const test = require('node:test');
const assert = require('node:assert/strict');
const { createEmailPreviewService, computeLabelReconciliation, PREVIEW_PAGE_SIZE } = require('../services/emailPreviewService');
const { compileSearchQuery } = require('../services/gmailService');
const { evaluateMessageAgainstPolicy } = require('../services/emailPolicyService');

/**
 * §28.1's full "Gmail Label / Multi-Member Workflow" test category, covered
 * here at the buildPreview integration level rather than only at
 * evaluateMessageAgainstPolicy's pure-function level (EM3 already covers
 * that layer in emailPolicyService.test.js) — these tests exercise the real
 * compileSearchQuery + evaluateMessageAgainstPolicy functions (both pure,
 * imported directly, not re-faked) against a fixture "mailbox," with only
 * the network-shaped gmailService calls (listMessageIdsByQuery/listLabels/
 * getMessageMetadata) faked. The fixture's listMessageIdsByQuery ignores the
 * real query string and returns exactly the candidate set each test wants —
 * this is deliberate: §17 item 4 documents that the LOCAL re-check (deny-
 * list always, label-presence in manual mode) is defense-in-depth on top of
 * the provider query, not a replacement for it, so these tests prove the
 * local check alone correctly excludes an unlabeled/out-of-policy message
 * even if it somehow reached the candidate list.
 */

const MANAGED_LABEL_ID = 'Label_managed_1';
const LABELS = [
  { id: MANAGED_LABEL_ID, name: 'Relativity/Knowledge' },
  { id: 'Label_finance', name: 'finance' },
  { id: 'Label_payroll', name: 'finance/payroll' },
  { id: 'INBOX', name: 'INBOX' },
];

function fixtureConnection(overrides = {}) {
  return { sync_mode: 'manual_selected', managed_label_id: MANAGED_LABEL_ID, ...overrides };
}

function fixtureGmailService({ messages, labels = LABELS, listCalls = [] } = {}) {
  const byId = new Map((messages || []).map((m) => [m.id, m]));
  return {
    compileSearchQuery,
    listMessageIdsByQuery: async ({ query, pageToken }) => {
      listCalls.push({ query, pageToken });
      return { messageIds: (messages || []).map((m) => m.id), nextPageToken: null };
    },
    listLabels: async () => labels,
    getMessageMetadata: async ({ messageId }) => {
      const m = byId.get(messageId);
      return {
        messageId,
        subject: m.subject,
        fromAddress: m.fromAddress,
        date: m.date || '2026-07-24T00:00:00Z',
        labelIds: m.labelIds || [],
        isSent: !!m.isSent,
      };
    },
  };
}

function fixtureEmailPolicyService(rules) {
  return {
    getPolicy: async () => ({ rules }),
    evaluateMessageAgainstPolicy,
  };
}

function makeService({ messages, rules, labels, listCalls }) {
  return createEmailPreviewService({
    gmailService: fixtureGmailService({ messages, labels, listCalls }),
    emailPolicyService: fixtureEmailPolicyService(rules),
  });
}

const ALLOW_FINANCE = { id: 'rule-1', ruleType: 'allow', labelOrFolder: 'finance', enabled: true };
const DENY_PAYROLL = { id: 'rule-2', ruleType: 'deny', labelOrFolder: 'finance/payroll', enabled: true };

// ─────────────────────────────────────────────
// Member labels one/multiple emails (manual mode)
// ─────────────────────────────────────────────

test('member labels one email: the single labeled, policy-matching message is matched; nothing else is', async () => {
  const messages = [
    { id: 'm1', subject: 'Invoice', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] },
  ];
  const service = makeService({ messages, rules: [ALLOW_FINANCE] });
  const result = await service.buildPreview({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), accessToken: 'token' });
  assert.equal(result.matchedCount, 1);
  assert.equal(result.scannedCount, 1);
  assert.deepEqual(result.sample, [{ subject: 'Invoice', from: 'ap@vendor.com', date: '2026-07-24T00:00:00Z' }]);
});

test('member labels multiple emails: all labeled+matching messages counted, in one preview call', async () => {
  const messages = [
    { id: 'm1', subject: 'Invoice 1', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] },
    { id: 'm2', subject: 'Invoice 2', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] },
    { id: 'm3', subject: 'Invoice 3', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] },
  ];
  const service = makeService({ messages, rules: [ALLOW_FINANCE] });
  const result = await service.buildPreview({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), accessToken: 'token' });
  assert.equal(result.matchedCount, 3);
  assert.equal(result.scannedCount, 3);
  assert.equal(result.sample.length, 3);
});

// ─────────────────────────────────────────────
// Bulk label application / pagination (§17 item 7)
// ─────────────────────────────────────────────

