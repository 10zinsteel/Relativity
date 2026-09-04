const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlackEventsService, OUTCOME } = require('../services/slackEventsService');
const { createSlackDeliveryFailureService } = require('../services/slackDeliveryFailureService');

const CLIENT_ID = 'client-1';
const CONNECTION_ID = 'conn-1';
const TEAM_ID = 'T12345';
const BOT_USER_ID = 'U0BOT';
const NO_OP_SLEEP = async () => {};

function activeConnection(overrides = {}) {
  return {
    id: CONNECTION_ID,
    client_id: CLIENT_ID,
    provider: 'slack',
    external_account_id: TEAM_ID,
    status: 'active',
    provider_metadata: { bot_user_id: BOT_USER_ID },
    ...overrides,
  };
}

function activeClient(overrides = {}) {
  return { id: CLIENT_ID, is_active: true, ...overrides };
}

function baseEventCallback(overrides = {}) {
  const { event: eventOverrides, ...topLevelOverrides } = overrides;
  return {
    type: 'event_callback',
    team_id: TEAM_ID,
    event_id: 'Ev001',
    ...topLevelOverrides,
    event: {
      type: 'app_mention',
      user: 'U0HUMAN',
      text: `<@${BOT_USER_ID}> What is our PTO policy?`,
      channel: 'C1',
      ts: '1700000000.000000',
      ...eventOverrides,
    },
  };
}

function createFakeSlackEventLog(initial = {}) {
  const rows = new Map();
  let nextId = 1;
  return {
    calls: [],
    insertReceived: async (params) => {
      const key = `slack:${params.externalEventId}`;
      const existing = [...rows.values()].find((r) => r.external_event_id === params.externalEventId);
      if (existing) return { inserted: false, row: existing };
      const row = { id: String(nextId++), status: 'received', channel_id: params.channelId, thread_ts: params.threadTs, event_ts: params.eventTs, external_event_id: params.externalEventId, client_id: params.clientId, connection_id: params.connectionId, idempotency_key: params.idempotencyKey, ...initial };
      rows.set(row.id, row);
      return { inserted: true, row };
    },
    markEnqueued: async (id) => { const r = rows.get(id); if (r) r.status = 'enqueued'; return r; },
    markDelivered: async (id, opts) => { const r = rows.get(id); if (r) { r.status = 'delivered'; if (opts && typeof opts.attemptCount === 'number') r.attempt_count = opts.attemptCount; } return r; },
    markFailed: async (id, opts) => { const r = rows.get(id); if (r) { r.status = 'failed'; r.error_code = opts.errorCode; } return r; },
    markDeliveryFailed: async (id, opts) => {
      const r = rows.get(id);
      if (r) { r.status = 'delivery_failed'; r.error_code = opts.errorCode; r.attempt_count = opts.attemptCount; }
      return r;
    },
    _rows: rows,
  };
}

function createFakeOauthConnectionsService({ connection = activeConnection(), credential = { accessToken: 'xoxb-fake' } } = {}) {
  return {
    getActiveConnectionByExternalAccount: async () => connection,
    getDecryptedCredentialForConnection: async () => credential,
  };
}

function createFakeSupabaseService({ client = activeClient() } = {}) {
  return { getClientById: async () => client };
}

function createFakeAikbAskClient({ failCount = 0, shouldFail = false } = {}) {
  const calls = [];
  const totalFailures = shouldFail ? Infinity : failCount;
  return {
    calls,
    ask: async (params) => {
      calls.push(params);
      if (calls.length <= totalFailures) throw Object.assign(new Error('down'), { code: 'AIKB_ASK_HTTP_ERROR' });
      return { accepted: true, eventId: 'aikb-evt-1' };
    },
  };
}

function createFakeSlackDeliveryService({ failCount = 0 } = {}) {
  const calls = [];
  return {
    calls,
    postMessage: async (params) => {
      calls.push(params);
      if (calls.length <= failCount) throw Object.assign(new Error('failed'), { code: 'SLACK_DELIVERY_HTTP_ERROR' });
      return { ts: '1.0', channel: params.channel };
    },
  };
}

function createFakeAikbRedactClient() {
  const calls = [];
  return { calls, redact: async (params) => { calls.push(params); return { redacted: true }; } };
}

function buildDeliveryFailureService({ slackEventLogService, aikbRedactClient = createFakeAikbRedactClient() }) {
  return createSlackDeliveryFailureService({ slackEventLogService, aikbRedactClient });
}

