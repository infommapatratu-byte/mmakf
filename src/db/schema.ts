// MMAKF Federation OS — core relational schema (Wave 2a).
//
// Scope of this wave: the federation hierarchy, people and their credentials,
// authentication/authorisation, and the audit spine. Grading, certificates,
// competition and commerce build on these in later waves
// (docs/FEDERATION-ARCHITECTURE.md §11).
//
// Design rules enforced here:
//  · Credentials are SEPARATE (§33): rank ≠ instructor ≠ examiner ≠ official ≠ office.
//  · Rank history is APPEND-ONLY (§31): current rank is derived, never overwritten.
//  · Nothing is deleted (§78): status transitions to revoked/expired, with reason.
//  · Every privileged mutation writes an audit_events row (§52).

import {
  pgTable, serial, text, integer, timestamp, date,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
// Civil geography. Imported rather than only re-exported because `persons`
// below carries a real foreign key onto it. There is no cycle: geography.schema
// imports nothing from this file, which is precisely because it is a map and
// not part of the federation hierarchy.
import { adminAreas } from './geography.schema';

// ─── Shared enums ───────────────────────────────────────────────────────────

export const unitStatus = pgEnum('unit_status', [
  'draft', 'provisional', 'active', 'suspended', 'expired', 'revoked',
]);

export const personStatus = pgEnum('person_status', [
  'pending', 'active', 'inactive', 'suspended', 'deceased',
]);

export const membershipCategory = pgEnum('membership_category', [
  'athlete', 'instructor', 'dojo', 'official',
]);

export const membershipStatus = pgEnum('membership_status', [
  'pending', 'active', 'expired', 'suspended', 'revoked',
]);

export const rankKind = pgEnum('rank_kind', ['kyu', 'dan']);

export const rankStatus = pgEnum('rank_status', ['active', 'superseded', 'revoked']);

export const credentialStatus = pgEnum('credential_status', [
  'active', 'expired', 'suspended', 'revoked',
]);

// 'institution' was added in 0011. It is a TENANT scope, not a rung of the
// federation hierarchy: national/state/district/dojo describe where a resource
// sits inside MMAKF, while 'institution' describes a client that sits outside
// it entirely. See scopeContains() in src/lib/rbac.ts, which gives an
// institution binding no federation resource at all.
export const scopeType = pgEnum('scope_type', ['national', 'state', 'district', 'dojo', 'institution']);

export const auditAction = pgEnum('audit_action', [
  'create', 'update', 'delete', 'approve', 'reject', 'revoke',
  'finalize', 'login', 'logout', 'export',
  // Added in migration 0006. A suspension is a governance decision somebody has
  // to answer for; recording it as a generic 'update' makes it indistinguishable
  // from a clerk editing a row, which is the one thing the audit exists to prevent.
  'suspend', 'reinstate',
]);

// ─── Federation hierarchy ───────────────────────────────────────────────────

export const stateUnits = pgTable('state_units', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                     // MMAKF-ST-JH
  state: text('state').notNull(),
  name: text('name').notNull(),
  hqCity: text('hq_city'),
  status: unitStatus('status').notNull().default('draft'),
  charteredOn: date('chartered_on'),
  charterExpiresOn: date('charter_expires_on'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('state_units_code_uk').on(t.code),
  stateIdx: uniqueIndex('state_units_state_uk').on(t.state),
}));

export const districtUnits = pgTable('district_units', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                     // MMAKF-DIST-JH-RMG
  stateUnitId: integer('state_unit_id').notNull().references(() => stateUnits.id),
  district: text('district').notNull(),
  name: text('name').notNull(),
  status: unitStatus('status').notNull().default('draft'),
  charteredOn: date('chartered_on'),
  charterExpiresOn: date('charter_expires_on'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('district_units_code_uk').on(t.code),
  stateIdx: index('district_units_state_idx').on(t.stateUnitId),
}));

