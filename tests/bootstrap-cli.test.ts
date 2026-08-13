// The bootstrap CLI, exercised exactly as the operator runs it at go-live.
//
// scripts/create-user.ts mints the FIRST administrator, and it is the only way
// to mint one: the admin console cannot create the account you need in order to
// sign in to the admin console. So this script runs once, on a live database,
// over the transaction pooler, and whatever it leaves behind is what the
// federation has to live with.
//
// The suite therefore runs the REAL script as a real child process against a
// real Postgres wire protocol — the same driver, the same TCP path, the same
// transactions production uses. Nothing here mocks the database, because the
// defect being guarded against is a database defect: what survives when the run
// does not reach the end.
//
// PGlite is hosted in this process and published on a socket rather than
// spawned via scripts/pg-testserver.mjs, for one reason: that server allows a
// single connection, and this suite needs its own alongside the child's.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { verifyPassword } from '../src/lib/password';

// A port derived from the pid, in a band no other suite claims, so parallel
// runs on one machine do not collide.
const PORT = 7600 + (process.pid % 300);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

let pglite: PGlite;
let server: PGLiteSocketServer;
let sql: ReturnType<typeof postgres>;

/** Runs the real script, capturing everything it says on either stream. */
function runCli(...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // No shell: process.execPath contains spaces on Windows and a shell would
    // split it.
    const p = spawn(process.execPath, ['scripts/create-user.ts', ...args], {
      env: { ...process.env, DATABASE_URL: URL },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

/**
 * Makes the SECOND of the script's three writes fail, and only that one.
 *
 * The realistic production failure is the pooler refusing a statement part-way
 * through the sequence — max clients reached, or the backend recycled between
 * statements. A check constraint that the pending role binding violates
 * reproduces the same shape deterministically: the users INSERT succeeds, the
 * role_bindings INSERT is refused, and the process dies with work already done.
 *
 * The constraint keys on the role, so adding it can never retroactively
 * invalidate a binding an earlier test in this file already wrote.
 */
async function withRoleBindingRefused<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await sql.unsafe(`ALTER TABLE role_bindings ADD CONSTRAINT bootstrap_cli_refuse CHECK (role <> '${role}')`);
  try {
    return await fn();
  } finally {
    await sql.unsafe('ALTER TABLE role_bindings DROP CONSTRAINT bootstrap_cli_refuse');
  }
}

/** Everything the script is supposed to write, for one account. */
async function accountFor(email: string) {
  const users = await sql`SELECT id, email, password_hash, must_change_password FROM users WHERE email = ${email}`;
  if (!users.length) return { user: null as any, bindings: [] as any[], audits: [] as any[] };
  const bindings = await sql`SELECT role, scope_type, scope_id, status FROM role_bindings WHERE user_id = ${users[0].id}`;
  const audits = await sql`
    SELECT actor_label, action, entity_type FROM audit_events
    WHERE entity_type = 'user' AND entity_id = ${String(users[0].id)}`;
  return { user: users[0], bindings: [...bindings], audits: [...audits] };
}

/** Totals across all three tables — the atomicity check compares these. */
async function totals() {
  const [row] = await sql`
    SELECT (SELECT count(*)::int FROM users)          AS users,
           (SELECT count(*)::int FROM role_bindings)  AS bindings,
           (SELECT count(*)::int FROM audit_events)   AS audits`;
  return { users: row.users, bindings: row.bindings, audits: row.audits };
}

// The script prints the generated credential on a labelled line. It is
// base64url, so the token itself never contains whitespace.
const PASSWORD_LINE = /Password\s+(\S+)/;

beforeAll(async () => {
  pglite = await PGlite.create();
  // Two connections: this suite keeps one open for its assertions and the child
  // process needs the other. The default of one would reject whichever arrived
  // second with "Too many connections", which reads exactly like the pooler
  // failure the suite is meant to be simulating deliberately.
  server = new PGLiteSocketServer({ db: pglite, port: PORT, host: '127.0.0.1', maxConnections: 2 });
  await server.start();

  // EVERY migration, discovered rather than listed — a hardcoded file breaks
  // the moment a later one adds a column the script writes.
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const t = stmt.trim();
      if (t) await pglite.exec(t);
    }
  }

  // prepare:false is what production uses against the Supabase transaction
  // pooler, and what the script itself uses.
  sql = postgres(URL, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 0, onnotice: () => {} });
  await sql`SELECT 1`;
}, 120_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  if (server) await server.stop().catch(() => {});
  if (pglite) await pglite.close().catch(() => {});
});

