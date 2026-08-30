'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createEmailSyncService,
  assertSyncAllowed,
  ERROR_CODES,
  HISTORICAL_PAGE_SIZE,
} = require('../services/emailSyncService');
const { compileSearchQuery, ERROR_CODES: GMAIL_ERROR_CODES } = require('../services/gmailService');
const { evaluateMessageAgainstPolicy } = require('../services/emailPolicyService');
const { normalizeEmailBody } = require('../services/emailNormalizationService');

// Mirrors test/emailPreviewService.test.js's fixture convention: the real,
// pure compileSearchQuery/evaluateMessageAgainstPolicy/normalizeEmailBody
// functions are used unmodified (imported directly, not re-faked) — only
// the network-shaped gmailService/aikbService calls and the DB-backed
// emailSyncRepo are faked, so these tests exercise real policy/normalization
// logic against a fixture "mailbox."

const MANAGED_LABEL_ID = 'Label_managed_1';
const LABELS = [
  { id: MANAGED_LABEL_ID, name: 'Relativity/Knowledge' },
  { id: 'Label_finance', name: 'finance' },
  { id: 'Label_payroll', name: 'finance/payroll' },
  { id: 'INBOX', name: 'INBOX' },
];

const ALLOW_FINANCE = { id: 'rule-1', ruleType: 'allow', labelOrFolder: 'finance', enabled: true };
const DENY_PAYROLL = { id: 'rule-2', ruleType: 'deny', labelOrFolder: 'finance/payroll', enabled: true };

function fixtureConnection(overrides = {}) {
  return {
    id: 'conn-1',
    member_id: 'member-1',
    mailbox_address: 'sam@client.com',
    sync_mode: 'manual_selected',
    sync_enabled: true,
    managed_label_id: MANAGED_LABEL_ID,
    ...overrides,
  };
}

// EM7 — a default fake historyId every fixture-driven historical sync
// establishes on completion, unless a test overrides getMailboxHistoryId
// itself. Distinct from any real history.list response's historyId so a
// test can tell "the fallback default" from "a real captured cursor" apart.
const DEFAULT_FIXTURE_HISTORY_ID = 'history-default';

function fixtureGmailService({
  pages = [], labels = LABELS, bodies = {}, calls = {},
  mailboxHistoryId = DEFAULT_FIXTURE_HISTORY_ID, historyPages = [],
  // EM9 (§24.5, §28.1) — reconcilePolicyChanges re-fetches metadata for
  // previously-ingested messages independent of any current page's
  // candidates; extraMessages lets a test give one of those messages a
  // resolvable metadata fixture without it also appearing as a "new"
  // candidate in listMessageIdsByQuery/history.list.
  extraMessages = [],
} = {}) {
  let pageCall = 0;
  let historyPageCall = 0;
  return {
    compileSearchQuery,
    listMessageIdsByQuery: async ({ query, pageToken }) => {
      calls.listMessageIdsByQuery = calls.listMessageIdsByQuery || [];
      calls.listMessageIdsByQuery.push({ query, pageToken });
      const page = pages[pageCall] || { messages: [], nextPageToken: null };
      pageCall++;
      return { messageIds: page.messages.map((m) => m.id), nextPageToken: page.nextPageToken || null };
    },
    listLabels: async () => labels,
    getMessageMetadata: async ({ messageId }) => {
      // extraMessages takes priority — a page entry added only to satisfy a
      // reconciliation pass's own listMessageIdsByQuery call (e.g. "still
      // under the label") may carry nothing but an id, and must never shadow
      // a fuller extraMessages fixture for the same messageId.
      const all = extraMessages.concat(pages.flatMap((p) => p.messages));
      const m = all.find((x) => x.id === messageId);
      if (!m) throw new Error(`fixture: no metadata for ${messageId}`);
      return {
        messageId,
        threadId: m.threadId || `thread-${messageId}`,
        subject: m.subject,
        fromAddress: m.fromAddress,
        date: m.date || '2026-07-24T00:00:00Z',
        labelIds: m.labelIds || [],
        isSent: !!m.isSent,
      };
    },
    getMessageBody: async ({ messageId }) => {
      calls.getMessageBody = calls.getMessageBody || [];
      calls.getMessageBody.push(messageId);
      if (bodies[messageId] === undefined) throw new Error(`fixture: no body for ${messageId}`);
      return bodies[messageId];
    },
    // EM7
    getMailboxHistoryId: async () => {
      calls.getMailboxHistoryId = (calls.getMailboxHistoryId || 0) + 1;
      return { historyId: mailboxHistoryId };
    },
    listHistory: async ({ startHistoryId, pageToken, labelId, historyTypes }) => {
      calls.listHistory = calls.listHistory || [];
      calls.listHistory.push({ startHistoryId, pageToken, labelId, historyTypes });
      const page = historyPages[historyPageCall] || { changes: [], historyId: mailboxHistoryId, nextPageToken: null };
      historyPageCall++;
      if (page.throws) throw page.throws;
      return { changes: page.changes || [], historyId: page.historyId || mailboxHistoryId, nextPageToken: page.nextPageToken || null };
    },
  };
}

function fixtureEmailPolicyService(rules) {
  return { getPolicy: async () => ({ rules }), evaluateMessageAgainstPolicy };
}

function fixtureAikbService({ documents = [], failIngestFor = new Set(), calls = {} } = {}) {
  calls.uploadAndIngest = [];
  calls.deleteDocumentById = [];
  return {
    listDocuments: async () => ({ documents }),
    uploadAndIngest: async (args) => {
      calls.uploadAndIngest.push(args);
      if (failIngestFor.has(args.sourceFileId)) throw new Error('AIKB ingest failed: simulated');
    },
    deleteDocumentById: async (clientId, documentId) => {
      calls.deleteDocumentById.push({ clientId, documentId });
    },
  };
}

