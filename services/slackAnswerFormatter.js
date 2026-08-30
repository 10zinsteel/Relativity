'use strict';

// Slack answer/citation formatting (Architecture Review Phase 4, Milestone
// 4, §4.14). Pure, no I/O. Only ever includes human-readable citation
// fields (document title, optional page) — document IDs, chunk IDs, storage
// paths, signed URLs, database IDs, embeddings, and raw metadata must never
// reach this module's output.

const MAX_CITATIONS = 5;
const MAX_ANSWER_CHARS = 3000; // conservative vs. Slack's much larger message limit
const TRUNCATION_SUFFIX = '…'; // ellipsis

const FALLBACK = Object.freeze({
  KNOWLEDGE_GAP: "I couldn't find that information in your organization's knowledge base.",
  TEMPORARY_FAILURE: "I couldn't complete that request right now. Please try again shortly.",
  // EL7B (LIVE_EMAIL_LOOKUP.md §3.2 — "an unlinked user gets the link-prompt,
  // never a silent failure"): appended when AIKB signals
  // emailLookupSuggested (services/slackDeliverService.js), covering both
  // an unlinked Slack user and a linked one with no active/consented
  // mailbox — deliberately generic wording rather than guessing which case
  // applies, since Relativity doesn't re-check that distinction at deliver
  // time.
  EMAIL_LOOKUP_SUGGESTED: "\n\n_I can search your email for questions like this once you link your Slack account or connect email search — see the Relativity portal's Email panel._",
});

function truncateAnswer(text) {
  if (typeof text !== 'string') return '';
  if (text.length <= MAX_ANSWER_CHARS) return text;
  return `${text.slice(0, MAX_ANSWER_CHARS - 1)}${TRUNCATION_SUFFIX}`;
}

/**
 * EL7B (§3.2: "a live email citation in Slack shows subject/sender/date and
 * a portal deep-link for full detail") — live_email_message/
 * live_email_thread sources (§6.2) never carry `title`/`fileName`, only
 * `subject`/`from`; this constructs the same "subject" from "sender" shape
 * runKnowledgeQuery.js's own sourceMap already builds for a STORED email
 * citation's `title` field, so both render consistently even though only
 * one of them arrives with `title` pre-built.
 */
function titleForSource(source) {
  if (typeof source.title === 'string' && source.title.trim()) return source.title.trim();
  if (typeof source.fileName === 'string' && source.fileName.trim()) return source.fileName.trim();
  if (typeof source.subject === 'string') {
    return `"${source.subject}" from ${source.from || 'unknown sender'}`;
  }
  return '';
}

/**
 * @param {Array<{fileName?: string, title?: string, pages?: number[], subject?: string, from?: string, live?: boolean, contributingMemberName?: string}>} sources
 * @returns {string[]} deduplicated, capped, human-readable citation lines.
 */
function formatCitations(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return [];

  const seen = new Set();
  const lines = [];

  for (const source of sources) {
    if (!source) continue;
    const title = titleForSource(source);
    if (!title) continue;

    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // EM10.8 (EMAIL_INGESTION.md §23) — contributor attribution, when
    // present. Only ever set on a stored-ingestion email citation (by
    // Relativity's citationAttributionService, server-side, before this
    // function ever runs); live sources never carry it. Appended to the
    // dedup KEY's underlying title, not used to compute the key itself —
    // two chunks from the same document already dedupe on title alone.
    const attribution = typeof source.contributingMemberName === 'string' && source.contributingMemberName.trim()
      ? ` — via ${source.contributingMemberName.trim()}'s mailbox`
      : '';
    const displayTitle = `${title}${attribution}`;

    // §3.2/§6.3 — a live result is fresher and can change/disappear, unlike
    // a durable stored citation; marked distinctly here the same way the
    // portal's own "🔴 Live" badge (portal.js) distinguishes the two.
    lines.push(source.live === true ? `${displayTitle} (Live)` : displayTitle);
    if (lines.length >= MAX_CITATIONS) break;
  }

  return lines;
}

/**
 * @param {{ answer: string, sources?: Array, isKnowledgeGap?: boolean, emailLookupSuggested?: boolean }} result - AIKB's /ask-pipeline response.
 * @returns {string} the exact mrkdwn text to send via chat.postMessage.
 */
function formatSlackMessage({ answer, sources, isKnowledgeGap, emailLookupSuggested }) {
  // EL7B (§3.2) — the link-prompt hint takes priority even on a knowledge-gap
  // answer: "never a silent failure" applies regardless of whether stored
  // knowledge also came up empty.
  const hint = emailLookupSuggested === true ? FALLBACK.EMAIL_LOOKUP_SUGGESTED : '';

  if (isKnowledgeGap) {
    return `${FALLBACK.KNOWLEDGE_GAP}${hint}`;
  }

  const body = truncateAnswer(answer || '');
  const citationLines = formatCitations(sources);

  if (citationLines.length === 0) {
    return `${body}${hint}`;
  }

  const sourcesBlock = citationLines.map((title) => `• ${title}`).join('\n');
  return `${body}\n\nSources:\n${sourcesBlock}${hint}`;
}

module.exports = {
  formatSlackMessage,
  formatCitations,
  titleForSource,
  truncateAnswer,
  FALLBACK,
  MAX_CITATIONS,
  MAX_ANSWER_CHARS,
};
