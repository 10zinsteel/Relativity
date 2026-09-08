'use strict';

// Gmail OAuth connection routes (EM2 — Architecture/architecture/
// EMAIL_INGESTION.md §14.1), extended in EM3 with organization policy
// (/policy, /settings), in EM4 with the member mailbox settings surface
// (/member-settings), in EM5 with the label-query dry-run preview
// (/connections/:id/preview), and in EM6 with real historical import
// (/connections/:id/sync) — the first route in this file that actually
// forwards content to AIKB. EM10.6 removed Automatic Email Ingestion
// (/connections/:id/sync-mode and /sync/tick, along with automatic mode
// itself) — Gmail ingestion is label-driven only now, see
// EMAIL_INGESTION.md's EM10.6 record. Thin Express adapter — all
// logic lives in services/emailConnectionService.js / services/
// emailPolicyService.js / services/emailPreviewService.js /
// services/emailSyncService.js / services/supabaseService.js so it stays
// unit-testable without an HTTP layer. Mounted at /api/integrations/email
// in app.js.
//
// clientId/memberId are ALWAYS resolved server-side by clientAuth from the
// authenticated Supabase session — never accepted from the browser.
//
// Connecting, status, and disconnect are ALL self-service in EM2 — any
// active member, role != viewer, acting only on their OWN connection.
// Deliberately narrower than §14.1's general route table (which describes
// disconnect as "connection's own member or owner/admin"): for a
// consent-sensitive feature like a personal mailbox connection, EM2 does
// not give owners/admins any override to disconnect another member's
// Gmail account. That administrative/offboarding capability belongs to
// EM9 (member offboarding and policy reconciliation), not this milestone
// — see the EM2 Implementation Record in EMAIL_INGESTION.md. Enforced via
// emailConnectionService.canDisconnectConnection, checked after loading the
// target connection (it can't be a pre-route middleware like requireRole
// since it needs the row's connected_by_member_id first).

const express = require('express');
const router = express.Router();
const clientAuth = require('../../middleware/clientAuth');
const emailConnectionService = require('../../services/emailConnectionService');
const oauthConnectionsService = require('../../services/oauthConnectionsService');
const gmailService = require('../../services/gmailService');
const emailPolicyService = require('../../services/emailPolicyService');
const emailPreviewService = require('../../services/emailPreviewService');
const emailSyncService = require('../../services/emailSyncService');
const supabaseService = require('../../services/supabaseService');
const { REDIRECT, PROVIDER, canDisconnectConnection } = emailConnectionService;

const OWNER_ADMIN = ['owner', 'admin'];
const SUPPORTED_PROVIDERS = [PROVIDER]; // just 'gmail' for EM2 — microsoft is EM12