test('bulk label application: a paginated candidate list is correctly walked across two preview calls via nextPageToken, no double-processing', async () => {
  const pageOneMessages = [{ id: 'm1', subject: 'A', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }];
  const gmailServicePageOne = {
    compileSearchQuery,
    listMessageIdsByQuery: async ({ pageToken }) => {
      assert.equal(pageToken, null);
      return { messageIds: ['m1'], nextPageToken: 'page-2-token' };
    },
    listLabels: async () => LABELS,
    getMessageMetadata: async () => ({ messageId: 'm1', subject: 'A', fromAddress: 'ap@vendor.com', date: 'd', labelIds: [MANAGED_LABEL_ID, 'Label_finance'], isSent: false }),
  };
  const service1 = createEmailPreviewService({ gmailService: gmailServicePageOne, emailPolicyService: fixtureEmailPolicyService([ALLOW_FINANCE]) });
  const page1 = await service1.buildPreview({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), accessToken: 'token' });
  assert.equal(page1.complete, false);
  assert.equal(page1.nextPageToken, 'page-2-token');
  assert.equal(page1.matchedCount, 1);

  const gmailServicePageTwo = {
    compileSearchQuery,
    listMessageIdsByQuery: async ({ pageToken }) => {
      assert.equal(pageToken, 'page-2-token');
      return { messageIds: ['m2'], nextPageToken: null };
    },
    listLabels: async () => LABELS,
    getMessageMetadata: async () => ({ messageId: 'm2', subject: 'B', fromAddress: 'ap@vendor.com', date: 'd', labelIds: [MANAGED_LABEL_ID, 'Label_finance'], isSent: false }),
  };
  const service2 = createEmailPreviewService({ gmailService: gmailServicePageTwo, emailPolicyService: fixtureEmailPolicyService([ALLOW_FINANCE]) });
  const page2 = await service2.buildPreview({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), accessToken: 'token', pageToken: page1.nextPageToken });
  assert.equal(page2.complete, true);
  assert.equal(page2.nextPageToken, null);
  assert.equal(page2.matchedCount, 1);
  // Together, both pages account for exactly the two distinct messages — no overlap.
  assert.notEqual(page1.sample[0].subject, page2.sample[0].subject);
});

// ─────────────────────────────────────────────
// Unlabeled emails never ingest in Manual mode (defense-in-depth, §17 item 4)
// ─────────────────────────────────────────────

test('unlabeled-but-policy-matching messages are excluded in manual mode even if they appear in the candidate list', async () => {
  const messages = [
    { id: 'm1', subject: 'Not labeled', fromAddress: 'ap@vendor.com', labelIds: ['Label_finance'] }, // policy-matching, NOT labeled
    { id: 'm2', subject: 'Labeled', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] },
  ];
  const service = makeService({ messages, rules: [ALLOW_FINANCE] });
  const result = await service.buildPreview({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), accessToken: 'token' });
  assert.equal(result.matchedCount, 1);
  assert.equal(result.scannedCount, 2);
  assert.deepEqual(result.sample.map((s) => s.subject), ['Labeled']);
});

// EM10.6 removed Automatic Email Ingestion — the mode that ignored label
// presence/absence entirely (organization policy alone decided) no longer
// exists; every message is now always label-gated (§16.1 item 3, prior
// text). See EMAIL_INGESTION.md's EM10.6 record.

// ─────────────────────────────────────────────
// Organization deny rules rejecting labeled emails (§16.1 item 5)
// ─────────────────────────────────────────────

test('a deny rule excludes a message even when it carries the label and matches an allow rule (deny always wins)', async () => {
  const messages = [
    { id: 'm1', subject: 'Payroll run', fromAddress: 'hr@client.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance', 'Label_payroll'] },
  ];
  const service = makeService({ messages, rules: [ALLOW_FINANCE, DENY_PAYROLL] });
  const result = await service.buildPreview({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), accessToken: 'token' });
  assert.equal(result.matchedCount, 0);
});

// ─────────────────────────────────────────────
// Organization allow rules permitting labeled emails (baseline positive path)
// ─────────────────────────────────────────────

test('a labeled message matching an allow rule with no deny match is counted as matched', async () => {
  const messages = [{ id: 'm1', subject: 'Invoice', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }];
  const service = makeService({ messages, rules: [ALLOW_FINANCE, DENY_PAYROLL] });
  const result = await service.buildPreview({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), accessToken: 'token' });
  assert.equal(result.matchedCount, 1);
});

// ─────────────────────────────────────────────
// Member labeling emails outside organization policy (§16.1 item 4)
// ─────────────────────────────────────────────

test('a labeled message matching zero allow rules is excluded — the label alone is never sufficient', async () => {
  const messages = [{ id: 'm1', subject: 'Personal', fromAddress: 'friend@example.com', labelIds: [MANAGED_LABEL_ID] }];
  const service = makeService({ messages, rules: [ALLOW_FINANCE] });
  const result = await service.buildPreview({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), accessToken: 'token' });
  assert.equal(result.matchedCount, 0);
});

// ─────────────────────────────────────────────
// Empty organization policy fails closed (§16.1 item 6)
// ─────────────────────────────────────────────

