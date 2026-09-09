'use strict';

// Gmail OAuth connection flow orchestration (EM2 — Architecture/architecture/
// EMAIL_INGESTION.md §12, §14.1). Mirrors services/slackIntegrationService.js's
// shape and testing approach (dependency injection, no real network/Supabase
// calls in tests) with the one structural difference EM2 introduces:
// connections are member-scoped, not client-scoped — multiple members of the
// same client can each have their own active Gmail connection, so every
// function here takes/threads memberId, and disconnect only ever revokes the
// specific connection it was asked to, never every connection for the client.
//
// No organization policy or sync/ingestion logic lives here — those are
// EM3/EM6+. This file connects/lists/disconnects (EM2), and, as of EM5,
// creates/reuses the managed "Relativity/Knowledge" Gmail label on connect
// and keeps a connection's access token valid on demand
// (getValidGmailAccessToken) for services/emailPreviewService.js's dry-run
// preview to call — still no ingestion (EM6) or real sync run here.
// (EM4 originally let a member switch their own connection's sync_mode
// between manual_selected/automatic; that endpoint and Automatic Email
// Ingestion itself were removed in EM10.6 — Gmail ingestion is label-driven
// only now, see EMAIL_INGESTION.md's EM10.6 record. EM8's pause/resume
// lifecycle control was removed in EM10.7 — see EMAIL_INGESTION.md's EM10.7
// record — so sync_mode is now fixed at 'manual_selected' for the life of a
// connection; only a full disconnect/reconnect ever changes it.)
//
// Disconnect was self-service ONLY in EM2 — a member could disconnect only
// their own connection, with no owner/admin override, even though §14.1's
// general route table always described the eventual full-feature shape as
// "connection's own member or owner/admin." That administrative override,
// plus the cleanupIngestedContent body param, is EM9's (member offboarding
// and policy reconciliation) — see disconnect() below and the EM9
// Implementation Record in EMAIL_INGESTION.md. canDisconnectConnection
// itself is UNCHANGED by EM9 — it still expresses only "is this your own
// connection," since sync/preview both reuse it for their own
// self-service-only shape, which EM9 does not touch; the owner/admin
// override lives only in the disconnect route's own authorization check,
// not in this shared predicate.

const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');
const defaultOauthStateService = require('./oauthStateService');
const defaultGmailService = require('./gmailService');
const defaultOauthConnectionsService = require('./oauthConnectionsService');
const defaultSupabaseService = require('./supabaseService');
const defaultAikbService = require('./aikbService');

// EM5 — refresh a stored Gmail access token this many ms before its known
// expiry, not only after it has already failed. Gmail access tokens are
// short-lived (~1 hour, §12 item 3) so any call more than a few minutes
// after connect needs this; 5 minutes is a conservative margin against
// clock skew and the time a preview call itself takes to run.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const PROVIDER = 'gmail';

// Safe portal redirects — never carry a raw error string, state, token, or
// mailbox address. Mirrors slackIntegrationService.js's REDIRECT constants.
const REDIRECT = Object.freeze({
  SUCCESS: '/portal.html?integration=gmail&status=connected',
  DENIED: '/portal.html?integration=gmail&error=access_denied',
  INVALID_STATE: '/portal.html?integration=gmail&error=invalid_state',
  EXPIRED_STATE: '/portal.html?integration=gmail&error=expired_state',
  CONNECTION_FAILED: '/portal.html?integration=gmail&error=connection_failed',
});

// Thin, EM2-only data access for the email_connections table (§13.1) — the
// one satellite table Gmail's connect flow needs that Slack's flow never
// did, since Slack has no per-connection metadata table of its own.
// Injectable like every other dependency below, so tests never touch a real
// Supabase project.
const defaultDbClient = createClient(supabaseConfig.url, supabaseConfig.serviceKey);

