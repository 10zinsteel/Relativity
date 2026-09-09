const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * config/index.js reads Slack env vars at require-time, so they must be set
 * before requiring services/slackService.js — the module caches the config
 * snapshot on first require. Sets fake-but-well-formed values; no real
 * network call is ever made (httpClient is dependency-injected in every
 * exchangeCodeForToken/revokeToken test below).
 */
process.env.SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || 'test-client-id';
process.env.SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || 'test-client-secret';
process.env.SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI || 'https://relativitysystems.ai/api/integrations/slack/callback';

const {
  createSlackService,
  buildAuthorizationUrl,
  validateOAuthResponse,
  isSlackConfigured,
  REQUIRED_SCOPES,
  ERROR_CODES,
} = require('../services/slackService');

// ─────────────────────────────────────────────
// Authorization URL
// ─────────────────────────────────────────────

test('buildAuthorizationUrl uses SLACK_CLIENT_ID, the exact redirect URI, and includes the raw state', () => {
  const url = new URL(buildAuthorizationUrl({ state: 'raw-state-value' }));
  assert.equal(url.origin + url.pathname, 'https://slack.com/oauth/v2/authorize');
  assert.equal(url.searchParams.get('client_id'), 'test-client-id');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://relativitysystems.ai/api/integrations/slack/callback');
  assert.equal(url.searchParams.get('state'), 'raw-state-value');
});

test('buildAuthorizationUrl requests exactly the channel-mention and DM scopes — nothing more, nothing less', () => {
  const url = new URL(buildAuthorizationUrl({ state: 's' }));
  const scopes = url.searchParams.get('scope').split(',');
  const expected = ['app_mentions:read', 'chat:write', 'im:history', 'im:read', 'im:write'];
  assert.deepEqual(scopes.sort(), expected.sort());
  assert.deepEqual(REQUIRED_SCOPES.sort(), expected.sort());
});

test('buildAuthorizationUrl never requests incoming-webhook or any excluded scope', () => {
  const url = new URL(buildAuthorizationUrl({ state: 's' }));
  const scopeParam = url.searchParams.get('scope');
  for (const forbidden of ['incoming-webhook', 'channels:history', 'groups:history', 'users:read', 'users:read.email']) {
    assert.equal(scopeParam.includes(forbidden), false, `scope must not include "${forbidden}"`);
  }
});

test('buildAuthorizationUrl never exposes the client secret', () => {
  const url = buildAuthorizationUrl({ state: 's' });
  assert.equal(url.includes('test-client-secret'), false);
});

test('buildAuthorizationUrl requires a state value', () => {
  assert.throws(() => buildAuthorizationUrl({ state: null }), /requires state/);
});

test('isSlackConfigured is true when clientId/clientSecret/redirectUri are all set', () => {
  assert.equal(isSlackConfigured(), true);
});

// ─────────────────────────────────────────────
// validateOAuthResponse — pure, no network
// ─────────────────────────────────────────────

test('validateOAuthResponse accepts a well-formed Slack response and normalizes it', () => {
  const result = validateOAuthResponse({
    ok: true,
    access_token: 'xoxb-real-token',
    team: { id: 'T123', name: 'Acme Corp' },
    bot_user_id: 'U123',
    app_id: 'A123',
    token_type: 'bot',
    scope: 'app_mentions:read,chat:write',
  });
  assert.equal(result.accessToken, 'xoxb-real-token');
  assert.deepEqual(result.team, { id: 'T123', name: 'Acme Corp' });
  assert.equal(result.botUserId, 'U123');
  assert.equal(result.enterprise, null);
  assert.deepEqual(result.scopes, ['app_mentions:read', 'chat:write']);
});

test('validateOAuthResponse captures optional enterprise metadata when present', () => {
  const result = validateOAuthResponse({
    ok: true,
    access_token: 'xoxb-x',
    team: { id: 'T1', name: 'Acme' },
    bot_user_id: 'U1',
    enterprise: { id: 'E1', name: 'Acme Enterprise' },
  });
  assert.deepEqual(result.enterprise, { id: 'E1', name: 'Acme Enterprise' });
});

test('validateOAuthResponse rejects ok: false', () => {
  assert.throws(
    () => validateOAuthResponse({ ok: false, error: 'invalid_code' }),
    (err) => err.code === ERROR_CODES.OAUTH_FAILED
  );
});

test('validateOAuthResponse rejects a missing access_token', () => {
  assert.throws(
    () => validateOAuthResponse({ ok: true, team: { id: 'T1' }, bot_user_id: 'U1' }),
    (err) => err.code === ERROR_CODES.INVALID_RESPONSE
  );
});

test('validateOAuthResponse rejects a missing team id', () => {
  assert.throws(
    () => validateOAuthResponse({ ok: true, access_token: 'xoxb-x', bot_user_id: 'U1' }),
    (err) => err.code === ERROR_CODES.INVALID_RESPONSE
  );
});

test('validateOAuthResponse rejects a missing bot_user_id', () => {
  assert.throws(
    () => validateOAuthResponse({ ok: true, access_token: 'xoxb-x', team: { id: 'T1' } }),
    (err) => err.code === ERROR_CODES.INVALID_RESPONSE
  );
});