describe('the bootstrap account CLI', () => {
  it('creates the user, its role binding and its audit entry, and prints a password that works', async () => {
    const email = 'bootstrap-ok@example.test';
    const { code, out } = await runCli('--email', email, '--role', 'SUPER_ADMIN', '--scope', 'national');
    expect(code, out).toBe(0);

    const password = (out.match(PASSWORD_LINE) || [])[1];
    expect(password, out).toBeTruthy();
    // Generated, not chosen: base64url, and long enough that guessing is not a
    // strategy.
    expect(password).toMatch(/^[A-Za-z0-9_-]{22,}$/);

    const { user, bindings, audits } = await accountFor(email);
    expect(user).toBeTruthy();
    expect(user.must_change_password).toBe('yes');
    expect(await verifyPassword(password, user.password_hash)).toBe(true);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].role).toBe('SUPER_ADMIN');
    expect(bindings[0].scope_type).toBe('national');
    expect(bindings[0].scope_id).toBe(null);
    expect(bindings[0].status).toBe('active');
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_label).toBe('bootstrap-cli');
  });

  it('leaves no half-made account behind when a write fails part-way through', async () => {
    const email = 'bootstrap-partial@example.test';
    const before = await totals();

    const run = await withRoleBindingRefused('REFEREE', () =>
      runCli('--email', email, '--role', 'REFEREE', '--scope', 'national')
    );
    expect(run.code, run.out).not.toBe(0);

    // The account, its authority and its audit entry are one fact. A user row
    // with no role binding is not a partial success: it occupies the email
    // address while granting nothing, and on its way in it retires the shared
    // office password (sharedPasswordAllowed in src/lib/auth.ts counts users).
    const { user } = await accountFor(email);
    expect(user).toBe(null);
    expect(await totals()).toEqual(before);
  });

  it('can simply be run again after a failure, with the same email', async () => {
    const email = 'bootstrap-retry@example.test';

    const failed = await withRoleBindingRefused('JUDGE', () =>
      runCli('--email', email, '--role', 'JUDGE', '--scope', 'national')
    );
    expect(failed.code, failed.out).not.toBe(0);

    // Nothing was written, so nothing is in the way. The operator repeats the
    // command; they do not hand-edit the federation's database to clear a row
    // the failed run should never have left behind.
    const retry = await runCli('--email', email, '--role', 'JUDGE', '--scope', 'national');
    expect(retry.code, retry.out).toBe(0);

    const password = (retry.out.match(PASSWORD_LINE) || [])[1];
    const { user, bindings } = await accountFor(email);
    expect(user).toBeTruthy();
    expect(await verifyPassword(password, user.password_hash)).toBe(true);
    expect(bindings).toHaveLength(1);
    expect(bindings[0].role).toBe('JUDGE');
  });

  it('shows the generated password even when the write fails', async () => {
    const email = 'bootstrap-indoubt@example.test';

    const run = await withRoleBindingRefused('EXAMINER', () =>
      runCli('--email', email, '--role', 'EXAMINER', '--scope', 'national')
    );
    expect(run.code, run.out).not.toBe(0);

    // The password exists only in that process's memory. A failure the client
    // sees is not proof the server did not commit — lose the reply to a COMMIT
    // and the account can exist with a credential nobody ever read. Printing it
    // on the failure path costs nothing and is the only copy there will be.
    const password = (run.out.match(PASSWORD_LINE) || [])[1];
    expect(password, run.out).toBeTruthy();
    expect(password).toMatch(/^[A-Za-z0-9_-]{22,}$/);
  });

  it('refuses a duplicate email without touching anything', async () => {
    const before = await totals();
    const { code, out } = await runCli('--email', 'bootstrap-ok@example.test', '--role', 'SUPER_ADMIN', '--scope', 'national');
    expect(code).not.toBe(0);
    expect(out).toContain('already exists');
    expect(await totals()).toEqual(before);
  });
});
