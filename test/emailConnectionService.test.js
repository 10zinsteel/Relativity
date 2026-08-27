const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmailConnectionService, mapGmailConnectionResponse, canDisconnectConnection, REDIRECT, PROVIDER } = require('../services/emailConnectionService');

const ACTIVE_CLIENT = { id: 'client-a', is_active: true };
const ACTIVE_MEMBER_A = { id: 'member-a', client_id: 'client-a', role: 'member', status: 'active' };
const ACTIVE_MEMBER_B = { id: 'member-b', client_id: 'client-a', role: 'member', status: 'active' };

const MEMBERS_BY_ID = { 'member-a': ACTIVE_MEMBER_A, 'member-b': ACTIVE_MEMBER_B };

function makeFakes(overrides = {}) {
  const calls = {
    generateAndStoreState: [],
    consumeState: [],
    exchangeCodeForToken: [],
    createOrReplaceConnection: [],
    getActiveConnectionForClientAndMember: [],
    revokeToken: [],
    markConnectionRevokedForMember: [],
    upsertConnection: [],
    getByOauthConnectionId: [],
    getConnectionById: [],
    pauseConnection: [],
    resumeConnection: [],
    getOrCreateManagedLabel: [],
    updateManagedLabelId: [],
    refreshAccessToken: [],
    getDecryptedCredentialForConnection: [],
    updateCredentialForConnection: [],
    listDocuments: [],
    deleteDocumentById: [],
    updateLiveLookupEnabled: [],
  };

  // In-memory model of oauth_connections rows, keyed by connectionId, so
  // createOrReplaceConnection's effect is visible to the immediately
  // following getActiveConnectionForClientAndMember call within the same
  // test — mirrors the real two-step read-after-write handleCallback does.
  const connectionsStore = new Map();
  let nextConnectionId = 1;

  const oauthStateService = {
    generateAndStoreState: async (args) => {
      calls.generateAndStoreState.push(args);
      return overrides.generateAndStoreState
        ? overrides.generateAndStoreState(args)
        : { rawState: 'raw-state-value', expiresAt: new Date(Date.now() + 600000).toISOString() };
    },
    consumeState: async (args) => {
      calls.consumeState.push(args);
      if (overrides.consumeState) return overrides.consumeState(args);
      return { status: 'consumed', clientId: 'client-a', memberId: 'member-a', redirectAfter: null };
    },
  };

  const gmailService = {
    isGmailConfigured: overrides.isGmailConfigured || (() => true),
    buildAuthorizationUrl: overrides.buildAuthorizationUrl || (({ state }) => `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`),
    exchangeCodeForToken: async (code) => {
      calls.exchangeCodeForToken.push(code);
      if (overrides.exchangeCodeForToken) return overrides.exchangeCodeForToken(code);
      return {
        accessToken: 'ya29.real-access-token',
        refreshToken: '1//real-refresh-token',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'openid', 'email', 'profile'],
        externalAccountId: '109876543210',
        mailboxAddress: 'alex@example.com',
        displayName: 'Alex Doe',
      };
    },
    revokeToken: async (token) => {
      calls.revokeToken.push(token);
      return overrides.revokeToken ? overrides.revokeToken(token) : true;
    },
    getOrCreateManagedLabel: async (accessToken) => {
      calls.getOrCreateManagedLabel.push(accessToken);
      if (overrides.getOrCreateManagedLabel) return overrides.getOrCreateManagedLabel(accessToken);
      return { labelId: 'Label_managed_1', created: true };
    },
    refreshAccessToken: async (refreshToken) => {
      calls.refreshAccessToken.push(refreshToken);
      if (overrides.refreshAccessToken) return overrides.refreshAccessToken(refreshToken);
      return { accessToken: 'ya29.refreshed-token', refreshToken: null, expiresAt: new Date(Date.now() + 3600000).toISOString() };
    },
  };

  const oauthConnectionsService = {
    createOrReplaceConnection: async (args) => {
      calls.createOrReplaceConnection.push(args);
      if (overrides.createOrReplaceConnection) return overrides.createOrReplaceConnection(args);
      // Mirrors replace_active_oauth_connection's real, EM1-migrated behavior
      // for gmail/microsoft: revoke this SAME member's prior active row
      // before inserting the new one — scoped by (clientId, provider,
      // connectedByMemberId), never touching a different member's row.
      for (const row of connectionsStore.values()) {
        if (row.client_id === args.clientId && row.provider === args.provider && row.connected_by_member_id === args.connectedByMemberId && row.status === 'active') {
          row.status = 'revoked';
        }
      }
      const id = `conn-${nextConnectionId++}`;
      const row = {
        id,
        client_id: args.clientId,
        provider: args.provider,
        connected_by_member_id: args.connectedByMemberId,
        status: 'active',
        connected_at: new Date().toISOString(),
      };
      connectionsStore.set(id, row);
      return { connected: true, provider: args.provider }; // safe shape — deliberately no id, see emailConnectionService.js
    },
    getActiveConnectionForClientAndMember: async (clientId, provider, memberId) => {
      calls.getActiveConnectionForClientAndMember.push({ clientId, provider, memberId });
      if (overrides.getActiveConnectionForClientAndMember) return overrides.getActiveConnectionForClientAndMember(clientId, provider, memberId);
      for (const row of connectionsStore.values()) {
        if (row.client_id === clientId && row.provider === provider && row.connected_by_member_id === memberId && row.status === 'active') {
          return row;
        }
      }
      return null;
    },
    listActiveConnectionsForClient: async (clientId, provider) => {
      if (overrides.listActiveConnectionsForClient) return overrides.listActiveConnectionsForClient(clientId, provider);
      return [...connectionsStore.values()].filter((r) => r.client_id === clientId && r.provider === provider && r.status === 'active');
    },
    getConnectionById: async (connectionId) => {
      calls.getConnectionById.push(connectionId);
      if (overrides.getConnectionById) return overrides.getConnectionById(connectionId);
      return connectionsStore.get(connectionId) || null;
    },
    getDecryptedCredentialForConnection: async (connectionId) => {
      calls.getDecryptedCredentialForConnection.push(connectionId);
      if (overrides.getDecryptedCredentialForConnection) return overrides.getDecryptedCredentialForConnection(connectionId);
      // Fresh by default (~1hr out) so getValidGmailAccessToken's tests opt
      // into an expiring/expired credential explicitly via override instead
      // of every disconnect-focused test accidentally triggering a refresh.
      return { accessToken: 'ya29.decrypted-token', refreshToken: '1//decrypted-refresh-token', expiresAt: new Date(Date.now() + 3600000).toISOString() };
    },
    updateCredentialForConnection: async (connectionId, args) => {
      calls.updateCredentialForConnection.push({ connectionId, ...args });
      if (overrides.updateCredentialForConnection) return overrides.updateCredentialForConnection(connectionId, args);
      return undefined;
    },
    markConnectionRevokedForMember: async (clientId, provider, memberId) => {
      calls.markConnectionRevokedForMember.push({ clientId, provider, memberId });
      for (const row of connectionsStore.values()) {
        if (row.client_id === clientId && row.provider === provider && row.connected_by_member_id === memberId) {
          row.status = 'revoked';
        }
      }
      return { revoked: true };
    },
  };

  const supabaseService = {
    getClientById: async (clientId) => {
      if (overrides.getClientById) return overrides.getClientById(clientId);
      return clientId === 'client-a' ? ACTIVE_CLIENT : null;
    },
    getClientMemberById: async (memberId, clientId) => {
      if (overrides.getClientMemberById) return overrides.getClientMemberById(memberId, clientId);
      return clientId === 'client-a' ? (MEMBERS_BY_ID[memberId] || null) : null;
    },
  };

  const emailConnectionsRepo = {
    upsertConnection: async (args) => {
      calls.upsertConnection.push(args);
      if (overrides.upsertConnection) return overrides.upsertConnection(args);
      return {
        client_id: args.clientId,
        member_id: args.memberId,
        oauth_connection_id: args.oauthConnectionId,
        provider: args.provider,
        mailbox_address: args.mailboxAddress,
        display_name: args.displayName,
        sync_mode: 'manual_selected',
        sync_enabled: true,
        historical_import_status: 'not_started',
      };
    },
    getByOauthConnectionId: async (oauthConnectionId) => {
      calls.getByOauthConnectionId.push(oauthConnectionId);
      if (overrides.getByOauthConnectionId) return overrides.getByOauthConnectionId(oauthConnectionId);
      return {
        oauth_connection_id: oauthConnectionId,
        mailbox_address: 'alex@example.com',
        display_name: 'Alex Doe',
        sync_mode: 'manual_selected',
        sync_enabled: true,
        historical_import_status: 'not_started',
        pre_pause_sync_mode: null,
      };
    },
    // EM8 — POST /connections/:id/pause.
    pauseConnection: async (oauthConnectionId, priorSyncMode) => {
      calls.pauseConnection.push({ oauthConnectionId, priorSyncMode });
      if (overrides.pauseConnection) return overrides.pauseConnection(oauthConnectionId, priorSyncMode);
      return { oauth_connection_id: oauthConnectionId, sync_mode: 'paused', pre_pause_sync_mode: priorSyncMode };
    },
    // EM8 — POST /connections/:id/resume.
    resumeConnection: async (oauthConnectionId, restoredSyncMode) => {
      calls.resumeConnection.push({ oauthConnectionId, restoredSyncMode });
      if (overrides.resumeConnection) return overrides.resumeConnection(oauthConnectionId, restoredSyncMode);
      return { oauth_connection_id: oauthConnectionId, sync_mode: restoredSyncMode, pre_pause_sync_mode: null };
    },
    // EM5 — ensureManagedLabel's lazy-backfill write path.
    updateManagedLabelId: async (oauthConnectionId, managedLabelId) => {
      calls.updateManagedLabelId.push({ oauthConnectionId, managedLabelId });
      if (overrides.updateManagedLabelId) return overrides.updateManagedLabelId(oauthConnectionId, managedLabelId);
      return { oauth_connection_id: oauthConnectionId, managed_label_id: managedLabelId };
    },
    // EL6 — PUT /live-lookup-settings' per-mailbox half.
    updateLiveLookupEnabled: async (oauthConnectionId, enabled) => {
      calls.updateLiveLookupEnabled.push({ oauthConnectionId, enabled });
      if (overrides.updateLiveLookupEnabled) return overrides.updateLiveLookupEnabled(oauthConnectionId, enabled);
      return { oauth_connection_id: oauthConnectionId, live_lookup_enabled: enabled };
    },
  };

  // EM9 — disconnect-with-cleanup's only real dependency: listDocuments
  // (contributingMemberId-filtered) + deleteDocumentById, mirroring
  // emailSyncService.test.js's fixtureAikbService shape.
  const aikbService = {
    listDocuments: async (clientId, filters) => {
      calls.listDocuments.push({ clientId, filters });
      if (overrides.listDocuments) return overrides.listDocuments(clientId, filters);
      return { documents: [] };
    },
    deleteDocumentById: async (clientId, documentId) => {
      calls.deleteDocumentById.push({ clientId, documentId });
      if (overrides.deleteDocumentById) return overrides.deleteDocumentById(clientId, documentId);
      return undefined;
    },
  };

  const service = createEmailConnectionService({
    oauthStateService, gmailService, oauthConnectionsService, supabaseService, emailConnectionsRepo, aikbService,
  });
  return { service, calls, connectionsStore };
}

