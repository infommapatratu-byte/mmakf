// Shotokan technical system, grading engine and certificates.
//
// This is the federation's core authority. Everything else — the member
// register, the athlete passport, the public verification service — is only
// trustworthy if a credential can be traced back to an examination that
// actually happened, under a syllabus that actually existed on that date.
//
// THE RULE THAT SHAPES THIS ENTIRE FILE: the schema defines the STRUCTURE of a
// syllabus; MMAKF supplies the CONTENT. Not one technique, kata requirement,
// eligibility rule, minimum interval or pass mark is shipped in code. An empty
// syllabus renders as "not yet published by the federation", which is credible.
// An invented one is fraud, and it is the failure the directive treats as
// unforgivable.
//
// Everything is VERSIONED. A 2026 grading must remain associated with the
// syllabus that governed it, forever — otherwise revising the syllabus silently
// rewrites the meaning of every certificate already issued.

import {
  pgTable, serial, text, integer, timestamp, date, boolean,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { persons, dojos, stateUnits, districtUnits } from './schema';

// ─── Enums ──────────────────────────────────────────────────────────────────

export const syllabusStatus = pgEnum('syllabus_status', [
  'draft', 'under_review', 'approved', 'active', 'superseded', 'withdrawn',
]);

export const techniqueCategory = pgEnum('technique_category', [
  'dachi',      // stances
  'uke',        // blocks
  'tsuki',      // punches
  'uchi',       // strikes
  'geri',       // kicks
  'tai_sabaki', // body movement
  'ukemi',      // breakfalls
  'other',
]);

export const kumiteSystem = pgEnum('kumite_system', [
  'kihon_kumite', 'yakusoku_kumite', 'gohon_kumite', 'sanbon_kumite',
  'ippon_kumite', 'jiyu_ippon_kumite', 'jiyu_kumite', 'shiai_kumite', 'other',
]);

/**
 * Grading lifecycle. `locked` is the point of no return: once results are
 * locked, corrections create a new record rather than editing this one.
 */
export const gradingStatus = pgEnum('grading_status', [
  'draft', 'scheduled', 'registration_open', 'registration_closed',
  'in_progress', 'scoring', 'awaiting_approval', 'approved', 'locked',
  'cancelled',
]);

export const candidateStatus = pgEnum('candidate_status', [
  'applied', 'eligibility_check', 'eligible', 'ineligible', 'fee_pending',
  'confirmed', 'withdrawn', 'absent', 'examined', 'passed', 'failed',
  'referred',   // partial pass — re-examine specific components
]);

export const certificateStatus = pgEnum('certificate_status', [
  'issued', 'reissued', 'suspended', 'revoked', 'superseded',
]);

export const certificateKind = pgEnum('certificate_kind', [
  'kyu_grade', 'dan_grade', 'instructor', 'examiner', 'official',
  'course_completion', 'affiliation', 'event_participation', 'other',
]);

// ─── Syllabus versioning ────────────────────────────────────────────────────

/**
 * A published edition of the MMAKF technical syllabus.
 *
 * Grades, requirements and gradings all reference a version. Revising the
 * syllabus creates a NEW version and supersedes the old one; the old one is
 * never edited, because certificates issued under it must keep their meaning.
 */
export const syllabusVersions = pgTable('syllabus_versions', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                  // MMAKF-SYL-2026-01
  title: text('title').notNull(),
  status: syllabusStatus('status').notNull().default('draft'),
  effectiveFrom: date('effective_from'),
  effectiveTo: date('effective_to'),
  supersedesId: integer('supersedes_id'),
  approvedByPersonId: integer('approved_by_person_id').references(() => persons.id),
  approvedOn: date('approved_on'),
  // The authority under which it was adopted — a resolution, a council decision.
  adoptedUnder: text('adopted_under'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('syllabus_versions_code_uk').on(t.code),
  statusIdx: index('syllabus_versions_status_idx').on(t.status),
}));

// ─── Shotokan technical databases ───────────────────────────────────────────

