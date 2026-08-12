// Competition management, results and rankings.
//
// The second pillar of a national federation, and the largest single domain.
// A championship is not an event listing: it is entries validated against
// eligibility, a reproducible draw, matches scored by named officials, results
// that lock, and rankings that can be explained.
//
// TWO PRINCIPLES SHAPE EVERYTHING HERE:
//
//  1. RESULTS LOCK. Once finalised, an official result is never edited. A
//     correction creates a new version and records who authorised it. A
//     federation whose past results can be quietly changed has no results.
//
//  2. RANKINGS ARE EXPLAINABLE. Every ranking row stores the ruleset version
//     and the per-event contributions that produced it, so an athlete can be
//     shown exactly why they are ranked where they are. A ranking nobody can
//     audit is a ranking nobody should trust — and it is the thing athletes
//     dispute most.

import {
  pgTable, serial, text, integer, timestamp, date, boolean,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { persons, dojos, stateUnits, districtUnits } from './schema';

// ─── Enums ──────────────────────────────────────────────────────────────────

export const eventKind = pgEnum('event_kind', [
  'national_championship', 'open_national', 'state_championship',
  'district_championship', 'selection_trial', 'seminar', 'camp',
  'grading', 'technical_course', 'referee_course', 'other',
]);

/** Explicit lifecycle. Registration cannot open before sanction. */
export const eventStatus = pgEnum('event_status', [
  'draft', 'technical_review', 'sanction_review', 'approved', 'published',
  'registration_open', 'registration_closed', 'check_in', 'live',
  'results_pending', 'results_final', 'archived', 'cancelled', 'postponed',
]);

/**
 * The statuses at which a competition event is PUBLIC INFORMATION.
 *
 * It lives here, beside the enum it constrains, because it was previously
 * written out in four places — the competition API route, src/lib/search.ts,
 * src/lib/calendar.ts and src/lib/realtime.ts — each with a comment
 * acknowledging the duplication and explaining why it was acceptable. It was
 * not: a visibility rule that exists in four places is a rule that answers
 * differently in four places the day one of them is edited, and the failure
 * mode is an unpublished event reaching the public from whichever copy was
 * missed.
 *
 * Anything not listed here — draft, technical_review, sanction_review,
 * approved — is the federation's internal business until it publishes.
 */
export const PUBLIC_EVENT_STATUSES = [
  'published', 'registration_open', 'registration_closed',
  'check_in', 'live', 'results_pending', 'results_final', 'archived',
] as const satisfies readonly (typeof eventStatus.enumValues)[number][];

/**
 * `as const satisfies` rather than a plain annotation, deliberately. The const
 * keeps the literal types Drizzle needs to match the enum column, and the
 * satisfies clause makes a TYPO a compile error — 'registration_opne' in a
 * plain `readonly string[]` compiles fine and silently removes a status from
 * public view. Neither form alone gives both.
 *
 * The membership test as a predicate, because the two call sites that need it
 * hold a plain `string` from a database row and a literal tuple will not accept
 * one without a cast at each site.
 */
export function isPublicEventStatus(status: string): boolean {
  return (PUBLIC_EVENT_STATUSES as readonly string[]).includes(status);
}

export const disciplineKind = pgEnum('discipline_kind', ['kata', 'kumite', 'team_kata', 'team_kumite']);

export const entryStatus = pgEnum('entry_status', [
  'draft', 'submitted', 'eligibility_check', 'ineligible', 'fee_pending',
  'confirmed', 'checked_in', 'weighed_in', 'withdrawn', 'disqualified', 'no_show',
]);

export const drawFormat = pgEnum('draw_format', [
  'single_elimination', 'single_elimination_repechage', 'round_robin',
  'pool_then_elimination', 'kata_flag', 'kata_scoring', 'team_elimination',
]);

export const matchStatus = pgEnum('match_status', [
  'scheduled', 'called', 'in_progress', 'paused', 'completed',
  'walkover', 'disqualification', 'cancelled', 'under_protest',
]);

export const resultStatus = pgEnum('result_status', ['provisional', 'final', 'corrected', 'voided']);

export const medalKind = pgEnum('medal_kind', ['gold', 'silver', 'bronze', 'participation']);

export const protestStatus = pgEnum('protest_status', [
  'lodged', 'fee_pending', 'under_review', 'upheld', 'dismissed', 'withdrawn',
]);

// ─── Events ─────────────────────────────────────────────────────────────────

export const competitionEvents = pgTable('competition_events', {
  id: serial('id').primaryKey(),
  // Immutable identity. Entries bind to THIS, never to a display title —
  // renaming an event previously orphaned every entry attached to it.
  code: text('code').notNull(),                  // MMAKF-EVT-2026-000001
  title: text('title').notNull(),
  kind: eventKind('kind').notNull(),
  status: eventStatus('status').notNull().default('draft'),

  startsOn: date('starts_on'),
  endsOn: date('ends_on'),
  venue: text('venue'),
  city: text('city'),
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),

  registrationOpensAt: timestamp('registration_opens_at', { withTimezone: true }),
  registrationClosesAt: timestamp('registration_closes_at', { withTimezone: true }),

  // Sanctioning — a championship without it is not a federation event.
  sanctionedByPersonId: integer('sanctioned_by_person_id').references(() => persons.id),
  sanctionedAt: timestamp('sanctioned_at', { withTimezone: true }),
  sanctionReference: text('sanction_reference'),
  rulesetVersion: text('ruleset_version'),

  organiserDojoId: integer('organiser_dojo_id').references(() => dojos.id),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  description: text('description'),

  resultsFinalisedAt: timestamp('results_finalised_at', { withTimezone: true }),
  resultsFinalisedByUserId: integer('results_finalised_by_user_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('competition_events_code_uk').on(t.code),
  statusIdx: index('competition_events_status_idx').on(t.status),
  dateIdx: index('competition_events_date_idx').on(t.startsOn),
}));

