const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Lightweight HTTP-level smoke test over the real Express app (app.js),
 * checking route wiring and auth-gating end to end. Deliberately narrow,
 * mirroring test/slackRoutes.test.js exactly: every request below either has
 * no Authorization header (rejected by clientAuth before any Supabase call
 * is made — see middleware/clientAuth.js) or hits the callback's early-return
 * paths (missing/denied params, unsupported provider — all resolved before
 * any Supabase or Gmail call), so this file makes no real Gmail or Supabase
 * network call, consistent with every other test in this suite. The route's
 * own owns-this-connection-OR-owner/admin auth check (routes/integrations/email.js's
 * POST /connections/:id/disconnect) and the cross-member isolation it
 * enforces are covered at the service layer in
 * test/emailConnectionService.test.js — EM2's own spec explicitly calls for
 * that coverage as a two-member test proving member A cannot see/mutate
 * member B's connection. A real authenticated-session route test would
 * require mocking Supabase's auth.getUser, which is outside this repo's
 * existing testing convention (no test database, no mocking library).
 */

process.env.GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || 'test-gmail-client-id';
process.env.GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || 'test-gmail-client-secret';
process.env.GMAIL_REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || 'https://relativitysystems.ai/api/integrations/email/gmail/callback';
process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';
process.env.GLOBAL_SUPABASE_ANON_KEY = process.env.GLOBAL_SUPABASE_ANON_KEY || 'test-anon-key';
process.env.SERVICE_REQUEST_SIGNING_SECRET = process.env.SERVICE_REQUEST_SIGNING_SECRET || 'test-service-request-secret';

const app = require('../app');

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('Email integration routes — auth gating and safe callback redirects', async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // EM10.6 removed POST /sync/tick along with Automatic Email Ingestion
  // itself — see EMAIL_INGESTION.md's EM10.6 record. The system-scoped
  // envelope mechanism it used (requireSystemServiceRequest/
  // serviceRequestAuth.js) remains — it's shared infrastructure, still used
  // by POST /api/tools/execute — but this route no longer exists.

  await t.test('GET /api/integrations/email/gmail/start requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/gmail/start`, { redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/integrations/email/connections requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/connections`, { redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  await t.test('POST /api/integrations/email/connections/:id/disconnect requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/connections/conn-1/disconnect`, { method: 'POST', redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  // EM3 — organization policy engine routes (§14.1). GET/PUT /policy and
  // GET/PUT /settings all require clientAuth like every other route above;
  // PUT's additional owner/admin gate (requireOwnerAdmin) runs only after
  // clientAuth succeeds, so it can't be exercised here without a real
  // authenticated session — same limitation this file's header comment
  // already documents for the disconnect route's ownership check.
  await t.test('GET /api/integrations/email/policy requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/policy`, { redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  await t.test('PUT /api/integrations/email/policy requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rules: [] }),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/integrations/email/settings requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/settings`, { redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  await t.test('PUT /api/integrations/email/settings requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ liveLookupEnabled: true }),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
  });

  // EM4 — member mailbox settings routes (§14.1, §31). member-settings'
  // self-service-only scope runs only after clientAuth succeeds, so — same
  // limitation this file's header comment already documents for
  // disconnect's and PUT /policy|/settings's role gates — it isn't
  // exercised here without a real authenticated session; that coverage
  // lives in test/emailConnectionService.test.js instead. (EM10.6 removed
  // POST /connections/:id/sync-mode along with Automatic Email Ingestion
  // itself — see EMAIL_INGESTION.md's EM10.6 record.)

  // EM8's pause/resume routes were removed in EM10.7 — see
  // EMAIL_INGESTION.md's EM10.7 record.

  await t.test('GET /api/integrations/email/member-settings requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/member-settings`, { redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  await t.test('PUT /api/integrations/email/member-settings requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/member-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ searchEnabled: false }),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
  });

  // EL6 — the member's own live-lookup consent record (§2.3, §7). Same
  // limitation as member-settings above (no real authenticated-session
  // route test without mocking Supabase auth) — the gate logic itself
  // (an un-consented member's questions never reach tool-offering) is
  // covered at the service layer in test/emailLiveLookupService.test.js.
  await t.test('GET /api/integrations/email/live-lookup-settings requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/live-lookup-settings`, { redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  await t.test('PUT /api/integrations/email/live-lookup-settings requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/live-lookup-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consent: true }),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
  });

  // EM5 — label-query dry-run preview (§14.1, §17, §31). Same limitation as
  // disconnect above: the owns-this-connection gate and the live
  // Gmail-call path (getValidGmailAccessToken/ensureManagedLabel/buildPreview)
  // run only after clientAuth succeeds, so they aren't exercised here; see
  // test/emailConnectionService.test.js and test/emailPreviewService.test.js.
  await t.test('POST /api/integrations/email/connections/:id/preview requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/connections/conn-1/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
  });

  // EM6 — historical import (§14.2, §15, §17, §31). Same limitation as
  // preview above: the owns-this-connection gate and the real sync path run
  // only after clientAuth succeeds; see test/emailSyncService.test.js for
  // the orchestration logic's own DI-faked coverage.
  await t.test('POST /api/integrations/email/connections/:id/sync requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/connections/conn-1/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/integrations/email/connections/:id/sync-runs requires authentication', async () => {
    const res = await fetch(`${base}/api/integrations/email/connections/conn-1/sync-runs`, { redirect: 'manual' });
    assert.equal(res.status, 401);
  });

  await t.test('GET /api/integrations/email/gmail/callback with a denial error redirects to the safe access_denied path', async () => {
    const res = await fetch(`${base}/api/integrations/email/gmail/callback?error=access_denied`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/portal.html?integration=gmail&error=access_denied');
  });

  await t.test('GET /api/integrations/email/gmail/callback with no code/state redirects to invalid_state', async () => {
    const res = await fetch(`${base}/api/integrations/email/gmail/callback`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/portal.html?integration=gmail&error=invalid_state');
  });

  await t.test('GET /api/integrations/email/gmail/callback with only a code (no state) redirects to invalid_state', async () => {
    const res = await fetch(`${base}/api/integrations/email/gmail/callback?code=abc`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/portal.html?integration=gmail&error=invalid_state');
  });

  await t.test('GET /api/integrations/email/microsoft/callback (unsupported provider) redirects to invalid_state, not a 500 or JSON error', async () => {
    const res = await fetch(`${base}/api/integrations/email/microsoft/callback`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/portal.html?integration=gmail&error=invalid_state');
  });
});
