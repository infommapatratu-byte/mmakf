// Self-service learner records: the step between "I registered" and "I can pay".
//
// THE DEAD END THIS REMOVES. Public registration creates an account with no
// person attached, by design (registration grants nothing). Everything a
// learner does — enrol, pay, learn, hold a certificate — reads the PERSON. So a
// newly registered student met "Your account is not linked to a member record.
// The federation office makes the link", and nothing in the application could
// make it. No student could register and then pay without manual office work.
//
// TWO DOORS, AND THE RULE THAT KEEPS THEM FROM DUPLICATING PEOPLE:
//
//   claimMemberRecord()     an existing member links their account to the record
//                           the federation already holds, with their member ID
//                           and date of birth. Their history — grades, past
//                           certificates — comes with it. One record, one
//                           account: a record already linked elsewhere is refused.
//   createLearnerProfile()  someone new creates their own record. Refused when a
//                           record with the same email or mobile already exists,
//                           and the person is sent to the claim door instead —
//                           so an existing member cannot accidentally become two.
//
// CHILDREN ARE NOT CREATED HERE. A record for someone under 18 is created with a
// parent or guardian through the federation office; self-service for a minor
// would put a child's record in the register on nobody's verified authority.
//
// The person is created by createPersonForSource() — the register's own path,
// idempotent per source ref, with a federation ID from the atomic allocator —
// acting as the system for this one purpose, audited with the account's id.

import { and, eq, isNull, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { createPersonForSource, writeAudit, type AuditContext } from '@/db/federation';
import { legacyAdminPrincipal } from '@/lib/rbac';
import { queue } from '@/lib/notifications';

type DB = any;

export class LearnerProfileError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'LearnerProfileError';
  }
}

export function isLearnerProfileError(err: unknown): err is LearnerProfileError {
  return err instanceof LearnerProfileError;
}

const NO_MATCH = 'No member record matches that member ID and date of birth. Check both, or write to admin@mmakf.in.';

function isoDate(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

export function ageOn(dob: string, now: Date = new Date()): number {
  const [y, m, d] = dob.split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  const beforeBirthday = now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d);
  if (beforeBirthday) age--;
  return age;
}

