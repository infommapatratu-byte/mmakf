// Competition events, categories and entries — the gate a championship stands on.
//
//   EVENT → TECHNICAL REVIEW → SANCTION → PUBLICATION → REGISTRATION →
//   ENTRY (eligibility decided and evidenced) → CHECK-IN → WEIGH-IN → COMPETITION
//
// Two things make this module worth having.
//
// FIRST, THE LIFECYCLE IS A STATE MACHINE, NOT A COLUMN. `eventStatus` has
// fourteen values; a free-text update would let a draft become live, or
// registration open on an event nobody ever sanctioned. Every legal transition is
// enumerated below and everything else is refused. A championship that was never
// sanctioned is not a federation event, and this is where that is enforced.
//
// SECOND, AN ENTRY CARRIES ITS OWN JUSTIFICATION. `enterEvent` stores the
// eligibility decision AND the evidence behind it, exactly as grading.ts does,
// so a refusal can be explained months later from the record rather than
// re-derived from regulations that have since changed.
//
// WHAT THIS MODULE DOES NOT DO: it does not know a single MMAKF competition
// rule. Age bounds, weight bounds, minimum grades, entry quotas and fees are
// CONFIGURATION carried on the category row. An unset bound is not checked, and
// the stored result says it was not set — never that the athlete cleared a
// threshold nobody approved.

import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import * as s from './schema';
import { PUBLIC_EVENT_STATUSES } from './competition.schema';
import { allocateFederationId, resolvePlacement, writeAudit, type AuditContext } from './federation';
import {
  assertCan, assertCanAnywhere, can, canAnywhere, visibleScopes,
  ForbiddenError, type Action, type Principal, type Resource,
} from '@/lib/rbac';
import { isUniqueViolation } from './pgerror';

type DB = any; // drizzle client (postgres.js in prod, PGlite in tests)

export class CompetitionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CompetitionError';
    this.code = code;
  }
}

export type EventStatus = (typeof s.eventStatus.enumValues)[number];
export type EntryStatus = (typeof s.entryStatus.enumValues)[number];
export type Discipline = (typeof s.disciplineKind.enumValues)[number];

const TEAM_DISCIPLINES: readonly Discipline[] = ['team_kata', 'team_kumite'];

// ─── The lifecycle ──────────────────────────────────────────────────────────

/**
 * Every legal move, exhaustively. Anything not listed here is refused.
 *
 * Read it as the federation's calendar policy in one place: an event is
 * technically reviewed, then sanctioned, then published, and only then may
 * registration open. Cancellation is reachable from anywhere before results
 * exist and from nowhere after — cancelling a championship that already produced
 * medals would falsify them.
 *
 * Exported because a state machine nobody can inspect is a state machine nobody
 * can trust: an admin screen renders the legal moves from this map rather than
 * keeping its own copy that can drift out of step.
 */
export const LEGAL_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  draft: ['technical_review', 'cancelled'],
  technical_review: ['draft', 'sanction_review', 'cancelled'],
  // → approved is deliberately ABSENT: approval is what sanctionEvent() does,
  //   and it needs a sanctioning authority and a reference.
  sanction_review: ['technical_review', 'cancelled'],
  approved: ['published', 'postponed', 'cancelled'],
  published: ['registration_open', 'postponed', 'cancelled'],
  registration_open: ['registration_closed', 'postponed', 'cancelled'],
  registration_closed: ['registration_open', 'check_in', 'postponed', 'cancelled'],
  check_in: ['live', 'cancelled'],
  live: ['results_pending', 'cancelled'],
  results_pending: ['results_final'],
  results_final: ['archived'],
  archived: [],
  cancelled: [],
  // A postponed event has ALREADY been sanctioned — it keeps its authority and
  // its reference — so it resumes by being published again on the new date.
  // `approved` must not appear here (or anywhere in this map): transitionEvent
  // refuses that target unconditionally, and an admin screen rendering this map
  // as "the legal moves" would otherwise offer a button that always throws.
  // The map is the contract; it must not promise a move the module refuses.
  postponed: ['published', 'cancelled'],
};

// Statuses at which an event is public information. A FIFTH copy of this list
// lived here under a DIFFERENT NAME, which is why the duplication survived so
// long — nobody greps for a rule they believe is called something else. There
// is now one definition, in the schema beside the enum it constrains.
const PUBLIC_STATUSES: readonly EventStatus[] = PUBLIC_EVENT_STATUSES as readonly EventStatus[];

/** Once here, the entry list is history and must not be rewritten. */
const RESULTS_LOCKED_STATUSES: readonly EventStatus[] = ['results_final', 'archived'];

function eventPlacement(event: any): Resource {
  return {
    stateUnitId: event.stateUnitId,
    districtUnitId: event.districtUnitId,
    dojoId: event.organiserDojoId,
  };
}

async function loadEvent(db: DB, eventId: number) {
  const row = (await db.select().from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, eventId)).limit(1))[0];
  if (!row) throw new CompetitionError('unknown_event', 'Unknown competition event');
  return row;
}

async function loadCategory(db: DB, categoryId: number) {
  const row = (await db.select().from(s.eventCategories)
    .where(eq(s.eventCategories.id, categoryId)).limit(1))[0];
  if (!row) throw new CompetitionError('unknown_category', 'Unknown event category');
  return row;
}

/**
 * May this principal read this event?
 *
 * Scope normally decides. The exception is a NATIONAL event, which carries no
 * state or district placement and would therefore be invisible to every scoped
 * administrator — including the state admin who has to enter athletes for it.
 * Once published, an event is public information, so any principal holding
 * `competition:read` somewhere may see it. An unpublished national event stays
 * national-only: open on the published, closed on the drafts.
 */
function assertEventReadable(principal: Principal, event: any): void {
  if (can(principal, 'competition:read', eventPlacement(event))) return;
  if (event.stateUnitId == null && event.districtUnitId == null
      && PUBLIC_STATUSES.includes(event.status)
      && canAnywhere(principal, 'competition:read')) return;
  throw new ForbiddenError('competition:read');
}

// ─── Events ─────────────────────────────────────────────────────────────────

export interface NewEvent {
  title: string;
  kind: (typeof s.eventKind.enumValues)[number];
  startsOn?: string | null;
  endsOn?: string | null;
  venue?: string | null;
  city?: string | null;
  stateUnitId?: number | null;
  districtUnitId?: number | null;
  organiserDojoId?: number | null;
  registrationOpensAt?: Date | null;
  registrationClosesAt?: Date | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  description?: string | null;
  rulesetVersion?: string | null;
}

/**
 * Create an event. It always starts in `draft`.
 *
 * The status is NOT taken from the caller. Accepting one would let a client post
 * an event straight into `registration_open` and skip sanction entirely — the
 * exact failure the state machine exists to prevent.
 */
