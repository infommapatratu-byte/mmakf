// Governance, compliance and the confidential case systems.
//
// This is the part of a federation that most sites omit and that most
// determines whether it is believed: who holds office, under what document,
// decided at which meeting, and what happens when something goes wrong.
//
// TWO THINGS ARE STRUCTURAL HERE, NOT COSMETIC:
//
//  1. NO OFFICE HOLDER IS INVENTED. Committees and posts are modelled as
//     relationships between a person and a role for a term. An empty committee
//     renders as vacant, which is honest; a fabricated one is the failure this
//     project treats as unforgivable.
//
//  2. SAFEGUARDING AND MEDICAL DATA ARE SEPARATED BY DESIGN, not by a flag on
//     a shared table. They carry their own tables, their own access rules and
//     their own classification, so a mistaken join or a careless `SELECT *`
//     cannot surface a child-protection case in an admin list. That risk is why
//     they are not columns on `persons`.

import {
  pgTable, serial, text, integer, timestamp, date, boolean,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { persons, dojos, stateUnits, districtUnits } from './schema';

// ─── Enums ──────────────────────────────────────────────────────────────────

export const documentStatus = pgEnum('document_status', [
  'draft', 'under_review', 'approved', 'published', 'superseded',
  'withdrawn', 'archived',
]);

export const meetingStatus = pgEnum('meeting_status', [
  'scheduled', 'notice_issued', 'held', 'minutes_draft',
  'minutes_approved', 'cancelled', 'adjourned',
]);

export const motionOutcome = pgEnum('motion_outcome', [
  'carried', 'defeated', 'withdrawn', 'deferred', 'referred',
]);

export const caseStatus = pgEnum('case_status', [
  'received', 'triage', 'under_investigation', 'hearing_scheduled',
  'heard', 'decided', 'appealed', 'appeal_heard', 'closed', 'withdrawn',
]);

/**
 * Data classification, applied at the row level.
 *
 * Any query that reaches a public surface filters on this. Defence in depth:
 * the RBAC layer should already have prevented the read, and this is the second
 * gate for when it does not.
 */
export const dataClass = pgEnum('data_class', [
  'public', 'member', 'official', 'confidential', 'restricted', 'highly_restricted',
]);

export const ticketStatus = pgEnum('ticket_status', [
  'open', 'awaiting_member', 'in_progress', 'escalated', 'resolved', 'closed',
]);

// ─── Committees and office ──────────────────────────────────────────────────

export const committees = pgTable('committees', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),                  // executive | technical | standing | ad_hoc
  remit: text('remit'),
  // The instrument that created it — a constitution clause, a resolution.
  constitutedUnder: text('constituted_under'),
  scopeType: text('scope_type').notNull().default('national'),
  scopeId: integer('scope_id'),
  parentCommitteeId: integer('parent_committee_id'),
  quorum: integer('quorum'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ codeIdx: uniqueIndex('committees_code_uk').on(t.code) }));

/**
 * A person holding an office for a term.
 *
 * Terms are dated and never deleted, so the federation can show who held an
 * office at any past date — which is exactly what an audit or a challenged
 * decision requires.
 */
export const committeeAppointments = pgTable('committee_appointments', {
  id: serial('id').primaryKey(),
  committeeId: integer('committee_id').notNull().references(() => committees.id),
  personId: integer('person_id').notNull().references(() => persons.id),
  office: text('office').notNull(),              // chair | secretary | member
  termFrom: date('term_from').notNull(),
  termTo: date('term_to'),
  appointedUnder: text('appointed_under'),       // election, resolution, nomination
  status: text('status').notNull().default('active'),
  endedReason: text('ended_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  committeeIdx: index('committee_appointments_committee_idx').on(t.committeeId),
  personIdx: index('committee_appointments_person_idx').on(t.personId),
}));

// ─── Documents ──────────────────────────────────────────────────────────────

/**
 * Official documents, versioned.
 *
 * A published version is NEVER edited. Revision creates a new version and marks
 * the old one superseded, because a rule that applied in 2026 must remain
 * readable in the form it had in 2026 — a locked result or a past grading was
 * decided under it.
 */
export const officialDocuments = pgTable('official_documents', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                  // MMAKF-DOC-CONST
  title: text('title').notNull(),
  category: text('category').notNull(),          // constitution | byelaw | policy | regulation | form
  summary: text('summary'),
  // Which body owns it, so a reader knows whether MMAKF wrote it or adopted it.
  issuingBody: text('issuing_body').notNull().default('MMAKF'),
  classification: dataClass('classification').notNull().default('public'),
  currentVersionId: integer('current_version_id'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ codeIdx: uniqueIndex('official_documents_code_uk').on(t.code) }));