function fixtureEmailSyncRepo({
  previouslyIngested = [], initialSyncState = null,
} = {}) {
  const runs = new Map();
  const events = [];
  const syncStateCalls = [];
  let syncState = initialSyncState;
  let nextId = 1;
  return {
    _runs: runs,
    _events: events,
    _syncStateCalls: syncStateCalls,
    get _syncState() { return syncState; },
    createSyncRun: async ({ clientId, emailConnectionId, runType, triggeredByMemberId }) => {
      const id = `run-${nextId++}`;
      const row = { id, clientId, emailConnectionId, runType, triggeredByMemberId, status: 'running' };
      runs.set(id, row);
      return row;
    },
    completeSyncRun: async (syncRunId, { status, counts, errorSummary }) => {
      const row = runs.get(syncRunId);
      if (row) Object.assign(row, { status, counts, errorSummary });
    },
    recordEvents: async (evts) => { events.push(...evts); },
    updateHistoricalImportStatus: async () => {},
    getSyncState: async () => syncState,
    // EM7 — only overwrites the cursor fields when the caller actually
    // passes them (mirrors the real repo's "undefined = leave unchanged"
    // contract), so a resumed/failed-run call never wipes a valid cursor.
    upsertSyncState: async (emailConnectionId, patch) => {
      syncStateCalls.push(patch);
      syncState = {
        email_connection_id: emailConnectionId,
        cursor_status: (syncState && syncState.cursor_status) || 'none',
        provider_cursor: (syncState && syncState.provider_cursor) || null,
        ...syncState,
        last_sync_started_at: patch.lastSyncStartedAt,
        last_sync_completed_at: patch.lastSyncCompletedAt,
        last_sync_status: patch.lastSyncStatus,
        ...(patch.providerCursor !== undefined ? { provider_cursor: patch.providerCursor } : {}),
        ...(patch.cursorStatus !== undefined ? { cursor_status: patch.cursorStatus } : {}),
        ...(patch.cursorObtainedAt !== undefined ? { cursor_obtained_at: patch.cursorObtainedAt } : {}),
      };
    },
    markCursorExpired: async (emailConnectionId) => {
      syncStateCalls.push({ cursorStatus: 'expired' });
      syncState = { ...(syncState || { email_connection_id: emailConnectionId }), cursor_status: 'expired' };
    },
    getPreviouslyIngestedMessageIds: async () => previouslyIngested,
    listRecentSyncRuns: async (emailConnectionId, limit = 10) => {
      return Array.from(runs.values())
        .filter((r) => r.emailConnectionId === emailConnectionId)
        .slice(0, limit);
    },
  };
}

function makeService({
  pages, rules, labels, gmailCalls, bodies, documents, failIngestFor, aikbCalls, previouslyIngested, maxDocuments,
  historyPages, mailboxHistoryId, initialSyncState, extraMessages,
} = {}) {
  const emailSyncRepo = fixtureEmailSyncRepo({ previouslyIngested, initialSyncState });
  const gmailService = fixtureGmailService({ pages, labels, bodies, calls: gmailCalls || {}, historyPages, mailboxHistoryId, extraMessages });
  const aikbService = fixtureAikbService({ documents, failIngestFor, calls: aikbCalls || {} });
  const service = createEmailSyncService({
    gmailService,
    emailPolicyService: fixtureEmailPolicyService(rules),
    emailNormalizationService: { normalizeEmailBody },
    aikbService,
    emailSyncRepo,
    maxDocuments: maxDocuments || 50,
  });
  return { service, emailSyncRepo, gmailService, aikbService };
}

// ─────────────────────────────────────────────
// assertSyncAllowed — fail-closed connection-level gates
// ─────────────────────────────────────────────

test('assertSyncAllowed throws SEARCH_DISABLED when the member has search_enabled off', () => {
  assert.throws(
    () => assertSyncAllowed({ memberSearchEnabled: false, syncEnabled: true }),
    (err) => err.code === ERROR_CODES.SEARCH_DISABLED
  );
});

test('assertSyncAllowed throws SYNC_DISABLED when the connection itself is disabled', () => {
  assert.throws(
    () => assertSyncAllowed({ memberSearchEnabled: true, syncEnabled: false }),
    (err) => err.code === ERROR_CODES.SYNC_DISABLED
  );
});

test('assertSyncAllowed does not throw for a healthy connection', () => {
  assert.doesNotThrow(() => assertSyncAllowed({ memberSearchEnabled: true, syncEnabled: true }));
});

// ─────────────────────────────────────────────
// syncConnection — connection-level gates surface through the real call too
// ─────────────────────────────────────────────

test('syncConnection rejects before any Gmail call when search_enabled is false', async () => {
  const gmailCalls = {};
  const { service } = makeService({ pages: [], rules: [], gmailCalls });
  await assert.rejects(
    () => service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: false, accessToken: 't' }),
    (err) => err.code === ERROR_CODES.SEARCH_DISABLED
  );
  assert.equal(gmailCalls.listMessageIdsByQuery, undefined);
});

test('syncConnection rejects when the client is already at the document limit, before creating a sync run or any Gmail call', async () => {
  const gmailCalls = {};
  const documents = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, status: 'indexed' }));
  const { service, emailSyncRepo } = makeService({ pages: [], rules: [], gmailCalls, documents, maxDocuments: 5 });
  await assert.rejects(
    () => service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' }),
    (err) => err.code === ERROR_CODES.DOCUMENT_LIMIT_REACHED
  );
  assert.equal(gmailCalls.listMessageIdsByQuery, undefined);
  assert.equal(emailSyncRepo._runs.size, 0);
});

// ─────────────────────────────────────────────
// Policy Evaluation Model — fail-closed (§16.1 item 6) and label gating
// ─────────────────────────────────────────────

test('empty organization policy: zero enabled allow rules ingests zero messages, even a labeled one', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Invoice', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }] }];
  const { service, aikbService: fakeAikb, emailSyncRepo } = makeService({ pages, rules: [] });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'No enabled organization allow rule matches this message.');
  const event = emailSyncRepo._events.find((e) => e.provider_message_id === 'm1');
  assert.equal(event.outcome, 'excluded_no_matching_rule');
});

test('manual mode: a policy-matching but UNLABELED message is excluded (label is necessary, not sufficient)', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Invoice', fromAddress: 'ap@vendor.com', labelIds: ['Label_finance'] }] }];
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE] });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped[0].reason, 'Message does not carry the Relativity/Knowledge label.');
});

test('a member labeling an email outside organization policy still imports nothing (labeling is never an authorization override)', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Random', fromAddress: 'someone@random.com', labelIds: [MANAGED_LABEL_ID] }] }];
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE] });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
});