export async function createEvent(db: DB, ctx: AuditContext, input: NewEvent) {
  // Resolve the placement BEFORE authorising, so the scope check is made against
  // a hierarchy that actually exists rather than one the caller asserted.
  const placement = await resolvePlacement(db, {
    stateUnitId: input.stateUnitId,
    districtUnitId: input.districtUnitId,
    dojoId: input.organiserDojoId,
  });
  assertCan(ctx.principal, 'competition:write', placement);

  if (!input.title?.trim()) {
    throw new CompetitionError('title_required', 'An event needs a title.');
  }
  if (input.startsOn && input.endsOn && input.endsOn < input.startsOn) {
    throw new CompetitionError(
      'dates_inverted',
      `An event cannot end (${input.endsOn}) before it starts (${input.startsOn}).`
    );
  }
  if (input.registrationOpensAt && input.registrationClosesAt
      && input.registrationClosesAt.getTime() < input.registrationOpensAt.getTime()) {
    throw new CompetitionError(
      'registration_window_inverted',
      'Registration cannot close before it opens.'
    );
  }

  const code = await allocateFederationId(db, 'EVT');
  const [row] = await db.insert(s.competitionEvents).values({
    code,
    title: input.title.trim(),
    kind: input.kind,
    status: 'draft',
    startsOn: input.startsOn ?? null,
    endsOn: input.endsOn ?? null,
    venue: input.venue ?? null,
    city: input.city ?? null,
    stateUnitId: placement.stateUnitId,
    districtUnitId: placement.districtUnitId,
    organiserDojoId: placement.dojoId,
    registrationOpensAt: input.registrationOpensAt ?? null,
    registrationClosesAt: input.registrationClosesAt ?? null,
    contactEmail: input.contactEmail ?? null,
    contactPhone: input.contactPhone ?? null,
    description: input.description ?? null,
    rulesetVersion: input.rulesetVersion ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'competition_event',
    entityId: row.id,
    action: 'create',
    newValue: { code, title: row.title, kind: row.kind, status: 'draft' },
  });
  return row;
}

/**
 * Move an event to another status, or refuse.
 *
 * A reason is mandatory on EVERY move. A calendar that shows a national
 * championship was cancelled but not why is worthless to the clubs that had
 * already booked travel, and the audit row is the only place that answer
 * survives.
 */
export async function transitionEvent(
  db: DB,
  ctx: AuditContext,
  input: { eventId: number; to: EventStatus; reason: string },
  now: Date = new Date()
) {
  const event = await loadEvent(db, input.eventId);
  assertCan(ctx.principal, 'competition:write', eventPlacement(event));

  if (!input.reason?.trim()) {
    throw new CompetitionError('reason_required', 'Every status change must record why it was made.');
  }
  const from: EventStatus = event.status;
  if (input.to === from) {
    throw new CompetitionError('no_change', `This event is already ${from.replace(/_/g, ' ')}.`);
  }
  if (input.to === 'approved') {
    // The one transition that cannot be made by status alone: approval IS the
    // sanction, and a sanction without an authority and a reference is a claim
    // rather than a record.
    throw new CompetitionError(
      'requires_sanction',
      'An event becomes approved only through sanctionEvent(), which records the sanctioning authority and reference.'
    );
  }
  const legal = LEGAL_TRANSITIONS[from] ?? [];
  if (!legal.includes(input.to)) {
    throw new CompetitionError(
      'illegal_transition',
      legal.length === 0
        ? `An event that is ${from.replace(/_/g, ' ')} is final and cannot change status.`
        : `An event cannot go from ${from.replace(/_/g, ' ')} to ${input.to.replace(/_/g, ' ')}. Legal next steps: ${legal.join(', ')}.`
    );
  }

  // Guards the map alone cannot express. Each fails closed.
  if (input.to === 'registration_open') {
    if (!event.sanctionedAt) {
      throw new CompetitionError(
        'not_sanctioned',
        'Registration cannot open on an event that has not been sanctioned.'
      );
    }
    const counted = await db.select({ n: sql<number>`count(*)::int` })
      .from(s.eventCategories).where(eq(s.eventCategories.eventId, event.id));
    if (Number(counted[0]?.n ?? 0) === 0) {
      throw new CompetitionError(
        'no_categories',
        'Registration cannot open on an event with no categories to enter.'
      );
    }
  }

  const patch: Record<string, unknown> = { status: input.to, updatedAt: now };
  if (input.to === 'results_final') {
    // The point of no return for this event's entry list.
    patch.resultsFinalisedAt = now;
    patch.resultsFinalisedByUserId = ctx.principal.userId ?? null;
  }

  const [row] = await db.update(s.competitionEvents).set(patch)
    .where(eq(s.competitionEvents.id, event.id)).returning();

  await writeAudit(db, { ...ctx, reason: input.reason.trim() }, {
    entityType: 'competition_event',
    entityId: event.id,
    action: input.to === 'results_final' ? 'finalize' : input.to === 'cancelled' ? 'reject' : 'update',
    oldValue: { status: from },
    newValue: { status: input.to, at: now.toISOString(), by: ctx.principal.label },
  });
  return row;
}

/**
 * Sanction an event: who authorised it, and under what reference.
 *
 * This is the transition `transitionEvent` refuses to make, because it is the
 * one that carries authority. Re-sanctioning is refused rather than allowed to
 * overwrite — a second reference silently replacing the first would erase the
 * record of who actually approved the championship.
 */
export async function sanctionEvent(
  db: DB,
  ctx: AuditContext,
  input: {
    eventId: number;
    sanctionedByPersonId: number;
    sanctionReference: string;
    rulesetVersion?: string | null;
    reason?: string | null;
  },
  now: Date = new Date()
) {
  const event = await loadEvent(db, input.eventId);
  assertCan(ctx.principal, 'competition:sanction', eventPlacement(event));

  if (!input.sanctionReference?.trim()) {
    throw new CompetitionError(
      'sanction_reference_required',
      'A sanction must record the federation reference it was issued under.'
    );
  }
  if (event.sanctionedAt) {
    throw new CompetitionError(
      'already_sanctioned',
      `This event was already sanctioned under ${event.sanctionReference ?? 'an unrecorded reference'}.`
    );
  }
  if (event.status !== 'sanction_review') {
    throw new CompetitionError(
      'not_in_sanction_review',
      `Only an event in sanction review can be sanctioned; this one is ${event.status.replace(/_/g, ' ')}.`
    );
  }

  const person = (await db.select().from(s.persons)
    .where(eq(s.persons.id, input.sanctionedByPersonId)).limit(1))[0];
  if (!person) {
    throw new CompetitionError('unknown_person', 'The sanctioning person is not on the federation register.');
  }

  const [row] = await db.update(s.competitionEvents).set({
    status: 'approved',
    sanctionedByPersonId: input.sanctionedByPersonId,
    sanctionedAt: now,
    sanctionReference: input.sanctionReference.trim(),
    rulesetVersion: input.rulesetVersion ?? event.rulesetVersion ?? null,
    updatedAt: now,
  }).where(eq(s.competitionEvents.id, event.id)).returning();

  await writeAudit(
    db,
    { ...ctx, reason: input.reason ?? null, authority: input.sanctionReference.trim() },
    {
      entityType: 'competition_event',
      entityId: event.id,
      action: 'approve',
      oldValue: { status: event.status, sanctionedAt: null },
      newValue: {
        status: 'approved',
        sanctionedByPersonId: input.sanctionedByPersonId,
        sanctionReference: input.sanctionReference.trim(),
        sanctionedAt: now.toISOString(),
      },
    }
  );
  return row;
}