// The owner/admin closure §14.1's own file-level comment anticipated this
// milestone would need, alongside the pre-existing owns-this-connection
// inline check below (§4.1's "no shared requireRole middleware" gap is not
// fixed platform-wide by this, just given a local, reusable name here —
// matches routes/collections.js's own local requireRole precedent).
function requireOwnerAdmin(req, res, next) {
  if (!req.member || !OWNER_ADMIN.includes(req.member.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
}

/**
 * GET /api/integrations/email/:provider/start
 * Self-service: any active member whose role isn't `viewer` — connecting
 * authorizes access to the member's OWN mailbox, not an organization-wide
 * action, so this is deliberately NOT owner/admin-gated like Slack's /start.
 * Returns JSON { url } — the portal redirects the browser there.
 */
router.get('/:provider/start', clientAuth, async (req, res) => {
  const { provider } = req.params;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.status(400).json({ error: `Unsupported email provider "${provider}".` });
  }
  if (req.member.role === 'viewer') {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  try {
    const { url } = await emailConnectionService.startConnection({
      clientId: req.client.id,
      memberId: req.member.id,
      provider,
    });
    res.json({ url });
  } catch (err) {
    if (err.code === 'GMAIL_NOT_CONFIGURED') {
      return res.status(500).json({ error: 'Gmail integration is not configured on the server.' });
    }
    console.error(`GET /api/integrations/email/${provider}/start error:`, err.message);
    res.status(500).json({ error: 'Could not start the Gmail connection. Please try again.' });
  }
});

/**
 * GET /api/integrations/email/:provider/callback
 * Public — Google redirects the browser here with no bearer token. All
 * client/member context comes from the consumed oauth_states row, never
 * from query parameters. Always redirects; never renders JSON, so a raw
 * error/state/token can never end up in a JSON error body either.
 */
router.get('/:provider/callback', async (req, res) => {
  const { provider } = req.params;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    return res.redirect(REDIRECT.INVALID_STATE);
  }
  const { code, state, error } = req.query;
  const { redirectPath } = await emailConnectionService.handleCallback({
    code: typeof code === 'string' ? code : null,
    state: typeof state === 'string' ? state : null,
    error: typeof error === 'string' ? error : null,
  });
  res.redirect(redirectPath);
});

/**
 * GET /api/integrations/email/connections
 * Any authenticated, active member sees their own connection by default.
 * `?all=true` only takes effect for owner/admin callers (silently ignored
 * otherwise, fail-safe) — the admin console's future per-client roster view
 * (§27) will use this same param. This is a read-only visibility grant, not
 * a mutation authority — distinct from disconnect below, which owners/admins
 * do NOT get an override for in EM2.
 *
 * `configured` reflects whether Gmail OAuth is set up on the server at all
 * (independent of any specific connection) — the portal uses this to hide
 * the Connect button entirely rather than let a member click it and get a
 * failure only after the fact.
 */
router.get('/connections', clientAuth, async (req, res) => {
  try {
    const isOwnerAdmin = OWNER_ADMIN.includes(req.member.role);
    const result = await emailConnectionService.getConnections({
      clientId: req.client.id,
      memberId: req.member.id,
      isOwnerAdmin,
      all: req.query.all === 'true',
    });
    res.json({ ...result, configured: gmailService.isGmailConfigured() });
  } catch (err) {
    console.error('GET /api/integrations/email/connections error:', err.message);
    res.status(500).json({ error: 'Could not load email connections.' });
  }
});

/**
 * POST /api/integrations/email/connections/:id/disconnect
 * Self-service (the connection's own member) OR — as of EM9 — owner/admin,
 * matching §14.1's route table (the EM2 Implementation Record flagged the
 * owner/admin branch and the cleanupIngestedContent body param as
 * deliberately out of scope until this milestone). The ownership-or-admin
 * check happens here, inline, after loading the target row — it can't be a
 * pre-route middleware since it needs connected_by_member_id first. Body:
 * optional `{cleanupIngestedContent: boolean}` (§24) — when true, every
 * document this member contributed is enumerated and deleted as part of
 * the same call (services/emailConnectionService.js#cleanupMemberContent).
 */
router.post('/connections/:id/disconnect', clientAuth, async (req, res) => {
  const { id } = req.params;
  const { cleanupIngestedContent } = req.body || {};
  try {
    const connection = await oauthConnectionsService.getConnectionById(id);
    if (!connection || connection.client_id !== req.client.id || connection.provider !== PROVIDER) {
      return res.status(404).json({ error: 'Connection not found.' });
    }
    const isOwnerAdmin = OWNER_ADMIN.includes(req.member.role);
    if (!canDisconnectConnection({ connection, actingMemberId: req.member.id }) && !isOwnerAdmin) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const result = await emailConnectionService.disconnect({
      clientId: req.client.id,
      connectionId: id,
      cleanupIngestedContent: cleanupIngestedContent === true,
    });
    res.json(result);
  } catch (err) {
    console.error('POST /api/integrations/email/connections/:id/disconnect error:', err.message);
    res.status(500).json({ error: 'Could not disconnect Gmail. Please try again.' });
  }
});

// EM8's pause/resume routes (POST /connections/:id/pause, /resume) were
// removed in EM10.7 — see EMAIL_INGESTION.md's EM10.7 record. A member who
// wants to stop syncing now disconnects; there is no lighter-weight
// temporary-stop control.

/**
 * GET /api/integrations/email/member-settings
 * PUT /api/integrations/email/member-settings
 * Self-service, own row only (EM4 — §7, §13.1, §31). Distinct from GET/PUT
 * /settings above, which is the org-wide live-lookup switch — this is
 * the member's own `client_members.search_enabled` gate: off means nothing
 * from this member's mailbox ever becomes searchable, regardless of sync
 * mode or label (§Policy Evaluation Model). `req.member` is already loaded
 * by clientAuth with `search_enabled` selected.
 */
router.get('/member-settings', clientAuth, async (req, res) => {
  res.json({ searchEnabled: req.member.search_enabled !== false });
});

router.put('/member-settings', clientAuth, async (req, res) => {
  const { searchEnabled } = req.body;
  if (typeof searchEnabled !== 'boolean') {
    return res.status(400).json({ error: 'searchEnabled must be a boolean' });
  }
  try {
    const updated = await supabaseService.updateClientMember(req.member.id, req.client.id, { search_enabled: searchEnabled });
    res.json({ searchEnabled: updated.search_enabled });
  } catch (err) {
    console.error('PUT /api/integrations/email/member-settings error:', err.message);
    res.status(500).json({ error: 'Could not save your settings.' });
  }
});

/**
 * POST /api/integrations/email/connections/:id/preview
 * Self-service only (EM5 — §14.1, §17, §31), same ownership shape as
 * disconnect above (reuses canDisconnectConnection). Dry-run: compiles the
 * Relativity/Knowledge label query plus organization policy, lists a
 * bounded page of candidates, and re-verifies each one locally via the
 * Policy Evaluation Model (§16) — never fetches message bodies, never
 * persists anything, never ingests. Body: optional `{pageToken}` to
 * continue a prior call's pagination.
 */
router.post('/connections/:id/preview', clientAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const connection = await oauthConnectionsService.getConnectionById(id);
    if (!connection || connection.client_id !== req.client.id || connection.provider !== PROVIDER) {
      return res.status(404).json({ error: 'Connection not found.' });
    }
    if (!canDisconnectConnection({ connection, actingMemberId: req.member.id })) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const emailConnectionRow = await emailConnectionService.getEmailConnectionRecord(id);
    if (!emailConnectionRow) {
      return res.status(404).json({ error: 'Connection not found.' });
    }

    let accessToken;
    try {
      accessToken = await emailConnectionService.getValidGmailAccessToken(id);
    } catch (err) {
      if (err.code === 'AUTHORIZATION_EXPIRED') {
        return res.status(400).json({ error: 'Gmail authorization has expired. Please reconnect your mailbox.' });
      }
      throw err;
    }

    emailConnectionRow.managed_label_id = await emailConnectionService.ensureManagedLabel({
      oauthConnectionId: id,
      emailConnectionRow,
      accessToken,
    });

    const { pageToken } = req.body || {};
    const result = await emailPreviewService.buildPreview({
      clientId: req.client.id,
      emailConnectionRow,
      accessToken,
      pageToken: typeof pageToken === 'string' ? pageToken : null,
    });
    res.json(result);
  } catch (err) {
    console.error('POST /api/integrations/email/connections/:id/preview error:', err.message);
    res.status(500).json({ error: 'Could not generate preview.' });
  }
});