test('deny always overrides allow, even with the label present', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Payroll run', fromAddress: 'hr@client.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance', 'Label_payroll'] }] }];
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE, DENY_PAYROLL], bodies: {} });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped[0].reason.includes('deny rule'), true);
});

// ─────────────────────────────────────────────
// Successful ingest path
// ─────────────────────────────────────────────

test('an eligible, labeled, policy-matching message is normalized and forwarded to AIKB with the right emailMetadata shape', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Invoice #42', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'], date: '2026-01-05T10:00:00Z' }] }];
  const bodies = { m1: { html: '<p>Please see attached invoice.</p>' } };
  const aikbCalls = {};
  const { service, emailSyncRepo } = makeService({ pages, rules: [ALLOW_FINANCE], bodies, aikbCalls });

  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });

  assert.equal(result.imported.length, 1);
  assert.equal(aikbCalls.uploadAndIngest.length, 1);
  const call = aikbCalls.uploadAndIngest[0];
  assert.equal(call.clientId, 'client-a');
  assert.equal(call.sourceFileId, 'm1');
  assert.equal(call.sourceProvider, 'gmail');
  assert.equal(call.mimeType, 'text/plain');
  assert.match(call.fileBuffer.toString('utf8'), /Please see attached invoice\./);
  assert.equal(call.emailMetadata.provider, 'gmail');
  assert.equal(call.emailMetadata.providerAccountId, 'sam@client.com');
  assert.equal(call.emailMetadata.contributingMemberId, 'member-1');
  assert.equal(call.emailMetadata.providerMessageId, 'm1');
  assert.equal(call.emailMetadata.subject, 'Invoice #42');
  assert.equal(call.emailMetadata.ingestionRuleId, 'rule-1');
  assert.deepEqual(call.emailMetadata.folderOrLabels.sort(), ['Relativity/Knowledge', 'finance'].sort());

  const ingestedEvent = emailSyncRepo._events.find((e) => e.provider_message_id === 'm1');
  assert.equal(ingestedEvent.outcome, 'ingested');
});

test('destination collection: a matched rule\'s destinationCollectionId is forwarded as collectionId', async () => {
  const rule = { ...ALLOW_FINANCE, destinationCollectionId: 'coll-finance' };
  const pages = [{ messages: [{ id: 'm1', subject: 'Invoice', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }] }];
  const aikbCalls = {};
  const { service } = makeService({ pages, rules: [rule], bodies: { m1: { text: 'Invoice body.' } }, aikbCalls });
  await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(aikbCalls.uploadAndIngest[0].collectionId, 'coll-finance');
});

test('two distinct eligible messages both ingest independently — no client-side content-hash collapsing (dedup-narrowing is AIKB\'s responsibility, §20)', async () => {
  const pages = [{
    messages: [
      { id: 'm1', subject: 'Auto-notification', fromAddress: 'noreply@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] },
      { id: 'm2', subject: 'Auto-notification', fromAddress: 'noreply@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] },
    ],
  }];
  const bodies = {
    m1: { text: 'Your invoice is ready.' },
    m2: { text: 'Your invoice is ready.' }, // near-identical body, distinct message
  };
  const aikbCalls = {};
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE], bodies, aikbCalls });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 2);
  assert.equal(aikbCalls.uploadAndIngest.length, 2);
  assert.deepEqual(aikbCalls.uploadAndIngest.map((c) => c.sourceFileId).sort(), ['m1', 'm2']);
});

// ─────────────────────────────────────────────
// Per-message failure isolation (§17 item 5)
// ─────────────────────────────────────────────

test('a message whose body fetch fails is recorded as failed and does not stop the rest of the page', async () => {
  const pages = [{
    messages: [
      { id: 'm1', subject: 'Will fail', fromAddress: 'a@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] },
      { id: 'm2', subject: 'Will succeed', fromAddress: 'b@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] },
    ],
  }];
  const bodies = { m2: { text: 'Body two.' } }; // m1 intentionally missing -> fixture throws
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE], bodies });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].messageId, 'm1');
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].messageId, 'm2');
  assert.equal(result.status, 'partial');
});

test('a message that normalizes to empty text is recorded failed, not ingested', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Blank', fromAddress: 'a@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }] }];
  const { service, aikbService: fakeAikb } = makeService({
    pages, rules: [ALLOW_FINANCE], bodies: { m1: { html: '<img src="x"><script>void(0)</script>' } },
  });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /no extractable text/);
});

test('an AIKB ingest call that throws is recorded as failed, not silently swallowed', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'X', fromAddress: 'a@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }] }];
  const { service } = makeService({
    pages, rules: [ALLOW_FINANCE], bodies: { m1: { text: 'body' } }, failIngestFor: new Set(['m1']),
  });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.status, 'partial');
});

// ─────────────────────────────────────────────
// Pagination / resume (§17 item 3)
// ─────────────────────────────────────────────

test('pagination: a page with more results returns complete:false and a nextPageToken; a second call with that token continues and finishes', async () => {
  const pages = [
    { messages: [{ id: 'm1', subject: 'One', fromAddress: 'a@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }], nextPageToken: 'page-2' },
    { messages: [{ id: 'm2', subject: 'Two', fromAddress: 'a@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }], nextPageToken: null },
  ];
  const bodies = { m1: { text: 'one' }, m2: { text: 'two' } };
  const gmailCalls = {};
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE], bodies, gmailCalls });

  const first = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(first.complete, false);
  assert.equal(first.nextPageToken, 'page-2');
  assert.equal(first.imported.length, 1);
  assert.equal(first.runType, 'historical');

  const second = await service.syncConnection({
    clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't',
    pageToken: first.nextPageToken, runType: first.runType,
  });
  assert.equal(second.complete, true);
  assert.equal(second.nextPageToken, null);
  assert.equal(second.imported.length, 1);
  assert.equal(second.imported[0].messageId, 'm2');

  // Two historical-page calls plus one final reconciliation listing call
  // (§24.2, only run once the second page reports complete) — assert the
  // two paginated calls specifically, in order.
  const pageCalls = gmailCalls.listMessageIdsByQuery.slice(0, 2).map((c) => c.pageToken);
  assert.deepEqual(pageCalls, [null, 'page-2']);
});

test('the document-limit check only runs on the first page (pageToken null), not on a resumed page', async () => {
  const pages = [
    { messages: [], nextPageToken: null },
  ];
  const documents = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, status: 'indexed' }));
  const { service } = makeService({ pages, rules: [], documents, maxDocuments: 5 });
  // Resuming (pageToken set) must not re-trigger the limit check that would
  // have blocked a fresh sync — a run already in progress should be allowed
  // to finish its remaining pages.
  const result = await service.syncConnection({
    clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't', pageToken: 'resume-token', runType: 'historical',
  });
  assert.equal(result.complete, true);
});

