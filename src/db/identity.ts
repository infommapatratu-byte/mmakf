// The identity foundation — contacts, addresses, relationships, guardianship,
// consent, duplicates and governed profile changes.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR REFUSALS THIS MODULE IS BUILT AROUND
// ─────────────────────────────────────────────────────────────────────────────
//
//  1. IT WILL NOT TREAT AN ASSERTION AS A FACT. Anybody may claim to be a
//     child's parent. assertRelationship() records the claim and returns a row
//     with status 'asserted', which confers nothing anywhere in this file.
//
//  2. IT WILL NOT DERIVE ACCESS FROM A RELATIONSHIP. guardianCan() requires a
//     VERIFIED relationship AND a granted capability AND that neither has
//     expired. Being a parent is not a permission; there is no code path here
//     in which it becomes one.
//
//  3. IT WILL NOT MERGE TWO PEOPLE. detectPersonDuplicates() raises candidates.
//     decideDuplicate() records a human's decision. Nothing in this module
//     rewrites one person's records onto another, and that absence is
//     deliberate: an incorrect merge of two national identity records is not
//     reversible by any code that could be written afterwards.
//
//  4. IT WILL NOT OVERWRITE A GOVERNED FIELD. A date of birth is a competition
//     age category and a name is what a certificate already in somebody's hands
//     says. Those move through requestProfileChange() → decision → apply, and
//     the apply step re-reads the record and REFUSES if it moved underneath the
//     decision.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS NOT DECIDED HERE
// ─────────────────────────────────────────────────────────────────────────────
//
// Which documents prove a guardianship. Which policies require consent, and at
// what version. What score means two records are the same person — DUPLICATE_
// REVIEW_THRESHOLD below decides only what reaches a QUEUE, never what is true.
// How long any of it is retained. Each is MMAKF's to set; each has a place to
// arrive and no invented default.
//
// The age of majority is NOT redefined here either. It is MINOR_AGE in
// src/lib/registration.ts, where the federation already set it, and isMinor()
// below imports it rather than writing 18 a second time.

import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import * as s from './schema';
import * as idn from './identity.schema';
import { allocateFederationId, writeAudit, type AuditContext } from './federation';
import { recordAddress, type AddressInput } from './geography';
import { isUniqueViolation } from './pgerror';
import { MINOR_AGE } from '@/lib/registration';
import {
  assertCan, assertCanAnywhere, can, canAnywhere, visibleScopes,
  type Principal,
} from '@/lib/rbac';

type DB = any;

export class IdentityError extends Error {
  readonly code: string;
  readonly field?: string;
  constructor(code: string, message: string, field?: string) {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
    this.field = field;
  }
}

/** Shape check, not `instanceof` — see the note in src/lib/workflow.ts. */
export function isIdentityError(err: unknown): err is IdentityError {
  return !!err && typeof err === 'object' && (err as any).name === 'IdentityError'
    && typeof (err as any).code === 'string';
}

// ─── Age ────────────────────────────────────────────────────────────────────

/**
 * Whole years between a date of birth and a reference date.
 *
 * Computed on the calendar, not by dividing milliseconds. A year is not
 * 365.25 days, and an athlete born on 29 February whose age is computed by
 * division lands in the wrong competition category roughly one year in four.
 */
