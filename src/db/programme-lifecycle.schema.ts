// The last hop: a programme that ran, and what it produced (migration 0037).
//
// Two tables, and each exists because the fact it records had nowhere to live.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY ELIGIBILITY IS A ROW AND NOT A QUERY
// ─────────────────────────────────────────────────────────────────────────────
//
// "Who may be certified for programme 12?" is answerable by joining sessions to
// attendance every time somebody asks. That is precisely what must NOT happen.
// A certificate is a document the federation has to defend years later, and the
// evidence behind it has to be the register AS IT STOOD when the authority
// signed — not the register as it stands now, after a correction, a late mark,
// a participant leaving, or a session being reclassified. So the assessment is
// FROZEN into `programme_certifications` at the moment the programme completes,
// and the approval reads that row.
//
// It is also the idempotency guarantee. `(program_id, participant_id)` is
// unique, so a programme completing twice — a retried workflow, a double-clicked
// button, two administrators at once — produces one eligibility row per
// participant and therefore at most one certificate. That constraint is the
// guard; there is no SELECT-then-INSERT anywhere that two concurrent callers
// could both pass.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE ATTENDANCE FIGURES ARE COLUMNS AND NOT A THRESHOLD
// ─────────────────────────────────────────────────────────────────────────────
//
// MMAKF HAS PUBLISHED NO MINIMUM ATTENDANCE REQUIREMENT. There is no "80% and
// you pass" anywhere in the federation's instruments, and inventing one here
// would be this system setting the certification standard on the federation's
// behalf — the same class of mistake as inventing a fee.
//
// So the row carries the COUNTS and no verdict beyond the floor: present,
// absent, unrecorded, out of the sessions actually delivered. The floor is the
// only judgement this system makes, and it is a judgement about the RECORD
// rather than about the participant: somebody the register never once places in
// the room is `ineligible`, because a certificate saying they trained would be
// a document with nothing behind it. Everything above that floor is `eligible`,
// which means "a human may now decide", not "this person has earned it".
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A RENEWAL NOTICE IS A ROW AT ALL
// ─────────────────────────────────────────────────────────────────────────────
//
// The notice itself is a domain event, and the event feed already deduplicates
// on `correlation_id`. `renewal_notices` is not a second copy of that: it is the
// record of the SWEEP's decision — which entitlement, expiring on which date,
// with how many days of notice the federation actually gave. That last column is
// the one nobody can reconstruct afterwards, and it is the one a member disputes
// ("I was never told in time").
//
// The unique key is `(entitlement_id, expires_on)` and not `entitlement_id`
// alone, deliberately. A sweep run daily must not write to a member every
// morning for a month — that is the "once" the brief asks for. But an
// entitlement that IS renewed acquires a NEW expiry date, and its next renewal
// window must raise its own notice. Keying on the date gives both: once per
// term, forever, with no scheduling state to keep.

