const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Lightweight HTTP-level smoke test over the real Express app (app.js),
 * checking route wiring and auth-gating end to end. Deliberately narrow:
 * every request below either has no Authorization header (rejected by
 * clientAuth before any Supabase call is made — see middleware/clientAuth.js)
 * or hits the callback's early-return paths (missing/denied params, resolved
 * before any Supabase or Slack call) — so this file makes no real Slack or
 * Supabase network call, consistent with every other test in this suite.
 * Deeper flow coverage (state consumption, token exchange, callback
 * orchestration) lives in test/slackIntegrationService.test.js,
 * test/oauthStateService.test.js, and test/slackService.test.js, which test
 * the underlying services directly via dependency injection.
 */

process.env.SLACK_CLIENT_ID = process.env.SLACK_CLIENT_ID || 'test-client-id';
process.env.SLACK_CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET || 'test-client-secret';
process.env.SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI || 'https://relativitysystems.ai/api/integrations/slack/callback';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';
process.env.GLOBAL_SUPABASE_ANON_KEY = process.env.GLOBAL_SUPABASE_ANON_KEY || 'test-anon-key';

const app = require('../app');

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('Slack routes — auth gating, retirement, and safe callback redirects', async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await t.test('GET /api/integrations/slack/start requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/slack/start`, { redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/integrations/slack/status requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/slack/status`, { redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  await t.test('POST /api/integrations/slack/disconnect requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/slack/disconnect`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/integrations/slack/callback with a denial error redirects to the safe access_denied path', async () => {
    const res = await fetch(`${base}/api/integrations/slack/callback?error=access_denied`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/portal.html?integration=slack&error=access_denied');
  });

  await t.test('GET /api/integrations/slack/callback with no code/state redirects to invalid_state', async () => {
    const res = await fetch(`${base}/api/integrations/slack/callback`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/portal.html?integration=slack&error=invalid_state');
  });

  await t.test('GET /api/integrations/slack/callback with only a code (no state) redirects to invalid_state', async () => {
    const res = await fetch(`${base}/api/integrations/slack/callback?code=abc`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/portal.html?integration=slack&error=invalid_state');
  });

  await t.test('the old /auth/slack/start route is retired (410 Gone), not the active OAuth path', async () => {
    const res = await fetch(`${base}/auth/slack/start`, { redirect: 'manual' });
    assert.equal(res.status, 410);
  });

  await t.test('the old /auth/slack/callback route is retired (410 Gone), not the active OAuth path', async () => {
    const res = await fetch(`${base}/auth/slack/callback`, { redirect: 'manual' });
    assert.equal(res.status, 410);
  });
});