const defaultEmailConnectionsRepo = {
  async upsertConnection({ clientId, memberId, oauthConnectionId, provider, mailboxAddress, displayName, managedLabelId }) {
    const { data, error } = await defaultDbClient
      .from('email_connections')
      .upsert(
        {
          client_id: clientId,
          member_id: memberId,
          oauth_connection_id: oauthConnectionId,
          provider,
          mailbox_address: mailboxAddress,
          display_name: displayName,
          managed_label_id: managedLabelId || null,
        },
        { onConflict: 'oauth_connection_id' }
      )
      .select('*')
      .maybeSingle();

    if (error) throw new Error(`upsertConnection failed: ${error.message}`);
    return data;
  },

  // EM5 (§10) — lazy backfill path: if label creation at connect time
  // (handleCallback) failed, emailPreviewService.js retries via
  // ensureManagedLabel below rather than leaving the connection permanently
  // labelless.
  async updateManagedLabelId(oauthConnectionId, managedLabelId) {
    const { data, error } = await defaultDbClient
      .from('email_connections')
      .update({ managed_label_id: managedLabelId, updated_at: new Date().toISOString() })
      .eq('oauth_connection_id', oauthConnectionId)
      .select('*')
      .maybeSingle();

    if (error) throw new Error(`updateManagedLabelId failed: ${error.message}`);
    return data || null;
  },

  async getByOauthConnectionId(oauthConnectionId) {
    const { data, error } = await defaultDbClient
      .from('email_connections')
      .select('*')
      .eq('oauth_connection_id', oauthConnectionId)
      .maybeSingle();

    if (error) throw new Error(`getByOauthConnectionId failed: ${error.message}`);
    return data || null;
  },

  // EL6 (LIVE_EMAIL_LOOKUP.md §2.3) — the per-mailbox half of the consent
  // toggle; setLiveLookupEnabledForOwnConnection below is what actually
  // keeps this in sync with client_members.live_lookup_consented_at.
  async updateLiveLookupEnabled(oauthConnectionId, enabled) {
    const { data, error } = await defaultDbClient
      .from('email_connections')
      .update({ live_lookup_enabled: enabled, updated_at: new Date().toISOString() })
      .eq('oauth_connection_id', oauthConnectionId)
      .select('*')
      .maybeSingle();

    if (error) throw new Error(`updateLiveLookupEnabled failed: ${error.message}`);
    return data || null;
  },

};

/**
 * EM2 disconnect authorization — self-service only. A member may disconnect
 * only a connection they themselves own; there is no owner/admin override
 * in this milestone (see the file header comment). Pure and directly
 * testable, exactly like mapGmailConnectionResponse/mapSlackStatusResponse,
 * so this specific security boundary can be asserted without needing a real
 * authenticated HTTP session.
 */
function canDisconnectConnection({ connection, actingMemberId }) {
  return !!connection && !!actingMemberId && connection.connected_by_member_id === actingMemberId;
}

/**
 * Pure mapping from an oauth_connections row + its matching email_connections
 * row (may be null if the satellite row is somehow missing) to the API
 * response shape — allowlists fields explicitly, same discipline as
 * mapSlackStatusResponse.
 */
function mapGmailConnectionResponse(connectionRow, emailConnectionRow) {
  return {
    connectionId: connectionRow.id,
    memberId: connectionRow.connected_by_member_id,
    provider: PROVIDER,
    mailboxAddress: emailConnectionRow ? emailConnectionRow.mailbox_address : connectionRow.external_account_name,
    displayName: emailConnectionRow ? emailConnectionRow.display_name : null,
    syncMode: emailConnectionRow ? emailConnectionRow.sync_mode : null,
    syncEnabled: emailConnectionRow ? emailConnectionRow.sync_enabled : null,
    historicalImportStatus: emailConnectionRow ? emailConnectionRow.historical_import_status : null,
    status: connectionRow.status,
    connectedAt: connectionRow.connected_at,
  };
}

/**
 * EM9 (§24.1, §24.5) — disconnect-with-cleanup: enumerate every AIKB
 * document this member contributed (contributingMemberId-filtered, §13.2 —
 * the AIKB documents listing now supports this filter) and tombstone each
 * via the existing per-document delete path. A loop over individual
 * deletes, not a dedicated bulk-delete endpoint — the exact MVP tradeoff
 * §24.1 accepts. Best-effort per document: one failure doesn't block the
 * rest, mirroring emailSyncService.js's tombstoneMessages discipline.
 */
