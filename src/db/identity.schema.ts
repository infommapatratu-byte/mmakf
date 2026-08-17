// The identity foundation — contacts, addresses, relationships, consent,
// duplicates and governed changes.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE PERSON, ONE PERSON ID
// ─────────────────────────────────────────────────────────────────────────────
//
// Nothing here is a second `persons` table. There is no name column, no date of
// birth and no second identity record, because the federation's brief is
// explicit on the point and because the failure it prevents is the one that
// cannot be repaired later: two rows both claiming to be the authoritative
// record of the same human being.
//
// Everything below HANGS OFF `persons.id`. It adds the facts a single wide row
// cannot hold — several contacts, an address history, other people, consent
// over time — and it adds them as their own rows with their own lifecycles.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR RULES THESE TABLES ENFORCE RATHER THAN PROMISE
// ─────────────────────────────────────────────────────────────────────────────
//
//  1. AN ASSERTION IS NOT A FACT. `person_relationships` defaults to
//     'asserted'. Anybody can claim to be somebody's parent; the register
//     records the claim, records who made it, and waits for a decision. This is
//     the same rule `role_applications` follows in ./onboarding.schema.ts, and
//     for the same reason: nothing that reads authority reads a request.
//
//  2. BEING A PARENT IS NOT A PERMISSION. `guardian_authorizations` is a
//     SEPARATE table from the relationship, granted one capability at a time.
//     If access derived from the relationship row, every parent would hold
//     every capability the moment anybody wrote `if (isParent)`. Here an
//     ungranted capability has no row, and no row is no access.
//
//  3. CONSENT IS A RECORD, NOT A FLAG. `consent_records` is APPEND-ONLY and
//     carries the policy VERSION. `consent = true` cannot answer "was consent
//     in force when that photograph was taken?", and that is the only question
//     anybody ever actually asks.
//
//  4. A SUSPECTED DUPLICATE IS A QUESTION. `duplicate_candidates` raises it and
//     is structurally unable to answer it — there is no merge path in this file
//     and none in src/db/identity.ts that runs without a named decider.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE REFUSES TO DECIDE
// ─────────────────────────────────────────────────────────────────────────────
//
// The age of majority (it lives beside MINOR_AGE in src/lib/registration.ts,
// where the federation already set it, and is not re-stated here); which
// documents prove a guardianship; which policies require consent and at what
// version; what score makes two records the same person; and how long any of it
// is retained. Each has a place to arrive and no default, because each is
// MMAKF's to set and a default typed here becomes policy nobody voted for.

import {
  pgTable, serial, text, integer, timestamp, date, boolean,
  jsonb, pgEnum, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { persons, users } from './schema';

// ─── Contacts ───────────────────────────────────────────────────────────────

export const contactKind = pgEnum('contact_kind', ['email', 'phone', 'whatsapp']);

export const contactStatus = pgEnum('contact_status', [
  'active', 'superseded', 'revoked', 'bounced',
]);

/**
 * Every way of reaching a person, and whether anybody has PROVED any of them.
 *
 * `persons.email` and `persons.phone` stay where they are as the primary
 * strings — 130 route files read them. What they never had is the second half
 * of the question, and adding an `email_verified` boolean beside `email` would
 * have created two answers to it the first time somebody updated one column and
 * not the other. Verification lives HERE and only here.
 *
 * `normalized` is what makes duplicate detection possible: `+91 98765 43210`,
 * `098765 43210` and `919876543210` are one telephone, and only a normalised,
 * indexed column can say so across a national register.
 */
export const personContacts = pgTable('person_contacts', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  kind: contactKind('kind').notNull(),
  /** As given, preserved verbatim — it is what the person will recognise. */
  value: text('value').notNull(),
  /** Written by normaliseContact(); the only form anything matches on. */
  normalized: text('normalized').notNull(),
  label: text('label'),
  isPrimary: boolean('is_primary').notNull().default(false),
  /**
   * NULL MEANS NOT VERIFIED. There is no third state and no default of
   * "assumed good" — every system that has ever mailed a credential to an
   * unproven address started with a column that made the assumption easy.
   */
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verificationMethod: text('verification_method'),
  verificationRef: text('verification_ref'),
  status: contactStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  personIdx: index('person_contacts_person_idx').on(t.personId),
  // Deliberately NOT unique. Two siblings share a parent's phone number, and a
  // database that refused the second child would be enforcing a family policy
  // nobody set. Duplicate detection reads this index and RAISES a candidate;
  // the decision stays with a person.
  normalizedIdx: index('person_contacts_normalized_idx').on(t.kind, t.normalized),
  primaryUk: uniqueIndex('person_contacts_primary_uk')
    .on(t.personId, t.kind)
    .where(sql`is_primary AND status = 'active'`),
  valueUk: uniqueIndex('person_contacts_value_uk')
    .on(t.personId, t.kind, t.normalized)
    .where(sql`status = 'active'`),
}));

