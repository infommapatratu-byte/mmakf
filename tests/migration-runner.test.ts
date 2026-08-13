// The migration runner, exercised as an operator runs it.
//
// scripts/migrate.mjs is the first thing ever pointed at a new federation
// database, and the operator's only instrument for reading it. Three things it
// promised were not true, and each cost the operator something real:
//
//   · `--status` was documented as "change nothing" and created a table. The one
//     command you reach for to inspect a database you are not ready to touch
//     wrote to it — and, on a role without CREATE, died before reading anything.
//   · `DATABASE_SCHEMA` was documented as a supported knob. Setting it aborted
//     migration 0000 with `type "audit_action" does not exist`, a message about
//     an enum that never names the setting that caused it.
//   · The header claimed "there is no partially-migrated state to reason about".
//     Each FILE is a transaction; the RUN is not. A failure in the fourth file
//     leaves the first three committed, and an operator who believed the comment
//     would go looking for a database that was "exactly as it was".
//
// These run the real script as a separate process against a real Postgres
// (PGlite behind the wire protocol), started by the test itself — same driver,
// same TCP path, no Docker, no external service. Assertions are on observable
// state and on the words the operator actually reads.

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import postgres from 'postgres';
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

// Ports derived from the pid so parallel runs on one machine do not collide,
// and spaced so each case in this file gets its own pristine server.
const PORT_BASE = 7100 + (process.pid % 400) * 8;
const MIGRATE = resolve('scripts/migrate.mjs');

type Ran = { code: number | null; out: string };

/** Runs a node script as its own process, merging stdout and stderr as the operator sees them. */
function run(args: string[], env: Record<string, string>, cwd?: string): Promise<Ran> {
  return new Promise((done) => {
    // No shell: process.execPath contains spaces on Windows and a shell splits it.
    const p = spawn(process.execPath, args, { env: { ...process.env, ...env }, cwd });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => done({ code, out }));
  });
}

/** A fresh, empty Postgres on its own port for the duration of one case. */
async function withDatabase<T>(
  slot: number,
  body: (url: string, sql: ReturnType<typeof postgres>) => Promise<T>
): Promise<T> {
  const port = PORT_BASE + slot;
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`;

  // PGlite is published on the socket from inside this process rather than
  // spawned via scripts/pg-testserver.mjs, for the same reason
  // tests/bootstrap-cli.test.ts hosts its own: that server permits a SINGLE
  // connection, and every case here needs one for its own assertions while the
  // migrate.mjs child holds another. Sharing it had the runner's connection
  // rejected with "Too many connections", which surfaces as `read ECONNRESET`
  // and a non-zero exit — a harness ceiling that reads exactly like a defect in
  // the runner under test.
  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 4 });
  await server.start();

  const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 0, onnotice: () => {} });
  try {
    return await body(url, sql);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
    await server.stop();
    await db.close();
  }
}

const tableNames = async (sql: ReturnType<typeof postgres>, schema = 'public') =>
  (await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = ${schema} ORDER BY table_name`).map((r: any) => r.table_name as string);

/** Everything except the runner's own ledger, which an APPLY is entitled to create. */
const federationTables = async (sql: ReturnType<typeof postgres>) =>
  (await tableNames(sql)).filter((n) => !n.startsWith('_'));

const REAL_MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

describe('--status inspects the database without writing to it', () => {
  it('reports every migration as pending and leaves the database empty', async () => {
    await withDatabase(0, async (url, sql) => {
      expect(await tableNames(sql)).toEqual([]);

      // DATABASE_SCHEMA is neutralised explicitly: an operator's ambient value
      // must not decide what this case measures.
      const status = await run([MIGRATE, '--status'], { DATABASE_URL: url, DATABASE_SCHEMA: '' });

      expect(status.code).toBe(0);
      for (const m of REAL_MIGRATIONS) expect(status.out).toContain(`PENDING  ${m}`);
      expect(status.out).toContain(`${REAL_MIGRATIONS.length} migration(s) pending`);

      // The whole point: an inspection leaves nothing behind. Not one table, not
      // the runner's own bookkeeping ledger.
      expect(await tableNames(sql)).toEqual([]);
      const [{ ledger }] = await sql`SELECT to_regclass('public._mmakf_migrations') AS ledger`;
      expect(ledger).toBe(null);
    });
  }, 120_000);

  it('still reports correctly once migrations have been applied', async () => {
    await withDatabase(1, async (url, sql) => {
      const applied = await run([MIGRATE], { DATABASE_URL: url, DATABASE_SCHEMA: '' });
      expect(applied.code).toBe(0);

      const status = await run([MIGRATE, '--status'], { DATABASE_URL: url, DATABASE_SCHEMA: '' });
      expect(status.code).toBe(0);
      expect(status.out).toContain('Up to date.');
      for (const m of REAL_MIGRATIONS) expect(status.out).toMatch(new RegExp(`ok\\s+${m}`));
      expect(status.out).not.toContain('PENDING');

      // The ledger exists because the APPLY created it, and reading it did not
      // change what it holds.
      const rows = await sql`SELECT name FROM public._mmakf_migrations ORDER BY name`;
      expect(rows.map((r: any) => r.name)).toEqual(REAL_MIGRATIONS);
    });
  }, 180_000);
});