/**
 * POST /api/integrations/email/connections/:id/sync
 * Self-service only (EM6/EM7 — §14.2, §15, §17, §18, §31), same ownership
 * shape as preview above (reuses canDisconnectConnection). Runs one bounded
 * page of sync — historical (EM6) or incremental (EM7), decided
 * automatically from the connection's stored cursor.
 * Body: optional `{pageToken, runType}` to continue a prior call's
 * pagination — EM7 requires BOTH together when resuming (the response
 * always echoes the `runType` a caller must pass back, since a resumed page
 * needs to know whether to continue a full re-scan or a history-diff read).
 * Returns a `{syncRunId, runType, status, complete, nextPageToken,
 * imported, skipped, failed, reconciled, restored, errorSummary}` summary — the same
 * structured-summary UX pattern already proven for ZIP import (§27).
 */
router.post('/connections/:id/sync', clientAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const connection = await oauthConnectionsService.getConnectionById(id);
    if (!connection || connection.client_id !== req.client.id || connection.provider !== PROVIDER) {
      return res.status(404).json({ error: 'Connection not found.' });
    }
    if (!canDisconnectConnection({ connection, actingMemberId: req.member.id })) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const emailConnectionRow = await emailConnectionService.getEmailConnectionRecord(id);
    if (!emailConnectionRow) {
      return res.status(404).json({ error: 'Connection not found.' });
    }

    let accessToken;
    try {
      accessToken = await emailConnectionService.getValidGmailAccessToken(id);
    } catch (err) {
      if (err.code === 'AUTHORIZATION_EXPIRED') {
        return res.status(400).json({ error: 'Gmail authorization has expired. Please reconnect your mailbox.' });
      }
      throw err;
    }

    emailConnectionRow.managed_label_id = await emailConnectionService.ensureManagedLabel({
      oauthConnectionId: id,
      emailConnectionRow,
      accessToken,
    });

    const { pageToken, runType } = req.body || {};
    const result = await emailSyncService.syncConnection({
      clientId: req.client.id,
      emailConnectionRow,
      memberSearchEnabled: req.member.search_enabled !== false,
      accessToken,
      triggeredByMemberId: req.member.id,
      pageToken: typeof pageToken === 'string' ? pageToken : null,
      runType: typeof runType === 'string' ? runType : null,
    });
    res.json(result);
  } catch (err) {
    if (err.code && Object.values(emailSyncService.ERROR_CODES).includes(err.code)) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    console.error('POST /api/integrations/email/connections/:id/sync error:', err.message);
    res.status(500).json({ error: 'Could not sync this connection.' });
  }
});

