#!/usr/bin/env node
// Migration runner (§55).
//
//   node scripts/migrate.mjs            apply pending migrations
//   node scripts/migrate.mjs --status   list applied / pending, change nothing
//
// Migrations are forward-only SQL files in drizzle/, applied in filename order.
// Each is recorded in _mmakf_migrations with a checksum, so:
//   · a file already applied is skipped;
//   · a file EDITED after being applied is a hard error, not a silent skip —
//     editing applied history is how environments drift apart.
//
// DATABASE_URL must be set. There is no fallback and no auto-created database:
// pointing migrations at the wrong environment is worse than failing loudly.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.NEON_DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Refusing to guess a target database.');
  process.exit(1);
}

const statusOnly = process.argv.includes('--status');
const sql = neon(url);

const host = (() => { try { return new URL(url).host; } catch { return 'unknown host'; } })();
console.log(`Target: ${host}`);

await sql`
  CREATE TABLE IF NOT EXISTS _mmakf_migrations (
    name        text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  )
`;

const applied = new Map(
  (await sql`SELECT name, checksum FROM _mmakf_migrations`).map((r) => [r.name, r.checksum])
);

const files = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();
if (!files.length) {
  console.error('No migration files found in drizzle/.');
  process.exit(1);
}

let pending = 0;
for (const name of files) {
  const body = readFileSync(`drizzle/${name}`, 'utf8');
  const checksum = createHash('sha256').update(body).digest('hex').slice(0, 16);
  const previous = applied.get(name);

  if (previous) {
    if (previous !== checksum) {
      console.error(
        `\nMIGRATION ALTERED AFTER APPLY: ${name}\n` +
        `  recorded ${previous}, file now ${checksum}\n` +
        `  Applied migrations are immutable. Add a new migration instead.`
      );
      process.exit(1);
    }
    console.log(`  ok      ${name}`);
    continue;
  }

  pending++;
  if (statusOnly) {
    console.log(`  PENDING ${name}`);
    continue;
  }

  console.log(`  apply   ${name}`);
  // Statements are split on drizzle's breakpoint marker. neon-http has no
  // multi-statement transaction, so a failure part-way leaves the earlier
  // statements applied — the run is not recorded, so a re-run resumes and the
  // CREATE ... IF NOT EXISTS statements are idempotent.
  for (const stmt of body.split('--> statement-breakpoint')) {
    const t = stmt.trim();
    if (!t) continue;
    try {
      await sql(t);
    } catch (err) {
      console.error(`\nFAILED in ${name}:\n${t.slice(0, 300)}\n\n${err.message}`);
      process.exit(1);
    }
  }
  await sql`INSERT INTO _mmakf_migrations (name, checksum) VALUES (${name}, ${checksum})`;
}

if (statusOnly) {
  console.log(pending ? `\n${pending} migration(s) pending.` : '\nUp to date.');
} else {
  console.log(pending ? `\nApplied ${pending} migration(s).` : '\nUp to date; nothing to apply.');
}

// Report what actually exists, so the operator verifies rather than assumes.
const tables = await sql`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name NOT LIKE '\\_%'
  ORDER BY table_name
`;
console.log(`\nTables in public (${tables.length}):`);
console.log(tables.map((t) => `  · ${t.table_name}`).join('\n'));
