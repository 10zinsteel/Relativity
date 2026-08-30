'use strict';

// Orchestrates POST /api/integrations/slack/events end-to-end (Architecture
// Review Phase 4, Milestone 4, §4.3-§4.9). Signature verification itself
// happens in Express middleware (services/slackSignatureService.js) before
// this module ever runs — everything here operates on an ALREADY-VERIFIED
// event. Composes the smaller focused services, matching this repo's
// existing convention (services/slackIntegrationService.js).
//
// Never trusts team_id/channel_id/user_id/client_id from anywhere but a
// verified event + a database lookup. Never logs message or answer text.

const defaultOauthConnectionsService = require('./oauthConnectionsService');
const defaultSupabaseService = require('./supabaseService');
const defaultSlackEventLogService = require('./slackEventLogService');
const defaultSlackDeliveryService = require('./slackDeliveryService');
const defaultAikbAskClient = require('./aikbAskClient');
const defaultSlackCollectionAccessService = require('./slackCollectionAccessService');
const defaultSlackDeliveryFailureService = require('./slackDeliveryFailureService');
const { extractQuestion, EMPTY_QUESTION_REPLY } = require('./slackQuestionService');
const { FALLBACK } = require('./slackAnswerFormatter');
const { retryWithBackoff } = require('./retryWithBackoff');
const config = require('../config');

const PROVIDER = 'slack';

// Safe, structured outcome codes for §4.16 metadata-only logging — never a
// message/answer body, never a raw error string.
const OUTCOME = Object.freeze({
  DUPLICATE: 'duplicate',
  UNSUPPORTED_EVENT_TYPE: 'unsupported_event_type',
  MPIM_UNSUPPORTED: 'mpim_unsupported',
  BOT_EVENT: 'bot_event',
  SELF_EVENT: 'self_event',
  EDITED_OR_DELETED: 'edited_or_deleted',
  MALFORMED: 'malformed',
  UNKNOWN_WORKSPACE: 'unknown_workspace',
  INACTIVE_ORG: 'inactive_org',
  EMPTY_QUESTION: 'empty_question',
  ENQUEUED: 'enqueued',
  ASK_FAILED: 'ask_failed',
});