export const dojos = pgTable('dojos', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                     // MMAKF-DOJO-JH-RMG-001
  name: text('name').notNull(),
  stateUnitId: integer('state_unit_id').notNull().references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),
  chiefInstructorPersonId: integer('chief_instructor_person_id'),
  addressLine: text('address_line'),
  city: text('city'),
  status: unitStatus('status').notNull().default('draft'),
  affiliatedOn: date('affiliated_on'),
  affiliationExpiresOn: date('affiliation_expires_on'),

  // ── Added by migration 0032 (the scheduling engine) ─────────────────────
  //
  // A club needs a stable public address of its own — /clubs/[slug] — and a
  // clock of its own, because the schedule engine stores wall-clock rules and
  // "the dojo opens at six" is meaningless without one.
  //
  // `slug` is NULLABLE and unique-when-set, deliberately. A club with no slug
  // is NOT published, rather than published under a slug guessed from its name
  // that changes the next time somebody corrects a spelling — a public URL that
  // moves is a link somebody's parent had bookmarked.
  slug: text('slug'),
  timezone: text('timezone').notNull().default('Asia/Kolkata'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('dojos_code_uk').on(t.code),
  slugIdx: uniqueIndex('dojos_slug_uk').on(t.slug).where(sql`slug is not null`),
  stateIdx: index('dojos_state_idx').on(t.stateUnitId),
  districtIdx: index('dojos_district_idx').on(t.districtUnitId),
}));

// ─── People ─────────────────────────────────────────────────────────────────

export const persons = pgTable('persons', {
  id: serial('id').primaryKey(),
  federationId: text('federation_id').notNull(),    // MMAKF-MEM-2026-000001
  fullName: text('full_name').notNull(),
  dob: date('dob'),                                 // PRIVATE — never in public API
  gender: text('gender'),                           // PRIVATE
  photoUrl: text('photo_url'),
  email: text('email'),                             // PRIVATE
  phone: text('phone'),                             // PRIVATE
  city: text('city'),
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),
  dojoId: integer('dojo_id').references(() => dojos.id),
  status: personStatus('status').notNull().default('pending'),
  // The intake record this person was created from — see the note on
  // memberships.sourceRef below. Null for anyone entered by another path.
  sourceRef: text('source_ref'),

  // ── Identity foundation (migration 0025) ────────────────────────────────
  //
  // `fullName` above STAYS, stays NOT NULL, and stays the display name: it is
  // what the certificates say and what the rest of this repository reads. The
  // parts below are ADDITIONAL and nullable, for matching, official forms and
  // addressing somebody correctly.
  //
  // They are NOT back-filled by splitting existing names on spaces. For
  // 'Shihan Pramod Kumar Pathak' that yields a given name of 'Shihan' and a
  // family name of 'Kumar', and a wrong parse is worse than an absent one
  // because nothing downstream can tell it was guessed.
  givenName: text('given_name'),                    // PRIVATE
  middleName: text('middle_name'),                  // PRIVATE
  familyName: text('family_name'),                  // PRIVATE
  preferredName: text('preferred_name'),
  /** ISO 3166-1 alpha-2. Text, not a FK — see the note in migration 0025. */
  nationality: text('nationality'),                 // PRIVATE
  /** BCP-47, e.g. 'as', 'hi', 'en-IN'. */
  preferredLanguage: text('preferred_language'),
  /**
   * WHERE THEY LIVE, in civil geography.
   *
   * Beside `stateUnitId`, never instead of it: that column says which chartered
   * MMAKF body administers this person, and this one says where on the map they
   * are. A member in a state MMAKF has not yet chartered has the second and not
   * the first, and before 0025 the register had nowhere to put them.
   */
  residenceAreaId: integer('residence_area_id').references(() => adminAreas.id),
  /**
   * A normalised, order-independent form of the name, written by the identity
   * service — never typed, never read as a display value. Duplicate detection
   * matches on it, which is what keeps that a bounded index lookup instead of a
   * scan of a national register.
   */
  matchKey: text('match_key'),                      // PRIVATE

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  fedIdx: uniqueIndex('persons_federation_id_uk').on(t.federationId),
  residenceIdx: index('persons_residence_idx').on(t.residenceAreaId),
  matchKeyIdx: index('persons_match_key_idx').on(t.matchKey),
  // At most one person per intake record. Approving the same application twice
  // must not produce two people, and only the database can settle that when the
  // two approvals race — see migration 0013.
  sourceUk: uniqueIndex('persons_source_ref_uk')
    .on(t.sourceRef)
    .where(sql`source_ref is not null`),
  stateIdx: index('persons_state_idx').on(t.stateUnitId),
  dojoIdx: index('persons_dojo_idx').on(t.dojoId),
  nameIdx: index('persons_name_idx').on(t.fullName),
}));

