-- Migration: 20260904_email_ingestion_policy_restoration
-- Fix: policy-tombstoned email documents had no restore path
-- (Architecture/architecture/EMAIL_INGESTION.md "Deletion, Retention, and
-- Lifecycle Behavior"; EM10_5_STAGING_CHECKLIST.md Part 2, Bug 12).
--
-- No new table or column — one widened CHECK constraint, following the
-- exact EM9 pattern (20260725_email_ingestion_em9.sql).
--
-- Safe to run multiple times (DROP CONSTRAINT IF EXISTS). Purely additive:
-- applies cleanly to the current schema; no existing row is rewritten.

-- ─────────────────────────────────────────────
-- email_ingestion_events.outcome — add 'restored_policy_change'.
--
-- reconcilePolicyChanges (services/emailSyncService.js) tombstones a
-- message when an org policy edit makes it stop matching
-- ('tombstoned_policy_change'), but nothing previously walked the other
-- direction: a message re-evaluated after a later policy edit that makes it
-- match again. The new reconcilePolicyRestorations pass re-ingests such
-- messages and records this new outcome — kept distinct from a plain
-- 'ingested' event so the audit trail (§27) can tell "first ingest" apart
-- from "re-ingested after a policy-caused tombstone."
-- ─────────────────────────────────────────────
-- Full set below matches the live constraint definition (verified via
-- pg_get_constraintdef) plus the one new value — not just the EM1/EM9
-- migration files' own history, since the EL4/EL6 live-lookup migrations
-- also widened this same constraint (adding 'live_lookup_search'/
-- 'live_lookup_fetch') without a corresponding tracked migration name.
ALTER TABLE email_ingestion_events
  DROP CONSTRAINT IF EXISTS email_ingestion_events_outcome_check;
ALTER TABLE email_ingestion_events
  ADD CONSTRAINT email_ingestion_events_outcome_check
    CHECK (outcome IN
      ('ingested', 'excluded_no_matching_rule', 'excluded_deny_listed',
       'excluded_not_labeled', 'duplicate', 'skipped_size_limit', 'failed',
       'tombstoned_label_removed', 'tombstoned_policy_change',
       'live_lookup_search', 'live_lookup_fetch',
       'restored_policy_change'));