test('resuming without a runType is rejected (INVALID_RESUME) rather than silently guessing', async () => {
  const { service } = makeService({ pages: [{ messages: [], nextPageToken: null }], rules: [] });
  await assert.rejects(
    () => service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't', pageToken: 'resume-token' }),
    (err) => err.code === ERROR_CODES.INVALID_RESUME
  );
});

// ─────────────────────────────────────────────
// Cross-member isolation
// ─────────────────────────────────────────────

test('two different connections (different members) never cross — each sync only ever touches its own connection\'s row and contributingMemberId', async () => {
  const pagesA = [{ messages: [{ id: 'a1', subject: 'A', fromAddress: 'a@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }] }];
  const pagesB = [{ messages: [{ id: 'b1', subject: 'B', fromAddress: 'b@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }] }];

  const aikbCallsA = {};
  const { service: serviceA } = makeService({ pages: pagesA, rules: [ALLOW_FINANCE], bodies: { a1: { text: 'a' } }, aikbCalls: aikbCallsA });
  const resultA = await serviceA.syncConnection({
    clientId: 'client-a', emailConnectionRow: fixtureConnection({ id: 'conn-a', member_id: 'member-a', mailbox_address: 'a@client.com' }),
    memberSearchEnabled: true, accessToken: 't',
  });

  const aikbCallsB = {};
  const { service: serviceB } = makeService({ pages: pagesB, rules: [ALLOW_FINANCE], bodies: { b1: { text: 'b' } }, aikbCalls: aikbCallsB });
  const resultB = await serviceB.syncConnection({
    clientId: 'client-a', emailConnectionRow: fixtureConnection({ id: 'conn-b', member_id: 'member-b', mailbox_address: 'b@client.com' }),
    memberSearchEnabled: true, accessToken: 't',
  });

  assert.equal(resultA.imported[0].messageId, 'a1');
  assert.equal(resultB.imported[0].messageId, 'b1');
  assert.equal(aikbCallsA.uploadAndIngest[0].emailMetadata.contributingMemberId, 'member-a');
  assert.equal(aikbCallsB.uploadAndIngest[0].emailMetadata.contributingMemberId, 'member-b');
  assert.equal(aikbCallsA.uploadAndIngest.some((c) => c.sourceFileId === 'b1'), false);
  assert.equal(aikbCallsB.uploadAndIngest.some((c) => c.sourceFileId === 'a1'), false);
});

// ─────────────────────────────────────────────
// Label-removal reconciliation (§24.2) — now runnable end-to-end (EM5 built
// the pure logic; EM6 gives it real email_ingestion_events data)
// ─────────────────────────────────────────────

test('label-removal reconciliation: a previously-ingested message no longer under the label is tombstoned via AIKB delete, once the sync completes', async () => {
  const pages = [{ messages: [], nextPageToken: null }]; // nothing new this sync
  const documents = [{ id: 'doc-old', source_provider: 'gmail', source_file_id: 'old-msg', status: 'indexed' }];
  const gmailCalls = {};
  const { service, aikbService: fakeAikb } = makeService({
    pages, rules: [ALLOW_FINANCE], documents, previouslyIngested: ['old-msg'], gmailCalls,
  });

  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });

  assert.equal(result.complete, true);
  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0].messageId, 'old-msg');
  assert.equal(result.reconciled[0].documentId, 'doc-old');
});

test('label-removal reconciliation: a message still under the label is NOT tombstoned', async () => {
  const pages = [{ messages: [], nextPageToken: null }];
  const documents = [{ id: 'doc-keep', source_provider: 'gmail', source_file_id: 'still-labeled', status: 'indexed' }];
  // The reconciliation listing call returns the same message as "currently labeled".
  const gmailService = {
    compileSearchQuery,
    listMessageIdsByQuery: async () => ({ messageIds: ['still-labeled'], nextPageToken: null }),
    listLabels: async () => LABELS,
    getMessageMetadata: async () => { throw new Error('not used in this test'); },
    getMessageBody: async () => { throw new Error('not used in this test'); },
    getMailboxHistoryId: async () => ({ historyId: DEFAULT_FIXTURE_HISTORY_ID }),
    listHistory: async () => { throw new Error('not used in this test'); },
  };
  const emailSyncRepo = fixtureEmailSyncRepo({ previouslyIngested: ['still-labeled'] });
  const aikbService = fixtureAikbService({ documents });
  const service = createEmailSyncService({
    gmailService,
    emailPolicyService: fixtureEmailPolicyService([ALLOW_FINANCE]),
    emailNormalizationService: { normalizeEmailBody },
    aikbService,
    emailSyncRepo,
    maxDocuments: 50,
  });

  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.reconciled.length, 0);
});

test('reconciliation does not run on an incomplete (paginated) sync — only once the run is complete', async () => {
  const pages = [{ messages: [], nextPageToken: 'more' }];
  const documents = [{ id: 'doc-old', source_provider: 'gmail', source_file_id: 'old-msg', status: 'indexed' }];
  const { service } = makeService({ pages, rules: [ALLOW_FINANCE], documents, previouslyIngested: ['old-msg'] });
  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.complete, false);
  assert.equal(result.reconciled.length, 0);
});

// ─────────────────────────────────────────────
// EM9 — policy-change reconciliation (§24.5, §28.1's "Label reconciliation
// after policy changes" case): a previously-ingested message, still
// labeled, whose organization then edits policy so it no longer matches.
// ─────────────────────────────────────────────

test('policy-change reconciliation: a previously-ingested message that now matches a deny rule is tombstoned as tombstoned_policy_change, label still present', async () => {
  // Two pages: the first is the main historical scan (nothing new); the
  // second is reconcileRemovedLabelsFullList's own "what's currently under
  // the label" query — 'old-msg' is reported there too, so the label-removal
  // pass correctly sees it as still labeled and does NOT also tombstone it,
  // isolating this test to the policy-reconciliation path alone.
  const pages = [
    { messages: [], nextPageToken: null },
    { messages: [{ id: 'old-msg' }], nextPageToken: null },
  ];
  const documents = [{ id: 'doc-old', source_provider: 'gmail', source_file_id: 'old-msg', status: 'indexed' }];
  const extraMessages = [{
    id: 'old-msg', subject: 'Payroll run', fromAddress: 'hr@client.com',
    labelIds: [MANAGED_LABEL_ID, 'Label_payroll'],
  }];
  const { service, emailSyncRepo } = makeService({
    pages, rules: [ALLOW_FINANCE, DENY_PAYROLL], documents, previouslyIngested: ['old-msg'], extraMessages,
  });

  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });

  assert.equal(result.complete, true);
  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0].messageId, 'old-msg');
  assert.equal(result.reconciled[0].documentId, 'doc-old');
  const event = emailSyncRepo._events.find((e) => e.provider_message_id === 'old-msg');
  assert.equal(event.outcome, 'tombstoned_policy_change');
  assert.equal(event.ingested_document_id, 'doc-old');
});

