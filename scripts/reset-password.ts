#!/usr/bin/env node
// Reissue the password for a federation user account.
//
//   npm run user:reset-password -- --email you@mmakf.in
//
// This is the RECOVERY PATH, and it is a command rather than a page on purpose.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THERE IS NO "FORGOTTEN PASSWORD" FORM
// ─────────────────────────────────────────────────────────────────────────────
//
// The two self-service designs both fail here, and neither failure is obvious
// until it is written down.
//
// A RESET LINK NEEDS SOMEWHERE TO SEND IT. This project configures no mail
// transport — there is no SMTP host, no API key, no sender domain anywhere in
// src/lib. A form that accepted an address and claimed to have sent a link
// would be a §70 violation in its purest form: a feature that reports success
// and does nothing. The first person to depend on it would be locked out while
// being told help was on the way.
//
// A SECURITY QUESTION WOULD BE WEAKER THAN THE PASSWORD IT REPLACES, and for
// this federation specifically it would be an unusually bad one. The obvious
// question is a date of birth — and `persons.date_of_birth` is a column in this
// very database. An answer that is already a field in the register cannot
// protect the account that reads the register. The same argument retires the
// rest of the genre: a first school, a mother's maiden name and a birthplace are
// all recorded somewhere a determined stranger can reach, they never expire, and
// unlike a password nobody can be told to change one. NIST SP 800-63B stopped
// permitting knowledge-based answers as an authenticator for exactly this.
//
// So recovery rests on the same root of trust that minted the first account:
// WHOEVER HOLDS THE CONNECTION STRING. That is a small, known set of people, it
// requires no mailbox, it cannot be phished from the account holder, and it
// leaves an audit row naming what happened. If the federation later configures
// mail, an emailed one-time link becomes the right front end — and it should
// call this same transaction rather than inventing a second way in.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS DOES THAT SETTING A PASSWORD ALONE WOULD NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// IT SIGNS OUT EVERY EXISTING SESSION. `users.session_epoch` is stamped into
// each session cookie and checked by resolvePrincipal() on every request, so
// incrementing it invalidates all of them at once. A reset is usually performed
// BECAUSE a credential may be in the wrong hands; leaving the intruder's cookie
// working until it expires would make the reset theatre. This is also why the
// account holder is signed out of their own other devices — that is the feature.
//
// IT FLAGS must_change_password. The operator running this necessarily sees the
// new password, so it is a handover credential and not a permanent one. The
// account holder replaces it on first use and the operator's copy stops being
// an account they can enter.
//
// IT REFUSES AN ACCOUNT THAT DOES NOT EXIST rather than reporting success. The
// email is echoed in the refusal because whoever can run this already holds the
// database; there is no account-enumeration boundary left to protect at this
// point, and a silent no-op would send them to look for a password that was
// never issued.
//
// The three cautions from scripts/create-user.ts apply here unchanged: one
// transaction or none; the credential is printed even when the write reports a
// failure, because a lost COMMIT reply is not proof of a rollback; and every
// exit path closes the pool, since a pooler that has not reclaimed a slot
// refuses the next run in a way that reads as a database fault.
//
// Requires DATABASE_URL. Against the local development database:
//   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/postgres" npm run user:reset-password -- --email a@b.in

import postgres from 'postgres';
import crypto from 'node:crypto';
import { tlsFor, tlsHint } from './db-tls.mjs';
import { hashPassword } from '../src/lib/password.ts';

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
  console.error('Usage: npm run user:reset-password -- --email <address>');
  process.exit(1);
}

// Same generator as the bootstrap: 20 random bytes, ~160 bits, never a variation
// on a password anybody has used before.
const password = crypto.randomBytes(20).toString('base64url');

// This mints a NEW PASSWORD and writes its hash. Sending that exchange in
// plaintext would hand the recovery path itself to anyone on the route, which
// is what no `ssl` option meant — postgres.js ships `ssl: false`. Policy lives
// in scripts/db-tls.mjs.
const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15, ...tlsFor(url) });

try {
  const [found] = await sql`SELECT id, email, status FROM users WHERE email = ${email} LIMIT 1`;
  if (!found) {
    throw new Refused(
      `No account exists with the email ${email}. Nothing was changed.\n` +
      `If this is meant to be the first administrator, create it instead:\n` +
      `  npm run user:create -- --email ${email} --role SUPER_ADMIN`
    );
  }

  // A DISABLED ACCOUNT CANNOT SIGN IN, WHATEVER ITS PASSWORD IS.
  //
  // signIn() refuses on status before it looks at the credential, and the route
  // reports that refusal as "Invalid email or password" — deliberately, so a
  // stranger cannot learn which addresses are disabled. The operator standing
  // here is not a stranger, and without this they reissue a perfectly good
  // password, watch it be called invalid, and reissue it again.
  if (found.status !== 'active') {
    for (const line of [
      '',
      `WARNING: this account's status is "${found.status}", not "active".`,
      'A password will still be set below, and it will still be refused at sign-in:',
      'the console answers a disabled account with "Invalid email or password", the',
      'same words it uses for a wrong one. Re-enable the account before handing this',
      'credential to anybody.',
      '',
    ]) console.warn(line);
  }

  // Hashed before the transaction opens; scrypt costs ~100ms and there is no
  // reason to hold a pooler backend across it.
  const passwordHash = await hashPassword(password);

  const updated = await sql.begin(async (tx) => {
    // THE LOCKOUT IS CLEARED HERE, AND IT HAS TO BE.
    //
    // signIn() checks locked_until BEFORE it verifies the password
    // (src/db/users.ts). Reissuing the credential without clearing the lock
    // therefore hands somebody a password that is CORRECT and still refused,
    // for up to fifteen minutes, with the console saying the account is locked
    // — so the documented recovery path did not, on its own, recover anything.
    // Whoever is locked out has usually just spent five attempts earning the
    // lock, which is exactly why they are running this.
    //
    // It costs nothing: the lock exists to slow online guessing against a
    // password that no longer exists a line above this one.
    const [row] = await tx`
      UPDATE users
         SET password_hash = ${passwordHash},
             must_change_password = 'yes',
             failed_attempts = 0,
             locked_until = NULL,
             session_epoch = session_epoch + 1
       WHERE id = ${found.id}
      RETURNING id, email, status, session_epoch
    `;

    // The audit row records that a reset happened and by what route. It carries
    // no hash and no password — an audit trail that quotes the credential is a
    // second place the credential lives.
    await tx`
      INSERT INTO audit_events (actor_label, entity_type, entity_id, action, new_value, reason)
      VALUES ('recovery-cli', 'user', ${String(row.id)}, 'password_reset',
              ${tx.json({ email: row.email, sessionsInvalidated: true, mustChangePassword: true })},
              'Password reissued by a database operator through scripts/reset-password.ts')
    `;

    return row;
  });

  console.log(`
Password reissued.

  Email     ${updated.email}
  Password  ${password}

Every existing session for this account has been signed out. This password is
shown ONCE and is not recoverable. Hand it over on a channel you trust — not the
same channel as the email address — and the holder must change it on first use.
`);
} catch (err: any) {
  if (err instanceof Refused) {
    console.error(`\n${err.message}\n`);
  } else {
    // Not a refusal: the write may or may not have landed. Print the credential,
    // because if it did land this is the only copy that will ever exist.
    console.error(`
Failed: ${err?.message ?? err}

The password was probably NOT changed — run the command again. If the account
still refuses the old password, the write did land after all, and this is the
only copy of its new credential:

  Email     ${email}
  Password  ${password}
`);
  }
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
