// MMAKF operations — the federation's internal operating platform.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS *NOT*
// ─────────────────────────────────────────────────────────────────────────────
//
// It is not a second copy of the federation. Before adding anything here the
// existing 117 tables were read, and most of what an "institutional training
// platform" needs was already present:
//
//   institutions, institutionContacts   engagement.schema.ts
//   leads, leadActivities               engagement.schema.ts
//   trainingRequests, quotes, proposals engagement.schema.ts
//   trainingPrograms, participants      engagement.schema.ts
//   bookings, coachAvailability         engagement.schema.ts
//   calendarEvents, calendarConnections engagement.schema.ts
//   invoices, payments, orders          commerce.schema.ts
//   supportTickets, notifications       governance.schema.ts
//   domainEvents                        governance.schema.ts
//   persons, users, roleBindings        schema.ts
//
// So this file adds only what genuinely had no home, and EXTENDS rather than
// replaces where something close already existed. Where a table here looks like
// one that exists elsewhere, the comment says why it is not the same thing.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE IDEA
// ─────────────────────────────────────────────────────────────────────────────
//
// A school fills in a form once. Everything downstream — the institution
// record, the lead, the owner, the task, the acknowledgement, the SLA clock —
// is DERIVED from that submission by the workflow engine, never re-typed by an
// administrator. That is why `workflow_runs` carries an idempotency key and why
// `institution_applications` keeps the raw submitted payload: the automation
// must be replayable, and a replay must not create a second institution.

import {
  pgTable, serial, text, integer, boolean, timestamp, date, numeric,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { persons, users, stateUnits, districtUnits, dojos } from './schema';
// Civil geography. `venues.areaId` carries a real foreign key onto it for the
// same reason `persons.residenceAreaId` does — see migration 0025.
import { adminAreas } from './geography.schema';
import {
  institutions, leads, trainingRequests, trainingPrograms, bookings,
  proposals, quoteVersions, services, programParticipants,
  audienceKind, deliveryMode,
} from './engagement.schema';
import { supportTickets } from './governance.schema';

// ═══════════════════════════════════════════════════════════════════════════
// PROGRAMME CATALOGUE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The lifecycle the federation asked for, exactly.
 *
 * `published` is separate from `approved` on purpose: a programme can be
 * approved internally long before the federation wants it advertised, and
 * collapsing the two means every internal approval immediately changes the
 * public website.
 */
export const programTemplateStatus = pgEnum('program_template_status', [
  'draft', 'under_review', 'approved', 'published', 'archived',
]);

/**
 * A configurable programme the federation can offer — "School Shotokan, ages
 * 8–12, two sessions a week, twelve weeks, on site".
 *
 * DISTINCT FROM `services`. A service is a component ("Shotokan core"); a
 * template is an assembled, deliverable shape built from one. And distinct from
 * `trainingPrograms`, which is a template ACTUALLY BEING DELIVERED to one named
 * client — the difference between a menu and a meal.
 *
 * CARRIES NO PRICE. Deliberately, and enforced by there being no column for
 * one: the fee framework prices a configuration, and a price stored here would
 * be the tenth scattered price the federation asked us to remove.
 */
export const programTemplates = pgTable('program_templates', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                    // MMAKF-PT-SCHOOL-SHOTOKAN
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  audience: audienceKind('audience').notNull(),
  serviceId: integer('service_id').references(() => services.id),
  status: programTemplateStatus('status').notNull().default('draft'),

  summary: text('summary'),
  curriculumOutline: text('curriculum_outline'),

  // Every one of these is NULLABLE. A template the federation has not yet
  // specified is incomplete, not zero — and `0 participants` reads as a real
  // answer where NULL reads as the absence it is.
  ageBands: jsonb('age_bands'),
  minParticipants: integer('min_participants'),
  maxParticipants: integer('max_participants'),
  sessionsPerWeek: integer('sessions_per_week'),
  durationWeeks: integer('duration_weeks'),
  sessionMinutes: integer('session_minutes'),
  minInstructorGrade: text('min_instructor_grade'),
  instructorsRequired: integer('instructors_required'),
  facilityRequirement: text('facility_requirement'),
  equipmentRequirement: text('equipment_requirement'),

  includesAssessment: boolean('includes_assessment'),
  includesGrading: boolean('includes_grading'),
  includesCertification: boolean('includes_certification'),
  includesCompetition: boolean('includes_competition'),
  includesReporting: boolean('includes_reporting'),

  /** Which delivery modes this template supports: ['on_site','online']. */
  modes: jsonb('modes'),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  reviewedByUserId: integer('reviewed_by_user_id').references(() => users.id),
  approvedByUserId: integer('approved_by_user_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('program_templates_code_uk').on(t.code),
  slugUk: uniqueIndex('program_templates_slug_uk').on(t.slug),
  audienceIdx: index('program_templates_audience_idx').on(t.audience, t.status),
}));

// ═══════════════════════════════════════════════════════════════════════════
// INSTITUTIONAL APPLICATION — the 20-step wizard
// ═══════════════════════════════════════════════════════════════════════════

