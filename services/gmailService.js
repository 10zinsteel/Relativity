'use strict';

// Gmail OAuth client (EM2 — Architecture/architecture/EMAIL_INGESTION.md §10,
// §12), extended in EM5 with the managed-label workflow and the read-only
// message calls the preview dry-run needs (§10, §17), in EM6 with the
// format=full body fetch (§19), and in EM7 with the History API incremental
// diff (§18) — getMailboxHistoryId (users.getProfile, to capture a fresh
// cursor) and listHistory (users.history.list, to read what changed since a
// stored cursor). Mirrors services/slackService.js's shape one-for-one:
// provider-specific, dependency-injected httpClient so tests never make a
// real network call. Still no write/mutation here beyond the managed label
// itself (labels.create) — never modifies, sends, or deletes a message.
//
// Scope grew from EM2's gmail.readonly + identity to add gmail.labels here
// (EM5) — required to create the managed "Relativity/Knowledge" label
// (labels.list/get alone cannot create one). Still no gmail.modify/compose/
// send — labels.create/list is the only mutation this scope permits.
// history.list/getProfile both fall under the existing gmail.readonly scope
// — no scope addition needed for EM7.

const axios = require('axios');
const { gmail } = require('../config');

const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.labels',
  'openid',
  'email',
  'profile',
];

// The one Gmail label this feature ever creates/reads (§10). A slash in a
// Gmail label name creates a nested label in the UI, which is exactly the
// display Relativity wants ("Relativity" parent, "Knowledge" child) — no
// escaping needed in the Gmail API label `name` field itself.
const MANAGED_LABEL_NAME = 'Relativity/Knowledge';

const OAUTH_TIMEOUT_MS = 10000;
const GMAIL_API_TIMEOUT_MS = 10000;
const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

const ERROR_CODES = Object.freeze({
  NOT_CONFIGURED: 'GMAIL_NOT_CONFIGURED',
  HTTP_ERROR: 'GMAIL_HTTP_ERROR',
  INVALID_RESPONSE: 'GMAIL_INVALID_RESPONSE',
  OAUTH_FAILED: 'GMAIL_OAUTH_FAILED',
  // EM7 (§18.4) — Gmail returns 404 when a startHistoryId is older than the
  // mailbox's retained history window (at least 7 days, per Google's docs).
  // Distinct from HTTP_ERROR so callers can distinguish "cursor is stale,
  // fall back to a bounded historical re-scan" from a real, unexpected
  // failure that shouldn't silently trigger a full re-scan.
  HISTORY_EXPIRED: 'GMAIL_HISTORY_EXPIRED',
});

function gmailError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function isGmailConfigured() {
  return Boolean(gmail.clientId && gmail.clientSecret && gmail.redirectUri);
}

/**
 * Builds Google's OAuth 2.0 authorization-code consent URL. Pure — no
 * network access. Never includes the client secret. `access_type=offline`
 * plus `prompt=consent` guarantee a refresh token is issued on every
 * connect, not just the first one ever for that Google account.
 */
function buildAuthorizationUrl({ state }) {
  if (!isGmailConfigured()) throw gmailError(ERROR_CODES.NOT_CONFIGURED, 'Gmail OAuth is not configured');
  if (!state || typeof state !== 'string') throw new Error('buildAuthorizationUrl requires state');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', gmail.clientId);
  authUrl.searchParams.set('redirect_uri', gmail.redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', REQUIRED_SCOPES.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  return authUrl.toString();
}

/**
 * Validates the shape of Google's token-exchange response. Pure — no
 * network access. Never echoes the raw response back to a caller.
 */
function validateTokenResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail token response was not a valid object');
  }
  if (typeof data.access_token !== 'string' || data.access_token.length === 0) {
    throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail token response is missing an access token');
  }
  if (typeof data.refresh_token !== 'string' || data.refresh_token.length === 0) {
    throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail token response is missing a refresh token');
  }

  const scopes = typeof data.scope === 'string'
    ? data.scope.split(' ').map((s) => s.trim()).filter(Boolean)
    : [];

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresInSeconds: typeof data.expires_in === 'number' ? data.expires_in : null,
    tokenType: typeof data.token_type === 'string' ? data.token_type : null,
    scopes,
  };
}