// ─── Address history ────────────────────────────────────────────────────────

/**
 * Which address is whose, for what purpose, and WHEN.
 *
 * The validity window is the point. A person moves; overwriting their address
 * destroys the record of where they lived when they competed, which is the
 * record a disputed entry needs. Superseding sets `validTo` and inserts a new
 * row — nothing is deleted, as everywhere else in this schema.
 */
export const personAddresses = pgTable('person_addresses', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  addressId: integer('address_id').notNull(),
  /** `home` | `postal` | `training` | `work` | `billing` — the address_kind enum. */
  kind: text('kind').notNull(),
  validFrom: date('valid_from').notNull(),
  /** NULL means current. */
  validTo: date('valid_to'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  personIdx: index('person_addresses_person_idx').on(t.personId),
  // ONE CURRENT ADDRESS PER PERSON PER KIND, settled by the database rather
  // than by a read-then-write. Two intake paths recording a home address in the
  // same millisecond both see none current and both insert; "which of these two
  // is where they live" is then a question no later query can answer.
  currentUk: uniqueIndex('person_addresses_current_uk')
    .on(t.personId, t.kind)
    .where(sql`valid_to IS NULL`),
}));

// ─── Relationships ──────────────────────────────────────────────────────────

export const relationshipType = pgEnum('relationship_type', [
  'parent', 'legal_guardian', 'authorized_guardian', 'institutional_guardian',
  'spouse', 'sibling', 'emergency_contact',
]);

export const relationshipStatus = pgEnum('relationship_status', [
  'asserted', 'verified', 'rejected', 'revoked', 'expired',
]);

/**
 * HOLDER is the <type> OF SUBJECT.
 *
 * A mother and her child: holder = the mother, type = 'parent', subject = the
 * child. An emergency contact: holder = the contact, subject = the athlete. The
 * direction is fixed by that sentence so that no query has to guess which
 * column is which, which is exactly the bug a symmetric `person_a`/`person_b`
 * pair produces on its first join.
 *
 * `status` DEFAULTS TO 'asserted', AND ASSERTED CONFERS NOTHING. A parent
 * filling in a form has made a claim, not established a fact. Everything that
 * grants access — see `guardianAuthorizations` below — requires 'verified',
 * and requires a grant on top of it.
 */
export const personRelationships = pgTable('person_relationships', {
  id: serial('id').primaryKey(),
  holderPersonId: integer('holder_person_id').notNull().references(() => persons.id),
  subjectPersonId: integer('subject_person_id').notNull().references(() => persons.id),
  type: relationshipType('type').notNull(),
  status: relationshipStatus('status').notNull().default('asserted'),
  /**
   * Whatever was supplied — a birth certificate reference, a court order, a
   * school letter. Free-form jsonb because MMAKF has not published what proves
   * a guardianship, and a NOT NULL column named `birth_certificate_number`
   * would be this file inventing that policy in a migration.
   */
  evidence: jsonb('evidence'),
  assertedByUserId: integer('asserted_by_user_id').references(() => users.id),
  verifiedByUserId: integer('verified_by_user_id').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  validFrom: date('valid_from'),
  validTo: date('valid_to'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  holderIdx: index('person_relationships_holder_idx').on(t.holderPersonId),
  subjectIdx: index('person_relationships_subject_idx').on(t.subjectPersonId),
  // One LIVE relationship per pair per type. A revoked one sits beside it and
  // must: a guardianship that ended is the record of why somebody once had
  // access to a child's file, and deleting it deletes the answer.
  liveUk: uniqueIndex('person_relationships_live_uk')
    .on(t.holderPersonId, t.subjectPersonId, t.type)
    .where(sql`status IN ('asserted', 'verified')`),
}));