export const memberships = pgTable('memberships', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  category: membershipCategory('category').notNull(),
  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),
  status: membershipStatus('status').notNull().default('pending'),
  issuedByUserId: integer('issued_by_user_id'),
  revokedReason: text('revoked_reason'),
  /**
   * The intake record this register entry was issued from — the id of the row
   * in the public membership-application queue.
   *
   * It exists so an approval can be REPEATED safely. The queue lives in Redis
   * and the register lives here; a decision that reaches one and not the other
   * has to be retriable, and a retry must find the membership it already made
   * rather than making a second one. Null for a membership issued by any other
   * route, which is why the unique index below is partial.
   */
  sourceRef: text('source_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  personIdx: index('memberships_person_idx').on(t.personId),
  statusIdx: index('memberships_status_idx').on(t.status),
  sourceUk: uniqueIndex('memberships_source_ref_uk')
    .on(t.sourceRef)
    .where(sql`source_ref is not null`),
}));

// ─── Credentials (independent of one another — §33) ─────────────────────────

/**
 * Rank history. APPEND-ONLY: a promotion inserts a new row and supersedes the
 * previous one; awarded facts are never edited. Current rank is derived.
 */
export const rankRecords = pgTable('rank_records', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  kind: rankKind('kind').notNull(),
  gradeLabel: text('grade_label').notNull(),        // '9th Kyu', 'Shodan'
  gradeOrdinal: integer('grade_ordinal').notNull(), // kyu: 10..1, dan: 1..10
  awardedOn: date('awarded_on').notNull(),
  gradingEventId: integer('grading_event_id'),      // wave 2c
  certificateId: integer('certificate_id'),         // wave 2b
  syllabusVersion: text('syllabus_version'),
  score: integer('score'),
  status: rankStatus('status').notNull().default('active'),
  revokedReason: text('revoked_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  personIdx: index('rank_records_person_idx').on(t.personId),
  activeIdx: index('rank_records_active_idx').on(t.personId, t.status),
  // At most ONE active rank per person per kind, enforced by the database.
  // Application code supersedes the previous rank before inserting, but two
  // concurrent promotions can both read "no active rank" and both insert —
  // leaving two active rows and making current rank ambiguous. A partial unique
  // index makes that state unrepresentable regardless of how the race lands.
  oneActive: uniqueIndex('rank_records_one_active_uk')
    .on(t.personId, t.kind)
    .where(sql`status = 'active'`),
}));

export const instructorQuals = pgTable('instructor_quals', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  level: text('level').notNull(),                   // assistant | instructor | senior | chief
  grantedOn: date('granted_on').notNull(),
  expiresOn: date('expires_on'),
  status: credentialStatus('status').notNull().default('active'),
  authorityUserId: integer('authority_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ personIdx: index('instructor_quals_person_idx').on(t.personId) }));

export const examinerQuals = pgTable('examiner_quals', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  level: text('level').notNull(),                   // A | B | C | senior | chief
  scope: text('scope').notNull(),                   // kyu_low | kyu_high | dan
  grantedOn: date('granted_on').notNull(),
  expiresOn: date('expires_on'),
  status: credentialStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ personIdx: index('examiner_quals_person_idx').on(t.personId) }));

export const officialQuals = pgTable('official_quals', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  kind: text('kind').notNull(),                     // judge | referee | technical_delegate
  level: text('level'),
  grantedOn: date('granted_on').notNull(),
  expiresOn: date('expires_on'),
  cpdDueOn: date('cpd_due_on'),
  status: credentialStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ personIdx: index('official_quals_person_idx').on(t.personId) }));

export const governancePosts = pgTable('governance_posts', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  office: text('office').notNull(),                 // President, General Secretary, …
  body: text('body').notNull(),                     // national | state | district | committee
  scopeType: scopeType('scope_type').notNull().default('national'),
  scopeId: integer('scope_id'),
  termFrom: date('term_from').notNull(),
  termTo: date('term_to'),
  status: credentialStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ personIdx: index('governance_posts_person_idx').on(t.personId) }));

