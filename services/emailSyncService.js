'use strict';

// Email sync orchestration — Architecture/architecture/EMAIL_INGESTION.md.
// EM6 (§14.2, §15, §17) shipped the first real ingestion: bounded,
// paginated, `manual_selected`-mode-only historical import, using EM5's
// label workflow, forwarding normalized text to AIKB's existing,
// generalized `/ingest` route (services/aikbService.js). EM7 (§18) adds the
// Gmail History API incremental path on top of it: once a connection has a
// valid stored cursor (`email_sync_state.provider_cursor`), a fresh sync
// reads only what changed since that cursor instead of re-scanning the
// whole label — falling back transparently to a bounded historical re-scan
// when the cursor has expired (§18.4).
//
// EM8 (§18.3) added a second, label-free `automatic` sync mode alongside
// `manual_selected` — a policy-only, no-per-message-label path, driven by an
// AIKB-Inngest cron tick instead of a member's "Sync now" click.
//
// EM10.6 removed Automatic Email Ingestion entirely (see
// EMAIL_INGESTION.md's EM10.6 record): `syncConnection` below is once again
// `manual_selected`-only — label-gated historical import (EM6) and
// label-scoped incremental sync via the Gmail History API (EM7). The tick
// handler, its due-connection query, and every automatic-mode branch this
// file used to carry were deleted, not merely disabled.
//
// EM9 (§24.5, §28.1) added `reconcilePolicyChanges`, which re-evaluates
// every previously-ingested message against the CURRENT organization policy
// (independent of label state) and tombstones anything that no longer
// matches, recorded as `tombstoned_policy_change` — orthogonal to
// `reconcileRemovedLabelsFullList` below, which reconciles label withdrawal.

const { createClient } = require('@supabase/supabase-js');
const { supabase: supabaseConfig, limits, email: emailConfig } = require('../config');
const defaultGmailService = require('./gmailService');
const { ERROR_CODES: GMAIL_ERROR_CODES } = require('./gmailService');
const defaultEmailPolicyService = require('./emailPolicyService');
const defaultEmailNormalizationService = require('./emailNormalizationService');
const defaultAikbService = require('./aikbService');

// Bounded per request (Vercel timeout — §17 item 3): one page of historical
// import, or one page of history-diff processing, per POST /sync call. A
// caller re-invokes with the returned nextPageToken (and runType) until
// complete: true.
const HISTORICAL_PAGE_SIZE = emailConfig.historicalSyncPageSize;

// Label-removal reconciliation (§24.2) for a FULL historical sync (fresh or
// cursor-expired-fallback) needs "every message currently under the
// label," not just this page's candidates — a single, larger, bounded
// listing rather than true unbounded pagination, run only once the
// historical page loop reports complete. An incremental sync never needs
// this: the History API diff itself reports label removals directly
// (§18.4), tombstoned per-page as they're seen. A mailbox with more than
// this many labeled messages gets a best-effort full-list reconciliation
// pass (a documented MVP bound, not a correctness bug — the next completed
// sync re-attempts it).
const RECONCILIATION_LIST_SIZE = 500;

const ERROR_CODES = Object.freeze({
  SEARCH_DISABLED: 'SEARCH_DISABLED',
  SYNC_DISABLED: 'SYNC_DISABLED',
  DOCUMENT_LIMIT_REACHED: 'DOCUMENT_LIMIT_REACHED',
  INVALID_RESUME: 'INVALID_RESUME',
});

function syncError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// Thin, EM6/EM7-only data access for email_sync_runs/email_ingestion_events/
// email_sync_state, plus the one email_connections column
// (historical_import_status) this milestone writes. Injectable like every
// other repo object in this codebase's email services, so tests never touch
// a real Supabase project.
const defaultDbClient = createClient(supabaseConfig.url, supabaseConfig.serviceKey);

// Shared by getPreviouslyIngestedMessageIds and
// getTombstonedPolicyChangeMessageIds — every email_connections.id that has
// ever shared this row's durable mailbox identity (client + member +
// provider + mailbox address), so a reconnect (which allocates a new
// connection id, per Scenario 6) doesn't orphan either lookup from a
// mailbox's ingestion history.
async function resolveMailboxConnectionIds(emailConnectionRow) {
  const { data: relatedConnections, error: relError } = await defaultDbClient
    .from('email_connections')
    .select('id')
    .eq('client_id', emailConnectionRow.client_id)
    .eq('member_id', emailConnectionRow.member_id)
    .eq('provider', emailConnectionRow.provider)
    .eq('mailbox_address', emailConnectionRow.mailbox_address);
  if (relError) throw new Error(`resolveMailboxConnectionIds failed: ${relError.message}`);
  return (relatedConnections || []).map((row) => row.id);
}

// Pure reduction used by getTombstonedPolicyChangeMessageIds: given every
// email_ingestion_events row for a mailbox's message ids, in ascending
// created_at order, returns a Map of provider_message_id -> its most recent
// outcome. Extracted standalone so this "latest, not any" logic (the actual
// fix for messages otherwise being permanently invisible after a restore)
// is directly unit-testable without a live Supabase query.
function reduceToLatestOutcomePerMessage(eventsAscending) {
  const latest = new Map();
  for (const row of eventsAscending) {
    latest.set(row.provider_message_id, row.outcome);
  }
  return latest;
}

