'use strict';

// Slack OAuth v2 client (Architecture Review Phase 4, Milestone 3).
// Focused, provider-specific — no Slack Web API message-posting logic here;
// that is explicitly out of scope until the Slack Events milestone.
//
// httpClient is dependency-injected (defaults to axios) so tests can
// exercise exchangeCodeForToken/revokeToken without any real network call,
// mirroring services/oauthConnectionsService.js's client-injection pattern.

const axios = require('axios');
const { slack } = require('../config');

// app_mentions:read/chat:write cover channel @mentions; im:history/im:read/
// im:write are required for DM support (services/slackEventsService.js's
// channel_type === 'im' handling, live since before EL7C and still active
// after it — EL7C only removed DM identity linking/live lookup, not DM
// handling itself). Do not add incoming-webhook, channels:history,
// groups:history, users:read, or users:read.email here — group DMs (mpim)
// are explicitly unsupported (backlog M13) and no scope here should imply
// otherwise.
const REQUIRED_SCOPES = ['app_mentions:read', 'chat:write', 'im:history', 'im:read', 'im:write'];

const OAUTH_TIMEOUT_MS = 10000;

const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'SLACK_NOT_CONFIGURED',
  HTTP_ERROR: 'SLACK_HTTP_ERROR',
  INVALID_RESPONSE: 'SLACK_INVALID_RESPONSE',
  OAUTH_FAILED: 'SLACK_OAUTH_FAILED',
});

function slackError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isSlackConfigured() {
  return Boolean(slack.clientId && slack.clientSecret && slack.redirectUri);
}

/**
 * Builds the Slack OAuth v2 authorization URL. Pure — no network access.
 * Never includes the client secret. `state` is the raw, single-use state
 * value (services/oauthStateService.js) — Slack receives it as-is; only its
 * hash is ever persisted server-side.
 */
function buildAuthorizationUrl({ state }) {
  if (!isSlackConfigured()) throw slackError(ERROR_CODES.NOT_CONFIGURED, 'Slack OAuth is not configured');
  if (!state || typeof state !== 'string') throw new Error('buildAuthorizationUrl requires state');

  const authUrl = new URL('https://slack.com/oauth/v2/authorize');
  authUrl.searchParams.set('client_id', slack.clientId);
  authUrl.searchParams.set('redirect_uri', slack.redirectUri);
  authUrl.searchParams.set('scope', REQUIRED_SCOPES.join(','));
  authUrl.searchParams.set('state', state);
  return authUrl.toString();
}

/**
 * Validates the shape of a Slack `oauth.v2.access` response and returns a
 * normalized, minimal object. Pure — no network access. Never echoes
 * Slack's raw response back to a caller; only a safe internal error code
 * and message on failure.
 */
function validateOAuthResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw slackError(ERROR_CODES.INVALID_RESPONSE, 'Slack OAuth response was not a valid object');
  }
  if (data.ok !== true) {
    throw slackError(ERROR_CODES.OAUTH_FAILED, 'Slack OAuth exchange did not succeed');
  }
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw slackError(ERROR_CODES.INVALID_RESPONSE, 'Slack OAuth response is missing an access token');
  }
  if (!data.team || typeof data.team.id !== 'string' || data.team.id.length === 0) {
    throw slackError(ERROR_CODES.INVALID_RESPONSE, 'Slack OAuth response is missing a team id');
  }
  if (typeof data.bot_user_id !== 'string' || data.bot_user_id.length === 0) {
    throw slackError(ERROR_CODES.INVALID_RESPONSE, 'Slack OAuth response is missing a bot user id');
  }

  const scopes = typeof data.scope === 'string'
    ? data.scope.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const hasEnterprise = data.enterprise && typeof data.enterprise === 'object' && typeof data.enterprise.id === 'string' && data.enterprise.id.length > 0;

  return {
    accessToken: data.access_token,
    team: { id: data.team.id, name: typeof data.team.name === 'string' ? data.team.name : null },
    enterprise: hasEnterprise ? { id: data.enterprise.id, name: typeof data.enterprise.name === 'string' ? data.enterprise.name : null } : null,
    botUserId: data.bot_user_id,
    appId: typeof data.app_id === 'string' ? data.app_id : null,
    tokenType: typeof data.token_type === 'string' ? data.token_type : null,
    scopes,
  };
}

/**
 * @param {{ httpClient?: { post: Function } }} [deps] — injected for testing; defaults to axios.
 */
function createSlackService({ httpClient = axios } = {}) {
  /** Exchanges an authorization code for a bot token via oauth.v2.access. */
  async function exchangeCodeForToken(code) {
    if (!isSlackConfigured()) throw slackError(ERROR_CODES.NOT_CONFIGURED, 'Slack OAuth is not configured');
    if (!code || typeof code !== 'string') throw new Error('exchangeCodeForToken requires code');

    const params = new URLSearchParams({
      code,
      redirect_uri: slack.redirectUri,
    });

    let response;
    try {
      response = await httpClient.post('https://slack.com/api/oauth.v2.access', params.toString(), {
        auth: { username: slack.clientId, password: slack.clientSecret },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: OAUTH_TIMEOUT_MS,
      });
    } catch {
      // Deliberately generic — never surface err.message here: axios error
      // objects retain the request config (including the Basic-auth client
      // secret) and must never be echoed to a caller or logged upstream.
      throw slackError(ERROR_CODES.HTTP_ERROR, 'Slack OAuth token exchange request failed');
    }

    if (!response || response.status < 200 || response.status >= 300) {
      throw slackError(ERROR_CODES.HTTP_ERROR, `Slack OAuth token exchange returned an unsuccessful HTTP status`);
    }
    if (!response.data || typeof response.data !== 'object') {
      throw slackError(ERROR_CODES.INVALID_RESPONSE, 'Slack OAuth token exchange returned an invalid response');
    }

    return validateOAuthResponse(response.data);
  }

  /**
   * Best-effort provider-side revocation (auth.revoke). Never throws —
   * callers must be able to proceed with local revocation regardless of
   * whether Slack's own revocation succeeded. Returns a boolean only.
   */
  async function revokeToken(accessToken) {
    if (!accessToken || typeof accessToken !== 'string') return false;
    try {
      const response = await httpClient.post('https://slack.com/api/auth.revoke', null, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: OAUTH_TIMEOUT_MS,
      });
      return Boolean(response && response.data && response.data.ok === true);
    } catch {
      return false;
    }
  }

  return { exchangeCodeForToken, revokeToken };
}

const defaultService = createSlackService();

module.exports = {
  ...defaultService,
  createSlackService,
  buildAuthorizationUrl,
  validateOAuthResponse,
  isSlackConfigured,
  REQUIRED_SCOPES,
  ERROR_CODES,
};