/**
 * Kihon — the technique catalogue.
 *
 * Reference material about Shotokan technique is not the same thing as MMAKF's
 * grading requirements, so the two are separate tables. This one describes
 * techniques; `gradeRequirements` says which are examined at which grade.
 */
export const techniques = pgTable('techniques', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  nameJa: text('name_ja'),                       // 前蹴り
  nameRomaji: text('name_romaji').notNull(),     // Mae-geri
  nameEn: text('name_en'),                       // Front kick
  category: techniqueCategory('category').notNull(),
  description: text('description'),
  execution: text('execution'),
  purpose: text('purpose'),
  breathing: text('breathing'),
  commonErrors: jsonb('common_errors'),
  corrections: jsonb('corrections'),
  beginnerAdaptation: text('beginner_adaptation'),
  advancedInterpretation: text('advanced_interpretation'),
  // Provenance matters: a teacher's interpretation is not federation doctrine.
  sourceKind: text('source_kind').notNull().default('reference'), // official | teacher | reference
  authoredByPersonId: integer('authored_by_person_id').references(() => persons.id),
  published: boolean('published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugIdx: uniqueIndex('techniques_slug_uk').on(t.slug),
  categoryIdx: index('techniques_category_idx').on(t.category),
}));

export const kata = pgTable('kata', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  nameJa: text('name_ja'),
  nameRomaji: text('name_romaji').notNull(),     // Heian Shodan
  meaning: text('meaning'),
  family: text('family'),                        // Heian, Tekki, Sentei, Jiyu
  movementCount: integer('movement_count'),
  embusen: text('embusen'),
  characteristics: text('characteristics'),
  history: text('history'),
  sequence: jsonb('sequence'),                   // ordered movements, when documented
  bunkai: jsonb('bunkai'),
  commonErrors: jsonb('common_errors'),
  sourceKind: text('source_kind').notNull().default('reference'),
  published: boolean('published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ slugIdx: uniqueIndex('kata_slug_uk').on(t.slug) }));

export const kumiteForms = pgTable('kumite_forms', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  system: kumiteSystem('system').notNull(),
  nameRomaji: text('name_romaji').notNull(),
  purpose: text('purpose'),
  progression: text('progression'),
  principles: text('principles'),
  safetyNotes: text('safety_notes'),
  drills: jsonb('drills'),
  sourceKind: text('source_kind').notNull().default('reference'),
  published: boolean('published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ slugIdx: uniqueIndex('kumite_forms_slug_uk').on(t.slug) }));

// ─── Grade definitions ──────────────────────────────────────────────────────

/**
 * A grade AS DEFINED BY A SYLLABUS VERSION.
 *
 * The same 8th Kyu can carry different requirements under different syllabus
 * versions, which is precisely why grade definitions hang off a version rather
 * than being global constants.
 *
 * Every eligibility field is NULLABLE and unset by default. MMAKF decides the
 * minimum interval, the minimum attendance and the minimum age — not this file.
 */
export const gradeDefinitions = pgTable('grade_definitions', {
  id: serial('id').primaryKey(),
  syllabusVersionId: integer('syllabus_version_id').notNull().references(() => syllabusVersions.id),
  kind: text('kind').notNull(),                  // kyu | dan
  ordinal: integer('ordinal').notNull(),         // kyu 10..1, dan 1..10
  label: text('label').notNull(),                // "8th Kyu", "Shodan"
  beltColour: text('belt_colour'),
  beltHex: text('belt_hex'),

  // Eligibility — all optional, all federation policy.
  minAgeYears: integer('min_age_years'),
  minMonthsSincePrevious: integer('min_months_since_previous'),
  minSessionsSincePrevious: integer('min_sessions_since_previous'),
  previousGradeOrdinal: integer('previous_grade_ordinal'),
  requiresNationalApproval: boolean('requires_national_approval').notNull().default(false),
  examinerMinLevel: text('examiner_min_level'),

  notes: text('notes'),
  displayOrder: integer('display_order').notNull().default(0),
}, (t) => ({
  uniqueGrade: uniqueIndex('grade_definitions_uk').on(t.syllabusVersionId, t.kind, t.ordinal),
  versionIdx: index('grade_definitions_version_idx').on(t.syllabusVersionId),
}));

/**
 * What is examined at a grade. One row per requirement, so a scorecard can be
 * generated from the syllabus rather than hand-built per grading.
 */
export const gradeRequirements = pgTable('grade_requirements', {
  id: serial('id').primaryKey(),
  gradeDefinitionId: integer('grade_definition_id').notNull().references(() => gradeDefinitions.id),
  component: text('component').notNull(),        // kihon | kata | kumite | bunkai | theory | reigi
  techniqueId: integer('technique_id').references(() => techniques.id),
  kataId: integer('kata_id').references(() => kata.id),
  kumiteFormId: integer('kumite_form_id').references(() => kumiteForms.id),
  requirement: text('requirement').notNull(),    // free text where no entity fits
  detail: text('detail'),
  // Weighting within the component. Null means the technical council has not
  // set one, and the scorecard treats the component as unweighted.
  weight: integer('weight'),
  mandatory: boolean('mandatory').notNull().default(true),
  displayOrder: integer('display_order').notNull().default(0),
}, (t) => ({ gradeIdx: index('grade_requirements_grade_idx').on(t.gradeDefinitionId) }));

// ─── Grading events ─────────────────────────────────────────────────────────

export const gradingEvents = pgTable('grading_events', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                  // MMAKF-GRD-2026-000001
  title: text('title').notNull(),
  syllabusVersionId: integer('syllabus_version_id').notNull().references(() => syllabusVersions.id),
  status: gradingStatus('status').notNull().default('draft'),

  heldOn: date('held_on'),
  venue: text('venue'),
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),
  dojoId: integer('dojo_id').references(() => dojos.id),

  registrationOpensOn: date('registration_opens_on'),
  registrationClosesOn: date('registration_closes_on'),

  chiefExaminerPersonId: integer('chief_examiner_person_id').references(() => persons.id),
  // Set when results are locked. After this, corrections create new records.
  lockedAt: timestamp('locked_at', { withTimezone: true }),
  lockedByUserId: integer('locked_by_user_id'),

  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('grading_events_code_uk').on(t.code),
  statusIdx: index('grading_events_status_idx').on(t.status),
  dateIdx: index('grading_events_date_idx').on(t.heldOn),
}));

/** Examiners assigned to a grading, and what they were authorised to examine. */
export const gradingPanel = pgTable('grading_panel', {
  id: serial('id').primaryKey(),
  gradingEventId: integer('grading_event_id').notNull().references(() => gradingEvents.id),
  personId: integer('person_id').notNull().references(() => persons.id),
  role: text('role').notNull(),                  // chief | examiner | assessor | observer
  // Frozen at assignment: an examiner's licence may lapse later, and the record
  // must still show what authority they held on the day.
  qualificationSnapshot: jsonb('qualification_snapshot'),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueMember: uniqueIndex('grading_panel_uk').on(t.gradingEventId, t.personId),
}));

