// User accounts and sign-in (§53, §65, §75).
//
// Replaces the single shared office password with per-person accounts, so every
// audited action names a human being rather than "legacy-admin".
//
// The authority model lives in src/lib/rbac.ts. This module only answers two
// questions: who is signing in, and which bindings do they currently hold.
//
// DESIGN DECISION — bindings are looked up per request, never embedded in the
// session cookie. Embedding is faster, but authority would then remain valid
// until the cookie expired: withdrawing a state secretary's role would not take
// effect for up to a week. For a federation, revocation has to be immediate, so
// the cost of one indexed read per request is the right trade.

import { and, eq, sql } from 'drizzle-orm';
import * as s from './schema';
import { hashPassword, verifyPassword, needsRehash, equalizeTiming, passwordProblem } from '@/lib/password';
import { ROLES, type Binding, type Principal, type Role, type ScopeType } from '@/lib/rbac';
import { writeAudit, type AuditContext } from './federation';

type DB = any;

// Lockout policy. Five failures locks the account for fifteen minutes.
//
// Note this is deliberately account-scoped, which means an attacker who knows an
// administrator's email can lock them out on purpose. That denial of service is
// accepted because the alternative — no lockout — makes online guessing viable,
// and it is mitigated by the IP rate limiter in front of the endpoint and by the
// lock expiring on its own rather than needing an administrator to clear it.
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export interface AuthedUser {
  id: number;
  email: string;
  personId: number | null;
  sessionEpoch: number;
  mustChangePassword: boolean;
}

export type SignInResult =
  | { ok: true; user: AuthedUser }
  | { ok: false; reason: 'invalid' | 'locked' | 'disabled' };

function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase().slice(0, 254) : '';
}

/**
 * Verify an email and password.
 *
 * Every failure path returns the same shape and costs roughly the same time:
 * when no user matches we still run a hash comparison, so response timing does
 * not disclose which email addresses hold accounts (§53 enumeration).
 */
export async function signIn(
  db: DB,
  email: unknown,
  password: unknown
): Promise<SignInResult> {
  const addr = normalizeEmail(email);
  const pw = typeof password === 'string' ? password : '';

  if (!addr || !pw) {
    await equalizeTiming(pw);
    return { ok: false, reason: 'invalid' };
  }

  const row = (await db.select().from(s.users).where(eq(s.users.email, addr)).limit(1))[0];
  if (!row) {
    await equalizeTiming(pw);
    return { ok: false, reason: 'invalid' };
  }

  if (row.status === 'disabled') {
    await equalizeTiming(pw);
    return { ok: false, reason: 'disabled' };
  }

  if (row.lockedUntil && new Date(row.lockedUntil).getTime() > Date.now()) {
    await equalizeTiming(pw);
    return { ok: false, reason: 'locked' };
  }

  const good = await verifyPassword(pw, row.passwordHash);

  if (!good) {
    const failed = (row.failedAttempts ?? 0) + 1;
    const lock = failed >= MAX_FAILED;
    await db
      .update(s.users)
      .set({
        failedAttempts: lock ? 0 : failed,
        lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : row.lockedUntil,
        updatedAt: new Date(),
      })
      .where(eq(s.users.id, row.id));
    return { ok: false, reason: lock ? 'locked' : 'invalid' };
  }

  // Success: clear the failure counter and any expired lock.
  const update: Record<string, unknown> = {
    failedAttempts: 0,
    lockedUntil: null,
    lastLoginAt: new Date(),
    updatedAt: new Date(),
  };
  // Opportunistic upgrade: re-hash under current parameters while we hold the
  // plaintext, so raising the cost factor migrates accounts as people sign in.
  if (needsRehash(row.passwordHash)) update.passwordHash = await hashPassword(pw);
  await db.update(s.users).set(update).where(eq(s.users.id, row.id));

  return {
    ok: true,
    user: {
      id: row.id,
      email: row.email,
      personId: row.personId ?? null,
      sessionEpoch: row.sessionEpoch ?? 0,
      mustChangePassword: row.mustChangePassword === 'yes',
    },
  };
}

/**
 * Load the principal for a signed-in user: their identity plus every active
 * role binding. Returns null if the account no longer exists, has been
 * disabled, or its session epoch has moved past the one the caller presented.
 */
export async function resolvePrincipal(
  db: DB,
  userId: number,
  sessionEpoch: number
): Promise<Principal | null> {
  const row = (await db.select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
  if (!row || row.status === 'disabled') return null;
  if ((row.sessionEpoch ?? 0) !== sessionEpoch) return null;   // signed out everywhere

  const rows = await db
    .select()
    .from(s.roleBindings)
    .where(and(eq(s.roleBindings.userId, userId), eq(s.roleBindings.status, 'active')));

  const bindings: Binding[] = rows
    .filter((b: any) => ROLES.includes(b.role as Role))   // ignore roles the code no longer knows
    .map((b: any) => ({
      role: b.role as Role,
      scopeType: b.scopeType as ScopeType,
      scopeId: b.scopeId ?? null,
      status: b.status,
      expiresAt: b.expiresAt ?? null,
    }));

  return { userId: row.id, label: row.email, bindings };
}

/** Invalidate every session for a user — sign out everywhere. */
export async function bumpSessionEpoch(db: DB, ctx: AuditContext, userId: number): Promise<void> {
  await db
    .update(s.users)
    .set({ sessionEpoch: sql`${s.users.sessionEpoch} + 1`, updatedAt: new Date() })
    .where(eq(s.users.id, userId));
  await writeAudit(db, ctx, { entityType: 'user', entityId: userId, action: 'update', newValue: { sessionsRevoked: true } });
}

export interface NewUser {
  email: string;
  password: string;
  personId?: number | null;
  mustChangePassword?: boolean;
}

/**
 * Create a user account. Callers are responsible for authorisation — this is
 * used both by the admin console (which checks `user:write`) and by the
 * bootstrap script (which runs with operator access to the database itself).
 */
export async function createUser(db: DB, input: NewUser): Promise<{ id: number; email: string }> {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes('@')) throw new Error('A valid email address is required');

  const problem = passwordProblem(input.password);
  if (problem) throw new Error(problem);

  const existing = (await db.select().from(s.users).where(eq(s.users.email, email)).limit(1))[0];
  if (existing) throw new Error(`A user already exists with the email ${email}`);

  const rows = await db
    .insert(s.users)
    .values({
      email,
      passwordHash: await hashPassword(input.password),
      personId: input.personId ?? null,
      status: 'active',
      mustChangePassword: input.mustChangePassword ? 'yes' : 'no',
    })
    .returning({ id: s.users.id, email: s.users.email });

  return rows[0];
}

