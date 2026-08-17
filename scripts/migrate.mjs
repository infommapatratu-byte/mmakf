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
// Each FILE applies inside a transaction. The RUN does not. Postgres DDL is
// transactional, so a file that fails half way leaves nothing of itself behind
// — but every file that already succeeded is COMMITTED and stays committed. A
// failure in the fourth file leaves the first three in the database, and an
// operator told "rolled back" would go looking for a database that is exactly
// as it was and not find one. So a stopped run reports how far it got, by name.
//
// --status is the command you reach for when you are not ready to touch the
// database yet, so it must not touch it: it reads the ledger where one exists
// and reports everything as pending where one does not. It must never bring the
// ledger into being, because that is a write, and on a role without CREATE it
// is a write that dies before reporting anything at all.
//
// Provider-neutral: plain Postgres over TCP. Works against Supabase, Railway,
// Render, Fly, RDS or a local server — DATABASE_URL is the only input. It must
// be set; there is no fallback target, because pointing migrations at the wrong
// environment is far worse than failing loudly.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { tlsFor, tlsHint } from './db-tls.mjs';

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

// REFUSED, not provisioned. Every migration in drizzle/ writes unqualified
// names into whatever search_path points at, and the Drizzle schema, the app
// and scripts/verify-migrate.mjs all assume `public`. Honouring some other
// value would put the federation's tables somewhere the application will never
// look, and the failure would present as an empty federation rather than as an
// error — the operator would read `type "audit_action" does not exist` and go
// hunting through migration 0000 for a fault that is in their environment.
//
// Nor is the schema brought into being here: doing so demands CREATE on the
// database itself, which a managed provider often withholds from the role in
// the connection string. Failing on a privilege the operator cannot grant is a
// worse first experience than being told the variable is unsupported.
if (schema !== 'public') {
  console.error(
    `DATABASE_SCHEMA is set to "${schema}", and these migrations only target public.\n` +
    'Unset DATABASE_SCHEMA, or point DATABASE_URL at a database whose public schema you may use.'
  );
  process.exit(1);
}

// TLS on the same terms as the application, from the one definition in
// scripts/db-tls.mjs. This runner passed no `ssl` option at all for a long time,
// and postgres.js ships `ssl: false` — so omitting it was a decision to send
// every migration in drizzle/ across the open internet IN PLAINTEXT. It hid
// perfectly, because it works: a pooler accepts an unencrypted session without
// complaint, and nothing in this output ever said how the bytes travelled.
const sql = postgres(url, {
  max: 1,
  prepare: false,
  connect_timeout: 15,
  idle_timeout: 20,
  connection: { search_path: schema },
  ...tlsFor(url),
});

function describeTarget(u) {
  try {
    const p = new URL(u);
    return `${p.host}${p.pathname}`;
  } catch {
    return 'unknown host';
  }
}

/**
 * What the operator reads when a run stops part way.
 *
 * The only question at this point is whether to fix and re-run or to restore,
 * and that turns entirely on what is still in the database. So the report names
 * the file that stopped the run, counts the files that are committed against
 * the files this run set out to apply, and says which of the two situations
 * this is. Anything vaguer sends someone to a backup they did not need.
 */
function reportStoppedRun({ name, error, statement, committed, plannedCount }) {
  const lines = ['', `FAILED in ${name}`];
  if (statement) lines.push(statement.slice(0, 300));
  lines.push('', error.message, '');

  if (committed.length === 0) {
    lines.push(
      'No migration was applied. The database is unchanged — this file rolled',
      'back whole and nothing ran before it. Fix the file and re-run.'
    );
  } else {
    lines.push(
      `The failing file rolled back whole and left nothing behind, but the run`,
      `did not roll back: each file is its own transaction, so the database is`,
      `now part-migrated.`,
      '',
      `  committed  ${committed.length} of ${plannedCount} pending migration(s):`,
      ...committed.map((n) => `    · ${n}`),
      `  stopped at ${name}`,
      '',
      'Fix that file and re-run to resume: the committed migrations are recorded',
      'in _mmakf_migrations and will be skipped. Restoring from a backup instead',
      'would discard them.'
    );
  }
  console.error(lines.join('\n'));
}

let exitCode = 0;
try {
  console.log(`Target: ${describeTarget(url)} (schema: ${schema})`);

  // The schema is pinned for this session, never provisioned — see the refusal
  // above. Pinning still matters: a pooler or a previous session can leave
  // search_path pointing somewhere unexpected.
  await sql.unsafe(`SET search_path TO ${schema}`);

  // An inspection asks whether the ledger is there; an apply is entitled to put
  // it there. Keeping those apart is the whole difference between a command
  // that reads a database and a command that writes to one.
  let ledgerExists = true;
  if (statusOnly) {
    const [{ ledger }] = await sql`SELECT to_regclass('public._mmakf_migrations') AS ledger`;
    ledgerExists = ledger !== null;
  } else {
    await sql`
      CREATE TABLE IF NOT EXISTS _mmakf_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )
    `;
  }

  const applied = ledgerExists
    ? new Map(
        (await sql`SELECT name, checksum FROM _mmakf_migrations`).map((r) => [r.name, r.checksum])
      )
    : new Map();

  const files = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();
  if (!files.length) throw new Error('No migration files found in drizzle/.');

  // Counted before anything runs, so the failure report can say "2 of 3" rather
  // than "2 so far" — the operator needs the denominator to know what is left.
  const plannedCount = files.filter((f) => !applied.has(f)).length;

  const committed = [];
  let pending = 0;
  let stopped = false;

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

    // Held outside the transaction so the report can quote the statement that
    // actually failed; inside, it is lost with the rollback.
    let attempted = null;
    try {
      await sql.begin(async (tx) => {
        for (const stmt of statements) {
          attempted = stmt;
          await tx.unsafe(stmt);
        }
        attempted = null;
        await tx`INSERT INTO _mmakf_migrations (name, checksum) VALUES (${name}, ${checksum})`;
      });
    } catch (err) {
      reportStoppedRun({ name, error: err, statement: attempted, committed, plannedCount });
      exitCode = 1;
      stopped = true;
      break;
    }

    committed.push(name);
    console.log(`  applied  ${name} (${statements.length} statements)`);
  }

  if (!stopped) {
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
  }
} catch (err) {
  console.error(`\n${err.message}`);

  // A certificate failure reads nothing like what it is, so the next operator
  // does not go re-checking a password that was never at fault.
  const hint = tlsHint(err);
  if (hint) console.error(hint);

  exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}

process.exit(exitCode);