// Milestone 5: processEventCallback/retryStuckRow look up the org's
// Slack-allowed collections fresh on every call — fake it here so no test
// in this file makes a real network call, matching this file's existing
// all-fakes convention. Defaults to an unrestricted-looking empty allow
// list unless a test cares about the specific value passed through to
// aikbAskClient.
function createFakeSlackCollectionAccessService(allowedCollectionIds = []) {
  return { getAllowedCollectionIds: async () => allowedCollectionIds };
}

test('a valid app_mention with a real question resolves the workspace, dedupes, and enqueues via AIKB', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const aikbAskClient = createFakeAikbAskClient();
  const oauthConnectionsService = createFakeOauthConnectionsService();
  const supabaseService = createFakeSupabaseService();
  const slackDeliveryService = createFakeSlackDeliveryService();

  const service = createSlackEventsService({ sleep: NO_OP_SLEEP, slackEventLogService, aikbAskClient, oauthConnectionsService, supabaseService, slackDeliveryService, slackCollectionAccessService: createFakeSlackCollectionAccessService(['col-general']) });
  const result = await service.processEventCallback(baseEventCallback());

  assert.equal(result.outcome, OUTCOME.ENQUEUED);
  assert.equal(aikbAskClient.calls.length, 1);
  assert.equal(aikbAskClient.calls[0].clientId, CLIENT_ID);
  assert.equal(aikbAskClient.calls[0].question, 'What is our PTO policy?');
  assert.equal(aikbAskClient.calls[0].idempotencyKey, 'slack:Ev001');
  assert.deepEqual(aikbAskClient.calls[0].allowedCollectionIds, ['col-general'], 'the org\'s currently-allowed collections must be looked up and passed through');
  assert.equal(aikbAskClient.calls[0].origin, 'slack', 'a channel @mention must tag its AIKB session as \'slack\', not \'slack_dm\'');
});

test('backlog M13: a 1:1 DM (message/im) is processed exactly like an app_mention, tagged origin: slack_dm', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const aikbAskClient = createFakeAikbAskClient();
  const oauthConnectionsService = createFakeOauthConnectionsService();
  const supabaseService = createFakeSupabaseService();
  const slackDeliveryService = createFakeSlackDeliveryService();

  const service = createSlackEventsService({ sleep: NO_OP_SLEEP, slackEventLogService, aikbAskClient, oauthConnectionsService, supabaseService, slackDeliveryService, slackCollectionAccessService: createFakeSlackCollectionAccessService(['col-general']) });
  const result = await service.processEventCallback(baseEventCallback({
    event: { type: 'message', channel_type: 'im', text: 'What is our PTO policy?', channel: 'D1' },
  }));

  assert.equal(result.outcome, OUTCOME.ENQUEUED);
  assert.equal(aikbAskClient.calls.length, 1);
  assert.equal(aikbAskClient.calls[0].question, 'What is our PTO policy?', 'no mention prefix to strip in a DM — the raw text is the question');
  assert.equal(aikbAskClient.calls[0].origin, 'slack_dm');
  assert.deepEqual(aikbAskClient.calls[0].allowedCollectionIds, ['col-general'], 'DMs reuse the same client-wide allow-list as channel mentions — no per-member scoping');
  assert.equal(aikbAskClient.calls[0].memberId, null, 'EL7C: Slack never resolves a requesting member');
  assert.equal(aikbAskClient.calls[0].emailLookupAvailable, false, 'EL7C: Slack never offers live email lookup');
});

test('backlog M13: a group DM (message/mpim) is explicitly unsupported, no AIKB call', async () => {
  const aikbAskClient = createFakeAikbAskClient();
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = await service.processEventCallback(baseEventCallback({
    event: { type: 'message', channel_type: 'mpim', text: 'hey bot', channel: 'G1' },
  }));

  assert.equal(result.outcome, OUTCOME.MPIM_UNSUPPORTED);
  assert.equal(aikbAskClient.calls.length, 0);
});

test('never trusts a client/organization id from the Slack payload — only from the DB lookup', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const aikbAskClient = createFakeAikbAskClient();
  const oauthConnectionsService = createFakeOauthConnectionsService();
  const supabaseService = createFakeSupabaseService();
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP, slackEventLogService, aikbAskClient, oauthConnectionsService, supabaseService, slackDeliveryService: createFakeSlackDeliveryService(), slackCollectionAccessService: createFakeSlackCollectionAccessService() });

  const spoofed = baseEventCallback({ client_id: 'attacker-supplied-client-id', organization_id: 'attacker-org' });
  await service.processEventCallback(spoofed);

  assert.equal(aikbAskClient.calls[0].clientId, CLIENT_ID, 'clientId must come only from the trusted oauth_connections lookup');
});