// ─── Categories ─────────────────────────────────────────────────────────────

export interface NewCategory {
  eventId: number;
  code: string;
  label: string;
  discipline: Discipline;
  gender?: string | null;
  ageGroup?: string | null;
  minAgeYears?: number | null;
  maxAgeYears?: number | null;
  bornOnOrAfter?: string | null;
  bornOnOrBefore?: string | null;
  minWeightGrams?: number | null;
  maxWeightGrams?: number | null;
  minGradeOrdinal?: number | null;
  minGradeKind?: 'kyu' | 'dan' | null;
  teamSize?: number | null;
  drawFormat?: (typeof s.drawFormat.enumValues)[number] | null;
  maxEntries?: number | null;
  entriesPerDojo?: number | null;
  feeCode?: string | null;
  displayOrder?: number;
}

/** Categories may still be added while the event is being built and advertised. */
const CATEGORY_EDITABLE_STATUSES: readonly EventStatus[] = [
  'draft', 'technical_review', 'sanction_review', 'approved', 'published', 'registration_open',
];

/**
 * The one reserved category-gender label.
 *
 * There is deliberately NO list of permitted genders here. Which gender labels
 * exist, and how they are spelled, is the federation's — `persons.gender` is
 * free text filled in by MMAKF's own registration process, so a module that
 * enumerated `female | male | mixed` would be refusing the federation
 * permission to configure the categories it actually runs. A category gender is
 * therefore stored as given (case-folded) and compared literally against the
 * competitor's recorded gender, which is reportable either way.
 *
 * `mixed` is reserved only because it is the absence of a restriction rather
 * than a value any competitor is recorded as, and the eligibility check says so
 * in as many words.
 */
const OPEN_GENDER = 'mixed';

/** 1 → 1st, 2 → 2nd, 3 → 3rd, 11 → 11th. The naive `${n}th` produced "3th kyu". */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

function assertWholeNumber(value: number | null | undefined, field: string, min = 0): void {
  if (value == null) return;
  if (!Number.isInteger(value)) {
    // Weight is grams and age is years — both integers. A float here is either a
    // kilogram figure that was never converted or a rounding error waiting to
    // decide a medal.
    throw new CompetitionError('not_an_integer', `${field} must be a whole number; received ${value}.`);
  }
  if (value < min) {
    throw new CompetitionError('out_of_range', `${field} must be at least ${min}; received ${value}.`);
  }
}

/**
 * Add a category to an event.
 *
 * Every bound here is OPTIONAL, because every bound is MMAKF's to set. What this
 * function guarantees is only that a bound the federation DID set is coherent: a
 * maximum below its minimum is not a strict category, it is a category nobody
 * can ever enter, and it would otherwise be discovered on the morning of the
 * championship.
 */
