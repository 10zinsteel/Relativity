-- Migration: 20260909_email_ingestion_bug6_sync_summary
-- Fix: EM10.5 Bug 6 — the portal's sync-run summary (email_sync_runs) only
-- ever tracked ingest-side counts (messages_scanned/matched/ingested/
-- skipped/duplicate/failed). A sync that tombstoned or restored documents
-- via reconciliation (services/emailSyncService.js's
-- reconcileRemovedLabelsFullList / reconcilePolicyChanges /
-- reconcilePolicyRestorations) displayed "0 imported, 0 skipped, 0 failed"
-- with no visible sign anything happened — the only evidence lived in
-- email_ingestion_events, never surfaced in the portal UI
-- (EM10_5_STAGING_CHECKLIST.md Part 2, Bug 6).
--
-- Purely additive: two new NOT NULL DEFAULT 0 columns. No existing row is
-- rewritten (their historical reconciliation activity, if any, simply isn't
-- retroactively counted — same tradeoff every other EM10.5 bug fix made for
-- data already written before the fix).

ALTER TABLE email_sync_runs
  ADD COLUMN IF NOT EXISTS messages_reconciled integer NOT NULL DEFAULT 0, -- tombstoned this run (label removed or policy stopped matching)
  ADD COLUMN IF NOT EXISTS messages_restored    integer NOT NULL DEFAULT 0; -- re-ingested this run (a policy edit made a tombstoned message match again)
