// Practice records — what a student says they have done, and what an instructor
// has asked them to do. §43 and §44.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE RULE THIS FILE EXISTS TO MAKE STRUCTURALLY TRUE
// ─────────────────────────────────────────────────────────────────────────────
//
// §44 states it plainly, and it is the sentence the whole design answers to:
//
//     Watching Bassai Dai does NOT make Bassai Dai "completed".
//
// Physical competence is established by the federation's examination process —
// a grading, with a panel, under a syllabus version, recorded in
// technical.schema.ts and evidenced by a certificate. Nothing in THIS file is
// evidence of anything except that somebody pressed a button about themselves.
//
// A comment saying so would not survive contact with a future feature request.
// So the separation is built into the schema instead:
//
//   1. NOTHING HERE REFERENCES THE GRADING ENGINE. No foreign key to
//      grading_events, grading_candidates, grade_definitions, certificates or
//      any rank record — in either direction. tests/practice.test.ts asserts
//      that by reading information_schema rather than by reading this comment,
//      because the day somebody adds `grading_candidate_id` "just to link them"
//      is the day a self-reported tick becomes examination evidence.
//
//   2. THERE IS NO COMPLETION STATE. The vocabulary is deliberately
//      progressive and never terminal: `watched`, `practising`, `needs_work`,
//      `bookmarked`. There is no `completed`, no `mastered`, no `passed`, and no
//      percentage. A student cannot mark themselves finished with a kata,
//      because finishing a kata is not a thing a student decides.
//
//   3. EVERY MARK IS LABELLED AS A SELF-REPORT AT THE ROW LEVEL.
//      `self_reported` is NOT NULL DEFAULT true and there is no code path that
//      writes false. It exists so that a query joining these rows to anything
//      official has to look at it, and so an export of this table cannot be
//      mistaken for an attainment record by whoever opens the spreadsheet.
//
// An ASSIGNMENT is not attainment either. An instructor asking a student to work
// on mae-geri records that the instruction was given; it records nothing about
// how the student did, because that judgement belongs on the dojo floor and, if
// it is to count for anything, in a grading.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A SUBJECT IS, AND WHY IT IS NOT A FOREIGN KEY
// ─────────────────────────────────────────────────────────────────────────────
//
// A student bookmarks a TECHNIQUE, a KATA, a KUMITE concept or a VIDEO. The
// first three live in static source (src/data/shotokan, src/data/kata) because
// they are public martial-arts knowledge that must render with no database at
// all; only the fourth is a table. A foreign key can therefore only be written
// for one of the four, and writing it for one and not the others would make the
// most and least important subjects behave differently.
//
// So the subject is (kind, slug) — a polymorphic reference, with the honest cost
// that the database cannot enforce the slug exists. That cost is paid back by
// tests/practice.test.ts, which resolves every stored slug against the library
// and fails on an orphan, and by markPractice() refusing an unknown subject on
// the way in. The alternative — four nullable columns and a CHECK — buys
// referential integrity for one column out of four and complicates every read.

import {
  pgTable, serial, text, integer, timestamp, boolean,
  uniqueIndex, index, pgEnum,
} from 'drizzle-orm/pg-core';
import { persons } from './schema';

// ─── Enums ──────────────────────────────────────────────────────────────────

/**
 * What a student may say about their own practice.
 *
 * DELIBERATELY WITHOUT A TERMINAL STATE. See rule 2 in the header: there is no
 * `completed` because completion is not a student's call, and there is no
 * `mastered` because that is what a grading is for.
 *
 * `needs_work` is the one that earns its place. A library where the only
 * self-report is positive collects nothing a student would act on later, and an
 * honest "I cannot do this yet" is the most useful thing on the list — both to
 * the student revisiting it and to an instructor who is shown it.
 */
export const practiceMark = pgEnum('practice_mark', [
  'watched',
  'practising',
  'needs_work',
  'bookmarked',
]);

/**
 * What a mark or an assignment can be about.
 *
 * `drill` is present because §43 names it as assignable. Drills live inside a
 * technique or kumite record rather than as their own entity, so the slug is
 * the parent's and the detail goes in the note.
 */
export const practiceSubject = pgEnum('practice_subject', [
  'technique',
  'kata',
  'kumite',
  'video',
  'drill',
]);

export const assignmentState = pgEnum('assignment_state', [
  'assigned',
  'acknowledged',
  'withdrawn',
]);


// ─── Self-reported practice ─────────────────────────────────────────────────

/**
 * One person's own note about one thing they are working on.
 *
 * UNIQUE ON (person, kind, slug): a student has ONE current relationship with a
 * technique, not a log of every time they opened the page. Re-marking updates
 * the row and moves `markedAt`. A history table would be a different feature
 * with a different privacy question attached, and this is not it.
 */
export const practiceMarks = pgTable('practice_marks', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),

  subjectKind: practiceSubject('subject_kind').notNull(),
  /** Slug into the static library, or a media asset id rendered as text. */
  subjectSlug: text('subject_slug').notNull(),

  mark: practiceMark('mark').notNull(),
  /** The student's own words. Nobody else's, and never required. */
  note: text('note'),

  /**
   * ALWAYS TRUE. See rule 3 in the header — it exists to be read by anything
   * that might otherwise mistake this table for an attainment record, and there
   * is no code path that sets it false.
   */
  selfReported: boolean('self_reported').notNull().default(true),

  markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  onePerSubject: uniqueIndex('practice_marks_uk').on(t.personId, t.subjectKind, t.subjectSlug),
  personIdx: index('practice_marks_person_idx').on(t.personId, t.markedAt),
  // For "who has flagged this technique as difficult" — an instructor's view of
  // a cohort, which is the only legitimate cross-person read of this table.
  subjectIdx: index('practice_marks_subject_idx').on(t.subjectKind, t.subjectSlug, t.mark),
}));

// ─── Instructor assignments ─────────────────────────────────────────────────

/**
 * An instructor asking a student to work on something.
 *
 * RECORDS THAT THE INSTRUCTION WAS GIVEN, AND NOTHING ABOUT THE OUTCOME. There
 * is no `completed_at`, no score and no sign-off column, because an instructor
 * confirming that a student can now do something is an assessment — and this
 * platform has exactly one place assessments are recorded, which is the grading
 * engine, with a panel and a syllabus version behind it.
 *
 * `acknowledged` is the furthest state a student can move it to: they have seen
 * it. That is a fact about a notification, not about karate.
 */
export const practiceAssignments = pgTable('practice_assignments', {
  id: serial('id').primaryKey(),

  personId: integer('person_id').notNull().references(() => persons.id),
  assignedByPersonId: integer('assigned_by_person_id').notNull().references(() => persons.id),

  subjectKind: practiceSubject('subject_kind').notNull(),
  subjectSlug: text('subject_slug').notNull(),

  /** What the instructor actually wants worked on. The point of the record. */
  instruction: text('instruction').notNull(),
  dueOn: timestamp('due_on', { withTimezone: true }),

  state: assignmentState('state').notNull().default('assigned'),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  /** Withdrawing needs a reason, for the same reason every refusal here does. */
  withdrawnReason: text('withdrawn_reason'),

  assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  personIdx: index('practice_assignments_person_idx').on(t.personId, t.state),
  assignerIdx: index('practice_assignments_assigner_idx').on(t.assignedByPersonId),
}));