test('policy-change reconciliation: a previously-ingested message that no longer matches any allow rule is tombstoned', async () => {
  const pages = [
    { messages: [], nextPageToken: null },
    { messages: [{ id: 'old-msg' }], nextPageToken: null }, // still under the label — see the deny-rule test above for why this second page matters
  ];
  const documents = [{ id: 'doc-old', source_provider: 'gmail', source_file_id: 'old-msg', status: 'indexed' }];
  const extraMessages = [{
    id: 'old-msg', subject: 'Random newsletter', fromAddress: 'news@vendor.com',
    labelIds: [MANAGED_LABEL_ID], // still labeled — the allow rule for 'finance' was removed, not the label
  }];
  // Rule set no longer includes ALLOW_FINANCE at all (simulates a PUT
  // /policy replace that dropped it) — 'old-msg' never matched anything
  // else, so it now falls through to excluded_no_matching_rule.
  const { service, emailSyncRepo } = makeService({
    pages, rules: [], documents, previouslyIngested: ['old-msg'], extraMessages,
  });

  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });

  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0].messageId, 'old-msg');
  const event = emailSyncRepo._events.find((e) => e.provider_message_id === 'old-msg');
  assert.equal(event.outcome, 'tombstoned_policy_change');
});

test('policy-change reconciliation: a previously-ingested message that STILL matches policy is left alone', async () => {
  const pages = [
    { messages: [], nextPageToken: null },
    { messages: [{ id: 'keep-msg' }], nextPageToken: null }, // still under the label
  ];
  const documents = [{ id: 'doc-keep', source_provider: 'gmail', source_file_id: 'keep-msg', status: 'indexed' }];
  const extraMessages = [{
    id: 'keep-msg', subject: 'Finance update', fromAddress: 'finance@client.com',
    labelIds: [MANAGED_LABEL_ID, 'Label_finance'],
  }];
  const { service } = makeService({
    pages, rules: [ALLOW_FINANCE], documents, previouslyIngested: ['keep-msg'], extraMessages,
  });

  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.reconciled.length, 0);
});

test('policy-change reconciliation: a re-fetch failure for one candidate is skipped, not thrown — the sync still completes', async () => {
  const documents = [{ id: 'doc-old', source_provider: 'gmail', source_file_id: 'gone-msg', status: 'indexed' }];
  // Custom gmailService (not fixtureGmailService) for precise control: the
  // label-removal pass's "what's currently under the label" query reports
  // 'gone-msg' as still present (so THAT pass doesn't also tombstone it —
  // isolating this test to the policy path), while getMessageMetadata
  // — the call reconcilePolicyChanges actually needs to exercise — always
  // throws, simulating a real re-fetch failure reconcilePolicyChanges must
  // swallow per-message rather than letting it fail the whole sync.
  let listCall = 0;
  const gmailService = {
    compileSearchQuery,
    // First call is the main historical scan (nothing new); the second is
    // reconcileRemovedLabelsFullList's own "currently under the label" query.
    listMessageIdsByQuery: async () => {
      listCall++;
      return listCall === 1 ? { messageIds: [], nextPageToken: null } : { messageIds: ['gone-msg'], nextPageToken: null };
    },
    listLabels: async () => LABELS,
    getMessageMetadata: async () => { throw new Error('simulated Gmail fetch failure'); },
    getMessageBody: async () => { throw new Error('not used in this test'); },
    getMailboxHistoryId: async () => ({ historyId: DEFAULT_FIXTURE_HISTORY_ID }),
    listHistory: async () => { throw new Error('not used in this test'); },
  };
  const emailSyncRepo = fixtureEmailSyncRepo({ previouslyIngested: ['gone-msg'] });
  const aikbService = fixtureAikbService({ documents });
  const service = createEmailSyncService({
    gmailService,
    emailPolicyService: fixtureEmailPolicyService([ALLOW_FINANCE]),
    emailNormalizationService: { normalizeEmailBody },
    aikbService,
    emailSyncRepo,
    maxDocuments: 50,
  });

  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.status, 'completed');
  assert.equal(result.reconciled.length, 0);
});

// ─────────────────────────────────────────────
// Run-level failure
// ─────────────────────────────────────────────

test('a page-level failure (the list call itself throws) marks the run failed with an error summary, not a thrown exception', async () => {
  const gmailService = {
    compileSearchQuery,
    listMessageIdsByQuery: async () => { throw new Error('Gmail quota exceeded'); },
    listLabels: async () => LABELS,
    getMessageMetadata: async () => { throw new Error('not reached'); },
    getMessageBody: async () => { throw new Error('not reached'); },
    getMailboxHistoryId: async () => { throw new Error('not reached'); },
    listHistory: async () => { throw new Error('not used in this test'); },
  };
  const emailSyncRepo = fixtureEmailSyncRepo();
  const aikbService = fixtureAikbService({});
  const service = createEmailSyncService({
    gmailService,
    emailPolicyService: fixtureEmailPolicyService([ALLOW_FINANCE]),
    emailNormalizationService: { normalizeEmailBody },
    aikbService,
    emailSyncRepo,
    maxDocuments: 50,
  });

  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.status, 'failed');
  assert.match(result.errorSummary || emailSyncRepo._runs.get(result.syncRunId).errorSummary, /Gmail quota exceeded/);
});

