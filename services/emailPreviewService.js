'use strict';

// Gmail label-query dry-run preview (EM5 — Architecture/architecture/
// EMAIL_INGESTION.md §14.1, §17) plus the pure label-removal reconciliation
// logic (§24.2), built now and exercised only via fixtures since EM6 hasn't
// shipped real ingestion yet to reconcile against (no `email_ingestion_events`
// rows exist in production until then).
//
// buildPreview NEVER persists anything and NEVER returns message body
// content — only {subject, from, date} per matched message (§14.1). It
// compiles a provider query (gmailService.compileSearchQuery), lists a
// bounded page of candidate message ids, fetches metadata-only for each,
// and re-verifies eligibility locally via emailPolicyService's Policy
// Evaluation Model (§16) — the same defense-in-depth split historical
// import (EM6) will reuse: the provider query narrows the candidate set,
// the local check is what actually decides eligibility.

const { email: emailConfig } = require('../config');
const defaultGmailService = require('./gmailService');
const defaultEmailPolicyService = require('./emailPolicyService');

// Bounded per call — one Gmail messages.get round trip per candidate, so
// this stays small regardless of mailbox size (§17 item 3's Vercel-timeout
// reasoning applies to any live per-message loop, not only historical
// import's; a caller wanting more walks pageToken across multiple calls).
const PREVIEW_PAGE_SIZE = emailConfig.previewPageSize;

/**
 * @param {object} [deps] — injected for testing; each defaults to the real singleton service.
 */
function createEmailPreviewService({
  gmailService = defaultGmailService,
  emailPolicyService = defaultEmailPolicyService,
} = {}) {
  /**
   * @param {string} clientId
   * @param {object} emailConnectionRow - the email_connections row (needs
   *   managed_label_id; callers are responsible for having already run
   *   emailConnectionService.ensureManagedLabel before calling this).
   * @param {string} accessToken - a live, already-refreshed Gmail access
   *   token (emailConnectionService.getValidGmailAccessToken).
   * @param {string|null} [pageToken] - continuation token from a prior call.
   * @returns {{matchedCount:number, scannedCount:number, sample:{subject:string,from:string,date:string}[], nextPageToken:string|null, complete:boolean}}
   */
  async function buildPreview({ clientId, emailConnectionRow, accessToken, pageToken = null }) {
    if (!clientId) throw new Error('buildPreview requires clientId');
    if (!emailConnectionRow) throw new Error('buildPreview requires emailConnectionRow');
    if (!accessToken) throw new Error('buildPreview requires accessToken');

    const { rules } = await emailPolicyService.getPolicy(clientId);

    const query = gmailService.compileSearchQuery();

    const { messageIds, nextPageToken } = await gmailService.listMessageIdsByQuery({
      accessToken,
      query,
      pageToken,
      maxResults: PREVIEW_PAGE_SIZE,
    });

    if (messageIds.length === 0) {
      return { matchedCount: 0, scannedCount: 0, sample: [], nextPageToken, complete: !nextPageToken };
    }

    // Label ids on a message (labelIds) are provider ids, but organization
    // policy's labelOrFolder rules are authored by name (§13.1's column
    // comment) — build the id→name map once per call so ruleMatchesMessage
    // can compare names, not ids.
    const labels = await gmailService.listLabels(accessToken);
    const labelNameById = new Map(labels.map((l) => [l.id, l.name]));

    let matchedCount = 0;
    const sample = [];
    for (const messageId of messageIds) {
      const meta = await gmailService.getMessageMetadata({ accessToken, messageId });

      const hasLabel = Boolean(emailConnectionRow.managed_label_id) && meta.labelIds.includes(emailConnectionRow.managed_label_id);
      const labelsOrFolders = meta.labelIds.map((id) => labelNameById.get(id)).filter(Boolean);

      // recipientPattern is deferred from the MVP rule-builder UI (§16.1's
      // field-subset table) — no rule created through the portal can ever
      // set it, so omitting To/Cc headers here (an extra fetch this dry-run
      // doesn't otherwise need) costs nothing today. A rule that somehow did
      // set recipientPattern simply never matches on it, which is the
      // correct fail-closed answer for a criterion this call can't verify.
      const message = {
        provider: 'gmail',
        fromAddress: meta.fromAddress,
        toAddresses: [],
        ccAddresses: [],
        subject: meta.subject,
        isSent: meta.isSent,
        labelsOrFolders,
      };

      const decision = emailPolicyService.evaluateMessageAgainstPolicy({ rules, message, hasLabel });
      if (decision.eligible) {
        matchedCount++;
        if (sample.length < PREVIEW_PAGE_SIZE) {
          sample.push({ subject: meta.subject, from: meta.fromAddress, date: meta.date });
        }
      }
    }

    return {
      matchedCount,
      scannedCount: messageIds.length,
      sample,
      nextPageToken,
      complete: !nextPageToken,
    };
  }

  return { buildPreview };
}

/**
 * §24.2 — pure label-removal reconciliation. Built now so EM6 can call it
 * unmodified once real `email_ingestion_events(outcome='ingested')` rows
 * exist; in EM5 it is exercised only via fixtures standing in for those rows
 * (§31's EM5 Tests bullet: "exercised via fixtures since EM6 hasn't shipped
 * real ingestion yet to reconcile against").
 *
 * @param {{messageId: string, ingestedDocumentId: string}[]} previouslyIngested
 *   fixture/real stand-in for this connection's previously-ingested messages.
 * @param {Set<string>|string[]} currentlyLabeledMessageIds - a fresh read of
 *   which message ids currently carry the managed label (§18.4: "reads label
 *   state directly," no History API cursor until EM7).
 * @returns {{messageId:string, ingestedDocumentId:string, outcome:'tombstoned_label_removed'}[]}
 *   one entry per message whose label was removed — EM6+ calls
 *   `DELETE /api/knowledge/document/:id` for each `ingestedDocumentId` and
 *   records the outcome (§24.2 items 2-3); this function does neither
 *   itself, it only computes which messages qualify.
 */
function computeLabelReconciliation({ previouslyIngested, currentlyLabeledMessageIds }) {
  const labeledSet = currentlyLabeledMessageIds instanceof Set
    ? currentlyLabeledMessageIds
    : new Set(currentlyLabeledMessageIds || []);

  return (previouslyIngested || [])
    .filter((row) => !labeledSet.has(row.messageId))
    .map((row) => ({
      messageId: row.messageId,
      ingestedDocumentId: row.ingestedDocumentId,
      outcome: 'tombstoned_label_removed',
    }));
}

const defaultService = createEmailPreviewService();

module.exports = {
  ...defaultService,
  createEmailPreviewService,
  computeLabelReconciliation,
  PREVIEW_PAGE_SIZE,
};
