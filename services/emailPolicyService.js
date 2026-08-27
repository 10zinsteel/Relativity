'use strict';

// Organization email policy — allow/deny rule CRUD and the org-wide
// live-lookup switch (EM3 — Architecture/architecture/EMAIL_INGESTION.md
// §13.1, §14.1, §16, §31; the org-wide automatic-sync switch this file also
// used to own was removed in EM10.6 — Gmail ingestion is label-driven only
// now). Still no actual ingestion here: this file is the
// policy-authoring surface plus the pure rule-matching logic EM5/EM6 will
// call against real messages — evaluateMessageAgainstPolicy is exported
// specifically so those later milestones don't need to reimplement it.
//
// Rules are client-scoped, not connection-scoped (§13.1 — a deliberate
// departure from the original single-mailbox design): owners/admins author
// one policy that applies identically to every member's mailbox. Mirrors
// services/slackCollectionAccessService.js's createXService(client) +
// singleton-export shape and its fail-closed delete-then-insert replace
// pattern.

const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig } = require('../config');

const RULE_TYPES = ['allow', 'deny'];
const PROVIDERS = ['gmail', 'microsoft'];
const DEFAULT_MAX_HISTORICAL_DAYS = 90;

function normalizeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Validates and normalizes one API-shaped rule payload (as sent to
 * PUT /policy) into the shape replacePolicy persists. Throws a
 * validation Error with `.status = 400` on the first invalid field,
 * carrying the offending rule's index for a useful error message.
 */
function validateRule(rule, index) {
  if (!rule || typeof rule !== 'object') {
    const err = new Error(`Rule at index ${index} must be an object.`);
    err.status = 400;
    throw err;
  }
  if (!RULE_TYPES.includes(rule.ruleType)) {
    const err = new Error(`Rule at index ${index}: ruleType must be "allow" or "deny".`);
    err.status = 400;
    throw err;
  }
  if (rule.provider != null && !PROVIDERS.includes(rule.provider)) {
    const err = new Error(`Rule at index ${index}: provider must be "gmail", "microsoft", or omitted.`);
    err.status = 400;
    throw err;
  }

  const maxHistoricalDays = rule.maxHistoricalDays == null ? DEFAULT_MAX_HISTORICAL_DAYS : Number(rule.maxHistoricalDays);
  if (!Number.isInteger(maxHistoricalDays) || maxHistoricalDays < 1 || maxHistoricalDays > 730) {
    const err = new Error(`Rule at index ${index}: maxHistoricalDays must be an integer between 1 and 730.`);
    err.status = 400;
    throw err;
  }

  return {
    provider: rule.provider || null,
    ruleType: rule.ruleType,
    labelOrFolder: normalizeString(rule.labelOrFolder),
    senderPattern: normalizeString(rule.senderPattern),
    recipientPattern: normalizeString(rule.recipientPattern),
    subjectKeyword: normalizeString(rule.subjectKeyword),
    includeSent: !!rule.includeSent,
    includeAttachments: !!rule.includeAttachments,
    maxHistoricalDays,
    destinationCollectionId: normalizeString(rule.destinationCollectionId),
    enabled: rule.enabled !== false,
  };
}