import {
  pgTable, serial, text, integer, timestamp, date,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { persons, users } from './schema';
import { certificates } from './technical.schema';
import { entitlements, entitlementSubject } from './entitlement.schema';
import { trainingPrograms, programParticipants } from './engagement.schema';
import { tasks } from './operations.schema';

/**
 * Five outcomes, and three of them are refusals that are RECORDED rather than
 * thrown away.
 *
 *   eligible    the register places this participant at delivered sessions, and
 *               an authority may now decide. NOT "has passed".
 *   ineligible  the register never once records them present. No human decision
 *               can rest on evidence that does not exist, so this row never
 *               becomes a certificate.
 *   issued      an authority approved it and a certificate exists. `certificate_id`
 *               names it.
 *   declined    an authority looked at the figures and said no, with a reason.
 *               A real answer, kept, and not the same thing as `ineligible`.
 *   blocked     approved in principle and NOT issuable — the commonest case
 *               being a school cohort child the federation holds no person
 *               record for, and `certificates.person_id` is NOT NULL. Recorded
 *               with the reason so the desk gets a list, rather than an
 *               exception that loses it.
 */
export const programmeCertificationStatus = pgEnum('programme_certification_status', [
  'eligible', 'ineligible', 'issued', 'declined', 'blocked',
]);

export const programmeCertifications = pgTable('programme_certifications', {
  id: serial('id').primaryKey(),
  programId: integer('program_id').notNull().references(() => trainingPrograms.id),
  participantId: integer('participant_id').notNull().references(() => programParticipants.id),
  /**
   * Null for a cohort participant the federation holds no person record for.
   * That is not a defect in this table — see `blocked` above — it is the school
   * case that `program_participants.display_name` exists for.
   */
  personId: integer('person_id').references(() => persons.id),

  status: programmeCertificationStatus('status').notNull().default('eligible'),

  // ── The register, frozen at assessment ──────────────────────────────────
  /** Sessions the programme actually delivered. The denominator, stated. */
  sessionsDelivered: integer('sessions_delivered').notNull(),
  /** Marks of any kind recorded for this participant across those sessions. */
  marksRecorded: integer('marks_recorded').notNull(),
  sessionsPresent: integer('sessions_present').notNull(),
  sessionsAbsent: integer('sessions_absent').notNull(),
  /**
   * Delivered sessions with no mark for this participant at all. NOT absences.
   * The register is silent about them and this system does not fill the silence
   * in either direction.
   */
  sessionsUnrecorded: integer('sessions_unrecorded').notNull(),
  assessedAt: timestamp('assessed_at', { withTimezone: true }).notNull().defaultNow(),

  /** The piece of work raised for the authority who may certify. */
  taskId: integer('task_id').references(() => tasks.id),
  certificateId: integer('certificate_id').references(() => certificates.id),

  approvedByUserId: integer('approved_by_user_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  /** Why an authority said no, or why an approved one could not be issued. */
  reason: text('reason'),
  /** Frozen evidence — the checks the programme passed to get here. */
  detail: jsonb('detail'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // THE idempotency guarantee. One assessment per participant per programme.
  participantUk: uniqueIndex('programme_certifications_participant_uk')
    .on(t.programId, t.participantId),
  // A certificate is claimed by exactly one certification row. Postgres treats
  // NULLs as distinct in a unique index, so every row that has not been issued
  // — which is most of them — sits under this index without colliding.
  certificateUk: uniqueIndex('programme_certifications_certificate_uk')
    .on(t.certificateId),
  programStatusIdx: index('programme_certifications_program_status_idx')
    .on(t.programId, t.status),
  personIdx: index('programme_certifications_person_idx').on(t.personId),
}));

export const renewalNotices = pgTable('renewal_notices', {
  id: serial('id').primaryKey(),
  entitlementId: integer('entitlement_id').notNull().references(() => entitlements.id),
  subject: entitlementSubject('subject').notNull(),
  /** The membership, certificate or enrolment that expires. */
  subjectId: integer('subject_id'),
  /** Who to write to. Null means the sweep found nobody, and says so. */
  personId: integer('person_id').references(() => persons.id),

  expiresOn: date('expires_on').notNull(),
  /**
   * How much warning the federation actually gave, in days, as at the sweep.
   *
   * Recorded because it is the number in dispute when a member says they were
   * told too late, and because it is unreconstructible afterwards: the sweep's
   * window is a caller's argument, not a stored policy, and MMAKF has published
   * no renewal window for anybody to look up.
   */
  noticeDays: integer('notice_days').notNull(),
  /** Where the derived expiry came from, in words. Never a guess. */
  basis: text('basis').notNull(),

  raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
  /** The event that carried it to the notification consumer. */
  domainEventId: integer('domain_event_id'),
}, (t) => ({
  // ONCE PER TERM. See the header: keyed on the expiry date, so a daily sweep
  // writes once and a renewed entitlement's next term gets its own notice.
  termUk: uniqueIndex('renewal_notices_term_uk').on(t.entitlementId, t.expiresOn),
  expiryIdx: index('renewal_notices_expiry_idx').on(t.expiresOn),
  personIdx: index('renewal_notices_person_idx').on(t.personId),
}));
