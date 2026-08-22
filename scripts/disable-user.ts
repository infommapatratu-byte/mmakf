#!/usr/bin/env node
// Disable a federation account, and cut every session it holds.
//
//   npm run user:disable -- --email someone@mmakf.in
//   npm run user:disable -- --email someone@mmakf.in --reason "placeholder account"
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS, AND WHAT WENT WRONG WITHOUT IT
// ─────────────────────────────────────────────────────────────────────────────
//
// The register could CREATE an administrator and reissue its password, and had
// no way to take one away. So when `you@mmakf.in` — a placeholder address out of
// a set of instructions, typed literally — ended up holding SUPER_ADMIN at
// national scope AND signing in, the only remedies were a hand-written UPDATE or
// leaving it there.
//
// A national super administrator on a guessable address is not a tidiness
// problem. It is every record in the federation, reachable by anyone who tries
// the obvious address against a password reset.
//
// ─────────────────────────────────────────────────────────────────────────────
// DISABLE, NOT DELETE, AND THE DIFFERENCE MATTERS
// ─────────────────────────────────────────────────────────────────────────────
//
// Deleting the row would take its audit trail with it — every action the account
// took would point at a user id that no longer resolves, and the register would
// lose the ability to say what was done under it. `status = 'disabled'` is
// refused by signIn() before the password is even examined (src/db/users.ts), so
// the account cannot be used, and everything it did remains attributable.
//
// THE EPOCH BUMP IS THE HALF THAT ACTS IMMEDIATELY. Setting the status alone
// stops the next SIGN-IN; it does nothing to a cookie already issued, and
// resolvePrincipal() would keep honouring it until it expired. Bumping
// session_epoch invalidates every cookie for the account at once, which is what
// "disabled" has to mean when the holder is already inside.
//
// Requires DATABASE_URL.

import postgres from 'postgres';
import { tlsFor, tlsHint } from './db-tls.mjs';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** A refusal the operator can act on, as distinct from a database fault. */
class Refused extends Error {}

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const email = (arg('email') || '').trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('Usage: npm run user:disable -- --email <address> [--reason "why"]');
  process.exit(1);
}
const reason = (arg('reason') || 'Disabled by a database operator through scripts/disable-user.ts').slice(0, 500);

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15, ...tlsFor(url) });

try {
  const [found] = await sql`SELECT id, email, status FROM users WHERE email = ${email} LIMIT 1`;
  if (!found) throw new Refused(`No account exists with the email ${email}. Nothing was changed.`);

  if (found.status === 'disabled') {
    console.log(`\n${email} is already disabled. Nothing was changed.\n`);
  } else {
    // One transaction: an account disabled without its sessions cut is still a
    // way in, and an audit row without the change is a record of nothing.
    const [row] = await sql.begin(async (tx) => {
      const updated = await tx`
        UPDATE users
           SET status = 'disabled',
               session_epoch = session_epoch + 1,
               failed_attempts = 0,
               locked_until = NULL
         WHERE id = ${found.id}
        RETURNING id, email, status, session_epoch
      `;

      // 'suspend' is a member of the audit_action enum. Recording this as a
      // generic 'update' is what migration 0006 argued against: a governance
      // decision somebody has to answer for must not read like a clerk editing
      // a row.
      await tx`
        INSERT INTO audit_events (actor_label, entity_type, entity_id, action, new_value, reason)
        VALUES ('recovery-cli', 'user', ${String(found.id)}, 'suspend',
                ${tx.json({ email: found.email, previousStatus: found.status, sessionsRevoked: true })},
                ${reason})
      `;

      return updated;
    });

    console.log(`
Account disabled.

  Email          ${row.email}
  Status         ${row.status}
  Session epoch  ${row.session_epoch}   (every existing session is now invalid)

Sign-in is refused before the password is examined, so the credential no longer
opens anything. The row is kept, not deleted, so everything done under it stays
attributable in the audit trail.
`);
  }

  // Role bindings are reported rather than revoked. Disabling stops the account
  // dead; what authority it HELD is evidence, and withdrawing it here would
  // quietly edit the record of what this account was able to do.
  const bindings = await sql`
    SELECT role, scope_type, scope_id, status FROM role_bindings WHERE user_id = ${found.id} ORDER BY role
  `;
  if (bindings.length) {
    console.log('Roles it held (left on the record, and now unusable):');
    for (const b of bindings) {
      const scope = b.scope_id == null ? String(b.scope_type) : `${b.scope_type}:${b.scope_id}`;
      console.log(`  ${b.role} (${scope}) [${b.status}]`);
    }
    console.log('');
  }
} catch (err: any) {
  if (err instanceof Refused) {
    console.error(`\n${err.message}\n`);
  } else {
    console.error(`\nFailed: ${err?.message ?? err}\n`);
    const hint = tlsHint(err);
    if (hint) console.error(hint);
  }
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
