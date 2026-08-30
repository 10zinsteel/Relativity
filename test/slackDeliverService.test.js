const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlackDeliverService, RESULT } = require('../services/slackDeliverService');
const { createSlackDeliveryFailureService } = require('../services/slackDeliveryFailureService');

const CLIENT_ID = 'client-1';
const OTHER_CLIENT_ID = 'client-2';
const CONNECTION_ID = 'conn-1';
const IDEMPOTENCY_KEY = 'slack:Ev001';

const NO_OP_SLEEP = async () => {};

function baseRow(overrides = {}) {
  return {
    id: 'row-1',
    client_id: CLIENT_ID,
    connection_id: CONNECTION_ID,
    channel_id: 'C1',
    thread_ts: '1700000000.000000',
    event_ts: '1700000000.000000',
    status: 'enqueued',
    idempotency_key: IDEMPOTENCY_KEY,
    ...overrides,
  };
}

function createFakeSlackEventLogService({ row } = {}) {
  const state = { row: row ? { ...row } : null };
  return {
    state,
    getByIdempotencyKey: async (key) => (state.row && state.row.idempotency_key === key ? state.row : null),
    claimForDelivery: async (id) => {
      if (state.row && state.row.id === id && state.row.status === 'enqueued') {
        state.row.status = 'answered';
        return state.row;
      }
      return null;
    },
    markDelivered: async (id, opts) => {
      if (state.row && state.row.id === id) {
        state.row.status = 'delivered';
        if (opts && typeof opts.attemptCount === 'number') state.row.attempt_count = opts.attemptCount;
      }
      return state.row;
    },
    markFailed: async (id, opts) => { if (state.row && state.row.id === id) { state.row.status = 'failed'; state.row.error_code = opts.errorCode; } return state.row; },
    markDeliveryFailed: async (id, opts) => {
      if (state.row && state.row.id === id) {
        state.row.status = 'delivery_failed';
        state.row.error_code = opts.errorCode;
        state.row.attempt_count = opts.attemptCount;
        state.row.question = null;
      }
      return state.row;
    },
  };
}

function createFakeOauthConnectionsService({ connection = { id: CONNECTION_ID, status: 'active' }, credential = { accessToken: 'xoxb-fake' } } = {}) {
  return {
    getConnectionById: async () => connection,
    getDecryptedCredentialForConnection: async () => credential,
  };
}

function createFakeSlackDeliveryService({ failCount = 0, errorCode = 'SLACK_DELIVERY_HTTP_ERROR' } = {}) {
  const calls = [];
  return {
    calls,
    postMessage: async (params) => {
      calls.push(params);
      if (calls.length <= failCount) throw Object.assign(new Error('failed'), { code: errorCode });
      return { ts: '1.1', channel: params.channel };
    },
  };
}

function createFakeAikbRedactClient({ shouldFail = false } = {}) {
  const calls = [];
  return {
    calls,
    redact: async (params) => {
      calls.push(params);
      if (shouldFail) throw Object.assign(new Error('down'), { code: 'AIKB_REDACT_HTTP_ERROR' });
      return { redacted: true };
    },
  };
}

// EM10.8 — a trivial fake: appends "(enriched)" to any source that carried
// a contributingMemberId, so tests can assert enrichment ran (or didn't)
// without depending on citationAttributionService's own real logic.
function createFakeCitationAttributionService() {
  const calls = [];
  return {
    calls,
    enrichSourcesWithContributorNames: async (clientId, sources) => {
      calls.push({ clientId, sources });
      return sources.map((s) => (s.contributingMemberId ? { ...s, contributingMemberName: '(enriched)' } : s));
    },
  };
}

function buildService({ row, deliveryFailOptions = {}, aikbRedactOptions = {}, connectionOptions = {} } = {}) {
  const slackEventLogService = createFakeSlackEventLogService({ row });
  const slackDeliveryService = createFakeSlackDeliveryService(deliveryFailOptions);
  const aikbRedactClient = createFakeAikbRedactClient(aikbRedactOptions);
  const oauthConnectionsService = createFakeOauthConnectionsService(connectionOptions);
  const slackDeliveryFailureService = createSlackDeliveryFailureService({ slackEventLogService, aikbRedactClient });
  const citationAttributionService = createFakeCitationAttributionService();

  const service = createSlackDeliverService({
    slackEventLogService,
    oauthConnectionsService,
    slackDeliveryService,
    slackDeliveryFailureService,
    citationAttributionService,
    sleep: NO_OP_SLEEP,
  });

  return { service, slackEventLogService, slackDeliveryService, aikbRedactClient, oauthConnectionsService, citationAttributionService };
}

