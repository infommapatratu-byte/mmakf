// THE OPERATIONAL FEDERATION TEAM — the people who RUN MMAKF, as distinct from
// the people who GOVERN it and from what any login is permitted to do.
//
// Migration 0056 carries the full reasoning. The three sentences worth
// repeating where the columns are:
//
//   1. `team_appointments.personId` REFERENCES `persons`. There is no second
//      name column anywhere in this file. One human being is one `persons` row,
//      however many hats they wear — employee, Sensei, Black Belt, official.
//
//   2. NO FOREIGN KEY REACHES `committees` IN EITHER DIRECTION. Governance is
//      an office held under the constitution; this is a job. Rendering the
//      media desk on the Governance page would state something false about a
//      real person's standing, so the two registers cannot see each other.
//
//   3. THERE IS NOWHERE HERE TO PUT PRIVATE DATA. No salary, no private phone,
//      no government id, no HR note, no disciplinary finding — not as a
//      nullable column and not as a jsonb blob. These rows are written to be
//      published, and the only reliable way to guarantee a public page never
//      leaks a home number is for the number to have no column to sit in.

import {
  pgTable, pgEnum, serial, text, integer, boolean, date, jsonb,
  timestamp, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { persons, stateUnits, districtUnits, dojos, scopeType } from './schema';

/**
 * The organisational level, kept apart from the free-text `title`.
 *
 * A title is what the card says — "Head of Competition Operations". The level
 * is what the federation can sort and filter by without parsing English, so
 * `/team` can group an org chart from rows nobody hand-ordered.
 */
export const orgLevel = pgEnum('org_level', [
  'executive', 'director', 'head', 'manager',
  'officer', 'coordinator', 'staff', 'volunteer',
]);

/**
 * The APPOINTMENT's lifecycle — not the person's, and not the login's.
 *
 * Somebody may leave the media desk and remain an active member holding an
 * active Black Belt with an unchanged `role_bindings` row. Ending an
 * appointment closes this row and touches neither of the others.
 */
export const teamAppointmentStatus = pgEnum('team_appointment_status', [
  'draft', 'active', 'suspended', 'ended',
]);

export const departments = pgTable('departments', {
  id: serial('id').primaryKey(),
  /**
   * Stable, typed by an administrator, never derived from the name. Renaming
   * "Media" to "Media and Communications" must not orphan every appointment
   * filed under it.
   */
  code: text('code').notNull(),
  name: text('name').notNull(),
  /**
   * Null until somebody sets one, and NOT guessed from the name — for the
   * reason `clubs` are not published under a derived slug: a public URL that
   * moves the day a spelling is corrected is a link somebody had bookmarked.
   */
  slug: text('slug'),
  description: text('description'),
  parentId: integer('parent_id'),
  sortOrder: integer('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('departments_code_uk').on(t.code),
  slugIdx: uniqueIndex('departments_slug_uk').on(t.slug).where(sql`slug is not null`),
  parentIdx: index('departments_parent_idx').on(t.parentId),
}));

export const teamAppointments = pgTable('team_appointments', {
  id: serial('id').primaryKey(),
  /** The canonical person. Never a name. See the header. */
  personId: integer('person_id').notNull().references(() => persons.id),
  departmentId: integer('department_id').references(() => departments.id),

  title: text('title').notNull(),
  orgLevel: orgLevel('org_level').notNull(),
  responsibility: text('responsibility'),

  /**
   * WHERE they operate, in the federation's existing scope vocabulary rather
   * than a second one invented here — so a state coordinator's appointment is
   * scoped the same way their authority is, and one `visibleScopes()` predicate
   * filters both.
   */
  scopeType: scopeType('scope_type').notNull().default('national'),
  scopeStateUnitId: integer('scope_state_unit_id').references(() => stateUnits.id),
  scopeDistrictUnitId: integer('scope_district_unit_id').references(() => districtUnits.id),
  scopeDojoId: integer('scope_dojo_id').references(() => dojos.id),

  startedOn: date('started_on').notNull(),
  endedOn: date('ended_on'),
  status: teamAppointmentStatus('status').notNull().default('draft'),

  /**
   * PUBLICATION IS AN ACT, NOT A DEFAULT.
   *
   * Creating an appointment does not put a person's face on the public
   * internet. That is a separate call gated on `team:publish`, and a CHECK in
   * 0056 refuses to publish anything whose status is not `active` — so a draft,
   * a suspended officer and somebody who left cannot reach `/team` even by a
   * direct UPDATE.
   */
  published: boolean('published').notNull().default(false),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  sortOrder: integer('sort_order').notNull().default(0),

  publicBio: text('public_bio'),
  /**
   * AN OFFICE ROUTE — 'competition@mmakf.in', a desk line the federation
   * publishes on purpose. NEVER an employee's own number.
   *
   * No code can tell a desk number from a personal one, so this is enforced as
   * a sentence beside the field on `/admin/team` rather than by a validator
   * that would only pretend to.
   */
  publicContact: text('public_contact'),
  /** `[{ label, url }]`, https-only — validated by `sanitiseLinks()`. */
  publicLinks: jsonb('public_links'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  personIdx: index('team_appointments_person_idx').on(t.personId),
  deptIdx: index('team_appointments_dept_idx').on(t.departmentId),
  statusIdx: index('team_appointments_status_idx').on(t.status),
  publicIdx: index('team_appointments_public_idx').on(t.sortOrder, t.id).where(sql`published`),
  oneLive: uniqueIndex('team_appointments_one_live_uk')
    .on(t.personId, t.departmentId, t.title)
    .where(sql`status in ('draft', 'active', 'suspended')`),
}));

/**
 * WHAT THE ROW SAID BEFORE.
 *
 * `audit_events` records who did what to which entity, and every write in
 * `src/db/team.ts` puts a row there too. This is the other half of the same
 * question and not a duplicate of it: the audit register answers "who
 * unpublished the Finance Officer on 3 March", and this answers "what did the
 * page say about her that morning" — which is what gets asked when somebody
 * produces a screenshot.
 *
 * APPEND-ONLY. `src/db/team.ts` issues no UPDATE and no DELETE against it, and
 * `tests/team.test.ts` asserts that by reading the module's source rather than
 * by trusting this comment.
 */
export const teamAppointmentHistory = pgTable('team_appointment_history', {
  id: serial('id').primaryKey(),
  appointmentId: integer('appointment_id').notNull().references(() => teamAppointments.id),
  change: text('change').notNull(),
  /** The complete row BEFORE. Null on `created`. */
  before: jsonb('before'),
  /** The complete row AFTER. */
  after: jsonb('after').notNull(),
  reason: text('reason'),
  /**
   * Nullable, because a system process has no user. Writing 0 or a sentinel
   * would make an unattributable change look attributed, which is the failure
   * the four-eyes rule elsewhere in this codebase exists to prevent.
   */
  actorUserId: integer('actor_user_id'),
  actorLabel: text('actor_label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  apptIdx: index('team_appointment_history_appt_idx').on(t.appointmentId, t.id),
}));
