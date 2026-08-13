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
// Each file applies inside a TRANSACTION. Postgres DDL is transactional, so a
// migration that fails half way leaves the database exactly as it was; there is
// no partially-migrated state to reason about.
//
// Provider-neutral: plain Postgres over TCP. Works against Supabase, Railway,
// Render, Fly, RDS or a local server — DATABASE_URL is the only input. It must
// be set; there is no fallback target, because pointing migrations at the wrong
// environment is far worse than failing loudly.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import postgres from 'postgres';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error('DATABASE_URL is not set. Refusing to guess a target database.');
  process.exit(1);
}

const statusOnly = process.argv.includes('--status');

// Migrations run from an operator's machine, not a serverless function, so a
// small pool is fine. prepare:false keeps this working through a transaction
// pooler as well as a direct connection.
// The target schema is stated explicitly rather than inherited. A connection's
// default search_path is ambient state — a managed provider, a pooler, or a
// previous session can leave it pointing somewhere unexpected, and migrations
// must never land in a schema by accident.
const schema = process.env.DATABASE_SCHEMA || 'public';

// REFUSED, not created. Every migration in drizzle/ writes unqualified names
// into whatever search_path points at, and the Drizzle schema, the app and
// scripts/verify-migrate.mjs all assume `public`. Honouring some other value
// would put 112 tables somewhere the application will never look, and the
// failure would present as an empty federation rather than as an error.
//
// Nor is the schema created here: doing so demands CREATE on the
// database itself, which a managed provider often withholds from the role in
// the connection string. Failing on a privilege the operator cannot grant is a
// worse first experience than being told the variable is unsupported.
if (schema !== 'public') {
  console.error(
    `DATABASE_SCHEMA is set to "${schema}", and these migrations only target public.
` +
    'Unset DATABASE_SCHEMA, or point DATABASE_URL at a database whose public schema you may use.'
  );
  process.exit(1);
}

const sql = postgres(url, {
  max: 1,
  prepare: false,
  connect_timeout: 15,
  idle_timeout: 20,
  connection: { search_path: schema },
});

function describeTarget(u) {
  try {
    const p = new URL(u);
    return `${p.host}${p.pathname}`;
  } catch {
    return 'unknown host';
  }
}

let exitCode = 0;
try {
  console.log(`Target: ${describeTarget(url)} (schema: ${schema})`);

  // The schema is pinned for this session, never provisioned — see the refusal
  // above. Pinning still matters: a pooler or a previous session can leave
  // search_path pointing somewhere unexpected.
  await sql.unsafe(`SET search_path TO ${schema}`);

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
  if (!files.length) throw new Error('No migration files found in drizzle/.');

  let pending = 0;

  for (const name of files) {
    const body = readFileSync(`drizzle/${name}`, 'utf8');
    const checksum = createHash('sha256').update(body).digest('hex').slice(0, 16);
    const previous = applied.get(name);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `MIGRATION ALTERED AFTER APPLY: ${name}\n` +
          `  recorded ${previous}, file is now ${checksum}\n` +
          `  Applied migrations are immutable. Add a new migration instead.`
        );
      }
      console.log(`  ok       ${name}`);
      continue;
    }

    pending++;
    if (statusOnly) {
      console.log(`  PENDING  ${name}`);
      continue;
    }

    console.log(`  applying ${name}`);
    const statements = body.split('--> statement-breakpoint').map((t) => t.trim()).filter(Boolean);

    await sql.begin(async (tx) => {
      for (const stmt of statements) {
        try {
          await tx.unsafe(stmt);
        } catch (err) {
          throw new Error(`FAILED in ${name} (rolled back):\n${stmt.slice(0, 300)}\n\n${err.message}`);
        }
      }
      await tx`INSERT INTO _mmakf_migrations (name, checksum) VALUES (${name}, ${checksum})`;
    });

    console.log(`  applied  ${name} (${statements.length} statements)`);
  }

  console.log(
    statusOnly
      ? (pending ? `\n${pending} migration(s) pending.` : '\nUp to date.')
      : (pending ? `\nApplied ${pending} migration(s).` : '\nUp to date; nothing to apply.')
  );

  // Report what actually exists, so the operator verifies rather than assumes.
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name NOT LIKE '\\_%'
    ORDER BY table_name
  `;
  console.log(`\nTables in public (${tables.length}):`);
  console.log(tables.map((t) => `  · ${t.table_name}`).join('\n'));
} catch (err) {
  console.error(`\n${err.message}`);
  exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}

process.exit(exitCode);