export async function addCategory(db: DB, ctx: AuditContext, input: NewCategory) {
  const event = await loadEvent(db, input.eventId);
  assertCan(ctx.principal, 'competition:write', eventPlacement(event));

  if (!CATEGORY_EDITABLE_STATUSES.includes(event.status)) {
    throw new CompetitionError(
      'event_not_editable',
      `Categories cannot be added to an event that is ${event.status.replace(/_/g, ' ')}.`
    );
  }
  if (!input.code?.trim() || !input.label?.trim()) {
    throw new CompetitionError('code_and_label_required', 'A category needs both a code and a label.');
  }

  assertWholeNumber(input.minAgeYears, 'Minimum age');
  assertWholeNumber(input.maxAgeYears, 'Maximum age');
  assertWholeNumber(input.minWeightGrams, 'Minimum weight (grams)');
  assertWholeNumber(input.maxWeightGrams, 'Maximum weight (grams)');
  assertWholeNumber(input.maxEntries, 'Maximum entries', 1);
  assertWholeNumber(input.entriesPerDojo, 'Entries per dojo', 1);
  assertWholeNumber(input.teamSize, 'Team size', 1);
  assertWholeNumber(input.minGradeOrdinal, 'Minimum grade ordinal', 1);

  if (input.minAgeYears != null && input.maxAgeYears != null && input.minAgeYears > input.maxAgeYears) {
    throw new CompetitionError(
      'age_bounds_inverted',
      `Minimum age ${input.minAgeYears} is above maximum age ${input.maxAgeYears}; no athlete could enter.`
    );
  }
  if (input.bornOnOrAfter && input.bornOnOrBefore && input.bornOnOrAfter > input.bornOnOrBefore) {
    throw new CompetitionError(
      'birth_window_inverted',
      `Born-on-or-after ${input.bornOnOrAfter} is later than born-on-or-before ${input.bornOnOrBefore}; no athlete could enter.`
    );
  }
  if (input.minWeightGrams != null && input.maxWeightGrams != null
      && input.minWeightGrams > input.maxWeightGrams) {
    throw new CompetitionError(
      'weight_bounds_inverted',
      `Minimum weight ${input.minWeightGrams}g is above maximum weight ${input.maxWeightGrams}g; no athlete could enter.`
    );
  }

  const isTeam = TEAM_DISCIPLINES.includes(input.discipline);
  if (isTeam && (input.teamSize == null || input.teamSize < 2)) {
    throw new CompetitionError(
      'team_size_required',
      'A team category must state how many competitors make up a team.'
    );
  }
  if (!isTeam && input.teamSize != null) {
    throw new CompetitionError(
      'team_size_not_applicable',
      'An individual category cannot carry a team size.'
    );
  }

  // A gender restriction is stored exactly as the federation configured it. The
  // only refusal is a blank one, which is neither a restriction nor an absence
  // and would sit in the record meaning nothing.
  if (input.gender != null && !input.gender.trim()) {
    throw new CompetitionError(
      'blank_gender',
      'A category gender must either be set to a label the federation uses, or left unset for no restriction.'
    );
  }
  // A grade bound with no kind cannot be applied — kyu ordinals descend and dan
  // ordinals ascend, so "ordinal 5" means nothing on its own.
  if ((input.minGradeOrdinal == null) !== (input.minGradeKind == null)) {
    throw new CompetitionError(
      'grade_bound_incomplete',
      'A minimum grade needs both an ordinal and a kind (kyu or dan).'
    );
  }
  if (input.minGradeKind && !['kyu', 'dan'].includes(input.minGradeKind)) {
    throw new CompetitionError('unknown_grade_kind', 'Minimum grade kind must be kyu or dan.');
  }

  let row;
  try {
    [row] = await db.insert(s.eventCategories).values({
      eventId: input.eventId,
      code: input.code.trim(),
      label: input.label.trim(),
      discipline: input.discipline,
      gender: input.gender ? input.gender.trim().toLowerCase() : null,
      ageGroup: input.ageGroup ?? null,
      minAgeYears: input.minAgeYears ?? null,
      maxAgeYears: input.maxAgeYears ?? null,
      bornOnOrAfter: input.bornOnOrAfter ?? null,
      bornOnOrBefore: input.bornOnOrBefore ?? null,
      minWeightGrams: input.minWeightGrams ?? null,
      maxWeightGrams: input.maxWeightGrams ?? null,
      minGradeOrdinal: input.minGradeOrdinal ?? null,
      minGradeKind: input.minGradeKind ?? null,
      teamSize: input.teamSize ?? null,
      drawFormat: input.drawFormat ?? null,
      maxEntries: input.maxEntries ?? null,
      entriesPerDojo: input.entriesPerDojo ?? null,
      feeCode: input.feeCode ?? null,
      displayOrder: input.displayOrder ?? 0,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CompetitionError(
        'duplicate_category',
        `This event already has a category with the code ${input.code.trim()}.`
      );
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'event_category',
    entityId: row.id,
    action: 'create',
    newValue: { eventId: input.eventId, code: row.code, label: row.label, discipline: row.discipline },
  });
  return row;
}

// ─── Eligibility ────────────────────────────────────────────────────────────

export interface EligibilityCheck {
  rule: string;
  passed: boolean;
  detail: string;
}

export interface EligibilityResult {
  eligible: boolean;
  /** Every rule considered, whether it passed, and the value it saw. */
  checks: EligibilityCheck[];
  reasons: string[];
  checkedAt: string;
  /** The date age and membership cover were tested against (YYYY-MM-DD). */
  asOf: string;
  /** Where that date came from — the event's first day, or failing that, today. */
  asOfBasis: 'competition_start' | 'entry_date';
  /** Present for team entries: the same decision, per member. */
  members?: Array<{ personId: number; eligible: boolean; checks: EligibilityCheck[]; reasons: string[] }>;
}

function ageOn(dob: string, on: Date): number {
  const born = new Date(`${dob}T00:00:00Z`);
  let age = on.getUTCFullYear() - born.getUTCFullYear();
  const m = on.getUTCMonth() - born.getUTCMonth();
  if (m < 0 || (m === 0 && on.getUTCDate() < born.getUTCDate())) age--;
  return age;
}

/**
 * Decide whether one person may enter one category.
 *
 * Every rule comes from the CATEGORY, which MMAKF configures per event. Nothing
 * here invents an age band, a weight class or a minimum grade: an unset bound is
 * reported as unset and passes, because failing an athlete against a threshold
 * nobody approved is a worse error than admitting one the regulations never
 * excluded.
 *
 * The whole check list is returned and stored, so a refusal can be explained
 * from the record instead of re-derived from a category that may since have been
 * edited.
 *
 * AUTHORISED AGAINST THE COMPETITOR, not the event. The answer is a reading of
 * one person's record — their grade, their membership standing, their age band,
 * whether they are suspended — so an endpoint that exposed it ungated would let
 * anyone enumerate person ids and learn all of it. You may ask this question
 * about a competitor you administer.
 */
export async function checkEntryEligibility(
  db: DB,
  principal: Principal,
  personId: number,
  categoryId: number,
  on: Date = new Date()
): Promise<EligibilityResult> {
  const checks: EligibilityCheck[] = [];
  const reasons: string[] = [];

  const person = (await db.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1))[0];
  if (!person) throw new CompetitionError('unknown_person', 'Unknown person');
  assertCan(principal, 'competition:read', {
    stateUnitId: person.stateUnitId, districtUnitId: person.districtUnitId, dojoId: person.dojoId,
  });
  const category = await loadCategory(db, categoryId);
  const event = await loadEvent(db, category.eventId);

  // WHICH DAY IS THE QUESTION ASKED ABOUT?
  //
  // Age bands and membership cover are questions about the DAY OF COMPETITION,
  // not the day an entry happens to be keyed in. Entries commonly open months
  // ahead: testing them against "today" admits a competitor whose membership
  // lapses before the championship, refuses one who is a year young in March
  // but inside the band in September, and produces a stored record that
  // contradicts the rule it claims to have applied.
  //
  // Where the event states no start date the check falls back to the entry
  // date, and `asOfBasis` says so — an assumption the federation can see is an
  // assumption it can correct.
  const asOf: string = event.startsOn ?? on.toISOString().slice(0, 10);
  const asOfBasis: 'competition_start' | 'entry_date' = event.startsOn ? 'competition_start' : 'entry_date';
  const asOfLabel = asOfBasis === 'competition_start'
    ? `${asOf} (first day of competition)`
    : `${asOf} (date of entry; this event states no start date)`;

  // 1. The person's own record must be in good standing.
  const personActive = person.status === 'active';
  checks.push({ rule: 'person_active', passed: personActive, detail: `person status ${person.status}` });
  if (!personActive) reasons.push('The membership record is not active.');

  // 2. A current membership covering the day of competition. Insurance and
  //    safeguarding hang off this; a lapsed membership is not a technicality.
  const memberships = await db.select().from(s.memberships).where(and(
    eq(s.memberships.personId, personId),
    eq(s.memberships.status, 'active')
  ));
  const covering = memberships.filter((m: any) =>
    m.validFrom <= asOf && (!m.validTo || m.validTo >= asOf));
  const membershipOk = covering.length > 0;
  checks.push({
    rule: 'membership_active',
    passed: membershipOk,
    detail: membershipOk
      ? `${covering.length} active membership(s) covering ${asOfLabel}`
      : memberships.length
        ? `${memberships.length} active membership(s) on record, none covering ${asOfLabel}`
        : `no active membership on record covering ${asOfLabel}`,
  });
  if (!membershipOk) reasons.push(`No active federation membership covering ${asOfLabel}.`);

  // 3. Birth-date window. Karate regulations define age by year of birth on the
  //    day of competition rather than by exact age — which is why the category
  //    carries dates and not only a number.
  if (category.bornOnOrAfter == null && category.bornOnOrBefore == null) {
    checks.push({
      rule: 'age_birth_window',
      passed: true,
      detail: 'no birth-date window set for this category',
    });
  } else if (!person.dob) {
    checks.push({
      rule: 'age_birth_window',
      passed: false,
      detail: 'no date of birth on record, so the birth-date window cannot be checked',
    });
    reasons.push('A date of birth is required to check this category’s birth-date window.');
  } else {
    const afterOk = category.bornOnOrAfter == null || person.dob >= category.bornOnOrAfter;
    const beforeOk = category.bornOnOrBefore == null || person.dob <= category.bornOnOrBefore;
    const passed = afterOk && beforeOk;
    checks.push({
      rule: 'age_birth_window',
      passed,
      detail: `born ${person.dob}; window ${category.bornOnOrAfter ?? 'unset'} .. ${category.bornOnOrBefore ?? 'unset'}`,
    });
    if (!passed) {
      reasons.push(
        `This category is for competitors born ${category.bornOnOrAfter ?? 'any time'} to ${category.bornOnOrBefore ?? 'any time'}; this competitor was born ${person.dob}.`
      );
    }
  }

  // 4. Exact-age bounds, when the category states them instead of, or as well
  //    as, the birth-date window.
  if (category.minAgeYears == null && category.maxAgeYears == null) {
    checks.push({ rule: 'age_years', passed: true, detail: 'no age bound set for this category' });
  } else if (!person.dob) {
    checks.push({
      rule: 'age_years',
      passed: false,
      detail: 'no date of birth on record, so the age bound cannot be checked',
    });
    reasons.push('A date of birth is required to check this category’s age bounds.');
  } else {
    const age = ageOn(person.dob, new Date(`${asOf}T00:00:00Z`));
    const passed = (category.minAgeYears == null || age >= category.minAgeYears)
      && (category.maxAgeYears == null || age <= category.maxAgeYears);
    checks.push({
      rule: 'age_years',
      passed,
      detail: `age ${age} on ${asOfLabel}; bounds ${category.minAgeYears ?? 'unset'} .. ${category.maxAgeYears ?? 'unset'}`,
    });
    if (!passed) {
      reasons.push(
        `This category is for ages ${category.minAgeYears ?? 'any'} to ${category.maxAgeYears ?? 'any'}; this competitor is ${age} on ${asOf}.`
      );
    }
  }

  // 5. Gender. A category with none set, or set to mixed, is open.
  const want = category.gender?.trim().toLowerCase() ?? null;
  if (!want || want === OPEN_GENDER) {
    checks.push({
      rule: 'gender',
      passed: true,
      detail: want === OPEN_GENDER ? 'category is mixed' : 'no gender restriction set for this category',
    });
  } else if (!person.gender) {
    checks.push({ rule: 'gender', passed: false, detail: `category is ${want}; no gender on record` });
    reasons.push('This category is restricted by gender and none is recorded for this competitor.');
  } else {
    const passed = person.gender.trim().toLowerCase() === want;
    checks.push({ rule: 'gender', passed, detail: `category is ${want}; competitor is ${person.gender}` });
    if (!passed) reasons.push(`This category is for ${want} competitors.`);
  }

  // 6. Minimum grade.
  //
  //    THE TRAP: kyu ordinals DESCEND towards mastery (10th kyu is a beginner,
  //    1st kyu is the highest kyu) while dan ordinals ASCEND. Comparing them the
  //    same way silently admits every beginner to a category meant for advanced
  //    competitors, and reads as correct in review. Hence the split below — and
  //    hence a bound with no kind is refused rather than guessed at.
  if (category.minGradeOrdinal == null) {
    checks.push({ rule: 'min_grade', passed: true, detail: 'no minimum grade set for this category' });
  } else if (!category.minGradeKind) {
    checks.push({
      rule: 'min_grade',
      passed: false,
      detail: `minimum ordinal ${category.minGradeOrdinal} set with no grade kind, so the rule cannot be applied`,
    });
    reasons.push('This category’s minimum grade is incomplete and cannot be applied.');
  } else {
    const ranks = await db.select().from(s.rankRecords).where(and(
      eq(s.rankRecords.personId, personId),
      eq(s.rankRecords.status, 'active')
    ));
    const dan = ranks.find((r: any) => r.kind === 'dan');
    const kyu = ranks.find((r: any) => r.kind === 'kyu');
    let passed: boolean;
    let detail: string;

    if (category.minGradeKind === 'dan') {
      passed = Boolean(dan) && dan.gradeOrdinal >= category.minGradeOrdinal;
      detail = dan
        ? `holds ${dan.gradeLabel} (dan ${dan.gradeOrdinal}), minimum dan ${category.minGradeOrdinal}`
        : `holds no active dan grade, minimum dan ${category.minGradeOrdinal}`;
    } else if (dan) {
      // Any dan grade sits above every kyu grade. Refusing a black belt from a
      // "minimum 5th kyu" category would be an obviously wrong answer.
      passed = true;
      detail = `holds ${dan.gradeLabel}, which is above every kyu grade`;
    } else {
      passed = Boolean(kyu) && kyu.gradeOrdinal <= category.minGradeOrdinal;
      detail = kyu
        ? `holds ${kyu.gradeLabel} (kyu ${kyu.gradeOrdinal}), minimum kyu ${category.minGradeOrdinal}`
        : `holds no active kyu grade, minimum kyu ${category.minGradeOrdinal}`;
    }
    checks.push({ rule: 'min_grade', passed, detail });
    if (!passed) {
      // Ordinal suffixes are computed, not concatenated: "3th kyu" on a refusal
      // notice is the sort of thing a club quotes back at the federation.
      reasons.push(
        category.minGradeKind === 'dan'
          ? `This category requires at least ${ordinal(category.minGradeOrdinal)} dan.`
          : `This category requires at least ${ordinal(category.minGradeOrdinal)} kyu.`
      );
    }
  }

  return {
    eligible: reasons.length === 0,
    checks,
    reasons,
    checkedAt: on.toISOString(),
    asOf,
    asOfBasis,
  };
}