/**
 * GET /api/integrations/email/connections/:id/sync-runs
 * Self-service only (EM7 — §27, §31), same ownership shape as sync/preview
 * above. Returns `{syncRuns: [...]}`, newest first — the portal's sync-run
 * history view (§7).
 */
router.get('/connections/:id/sync-runs', clientAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const connection = await oauthConnectionsService.getConnectionById(id);
    if (!connection || connection.client_id !== req.client.id || connection.provider !== PROVIDER) {
      return res.status(404).json({ error: 'Connection not found.' });
    }
    if (!canDisconnectConnection({ connection, actingMemberId: req.member.id })) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    const emailConnectionRow = await emailConnectionService.getEmailConnectionRecord(id);
    if (!emailConnectionRow) {
      return res.status(404).json({ error: 'Connection not found.' });
    }

    const syncRuns = await emailSyncService.listSyncRuns(emailConnectionRow.id);
    res.json({ syncRuns });
  } catch (err) {
    console.error('GET /api/integrations/email/connections/:id/sync-runs error:', err.message);
    res.status(500).json({ error: 'Could not load sync history.' });
  }
});

/**
 * GET /api/integrations/email/policy
 * Any active member — every member sees the same organization policy that
 * bounds their own mailbox, not just owners/admins (§14.1, §16.1: "a
 * configured allow rule's effect is immediately visible to every connected
 * member").
 */
router.get('/policy', clientAuth, async (req, res) => {
  try {
    const result = await emailPolicyService.getPolicy(req.client.id);
    res.json(result);
  } catch (err) {
    console.error('GET /api/integrations/email/policy error:', err.message);
    res.status(500).json({ error: 'Could not load organization policy.' });
  }
});

/**
 * PUT /api/integrations/email/policy
 * owner/admin only (§14.1). Body: { rules: [...] }. Replaces the FULL rule
 * set — fail-closed: {rules: []} means ingest nothing, from anyone, in any
 * mode (§16.1 item 6), enforced by emailPolicyService.replacePolicy's
 * delete-then-insert order.
 */
