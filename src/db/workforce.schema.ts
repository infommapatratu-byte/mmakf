// THE WORKFORCE — employment, leave, time, expenses and recruitment.
//
// Migration 0058 carries the full reasoning. The four sentences worth repeating
// where the columns are:
//
//   1. `employments.personId` REFERENCES `persons`. There is no `employees`
//      table carrying a name. The federation's Technical Director is very often
//      also a 5th Dan, an examiner and a club owner, and a second identity
//      record for one human being is a second date of birth.
//
//   2. NO FOREIGN KEY REACHES `team_appointments`, in either direction.
//      `team_appointments` is what somebody does IN PUBLIC; this is that the
//      federation EMPLOYS them, and it is private. A volunteer coordinator is
//      the first and not the second; a payroll clerk is the second and not the
//      first. They meet at `persons.id` and nowhere else.
//
//   3. THERE IS NO SALARY COLUMN AND NO BANK DETAIL. `payBandCode` is a
//      reference to a band MMAKF defines elsewhere. Payroll carries statutory
//      obligations this repository cannot discharge, and a half-built one that
//      computes a figure somebody pays a real person is worse than none.
//
//   4. A CANDIDATE IS NOT YET A PERSON. `jobApplications.personId` is nullable
//      and set on ACCEPTANCE, mirroring `provisionFromRegistration()` on the
//      institutional intake path. Filing every unsuccessful applicant into the
//      federation's people register would make the national member count a
//      number nobody could defend.
//
// NOT RE-EXPORTED FROM schema.ts, for the mechanical reason recorded at the
// bottom of that file: this module uses `scopeType` and `orgLevel` EAGERLY, and
// `export * from` evaluates the target before schema.ts's own body runs. Import
// it directly:  import * as w from '@/db/workforce.schema';

import {
  pgTable, pgEnum, serial, text, integer, boolean, date, jsonb,
  timestamp, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { persons, stateUnits, scopeType } from './schema';
import { departments, orgLevel } from './team.schema';

export const employmentType = pgEnum('employment_type', [
  'permanent', 'fixed_term', 'contract', 'consultant',
  'intern', 'apprentice', 'volunteer', 'secondment',
]);

/**
 * The EMPLOYMENT's lifecycle — not the person's and not the login's.
 *
 * Ending an employment does not disable a `users` row, because a departing
 * employee is routinely still a member and still holds a rank. Removing access
 * is a `role_bindings` act under `role:grant`.
 */
export const employmentStatus = pgEnum('employment_status', [
  'offered', 'onboarding', 'active', 'on_leave',
  'suspended', 'notice', 'ended',
]);

export const positionStatus = pgEnum('position_status', [
  'draft', 'open', 'filled', 'frozen', 'closed',
]);

export const leaveRequestStatus = pgEnum('leave_request_status', [
  'draft', 'submitted', 'approved', 'rejected', 'cancelled', 'withdrawn',
]);

export const expenseClaimStatus = pgEnum('expense_claim_status', [
  'draft', 'submitted', 'approved', 'rejected', 'paid', 'cancelled',
]);

export const vacancyStatus = pgEnum('vacancy_status', [
  'draft', 'open', 'closed', 'filled', 'withdrawn',
]);

export const jobApplicationStatus = pgEnum('job_application_status', [
  'received', 'screening', 'shortlisted', 'interviewing',
  'offered', 'accepted', 'declined', 'rejected', 'withdrawn',
]);

export const workRecordStatus = pgEnum('work_record_status', [
  'draft', 'submitted', 'approved', 'rejected',
]);

/**
 * A POSITION IS A SLOT, NOT A PERSON.
 *
 * "Competition Operations Manager" exists whether or not anybody holds it, which
 * is what lets the federation carry a vacancy, a reporting line and a headcount
 * without inventing a placeholder employee to hang them from.
 *
 * It reuses `departments` from migration 0056 rather than minting a second
 * organisational tree: the team register and the establishment describe the same
 * organisation and must not disagree about what its departments are.
 */
export const positions = pgTable('positions', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),
  title: text('title').notNull(),
  departmentId: integer('department_id').references(() => departments.id),
  orgLevel: orgLevel('org_level').notNull(),
  reportsToPositionId: integer('reports_to_position_id'),
  /** How many people may hold this position at once. Usually 1. */
  headcount: integer('headcount').notNull().default(1),
  status: positionStatus('status').notNull().default('draft'),
  /** A REFERENCE, NOT AN AMOUNT. See rule 3 in the header. */
  payBandCode: text('pay_band_code'),
  scopeType: scopeType('scope_type').notNull().default('national'),
  scopeStateUnitId: integer('scope_state_unit_id').references(() => stateUnits.id),
  description: text('description'),
  responsibilities: text('responsibilities'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('positions_code_uk').on(t.code),
  deptIdx: index('positions_dept_idx').on(t.departmentId),
  reportsIdx: index('positions_reports_idx').on(t.reportsToPositionId),
}));