const defaultEmailSyncRepo = {
  async createSyncRun({ clientId, emailConnectionId, runType, triggeredByMemberId }) {
    const { data, error } = await defaultDbClient
      .from('email_sync_runs')
      .insert({
        client_id: clientId,
        email_connection_id: emailConnectionId,
        run_type: runType,
        status: 'running',
        triggered_by_member_id: triggeredByMemberId || null,
      })
      .select('*')
      .single();
    if (error) throw new Error(`createSyncRun failed: ${error.message}`);
    return data;
  },

  async completeSyncRun(syncRunId, { status, counts, errorSummary }) {
    const { error } = await defaultDbClient
      .from('email_sync_runs')
      .update({
        status,
        completed_at: new Date().toISOString(),
        messages_scanned: counts.scanned,
        messages_matched: counts.matched,
        messages_ingested: counts.ingested,
        messages_skipped: counts.skipped,
        messages_duplicate: counts.duplicate,
        messages_failed: counts.failed,
        error_summary: errorSummary || null,
      })
      .eq('id', syncRunId);
    if (error) throw new Error(`completeSyncRun failed: ${error.message}`);
  },

  async recordEvents(events) {
    if (!events || events.length === 0) return;
    const { error } = await defaultDbClient.from('email_ingestion_events').insert(events);
    if (error) throw new Error(`recordEvents failed: ${error.message}`);
  },

  async updateHistoricalImportStatus(emailConnectionId, status) {
    const { error } = await defaultDbClient
      .from('email_connections')
      .update({ historical_import_status: status, updated_at: new Date().toISOString() })
      .eq('id', emailConnectionId);
    if (error) throw new Error(`updateHistoricalImportStatus failed: ${error.message}`);
  },

  // EM7 — read the connection's stored cursor to decide historical vs
  // incremental at the start of a fresh sync (§18.2).
  async getSyncState(emailConnectionId) {
    const { data, error } = await defaultDbClient
      .from('email_sync_state')
      .select('*')
      .eq('email_connection_id', emailConnectionId)
      .maybeSingle();
    if (error) throw new Error(`getSyncState failed: ${error.message}`);
    return data || null;
  },

  // EM7 — only the cursor-lifecycle columns are ever conditionally written
  // here (providerCursor/cursorStatus/cursorObtainedAt default to
  // `undefined`, meaning "leave unchanged" — Supabase's upsert only issues
  // an UPDATE SET for keys actually present in the payload, so an
  // in-progress/failed sync's upsertSyncState call — which omits all three
  // — never clobbers a still-valid cursor with nothing).
  async upsertSyncState(emailConnectionId, {
    lastSyncStartedAt, lastSyncCompletedAt, lastSyncStatus,
    providerCursor, cursorStatus, cursorObtainedAt,
  }) {
    const payload = {
      email_connection_id: emailConnectionId,
      last_sync_started_at: lastSyncStartedAt,
      last_sync_completed_at: lastSyncCompletedAt,
      last_sync_status: lastSyncStatus,
      updated_at: new Date().toISOString(),
    };
    if (providerCursor !== undefined) payload.provider_cursor = providerCursor;
    if (cursorStatus !== undefined) payload.cursor_status = cursorStatus;
    if (cursorObtainedAt !== undefined) payload.cursor_obtained_at = cursorObtainedAt;

    const { error } = await defaultDbClient
      .from('email_sync_state')
      .upsert(payload, { onConflict: 'email_connection_id' });
    if (error) throw new Error(`upsertSyncState failed: ${error.message}`);
  },

  // EM7 (§18.4) — a stale/expired cursor is recorded so the NEXT fresh sync
  // falls back to historical without needing to re-probe Gmail first.
  async markCursorExpired(emailConnectionId) {
    const { error } = await defaultDbClient
      .from('email_sync_state')
      .upsert(
        { email_connection_id: emailConnectionId, cursor_status: 'expired', updated_at: new Date().toISOString() },
        { onConflict: 'email_connection_id' }
      );
    if (error) throw new Error(`markCursorExpired failed: ${error.message}`);
  },

  // §24.2 reconciliation (full-list variant, historical sync only) — every
  // message this MAILBOX has ever successfully queued for ingestion, across
  // every past sync run, so a label removed since ANY prior sync (not just
  // the most recent one) is still caught. Bug fix (found during EM10.5 B8
  // setup, 2026-09-02): a reconnect (disconnect+reconnect, or a fresh OAuth
  // grant replacing the active connection — Scenario 6's validated,
  // intentional behavior) gives the same mailbox a NEW email_connections.id.
  // Scoping this lookup to a single connection id therefore made every
  // message ingested under a prior connection row invisible to both
  // reconciliation passes (this one and reconcilePolicyChanges) the moment a
  // mailbox was reconnected — label removal and policy-change tombstoning
  // both silently stopped catching that mailbox's older content. Scoped
  // instead by the durable mailbox identity (client + member + provider +
  // address), across every connection row that identity has ever had.
  async getPreviouslyIngestedMessageIds(emailConnectionRow) {
    const connectionIds = await resolveMailboxConnectionIds(emailConnectionRow);
    if (connectionIds.length === 0) return [];

    const { data, error } = await defaultDbClient
      .from('email_ingestion_events')
      .select('provider_message_id')
      .in('email_connection_id', connectionIds)
      .eq('outcome', 'ingested');
    if (error) throw new Error(`getPreviouslyIngestedMessageIds failed: ${error.message}`);
    return Array.from(new Set((data || []).map((row) => row.provider_message_id)));
  },

  // Restore-path counterpart (fix for: policy-tombstoned messages had no
  // way back once the policy that tombstoned them was later reverted —
  // see reconcilePolicyRestorations' doc comment). Unlike
  // getPreviouslyIngestedMessageIds above, this can't just filter
  // `.eq('outcome', 'tombstoned_policy_change')`: a message's original
  // 'ingested' event row is never removed, so outcome history accumulates
  // (ingested -> tombstoned_policy_change -> restored_policy_change -> ...)
  // and only the LATEST row per message tells you its current state.
  // Scoped by the same durable mailbox identity as
  // getPreviouslyIngestedMessageIds, for the same reconnect reason.
  async getTombstonedPolicyChangeMessageIds(emailConnectionRow) {
    const connectionIds = await resolveMailboxConnectionIds(emailConnectionRow);
    if (connectionIds.length === 0) return [];

    const { data, error } = await defaultDbClient
      .from('email_ingestion_events')
      .select('provider_message_id, outcome')
      .in('email_connection_id', connectionIds)
      .order('created_at', { ascending: true });
    if (error) throw new Error(`getTombstonedPolicyChangeMessageIds failed: ${error.message}`);

    return Array.from(reduceToLatestOutcomePerMessage(data || []).entries())
      .filter(([, outcome]) => outcome === 'tombstoned_policy_change')
      .map(([messageId]) => messageId);
  },

  // EM7 — recent sync-run history for the portal's sync-run view (§27, §31 EM7 Frontend).
  async listRecentSyncRuns(emailConnectionId, limit = 10) {
    const { data, error } = await defaultDbClient
      .from('email_sync_runs')
      .select('*')
      .eq('email_connection_id', emailConnectionId)
      .order('started_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`listRecentSyncRuns failed: ${error.message}`);
    return data || [];
  },

};

/**
 * Fail-closed gate (§16's Policy Evaluation Model, the connection-level
 * steps above the per-message decision tree) — evaluated before any
 * provider call is made. Every branch maps to a single named reason so a
 * rejection is always attributable, never a generic failure.
 */
function assertSyncAllowed({ memberSearchEnabled, syncEnabled }) {
  if (!memberSearchEnabled) {
    throw syncError(ERROR_CODES.SEARCH_DISABLED, 'This mailbox is not contributing to search (search_enabled is off).');
  }
  if (!syncEnabled) {
    throw syncError(ERROR_CODES.SYNC_DISABLED, 'Sync is disabled for this connection.');
  }
}

function safeIsoDate(dateHeaderValue) {
  const parsed = new Date(dateHeaderValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

async function countActiveDocuments(aikbService, clientId) {
  try {
    const existing = await aikbService.listDocuments(clientId);
    const docs = existing.documents || (Array.isArray(existing) ? existing : []);
    return docs.filter((d) => d.status !== 'deleted').length;
  } catch {
    return 0; // non-blocking — matches routes/api.js's existing "proceed if count check fails" precedent
  }
}

/**
 * The aikbService.uploadAndIngest payload for one Gmail message — shared by
 * processCandidateMessage (new/re-scanned messages) and
 * reconcilePolicyRestorations (re-ingesting a policy-tombstoned message),
 * so the two can't drift apart on what AIKB expects.
 */
function buildEmailIngestPayload({ clientId, emailConnectionRow, messageId, meta, normalized, labelsOrFolders, matchedRuleId, destinationCollectionId }) {
  return {
    clientId,
    sourceFileId: messageId,
    fileName: `${(meta.subject || '(no subject)').slice(0, 200)}.txt`,
    mimeType: 'text/plain',
    fileBuffer: Buffer.from(normalized, 'utf8'),
    sourceProvider: 'gmail',
    collectionId: destinationCollectionId || undefined,
    emailMetadata: {
      provider: 'gmail',
      providerAccountId: emailConnectionRow.mailbox_address,
      contributingMemberId: emailConnectionRow.member_id,
      providerMessageId: messageId,
      providerThreadId: meta.threadId || null,
      from: meta.fromAddress,
      fromName: null,
      to: [],
      cc: [],
      subject: meta.subject,
      sentAt: meta.date ? safeIsoDate(meta.date) : null,
      receivedAt: null,
      folderOrLabels: labelsOrFolders,
      hasAttachments: false,
      deepLinkUrl: `https://mail.google.com/mail/u/0/#all/${messageId}`,
      ingestionRuleId: matchedRuleId,
    },
  };
}

/**
 * Shared per-message eligibility + ingest pipeline, used by both the
 * historical and incremental page processors so the two never drift apart:
 * metadata fetch → local policy re-verification (label gate + organization
 * policy, §16) → (if eligible) body fetch → normalize (§19) → forward to
 * AIKB (§14.2). Never throws for an eligibility/normalization/ingest
 * failure — those are represented in the returned `kind`; only an
 * unexpected exception (a network error the caller didn't already handle)
 * propagates, which callers wrap in their own try/catch.
 */
async function processCandidateMessage({
  gmailService, emailPolicyService, emailNormalizationService, aikbService,
  clientId, emailConnectionRow, accessToken, rules, labelNameById, messageId, syncRunId,
}) {
  const meta = await gmailService.getMessageMetadata({ accessToken, messageId });
  const hasLabel = Boolean(emailConnectionRow.managed_label_id) && meta.labelIds.includes(emailConnectionRow.managed_label_id);
  const labelsOrFolders = meta.labelIds.map((id) => labelNameById.get(id)).filter(Boolean);

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

  if (!decision.eligible) {
    return {
      kind: 'skipped',
      event: {
        sync_run_id: syncRunId,
        email_connection_id: emailConnectionRow.id,
        provider_message_id: messageId,
        outcome: decision.outcome,
        matched_rule_id: decision.matchedRuleId,
        reason: decision.reason,
      },
      entry: { messageId, subject: meta.subject, reason: decision.reason },
    };
  }

  const body = await gmailService.getMessageBody({ accessToken, messageId });
  const normalized = emailNormalizationService.normalizeEmailBody({ html: body.html, text: body.text });

  if (!normalized) {
    const reason = 'Message produced no extractable text after normalization.';
    return {
      kind: 'failed',
      event: {
        sync_run_id: syncRunId,
        email_connection_id: emailConnectionRow.id,
        provider_message_id: messageId,
        outcome: 'failed',
        matched_rule_id: decision.matchedRuleId,
        reason,
      },
      entry: { messageId, subject: meta.subject, reason },
    };
  }

  const matchedRule = (rules || []).find((r) => r.id === decision.matchedRuleId);
  const destinationCollectionId = matchedRule ? matchedRule.destinationCollectionId : null;

  await aikbService.uploadAndIngest(buildEmailIngestPayload({
    clientId, emailConnectionRow, messageId, meta, normalized, labelsOrFolders,
    matchedRuleId: decision.matchedRuleId, destinationCollectionId,
  }));

  return {
    kind: 'ingested',
    event: {
      sync_run_id: syncRunId,
      email_connection_id: emailConnectionRow.id,
      provider_message_id: messageId,
      outcome: 'ingested',
      matched_rule_id: decision.matchedRuleId,
      reason: decision.reason,
    },
    entry: { messageId, subject: meta.subject },
  };
}

/**
 * Runs `processCandidateMessage` for one messageId, folding the result (or
 * an unexpected exception) into the shared counts/events/imported/skipped/
 * failed accumulators — the exact per-message bookkeeping both the
 * historical and incremental loops need identically.
 */
async function processOneCandidate(deps, { messageId, counts, events, imported, skipped, failed }) {
  counts.scanned++;
  try {
    const result = await processCandidateMessage({ ...deps, messageId });
    events.push(result.event);
    if (result.kind === 'skipped') {
      counts.skipped++;
      skipped.push(result.entry);
    } else if (result.kind === 'failed') {
      counts.matched++;
      counts.failed++;
      failed.push(result.entry);
    } else {
      counts.matched++;
      counts.ingested++;
      imported.push(result.entry);
    }
  } catch (err) {
    counts.failed++;
    const reason = `Sync error: ${err.message}`.slice(0, 500);
    events.push({
      sync_run_id: deps.syncRunId,
      email_connection_id: deps.emailConnectionRow.id,
      provider_message_id: messageId,
      outcome: 'failed',
      matched_rule_id: null,
      reason,
    });
    failed.push({ messageId, reason: err.message });
  }
}

/**
 * Tombstones a set of message ids via AIKB's existing DELETE /document/:id
 * (§24.1, §24.2) — resolved to the real AIKB document id through
 * aikbService.listDocuments, since /ingest never returns one synchronously
 * (it only enqueues an async Inngest event). Shared by both the historical
 * full-list reconciliation and the incremental per-page diff handling.
 * Best-effort per message: one delete failure doesn't block the rest.
 */
async function tombstoneMessages({ aikbService, emailSyncRepo, clientId, emailConnectionRow, messageIds, syncRunId, reason, outcome = 'tombstoned_label_removed' }) {
  if (!messageIds || messageIds.length === 0) return [];

  const documents = await aikbService.listDocuments(clientId);
  const docs = documents.documents || (Array.isArray(documents) ? documents : []);
  const docIdByMessageId = new Map(
    docs
      .filter((d) => (d.source_provider || d.sourceProvider) === 'gmail')
      .map((d) => [d.source_file_id || d.sourceFileId, d.id])
  );

  const tombstoned = [];
  const events = [];
  for (const messageId of messageIds) {
    const documentId = docIdByMessageId.get(messageId);
    if (!documentId) continue; // already deleted/never resolved — nothing to do
    try {
      await aikbService.deleteDocumentById(clientId, documentId);
      tombstoned.push({ messageId, documentId });
      events.push({
        sync_run_id: syncRunId,
        email_connection_id: emailConnectionRow.id,
        provider_message_id: messageId,
        outcome,
        matched_rule_id: null,
        reason,
        ingested_document_id: documentId,
      });
    } catch (err) {
      console.error('[emailSyncService] tombstone delete failed:', messageId, err.message);
    }
  }
  if (events.length > 0) await emailSyncRepo.recordEvents(events);
  return tombstoned;
}

/**
 * §24.2 — full-list label-removal reconciliation, historical sync only, run
 * once a historical sync reports complete (fresh full import OR a
 * cursor-expired fallback). Re-lists every message currently under the
 * managed label (a single bounded call, RECONCILIATION_LIST_SIZE) and diffs
 * it against every message this connection has ever successfully queued for
 * ingestion. An incremental sync never calls this — the History API diff
 * itself already reports label removals directly, tombstoned per-page (see
 * runIncrementalPage). Best-effort: a reconciliation failure is logged and
 * does not fail the sync run that triggered it.
 */
async function reconcileRemovedLabelsFullList({ gmailService, emailSyncRepo, aikbService, clientId, emailConnectionRow, accessToken, syncRunId }) {
  if (!emailConnectionRow.managed_label_id) return [];

  try {
    const [previouslyIngested, { messageIds: currentlyLabeled }] = await Promise.all([
      emailSyncRepo.getPreviouslyIngestedMessageIds(emailConnectionRow),
      gmailService.listMessageIdsByQuery({
        accessToken,
        query: gmailService.compileSearchQuery({ mode: 'manual_selected', rules: [] }),
        maxResults: RECONCILIATION_LIST_SIZE,
      }),
    ]);

    if (previouslyIngested.length === 0) return [];

    const currentlyLabeledSet = new Set(currentlyLabeled);
    const removed = previouslyIngested.filter((messageId) => !currentlyLabeledSet.has(messageId));
    if (removed.length === 0) return [];

    return await tombstoneMessages({
      aikbService, emailSyncRepo, clientId, emailConnectionRow, syncRunId,
      messageIds: removed,
      reason: 'Relativity/Knowledge label removed since last sync.',
    });
  } catch (err) {
    console.error('[emailSyncService] full-list label reconciliation failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * EM9 (§24.5, §28.1's "Label reconciliation after policy changes" case) —
 * re-evaluates every message this connection has previously ingested
 * against the CURRENT organization policy (not against label state, which
 * reconcileRemovedLabelsFullList above already handles) and tombstones any
 * that no longer pass — e.g. an owner/admin edits the policy (PUT replaces
 * the whole rule set) so a rule that used to match a category of email no
 * longer does; the Gmail label is still present, so this is a distinct
 * event from §24.2's label-withdrawal path, recorded as
 * 'tombstoned_policy_change' rather than 'tombstoned_label_removed' (§13.1,
 * the EM9 migration's widened outcome CHECK). Unlike
 * reconcileRemovedLabelsFullList, this runs for BOTH sync modes and BOTH
 * run types — a policy change must retroactively affect every connection
 * it touches, not just the one whose sync happened to run right after the
 * edit (§31 EM9 acceptance criteria), and manual mode's label gate is
 * orthogonal to organization policy, not a substitute reconciliation target
 * for it.
 *
 * Bounded to POLICY_RECONCILIATION_LIST_SIZE previously-ingested messages
 * per sync (oldest-message-id order is not guaranteed — this is a
 * best-effort MVP bound, the same documented tradeoff
 * RECONCILIATION_LIST_SIZE already accepts elsewhere in this file): each
 * candidate needs its own Gmail metadata re-fetch (no cheaper bulk API
 * exists for "re-check policy," unlike label presence, which Gmail can list
 * in one query), so this is deliberately capped rather than unbounded.
 * Best-effort and non-fatal: a re-fetch failure for one message is skipped,
 * not retried in this same pass, and never fails the sync run that
 * triggered it — a later sync gets another chance.
 */
const POLICY_RECONCILIATION_LIST_SIZE = 500;

async function reconcilePolicyChanges({ gmailService, emailPolicyService, emailSyncRepo, aikbService, clientId, emailConnectionRow, accessToken, rules, syncRunId, excludeMessageIds = new Set() }) {
  try {
    const previouslyIngested = await emailSyncRepo.getPreviouslyIngestedMessageIds(emailConnectionRow);
    if (previouslyIngested.length === 0) return [];
    // A message the label-removal pass (reconcileRemovedLabelsFullList)
    // already tombstoned this same sync is skipped here — both passes
    // independently query "should this still be here," and a message can
    // legitimately fail both checks at once (label removed AND no longer
    // policy-eligible); tombstoning it twice would mean a second, redundant
    // AIKB delete call against an already-deleted document and two
    // conflicting event rows for the same message in the same run.
    const candidates = previouslyIngested
      .filter((messageId) => !excludeMessageIds.has(messageId))
      .slice(0, POLICY_RECONCILIATION_LIST_SIZE);

    const labels = await gmailService.listLabels(accessToken);
    const labelNameById = new Map(labels.map((l) => [l.id, l.name]));

    const noLongerEligible = [];
    for (const messageId of candidates) {
      let meta;
      try {
        meta = await gmailService.getMessageMetadata({ accessToken, messageId });
      } catch (err) {
        continue; // gone / transient failure — leave it for a future pass, don't fail the sync
      }

      const hasLabel = Boolean(emailConnectionRow.managed_label_id) && meta.labelIds.includes(emailConnectionRow.managed_label_id);
      const labelsOrFolders = meta.labelIds.map((id) => labelNameById.get(id)).filter(Boolean);
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
      if (!decision.eligible) noLongerEligible.push(messageId);
    }
    if (noLongerEligible.length === 0) return [];

    return await tombstoneMessages({
      aikbService, emailSyncRepo, clientId, emailConnectionRow, syncRunId,
      messageIds: noLongerEligible,
      reason: 'No longer matches organization policy.',
      outcome: 'tombstoned_policy_change',
    });
  } catch (err) {
    console.error('[emailSyncService] policy-change reconciliation failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * Restore-path counterpart to reconcilePolicyChanges above — fixes a gap
 * where a message tombstoned by an org policy edit could never come back
 * even after a LATER policy edit made it match again. reconcilePolicyChanges
 * only ever walks forward (ingested -> tombstoned); nothing previously
 * walked backward. Restoring isn't a cheap status flip: tombstoning hard-
 * deletes the message's indexed chunks and its uploaded file, so "restore"
 * means re-running the exact same body-fetch -> normalize -> ingest pipeline
 * processCandidateMessage uses for a brand-new message, just re-invoked for
 * a specific previously-tombstoned messageId (AIKB's ingest already handles
 * re-ingesting an existing document id correctly — proven in
 * EM10_5_STAGING_CHECKLIST.md Bugs 7/8/9).
 *
 * Candidates come from getTombstonedPolicyChangeMessageIds (latest event
 * outcome == 'tombstoned_policy_change' — see its own doc comment for why
 * that has to be a "latest," not "any," check). Bounded by the same
 * POLICY_RECONCILIATION_LIST_SIZE cap reconcilePolicyChanges uses, for the
 * same reason (one Gmail metadata re-fetch per candidate, no cheaper bulk
 * check exists). Best-effort and non-fatal, same as reconcilePolicyChanges:
 * a re-fetch/normalize/ingest failure for one message is skipped, not
 * retried in this same pass, and never fails the sync run that triggered it
 * — a later sync gets another chance.
 */
async function reconcilePolicyRestorations({ gmailService, emailPolicyService, emailNormalizationService, emailSyncRepo, aikbService, clientId, emailConnectionRow, accessToken, rules, syncRunId, excludeMessageIds = new Set() }) {
  try {
    const tombstonedByPolicy = await emailSyncRepo.getTombstonedPolicyChangeMessageIds(emailConnectionRow);
    if (tombstonedByPolicy.length === 0) return [];

    const candidates = tombstonedByPolicy
      .filter((messageId) => !excludeMessageIds.has(messageId))
      .slice(0, POLICY_RECONCILIATION_LIST_SIZE);
    if (candidates.length === 0) return [];

    const labels = await gmailService.listLabels(accessToken);
    const labelNameById = new Map(labels.map((l) => [l.id, l.name]));

    const restored = [];
    const events = [];
    for (const messageId of candidates) {
      let meta;
      try {
        meta = await gmailService.getMessageMetadata({ accessToken, messageId });
      } catch (err) {
        continue; // gone / transient failure — leave it tombstoned, a future pass retries
      }

      const hasLabel = Boolean(emailConnectionRow.managed_label_id) && meta.labelIds.includes(emailConnectionRow.managed_label_id);
      const labelsOrFolders = meta.labelIds.map((id) => labelNameById.get(id)).filter(Boolean);
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
      if (!decision.eligible) continue; // still doesn't match — stays tombstoned

      try {
        const body = await gmailService.getMessageBody({ accessToken, messageId });
        const normalized = emailNormalizationService.normalizeEmailBody({ html: body.html, text: body.text });
        if (!normalized) continue; // no extractable text — stays tombstoned, a future pass retries

        const matchedRule = (rules || []).find((r) => r.id === decision.matchedRuleId);
        const destinationCollectionId = matchedRule ? matchedRule.destinationCollectionId : null;

        await aikbService.uploadAndIngest(buildEmailIngestPayload({
          clientId, emailConnectionRow, messageId, meta, normalized, labelsOrFolders,
          matchedRuleId: decision.matchedRuleId, destinationCollectionId,
        }));

        restored.push({ messageId, subject: meta.subject });
        events.push({
          sync_run_id: syncRunId,
          email_connection_id: emailConnectionRow.id,
          provider_message_id: messageId,
          outcome: 'restored_policy_change',
          matched_rule_id: decision.matchedRuleId,
          reason: 'Now matches organization policy again.',
        });
      } catch (err) {
        console.error('[emailSyncService] policy restoration ingest failed:', messageId, err.message);
      }
    }
    if (events.length > 0) await emailSyncRepo.recordEvents(events);
    return restored;
  } catch (err) {
    console.error('[emailSyncService] policy restoration reconciliation failed (non-fatal):', err.message);
    return [];
  }
}

/**
 * One bounded page of historical import (EM6 — §17): compiles the fixed
 * manual-mode label query, lists a page of candidates, and runs each
 * through the shared eligibility/ingest pipeline.
 */
async function runHistoricalPage(deps) {
  const { gmailService, clientId, emailConnectionRow, accessToken, pageToken, rules, syncRunId } = deps;

  const query = gmailService.compileSearchQuery();
  const listResult = await gmailService.listMessageIdsByQuery({ accessToken, query, pageToken, maxResults: HISTORICAL_PAGE_SIZE });

  const counts = { scanned: 0, matched: 0, ingested: 0, skipped: 0, duplicate: 0, failed: 0 };
  const events = [];
  const imported = [];
  const skipped = [];
  const failed = [];

  let labelNameById = new Map();
  if (listResult.messageIds.length > 0) {
    const labels = await gmailService.listLabels(accessToken);
    labelNameById = new Map(labels.map((l) => [l.id, l.name]));
  }

  for (const messageId of listResult.messageIds) {
    await processOneCandidate(
      { ...deps, clientId, emailConnectionRow, accessToken, rules, labelNameById, syncRunId },
      { messageId, counts, events, imported, skipped, failed }
    );
  }

  return { counts, events, imported, skipped, failed, reconciled: [], nextPageToken: listResult.nextPageToken || null, newCursor: null };
}

/**
 * One bounded page of incremental sync (EM7 — §18): reduces the History
 * API's ordered change list to one final action per message (last-write-
 * wins — a message labeled then unlabeled again within the same page nets
 * out to "removed," and vice versa), runs newly-labeled candidates through
 * the shared eligibility/ingest pipeline, and tombstones anything reported
 * `labelRemoved`/`messageDeleted` immediately — no separate full-list
 * reconciliation pass needed (§18.4).
 *
 * @param {object} [deps.prefetched] - an already-fetched listHistory result
 *   for this exact page, when the caller already made the call itself (the
 *   fresh-sync cursor-expiry probe in syncConnection) — avoids a duplicate
 *   network call. Only ever set for the FIRST page of a fresh incremental
 *   sync; every resumed page fetches its own.
 */
async function runIncrementalPage(deps) {
  const { gmailService, emailSyncRepo, clientId, emailConnectionRow, accessToken, startHistoryId, pageToken, rules, syncRunId, prefetched } = deps;

  const historyResult = prefetched || await gmailService.listHistory({
    accessToken,
    startHistoryId,
    labelId: emailConnectionRow.managed_label_id,
    pageToken,
    maxResults: HISTORICAL_PAGE_SIZE,
  });

  // Bug fix (EM10.5 Scenario 3 regression): a `labelRemoved` change only
  // signals that OUR managed label was removed if `labelIds` actually names
  // it — Gmail's labelId-scoped history feed can still surface removal of a
  // completely unrelated label (most commonly `UNREAD`, removed simply by
  // opening the message in Gmail) bundled in for a message that also
  // happens to carry the managed label. An event that doesn't name the
  // managed label is noise, not a removal signal, and must be dropped
  // before the last-write-wins reduction below — otherwise it can wrongly
  // overwrite a real 'labelAdded' action, or wrongly tombstone a message
  // whose managed label was never actually removed.
  const finalActionByMessage = new Map();
  for (const change of historyResult.changes) {
    if (change.type === 'labelRemoved') {
      const removedManagedLabel = Boolean(emailConnectionRow.managed_label_id)
        && change.labelIds.includes(emailConnectionRow.managed_label_id);
      if (!removedManagedLabel) continue;
    }
    finalActionByMessage.set(change.messageId, change.type);
  }

  const toIngest = [];
  const toRemoveLabelRemoved = [];
  const toRemoveDeleted = [];
  for (const [messageId, type] of finalActionByMessage.entries()) {
    if (type === 'labelAdded') toIngest.push(messageId);
    else if (type === 'messageDeleted') toRemoveDeleted.push(messageId);
    else toRemoveLabelRemoved.push(messageId);
  }

  const counts = { scanned: 0, matched: 0, ingested: 0, skipped: 0, duplicate: 0, failed: 0 };
  const events = [];
  const imported = [];
  const skipped = [];
  const failed = [];

  let labelNameById = new Map();
  if (toIngest.length > 0) {
    const labels = await gmailService.listLabels(accessToken);
    labelNameById = new Map(labels.map((l) => [l.id, l.name]));
  }

  for (const messageId of toIngest) {
    await processOneCandidate(
      { ...deps, clientId, emailConnectionRow, accessToken, rules, labelNameById, syncRunId },
      { messageId, counts, events, imported, skipped, failed }
    );
  }

  const reconciled = [
    ...(await tombstoneMessages({
      aikbService: deps.aikbService, emailSyncRepo, clientId, emailConnectionRow, syncRunId,
      messageIds: toRemoveLabelRemoved,
      reason: 'Relativity/Knowledge label removed since last sync.',
    })),
    ...(await tombstoneMessages({
      aikbService: deps.aikbService, emailSyncRepo, clientId, emailConnectionRow, syncRunId,
      messageIds: toRemoveDeleted,
      reason: 'Message deleted at the provider since last sync.',
    })),
  ];

  return {
    counts, events, imported, skipped, failed, reconciled,
    nextPageToken: historyResult.nextPageToken || null,
    newCursor: historyResult.historyId || null,
  };
}

/**
 * @param {object} [deps] — injected for testing; each defaults to the real singleton service.
 */
function createEmailSyncService({
  gmailService = defaultGmailService,
  emailPolicyService = defaultEmailPolicyService,
  emailNormalizationService = defaultEmailNormalizationService,
  aikbService = defaultAikbService,
  emailSyncRepo = defaultEmailSyncRepo,
  maxDocuments = limits.maxDocuments,
} = {}) {
  /**
   * Runs one bounded page of sync for a connection — historical (EM6) or
   * incremental (EM7), decided automatically from the connection's stored
   * cursor on a fresh call, or trusted from the caller on a resumed one.
   *
   * @param {string} clientId
   * @param {object} emailConnectionRow - email_connections row (needs id,
   *   member_id, mailbox_address, sync_mode, sync_enabled, managed_label_id).
   * @param {boolean} memberSearchEnabled - the connection's own member's
   *   client_members.search_enabled (§16's fail-closed gate).
   * @param {string} accessToken - a live, already-refreshed Gmail access
   *   token (emailConnectionService.getValidGmailAccessToken).
   * @param {string|null} [triggeredByMemberId] - the acting member for this
   *   specific sync click (§15.1).
   * @param {string|null} [pageToken] - continuation token from a prior call.
   * @param {'historical'|'incremental'|null} [runType] - REQUIRED when
   *   pageToken is set (resuming), to know which provider-call shape to
   *   continue; ignored/recomputed on a fresh call.
   * @returns {{syncRunId:string, runType:string, status:string, complete:boolean, nextPageToken:string|null, imported:object[], skipped:object[], failed:object[], reconciled:object[], errorSummary:string|null}}
   */
  async function syncConnection({
    clientId,
    emailConnectionRow,
    memberSearchEnabled,
    accessToken,
    triggeredByMemberId = null,
    pageToken = null,
    runType = null,
  }) {
    if (!clientId) throw new Error('syncConnection requires clientId');
    if (!emailConnectionRow) throw new Error('syncConnection requires emailConnectionRow');
    if (!accessToken) throw new Error('syncConnection requires accessToken');

    assertSyncAllowed({
      memberSearchEnabled,
      syncEnabled: emailConnectionRow.sync_enabled,
    });

    let resolvedRunType;
    let prefetchedHistoryPage = null;
    let startHistoryId = null;

    if (pageToken) {
      // Resuming a paginated run — trust the caller's runType (the route
      // only ever passes back exactly what a prior call of this same
      // function returned) rather than re-deriving it, since the stored
      // cursor may already have moved on for an unrelated reason by the
      // time a resumed page runs.
      if (runType !== 'historical' && runType !== 'incremental') {
        throw syncError(ERROR_CODES.INVALID_RESUME, 'Resuming a paginated sync requires the runType from the prior page.');
      }
      resolvedRunType = runType;
      if (resolvedRunType === 'incremental') {
        // Gmail's history.list requires startHistoryId on every page, not
        // only the first — re-read it rather than threading it through the
        // route/pageToken, since the stored cursor is guaranteed unchanged
        // until this same run finally completes (upsertSyncState below only
        // ever writes a new cursor once complete: true).
        const syncState = await emailSyncRepo.getSyncState(emailConnectionRow.id);
        startHistoryId = syncState && syncState.provider_cursor;
        if (!startHistoryId) {
          throw syncError(ERROR_CODES.INVALID_RESUME, 'Cannot resume an incremental sync — the connection has no stored cursor.');
        }
      }
    } else {
      // §17 item 6 — the existing per-client document-count ceiling,
      // checked once at the start of a fresh sync (not on a resumed page).
      const count = await countActiveDocuments(aikbService, clientId);
      if (count >= maxDocuments) {
        throw syncError(ERROR_CODES.DOCUMENT_LIMIT_REACHED, `Document limit reached (${maxDocuments} max). Delete some documents to sync more.`);
      }

      const syncState = await emailSyncRepo.getSyncState(emailConnectionRow.id);
      // Cursor validity additionally depends on a managed label existing to
      // scope against.
      const hasValidCursor = syncState && syncState.cursor_status === 'valid' && syncState.provider_cursor
        && emailConnectionRow.managed_label_id;

      if (hasValidCursor) {
        // Probe now, before creating a sync run, so a stale cursor can fall
        // back to historical without ever recording a spurious incremental
        // run (§18.4).
        try {
          prefetchedHistoryPage = await gmailService.listHistory({
            accessToken,
            startHistoryId: syncState.provider_cursor,
            labelId: emailConnectionRow.managed_label_id,
            maxResults: HISTORICAL_PAGE_SIZE,
          });
          resolvedRunType = 'incremental';
        } catch (err) {
          if (err.code === GMAIL_ERROR_CODES.HISTORY_EXPIRED) {
            await emailSyncRepo.markCursorExpired(emailConnectionRow.id);
            resolvedRunType = 'historical';
          } else {
            throw err; // a genuine failure — surface it, don't silently pick a path
          }
        }
      } else {
        resolvedRunType = 'historical';
      }
    }

    const { rules } = await emailPolicyService.getPolicy(clientId);

    const syncRun = await emailSyncRepo.createSyncRun({
      clientId,
      emailConnectionId: emailConnectionRow.id,
      runType: resolvedRunType,
      triggeredByMemberId,
    });
    const startedAt = new Date().toISOString();
    if (!pageToken && resolvedRunType === 'historical') {
      await emailSyncRepo.updateHistoricalImportStatus(emailConnectionRow.id, 'running');
    }

    let pageOutcome;
    let runStatus = 'completed';
    let errorSummary = null;

    try {
      if (resolvedRunType === 'incremental') {
        pageOutcome = await runIncrementalPage({
          gmailService, emailPolicyService, emailNormalizationService, aikbService, emailSyncRepo,
          clientId, emailConnectionRow, accessToken, pageToken, rules, syncRunId: syncRun.id,
          startHistoryId, prefetched: prefetchedHistoryPage,
        });
      } else {
        pageOutcome = await runHistoricalPage({
          gmailService, emailPolicyService, emailNormalizationService, aikbService, emailSyncRepo,
          clientId, emailConnectionRow, accessToken, pageToken, rules, syncRunId: syncRun.id,
        });
      }
    } catch (err) {
      // A page-level failure (e.g. the list call itself, after the initial
      // probe above already succeeded) fails the whole run — individual
      // message failures are already caught inside processOneCandidate and
      // never reach here (§17 item 5).
      runStatus = 'failed';
      errorSummary = err.message;
      pageOutcome = {
        counts: { scanned: 0, matched: 0, ingested: 0, skipped: 0, duplicate: 0, failed: 0 },
        events: [], imported: [], skipped: [], failed: [], reconciled: [], nextPageToken: null, newCursor: null,
      };
    }

    if (runStatus !== 'failed' && pageOutcome.counts.failed > 0) runStatus = 'partial';
    const complete = runStatus === 'failed' || !pageOutcome.nextPageToken;

    let extraReconciled = [];
    if (complete && runStatus !== 'failed' && resolvedRunType === 'historical') {
      extraReconciled = await reconcileRemovedLabelsFullList({
        gmailService, emailSyncRepo, aikbService, clientId, emailConnectionRow, accessToken, syncRunId: syncRun.id,
      });
    }
    // EM9 (§24.5, §28.1) — policy-change reconciliation runs for both run
    // types (unlike the label-removal pass above), only gated on the run
    // having completed successfully — see reconcilePolicyChanges' own doc
    // comment for why this can't be scoped to historical only.
    // excludeMessageIds prevents a double-tombstone of anything already
    // tombstoned this same sync. Bug fix (EM10.5 Scenario 3 regression):
    // this previously only included extraReconciled (historical's full-list
    // pass) and missed pageOutcome.reconciled — an INCREMENTAL run's own
    // per-page labelRemoved/messageDeleted tombstones, done inline inside
    // runIncrementalPage — so a message that pass already tombstoned could
    // still be re-evaluated and tombstoned a second time here. historical's
    // pageOutcome.reconciled is always [] (its reconciliation is the
    // extraReconciled branch above), so this is a no-op there — the gap was
    // incremental-only.
    let restored = [];
    if (complete && runStatus !== 'failed') {
      const alreadyReconciledIds = new Set([
        ...pageOutcome.reconciled.map((r) => r.messageId),
        ...extraReconciled.map((r) => r.messageId),
      ]);
      extraReconciled = [
        ...extraReconciled,
        ...(await reconcilePolicyChanges({
          gmailService, emailPolicyService, emailSyncRepo, aikbService, clientId, emailConnectionRow, accessToken, rules, syncRunId: syncRun.id,
          excludeMessageIds: alreadyReconciledIds,
        })),
      ];
      // Restore-path counterpart, run right alongside policy-change
      // tombstoning above — same gating (both sync modes, both run types),
      // since a policy revert needs to be caught regardless of which run
      // type happened to execute it. See reconcilePolicyRestorations' own
      // doc comment for why this direction was previously entirely missing.
      restored = await reconcilePolicyRestorations({
        gmailService, emailPolicyService, emailNormalizationService, emailSyncRepo, aikbService, clientId, emailConnectionRow, accessToken, rules, syncRunId: syncRun.id,
        excludeMessageIds: alreadyReconciledIds,
      });
    }
    const reconciled = [...pageOutcome.reconciled, ...extraReconciled];

    await emailSyncRepo.recordEvents(pageOutcome.events);
    await emailSyncRepo.completeSyncRun(syncRun.id, { status: runStatus, counts: pageOutcome.counts, errorSummary });
    if (complete && resolvedRunType === 'historical') {
      await emailSyncRepo.updateHistoricalImportStatus(emailConnectionRow.id, runStatus === 'failed' ? 'failed' : 'completed');
    }

    // Cursor lifecycle (§18.2): a successful, complete run of EITHER type
    // establishes/refreshes a valid cursor so the NEXT sync can go
    // incremental — an incremental page's own response already carries the
    // new historyId; a historical completion (fresh or fallback) has to ask
    // for one explicitly via getMailboxHistoryId.
    if (complete && runStatus !== 'failed') {
      let newCursor = pageOutcome.newCursor;
      if (!newCursor) {
        try {
          const profile = await gmailService.getMailboxHistoryId(accessToken);
          newCursor = profile.historyId;
        } catch (err) {
          console.error('[emailSyncService] could not establish a fresh cursor after sync (non-fatal):', err.message);
        }
      }
      await emailSyncRepo.upsertSyncState(emailConnectionRow.id, {
        lastSyncStartedAt: startedAt,
        lastSyncCompletedAt: new Date().toISOString(),
        lastSyncStatus: runStatus,
        ...(newCursor ? { providerCursor: newCursor, cursorStatus: 'valid', cursorObtainedAt: new Date().toISOString() } : {}),
      });
    } else {
      await emailSyncRepo.upsertSyncState(emailConnectionRow.id, {
        lastSyncStartedAt: startedAt,
        lastSyncCompletedAt: complete ? new Date().toISOString() : null,
        lastSyncStatus: runStatus,
      });
    }

    return {
      syncRunId: syncRun.id,
      runType: resolvedRunType,
      status: runStatus,
      complete,
      nextPageToken: pageOutcome.nextPageToken || null,
      imported: pageOutcome.imported,
      skipped: pageOutcome.skipped,
      failed: pageOutcome.failed,
      reconciled,
      restored,
      errorSummary,
    };
  }

  /**
   * GET .../sync-runs (§27, §31 EM7 Frontend) — recent sync-run history for
   * a connection, newest first.
   */
  async function listSyncRuns(emailConnectionId, limit = 10) {
    if (!emailConnectionId) throw new Error('listSyncRuns requires emailConnectionId');
    return emailSyncRepo.listRecentSyncRuns(emailConnectionId, limit);
  }

  // EM10.6 removed runTick (and the AIKB cron tick / POST /sync/tick route
  // that called it) along with automatic mode itself — see
  // EMAIL_INGESTION.md's EM10.6 record. syncConnection above is now driven
  // exclusively by a member's own "Sync now" click.

  return { syncConnection, listSyncRuns };
}

const defaultService = createEmailSyncService();

module.exports = {
  ...defaultService,
  createEmailSyncService,
  assertSyncAllowed,
  ERROR_CODES,
  HISTORICAL_PAGE_SIZE,
  RECONCILIATION_LIST_SIZE,
  POLICY_RECONCILIATION_LIST_SIZE,
  reduceToLatestOutcomePerMessage,
};