export const applicationStatus = pgEnum('institution_application_status', [
  'draft',
  'submitted',
  'acknowledged',
  'under_review',
  'information_requested',
  'program_design',
  'quoted',
  'proposed',
  'approved',
  'contracted',
  'declined',
  'withdrawn',
  'expired',
]);

/**
 * One institution's request to start a programme with MMAKF.
 *
 * `payload` keeps the submission EXACTLY as it arrived, alongside the parsed
 * columns. Both, not one:
 *
 *   · the columns are what the federation queries, routes and reports on;
 *   · the payload is what the school actually said, and it is the only thing
 *     that can settle a later disagreement about what was asked for.
 *
 * Re-deriving columns from the payload later is possible. Re-deriving the
 * payload from columns is not, which is why the raw form is the copy that never
 * gets rewritten.
 */
export const institutionApplications = pgTable('institution_applications', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                      // MMAKF-APP-2026-000001
  audience: audienceKind('audience').notNull(),
  status: applicationStatus('status').notNull().default('draft'),

  // The records this submission produced. All nullable while the application is
  // still a draft — a half-filled wizard must not mint an institution.
  institutionId: integer('institution_id').references(() => institutions.id),
  leadId: integer('lead_id').references(() => leads.id),
  requestId: integer('request_id').references(() => trainingRequests.id),

  // ── Steps 1–2: identity and place ──
  institutionName: text('institution_name').notNull(),
  campusName: text('campus_name'),
  addressLine: text('address_line'),
  city: text('city'),
  postcode: text('postcode'),
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),
  /** Free text where the state is outside the federation's unit register. */
  stateName: text('state_name'),

  // ── Steps 3–6: population ──
  populationCount: integer('population_count'),
  participantCount: integer('participant_count'),
  batchCount: integer('batch_count'),
  campusCount: integer('campus_count'),
  ageBands: jsonb('age_bands'),

  // ── Steps 7–12: what they want ──
  requirements: text('requirements'),
  programTemplateId: integer('program_template_id').references(() => programTemplates.id),
  serviceId: integer('service_id').references(() => services.id),
  frequencyPerWeek: integer('frequency_per_week'),
  durationWeeks: integer('duration_weeks'),
  mode: deliveryMode('mode'),
  infrastructure: jsonb('infrastructure'),
  instructorRequirement: text('instructor_requirement'),
  instructorsRequired: integer('instructors_required'),

  // ── Steps 13–16: outcomes ──
  wantsAssessment: boolean('wants_assessment'),
  wantsGrading: boolean('wants_grading'),
  wantsCertification: boolean('wants_certification'),
  wantsCompetition: boolean('wants_competition'),
  specialRequirements: text('special_requirements'),

  // ── Steps 17–18: people ──
  contactName: text('contact_name'),
  contactRole: text('contact_role'),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  decisionMakerName: text('decision_maker_name'),
  decisionMakerRole: text('decision_maker_role'),
  decisionMakerEmail: text('decision_maker_email'),

  preferredStart: date('preferred_start'),

  /** The submission verbatim. See the note above. */
  payload: jsonb('payload'),
  /** Attribution: utm parameters, landing page, referrer. */
  source: jsonb('source'),

  /**
   * Unguessable key for the applicant's status page.
   *
   * Not "reference plus contact email": refs are sequence-allocated and a
   * school's contact address is usually on its own website, so both halves of
   * that pair are guessable and what they unlock is the school's submission.
   * Issued once and sent with the acknowledgement.
   */
  accessToken: text('access_token'),

  /** How far the applicant got. Lets a half-finished wizard be resumed. */
  stepReached: integer('step_reached').notNull().default(1),

  // ── Routing and service standard ──
  leadScore: integer('lead_score'),
  ownerUserId: integer('owner_user_id').references(() => users.id),
  ownerRole: text('owner_role'),
  /**
   * When the federation has undertaken to respond by.
   *
   * NULLABLE, and null unless a service standard has actually been set. A
   * default of "48 hours" here would be the system inventing a commitment the
   * federation never made — see REVIEW_TURNAROUND_NOT_SET in onboarding.ts for
   * the same decision taken once before.
   */
  slaDueAt: timestamp('sla_due_at', { withTimezone: true }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  firstContactAt: timestamp('first_contact_at', { withTimezone: true }),

  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedByUserId: integer('decided_by_user_id').references(() => users.id),
  decisionReason: text('decision_reason'),

  /** Set when a duplicate is detected, pointing at the surviving application. */
  supersededByApplicationId: integer('superseded_by_application_id'),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('institution_applications_ref_uk').on(t.ref),
  statusIdx: index('institution_applications_status_idx').on(t.status, t.createdAt),
  instIdx: index('institution_applications_inst_idx').on(t.institutionId),
  ownerIdx: index('institution_applications_owner_idx').on(t.ownerUserId, t.status),
  slaIdx: index('institution_applications_sla_idx').on(t.slaDueAt),
  tokenUk: uniqueIndex('institution_applications_token_uk').on(t.accessToken),
}));

