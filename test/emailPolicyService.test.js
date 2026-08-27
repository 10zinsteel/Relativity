const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createEmailPolicyService,
  evaluateMessageAgainstPolicy,
  ruleMatchesMessage,
  mapRuleRowToApi,
  validateRule,
} = require('../services/emailPolicyService');

/**
 * A minimal fake of the subset of the Supabase JS fluent query builder used
 * by emailPolicyService.js, extending test/oauthConnectionsService.test.js's
 * fake-client pattern with insert()/upsert()/order() support (which that
 * file's fake didn't need). Backed by two in-memory tables so
 * replacePolicy's delete-then-insert and getSettings/updateSettings's
 * upsert can be exercised end to end without a real Supabase project —
 * this repo has no test-database convention (dependency injection against
 * a fake client is the intended approach for every service here).
 */
function createFakeSupabaseClient({ failInsert = false, failDelete = false } = {}) {
  const tables = {
    email_ingestion_rules: [],
    email_organization_settings: [],
  };
  let nextId = 1;

  function makeBuilder(table) {
    const rows = tables[table];
    const state = { operation: 'select', filters: {}, payload: null, upsertOpts: null };
    const builder = {
      select() { return builder; },
      eq(col, val) { state.filters[col] = val; return builder; },
      order() { return builder; },
      delete() { state.operation = 'delete'; return builder; },
      insert(payload) { state.operation = 'insert'; state.payload = payload; return builder; },
      upsert(payload, opts) { state.operation = 'upsert'; state.payload = payload; state.upsertOpts = opts; return builder; },
      maybeSingle() { state.single = true; return builder; },
      then(resolve, reject) {
        Promise.resolve().then(() => {
          try {
            resolve(run());
          } catch (err) {
            reject(err);
          }
        });
      },
    };

    function matches(row) {
      return Object.entries(state.filters).every(([col, val]) => row[col] === val);
    }

    function run() {
      if (state.operation === 'select') {
        const matched = rows.filter(matches);
        return { data: state.single ? (matched[0] || null) : matched, error: null };
      }
      if (state.operation === 'delete') {
        if (failDelete) return { data: null, error: { message: 'simulated delete failure' } };
        for (let i = rows.length - 1; i >= 0; i--) {
          if (matches(rows[i])) rows.splice(i, 1);
        }
        return { data: null, error: null };
      }
      if (state.operation === 'insert') {
        if (failInsert) return { data: null, error: { message: 'simulated insert failure' } };
        const inserted = state.payload.map((row) => ({ id: `rule-${nextId++}`, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...row }));
        rows.push(...inserted);
        return { data: inserted, error: null };
      }
      if (state.operation === 'upsert') {
        const key = state.upsertOpts && state.upsertOpts.onConflict;
        const existingIndex = rows.findIndex((row) => row[key] === state.payload[key]);
        const merged = { ...(existingIndex >= 0 ? rows[existingIndex] : {}), ...state.payload };
        if (existingIndex >= 0) rows[existingIndex] = merged;
        else rows.push(merged);
        return { data: merged, error: null };
      }
      throw new Error(`unhandled operation ${state.operation}`);
    }

    return builder;
  }

  return { from(table) { return makeBuilder(table); }, tables };
}

// ─────────────────────────────────────────────
// evaluateMessageAgainstPolicy — the fail-closed Policy Evaluation Model
// (EMAIL_INGESTION.md §16, §28's "Unit — policy evaluation" row)
// ─────────────────────────────────────────────

function allowRule(overrides = {}) {
  return { id: 'allow-1', ruleType: 'allow', enabled: true, includeSent: false, ...overrides };
}
function denyRule(overrides = {}) {
  return { id: 'deny-1', ruleType: 'deny', enabled: true, includeSent: false, ...overrides };
}
function message(overrides = {}) {
  return {
    provider: 'gmail',
    fromAddress: 'someone@client.com',
    toAddresses: ['me@ourcompany.com'],
    ccAddresses: [],
    labelsOrFolders: ['support'],
    subject: 'Order question',
    isSent: false,
    ...overrides,
  };
}

