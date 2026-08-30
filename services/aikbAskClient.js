'use strict';

// Calls AIKB's POST /api/knowledge/ask — the fast accept-and-enqueue leg of
// the Slack Q&A flow (Architecture Review Phase 4, Milestone 4, §4.8-§4.10).
// This call is made synchronously inside the Slack /events handler, before
// Relativity acks Slack, so it MUST stay fast: it only needs AIKB to accept
// the question onto its own Inngest pipeline, not compute the answer.
//
// Signs the request with the additive HMAC service-request envelope
// (services/serviceRequestAuth.js) and sends it alongside the existing,
// unchanged AIKB_API_KEY (defense in depth — this does not replace that
// gate on AIKB's side, only adds to it for this one route).
//
// Never sends a Slack token or client secret in this request — only
// clientId, the extracted question, and narrow origin metadata (§4.9).

const axios = require('axios');
const config = require('../config');
const { signServiceRequest } = require('./serviceRequestAuth');

const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'AIKB_ASK_NOT_CONFIGURED',
  HTTP_ERROR: 'AIKB_ASK_HTTP_ERROR',
  TIMEOUT: 'AIKB_ASK_TIMEOUT',
  INVALID_RESPONSE: 'AIKB_ASK_INVALID_RESPONSE',
});

function createAikbAskError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function createAikbAskClient({ httpClient = axios } = {}) {
  /**
   * @param {object} params
   * @param {string} params.clientId - trusted, resolved via oauth_connections only.
   * @param {string} params.question - extracted, normalized (services/slackQuestionService.js).
   * @param {string} params.idempotencyKey - derived from Slack event_id.
   * @param {{ teamId: string, channelId: string, threadTs: string, eventId: string }} params.originMetadata
   * @param {string[]} params.allowedCollectionIds - Milestone 5: AIKB knowledge_collections ids Slack may search for this client. Always an explicit array (possibly empty — empty means "search nothing", not "search everything"), never omitted, so a caller can never accidentally fall back to an unrestricted search.
   * @param {string} [params.origin] - 'slack' (channel @mention, default) or 'slack_dm' (backlog M13) — tags the resulting AIKB session so DM conversations can be excluded from portal-facing chat history.
   * @param {string|null} [params.memberId] - EL7C (LIVE_EMAIL_LOOKUP.md): always null — Slack never resolves a requesting member (identity linking was removed entirely; the portal is the only surface with a session to resolve one from). AIKB degrades gracefully for this, exactly like the portal's pre-EL6 default.
   * @param {boolean} [params.emailLookupAvailable] - EL7C: always false for the same reason — live email lookup is portal-only.
   * @returns {Promise<{ accepted: boolean, eventId: string|null }>}
   */
  async function ask({ clientId, question, idempotencyKey, originMetadata, allowedCollectionIds, origin = 'slack', memberId = null, emailLookupAvailable = false }) {
    const baseUrl = config.aikb.apiBaseUrl;
    const apiKey = config.aikb.apiKey;
    const signingSecret = config.serviceRequest.signingSecret;

    if (!baseUrl || !apiKey || !signingSecret) {
      throw createAikbAskError(ERROR_CODES.NOT_CONFIGURED, 'AIKB /ask is not configured on this server.');
    }

    const payload = {
      question,
      origin,
      originMetadata,
      // Covered by the envelope's signature (hashPayload hashes the whole
      // payload object) — tampering with this in transit invalidates the
      // signature exactly like tampering with `question` would.
      allowedCollectionIds: Array.isArray(allowedCollectionIds) ? allowedCollectionIds : [],
      memberId: memberId || null,
      emailLookupAvailable: emailLookupAvailable === true,
    };

    const envelope = signServiceRequest({
      clientId,
      idempotencyKey,
      payload,
      secret: signingSecret,
    });

    let response;
    try {
      response = await httpClient.post(
        `${baseUrl.replace(/\/$/, '')}/api/knowledge/ask`,
        { ...envelope, payload },
        {
          headers: {
            'x-api-key': apiKey,
            'Content-Type': 'application/json',
          },
          timeout: config.aikb.askTimeoutMs,
        }
      );
    } catch (err) {
      if (err.code === 'ECONNABORTED') {
        throw createAikbAskError(ERROR_CODES.TIMEOUT, 'AIKB /ask request timed out.');
      }
      throw createAikbAskError(ERROR_CODES.HTTP_ERROR, 'AIKB /ask request failed.');
    }

    if (!response || response.status < 200 || response.status >= 300) {
      throw createAikbAskError(ERROR_CODES.HTTP_ERROR, `AIKB /ask returned HTTP ${response ? response.status : 'unknown'}.`);
    }

    const data = response.data;
    if (!data || typeof data !== 'object' || data.accepted !== true) {
      throw createAikbAskError(ERROR_CODES.INVALID_RESPONSE, 'AIKB /ask returned an unexpected response.');
    }

    return { accepted: true, eventId: data.eventId || null };
  }

  return { ask };
}

const defaultClient = createAikbAskClient();

module.exports = {
  ...defaultClient,
  createAikbAskClient,
  ERROR_CODES,
};
