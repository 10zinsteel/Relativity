const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// EM10.7 — Pause/Resume Sync removal (Architecture/architecture/
// EMAIL_INGESTION.md's EM10.7 record). Static, text-level assertions
// against the migration's SQL, matching the convention established by
// test/emailIngestionEm1Migration.test.js / emailIngestionEm8Migration.test.js
// / emailIngestionEm9Migration.test.js / emailIngestionEm10_6Migration.test.js
// — no test-database pattern exists anywhere in this repo for any migration.

const EM10_7_MIGRATION_PATH = path.join(__dirname, '..', 'supabase', 'migrations', '20260829_email_ingestion_em10_7_remove_pause_resume.sql');
const EM10_7_SQL = fs.readFileSync(EM10_7_MIGRATION_PATH, 'utf8');

test('normalizes any surviving paused sync_mode to manual_selected before tightening the CHECK constraint', () => {
  assert.match(
    EM10_7_SQL,
    /UPDATE email_connections\s*\n\s*SET sync_mode = 'manual_selected'[\s\S]*?WHERE sync_mode = 'paused';/,
    'must normalize sync_mode=\'paused\' rows before the CHECK constraint would reject them'
  );
});

test('email_connections.sync_mode CHECK is tightened to allow only manual_selected, via DROP+ADD CONSTRAINT (idempotent)', () => {
  assert.match(
    EM10_7_SQL,
    /ALTER TABLE email_connections\s*\n\s*DROP CONSTRAINT IF EXISTS email_connections_sync_mode_check;/,
    'must drop the old constraint IF EXISTS before recreating it'
  );
  assert.match(
    EM10_7_SQL,
    /CHECK \(sync_mode IN \('manual_selected'\)\)/,
    'the tightened CHECK must allow only manual_selected — paused is no longer representable'
  );
});

test('drops email_connections.pre_pause_sync_mode, guarded IF EXISTS', () => {
  assert.match(
    EM10_7_SQL,
    /ALTER TABLE email_connections\s*\n\s*DROP COLUMN IF EXISTS pre_pause_sync_mode;/,
    'must drop pre_pause_sync_mode IF EXISTS — schema drift means it may not exist in every environment'
  );
});

test('the migration touches only email_connections, and drops no table', () => {
  const alterStatements = Array.from(new Set(EM10_7_SQL.match(/ALTER TABLE \w+/g) || []));
  assert.deepEqual(
    alterStatements.sort(),
    ['ALTER TABLE email_connections'],
    'EM10.7 should only ever ALTER email_connections'
  );
  assert.doesNotMatch(EM10_7_SQL, /DROP TABLE/i, 'EM10.7 must not drop a table — only a column/constraint scoped to pause/resume');
});
