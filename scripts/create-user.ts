#!/usr/bin/env node
// Create a federation user account and grant it a role.
//
//   npm run user:create -- --email a@b.in --role SUPER_ADMIN
//   npm run user:create -- --email s@b.in --role STATE_ADMIN --scope state:3
//
// This is the BOOTSTRAP: the first account cannot be created through the admin
// console, because signing in to that console requires an account. Operator
// access to the database is the root of trust instead — whoever holds the
// connection string can mint the first administrator, and nobody else can.
//
// The password is generated here and printed ONCE. It is never stored in
// plaintext, never logged elsewhere, and the account is flagged
// must_change_password, so the operator hands over a credential the recipient
// must replace on first use.
//
// ─────────────────────────────────────────────────────────────────────────────
// THREE THINGS THIS SCRIPT IS CAREFUL ABOUT, AND THE FAILURE EACH PREVENTS
// ─────────────────────────────────────────────────────────────────────────────
//
// ONE ACCOUNT, OR NONE. The user row, its role binding and its audit entry go
// in a SINGLE transaction. Written one statement at a time, a fault between
// them — the transaction pooler refusing a statement, a recycled backend, an
// operator's Ctrl-C — leaves a user row with no authority attached. That row is
// not a partial success: it holds the email address hostage so the command
// cannot simply be run again, it grants nothing, and on its way in it retires
// the shared office password, because sharedPasswordAllowed() in src/lib/auth.ts
// switches the federation over as soon as ONE user exists. A half-made
// bootstrap can therefore lock everybody out of a system nobody can yet sign
// in to. Rolled back, the operator just runs the command a second time.
//
// THE CREDENTIAL IS SHOWN EVEN WHEN THE WRITE FAILS. It exists only in this
// process's memory and is unrecoverable once the process ends. An error the
// client sees is not proof the server did not commit — lose the reply to a
// COMMIT and the account exists carrying a password nobody ever read. Printing
// it on the failure path costs nothing and is the only copy there will be.
// The exception is a fault that struck BEFORE the connection was authenticated:
// there the outcome is not in doubt, no account exists, and the password is
// withheld rather than left on screen belonging to nobody.
//
// NO CONNECTION IS EVER ABANDONED. Every exit path closes the pool first.
// Calling process.exit() with a socket still open leaves the server to discover
// the reset itself, and a pooler that counts a slot it has not yet reclaimed
// refuses the NEXT run — which reads as a database fault rather than as the
// tidy refusal it actually was.
//
// Requires DATABASE_URL. Run against the local development database with:
//   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/postgres" npm run user:create -- ...

import postgres from 'postgres';
import crypto from 'node:crypto';
import { tlsFor, tlsHint } from './db-tls.mjs';
import { hashPassword } from '../src/lib/password.ts';
import { ROLES } from '../src/lib/rbac.ts';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/**
 * A refusal the operator can act on — a duplicate email, a scope that does not
 * exist — as distinct from a database fault. It is raised, rather than exited
 * on, so that the one shutdown path still runs; and it is reported WITHOUT the
 * generated credential, because on this path nothing was written and printing a
 * password for an account that does not exist invites somebody to hand it over.
 */
class Refused extends Error {}

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const email = (arg('email') || '').trim().toLowerCase();
const role = (arg('role') || '').trim();
const scope = (arg('scope') || 'national').trim();   // national | state:ID | district:ID | dojo:ID

if (!email || !email.includes('@')) {
  console.error('Usage: npm run user:create -- --email <address> --role <ROLE> [--scope national|state:ID]');
  process.exit(1);
}
if (!ROLES.includes(role as any)) {
  console.error(`--role must be one of:\n  ${ROLES.join('\n  ')}`);
  process.exit(1);
}

const [scopeType, scopeIdRaw] = scope.split(':');
if (!['national', 'state', 'district', 'dojo'].includes(scopeType)) {
  console.error('--scope must be national, or state:ID / district:ID / dojo:ID');
  process.exit(1);
}
const scopeId = scopeType === 'national' ? null : Number(scopeIdRaw);
if (scopeType !== 'national' && !Number.isInteger(scopeId)) {
  console.error(`--scope ${scopeType} requires a numeric id, e.g. --scope ${scopeType}:3`);
  process.exit(1);
}

