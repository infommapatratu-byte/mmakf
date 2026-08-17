// The federation scheduling engine — schema (Wave 2s).
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT WAS WRONG, AND WHY IT COULD NOT BE PATCHED
// ═══════════════════════════════════════════════════════════════════════════
//
// Before this file, MMAKF's opening hours were two English sentences in
// src/data/seed.ts — `federation.contact.hours` and
// `federation.contact.hoursSunday` — rendered by /schedule and /facilities, and
// a flat `schedule` array of thirteen rows with a `day` column reading 'Mon'.
// Three things follow from that, and all three are defects rather than
// shortcuts:
//
//  1. THERE WAS EXACTLY ONE SCHEDULE, AND IT BELONGED TO NOBODY. The string
//     said "Mon–Sat · 06:00–09:00 & 17:00–20:00" and the page called it the
//     MMAKF timetable. It is the HOMBU DOJO's timetable. An affiliated club in
//     Bokaro that trains Monday to Friday 18:00–21:00 was being published, on
//     the federation's own site, as training at six in the morning.
//
//  2. THE SEASON WAS IN THE PROSE. 'Summer 06:00–10:00 · Winter 08:00–11:30'
//     is two schedules crammed into one cell, with the changeover date written
//     down nowhere at all. Nothing could answer "is the dojo open at 09:30 on
//     the 4th of October" — not the page, not the database, not the office.
//
//  3. CHANGING IT NEEDED A DEVELOPER. Every timing was a string literal in a
//     seed file behind a deploy. The federation could not move a Sunday class
//     by half an hour without somebody editing TypeScript.
//
// This schema exists so that none of those three sentences can be written
// again. Hours are ROWS. Seasons have DATES. Every level of the federation owns
// its own, and the hombu dojo's hours are the hombu dojo's hours.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IS NOT HERE, BECAUSE IT ALREADY EXISTS
// ═══════════════════════════════════════════════════════════════════════════
//
// The instruction was to reuse canonical entities and not duplicate tables, and
// most of the nouns in a scheduling model were already in this repository:
//
//   Organization / Club / Dojo   → `state_units`, `district_units`, `dojos`.
//   Facility / TrainingLocation  → `venues` (operations.schema.ts). A venue is
//                                  a ROOM; a dojo is a MEMBER. Both already say
//                                  so at length. This wave adds a timezone and
//                                  coordinates to venues and nothing else.
//   Instructor                   → `persons` + `coach_profiles`.
//   InstructorAvailability       → `coach_availability` (engagement.schema.ts),
//                                  which already stores real intervals and is
//                                  already read by src/db/booking.ts.
//   Booking                      → `bookings` + `booking_resources`, with a
//                                  transactional, advisory-locked booking path
//                                  in src/db/booking.ts. This wave adds ONE
//                                  column to `bookings` — `class_session_id` —
//                                  rather than a second booking table.
//   FacilityAvailability         → `venue_blackouts`, for maintenance and
//                                  closures at the ROOM. Kept, and read by the
//                                  resolver. See `scheduleExceptions` below for
//                                  why that is not the same table as this one.
//   Holiday                      → `schedule_exceptions`, below. There was no
//                                  holiday table to reuse.
//   Audit of every change        → `audit_events` + writeAudit(). No scheduling
//                                  changelog table: "who changed it, what,
//                                  when, reason" is the audit spine's whole
//                                  job, and a second one would drift from it.
//
// So what is genuinely new is the part that was genuinely missing: RECURRENCE,
// SEASONS, INHERITANCE, EXCEPTIONS and VERSIONS — plus the class as an object
// distinct from the room it happens in.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FIVE DECISIONS THIS SCHEMA MAKES
// ═══════════════════════════════════════════════════════════════════════════
//
// ONE. A SCHEDULE HAS AN OWNER, AND THE OWNER IS A SCOPE. `owner_scope` is the
// existing `scope_type` enum — national | state | district | dojo | institution
// — the same vocabulary RBAC already uses for role bindings. That is not a
// convenience: it means the question "may this administrator edit this
// schedule?" is answered by the authority model that already exists, with no
// second notion of who-owns-what to keep in step. A club administrator bound at
// dojo scope can edit the dojo's schedule and cannot reach the federation's.
//
// TWO. INHERITANCE IS RESOLVED, NEVER COPIED. There is no job that pushes the
// federation's hours down into clubs. The resolver in src/db/scheduling.ts
// walks venue → dojo → district → state → national and stops at the FIRST level
// that has a schedule for the purpose it was asked about. A club that has
// defined nothing inherits; a club that has defined something overrides, and
// the federation's row is not touched. `inherits_from_schedule_id` exists for
// the case the hierarchy cannot express — a satellite location following
// another club's timetable — and is deliberately the exception, not the path.
//
// THREE. CONTENT LIVES IN A VERSION, AND VERSIONS ARE NOT OVERWRITTEN. The
// timings are in `schedule_rules`, which hang off `schedule_versions`, which
// carry `effective_from` / `effective_to`. Changing a club's hours creates a NEW
// version; the old one is marked superseded and keeps its rules. Every read
// takes an `asOf` date, so an attendance record from March renders against the
// timetable that was actually in force in March. This is the requirement that
// makes the rest of the model shaped the way it is — without it, `schedules`
// and `schedule_rules` would be two tables instead of four.
//
// FOUR. THE ROOM'S HOURS AND THE CLASS'S HOURS ARE DIFFERENT OBJECTS. A dojo
// open 06:00–21:00 is not a dojo running a class for fifteen hours. Facility
// hours are a schedule with `purpose = 'operating'`; a class is a row in
// `dojo_classes` with its own schedule at `purpose = 'class'`, and the engine
// refuses to place a class outside the room's open hours rather than silently
// widening them.
//
// FIVE. AN EXCEPTION IS AN EFFECT, NOT A MOOD. `schedule_exceptions.effect` is
// one of closed / replace / add / remove, and `kind` is the human reason
// (holiday, grading, maintenance…). Splitting them is what lets "15 September:
// closed for grading" and "15 September: 06:00–08:00 only, grading afterwards"
// be the same table. A single `kind` column would have had to grow a value per
// combination, and the resolver would have been a switch nobody could audit.
//
// ═══════════════════════════════════════════════════════════════════════════
// TIME, AND WHY IT IS TEXT
// ═══════════════════════════════════════════════════════════════════════════
//
// Rule and exception times are `text` in HH:MM, with a CHECK constraint that
// makes anything else unstorable. They are WALL-CLOCK times in the schedule's
// own timezone — "the dojo opens at six" is a fact about the dojo's clock, not
// an instant, and it stays true across a timezone change that an instant would
// not survive. HH:MM is also lexicographically ordered, so `closes_at >
// opens_at` is a real database CHECK rather than a hope.
//
// Instants — `class_sessions.starts_at` — are `timestamptz`, because an
// occurrence IS a moment. Each session also freezes the local date and local
// times it was generated from, so a session can still say what the timetable
// said even if the venue's timezone is later corrected.
//
// `timezone` is an IANA name and it is NOT assumed to be Asia/Kolkata forever.
// It defaults to it, because MMAKF is in India today and a default nobody has
// to type is worth more than a null nobody notices.

