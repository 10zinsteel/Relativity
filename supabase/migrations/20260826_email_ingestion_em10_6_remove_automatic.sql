-- Migration: 20260826_email_ingestion_em10_6_remove_automatic
-- EM10.6 — Automatic Email Ingestion removal
-- (Architecture/architecture/EMAIL_INGESTION.md's EM10.6 record).
--
-- Product decision: Automatic Email Ingestion (EM8 — a label-free sync mode
-- that ingested any policy-matching message on an unattended cron tick) is
-- removed from V1. Gmail ingestion is label-driven only: a member applies
-- the managed Relativity/Knowledge label, then policy is evaluated, then
-- eligible content is ingested. This migration normalizes any surviving
-- 'automatic' state to 'manual_selected' and then tightens schema to make
-- 'automatic' permanently unrepresentable, and drops the two columns that
-- existed solely to support automatic mode.
--
-- Verified against live data before writing this migration (Supabase MCP,
-- 2026-08-26): all 9 email_connections rows are already 'manual_selected'
-- (zero 'automatic' rows exist); email_organization_settings has zero rows
-- at all (automatic_sync_enabled was never turned on for any client); zero
-- email_sync_state rows have next_sync_due_at set. The normalization
-- statements below are therefore defensive/forward-safe, not a real-data
-- backfill — but this migration must still work correctly against any
-- environment (e.g. a fresh EM1-only database, or a differently-seeded
-- staging project) where that is not the case.
--
-- Schema-drift note (see Architecture/docs/audits/SCHEMA_DRIFT.md for the
-- existing audit of unrelated drift): live production schema was verified
-- directly rather than assumed from tracked migration files, because
-- 20260725_email_ingestion_em8.sql's own schema change
-- (email_connections.pre_pause_sync_mode) was found to NOT be present on
-- the live Global database, despite EM8/EM9 application code depending on
-- it and appearing (from the staging checklist) to have run successfully in
-- other respects. This migration does not assume pre_pause_sync_mode
-- exists — the normalization statement touching it is guarded so this
-- migration is safe to run whether or not that earlier gap has been
-- separately closed. That gap itself is NOT fixed here — it is unrelated to
-- Automatic Email Ingestion (pause/resume is a general lifecycle control,
-- not automatic-mode-specific) and is out of this migration's scope.
--
-- Safe to run multiple times (guarded DO blocks, DROP CONSTRAINT/COLUMN IF
-- EXISTS throughout).

-- ─────────────────────────────────────────────
-- 1. Normalize any surviving 'automatic' sync_mode to 'manual_selected'.
-- ─────────────────────────────────────────────
UPDATE email_connections
   SET sync_mode = 'manual_selected',
       updated_at = now()
 WHERE sync_mode = 'automatic';

-- ─────────────────────────────────────────────
-- 2. Normalize any surviving 'automatic' pre_pause_sync_mode, guarded —
--    see the schema-drift note above for why this column's existence
--    cannot be assumed.
-- ─────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'email_connections' AND column_name = 'pre_pause_sync_mode'
  ) THEN
    UPDATE email_connections
       SET pre_pause_sync_mode = 'manual_selected',
           updated_at = now()
     WHERE pre_pause_sync_mode = 'automatic';
  END IF;
END $$;

-- ─────────────────────────────────────────────
-- 3. Tighten email_connections.sync_mode — 'automatic' is no longer a
--    representable value. Statement 1 above guarantees no row can violate
--    this before it's applied.
-- ─────────────────────────────────────────────
ALTER TABLE email_connections
  DROP CONSTRAINT IF EXISTS email_connections_sync_mode_check;
ALTER TABLE email_connections
  ADD CONSTRAINT email_connections_sync_mode_check
    CHECK (sync_mode IN ('manual_selected', 'paused'));

-- ─────────────────────────────────────────────
-- 4. Drop email_organization_settings.automatic_sync_enabled — the org-wide
--    Automatic Email Ingestion switch. No application code reads or writes
--    this column after this milestone (emailPolicyService.js's
--    getSettings/updateSettings no longer reference it). live_lookup_enabled
--    on the same table is untouched — it is EL4/EL6's independent org-wide
--    live-lookup switch, not automatic-mode-specific.
-- ─────────────────────────────────────────────
ALTER TABLE email_organization_settings
  DROP COLUMN IF EXISTS automatic_sync_enabled;

-- ─────────────────────────────────────────────
-- 5. Drop email_sync_state.next_sync_due_at — populated and read only by
--    the automatic-mode tick handler (listDueAutomaticConnections,
--    removed) and the portal's "next automatic sync" display (removed). No
--    application code references this column after this milestone.
-- ─────────────────────────────────────────────
ALTER TABLE email_sync_state
  DROP COLUMN IF EXISTS next_sync_due_at;