// ─── Entries ────────────────────────────────────────────────────────────────

/**
 * Enter a competitor, or a team, into a category.
 *
 * The eligibility decision is stored WITH its evidence, and an ineligible entry
 * is still recorded — a refusal is part of the history and the club is owed an
 * explanation it can read back.
 *
 * An eligible entry becomes `fee_pending` rather than `confirmed` when the
 * category carries a fee code and no order is attached. That is not an invented
 * fee: the fee code is configuration the federation put on the category, and
 * confirming the entry regardless would assert a payment nobody recorded.
 */
export async function enterEvent(
  db: DB,
  ctx: AuditContext,
  input: {
    categoryId: number;
    personId?: number | null;
    /** Required for team categories; every member is checked in their own right. */
    members?: Array<{ personId: number; role?: string | null; position?: number | null }>;
    dojoId?: number | null;
    orderId?: number | null;
  },
  now: Date = new Date()
) {
  const category = await loadCategory(db, input.categoryId);
  const event = await loadEvent(db, category.eventId);
  const isTeam = TEAM_DISCIPLINES.includes(category.discipline);

  const memberIds = isTeam
    ? (input.members ?? []).map((m) => m.personId)
    : input.personId != null ? [input.personId] : [];
  if (memberIds.length === 0) {
    throw new CompetitionError(
      'no_competitor',
      isTeam ? 'A team entry must name its members.' : 'An entry must name a competitor.'
    );
  }
  if (new Set(memberIds).size !== memberIds.length) {
    throw new CompetitionError('duplicate_member', 'The same person appears twice in this team.');
  }

  const people = await db.select().from(s.persons).where(inArray(s.persons.id, memberIds));
  if (people.length !== memberIds.length) {
    throw new CompetitionError('unknown_person', 'One or more competitors are not on the federation register.');
  }

  // AUTHORISATION FIRST, and against the COMPETITOR's placement rather than the
  // event's: entering an athlete is an act over that athlete's record, and an
  // administrator must not be able to reach another state's competitors by
  // picking a national event. It also comes before the event checks below, so an
  // unauthorised caller learns nothing about the event's state.
  for (const p of people) {
    assertCan(ctx.principal, 'competition:write', {
      stateUnitId: p.stateUnitId, districtUnitId: p.districtUnitId, dojoId: p.dojoId,
    });
  }

  if (isTeam) {
    if (category.teamSize == null) {
      throw new CompetitionError(
        'team_size_not_configured',
        'This team category states no team size, so a team cannot be validated against it.'
      );
    }
    if (memberIds.length !== category.teamSize) {
      throw new CompetitionError(
        'team_size_mismatch',
        `This category is for teams of ${category.teamSize}; ${memberIds.length} competitor(s) were named.`
      );
    }
  }

  // A championship nobody sanctioned must not take entries, whatever its status
  // column says. A status can be written straight into the table; a sanction
  // carries an authority and a reference. Check the fact, not the label.
  if (!event.sanctionedAt) {
    throw new CompetitionError(
      'not_sanctioned',
      'This event has not been sanctioned by the federation and cannot take entries.'
    );
  }
  if (event.status !== 'registration_open') {
    throw new CompetitionError(
      'registration_closed',
      `Entries are not open: this event is ${event.status.replace(/_/g, ' ')}.`
    );
  }
  // An unset window is not enforced, and the stored snapshot below says so.
  if (event.registrationOpensAt && now.getTime() < new Date(event.registrationOpensAt).getTime()) {
    throw new CompetitionError(
      'registration_not_yet_open',
      `Registration opens ${new Date(event.registrationOpensAt).toISOString()}.`
    );
  }
  if (event.registrationClosesAt && now.getTime() > new Date(event.registrationClosesAt).getTime()) {
    throw new CompetitionError(
      'registration_closed',
      `Registration closed ${new Date(event.registrationClosesAt).toISOString()}.`
    );
  }

  const lead = people.find((p: any) => p.id === memberIds[0]);
  const dojoId = input.dojoId ?? lead?.dojoId ?? null;

  // Quotas, only where the federation set them.
  const live = await db.select().from(s.eventEntries).where(and(
    eq(s.eventEntries.categoryId, category.id),
    sql`${s.eventEntries.status} NOT IN ('withdrawn', 'ineligible')`
  ));
  if (category.maxEntries != null && live.length >= category.maxEntries) {
    throw new CompetitionError(
      'category_full',
      `This category is limited to ${category.maxEntries} entries and is full.`
    );
  }
  if (category.entriesPerDojo != null && dojoId != null) {
    const fromDojo = live.filter((e: any) => e.dojoId === dojoId).length;
    if (fromDojo >= category.entriesPerDojo) {
      throw new CompetitionError(
        'dojo_quota_reached',
        `This category allows ${category.entriesPerDojo} entries per dojo, and this dojo already has ${fromDojo}.`
      );
    }
  }

  // For a team the unique index cannot help — personId is null on the entry row
  // — so the double-entry guard is explicit here.
  if (isTeam) {
    const clash = await db
      .select({ personId: s.entryMembers.personId })
      .from(s.entryMembers)
      .innerJoin(s.eventEntries, eq(s.entryMembers.entryId, s.eventEntries.id))
      .where(and(
        eq(s.eventEntries.categoryId, category.id),
        inArray(s.entryMembers.personId, memberIds),
        sql`${s.eventEntries.status} <> 'withdrawn'`
      ));
    if (clash.length) {
      throw new CompetitionError(
        'already_entered',
        'One or more of these competitors is already entered in this category.'
      );
    }
  }

  const perMember: Array<{ personId: number } & EligibilityResult> = [];
  for (const id of memberIds) {
    perMember.push({
      personId: id,
      ...(await checkEntryEligibility(db, ctx.principal, id, category.id, now)),
    });
  }
  const eligible = perMember.every((m) => m.eligible);
  const eligibility: EligibilityResult = {
    eligible,
    checks: isTeam
      ? perMember.map((m) => ({
          rule: `member_${m.personId}`,
          passed: m.eligible,
          detail: m.eligible ? 'eligible' : m.reasons.join(' '),
        }))
      : perMember[0].checks,
    reasons: perMember.flatMap((m) => m.reasons),
    checkedAt: now.toISOString(),
    // Every member is checked against the same event, so the date the age and
    // membership rules were tested against is one fact, not one per member.
    asOf: perMember[0].asOf,
    asOfBasis: perMember[0].asOfBasis,
    ...(isTeam
      ? {
          members: perMember.map((m) => ({
            personId: m.personId, eligible: m.eligible, checks: m.checks, reasons: m.reasons,
          })),
        }
      : {}),
  };

  const feeOutstanding = Boolean(category.feeCode) && input.orderId == null;
  const status: EntryStatus = !eligible ? 'ineligible' : feeOutstanding ? 'fee_pending' : 'confirmed';

  const entryNo = await allocateFederationId(db, 'ENT');
  let row;
  try {
    [row] = await db.insert(s.eventEntries).values({
      entryNo,
      eventId: event.id,
      categoryId: category.id,
      // A team entry has no single owning person; its members are rows of their
      // own, which also keeps the (category, person) unique index meaningful.
      personId: isTeam ? null : memberIds[0],
      dojoId,
      stateUnitId: lead?.stateUnitId ?? null,
      status,
      eligibilityCheckedAt: now,
      // Frozen evidence: the decision, the category as it stood, the
      // registration window that was (or was not) enforced, and the sanction the
      // event was running under.
      eligibilitySnapshot: {
        ...eligibility,
        category: {
          code: category.code, label: category.label, discipline: category.discipline,
          gender: category.gender, bornOnOrAfter: category.bornOnOrAfter,
          bornOnOrBefore: category.bornOnOrBefore, minAgeYears: category.minAgeYears,
          maxAgeYears: category.maxAgeYears, minWeightGrams: category.minWeightGrams,
          maxWeightGrams: category.maxWeightGrams, minGradeOrdinal: category.minGradeOrdinal,
          minGradeKind: category.minGradeKind, teamSize: category.teamSize,
        },
        registrationWindow: {
          opensAt: event.registrationOpensAt ?? null,
          closesAt: event.registrationClosesAt ?? null,
          enforced: Boolean(event.registrationOpensAt || event.registrationClosesAt),
        },
        sanction: { reference: event.sanctionReference, sanctionedAt: event.sanctionedAt },
      },
      ineligibleReason: eligible ? null : eligibility.reasons.join(' '),
      orderId: input.orderId ?? null,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err)) {
      // The unique index is (categoryId, personId) and does NOT exclude
      // withdrawn entries, so a club that withdrew a competitor and tried to
      // re-enter them was told "already entered" — a refusal that reads as
      // wrong to the only people who can act on it. Name the entry and the
      // state it is actually in, so the refusal is defensible from the record.
      const [clash] = await db.select({
        entryNo: s.eventEntries.entryNo, status: s.eventEntries.status,
      }).from(s.eventEntries).where(and(
        eq(s.eventEntries.categoryId, category.id),
        eq(s.eventEntries.personId, memberIds[0])
      )).limit(1);
      throw new CompetitionError(
        'already_entered',
        clash
          ? `This competitor already has entry ${clash.entryNo} in this category (${clash.status.replace(/_/g, ' ')}); a second entry cannot be created.`
          : 'This competitor is already entered in this category.'
      );
    }
    throw err;
  }

  if (isTeam) {
    for (const [i, m] of (input.members ?? []).entries()) {
      await db.insert(s.entryMembers).values({
        entryId: row.id,
        personId: m.personId,
        role: m.role ?? 'competitor',
        position: m.position ?? i + 1,
      });
    }
  }

  await writeAudit(db, ctx, {
    entityType: 'event_entry',
    entityId: row.id,
    action: 'create',
    newValue: {
      entryNo, eventId: event.id, categoryId: category.id,
      competitors: memberIds, status, eligible,
    },
  });

  return { ...row, eligibility };
}