export const employments = pgTable('employments', {
  id: serial('id').primaryKey(),
  /** The canonical person. Never a name. See rule 1. */
  personId: integer('person_id').notNull().references(() => persons.id),
  positionId: integer('position_id').references(() => positions.id),
  employeeNo: text('employee_no').notNull(),
  employmentType: employmentType('employment_type').notNull(),
  status: employmentStatus('status').notNull().default('offered'),
  /**
   * THE LINE MANAGER, as a PERSON not a position.
   *
   * `positions.reportsToPositionId` is the establishment's shape; this is who
   * actually approves this employee's leave today — which during a vacancy is
   * somebody else entirely. Both are needed and they are not the same fact.
   */
  managerPersonId: integer('manager_person_id').references(() => persons.id),
  startedOn: date('started_on').notNull(),
  endedOn: date('ended_on'),
  probationEndsOn: date('probation_ends_on'),
  noticeEndsOn: date('notice_ends_on'),
  workLocation: text('work_location'),
  weeklyHours: integer('weekly_hours'),
  payBandCode: text('pay_band_code'),
  /** A controlled vocabulary — see EXIT_REASONS in src/db/workforce.ts. */
  exitReason: text('exit_reason'),
  exitNote: text('exit_note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  employeeNoIdx: uniqueIndex('employments_employee_no_uk').on(t.employeeNo),
  personIdx: index('employments_person_idx').on(t.personId),
  managerIdx: index('employments_manager_idx').on(t.managerPersonId),
  positionIdx: index('employments_position_idx').on(t.positionId),
  statusIdx: index('employments_status_idx').on(t.status),
  /**
   * ONE LIVE EMPLOYMENT PER PERSON, partial so re-employment after leaving is
   * possible and the closed rows survive as history. Without it a retried
   * onboarding creates a second live employment and every leave balance,
   * approval route and headcount doubles silently.
   */
  oneLive: uniqueIndex('employments_one_live_uk').on(t.personId).where(sql`status <> 'ended'`),
}));

/** Append-only. `src/db/workforce.ts` issues no UPDATE and no DELETE here. */
export const employmentEvents = pgTable('employment_events', {
  id: serial('id').primaryKey(),
  employmentId: integer('employment_id').notNull().references(() => employments.id),
  kind: text('kind').notNull(),
  effectiveOn: date('effective_on').notNull(),
  before: jsonb('before'),
  after: jsonb('after').notNull(),
  reason: text('reason'),
  actorUserId: integer('actor_user_id'),
  actorLabel: text('actor_label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  empIdx: index('employment_events_emp_idx').on(t.employmentId, t.id),
}));

/** SHIPS EMPTY. Leave policy is MMAKF's, not a developer's guess. */
export const leaveTypes = pgTable('leave_types', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  paid: boolean('paid').notNull().default(true),
  allowsNegative: boolean('allows_negative').notNull().default(false),
  requiresHrApproval: boolean('requires_hr_approval').notNull().default(false),
  active: boolean('active').notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('leave_types_code_uk').on(t.code),
}));

export const leaveEntitlements = pgTable('leave_entitlements', {
  id: serial('id').primaryKey(),
  employmentId: integer('employment_id').notNull().references(() => employments.id),
  leaveTypeId: integer('leave_type_id').notNull().references(() => leaveTypes.id),
  leaveYear: integer('leave_year').notNull(),
  /** HALF-DAYS as an integer, never a float — 0.5 in binary floating point is
   *  what makes a balance eventually read 4.499999999. */
  entitledHalfDays: integer('entitled_half_days').notNull().default(0),
  carriedHalfDays: integer('carried_half_days').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uk: uniqueIndex('leave_entitlements_uk').on(t.employmentId, t.leaveTypeId, t.leaveYear),
}));