test('a successful answer is formatted and delivered on the first attempt, then the row is marked delivered', async () => {
  const { service, slackEventLogService, slackDeliveryService } = buildService({ row: baseRow() });

  const result = await service.handleDeliverCallback({
    clientId: CLIENT_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    payload: { answer: 'You get 15 days of PTO.', sources: [{ fileName: 'PTO.pdf' }], isKnowledgeGap: false },
  });

  assert.equal(result.result, RESULT.DELIVERED);
  assert.equal(slackDeliveryService.calls.length, 1);
  assert.match(slackDeliveryService.calls[0].text, /You get 15 days of PTO\./);
  assert.match(slackDeliveryService.calls[0].text, /Sources:\n• PTO\.pdf/);
  assert.equal(slackEventLogService.state.row.status, 'delivered');
  assert.equal(slackEventLogService.state.row.attempt_count, 1);
});

// EM10.8 (EMAIL_INGESTION.md §23) — contributor attribution.
test('an answer delivery enriches sources via citationAttributionService before formatting, passing the verified clientId (never a payload-supplied one)', async () => {
  const { service, slackDeliveryService, citationAttributionService } = buildService({ row: baseRow() });

  await service.handleDeliverCallback({
    clientId: CLIENT_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    payload: { answer: 'Renewal terms are net-30.', sources: [{ title: '"Renewal" from Jane', contributingMemberId: 'member-a' }], isKnowledgeGap: false },
  });

  assert.equal(citationAttributionService.calls.length, 1);
  assert.deepEqual(citationAttributionService.calls[0], { clientId: CLIENT_ID, sources: [{ title: '"Renewal" from Jane', contributingMemberId: 'member-a' }] });
  assert.match(slackDeliveryService.calls[0].text, /via \(enriched\)'s mailbox/);
});

test('an AIKB-reported error payload never calls citationAttributionService — there is nothing to enrich', async () => {
  const { service, citationAttributionService } = buildService({ row: baseRow() });

  await service.handleDeliverCallback({
    clientId: CLIENT_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    payload: { error: true, errorCode: 'AIKB_TIMEOUT' },
  });

  assert.equal(citationAttributionService.calls.length, 0);
});

test('a knowledge-gap payload delivers the approved fallback message', async () => {
  const { service, slackDeliveryService } = buildService({ row: baseRow() });

  await service.handleDeliverCallback({
    clientId: CLIENT_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    payload: { answer: '', sources: [], isKnowledgeGap: true },
  });

  assert.equal(slackDeliveryService.calls[0].text, "I couldn't find that information in your organization's knowledge base.");
});

test('an AIKB-reported error payload delivers the temporary-failure fallback (single attempt, unchanged by ADR-007)', async () => {
  const { service, slackDeliveryService } = buildService({ row: baseRow() });

  await service.handleDeliverCallback({
    clientId: CLIENT_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    payload: { error: true, errorCode: 'AIKB_PROCESSING_FAILED' },
  });

  assert.equal(slackDeliveryService.calls[0].text, "I couldn't complete that request right now. Please try again shortly.");
  assert.equal(slackDeliveryService.calls.length, 1, 'AIKB generation failures are not retried, per ADR-007');
});

test('an unknown idempotencyKey (no matching event) is safely ignored', async () => {
  const { service } = buildService({ row: null });

  const result = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: 'slack:unknown', payload: { answer: 'x' } });
  assert.equal(result.result, RESULT.UNKNOWN_EVENT);
});

test('a clientId that does not match the event\'s own resolved clientId is rejected (cross-tenant safety)', async () => {
  const { service, slackDeliveryService } = buildService({ row: baseRow() });

  const result = await service.handleDeliverCallback({ clientId: OTHER_CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x' } });
  assert.equal(result.result, RESULT.CLIENT_MISMATCH);
  assert.equal(slackDeliveryService.calls.length, 0);
});

test('a second /deliver callback for the same event is a safe no-op (only the first delivery attempt proceeds)', async () => {
  const { service, slackDeliveryService } = buildService({ row: baseRow() });

  const first = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });
  const second = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });

  assert.equal(first.result, RESULT.DELIVERED);
  assert.equal(second.result, RESULT.ALREADY_PROCESSED);
  assert.equal(slackDeliveryService.calls.length, 1, 'Slack must never receive two posts for the same event');
});

test('a revoked connection on a real-answer delivery goes straight to the terminal delivery_failed state and redacts', async () => {
  const { service, slackDeliveryService, slackEventLogService, aikbRedactClient } = buildService({
    row: baseRow(),
    connectionOptions: { connection: { id: CONNECTION_ID, status: 'revoked' } },
  });

  const result = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });
  assert.equal(result.result, RESULT.CONNECTION_REVOKED);
  assert.equal(slackDeliveryService.calls.length, 0);
  assert.equal(slackEventLogService.state.row.status, 'delivery_failed');
  assert.equal(slackEventLogService.state.row.question, null);
  assert.equal(aikbRedactClient.calls.length, 1, 'AIKB-side content must be redacted too');
});