async function loadEntry(db: DB, entryId: number) {
  const entry = (await db.select().from(s.eventEntries)
    .where(eq(s.eventEntries.id, entryId)).limit(1))[0];
  if (!entry) throw new CompetitionError('unknown_entry', 'Unknown entry');
  const event = await loadEvent(db, entry.eventId);
  const category = await loadCategory(db, entry.categoryId);
  return { entry, event, category };
}

/**
 * OFFICIAL RECORDS LOCK.
 *
 * Once an event's results are final, its entry list is history: check-in times,
 * weigh-in weights and withdrawals are the evidence behind medals that have
 * already been published. Every mutation of an entry goes through here, because
 * a lock that one function forgets is not a lock — `recordWeighIn` could
 * previously rewrite the recorded weight of a competitor in a finalised
 * championship, and the row would carry no sign that it had ever said anything
 * else.
 */
function assertEntriesUnlocked(event: any, what: string): void {
  if (event.resultsFinalisedAt || RESULTS_LOCKED_STATUSES.includes(event.status)) {
    throw new CompetitionError(
      'results_final',
      `This event’s results are final; ${what} can no longer be changed. Record a correction against the result instead.`
    );
  }
}

function assertEntryWritable(principal: Principal, entry: any, event: any): void {
  // The entry's own placement, falling back to the event's for an entry that
  // carries none — never an empty resource, which only a national binding
  // satisfies. Fail closed.
  assertCan(principal, 'competition:write', {
    stateUnitId: entry.stateUnitId ?? event.stateUnitId,
    districtUnitId: event.districtUnitId,
    dojoId: entry.dojoId,
  });
}