/**
 * The application's history, and the applicant's status page.
 *
 * `visibleToApplicant` is the whole reason this is one table rather than two.
 * The federation's internal note ("chased twice, no answer") and the
 * applicant-facing entry ("we have received your application") are the same
 * kind of fact about the same application, and keeping them together means the
 * timeline can never disagree with itself. The flag decides who sees which.
 */
export const applicationEvents = pgTable('application_events', {
  id: serial('id').primaryKey(),
  applicationId: integer('application_id').notNull().references(() => institutionApplications.id),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  kind: text('kind').notNull(),                    // submitted | routed | acknowledged | ...
  summary: text('summary').notNull(),
  detail: jsonb('detail'),
  actorUserId: integer('actor_user_id').references(() => users.id),
  visibleToApplicant: boolean('visible_to_applicant').notNull().default(false),
}, (t) => ({
  appIdx: index('application_events_app_idx').on(t.applicationId, t.at),
}));

// ═══════════════════════════════════════════════════════════════════════════
// LEAD AND APPLICATION ROUTING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Who picks up what.
 *
 * A table rather than a hard-coded function because the answer changes when
 * staff change, and re-deploying the site to move Jharkhand school enquiries to
 * a different manager is not an acceptable operational model.
 *
 * Matching is most-specific-first (see routeApplication in
 * src/db/applications.ts): a rule naming both an audience and a district beats
 * one naming only the audience. A rule that matches nothing leaves the
 * application UNOWNED and visible in the unassigned queue — never silently
 * dropped, and never assigned to an arbitrary administrator.
 */
export const routingRules = pgTable('routing_rules', {
  id: serial('id').primaryKey(),
  label: text('label').notNull(),
  active: boolean('active').notNull().default(true),

  // Conditions. NULL means "any" — an unstated condition constrains nothing.
  audience: audienceKind('audience'),
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),
  serviceId: integer('service_id').references(() => services.id),
  minParticipants: integer('min_participants'),
  maxParticipants: integer('max_participants'),

  // Target. A role, a named person, or both.
  targetRole: text('target_role'),
  targetUserId: integer('target_user_id').references(() => users.id),
  department: text('department'),

  /** Higher wins. Ties break on specificity, then on lowest id. */
  priority: integer('priority').notNull().default(100),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  activeIdx: index('routing_rules_active_idx').on(t.active, t.priority),
}));

// ═══════════════════════════════════════════════════════════════════════════
// TASK ENGINE
// ═══════════════════════════════════════════════════════════════════════════

export const taskStatus = pgEnum('task_status', [
  'open', 'in_progress', 'blocked', 'done', 'cancelled',
]);

export const taskPriority = pgEnum('task_priority', ['low', 'normal', 'high', 'urgent']);

/**
 * The shape of a recurring piece of work.
 *
 * Templates exist so that "review a school application" means the same thing,
 * carries the same deadline and escalates to the same role every time, rather
 * than depending on which administrator happened to create the task.
 */
export const taskTemplates = pgTable('task_templates', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                    // REVIEW_INSTITUTION_APPLICATION
  title: text('title').notNull(),
  description: text('description'),
  defaultRole: text('default_role'),
  defaultPriority: taskPriority('default_priority').notNull().default('normal'),
  /** Null where the federation has set no standard. Not defaulted to a number. */
  dueInHours: integer('due_in_hours'),
  escalateAfterHours: integer('escalate_after_hours'),
  escalateToRole: text('escalate_to_role'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ codeUk: uniqueIndex('task_templates_code_uk').on(t.code) }));

/**
 * A single piece of work owed by a person or a role.
 *
 * NOT `governance.actionItems`, which minutes a meeting resolution and belongs
 * to that meeting. This is the operational queue: applications to review,
 * coaches to screen, tickets to answer.
 *
 * `subjectKind`/`subjectId` are a deliberate soft reference. A foreign key per
 * subject type would mean a new nullable column and a new migration every time
 * something becomes taskable, and twelve mutually-exclusive nullable FKs is not
 * a cleaner design than two columns and a lookup table of kinds.
 */