async function cleanupMemberContent({ aikbService, clientId, memberId }) {
  const result = await aikbService.listDocuments(clientId, { contributingMemberId: memberId });
  const docs = result.documents || (Array.isArray(result) ? result : []);

  let deleted = 0;
  let failed = 0;
  // EM10.5 Bug 13 — collected so disconnect() can also strip the managed
  // Gmail label from these messages (below, requires the still-valid access
  // token this function itself doesn't have); without that, an AIKB-only
  // delete doesn't survive a later reconnect's ordinary label-driven sync.
  const gmailMessageIds = [];
  for (const doc of docs) {
    const documentId = doc.id || doc.documentId || doc.document_id;
    if (!documentId) continue;
    try {
      await aikbService.deleteDocumentById(clientId, documentId);
      deleted++;
      const sourceProvider = doc.sourceProvider || doc.source_provider;
      const sourceFileId = doc.sourceFileId || doc.source_file_id;
      if (sourceProvider === PROVIDER && sourceFileId) gmailMessageIds.push(sourceFileId);
    } catch (err) {
      failed++;
      console.error('[gmail oauth] disconnect-cleanup delete failed:', documentId, err.message);
    }
  }
  return { requested: docs.length, deleted, failed, gmailMessageIds };
}

/**
 * @param {object} [deps] — injected for testing; each defaults to the real singleton service.
 */