/**
 * A category within an event — the thing an athlete actually enters.
 *
 * Age and weight bounds are per-category and per-event rather than global,
 * because they are set by the competition regulations in force for that event.
 */
export const eventCategories = pgTable('event_categories', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => competitionEvents.id),
  code: text('code').notNull(),                  // CAD-M-KUM-61
  label: text('label').notNull(),                // "Cadet Male Kumite -61kg"
  discipline: disciplineKind('discipline').notNull(),

  gender: text('gender'),                        // female | male | mixed
  ageGroup: text('age_group'),                   // as named in the regulations
  minAgeYears: integer('min_age_years'),
  maxAgeYears: integer('max_age_years'),
  // Birth-year bounds, because most karate regulations define age by year of
  // birth on the day of competition rather than by exact age.
  bornOnOrAfter: date('born_on_or_after'),
  bornOnOrBefore: date('born_on_or_before'),

  minWeightGrams: integer('min_weight_grams'),   // grams: integers, never floats
  maxWeightGrams: integer('max_weight_grams'),

  minGradeOrdinal: integer('min_grade_ordinal'),
  minGradeKind: text('min_grade_kind'),
  teamSize: integer('team_size'),

  drawFormat: drawFormat('draw_format'),
  maxEntries: integer('max_entries'),
  entriesPerDojo: integer('entries_per_dojo'),
  feeCode: text('fee_code'),

  displayOrder: integer('display_order').notNull().default(0),
}, (t) => ({
  uniqueCode: uniqueIndex('event_categories_uk').on(t.eventId, t.code),
  eventIdx: index('event_categories_event_idx').on(t.eventId),
}));

// ─── Entries ────────────────────────────────────────────────────────────────

export const eventEntries = pgTable('event_entries', {
  id: serial('id').primaryKey(),
  entryNo: text('entry_no').notNull(),           // MMAKF-ENT-2026-000001
  eventId: integer('event_id').notNull().references(() => competitionEvents.id),
  categoryId: integer('category_id').notNull().references(() => eventCategories.id),
  personId: integer('person_id').references(() => persons.id),

  dojoId: integer('dojo_id').references(() => dojos.id),
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  status: entryStatus('status').notNull().default('draft'),

  // The eligibility decision AND its evidence, frozen at the moment it was
  // made. Rules and memberships change; the record of why an entry was accepted
  // must not.
  eligibilityCheckedAt: timestamp('eligibility_checked_at', { withTimezone: true }),
  eligibilitySnapshot: jsonb('eligibility_snapshot'),
  ineligibleReason: text('ineligible_reason'),

  checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
  weighInGrams: integer('weigh_in_grams'),
  weighInAt: timestamp('weigh_in_at', { withTimezone: true }),
  weighInByPersonId: integer('weigh_in_by_person_id').references(() => persons.id),

  seed: integer('seed'),
  drawPosition: integer('draw_position'),
  orderId: integer('order_id'),                  // entry fee

  withdrawnReason: text('withdrawn_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  entryNoIdx: uniqueIndex('event_entries_no_uk').on(t.entryNo),
  // One entry per person per category — the duplicate-entry guard, at the
  // database rather than in a handler that can be bypassed.
  uniquePerson: uniqueIndex('event_entries_person_uk').on(t.categoryId, t.personId),
  eventIdx: index('event_entries_event_idx').on(t.eventId),
  statusIdx: index('event_entries_status_idx').on(t.status),
}));