export const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                      // MMAKF-TSK-2026-000001
  templateCode: text('template_code'),
  title: text('title').notNull(),
  detail: text('detail'),

  subjectKind: text('subject_kind'),               // institution_application | coach_application | ticket | ...
  subjectId: integer('subject_id'),
  institutionId: integer('institution_id').references(() => institutions.id),

  assignedRole: text('assigned_role'),
  assignedUserId: integer('assigned_user_id').references(() => users.id),

  status: taskStatus('status').notNull().default('open'),
  priority: taskPriority('priority').notNull().default('normal'),

  dueAt: timestamp('due_at', { withTimezone: true }),
  escalateAt: timestamp('escalate_at', { withTimezone: true }),
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  escalationLevel: integer('escalation_level').notNull().default(0),

  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  completedByUserId: integer('completed_by_user_id').references(() => users.id),
  outcome: text('outcome'),

  /**
   * Set by the workflow engine so a replayed run adopts the task it already
   * created instead of creating a second one. Unique where present.
   */
  idempotencyKey: text('idempotency_key'),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('tasks_ref_uk').on(t.ref),
  idemUk: uniqueIndex('tasks_idempotency_uk').on(t.idempotencyKey),
  queueIdx: index('tasks_queue_idx').on(t.status, t.dueAt),
  assigneeIdx: index('tasks_assignee_idx').on(t.assignedUserId, t.status),
  roleIdx: index('tasks_role_idx').on(t.assignedRole, t.status),
  subjectIdx: index('tasks_subject_idx').on(t.subjectKind, t.subjectId),
  escalationIdx: index('tasks_escalation_idx').on(t.escalateAt, t.escalatedAt),
}));

/** Task B cannot start until task A is done. */
export const taskDependencies = pgTable('task_dependencies', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id').notNull().references(() => tasks.id),
  dependsOnTaskId: integer('depends_on_task_id').notNull().references(() => tasks.id),
}, (t) => ({
  uk: uniqueIndex('task_dependencies_uk').on(t.taskId, t.dependsOnTaskId),
}));

export const taskEvents = pgTable('task_events', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id').notNull().references(() => tasks.id),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  kind: text('kind').notNull(),
  note: text('note'),
  actorUserId: integer('actor_user_id').references(() => users.id),
}, (t) => ({ taskIdx: index('task_events_task_idx').on(t.taskId, t.at) }));

// ═══════════════════════════════════════════════════════════════════════════
// WORKFLOW ENGINE
// ═══════════════════════════════════════════════════════════════════════════

export const workflowRunStatus = pgEnum('workflow_run_status', [
  'pending', 'running', 'succeeded', 'partially_failed', 'failed', 'skipped',
]);

/**
 * A named automation: a trigger, and the ordered actions it performs.
 *
 * Stored rather than compiled in so that the federation can see what the system
 * does on its behalf without reading TypeScript, and so that switching one off
 * does not require a deployment. The ACTIONS themselves are code — the registry
 * in src/lib/workflow.ts — because an action that could be authored through the
 * admin console would be a remote code execution feature.
 */
export const workflowDefinitions = pgTable('workflow_definitions', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                    // SCHOOL_APPLICATION_SUBMITTED
  title: text('title').notNull(),
  description: text('description'),
  trigger: text('trigger').notNull(),              // the domain event that starts it
  version: integer('version').notNull().default(1),
  active: boolean('active').notNull().default(true),
  /** { steps: [{ action, params, condition? }], maxAttempts } */
  definition: jsonb('definition').notNull(),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeVersionUk: uniqueIndex('workflow_definitions_code_version_uk').on(t.code, t.version),
  triggerIdx: index('workflow_definitions_trigger_idx').on(t.trigger, t.active),
}));

/**
 * One execution.
 *
 * `idempotencyKey` is UNIQUE and is the load-bearing column in this file. A
 * retry, a duplicate webhook, a double-clicked Submit and a replayed event all
 * arrive with the same key, and the unique index turns "please do not run this
 * twice" from a hope into a constraint the database enforces.
 */
export const workflowRuns = pgTable('workflow_runs', {
  id: serial('id').primaryKey(),
  workflowCode: text('workflow_code').notNull(),
  workflowVersion: integer('workflow_version').notNull().default(1),
  trigger: text('trigger').notNull(),

  subjectKind: text('subject_kind'),
  subjectId: integer('subject_id'),

  idempotencyKey: text('idempotency_key').notNull(),

  status: workflowRunStatus('status').notNull().default('pending'),
  attempt: integer('attempt').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),

  context: jsonb('context'),
  result: jsonb('result'),
  error: text('error'),

  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idemUk: uniqueIndex('workflow_runs_idempotency_uk').on(t.idempotencyKey),
  statusIdx: index('workflow_runs_status_idx').on(t.status, t.nextAttemptAt),
  subjectIdx: index('workflow_runs_subject_idx').on(t.subjectKind, t.subjectId),
}));

/**
 * What each action did.
 *
 * Written whether the step succeeded or failed, because "the notification was
 * never sent" and "the notification was sent and the school says it never
 * arrived" are different problems and the difference is only recoverable if the
 * failure was recorded at the time.
 */