import {
  pgTable, serial, text, integer, boolean, timestamp, date,
  uniqueIndex, index, pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { persons, users, scopeType } from './schema';
import { deliveryMode } from './engagement.schema';
// `venues` is the facility. Imported for a real foreign key: a schedule for a
// room that does not exist is not a schedule. `sessionStatus` is reused rather
// than cloned — it already reads scheduled | delivered | cancelled |
// rescheduled | no_show, which is exactly the lifecycle of a class occurrence,
// and a second enum with the same five values would drift the first time
// somebody added a sixth to one of them.
import { venues, sessionStatus } from './operations.schema';

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/**
 * What a schedule GOVERNS.
 *
 * 'operating' is the front door being open. 'training' is when the mat is
 * available to train on, which is narrower and is the one a member cares about.
 * 'office' and 'administrative' are the staffed hours the federation answers
 * the telephone in — HQ has all four and they genuinely differ.
 *
 * 'class' belongs to one row in `dojo_classes` and to nothing else.
 */
export const schedulePurpose = pgEnum('schedule_purpose', [
  'operating', 'training', 'office', 'administrative', 'class',
]);

export const scheduleStatus = pgEnum('schedule_status', [
  'draft', 'active', 'retired',
]);

/**
 * A version's standing.
 *
 * 'draft' is editable and invisible to every read. 'published' is in force for
 * its window. 'superseded' is history and is still readable — that is the whole
 * point of it existing. 'withdrawn' is a version published in error and pulled;
 * it is distinguished from 'superseded' because "we replaced this" and "this
 * should never have been in force" are different statements to a member asking
 * why the timetable changed.
 */
export const scheduleVersionStatus = pgEnum('schedule_version_status', [
  'draft', 'published', 'superseded', 'withdrawn',
]);

export const scheduleRuleKind = pgEnum('schedule_rule_kind', ['open', 'closed']);

/** WHY a date differs. Descriptive; the machine-readable half is `effect`. */
export const scheduleExceptionKind = pgEnum('schedule_exception_kind', [
  'holiday', 'closure', 'extended_hours', 'reduced_hours',
  'competition', 'seminar', 'camp', 'maintenance',
  'private_booking', 'examination', 'grading', 'special_training',
]);

/**
 * WHAT a date override does to the day's normal windows.
 *
 * closed  — the whole day is shut, whatever the rules say.
 * replace — the exception's windows ARE the day; the rules are discarded.
 * add     — an extra window on top of the normal ones.
 * remove  — cut this window out of the normal ones (a two-hour maintenance
 *           slot inside an otherwise ordinary day).
 */
export const scheduleExceptionEffect = pgEnum('schedule_exception_effect', [
  'closed', 'replace', 'add', 'remove',
]);

export const seasonStatus = pgEnum('season_status', ['draft', 'active', 'archived']);

export const classStatus = pgEnum('dojo_class_status', [
  'draft', 'active', 'paused', 'retired',
]);

// ─── Seasons ────────────────────────────────────────────────────────────────

/**
 * A named stretch of the calendar, with dates somebody chose.
 *
 * 'Summer' and 'Winter' are NOT hard-coded anywhere in this system. They are
 * rows here, owned by whoever defined them, with a start and an end an
 * administrator set and can move. A club may use the federation's definitions
 * or write its own — the resolver looks for a season owned by the schedule's
 * own level first and walks up only if it finds none, which is the same
 * inheritance rule the schedules themselves follow.
 *
 * `owner_id` is null exactly when `owner_scope` is 'national': the federation
 * is the one level with no row of its own to point at.
 */
export const seasons = pgTable('seasons', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                    // summer-2026
  name: text('name').notNull(),                    // Summer 2026
  ownerScope: scopeType('owner_scope').notNull(),
  ownerId: integer('owner_id'),
  startsOn: date('starts_on').notNull(),
  endsOn: date('ends_on').notNull(),
  status: seasonStatus('status').notNull().default('draft'),
  /** False stops a lower level inheriting it — a club season is usually local. */
  inheritable: boolean('inheritable').notNull().default(true),
  notes: text('notes'),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // COALESCE because Postgres treats NULLs as distinct, so a plain unique index
  // on a nullable owner_id would let the federation define 'summer-2026' twice.
  codeUk: uniqueIndex('seasons_code_uk').on(t.ownerScope, sql`coalesce(${t.ownerId}, 0)`, t.code),
  ownerIdx: index('seasons_owner_idx').on(t.ownerScope, t.ownerId, t.startsOn),
  windowIdx: index('seasons_window_idx').on(t.startsOn, t.endsOn),
}));