// ─────────────────────────────────────────────
// startConnection
// ─────────────────────────────────────────────

test('startConnection generates state bound to the caller and builds the authorization URL from it', async () => {
  const { service, calls } = makeFakes();
  const { url } = await service.startConnection({ clientId: 'client-a', memberId: 'member-a', provider: 'gmail' });

  assert.equal(calls.generateAndStoreState.length, 1);
  assert.equal(calls.generateAndStoreState[0].clientId, 'client-a');
  assert.equal(calls.generateAndStoreState[0].memberId, 'member-a');
  assert.equal(calls.generateAndStoreState[0].provider, 'gmail');
  assert.ok(url.includes('raw-state-value'));
});

test('startConnection throws GMAIL_NOT_CONFIGURED when Gmail env is missing, before generating any state', async () => {
  const { service, calls } = makeFakes({ isGmailConfigured: () => false });
  await assert.rejects(
    () => service.startConnection({ clientId: 'client-a', memberId: 'member-a', provider: 'gmail' }),
    (err) => err.code === 'GMAIL_NOT_CONFIGURED'
  );
  assert.equal(calls.generateAndStoreState.length, 0);
});

test('startConnection rejects an unsupported provider', async () => {
  const { service } = makeFakes();
  await assert.rejects(
    () => service.startConnection({ clientId: 'client-a', memberId: 'member-a', provider: 'microsoft' }),
    /unsupported provider/
  );
});