// EM10.6 removed Automatic Email Ingestion's mode-branching (the `mode`
// param and its label-free evaluation path) — evaluateMessageAgainstPolicy
// is now always label-gated, matching the original manual_selected branch
// exactly. See EMAIL_INGESTION.md's EM10.6 record.

test('empty allow-rule set ⇒ zero matches (fail-closed), even when labeled', () => {
  const result = evaluateMessageAgainstPolicy({ rules: [], message: message(), hasLabel: true });
  assert.equal(result.eligible, false);
  assert.equal(result.outcome, 'excluded_no_matching_rule');
});

test('policy match without label ⇒ excluded_not_labeled', () => {
  const rules = [allowRule({ labelOrFolder: 'support' })];
  const result = evaluateMessageAgainstPolicy({ rules, message: message(), hasLabel: false });
  assert.equal(result.eligible, false);
  assert.equal(result.outcome, 'excluded_not_labeled');
});

test('label present but no policy match ⇒ excluded_no_matching_rule', () => {
  const rules = [allowRule({ senderPattern: '@somewhere-else.com' })];
  const result = evaluateMessageAgainstPolicy({ rules, message: message(), hasLabel: true });
  assert.equal(result.eligible, false);
  assert.equal(result.outcome, 'excluded_no_matching_rule');
});

test('label AND policy match ⇒ eligible', () => {
  const rules = [allowRule({ labelOrFolder: 'support' })];
  const result = evaluateMessageAgainstPolicy({ rules, message: message(), hasLabel: true });
  assert.equal(result.eligible, true);
  assert.equal(result.matchedRuleId, 'allow-1');
});

test('allow matches, deny also matches ⇒ excluded (deny always wins)', () => {
  const rules = [
    allowRule({ labelOrFolder: 'support' }),
    denyRule({ id: 'deny-payroll', labelOrFolder: 'support' }),
  ];
  const result = evaluateMessageAgainstPolicy({ rules, message: message(), hasLabel: true });
  assert.equal(result.eligible, false);
  assert.equal(result.outcome, 'excluded_deny_listed');
  assert.equal(result.matchedRuleId, 'deny-payroll');
});