test('a duplicate event_id is deduped and never calls AIKB twice', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const aikbAskClient = createFakeAikbAskClient();
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService, aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const first = await service.processEventCallback(baseEventCallback());
  const second = await service.processEventCallback(baseEventCallback());

  assert.equal(first.outcome, OUTCOME.ENQUEUED);
  assert.equal(second.outcome, OUTCOME.DUPLICATE);
  assert.equal(aikbAskClient.calls.length, 1);
});

test('an unknown workspace (no active connection) is safely rejected, no AIKB call', async () => {
  const aikbAskClient = createFakeAikbAskClient();
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient,
    oauthConnectionsService: { getActiveConnectionByExternalAccount: async () => null },
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = await service.processEventCallback(baseEventCallback());
  assert.equal(result.outcome, OUTCOME.UNKNOWN_WORKSPACE);
  assert.equal(aikbAskClient.calls.length, 0);
});

test('an ambiguous mapping (lookup throws) is rejected the same as unknown, never leaks the error', async () => {
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: { getActiveConnectionByExternalAccount: async () => { throw new Error('PGRST116: more than one row returned'); } },
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = await service.processEventCallback(baseEventCallback());
  assert.equal(result.outcome, OUTCOME.UNKNOWN_WORKSPACE);
});

test('an inactive organization is rejected, no AIKB call', async () => {
  const aikbAskClient = createFakeAikbAskClient();
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService({ client: activeClient({ is_active: false }) }),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = await service.processEventCallback(baseEventCallback());
  assert.equal(result.outcome, OUTCOME.INACTIVE_ORG);
  assert.equal(aikbAskClient.calls.length, 0);
});

test('a bot-generated event is ignored', async () => {
  const aikbAskClient = createFakeAikbAskClient();
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = await service.processEventCallback(baseEventCallback({ event: { bot_id: 'B123' } }));
  assert.equal(result.outcome, OUTCOME.BOT_EVENT);
  assert.equal(aikbAskClient.calls.length, 0);
});

test('a self-generated event (from RelativityBot itself) is ignored', async () => {
  const aikbAskClient = createFakeAikbAskClient();
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = await service.processEventCallback(baseEventCallback({ event: { user: BOT_USER_ID } }));
  assert.equal(result.outcome, OUTCOME.SELF_EVENT);
  assert.equal(aikbAskClient.calls.length, 0);
});

test('an unsupported event type is ignored', async () => {
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = await service.processEventCallback(baseEventCallback({ event: { type: 'message' } }));
  assert.equal(result.outcome, OUTCOME.UNSUPPORTED_EVENT_TYPE);
});

test('an edited-message subtype is ignored', async () => {
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = await service.processEventCallback(baseEventCallback({ event: { subtype: 'message_changed' } }));
  assert.equal(result.outcome, OUTCOME.EDITED_OR_DELETED);
});

test('a malformed payload (missing team_id) is safely ignored', async () => {
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = await service.processEventCallback({ type: 'event_callback', event_id: 'Ev001', event: { type: 'app_mention' } });
  assert.equal(result.outcome, OUTCOME.MALFORMED);
});

test('a malformed payload (missing event) is safely ignored', async () => {
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = await service.processEventCallback({ type: 'event_callback', team_id: TEAM_ID, event_id: 'Ev001' });
  assert.equal(result.outcome, OUTCOME.MALFORMED);
});

test('a Slack resend after the original event already reached delivery_failed is still deduped, never reprocessed', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const aikbAskClient = createFakeAikbAskClient({ shouldFail: true });
  const service = createSlackEventsService({
    sleep: NO_OP_SLEEP,
    slackEventLogService, aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
    slackDeliveryFailureService: buildDeliveryFailureService({ slackEventLogService }),
  });

  const first = await service.processEventCallback(baseEventCallback());
  assert.equal(first.outcome, OUTCOME.ASK_FAILED);
  assert.equal([...slackEventLogService._rows.values()][0].status, 'delivery_failed');

  const resend = await service.processEventCallback(baseEventCallback());
  assert.equal(resend.outcome, OUTCOME.DUPLICATE);
  assert.equal(aikbAskClient.calls.length, 3, 'the resend must never call AIKB again — only the original 3 bounded attempts happened');
});

