#!/usr/bin/env node
// What the register actually holds for one account.
//
//   npm run user:status -- --email you@mmakf.in
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A READ-ONLY COMMAND EARNS ITS PLACE
// ─────────────────────────────────────────────────────────────────────────────
//
// "Invalid email or password" is FOUR different facts wearing one sentence. The
// sign-in route says it when no such account exists, when the password is
// wrong, and when the account is disabled — deliberately, because telling a
// stranger which of those it is tells them which addresses are real. A lockout
// is the only one disclosed, because the caller must be told why waiting is
// required.
//
// That is right for the console and useless for the operator, who ends up
// reissuing a password that was already correct — twice, in this federation's
// case — because nothing anywhere would say which of the four it was.
//
// This is the answer, and it reads. It writes nothing, it takes no --force, and
// it cannot lock anybody out.
//
// IT PRINTS NO HASH AND NO CREDENTIAL. Whether a password EXISTS is reported;
// what it is, is not derivable from anything below. An operator who wants the
// credential changed has scripts/reset-password.ts, which says so in its audit
// row.
//
// Requires DATABASE_URL.

import postgres from 'postgres';
import { tlsFor, tlsHint } from './db-tls.mjs';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const email = (arg('email') || '').trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Usage: npm run user:status -- --email <address>');
  process.exit(1);
}

/**
 * Roles, with the two ways one can be present and still grant nothing said out
 * loud: a binding whose status is not active, and one whose expiry has passed.
 * Both render as a live role in any listing that only counts rows.
 */
function describeRoles(rows: any[]): string {
  if (!rows.length) return 'NONE   <-- signs in, and every module refuses';
  const now = Date.now();
  return rows
    .map((b) => {
      const scope = b.scope_id == null ? String(b.scope_type) : `${b.scope_type}:${b.scope_id}`;
      const expired = b.expires_at && new Date(b.expires_at).getTime() <= now;
      const dead = b.status !== 'active' ? ` [${b.status}]` : expired ? ' [expired]' : '';
      return `${b.role} (${scope})${dead}`;
    })
    .join(', ');
}

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15, ...tlsFor(url) });

try {
  const [u] = await sql`
    SELECT id, email, status, password_hash IS NOT NULL AS has_password,
           must_change_password, failed_attempts, locked_until, session_epoch, last_login_at
      FROM users WHERE email = ${email} LIMIT 1
  `;

  if (!u) {
    console.log(`
No account exists with the email ${email}.

That is why the console says "Invalid email or password" — it says the same
thing for an unknown address as for a wrong password, on purpose. Create it:

  npm run user:create -- --email ${email} --role SUPER_ADMIN
`);
    process.exitCode = 1;
  } else {
    // Roles are read separately because an account with no binding can sign in
    // and then find every module refused — which looks like a broken console
    // rather than an account nobody granted anything to.
    // Column names checked against src/db/schema.ts roleBindings: there is no
    // `scope` and no `revoked_at`. Authority is withdrawn by `status`, and the
    // scope is a PAIR — scope_type plus a nullable scope_id, null meaning
    // national. An expiry that has passed grants nothing either, so it is read
    // rather than assumed absent.
    const bindings = await sql`
      SELECT role, scope_type, scope_id, status, expires_at
        FROM role_bindings
       WHERE user_id = ${u.id}
       ORDER BY role
    `;

    const lockedNow = u.locked_until && new Date(u.locked_until).getTime() > Date.now();

    console.log(`
  Email            ${u.email}
  Status           ${u.status}${u.status === 'active' ? '' : '   <-- sign-in is refused, whatever the password is'}
  Password set     ${u.has_password ? 'yes' : 'NO   <-- no credential exists; reset-password will mint one'}
  Must change      ${u.must_change_password}
  Failed attempts  ${u.failed_attempts}
  Locked until     ${u.locked_until ? new Date(u.locked_until).toISOString() : 'not locked'}${lockedNow ? '   <-- LOCKED RIGHT NOW: a correct password is refused until this passes' : ''}
  Session epoch    ${u.session_epoch}
  Last sign-in     ${u.last_login_at ? new Date(u.last_login_at).toISOString() : 'never'}
  Roles            ${describeRoles(bindings)}
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