test('member labeling an email outside organization policy never expands beyond it (§16.1 item 4)', () => {
  // A member applies the label, but the client's policy never allow-listed
  // this sender/label combination at all.
  const rules = [allowRule({ senderPattern: '@only-this-domain.com' })];
  const result = evaluateMessageAgainstPolicy({
    rules,
    message: message({ fromAddress: 'random@unrelated.com', labelsOrFolders: ['Relativity/Knowledge'] }),
    hasLabel: true,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.outcome, 'excluded_no_matching_rule');
});

test('disabled allow rule never matches', () => {
  const rules = [allowRule({ enabled: false, labelOrFolder: 'support' })];
  const result = evaluateMessageAgainstPolicy({ rules, message: message(), hasLabel: true });
  assert.equal(result.eligible, false);
  assert.equal(result.outcome, 'excluded_no_matching_rule');
});

test('disabled deny rule does not block an otherwise-matching allow rule', () => {
  const rules = [
    allowRule({ labelOrFolder: 'support' }),
    denyRule({ enabled: false, labelOrFolder: 'support' }),
  ];
  const result = evaluateMessageAgainstPolicy({ rules, message: message(), hasLabel: true });
  assert.equal(result.eligible, true);
});

test('provider-scoped rule does not match a different provider', () => {
  const rules = [allowRule({ provider: 'microsoft', labelOrFolder: 'support' })];
  const result = evaluateMessageAgainstPolicy({ rules, message: message({ provider: 'gmail' }), hasLabel: true });
  assert.equal(result.eligible, false);
});

test('provider-null rule (applies to every provider) matches any provider', () => {
  const rules = [allowRule({ provider: null, labelOrFolder: 'support' })];
  const result = evaluateMessageAgainstPolicy({ rules, message: message({ provider: 'microsoft' }), hasLabel: true });
  assert.equal(result.eligible, true);
});

test('include_sent=false excludes a Sent-folder message even if it otherwise matches', () => {
  const rules = [allowRule({ senderPattern: '@ourcompany.com', includeSent: false })];
  const result = evaluateMessageAgainstPolicy({
    rules,
    message: message({ fromAddress: 'me@ourcompany.com', isSent: true }),
    hasLabel: true,
  });
  assert.equal(result.eligible, false);
});

test('include_sent=true allows a Sent-folder message to match', () => {
  const rules = [allowRule({ senderPattern: '@ourcompany.com', includeSent: true })];
  const result = evaluateMessageAgainstPolicy({
    rules,
    message: message({ fromAddress: 'me@ourcompany.com', isSent: true }),
    hasLabel: true,
  });
  assert.equal(result.eligible, true);
});

// ─────────────────────────────────────────────
// ruleMatchesMessage — criterion-level matching semantics
// ─────────────────────────────────────────────

test('a rule with zero criteria fields set never matches anything', () => {
  assert.equal(ruleMatchesMessage(allowRule(), message()), false);
});

test('sender_pattern domain form ("@domain") matches by suffix', () => {
  const rule = allowRule({ senderPattern: '@client.com' });
  assert.equal(ruleMatchesMessage(rule, message({ fromAddress: 'anyone@client.com' })), true);
  assert.equal(ruleMatchesMessage(rule, message({ fromAddress: 'anyone@notclient.com' })), false);
});

test('sender_pattern exact-address form matches only that address', () => {
  const rule = allowRule({ senderPattern: 'billing@client.com' });
  assert.equal(ruleMatchesMessage(rule, message({ fromAddress: 'billing@client.com' })), true);
  assert.equal(ruleMatchesMessage(rule, message({ fromAddress: 'sales@client.com' })), false);
});

test('recipient_pattern matches against to+cc addresses', () => {
  const rule = allowRule({ recipientPattern: '@ourcompany.com' });
  assert.equal(ruleMatchesMessage(rule, message({ toAddresses: [], ccAddresses: ['team@ourcompany.com'] })), true);
});

test('subject_keyword match is a case-insensitive substring check', () => {
  const rule = allowRule({ subjectKeyword: 'invoice' });
  assert.equal(ruleMatchesMessage(rule, message({ subject: 'Your INVOICE is ready' })), true);
  assert.equal(ruleMatchesMessage(rule, message({ subject: 'Order confirmation' })), false);
});

test('a rule with multiple criteria requires ALL of them to match (conjunctive)', () => {
  const rule = allowRule({ labelOrFolder: 'support', senderPattern: '@client.com' });
  assert.equal(ruleMatchesMessage(rule, message({ labelsOrFolders: ['support'], fromAddress: 'x@client.com' })), true);
  assert.equal(ruleMatchesMessage(rule, message({ labelsOrFolders: ['other'], fromAddress: 'x@client.com' })), false);
});

// ─────────────────────────────────────────────
// validateRule — PUT /policy input validation
// ─────────────────────────────────────────────

test('validateRule rejects an unknown ruleType', () => {
  assert.throws(() => validateRule({ ruleType: 'maybe' }, 0), /ruleType/);
});

test('validateRule rejects an unknown provider', () => {
  assert.throws(() => validateRule({ ruleType: 'allow', provider: 'yahoo' }, 0), /provider/);
});

test('validateRule rejects maxHistoricalDays out of the 1-730 bound', () => {
  assert.throws(() => validateRule({ ruleType: 'allow', maxHistoricalDays: 731 }, 0), /maxHistoricalDays/);
  assert.throws(() => validateRule({ ruleType: 'allow', maxHistoricalDays: 0 }, 0), /maxHistoricalDays/);
});

test('validateRule defaults maxHistoricalDays to 90 and enabled to true', () => {
  const validated = validateRule({ ruleType: 'allow' }, 0);
  assert.equal(validated.maxHistoricalDays, 90);
  assert.equal(validated.enabled, true);
});

test('validateRule normalizes blank strings to null', () => {
  const validated = validateRule({ ruleType: 'allow', senderPattern: '   ' }, 0);
  assert.equal(validated.senderPattern, null);
});

// ─────────────────────────────────────────────
// mapRuleRowToApi — pure DB row -> API shape mapping
// ─────────────────────────────────────────────

test('mapRuleRowToApi maps every column to its camelCase API field', () => {
  const row = {
    id: 'rule-1', provider: 'gmail', rule_type: 'allow', label_or_folder: 'support',
    sender_pattern: '@client.com', recipient_pattern: null, subject_keyword: null,
    include_sent: false, include_attachments: false, max_historical_days: 90,
    destination_collection_id: 'col-1', enabled: true, created_by_member_id: 'member-1',
    created_at: '2026-07-23T00:00:00.000Z', updated_at: '2026-07-23T00:00:00.000Z',
  };
  const api = mapRuleRowToApi(row);
  assert.equal(api.id, 'rule-1');
  assert.equal(api.ruleType, 'allow');
  assert.equal(api.labelOrFolder, 'support');
  assert.equal(api.destinationCollectionId, 'col-1');
  assert.equal(api.maxHistoricalDays, 90);
});

// ─────────────────────────────────────────────
// createEmailPolicyService — CRUD against the fake Supabase client
// ─────────────────────────────────────────────

test('getPolicy returns an empty rule set for a client with no rows', async () => {
  const { client } = { client: createFakeSupabaseClient() };
  const service = createEmailPolicyService(client);
  const result = await service.getPolicy('client-a');
  assert.deepEqual(result, { rules: [] });
});

test('replacePolicy persists rules and getPolicy reads them back', async () => {
  const client = createFakeSupabaseClient();
  const service = createEmailPolicyService(client);

  const saved = await service.replacePolicy({
    clientId: 'client-a',
    rules: [{ ruleType: 'allow', senderPattern: '@client.com' }],
    updatedByMemberId: 'member-1',
  });
  assert.equal(saved.rules.length, 1);
  assert.equal(saved.rules[0].ruleType, 'allow');
  assert.equal(saved.rules[0].createdByMemberId, 'member-1');

  const read = await service.getPolicy('client-a');
  assert.equal(read.rules.length, 1);
  assert.equal(read.rules[0].senderPattern, '@client.com');
});

test('replacePolicy is tenant-scoped: replacing client A\'s rules never touches client B\'s', async () => {
  const client = createFakeSupabaseClient();
  const service = createEmailPolicyService(client);

  await service.replacePolicy({ clientId: 'client-a', rules: [{ ruleType: 'allow', senderPattern: '@a.com' }] });
  await service.replacePolicy({ clientId: 'client-b', rules: [{ ruleType: 'allow', senderPattern: '@b.com' }] });

  await service.replacePolicy({ clientId: 'client-a', rules: [] });

  const aRules = await service.getPolicy('client-a');
  const bRules = await service.getPolicy('client-b');
  assert.equal(aRules.rules.length, 0);
  assert.equal(bRules.rules.length, 1);
  assert.equal(bRules.rules[0].senderPattern, '@b.com');
});

test('replacePolicy with an empty array clears the policy (fail-closed: ingest nothing)', async () => {
  const client = createFakeSupabaseClient();
  const service = createEmailPolicyService(client);

  await service.replacePolicy({ clientId: 'client-a', rules: [{ ruleType: 'allow', senderPattern: '@client.com' }] });
  const cleared = await service.replacePolicy({ clientId: 'client-a', rules: [] });
  assert.deepEqual(cleared, { rules: [] });

  const read = await service.getPolicy('client-a');
  assert.deepEqual(read, { rules: [] });
});

test('replacePolicy rejects the whole batch (no partial write) when any rule fails validation', async () => {
  const client = createFakeSupabaseClient();
  const service = createEmailPolicyService(client);

  await service.replacePolicy({ clientId: 'client-a', rules: [{ ruleType: 'allow', senderPattern: '@client.com' }] });

  await assert.rejects(
    () => service.replacePolicy({
      clientId: 'client-a',
      rules: [{ ruleType: 'allow' }, { ruleType: 'not-a-real-type' }],
    })
  );

  // Validation runs before any delete/insert — the original rule survives.
  const read = await service.getPolicy('client-a');
  assert.equal(read.rules.length, 1);
});

test('replacePolicy fails closed if the insert half fails after delete succeeds', async () => {
  const client = createFakeSupabaseClient();
  const service = createEmailPolicyService(client);
  await service.replacePolicy({ clientId: 'client-a', rules: [{ ruleType: 'allow', senderPattern: '@client.com' }] });

  const failingClient = createFakeSupabaseClient({ failInsert: true });
  failingClient.tables.email_ingestion_rules.push(...client.tables.email_ingestion_rules);
  const failingService = createEmailPolicyService(failingClient);

  await assert.rejects(() => failingService.replacePolicy({
    clientId: 'client-a',
    rules: [{ ruleType: 'allow', senderPattern: '@new.com' }],
  }));

  // Delete already committed before the simulated insert failure — the
  // client is left with an EMPTY (deny-all) policy, not a stale one. This
  // is the same fail-closed partial-failure mode as
  // slackCollectionAccessService.setAllowedCollectionIds.
  const read = await failingService.getPolicy('client-a');
  assert.equal(read.rules.length, 0);
});

// EM10.6 removed automaticSyncEnabled from email_organization_settings —
// liveLookupEnabled (EL4/EL6) is now the only setting getSettings/
// updateSettings carry. See EMAIL_INGESTION.md's EM10.6 record.

test('getSettings defaults liveLookupEnabled to false when no row exists (fail-closed)', async () => {
  const client = createFakeSupabaseClient();
  const service = createEmailPolicyService(client);
  const settings = await service.getSettings('client-a');
  assert.deepEqual(settings, { liveLookupEnabled: false, updatedByMemberId: null, updatedAt: null });
});

test('updateSettings persists and getSettings reads back true', async () => {
  const client = createFakeSupabaseClient();
  const service = createEmailPolicyService(client);
  const updated = await service.updateSettings({ clientId: 'client-a', liveLookupEnabled: true, updatedByMemberId: 'member-1' });
  assert.equal(updated.liveLookupEnabled, true);
  assert.equal(updated.updatedByMemberId, 'member-1');

  const read = await service.getSettings('client-a');
  assert.equal(read.liveLookupEnabled, true);
});

test('updateSettings can flip liveLookupEnabled back to false', async () => {
  const client = createFakeSupabaseClient();
  const service = createEmailPolicyService(client);
  await service.updateSettings({ clientId: 'client-a', liveLookupEnabled: true, updatedByMemberId: 'member-1' });
  await service.updateSettings({ clientId: 'client-a', liveLookupEnabled: false, updatedByMemberId: 'member-1' });

  const read = await service.getSettings('client-a');
  assert.equal(read.liveLookupEnabled, false);
});

test('updateSettings is tenant-scoped: toggling client A never affects client B', async () => {
  const client = createFakeSupabaseClient();
  const service = createEmailPolicyService(client);
  await service.updateSettings({ clientId: 'client-a', liveLookupEnabled: true, updatedByMemberId: 'member-1' });

  const bSettings = await service.getSettings('client-b');
  assert.equal(bSettings.liveLookupEnabled, false);
});

test('getPolicy/replacePolicy/getSettings/updateSettings reject a missing clientId', async () => {
  const client = createFakeSupabaseClient();
  const service = createEmailPolicyService(client);
  await assert.rejects(() => service.getPolicy());
  await assert.rejects(() => service.replacePolicy({ rules: [] }));
  await assert.rejects(() => service.getSettings());
  await assert.rejects(() => service.updateSettings({ liveLookupEnabled: true }));
});