test('an empty mention (no question) never calls AIKB and replies directly with the safe fallback', async () => {
  const aikbAskClient = createFakeAikbAskClient();
  const slackDeliveryService = createFakeSlackDeliveryService();
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService,
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = await service.processEventCallback(baseEventCallback({ event: { text: `<@${BOT_USER_ID}>` } }));
  assert.equal(result.outcome, OUTCOME.EMPTY_QUESTION);
  assert.equal(aikbAskClient.calls.length, 0);
  assert.equal(slackDeliveryService.calls.length, 1);
  assert.equal(slackDeliveryService.calls[0].text, 'Please include a question after mentioning me.');
});

test('an over-length question never calls AIKB and replies with the too-long fallback, not the empty-question one', async () => {
  const aikbAskClient = createFakeAikbAskClient();
  const slackDeliveryService = createFakeSlackDeliveryService();
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService,
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const overLongText = `<@${BOT_USER_ID}> ${'a'.repeat(2001)}`;
  const result = await service.processEventCallback(baseEventCallback({ event: { text: overLongText } }));
  assert.equal(result.outcome, OUTCOME.QUESTION_TOO_LONG);
  assert.equal(aikbAskClient.calls.length, 0);
  assert.equal(slackDeliveryService.calls.length, 1);
  assert.equal(slackDeliveryService.calls[0].text, 'That question is too long — please shorten it and ask again.');
});

test('url_verification returns the exact challenge value', () => {
  const service = createSlackEventsService({ sleep: NO_OP_SLEEP,
    slackEventLogService: createFakeSlackEventLog(),
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = service.handleUrlVerification({ type: 'url_verification', challenge: 'abc123' });
  assert.deepEqual(result, { challenge: 'abc123' });
});

test('AIKB /ask retry success: the first accept-and-enqueue attempt fails, the second succeeds', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const aikbAskClient = createFakeAikbAskClient({ failCount: 1 });
  const service = createSlackEventsService({
    sleep: NO_OP_SLEEP,
    slackEventLogService, aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService: createFakeSlackDeliveryService(),
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = await service.processEventCallback(baseEventCallback());
  assert.equal(result.outcome, OUTCOME.ENQUEUED);
  assert.equal(aikbAskClient.calls.length, 2, 'exactly one retry should have occurred');
  assert.equal([...slackEventLogService._rows.values()][0].status, 'enqueued');
});

test('AIKB /ask terminal failure: all 3 attempts fail — best-effort Slack notice, delivery_failed, redaction, AIKB never processed', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const aikbAskClient = createFakeAikbAskClient({ shouldFail: true });
  const slackDeliveryService = createFakeSlackDeliveryService();
  const aikbRedactClient = createFakeAikbRedactClient();
  const service = createSlackEventsService({
    sleep: NO_OP_SLEEP,
    slackEventLogService, aikbAskClient,
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService,
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
    slackDeliveryFailureService: buildDeliveryFailureService({ slackEventLogService, aikbRedactClient }),
  });

  const result = await service.processEventCallback(baseEventCallback());

  assert.equal(result.status, 200);
  assert.equal(result.outcome, OUTCOME.ASK_FAILED);
  assert.equal(aikbAskClient.calls.length, 3, 'exactly 3 total attempts: initial + retry #1 + retry #2');

  const row = [...slackEventLogService._rows.values()][0];
  assert.equal(row.status, 'delivery_failed');
  assert.equal(row.attempt_count, 3);
  assert.equal(row.question, undefined, 'Backlog M13 (revised): slack_event_log never stores a question at all, not even transiently');

  assert.equal(slackDeliveryService.calls.length, 1, 'a best-effort "couldn\'t complete that request" notice is sent since Slack itself is reachable');
  assert.equal(slackDeliveryService.calls[0].text, "I couldn't complete that request right now. Please try again shortly.");

  assert.deepEqual(aikbRedactClient.calls, [{ clientId: CLIENT_ID, idempotencyKey: 'slack:Ev001' }]);
});

test('an empty mention: a transient delivery failure is retried and still succeeds', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const slackDeliveryService = createFakeSlackDeliveryService({ failCount: 1 });
  const service = createSlackEventsService({
    sleep: NO_OP_SLEEP,
    slackEventLogService,
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService,
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
  });

  const result = await service.processEventCallback(baseEventCallback({ event: { text: `<@${BOT_USER_ID}>` } }));
  assert.equal(result.outcome, OUTCOME.EMPTY_QUESTION);
  assert.equal(slackDeliveryService.calls.length, 2);
  assert.equal([...slackEventLogService._rows.values()][0].status, 'delivered');
});

test('an empty mention: all 3 reply attempts fail — the row reaches delivery_failed with no AIKB redact call (AIKB was never reached)', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const slackDeliveryService = createFakeSlackDeliveryService({ failCount: 3 });
  const aikbRedactClient = createFakeAikbRedactClient();
  const service = createSlackEventsService({
    sleep: NO_OP_SLEEP,
    slackEventLogService,
    aikbAskClient: createFakeAikbAskClient(),
    oauthConnectionsService: createFakeOauthConnectionsService(),
    supabaseService: createFakeSupabaseService(),
    slackDeliveryService,
    slackCollectionAccessService: createFakeSlackCollectionAccessService(),
    slackDeliveryFailureService: buildDeliveryFailureService({ slackEventLogService, aikbRedactClient }),
  });

  const result = await service.processEventCallback(baseEventCallback({ event: { text: `<@${BOT_USER_ID}>` } }));
  assert.equal(result.outcome, OUTCOME.EMPTY_QUESTION);
  assert.equal(slackDeliveryService.calls.length, 3);

  const row = [...slackEventLogService._rows.values()][0];
  assert.equal(row.status, 'delivery_failed');
  assert.equal(aikbRedactClient.calls.length, 0, 'no AIKB session could exist for an empty-question reply');
});