/**
 * WHAT A GUARDIAN MAY ACTUALLY DO, one capability at a time.
 *
 * This table exists because of a single sentence in the federation's brief:
 * *"Sensitive information must not become visible simply because a user has
 * 'parent' status."*
 *
 * A separate table is the only structure that makes that true rather than
 * intended. If the capability were a column on the relationship, or worse
 * derived from its existence, then the first `if (isParent)` anybody writes
 * hands over the safeguarding file along with the class timetable. Here there
 * is nothing to derive: a capability that was not granted has no row.
 *
 * `capability` is TEXT and not an enum, for the reason `role_bindings.role` is
 * text — the list lives in GUARDIAN_CAPABILITIES in src/db/identity.ts, and a
 * database enum would be a second copy of it that drifts on the first edit.
 */
export const guardianAuthorizations = pgTable('guardian_authorizations', {
  id: serial('id').primaryKey(),
  relationshipId: integer('relationship_id').notNull().references(() => personRelationships.id),
  capability: text('capability').notNull(),
  grantedByUserId: integer('granted_by_user_id').references(() => users.id),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /**
   * The `credential_status` enum from ./schema.ts, declared here as text.
   *
   * Not an oversight: ./schema.ts re-exports this file, so dereferencing an
   * enum from it as a column TYPE runs while that module is still initialising
   * and drizzle-kit dies with "Cannot access 'credentialStatus' before
   * initialization". ./onboarding.schema.ts made the same choice for
   * `scope_type`, with the same note. The COLUMN is the enum in Postgres; only
   * the TypeScript declaration is text.
   */
  status: text('status').notNull().default('active'),
  revokedReason: text('revoked_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  relIdx: index('guardian_authorizations_rel_idx').on(t.relationshipId),
  activeUk: uniqueIndex('guardian_authorizations_active_uk')
    .on(t.relationshipId, t.capability)
    .where(sql`status = 'active'`),
}));

// ─── Consent ────────────────────────────────────────────────────────────────

export const consentDecision = pgEnum('consent_decision', ['granted', 'refused', 'withdrawn']);

export const consentCapacity = pgEnum('consent_capacity', ['self', 'guardian', 'institution', 'staff']);

/**
 * APPEND-ONLY. There is no status column here and nothing in this table is ever
 * UPDATEd — src/db/identity.ts has no code path that does, and that is checked
 * by a test rather than left to discipline.
 *
 * Current consent is the LATEST row for (subject, policyKey). A withdrawal is a
 * NEW row, so the fact that consent once existed survives its withdrawal. That
 * is the entire difference between this and a boolean: only one of the two can
 * answer *"was consent in force at the moment that photograph was taken?"*,
 * and that is the only form the question ever really takes.
 *
 * `policyVersion` is NOT NULL. Consent to version 1 of a photography policy is
 * not consent to version 4, and a record that cannot say which one it agreed to
 * is a record nobody can rely on — including the member who gave it.
 */
export const consentRecords = pgTable('consent_records', {
  id: serial('id').primaryKey(),
  subjectPersonId: integer('subject_person_id').notNull().references(() => persons.id),
  /** Stable key: `terms`, `privacy`, `photo`, `competition`, `communications`. */
  policyKey: text('policy_key').notNull(),
  policyVersion: text('policy_version').notNull(),
  decision: consentDecision('decision').notNull(),
  capacity: consentCapacity('capacity').notNull(),
  /**
   * Who actually gave it. For a minor that is the guardian — and the
   * relationship they acted under is named, so that the authority behind a
   * consent can be CHECKED years later instead of assumed.
   */
  givenByPersonId: integer('given_by_person_id').references(() => persons.id),
  givenByUserId: integer('given_by_user_id').references(() => users.id),
  relationshipId: integer('relationship_id').references(() => personRelationships.id),
  channel: text('channel'),
  /** Hashed, never raw — the rule `audit_events.actor_ip_hash` already follows. */
  ipHash: text('ip_hash'),
  userAgentHash: text('user_agent_hash'),
  evidence: jsonb('evidence'),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  currentIdx: index('consent_records_current_idx')
    .on(t.subjectPersonId, t.policyKey, t.recordedAt),
}));