export const leaveRequests = pgTable('leave_requests', {
  id: serial('id').primaryKey(),
  employmentId: integer('employment_id').notNull().references(() => employments.id),
  leaveTypeId: integer('leave_type_id').notNull().references(() => leaveTypes.id),
  reference: text('reference').notNull(),
  fromDate: date('from_date').notNull(),
  toDate: date('to_date').notNull(),
  /** Computed by the domain module from the dates — never supplied by a client.
   *  A request that names its own duration can be 0.5 days long and 30 wide. */
  halfDays: integer('half_days').notNull(),
  firstDayHalf: boolean('first_day_half').notNull().default(false),
  lastDayHalf: boolean('last_day_half').notNull().default(false),
  status: leaveRequestStatus('status').notNull().default('draft'),
  reason: text('reason'),
  decidedByUserId: integer('decided_by_user_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  hrDecidedByUserId: integer('hr_decided_by_user_id'),
  hrDecidedAt: timestamp('hr_decided_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refIdx: uniqueIndex('leave_requests_reference_uk').on(t.reference),
  empIdx: index('leave_requests_emp_idx').on(t.employmentId, t.fromDate),
  statusIdx: index('leave_requests_status_idx').on(t.status),
}));

/**
 * AN EMPLOYEE'S WORKING TIME — deliberately NOT `session_attendance`, which is a
 * CLASS REGISTER recording which student turned up to which training session.
 * Conflating them would put a payroll question and a safeguarding question in
 * one table.
 */
export const workRecords = pgTable('work_records', {
  id: serial('id').primaryKey(),
  employmentId: integer('employment_id').notNull().references(() => employments.id),
  workDate: date('work_date').notNull(),
  /** MINUTES, integer — for the reason leave is half-days. */
  minutes: integer('minutes').notNull(),
  status: workRecordStatus('status').notNull().default('draft'),
  note: text('note'),
  approvedByUserId: integer('approved_by_user_id'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uk: uniqueIndex('work_records_uk').on(t.employmentId, t.workDate),
  statusIdx: index('work_records_status_idx').on(t.status),
}));

export const expenseClaims = pgTable('expense_claims', {
  id: serial('id').primaryKey(),
  employmentId: integer('employment_id').notNull().references(() => employments.id),
  reference: text('reference').notNull(),
  title: text('title').notNull(),
  /** INTEGER PAISE, as every other money column in this repository. */
  totalMinor: integer('total_minor').notNull().default(0),
  currency: text('currency').notNull().default('INR'),
  status: expenseClaimStatus('status').notNull().default('draft'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  decidedByUserId: integer('decided_by_user_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  /** Recorded by finance. NOT a payment integration — the federation pays an
   *  employee expense through its own banking, and inventing a gateway path for
   *  it would be fake automation. */
  paidOn: date('paid_on'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refIdx: uniqueIndex('expense_claims_reference_uk').on(t.reference),
  empIdx: index('expense_claims_emp_idx').on(t.employmentId),
  statusIdx: index('expense_claims_status_idx').on(t.status),
}));

export const expenseClaimLines = pgTable('expense_claim_lines', {
  id: serial('id').primaryKey(),
  claimId: integer('claim_id').notNull().references(() => expenseClaims.id),
  spentOn: date('spent_on').notNull(),
  category: text('category').notNull(),
  description: text('description').notNull(),
  amountMinor: integer('amount_minor').notNull(),
  /** A pointer into the existing upload store, never a file in the database. */
  receiptRef: text('receipt_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  claimIdx: index('expense_claim_lines_claim_idx').on(t.claimId),
}));

export const vacancies = pgTable('vacancies', {
  id: serial('id').primaryKey(),
  positionId: integer('position_id').references(() => positions.id),
  reference: text('reference').notNull(),
  title: text('title').notNull(),
  departmentId: integer('department_id').references(() => departments.id),
  slug: text('slug'),
  summary: text('summary'),
  description: text('description'),
  requirements: text('requirements'),
  employmentType: employmentType('employment_type').notNull(),
  location: text('location'),
  scopeType: scopeType('scope_type').notNull().default('national'),
  scopeStateUnitId: integer('scope_state_unit_id').references(() => stateUnits.id),
  openings: integer('openings').notNull().default(1),
  status: vacancyStatus('status').notNull().default('draft'),
  /** PUBLICATION IS AN ACT, as for a team appointment. Creating a vacancy does
   *  not advertise it. A CHECK refuses to publish anything not `open`. */
  published: boolean('published').notNull().default(false),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  opensOn: date('opens_on'),
  closesOn: date('closes_on'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refIdx: uniqueIndex('vacancies_reference_uk').on(t.reference),
  slugIdx: uniqueIndex('vacancies_slug_uk').on(t.slug).where(sql`slug is not null`),
  publicIdx: index('vacancies_public_idx').on(t.published, t.status),
}));

/** An APPLICANT, who is not yet a person in the federation register. Rule 4. */
export const jobApplications = pgTable('job_applications', {
  id: serial('id').primaryKey(),
  vacancyId: integer('vacancy_id').notNull().references(() => vacancies.id),
  reference: text('reference').notNull(),
  applicantName: text('applicant_name').notNull(),      // PRIVATE
  applicantEmail: text('applicant_email').notNull(),    // PRIVATE
  applicantPhone: text('applicant_phone'),              // PRIVATE
  coverNote: text('cover_note'),
  cvRef: text('cv_ref'),
  currentEmployer: text('current_employer'),
  yearsExperience: integer('years_experience'),
  /** Null until hired. The join to the ONE canonical person. */
  personId: integer('person_id').references(() => persons.id),
  status: jobApplicationStatus('status').notNull().default('received'),
  rejectedReason: text('rejected_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refIdx: uniqueIndex('job_applications_reference_uk').on(t.reference),
  statusIdx: index('job_applications_status_idx').on(t.status),
  // The one-per-email-per-vacancy index is expressed in SQL with lower(), which
  // Drizzle cannot describe here. It exists in migration 0058 and is what the
  // duplicate-submission test exercises.
}));

export const jobApplicationEvents = pgTable('job_application_events', {
  id: serial('id').primaryKey(),
  applicationId: integer('application_id').notNull().references(() => jobApplications.id),
  kind: text('kind').notNull(),
  note: text('note'),
  actorUserId: integer('actor_user_id'),
  actorLabel: text('actor_label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  appIdx: index('job_application_events_app_idx').on(t.applicationId, t.id),
}));

export const interviews = pgTable('interviews', {
  id: serial('id').primaryKey(),
  applicationId: integer('application_id').notNull().references(() => jobApplications.id),
  round: integer('round').notNull().default(1),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  durationMinutes: integer('duration_minutes'),
  mode: text('mode'),
  location: text('location'),
  status: text('status').notNull().default('scheduled'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  roundIdx: uniqueIndex('interviews_round_uk').on(t.applicationId, t.round),
}));

export const interviewPanellists = pgTable('interview_panellists', {
  id: serial('id').primaryKey(),
  interviewId: integer('interview_id').notNull().references(() => interviews.id),
  personId: integer('person_id').notNull().references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uk: uniqueIndex('interview_panellists_uk').on(t.interviewId, t.personId),
}));

/**
 * ONE PANELLIST, ONE OPINION, RECORDED BEFORE THEY SEE THE OTHERS.
 *
 * The domain module refuses a second write from the same panellist. That is not
 * bureaucracy: a panel whose members revise their scores after reading each
 * other's is a panel with one opinion, and the point of a panel is that it has
 * several.
 */
export const interviewFeedback = pgTable('interview_feedback', {
  id: serial('id').primaryKey(),
  interviewId: integer('interview_id').notNull().references(() => interviews.id),
  panellistPersonId: integer('panellist_person_id').notNull().references(() => persons.id),
  /** 1..5. Coarse deliberately — a 1-100 scale invites precision no interviewer
   *  actually has. */
  score: integer('score'),
  recommendation: text('recommendation').notNull(),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uk: uniqueIndex('interview_feedback_one_per_panellist_uk').on(t.interviewId, t.panellistPersonId),
}));

export const jobOffers = pgTable('job_offers', {
  id: serial('id').primaryKey(),
  applicationId: integer('application_id').notNull().references(() => jobApplications.id),
  positionId: integer('position_id').references(() => positions.id),
  reference: text('reference').notNull(),
  employmentType: employmentType('employment_type').notNull(),
  payBandCode: text('pay_band_code'),
  proposedStartOn: date('proposed_start_on').notNull(),
  status: text('status').notNull().default('draft'),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  expiresOn: date('expires_on'),
  note: text('note'),
  /** Set when acceptance creates the employment — the join that closes the loop
   *  from vacancy to employee. */
  employmentId: integer('employment_id').references(() => employments.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refIdx: uniqueIndex('job_offers_reference_uk').on(t.reference),
  oneLive: uniqueIndex('job_offers_one_live_uk').on(t.applicationId)
    .where(sql`status in ('draft', 'issued', 'accepted')`),
}));