export const workflowSteps = pgTable('workflow_steps', {
  id: serial('id').primaryKey(),
  runId: integer('run_id').notNull().references(() => workflowRuns.id),
  seq: integer('seq').notNull(),
  action: text('action').notNull(),
  status: text('status').notNull(),                // succeeded | failed | skipped
  attempt: integer('attempt').notNull().default(1),
  params: jsonb('params'),
  result: jsonb('result'),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => ({
  runSeqIdx: index('workflow_steps_run_idx').on(t.runId, t.seq),
}));

// ═══════════════════════════════════════════════════════════════════════════
// COACH MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

export const coachStatus = pgEnum('coach_status', [
  'candidate', 'screening', 'interview', 'technical_review', 'document_check',
  'approved', 'active', 'suspended', 'inactive', 'withdrawn', 'rejected',
]);

/**
 * The professional record of someone who teaches for MMAKF.
 *
 * Separate from `persons` because most people in the federation are not
 * coaches, and separate from `instructorQuals` because a qualification is one
 * fact about a coach while this is the standing, availability, reach and
 * approval state the assignment engine reads.
 */
export const coachProfiles = pgTable('coach_profiles', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  status: coachStatus('status').notNull().default('candidate'),

  headline: text('headline'),
  bio: text('bio'),
  danGrade: text('dan_grade'),
  teachingSince: date('teaching_since'),
  languages: jsonb('languages'),
  ageBands: jsonb('age_bands'),
  /** Programme template codes this coach is cleared to deliver. */
  programCodes: jsonb('program_codes'),

  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),
  homeDojoId: integer('home_dojo_id').references(() => dojos.id),
  baseCity: text('base_city'),
  travelRadiusKm: integer('travel_radius_km'),
  maxSessionsPerWeek: integer('max_sessions_per_week'),

  /**
   * Child-protection clearance. Nullable, and the assignment engine treats
   * NULL as NOT CLEARED — never as "probably fine". A coach with no recorded
   * clearance is excluded from any programme involving minors.
   */
  safeguardingClearedOn: date('safeguarding_cleared_on'),
  safeguardingExpiresOn: date('safeguarding_expires_on'),

  approvedAt: timestamp('approved_at', { withTimezone: true }),
  approvedByUserId: integer('approved_by_user_id').references(() => users.id),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  suspendedReason: text('suspended_reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  personUk: uniqueIndex('coach_profiles_person_uk').on(t.personId),
  statusIdx: index('coach_profiles_status_idx').on(t.status),
  geoIdx: index('coach_profiles_geo_idx').on(t.stateUnitId, t.districtUnitId),
}));

/** The candidate's own submission, before there is a profile to speak of. */
export const coachApplications = pgTable('coach_applications', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                      // MMAKF-CA-2026-000001
  coachProfileId: integer('coach_profile_id').references(() => coachProfiles.id),
  personId: integer('person_id').references(() => persons.id),
  userId: integer('user_id').references(() => users.id),

  fullName: text('full_name').notNull(),
  email: text('email'),
  phone: text('phone'),
  city: text('city'),
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),

  danGrade: text('dan_grade'),
  gradeAwardedBy: text('grade_awarded_by'),
  teachingYears: integer('teaching_years'),
  competitionExperience: text('competition_experience'),
  qualificationsSummary: text('qualifications_summary'),
  preferredPrograms: jsonb('preferred_programs'),
  preferredLocations: jsonb('preferred_locations'),
  availabilityNote: text('availability_note'),
  languages: jsonb('languages'),
  referees: jsonb('referees'),

  status: coachStatus('status').notNull().default('candidate'),
  payload: jsonb('payload'),
  source: jsonb('source'),

  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedByUserId: integer('decided_by_user_id').references(() => users.id),
  decisionReason: text('decision_reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('coach_applications_ref_uk').on(t.ref),
  statusIdx: index('coach_applications_status_idx').on(t.status, t.createdAt),
}));

/**
 * Every stage transition, with who decided and why.
 *
 * Append-only. A rejection that can be edited afterwards is not a record of a
 * decision, it is a record of the current opinion — and a candidate who asks
 * why they were turned down deserves the first.
 */
export const coachStageEvents = pgTable('coach_stage_events', {
  id: serial('id').primaryKey(),
  applicationId: integer('application_id').notNull().references(() => coachApplications.id),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  fromStatus: coachStatus('from_status'),
  toStatus: coachStatus('to_status').notNull(),
  outcome: text('outcome'),
  note: text('note'),
  actorUserId: integer('actor_user_id').references(() => users.id),
}, (t) => ({ appIdx: index('coach_stage_events_app_idx').on(t.applicationId, t.at) }));