// ─── Schedules ──────────────────────────────────────────────────────────────

/**
 * The IDENTITY of a schedule. It holds no timings — those are in versions.
 *
 * Splitting identity from content is what makes "do not overwrite historical
 * schedules" mechanical rather than a discipline: a club's schedule keeps one
 * id and one public URL for its whole life, while what it SAYS is a stack of
 * effective-dated versions nobody edits after publication.
 */
export const schedules = pgTable('schedules', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                    // MMAKF-SCH-2026-000001
  name: text('name').notNull(),
  purpose: schedulePurpose('purpose').notNull(),

  ownerScope: scopeType('owner_scope').notNull(),
  ownerId: integer('owner_id'),

  /** The room. Null means the schedule belongs to the UNIT, not to one space. */
  venueId: integer('venue_id').references(() => venues.id),
  /** Set exactly when purpose = 'class'. Enforced by CHECK in the migration. */
  classId: integer('class_id'),

  /** IANA. Wall-clock rules are meaningless without it. */
  timezone: text('timezone').notNull().default('Asia/Kolkata'),

  /**
   * An EXPLICIT parent, for the case the hierarchy cannot express.
   *
   * Normal inheritance needs no column at all — the resolver walks the
   * federation tree. This is for a satellite that follows another club's
   * timetable, or a second hall that follows the main one. Cycles are refused
   * by the service, not by the database.
   */
  inheritsFromScheduleId: integer('inherits_from_schedule_id'),

  status: scheduleStatus('status').notNull().default('draft'),
  /** Whether this appears on the public site at all. */
  publicVisible: boolean('public_visible').notNull().default(true),
  notes: text('notes'),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('schedules_code_uk').on(t.code),
  // One ACTIVE schedule per owner + purpose + room + class. Two would make
  // resolution a coin toss, and the loser would be somebody's Sunday.
  targetUk: uniqueIndex('schedules_target_uk')
    .on(
      t.ownerScope, sql`coalesce(${t.ownerId}, 0)`, t.purpose,
      sql`coalesce(${t.venueId}, 0)`, sql`coalesce(${t.classId}, 0)`
    )
    .where(sql`status <> 'retired'`),
  ownerIdx: index('schedules_owner_idx').on(t.ownerScope, t.ownerId, t.purpose),
  venueIdx: index('schedules_venue_idx').on(t.venueId),
  classIdx: index('schedules_class_idx').on(t.classId),
}));