/** Check a competitor in on the day. */
export async function checkIn(db: DB, ctx: AuditContext, entryId: number, now: Date = new Date()) {
  const { entry, event } = await loadEntry(db, entryId);
  assertEntryWritable(ctx.principal, entry, event);
  assertEntriesUnlocked(event, 'a check-in');

  if (!['check_in', 'live'].includes(event.status)) {
    throw new CompetitionError(
      'check_in_not_open',
      `Check-in is not open: this event is ${event.status.replace(/_/g, ' ')}.`
    );
  }
  if (entry.status === 'checked_in' || entry.status === 'weighed_in') {
    throw new CompetitionError('already_checked_in', 'This entry is already checked in.');
  }
  if (entry.status !== 'confirmed') {
    // Covers ineligible, withdrawn, disqualified and — deliberately —
    // fee_pending: checking in an entry whose fee was never recorded would
    // assert a payment that does not exist.
    throw new CompetitionError(
      'entry_not_confirmed',
      `Only a confirmed entry can check in; this one is ${entry.status.replace(/_/g, ' ')}.`
    );
  }

  const [row] = await db.update(s.eventEntries).set({
    status: 'checked_in', checkedInAt: now, updatedAt: now,
  }).where(eq(s.eventEntries.id, entryId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'event_entry',
    entityId: entryId,
    action: 'update',
    oldValue: { status: entry.status },
    newValue: { status: 'checked_in', checkedInAt: now.toISOString() },
  });
  return row;
}

export interface WeighInResult {
  entry: any;
  grams: number;
  /** null when the category sets no weight bound — the rule was not set. */
  withinLimit: boolean | null;
  detail: string;
}

/**
 * Record an official weigh-in, in GRAMS.
 *
 * Grams as integers, never kilograms as a float: 61.4 is not representable in
 * binary floating point, and a weight class decided by the last digit is exactly
 * where that bites. The recording official is required — an anonymous weight is
 * not evidence.
 *
 * A weight outside the category's bounds is RECORDED and reported, but the entry
 * is deliberately NOT auto-disqualified. Whether a failed weigh-in ends a
 * competitor's day, and whether they get a second attempt, is MMAKF competition
 * regulation. This function states the measurement and the fact that it falls
 * outside the configured limits, and leaves the decision to the officials who
 * hold it.
 */
export async function recordWeighIn(
  db: DB,
  ctx: AuditContext,
  input: { entryId: number; grams: number; officialPersonId: number },
  now: Date = new Date()
): Promise<WeighInResult> {
  const { entry, event, category } = await loadEntry(db, input.entryId);
  assertEntryWritable(ctx.principal, entry, event);
  assertEntriesUnlocked(event, 'a weigh-in');

  if (!Number.isInteger(input.grams)) {
    throw new CompetitionError(
      'weight_not_integer',
      `Weight is recorded in whole grams; received ${input.grams}.`
    );
  }
  if (input.grams <= 0) {
    throw new CompetitionError('weight_out_of_range', 'A recorded weight must be greater than zero.');
  }

  const official = (await db.select().from(s.persons)
    .where(eq(s.persons.id, input.officialPersonId)).limit(1))[0];
  if (!official) {
    throw new CompetitionError('unknown_official', 'The recording official is not on the federation register.');
  }

  if (!['checked_in', 'weighed_in'].includes(entry.status)) {
    throw new CompetitionError(
      'not_checked_in',
      `Only a checked-in entry can be weighed; this one is ${entry.status.replace(/_/g, ' ')}.`
    );
  }

  const hasBound = category.minWeightGrams != null || category.maxWeightGrams != null;
  const withinLimit = hasBound
    ? (category.minWeightGrams == null || input.grams >= category.minWeightGrams)
      && (category.maxWeightGrams == null || input.grams <= category.maxWeightGrams)
    : null;
  const detail = hasBound
    ? `${input.grams}g against bounds ${category.minWeightGrams ?? 'unset'} .. ${category.maxWeightGrams ?? 'unset'}`
    : `${input.grams}g; no weight limit set for this category`;

  const [row] = await db.update(s.eventEntries).set({
    weighInGrams: input.grams,
    weighInAt: now,
    weighInByPersonId: input.officialPersonId,
    // The measurement always stands; the STATUS only advances when it is inside
    // the configured limits, so an out-of-limit competitor cannot drift onto the
    // mat without an official making a decision.
    status: withinLimit === false ? entry.status : 'weighed_in',
    updatedAt: now,
  }).where(eq(s.eventEntries.id, input.entryId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'event_entry',
    entityId: input.entryId,
    action: 'update',
    oldValue: { weighInGrams: entry.weighInGrams ?? null, status: entry.status },
    newValue: {
      weighInGrams: input.grams, withinLimit, detail,
      recordedBy: input.officialPersonId, at: now.toISOString(), status: row.status,
    },
  });

  return { entry: row, grams: input.grams, withinLimit, detail };
}

