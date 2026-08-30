-- Migration: 20260829_email_ingestion_em10_7_remove_pause_resume
-- EM10.7 — Pause/Resume Sync removal
-- (Architecture/architecture/EMAIL_INGESTION.md's EM10.7 record).
--
-- Product decision: the EM8 pause/resume lifecycle control (POST
-- /connections/:id/pause, /resume) is removed. It existed to let a member
-- stop syncing temporarily without a full OAuth reconnect, but it created a
-- confusing third "stop syncing" mechanism alongside Disconnect and EM9's
-- offboard_client_member cascade (which forces sync_enabled=false with no
-- resume path of its own — see EMAIL_INGESTION.md's EM10.7 record for the
-- specific gap that prompted this). Going forward there is exactly one way
-- to stop syncing: Disconnect. This migration normalizes any surviving
-- 'paused' state to 'manual_selected' and then tightens schema to make
-- 'paused' permanently unrepresentable, and drops the column that existed
-- solely to support resume's "restore prior mode" behavior.
--
-- Verified against live data before writing this migration (Supabase MCP,
-- 2026-08-29): zero email_connections rows have sync_mode = 'paused'. The
-- normalization statement below is therefore defensive/forward-safe, not a
-- real-data backfill — but this migration must still work correctly against
-- any environment where that is not the case.
--
-- Schema-drift note: as EM10.6's migration already found for this same
-- table, live production schema was verified directly rather than assumed
-- from tracked migration files. email_connections.pre_pause_sync_mode
-- (added by 20260725_email_ingestion_em8.sql) is confirmed NOT present on
-- the live Global database, consistent with EM10.6's own finding. The DROP
-- COLUMN below is guarded (IF EXISTS) and is a safe no-op in that
-- environment; it is not a real-data-loss operation there.
--
-- Safe to run multiple times (DROP CONSTRAINT/COLUMN IF EXISTS throughout).

-- ─────────────────────────────────────────────
-- 1. Normalize any surviving 'paused' sync_mode to 'manual_selected'.
-- ─────────────────────────────────────────────
UPDATE email_connections
   SET sync_mode = 'manual_selected',
       updated_at = now()
 WHERE sync_mode = 'paused';

-- ─────────────────────────────────────────────
-- 2. Tighten email_connections.sync_mode — 'paused' is no longer a
--    representable value. Statement 1 above guarantees no row can violate
--    this before it's applied. 'manual_selected' is now the only legal
--    value (EM10.6 already removed 'automatic').
-- ─────────────────────────────────────────────
ALTER TABLE email_connections
  DROP CONSTRAINT IF EXISTS email_connections_sync_mode_check;
ALTER TABLE email_connections
  ADD CONSTRAINT email_connections_sync_mode_check
    CHECK (sync_mode IN ('manual_selected'));

-- ─────────────────────────────────────────────
-- 3. Drop email_connections.pre_pause_sync_mode — populated and read only
--    by pauseConnection/resumeConnection (both removed). No application
--    code references this column after this milestone. Guarded IF EXISTS
--    per the schema-drift note above.
-- ─────────────────────────────────────────────
ALTER TABLE email_connections
  DROP COLUMN IF EXISTS pre_pause_sync_mode;
