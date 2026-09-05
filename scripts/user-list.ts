#!/usr/bin/env node
// Every account the register holds.
//
//   npm run user:list
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A SECOND READ-ONLY COMMAND EARNS ITS PLACE
// ─────────────────────────────────────────────────────────────────────────────
//
// scripts/user-status.ts answers "what does the register hold for THIS address".
// So do reset-password and disable-user: all three take --email and refuse
// without one. Every recovery path in this project therefore begins with a fact
// the locked-out operator is least likely to have — the exact address of an
// account somebody created months ago, possibly not them.
//
// Nothing else supplies it. The console says "Invalid email or password" for an
// unknown address and for a wrong password alike, deliberately (§53), so
// guessing at the form teaches nothing; user:status says "No account exists
// with the email X" and points at user:create, which is the right answer only
// if the guess was also the address nobody had used.
//
// The federation's actual failure was smaller and worse than either. The shared
// office password was retired the moment the first account was created, the
// office kept typing it, and the console — correctly — would not say what to
// type instead. This says what to type instead.
//
// It writes nothing, takes no --force, and cannot lock anybody out.
//
// IT PRINTS NO HASH AND NO CREDENTIAL, on the same terms as user:status:
// whether a password EXISTS is reported; what it is is not derivable from
// anything below. Addresses are printed in full because whoever can run this
// already holds the connection string, and there is no account-enumeration
// boundary left to defend at that point.
//
// IT ALSO ANSWERS THE SHARED-PASSWORD QUESTION, because that is the one the
// operator is really asking and it is in no single row. The office password is
// retired by COUNT — sharedPasswordAllowed() in src/lib/auth.ts switches the
// federation over as soon as one account exists — so the verdict is printed
// under the list rather than left to be inferred from its length.
//
// Requires DATABASE_URL.

import postgres from 'postgres';
import { tlsFor, tlsHint } from './db-tls.mjs';

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

/** A binding that is present and actually grants something today. */
function isLive(b: any, now: number): boolean {
  if (b.status !== 'active') return false;
  return !b.expires_at || new Date(b.expires_at).getTime() > now;
}

/**
 * Roles, with the two ways one can be present and grant nothing said out loud —
 * a binding whose status is not active, and one whose expiry has passed. Both
 * render as a live role in any listing that only counts rows.
 */
function describeRoles(rows: any[], now: number): string {
  if (!rows.length) return 'none';
  return rows
    .map((b) => {
      const scope = b.scope_id == null ? String(b.scope_type) : `${b.scope_type}:${b.scope_id}`;
      const expired = b.expires_at && new Date(b.expires_at).getTime() <= now;
      const dead = b.status !== 'active' ? ` [${b.status}]` : expired ? ' [expired]' : '';
      return `${b.role} (${scope})${dead}`;
    })
    .join(', ');
}

/**
 * What stands between this account and a working session.
 *
 * Refusals first, ordered as signIn() checks them (src/db/users.ts): status,
 * then the lock, then the credential — so the first note is the one the caller
 * actually hits. The last note is not a refusal and is marked as one thing it
 * is easy to misread: must_change_password lets the holder in and then sends
 * them straight to /admin/password, which is a handover credential working
 * exactly as intended, not an account that is stuck.
 */
function describeProblem(u: any, bindings: any[], now: number): string {
  const notes: string[] = [];
  if (u.status !== 'active') notes.push(`${u.status}: sign-in refused whatever the password is`);
  if (u.locked_until && new Date(u.locked_until).getTime() > now) {
    notes.push(`LOCKED until ${new Date(u.locked_until).toISOString()}: a correct password is refused`);
  }
  if (!u.has_password) notes.push('no password set: reset-password mints one');
  if (!bindings.some((b) => isLive(b, now))) notes.push('no live role: signs in, every module refuses');
  if (u.must_change_password === 'yes') notes.push('handover password: signs in, then must be changed');
  return notes.join('; ');
}

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15, ...tlsFor(url) });

try {
  const users = await sql`
    SELECT id, email, status, password_hash IS NOT NULL AS has_password,
           must_change_password, locked_until, last_login_at
      FROM users
     ORDER BY id
  `;

  if (!users.length) {
    console.log(`
The register holds NO accounts.

That is why the shared office password still works: sharedPasswordAllowed() in
src/lib/auth.ts permits it only while the count is zero. Creating the first
account retires it in the same transaction, so create one deliberately:

  npm run user:create -- --email you@mmakf.in --role SUPER_ADMIN
`);
  } else {
    // One query for every binding rather than one per user: a register of any
    // size would otherwise open a round trip per row against a pooler that
    // charges for each.
    const bindings = await sql`
      SELECT user_id, role, scope_type, scope_id, status, expires_at
        FROM role_bindings
       ORDER BY user_id, role
    `;

    const byUser = new Map<number, any[]>();
    for (const b of bindings) {
      const list = byUser.get(b.user_id) || [];
      list.push(b);
      byUser.set(b.user_id, list);
    }

    const now = Date.now();
    const rows = users.map((u: any) => {
      const mine = byUser.get(u.id) || [];
      return {
        email: String(u.email),
        status: String(u.status),
        roles: describeRoles(mine, now),
        last: u.last_login_at ? new Date(u.last_login_at).toISOString().slice(0, 10) : 'never',
        problem: describeProblem(u, mine, now),
      };
    });

    const width = (key: 'email' | 'status' | 'roles' | 'last', head: string) =>
      Math.max(head.length, ...rows.map((r) => r[key].length));
    const wEmail = width('email', 'EMAIL');
    const wStatus = width('status', 'STATUS');
    const wRoles = width('roles', 'ROLES');

    const line = (email: string, status: string, roles: string, last: string) =>
      `  ${email.padEnd(wEmail)}  ${status.padEnd(wStatus)}  ${roles.padEnd(wRoles)}  ${last}`;

    console.log('');
    console.log(line('EMAIL', 'STATUS', 'ROLES', 'LAST SIGN-IN'));
    console.log(line('-'.repeat(wEmail), '-'.repeat(wStatus), '-'.repeat(wRoles), '-'.repeat(12)));
    for (const r of rows) {
      console.log(line(r.email, r.status, r.roles, r.last));
      // On its own line rather than a fifth column: the reason an account is
      // refused is the longest thing here and the only thing worth reading
      // twice, and wrapping it inside a table is how it gets skimmed past.
      if (r.problem) console.log(`  ${' '.repeat(wEmail)}  -> ${r.problem}`);
    }

    // The count, and what it means for the door the office keeps trying.
    const plural = users.length === 1 ? 'account exists' : 'accounts exist';
    console.log(`
${users.length} ${plural}, so the shared office password is RETIRED: /api/auth/login
answers it with 403 "The shared password has been retired." Sign in with one of
the addresses above.

  npm run user:status -- --email <address>          what the register holds
  npm run user:reset-password -- --email <address>  reissue, signing out sessions

An office that holds no address above needs a new account rather than a reset:

  npm run user:create -- --email you@mmakf.in --role SUPER_ADMIN
`);
  }
} catch (err: any) {
  console.error(`\nFailed: ${err?.message ?? err}\n`);
  const hint = tlsHint(err);
  if (hint) console.error(hint);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