export const gradingCandidates = pgTable('grading_candidates', {
  id: serial('id').primaryKey(),
  gradingEventId: integer('grading_event_id').notNull().references(() => gradingEvents.id),
  personId: integer('person_id').notNull().references(() => persons.id),
  gradeDefinitionId: integer('grade_definition_id').notNull().references(() => gradeDefinitions.id),
  status: candidateStatus('status').notNull().default('applied'),

  // The eligibility decision AND its reasoning, kept so a refusal can be
  // explained months later without re-deriving it from rules that may have
  // changed in the meantime.
  eligibilityCheckedAt: timestamp('eligibility_checked_at', { withTimezone: true }),
  eligibilityResult: jsonb('eligibility_result'),
  ineligibleReason: text('ineligible_reason'),

  presentedByPersonId: integer('presented_by_person_id').references(() => persons.id),
  dojoId: integer('dojo_id').references(() => dojos.id),
  orderId: integer('order_id'),                  // fee, when one is charged

  // Outcome
  overallScore: integer('overall_score'),
  outcome: text('outcome'),                      // pass | fail | refer
  referredComponents: jsonb('referred_components'),
  examinerNotes: text('examiner_notes'),
  candidateFeedback: text('candidate_feedback'), // the only text the candidate sees

  decidedAt: timestamp('decided_at', { withTimezone: true }),
  rankRecordId: integer('rank_record_id'),       // the rank this awarded, if passed
  certificateId: integer('certificate_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueEntry: uniqueIndex('grading_candidates_uk').on(t.gradingEventId, t.personId),
  personIdx: index('grading_candidates_person_idx').on(t.personId),
  statusIdx: index('grading_candidates_status_idx').on(t.status),
}));