export const documentVersions = pgTable('document_versions', {
  id: serial('id').primaryKey(),
  documentId: integer('document_id').notNull().references(() => officialDocuments.id),
  version: text('version').notNull(),            // "1.0", "2026-01"
  status: documentStatus('status').notNull().default('draft'),

  fileUrl: text('file_url'),
  fileSizeBytes: integer('file_size_bytes'),
  fileContentType: text('file_content_type'),
  // Proves the published file has not been swapped since approval.
  fileSha256: text('file_sha256'),
  bodyMarkdown: text('body_markdown'),

  effectiveFrom: date('effective_from'),
  effectiveTo: date('effective_to'),
  approvedByCommitteeId: integer('approved_by_committee_id').references(() => committees.id),
  approvedByPersonId: integer('approved_by_person_id').references(() => persons.id),
  approvedOn: date('approved_on'),
  approvedUnder: text('approved_under'),         // the resolution that adopted it

  supersedesVersionId: integer('supersedes_version_id'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueVersion: uniqueIndex('document_versions_uk').on(t.documentId, t.version),
  documentIdx: index('document_versions_document_idx').on(t.documentId),
}));

// ─── Meetings ───────────────────────────────────────────────────────────────

export const meetings = pgTable('meetings', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),
  committeeId: integer('committee_id').references(() => committees.id),
  title: text('title').notNull(),
  kind: text('kind').notNull(),                  // agm | egm | executive | committee
  status: meetingStatus('status').notNull().default('scheduled'),

  heldOn: date('held_on'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  venue: text('venue'),
  noticeIssuedOn: date('notice_issued_on'),

  quorumRequired: integer('quorum_required'),
  quorumPresent: integer('quorum_present'),
  // Recorded explicitly: decisions taken without quorum are challengeable, and
  // that has to be visible rather than inferred.
  quorumMet: boolean('quorum_met'),

  chairPersonId: integer('chair_person_id').references(() => persons.id),
  minutesDocumentVersionId: integer('minutes_document_version_id').references(() => documentVersions.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ codeIdx: uniqueIndex('meetings_code_uk').on(t.code) }));

export const meetingAttendance = pgTable('meeting_attendance', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').notNull().references(() => meetings.id),
  personId: integer('person_id').notNull().references(() => persons.id),
  role: text('role'),
  present: boolean('present').notNull().default(true),
  apologies: boolean('apologies').notNull().default(false),
  proxyForPersonId: integer('proxy_for_person_id').references(() => persons.id),
}, (t) => ({
  uniqueAttendee: uniqueIndex('meeting_attendance_uk').on(t.meetingId, t.personId),
}));

export const resolutions = pgTable('resolutions', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').notNull().references(() => meetings.id),
  number: text('number').notNull(),
  text: text('text').notNull(),
  movedByPersonId: integer('moved_by_person_id').references(() => persons.id),
  secondedByPersonId: integer('seconded_by_person_id').references(() => persons.id),
  votesFor: integer('votes_for'),
  votesAgainst: integer('votes_against'),
  abstentions: integer('abstentions'),
  outcome: motionOutcome('outcome').notNull(),
  effectiveFrom: date('effective_from'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uniqueNumber: uniqueIndex('resolutions_uk').on(t.meetingId, t.number) }));

export const actionItems = pgTable('action_items', {
  id: serial('id').primaryKey(),
  meetingId: integer('meeting_id').references(() => meetings.id),
  resolutionId: integer('resolution_id').references(() => resolutions.id),
  description: text('description').notNull(),
  ownerPersonId: integer('owner_person_id').references(() => persons.id),
  dueOn: date('due_on'),
  status: text('status').notNull().default('open'),
  completedOn: date('completed_on'),
  note: text('note'),
}, (t) => ({ ownerIdx: index('action_items_owner_idx').on(t.ownerPersonId, t.status) }));

// ─── Conflict of interest ───────────────────────────────────────────────────

/**
 * Declared interests, checked before an appointment or a decision.
 *
 * Without this, an examiner grading their own student or a selector picking
 * their own athlete is invisible until someone complains.
 */
export const interestDeclarations = pgTable('interest_declarations', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  kind: text('kind').notNull(),                  // family | coaching | financial | dojo | other
  description: text('description').notNull(),
  relatedPersonId: integer('related_person_id').references(() => persons.id),
  relatedDojoId: integer('related_dojo_id').references(() => dojos.id),
  declaredOn: date('declared_on').notNull(),
  validTo: date('valid_to'),
  active: boolean('active').notNull().default(true),
}, (t) => ({ personIdx: index('interest_declarations_person_idx').on(t.personId) }));

