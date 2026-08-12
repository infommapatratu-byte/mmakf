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

export const scopeType = pgEnum('scope_type', ['national', 'state', 'district', 'dojo']);

export const auditAction = pgEnum('audit_action', [
  'create', 'update', 'delete', 'approve', 'reject', 'revoke',
  'finalize', 'login', 'logout', 'export',
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('dojos_code_uk').on(t.code),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  fedIdx: uniqueIndex('persons_federation_id_uk').on(t.federationId),
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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  personIdx: index('memberships_person_idx').on(t.personId),
  statusIdx: index('memberships_status_idx').on(t.status),
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