test('validateOAuthResponse rejects a non-object response', () => {
  assert.throws(() => validateOAuthResponse(null), (err) => err.code === ERROR_CODES.INVALID_RESPONSE);
  assert.throws(() => validateOAuthResponse('oops'), (err) => err.code === ERROR_CODES.INVALID_RESPONSE);
});

// ─────────────────────────────────────────────
// exchangeCodeForToken / revokeToken — DI'd httpClient, no real network
// ─────────────────────────────────────────────

test('exchangeCodeForToken posts client_id/client_secret/code/redirect_uri and returns the validated result', async () => {
  let captured = null;
  const fakeHttp = {
    post: async (url, body, opts) => {
      captured = { url, body, opts };
      return {
        status: 200,
        data: { ok: true, access_token: 'xoxb-token', team: { id: 'T1', name: 'Acme' }, bot_user_id: 'U1', scope: 'app_mentions:read,chat:write' },
      };
    },
  };
  const service = createSlackService({ httpClient: fakeHttp });

  const result = await service.exchangeCodeForToken('the-code');

  assert.equal(captured.url, 'https://slack.com/api/oauth.v2.access');
  assert.equal(captured.opts.auth.username, 'test-client-id');
  assert.equal(captured.opts.auth.password, 'test-client-secret');
  assert.ok(captured.body.includes('code=the-code'));
  assert.ok(captured.body.includes('redirect_uri='));
  assert.ok(typeof captured.opts.timeout === 'number' && captured.opts.timeout > 0);
  assert.equal(result.accessToken, 'xoxb-token');
});

test('exchangeCodeForToken rejects a non-2xx HTTP response', async () => {
  const fakeHttp = { post: async () => ({ status: 500, data: { ok: false } }) };
  const service = createSlackService({ httpClient: fakeHttp });
  await assert.rejects(() => service.exchangeCodeForToken('code'), (err) => err.code === ERROR_CODES.HTTP_ERROR);
});

test('exchangeCodeForToken rejects when the HTTP client throws (network error)', async () => {
  const fakeHttp = { post: async () => { throw new Error('ECONNRESET'); } };
  const service = createSlackService({ httpClient: fakeHttp });
  await assert.rejects(() => service.exchangeCodeForToken('code'), (err) => err.code === ERROR_CODES.HTTP_ERROR);
});

test('exchangeCodeForToken rejects an invalid (non-object) JSON body', async () => {
  const fakeHttp = { post: async () => ({ status: 200, data: 'not-json-object' }) };
  const service = createSlackService({ httpClient: fakeHttp });
  await assert.rejects(() => service.exchangeCodeForToken('code'), (err) => err.code === ERROR_CODES.INVALID_RESPONSE);
});

test('exchangeCodeForToken rejects a Slack ok:false response', async () => {
  const fakeHttp = { post: async () => ({ status: 200, data: { ok: false, error: 'invalid_code' } }) };
  const service = createSlackService({ httpClient: fakeHttp });
  await assert.rejects(() => service.exchangeCodeForToken('code'), (err) => err.code === ERROR_CODES.OAUTH_FAILED);
});

test('exchangeCodeForToken never leaks the client secret in a thrown error message', async () => {
  const fakeHttp = { post: async () => { throw new Error('boom with secret test-client-secret leaked'); } };
  const service = createSlackService({ httpClient: fakeHttp });
  try {
    await service.exchangeCodeForToken('code');
    assert.fail('expected exchangeCodeForToken to throw');
  } catch (err) {
    assert.equal(err.message.includes('test-client-secret'), false);
  }
});

test('revokeToken returns true on a successful Slack auth.revoke response', async () => {
  const fakeHttp = { post: async (url, _body, opts) => ({ status: 200, data: { ok: true }, _url: url, _opts: opts }) };
  const service = createSlackService({ httpClient: fakeHttp });
  const result = await service.revokeToken('xoxb-token');
  assert.equal(result, true);
});

test('revokeToken returns false (never throws) when the HTTP call fails', async () => {
  const fakeHttp = { post: async () => { throw new Error('network down'); } };
  const service = createSlackService({ httpClient: fakeHttp });
  const result = await service.revokeToken('xoxb-token');
  assert.equal(result, false);
});

test('revokeToken returns false for a missing token without calling the HTTP client', async () => {
  let called = false;
  const fakeHttp = { post: async () => { called = true; return { status: 200, data: { ok: true } }; } };
  const service = createSlackService({ httpClient: fakeHttp });
  const result = await service.revokeToken(null);
  assert.equal(result, false);
  assert.equal(called, false);
});

test('revokeToken sends the token as a Bearer header, never as a query/body param that could be logged with the URL', async () => {
  let captured = null;
  const fakeHttp = { post: async (url, body, opts) => { captured = { url, body, opts }; return { status: 200, data: { ok: true } }; } };
  const service = createSlackService({ httpClient: fakeHttp });
  await service.revokeToken('xoxb-secret-token');
  assert.equal(captured.url.includes('xoxb-secret-token'), false);
  assert.equal(captured.opts.headers.Authorization, 'Bearer xoxb-secret-token');
});