// ─── Authentication & authorisation ─────────────────────────────────────────

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').references(() => persons.id),
  email: text('email').notNull(),
  passwordHash: text('password_hash'),
  status: text('status').notNull().default('active'),  // active | locked | disabled
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  // Bumping this invalidates every existing session for the user at once —
  // "sign out everywhere", and the lever used when an account is compromised or
  // authority is withdrawn. Sessions carry the epoch they were minted under.
  sessionEpoch: integer('session_epoch').notNull().default(0),
  mustChangePassword: text('must_change_password').notNull().default('no'), // yes | no

  // Multi-factor authentication (TOTP, RFC 6238).
  //
  // The secret is stored encrypted and NEVER leaves the server. Recovery codes
  // are stored HASHED — a database leak must not hand over working bypasses —
  // and each is removed as it is consumed, so a code cannot be replayed even if
  // it was observed.
  //
  // mfaEnrolledAt is set only after a code has been verified. An account that
  // scanned a QR and never proved it works is NOT enrolled, because an
  // administrator who mis-scanned would otherwise lock themselves out of the
  // federation on their next sign-in.
  mfaSecretEncrypted: text('mfa_secret_encrypted'),
  mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true }),
  mfaRecoveryHashes: jsonb('mfa_recovery_hashes'),
  mfaLastUsedAt: timestamp('mfa_last_used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ emailIdx: uniqueIndex('users_email_uk').on(t.email) }));

/**
 * A user holds one or more role bindings, each scoped to a unit. Authority is
 * the union of bindings; scope is always checked against the resource.
 */
export const roleBindings = pgTable('role_bindings', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  role: text('role').notNull(),                     // see src/lib/rbac.ts ROLES
  scopeType: scopeType('scope_type').notNull(),
  scopeId: integer('scope_id'),                     // null for national scope
  grantedByUserId: integer('granted_by_user_id'),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  status: credentialStatus('status').notNull().default('active'),
}, (t) => ({
  userIdx: index('role_bindings_user_idx').on(t.userId),
  uniqueBinding: uniqueIndex('role_bindings_uk').on(t.userId, t.role, t.scopeType, t.scopeId),
}));

// ─── Audit spine (§52) ──────────────────────────────────────────────────────