/** Digits only, last 10: "+91 98765-43210" and "09876543210" compare equal. */
export function normalisePhone(v: unknown): string | null {
  const digits = String(v ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

async function loadAccount(db: DB, userId: number) {
  const user = (await db.select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
  if (!user) throw new LearnerProfileError('no_account', 'Sign in again.');
  if (user.personId != null) {
    throw new LearnerProfileError('already_linked', 'Your account is already linked to a member record.');
  }
  return user;
}

async function link(db: DB, userId: number, personId: number) {
  const [row] = await db.update(s.users).set({ personId, updatedAt: new Date() })
    .where(and(eq(s.users.id, userId), isNull(s.users.personId)))
    .returning({ id: s.users.id });
  if (!row) throw new LearnerProfileError('already_linked', 'Your account was linked a moment ago. Refresh the page.');
}

const systemCtx = (userId: number, what: string): AuditContext => ({
  principal: legacyAdminPrincipal(),
  reason: `${what} by the holder of account #${userId}, through the self-service member area.`,
  authority: 'self-service',
});

/**
 * Link the signed-in account to the member record the federation already holds.
 * The same refusal is given for "no such ID" and "wrong date of birth", so the
 * form cannot be used to discover which member IDs exist.
 */
export async function claimMemberRecord(
  db: DB,
  input: { userId: number; federationId: string; dob: string },
): Promise<{ personId: number; federationId: string; fullName: string }> {
  const user = await loadAccount(db, input.userId);
  const id = String(input.federationId ?? '').trim().toUpperCase();
  const dob = isoDate(input.dob);
  if (!id || !dob) throw new LearnerProfileError('bad_input', 'Enter your member ID and your date of birth.');

  const person = (await db.select().from(s.persons)
    .where(sql`upper(${s.persons.federationId}) = ${id}`).limit(1))[0];
  if (!person || !person.dob || String(person.dob) !== dob) {
    throw new LearnerProfileError('no_match', NO_MATCH);
  }
  if (person.status === 'deceased' || person.status === 'suspended') {
    throw new LearnerProfileError('not_claimable', 'This member record cannot be linked online. Write to admin@mmakf.in.');
  }
  const other = (await db.select({ id: s.users.id }).from(s.users)
    .where(eq(s.users.personId, person.id)).limit(1))[0];
  if (other) {
    throw new LearnerProfileError('linked_elsewhere', 'This member record is already linked to another sign-in. Write to admin@mmakf.in if that is not you.');
  }

  await link(db, user.id, person.id);
  await writeAudit(db, systemCtx(user.id, 'Member record claimed'), {
    entityType: 'user', entityId: user.id, action: 'update',
    newValue: { personId: person.id, federationId: person.federationId, method: 'member ID + date of birth' },
  });
  // Tell the record's own address, if it differs: a claim made with somebody
  // else's ID and date of birth is then noticed by the real member.
  if (person.email && String(person.email).toLowerCase() !== String(user.email).toLowerCase()) {
    await queue(db, {
      personId: person.id,
      channel: 'email',
      title: 'Your MMAKF member record was linked to a sign-in',
      body: `Your member record ${person.federationId} was linked to the MMAKF sign-in ${user.email}. If this was not you, write to admin@mmakf.in straight away.`,
      linkUrl: '/my',
    });
  }
  return { personId: person.id, federationId: person.federationId, fullName: person.fullName };
}

/**
 * Create a learner record for someone new to MMAKF and link it to their account.
 */
export async function createLearnerProfile(
  db: DB,
  input: { userId: number; fullName: string; dob: string; phone: string; city?: string | null },
  now: Date = new Date(),
): Promise<{ personId: number; federationId: string; created: boolean }> {
  const user = await loadAccount(db, input.userId);
  const fullName = String(input.fullName ?? '').trim().replace(/\s+/g, ' ');
  const dob = isoDate(input.dob);
  const phone = normalisePhone(input.phone);
  if (fullName.length < 2 || fullName.length > 120) throw new LearnerProfileError('bad_input', 'Enter your full name.');
  if (!dob) throw new LearnerProfileError('bad_input', 'Enter your date of birth.');
  if (!phone) throw new LearnerProfileError('bad_input', 'Enter a 10-digit mobile number.');
  const age = ageOn(dob, now);
  if (age < 0 || age > 110) throw new LearnerProfileError('bad_input', 'Check your date of birth.');
  if (age < 18) {
    throw new LearnerProfileError(
      'minor',
      'A record for someone under 18 is created with a parent or guardian by the federation office. Write to admin@mmakf.in with the child’s name and date of birth.',
    );
  }

  // Never a second record for an existing member.
  const email = String(user.email).toLowerCase();
  const dupe = (await db.select({ id: s.persons.id }).from(s.persons)
    .where(sql`lower(${s.persons.email}) = ${email} or right(regexp_replace(coalesce(${s.persons.phone}, ''), '[^0-9]', '', 'g'), 10) = ${phone}`)
    .limit(1))[0];
  if (dupe) {
    throw new LearnerProfileError(
      'possible_duplicate',
      'The federation already holds a member record with this email address or mobile number. Link it with your member ID and date of birth instead, or write to admin@mmakf.in.',
    );
  }

  const person = await createPersonForSource(db, systemCtx(user.id, 'Learner record created'), {
    fullName,
    dob,
    phone,
    email,
    city: input.city ? String(input.city).trim().slice(0, 80) : null,
    sourceRef: `self-registration:user:${user.id}`,
    status: 'pending',
  });
  await link(db, user.id, person.id);
  await writeAudit(db, systemCtx(user.id, 'Learner record linked'), {
    entityType: 'user', entityId: user.id, action: 'update',
    newValue: { personId: person.id, federationId: person.federationId, method: 'self-registration' },
  });
  return { personId: person.id, federationId: person.federationId, created: person.created };
}