/**
 * Validates the shape of Google's OpenID Connect userinfo response. Pure —
 * no network access.
 */
function validateUserInfoResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail userinfo response was not a valid object');
  }
  if (typeof data.sub !== 'string' || data.sub.length === 0) {
    throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail userinfo response is missing a subject id');
  }
  if (typeof data.email !== 'string' || data.email.length === 0) {
    throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail userinfo response is missing an email address');
  }

  return {
    externalAccountId: data.sub,
    mailboxAddress: data.email,
    displayName: typeof data.name === 'string' && data.name.length > 0 ? data.name : null,
  };
}

/**
 * Extracts a bare email address from an RFC 5322 "From"/"To" header value
 * (e.g. `Alex Doe <alex@example.com>` or a bare `alex@example.com`). Pure —
 * no network access. Returns null rather than throwing on an unparseable
 * value, since header content is provider-supplied, not validated input.
 */
function extractEmailAddress(headerValue) {
  if (typeof headerValue !== 'string' || !headerValue.trim()) return null;
  const angleMatch = headerValue.match(/<([^>]+)>/);
  const candidate = (angleMatch ? angleMatch[1] : headerValue).trim();
  return candidate.includes('@') ? candidate.toLowerCase() : null;
}

/**
 * Parses the `payload.headers` array `format=metadata` returns into the
 * flat shape the rest of this file/emailPreviewService work with. Pure.
 */
function parseMessageHeaders(headers) {
  const byName = new Map();
  for (const h of headers || []) {
    if (h && typeof h.name === 'string') byName.set(h.name.toLowerCase(), h.value);
  }
  return {
    subject: byName.get('subject') || null,
    fromAddress: extractEmailAddress(byName.get('from')),
    date: byName.get('date') || null,
  };
}

/**
 * Decodes Gmail's base64url message-body encoding (RFC 4648 §5 — '-'/'_'
 * instead of '+'/'/', no padding) into a UTF-8 string. Pure.
 */
function decodeBase64Url(data) {
  if (typeof data !== 'string' || !data) return '';
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Walks a `format=full` message's MIME `payload` tree (recursively, since
 * `multipart/alternative`/`multipart/mixed` can nest, e.g. an alternative
 * pair inside a mixed part that also carries attachments) and returns the
 * first `text/plain` and first `text/html` body found. Pure. Parts that
 * carry a `filename` are attachments (or inline images), never a message
 * body — skipped here regardless of MIME type, matching §21's "attachment
 * ingestion is a separate, deferred milestone" scoping (EM6 never descends
 * into an attachment's own bytes).
 */
function extractBodyParts(payload) {
  let html = null;
  let text = null;

  function walk(part) {
    if (!part || (html && text)) return;
    if (part.filename) return; // attachment/inline-image, not a body part

    const mimeType = part.mimeType || '';
    if (mimeType === 'text/html' && !html && part.body && part.body.data) {
      html = decodeBase64Url(part.body.data);
    } else if (mimeType === 'text/plain' && !text && part.body && part.body.data) {
      text = decodeBase64Url(part.body.data);
    } else if (Array.isArray(part.parts)) {
      for (const child of part.parts) walk(child);
    }
  }

  walk(payload);
  return { html, text };
}

/**
 * Compiles a Gmail search-query string (`q` param, §10) for a preview/
 * historical-import candidate list. Pure — no network access. Always
 * exactly `label:Relativity/Knowledge -in:chats` (§17 item 2 — "the query
 * is simply label:Relativity/Knowledge... the label, not a date window, is
 * the primary selection criterion"). Policy (allow/deny) is deliberately
 * NOT folded into this query string — it is re-verified locally per
 * candidate message instead (§10 item 4's defense-in-depth pattern), the
 * same division of labor historical import (EM6) reuses.
 *
 * EM10.6 — Automatic Email Ingestion's rule-compiled query branch (which
 * OR'd together one clause per enabled allow rule, with no label) was
 * removed; this is now the single supported query shape. See
 * EMAIL_INGESTION.md's EM10.6 record.
 */