export const auditEvents = pgTable('audit_events', {
  id: serial('id').primaryKey(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actorUserId: integer('actor_user_id'),
  actorLabel: text('actor_label'),                  // 'admin', unit name, system
  actorRole: text('actor_role'),
  actorIpHash: text('actor_ip_hash'),               // hashed — never a raw IP
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id'),
  action: auditAction('action').notNull(),
  oldValue: jsonb('old_value'),
  newValue: jsonb('new_value'),
  reason: text('reason'),
  authority: text('authority'),
  requestId: text('request_id'),
}, (t) => ({
  entityIdx: index('audit_events_entity_idx').on(t.entityType, t.entityId),
  atIdx: index('audit_events_at_idx').on(t.at),
  actorIdx: index('audit_events_actor_idx').on(t.actorUserId),
}));

// ─── ID sequence allocation (§2: never Date.now()) ──────────────────────────

/**
 * One row per (prefix, year); `next` is incremented atomically to allocate
 * federation IDs such as MMAKF-MEM-2026-000001.
 */
export const idSequences = pgTable('id_sequences', {
  id: serial('id').primaryKey(),
  prefix: text('prefix').notNull(),
  year: integer('year').notNull(),
  next: integer('next').notNull().default(1),
}, (t) => ({ uk: uniqueIndex('id_sequences_uk').on(t.prefix, t.year) }));

// ─── Commerce & finance ─────────────────────────────────────────────────────
//
// Kept in its own file for size, re-exported here so `import * as s from
// './schema'` remains the single entry point and drizzle-kit sees one schema.
export * from './commerce.schema';

// ─── Technical, competition, education, governance ──────────────────────────
//
// Split by domain for size, re-exported here so `import * as s from './schema'`
// stays the single entry point and drizzle-kit sees one schema.
export * from './technical.schema';
export * from './competition.schema';
export * from './education.schema';
export * from './governance.schema';

// Training, engagement and the unified fee architecture. Added to replace nine
// independent monthly prices typed into a content file with ONE versioned fee
// framework whose output depends on who is asking and what they need.
export * from './engagement.schema';

// Onboarding, seller standing and the marketplace review spine. Registration
// confers nothing; authority and the right to sell are both the output of a
// human decision, and a listing is reviewed separately from the seller.
export * from './onboarding.schema';

// What OTHER organisations charge, with the source of every figure. Kept apart
// from the fee framework above by having no relationship to it at all: there is
// no foreign key in either direction, and src/db/fee-recommendation.ts holds no
// database handle with which to bridge them. A benchmark is evidence; an MMAKF
// fee is a decision two people have to make.
export * from './benchmarks.schema';

// Entitlements — the join from a verified payment to the thing it bought.
// Separate from commerce.schema.ts on purpose: those tables record MONEY, and
// these record what the federation ISSUED in return. Conflating them is how a
// system ends up believing that a captured payment is, by itself, a membership.
export * from './entitlement.schema';

// The fee catalogue — what the federation may charge for, as records rather
// than paragraphs. Every entry carries a code, a category, a unit and a display
// policy, and NOT ONE carries an amount: amounts belong to a versioned fee
// rule, which is what stops a 2027 price change rewriting a 2026 invoice.
export * from './fee-catalogue.schema';

// Currency and tax. Both are VERSIONED and both ship EMPTY of numbers, for the
// same reason the fee framework does: a rate is a determination MMAKF has to
// make, and a plausible seeded one is indistinguishable six months later from a
// rate somebody actually approved. What they add is the guarantee that once a
// quotation or an invoice is issued, the tax and the exchange rate are frozen
// ON that record — so a later rate movement can never change what is owed.
export * from './currency.schema';
export * from './tax.schema';

// ─── The marketplace platform (migration 0025) ──────────────────────────────
//
// The shop became a MULTI-SELLER MARKETPLACE. Six files rather than one,
// because the domains genuinely separate and a single file would be six
// thousand lines nobody can navigate:
//
//   seller.schema              who is selling, and on what evidence
//   catalogue.schema           the governed taxonomy, variants, moderation
//   inventory.schema           locations, buckets, the movement ledger
//   marketplace-orders.schema  the seller-order split, shipping, returns
//   marketplace-finance.schema commission, settlement, payouts
//   marketplace-trust.schema   reviews, performance, fraud, promotions
//
// ORDER MATTERS BELOW. `catalogue` references `seller` (brands), `inventory`
// references `catalogue` (variants), `marketplace-orders` references both, and
// `marketplace-finance` references `marketplace-orders`. Re-exporting them out
// of dependency order does not break Drizzle — the table objects are lazily
// referenced — but it makes the dependency direction unreadable, and the one
// cycle that WOULD break things (order_lines → seller_orders) is avoided by
// declaring that foreign key only in SQL. See commerce.schema.ts, `orderLines`.
export * from './seller.schema';
export * from './catalogue.schema';
export * from './inventory.schema';
export * from './marketplace-orders.schema';
export * from './marketplace-finance.schema';
export * from './marketplace-trust.schema';

// Discount and concession policy. TWO models, not one with a flag: a discount
// is commercial and is redeemed with a code, a concession is a decision about a
// person's circumstances and is applied for. They carry different approval
// authority and different audit sensitivity, and a hardship case must never
// reach a marketing report. Both ship EMPTY — MMAKF has approved neither.
export * from './discounts.schema';

// CIVIL GEOGRAPHY — where places are, as opposed to which chartered MMAKF unit
// administers them. The two ladders share no foreign key in either direction,
// and that absence is the feature: the day a district row points at a state
// unit, the register loses the ability to record a member living somewhere the
// federation has not yet chartered.
export * from './geography.schema';

// THE IDENTITY FOUNDATION — verified contacts, address history, relationships,
// what a guardian may actually do, consent as a versioned record, suspected
// duplicates and governed profile changes. Not one of these is a second
// `persons` table; every one of them hangs off `persons.id`, because one person
// is one person id and a parallel identity record is the mistake that cannot be
// undone later.
export * from './identity.schema';

// THE REGULATORY ENGINE — source material, MMAKF's own instruments, the rules
// derived from them, and the determinations they produced. Kept apart from
// governance.schema.ts, which registers FILES: a constitution PDF with a
// checksum is not the same object as an evaluable rule with an effective date,
// and merging them would force every uploaded document to pretend it is
// executable. Provenance is a column here — academy_source, mmakf_regulation
// and external_reference never merge, so academy material cannot reach a
// federation surface by omission.
export * from './policy.schema';

// THE TECHNICAL KNOWLEDGE LIBRARY — what is known about Shotokan technique,
// where each fact came from, and whether MMAKF has endorsed it. Kept apart from
// technical.schema.ts, which is the GRADING AUTHORITY: a movement-level
// description of Heian Nidan is teaching material, not a grading requirement,
// and the two must never be reachable from one another by accident. Provenance
// is mandatory (technical_citations), rights and endorsement are separate axes,
// and 'unverified' is a state the schema is comfortable storing.
export * from './library.schema';