describe('a schema the migrations cannot deliver is refused by name', () => {
  it('rejects a non-public DATABASE_SCHEMA before it touches the database', async () => {
    await withDatabase(2, async (url, sql) => {
      const attempt = await run([MIGRATE], { DATABASE_URL: url, DATABASE_SCHEMA: 'mmakf' });

      expect(attempt.code).toBe(1);
      // The message must name the setting the operator typed. The old failure
      // named an enum type, which points at the migration and not at the cause.
      expect(attempt.out).toContain('DATABASE_SCHEMA');
      expect(attempt.out).toContain('public');
      expect(attempt.out).not.toContain('audit_action');

      // Nothing is attempted against the target: no orphan schema, no ledger,
      // no half-created anything for the operator to clean up afterwards.
      const schemas = await sql`SELECT nspname FROM pg_namespace WHERE nspname = 'mmakf'`;
      expect(schemas.length).toBe(0);
      expect(await tableNames(sql)).toEqual([]);
    });
  }, 120_000);

  it('does not issue CREATE SCHEMA, which demands CREATE on the database itself', () => {
    // Measured on PostgreSQL 18.3: `CREATE SCHEMA IF NOT EXISTS public` raises
    // 42501 "permission denied for database postgres" for a role without CREATE
    // on the database EVEN WHERE public already exists — the privilege check
    // runs before the IF NOT EXISTS short-circuit. public is created by initdb
    // and is the only schema this runner supports, so the statement could never
    // do anything except fail, and its message names the database rather than
    // anything the migration needed.
    expect(readFileSync('scripts/migrate.mjs', 'utf8')).not.toMatch(/CREATE SCHEMA/i);
  });
});

describe('a run that fails part way says how far it got', () => {
  it('names the file it stopped at and reports the files that stayed committed', async () => {
    // Synthetic migrations in a scratch directory: the runner reads drizzle/
    // relative to its working directory, so a failure can be staged without
    // touching the federation's real, already-applied migration history.
    const dir = mkdtempSync(join(tmpdir(), 'mmakf-migrate-'));
    mkdirSync(join(dir, 'drizzle'));
    const write = (name: string, body: string) => writeFileSync(join(dir, 'drizzle', name), body);
    write('0000_first.sql', 'CREATE TABLE "first_table" ("id" integer PRIMARY KEY);');
    write('0001_second.sql', 'CREATE TABLE "second_table" ("id" integer PRIMARY KEY);');
    write(
      '0002_broken.sql',
      'CREATE TABLE "third_table" ("id" integer PRIMARY KEY);\n' +
      '--> statement-breakpoint\n' +
      'CREATE TABLE "broken" ("x" integer REFERENCES "no_such_table"("id"));'
    );

    try {
      await withDatabase(3, async (url, sql) => {
        const failed = await run([MIGRATE], { DATABASE_URL: url, DATABASE_SCHEMA: '' }, dir);

        expect(failed.code).toBe(1);
        expect(failed.out).toContain('FAILED in 0002_broken.sql');

        // The report the header used to deny was needed at all.
        expect(failed.out).toContain('2 of 3');
        expect(failed.out).toContain('part-migrated');
        expect(failed.out).toContain('0002_broken.sql');

        // And the report matches reality: the first two files are committed, the
        // failing file left nothing at all.
        const names = await tableNames(sql);
        expect(names).toContain('first_table');
        expect(names).toContain('second_table');
        expect(names).not.toContain('third_table');
        expect(names).not.toContain('broken');

        // "Re-run to resume" has to be true, not merely encouraging.
        write('0002_broken.sql', 'CREATE TABLE "third_table" ("id" integer PRIMARY KEY);');
        const resumed = await run([MIGRATE], { DATABASE_URL: url, DATABASE_SCHEMA: '' }, dir);
        expect(resumed.code).toBe(0);
        expect(resumed.out).toMatch(/ok\s+0000_first\.sql/);
        expect(resumed.out).toMatch(/applied\s+0002_broken\.sql/);
        expect(await tableNames(sql)).toContain('third_table');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('says the database is unchanged when the very first file fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmakf-migrate-'));
    mkdirSync(join(dir, 'drizzle'));
    writeFileSync(
      join(dir, 'drizzle', '0000_broken.sql'),
      'CREATE TABLE "broken" ("x" integer REFERENCES "no_such_table"("id"));'
    );

    try {
      await withDatabase(4, async (url, sql) => {
        const failed = await run([MIGRATE], { DATABASE_URL: url, DATABASE_SCHEMA: '' }, dir);

        expect(failed.code).toBe(1);
        expect(failed.out).toContain('No migration was applied');
        expect(failed.out).not.toContain('part-migrated');
        // The ledger is the runner's own bookkeeping and an apply may create it;
        // nothing of the migration itself may survive.
        expect(await federationTables(sql)).toEqual([]);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
