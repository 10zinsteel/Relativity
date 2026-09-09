const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Lightweight HTTP-level smoke test over the real Express app (app.js),
 * mirroring test/emailRoutes.test.js's pattern: only auth-gating is
 * exercised here (no ADMIN_JWT_SECRET-signed token in this run), so no real
 * Supabase/Gmail call is ever made. The route's actual disconnect behavior
 * (owner/admin override, cleanupIngestedContent, label-strip) is covered at
 * the service layer in test/emailConnectionService.test.js — this file only
 * proves EM10.5 Bug 11's fix is actually wired into the running app and
 * gated the same way every other admin route is.
 */

process.env.GLOBAL_SUPABASE_URL = process.env.GLOBAL_SUPABASE_URL || 'https://example.supabase.co';
process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY = process.env.GLOBAL_SUPABASE_SERVICE_ROLE_KEY || 'test-service-key';
process.env.GLOBAL_SUPABASE_ANON_KEY = process.env.GLOBAL_SUPABASE_ANON_KEY || 'test-anon-key';
process.env.SERVICE_REQUEST_SIGNING_SECRET = process.env.SERVICE_REQUEST_SIGNING_SECRET || 'test-service-request-secret';
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'test-admin-jwt-secret';

const app = require('../app');

function startServer() {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('POST /admin/clients/:clientId/email-connections/:connectionId/disconnect (EM10.5 Bug 11) requires admin auth', async (t) => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await t.test('no x-admin-token is rejected', async () => {
    const res = await fetch(`${base}/admin/clients/client-a/email-connections/conn-1/disconnect`, {
      method: 'POST',
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
  });

  await t.test('an invalid x-admin-token is rejected', async () => {
    const res = await fetch(`${base}/admin/clients/client-a/email-connections/conn-1/disconnect`, {
      method: 'POST',
      headers: { 'x-admin-token': 'not-a-real-token' },
      redirect: 'manual',
    });
    assert.equal(res.status, 401);
  });
});