/**
 * One effective-dated edition of a schedule.
 *
 * `effective_to` null means "until further notice", which is the normal state of
 * the current version. Publishing a successor CLOSES the incumbent by setting
 * its `effective_to` to the day before the new one starts and moving it to
 * 'superseded' — it is never deleted and its rules are never edited.
 *
 * The CHECK on publication is the "every change must have who / when / reason"
 * requirement made unavoidable: a row cannot BE published without a publisher
 * and a timestamp. The reason travels in `audit_events` alongside, where every
 * other consequential act in this system already records its reason.
 */
export const scheduleVersions = pgTable('schedule_versions', {
  id: serial('id').primaryKey(),
  scheduleId: integer('schedule_id').notNull().references(() => schedules.id),
  versionNo: integer('version_no').notNull(),
  status: scheduleVersionStatus('status').notNull().default('draft'),

  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),

  reason: text('reason'),
  supersedesVersionId: integer('supersedes_version_id'),

  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedByUserId: integer('published_by_user_id').references(() => users.id),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  withdrawnReason: text('withdrawn_reason'),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  versionUk: uniqueIndex('schedule_versions_no_uk').on(t.scheduleId, t.versionNo),
  scheduleIdx: index('schedule_versions_schedule_idx').on(t.scheduleId, t.effectiveFrom),
  statusIdx: index('schedule_versions_status_idx').on(t.status, t.effectiveFrom),
}));