function compileSearchQuery() {
  return `label:${MANAGED_LABEL_NAME} -in:chats`;
}

/**
 * @param {{ httpClient?: { post: Function, get: Function } }} [deps] — injected for testing; defaults to axios.
 */
function createGmailService({ httpClient = axios } = {}) {
  /**
   * Exchanges an authorization code for tokens, then resolves the connected
   * mailbox's address/display name via the OpenID Connect userinfo
   * endpoint. Returns one normalized object so callers (emailConnectionService)
   * never need to make a second round trip themselves.
   */
  async function exchangeCodeForToken(code) {
    if (!isGmailConfigured()) throw gmailError(ERROR_CODES.NOT_CONFIGURED, 'Gmail OAuth is not configured');
    if (!code || typeof code !== 'string') throw new Error('exchangeCodeForToken requires code');

    const params = new URLSearchParams({
      code,
      client_id: gmail.clientId,
      client_secret: gmail.clientSecret,
      redirect_uri: gmail.redirectUri,
      grant_type: 'authorization_code',
    });

    let tokenResponse;
    try {
      tokenResponse = await httpClient.post('https://oauth2.googleapis.com/token', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: OAUTH_TIMEOUT_MS,
      });
    } catch {
      // Deliberately generic — never surface err.message here: the request
      // config (and any axios error object built from it) retains the
      // client secret and must never be echoed to a caller or logged.
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail OAuth token exchange request failed');
    }

    if (!tokenResponse || tokenResponse.status < 200 || tokenResponse.status >= 300) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail OAuth token exchange returned an unsuccessful HTTP status');
    }

    const token = validateTokenResponse(tokenResponse.data);

    let userInfoResponse;
    try {
      userInfoResponse = await httpClient.get('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${token.accessToken}` },
        timeout: OAUTH_TIMEOUT_MS,
      });
    } catch {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail userinfo request failed');
    }

    if (!userInfoResponse || userInfoResponse.status < 200 || userInfoResponse.status >= 300) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail userinfo request returned an unsuccessful HTTP status');
    }

    const identity = validateUserInfoResponse(userInfoResponse.data);

    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresInSeconds ? new Date(Date.now() + token.expiresInSeconds * 1000).toISOString() : null,
      scopes: token.scopes,
      externalAccountId: identity.externalAccountId,
      mailboxAddress: identity.mailboxAddress,
      displayName: identity.displayName,
    };
  }

  /**
   * Best-effort provider-side revocation. Never throws — callers must be
   * able to proceed with local revocation regardless of whether Google's
   * own revocation succeeded. Returns a boolean only.
   */
  async function revokeToken(token) {
    if (!token || typeof token !== 'string') return false;
    try {
      const params = new URLSearchParams({ token });
      const response = await httpClient.post('https://oauth2.googleapis.com/revoke', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: OAUTH_TIMEOUT_MS,
      });
      return Boolean(response && response.status >= 200 && response.status < 300);
    } catch {
      return false;
    }
  }

  /**
   * Refreshes an expiring/expired access token (EM5 — no orchestration of
   * *when* to refresh lives here, see emailConnectionService.js's
   * getValidGmailAccessToken; this is only the raw token-endpoint call,
   * mirroring exchangeCodeForToken's structure). Google may omit a new
   * refresh_token on refresh — callers must preserve the prior one in that
   * case (the same bug class ADR-006's updateCredentialForConnection already
   * solved for Google Drive), so `refreshToken` here is nullable by design,
   * never defaulted to the input token.
   */
  async function refreshAccessToken(refreshToken) {
    if (!isGmailConfigured()) throw gmailError(ERROR_CODES.NOT_CONFIGURED, 'Gmail OAuth is not configured');
    if (!refreshToken || typeof refreshToken !== 'string') throw new Error('refreshAccessToken requires refreshToken');

    const params = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: gmail.clientId,
      client_secret: gmail.clientSecret,
      grant_type: 'refresh_token',
    });

    let response;
    try {
      response = await httpClient.post('https://oauth2.googleapis.com/token', params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: OAUTH_TIMEOUT_MS,
      });
    } catch {
      // Same secret-leakage concern as exchangeCodeForToken — never surface err.message.
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail OAuth token refresh request failed');
    }

    if (!response || response.status < 200 || response.status >= 300) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail OAuth token refresh returned an unsuccessful HTTP status');
    }

    if (!response.data || typeof response.data.access_token !== 'string' || !response.data.access_token) {
      throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail token refresh response is missing an access token');
    }

    return {
      accessToken: response.data.access_token,
      refreshToken: typeof response.data.refresh_token === 'string' && response.data.refresh_token ? response.data.refresh_token : null,
      expiresAt: typeof response.data.expires_in === 'number' ? new Date(Date.now() + response.data.expires_in * 1000).toISOString() : null,
    };
  }

  /**
   * Lists every label on the mailbox as `{id, name}` pairs — used both to
   * find/create the managed label and, in emailPreviewService.js, to build
   * an id→name map so a fetched message's `labelIds` can be evaluated
   * against organization policy's name-based `labelOrFolder` rules.
   */
  async function listLabels(accessToken) {
    if (!accessToken) throw new Error('listLabels requires accessToken');
    let response;
    try {
      response = await httpClient.get(`${GMAIL_API_BASE}/labels`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: GMAIL_API_TIMEOUT_MS,
      });
    } catch {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail labels.list request failed');
    }
    if (!response || response.status < 200 || response.status >= 300) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail labels.list returned an unsuccessful HTTP status');
    }
    const labels = Array.isArray(response.data && response.data.labels) ? response.data.labels : [];
    return labels.map((l) => ({ id: l.id, name: l.name }));
  }

  /**
   * Idempotent create-or-reuse of the managed `Relativity/Knowledge` label
   * (§10) — lists first so a member's pre-existing label (e.g. from a prior
   * disconnect/reconnect) is reused, never duplicated.
   */
  async function getOrCreateManagedLabel(accessToken) {
    const labels = await listLabels(accessToken);
    const existing = labels.find((l) => l.name === MANAGED_LABEL_NAME);
    if (existing) return { labelId: existing.id, created: false };

    let response;
    try {
      response = await httpClient.post(
        `${GMAIL_API_BASE}/labels`,
        { name: MANAGED_LABEL_NAME, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
        { headers: { Authorization: `Bearer ${accessToken}` }, timeout: GMAIL_API_TIMEOUT_MS }
      );
    } catch {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail labels.create request failed');
    }
    if (!response || response.status < 200 || response.status >= 300 || !response.data || !response.data.id) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail labels.create returned an unsuccessful HTTP status or malformed body');
    }
    return { labelId: response.data.id, created: true };
  }

  /**
   * `users.messages.list` — returns bare `{id}` results only (no metadata),
   * matching Gmail's own API shape; callers fetch metadata per message via
   * getMessageMetadata below. Bounded by `maxResults` (a preview/pagination
   * page, never "list everything" — §17 item 3's Vercel-timeout constraint
   * applies to any live per-message loop this feeds, not only historical
   * import's).
   */
  async function listMessageIdsByQuery({ accessToken, query, pageToken, maxResults = 25 }) {
    if (!accessToken) throw new Error('listMessageIdsByQuery requires accessToken');
    if (!query) return { messageIds: [], nextPageToken: null };

    const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
    if (pageToken) params.set('pageToken', pageToken);

    let response;
    try {
      response = await httpClient.get(`${GMAIL_API_BASE}/messages?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: GMAIL_API_TIMEOUT_MS,
      });
    } catch {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail messages.list request failed');
    }
    if (!response || response.status < 200 || response.status >= 300) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail messages.list returned an unsuccessful HTTP status');
    }

    const messages = Array.isArray(response.data && response.data.messages) ? response.data.messages : [];
    return {
      messageIds: messages.map((m) => m.id),
      nextPageToken: (response.data && response.data.nextPageToken) || null,
    };
  }

  /**
   * `users.messages.get?format=metadata` — headers only (Subject/From/Date),
   * plus `labelIds` (needed for the manual-mode label gate and automatic-
   * mode labelOrFolder rule matching). Never fetches the message body —
   * preview must never return body content (§14.1).
   */
  async function getMessageMetadata({ accessToken, messageId }) {
    if (!accessToken) throw new Error('getMessageMetadata requires accessToken');
    if (!messageId) throw new Error('getMessageMetadata requires messageId');

    const params = new URLSearchParams({ format: 'metadata' });
    params.append('metadataHeaders', 'Subject');
    params.append('metadataHeaders', 'From');
    params.append('metadataHeaders', 'Date');

    let response;
    try {
      response = await httpClient.get(`${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: GMAIL_API_TIMEOUT_MS,
      });
    } catch {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail messages.get request failed');
    }
    if (!response || response.status < 200 || response.status >= 300) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail messages.get returned an unsuccessful HTTP status');
    }

    const headers = parseMessageHeaders(response.data && response.data.payload && response.data.payload.headers);
    const labelIds = Array.isArray(response.data && response.data.labelIds) ? response.data.labelIds : [];
    return {
      messageId,
      // EM6 — Gmail's messages.get response always carries threadId at the
      // top level (regardless of format), used to populate
      // email_source_messages.provider_thread_id for UI thread-grouping
      // (§20) — not consulted by preview (EM5), only by historical import.
      threadId: (response.data && response.data.threadId) || null,
      subject: headers.subject,
      fromAddress: headers.fromAddress,
      date: headers.date,
      labelIds,
      isSent: labelIds.includes('SENT'),
      // EL4 — Gmail's message resource always carries a server-generated
      // snippet field (every format except format=raw), previously unread
      // by any caller. search_email_messages (services/emailLiveLookupService.js)
      // uses this as the result preview so it never needs a separate
      // format=full fetch just to show a snippet.
      snippet: (response.data && response.data.snippet) || '',
    };
  }

  /**
   * `users.messages.get?format=full` — the ONLY call in this file that
   * fetches message body content (EM6). Historical import calls this only
   * for a message that has already been eligibility-checked via the
   * metadata-only getMessageMetadata + local policy re-verification
   * (§17 item 4) — never for a candidate that hasn't cleared that gate.
   * Returns raw HTML/plain-text bodies as fetched; callers MUST pass this
   * through services/emailNormalizationService.js before it is ever
   * persisted or forwarded to AIKB — this function itself never sanitizes,
   * strips, or normalizes anything (§19: "raw HTML/raw MIME — never
   * stored").
   */
  async function getMessageBody({ accessToken, messageId }) {
    if (!accessToken) throw new Error('getMessageBody requires accessToken');
    if (!messageId) throw new Error('getMessageBody requires messageId');

    let response;
    try {
      response = await httpClient.get(`${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: GMAIL_API_TIMEOUT_MS,
      });
    } catch {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail messages.get (format=full) request failed');
    }
    if (!response || response.status < 200 || response.status >= 300) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail messages.get (format=full) returned an unsuccessful HTTP status');
    }

    const { html, text } = extractBodyParts(response.data && response.data.payload);
    return { messageId, html, text };
  }

  /**
   * `users.threads.get?format=full` (EL4 — Architecture/architecture/
   * LIVE_EMAIL_LOOKUP.md §4.3) — the one genuinely new Gmail-facing call
   * this milestone adds: get_email_content's threadId branch needs every
   * message in a thread, and Gmail's `q` search syntax has no `threadId:`
   * operator to fetch that via listMessageIdsByQuery. threads.get returns
   * every message's full payload in a single response, so this is one API
   * call, not N. Reuses parseMessageHeaders/extractBodyParts unchanged —
   * no new HTML/MIME-parsing logic, only a new endpoint around the same
   * per-message shape getMessageMetadata+getMessageBody already produce
   * separately.
   */
  async function getThread({ accessToken, threadId }) {
    if (!accessToken) throw new Error('getThread requires accessToken');
    if (!threadId) throw new Error('getThread requires threadId');

    let response;
    try {
      response = await httpClient.get(`${GMAIL_API_BASE}/threads/${encodeURIComponent(threadId)}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: GMAIL_API_TIMEOUT_MS,
      });
    } catch {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail threads.get request failed');
    }
    if (response && response.status === 404) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail thread not found');
    }
    if (!response || response.status < 200 || response.status >= 300) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail threads.get returned an unsuccessful HTTP status');
    }

    const rawMessages = Array.isArray(response.data && response.data.messages) ? response.data.messages : [];
    const messages = rawMessages.map((m) => {
      const headers = parseMessageHeaders(m.payload && m.payload.headers);
      const labelIds = Array.isArray(m.labelIds) ? m.labelIds : [];
      const { html, text } = extractBodyParts(m.payload);
      return {
        messageId: m.id,
        threadId,
        subject: headers.subject,
        fromAddress: headers.fromAddress,
        date: headers.date,
        labelIds,
        isSent: labelIds.includes('SENT'),
        html,
        text,
      };
    });

    return { threadId, messages };
  }

  /**
   * `users.getProfile` (EM7 — §18.3's `next_sync_due_at`/cursor bookkeeping
   * groundwork). The ONLY reliable way to obtain the mailbox's current
   * historyId with no other side effect — used to establish a fresh cursor
   * right after a full historical sync completes, so the NEXT sync can go
   * incremental (§18.2).
   */
  async function getMailboxHistoryId(accessToken) {
    if (!accessToken) throw new Error('getMailboxHistoryId requires accessToken');
    let response;
    try {
      response = await httpClient.get(`${GMAIL_API_BASE}/profile`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: GMAIL_API_TIMEOUT_MS,
      });
    } catch {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail users.getProfile request failed');
    }
    if (!response || response.status < 200 || response.status >= 300) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail users.getProfile returned an unsuccessful HTTP status');
    }
    const historyId = response.data && response.data.historyId;
    if (!historyId) {
      throw gmailError(ERROR_CODES.INVALID_RESPONSE, 'Gmail users.getProfile response is missing historyId');
    }
    return { historyId: String(historyId) };
  }

  /**
   * `users.history.list` (EM7 — §18, §18.4): reads what changed since
   * `startHistoryId`, filtered by Gmail (`labelId`) to messages associated
   * with the managed label — but NOT scoped to changes of that specific
   * label. A `labelsRemoved` record in this feed can name a completely
   * different label (most commonly `UNREAD`, removed simply by opening the
   * message in Gmail) bundled alongside a message that also happens to
   * carry the managed label. Every `labelRemoved` change below therefore
   * carries its own `labelIds` so the caller can check WHICH label was
   * actually removed before treating it as "the managed label was removed"
   * (EM10.5 Scenario 3 regression — §24.2 previously assumed this filtering
   * was already exact). Reports `labelAdded`/`labelRemoved`/`messageDeleted`.
   *
   * EM10.6 — Automatic Email Ingestion's unscoped `historyTypes:
   * ['messageAdded']` shape (no `labelId`, any new message anywhere in the
   * mailbox) was removed along with automatic mode itself; this is now the
   * only shape this function produces. See EMAIL_INGESTION.md's EM10.6
   * record.
   *
   * Returns a flat, ORDER-PRESERVING list of `{type, messageId}` changes
   * (`labelRemoved` additionally carries `labelIds: string[]`, the actual
   * label(s) removed in that entry, defaulting to `[]` if Gmail's response
   * omits it) — callers reduce this to one final action per message
   * (last-write-wins) rather than this function pre-grouping into added/
   * removed sets, since a message can legitimately be labeled and then
   * unlabeled again within the same page and only the net effect matters
   * (§24.2).
   *
   * Throws `ERROR_CODES.HISTORY_EXPIRED` on Gmail's documented 404 for a
   * `startHistoryId` older than the retained history window — callers must
   * treat this as "fall back to a bounded historical re-scan," never a
   * generic failure (§18.4).
   */
  async function listHistory({ accessToken, startHistoryId, labelId, pageToken, maxResults = 50 }) {
    if (!accessToken) throw new Error('listHistory requires accessToken');
    if (!startHistoryId) throw new Error('listHistory requires startHistoryId');

    // Label-scoped added/removed + deletions (§18.2) — the only shape this
    // function produces since EM10.6 removed automatic mode's unscoped
    // messageAdded shape.
    const types = ['labelAdded', 'labelRemoved', 'messageDeleted'];
    const params = new URLSearchParams({ startHistoryId: String(startHistoryId), maxResults: String(maxResults) });
    for (const type of types) params.append('historyTypes', type);
    if (labelId) params.set('labelId', labelId);
    if (pageToken) params.set('pageToken', pageToken);

    let response;
    try {
      response = await httpClient.get(`${GMAIL_API_BASE}/history?${params.toString()}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: GMAIL_API_TIMEOUT_MS,
      });
    } catch {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail users.history.list request failed');
    }

    if (response && response.status === 404) {
      throw gmailError(ERROR_CODES.HISTORY_EXPIRED, 'Gmail history cursor is expired or invalid');
    }
    if (!response || response.status < 200 || response.status >= 300) {
      throw gmailError(ERROR_CODES.HTTP_ERROR, 'Gmail users.history.list returned an unsuccessful HTTP status');
    }

    const changes = [];
    for (const record of (response.data && response.data.history) || []) {
      for (const entry of record.labelsAdded || []) {
        const messageId = entry.message && entry.message.id;
        if (messageId) changes.push({ type: 'labelAdded', messageId });
      }
      for (const entry of record.labelsRemoved || []) {
        const messageId = entry.message && entry.message.id;
        const labelIds = Array.isArray(entry.labelIds) ? entry.labelIds : [];
        if (messageId) changes.push({ type: 'labelRemoved', messageId, labelIds });
      }
      for (const entry of record.messagesDeleted || []) {
        const messageId = entry.message && entry.message.id;
        if (messageId) changes.push({ type: 'messageDeleted', messageId });
      }
    }

    return {
      changes,
      // Gmail returns the mailbox's current historyId on every page — the
      // caller only needs the LAST page's value as the new cursor once the
      // whole incremental sync completes (§18.2).
      historyId: (response.data && response.data.historyId) ? String(response.data.historyId) : null,
      nextPageToken: (response.data && response.data.nextPageToken) || null,
    };
  }

  return {
    exchangeCodeForToken,
    revokeToken,
    refreshAccessToken,
    listLabels,
    getOrCreateManagedLabel,
    listMessageIdsByQuery,
    getMessageMetadata,
    getMessageBody,
    getThread,
    getMailboxHistoryId,
    listHistory,
  };
}

const defaultService = createGmailService();

module.exports = {
  ...defaultService,
  createGmailService,
  buildAuthorizationUrl,
  validateTokenResponse,
  validateUserInfoResponse,
  isGmailConfigured,
  compileSearchQuery,
  extractEmailAddress,
  parseMessageHeaders,
  decodeBase64Url,
  extractBodyParts,
  REQUIRED_SCOPES,
  MANAGED_LABEL_NAME,
  ERROR_CODES,
};
