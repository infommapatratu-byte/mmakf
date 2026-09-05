// The account listing, exercised as the locked-out operator runs it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS COMMAND IS WORTH A SUITE
// ─────────────────────────────────────────────────────────────────────────────
//
// scripts/user-list.ts is a RECOVERY path, and a recovery path is used exactly
// once per emergency, by somebody who cannot check its work. Everything it says
// is taken on trust, at the worst possible moment, by a person who has already
// tried the password they had.
//
// The federation reached that moment: the shared office password retires itself
// the instant the first account exists (sharedPasswordAllowed(), src/lib/auth.ts),
// production crossed that line at its own cutover, and /api/auth/login answers
// the old password with a 403 that cannot name a replacement — it does not know
// which addresses the register holds. This command is the thing that knows.
//
// So the assertions below are about WHAT IT SAYS, not merely that it exits 0:
//
//   · an EMPTY register must say the shared password still works, because that
//     is the one state in which the office should keep using it — and telling
//     them otherwise sends them to reset a credential that does not exist;
//   · a NON-EMPTY register must say the shared password is retired, because
//     that is the sentence the office is actually missing;
//   · an account that cannot sign in must SAY SO IN THE LISTING. A row that
//     looks usable and is not sends the operator to reissue a password against
//     a disabled account and watch it be refused — which this project has
//     already done twice, and which scripts/reset-password.ts warns about for
//     the same reason;
//   · a disabled account must still be LISTED. Hiding it would send the
//     operator to create a duplicate for an address the unique index will then
//     refuse, which reads as a broken script rather than an account that is
//     already there.
//
// And one security pin: the listing prints no hash. It is run by whoever holds
// the connection string, so addresses are not withheld — but a stored hash on
// screen is a hash in the scrollback of a machine that had no copy of it.
//
// The real script runs as a real child process against a real Postgres wire
// protocol, on the pattern of tests/bootstrap-cli.test.ts: the thing under test
// is what the operator's terminal shows, so nothing here mocks the database.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

// A port derived from the pid, in a band no other suite claims — 6100 and above
// belong to e2e-postgres, live-error-disclosure, migration-runner and
// bootstrap-cli.
const PORT = 5900 + (process.pid % 150);
const URL = `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`;

// Written into every account this suite creates, and asserted absent from the
// output. A literal sentinel rather than a real scrypt hash: what matters is
// that the column's contents do not reach the terminal, and a value that could
// only have come from that column proves it.
const HASH = 'scrypt$32768$8$1$SALTSENTINEL$HASHSENTINEL';

let pglite: PGlite;
let server: PGLiteSocketServer;
let sql: ReturnType<typeof postgres>;

/** Runs the real script, capturing everything it says on either stream. */
function runList(): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // No shell: process.execPath contains spaces on Windows and a shell would
    // split it.
    const p = spawn(process.execPath, ['scripts/user-list.ts'], {
      env: { ...process.env, DATABASE_URL: URL },
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

/** An account, written directly — this suite tests the reader, not the writer. */
async function addUser(
  email: string,
  opts: { status?: string; hash?: string | null; mustChange?: string; lockedMinutes?: number } = {}
) {
  const [row] = await sql`
    INSERT INTO users (email, password_hash, status, must_change_password, locked_until)
    VALUES (${email}, ${opts.hash === undefined ? HASH : opts.hash}, ${opts.status ?? 'active'},
            ${opts.mustChange ?? 'no'},
            ${opts.lockedMinutes ? sql`now() + make_interval(mins => ${opts.lockedMinutes})` : null})
    RETURNING id
  `;
  return row.id as number;
}

async function addBinding(userId: number, role: string, status = 'active') {
  await sql`
    INSERT INTO role_bindings (user_id, role, scope_type, scope_id, status)
    VALUES (${userId}, ${role}, 'national', NULL, ${status}::credential_status)
  `;
}

beforeAll(async () => {
  pglite = await PGlite.create();
  // Two connections: this suite keeps one open for its assertions and the child
  // process needs the other.
  server = new PGLiteSocketServer({ db: pglite, port: PORT, host: '127.0.0.1', maxConnections: 2 });
  await server.start();

  // Every migration, discovered rather than listed.
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const t = stmt.trim();
      if (t) await pglite.exec(t);
    }
  }

  sql = postgres(URL, { max: 1, prepare: false, connect_timeout: 10, idle_timeout: 0, onnotice: () => {} });
  await sql`SELECT 1`;
}, 120_000);

