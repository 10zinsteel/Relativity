'use strict';

// EM10.8 — Citation contributor attribution (EMAIL_INGESTION.md §23).
// Resolves each email-sourced citation's opaque `contributingMemberId`
// (forwarded, unresolved, by AIKB's runKnowledgeQuery.js — see that file's
// own EM10.8 comment) to a human-readable name, server-side, before
// sources[] ever reaches the portal response or a Slack answer. This is
// the "portal-side lookup" §23 always said this feature would need — AIKB
// has no access to client_members (no FK, cross-project), so this can only
// happen here.
//
// Deliberately strips the raw member id off every source before returning
// — matching this codebase's existing citation-output discipline (see
// slackAnswerFormatter.js's explicit "document ids, chunk ids... must
// never reach this module's output" contract): a citation is a
// human-facing string, not a database row.

const defaultSupabaseService = require('./supabaseService');

/**
 * @param {object} [deps] — injected for testing; defaults to the real singleton service.
 */
function createCitationAttributionService({ supabaseService = defaultSupabaseService } = {}) {
  /**
   * Returns a NEW array — never mutates the input. This is the only module
   * allowed to set `contributingMemberName` — any pre-existing value on an
   * incoming source (there should never be one; AIKB never sets this field)
   * is stripped, not trusted, the same defense-in-depth discipline this
   * codebase already applies to poisoned/unexpected fields on a source
   * object elsewhere (e.g. runKnowledgeQuery.js's liveSourcesFrom* helpers).
   */
  async function enrichSourcesWithContributorNames(clientId, sources) {
    if (!clientId) throw new Error('enrichSourcesWithContributorNames requires clientId');
    if (!Array.isArray(sources) || sources.length === 0) return sources || [];

    const memberIds = Array.from(new Set(
      sources.map((s) => s.contributingMemberId).filter(Boolean)
    ));

    let nameById = new Map();
    if (memberIds.length > 0) {
      const members = await supabaseService.getClientMembersByIds(clientId, memberIds);
      nameById = new Map(members.map((m) => [m.id, m.full_name || m.email]));
    }

    return sources.map((s) => {
      const { contributingMemberId, contributingMemberName: _ignoredIncoming, ...rest } = s;
      if (!contributingMemberId) return rest;
      const name = nameById.get(contributingMemberId);
      // A lookup miss (hard-deleted member — see
      // 20260813_team_member_hard_delete.sql — or any other reason the id
      // no longer resolves) simply gets no attribution, never a rendered
      // "via undefined's mailbox".
      return name ? { ...rest, contributingMemberName: name } : rest;
    });
  }

  return { enrichSourcesWithContributorNames };
}

const defaultService = createCitationAttributionService();

module.exports = {
  ...defaultService,
  createCitationAttributionService,
};