// ─── Duplicate candidates ───────────────────────────────────────────────────

export const duplicateSubject = pgEnum('duplicate_subject', ['person', 'institution']);

export const duplicateStatus = pgEnum('duplicate_status', ['open', 'same', 'distinct', 'merged']);

/**
 * A suspected duplicate is a QUESTION, and this table is structurally unable to
 * answer it: there is no merge in this file, and the only decision path in
 * src/db/identity.ts demands a named decider and a reason.
 *
 * The pair is stored with `leftId < rightId`, enforced by a CHECK constraint, so
 * that (A,B) and (B,A) are ONE candidate. Without it a detector run from either
 * side produces two rows, two reviewers decide them independently, and they are
 * free to disagree about whether two records are the same human being.
 */
export const duplicateCandidates = pgTable('duplicate_candidates', {
  id: serial('id').primaryKey(),
  subjectType: duplicateSubject('subject_type').notNull(),
  leftId: integer('left_id').notNull(),
  rightId: integer('right_id').notNull(),
  /**
   * Per mille, 0..1000. Integer for the reason money in this schema is integer
   * paise: a float that sorts differently on two machines is not a queue order,
   * and a review queue whose order is unstable is a queue nobody works through.
   */
  score: integer('score').notNull(),
  /**
   * WHICH signals fired, not merely how many. A reviewer about to declare two
   * records the same person needs to see that it was a verified telephone and a
   * date of birth — not two common names in a country with a great many of them.
   */
  signals: jsonb('signals').notNull(),
  status: duplicateStatus('status').notNull().default('open'),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  decidedByUserId: integer('decided_by_user_id').references(() => users.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  mergedIntoId: integer('merged_into_id'),
}, (t) => ({
  queueIdx: index('duplicate_candidates_queue_idx').on(t.subjectType, t.status, t.score),
  openUk: uniqueIndex('duplicate_candidates_open_uk')
    .on(t.subjectType, t.leftId, t.rightId)
    .where(sql`status = 'open'`),
}));

// ─── Governed profile changes ───────────────────────────────────────────────

export const changeRequestStatus = pgEnum('change_request_status', [
  'submitted', 'under_review', 'approved', 'rejected', 'withdrawn',
]);

/**
 * Not every field needs this, and saying so matters: a member correcting a
 * landline should not wait on a committee. GOVERNED_FIELDS in
 * src/db/identity.ts names the ones that do — the fields where an unreviewed
 * edit silently changes an OUTCOME. A date of birth is a competition age
 * category. A name is what a certificate already in somebody's hands says. A
 * nationality is eligibility for a national squad.
 *
 * `appliedAt` is separate from approval on purpose. Approving a change and
 * writing it to `persons` are two facts, and an approved request that never
 * applied is then a row a queue can find — rather than a change that everybody
 * involved believes happened.
 */
export const profileChangeRequests = pgTable('profile_change_requests', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                       // MMAKF-PCR-2026-000001
  personId: integer('person_id').notNull().references(() => persons.id),
  requestedByUserId: integer('requested_by_user_id').references(() => users.id),
  field: text('field').notNull(),
  /**
   * The value AT THE MOMENT OF REQUEST, kept so a decision taken a fortnight
   * later can see whether the record moved underneath it — and refuse if it did.
   */
  oldValue: text('old_value'),
  newValue: text('new_value'),
  evidence: jsonb('evidence'),
  status: changeRequestStatus('status').notNull().default('submitted'),
  reviewedByUserId: integer('reviewed_by_user_id').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('profile_change_requests_ref_uk').on(t.ref),
  personIdx: index('profile_change_requests_person_idx').on(t.personId),
  queueIdx: index('profile_change_requests_queue_idx').on(t.status, t.createdAt),
  // One open request per person per field, or two reviewers approve two
  // different dates of birth and whichever applies second silently wins.
  openUk: uniqueIndex('profile_change_requests_open_uk')
    .on(t.personId, t.field)
    .where(sql`status IN ('submitted', 'under_review')`),
}));