/**
 * One weekly window.
 *
 * `day_of_week` is ISO-8601: 1 = Monday … 7 = Sunday. Written down here because
 * JavaScript's getDay() is 0 = Sunday and the two get mixed up constantly; the
 * engine converts once, at the boundary, and every row in this table is ISO.
 *
 * `season_id` null means the rule applies ALL YEAR. A season-bound rule applies
 * only inside that season's dates, which is how "Sunday runs 06:00–10:00 in
 * summer and 08:00–11:30 in winter" is stored: two rows, one per season, both
 * on day 7 — not one string with the word 'Summer' in it.
 *
 * A day with no rule at all is CLOSED. An explicit `kind = 'closed'` row exists
 * so an administrator can state a closure rather than leaving a gap that reads
 * as an oversight — the two are indistinguishable to the resolver and very
 * different to a reader of the admin screen.
 */
export const scheduleRules = pgTable('schedule_rules', {
  id: serial('id').primaryKey(),
  versionId: integer('version_id').notNull().references(() => scheduleVersions.id),
  seasonId: integer('season_id').references(() => seasons.id),
  dayOfWeek: integer('day_of_week').notNull(),     // 1 = Monday … 7 = Sunday
  kind: scheduleRuleKind('kind').notNull().default('open'),
  opensAt: text('opens_at'),                       // HH:MM, wall clock
  closesAt: text('closes_at'),                     // HH:MM, wall clock
  /** 'Morning batch', 'Session 2' — what the timetable calls this window. */
  label: text('label'),
  displayOrder: integer('display_order').notNull().default(0),
  notes: text('notes'),
}, (t) => ({
  versionDayIdx: index('schedule_rules_version_day_idx').on(t.versionId, t.dayOfWeek),
  seasonIdx: index('schedule_rules_season_idx').on(t.seasonId),
}));

/**
 * A single date that does not follow the pattern.
 *
 * Attached to the SCHEDULE and not to a version, deliberately. A public holiday
 * on 15 August is a fact about the club's calendar; it should not evaporate
 * because somebody published new opening hours in July. Versions carry the
 * recurring pattern; exceptions carry the calendar.
 *
 * NOT `venue_blackouts`, which stays exactly as it is. That table is an INSTANT
 * range against a ROOM and is what the booking engine subtracts when it looks
 * for free time. This one is a CALENDAR DAY against a SCHEDULE at any level of
 * the federation — a national holiday closing every unit has no venue to point
 * at — and it can EXTEND hours as well as remove them, which a blackout by
 * definition cannot. The resolver reads both.
 */
export const scheduleExceptions = pgTable('schedule_exceptions', {
  id: serial('id').primaryKey(),
  scheduleId: integer('schedule_id').notNull().references(() => schedules.id),
  onDate: date('on_date').notNull(),
  kind: scheduleExceptionKind('kind').notNull(),
  effect: scheduleExceptionEffect('effect').notNull(),
  opensAt: text('opens_at'),                       // HH:MM, null when effect = 'closed'
  closesAt: text('closes_at'),
  /** Never optional. A closure nobody can explain is a closure nobody trusts. */
  reason: text('reason').notNull(),
  /** Provenance — 'grading', 'competition', 'maintenance_order' and its id. */
  sourceKind: text('source_kind'),
  sourceId: integer('source_id'),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  dateIdx: index('schedule_exceptions_date_idx').on(t.scheduleId, t.onDate),
  onDateIdx: index('schedule_exceptions_on_date_idx').on(t.onDate),
}));

// ─── Classes ────────────────────────────────────────────────────────────────

/**
 * A class the federation offers, week after week.
 *
 * `dojo_classes` rather than `classes` because `class` is a reserved word in
 * enough tooling to be worth avoiding, and because these are the classes a club
 * runs — distinct from `live_classes` (a Master Teacher broadcast, which has a
 * channel and a rights position) and from `program_sessions` (a delivery to a
 * client school under a contract). All three are real and none is the others.
 *
 * MODE IS LOAD-BEARING. A class at 'online' takes no room: the CHECK in the
 * migration requires a venue for every other mode and permits its absence only
 * here. That is the "an online class should not consume a physical dojo unless
 * explicitly configured" rule, expressed where it cannot be forgotten — a
 * hybrid class DOES carry a venue, because it genuinely occupies one.
 */