// ─── Disciplinary and appeals ───────────────────────────────────────────────

export const disciplinaryCases = pgTable('disciplinary_cases', {
  id: serial('id').primaryKey(),
  caseNo: text('case_no').notNull(),
  status: caseStatus('status').notNull().default('received'),
  classification: dataClass('classification').notNull().default('confidential'),

  subjectPersonId: integer('subject_person_id').references(() => persons.id),
  subjectDojoId: integer('subject_dojo_id').references(() => dojos.id),
  complainantPersonId: integer('complainant_person_id').references(() => persons.id),
  anonymousComplainant: boolean('anonymous_complainant').notNull().default(false),

  summary: text('summary').notNull(),
  allegedBreachOf: text('alleged_breach_of'),    // the rule said to be breached
  receivedOn: date('received_on').notNull(),

  investigatorPersonId: integer('investigator_person_id').references(() => persons.id),
  panelCommitteeId: integer('panel_committee_id').references(() => committees.id),
  hearingOn: date('hearing_on'),

  decision: text('decision'),
  sanction: text('sanction'),
  sanctionFrom: date('sanction_from'),
  sanctionTo: date('sanction_to'),
  decidedOn: date('decided_on'),
  decidedByCommitteeId: integer('decided_by_committee_id').references(() => committees.id),

  appealLodgedOn: date('appeal_lodged_on'),
  appealOutcome: text('appeal_outcome'),
  appealDecidedOn: date('appeal_decided_on'),
  closedOn: date('closed_on'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  caseNoIdx: uniqueIndex('disciplinary_cases_no_uk').on(t.caseNo),
  statusIdx: index('disciplinary_cases_status_idx').on(t.status),
}));

// ─── Safeguarding ───────────────────────────────────────────────────────────

/**
 * Child-protection casework. HIGHLY RESTRICTED by default.
 *
 * A separate table from disciplinary cases on purpose. Merging them would put
 * child-protection material one careless join away from a general admin list,
 * and the two have different lawful bases, different retention and a different
 * set of people who may ever read them.
 *
 * `reporterContact` is deliberately free text and may be withheld: a reporter
 * who fears identification must still be able to report.
 */
export const safeguardingCases = pgTable('safeguarding_cases', {
  id: serial('id').primaryKey(),
  caseNo: text('case_no').notNull(),
  status: caseStatus('status').notNull().default('received'),
  classification: dataClass('classification').notNull().default('highly_restricted'),

  concernSummary: text('concern_summary').notNull(),
  concernKind: text('concern_kind'),
  receivedOn: date('received_on').notNull(),
  receivedVia: text('received_via'),

  reporterName: text('reporter_name'),
  reporterContact: text('reporter_contact'),
  reporterAnonymous: boolean('reporter_anonymous').notNull().default(false),

  // Never a join to persons for the child: a safeguarding case must be able to
  // concern someone who is not, and may never be, a federation member.
  subjectDescription: text('subject_description'),
  subjectIsMinor: boolean('subject_is_minor'),
  subjectPersonId: integer('subject_person_id').references(() => persons.id),
  aboutPersonId: integer('about_person_id').references(() => persons.id),

  assignedOfficerPersonId: integer('assigned_officer_person_id').references(() => persons.id),
  // Whether an external authority has been informed. A body working with
  // children must be able to evidence that it referred when it should have.
  referredToAuthority: boolean('referred_to_authority').notNull().default(false),
  referredOn: date('referred_on'),
  referredTo: text('referred_to'),

  actionsTaken: text('actions_taken'),
  outcome: text('outcome'),
  closedOn: date('closed_on'),
  reviewDueOn: date('review_due_on'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  caseNoIdx: uniqueIndex('safeguarding_cases_no_uk').on(t.caseNo),
  officerIdx: index('safeguarding_cases_officer_idx').on(t.assignedOfficerPersonId),
}));

/** Append-only case notes. Nothing in a case file is ever edited. */
export const caseNotes = pgTable('case_notes', {
  id: serial('id').primaryKey(),
  caseKind: text('case_kind').notNull(),         // disciplinary | safeguarding | grievance
  caseId: integer('case_id').notNull(),
  authorPersonId: integer('author_person_id').references(() => persons.id),
  authorUserId: integer('author_user_id'),
  note: text('note').notNull(),
  classification: dataClass('classification').notNull().default('confidential'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ caseIdx: index('case_notes_case_idx').on(t.caseKind, t.caseId) }));

// ─── Medical ────────────────────────────────────────────────────────────────

