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
// Requires DATABASE_URL. Run against the local development database with:
//   DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5433/postgres" npm run user:create -- ...

import postgres from 'postgres';
import crypto from 'node:crypto';
import { hashPassword } from '../src/lib/password.ts';
import { ROLES } from '../src/lib/rbac.ts';

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

// 20 random bytes in base64url — ~160 bits, far past any password policy, and
// generated rather than chosen so it is not a variation on a known password.
const password = crypto.randomBytes(20).toString('base64url');

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 15 });

try {
  const existing = await sql`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
  if (existing.length) {
    console.error(`A user already exists with the email ${email}.`);
    process.exit(1);
  }

  if (scopeType !== 'national') {
    const table = scopeType === 'state' ? 'state_units' : scopeType === 'district' ? 'district_units' : 'dojos';
    const found = await sql`SELECT id FROM ${sql(table)} WHERE id = ${scopeId} LIMIT 1`;
    if (!found.length) {
      console.error(`No ${scopeType} exists with id ${scopeId}. Create the unit first.`);
      process.exit(1);
    }
  }

  const passwordHash = await hashPassword(password);

  const [user] = await sql`
    INSERT INTO users (email, password_hash, status, must_change_password)
    VALUES (${email}, ${passwordHash}, 'active', 'yes')
    RETURNING id, email
  `;

  await sql`
    INSERT INTO role_bindings (user_id, role, scope_type, scope_id, status)
    VALUES (${user.id}, ${role}, ${scopeType}, ${scopeId}, 'active')
  `;

  await sql`
    INSERT INTO audit_events (actor_label, entity_type, entity_id, action, new_value, reason)
    VALUES ('bootstrap-cli', 'user', ${String(user.id)}, 'create',
            ${sql.json({ email, role, scopeType, scopeId })},
            'Account created via bootstrap CLI by a database operator')
  `;

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
  console.error(`\nFailed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 }).catch(() => {});
}