// ─────────────────────────────────────────────
// handleCallback — rejection paths
// ─────────────────────────────────────────────

test('Gmail denial (error param present) redirects to the safe access_denied path without touching state', async () => {
  const { service, calls } = makeFakes();
  const result = await service.handleCallback({ code: null, state: null, error: 'access_denied' });
  assert.equal(result.redirectPath, REDIRECT.DENIED);
  assert.equal(calls.consumeState.length, 0);
});

test('missing code is rejected as invalid_state', async () => {
  const { service } = makeFakes();
  const result = await service.handleCallback({ code: null, state: 'some-state', error: null });
  assert.equal(result.redirectPath, REDIRECT.INVALID_STATE);
});

test('missing state is rejected as invalid_state', async () => {
  const { service } = makeFakes();
  const result = await service.handleCallback({ code: 'some-code', state: null, error: null });
  assert.equal(result.redirectPath, REDIRECT.INVALID_STATE);
});

test('unknown/reused/provider-mismatched state redirects to invalid_state', async () => {
  for (const status of ['not_found', 'reused', 'provider_mismatch']) {
    const { service } = makeFakes({ consumeState: async () => ({ status }) });
    const result = await service.handleCallback({ code: 'c', state: 's', error: null });
    assert.equal(result.redirectPath, REDIRECT.INVALID_STATE, `status ${status} should map to INVALID_STATE`);
  }
});

test('expired state redirects to expired_state (distinct from invalid_state)', async () => {
  const { service } = makeFakes({ consumeState: async () => ({ status: 'expired' }) });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.EXPIRED_STATE);
});