// ─────────────────────────────────────────────
// Historical-page size bound
// ─────────────────────────────────────────────

test('HISTORICAL_PAGE_SIZE is a small, bounded page (Vercel-timeout constraint, §17 item 3)', () => {
  assert.ok(HISTORICAL_PAGE_SIZE > 0 && HISTORICAL_PAGE_SIZE <= 50);
});

// ─────────────────────────────────────────────
// EM7 — cursor lifecycle: a completed historical sync establishes a fresh cursor
// ─────────────────────────────────────────────

test('a fresh sync with no stored cursor runs historical, and on completion establishes a valid cursor via getMailboxHistoryId', async () => {
  const pages = [{ messages: [], nextPageToken: null }];
  const { service, emailSyncRepo } = makeService({ pages, rules: [], mailboxHistoryId: 'hist-fresh-1' });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.runType, 'historical');
  assert.equal(result.complete, true);
  assert.equal(emailSyncRepo._syncState.cursor_status, 'valid');
  assert.equal(emailSyncRepo._syncState.provider_cursor, 'hist-fresh-1');
});

test('the cursor is NOT established while a historical sync is still incomplete (more pages remain)', async () => {
  const pages = [{ messages: [], nextPageToken: 'more' }];
  const { service, emailSyncRepo } = makeService({ pages, rules: [] });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.complete, false);
  assert.notEqual(emailSyncRepo._syncState && emailSyncRepo._syncState.cursor_status, 'valid');
});

test('a failed sync run does not establish or overwrite the cursor', async () => {
  const gmailService = {
    compileSearchQuery,
    listMessageIdsByQuery: async () => { throw new Error('boom'); },
    listLabels: async () => LABELS,
    getMessageMetadata: async () => { throw new Error('not reached'); },
    getMessageBody: async () => { throw new Error('not reached'); },
    getMailboxHistoryId: async () => { throw new Error('must not be called on a failed run'); },
    listHistory: async () => { throw new Error('not used in this test'); },
  };
  const emailSyncRepo = fixtureEmailSyncRepo({ initialSyncState: { cursor_status: 'valid', provider_cursor: 'keep-me' } });
  const aikbService = fixtureAikbService({});
  const service = createEmailSyncService({
    gmailService, emailPolicyService: fixtureEmailPolicyService([]), emailNormalizationService: { normalizeEmailBody },
    aikbService, emailSyncRepo, maxDocuments: 50,
  });
  // No managed_label_id -> hasValidCursor is false even though a cursor is
  // stored, so this goes down the historical path (and its listMessageIdsByQuery
  // throw) rather than the incremental probe.
  const result = await service.syncConnection({
    clientId: 'c1', emailConnectionRow: fixtureConnection({ managed_label_id: null }), memberSearchEnabled: true, accessToken: 't',
  });
  assert.equal(result.status, 'failed');
  assert.equal(emailSyncRepo._syncState.provider_cursor, 'keep-me');
});

// ─────────────────────────────────────────────
// EM7 — incremental sync: a valid stored cursor is used instead of a full re-scan
// ─────────────────────────────────────────────

test('a fresh sync with a valid stored cursor runs incremental — listHistory scoped to the managed label, not a full listMessageIdsByQuery scan', async () => {
  const gmailCalls = {};
  const { service, emailSyncRepo } = makeService({
    pages: [], rules: [], gmailCalls,
    initialSyncState: { cursor_status: 'valid', provider_cursor: '100' },
    historyPages: [{ changes: [], historyId: '150', nextPageToken: null }],
  });
  const result = await service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.runType, 'incremental');
  assert.equal(gmailCalls.listMessageIdsByQuery, undefined, 'incremental sync must never fall back to a full label scan');
  assert.equal(gmailCalls.listHistory[0].startHistoryId, '100');
  assert.equal(emailSyncRepo._syncState.provider_cursor, '150');
  assert.equal(emailSyncRepo._syncState.cursor_status, 'valid');
});

test('incremental sync: a labelAdded change is run through the full eligibility/ingest pipeline exactly like historical', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'New invoice', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }] }];
  const aikbCalls = {};
  const { service } = makeService({
    pages, rules: [ALLOW_FINANCE], bodies: { m1: { text: 'Invoice body.' } }, aikbCalls,
    initialSyncState: { cursor_status: 'valid', provider_cursor: '100' },
    historyPages: [{ changes: [{ type: 'labelAdded', messageId: 'm1' }], historyId: '150', nextPageToken: null }],
  });
  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].messageId, 'm1');
  assert.equal(aikbCalls.uploadAndIngest[0].emailMetadata.providerMessageId, 'm1');
});

test('incremental sync: a labelAdded change that fails policy is recorded skipped, exactly like historical', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Random', fromAddress: 'someone@random.com', labelIds: [MANAGED_LABEL_ID] }] }];
  const { service } = makeService({
    pages, rules: [ALLOW_FINANCE],
    initialSyncState: { cursor_status: 'valid', provider_cursor: '100' },
    historyPages: [{ changes: [{ type: 'labelAdded', messageId: 'm1' }], historyId: '150', nextPageToken: null }],
  });
  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
  assert.equal(result.skipped.length, 1);
});

test('incremental sync: a labelRemoved change tombstones the previously-ingested document directly from the diff, with no full re-list', async () => {
  const documents = [{ id: 'doc-old', source_provider: 'gmail', source_file_id: 'old-msg', status: 'indexed' }];
  const gmailCalls = {};
  const { service, emailSyncRepo } = makeService({
    pages: [], rules: [ALLOW_FINANCE], documents, gmailCalls,
    initialSyncState: { cursor_status: 'valid', provider_cursor: '100' },
    historyPages: [{ changes: [{ type: 'labelRemoved', messageId: 'old-msg', labelIds: [MANAGED_LABEL_ID] }], historyId: '150', nextPageToken: null }],
  });
  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0].messageId, 'old-msg');
  const event = emailSyncRepo._events.find((e) => e.provider_message_id === 'old-msg');
  assert.equal(event.outcome, 'tombstoned_label_removed');
  assert.match(event.reason, /label removed/);
});

