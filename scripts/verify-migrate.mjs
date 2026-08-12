#!/usr/bin/env node
// End-to-end verification of the migration runner (§57, §82).
//
// Boots a real Postgres wire-protocol server (PGlite behind a socket), then runs
// scripts/migrate.mjs against it as a separate process — the same script, the
// same driver, the same TCP path production uses. Asserts:
//
//   1. --status on an empty database reports the migration as PENDING
//   2. the run applies it and reports the tables that now exist
//   3. a second run is a no-op (idempotent)
//   4. editing an applied migration is REFUSED (drift protection)
//
//   node scripts/verify-migrate.mjs

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const PORT = 5433 + (process.pid % 500);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
// Derived, not hard-coded: adding a migration must not silently break the
// verification of the runner that applies them.
const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();
const LATEST = `drizzle/${MIGRATIONS[MIGRATIONS.length - 1]}`;
const EXPECTED_TABLES = 14;

function run(cmd, args, env = {}) {
  return new Promise((resolve) => {
    // No shell: process.execPath contains spaces on Windows ("C:\Program Files\...")
    // and a shell would split it. We spawn node directly, so none is needed.
    const p = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

const server = spawn(process.execPath, ['scripts/pg-testserver.mjs', String(PORT)]);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not start')), 30000);
  server.stdout.on('data', (d) => {
    if (String(d).includes('ready on')) { clearTimeout(timer); resolve(); }
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
});

const original = readFileSync(LATEST, 'utf8');
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

try {
  const status = await run(process.execPath, ['scripts/migrate.mjs', '--status'], { DATABASE_URL: URL });
  const allListed = MIGRATIONS.every((m) => status.out.includes(`PENDING  ${m}`));
  check(`status reports all ${MIGRATIONS.length} migration(s) pending on an empty database`,
    status.code === 0 && allListed && status.out.includes(`${MIGRATIONS.length} migration(s) pending`),
    status.out.trim());

  const apply = await run(process.execPath, ['scripts/migrate.mjs'], { DATABASE_URL: URL });
  check('applies every migration and reports the tables created',
    apply.code === 0 &&
      apply.out.includes(`Applied ${MIGRATIONS.length} migration`) &&
      apply.out.includes('persons') &&
      apply.out.includes('audit_events'),
    apply.out.trim());

  const tableCount = Number((apply.out.match(/Tables in public \((\d+)\)/) || [])[1] || 0);
  check(`all ${EXPECTED_TABLES} federation tables exist`, tableCount === EXPECTED_TABLES, `found ${tableCount}`);

  const again = await run(process.execPath, ['scripts/migrate.mjs'], { DATABASE_URL: URL });
  check('a second run is a no-op',
    again.code === 0 && /nothing to apply/.test(again.out),
    again.out.trim());

  writeFileSync(LATEST, original + '\n-- drift\n');
  const drift = await run(process.execPath, ['scripts/migrate.mjs'], { DATABASE_URL: URL });
  check('refuses an applied migration that was edited afterwards',
    drift.code === 1 && /ALTERED AFTER APPLY/.test(drift.out),
    drift.out.trim());
} finally {
  writeFileSync(LATEST, original);
  server.kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