test('empty policy still lists candidates (label alone drives the query) but locally excludes everything — zero matches', async () => {
  const messages = [{ id: 'm1', subject: 'Anything', fromAddress: 'a@b.com', labelIds: [MANAGED_LABEL_ID] }];
  const service = makeService({ messages, rules: [] });
  const result = await service.buildPreview({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), accessToken: 'token' });
  assert.equal(result.matchedCount, 0);
  assert.equal(result.scannedCount, 1, 'the label-only query still lists the candidate; the LOCAL policy check is what excludes it');
});

// ─────────────────────────────────────────────
// Response shape — never body content, never persisted
// ─────────────────────────────────────────────

test('the response never includes anything beyond {matchedCount, scannedCount, sample, nextPageToken, complete}, and sample entries are exactly {subject, from, date}', async () => {
  const messages = [{ id: 'm1', subject: 'Invoice', fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }];
  const service = makeService({ messages, rules: [ALLOW_FINANCE] });
  const result = await service.buildPreview({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), accessToken: 'token' });
  assert.deepEqual(Object.keys(result).sort(), ['complete', 'matchedCount', 'nextPageToken', 'sample', 'scannedCount'].sort());
  assert.deepEqual(Object.keys(result.sample[0]).sort(), ['date', 'from', 'subject'].sort());
});

test('sample is capped at PREVIEW_PAGE_SIZE even if every scanned message matches', async () => {
  const messages = Array.from({ length: PREVIEW_PAGE_SIZE + 5 }, (_, i) => ({
    id: `m${i}`, subject: `Invoice ${i}`, fromAddress: 'ap@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'],
  }));
  const service = makeService({ messages, rules: [ALLOW_FINANCE] });
  const result = await service.buildPreview({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), accessToken: 'token' });
  assert.ok(result.sample.length <= PREVIEW_PAGE_SIZE);
});

// ─────────────────────────────────────────────
// Multiple members using the same workflow simultaneously — no shared state
// ─────────────────────────────────────────────

test('two connections previewed "concurrently" (interleaved calls to independently-constructed services) never leak state into each other', async () => {
  const serviceA = makeService({ messages: [{ id: 'a1', subject: 'A', fromAddress: 'a@vendor.com', labelIds: [MANAGED_LABEL_ID, 'Label_finance'] }], rules: [ALLOW_FINANCE] });
  const serviceB = makeService({ messages: [{ id: 'b1', subject: 'B', fromAddress: 'b@vendor.com', labelIds: [] }], rules: [ALLOW_FINANCE] });

  const [resultA, resultB] = await Promise.all([
    serviceA.buildPreview({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), accessToken: 'token-a' }),
    serviceB.buildPreview({ clientId: 'client-a', emailConnectionRow: fixtureConnection(), accessToken: 'token-b' }),
  ]);
  assert.equal(resultA.matchedCount, 1);
  assert.equal(resultB.matchedCount, 0); // member B's message isn't labeled
});

// ─────────────────────────────────────────────
// computeLabelReconciliation (§24.2) — pure, fixture-only in EM5
// ─────────────────────────────────────────────

test('computeLabelReconciliation tombstones a previously-ingested message whose label was removed', () => {
  const result = computeLabelReconciliation({
    previouslyIngested: [{ messageId: 'm1', ingestedDocumentId: 'doc-1' }],
    currentlyLabeledMessageIds: [],
  });
  assert.deepEqual(result, [{ messageId: 'm1', ingestedDocumentId: 'doc-1', outcome: 'tombstoned_label_removed' }]);
});

test('computeLabelReconciliation leaves a still-labeled message alone', () => {
  const result = computeLabelReconciliation({
    previouslyIngested: [{ messageId: 'm1', ingestedDocumentId: 'doc-1' }],
    currentlyLabeledMessageIds: ['m1'],
  });
  assert.deepEqual(result, []);
});

test('computeLabelReconciliation handles a mix — only the unlabeled-now message is tombstoned', () => {
  const result = computeLabelReconciliation({
    previouslyIngested: [
      { messageId: 'm1', ingestedDocumentId: 'doc-1' },
      { messageId: 'm2', ingestedDocumentId: 'doc-2' },
    ],
    currentlyLabeledMessageIds: new Set(['m1']),
  });
  assert.deepEqual(result, [{ messageId: 'm2', ingestedDocumentId: 'doc-2', outcome: 'tombstoned_label_removed' }]);
});

test('computeLabelReconciliation accepts either a Set or a plain array for currentlyLabeledMessageIds', () => {
  const viaArray = computeLabelReconciliation({ previouslyIngested: [{ messageId: 'm1', ingestedDocumentId: 'd1' }], currentlyLabeledMessageIds: ['m1'] });
  const viaSet = computeLabelReconciliation({ previouslyIngested: [{ messageId: 'm1', ingestedDocumentId: 'd1' }], currentlyLabeledMessageIds: new Set(['m1']) });
  assert.deepEqual(viaArray, viaSet);
});

test('computeLabelReconciliation returns an empty array for empty/missing input, never throws', () => {
  assert.deepEqual(computeLabelReconciliation({ previouslyIngested: [], currentlyLabeledMessageIds: [] }), []);
  assert.deepEqual(computeLabelReconciliation({}), []);
});
