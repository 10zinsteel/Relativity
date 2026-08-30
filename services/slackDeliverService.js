'use strict';

// Orchestrates POST /api/integrations/slack/deliver — AIKB's callback once
// it has an answer (or has given up) for a previously-enqueued Slack
// question (Architecture Review Phase 4, Milestone 4, §4.3, §4.8, §4.13).
// The service-request envelope itself is verified by Express middleware
// (services/serviceRequestAuth.js via requireServiceRequestMiddleware in
// the route) before this module runs — clientId/idempotencyKey here are
// already trusted.

const defaultOauthConnectionsService = require('./oauthConnectionsService');
const defaultSlackEventLogService = require('./slackEventLogService');
const defaultSlackDeliveryService = require('./slackDeliveryService');
const defaultSlackDeliveryFailureService = require('./slackDeliveryFailureService');
const defaultCitationAttributionService = require('./citationAttributionService');
const { formatSlackMessage, FALLBACK } = require('./slackAnswerFormatter');
const { retryWithBackoff } = require('./retryWithBackoff');
const config = require('../config');

const RESULT = Object.freeze({
  DELIVERED: 'delivered',
  ALREADY_PROCESSED: 'already_processed',
  UNKNOWN_EVENT: 'unknown_event',
  CLIENT_MISMATCH: 'client_mismatch',
  CONNECTION_REVOKED: 'connection_revoked',
  DELIVERY_FAILED: 'delivery_failed',
});

function createSlackDeliverService({
  oauthConnectionsService = defaultOauthConnectionsService,
  slackEventLogService = defaultSlackEventLogService,
  slackDeliveryService = defaultSlackDeliveryService,
  slackDeliveryFailureService = defaultSlackDeliveryFailureService,
  citationAttributionService = defaultCitationAttributionService,
  sleep,
} = {}) {
  /**
   * @param {object} params
   * @param {string} params.clientId - from the verified envelope, never the payload.
   * @param {string} params.idempotencyKey - from the verified envelope.
   * @param {object} params.payload - { error: true, errorCode } OR { answer, sources, isKnowledgeGap, gapReason, sessionId }.
   */
  async function handleDeliverCallback({ clientId, idempotencyKey, payload }) {
    const row = await slackEventLogService.getByIdempotencyKey(idempotencyKey);
    if (!row) {
      return { result: RESULT.UNKNOWN_EVENT };
    }
    if (row.client_id !== clientId) {
      // Envelope's clientId must match the event's own resolved clientId —
      // never trust a callback to deliver into a different organization's
      // Slack workspace than the one that originated the question.
      return { result: RESULT.CLIENT_MISMATCH };
    }

    const claimed = await slackEventLogService.claimForDelivery(row.id);
    if (!claimed) {
      // Not in 'enqueued' state — either already answered/delivered/failed,
      // or a concurrent callback already won the claim. Safe no-op.
      return { result: RESULT.ALREADY_PROCESSED };
    }

    // ADR-007: AIKB generation failure vs. Slack delivery failure are
    // handled differently, and must stay distinguishable. A real generated
    // answer gets bounded, immediate in-flow retries and lands on the
    // terminal delivery_failed status (with redaction) if every attempt
    // fails. An AIKB-generation-failure notification is unchanged from
    // before this ADR: a single attempt, the existing generic 'failed'
    // status, and no redaction (there is no answer to redact).
    const isAnswerDelivery = !(payload && payload.error === true);

    const connection = await oauthConnectionsService.getConnectionById(row.connection_id);
    if (!connection || connection.status !== 'active') {
      if (isAnswerDelivery) {
        await slackDeliveryFailureService.finalizeDeliveryFailure({ row, errorCode: 'CONNECTION_REVOKED', attemptCount: 0 });
      } else {
        await slackEventLogService.markFailed(row.id, { errorCode: 'CONNECTION_REVOKED' });
      }
      return { result: RESULT.CONNECTION_REVOKED };
    }

    // EM10.8 — resolve each email source's opaque contributingMemberId to a
    // display name before formatting; a no-op when no source carries one.
    let enrichedSources = payload && payload.sources;
    if (isAnswerDelivery && Array.isArray(enrichedSources)) {
      enrichedSources = await citationAttributionService.enrichSourcesWithContributorNames(clientId, enrichedSources);
    }

    const text = isAnswerDelivery
      ? formatSlackMessage({
        answer: payload && payload.answer,
        sources: enrichedSources,
        isKnowledgeGap: !!(payload && payload.isKnowledgeGap),
        // EL7B (§3.2) — narrow signal only (never the full intent object);
        // AIKB sets this when the classifier thought live email might help
        // but no tools were ever offered (unlinked Slack user, or a linked
        // one with no active/consented mailbox).
        emailLookupSuggested: !!(payload && payload.emailLookupSuggested),
      })
      : FALLBACK.TEMPORARY_FAILURE;

    let credential;
    try {
      credential = await oauthConnectionsService.getDecryptedCredentialForConnection(connection.id);
      if (!credential) throw new Error('no credential');
    } catch (err) {
      const errorCode = err.code || 'SLACK_DELIVERY_FAILED';
      if (isAnswerDelivery) {
        await slackDeliveryFailureService.finalizeDeliveryFailure({ row, errorCode, attemptCount: 0 });
      } else {
        await slackEventLogService.markFailed(row.id, { errorCode });
      }
      return { result: RESULT.DELIVERY_FAILED, errorCode };
    }

    if (!isAnswerDelivery) {
      // AIKB generation failure notification (ADR-007: "Do not change the
      // documented behavior") — single attempt, no retry, existing 'failed'
      // status on failure, never delivery_failed.
      try {
        await slackDeliveryService.postMessage({
          botToken: credential.accessToken,
          channel: row.channel_id,
          threadTs: row.thread_ts || row.event_ts,
          text,
        });
        await slackEventLogService.markDelivered(row.id, { responseMetadata: { isKnowledgeGap: false } });
        return { result: RESULT.DELIVERED };
      } catch (err) {
        await slackEventLogService.markFailed(row.id, { errorCode: err.code || 'SLACK_DELIVERY_FAILED' });
        return { result: RESULT.DELIVERY_FAILED, errorCode: err.code || 'SLACK_DELIVERY_FAILED' };
      }
    }

    // Real answer delivery — bounded, immediate in-flow retries (ADR-007).
    try {
      const { attempts } = await retryWithBackoff(
        () => slackDeliveryService.postMessage({
          botToken: credential.accessToken,
          channel: row.channel_id,
          threadTs: row.thread_ts || row.event_ts,
          text,
        }),
        { attempts: config.slackDelivery.maxAttempts, backoffMs: config.slackDelivery.backoffMs, sleep }
      );

      await slackEventLogService.markDelivered(row.id, {
        responseMetadata: { isKnowledgeGap: !!(payload && payload.isKnowledgeGap) },
        attemptCount: attempts,
      });
      return { result: RESULT.DELIVERED };
    } catch (err) {
      const errorCode = err.code || 'SLACK_DELIVERY_FAILED';
      await slackDeliveryFailureService.finalizeDeliveryFailure({
        row,
        errorCode,
        attemptCount: err.attempts || config.slackDelivery.maxAttempts,
      });
      return { result: RESULT.DELIVERY_FAILED, errorCode };
    }
  }

  return { handleDeliverCallback };
}

const defaultService = createSlackDeliverService();

module.exports = {
  ...defaultService,
  createSlackDeliverService,
  RESULT,
};