// ─────────────────────────────────────────────
// EL7C — Slack Live-Email Access Removal (LIVE_EMAIL_LOOKUP.md): identity
// linking (EL7A) and Slack's live-lookup path (EL7B) were removed
// entirely. A DM never resolves a requesting member, so a "link CODE"-
// shaped message is just an ordinary question that falls through to AIKB
// like any other.
// ─────────────────────────────────────────────

function dmEventCallback(text, overrides = {}) {
  return baseEventCallback({
    event: { type: 'message', channel_type: 'im', user: 'U0HUMAN', text, channel: 'D1', ...overrides },
  });
}

test('EL7C: a "link CODE"-shaped DM is treated as an ordinary question, never intercepted', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const aikbAskClient = createFakeAikbAskClient();
  const oauthConnectionsService = createFakeOauthConnectionsService();
  const supabaseService = createFakeSupabaseService();
  const slackDeliveryService = createFakeSlackDeliveryService();

  const service = createSlackEventsService({
    sleep: NO_OP_SLEEP, slackEventLogService, aikbAskClient, oauthConnectionsService, supabaseService, slackDeliveryService,
    slackCollectionAccessService: createFakeSlackCollectionAccessService(['col-general']),
  });
  const result = await service.processEventCallback(dmEventCallback('link K7XQ2P9M'));

  assert.equal(result.outcome, OUTCOME.ENQUEUED);
  assert.equal(aikbAskClient.calls.length, 1);
  assert.equal(aikbAskClient.calls[0].question, 'link K7XQ2P9M');
  assert.equal(aikbAskClient.calls[0].memberId, null);
  assert.equal(aikbAskClient.calls[0].emailLookupAvailable, false);
});

test('EL7C: a channel @mention with "link CODE"-shaped text is likewise just an ordinary question', async () => {
  const slackEventLogService = createFakeSlackEventLog();
  const aikbAskClient = createFakeAikbAskClient();
  const oauthConnectionsService = createFakeOauthConnectionsService();
  const supabaseService = createFakeSupabaseService();
  const slackDeliveryService = createFakeSlackDeliveryService();

  const service = createSlackEventsService({
    sleep: NO_OP_SLEEP, slackEventLogService, aikbAskClient, oauthConnectionsService, supabaseService, slackDeliveryService,
    slackCollectionAccessService: createFakeSlackCollectionAccessService(['col-general']),
  });
  const result = await service.processEventCallback(baseEventCallback({
    event: { type: 'app_mention', user: 'U0HUMAN', text: `<@${BOT_USER_ID}> link K7XQ2P9M`, channel: 'C1', ts: '1700000000.000000' },
  }));

  assert.equal(result.outcome, OUTCOME.ENQUEUED);
  assert.equal(aikbAskClient.calls.length, 1);
  assert.equal(aikbAskClient.calls[0].memberId, null);
  assert.equal(aikbAskClient.calls[0].emailLookupAvailable, false);
});