/**
 * Change a password, verifying the current one first.
 *
 * Every other session for the user is invalidated: a password change is what
 * someone does after a suspected compromise, and it would be useless if the
 * attacker's existing session kept working.
 */
export async function changePassword(
  db: DB,
  ctx: AuditContext,
  userId: number,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const row = (await db.select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
  if (!row) throw new Error('Unknown user');

  if (!(await verifyPassword(currentPassword, row.passwordHash))) {
    throw new Error('Current password is incorrect');
  }
  const problem = passwordProblem(newPassword);
  if (problem) throw new Error(problem);
  if (await verifyPassword(newPassword, row.passwordHash)) {
    throw new Error('New password must be different from the current one');
  }

  await db
    .update(s.users)
    .set({
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: 'no',
      sessionEpoch: sql`${s.users.sessionEpoch} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(s.users.id, userId));

  // The password itself never enters the audit record — only that it changed.
  await writeAudit(db, ctx, {
    entityType: 'user',
    entityId: userId,
    action: 'update',
    newValue: { passwordChanged: true, sessionsRevoked: true },
  });
}

/**
 * Bind a role to a user. Authorisation is the caller's responsibility and must
 * go through canGrantRole() — see src/lib/rbac.ts, which forbids granting
 * SUPER_ADMIN/SAFEGUARDING_OFFICER except by a super admin, and forbids
 * granting authority the granter does not itself hold.
 */
export async function grantRole(
  db: DB,
  ctx: AuditContext,
  input: { userId: number; role: Role; scopeType: ScopeType; scopeId: number | null; expiresAt?: Date | null }
): Promise<{ id: number }> {
  if (!ROLES.includes(input.role)) throw new Error(`Unknown role: ${input.role}`);
  if (input.scopeType !== 'national' && input.scopeId == null) {
    throw new Error('A scoped role binding requires a scope id');
  }

  const rows = await db
    .insert(s.roleBindings)
    .values({
      userId: input.userId,
      role: input.role,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      grantedByUserId: ctx.principal.userId ?? null,
      expiresAt: input.expiresAt ?? null,
      status: 'active',
    })
    .onConflictDoUpdate({
      target: [s.roleBindings.userId, s.roleBindings.role, s.roleBindings.scopeType, s.roleBindings.scopeId],
      set: { status: 'active', expiresAt: input.expiresAt ?? null, grantedByUserId: ctx.principal.userId ?? null },
    })
    .returning({ id: s.roleBindings.id });

  await writeAudit(db, ctx, {
    entityType: 'role_binding',
    entityId: rows[0].id,
    action: 'create',
    newValue: { userId: input.userId, role: input.role, scopeType: input.scopeType, scopeId: input.scopeId },
  });
  return rows[0];
}

/** Withdraw a role binding. Never deleted — status moves to revoked (§78). */
export async function revokeRole(db: DB, ctx: AuditContext, bindingId: number, reason: string): Promise<void> {
  if (!reason || !reason.trim()) throw new Error('Revocation requires a reason');

  const before = (await db.select().from(s.roleBindings).where(eq(s.roleBindings.id, bindingId)).limit(1))[0];
  if (!before) throw new Error('Unknown role binding');

  await db.update(s.roleBindings).set({ status: 'revoked' }).where(eq(s.roleBindings.id, bindingId));

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'role_binding',
    entityId: bindingId,
    action: 'revoke',
    oldValue: { role: before.role, scopeType: before.scopeType, scopeId: before.scopeId, status: before.status },
    newValue: { status: 'revoked' },
  });
}

/** Users the console lists, with their active bindings. No password material. */
export async function listUsers(db: DB, limit = 200) {
  const users = await db
    .select({
      id: s.users.id,
      email: s.users.email,
      personId: s.users.personId,
      status: s.users.status,
      lastLoginAt: s.users.lastLoginAt,
      lockedUntil: s.users.lockedUntil,
      mustChangePassword: s.users.mustChangePassword,
    })
    .from(s.users)
    .limit(limit);

  const bindings = await db
    .select()
    .from(s.roleBindings)
    .where(eq(s.roleBindings.status, 'active'));

  return users.map((u: any) => ({
    ...u,
    bindings: bindings
      .filter((b: any) => b.userId === u.id)
      .map((b: any) => ({ id: b.id, role: b.role, scopeType: b.scopeType, scopeId: b.scopeId, expiresAt: b.expiresAt })),
  }));
}