function createSlackEventsService({
  oauthConnectionsService = defaultOauthConnectionsService,
  supabaseService = defaultSupabaseService,
  slackEventLogService = defaultSlackEventLogService,
  slackDeliveryService = defaultSlackDeliveryService,
  aikbAskClient = defaultAikbAskClient,
  slackCollectionAccessService = defaultSlackCollectionAccessService,
  slackDeliveryFailureService = defaultSlackDeliveryFailureService,
  sleep,
} = {}) {
  /**
   * Slack's url_verification handshake. Verified by the same signature
   * middleware as event_callback — no special-cased bypass.
   */
  function handleUrlVerification(body) {
    if (!body || body.type !== 'url_verification') return null;
    return { challenge: typeof body.challenge === 'string' ? body.challenge : '' };
  }

  /**
   * Resolves team_id -> exactly one active organization + connection, per
   * §4.6. Any ambiguity, revoked/expired status, or inactive organization is
   * treated as a safe rejection (no throw), since Slack should never see or
   * retry on the details of an internal mapping failure.
   */
  async function resolveWorkspace(teamId) {
    let connection;
    try {
      connection = await oauthConnectionsService.getActiveConnectionByExternalAccount(PROVIDER, teamId);
    } catch (err) {
      // Includes the "more than one active row" case, which the database's
      // partial unique index should already prevent — treated the same as
      // "no mapping" rather than ever surfacing the underlying error.
      return { ok: false, reason: OUTCOME.UNKNOWN_WORKSPACE };
    }
    if (!connection) {
      return { ok: false, reason: OUTCOME.UNKNOWN_WORKSPACE };
    }

    let client;
    try {
      client = await supabaseService.getClientById(connection.client_id);
    } catch (err) {
      return { ok: false, reason: OUTCOME.INACTIVE_ORG };
    }
    if (!client || !client.is_active) {
      return { ok: false, reason: OUTCOME.INACTIVE_ORG };
    }

    return { ok: true, connection, client };
  }

  /**
   * Full event_callback processing. Always resolves (never throws) — every
   * path is a decision about whether/how to safely ack Slack, never an
   * uncaught error that would surface Slack-facing 500s.
   *
   * @returns {{ status: 200, outcome: string, duplicate?: boolean }}
   */
  async function processEventCallback(body) {
    const teamId = body && typeof body.team_id === 'string' ? body.team_id : null;
    const event = body && typeof body.event === 'object' ? body.event : null;
    const eventId = body && typeof body.event_id === 'string' ? body.event_id : null;

    if (!teamId || !event || !eventId) {
      return { status: 200, outcome: OUTCOME.MALFORMED };
    }
    if (event.bot_id) {
      return { status: 200, outcome: OUTCOME.BOT_EVENT };
    }
    if (event.type === 'message' && event.channel_type === 'mpim') {
      // Group DMs are explicitly out of scope (backlog M13, rescoped) —
      // safely dropped, same as any other unsupported event, but tagged
      // distinctly for observability.
      return { status: 200, outcome: OUTCOME.MPIM_UNSUPPORTED };
    }
    const isDirectMessage = event.type === 'message' && event.channel_type === 'im';
    if (event.type !== 'app_mention' && !isDirectMessage) {
      return { status: 200, outcome: OUTCOME.UNSUPPORTED_EVENT_TYPE };
    }
    if (event.subtype) {
      // message_changed / message_deleted / any other subtype — edits and
      // deletes are never processed, per §4.4.
      return { status: 200, outcome: OUTCOME.EDITED_OR_DELETED };
    }
    if (!event.channel || !event.ts) {
      return { status: 200, outcome: OUTCOME.MALFORMED };
    }

    const workspace = await resolveWorkspace(teamId);
    if (!workspace.ok) {
      return { status: 200, outcome: workspace.reason };
    }
    const { connection, client } = workspace;

    const botUserId = connection.provider_metadata && typeof connection.provider_metadata === 'object'
      ? connection.provider_metadata.bot_user_id
      : null;

    if (botUserId && event.user === botUserId) {
      return { status: 200, outcome: OUTCOME.SELF_EVENT };
    }

    const threadTs = event.thread_ts || event.ts;
    const idempotencyKey = `slack:${eventId}`;
    const extraction = extractQuestion(event.text, botUserId);

    const { inserted, row } = await slackEventLogService.insertReceived({
      externalEventId: eventId,
      clientId: client.id,
      connectionId: connection.id,
      eventType: event.type,
      channelId: event.channel,
      eventTs: event.ts,
      threadTs: event.thread_ts || null,
      idempotencyKey,
    });

    if (!inserted) {
      return { status: 200, outcome: OUTCOME.DUPLICATE, duplicate: true };
    }

    if (!extraction.ok) {
      await replyDirectly({
        connection, channel: event.channel, threadTs, text: EMPTY_QUESTION_REPLY, row,
        slackEventLogService, slackDeliveryService, oauthConnectionsService, slackDeliveryFailureService, sleep,
      });
      return { status: 200, outcome: OUTCOME.EMPTY_QUESTION };
    }

    // EL7C (LIVE_EMAIL_LOOKUP.md) — Slack never resolves a requesting
    // member or offers live email lookup: identity linking (EL7A) and
    // Slack's live-lookup path (EL7B) were removed entirely, since Slack
    // DMs have no session the way the portal does and the linking flow
    // built to bridge that gap was never actually used. Live email lookup
    // remains portal-only; AIKB already degrades gracefully for a null
    // memberId/false emailLookupAvailable.
    const requestingMemberId = null;
    const emailLookupAvailable = false;

    // ADR-007: the fast accept-and-enqueue call to AIKB gets the same
    // bounded, immediate, in-flow retry treatment as Slack delivery itself
    // — there is no scheduled sweep left to recover a row stuck at
    // 'received' if this call fails outright. Slack is still reachable
    // here (the connection/credential are already resolved), so on
    // exhaustion a best-effort "couldn't complete that request" reply is
    // sent before the row is marked delivery_failed and redacted.
    try {
      const allowedCollectionIds = await slackCollectionAccessService.getAllowedCollectionIds(client.id);
      const { value, attempts } = await retryWithBackoff(
        () => aikbAskClient.ask({
          clientId: client.id,
          question: extraction.question,
          idempotencyKey,
          originMetadata: { teamId, channelId: event.channel, threadTs, eventId },
          allowedCollectionIds,
          origin: isDirectMessage ? 'slack_dm' : 'slack',
          memberId: requestingMemberId,
          emailLookupAvailable,
        }),
        { attempts: config.slackDelivery.maxAttempts, backoffMs: config.slackDelivery.backoffMs, sleep }
      );
      await slackEventLogService.markEnqueued(row.id);
      return { status: 200, outcome: OUTCOME.ENQUEUED, aikbEventId: value.eventId, attempts };
    } catch (err) {
      const errorCode = err.code || 'ASK_FAILED';
      await bestEffortTemporaryFailureReply({ connection, row, slackDeliveryService, oauthConnectionsService });
      await slackDeliveryFailureService.finalizeDeliveryFailure({
        row, errorCode, attemptCount: err.attempts || config.slackDelivery.maxAttempts,
      });
      return { status: 200, outcome: OUTCOME.ASK_FAILED, errorCode };
    }
  }

  return {
    handleUrlVerification,
    resolveWorkspace,
    processEventCallback,
    OUTCOME,
  };
}