test('a revoked connection on an AIKB-error-notification delivery keeps the existing failed status, unchanged by ADR-007', async () => {
  const { service, slackEventLogService, aikbRedactClient } = buildService({
    row: baseRow(),
    connectionOptions: { connection: { id: CONNECTION_ID, status: 'revoked' } },
  });

  const result = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { error: true, errorCode: 'AIKB_PROCESSING_FAILED' } });
  assert.equal(result.result, RESULT.CONNECTION_REVOKED);
  assert.equal(slackEventLogService.state.row.status, 'failed');
  assert.equal(aikbRedactClient.calls.length, 0, 'the AIKB-generation-failure path never triggers redaction');
});

test('retry success: the first delivery attempt fails, the second succeeds, and the row is marked delivered', async () => {
  const { service, slackEventLogService, slackDeliveryService } = buildService({
    row: baseRow(),
    deliveryFailOptions: { failCount: 1 },
  });

  const result = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });

  assert.equal(result.result, RESULT.DELIVERED);
  assert.equal(slackDeliveryService.calls.length, 2, 'exactly one retry should have occurred');
  assert.equal(slackEventLogService.state.row.status, 'delivered');
  assert.equal(slackEventLogService.state.row.attempt_count, 2);
});

test('terminal failure: all 3 delivery attempts fail, the row reaches delivery_failed, and AIKB content is redacted', async () => {
  const { service, slackEventLogService, slackDeliveryService, aikbRedactClient } = buildService({
    row: baseRow(),
    deliveryFailOptions: { failCount: 3, errorCode: 'SLACK_DELIVERY_NOT_OK' },
  });

  const result = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });

  assert.equal(result.result, RESULT.DELIVERY_FAILED);
  assert.equal(slackDeliveryService.calls.length, 3, 'exactly 3 total attempts: initial + retry #1 + retry #2');
  assert.equal(slackEventLogService.state.row.status, 'delivery_failed');
  assert.equal(slackEventLogService.state.row.attempt_count, 3);
  assert.equal(slackEventLogService.state.row.error_code, 'SLACK_DELIVERY_NOT_OK');
  assert.equal(slackEventLogService.state.row.question, null, 'the stored question must be redacted on terminal failure');
  assert.deepEqual(aikbRedactClient.calls, [{ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY }]);
});

test('a failing AIKB redact callback never changes the delivery result — redaction failure is best-effort only', async () => {
  const { service } = buildService({
    row: baseRow(),
    deliveryFailOptions: { failCount: 3 },
    aikbRedactOptions: { shouldFail: true },
  });

  const result = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });
  assert.equal(result.result, RESULT.DELIVERY_FAILED);
});

test('a /deliver callback arriving after the row already reached delivery_failed is a safe no-op, never re-delivers', async () => {
  const { service, slackEventLogService, slackDeliveryService } = buildService({
    row: baseRow(),
    deliveryFailOptions: { failCount: 3 },
  });

  const first = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });
  assert.equal(first.result, RESULT.DELIVERY_FAILED);
  assert.equal(slackEventLogService.state.row.status, 'delivery_failed');

  const resend = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });
  assert.equal(resend.result, RESULT.ALREADY_PROCESSED);
  assert.equal(slackDeliveryService.calls.length, 3, 'no further Slack post must ever happen once the row is terminal');
});

test('the token is never exposed anywhere in the result or thrown errors', async () => {
  const { service } = buildService({
    row: baseRow(),
    connectionOptions: { credential: { accessToken: 'xoxb-SUPER-SECRET' } },
  });

  const result = await service.handleDeliverCallback({ clientId: CLIENT_ID, idempotencyKey: IDEMPOTENCY_KEY, payload: { answer: 'x', sources: [] } });
  assert.ok(!JSON.stringify(result).includes('xoxb-SUPER-SECRET'));
});

test('EL7B: emailLookupSuggested:true in the payload appends the link-prompt hint to the delivered message', async () => {
  const { service, slackDeliveryService } = buildService({ row: baseRow() });

  await service.handleDeliverCallback({
    clientId: CLIENT_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    payload: { answer: 'Not sure from our documents.', sources: [], isKnowledgeGap: false, emailLookupSuggested: true },
  });

  assert.match(slackDeliveryService.calls[0].text, /link your Slack account/i);
});

test('EL7B: omitting emailLookupSuggested changes nothing about the delivered message', async () => {
  const { service, slackDeliveryService } = buildService({ row: baseRow() });

  await service.handleDeliverCallback({
    clientId: CLIENT_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    payload: { answer: 'You get 15 days of PTO.', sources: [], isKnowledgeGap: false },
  });

  assert.doesNotMatch(slackDeliveryService.calls[0].text, /link your Slack account/i);
});