afterAll(async () => {
  if (sql) await sql.end({ timeout: 5 }).catch(() => {});
  if (server) await server.stop().catch(() => {});
  if (pglite) await pglite.close().catch(() => {});
});

describe('the account listing CLI', () => {
  // FIRST, AND IT HAS TO BE. Every later test writes an account, and the empty
  // register is the state this branch describes. Vitest runs the cases in a
  // file in order, so the dependency holds — it is stated here rather than left
  // for whoever reorders them.
  it('on an empty register, says the shared password still works rather than sending anyone to reset one', async () => {
    const { code, out } = await runList();
    expect(code, out).toBe(0);
    expect(out).toContain('NO accounts');
    // The consequence, not just the count: this is the only state in which the
    // office SHOULD still be typing the shared password.
    expect(out).toContain('shared office password still works');
    expect(out).toContain('npm run user:create');
    // And it must NOT tell an office with no accounts that their password was
    // retired — that is the sentence for the opposite state.
    expect(out).not.toContain('RETIRED');
  });

  it('lists an account, its role and the address to sign in with, and says the shared password is retired', async () => {
    const id = await addUser('registrar@example.test', { mustChange: 'yes' });
    await addBinding(id, 'SUPER_ADMIN');

    const { code, out } = await runList();
    expect(code, out).toBe(0);
    expect(out).toContain('registrar@example.test');
    expect(out).toContain('SUPER_ADMIN (national)');
    // The verdict, which is in no single row and is the reason the office is
    // running this at all.
    expect(out).toContain('RETIRED');
    expect(out).toContain('The shared password has been retired.');
    // must_change_password is NOT a refusal — an account carrying it signs in
    // and is sent to change it. Saying otherwise would send the operator to
    // "fix" a handover credential that is working as designed.
    expect(out).toContain('handover password');
  });

  it('shows a disabled account, and says its password is irrelevant', async () => {
    const id = await addUser('retired@example.test', { status: 'disabled' });
    await addBinding(id, 'TECHNICAL_DIRECTOR');

    const { out } = await runList();
    // Listed, not hidden: the address is taken, and an operator who cannot see
    // it will try to create it again.
    expect(out).toContain('retired@example.test');
    expect(out).toContain('sign-in refused whatever the password is');
  });

  it('names a live lockout, which refuses a correct password', async () => {
    const id = await addUser('locked@example.test', { lockedMinutes: 15 });
    await addBinding(id, 'FINANCE_OFFICER');

    const { out } = await runList();
    expect(out).toMatch(/locked@example\.test/);
    expect(out).toContain('LOCKED until');
    expect(out).toContain('a correct password is refused');
  });

  it('marks a revoked binding as dead rather than counting it as a role', async () => {
    const id = await addUser('revoked@example.test');
    await addBinding(id, 'REFEREE', 'revoked');

    const { out } = await runList();
    // The binding row still exists, so a listing that only counted rows would
    // show a working referee.
    expect(out).toContain('REFEREE (national) [revoked]');
    expect(out).toContain('no live role');
  });

  it('reports that a password exists without printing anything derived from it', async () => {
    const id = await addUser('nopassword@example.test', { hash: null });
    await addBinding(id, 'MEMBER');

    const { out } = await runList();
    expect(out).toContain('no password set');
    // The pin: no stored hash, and no fragment of one, reaches the terminal.
    expect(out).not.toContain('scrypt$');
    expect(out).not.toContain('HASHSENTINEL');
    expect(out).not.toContain('SALTSENTINEL');
  });
});