/** Members of a team entry. */
export const entryMembers = pgTable('entry_members', {
  id: serial('id').primaryKey(),
  entryId: integer('entry_id').notNull().references(() => eventEntries.id),
  personId: integer('person_id').notNull().references(() => persons.id),
  role: text('role'),                            // competitor | reserve | coach
  position: integer('position'),
}, (t) => ({
  uniqueMember: uniqueIndex('entry_members_uk').on(t.entryId, t.personId),
}));

// ─── Draws ──────────────────────────────────────────────────────────────────

/**
 * A published draw.
 *
 * `seedInput` and `randomSeed` exist so a draw is REPRODUCIBLE: given the same
 * entries and the same seed, the same bracket comes out. A draw nobody can
 * reproduce is a draw nobody can defend when a coach alleges it was rigged.
 */
export const draws = pgTable('draws', {
  id: serial('id').primaryKey(),
  categoryId: integer('category_id').notNull().references(() => eventCategories.id),
  format: drawFormat('format').notNull(),
  roundsCount: integer('rounds_count'),
  entryCount: integer('entry_count').notNull(),

  randomSeed: text('random_seed'),
  seedInput: jsonb('seed_input'),
  algorithmVersion: text('algorithm_version').notNull(),

  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
  generatedByUserId: integer('generated_by_user_id'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedByUserId: integer('published_by_user_id'),
  supersedesDrawId: integer('supersedes_draw_id'),
  regenerationReason: text('regeneration_reason'),
}, (t) => ({
  categoryIdx: index('draws_category_idx').on(t.categoryId),
}));

// ─── Matches ────────────────────────────────────────────────────────────────

export const matches = pgTable('matches', {
  id: serial('id').primaryKey(),
  drawId: integer('draw_id').notNull().references(() => draws.id),
  categoryId: integer('category_id').notNull().references(() => eventCategories.id),
  eventId: integer('event_id').notNull().references(() => competitionEvents.id),

  matchNo: text('match_no').notNull(),
  round: text('round').notNull(),                // R32 | QF | SF | F | pool
  roundOrder: integer('round_order').notNull().default(0),
  poolLabel: text('pool_label'),

  redEntryId: integer('red_entry_id').references(() => eventEntries.id),   // aka
  blueEntryId: integer('blue_entry_id').references(() => eventEntries.id), // ao

  mat: text('mat'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  durationSeconds: integer('duration_seconds'),

  status: matchStatus('status').notNull().default('scheduled'),

  redScore: integer('red_score').notNull().default(0),
  blueScore: integer('blue_score').notNull().default(0),
  redPenalties: jsonb('red_penalties'),
  bluePenalties: jsonb('blue_penalties'),

  winnerEntryId: integer('winner_entry_id').references(() => eventEntries.id),
  winMethod: text('win_method'),                 // points | senshu | hantei | kiken | hansoku
  // Where the winner goes. Set by the draw, so progression is data rather than
  // something a scorer works out by hand.
  advancesToMatchId: integer('advances_to_match_id'),
  advancesToSlot: text('advances_to_slot'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueMatchNo: uniqueIndex('matches_no_uk').on(t.eventId, t.matchNo),
  drawIdx: index('matches_draw_idx').on(t.drawId),
  statusIdx: index('matches_status_idx').on(t.status),
  matIdx: index('matches_mat_idx').on(t.eventId, t.mat, t.scheduledAt),
}));

/**
 * Every scoring action, append-only.
 *
 * The match row carries the running total for speed; THIS is the record of
 * truth. A disputed point is resolved by replaying these, and a correction
 * appends a reversing entry rather than editing history.
 */
export const matchEvents = pgTable('match_events', {
  id: serial('id').primaryKey(),
  matchId: integer('match_id').notNull().references(() => matches.id),
  sequence: integer('sequence').notNull(),
  side: text('side'),                            // red | blue
  action: text('action').notNull(),              // yuko | waza_ari | ippon | penalty | senshu
  points: integer('points').notNull().default(0),
  penaltyCode: text('penalty_code'),
  clockSeconds: integer('clock_seconds'),
  officialPersonId: integer('official_person_id').references(() => persons.id),
  reversesEventId: integer('reverses_event_id'),
  note: text('note'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueSeq: uniqueIndex('match_events_seq_uk').on(t.matchId, t.sequence),
  matchIdx: index('match_events_match_idx').on(t.matchId),
}));

/** Kata scoring — a panel of judges, each score recorded separately. */
export const kataScores = pgTable('kata_scores', {
  id: serial('id').primaryKey(),
  matchId: integer('match_id').references(() => matches.id),
  entryId: integer('entry_id').notNull().references(() => eventEntries.id),
  kataId: integer('kata_id'),
  kataName: text('kata_name'),
  judgePersonId: integer('judge_person_id').references(() => persons.id),
  judgePosition: integer('judge_position'),
  // Scores in hundredths, as integers. Karate kata scores carry one decimal and
  // floats do not sum reliably.
  technicalScore: integer('technical_score'),
  athleticScore: integer('athletic_score'),
  totalScore: integer('total_score'),
  discarded: boolean('discarded').notNull().default(false),  // high/low removal
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  entryIdx: index('kata_scores_entry_idx').on(t.entryId),
}));

// ─── Results ────────────────────────────────────────────────────────────────

/**
 * The official result of a category. Locking is the point of no return.
 *
 * A correction inserts a NEW row superseding this one and records who
 * authorised it. Editing in place would make the federation's history
 * unfalsifiable.
 */
export const competitionResults = pgTable('competition_results', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => competitionEvents.id),
  categoryId: integer('category_id').notNull().references(() => eventCategories.id),
  entryId: integer('entry_id').notNull().references(() => eventEntries.id),
  personId: integer('person_id').references(() => persons.id),

  placing: integer('placing').notNull(),
  medal: medalKind('medal'),
  matchesWon: integer('matches_won').notNull().default(0),
  matchesLost: integer('matches_lost').notNull().default(0),
  pointsFor: integer('points_for').notNull().default(0),
  pointsAgainst: integer('points_against').notNull().default(0),

  status: resultStatus('status').notNull().default('provisional'),
  finalisedAt: timestamp('finalised_at', { withTimezone: true }),
  finalisedByUserId: integer('finalised_by_user_id'),

  supersedesResultId: integer('supersedes_result_id'),
  correctionReason: text('correction_reason'),
  correctionAuthorisedByUserId: integer('correction_authorised_by_user_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  categoryIdx: index('competition_results_category_idx').on(t.categoryId),
  personIdx: index('competition_results_person_idx').on(t.personId),
  eventIdx: index('competition_results_event_idx').on(t.eventId),
}));

