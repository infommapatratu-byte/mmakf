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
import { readFileSync, writeFileSync } from 'node:fs';

const PORT = 5433 + (process.pid % 500);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;
const MIGRATION = 'drizzle/0000_federation_core.sql';

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

const original = readFileSync(MIGRATION, 'utf8');
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
};

try {
  const status = await run(process.execPath, ['scripts/migrate.mjs', '--status'], { DATABASE_URL: URL });
  check('status reports the migration pending on an empty database',
    status.code === 0 && /PENDING\s+0000_federation_core\.sql/.test(status.out) && /1 migration\(s\) pending/.test(status.out),
    status.out.trim());

  const apply = await run(process.execPath, ['scripts/migrate.mjs'], { DATABASE_URL: URL });
  check('applies the migration and reports the tables created',
    apply.code === 0 && /Applied 1 migration/.test(apply.out) && /persons/.test(apply.out) && /audit_events/.test(apply.out),
    apply.out.trim());

  const tableCount = Number((apply.out.match(/Tables in public \((\d+)\)/) || [])[1] || 0);
  check('all 14 federation tables exist', tableCount === 14, `found ${tableCount}`);

  const again = await run(process.execPath, ['scripts/migrate.mjs'], { DATABASE_URL: URL });
  check('a second run is a no-op',
    again.code === 0 && /nothing to apply/.test(again.out),
    again.out.trim());

  writeFileSync(MIGRATION, original + '\n-- drift\n');
  const drift = await run(process.execPath, ['scripts/migrate.mjs'], { DATABASE_URL: URL });
  check('refuses an applied migration that was edited afterwards',
    drift.code === 1 && /ALTERED AFTER APPLY/.test(drift.out),
    drift.out.trim());
} finally {
  writeFileSync(MIGRATION, original);
  server.kill();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