test('a deactivated (non-active status) member is rejected as connection_failed and never reaches Gmail token exchange', async () => {
  const { service, calls } = makeFakes({
    getClientMemberById: async () => ({ id: 'member-a', client_id: 'client-a', role: 'member', status: 'disabled' }),
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
  assert.equal(calls.exchangeCodeForToken.length, 0);
});

test('a member demoted to viewer mid-round-trip is rejected as connection_failed (self-service excludes viewers)', async () => {
  const { service, calls } = makeFakes({
    getClientMemberById: async () => ({ id: 'member-a', client_id: 'client-a', role: 'viewer', status: 'active' }),
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
  assert.equal(calls.exchangeCodeForToken.length, 0);
});

test('a member with an ordinary (non-viewer) role IS allowed through — self-service is not owner/admin-gated', async () => {
  const { service } = makeFakes({
    getClientMemberById: async () => ({ id: 'member-a', client_id: 'client-a', role: 'member', status: 'active' }),
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.SUCCESS);
});

test('an inactive organization is rejected as connection_failed', async () => {
  const { service } = makeFakes({ getClientById: async () => ({ id: 'client-a', is_active: false }) });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
});

test('a Gmail token-exchange failure redirects to connection_failed', async () => {
  const { service } = makeFakes({
    exchangeCodeForToken: async () => { const e = new Error('oauth failed'); e.code = 'GMAIL_OAUTH_FAILED'; throw e; },
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
});

test('a connection-persist (oauth_connections) failure redirects to connection_failed', async () => {
  const { service } = makeFakes({
    createOrReplaceConnection: async () => { throw new Error('createOrReplaceConnection failed: simulated'); },
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
});

test('an email_connections upsert failure (after oauth_connections already succeeded) still redirects to connection_failed', async () => {
  const { service, calls } = makeFakes({
    upsertConnection: async () => { throw new Error('upsertConnection failed: simulated'); },
  });
  const result = await service.handleCallback({ code: 'c', state: 's', error: null });
  assert.equal(result.redirectPath, REDIRECT.CONNECTION_FAILED);
  assert.equal(calls.createOrReplaceConnection.length, 1); // the oauth_connections write did happen
});

// ─────────────────────────────────────────────
// handleCallback — success path
// ─────────────────────────────────────────────

test('a fully valid callback persists the connection with the expected metadata shape and redirects to success', async () => {
  const { service, calls } = makeFakes();
  const result = await service.handleCallback({ code: 'the-code', state: 'the-state', error: null });

  assert.equal(result.redirectPath, REDIRECT.SUCCESS);
  assert.equal(calls.createOrReplaceConnection.length, 1);

  const args = calls.createOrReplaceConnection[0];
  assert.equal(args.clientId, 'client-a');
  assert.equal(args.provider, 'gmail');
  assert.equal(args.externalAccountId, '109876543210');
  assert.equal(args.externalAccountName, 'alex@example.com');
  assert.equal(args.connectedByMemberId, 'member-a');
  assert.equal(args.accessToken, 'ya29.real-access-token');
  assert.equal(args.refreshToken, '1//real-refresh-token');

  assert.equal(calls.upsertConnection.length, 1);
  const upsertArgs = calls.upsertConnection[0];
  assert.equal(upsertArgs.clientId, 'client-a');
  assert.equal(upsertArgs.memberId, 'member-a');
  assert.equal(upsertArgs.provider, 'gmail');
  assert.equal(upsertArgs.mailboxAddress, 'alex@example.com');
  assert.equal(upsertArgs.displayName, 'Alex Doe');
  assert.ok(upsertArgs.oauthConnectionId);
});

// ─────────────────────────────────────────────
// handleCallback — managed-label create-or-reuse (EM5 — §10)
// ─────────────────────────────────────────────

test('a successful callback creates/reuses the managed label using the fresh access token and persists its id onto email_connections', async () => {
  const { service, calls } = makeFakes();
  const result = await service.handleCallback({ code: 'the-code', state: 'the-state', error: null });

  assert.equal(result.redirectPath, REDIRECT.SUCCESS);
  assert.equal(calls.getOrCreateManagedLabel.length, 1);
  assert.equal(calls.getOrCreateManagedLabel[0], 'ya29.real-access-token');
  assert.equal(calls.upsertConnection[0].managedLabelId, 'Label_managed_1');
});

test('a managed-label creation failure does NOT fail the whole connection — it completes with managedLabelId left null (best-effort, lazily retried later)', async () => {
  const { service, calls } = makeFakes({
    getOrCreateManagedLabel: async () => { throw new Error('Gmail labels.create request failed'); },
  });
  const result = await service.handleCallback({ code: 'the-code', state: 'the-state', error: null });

  assert.equal(result.redirectPath, REDIRECT.SUCCESS);
  assert.equal(calls.upsertConnection.length, 1);
  assert.equal(calls.upsertConnection[0].managedLabelId, null);
});

// ─────────────────────────────────────────────
// getValidGmailAccessToken (EM5 — token-refresh orchestration)
// ─────────────────────────────────────────────

test('getValidGmailAccessToken returns the stored access token unchanged when it is not close to expiring', async () => {
  const { service, calls } = makeFakes({
    getDecryptedCredentialForConnection: async () => ({
      accessToken: 'ya29.still-fresh', refreshToken: '1//r', expiresAt: new Date(Date.now() + 3600000).toISOString(),
    }),
  });
  const token = await service.getValidGmailAccessToken('conn-1');
  assert.equal(token, 'ya29.still-fresh');
  assert.equal(calls.refreshAccessToken.length, 0);
});

test('getValidGmailAccessToken refreshes and persists a new token when the stored one is expiring soon', async () => {
  const { service, calls } = makeFakes({
    getDecryptedCredentialForConnection: async () => ({
      accessToken: 'ya29.about-to-expire', refreshToken: '1//old-refresh', expiresAt: new Date(Date.now() + 60000).toISOString(), // 1 min out, inside the 5-min margin
    }),
  });
  const token = await service.getValidGmailAccessToken('conn-1');
  assert.equal(token, 'ya29.refreshed-token');
  assert.equal(calls.refreshAccessToken.length, 1);
  assert.equal(calls.refreshAccessToken[0], '1//old-refresh');
  assert.equal(calls.updateCredentialForConnection.length, 1);
  assert.equal(calls.updateCredentialForConnection[0].accessToken, 'ya29.refreshed-token');
});

test('getValidGmailAccessToken refreshes when expiresAt is missing entirely (treated as already expired, not "never expires")', async () => {
  const { service, calls } = makeFakes({
    getDecryptedCredentialForConnection: async () => ({ accessToken: 'ya29.no-expiry', refreshToken: '1//r', expiresAt: null }),
  });
  await service.getValidGmailAccessToken('conn-1');
  assert.equal(calls.refreshAccessToken.length, 1);
});

test('getValidGmailAccessToken preserves the prior refresh token when Google\'s refresh response omits a new one (does not null it out)', async () => {
  const { service, calls } = makeFakes({
    getDecryptedCredentialForConnection: async () => ({
      accessToken: 'ya29.expiring', refreshToken: '1//keep-me', expiresAt: new Date(Date.now() + 1000).toISOString(),
    }),
    refreshAccessToken: async () => ({ accessToken: 'ya29.new', refreshToken: null, expiresAt: new Date(Date.now() + 3600000).toISOString() }),
  });
  await service.getValidGmailAccessToken('conn-1');
  assert.equal(calls.updateCredentialForConnection[0].refreshToken, '1//keep-me');
});

test('getValidGmailAccessToken uses the rotated refresh token when Google does return a new one', async () => {
  const { service, calls } = makeFakes({
    getDecryptedCredentialForConnection: async () => ({
      accessToken: 'ya29.expiring', refreshToken: '1//old', expiresAt: new Date(Date.now() + 1000).toISOString(),
    }),
    refreshAccessToken: async () => ({ accessToken: 'ya29.new', refreshToken: '1//rotated', expiresAt: new Date(Date.now() + 3600000).toISOString() }),
  });
  await service.getValidGmailAccessToken('conn-1');
  assert.equal(calls.updateCredentialForConnection[0].refreshToken, '1//rotated');
});

test('getValidGmailAccessToken throws AUTHORIZATION_EXPIRED when no credential row exists', async () => {
  const { service } = makeFakes({ getDecryptedCredentialForConnection: async () => null });
  await assert.rejects(() => service.getValidGmailAccessToken('conn-1'), (err) => err.code === 'AUTHORIZATION_EXPIRED');
});

test('getValidGmailAccessToken throws AUTHORIZATION_EXPIRED when the token is expiring and there is no refresh token to fall back on', async () => {
  const { service } = makeFakes({
    getDecryptedCredentialForConnection: async () => ({ accessToken: 'ya29.expiring', refreshToken: null, expiresAt: new Date(Date.now() + 1000).toISOString() }),
  });
  await assert.rejects(() => service.getValidGmailAccessToken('conn-1'), (err) => err.code === 'AUTHORIZATION_EXPIRED');
});

test('getValidGmailAccessToken throws AUTHORIZATION_EXPIRED (not the raw Gmail error) when the refresh attempt itself fails', async () => {
  const { service } = makeFakes({
    getDecryptedCredentialForConnection: async () => ({ accessToken: 'ya29.expiring', refreshToken: '1//dead', expiresAt: new Date(Date.now() + 1000).toISOString() }),
    refreshAccessToken: async () => { const e = new Error('invalid_grant'); e.code = 'GMAIL_HTTP_ERROR'; throw e; },
  });
  await assert.rejects(() => service.getValidGmailAccessToken('conn-1'), (err) => err.code === 'AUTHORIZATION_EXPIRED');
});

// ─────────────────────────────────────────────
// ensureManagedLabel / getEmailConnectionRecord (EM5)
// ─────────────────────────────────────────────

test('ensureManagedLabel is a no-op (no network, no write) when the row already has a managed_label_id', async () => {
  const { service, calls } = makeFakes();
  const labelId = await service.ensureManagedLabel({
    oauthConnectionId: 'conn-1',
    emailConnectionRow: { managed_label_id: 'Label_existing' },
    accessToken: 'ya29.token',
  });
  assert.equal(labelId, 'Label_existing');
  assert.equal(calls.getOrCreateManagedLabel.length, 0);
  assert.equal(calls.updateManagedLabelId.length, 0);
});

test('ensureManagedLabel creates/reuses the label and persists it when the row has no managed_label_id yet', async () => {
  const { service, calls } = makeFakes();
  const labelId = await service.ensureManagedLabel({
    oauthConnectionId: 'conn-1',
    emailConnectionRow: { managed_label_id: null },
    accessToken: 'ya29.token',
  });
  assert.equal(labelId, 'Label_managed_1');
  assert.equal(calls.getOrCreateManagedLabel.length, 1);
  assert.deepEqual(calls.updateManagedLabelId[0], { oauthConnectionId: 'conn-1', managedLabelId: 'Label_managed_1' });
});

test('getEmailConnectionRecord returns the email_connections row for a given oauth_connections id', async () => {
  const { service, calls } = makeFakes();
  const row = await service.getEmailConnectionRecord('conn-1');
  assert.equal(row.oauth_connection_id, 'conn-1');
  assert.equal(calls.getByOauthConnectionId.length, 1);
});

test('handleCallback never throws for any input — every branch resolves to a redirect path', async () => {
  const { service } = makeFakes({ exchangeCodeForToken: async () => { throw new Error('boom'); } });
  await assert.doesNotReject(() => service.handleCallback({ code: 'c', state: 's', error: null }));
});

test('handleCallback never leaks the raw code, state, or access/refresh token into the returned redirect path', async () => {
  const { service } = makeFakes();
  const result = await service.handleCallback({ code: 'super-secret-code', state: 'super-secret-state', error: null });
  assert.equal(result.redirectPath.includes('super-secret-code'), false);
  assert.equal(result.redirectPath.includes('super-secret-state'), false);
  assert.equal(result.redirectPath.includes('ya29.real-access-token'), false);
  assert.equal(result.redirectPath.includes('1//real-refresh-token'), false);
});

test('reconnecting the same member replaces only that member\'s connection, leaving a different member\'s connection untouched', async () => {
  const { service, connectionsStore } = makeFakes({
    consumeState: async () => ({ status: 'consumed', clientId: 'client-a', memberId: 'member-b', redirectAfter: null }),
  });

  // Seed an existing active connection for member-a (a different member of
  // the same client) that must survive member-b's connect/reconnect below.
  connectionsStore.set('conn-a-existing', { id: 'conn-a-existing', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active', connected_at: '2026-07-01T00:00:00Z' });

  // First connect for member-b.
  const first = await service.handleCallback({ code: 'code-1', state: 'state-1', error: null });
  assert.equal(first.redirectPath, REDIRECT.SUCCESS);
  const firstActiveForB = [...connectionsStore.values()].filter((r) => r.connected_by_member_id === 'member-b' && r.status === 'active');
  assert.equal(firstActiveForB.length, 1);
  const firstConnectionId = firstActiveForB[0].id;

  // Reconnect (member-b connects again — e.g. after a disconnect+reconnect cycle).
  const second = await service.handleCallback({ code: 'code-2', state: 'state-2', error: null });
  assert.equal(second.redirectPath, REDIRECT.SUCCESS);

  const activeForB = [...connectionsStore.values()].filter((r) => r.connected_by_member_id === 'member-b' && r.status === 'active');
  assert.equal(activeForB.length, 1, 'member-b must have exactly one active connection after reconnecting, not two');
  assert.notEqual(activeForB[0].id, firstConnectionId, 'the reconnect must produce a new active connection row');

  // Member-a's pre-existing connection is completely unaffected.
  assert.equal(connectionsStore.get('conn-a-existing').status, 'active');
});

// ─────────────────────────────────────────────
// getConnections
// ─────────────────────────────────────────────

test('getConnections returns only the caller\'s own connection by default (no admin override)', async () => {
  const { service, connectionsStore } = makeFakes();
  connectionsStore.set('conn-a', { id: 'conn-a', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active', connected_at: '2026-07-23T00:00:00Z' });
  connectionsStore.set('conn-b', { id: 'conn-b', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-b', status: 'active', connected_at: '2026-07-23T00:00:00Z' });

  const result = await service.getConnections({ clientId: 'client-a', memberId: 'member-a', isOwnerAdmin: false, all: false });
  assert.equal(result.connections.length, 1);
  assert.equal(result.connections[0].connectionId, 'conn-a');
  assert.equal(result.connections[0].memberId, 'member-a');
});

test('getConnections returns an empty list when the caller has no connection', async () => {
  const { service } = makeFakes({ getActiveConnectionForClientAndMember: async () => null });
  const result = await service.getConnections({ clientId: 'client-a', memberId: 'member-a', isOwnerAdmin: false, all: false });
  assert.deepEqual(result.connections, []);
});

test('getConnections with all=true returns every member\'s connection, but ONLY for an owner/admin caller', async () => {
  const { service, connectionsStore } = makeFakes();
  connectionsStore.set('conn-a', { id: 'conn-a', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active', connected_at: '2026-07-23T00:00:00Z' });
  connectionsStore.set('conn-b', { id: 'conn-b', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-b', status: 'active', connected_at: '2026-07-23T00:00:00Z' });

  const adminResult = await service.getConnections({ clientId: 'client-a', memberId: 'member-a', isOwnerAdmin: true, all: true });
  assert.equal(adminResult.connections.length, 2);
  assert.deepEqual(adminResult.connections.map((c) => c.memberId).sort(), ['member-a', 'member-b']);
});

test('getConnections with all=true from a NON-admin caller is silently ignored — returns only their own connection', async () => {
  const { service, connectionsStore } = makeFakes();
  connectionsStore.set('conn-a', { id: 'conn-a', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active', connected_at: '2026-07-23T00:00:00Z' });
  connectionsStore.set('conn-b', { id: 'conn-b', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-b', status: 'active', connected_at: '2026-07-23T00:00:00Z' });

  const result = await service.getConnections({ clientId: 'client-a', memberId: 'member-a', isOwnerAdmin: false, all: true });
  assert.equal(result.connections.length, 1);
  assert.equal(result.connections[0].memberId, 'member-a');
});

// ─────────────────────────────────────────────
// disconnect
// ─────────────────────────────────────────────

test('disconnect with no matching/active connection is idempotent — returns safe success without calling revoke', async () => {
  const { service, calls } = makeFakes({ getConnectionById: async () => null });
  const result = await service.disconnect({ clientId: 'client-a', connectionId: 'conn-x' });
  assert.deepEqual(result, { disconnected: true });
  assert.equal(calls.revokeToken.length, 0);
  assert.equal(calls.markConnectionRevokedForMember.length, 0);
});

test('disconnect decrypts the token server-side, attempts best-effort provider revocation, and marks the member-scoped connection revoked', async () => {
  const { service, calls } = makeFakes({
    getConnectionById: async () => ({ id: 'conn-1', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active' }),
  });
  const result = await service.disconnect({ clientId: 'client-a', connectionId: 'conn-1' });
  assert.deepEqual(result, { disconnected: true });
  assert.equal(calls.revokeToken.length, 1);
  assert.equal(calls.revokeToken[0], 'ya29.decrypted-token');
  assert.equal(calls.markConnectionRevokedForMember.length, 1);
  assert.deepEqual(calls.markConnectionRevokedForMember[0], { clientId: 'client-a', provider: 'gmail', memberId: 'member-a' });
});

test('disconnect never returns the access token in its response', async () => {
  const { service } = makeFakes({
    getConnectionById: async () => ({ id: 'conn-1', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active' }),
  });
  const result = await service.disconnect({ clientId: 'client-a', connectionId: 'conn-1' });
  assert.equal(JSON.stringify(result).includes('ya29'), false);
  assert.deepEqual(Object.keys(result), ['disconnected']);
});

test('disconnect is tenant-scoped — a connectionId belonging to a different client is treated as not found', async () => {
  const { service, calls } = makeFakes({
    getConnectionById: async () => ({ id: 'conn-1', client_id: 'client-b', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active' }),
  });
  const result = await service.disconnect({ clientId: 'client-a', connectionId: 'conn-1' });
  assert.deepEqual(result, { disconnected: true });
  assert.equal(calls.revokeToken.length, 0);
  assert.equal(calls.markConnectionRevokedForMember.length, 0);
});

// ─────────────────────────────────────────────
// disconnect — cleanupIngestedContent (EM9 — §24, §14.1)
// ─────────────────────────────────────────────

test('disconnect without cleanupIngestedContent never calls AIKB listDocuments/deleteDocumentById', async () => {
  const { service, calls } = makeFakes({
    getConnectionById: async () => ({ id: 'conn-1', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active' }),
  });
  const result = await service.disconnect({ clientId: 'client-a', connectionId: 'conn-1' });
  assert.deepEqual(result, { disconnected: true });
  assert.equal(calls.listDocuments.length, 0);
  assert.equal(calls.deleteDocumentById.length, 0);
});

test('disconnect with cleanupIngestedContent:true enumerates documents filtered by the connection\'s member and deletes each one', async () => {
  const docs = [{ id: 'doc-1' }, { id: 'doc-2' }];
  const { service, calls } = makeFakes({
    getConnectionById: async () => ({ id: 'conn-1', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active' }),
    listDocuments: async () => ({ documents: docs }),
  });
  const result = await service.disconnect({ clientId: 'client-a', connectionId: 'conn-1', cleanupIngestedContent: true });

  assert.equal(calls.listDocuments.length, 1);
  assert.deepEqual(calls.listDocuments[0], { clientId: 'client-a', filters: { contributingMemberId: 'member-a' } });
  assert.equal(calls.deleteDocumentById.length, 2);
  assert.deepEqual(calls.deleteDocumentById.map((c) => c.documentId).sort(), ['doc-1', 'doc-2']);
  assert.deepEqual(result.cleanup, { requested: 2, deleted: 2, failed: 0 });
});

test('disconnect cleanup is best-effort: one delete failure is counted, not thrown, and the rest still proceed', async () => {
  const docs = [{ id: 'doc-1' }, { id: 'doc-2' }];
  const { service } = makeFakes({
    getConnectionById: async () => ({ id: 'conn-1', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active' }),
    listDocuments: async () => ({ documents: docs }),
    deleteDocumentById: async (clientId, documentId) => {
      if (documentId === 'doc-1') throw new Error('simulated AIKB delete failure');
    },
  });
  const result = await service.disconnect({ clientId: 'client-a', connectionId: 'conn-1', cleanupIngestedContent: true });
  assert.deepEqual(result.cleanup, { requested: 2, deleted: 1, failed: 1 });
  // The connection itself is still disconnected regardless of cleanup outcome.
  assert.equal(result.disconnected, true);
});

test('disconnect cleanup with zero contributed documents is a safe no-op', async () => {
  const { service } = makeFakes({
    getConnectionById: async () => ({ id: 'conn-1', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active' }),
    listDocuments: async () => ({ documents: [] }),
  });
  const result = await service.disconnect({ clientId: 'client-a', connectionId: 'conn-1', cleanupIngestedContent: true });
  assert.deepEqual(result.cleanup, { requested: 0, deleted: 0, failed: 0 });
});

// ─────────────────────────────────────────────
// Cross-member isolation (EM2's own spec calls this out explicitly —
// "the single most heavily-tested authorization boundary in this feature")
// ─────────────────────────────────────────────

test('cross-member isolation: disconnecting member A\'s connection never revokes member B\'s connection for the same client', async () => {
  const { service, calls, connectionsStore } = makeFakes();
  connectionsStore.set('conn-a', { id: 'conn-a', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active' });
  connectionsStore.set('conn-b', { id: 'conn-b', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-b', status: 'active' });

  await service.disconnect({ clientId: 'client-a', connectionId: 'conn-a' });

  assert.equal(calls.markConnectionRevokedForMember.length, 1);
  assert.equal(calls.markConnectionRevokedForMember[0].memberId, 'member-a');
  // Member B's row is untouched by the fake's own scoped revoke logic.
  assert.equal(connectionsStore.get('conn-a').status, 'revoked');
  assert.equal(connectionsStore.get('conn-b').status, 'active');
});

test('cross-member isolation: member B\'s getConnections call never surfaces member A\'s connection, even though both belong to the same client', async () => {
  const { service, connectionsStore } = makeFakes();
  connectionsStore.set('conn-a', { id: 'conn-a', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active', connected_at: '2026-07-23T00:00:00Z' });

  const resultForB = await service.getConnections({ clientId: 'client-a', memberId: 'member-b', isOwnerAdmin: false, all: false });
  assert.deepEqual(resultForB.connections, []);
});

// ─────────────────────────────────────────────
// canDisconnectConnection — EM2's disconnect authorization boundary.
// Self-service ONLY: no owner/admin override exists in this milestone (that
// administrative capability is deferred to EM9 — see emailConnectionService.js's
// file header). This function takes no role/isOwnerAdmin parameter at all,
// so there is no code path by which a role could grant access here.
// ─────────────────────────────────────────────

test('canDisconnectConnection allows a member to disconnect their own connection', () => {
  const connection = { connected_by_member_id: 'member-a' };
  assert.equal(canDisconnectConnection({ connection, actingMemberId: 'member-a' }), true);
});

test('canDisconnectConnection denies a member disconnecting a DIFFERENT member\'s connection — regular members', () => {
  const connection = { connected_by_member_id: 'member-a' };
  assert.equal(canDisconnectConnection({ connection, actingMemberId: 'member-b' }), false);
});

test('canDisconnectConnection has no owner/admin override — it does not accept a role at all, so no role value can grant access to another member\'s connection', () => {
  const connection = { connected_by_member_id: 'member-a' };
  // Even if a caller mistakenly stuffed a role-like field onto the args,
  // the function signature only ever reads actingMemberId — proving there
  // is no hidden bypass path a future refactor could accidentally wire up.
  assert.equal(canDisconnectConnection({ connection, actingMemberId: 'member-owner', role: 'owner', isOwnerAdmin: true }), false);
});

test('canDisconnectConnection is a connection-ID-alone-never-grants-access guard: a null/missing connection is always denied', () => {
  assert.equal(canDisconnectConnection({ connection: null, actingMemberId: 'member-a' }), false);
  assert.equal(canDisconnectConnection({ connection: undefined, actingMemberId: 'member-a' }), false);
});

test('canDisconnectConnection denies when actingMemberId is missing, even if a connection is somehow passed', () => {
  const connection = { connected_by_member_id: 'member-a' };
  assert.equal(canDisconnectConnection({ connection, actingMemberId: null }), false);
  assert.equal(canDisconnectConnection({ connection, actingMemberId: undefined }), false);
});

// EM10.6 removed updateSyncMode (POST /connections/:id/sync-mode) along
// with Automatic Email Ingestion itself — a connection's sync_mode is no
// longer a member choice between modes; see EMAIL_INGESTION.md's EM10.6
// record and pauseConnection/resumeConnection's own tests below for the
// only remaining sync_mode writes.

// ─────────────────────────────────────────────
// pauseConnection / resumeConnection (EM8 — §14.1 POST .../pause | /resume,
// §Lifecycle "Paused")
// ─────────────────────────────────────────────

test('pauseConnection remembers the connection\'s CURRENT sync_mode before overwriting it to paused', async () => {
  const { service, calls } = makeFakes({
    getByOauthConnectionId: async (oauthConnectionId) => ({ oauth_connection_id: oauthConnectionId, sync_mode: 'manual_selected', pre_pause_sync_mode: null }),
  });
  const result = await service.pauseConnection({ clientId: 'client-a', oauthConnectionId: 'conn-1' });
  assert.deepEqual(result, { syncMode: 'paused' });
  assert.equal(calls.pauseConnection.length, 1);
  assert.deepEqual(calls.pauseConnection[0], { oauthConnectionId: 'conn-1', priorSyncMode: 'manual_selected' });
});

test('pauseConnection on an already-paused connection is a no-op — never overwrites pre_pause_sync_mode with "paused" itself', async () => {
  const { service, calls } = makeFakes({
    getByOauthConnectionId: async (oauthConnectionId) => ({ oauth_connection_id: oauthConnectionId, sync_mode: 'paused', pre_pause_sync_mode: 'manual_selected' }),
  });
  const result = await service.pauseConnection({ clientId: 'client-a', oauthConnectionId: 'conn-1' });
  assert.deepEqual(result, { syncMode: 'paused' });
  assert.equal(calls.pauseConnection.length, 0, 'must not write when already paused');
});

test('pauseConnection surfaces CONNECTION_NOT_FOUND when no email_connections row exists', async () => {
  const { service } = makeFakes({ getByOauthConnectionId: async () => null });
  await assert.rejects(
    () => service.pauseConnection({ clientId: 'client-a', oauthConnectionId: 'conn-missing' }),
    (err) => err.code === 'CONNECTION_NOT_FOUND'
  );
});

test('resumeConnection restores the exact prior mode recorded by pauseConnection', async () => {
  const { service, calls } = makeFakes({
    getByOauthConnectionId: async (oauthConnectionId) => ({ oauth_connection_id: oauthConnectionId, sync_mode: 'paused', pre_pause_sync_mode: 'manual_selected' }),
  });
  const result = await service.resumeConnection({ clientId: 'client-a', oauthConnectionId: 'conn-1' });
  assert.deepEqual(result, { syncMode: 'manual_selected' });
  assert.deepEqual(calls.resumeConnection[0], { oauthConnectionId: 'conn-1', restoredSyncMode: 'manual_selected' });
});

test('resumeConnection defaults to manual_selected when pre_pause_sync_mode is an unrecognized/legacy value (e.g. "automatic" — removed in EM10.6, SYNC_MODES.includes() now falls through)', async () => {
  const { service, calls } = makeFakes({
    getByOauthConnectionId: async (oauthConnectionId) => ({ oauth_connection_id: oauthConnectionId, sync_mode: 'paused', pre_pause_sync_mode: 'automatic' }),
  });
  const result = await service.resumeConnection({ clientId: 'client-a', oauthConnectionId: 'conn-1' });
  assert.deepEqual(result, { syncMode: 'manual_selected' });
  assert.deepEqual(calls.resumeConnection[0], { oauthConnectionId: 'conn-1', restoredSyncMode: 'manual_selected' });
});

test('resumeConnection defaults to manual_selected when pre_pause_sync_mode is unset (e.g. paused before this migration existed)', async () => {
  const { service, calls } = makeFakes({
    getByOauthConnectionId: async (oauthConnectionId) => ({ oauth_connection_id: oauthConnectionId, sync_mode: 'paused', pre_pause_sync_mode: null }),
  });
  const result = await service.resumeConnection({ clientId: 'client-a', oauthConnectionId: 'conn-1' });
  assert.deepEqual(result, { syncMode: 'manual_selected' });
  assert.deepEqual(calls.resumeConnection[0], { oauthConnectionId: 'conn-1', restoredSyncMode: 'manual_selected' });
});

test('resumeConnection on a connection that is not paused is a no-op, returning its current mode unchanged', async () => {
  const { service, calls } = makeFakes({
    getByOauthConnectionId: async (oauthConnectionId) => ({ oauth_connection_id: oauthConnectionId, sync_mode: 'manual_selected', pre_pause_sync_mode: null }),
  });
  const result = await service.resumeConnection({ clientId: 'client-a', oauthConnectionId: 'conn-1' });
  assert.deepEqual(result, { syncMode: 'manual_selected' });
  assert.equal(calls.resumeConnection.length, 0, 'must not write when not paused');
});

test('resumeConnection surfaces CONNECTION_NOT_FOUND when no email_connections row exists', async () => {
  const { service } = makeFakes({ getByOauthConnectionId: async () => null });
  await assert.rejects(
    () => service.resumeConnection({ clientId: 'client-a', oauthConnectionId: 'conn-missing' }),
    (err) => err.code === 'CONNECTION_NOT_FOUND'
  );
});

// ─────────────────────────────────────────────
// mapGmailConnectionResponse — pure response mapping
// ─────────────────────────────────────────────

test('mapGmailConnectionResponse allowlists exactly the documented fields', () => {
  const connectionRow = {
    id: 'conn-1',
    connected_by_member_id: 'member-a',
    status: 'active',
    connected_at: '2026-07-23T00:00:00Z',
    external_account_name: 'alex@example.com',
  };
  const emailConnectionRow = {
    mailbox_address: 'alex@example.com',
    display_name: 'Alex Doe',
    sync_mode: 'manual_selected',
    sync_enabled: true,
    historical_import_status: 'not_started',
  };
  const mapped = mapGmailConnectionResponse(connectionRow, emailConnectionRow);
  assert.deepEqual(mapped, {
    connectionId: 'conn-1',
    memberId: 'member-a',
    provider: PROVIDER,
    mailboxAddress: 'alex@example.com',
    displayName: 'Alex Doe',
    syncMode: 'manual_selected',
    syncEnabled: true,
    historicalImportStatus: 'not_started',
    status: 'active',
    connectedAt: '2026-07-23T00:00:00Z',
  });
});

// EM10.6 removed nextSyncDueAt from this response shape along with
// Automatic Email Ingestion itself (it was meaningful only for
// automatic-mode connections) — see EMAIL_INGESTION.md's EM10.6 record.

test('mapGmailConnectionResponse never includes any credential-related field', () => {
  const connectionRow = {
    id: 'conn-1',
    connected_by_member_id: 'member-a',
    status: 'active',
    connected_at: '2026-07-23T00:00:00Z',
    // Simulates an accidental join/select mistake — must never leak through.
    access_token_encrypted: { ciphertext: 'should-never-appear' },
  };
  const mapped = mapGmailConnectionResponse(connectionRow, null);
  for (const key of ['access_token', 'refresh_token', 'access_token_encrypted', 'accessToken', 'ciphertext', 'iv', 'authTag']) {
    assert.equal(key in mapped, false, `must not include "${key}"`);
  }
});

// ─────────────────────────────────────────────
// setLiveLookupEnabledForOwnConnection (EL6 — §2.3's consent/revocation
// toggle, the per-mailbox half PUT /live-lookup-settings keeps in sync
// with client_members.live_lookup_consented_at in the same request)
// ─────────────────────────────────────────────

test('setLiveLookupEnabledForOwnConnection updates the member\'s own active connection', async () => {
  const { service, calls, connectionsStore } = makeFakes();
  connectionsStore.set('conn-a', { id: 'conn-a', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-a', status: 'active' });

  const result = await service.setLiveLookupEnabledForOwnConnection({ clientId: 'client-a', memberId: 'member-a', enabled: true });

  assert.deepEqual(result, { updated: true });
  assert.equal(calls.updateLiveLookupEnabled.length, 1);
  assert.deepEqual(calls.updateLiveLookupEnabled[0], { oauthConnectionId: 'conn-a', enabled: true });
});

test('setLiveLookupEnabledForOwnConnection is a no-op, not an error, when the member has no active connection', async () => {
  const { service, calls } = makeFakes();

  const result = await service.setLiveLookupEnabledForOwnConnection({ clientId: 'client-a', memberId: 'member-a', enabled: true });

  assert.deepEqual(result, { updated: false });
  assert.equal(calls.updateLiveLookupEnabled.length, 0);
});

test('setLiveLookupEnabledForOwnConnection never touches another member\'s connection', async () => {
  const { service, calls, connectionsStore } = makeFakes();
  connectionsStore.set('conn-b', { id: 'conn-b', client_id: 'client-a', provider: 'gmail', connected_by_member_id: 'member-b', status: 'active' });

  const result = await service.setLiveLookupEnabledForOwnConnection({ clientId: 'client-a', memberId: 'member-a', enabled: true });

  assert.deepEqual(result, { updated: false });
  assert.equal(calls.updateLiveLookupEnabled.length, 0);
});