export const protests = pgTable('protests', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => competitionEvents.id),
  matchId: integer('match_id').references(() => matches.id),
  categoryId: integer('category_id').references(() => eventCategories.id),
  lodgedByPersonId: integer('lodged_by_person_id').references(() => persons.id),
  onBehalfOfEntryId: integer('on_behalf_of_entry_id').references(() => eventEntries.id),
  grounds: text('grounds').notNull(),
  status: protestStatus('status').notNull().default('lodged'),
  feeOrderId: integer('fee_order_id'),
  decision: text('decision'),
  decidedByPersonId: integer('decided_by_person_id').references(() => persons.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  lodgedAt: timestamp('lodged_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ eventIdx: index('protests_event_idx').on(t.eventId) }));

/** Officials appointed to an event, and what they were licensed to do. */
export const eventOfficials = pgTable('event_officials', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull().references(() => competitionEvents.id),
  personId: integer('person_id').notNull().references(() => persons.id),
  role: text('role').notNull(),                  // referee | judge | tatami_manager | td | medical
  mat: text('mat'),
  // Frozen at appointment: a licence may lapse later, and the record must show
  // the authority held on the day.
  licenceSnapshot: jsonb('licence_snapshot'),
  appointedAt: timestamp('appointed_at', { withTimezone: true }).notNull().defaultNow(),
  evaluation: jsonb('evaluation'),
}, (t) => ({
  uniqueAppointment: uniqueIndex('event_officials_uk').on(t.eventId, t.personId, t.role),
}));

// ─── Rankings ───────────────────────────────────────────────────────────────

/**
 * A versioned ranking ruleset.
 *
 * Points are DATA, never code. Nothing here ships a points table, because how
 * many points a national gold is worth is federation policy. Storing the rules
 * as a version means a past ranking stays computed under the rules that applied
 * when it was published.
 */
export const rankingRulesets = pgTable('ranking_rulesets', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),
  title: text('title').notNull(),
  discipline: disciplineKind('discipline'),
  // { eventKind: { placing: points }, decay, windowMonths, bestNResults, ... }
  rules: jsonb('rules').notNull(),
  windowMonths: integer('window_months'),
  bestNResults: integer('best_n_results'),
  tieBreak: jsonb('tie_break'),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  approvedByPersonId: integer('approved_by_person_id').references(() => persons.id),
  status: text('status').notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ codeIdx: uniqueIndex('ranking_rulesets_code_uk').on(t.code) }));