function createEmailConnectionService({
  oauthStateService = defaultOauthStateService,
  gmailService = defaultGmailService,
  oauthConnectionsService = defaultOauthConnectionsService,
  supabaseService = defaultSupabaseService,
  emailConnectionsRepo = defaultEmailConnectionsRepo,
  aikbService = defaultAikbService,
} = {}) {
  /**
   * GET /:provider/start — self-service: any active member whose role isn't
   * `viewer` may connect their own mailbox (enforced by the route's
   * middleware); not owner/admin-gated like Slack's /start.
   */
  async function startConnection({ clientId, memberId, provider }) {
    if (!clientId) throw new Error('startConnection requires clientId');
    if (!memberId) throw new Error('startConnection requires memberId');
    if (provider !== PROVIDER) throw new Error(`startConnection: unsupported provider "${provider}"`);
    if (!gmailService.isGmailConfigured()) {
      const err = new Error('Gmail OAuth is not configured');
      err.code = 'GMAIL_NOT_CONFIGURED';
      throw err;
    }

    const { rawState } = await oauthStateService.generateAndStoreState({ clientId, memberId, provider: PROVIDER });
    const url = gmailService.buildAuthorizationUrl({ state: rawState });
    return { url };
  }

  /**
   * GET /:provider/callback. Never throws — every rejection path (denial,
   * missing fields, invalid/expired/reused state, deactivated member, a
   * member demoted to `viewer` mid-round-trip, Gmail exchange failure,
   * persist failure) resolves to a safe redirect path instead. Never logs
   * the raw code, state, access/refresh token, or a full Gmail response.
   */
  async function handleCallback({ code, state, error }) {
    if (error) return { redirectPath: REDIRECT.DENIED };
    if (!code || !state) return { redirectPath: REDIRECT.INVALID_STATE };

    let consumed;
    try {
      consumed = await oauthStateService.consumeState({ rawState: state, provider: PROVIDER });
    } catch (err) {
      console.error('[gmail oauth] state consume error:', err.message);
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    if (consumed.status === 'expired') return { redirectPath: REDIRECT.EXPIRED_STATE };
    if (consumed.status !== 'consumed') return { redirectPath: REDIRECT.INVALID_STATE }; // not_found | reused | provider_mismatch

    const { clientId, memberId } = consumed;

    let clientRow, member;
    try {
      [clientRow, member] = await Promise.all([
        supabaseService.getClientById(clientId),
        supabaseService.getClientMemberById(memberId, clientId),
      ]);
    } catch (err) {
      console.error('[gmail oauth] org/member lookup error:', err.message);
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    if (!clientRow || !clientRow.is_active) return { redirectPath: REDIRECT.CONNECTION_FAILED };
    // Self-service: any active member except `viewer` — re-verified here in
    // case the member's role or status changed during the OAuth round trip.
    if (!member || member.status !== 'active' || member.role === 'viewer') {
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    let tokenData;
    try {
      tokenData = await gmailService.exchangeCodeForToken(code);
    } catch (err) {
      console.error('[gmail oauth] token exchange error:', err.code || 'unknown');
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    // EM5 (§10) — create-or-reuse the managed "Relativity/Knowledge" label
    // using the fresh access token this exchange just returned. Best-effort:
    // a Gmail hiccup here must not fail the whole connection (the mailbox is
    // still validly connected either way) — emailPreviewService.js's
    // ensureManagedLabel lazily retries this on the next preview call if
    // managed_label_id is still null.
    let managedLabelId = null;
    try {
      const label = await gmailService.getOrCreateManagedLabel(tokenData.accessToken);
      managedLabelId = label.labelId;
    } catch (err) {
      console.error('[gmail oauth] managed label create-or-reuse error (non-fatal, retried lazily):', err.message);
    }

    let connection;
    try {
      await oauthConnectionsService.createOrReplaceConnection({
        clientId,
        provider: PROVIDER,
        externalAccountId: tokenData.externalAccountId,
        externalAccountName: tokenData.mailboxAddress,
        scopesGranted: tokenData.scopes,
        providerMetadata: {
          mailbox_address: tokenData.mailboxAddress,
          display_name: tokenData.displayName,
        },
        connectedByMemberId: memberId,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        expiresAt: tokenData.expiresAt,
      });
      // createOrReplaceConnection's return value is the safe, allowlisted
      // status shape (no id, by design — see toSafeConnectionStatus) — a
      // second, member-scoped read gets us the connection's real id to link
      // the email_connections row, without loosening that safe-shape contract.
      connection = await oauthConnectionsService.getActiveConnectionForClientAndMember(clientId, PROVIDER, memberId);
    } catch (err) {
      console.error('[gmail oauth] connection persist error:', err.message);
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    if (!connection) {
      // Defensive — should be unreachable if createOrReplaceConnection just
      // succeeded, but never assume a satellite read agrees with a write.
      console.error('[gmail oauth] connection persist error: connection not found immediately after create');
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    try {
      await emailConnectionsRepo.upsertConnection({
        clientId,
        memberId,
        oauthConnectionId: connection.id,
        provider: PROVIDER,
        mailboxAddress: tokenData.mailboxAddress,
        displayName: tokenData.displayName,
        managedLabelId,
      });
    } catch (err) {
      console.error('[gmail oauth] email_connections persist error:', err.message);
      return { redirectPath: REDIRECT.CONNECTION_FAILED };
    }

    return { redirectPath: REDIRECT.SUCCESS };
  }

  /**
   * GET /connections — any active member sees their own connection by
   * default; `all=true` only takes effect when the caller is owner/admin
   * (a non-admin passing it is silently ignored, fail-safe). Always returns
   * `{ connections: [...] }`, 0 or 1 items in the own-connection case, so
   * the response shape never differs by caller role.
   */
  async function getConnections({ clientId, memberId, isOwnerAdmin, all }) {
    if (!clientId) throw new Error('getConnections requires clientId');
    if (!memberId) throw new Error('getConnections requires memberId');

    if (all && isOwnerAdmin) {
      const rows = await oauthConnectionsService.listActiveConnectionsForClient(clientId, PROVIDER);
      const connections = await Promise.all(
        rows.map(async (row) => {
          const emailConnectionRow = await emailConnectionsRepo.getByOauthConnectionId(row.id);
          return mapGmailConnectionResponse(row, emailConnectionRow);
        })
      );
      return { connections };
    }

    const row = await oauthConnectionsService.getActiveConnectionForClientAndMember(clientId, PROVIDER, memberId);
    if (!row) return { connections: [] };
    const emailConnectionRow = await emailConnectionsRepo.getByOauthConnectionId(row.id);
    return { connections: [mapGmailConnectionResponse(row, emailConnectionRow)] };
  }

  /**
   * POST /connections/:id/disconnect — the route loads the connection first
   * and enforces authorization (self-service, OR — as of EM9 — owner/admin,
   * per §14.1's route table) before ever calling this; this function
   * re-fetches by id itself rather than trusting a caller-supplied row, and
   * only ever revokes the specific member's connection it was given — never
   * every gmail connection for the client. Idempotent, mirrors
   * slackIntegrationService.js's disconnect.
   *
   * `cleanupIngestedContent` (EM9 — §24, §14.1) is the other half of §14.1's
   * route-table note that both the owner/admin override AND this body param
   * belong to EM9, not EM2: when true, every AIKB document this connection's
   * member contributed is enumerated and deleted (cleanupMemberContent
   * above) as part of the same call — best-effort, never fails the
   * disconnect itself if cleanup partially fails (matches §24.1's own
   * "disconnect always succeeds locally" framing; a cleanup failure is
   * reported back in the response, not thrown).
   *
   * EM10.5 Bug 13 fix: cleanup (and the managed-label strip it now also
   * does — see below) runs BEFORE token revocation, not after. The label
   * strip needs a still-valid Gmail access token; revoking first would make
   * every batchModify call in this path fail.
   */
  async function disconnect({ clientId, connectionId, cleanupIngestedContent = false }) {
    if (!clientId) throw new Error('disconnect requires clientId');
    if (!connectionId) throw new Error('disconnect requires connectionId');

    const connection = await oauthConnectionsService.getConnectionById(connectionId);
    if (!connection || connection.client_id !== clientId || connection.provider !== PROVIDER || connection.status !== 'active') {
      return { disconnected: true }; // already disconnected / not found / wrong client — safe no-op
    }

    let accessToken = null;
    try {
      const credential = await oauthConnectionsService.getDecryptedCredentialForConnection(connection.id);
      accessToken = credential ? credential.accessToken : null;
    } catch (err) {
      // Decryption failure must not block local revocation — the connection
      // still gets marked revoked below so it can never be used again.
      console.error('[gmail oauth] credential decrypt error during disconnect:', err.message);
    }

    let cleanup;
    if (cleanupIngestedContent) {
      let cleanupResult;
      try {
        cleanupResult = await cleanupMemberContent({ aikbService, clientId, memberId: connection.connected_by_member_id });
      } catch (err) {
        // The connection is still revoked below regardless — a cleanup
        // failure must never be reported as a failed disconnect, only as a
        // failed cleanup.
        console.error('[gmail oauth] disconnect-cleanup error (non-fatal to disconnect itself):', err.message);
        cleanupResult = { requested: 0, deleted: 0, failed: 0, gmailMessageIds: [], error: err.message };
      }

      let labelStripped = false;
      if (accessToken && cleanupResult.gmailMessageIds && cleanupResult.gmailMessageIds.length > 0) {
        try {
          const emailConnectionRow = await emailConnectionsRepo.getByOauthConnectionId(connection.id);
          const labelId = emailConnectionRow && emailConnectionRow.managed_label_id;
          if (labelId) {
            await gmailService.removeLabelFromMessages({ accessToken, labelId, messageIds: cleanupResult.gmailMessageIds });
            labelStripped = true;
          }
        } catch (err) {
          // Best-effort, same discipline as the AIKB deletes above — a
          // label-strip failure must never fail or block the disconnect.
          console.error('[gmail oauth] disconnect-cleanup label-strip error (non-fatal):', err.message);
        }
      }

      // gmailMessageIds is an internal detail (used above to call Gmail) —
      // deliberately not included in the response the route echoes back to
      // the client (routes/integrations/email.js res.json(result)).
      cleanup = {
        requested: cleanupResult.requested,
        deleted: cleanupResult.deleted,
        failed: cleanupResult.failed,
        labelStripped,
        ...(cleanupResult.error ? { error: cleanupResult.error } : {}),
      };
    }

    if (accessToken) {
      // Best-effort — revokeToken never throws, and its outcome never
      // changes whether the local connection is marked revoked. Runs after
      // cleanup above so the label strip (if any) still had a valid token.
      await gmailService.revokeToken(accessToken);
    }

    await oauthConnectionsService.markConnectionRevokedForMember(clientId, PROVIDER, connection.connected_by_member_id);

    if (!cleanupIngestedContent) {
      return { disconnected: true };
    }
    return { disconnected: true, cleanup };
  }

  // EM10.6 removed updateSyncMode (POST /connections/:id/sync-mode) along
  // with Automatic Email Ingestion itself, and EM10.7 removed pause/resume
  // (EM8) — a connection's sync_mode is now fixed at 'manual_selected' for
  // its entire life; nothing ever changes it after connect. See
  // EMAIL_INGESTION.md's EM10.6 and EM10.7 records.

  /**
   * EM5 — returns a Gmail access token guaranteed valid for at least
   * TOKEN_REFRESH_MARGIN_MS, refreshing it via the stored refresh token
   * first if the current one is missing/expiring/expired. Persists a
   * successful refresh in-place (never churns the connection's identity —
   * ADR-006's updateCredentialForConnection, §12 item 3), preserving the
   * existing refresh token when Google's refresh response omits a new one
   * (gmailService.refreshAccessToken already returns null in that case;
   * this function is what actually keeps the old one rather than nulling
   * it out — the same bug class already solved once for Google Drive).
   * Throws AUTHORIZATION_EXPIRED if there is no credential row or no
   * refresh token to fall back on, or if the refresh attempt itself fails
   * (revoked/expired refresh token, §12 item 4) — callers surface this as
   * the visible "reconnect your mailbox" portal state, never a silent retry.
   */
  async function getValidGmailAccessToken(connectionId) {
    if (!connectionId) throw new Error('getValidGmailAccessToken requires connectionId');

    const credential = await oauthConnectionsService.getDecryptedCredentialForConnection(connectionId);
    if (!credential || !credential.accessToken) {
      const err = new Error('No Gmail credential found for this connection.');
      err.code = 'AUTHORIZATION_EXPIRED';
      throw err;
    }

    const expiresAtMs = credential.expiresAt ? new Date(credential.expiresAt).getTime() : 0;
    const isFreshEnough = expiresAtMs && expiresAtMs - Date.now() > TOKEN_REFRESH_MARGIN_MS;
    if (isFreshEnough) return credential.accessToken;

    if (!credential.refreshToken) {
      const err = new Error('Gmail authorization has expired and cannot be silently refreshed.');
      err.code = 'AUTHORIZATION_EXPIRED';
      throw err;
    }

    let refreshed;
    try {
      refreshed = await gmailService.refreshAccessToken(credential.refreshToken);
    } catch (err) {
      console.error('[gmail] access token refresh failed:', err.code || 'unknown');
      const authErr = new Error('Gmail authorization has expired and could not be refreshed.');
      authErr.code = 'AUTHORIZATION_EXPIRED';
      throw authErr;
    }

    await oauthConnectionsService.updateCredentialForConnection(connectionId, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || credential.refreshToken,
      expiresAt: refreshed.expiresAt,
    });

    return refreshed.accessToken;
  }

  /**
   * EM5 — exposes the email_connections row (sync_mode, managed_label_id)
   * for a given oauth_connections id, so emailPreviewService.js doesn't need
   * its own, second copy of emailConnectionsRepo just to read one row.
   */
  async function getEmailConnectionRecord(oauthConnectionId) {
    if (!oauthConnectionId) throw new Error('getEmailConnectionRecord requires oauthConnectionId');
    return emailConnectionsRepo.getByOauthConnectionId(oauthConnectionId);
  }

  /**
   * EM5 (§10) — lazy backfill for a connection whose managed-label creation
   * at connect time (handleCallback) failed. Idempotent like
   * gmailService.getOrCreateManagedLabel itself; a no-op (one extra read,
   * no write) when the label already exists.
   */
  async function ensureManagedLabel({ oauthConnectionId, emailConnectionRow, accessToken }) {
    if (emailConnectionRow && emailConnectionRow.managed_label_id) {
      return emailConnectionRow.managed_label_id;
    }
    const { labelId } = await gmailService.getOrCreateManagedLabel(accessToken);
    await emailConnectionsRepo.updateManagedLabelId(oauthConnectionId, labelId);
    return labelId;
  }

  /**
   * EL6 (LIVE_EMAIL_LOOKUP.md §2.3) — the per-mailbox half of the consent
   * toggle: PUT /live-lookup-settings sets this in the SAME request as
   * client_members.live_lookup_consented_at, so "consented" and "this
   * mailbox is live-lookup-active" never drift apart for the common case of
   * a member with exactly one Gmail connection. A no-op, not an error, when
   * the member has no active connection yet — the consent record itself
   * (client_members.live_lookup_consented_at) is what's authoritative when
   * a mailbox connects later; emailLiveLookupService's own gate chain
   * re-checks the connection's flag independently regardless.
   */
  async function setLiveLookupEnabledForOwnConnection({ clientId, memberId, enabled }) {
    if (!clientId) throw new Error('setLiveLookupEnabledForOwnConnection requires clientId');
    if (!memberId) throw new Error('setLiveLookupEnabledForOwnConnection requires memberId');

    const connection = await oauthConnectionsService.getActiveConnectionForClientAndMember(clientId, PROVIDER, memberId);
    if (!connection) return { updated: false };

    await emailConnectionsRepo.updateLiveLookupEnabled(connection.id, enabled);
    return { updated: true };
  }

  return {
    startConnection,
    handleCallback,
    getConnections,
    disconnect,
    getValidGmailAccessToken,
    getEmailConnectionRecord,
    ensureManagedLabel,
    setLiveLookupEnabledForOwnConnection,
  };
}

const defaultService = createEmailConnectionService();

module.exports = {
  ...defaultService,
  createEmailConnectionService,
  mapGmailConnectionResponse,
  canDisconnectConnection,
  REDIRECT,
  PROVIDER,
};