/**
 * Medical records. RESTRICTED, and never joined into any public query.
 *
 * Deliberately minimal: the federation needs fitness-to-compete and emergency
 * information, not a clinical record. Collecting more than the purpose requires
 * is itself the risk.
 */
export const medicalRecords = pgTable('medical_records', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  classification: dataClass('classification').notNull().default('restricted'),

  kind: text('kind').notNull(),                  // clearance | injury | return_to_play | note
  summary: text('summary'),
  recordedOn: date('recorded_on').notNull(),

  clearanceStatus: text('clearance_status'),     // cleared | restricted | not_cleared
  clearanceValidTo: date('clearance_valid_to'),
  injurySite: text('injury_site'),
  injuryOccurredOn: date('injury_occurred_on'),
  eventId: integer('event_id'),
  returnToPlayOn: date('return_to_play_on'),

  recordedByPersonId: integer('recorded_by_person_id').references(() => persons.id),
  documentUrl: text('document_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ personIdx: index('medical_records_person_idx').on(t.personId) }));

// ─── Support and grievances ─────────────────────────────────────────────────

export const supportTickets = pgTable('support_tickets', {
  id: serial('id').primaryKey(),
  ticketNo: text('ticket_no').notNull(),
  category: text('category').notNull(),
  priority: text('priority').notNull().default('normal'),
  subject: text('subject').notNull(),
  body: text('body').notNull(),

  raisedByPersonId: integer('raised_by_person_id').references(() => persons.id),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  confidential: boolean('confidential').notNull().default(false),

  status: ticketStatus('status').notNull().default('open'),
  assignedToUserId: integer('assigned_to_user_id'),
  department: text('department'),
  // The response deadline, so a service standard is measurable rather than
  // aspirational.
  slaDueAt: timestamp('sla_due_at', { withTimezone: true }),
  firstResponseAt: timestamp('first_response_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolution: text('resolution'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ticketNoIdx: uniqueIndex('support_tickets_no_uk').on(t.ticketNo),
  statusIdx: index('support_tickets_status_idx').on(t.status, t.slaDueAt),
}));

// ─── Partners and sponsors ──────────────────────────────────────────────────

export const partners = pgTable('partners', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  kind: text('kind').notNull(),                  // sponsor | partner | supplier | institution
  tier: text('tier'),
  logoUrl: text('logo_url'),
  websiteUrl: text('website_url'),
  contactName: text('contact_name'),
  contactEmail: text('contact_email'),
  agreementFrom: date('agreement_from'),
  agreementTo: date('agreement_to'),
  deliverables: jsonb('deliverables'),
  status: text('status').notNull().default('prospective'),
  published: boolean('published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ statusIdx: index('partners_status_idx').on(t.status, t.published) }));

// ─── Domain events ──────────────────────────────────────────────────────────

/**
 * The federation's internal event feed.
 *
 * Every significant state change is appended here — RESULT_FINALIZED,
 * CERTIFICATE_ISSUED, LIVE_STARTED, RANKING_UPDATED — and consumers read from
 * it rather than each polling its own tables. It is what lets notifications,
 * analytics, the live scoreboard and any future mobile app stay consistent with
 * each other instead of each computing its own version of the truth.
 *
 * Append-only. A consumer that fails is retried from its own cursor; the event
 * itself is never rewritten.
 */
export const domainEvents = pgTable('domain_events', {
  id: serial('id').primaryKey(),
  eventType: text('event_type').notNull(),       // RESULT_FINALIZED, LIVE_STARTED, …
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  payload: jsonb('payload').notNull(),
  classification: dataClass('classification').notNull().default('member'),

  actorUserId: integer('actor_user_id'),
  actorLabel: text('actor_label'),
  correlationId: text('correlation_id'),

  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (t) => ({
  typeIdx: index('domain_events_type_idx').on(t.eventType, t.occurredAt),
  entityIdx: index('domain_events_entity_idx').on(t.entityType, t.entityId),
  // Drives the notification and analytics consumers.
  unpublishedIdx: index('domain_events_unpublished_idx').on(t.publishedAt, t.id),
}));

export const notifications = pgTable('notifications', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').references(() => persons.id),
  userId: integer('user_id'),
  channel: text('channel').notNull().default('in_app'),  // in_app | email | sms | push
  title: text('title').notNull(),
  body: text('body').notNull(),
  linkUrl: text('link_url'),
  domainEventId: integer('domain_event_id').references(() => domainEvents.id),

  status: text('status').notNull().default('queued'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  recipientIdx: index('notifications_recipient_idx').on(t.personId, t.status),
  queueIdx: index('notifications_queue_idx').on(t.status, t.createdAt),
}));