export const coachQualifications = pgTable('coach_qualifications', {
  id: serial('id').primaryKey(),
  coachProfileId: integer('coach_profile_id').notNull().references(() => coachProfiles.id),
  kind: text('kind').notNull(),                    // dan_grade | coaching | first_aid | safeguarding | referee
  title: text('title').notNull(),
  issuedBy: text('issued_by'),
  issuedOn: date('issued_on'),
  expiresOn: date('expires_on'),
  referenceNo: text('reference_no'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifiedByUserId: integer('verified_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  coachIdx: index('coach_qualifications_coach_idx').on(t.coachProfileId, t.kind),
  expiryIdx: index('coach_qualifications_expiry_idx').on(t.expiresOn),
}));

/** HR-sensitive by default. `confidential` gates it behind 'hr:read'. */
export const coachDocuments = pgTable('coach_documents', {
  id: serial('id').primaryKey(),
  coachProfileId: integer('coach_profile_id').references(() => coachProfiles.id),
  applicationId: integer('application_id').references(() => coachApplications.id),
  kind: text('kind').notNull(),                    // resume | id_proof | certificate | clearance
  title: text('title'),
  filename: text('filename').notNull(),
  storageKey: text('storage_key').notNull(),
  contentType: text('content_type'),
  sizeBytes: integer('size_bytes'),
  confidential: boolean('confidential').notNull().default(true),
  uploadedByUserId: integer('uploaded_by_user_id').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifiedByUserId: integer('verified_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ coachIdx: index('coach_documents_coach_idx').on(t.coachProfileId) }));

export const assignmentStatus = pgEnum('coach_assignment_status', [
  'recommended', 'proposed', 'accepted', 'declined', 'confirmed',
  'withdrawn', 'completed',
]);

/**
 * A coach put forward for, or confirmed on, a programme.
 *
 * `recommended` exists as its own state because the engine RECOMMENDS and a
 * human CONFIRMS. The federation asked for automation, not for a machine that
 * allocates people's working weeks without anyone looking — so a row can reach
 * 'recommended' automatically and can only reach 'confirmed' through
 * confirmAssignment(), which takes a principal.
 */
export const coachAssignments = pgTable('coach_assignments', {
  id: serial('id').primaryKey(),
  programId: integer('program_id').references(() => trainingPrograms.id),
  bookingId: integer('booking_id').references(() => bookings.id),
  coachPersonId: integer('coach_person_id').notNull().references(() => persons.id),
  coachProfileId: integer('coach_profile_id').references(() => coachProfiles.id),
  role: text('role').notNull().default('lead'),    // lead | assistant | observer
  status: assignmentStatus('status').notNull().default('recommended'),

  /** 0–1000. Decision support only — see the note in rankCandidates(). */
  score: integer('score'),
  rationale: jsonb('rationale'),

  recommendedAt: timestamp('recommended_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedByUserId: integer('decided_by_user_id').references(() => users.id),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
  declineReason: text('decline_reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  programIdx: index('coach_assignments_program_idx').on(t.programId, t.status),
  coachIdx: index('coach_assignments_coach_idx').on(t.coachPersonId, t.status),
}));

export const coachCpd = pgTable('coach_cpd', {
  id: serial('id').primaryKey(),
  coachProfileId: integer('coach_profile_id').notNull().references(() => coachProfiles.id),
  title: text('title').notNull(),
  provider: text('provider'),
  hours: integer('hours'),
  completedOn: date('completed_on'),
  evidenceUrl: text('evidence_url'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  verifiedByUserId: integer('verified_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ coachIdx: index('coach_cpd_coach_idx').on(t.coachProfileId) }));

/**
 * Operational performance over a period.
 *
 * PART W: "Do not create unfair automated employment decisions." So this table
 * stores COUNTS and RATES — sessions scheduled, sessions delivered, attendance
 * — and no computed grade, rating or rank. There is deliberately no
 * `overall_score` column, because the moment one exists something will sort by
 * it and someone will be dismissed by a number nobody can explain.
 */
export const coachPerformance = pgTable('coach_performance', {
  id: serial('id').primaryKey(),
  coachProfileId: integer('coach_profile_id').notNull().references(() => coachProfiles.id),
  periodFrom: date('period_from').notNull(),
  periodTo: date('period_to').notNull(),
  sessionsScheduled: integer('sessions_scheduled'),
  sessionsDelivered: integer('sessions_delivered'),
  sessionsCancelledByCoach: integer('sessions_cancelled_by_coach'),
  participantsAttended: integer('participants_attended'),
  participantsExpected: integer('participants_expected'),
  institutionFeedbackCount: integer('institution_feedback_count'),
  note: text('note'),
  recordedByUserId: integer('recorded_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  coachPeriodIdx: index('coach_performance_coach_idx').on(t.coachProfileId, t.periodFrom),
}));

// ═══════════════════════════════════════════════════════════════════════════
// VENUES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Somewhere training happens.
 *
 * Not `dojos`: a dojo is a chartered member of the federation, while a venue is
 * a room — a school hall, a hired mat space, a corporate gym. Every dojo HAS a
 * venue; most venues are not dojos.
 */
export const venues = pgTable('venues', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull().default('other'),   // dojo | school_hall | corporate | stadium | online | other
  dojoId: integer('dojo_id').references(() => dojos.id),
  institutionId: integer('institution_id').references(() => institutions.id),

  addressLine: text('address_line'),
  city: text('city'),
  postcode: text('postcode'),
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),

  capacity: integer('capacity'),
  matAreaSqm: integer('mat_area_sqm'),
  facilities: jsonb('facilities'),
  /** Step-free access, accessible WC, and so on. Absent means UNRECORDED. */
  accessibility: jsonb('accessibility'),
  equipment: jsonb('equipment'),

  contactName: text('contact_name'),
  contactPhone: text('contact_phone'),
  active: boolean('active').notNull().default(true),
  notes: text('notes'),

  // ── The location engine (migration 0032) ────────────────────────────────
  //
  // A ROOM NEEDS A CLOCK. Before this, a venue had an address and no timezone,
  // which is fine while every venue is in one country and wrong the moment one
  // is not — and the scheduling engine stores WALL-CLOCK rules ("the dojo opens
  // at six"), which mean nothing without one. The default is Asia/Kolkata
  // because MMAKF is in India today; it is a COLUMN precisely so that "assume
  // IST" is never again a line of code.
  timezone: text('timezone').notNull().default('Asia/Kolkata'),
  /** A stable public address for this room. Unique when set; null = unpublished. */
  slug: text('slug'),
  /** For "find a club near me". numeric, not float: a rounded coordinate is a different building. */
  latitude: numeric('latitude', { precision: 9, scale: 6 }),
  longitude: numeric('longitude', { precision: 9, scale: 6 }),
  /**
   * Civil geography, BESIDE `stateUnitId` rather than instead of it: that
   * column says which chartered MMAKF body administers this room, this one says
   * where on the map it is. The same distinction migration 0025 drew for
   * `persons.residenceAreaId`.
   */
  areaId: integer('area_id').references(() => adminAreas.id),
  parking: text('parking'),
  transport: text('transport'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('venues_code_uk').on(t.code),
  geoIdx: index('venues_geo_idx').on(t.stateUnitId, t.districtUnitId),
  instIdx: index('venues_institution_idx').on(t.institutionId),
  slugUk: uniqueIndex('venues_slug_uk').on(t.slug).where(sql`slug is not null`),
  areaIdx: index('venues_area_idx').on(t.areaId),
  pointIdx: index('venues_geo_point_idx').on(t.latitude, t.longitude),
}));

/** Maintenance, exams, holidays — periods the venue cannot be booked. */
export const venueBlackouts = pgTable('venue_blackouts', {
  id: serial('id').primaryKey(),
  venueId: integer('venue_id').notNull().references(() => venues.id),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  reason: text('reason'),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ venueIdx: index('venue_blackouts_venue_idx').on(t.venueId, t.startsAt) }));

// ═══════════════════════════════════════════════════════════════════════════
// CONTRACTS AND CLIENT DOCUMENTS
// ═══════════════════════════════════════════════════════════════════════════

export const contractStatus = pgEnum('contract_status', [
  'draft', 'issued', 'signed', 'active', 'completed', 'terminated', 'expired',
]);

export const contracts = pgTable('contracts', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                      // MMAKF-CTR-2026-000001
  institutionId: integer('institution_id').notNull().references(() => institutions.id),
  applicationId: integer('application_id').references(() => institutionApplications.id),
  proposalId: integer('proposal_id').references(() => proposals.id),
  /**
   * The exact quote version this contract was agreed against.
   *
   * A version, not a quote: quotes are revised, and a contract that pointed at
   * the mutable parent would silently change its own value the next time
   * somebody re-quoted.
   */
  quoteVersionId: integer('quote_version_id').references(() => quoteVersions.id),
  programId: integer('program_id').references(() => trainingPrograms.id),

  status: contractStatus('status').notNull().default('draft'),
  startsOn: date('starts_on'),
  endsOn: date('ends_on'),
  valueMinor: integer('value_minor'),
  currency: text('currency').notNull().default('INR'),
  termsSummary: text('terms_summary'),

  signedByName: text('signed_by_name'),
  signedByRole: text('signed_by_role'),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  signatureMethod: text('signature_method'),       // wet_ink | email_acceptance | portal
  countersignedByUserId: integer('countersigned_by_user_id').references(() => users.id),

  renewalOfContractId: integer('renewal_of_contract_id'),
  terminatedAt: timestamp('terminated_at', { withTimezone: true }),
  terminationReason: text('termination_reason'),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('contracts_ref_uk').on(t.ref),
  instIdx: index('contracts_institution_idx').on(t.institutionId, t.status),
}));

export const documentKind = pgEnum('client_document_kind', [
  'quote', 'proposal', 'contract', 'invoice', 'report', 'certificate',
  'program_document', 'correspondence', 'other',
]);

/**
 * A file belonging to one client institution.
 *
 * Not `governance.officialDocuments`, which holds the federation's own
 * constitution and circulars and is national in scope. This one has a TENANT:
 * every row belongs to exactly one institution, and that is what the RBAC
 * institution scope filters on.
 *
 * `visibleToClient` defaults to FALSE. A document uploaded by staff is internal
 * until somebody decides otherwise — the opposite default publishes an internal
 * margin note to the customer's portal the moment it is saved.
 */
export const clientDocuments = pgTable('client_documents', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),
  institutionId: integer('institution_id').notNull().references(() => institutions.id),
  kind: documentKind('kind').notNull(),
  title: text('title').notNull(),

  subjectKind: text('subject_kind'),
  subjectId: integer('subject_id'),

  filename: text('filename'),
  storageKey: text('storage_key'),
  contentType: text('content_type'),
  sizeBytes: integer('size_bytes'),
  checksum: text('checksum'),

  visibleToClient: boolean('visible_to_client').notNull().default(false),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  supersededByDocumentId: integer('superseded_by_document_id'),

  uploadedByUserId: integer('uploaded_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('client_documents_ref_uk').on(t.ref),
  instIdx: index('client_documents_institution_idx').on(t.institutionId, t.kind),
}));

// ═══════════════════════════════════════════════════════════════════════════
// INSTITUTION IDENTITY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Which federation login belongs to which client, and in what capacity.
 *
 * PART AP: one identity system. A principal at a school signs in with the same
 * `users` row they would use to enter a competition — they simply also have a
 * row here, which is what causes an INSTITUTION_ADMIN binding at institution
 * scope to be issued. No parallel user table, no second password.
 */
export const institutionUsers = pgTable('institution_users', {
  id: serial('id').primaryKey(),
  institutionId: integer('institution_id').notNull().references(() => institutions.id),
  userId: integer('user_id').notNull().references(() => users.id),
  role: text('role').notNull().default('INSTITUTION_COORDINATOR'),
  title: text('title'),
  status: text('status').notNull().default('invited'),  // invited | active | revoked
  invitedByUserId: integer('invited_by_user_id').references(() => users.id),
  invitedAt: timestamp('invited_at', { withTimezone: true }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uk: uniqueIndex('institution_users_uk').on(t.institutionId, t.userId),
  userIdx: index('institution_users_user_idx').on(t.userId, t.status),
}));

// ═══════════════════════════════════════════════════════════════════════════
// DELIVERY: SESSIONS AND ATTENDANCE
// ═══════════════════════════════════════════════════════════════════════════

export const sessionStatus = pgEnum('program_session_status', [
  'scheduled', 'delivered', 'cancelled', 'rescheduled', 'no_show',
]);

/**
 * One occurrence of an institutional programme.
 *
 * NOT `education.trainingSessions`, which records a class held at a dojo and
 * hangs off `dojoId`. This one hangs off a programme and a booking, belongs to
 * a client institution, and is what the client's portal, the coach's calendar
 * and the delivery report all read.
 */
export const programSessions = pgTable('program_sessions', {
  id: serial('id').primaryKey(),
  programId: integer('program_id').notNull().references(() => trainingPrograms.id),
  bookingId: integer('booking_id').references(() => bookings.id),
  seq: integer('seq').notNull(),
  title: text('title'),
  topic: text('topic'),

  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  venueId: integer('venue_id').references(() => venues.id),
  coachPersonId: integer('coach_person_id').references(() => persons.id),

  status: sessionStatus('status').notNull().default('scheduled'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  cancelledReason: text('cancelled_reason'),
  rescheduledToSessionId: integer('rescheduled_to_session_id'),
  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  programSeqUk: uniqueIndex('program_sessions_seq_uk').on(t.programId, t.seq),
  programIdx: index('program_sessions_program_idx').on(t.programId, t.startsAt),
  coachIdx: index('program_sessions_coach_idx').on(t.coachPersonId, t.startsAt),
}));

export const programAttendance = pgTable('program_attendance', {
  id: serial('id').primaryKey(),
  sessionId: integer('session_id').notNull().references(() => programSessions.id),
  participantId: integer('participant_id').notNull().references(() => programParticipants.id),
  present: boolean('present').notNull().default(true),
  note: text('note'),
  /**
   * Attendance corrections are audited (PART AV), so the original recording and
   * the correction are both kept: `correctedFromPresent` is the value that was
   * there before, not a second row.
   */
  correctedFromPresent: boolean('corrected_from_present'),
  correctedAt: timestamp('corrected_at', { withTimezone: true }),
  correctedByUserId: integer('corrected_by_user_id').references(() => users.id),

  recordedByUserId: integer('recorded_by_user_id').references(() => users.id),
  recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uk: uniqueIndex('program_attendance_uk').on(t.sessionId, t.participantId),
  sessionIdx: index('program_attendance_session_idx').on(t.sessionId),
}));

// ═══════════════════════════════════════════════════════════════════════════
// SUPPORT — messages on the existing ticket table
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The conversation on a ticket.
 *
 * `internal` is why staff can think out loud. Without it every note an agent
 * writes is a note the requester reads, so agents stop writing notes and the
 * context lives in someone's head instead of the ticket.
 */
export const ticketMessages = pgTable('ticket_messages', {
  id: serial('id').primaryKey(),
  ticketId: integer('ticket_id').notNull().references(() => supportTickets.id),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  authorKind: text('author_kind').notNull(),       // requester | staff | system
  authorUserId: integer('author_user_id').references(() => users.id),
  authorName: text('author_name'),
  body: text('body').notNull(),
  internal: boolean('internal').notNull().default(false),
  attachments: jsonb('attachments'),
}, (t) => ({
  ticketIdx: index('ticket_messages_ticket_idx').on(t.ticketId, t.at),
}));