/** Withdraw an entry. The reason is mandatory and stays on the record. */
export async function withdraw(
  db: DB,
  ctx: AuditContext,
  input: { entryId: number; reason: string },
  now: Date = new Date()
) {
  const { entry, event } = await loadEntry(db, input.entryId);
  assertEntryWritable(ctx.principal, entry, event);

  if (!input.reason?.trim()) {
    throw new CompetitionError('reason_required', 'A withdrawal must record why it was made.');
  }
  if (entry.status === 'withdrawn') {
    throw new CompetitionError('already_withdrawn', 'This entry is already withdrawn.');
  }
  // Withdrawing an entry after the results are official would change who
  // competed in a championship that has already been published.
  assertEntriesUnlocked(event, 'an entry');

  const [row] = await db.update(s.eventEntries).set({
    status: 'withdrawn', withdrawnReason: input.reason.trim(), updatedAt: now,
  }).where(eq(s.eventEntries.id, input.entryId)).returning();

  await writeAudit(db, { ...ctx, reason: input.reason.trim() }, {
    entityType: 'event_entry',
    entityId: input.entryId,
    action: 'update',
    oldValue: { status: entry.status },
    newValue: { status: 'withdrawn', withdrawnReason: input.reason.trim() },
  });
  return row;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * Scope filter for the event list.
 *
 * Returns null for national reach and `sql\`false\`` for none, so the caller
 * always filters IN THE QUERY rather than after it — knowing an id must never be
 * enough to read a row.
 */
function eventScopeCondition(principal: Principal, action: Action) {
  const scopes = visibleScopes(principal, action);
  if (scopes.kind === 'all') return null;
  if (scopes.kind === 'none') return sql`false`;

  const clauses: any[] = [];
  if (scopes.states.length) clauses.push(inArray(s.competitionEvents.stateUnitId, scopes.states));
  if (scopes.districts.length) clauses.push(inArray(s.competitionEvents.districtUnitId, scopes.districts));
  if (scopes.dojos.length) clauses.push(inArray(s.competitionEvents.organiserDojoId, scopes.dojos));
  // Published national events are public information; see assertEventReadable.
  clauses.push(and(
    isNull(s.competitionEvents.stateUnitId),
    isNull(s.competitionEvents.districtUnitId),
    inArray(s.competitionEvents.status, [...PUBLIC_STATUSES])
  ));
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

export async function listEvents(
  db: DB,
  principal: Principal,
  opts: { status?: EventStatus[]; limit?: number } = {}
) {
  // Gate on holding the action anywhere; the SQL filter below does the scoping,
  // so a state admin lists their own state rather than being refused outright.
  assertCanAnywhere(principal, 'competition:read');
  const conds: any[] = [];
  const scope = eventScopeCondition(principal, 'competition:read');
  if (scope) conds.push(scope);
  if (opts.status?.length) conds.push(inArray(s.competitionEvents.status, opts.status));

  const q = db.select().from(s.competitionEvents);
  const filtered = conds.length ? q.where(and(...conds)) : q;
  return filtered.orderBy(asc(s.competitionEvents.startsOn)).limit(opts.limit ?? 100);
}

export async function eventWithCategories(db: DB, principal: Principal, eventId: number) {
  const event = await loadEvent(db, eventId);
  assertEventReadable(principal, event);
  const categories = await db.select().from(s.eventCategories)
    .where(eq(s.eventCategories.eventId, eventId))
    .orderBy(asc(s.eventCategories.displayOrder), asc(s.eventCategories.code));
  return { event, categories };
}

/**
 * The entry list for one category.
 *
 * Columns are named explicitly rather than selected wholesale, so a later schema
 * addition cannot quietly widen what an entry list discloses. No dates of birth,
 * no contact details — an entry list says who is competing, it is not a member
 * export.
 */
export async function categoryEntries(db: DB, principal: Principal, categoryId: number) {
  const category = await loadCategory(db, categoryId);
  const event = await loadEvent(db, category.eventId);
  assertEventReadable(principal, event);

  const rows = await db
    .select({
      entryId: s.eventEntries.id,
      entryNo: s.eventEntries.entryNo,
      status: s.eventEntries.status,
      personId: s.eventEntries.personId,
      fullName: s.persons.fullName,
      federationId: s.persons.federationId,
      dojoId: s.eventEntries.dojoId,
      stateUnitId: s.eventEntries.stateUnitId,
      seed: s.eventEntries.seed,
      drawPosition: s.eventEntries.drawPosition,
      checkedInAt: s.eventEntries.checkedInAt,
      weighInGrams: s.eventEntries.weighInGrams,
      ineligibleReason: s.eventEntries.ineligibleReason,
      withdrawnReason: s.eventEntries.withdrawnReason,
    })
    .from(s.eventEntries)
    .leftJoin(s.persons, eq(s.eventEntries.personId, s.persons.id))
    .where(eq(s.eventEntries.categoryId, categoryId))
    .orderBy(asc(s.eventEntries.id));

  // `competition:read` is held by athletes, instructors, referees and every
  // other dojo — an entry list is close to public. The STATUS of an entry
  // belongs on it; the free-text reason behind a refusal or a withdrawal does
  // not, because it quotes a membership lapse, an injury or a suspension. The
  // reason is disclosed per row to the administrators who could have written it
  // — the same placement test that governs writing the entry — and withheld
  // otherwise, with the row saying it was withheld rather than that none exists.
  const entries = rows.map((r: any) => {
    const mayReadReasons = can(principal, 'competition:write', {
      stateUnitId: r.stateUnitId ?? event.stateUnitId,
      districtUnitId: event.districtUnitId,
      dojoId: r.dojoId,
    });
    return mayReadReasons
      ? { ...r, reasonsWithheld: false }
      : {
          ...r,
          ineligibleReason: null,
          withdrawnReason: null,
          reasonsWithheld: Boolean(r.ineligibleReason || r.withdrawnReason),
        };
  });

  return { category, entries };
}