export function ageOn(dob: string | Date | null | undefined, asOf: Date = new Date()): number | null {
  if (!dob) return null;
  const d = dob instanceof Date ? dob : new Date(`${String(dob).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;

  let age = asOf.getUTCFullYear() - d.getUTCFullYear();
  const monthDiff = asOf.getUTCMonth() - d.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && asOf.getUTCDate() < d.getUTCDate())) age--;
  return age;
}

/**
 * Is this person a minor?
 *
 * Returns null — not false — when the date of birth is unknown. The difference
 * matters more than anywhere else in this file: a system that answers "not a
 * minor" for an unknown date of birth will hand a child's record to whoever
 * asks. Callers must decide what to do about null, and the safeguarding-shaped
 * ones treat it as "assume minor until told otherwise".
 */
export function isMinor(dob: string | Date | null | undefined, asOf: Date = new Date()): boolean | null {
  const age = ageOn(dob, asOf);
  return age == null ? null : age < MINOR_AGE;
}

// ─── Normalisation ──────────────────────────────────────────────────────────

/**
 * The comparable form of a contact. ONE function, used on write and on read.
 *
 * Email: lowercased and trimmed. The local part is NOT otherwise touched —
 * stripping dots or `+tags` is a Gmail convention, and applying it universally
 * declares two different mailboxes at a self-hosted domain to be one person.
 *
 * Phone: digits only, with a leading `0` trunk prefix dropped and a bare
 * ten-digit Indian number given its country code. Without that, `9876543210`
 * and `+91 98765 43210` are two different people in the duplicate index, which
 * is precisely the pair it exists to catch.
 */
export function normaliseContact(kind: 'email' | 'phone' | 'whatsapp', value: string): string {
  const raw = String(value ?? '').trim();
  if (kind === 'email') return raw.toLowerCase();

  let digits = raw.replace(/[^\d]/g, '');
  if (raw.trim().startsWith('+')) return digits;       // already international
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;    // India, the default market
  return digits;
}

/**
 * The duplicate-matching key for a name.
 *
 * Sorted tokens, so that `Pramod Kumar Pathak` and `Pathak Pramod Kumar` — the
 * same person entered by two clerks with different conventions — produce the
 * same key. Honorifics are dropped for the same reason `initials()` in
 * src/lib/people.ts drops them: `Shihan Pramod Pathak` and `Pramod Pathak` are
 * one man.
 *
 * This is a MATCHING key, never a display value and never authoritative. It
 * exists to make the candidate search an index lookup rather than a scan of a
 * national register.
 */
const HONORIFICS = /^(shihan|sensei|senpai|soke|renshi|kyoshi|hanshi|shri|sri|smt|mr|mrs|ms|dr|prof)$/i;

export function computeMatchKey(fullName: string | null | undefined): string | null {
  const tokens = String(fullName ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !HONORIFICS.test(t));
  if (!tokens.length) return null;
  return [...tokens].sort().join(' ');
}

// ─── Contacts ───────────────────────────────────────────────────────────────

export interface ContactInput {
  personId: number;
  kind: 'email' | 'phone' | 'whatsapp';
  value: string;
  label?: string | null;
  /** Make this the primary of its kind, superseding whichever held it. */
  primary?: boolean;
}

async function personPlacement(db: DB, personId: number) {
  const p = (await db.select({
    id: s.persons.id, stateUnitId: s.persons.stateUnitId,
    districtUnitId: s.persons.districtUnitId, dojoId: s.persons.dojoId,
  }).from(s.persons).where(eq(s.persons.id, personId)).limit(1))[0];
  if (!p) throw new IdentityError('unknown_person', 'Unknown person.');
  return {
    stateUnitId: p.stateUnitId, districtUnitId: p.districtUnitId,
    dojoId: p.dojoId, personId: p.id,
  };
}

/**
 * Add a way of reaching somebody. UNVERIFIED — always, without exception.
 *
 * There is no `verified` parameter on this function, and that is the design.
 * Every system that has posted a credential to an unproven address had a
 * convenience flag on its intake path that somebody set because they were sure.
 * Verification is verifyContact(), it takes evidence, and it is a separate act.
 */
export async function addContact(
  db: DB,
  ctx: AuditContext,
  input: ContactInput
): Promise<{ id: number; created: boolean }> {
  const placement = await personPlacement(db, input.personId);
  assertCan(ctx.principal, 'person:write', placement);

  const value = String(input.value ?? '').trim();
  if (!value) throw new IdentityError('empty_contact', 'A contact needs a value.', 'value');
  if (input.kind === 'email' && !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(value)) {
    throw new IdentityError('bad_email', 'That does not look like an email address.', 'value');
  }

  const normalized = normaliseContact(input.kind, value);
  if (!normalized) throw new IdentityError('empty_contact', 'A contact needs a value.', 'value');
  if (input.kind !== 'email' && normalized.length < 8) {
    throw new IdentityError('bad_phone', 'That does not look like a telephone number.', 'value');
  }

  // Already on file and active: return it rather than raising. Re-submitting a
  // form must not fail, and must not produce a second row for one address.
  const existing = (await db.select({ id: idn.personContacts.id })
    .from(idn.personContacts)
    .where(and(
      eq(idn.personContacts.personId, input.personId),
      eq(idn.personContacts.kind, input.kind),
      eq(idn.personContacts.normalized, normalized),
      eq(idn.personContacts.status, 'active'),
    )).limit(1))[0];

  if (existing) {
    if (input.primary) await setPrimaryContact(db, ctx, existing.id);
    return { id: existing.id, created: false };
  }

  // ALWAYS inserted non-primary, then promoted through setPrimaryContact()
  // below if asked.
  //
  // The first version of this function inserted with `isPrimary: input.primary`
  // directly. It satisfied the unique index and left `persons.email` stale —
  // the exact drift setPrimaryContact()'s comment claims cannot happen, because
  // there were quietly TWO writers of the primary flag and only one of them
  // mirrored. Routing every promotion through the one function makes "one
  // writer" true rather than merely intended.
  let id: number;
  try {
    const rows = await db.insert(idn.personContacts).values({
      personId: input.personId,
      kind: input.kind,
      value,
      normalized,
      label: input.label ?? null,
      isPrimary: false,
    }).returning({ id: idn.personContacts.id });
    id = rows[0].id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = (await db.select({ id: idn.personContacts.id })
      .from(idn.personContacts)
      .where(and(
        eq(idn.personContacts.personId, input.personId),
        eq(idn.personContacts.kind, input.kind),
        eq(idn.personContacts.normalized, normalized),
        eq(idn.personContacts.status, 'active'),
      )).limit(1))[0];
    if (!raced) throw err;
    return { id: raced.id, created: false };
  }

  if (input.primary) await setPrimaryContact(db, ctx, id);

  await writeAudit(db, ctx, {
    entityType: 'person_contact', entityId: id, action: 'create',
    // The VALUE is not written into the audit row. An audit trail readable by
    // every auditor must not become a second, unprotected copy of the
    // federation's telephone directory.
    newValue: { personId: input.personId, kind: input.kind, verified: false },
  });
  return { id, created: true };
}

async function clearPrimary(db: DB, personId: number, kind: string): Promise<void> {
  await db.update(idn.personContacts)
    .set({ isPrimary: false, updatedAt: new Date() })
    .where(and(
      eq(idn.personContacts.personId, personId),
      eq(idn.personContacts.kind, kind as any),
      eq(idn.personContacts.isPrimary, true),
    ));
}

/**
 * Promote a contact to primary, and mirror it onto `persons`.
 *
 * `persons.email` / `persons.phone` are the denormalised primary strings that
 * 130 route files already read. Keeping them in step is this function's job and
 * ONLY this function's job — one writer, so the two can drift only through a
 * bug in one place rather than in every place a contact is touched.
 */
export async function setPrimaryContact(db: DB, ctx: AuditContext, contactId: number): Promise<void> {
  const c = (await db.select().from(idn.personContacts)
    .where(eq(idn.personContacts.id, contactId)).limit(1))[0];
  if (!c) throw new IdentityError('unknown_contact', 'Unknown contact.');
  if (c.status !== 'active') {
    throw new IdentityError('contact_inactive', 'A contact that is not active cannot be made primary.');
  }

  const placement = await personPlacement(db, c.personId);
  assertCan(ctx.principal, 'person:write', placement);

  await clearPrimary(db, c.personId, c.kind);
  await db.update(idn.personContacts)
    .set({ isPrimary: true, updatedAt: new Date() })
    .where(eq(idn.personContacts.id, contactId));

  if (c.kind === 'email') {
    await db.update(s.persons).set({ email: c.value, updatedAt: new Date() })
      .where(eq(s.persons.id, c.personId));
  } else if (c.kind === 'phone') {
    await db.update(s.persons).set({ phone: c.value, updatedAt: new Date() })
      .where(eq(s.persons.id, c.personId));
  }
}

/**
 * Record that somebody PROVED a contact.
 *
 * `method` and `ref` are required. "Verified" with no record of how is a claim
 * rather than evidence, and six months later it is indistinguishable from a
 * column somebody set by hand.
 */
export async function verifyContact(
  db: DB,
  ctx: AuditContext,
  input: { contactId: number; method: string; ref: string }
): Promise<void> {
  if (!String(input.method ?? '').trim() || !String(input.ref ?? '').trim()) {
    throw new IdentityError('no_evidence',
      'Verifying a contact requires the method and a reference to the proof.');
  }

  const c = (await db.select().from(idn.personContacts)
    .where(eq(idn.personContacts.id, input.contactId)).limit(1))[0];
  if (!c) throw new IdentityError('unknown_contact', 'Unknown contact.');
  if (c.status !== 'active') {
    throw new IdentityError('contact_inactive', 'That contact is no longer active.');
  }

  const placement = await personPlacement(db, c.personId);
  assertCan(ctx.principal, 'person:write', placement);

  // Already verified: leave the FIRST verification in place. Re-stamping it
  // would move the date on which the federation can say it knew, which is the
  // date that matters in any dispute about what was sent where.
  if (c.verifiedAt) return;

  await db.update(idn.personContacts).set({
    verifiedAt: new Date(),
    verificationMethod: input.method,
    verificationRef: input.ref,
    updatedAt: new Date(),
  }).where(eq(idn.personContacts.id, input.contactId));

  await writeAudit(db, ctx, {
    entityType: 'person_contact', entityId: input.contactId, action: 'update',
    oldValue: { verified: false },
    newValue: { verified: true, method: input.method, ref: input.ref },
  });
}

/** Retire a contact. Never a DELETE — it is how somebody was once reached. */
export async function supersedeContact(
  db: DB,
  ctx: AuditContext,
  input: { contactId: number; status: 'superseded' | 'revoked' | 'bounced'; reason: string }
): Promise<void> {
  const c = (await db.select().from(idn.personContacts)
    .where(eq(idn.personContacts.id, input.contactId)).limit(1))[0];
  if (!c) throw new IdentityError('unknown_contact', 'Unknown contact.');

  const placement = await personPlacement(db, c.personId);
  assertCan(ctx.principal, 'person:write', placement);

  await db.update(idn.personContacts)
    .set({ status: input.status, isPrimary: false, updatedAt: new Date() })
    .where(eq(idn.personContacts.id, input.contactId));

  await writeAudit(db, ctx, {
    entityType: 'person_contact', entityId: input.contactId, action: 'update',
    oldValue: { status: c.status }, newValue: { status: input.status, reason: input.reason },
  });
}

/** Every active contact for a person. PII — gated on 'person:read_pii'. */
export async function contactsFor(db: DB, principal: Principal, personId: number) {
  const placement = await personPlacement(db, personId);
  assertCan(principal, 'person:read_pii', placement);
  return db.select().from(idn.personContacts)
    .where(and(
      eq(idn.personContacts.personId, personId),
      eq(idn.personContacts.status, 'active'),
    ))
    .orderBy(desc(idn.personContacts.isPrimary), asc(idn.personContacts.id));
}

/**
 * Has this person proved a contact of this kind?
 *
 * The check every path that is about to SEND something should make, and the
 * reason it is a function rather than a column: it answers from the contact
 * rows, so it cannot be true while every address on file is unproven.
 */
export async function hasVerifiedContact(
  db: DB, personId: number, kind: 'email' | 'phone' | 'whatsapp'
): Promise<boolean> {
  const rows = await db.select({ id: idn.personContacts.id })
    .from(idn.personContacts)
    .where(and(
      eq(idn.personContacts.personId, personId),
      eq(idn.personContacts.kind, kind),
      eq(idn.personContacts.status, 'active'),
      sql`${idn.personContacts.verifiedAt} IS NOT NULL`,
    )).limit(1);
  return rows.length > 0;
}

// ─── Addresses ──────────────────────────────────────────────────────────────

/**
 * Give a person an address of a given kind, superseding any current one.
 *
 * Two writes, in this order: close the old window, then open the new. The
 * partial unique index on (person, kind) WHERE valid_to IS NULL enforces that
 * exactly one is open, so an interleaved second call fails the insert rather
 * than producing two current home addresses — a state from which no later query
 * can recover the truth.
 */
export async function setPersonAddress(
  db: DB,
  ctx: AuditContext,
  input: {
    personId: number;
    kind: 'home' | 'postal' | 'training' | 'work' | 'billing';
    validFrom?: string | null;
    address: AddressInput;
  }
): Promise<{ personAddressId: number; addressId: number; areaId: number | null; resolution: any }> {
  const placement = await personPlacement(db, input.personId);
  assertCan(ctx.principal, 'person:write', placement);

  const validFrom = input.validFrom ?? new Date().toISOString().slice(0, 10);

  const created = await recordAddress(db, input.address);

  await db.update(idn.personAddresses)
    .set({ validTo: validFrom })
    .where(and(
      eq(idn.personAddresses.personId, input.personId),
      eq(idn.personAddresses.kind, input.kind),
      isNull(idn.personAddresses.validTo),
    ));

  const rows = await db.insert(idn.personAddresses).values({
    personId: input.personId,
    addressId: created.id,
    kind: input.kind,
    validFrom,
  }).returning({ id: idn.personAddresses.id });

  // The civil area a person lives in is mirrored onto `persons` for the same
  // reason the primary email is: it is read on every list and profile, and a
  // join per row across a national register is the query nobody notices until
  // it is the whole database. Home address only — a training address is not
  // where somebody lives.
  if (input.kind === 'home' && created.areaId != null) {
    await db.update(s.persons)
      .set({ residenceAreaId: created.areaId, updatedAt: new Date() })
      .where(eq(s.persons.id, input.personId));
  }

  await writeAudit(db, ctx, {
    entityType: 'person_address', entityId: rows[0].id, action: 'create',
    // The lines of the address are NOT audited. Where a child lives is the
    // single most sensitive field in this schema, and an audit trail is read by
    // more people than the record itself.
    newValue: { personId: input.personId, kind: input.kind, areaId: created.areaId },
  });

  return {
    personAddressId: rows[0].id,
    addressId: created.id,
    areaId: created.areaId,
    resolution: created.resolution,
  };
}

/** Address history, newest window first. PII. */
export async function addressHistory(db: DB, principal: Principal, personId: number) {
  const placement = await personPlacement(db, personId);
  assertCan(principal, 'person:read_pii', placement);
  return db.select().from(idn.personAddresses)
    .where(eq(idn.personAddresses.personId, personId))
    .orderBy(desc(idn.personAddresses.validFrom), desc(idn.personAddresses.id));
}

// ─── Relationships and guardianship ─────────────────────────────────────────

export type RelationshipType = (typeof idn.relationshipType.enumValues)[number];

/**
 * What a guardian may be granted, one capability at a time.
 *
 * The list is short and it is deliberately NOT a hierarchy. `view_medical` does
 * not imply `view_safeguarding`, and nothing implies anything else: an implied
 * capability is a capability nobody granted, and every one of these was chosen
 * because it names a distinct thing a real parent asks for.
 */
export const GUARDIAN_CAPABILITIES = [
  'view_profile',        // name, grade, dojo — the child's own record
  'manage_enrolment',    // enrol, withdraw, change programme
  'pay',                 // invoices and payment on the child's behalf
  'give_consent',        // consent in the guardian capacity
  'view_attendance',
  'view_results',
  'view_medical',        // medical records — gated twice, see below
  'view_safeguarding',   // safeguarding casework — gated twice, see below
] as const;

export type GuardianCapability = (typeof GUARDIAN_CAPABILITIES)[number];

/**
 * The two capabilities that need MORE than authority over guardianship.
 *
 * Granting a parent sight of a medical or safeguarding record is not an
 * administrative act, and the office that verifies guardianships is not
 * automatically the office that may open that door. grantGuardianCapability()
 * demands the matching domain permission ON TOP of 'guardian:verify' for these
 * two — so an operational administrator who can attach a parent to a child
 * still cannot hand them the safeguarding file.
 */
const DOUBLE_GATED: Partial<Record<GuardianCapability, 'medical:read' | 'safeguarding:write'>> = {
  view_medical: 'medical:read',
  view_safeguarding: 'safeguarding:write',
};

/**
 * Record a CLAIM that one person stands in a relationship to another.
 *
 * Status 'asserted'. This confers nothing, is read by nothing that answers an
 * authorisation question, and exists so the claim and its author are on the
 * record before anybody decides about it.
 */
export async function assertRelationship(
  db: DB,
  ctx: AuditContext,
  input: {
    holderPersonId: number;
    subjectPersonId: number;
    type: RelationshipType;
    evidence?: unknown;
    validFrom?: string | null;
  }
): Promise<{ id: number; created: boolean }> {
  if (input.holderPersonId === input.subjectPersonId) {
    throw new IdentityError('self_relationship', 'A person cannot hold a relationship to themselves.');
  }

  // Authority is checked against the SUBJECT — the person whose record gains an
  // adult attached to it. Checking the holder instead would let anyone with
  // authority over their own record attach themselves to a stranger's child.
  const placement = await personPlacement(db, input.subjectPersonId);
  assertCan(ctx.principal, 'person:write', placement);
  await personPlacement(db, input.holderPersonId);      // existence check

  const existing = (await db.select({ id: idn.personRelationships.id })
    .from(idn.personRelationships)
    .where(and(
      eq(idn.personRelationships.holderPersonId, input.holderPersonId),
      eq(idn.personRelationships.subjectPersonId, input.subjectPersonId),
      eq(idn.personRelationships.type, input.type),
      inArray(idn.personRelationships.status, ['asserted', 'verified']),
    )).limit(1))[0];
  if (existing) return { id: existing.id, created: false };

  let id: number;
  try {
    const rows = await db.insert(idn.personRelationships).values({
      holderPersonId: input.holderPersonId,
      subjectPersonId: input.subjectPersonId,
      type: input.type,
      status: 'asserted',
      evidence: (input.evidence ?? null) as any,
      assertedByUserId: ctx.principal.userId ?? null,
      validFrom: input.validFrom ?? null,
    }).returning({ id: idn.personRelationships.id });
    id = rows[0].id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = (await db.select({ id: idn.personRelationships.id })
      .from(idn.personRelationships)
      .where(and(
        eq(idn.personRelationships.holderPersonId, input.holderPersonId),
        eq(idn.personRelationships.subjectPersonId, input.subjectPersonId),
        eq(idn.personRelationships.type, input.type),
        inArray(idn.personRelationships.status, ['asserted', 'verified']),
      )).limit(1))[0];
    if (!raced) throw err;
    return { id: raced.id, created: false };
  }

  await writeAudit(db, ctx, {
    entityType: 'person_relationship', entityId: id, action: 'create',
    newValue: {
      holder: input.holderPersonId, subject: input.subjectPersonId,
      type: input.type, status: 'asserted',
    },
  });
  return { id, created: true };
}

/**
 * Decide a claimed relationship.
 *
 * Gated on 'guardian:verify' — NOT on 'person:write'. Every dojo administrator
 * holds the latter so they can correct a telephone number; attaching an adult
 * to a child's record is a different kind of act and is held by a different set
 * of offices. A reason is required on every outcome, including approval.
 */
export async function decideRelationship(
  db: DB,
  ctx: AuditContext,
  input: {
    relationshipId: number;
    decision: 'verified' | 'rejected';
    reason: string;
  }
): Promise<void> {
  if (!String(input.reason ?? '').trim()) {
    throw new IdentityError('no_reason', 'A decision about a relationship requires a reason.');
  }

  const r = (await db.select().from(idn.personRelationships)
    .where(eq(idn.personRelationships.id, input.relationshipId)).limit(1))[0];
  if (!r) throw new IdentityError('unknown_relationship', 'Unknown relationship.');
  if (r.status !== 'asserted') {
    throw new IdentityError('not_open',
      `That relationship is '${r.status}' and is no longer awaiting a decision.`);
  }

  const placement = await personPlacement(db, r.subjectPersonId);
  assertCan(ctx.principal, 'guardian:verify', placement);

  await db.update(idn.personRelationships).set({
    status: input.decision,
    verifiedByUserId: ctx.principal.userId ?? null,
    verifiedAt: input.decision === 'verified' ? new Date() : null,
    decisionReason: input.reason,
    updatedAt: new Date(),
  }).where(eq(idn.personRelationships.id, input.relationshipId));

  await writeAudit(db, ctx, {
    entityType: 'person_relationship', entityId: input.relationshipId,
    action: input.decision === 'verified' ? 'approve' : 'reject',
    oldValue: { status: r.status },
    newValue: { status: input.decision, reason: input.reason },
  });
}

/**
 * End a relationship. Revocation also revokes everything it authorised.
 *
 * Both halves, in one call, because the failure mode of doing them separately
 * is a guardianship that has ended and a set of capabilities that has not — and
 * guardianCan() would then keep saying yes on the strength of grants whose
 * basis is gone.
 */
export async function revokeRelationship(
  db: DB,
  ctx: AuditContext,
  input: { relationshipId: number; reason: string }
): Promise<void> {
  if (!String(input.reason ?? '').trim()) {
    throw new IdentityError('no_reason', 'Revoking a relationship requires a reason.');
  }

  const r = (await db.select().from(idn.personRelationships)
    .where(eq(idn.personRelationships.id, input.relationshipId)).limit(1))[0];
  if (!r) throw new IdentityError('unknown_relationship', 'Unknown relationship.');

  const placement = await personPlacement(db, r.subjectPersonId);
  assertCan(ctx.principal, 'guardian:verify', placement);

  await db.update(idn.personRelationships).set({
    status: 'revoked',
    decisionReason: input.reason,
    validTo: new Date().toISOString().slice(0, 10),
    updatedAt: new Date(),
  }).where(eq(idn.personRelationships.id, input.relationshipId));

  await db.update(idn.guardianAuthorizations).set({
    status: 'revoked',
    revokedReason: `Relationship revoked: ${input.reason}`,
  }).where(and(
    eq(idn.guardianAuthorizations.relationshipId, input.relationshipId),
    eq(idn.guardianAuthorizations.status, 'active'),
  ));

  await writeAudit(db, ctx, {
    entityType: 'person_relationship', entityId: input.relationshipId, action: 'revoke',
    oldValue: { status: r.status }, newValue: { status: 'revoked', reason: input.reason },
  });
}

/**
 * Grant a guardian one capability over the person they are guardian of.
 *
 * THREE gates, and each one refuses a different mistake:
 *
 *   · the relationship must be VERIFIED — an assertion grants nothing;
 *   · the granter must hold 'guardian:verify' over the subject;
 *   · for the medical and safeguarding capabilities, the granter must ALSO
 *     hold the matching domain permission.
 *
 * The third is the one that makes the federation's own sentence true: a parent
 * does not see the safeguarding file because they are a parent, and the person
 * who attached them to the child cannot hand it over either.
 */
export async function grantGuardianCapability(
  db: DB,
  ctx: AuditContext,
  input: { relationshipId: number; capability: GuardianCapability; expiresAt?: Date | null }
): Promise<{ id: number; created: boolean }> {
  if (!GUARDIAN_CAPABILITIES.includes(input.capability)) {
    throw new IdentityError('unknown_capability', `Unknown guardian capability: ${input.capability}`);
  }

  const r = (await db.select().from(idn.personRelationships)
    .where(eq(idn.personRelationships.id, input.relationshipId)).limit(1))[0];
  if (!r) throw new IdentityError('unknown_relationship', 'Unknown relationship.');
  if (r.status !== 'verified') {
    throw new IdentityError('not_verified',
      'Capabilities may only be granted on a VERIFIED relationship. An assertion confers nothing.');
  }

  const placement = await personPlacement(db, r.subjectPersonId);
  assertCan(ctx.principal, 'guardian:verify', placement);

  const extra = DOUBLE_GATED[input.capability];
  if (extra) assertCan(ctx.principal, extra, placement);

  const existing = (await db.select({ id: idn.guardianAuthorizations.id })
    .from(idn.guardianAuthorizations)
    .where(and(
      eq(idn.guardianAuthorizations.relationshipId, input.relationshipId),
      eq(idn.guardianAuthorizations.capability, input.capability),
      eq(idn.guardianAuthorizations.status, 'active'),
    )).limit(1))[0];
  if (existing) return { id: existing.id, created: false };

  const rows = await db.insert(idn.guardianAuthorizations).values({
    relationshipId: input.relationshipId,
    capability: input.capability,
    grantedByUserId: ctx.principal.userId ?? null,
    expiresAt: input.expiresAt ?? null,
  }).returning({ id: idn.guardianAuthorizations.id });

  await writeAudit(db, ctx, {
    entityType: 'guardian_authorization', entityId: rows[0].id, action: 'create',
    newValue: {
      relationshipId: input.relationshipId, capability: input.capability,
      subject: r.subjectPersonId, holder: r.holderPersonId,
    },
  });
  return { id: rows[0].id, created: true };
}

export async function revokeGuardianCapability(
  db: DB,
  ctx: AuditContext,
  input: { authorizationId: number; reason: string }
): Promise<void> {
  if (!String(input.reason ?? '').trim()) {
    throw new IdentityError('no_reason', 'Revoking a capability requires a reason.');
  }

  const a = (await db.select().from(idn.guardianAuthorizations)
    .where(eq(idn.guardianAuthorizations.id, input.authorizationId)).limit(1))[0];
  if (!a) throw new IdentityError('unknown_authorization', 'Unknown authorization.');

  const r = (await db.select().from(idn.personRelationships)
    .where(eq(idn.personRelationships.id, a.relationshipId)).limit(1))[0];
  const placement = await personPlacement(db, r.subjectPersonId);
  assertCan(ctx.principal, 'guardian:verify', placement);

  await db.update(idn.guardianAuthorizations)
    .set({ status: 'revoked', revokedReason: input.reason })
    .where(eq(idn.guardianAuthorizations.id, input.authorizationId));

  await writeAudit(db, ctx, {
    entityType: 'guardian_authorization', entityId: input.authorizationId, action: 'revoke',
    newValue: { capability: a.capability, reason: input.reason },
  });
}

/**
 * MAY THIS PERSON DO THIS THING FOR THAT PERSON?
 *
 * The single question every parent-facing surface must ask, and the only
 * function in this module that answers it. It is a database question, not a
 * session question: it reads the relationship and the grant, and it fails
 * closed on every branch.
 *
 * Note what it does NOT accept: a role, a session flag, or a claim from the
 * caller that they are a parent. There is no argument through which any of
 * those could be passed in.
 */
export async function guardianCan(
  db: DB,
  input: {
    guardianPersonId: number;
    subjectPersonId: number;
    capability: GuardianCapability;
    asOf?: Date;
  }
): Promise<boolean> {
  if (!GUARDIAN_CAPABILITIES.includes(input.capability)) return false;
  if (input.guardianPersonId === input.subjectPersonId) return false;

  const asOf = input.asOf ?? new Date();
  const today = asOf.toISOString().slice(0, 10);

  const rows = await db
    .select({
      authId: idn.guardianAuthorizations.id,
      expiresAt: idn.guardianAuthorizations.expiresAt,
    })
    .from(idn.guardianAuthorizations)
    .innerJoin(
      idn.personRelationships,
      eq(idn.personRelationships.id, idn.guardianAuthorizations.relationshipId)
    )
    .where(and(
      eq(idn.personRelationships.holderPersonId, input.guardianPersonId),
      eq(idn.personRelationships.subjectPersonId, input.subjectPersonId),
      // VERIFIED only. This single clause is what makes an asserted
      // relationship worth nothing, and it is why the status column has five
      // values rather than a boolean.
      eq(idn.personRelationships.status, 'verified'),
      eq(idn.guardianAuthorizations.capability, input.capability),
      eq(idn.guardianAuthorizations.status, 'active'),
      // The relationship's own validity window, where one was set.
      or(
        isNull(idn.personRelationships.validTo),
        sql`${idn.personRelationships.validTo} >= ${today}`,
      ),
      or(
        isNull(idn.personRelationships.validFrom),
        sql`${idn.personRelationships.validFrom} <= ${today}`,
      ),
    ))
    .limit(1);

  if (!rows.length) return false;

  const expiry = rows[0].expiresAt;
  if (expiry && new Date(expiry).getTime() <= asOf.getTime()) return false;
  return true;
}

/** The children (or other subjects) a person holds a VERIFIED relationship to. */
export async function dependantsOf(db: DB, guardianPersonId: number) {
  return db
    .select({
      relationshipId: idn.personRelationships.id,
      type: idn.personRelationships.type,
      personId: s.persons.id,
      federationId: s.persons.federationId,
      fullName: s.persons.fullName,
      dob: s.persons.dob,
    })
    .from(idn.personRelationships)
    .innerJoin(s.persons, eq(s.persons.id, idn.personRelationships.subjectPersonId))
    .where(and(
      eq(idn.personRelationships.holderPersonId, guardianPersonId),
      eq(idn.personRelationships.status, 'verified'),
    ))
    .orderBy(asc(s.persons.fullName));
}

/** Everybody who holds a relationship to this person. PII. */
export async function guardiansOf(db: DB, principal: Principal, subjectPersonId: number) {
  const placement = await personPlacement(db, subjectPersonId);
  assertCan(principal, 'person:read_pii', placement);
  return db
    .select({
      relationshipId: idn.personRelationships.id,
      type: idn.personRelationships.type,
      status: idn.personRelationships.status,
      personId: s.persons.id,
      fullName: s.persons.fullName,
    })
    .from(idn.personRelationships)
    .innerJoin(s.persons, eq(s.persons.id, idn.personRelationships.holderPersonId))
    .where(eq(idn.personRelationships.subjectPersonId, subjectPersonId))
    .orderBy(asc(idn.personRelationships.id));
}

// ─── Consent ────────────────────────────────────────────────────────────────

export interface ConsentInput {
  subjectPersonId: number;
  policyKey: string;
  policyVersion: string;
  decision: 'granted' | 'refused' | 'withdrawn';
  capacity: 'self' | 'guardian' | 'institution' | 'staff';
  givenByPersonId?: number | null;
  relationshipId?: number | null;
  channel?: string | null;
  ipHash?: string | null;
  userAgentHash?: string | null;
  evidence?: unknown;
}

/**
 * Write a consent record. APPEND ONLY — there is no update path in this module.
 *
 * When the capacity is 'guardian', the authority is CHECKED rather than
 * believed: the named person must actually hold the 'give_consent' capability
 * over the subject. Without that check the capacity field would be a free-text
 * assertion by whoever submitted the form, which is the same as not having one.
 */
export async function recordConsent(
  db: DB,
  ctx: AuditContext,
  input: ConsentInput
): Promise<{ id: number }> {
  if (!String(input.policyKey ?? '').trim()) {
    throw new IdentityError('no_policy', 'A consent record needs a policy key.');
  }
  if (!String(input.policyVersion ?? '').trim()) {
    // The rule the column's NOT NULL already states, checked here so the caller
    // gets a sentence rather than a constraint violation.
    throw new IdentityError('no_version',
      'A consent record must name the policy VERSION it agreed to.');
  }

  await personPlacement(db, input.subjectPersonId);

  if (input.capacity === 'guardian') {
    if (input.givenByPersonId == null) {
      throw new IdentityError('no_guardian',
        'Consent in the guardian capacity must name the person giving it.');
    }
    const permitted = await guardianCan(db, {
      guardianPersonId: input.givenByPersonId,
      subjectPersonId: input.subjectPersonId,
      capability: 'give_consent',
    });
    if (!permitted) {
      throw new IdentityError('not_authorised',
        'That person does not hold a verified guardianship with authority to give consent.');
    }
  }

  const rows = await db.insert(idn.consentRecords).values({
    subjectPersonId: input.subjectPersonId,
    policyKey: input.policyKey.trim(),
    policyVersion: input.policyVersion.trim(),
    decision: input.decision,
    capacity: input.capacity,
    givenByPersonId: input.givenByPersonId ?? null,
    givenByUserId: ctx.principal.userId ?? null,
    relationshipId: input.relationshipId ?? null,
    channel: input.channel ?? null,
    ipHash: input.ipHash ?? null,
    userAgentHash: input.userAgentHash ?? null,
    evidence: (input.evidence ?? null) as any,
  }).returning({ id: idn.consentRecords.id });

  await writeAudit(db, ctx, {
    entityType: 'consent_record', entityId: rows[0].id, action: 'create',
    newValue: {
      subject: input.subjectPersonId, policy: input.policyKey,
      version: input.policyVersion, decision: input.decision, capacity: input.capacity,
    },
  });
  return { id: rows[0].id };
}

/**
 * The consent in force right now for one policy, or null.
 *
 * The LATEST row wins, and a 'withdrawn' or 'refused' latest row means there is
 * no consent — the function returns the record so the caller can see the
 * decision, and `isConsentInForce()` below is the boolean.
 */
export async function currentConsent(db: DB, subjectPersonId: number, policyKey: string) {
  const rows = await db.select().from(idn.consentRecords)
    .where(and(
      eq(idn.consentRecords.subjectPersonId, subjectPersonId),
      eq(idn.consentRecords.policyKey, policyKey),
    ))
    .orderBy(desc(idn.consentRecords.recordedAt), desc(idn.consentRecords.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Is consent in force for this policy AT THIS VERSION?
 *
 * The version argument is not optional and not ignored. Consent to version 1 of
 * a photography policy is not consent to version 4, and a check that omitted
 * the version would report the federation as covered for a policy the member
 * has never seen.
 */
export async function isConsentInForce(
  db: DB, subjectPersonId: number, policyKey: string, policyVersion: string
): Promise<boolean> {
  const current = await currentConsent(db, subjectPersonId, policyKey);
  if (!current) return false;
  if (current.decision !== 'granted') return false;
  return current.policyVersion === policyVersion;
}

/** The full history for a policy — the record a dispute is answered from. */
export async function consentHistory(
  db: DB, principal: Principal, subjectPersonId: number, policyKey?: string
) {
  const placement = await personPlacement(db, subjectPersonId);
  // The ip and user-agent hashes make this PII, quite apart from the decisions.
  assertCan(principal, 'person:read_pii', placement);

  const conditions = [eq(idn.consentRecords.subjectPersonId, subjectPersonId)];
  if (policyKey) conditions.push(eq(idn.consentRecords.policyKey, policyKey));

  return db.select().from(idn.consentRecords)
    .where(and(...conditions))
    .orderBy(desc(idn.consentRecords.recordedAt), desc(idn.consentRecords.id));
}

// ─── Duplicate detection ────────────────────────────────────────────────────

/**
 * What each signal is worth, per mille.
 *
 * These are DETECTION weights, not a truth threshold. Nothing in this module
 * acts on a score; the score decides only what a human is asked to look at, and
 * a candidate at 1000 is still a question. MMAKF has published no rule about
 * when two records are one person, and this constant is not that rule.
 */
const SIGNAL_WEIGHTS = {
  verified_phone: 450,
  verified_email: 450,
  phone: 300,
  email: 300,
  name_and_dob: 400,
  name_and_area: 150,
} as const;

/** Below this, a candidate is not worth a person's time. Tunable, not policy. */
export const DUPLICATE_REVIEW_THRESHOLD = 400;

/**
 * Look for other records that might be the same human being, and RAISE them.
 *
 * Every query below is an INDEX LOOKUP on a bounded key — a normalised contact,
 * a match key — and never a scan or a fuzzy comparison across the register.
 * That is the constraint a 600-million-row table imposes: a similarity search
 * that works beautifully on ten thousand people is an outage on six hundred
 * million, and it is the intake path, so it runs on every registration.
 *
 * Returns the candidates it raised. It does not merge, block or reject anything
 * — a duplicate is a question for a person, and registration continues.
 */
export async function detectPersonDuplicates(
  db: DB,
  personId: number,
  opts: { threshold?: number } = {}
): Promise<Array<{ otherPersonId: number; score: number; signals: string[] }>> {
  const threshold = opts.threshold ?? DUPLICATE_REVIEW_THRESHOLD;

  const me = (await db.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1))[0];
  if (!me) throw new IdentityError('unknown_person', 'Unknown person.');

  /** personId → set of signal names. */
  const hits = new Map<number, Set<string>>();
  const add = (otherId: number, signal: string) => {
    if (otherId === personId) return;
    if (!hits.has(otherId)) hits.set(otherId, new Set());
    hits.get(otherId)!.add(signal);
  };

  // 1 — shared contacts, by the normalised form.
  const myContacts = await db.select().from(idn.personContacts)
    .where(and(
      eq(idn.personContacts.personId, personId),
      eq(idn.personContacts.status, 'active'),
    ));

  for (const c of myContacts) {
    const others = await db.select({
      personId: idn.personContacts.personId,
      verifiedAt: idn.personContacts.verifiedAt,
    })
      .from(idn.personContacts)
      .where(and(
        eq(idn.personContacts.kind, c.kind),
        eq(idn.personContacts.normalized, c.normalized),
        eq(idn.personContacts.status, 'active'),
        ne(idn.personContacts.personId, personId),
      ))
      // Bounded. A number shared by two hundred records is a school's front
      // desk, not two hundred duplicates, and materialising them all would turn
      // one registration into a queue nobody can work.
      .limit(25);

    for (const o of others) {
      const bothVerified = !!c.verifiedAt && !!o.verifiedAt;
      const kind = c.kind === 'email' ? 'email' : 'phone';
      add(o.personId, bothVerified ? `verified_${kind}` : kind);
    }
  }

  // 2 — same name key and same date of birth. The classic pair, and the one
  //     signal here strong enough on its own to be worth a person's time.
  if (me.matchKey && me.dob) {
    const others = await db.select({ id: s.persons.id }).from(s.persons)
      .where(and(
        eq(s.persons.matchKey, me.matchKey),
        eq(s.persons.dob, me.dob),
        ne(s.persons.id, personId),
      )).limit(25);
    for (const o of others) add(o.id, 'name_and_dob');
  }

  // 3 — same name key in the same civil area. Weak on its own, deliberately:
  //     in a country with a great many common names this fires constantly, and
  //     scoring it highly would bury the real matches.
  if (me.matchKey && me.residenceAreaId != null) {
    const others = await db.select({ id: s.persons.id }).from(s.persons)
      .where(and(
        eq(s.persons.matchKey, me.matchKey),
        eq(s.persons.residenceAreaId, me.residenceAreaId),
        ne(s.persons.id, personId),
      )).limit(25);
    for (const o of others) add(o.id, 'name_and_area');
  }

  const raised: Array<{ otherPersonId: number; score: number; signals: string[] }> = [];

  for (const [otherId, signals] of hits) {
    const list = [...signals];
    // Highest single signal, plus a fifth of the rest. Straight addition would
    // let three weak signals outrank one verified telephone, and the weak ones
    // co-occur — same name, same area, same city — so they are not independent
    // evidence and must not be scored as though they were.
    const weights = list
      .map((sig) => SIGNAL_WEIGHTS[sig as keyof typeof SIGNAL_WEIGHTS] ?? 0)
      .sort((a, b) => b - a);
    const score = Math.min(1000, Math.round(weights[0] + weights.slice(1).reduce((n, w) => n + w, 0) / 5));
    if (score < threshold) continue;

    const [leftId, rightId] = personId < otherId ? [personId, otherId] : [otherId, personId];

    try {
      await db.insert(idn.duplicateCandidates).values({
        subjectType: 'person', leftId, rightId, score,
        signals: { signals: list } as any,
      });
    } catch (err) {
      // Already open. The partial unique index is what makes re-running the
      // detector — which happens on every contact added — cheap and safe.
      if (!isUniqueViolation(err)) throw err;
    }
    raised.push({ otherPersonId: otherId, score, signals: list });
  }

  return raised.sort((a, b) => b.score - a.score);
}

/**
 * The review queue, scope-filtered.
 *
 * A state administrator sees the candidates whose people are placed in their
 * state. The filter is applied in SQL against `persons`, not after the fact in
 * JavaScript, for the reason §53 gives: a list that fetches everything and then
 * hides some of it has already read it, and one missing `.filter()` publishes
 * the lot.
 */
export async function duplicateQueue(
  db: DB,
  principal: Principal,
  opts: { limit?: number; afterId?: number | null } = {}
) {
  assertCanAnywhere(principal, 'duplicate:review');
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const scopes = visibleScopes(principal, 'duplicate:review');
  if (scopes.kind === 'none') return [];

  const left = sql`left_person`;
  const conditions: any[] = [eq(idn.duplicateCandidates.status, 'open')];
  if (opts.afterId) conditions.push(sql`${idn.duplicateCandidates.id} > ${opts.afterId}`);

  if (scopes.kind === 'scoped') {
    const states = scopes.states.length ? scopes.states : [-1];
    const districts = scopes.districts.length ? scopes.districts : [-1];
    const dojos = scopes.dojos.length ? scopes.dojos : [-1];
    // EITHER side being in scope brings the pair into view. A duplicate that
    // straddles two states has to be visible to both, or it is worked by
    // neither — and a pair only one administrator can see is a pair that gets
    // decided without the other half's context.
    conditions.push(sql`EXISTS (
      SELECT 1 FROM persons p
      WHERE (p.id = ${idn.duplicateCandidates.leftId} OR p.id = ${idn.duplicateCandidates.rightId})
        AND (
          p.state_unit_id IN ${states}
          OR p.district_unit_id IN ${districts}
          OR p.dojo_id IN ${dojos}
        )
    )`);
  }

  return db.select().from(idn.duplicateCandidates)
    .where(and(...conditions))
    .orderBy(desc(idn.duplicateCandidates.score), asc(idn.duplicateCandidates.id))
    .limit(limit);
}

/**
 * Record a HUMAN's decision about a suspected duplicate.
 *
 * 'merged' is accepted as a decision and PERFORMS NO MERGE. There is no code in
 * this module that rewrites one person's records onto another, and there should
 * not be until MMAKF has decided what a merge means for rank history,
 * membership numbers and certificates already issued. Recording the decision
 * without acting on it is honest; acting on it now would be this file inventing
 * that policy at the moment it is least visible.
 */
export async function decideDuplicate(
  db: DB,
  ctx: AuditContext,
  input: {
    candidateId: number;
    decision: 'same' | 'distinct' | 'merged';
    reason: string;
    mergedIntoId?: number | null;
  }
): Promise<void> {
  assertCanAnywhere(ctx.principal, 'duplicate:review');
  if (!String(input.reason ?? '').trim()) {
    throw new IdentityError('no_reason', 'A duplicate decision requires a reason.');
  }
  if (input.decision === 'merged' && input.mergedIntoId == null) {
    throw new IdentityError('no_target', 'A merge decision must name the surviving record.');
  }

  const c = (await db.select().from(idn.duplicateCandidates)
    .where(eq(idn.duplicateCandidates.id, input.candidateId)).limit(1))[0];
  if (!c) throw new IdentityError('unknown_candidate', 'Unknown duplicate candidate.');
  if (c.status !== 'open') {
    throw new IdentityError('not_open', `That candidate is already '${c.status}'.`);
  }

  if (input.mergedIntoId != null && ![c.leftId, c.rightId].includes(input.mergedIntoId)) {
    throw new IdentityError('bad_target',
      'The surviving record must be one of the two in the candidate.');
  }

  // Scope is re-checked against the actual people, not merely 'anywhere'. The
  // queue filters, and a decision endpoint that trusted the queue's filtering
  // would be an IDOR: the candidate id is in the URL.
  const parties = await db.select({
    id: s.persons.id, stateUnitId: s.persons.stateUnitId,
    districtUnitId: s.persons.districtUnitId, dojoId: s.persons.dojoId,
  }).from(s.persons).where(inArray(s.persons.id, [c.leftId, c.rightId]));

  if (c.subjectType === 'person') {
    const permitted = parties.some((p: any) => can(ctx.principal, 'duplicate:review', {
      stateUnitId: p.stateUnitId, districtUnitId: p.districtUnitId, dojoId: p.dojoId,
    }));
    if (!permitted) assertCanAnywhere(ctx.principal, 'duplicate:review');
  }

  await db.update(idn.duplicateCandidates).set({
    status: input.decision,
    decidedByUserId: ctx.principal.userId ?? null,
    decidedAt: new Date(),
    decisionReason: input.reason,
    mergedIntoId: input.mergedIntoId ?? null,
  }).where(eq(idn.duplicateCandidates.id, input.candidateId));

  await writeAudit(db, ctx, {
    entityType: 'duplicate_candidate', entityId: input.candidateId, action: 'update',
    oldValue: { status: 'open', left: c.leftId, right: c.rightId, score: c.score },
    newValue: { status: input.decision, reason: input.reason, mergedInto: input.mergedIntoId ?? null },
  });
}

// ─── Governed profile changes ───────────────────────────────────────────────

/**
 * The fields an unreviewed edit must not touch.
 *
 * Each is here because changing it silently changes an OUTCOME somewhere else:
 * a date of birth is a competition age category; a name is what a certificate
 * already in somebody's hands says; a nationality is national-squad
 * eligibility; a gender is a competition category.
 *
 * Everything NOT in this list is an ordinary edit. A member correcting their
 * landline does not wait on a committee, and a governance model that made them
 * would be routed around within a week.
 */
export const GOVERNED_FIELDS = [
  'fullName', 'givenName', 'middleName', 'familyName',
  'dob', 'gender', 'nationality',
] as const;

export type GovernedField = (typeof GOVERNED_FIELDS)[number];

export function isGovernedField(field: string): field is GovernedField {
  return (GOVERNED_FIELDS as readonly string[]).includes(field);
}

/**
 * Ask for a governed field to be changed.
 *
 * `oldValue` is captured HERE, from the record as it stands, rather than being
 * accepted from the caller. A caller-supplied old value is a caller-supplied
 * story about what the record used to say, and the whole point of storing it is
 * to detect that the record moved while the request was in the queue.
 */
export async function requestProfileChange(
  db: DB,
  ctx: AuditContext,
  input: { personId: number; field: string; newValue: string; evidence?: unknown }
): Promise<{ id: number; ref: string }> {
  if (!isGovernedField(input.field)) {
    throw new IdentityError('not_governed',
      `'${input.field}' is not a governed field — change it directly.`, 'field');
  }
  if (!String(input.newValue ?? '').trim()) {
    throw new IdentityError('no_value', 'A change request needs the new value.', 'newValue');
  }

  const placement = await personPlacement(db, input.personId);
  // The person's own record, or somebody with authority over it. `personId` on
  // the resource is what lets rbac.ts recognise self-service.
  assertCan(ctx.principal, 'person:write', placement);

  const person = (await db.select().from(s.persons)
    .where(eq(s.persons.id, input.personId)).limit(1))[0];
  const oldValue = person[input.field] == null ? null : String(person[input.field]);

  if (oldValue === input.newValue.trim()) {
    throw new IdentityError('no_change', 'The record already says that.', 'newValue');
  }

  const ref = await allocateFederationId(db, 'PCR');

  try {
    const rows = await db.insert(idn.profileChangeRequests).values({
      ref,
      personId: input.personId,
      requestedByUserId: ctx.principal.userId ?? null,
      field: input.field,
      oldValue,
      newValue: input.newValue.trim(),
      evidence: (input.evidence ?? null) as any,
    }).returning({ id: idn.profileChangeRequests.id });

    await writeAudit(db, ctx, {
      entityType: 'profile_change_request', entityId: rows[0].id, action: 'create',
      newValue: { ref, personId: input.personId, field: input.field },
    });
    return { id: rows[0].id, ref };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw new IdentityError('already_open',
      `There is already an open request to change ${input.field} for this person.`, 'field');
  }
}

/**
 * Decide a change request, and APPLY it when approved.
 *
 * The apply step re-reads the record inside the same call and refuses if the
 * field moved since the request was filed. A fortnight-old approval written
 * blindly over a value somebody has since corrected is a silent regression, and
 * it is the reason `oldValue` is stored at all.
 *
 * `appliedAt` is set only after the write to `persons` succeeds. An approved
 * request with a null `appliedAt` is then a row a queue can find, rather than a
 * change everyone believes happened.
 */
export async function decideProfileChange(
  db: DB,
  ctx: AuditContext,
  input: { requestId: number; decision: 'approved' | 'rejected'; reason: string }
): Promise<{ applied: boolean }> {
  if (!String(input.reason ?? '').trim()) {
    throw new IdentityError('no_reason', 'A decision on a change request requires a reason.');
  }

  const r = (await db.select().from(idn.profileChangeRequests)
    .where(eq(idn.profileChangeRequests.id, input.requestId)).limit(1))[0];
  if (!r) throw new IdentityError('unknown_request', 'Unknown change request.');
  if (!['submitted', 'under_review'].includes(r.status)) {
    throw new IdentityError('not_open', `That request is '${r.status}'.`);
  }

  const placement = await personPlacement(db, r.personId);
  assertCan(ctx.principal, 'profilechange:decide', placement);

  // The decider must not be the requester. A change to a date of birth approved
  // by the person who asked for it is not a governed change; it is an edit with
  // extra steps.
  if (r.requestedByUserId != null && ctx.principal.userId != null
      && r.requestedByUserId === ctx.principal.userId) {
    throw new IdentityError('self_decision',
      'A change request must be decided by somebody other than the person who filed it.');
  }

  if (input.decision === 'rejected') {
    await db.update(idn.profileChangeRequests).set({
      status: 'rejected',
      reviewedByUserId: ctx.principal.userId ?? null,
      reviewedAt: new Date(),
      decisionReason: input.reason,
      updatedAt: new Date(),
    }).where(eq(idn.profileChangeRequests.id, input.requestId));

    await writeAudit(db, ctx, {
      entityType: 'profile_change_request', entityId: input.requestId, action: 'reject',
      newValue: { field: r.field, reason: input.reason },
    });
    return { applied: false };
  }

  const person = (await db.select().from(s.persons)
    .where(eq(s.persons.id, r.personId)).limit(1))[0];
  const currentValue = person[r.field] == null ? null : String(person[r.field]);

  if (currentValue !== r.oldValue) {
    throw new IdentityError('record_moved',
      `The record changed since this request was filed: ${r.field} now reads `
      + `'${currentValue ?? '(empty)'}', not '${r.oldValue ?? '(empty)'}'. `
      + 'File a fresh request against the current value.');
  }

  const patch: Record<string, unknown> = { [r.field]: r.newValue, updatedAt: new Date() };
  // A name change moves the matching key with it. Leaving it stale would make
  // duplicate detection go on matching the name the person no longer has.
  if (r.field === 'fullName') patch.matchKey = computeMatchKey(r.newValue);

  await db.update(s.persons).set(patch).where(eq(s.persons.id, r.personId));

  await db.update(idn.profileChangeRequests).set({
    status: 'approved',
    reviewedByUserId: ctx.principal.userId ?? null,
    reviewedAt: new Date(),
    decisionReason: input.reason,
    appliedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(idn.profileChangeRequests.id, input.requestId));

  await writeAudit(db, ctx, {
    entityType: 'person', entityId: r.personId, action: 'update',
    oldValue: { [r.field]: r.oldValue },
    newValue: { [r.field]: r.newValue, viaRequest: r.ref, reason: input.reason },
  });
  return { applied: true };
}

/** The change-request queue, scope-filtered in SQL. */
export async function profileChangeQueue(
  db: DB,
  principal: Principal,
  opts: { limit?: number; afterId?: number | null } = {}
) {
  assertCanAnywhere(principal, 'profilechange:decide');
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const scopes = visibleScopes(principal, 'profilechange:decide');
  if (scopes.kind === 'none') return [];

  const conditions: any[] = [
    inArray(idn.profileChangeRequests.status, ['submitted', 'under_review']),
  ];
  if (opts.afterId) conditions.push(sql`${idn.profileChangeRequests.id} > ${opts.afterId}`);

  if (scopes.kind === 'scoped') {
    const states = scopes.states.length ? scopes.states : [-1];
    const districts = scopes.districts.length ? scopes.districts : [-1];
    const dojos = scopes.dojos.length ? scopes.dojos : [-1];
    conditions.push(sql`EXISTS (
      SELECT 1 FROM persons p
      WHERE p.id = ${idn.profileChangeRequests.personId}
        AND (
          p.state_unit_id IN ${states}
          OR p.district_unit_id IN ${districts}
          OR p.dojo_id IN ${dojos}
        )
    )`);
  }

  return db.select().from(idn.profileChangeRequests)
    .where(and(...conditions))
    .orderBy(asc(idn.profileChangeRequests.createdAt), asc(idn.profileChangeRequests.id))
    .limit(limit);
}

// ─── Keeping the match key current ──────────────────────────────────────────

/**
 * Backfill `persons.match_key` for records that have none.
 *
 * Keyset paginated and batched, because it runs over the whole register and a
 * single UPDATE across 600 million rows takes a lock nobody can wait out. The
 * caller loops until it returns 0.
 *
 * Note it does NOT touch given/family name. Splitting an existing `full_name`
 * on spaces produces a family name of 'Kumar' for 'Shihan Pramod Kumar Pathak',
 * and a wrong parse is worse than an absent one because nothing downstream can
 * tell it was guessed. The match key is order-independent, so it is safe to
 * derive; the name parts are not.
 */
export async function backfillMatchKeys(
  db: DB, opts: { batch?: number; afterId?: number } = {}
): Promise<{ updated: number; lastId: number | null }> {
  const batch = Math.min(Math.max(opts.batch ?? 500, 1), 5000);

  const rows = await db.select({ id: s.persons.id, fullName: s.persons.fullName })
    .from(s.persons)
    .where(and(
      isNull(s.persons.matchKey),
      opts.afterId ? sql`${s.persons.id} > ${opts.afterId}` : undefined,
    ))
    .orderBy(asc(s.persons.id))
    .limit(batch);

  let updated = 0;
  for (const row of rows) {
    const key = computeMatchKey(row.fullName);
    if (!key) continue;
    await db.update(s.persons).set({ matchKey: key }).where(eq(s.persons.id, row.id));
    updated++;
  }

  return { updated, lastId: rows.length ? rows[rows.length - 1].id : null };
}
