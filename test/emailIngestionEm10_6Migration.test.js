const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// EM10.6 — Automatic Email Ingestion removal (Architecture/architecture/
// EMAIL_INGESTION.md's EM10.6 record). Static, text-level assertions
// against the migration's SQL, matching the convention established by
// test/emailIngestionEm1Migration.test.js / emailIngestionEm8Migration.test.js
// / emailIngestionEm9Migration.test.js — no test-database pattern exists
// anywhere in this repo for any migration.

const EM10_6_MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260826_email_ingestion_em10_6_remove_automatic.sql');
const EM10_6_SQL = fs.readFileSync(EM10_6_MIGRATION_PATH, 'utf8');

test('normalizes any surviving automatic sync_mode to manual_selected before tightening the CHECK constraint', () => {
  assert.match(
    EM10_6_SQL,
    /UPDATE email_connections\s*\n\s*SET sync_mode = 'manual_selected'[\s\S]*?WHERE sync_mode = 'automatic';/,
    'must normalize sync_mode=\'automatic\' rows before the CHECK constraint would reject them'
  );
});

test('normalizes pre_pause_sync_mode defensively, guarded by an information_schema existence check', () => {
  assert.match(
    EM10_6_SQL,
    /IF EXISTS \(\s*\n\s*SELECT 1 FROM information_schema\.columns\s*\n\s*WHERE table_name = 'email_connections' AND column_name = 'pre_pause_sync_mode'/,
    'must not assume pre_pause_sync_mode exists — EM8\'s own migration adding it was found not to be applied in production (schema drift, see this migration\'s header comment)'
  );
  assert.match(EM10_6_SQL, /pre_pause_sync_mode = 'manual_selected'/, 'must normalize a legacy automatic pre_pause_sync_mode when the column exists');
});

test('email_connections.sync_mode CHECK is tightened to drop automatic, via DROP+ADD CONSTRAINT (idempotent)', () => {
  assert.match(
    EM10_6_SQL,
    /ALTER TABLE email_connections\s*\n\s*DROP CONSTRAINT IF EXISTS email_connections_sync_mode_check;/,
    'must drop the old constraint IF EXISTS before recreating it'
  );
  assert.match(
    EM10_6_SQL,
    /CHECK \(sync_mode IN \('manual_selected', 'paused'\)\)/,
    'the tightened CHECK must allow only manual_selected and paused — automatic is no longer representable'
  );
});

test('drops email_organization_settings.automatic_sync_enabled, but never touches live_lookup_enabled', () => {
  assert.match(
    EM10_6_SQL,
    /ALTER TABLE email_organization_settings\s*\n\s*DROP COLUMN IF EXISTS automatic_sync_enabled;/,
    'must drop automatic_sync_enabled IF EXISTS'
  );
  assert.doesNotMatch(EM10_6_SQL, /DROP COLUMN IF EXISTS live_lookup_enabled/, 'must never drop live_lookup_enabled — EL4/EL6\'s independent org-wide switch');
});

test('drops email_sync_state.next_sync_due_at', () => {
  assert.match(
    EM10_6_SQL,
    /ALTER TABLE email_sync_state\s*\n\s*DROP COLUMN IF EXISTS next_sync_due_at;/,
    'must drop next_sync_due_at IF EXISTS'
  );
});

test('the migration touches only the four tables Automatic Email Ingestion actually used, and drops no table', () => {
  const alterStatements = Array.from(new Set(EM10_6_SQL.match(/ALTER TABLE \w+/g) || []));
  assert.deepEqual(
    alterStatements.sort(),
    ['ALTER TABLE email_connections', 'ALTER TABLE email_organization_settings', 'ALTER TABLE email_sync_state'].sort(),
    'EM10.6 should only ever ALTER email_connections/email_organization_settings/email_sync_state'
  );
  assert.doesNotMatch(EM10_6_SQL, /DROP TABLE/i, 'EM10.6 must not drop a table — only columns/constraints scoped to Automatic Email Ingestion');
});