// EM10.5 Scenario 3 regression: removing the managed label from ONE message
// tombstoned three previously-ingested messages in production. Root cause —
// Gmail's labelId-scoped history.list still surfaced `labelsRemoved` events
// for an UNREAD-label change (caused by opening the other two messages in
// Gmail) alongside the one real managed-label removal; the code treated
// every labelRemoved event identically regardless of which label it named.
test('incremental sync: a labelRemoved event naming a DIFFERENT label (e.g. UNREAD, removed by opening the message) is not treated as the managed label being removed', async () => {
  const documents = [
    { id: 'doc-weekly', source_provider: 'gmail', source_file_id: 'weekly-msg', status: 'indexed' },
    { id: 'doc-refund', source_provider: 'gmail', source_file_id: 'refund-msg', status: 'indexed' },
    { id: 'doc-phoenix', source_provider: 'gmail', source_file_id: 'phoenix-msg', status: 'indexed' },
  ];
  const { service, emailSyncRepo } = makeService({
    pages: [], rules: [],
    documents,
    initialSyncState: { cursor_status: 'valid', provider_cursor: '100' },
    historyPages: [{
      changes: [
        { type: 'labelRemoved', messageId: 'weekly-msg', labelIds: [MANAGED_LABEL_ID] }, // the real, intended removal
        { type: 'labelRemoved', messageId: 'refund-msg', labelIds: ['UNREAD'] }, // opened in Gmail — unrelated
        { type: 'labelRemoved', messageId: 'phoenix-msg', labelIds: ['UNREAD'] }, // opened in Gmail — unrelated
      ],
      historyId: '150', nextPageToken: null,
    }],
  });
  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });

  assert.equal(result.reconciled.length, 1, 'only the message whose managed label was actually removed should be tombstoned');
  assert.equal(result.reconciled[0].messageId, 'weekly-msg');
  const tombstoneEvents = emailSyncRepo._events.filter((e) => e.outcome === 'tombstoned_label_removed');
  assert.equal(tombstoneEvents.length, 1);
  assert.equal(tombstoneEvents[0].provider_message_id, 'weekly-msg');
});

test('incremental sync: a labelRemoved event with no labelIds at all is treated as unrelated noise, not a managed-label removal (fail-safe default)', async () => {
  const documents = [{ id: 'doc-old', source_provider: 'gmail', source_file_id: 'old-msg', status: 'indexed' }];
  const { service } = makeService({
    pages: [], rules: [], documents,
    initialSyncState: { cursor_status: 'valid', provider_cursor: '100' },
    historyPages: [{ changes: [{ type: 'labelRemoved', messageId: 'old-msg', labelIds: [] }], historyId: '150', nextPageToken: null }],
  });
  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.reconciled.length, 0);
});

// EM10.5 Scenario 3, second confirmed bug: a message tombstoned by the
// incremental page's own labelRemoved diff was not excluded from the same
// run's policy-change reconciliation pass, so it could be re-evaluated and
// tombstoned a SECOND time (confirmed in production: two ingestion events
// for the same message, 1.65s apart — tombstoned_label_removed then
// tombstoned_policy_change).
test('incremental sync: a message tombstoned by the label-removed diff is excluded from the same-run policy-change reconciliation pass — no redundant double-tombstone', async () => {
  const documents = [{ id: 'doc-1', source_provider: 'gmail', source_file_id: 'msg-1', status: 'indexed' }];
  // Still resolvable via getMessageMetadata for reconcilePolicyChanges's own
  // re-fetch, with no managed label and an empty ruleset (rules: []) — if
  // NOT excluded, this candidate would fail policy and get tombstoned again.
  const extraMessages = [{ id: 'msg-1', subject: 'Weekly Sales Meeting Agenda', fromAddress: 'a@x.com', labelIds: [] }];
  const aikbCalls = {};
  const { service, emailSyncRepo } = makeService({
    pages: [], rules: [], documents, previouslyIngested: ['msg-1'], extraMessages, aikbCalls,
    initialSyncState: { cursor_status: 'valid', provider_cursor: '100' },
    historyPages: [{ changes: [{ type: 'labelRemoved', messageId: 'msg-1', labelIds: [MANAGED_LABEL_ID] }], historyId: '150', nextPageToken: null }],
  });

  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });

  assert.equal(result.reconciled.length, 1, 'must be tombstoned exactly once, not once per reconciliation pass');
  assert.equal(aikbCalls.deleteDocumentById.length, 1);
  const events = emailSyncRepo._events.filter((e) => e.provider_message_id === 'msg-1');
  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'tombstoned_label_removed');
});

test('incremental sync: a messageDeleted change also tombstones, with a distinct reason from a label removal', async () => {
  const documents = [{ id: 'doc-old', source_provider: 'gmail', source_file_id: 'deleted-msg', status: 'indexed' }];
  const { service, emailSyncRepo } = makeService({
    pages: [], rules: [ALLOW_FINANCE], documents,
    initialSyncState: { cursor_status: 'valid', provider_cursor: '100' },
    historyPages: [{ changes: [{ type: 'messageDeleted', messageId: 'deleted-msg' }], historyId: '150', nextPageToken: null }],
  });
  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.reconciled.length, 1);
  const event = emailSyncRepo._events.find((e) => e.provider_message_id === 'deleted-msg');
  assert.match(event.reason, /deleted at the provider/);
});

test('incremental sync: a message labeled then unlabeled within the SAME page nets to removed, not ingested (last-write-wins)', async () => {
  const documents = [{ id: 'doc-1', source_provider: 'gmail', source_file_id: 'm1', status: 'indexed' }];
  const aikbCalls = {};
  const { service } = makeService({
    pages: [{ messages: [{ id: 'm1', subject: 'X', fromAddress: 'a@x.com', labelIds: [] }] }], rules: [ALLOW_FINANCE], documents, aikbCalls,
    initialSyncState: { cursor_status: 'valid', provider_cursor: '100' },
    historyPages: [{
      changes: [{ type: 'labelAdded', messageId: 'm1' }, { type: 'labelRemoved', messageId: 'm1', labelIds: [MANAGED_LABEL_ID] }],
      historyId: '150', nextPageToken: null,
    }],
  });
  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.imported.length, 0);
  assert.equal(aikbCalls.uploadAndIngest.length, 0, 'must never ingest a message whose final action in the same page was a removal');
  assert.equal(result.reconciled.length, 1);
  assert.equal(result.reconciled[0].messageId, 'm1');
});