/** A published ranking table — a snapshot, not a live query. */
export const rankingPeriods = pgTable('ranking_periods', {
  id: serial('id').primaryKey(),
  rulesetId: integer('ruleset_id').notNull().references(() => rankingRulesets.id),
  label: text('label').notNull(),
  categoryKey: text('category_key').notNull(),   // discipline|gender|ageGroup|weight
  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedByUserId: integer('published_by_user_id'),
  eventCount: integer('event_count'),
  athleteCount: integer('athlete_count'),
}, (t) => ({
  uniquePeriod: uniqueIndex('ranking_periods_uk').on(t.rulesetId, t.label, t.categoryKey),
}));

/**
 * One athlete's position in one ranking table.
 *
 * `contributions` is the whole point: it holds every event that fed this total,
 * with its placing and points, so the page can show an athlete exactly why they
 * sit where they do. Without it a ranking is an assertion.
 */
export const rankingEntries = pgTable('ranking_entries', {
  id: serial('id').primaryKey(),
  periodId: integer('period_id').notNull().references(() => rankingPeriods.id),
  personId: integer('person_id').notNull().references(() => persons.id),
  rank: integer('rank').notNull(),
  points: integer('points').notNull(),
  previousRank: integer('previous_rank'),
  contributions: jsonb('contributions').notNull(),
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  dojoId: integer('dojo_id').references(() => dojos.id),
}, (t) => ({
  uniqueEntry: uniqueIndex('ranking_entries_uk').on(t.periodId, t.personId),
  periodIdx: index('ranking_entries_period_idx').on(t.periodId, t.rank),
  personIdx: index('ranking_entries_person_idx').on(t.personId),
}));

// ─── National team ──────────────────────────────────────────────────────────

export const nationalSquads = pgTable('national_squads', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),
  title: text('title').notNull(),
  season: text('season').notNull(),
  discipline: disciplineKind('discipline'),
  ageGroup: text('age_group'),
  selectionCriteria: text('selection_criteria'),
  selectedOn: date('selected_on'),
  status: text('status').notNull().default('draft'),
  headCoachPersonId: integer('head_coach_person_id').references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ codeIdx: uniqueIndex('national_squads_code_uk').on(t.code) }));

/**
 * A squad member and WHY they were selected.
 *
 * `selectionBasis` records the evidence and the deciding body. Selection is a
 * human governance decision — analytics may inform it, and this column is where
 * the reasoning lives so a non-selected athlete can be given an answer.
 */
export const squadMembers = pgTable('squad_members', {
  id: serial('id').primaryKey(),
  squadId: integer('squad_id').notNull().references(() => nationalSquads.id),
  personId: integer('person_id').notNull().references(() => persons.id),
  role: text('role').notNull().default('athlete'),
  category: text('category'),
  selectionBasis: jsonb('selection_basis'),
  decidedByBody: text('decided_by_body'),
  status: text('status').notNull().default('selected'),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueMember: uniqueIndex('squad_members_uk').on(t.squadId, t.personId, t.role),
}));
