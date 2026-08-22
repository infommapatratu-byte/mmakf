#!/usr/bin/env node
// Backup and restore. Q-26.
//
//   npm run backup                    dump every table to a timestamped file
//   npm run backup -- --verify FILE   check a dump is complete and readable
//   npm run backup -- --restore FILE  restore into an EMPTY database
//
// Before this there was no backup path at all. A federation holding grading
// records, certificates and competition results has no acceptable answer to
// "what happens if the database is lost" other than a tested restore.
//
// WHY NOT pg_dump: it is not installed on every operator's machine, the version
// must match the server or it refuses, and it is absent from the deploy
// environment entirely. This uses the same driver the application uses, so if
// the application can reach the database, so can the backup.
//
// THE PART THAT MATTERS MOST IS --verify. An untested backup is not a backup, it
// is a file. Verification re-reads the dump, checks its checksum, confirms every
// expected table is present and reports the row counts, so an operator sees what
// they actually have before they need it.

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { tlsFor, tlsHint } from './db-tls.mjs';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Refusing to guess a target database.');
  process.exit(1);
}

const args = process.argv.slice(2);
const mode =
  args.includes('--restore') ? 'restore' :
  args.includes('--verify') ? 'verify' : 'backup';
const fileArg = args[args.indexOf(`--${mode}`) + 1];

const schema = process.env.DATABASE_SCHEMA || 'public';
// This reads the ENTIRE register into a file — every verified phone number,
// every child's address, every safeguarding note. It ran without an `ssl`
// option, and postgres.js ships `ssl: false`, so the whole thing crossed the
// network in the clear. tlsFor() is the same policy the application uses; see
// scripts/db-tls.mjs.
const sql = postgres(url, {
  max: 1, prepare: false, connect_timeout: 30, idle_timeout: 20,
  connection: { search_path: schema },
  onnotice: () => {},
  ...tlsFor(url),
});

function describeTarget(u) {
  try { const p = new URL(u); return `${p.host}${p.pathname}`; } catch { return 'unknown host'; }
}

/**
 * Tables in dependency order, so a restore never inserts a child before its
 * parent. Derived from the migrations rather than hardcoded: a new table added
 * to a migration is backed up automatically, which is the failure mode of every
 * hand-maintained backup list.
 */
async function tablesInDependencyOrder() {
  const rows = await sql`
    SELECT c.relname AS table_name,
           COALESCE(array_agg(DISTINCT f.relname) FILTER (WHERE f.relname IS NOT NULL), '{}') AS depends_on
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_constraint con ON con.conrelid = c.oid AND con.contype = 'f'
    LEFT JOIN pg_class f ON f.oid = con.confrelid AND f.oid <> c.oid
    WHERE n.nspname = ${schema} AND c.relkind = 'r' AND c.relname NOT LIKE '\\_%'
    GROUP BY c.relname
  `;

  const deps = new Map(rows.map((r) => [r.table_name, r.depends_on.filter((d) => d !== r.table_name)]));
  const ordered = [];
  const seen = new Set();

  // Depth-first over the FK graph. Cycles are broken by emitting on revisit —
  // Postgres permits circular references, and a backup must not refuse to run
  // because of one.
  const visit = (table, stack = new Set()) => {
    if (seen.has(table) || stack.has(table)) return;
    stack.add(table);
    for (const dep of deps.get(table) ?? []) visit(dep, stack);
    stack.delete(table);
    if (!seen.has(table)) { seen.add(table); ordered.push(table); }
  };
  for (const table of deps.keys()) visit(table);
  return ordered;
}