/**
 * Shared helper: posts a direct, static reply (used only for the empty-
 * question fallback, which needs no AIKB round trip), with the same
 * bounded, immediate retry treatment as any other Slack delivery
 * (ADR-007). Failures here are logged but never thrown — Slack has already
 * been (or is about to be) ack'd regardless. No AIKB-side content could
 * exist for this row (AIKB was never called), so exhausting retries skips
 * the AIKB redact callback.
 */
async function replyDirectly({ connection, channel, threadTs, text, row, slackEventLogService, slackDeliveryService, oauthConnectionsService, slackDeliveryFailureService, sleep }) {
  let credential;
  try {
    credential = await oauthConnectionsService.getDecryptedCredentialForConnection(connection.id);
    if (!credential) throw new Error('no credential');
  } catch (err) {
    await slackDeliveryFailureService.finalizeDeliveryFailure({ row, errorCode: 'EMPTY_QUESTION_REPLY_FAILED', attemptCount: 0, skipAikbRedact: true });
    return;
  }

  try {
    const { attempts } = await retryWithBackoff(
      () => slackDeliveryService.postMessage({ botToken: credential.accessToken, channel, threadTs, text }),
      { attempts: config.slackDelivery.maxAttempts, backoffMs: config.slackDelivery.backoffMs, sleep }
    );
    await slackEventLogService.markDelivered(row.id, { attemptCount: attempts });
  } catch (err) {
    await slackDeliveryFailureService.finalizeDeliveryFailure({
      row, errorCode: 'EMPTY_QUESTION_REPLY_FAILED', attemptCount: err.attempts || config.slackDelivery.maxAttempts, skipAikbRedact: true,
    });
  }
}

/**
 * Best-effort only, single attempt: Slack is reachable here (unlike a real
 * Slack-delivery failure), so a brief "couldn't complete that request"
 * notice is worth trying once, but its outcome never changes the row's
 * terminal state — the caller marks delivery_failed regardless.
 */
async function bestEffortTemporaryFailureReply({ connection, row, slackDeliveryService, oauthConnectionsService }) {
  try {
    if (!connection || connection.status !== 'active') return;
    const credential = await oauthConnectionsService.getDecryptedCredentialForConnection(connection.id);
    if (!credential) return;
    await slackDeliveryService.postMessage({
      botToken: credential.accessToken,
      channel: row.channel_id,
      threadTs: row.thread_ts || row.event_ts,
      text: FALLBACK.TEMPORARY_FAILURE,
    });
  } catch (err) {
    // Best-effort only — the row is marked delivery_failed by the caller
    // regardless of whether this reply succeeded.
  }
}

const defaultService = createSlackEventsService();

module.exports = {
  ...defaultService,
  createSlackEventsService,
  OUTCOME,
};