// ─────────────────────────────────────────────
// EM7 — cursor expiry fallback (§18.4)
// ─────────────────────────────────────────────

function gmailHistoryExpiredError() {
  return Object.assign(new Error('Gmail history cursor is expired or invalid'), { code: GMAIL_ERROR_CODES.HISTORY_EXPIRED });
}

test('cursor expiry: a stale cursor falls back to a bounded historical re-scan within the SAME call, not an error', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'Old mail', fromAddress: 'a@x.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }], nextPageToken: null }];
  const { service, emailSyncRepo, gmailService } = makeService({
    pages, rules: [ALLOW_FINANCE], bodies: { m1: { text: 'body' } },
    initialSyncState: { cursor_status: 'valid', provider_cursor: 'stale-100' },
    historyPages: [{ throws: gmailHistoryExpiredError() }],
    mailboxHistoryId: 'hist-after-fallback',
  });
  const result = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(result.runType, 'historical');
  assert.equal(result.imported.length, 1);
  // A fresh, valid cursor is established once the fallback completes.
  assert.equal(emailSyncRepo._syncState.cursor_status, 'valid');
  assert.equal(emailSyncRepo._syncState.provider_cursor, 'hist-after-fallback');
});

test('cursor expiry: markCursorExpired is called before falling back, so a crash mid-fallback still leaves the cursor correctly marked stale', async () => {
  const { service, emailSyncRepo } = makeService({
    pages: [{ messages: [], nextPageToken: null }], rules: [],
    initialSyncState: { cursor_status: 'valid', provider_cursor: 'stale-100' },
    historyPages: [{ throws: gmailHistoryExpiredError() }],
  });
  await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  const expiredCall = emailSyncRepo._syncStateCalls.find((c) => c.cursorStatus === 'expired');
  assert.ok(expiredCall, 'markCursorExpired must have been called');
});

test('a genuine (non-expiry) failure probing history.list propagates as a real error, never silently falls back', async () => {
  const httpError = Object.assign(new Error('Gmail 500'), { code: GMAIL_ERROR_CODES.HTTP_ERROR });
  const { service } = makeService({
    pages: [], rules: [],
    initialSyncState: { cursor_status: 'valid', provider_cursor: '100' },
    historyPages: [{ throws: httpError }],
  });
  await assert.rejects(
    () => service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' }),
    (err) => err.message === 'Gmail 500'
  );
});

// ─────────────────────────────────────────────
// EM7 — pagination across incremental pages
// ─────────────────────────────────────────────

test('incremental pagination: a second page reuses the SAME startHistoryId (the run-scoped, not-yet-finalized cursor) plus the returned pageToken', async () => {
  const pages = [{ messages: [{ id: 'm1', subject: 'A', fromAddress: 'a@x.com', labelIds: [] }, { id: 'm2', subject: 'B', fromAddress: 'a@x.com', labelIds: [] }] }];
  const gmailCalls = {};
  const { service, emailSyncRepo } = makeService({
    pages, rules: [], gmailCalls,
    initialSyncState: { cursor_status: 'valid', provider_cursor: '100' },
    historyPages: [
      { changes: [{ type: 'labelRemoved', messageId: 'm1', labelIds: [MANAGED_LABEL_ID] }], historyId: '120', nextPageToken: 'hist-page-2' },
      { changes: [{ type: 'labelRemoved', messageId: 'm2', labelIds: [MANAGED_LABEL_ID] }], historyId: '150', nextPageToken: null },
    ],
  });

  const first = await service.syncConnection({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't' });
  assert.equal(first.complete, false);
  assert.equal(first.runType, 'incremental');
  assert.notEqual(emailSyncRepo._syncState.provider_cursor, '120', 'the cursor must not move until the whole run completes');

  const second = await service.syncConnection({
    clientId: 'client-a', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't',
    pageToken: first.nextPageToken, runType: first.runType,
  });
  assert.equal(second.complete, true);
  assert.equal(gmailCalls.listHistory[1].startHistoryId, '100', 'the SAME startHistoryId is reused across every page of one run');
  assert.equal(gmailCalls.listHistory[1].pageToken, 'hist-page-2');
  assert.equal(emailSyncRepo._syncState.provider_cursor, '150');
});

test('resuming an incremental sync with no stored cursor is rejected (INVALID_RESUME) rather than calling Gmail with an undefined startHistoryId', async () => {
  const { service } = makeService({ pages: [], rules: [] }); // no initialSyncState
  await assert.rejects(
    () => service.syncConnection({ clientId: 'c1', emailConnectionRow: fixtureConnection(), memberSearchEnabled: true, accessToken: 't', pageToken: 'p1', runType: 'incremental' }),
    (err) => err.code === ERROR_CODES.INVALID_RESUME
  );
});

// ─────────────────────────────────────────────
// EM7 — sync-run history (§27, §31 EM7 Frontend)
// ─────────────────────────────────────────────

test('listSyncRuns returns the connection\'s recent sync runs, newest first, as recorded by the repo', async () => {
  const emailSyncRepo = fixtureEmailSyncRepo();
  const gmailService = fixtureGmailService({ pages: [{ messages: [], nextPageToken: null }] });
  const service = createEmailSyncService({
    gmailService, emailPolicyService: fixtureEmailPolicyService([]), emailNormalizationService: { normalizeEmailBody },
    aikbService: fixtureAikbService({}), emailSyncRepo, maxDocuments: 50,
  });
  const conn = fixtureConnection();
  await service.syncConnection({ clientId: 'client-a', emailConnectionRow: conn, memberSearchEnabled: true, accessToken: 't' });
  const runs = await service.listSyncRuns(conn.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].emailConnectionId, conn.id);
});


// EM10.6 removed Automatic Email Ingestion entirely — the automatic mode's
// incremental path (messageAdded scoping, no label-removal reconciliation,
// next_sync_due_at bookkeeping) and runTick (the POST /sync/tick
// orchestration) no longer exist. See EMAIL_INGESTION.md's EM10.6 record.