async function backup() {
  console.log(`Backing up ${describeTarget(url)} (schema: ${schema})\n`);

  const tables = await tablesInDependencyOrder();
  const migrations = await sql`SELECT name, checksum, applied_at FROM _mmakf_migrations ORDER BY name`
    .catch(() => []);

  const dump = {
    format: 'mmakf-backup-v1',
    takenAt: new Date().toISOString(),
    source: describeTarget(url),
    schema,
    // The migration state travels WITH the data. Restoring rows into a database
    // at a different schema version is how a restore appears to work and then
    // fails weeks later.
    migrations,
    tableOrder: tables,
    tables: {},
  };

  let total = 0;
  for (const table of tables) {
    const rows = await sql`SELECT * FROM ${sql(table)}`;
    dump.tables[table] = rows;
    total += rows.length;
    console.log(`  ${String(rows.length).padStart(7)}  ${table}`);
  }

  const body = JSON.stringify(dump);
  const checksum = createHash('sha256').update(body).digest('hex');
  const envelope = JSON.stringify({ checksum, rowCount: total, dump: JSON.parse(body) });

  mkdirSync('backups', { recursive: true });
  const name = `backups/mmakf-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(name, envelope);

  const sizeMb = (statSync(name).size / 1048576).toFixed(2);
  console.log(`\n${total} rows across ${tables.length} tables → ${name} (${sizeMb} MB)`);
  console.log(`sha256 ${checksum}`);
  console.log(`\nVERIFY IT NOW — an unverified backup is a file, not a backup:`);
  console.log(`  npm run backup -- --verify ${name}`);
}

function verify(path) {
  if (!path || !existsSync(path)) {
    console.error(`Usage: npm run backup -- --verify <file>`);
    process.exit(1);
  }

  console.log(`Verifying ${path}\n`);
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`UNREADABLE: ${err.message}`);
    console.error('This file cannot be restored.');
    process.exit(1);
  }

  const recomputed = createHash('sha256').update(JSON.stringify(envelope.dump)).digest('hex');
  const intact = recomputed === envelope.checksum;

  console.log(`  format      ${envelope.dump?.format ?? 'MISSING'}`);
  console.log(`  taken       ${envelope.dump?.takenAt ?? 'MISSING'}`);
  console.log(`  source      ${envelope.dump?.source ?? 'MISSING'}`);
  console.log(`  checksum    ${intact ? 'INTACT' : 'MISMATCH — the file has been altered or truncated'}`);
  console.log(`  migrations  ${(envelope.dump?.migrations ?? []).length} recorded`);

  const tables = Object.keys(envelope.dump?.tables ?? {});
  let counted = 0;
  const empty = [];
  for (const t of tables) {
    const n = envelope.dump.tables[t].length;
    counted += n;
    if (n === 0) empty.push(t);
  }

  console.log(`  tables      ${tables.length}`);
  console.log(`  rows        ${counted}${counted === envelope.rowCount ? '' : ` — MISMATCH, envelope claims ${envelope.rowCount}`}`);
  if (empty.length) console.log(`  empty       ${empty.length} table(s): ${empty.slice(0, 8).join(', ')}${empty.length > 8 ? ' …' : ''}`);

  const ok = intact && counted === envelope.rowCount && tables.length > 0;
  console.log(`\n${ok ? 'RESTORABLE.' : 'NOT RESTORABLE — do not rely on this file.'}`);
  if (!ok) process.exit(1);
}

async function restore(path) {
  if (!path || !existsSync(path)) {
    console.error('Usage: npm run backup -- --restore <file>');
    process.exit(1);
  }

  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  const recomputed = createHash('sha256').update(JSON.stringify(envelope.dump)).digest('hex');
  if (recomputed !== envelope.checksum) {
    console.error('CHECKSUM MISMATCH. Refusing to restore an altered or truncated file.');
    process.exit(1);
  }

  // A restore over live data would be an irreversible mistake made in a hurry,
  // which is precisely when restores happen. It is refused outright.
  const existing = await sql`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = ${schema} AND table_name NOT LIKE '\\_%'
  `;
  const occupied = [];
  for (const table of envelope.dump.tableOrder) {
    const rows = await sql`SELECT 1 FROM ${sql(table)} LIMIT 1`.catch(() => []);
    if (rows.length) occupied.push(table);
  }

  if (occupied.length) {
    console.error(`REFUSING TO RESTORE: ${occupied.length} table(s) already contain data.`);
    console.error(`  ${occupied.slice(0, 10).join(', ')}${occupied.length > 10 ? ' …' : ''}`);
    console.error('\nRestore into an EMPTY database. Overwriting live records is not something this');
    console.error('script will do for you, because it cannot be undone.');
    process.exit(1);
  }

  if (Number(existing[0]?.n ?? 0) === 0) {
    console.error('The target has no tables. Run `npm run db:migrate` first — a restore loads');
    console.error('rows, it does not create the schema.');
    process.exit(1);
  }

  console.log(`Restoring into ${describeTarget(url)}\n`);
  let total = 0;

  // One transaction: a half-restored federation is worse than none.
  await sql.begin(async (tx) => {
    for (const table of envelope.dump.tableOrder) {
      const rows = envelope.dump.tables[table] ?? [];
      if (!rows.length) continue;
      for (const row of rows) await tx`INSERT INTO ${tx(table)} ${tx(row)}`;
      total += rows.length;
      console.log(`  ${String(rows.length).padStart(7)}  ${table}`);
    }

    // Sequences do not follow inserted ids, so the next insert would collide
    // with a restored row. Every serial is advanced past its restored maximum.
    const sequences = await tx`
      SELECT c.relname AS seq, t.relname AS table_name, a.attname AS column_name
      FROM pg_class c
      JOIN pg_depend d ON d.objid = c.oid
      JOIN pg_class t ON t.oid = d.refobjid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'S' AND n.nspname = ${schema}
    `;
    for (const s of sequences) {
      await tx.unsafe(
        `SELECT setval('${s.seq}', COALESCE((SELECT MAX("${s.column_name}") FROM "${s.table_name}"), 1))`
      );
    }
    console.log(`\n  ${sequences.length} sequence(s) advanced past the restored maximum`);
  });

  console.log(`\nRestored ${total} rows. Verify before trusting:`);
  console.log('  curl <site>/api/health');
  console.log('  npm run db:status');
}

try {
  if (mode === 'backup') await backup();
  else if (mode === 'verify') verify(fileArg);
  else await restore(fileArg);
} catch (err) {
  console.error(`\n${err.message}`);

  // Every other failure this script reports is a judgement about the FILE, so a bare
  // certificate error gets read as one too — during --restore especially, where the
  // operator is already braced for the dump to be bad and will go re-verify a backup
  // that was never at fault. The register never moved either way: the handshake died
  // before a single statement was sent. Name the layer that actually refused.
  const hint = tlsHint(err);
  if (hint) console.error(hint);

  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