export const dojoClasses = pgTable('dojo_classes', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                    // MMAKF-CLS-2026-000001
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  summary: text('summary'),

  ownerScope: scopeType('owner_scope').notNull(),
  ownerId: integer('owner_id'),
  venueId: integer('venue_id').references(() => venues.id),
  mode: deliveryMode('mode').notNull().default('at_dojo'),

  discipline: text('discipline'),                  // shotokan | self_defence | competition
  style: text('style'),
  level: text('level'),                            // beginner | intermediate | advanced | all
  audience: text('audience'),                      // kids | adults | women | competition | school
  ageMin: integer('age_min'),
  ageMax: integer('age_max'),

  capacity: integer('capacity'),
  defaultCoachPersonId: integer('default_coach_person_id').references(() => persons.id),
  requiresBooking: boolean('requires_booking').notNull().default(true),

  /** Where an online or hybrid class actually meets. */
  onlinePlatform: text('online_platform'),
  onlineUrl: text('online_url'),

  status: classStatus('status').notNull().default('draft'),
  publicVisible: boolean('public_visible').notNull().default(true),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('dojo_classes_code_uk').on(t.code),
  slugUk: uniqueIndex('dojo_classes_slug_uk').on(t.slug),
  ownerIdx: index('dojo_classes_owner_idx').on(t.ownerScope, t.ownerId, t.status),
  venueIdx: index('dojo_classes_venue_idx').on(t.venueId),
}));

/**
 * ONE OCCURRENCE. A real Tuesday, at a real time, that a real person can book.
 *
 * Materialised rather than computed on the fly, for three reasons that are not
 * about performance: a booking needs something to point at, attendance needs
 * something to hang off, and a cancellation needs somewhere to record itself. A
 * purely derived occurrence has nowhere to say "this one is off".
 *
 * `schedule_version_id` is PROVENANCE and is the reason historical timetables
 * survive: every session records which edition of the schedule produced it. So
 * does the local wall-clock it was generated from — `local_date`, `local_start`,
 * `local_end`, `timezone` — frozen at generation. Correct a venue's timezone
 * next year and the instants stay right AND the session can still print what
 * the timetable said on the day.
 */
export const classSessions = pgTable('class_sessions', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                      // MMAKF-SES-2026-000001
  classId: integer('class_id').notNull().references(() => dojoClasses.id),
  scheduleVersionId: integer('schedule_version_id').references(() => scheduleVersions.id),

  venueId: integer('venue_id').references(() => venues.id),
  coachPersonId: integer('coach_person_id').references(() => persons.id),
  mode: deliveryMode('mode').notNull().default('at_dojo'),
  onlineUrl: text('online_url'),

  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  localDate: date('local_date').notNull(),
  localStart: text('local_start').notNull(),       // HH:MM as the timetable said
  localEnd: text('local_end').notNull(),
  timezone: text('timezone').notNull(),

  capacity: integer('capacity'),
  bookedCount: integer('booked_count').notNull().default(0),

  status: sessionStatus('status').notNull().default('scheduled'),
  cancelledReason: text('cancelled_reason'),
  rescheduledToSessionId: integer('rescheduled_to_session_id'),
  notes: text('notes'),

  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
}, (t) => ({
  refUk: uniqueIndex('class_sessions_ref_uk').on(t.ref),
  // Regenerating a timetable must not duplicate an occurrence. This is what
  // makes generation idempotent, and it is enforced by the database rather than
  // by the generator remembering to check.
  occurrenceUk: uniqueIndex('class_sessions_occurrence_uk').on(t.classId, t.startsAt),
  venueIdx: index('class_sessions_venue_idx').on(t.venueId, t.startsAt),
  coachIdx: index('class_sessions_coach_idx').on(t.coachPersonId, t.startsAt),
  windowIdx: index('class_sessions_window_idx').on(t.startsAt, t.endsAt),
  classIdx: index('class_sessions_class_idx').on(t.classId, t.localDate),
}));