/**
 * One score per requirement per examiner.
 *
 * Scores are recorded per EXAMINER, not merged on the way in, so a panel
 * disagreement remains visible and an appeal can see who marked what.
 */
export const gradingScores = pgTable('grading_scores', {
  id: serial('id').primaryKey(),
  candidateId: integer('candidate_id').notNull().references(() => gradingCandidates.id),
  examinerPersonId: integer('examiner_person_id').notNull().references(() => persons.id),
  gradeRequirementId: integer('grade_requirement_id').references(() => gradeRequirements.id),
  component: text('component').notNull(),
  score: integer('score'),
  maxScore: integer('max_score'),
  comment: text('comment'),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  candidateIdx: index('grading_scores_candidate_idx').on(t.candidateId),
  uniqueScore: uniqueIndex('grading_scores_uk').on(t.candidateId, t.examinerPersonId, t.component, t.gradeRequirementId),
}));

// ─── Certificates ───────────────────────────────────────────────────────────

/**
 * An issued certificate.
 *
 * `snapshot` freezes everything printed on it. Regenerating from live data
 * would let a later name correction or syllabus revision silently alter a
 * document already in someone's hands.
 *
 * Revocation NEVER deletes: status moves, reason is recorded, and the public
 * verification endpoint reports the revocation. A certificate that simply
 * vanished would be indistinguishable from one that never existed.
 */
export const certificates = pgTable('certificates', {
  id: serial('id').primaryKey(),
  certificateNo: text('certificate_no').notNull(),   // MMAKF-CERT-2026-000001
  kind: certificateKind('kind').notNull(),
  personId: integer('person_id').notNull().references(() => persons.id),

  title: text('title').notNull(),
  issuedOn: date('issued_on').notNull(),
  validFrom: date('valid_from'),
  validTo: date('valid_to'),                     // null = no expiry

  syllabusVersionId: integer('syllabus_version_id').references(() => syllabusVersions.id),
  gradingEventId: integer('grading_event_id').references(() => gradingEvents.id),
  rankRecordId: integer('rank_record_id'),

  issuingAuthority: text('issuing_authority').notNull(),
  signedByPersonId: integer('signed_by_person_id').references(() => persons.id),

  status: certificateStatus('status').notNull().default('issued'),
  revokedOn: date('revoked_on'),
  revokedReason: text('revoked_reason'),
  supersededById: integer('superseded_by_id'),

  // Unguessable, and the only thing a QR code carries — never the person id.
  verifyToken: text('verify_token').notNull(),
  snapshot: jsonb('snapshot').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  numberIdx: uniqueIndex('certificates_no_uk').on(t.certificateNo),
  tokenIdx: uniqueIndex('certificates_token_uk').on(t.verifyToken),
  personIdx: index('certificates_person_idx').on(t.personId),
  statusIdx: index('certificates_status_idx').on(t.status),
}));

/**
 * Every public verification attempt.
 *
 * Two reasons: a federation should be able to show that a credential was
 * checked, and a spike of lookups against sequential numbers is what
 * enumeration looks like.
 */
export const verificationLog = pgTable('verification_log', {
  id: serial('id').primaryKey(),
  lookupKind: text('lookup_kind').notNull(),     // certificate | member | dojo
  lookupValue: text('lookup_value').notNull(),
  found: boolean('found').notNull(),
  resultStatus: text('result_status'),
  ipHash: text('ip_hash'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  atIdx: index('verification_log_at_idx').on(t.at),
  valueIdx: index('verification_log_value_idx').on(t.lookupValue),
}));