function mapRuleRowToApi(row) {
  return {
    id: row.id,
    provider: row.provider,
    ruleType: row.rule_type,
    labelOrFolder: row.label_or_folder,
    senderPattern: row.sender_pattern,
    recipientPattern: row.recipient_pattern,
    subjectKeyword: row.subject_keyword,
    includeSent: row.include_sent,
    includeAttachments: row.include_attachments,
    maxHistoricalDays: row.max_historical_days,
    destinationCollectionId: row.destination_collection_id,
    enabled: row.enabled,
    createdByMemberId: row.created_by_member_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSettingsRowToApi(row) {
  return {
    // EL4 (Architecture/architecture/LIVE_EMAIL_LOOKUP.md §7) — org-wide
    // live-lookup switch. (Automatic Email Ingestion's own org-wide switch,
    // automatic_sync_enabled, was removed in EM10.6 — Gmail ingestion is
    // label-driven only now; see EMAIL_INGESTION.md's EM10.6 record.)
    liveLookupEnabled: row ? row.live_lookup_enabled : false,
    updatedByMemberId: row ? row.updated_by_member_id : null,
    updatedAt: row ? row.updated_at : null,
  };
}

/**
 * Case-insensitive sender/recipient address matching. A pattern starting
 * with '@' matches by domain suffix (e.g. '@client.com'); anything else
 * must match the full address exactly (§13.1's sender_pattern/
 * recipient_pattern column comment).
 */
function matchesAddressPattern(pattern, address) {
  if (!pattern || !address) return false;
  const p = pattern.toLowerCase();
  const a = address.toLowerCase();
  return p.startsWith('@') ? a.endsWith(p) : a === p;
}

/**
 * Whether a single enabled rule matches a candidate message. A rule with
 * zero criteria fields set (label/sender/recipient/subject all null) never
 * matches anything — fail closed rather than treating a criteria-less rule
 * as an unintended wildcard. Every criterion the rule DOES specify must
 * match (conjunctive), mirroring how a compiled Gmail/Graph search query
 * combines multiple terms (§17).
 */
function ruleMatchesMessage(rule, message) {
  if (rule.provider && message.provider && rule.provider !== message.provider) return false;
  if (message.isSent && !rule.includeSent) return false;

  const criteria = [];
  if (rule.labelOrFolder) {
    criteria.push(
      (message.labelsOrFolders || []).some(
        (label) => typeof label === 'string' && label.toLowerCase() === rule.labelOrFolder.toLowerCase()
      )
    );
  }
  if (rule.senderPattern) {
    criteria.push(matchesAddressPattern(rule.senderPattern, message.fromAddress));
  }
  if (rule.recipientPattern) {
    const recipients = [...(message.toAddresses || []), ...(message.ccAddresses || [])];
    criteria.push(recipients.some((addr) => matchesAddressPattern(rule.recipientPattern, addr)));
  }
  if (rule.subjectKeyword) {
    criteria.push(!!(message.subject && message.subject.toLowerCase().includes(rule.subjectKeyword.toLowerCase())));
  }

  if (criteria.length === 0) return false;
  return criteria.every(Boolean);
}

/**
 * The Policy Evaluation Model (EMAIL_INGESTION.md §16), as a pure function
 * over API-shaped rules (i.e. already run through mapRuleRowToApi/
 * getPolicy) — no ingestion, network, or DB access happens here. EM3 builds
 * and tests this logic; EM5/EM6 wire it up against real fetched messages.
 *
 * Evaluated in the order §16's diagram specifies: the label gate first
 * (independent of and prior to policy matching), then allow-rule matching,
 * then deny-rule override. Deny always wins.
 *
 * EM10.6 — Automatic Email Ingestion (a second, label-free evaluation path)
 * was removed; this is now the single, always-label-gated ingestion path,
 * matching label-driven mode's original branch exactly (see
 * EMAIL_INGESTION.md's EM10.6 record).
 *
 * @param {object[]} rules - API-shaped email_ingestion_rules rows.
 * @param {object} message - candidate message shape (see ruleMatchesMessage).
 * @param {boolean} hasLabel
 * @returns {{eligible: boolean, outcome: string|null, matchedRuleId: string|null, reason: string}}
 */
function evaluateMessageAgainstPolicy({ rules, message, hasLabel }) {
  if (!hasLabel) {
    return {
      eligible: false,
      outcome: 'excluded_not_labeled',
      matchedRuleId: null,
      reason: 'Message does not carry the Relativity/Knowledge label.',
    };
  }

  const enabledRules = (rules || []).filter((rule) => rule.enabled !== false);
  const allowRules = enabledRules.filter((rule) => rule.ruleType === 'allow');
  const denyRules = enabledRules.filter((rule) => rule.ruleType === 'deny');

  const matchedAllow = allowRules.find((rule) => ruleMatchesMessage(rule, message));
  if (!matchedAllow) {
    return {
      eligible: false,
      outcome: 'excluded_no_matching_rule',
      matchedRuleId: null,
      reason: 'No enabled organization allow rule matches this message.',
    };
  }

  const matchedDeny = denyRules.find((rule) => ruleMatchesMessage(rule, message));
  if (matchedDeny) {
    return {
      eligible: false,
      outcome: 'excluded_deny_listed',
      matchedRuleId: matchedDeny.id,
      reason: `Matched deny rule ${matchedDeny.id}.`,
    };
  }

  return {
    eligible: true,
    outcome: null,
    matchedRuleId: matchedAllow.id,
    reason: `Matched allow rule ${matchedAllow.id}.`,
  };
}

/**
 * @param {object} client - injected Supabase client (or fake, for tests).
 */
function createEmailPolicyService(client) {
  async function getPolicy(clientId) {
    if (!clientId) throw new Error('getPolicy requires clientId');

    const { data, error } = await client
      .from('email_ingestion_rules')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`getPolicy failed: ${error.message}`);

    return { rules: (data || []).map(mapRuleRowToApi) };
  }

  /**
   * Replaces the FULL rule set for a client — PUT /policy's semantics
   * (§14.1: "Replace the full organization rule set"). Delete-then-insert,
   * in that order, mirroring slackCollectionAccessService.setAllowedCollectionIds:
   * if the insert half fails after the delete succeeds, the client is left
   * with an EMPTY rule set (deny-all, per §16.1 item 6's fail-closed
   * guarantee) rather than a stale, possibly over-permissive one.
   */
  async function replacePolicy({ clientId, rules, updatedByMemberId }) {
    if (!clientId) throw new Error('replacePolicy requires clientId');
    if (!Array.isArray(rules)) throw new Error('replacePolicy requires an array of rules');

    const validated = rules.map((rule, index) => validateRule(rule, index));

    const { error: deleteError } = await client
      .from('email_ingestion_rules')
      .delete()
      .eq('client_id', clientId);
    if (deleteError) throw new Error(`replacePolicy (delete) failed: ${deleteError.message}`);

    if (validated.length === 0) return { rules: [] };

    const rows = validated.map((rule) => ({
      client_id: clientId,
      provider: rule.provider,
      rule_type: rule.ruleType,
      label_or_folder: rule.labelOrFolder,
      sender_pattern: rule.senderPattern,
      recipient_pattern: rule.recipientPattern,
      subject_keyword: rule.subjectKeyword,
      include_sent: rule.includeSent,
      include_attachments: rule.includeAttachments,
      max_historical_days: rule.maxHistoricalDays,
      destination_collection_id: rule.destinationCollectionId,
      enabled: rule.enabled,
      created_by_member_id: updatedByMemberId || null,
    }));

    const { data, error: insertError } = await client
      .from('email_ingestion_rules')
      .insert(rows)
      .select('*');
    if (insertError) throw new Error(`replacePolicy (insert) failed: ${insertError.message}`);

    return { rules: (data || []).map(mapRuleRowToApi) };
  }

  /**
   * email_organization_settings is created lazily (§13.1) — a client that
   * never touches this setting still gets liveLookupEnabled: false
   * (fail-closed).
   */
  async function getSettings(clientId) {
    if (!clientId) throw new Error('getSettings requires clientId');

    const { data, error } = await client
      .from('email_organization_settings')
      .select('*')
      .eq('client_id', clientId)
      .maybeSingle();
    if (error) throw new Error(`getSettings failed: ${error.message}`);

    return mapSettingsRowToApi(data);
  }

  // EL6 — the org-wide live-lookup switch. (Automatic Email Ingestion's own
  // org-wide switch was removed in EM10.6 — this is now the only setting
  // this function writes.)
  async function updateSettings({ clientId, liveLookupEnabled, updatedByMemberId }) {
    if (!clientId) throw new Error('updateSettings requires clientId');
    if (typeof liveLookupEnabled !== 'boolean') {
      throw new Error('updateSettings requires a boolean liveLookupEnabled');
    }

    const payload = {
      client_id: clientId,
      live_lookup_enabled: liveLookupEnabled,
      updated_by_member_id: updatedByMemberId || null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await client
      .from('email_organization_settings')
      .upsert(payload, { onConflict: 'client_id' })
      .select('*')
      .maybeSingle();
    if (error) throw new Error(`updateSettings failed: ${error.message}`);

    return mapSettingsRowToApi(data);
  }

  return { getPolicy, replacePolicy, getSettings, updateSettings };
}

const defaultClient = createClient(supabaseConfig.url, supabaseConfig.serviceKey);
const defaultService = createEmailPolicyService(defaultClient);

module.exports = {
  ...defaultService,
  createEmailPolicyService,
  evaluateMessageAgainstPolicy,
  ruleMatchesMessage,
  mapRuleRowToApi,
  validateRule,
};