router.put('/policy', clientAuth, requireOwnerAdmin, async (req, res) => {
  const { rules } = req.body;
  if (!Array.isArray(rules)) {
    return res.status(400).json({ error: 'rules must be an array' });
  }
  try {
    const result = await emailPolicyService.replacePolicy({
      clientId: req.client.id,
      rules,
      updatedByMemberId: req.member.id,
    });
    res.json(result);
  } catch (err) {
    if (err.status === 400) {
      return res.status(400).json({ error: err.message });
    }
    console.error('PUT /api/integrations/email/policy error:', err.message);
    res.status(500).json({ error: 'Could not save organization policy.' });
  }
});

/**
 * GET /api/integrations/email/settings
 * Any active member — reads the org-wide live-lookup switch. Fails closed
 * (liveLookupEnabled: false) when the client has never visited this
 * setting, since email_organization_settings is created lazily (§13.1).
 * (This route used to also carry automaticSyncEnabled, the org-wide
 * Automatic Email Ingestion switch — removed in EM10.6, see
 * EMAIL_INGESTION.md's EM10.6 record.)
 */
router.get('/settings', clientAuth, async (req, res) => {
  try {
    const result = await emailPolicyService.getSettings(req.client.id);
    res.json(result);
  } catch (err) {
    console.error('GET /api/integrations/email/settings error:', err.message);
    res.status(500).json({ error: 'Could not load email settings.' });
  }
});

/**
 * PUT /api/integrations/email/settings
 * owner/admin only (§14.1). Body: { liveLookupEnabled }. Toggles the
 * org-wide live-lookup switch (§2.1, EL6).
 */
router.put('/settings', clientAuth, requireOwnerAdmin, async (req, res) => {
  const { liveLookupEnabled } = req.body;
  if (typeof liveLookupEnabled !== 'boolean') {
    return res.status(400).json({ error: 'liveLookupEnabled must be a boolean' });
  }
  try {
    const result = await emailPolicyService.updateSettings({
      clientId: req.client.id,
      liveLookupEnabled,
      updatedByMemberId: req.member.id,
    });
    res.json(result);
  } catch (err) {
    console.error('PUT /api/integrations/email/settings error:', err.message);
    res.status(500).json({ error: 'Could not save email settings.' });
  }
});

/**
 * GET /api/integrations/email/live-lookup-settings
 * PUT /api/integrations/email/live-lookup-settings
 * Self-service, own row only (EL6 — LIVE_EMAIL_LOOKUP.md §2.3, §7). This is
 * the member's own one-time product consent for LIVE, per-question mailbox
 * use — explicitly separate from Gmail's OAuth scope grant (already given
 * at connect time) and from search_enabled (which gates ingestion
 * contribution, not live lookup). `consentedAt: null` blocks tool-offering
 * and is what the portal's consent modal gates on (§2.3's fail-closed
 * pattern, matching every other email-feature gate in this codebase).
 *
 * PUT also flips the member's own Gmail connection's live_lookup_enabled
 * flag in the same call (§2.3's "Revocation" toggle IS the consent record —
 * one user-facing on/off, not two independently-tracked switches) — a no-op
 * if the member has no active connection yet.
 */
router.get('/live-lookup-settings', clientAuth, async (req, res) => {
  res.json({ consentedAt: req.member.live_lookup_consented_at || null });
});

router.put('/live-lookup-settings', clientAuth, async (req, res) => {
  const { consent } = req.body;
  if (typeof consent !== 'boolean') {
    return res.status(400).json({ error: 'consent must be a boolean' });
  }
  try {
    const consentedAt = consent ? new Date().toISOString() : null;
    const updated = await supabaseService.updateClientMember(req.member.id, req.client.id, { live_lookup_consented_at: consentedAt });
    await emailConnectionService.setLiveLookupEnabledForOwnConnection({
      clientId: req.client.id,
      memberId: req.member.id,
      enabled: consent,
    });
    res.json({ consentedAt: updated.live_lookup_consented_at || null });
  } catch (err) {
    console.error('PUT /api/integrations/email/live-lookup-settings error:', err.message);
    res.status(500).json({ error: 'Could not save your live email search setting.' });
  }
});

module.exports = router;