// Every check above runs before a socket is opened, so an argument mistake
// cannot leave a connection behind.

// 20 random bytes in base64url — ~160 bits, far past any password policy, and
// generated rather than chosen so it is not a variation on a known password.
const password = crypto.randomBytes(20).toString('base64url');

// Writes a password hash, so the connection must be encrypted AND the peer
// verified — see scripts/db-tls.mjs. This ran with no `ssl` option, which
// postgres.js reads as plaintext.
const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15, ...tlsFor(url) });

try {
  // A read then a write, so two operators running this at the same second could
  // both pass this check. That is not the last line of defence: users.email
  // carries the unique index users_email_uk (src/db/schema.ts), so the loser's
  // INSERT fails inside the transaction below and the whole account rolls back.
  // This check exists to turn a driver's constraint-violation text into a
  // sentence naming the address that is already taken.
  const existing = await sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
  if (existing.length) {
    throw new Refused(`A user already exists with the email ${email}. Nothing was changed.`);
  }

  if (scopeType !== 'national') {
    const table = scopeType === 'state' ? 'state_units' : scopeType === 'district' ? 'district_units' : 'dojos';
    const found = await sql`SELECT id FROM ${sql(table)} WHERE id = ${scopeId} LIMIT 1`;
    if (!found.length) {
      throw new Refused(`No ${scopeType} exists with id ${scopeId}. Create the unit first.`);
    }
  }

  // Hashed BEFORE the transaction opens. scrypt at N=2^15 costs ~100ms, and a
  // transaction held open across it pins a pooler backend for no reason.
  const passwordHash = await hashPassword(password);

  // ONE TRANSACTION, or none of it. See the header.
  const user = await sql.begin(async (tx) => {
    const [created] = await tx`
      INSERT INTO users (email, password_hash, status, must_change_password)
      VALUES (${email}, ${passwordHash}, 'active', 'yes')
      RETURNING id, email
    `;

    await tx`
      INSERT INTO role_bindings (user_id, role, scope_type, scope_id, status)
      VALUES (${created.id}, ${role}, ${scopeType}, ${scopeId}, 'active')
    `;

    await tx`
      INSERT INTO audit_events (actor_label, entity_type, entity_id, action, new_value, reason)
      VALUES ('bootstrap-cli', 'user', ${String(created.id)}, 'create',
              ${tx.json({ email, role, scopeType, scopeId })},
              'Account created via bootstrap CLI by a database operator')
    `;

    return created;
  });

  console.log(`
Account created.

  Email     ${user.email}
  Role      ${role} (${scope})
  Password  ${password}

This password is shown ONCE and is not recoverable. Give it to the account
holder over a channel you trust — not the same channel as the email address.
They must change it on first sign-in.
`);
} catch (err: any) {
  const tls = tlsHint(err);

  if (err instanceof Refused) {
    console.error(`\n${err.message}\n`);
  } else if (tls) {
    // The one fault here whose outcome is NOT in doubt. TLS is settled before the
    // startup packet is sent, so there was never a session for a statement to run
    // in. Telling the operator the write "may have landed" would send them hunting
    // for a row that cannot exist, and the way they would check is to run the
    // command again — which fails identically until the CA is supplied. The
    // credential is withheld for the reason a Refused withholds it: it belongs to
    // no account, and a password on screen is one somebody eventually hands on.
    console.error(`\nFailed: ${err.message}`);
    console.error(tls);
    console.error(`
Nothing was written. The connection failed before authentication, so no statement
was ever sent and no account exists for a password to belong to. Fix the trust
problem above and run the command again — each run mints a fresh credential.
`);
  } else {
    // The credential goes out here too. If the transaction rolled back it is
    // worthless and the operator simply re-runs the command; if the COMMIT
    // landed and only its reply was lost, this line is the sole record of the
    // password the account now carries.
    console.error(`
Failed: ${err.message}

The account was probably NOT created — run the command again. If it then reports
that the email already exists, the write did land after all, and this is the only
copy of its credential:

  Email     ${email}
  Password  ${password}
`);
  }
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
