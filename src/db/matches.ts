// Match lifecycle, live scoring and result finalisation.
//
// SCHEDULED -> CALLED -> IN_PROGRESS <-> PAUSED -> COMPLETED -> (protest) -> RESULT
//
// Three properties make a competition record defensible, and this module holds
// all three:
//
//  1. THE EVENT LOG IS THE RECORD OF TRUTH. `matches.redScore`/`blueScore` are
//     a cache for the scoreboard. Every append recomputes them from the log, so
//     the cache cannot drift; and if something outside this module has moved
//     them, `reconcileMatchScore()` reports the drift rather than quietly
//     papering over it.
//
//  2. NOTHING IS EDITED. A wrongly signalled point is corrected by appending a
//     REVERSING event (`reversesEventId`). The original row stays exactly as it
//     was recorded, because "the referee changed his mind during the bout" and
//     "the record was altered afterwards" must still be distinguishable a year
//     later, in front of an appeal panel.
//
//  3. NO POINT VALUE IS INVENTED HERE. Karate scores yuko, waza-ari and ippon —
//     but what each is worth, whether senshu decides a tie, how many judges are
//     discarded in kata, and what placing a semi-final loser receives are all
//     COMPETITION REGULATIONS. They arrive as a ruleset supplied by the
//     federation. Where none has been supplied this module refuses to act
//     rather than assume, because an assumed point value is a fabricated result.

import { and, asc, eq, sql } from 'drizzle-orm';
import * as s from './schema';
import { writeAudit, type AuditContext } from './federation';
import { assertCan } from '@/lib/rbac';
import { isUniqueViolation } from './pgerror';

type DB = any; // drizzle client (postgres.js in prod, PGlite in tests)

export class MatchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MatchError';
    this.code = code;
  }
}

export type Side = 'red' | 'blue';
export type MatchState = (typeof s.matchStatus.enumValues)[number];

const otherSide = (side: Side): Side => (side === 'red' ? 'blue' : 'red');

// ─── The ruleset: competition regulations, supplied — never assumed ─────────

/**
 * What one signalled action is worth.
 *
 * `awardTo` is mandatory whenever points are carried, because "a penalty gives
 * the opponent the point" is a rule of a particular rulebook and not a law of
 * nature. Stating it explicitly keeps a result readable against the regulations
 * it was actually scored under.
 */
export interface ScoringActionRule {
  /** Integer points. Never a float — a score that cannot be summed exactly is not a score. */
  points: number;
  /** 'signalled' credits the competitor it was signalled for; 'opponent' credits the other. */
  awardTo?: 'signalled' | 'opponent';
  /** True when this action is an infringement, so it is tallied as a penalty. */
  penalty?: boolean;
  /**
   * True when recording it ends the bout immediately (e.g. hansoku).
   *
   * An ending action MUST also carry `awardTo`, whatever its point value: a
   * disqualification that carries no points still decides who goes through,
   * and which competitor that is cannot be inferred from the points.
   */
  endsMatch?: boolean;
  /** The win method recorded when it ends the bout. */
  winMethod?: string;
}

/**
 * Kata judging arrangement.
 *
 * Scores are integers in HUNDREDTHS. Kata marks carry decimals, and decimals
 * held as floats do not sum reliably — a medal decided on the third decimal
 * place of a binary rounding artefact is indefensible.
 */
export interface KataRules {
  /** Inclusive bounds on ONE judge's total, in hundredths. */
  minScore: number;
  maxScore: number;
  /** How many of the highest / lowest judge scores the regulations discard. */
  discardHighest?: number;
  discardLowest?: number;
  /**
   * The components judges mark. Naming them here is the federation stating that
   * they are summed; if MMAKF ever weights one against the other, the weight
   * belongs in this ruleset and not in code.
   */
  components?: Array<'technical' | 'athletic'>;
  /** Minimum judges whose scores must survive the discards for a valid result. */
  minJudges?: number;
}

/** How a bracket turns into placings. Entirely federation policy. */
export interface PlacingRules {
  /** Round code of the deciding bout. Unset ⇒ the last match by roundOrder, provided it is unique. */
  finalRound?: string;
  /** Rounds decided by a dedicated play-off, keyed by round code. */
  playoffRounds?: Record<string, { winner: number; loser: number }>;
  /** The placing given to the loser of each round. */
  losersPlacing?: Record<string, number>;
  /** placing → medal. A placing not listed carries no medal. */
  medals?: Record<string, 'gold' | 'silver' | 'bronze' | 'participation'>;
}

export interface ScoringRuleset {
  /** Identity of the regulations in force, recorded against what they decided. */
  code: string;
  actions: Record<string, ScoringActionRule>;
  /** Tie-breaks in the order the regulations apply them. Unset ⇒ a tie stays a tie. */
  tieBreak?: Array<'senshu' | 'hantei'>;
  /**
   * Does a point credited by the OPPONENT'S penalty confer senshu?
   *
   * This is a regulation, not arithmetic — rulebooks differ — so it is not
   * assumed here. Unset is tolerated only while both readings name the same
   * competitor; where they disagree the bout is refused completion and says so.
   */
  senshuFromPenaltyPoints?: boolean;
  kata?: KataRules;
  placings?: PlacingRules;
}

/**
 * Validate a supplied ruleset, or refuse.
 *
 * The single point where "the federation has not told us the rules" becomes a
 * refusal. Every entry point that might otherwise fall back on a default comes
 * through here first.
 */
export function requireRuleset(ruleset?: ScoringRuleset | null): ScoringRuleset {
  if (!ruleset || !ruleset.code || !ruleset.actions || Object.keys(ruleset.actions).length === 0) {
    throw new MatchError(
      'ruleset_required',
      'No scoring ruleset was supplied. Point values are set by the competition regulations in force; they are not assumed here.'
    );
  }
  for (const [name, rule] of Object.entries(ruleset.actions)) {
    if (!Number.isInteger(rule.points)) {
      throw new MatchError('bad_ruleset', `Action "${name}" has a non-integer point value.`);
    }
    if (rule.points < 0) {
      throw new MatchError('bad_ruleset', `Action "${name}" has a negative point value; a reversal carries the negation, a rule does not.`);
    }
    if (rule.points > 0 && !rule.awardTo) {
      throw new MatchError('bad_ruleset', `Action "${name}" awards ${rule.points} point(s) but does not say to which competitor.`);
    }
    if (rule.penalty && rule.points > 0 && rule.awardTo !== 'opponent') {
      throw new MatchError('bad_ruleset', `Penalty "${name}" would credit the competitor who committed it.`);
    }
    // An ending action with no awardTo is the trap that crowns the offender: a
    // 0-point disqualification stores the competitor it was signalled ABOUT,
    // and without awardTo the completion has nothing to invert it against.
    if (rule.endsMatch && !rule.awardTo) {
      throw new MatchError(
        'bad_ruleset',
        `Action "${name}" ends the bout but does not say which competitor it is awarded to. State awardTo: 'signalled' or 'opponent'.`
      );
    }
  }
  return ruleset;
}

function actionRule(ruleset: ScoringRuleset, action: string): ScoringActionRule {
  const rule = ruleset.actions[action];
  if (!rule) {
    throw new MatchError(
      'action_not_in_ruleset',
      `"${action}" is not a scoring action under ruleset ${ruleset.code}. The federation has not set its value, so it cannot be recorded.`
    );
  }
  return rule;
}

// ─── Loading and scope ──────────────────────────────────────────────────────

/**
 * Where an event sits in the federation hierarchy, for `can()`.
 *
 * A national event carries no state, so a state-scoped principal is refused —
 * the deny-by-default behaviour we want, not an accident.
 */
function eventResource(event: any) {
  return {
    stateUnitId: event.stateUnitId ?? null,
    districtUnitId: event.districtUnitId ?? null,
    dojoId: event.organiserDojoId ?? null,
  };
}

async function loadMatch(db: DB, matchId: number) {
  const match = (await db.select().from(s.matches).where(eq(s.matches.id, matchId)).limit(1))[0];
  if (!match) throw new MatchError('unknown_match', 'Unknown match');
  const event = (await db.select().from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, match.eventId)).limit(1))[0];
  if (!event) throw new MatchError('unknown_event', 'Unknown competition event');
  return { match, event, resource: eventResource(event) };
}

/** The person behind the calling account, for "is this your own record?" checks. */
async function principalPersonId(db: DB, ctx: AuditContext): Promise<number | null> {
  if (ctx.principal.userId == null) return null;
  const row = (await db.select({ personId: s.users.personId }).from(s.users)
    .where(eq(s.users.id, ctx.principal.userId)).limit(1))[0];
  return row?.personId ?? null;
}

/** The side an entry is on in a match, or null when it is not in it at all. */
export function sideOf(match: any, entryId: number | null | undefined): Side | null {
  if (entryId == null) return null;
  if (match.redEntryId === entryId) return 'red';
  if (match.blueEntryId === entryId) return 'blue';
  return null;
}

/**
 * The official must hold an appointment to this event.
 *
 * WHICH appointed role may signal which action is a matter of the competition
 * regulations, so that is not judged here — but an unappointed person putting
 * points on a national scoreboard is not a rules question, it is an integrity
 * failure, and it is refused.
 */
async function assertAppointed(db: DB, eventId: number, personId: number | null | undefined, what: string) {
  if (personId == null) {
    throw new MatchError('official_required', `${what} must record the official who signalled it.`);
  }
  const seat = (await db.select().from(s.eventOfficials).where(and(
    eq(s.eventOfficials.eventId, eventId),
    eq(s.eventOfficials.personId, personId)
  )).limit(1))[0];
  if (!seat) {
    throw new MatchError('official_not_appointed', 'That person is not an appointed official at this event.');
  }
  return seat;
}

// ─── The state machine ──────────────────────────────────────────────────────

/**
 * Legal transitions, exhaustively. Anything not listed is refused.
 *
 * `completed` is reachable only through completeMatch(), because completing a
 * bout without naming a winner and a win method produces a result nobody can
 * act on. `under_protest` is reachable only through lodgeProtest(), and returns
 * to `completed` when the protest is decided.
 */
const TRANSITIONS: Record<MatchState, MatchState[]> = {
  scheduled: ['called', 'cancelled', 'walkover', 'disqualification'],
  called: ['in_progress', 'scheduled', 'cancelled', 'walkover', 'disqualification'],
  in_progress: ['paused', 'completed', 'walkover', 'disqualification', 'cancelled'],
  paused: ['in_progress', 'completed', 'walkover', 'disqualification', 'cancelled'],
  completed: ['under_protest'],
  under_protest: ['completed'],
  walkover: [],
  disqualification: [],
  cancelled: [],
};

/** States in which the bout is over and its event log closed. */
const TERMINAL: MatchState[] = ['completed', 'walkover', 'disqualification', 'cancelled'];

export function allowedTransitions(from: MatchState): MatchState[] {
  return [...(TRANSITIONS[from] ?? [])];
}

function assertTransition(from: MatchState, to: MatchState) {
  const allowed = TRANSITIONS[from] ?? [];
  if (!allowed.includes(to)) {
    throw new MatchError(
      'illegal_transition',
      `A match that is ${from.replace(/_/g, ' ')} cannot move to ${to.replace(/_/g, ' ')}. Permitted from here: ${allowed.join(', ') || 'nothing — this state is final'}.`
    );
  }
}

/**
 * Move a match through its lifecycle.
 *
 * Terminal transitions demand a reason, and the two that produce a winner with
 * no bout — walkover and disqualification — demand that the winner be named. A
 * walkover with nobody recorded as advancing is how an entry silently vanishes
 * from a bracket.
 */
export async function transitionMatch(
  db: DB,
  ctx: AuditContext,
  input: {
    matchId: number;
    to: MatchState;
    reason?: string;
    winnerEntryId?: number | null;
    winMethod?: string;
  },
  now: Date = new Date()
) {
  const { match, resource } = await loadMatch(db, input.matchId);
  assertCan(ctx.principal, 'result:enter', resource);

  if (input.to === 'completed') {
    throw new MatchError(
      'use_complete_match',
      'A bout is completed through completeMatch(), which determines the winner from the event log and records the win method.'
    );
  }
  if (input.to === 'under_protest') {
    throw new MatchError('use_lodge_protest', 'A match goes under protest through lodgeProtest().');
  }

  assertTransition(match.status as MatchState, input.to);

  // Starting a bout with an empty side is how a bye ends up scored as a contest.
  if (input.to === 'in_progress' && match.status !== 'paused') {
    if (match.redEntryId == null || match.blueEntryId == null) {
      throw new MatchError(
        'incomplete_bout',
        'A bout cannot start with only one competitor assigned. Record a walkover instead.'
      );
    }
  }

  const terminal = TERMINAL.includes(input.to);
  if (terminal && !input.reason?.trim()) {
    throw new MatchError('reason_required', `Recording a match as ${input.to} requires a reason.`);
  }

  // A win method is a classification out of the regulations — "kiken" is a
  // withdrawal, not a synonym for "the opponent never appeared" — so it is
  // recorded only where it was stated, and only where it means anything.
  const winnerNamed = input.to === 'walkover' || input.to === 'disqualification';
  if (input.winMethod != null && !winnerNamed) {
    throw new MatchError(
      'win_method_not_applicable',
      `A win method belongs to a result. Recording a match as ${input.to} does not produce one.`
    );
  }

  let winnerEntryId: number | null = match.winnerEntryId ?? null;
  if (winnerNamed) {
    if (input.winnerEntryId == null) {
      throw new MatchError('winner_required', `A ${input.to} must name the competitor who advances.`);
    }
    if (!sideOf(match, input.winnerEntryId)) {
      throw new MatchError('winner_not_in_match', 'That entry is not a competitor in this match.');
    }
    winnerEntryId = input.winnerEntryId;
  }

  const startedAt = input.to === 'in_progress' && !match.startedAt ? now : match.startedAt;
  const endedAt = terminal ? now : match.endedAt;
  const durationSeconds = terminal && startedAt
    ? Math.max(0, Math.round((now.getTime() - new Date(startedAt).getTime()) / 1000))
    : match.durationSeconds;

  const [row] = await db.update(s.matches).set({
    status: input.to,
    startedAt,
    endedAt,
    durationSeconds,
    winnerEntryId,
    winMethod: input.winMethod?.trim() || match.winMethod || null,
    updatedAt: now,
  }).where(eq(s.matches.id, input.matchId)).returning();

  await writeAudit(db, { ...ctx, reason: input.reason ?? ctx.reason ?? null }, {
    entityType: 'match',
    entityId: input.matchId,
    action: 'update',
    oldValue: { status: match.status, winnerEntryId: match.winnerEntryId, winMethod: match.winMethod },
    newValue: { status: input.to, winnerEntryId, winMethod: input.winMethod?.trim() || match.winMethod || null },
  });

  if (winnerEntryId && (input.to === 'walkover' || input.to === 'disqualification')) {
    await advanceWinner(db, ctx, row, winnerEntryId, now);
  }

  return row;
}

// ─── The event log ──────────────────────────────────────────────────────────

/**
 * THE INVARIANT OF `match_events`, and the reason the cache cannot drift:
 *
 *     every row means "credit `points` to `side`".
 *
 * The running score is therefore Σ points GROUP BY side — pure arithmetic over
 * the log needing no ruleset at replay time, so a later amendment to the
 * regulations cannot retrospectively move a score that was already recorded.
 *
 * For a penalty row (`penaltyCode` set) the penalised competitor is
 *
 *     points > 0 ? the other side : `side`
 *
 * because a penalty never credits the competitor who committed it. That is
 * checked when the ruleset is validated, so the derivation always holds.
 */
export interface MatchScore {
  red: number;
  blue: number;
  /** Infringements tallied against each competitor, by code. */
  penalties: { red: Record<string, number>; blue: Record<string, number> };
  /** Rows in the log, including reversals and the rows they reverse. */
  eventCount: number;
  /** Rows still standing — neither a reversal nor reversed. */
  liveEventCount: number;
}

async function readLog(db: DB, matchId: number) {
  return db.select().from(s.matchEvents)
    .where(eq(s.matchEvents.matchId, matchId))
    .orderBy(asc(s.matchEvents.sequence));
}

/** Rows still standing: not a reversal, and not reversed by one. */
function liveEvents(events: any[]): any[] {
  const reversed = new Set(events.filter((e) => e.reversesEventId != null).map((e) => e.reversesEventId));
  return events.filter((e) => e.reversesEventId == null && !reversed.has(e.id));
}

/**
 * Replay the log.
 *
 * The total is computed twice — once over every row, once over only the rows
 * still standing — and the two must agree. They can only disagree if a reversal
 * failed to carry the exact negation of what it reverses, which would mean the
 * append-only guarantee had been broken by something outside this module. That
 * is worth a loud failure rather than a quietly wrong scoreboard.
 */
export function replayScore(events: any[]): MatchScore {
  const all = { red: 0, blue: 0 };
  for (const e of events) {
    if (e.side === 'red' || e.side === 'blue') all[e.side as Side] += e.points ?? 0;
  }

  const live = liveEvents(events);
  const standing = { red: 0, blue: 0 };
  const penalties: MatchScore['penalties'] = { red: {}, blue: {} };
  for (const e of live) {
    if (e.side !== 'red' && e.side !== 'blue') continue;
    const side = e.side as Side;
    const points = e.points ?? 0;
    standing[side] += points;
    if (e.penaltyCode) {
      const against = points > 0 ? otherSide(side) : side;
      penalties[against][e.penaltyCode] = (penalties[against][e.penaltyCode] ?? 0) + 1;
    }
  }

  if (all.red !== standing.red || all.blue !== standing.blue) {
    throw new MatchError(
      'log_inconsistent',
      `The event log does not reconcile: summing every row gives ${all.red}-${all.blue}, summing only the rows still standing gives ${standing.red}-${standing.blue}. A reversal has not cancelled what it reverses.`
    );
  }

  return {
    red: standing.red,
    blue: standing.blue,
    penalties,
    eventCount: events.length,
    liveEventCount: live.length,
  };
}

export async function scoreFromLog(db: DB, matchId: number): Promise<MatchScore> {
  return replayScore(await readLog(db, matchId));
}

/** Recompute the cache from the log. Returns whether it had drifted. */
async function syncCachedScore(db: DB, matchId: number, now: Date) {
  const match = (await db.select().from(s.matches).where(eq(s.matches.id, matchId)).limit(1))[0];
  const score = await scoreFromLog(db, matchId);
  const drifted = match.redScore !== score.red || match.blueScore !== score.blue;

  await db.update(s.matches).set({
    redScore: score.red,
    blueScore: score.blue,
    redPenalties: score.penalties.red,
    bluePenalties: score.penalties.blue,
    updatedAt: now,
  }).where(eq(s.matches.id, matchId));

  return { score, drifted, cached: { red: match.redScore, blue: match.blueScore } };
}

/**
 * Recompute the cache and SAY whether it had drifted.
 *
 * A silent self-heal would hide the fact that something had written to the
 * scoreboard outside the event log, which is precisely the event an official
 * needs to be told about.
 */
export async function reconcileMatchScore(db: DB, ctx: AuditContext, matchId: number, now: Date = new Date()) {
  const { resource } = await loadMatch(db, matchId);
  assertCan(ctx.principal, 'result:enter', resource);

  const result = await syncCachedScore(db, matchId, now);
  if (result.drifted) {
    await writeAudit(db, ctx, {
      entityType: 'match',
      entityId: matchId,
      action: 'update',
      oldValue: { redScore: result.cached.red, blueScore: result.cached.blue, source: 'cache' },
      newValue: { redScore: result.score.red, blueScore: result.score.blue, source: 'event_log' },
    });
  }
  return result;
}

/**
 * Append one row, allocating the next sequence number.
 *
 * The sequence is derived from the log rather than from a counter on the match,
 * so it cannot be pushed out of step by a failed write. Two scorers on the same
 * mat can still read the same maximum, which the unique index on
 * (match_id, sequence) turns into a conflict rather than two events sharing a
 * position — so a conflict is retried, not surfaced.
 */
async function appendEvent(db: DB, matchId: number, values: Record<string, unknown>, attempts = 5) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const rows = await db
      .select({ m: sql<number>`coalesce(max(${s.matchEvents.sequence}), 0)::int` })
      .from(s.matchEvents)
      .where(eq(s.matchEvents.matchId, matchId));
    const sequence = Number(rows[0]?.m ?? 0) + 1;
    try {
      const [row] = await db.insert(s.matchEvents)
        .values({ ...values, matchId, sequence })
        .returning();
      return row;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < attempts - 1) continue;
      throw err;
    }
  }
  throw new MatchError('sequence_contention', 'Could not allocate a sequence number for this event.');
}

/**
 * Record a scoring action. APPEND-ONLY.
 *
 * `side` names the competitor the action was signalled FOR (a scorer) or
 * AGAINST (a penalty); the ruleset decides which competitor the points are
 * credited to, and the row stores that resolved side so the log replays without
 * needing the ruleset again.
 */
export async function recordMatchEvent(
  db: DB,
  ctx: AuditContext,
  input: {
    matchId: number;
    side: Side;
    action: string;
    officialPersonId: number;
    clockSeconds?: number | null;
    penaltyCode?: string | null;
    note?: string | null;
    ruleset: ScoringRuleset;
  },
  now: Date = new Date()
) {
  const { match, event, resource } = await loadMatch(db, input.matchId);
  assertCan(ctx.principal, 'result:enter', resource);

  const ruleset = requireRuleset(input.ruleset);

  if (input.side !== 'red' && input.side !== 'blue') {
    throw new MatchError('bad_side', 'A scoring action must name red or blue.');
  }
  if (match.status !== 'in_progress') {
    throw new MatchError(
      'not_scorable',
      `Points can only be recorded while a bout is in progress; this match is ${String(match.status).replace(/_/g, ' ')}.`
    );
  }

  await assertAppointed(db, event.id, input.officialPersonId, 'A scoring action');

  const rule = actionRule(ruleset, input.action);
  if (rule.penalty && !input.penaltyCode) {
    throw new MatchError('penalty_code_required', `"${input.action}" is an infringement and must carry its penalty code.`);
  }
  if (input.clockSeconds != null && (!Number.isInteger(input.clockSeconds) || input.clockSeconds < 0)) {
    throw new MatchError('bad_clock', 'The bout clock is recorded in whole seconds.');
  }

  // The resolved side: who the points are credited to. A zero-point action —
  // a warning — stays on the competitor it was signalled about, so the penalty
  // tally can still name them.
  const creditedSide: Side = rule.points > 0 && rule.awardTo === 'opponent'
    ? otherSide(input.side)
    : input.side;

  const row = await appendEvent(db, input.matchId, {
    side: creditedSide,
    action: input.action,
    points: rule.points,
    penaltyCode: input.penaltyCode ?? null,
    clockSeconds: input.clockSeconds ?? null,
    officialPersonId: input.officialPersonId,
    reversesEventId: null,
    note: input.note ?? null,
    at: now,
  });

  const { score } = await syncCachedScore(db, input.matchId, now);
  return { event: row, score };
}

/**
 * Correct a recorded action by APPENDING ITS REVERSAL.
 *
 * There is deliberately no function in this module that updates or deletes a
 * `match_events` row. A correction is a new row carrying the exact negation and
 * pointing at what it reverses, so the log still shows that the point was
 * signalled and then withdrawn — which is what an appeal actually needs to see.
 */
export async function correctMatchEvent(
  db: DB,
  ctx: AuditContext,
  input: { eventId: number; reason: string; officialPersonId: number; clockSeconds?: number | null },
  now: Date = new Date()
) {
  const original = (await db.select().from(s.matchEvents)
    .where(eq(s.matchEvents.id, input.eventId)).limit(1))[0];
  if (!original) throw new MatchError('unknown_event_row', 'Unknown match event');

  const { match, event, resource } = await loadMatch(db, original.matchId);
  assertCan(ctx.principal, 'result:enter', resource);

  if (!input.reason?.trim()) {
    throw new MatchError('reason_required', 'A correction must record why the action is being withdrawn.');
  }
  if (original.reversesEventId != null) {
    throw new MatchError('cannot_reverse_a_reversal', 'That row is itself a correction. Append a fresh action instead.');
  }

  const already = (await db.select().from(s.matchEvents)
    .where(eq(s.matchEvents.reversesEventId, input.eventId)).limit(1))[0];
  if (already) {
    throw new MatchError('already_reversed', 'That action has already been withdrawn.');
  }

  // The bout's log closes when the bout does. After that the route is a
  // protest, decided by the appointed authority, not a quiet edit at the table.
  if (match.status !== 'in_progress' && match.status !== 'paused') {
    throw new MatchError(
      'event_log_closed',
      `The event log for this match is closed (${String(match.status).replace(/_/g, ' ')}). A finalised bout is corrected through a protest, not by amending the log.`
    );
  }

  await assertAppointed(db, event.id, input.officialPersonId, 'A correction');

  const row = await appendEvent(db, original.matchId, {
    side: original.side,
    action: original.action,
    points: -(original.points ?? 0),
    penaltyCode: original.penaltyCode,
    clockSeconds: input.clockSeconds ?? original.clockSeconds,
    officialPersonId: input.officialPersonId,
    reversesEventId: original.id,
    note: input.reason.trim(),
    at: now,
  });

  const { score } = await syncCachedScore(db, original.matchId, now);

  await writeAudit(db, { ...ctx, reason: input.reason.trim() }, {
    entityType: 'match_event',
    entityId: original.id,
    action: 'update',
    oldValue: { sequence: original.sequence, side: original.side, action: original.action, points: original.points },
    newValue: { reversedBySequence: row.sequence, reversedByEventId: row.id, score },
  });

  return { reversal: row, score };
}

/**
 * The whole bout, reconstructible: every row, what still stands, and the total.
 *
 * A log that does not reconcile must still be RENDERABLE — that is precisely
 * the moment an official needs to see the rows. So the failure is reported as
 * part of the explanation rather than thrown, which would leave the panel
 * hearing the complaint with nothing at all to look at.
 */
export async function explainMatch(db: DB, matchId: number) {
  const match = (await db.select().from(s.matches).where(eq(s.matches.id, matchId)).limit(1))[0];
  if (!match) throw new MatchError('unknown_match', 'Unknown match');
  const events = await readLog(db, matchId);
  const live = liveEvents(events);
  const liveIds = new Set(live.map((e) => e.id));

  let score: MatchScore | null = null;
  let problem: string | null = null;
  try {
    score = replayScore(events);
  } catch (err) {
    if (!(err instanceof MatchError) || err.code !== 'log_inconsistent') throw err;
    problem = err.message;
  }

  return {
    match,
    score,
    consistent: problem == null,
    problem,
    cachedScore: { red: match.redScore, blue: match.blueScore },
    cacheAgrees: score != null && match.redScore === score.red && match.blueScore === score.blue,
    events: events.map((e: any) => ({
      sequence: e.sequence,
      side: e.side,
      action: e.action,
      points: e.points,
      penaltyCode: e.penaltyCode,
      clockSeconds: e.clockSeconds,
      officialPersonId: e.officialPersonId,
      reversesEventId: e.reversesEventId,
      note: e.note,
      standing: liveIds.has(e.id),
    })),
  };
}

// ─── Kata scoring ───────────────────────────────────────────────────────────

/**
 * Record one judge's kata score, in integer hundredths.
 *
 * A judge's own row is theirs alone: re-scoring before the panel result is
 * computed updates that judge's row and audits the change; it never touches
 * another judge's. The bounds come from the regulations, so a panel marking out
 * of 10.00 and a panel marking out of 5.00 are both representable without this
 * module choosing either.
 */
export async function recordKataScore(
  db: DB,
  ctx: AuditContext,
  input: {
    entryId: number;
    judgePersonId: number;
    judgePosition?: number | null;
    matchId?: number | null;
    kataId?: number | null;
    kataName?: string | null;
    /** Supply either the components the ruleset names, or an overall total. */
    technicalScore?: number | null;
    athleticScore?: number | null;
    totalScore?: number | null;
    ruleset: ScoringRuleset;
  },
  now: Date = new Date()
) {
  const ruleset = requireRuleset(input.ruleset);
  const rules = ruleset.kata;
  if (!rules) {
    throw new MatchError(
      'kata_rules_required',
      `Ruleset ${ruleset.code} carries no kata judging arrangement. The score range and the discard rule are set by the federation, not assumed here.`
    );
  }
  if (!Number.isInteger(rules.minScore) || !Number.isInteger(rules.maxScore) || rules.maxScore <= rules.minScore) {
    throw new MatchError('bad_ruleset', 'Kata bounds must be whole hundredths with a maximum above the minimum.');
  }

  const entry = (await db.select().from(s.eventEntries)
    .where(eq(s.eventEntries.id, input.entryId)).limit(1))[0];
  if (!entry) throw new MatchError('unknown_entry', 'Unknown entry');

  const event = (await db.select().from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, entry.eventId)).limit(1))[0];
  if (!event) throw new MatchError('unknown_event', 'Unknown competition event');
  assertCan(ctx.principal, 'result:enter', eventResource(event));

  await assertAppointed(db, event.id, input.judgePersonId, 'A kata score');

  if (input.matchId != null) {
    const match = (await db.select().from(s.matches).where(eq(s.matches.id, input.matchId)).limit(1))[0];
    if (!match) throw new MatchError('unknown_match', 'Unknown match');
    // The bout must be the entry's own. Otherwise a score can be filed against
    // a performance in another category — which no reader could later detect,
    // because both ids resolve.
    if (match.eventId !== entry.eventId) {
      throw new MatchError('match_not_for_entry', 'That bout belongs to a different event from this entry.');
    }
    if (match.categoryId !== entry.categoryId) {
      throw new MatchError('match_not_for_entry', 'That bout belongs to a different category from this entry.');
    }
    if (TERMINAL.includes(match.status as MatchState)) {
      throw new MatchError('event_log_closed', 'This bout is over; its kata scores can no longer be changed.');
    }
  }

  if (await kataPanelFinalised(db, input.entryId, input.matchId ?? null)) {
    throw new MatchError(
      'kata_result_computed',
      'This panel result has already been computed and its discards recorded; a mark can no longer be added or changed. A correction after that point is a protest, not an amendment at the table.'
    );
  }

  // Components are summed only when the ruleset names them — because naming
  // them is the federation saying they combine that way.
  const components = rules.components ?? [];
  let total: number;
  if (components.length > 0) {
    for (const c of components) {
      const v = c === 'technical' ? input.technicalScore : input.athleticScore;
      if (v == null) throw new MatchError('component_required', `This ruleset marks kata on ${components.join(' and ')}; the ${c} score is missing.`);
      if (!Number.isInteger(v)) throw new MatchError('bad_kata_score', `The ${c} score must be an integer in hundredths.`);
    }
    total = components.reduce((n, c) => n + Number(c === 'technical' ? input.technicalScore : input.athleticScore), 0);
  } else {
    if (input.totalScore == null) throw new MatchError('component_required', 'This ruleset marks kata on a single overall score; none was supplied.');
    if (!Number.isInteger(input.totalScore)) throw new MatchError('bad_kata_score', 'A kata score must be an integer in hundredths.');
    total = input.totalScore;
  }

  if (total < rules.minScore || total > rules.maxScore) {
    throw new MatchError(
      'kata_score_out_of_range',
      `A kata score of ${(total / 100).toFixed(2)} is outside the ${(rules.minScore / 100).toFixed(2)}–${(rules.maxScore / 100).toFixed(2)} range set by ruleset ${ruleset.code}.`
    );
  }

  const existing = (await db.select().from(s.kataScores).where(and(
    eq(s.kataScores.entryId, input.entryId),
    eq(s.kataScores.judgePersonId, input.judgePersonId),
    input.matchId == null
      ? sql`${s.kataScores.matchId} IS NULL`
      : eq(s.kataScores.matchId, input.matchId)
  )).limit(1))[0];

  if (existing) {
    const [updated] = await db.update(s.kataScores).set({
      technicalScore: input.technicalScore ?? null,
      athleticScore: input.athleticScore ?? null,
      totalScore: total,
      kataId: input.kataId ?? existing.kataId,
      kataName: input.kataName ?? existing.kataName,
      judgePosition: input.judgePosition ?? existing.judgePosition,
      at: now,
    }).where(eq(s.kataScores.id, existing.id)).returning();

    await writeAudit(db, ctx, {
      entityType: 'kata_score',
      entityId: existing.id,
      action: 'update',
      oldValue: { totalScore: existing.totalScore },
      newValue: { totalScore: total },
    });
    return updated;
  }

  const [row] = await db.insert(s.kataScores).values({
    matchId: input.matchId ?? null,
    entryId: input.entryId,
    kataId: input.kataId ?? null,
    kataName: input.kataName ?? null,
    judgePersonId: input.judgePersonId,
    judgePosition: input.judgePosition ?? null,
    technicalScore: input.technicalScore ?? null,
    athleticScore: input.athleticScore ?? null,
    totalScore: total,
    discarded: false,
    at: now,
  }).returning();

  return row;
}

/**
 * Has this panel already been totalled?
 *
 * kata_scores carries no "panel closed" column, so the finalisation is read
 * back from the audit spine — stored data, and exactly what the federation
 * would produce to show WHEN the panel closed. The discard flags are checked
 * too, since they are the other durable trace of the same act.
 *
 * Without this, a judge who had not yet marked could add a score after the
 * discards were computed and move a medal without anything being corrected.
 */
async function kataPanelFinalised(db: DB, entryId: number, matchId: number | null): Promise<boolean> {
  const audited = await db.select({ id: s.auditEvents.id }).from(s.auditEvents).where(and(
    eq(s.auditEvents.entityType, 'kata_score_panel'),
    eq(s.auditEvents.entityId, String(entryId)),
    eq(s.auditEvents.action, 'finalize'),
    matchId == null
      ? sql`${s.auditEvents.newValue}->>'matchId' IS NULL`
      : sql`${s.auditEvents.newValue}->>'matchId' = ${String(matchId)}`
  )).limit(1);
  if (audited.length) return true;

  const flagged = await db.select({ id: s.kataScores.id }).from(s.kataScores).where(and(
    eq(s.kataScores.entryId, entryId),
    eq(s.kataScores.discarded, true),
    matchId == null ? sql`${s.kataScores.matchId} IS NULL` : eq(s.kataScores.matchId, matchId)
  )).limit(1);
  return flagged.length > 0;
}

export interface KataResult {
  rulesetCode: string;
  /** Judge scores kept, in hundredths. */
  counted: Array<{ id: number; judgePersonId: number | null; judgePosition: number | null; totalScore: number }>;
  /** Judge scores set aside, and why — 'highest' or 'lowest'. */
  discarded: Array<{ id: number; judgePersonId: number | null; judgePosition: number | null; totalScore: number; as: 'highest' | 'lowest' }>;
  /** Sum of the counted scores, in hundredths. */
  total: number;
  judgesScoring: number;
}

/**
 * Apply the discard rule and total the panel.
 *
 * Ties are broken by judge position and then row id purely so the choice of
 * WHICH of two identical scores was discarded is reproducible — an arbitrary
 * pick would make the same panel produce two different explanations.
 *
 * The discard counts come from the ruleset. Where the federation has set none,
 * nothing is discarded — this module does not decide that the top and bottom
 * judge should be dropped.
 */
export function computeKataResult(scores: any[], ruleset: ScoringRuleset): KataResult {
  const rules = ruleset.kata;
  if (!rules) {
    throw new MatchError(
      'kata_rules_required',
      `Ruleset ${ruleset.code} carries no kata judging arrangement, so a panel total cannot be computed.`
    );
  }

  const high = rules.discardHighest ?? 0;
  const low = rules.discardLowest ?? 0;
  if (!Number.isInteger(high) || !Number.isInteger(low) || high < 0 || low < 0) {
    throw new MatchError('bad_ruleset', 'Kata discard counts must be non-negative whole numbers.');
  }

  const ordered = [...scores].sort((a, b) =>
    (a.totalScore ?? 0) - (b.totalScore ?? 0) ||
    (a.judgePosition ?? 0) - (b.judgePosition ?? 0) ||
    a.id - b.id
  );

  const needed = high + low + (rules.minJudges ?? 1);
  if (ordered.length < needed) {
    throw new MatchError(
      'not_enough_judges',
      `${ordered.length} judge score(s) recorded; ruleset ${ruleset.code} needs ${needed} to discard ${low} lowest and ${high} highest and still have a result.`
    );
  }

  const discarded: KataResult['discarded'] = [];
  for (let i = 0; i < low; i++) discarded.push({ ...pick(ordered[i]), as: 'lowest' });
  for (let i = 0; i < high; i++) discarded.push({ ...pick(ordered[ordered.length - 1 - i]), as: 'highest' });

  const discardedIds = new Set(discarded.map((d) => d.id));
  const counted = ordered.filter((r) => !discardedIds.has(r.id)).map(pick);

  return {
    rulesetCode: ruleset.code,
    counted,
    discarded,
    total: counted.reduce((n, r) => n + r.totalScore, 0),
    judgesScoring: ordered.length,
  };
}

function pick(r: any) {
  return {
    id: r.id,
    judgePersonId: r.judgePersonId ?? null,
    judgePosition: r.judgePosition ?? null,
    totalScore: r.totalScore ?? 0,
  };
}

/**
 * Compute a competitor's kata result and RECORD which scores were discarded.
 *
 * Persisting the discard flag is the point: "the panel gave 24.6" is not
 * explainable, "these five judges scored, the highest and the lowest were set
 * aside, and here they are" is.
 */
export async function finaliseKataScoring(
  db: DB,
  ctx: AuditContext,
  input: { entryId: number; matchId?: number | null; ruleset: ScoringRuleset },
  now: Date = new Date()
): Promise<KataResult> {
  const ruleset = requireRuleset(input.ruleset);

  const entry = (await db.select().from(s.eventEntries)
    .where(eq(s.eventEntries.id, input.entryId)).limit(1))[0];
  if (!entry) throw new MatchError('unknown_entry', 'Unknown entry');
  const event = (await db.select().from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, entry.eventId)).limit(1))[0];
  assertCan(ctx.principal, 'result:enter', eventResource(event));

  const scores = await db.select().from(s.kataScores).where(and(
    eq(s.kataScores.entryId, input.entryId),
    input.matchId == null ? sql`${s.kataScores.matchId} IS NULL` : eq(s.kataScores.matchId, input.matchId)
  ));

  const result = computeKataResult(scores, ruleset);

  for (const d of result.discarded) {
    await db.update(s.kataScores).set({ discarded: true }).where(eq(s.kataScores.id, d.id));
  }

  await writeAudit(db, ctx, {
    entityType: 'kata_score_panel',
    entityId: input.entryId,
    action: 'finalize',
    newValue: {
      ruleset: ruleset.code,
      matchId: input.matchId ?? null,        // the panel lock is read back from this
      total: result.total,
      discarded: result.discarded,
      counted: result.counted,
    },
  });

  return result;
}

// ─── Completing a bout ──────────────────────────────────────────────────────

/**
 * Senshu: the first competitor to score.
 *
 * Whether senshu decides anything is regulation, and it is only consulted when
 * the ruleset lists it as a tie-break. A point later withdrawn does not count,
 * which is exactly why the reversal is in the log rather than an edit.
 *
 * `countPenaltyPoints` has NO default, deliberately. Whether a point credited
 * by the opponent's penalty confers senshu differs between rulebooks, and a
 * default here would be this module quietly writing one of them into MMAKF's
 * regulations. The caller must say which reading it is asking about.
 */
export function senshuSide(events: any[], countPenaltyPoints: boolean): Side | null {
  for (const e of liveEvents(events)) {
    if (e.penaltyCode && !countPenaltyPoints) continue;
    if ((e.points ?? 0) > 0 && (e.side === 'red' || e.side === 'blue')) return e.side as Side;
  }
  return null;
}

/**
 * Senshu under the regulations in force, or a refusal.
 *
 * Where the federation has not stated whether penalty-awarded points confer
 * senshu, both readings are computed. If they name the same competitor the
 * question never arose and the bout is decided; if they disagree, the winner
 * would depend on a rule nobody has approved, so the bout is not decided.
 */
function senshuUnder(events: any[], ruleset: ScoringRuleset): Side | null {
  const stated = ruleset.senshuFromPenaltyPoints;
  if (stated != null) return senshuSide(events, stated);

  const counting = senshuSide(events, true);
  const notCounting = senshuSide(events, false);
  if (counting !== notCounting) {
    throw new MatchError(
      'senshu_ambiguous',
      `Senshu depends on whether a point credited by the opponent's penalty counts as scoring first — counting it gives ${counting ?? 'nobody'}, not counting it gives ${notCounting ?? 'nobody'} — and ruleset ${ruleset.code} does not say. Set senshuFromPenaltyPoints; it is not assumed here.`
    );
  }
  return notCounting;
}

export interface CompletionDecision {
  winnerEntryId: number;
  /** As stated by the referee: kiken, hansoku, hantei … */
  winMethod: string;
  reason: string;
}

/**
 * Complete a bout: determine the winner from the event log, record the win
 * method, and advance the winner into the next match.
 *
 * A tie is NOT broken by this module on its own initiative. If the regulations
 * in force list no tie-break, the bout is refused completion and says so —
 * declaring a winner of a drawn bout under a rule nobody approved is exactly
 * the failure this codebase exists to prevent.
 */
export async function completeMatch(
  db: DB,
  ctx: AuditContext,
  input: { matchId: number; ruleset: ScoringRuleset; decision?: CompletionDecision },
  now: Date = new Date()
) {
  const { match, resource } = await loadMatch(db, input.matchId);
  assertCan(ctx.principal, 'result:enter', resource);

  const ruleset = requireRuleset(input.ruleset);
  assertTransition(match.status as MatchState, 'completed');

  const events = await readLog(db, input.matchId);
  const score = replayScore(events);

  let winnerEntryId: number | null = null;
  let winMethod: string;

  if (input.decision) {
    // A referee's stated decision — withdrawal, disqualification, a judges'
    // vote. Recorded as stated, never recomputed, and it carries its reason.
    if (!input.decision.reason?.trim()) {
      throw new MatchError('reason_required', 'A stated decision must record why it was made.');
    }
    if (!input.decision.winMethod?.trim()) {
      throw new MatchError('win_method_required', 'A stated decision must record the win method.');
    }
    if (!sideOf(match, input.decision.winnerEntryId)) {
      throw new MatchError('winner_not_in_match', 'That entry is not a competitor in this match.');
    }
    winnerEntryId = input.decision.winnerEntryId;
    winMethod = input.decision.winMethod.trim();
  } else {
    // An action the regulations say ends the bout outright settles it.
    const ended = liveEvents(events)
      .map((e) => ({ e, rule: ruleset.actions[e.action] }))
      .filter((x) => x.rule?.endsMatch)
      .pop();

    if (ended) {
      // The row stores the side the POINTS were credited to. For a scoring
      // action that is already the competitor the bout is awarded to, but an
      // ending action carrying no points stores the competitor it was signalled
      // ABOUT — so the signalled side is recovered first and `awardTo` applied
      // to it. Without this inversion a 0-point shikkaku crowns the offender.
      const rule = ended.rule!;
      if (!rule.awardTo) {
        throw new MatchError(
          'bad_ruleset',
          `Action "${ended.e.action}" ended the bout but ruleset ${ruleset.code} does not say which competitor it is awarded to.`
        );
      }
      const signalled: Side = rule.points > 0 && rule.awardTo === 'opponent'
        ? otherSide(ended.e.side as Side)
        : (ended.e.side as Side);
      const side: Side = rule.awardTo === 'opponent' ? otherSide(signalled) : signalled;
      winnerEntryId = side === 'red' ? match.redEntryId : match.blueEntryId;
      winMethod = rule.winMethod ?? ended.e.action;
    } else if (score.red !== score.blue) {
      const side: Side = score.red > score.blue ? 'red' : 'blue';
      winnerEntryId = side === 'red' ? match.redEntryId : match.blueEntryId;
      winMethod = 'points';
    } else {
      winMethod = '';
      for (const rule of ruleset.tieBreak ?? []) {
        if (rule === 'senshu') {
          const side = senshuUnder(events, ruleset);
          if (side) {
            winnerEntryId = side === 'red' ? match.redEntryId : match.blueEntryId;
            winMethod = 'senshu';
            break;
          }
        } else if (rule === 'hantei') {
          // Hantei is a judges' vote. It is a decision, not a computation, so
          // it must arrive as one.
          throw new MatchError(
            'hantei_required',
            `The bout is level at ${score.red}-${score.blue} and ruleset ${ruleset.code} decides it by hantei. Record the judges' decision explicitly.`
          );
        }
      }
      if (!winnerEntryId) {
        throw new MatchError(
          'tie_unresolved',
          `The bout is level at ${score.red}-${score.blue} and ruleset ${ruleset.code} sets no tie-break that resolves it. The result cannot be determined from the record.`
        );
      }
    }
  }

  if (winnerEntryId == null) {
    throw new MatchError('winner_undetermined', 'The winner could not be determined from the event log.');
  }

  const durationSeconds = match.startedAt
    ? Math.max(0, Math.round((now.getTime() - new Date(match.startedAt).getTime()) / 1000))
    : match.durationSeconds;

  const [row] = await db.update(s.matches).set({
    status: 'completed',
    endedAt: now,
    durationSeconds,
    redScore: score.red,
    blueScore: score.blue,
    redPenalties: score.penalties.red,
    bluePenalties: score.penalties.blue,
    winnerEntryId,
    winMethod,
    updatedAt: now,
  }).where(eq(s.matches.id, input.matchId)).returning();

  await writeAudit(db, { ...ctx, reason: input.decision?.reason ?? ctx.reason ?? null }, {
    entityType: 'match',
    entityId: input.matchId,
    action: 'finalize',
    oldValue: { status: match.status, redScore: match.redScore, blueScore: match.blueScore },
    newValue: {
      status: 'completed',
      score: { red: score.red, blue: score.blue },
      winnerEntryId,
      winMethod,
      ruleset: ruleset.code,
      stated: Boolean(input.decision),
    },
  });

  const advanced = await advanceWinner(db, ctx, row, winnerEntryId, now);
  return { match: row, score, winnerEntryId, winMethod, advancedTo: advanced };
}

/**
 * Put the winner into the next match, where the draw says one exists.
 *
 * Progression is data set by the draw, not arithmetic done at the table. The
 * slot is refused if it already holds someone else, and refused outright once
 * the next bout has begun — quietly swapping a competitor into a match already
 * under way is not a recoverable mistake.
 */
async function advanceWinner(db: DB, ctx: AuditContext, match: any, winnerEntryId: number, now: Date) {
  if (match.advancesToMatchId == null) return null;

  const slot = match.advancesToSlot;
  if (slot !== 'red' && slot !== 'blue') {
    throw new MatchError(
      'no_advance_slot',
      `Match ${match.matchNo} advances to another match but the draw does not say into which side.`
    );
  }

  const next = (await db.select().from(s.matches)
    .where(eq(s.matches.id, match.advancesToMatchId)).limit(1))[0];
  if (!next) throw new MatchError('unknown_match', 'The match this one advances to does not exist.');

  const occupant = slot === 'red' ? next.redEntryId : next.blueEntryId;
  if (occupant === winnerEntryId) return next;                 // idempotent retry
  if (occupant != null) {
    throw new MatchError('slot_occupied', `The ${slot} side of match ${next.matchNo} is already taken by another entry.`);
  }
  if (next.status !== 'scheduled' && next.status !== 'called') {
    throw new MatchError('next_match_started', `Match ${next.matchNo} is already ${String(next.status).replace(/_/g, ' ')}; a competitor cannot be placed into it now.`);
  }

  const [updated] = await db.update(s.matches)
    .set(slot === 'red' ? { redEntryId: winnerEntryId, updatedAt: now } : { blueEntryId: winnerEntryId, updatedAt: now })
    .where(eq(s.matches.id, next.id))
    .returning();

  await writeAudit(db, ctx, {
    entityType: 'match',
    entityId: next.id,
    action: 'update',
    oldValue: { [`${slot}EntryId`]: null },
    newValue: { [`${slot}EntryId`]: winnerEntryId, from: match.matchNo },
  });

  return updated;
}

// ─── Results ────────────────────────────────────────────────────────────────

const TERMINAL_FOR_RESULTS: MatchState[] = ['completed', 'walkover', 'disqualification', 'cancelled'];

/**
 * Compute a category's placings from the bracket and LOCK them.
 *
 * The winner and the runner-up fall out of the structure: whoever contests the
 * deciding bout is first and second. EVERYTHING BELOW THAT IS POLICY — whether
 * both semi-final losers take third, or a play-off separates third from fourth,
 * or fifth places are awarded at all — so it comes from `ruleset.placings`. If
 * a round has no rule, the whole finalisation is refused and names the rounds
 * that are missing, rather than inventing a convention and stamping it FINAL.
 */
export async function finaliseResults(
  db: DB,
  ctx: AuditContext,
  input: { categoryId: number; ruleset: ScoringRuleset },
  now: Date = new Date()
) {
  const ruleset = requireRuleset(input.ruleset);

  const category = (await db.select().from(s.eventCategories)
    .where(eq(s.eventCategories.id, input.categoryId)).limit(1))[0];
  if (!category) throw new MatchError('unknown_category', 'Unknown event category');

  const event = (await db.select().from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, category.eventId)).limit(1))[0];
  if (!event) throw new MatchError('unknown_event', 'Unknown competition event');
  assertCan(ctx.principal, 'result:finalize', eventResource(event));

  const existing = await db.select().from(s.competitionResults)
    .where(eq(s.competitionResults.categoryId, input.categoryId));
  if (existing.some((r: any) => r.status === 'final' || r.status === 'corrected')) {
    throw new MatchError(
      'already_finalised',
      'The results for this category are already final. A change is made by correcting the result, which supersedes it and records who authorised it.'
    );
  }
  // Provisional or voided rows are still rows: finalising over them would leave
  // two placings for the same competitor with nothing to say which stands.
  if (existing.length) {
    throw new MatchError(
      'results_exist',
      `This category already carries ${existing.length} result row(s) (${[...new Set(existing.map((r: any) => r.status))].join(', ')}). They must be resolved before a final set is written.`
    );
  }

  const rules = ruleset.placings;
  if (!rules) {
    throw new MatchError(
      'placing_rules_required',
      `Ruleset ${ruleset.code} carries no placing rules. What placing a beaten competitor receives is federation policy and is not assumed here.`
    );
  }

  const all = await db.select().from(s.matches)
    .where(eq(s.matches.categoryId, input.categoryId))
    .orderBy(asc(s.matches.roundOrder), asc(s.matches.id));
  if (all.length === 0) {
    throw new MatchError('no_matches', 'This category has no matches, so it has no result.');
  }

  const unfinished = all.filter((m: any) => !TERMINAL_FOR_RESULTS.includes(m.status));
  if (unfinished.length) {
    throw new MatchError(
      'matches_incomplete',
      `${unfinished.length} match(es) are not finished: ${unfinished.map((m: any) => `${m.matchNo} (${m.status})`).join(', ')}.`
    );
  }

  const played = all.filter((m: any) => m.status !== 'cancelled');
  if (played.length === 0) throw new MatchError('no_matches', 'Every match in this category was cancelled; there is no result.');

  const playoffRounds = rules.playoffRounds ?? {};
  const placings = new Map<number, number>();   // entryId → placing

  // The deciding bout: named by the regulations, or the last match that is not
  // a play-off. If that is ambiguous the bracket has to be stated explicitly
  // rather than guessed at.
  const contenders = rules.finalRound
    ? played.filter((m: any) => m.round === rules.finalRound)
    : (() => {
        const notPlayoff = played.filter((m: any) => !(m.round in playoffRounds));
        const top = Math.max(...notPlayoff.map((m: any) => m.roundOrder ?? 0));
        return notPlayoff.filter((m: any) => (m.roundOrder ?? 0) === top);
      })();

  if (contenders.length !== 1) {
    throw new MatchError(
      'final_ambiguous',
      `The deciding bout could not be identified: ${contenders.length} matches qualify. Name it with placings.finalRound.`
    );
  }
  const final = contenders[0];
  if (final.winnerEntryId == null) {
    throw new MatchError('final_undecided', `The deciding bout ${final.matchNo} records no winner.`);
  }
  placings.set(final.winnerEntryId, 1);
  const runnerUp = final.redEntryId === final.winnerEntryId ? final.blueEntryId : final.redEntryId;
  if (runnerUp != null) placings.set(runnerUp, 2);

  for (const m of played) {
    const rule = playoffRounds[m.round];
    if (!rule) continue;
    if (m.winnerEntryId == null) {
      throw new MatchError('playoff_undecided', `Play-off ${m.matchNo} records no winner.`);
    }
    const loser = m.redEntryId === m.winnerEntryId ? m.blueEntryId : m.redEntryId;
    placings.set(m.winnerEntryId, rule.winner);
    if (loser != null) placings.set(loser, rule.loser);
  }

  // Everyone else is placed by the round in which they were beaten.
  const entryIds = new Set<number>();
  for (const m of played) {
    if (m.redEntryId != null) entryIds.add(m.redEntryId);
    if (m.blueEntryId != null) entryIds.add(m.blueEntryId);
  }

  const missingRounds = new Set<string>();
  const undetermined: number[] = [];
  for (const entryId of entryIds) {
    if (placings.has(entryId)) continue;
    const losses = played.filter((m: any) =>
      sideOf(m, entryId) && m.winnerEntryId != null && m.winnerEntryId !== entryId);
    if (losses.length === 0) {
      undetermined.push(entryId);
      continue;
    }
    const exit = losses.reduce((a: any, b: any) => ((b.roundOrder ?? 0) >= (a.roundOrder ?? 0) ? b : a));
    const placing = rules.losersPlacing?.[exit.round];
    if (placing == null) { missingRounds.add(exit.round); continue; }
    placings.set(entryId, placing);
  }

  if (missingRounds.size) {
    throw new MatchError(
      'placing_not_set',
      `Ruleset ${ruleset.code} does not say what placing the loser of ${[...missingRounds].join(', ')} receives. The federation must set it; it is not assumed here.`
    );
  }
  if (undetermined.length) {
    throw new MatchError(
      'placing_undetermined',
      `${undetermined.length} competitor(s) lost no match and did not contest the deciding bout, so their placing cannot be derived from this bracket.`
    );
  }

  // Per-competitor record. The figures come from the EVENT LOG, replayed, not
  // from matches.redScore/blueScore — this module's own contract is that the
  // cached scoreboard can drift, and a locked official record must not be built
  // on a number nobody can reconstruct. Where a bout has no log at all (a
  // walkover, a bye) there is nothing to replay and the recorded score stands.
  // Where it HAS a log and the two disagree, the whole finalisation stops and
  // names the bout, rather than stamping FINAL on a figure under dispute.
  const scoreOf = new Map<number, { red: number; blue: number }>();
  for (const m of played) {
    const log = await readLog(db, m.id);
    if (log.length === 0) {
      scoreOf.set(m.id, { red: m.redScore, blue: m.blueScore });
      continue;
    }
    const replayed = replayScore(log);
    if (replayed.red !== m.redScore || replayed.blue !== m.blueScore) {
      throw new MatchError(
        'score_unreconciled',
        `Match ${m.matchNo} is recorded as ${m.redScore}-${m.blueScore} but its event log replays to ${replayed.red}-${replayed.blue}. The record cannot be finalised until that is explained; reconcileMatchScore() reports the difference.`
      );
    }
    scoreOf.set(m.id, { red: replayed.red, blue: replayed.blue });
  }

  const stats = new Map<number, { won: number; lost: number; pf: number; pa: number }>();
  for (const entryId of entryIds) stats.set(entryId, { won: 0, lost: 0, pf: 0, pa: 0 });
  for (const m of played) {
    const sc = scoreOf.get(m.id)!;
    for (const side of ['red', 'blue'] as Side[]) {
      const entryId = side === 'red' ? m.redEntryId : m.blueEntryId;
      if (entryId == null) continue;
      const st = stats.get(entryId)!;
      st.pf += side === 'red' ? sc.red : sc.blue;
      st.pa += side === 'red' ? sc.blue : sc.red;
      if (m.winnerEntryId === entryId) st.won++;
      else if (m.winnerEntryId != null) st.lost++;
    }
  }

  const entries = await db.select().from(s.eventEntries)
    .where(eq(s.eventEntries.categoryId, input.categoryId));
  const personByEntry = new Map<number, number | null>(entries.map((e: any) => [e.id, e.personId ?? null]));

  const rows = [...placings.entries()]
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([entryId, placing]) => {
      const st = stats.get(entryId)!;
      return {
        eventId: category.eventId,
        categoryId: input.categoryId,
        entryId,
        personId: personByEntry.get(entryId) ?? null,
        placing,
        medal: rules.medals?.[String(placing)] ?? null,
        matchesWon: st.won,
        matchesLost: st.lost,
        pointsFor: st.pf,
        pointsAgainst: st.pa,
        status: 'final' as const,
        finalisedAt: now,
        finalisedByUserId: ctx.principal.userId ?? null,
      };
    });

  const written = await db.insert(s.competitionResults).values(rows).returning();

  await writeAudit(db, ctx, {
    entityType: 'competition_result_set',
    entityId: input.categoryId,
    action: 'finalize',
    newValue: {
      ruleset: ruleset.code,
      finalMatch: final.matchNo,
      placings: rows.map((r) => ({ entryId: r.entryId, placing: r.placing, medal: r.medal })),
    },
  });

  return written;
}

/**
 * Correct a locked result.
 *
 * The original row is NEVER written to. A correction is a new row pointing back
 * at what it supersedes, carrying the reason and the user who authorised it;
 * `officialResults()` then reads the head of each chain. A result that could be
 * edited in place would make the federation's history unfalsifiable, which is
 * the same as having no history.
 */
export async function correctResult(
  db: DB,
  ctx: AuditContext,
  input: {
    resultId: number;
    reason: string;
    authorisedByUserId: number;
    placing?: number;
    medal?: 'gold' | 'silver' | 'bronze' | 'participation' | null;
    matchesWon?: number;
    matchesLost?: number;
    pointsFor?: number;
    pointsAgainst?: number;
    /** Void the placing entirely (a disqualification after the fact). */
    void?: boolean;
  },
  now: Date = new Date()
) {
  const original = (await db.select().from(s.competitionResults)
    .where(eq(s.competitionResults.id, input.resultId)).limit(1))[0];
  if (!original) throw new MatchError('unknown_result', 'Unknown result');

  const event = (await db.select().from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, original.eventId)).limit(1))[0];
  assertCan(ctx.principal, 'result:finalize', eventResource(event));

  if (!input.reason?.trim()) {
    throw new MatchError('reason_required', 'A correction to an official result requires a reason.');
  }
  if (input.authorisedByUserId == null) {
    throw new MatchError('authority_required', 'A correction to an official result requires the user who authorised it.');
  }
  // Two-person control (IMPLEMENTATION-QUEUE Q-25): the person keying the
  // correction cannot also be the authority for it.
  if (ctx.principal.userId != null && input.authorisedByUserId === ctx.principal.userId) {
    throw new MatchError(
      'second_person_required',
      'A result correction must be authorised by a second person; the user making it cannot authorise their own correction.'
    );
  }
  if (original.status === 'provisional') {
    throw new MatchError('not_final', 'That result is not final yet, so there is nothing to supersede.');
  }

  const superseded = (await db.select().from(s.competitionResults)
    .where(eq(s.competitionResults.supersedesResultId, input.resultId)).limit(1))[0];
  if (superseded) {
    throw new MatchError('already_superseded', `That result has already been corrected by result ${superseded.id}. Correct the current one.`);
  }

  const [row] = await db.insert(s.competitionResults).values({
    eventId: original.eventId,
    categoryId: original.categoryId,
    entryId: original.entryId,
    personId: original.personId,
    placing: input.placing ?? original.placing,
    medal: input.void ? null : (input.medal === undefined ? original.medal : input.medal),
    matchesWon: input.matchesWon ?? original.matchesWon,
    matchesLost: input.matchesLost ?? original.matchesLost,
    pointsFor: input.pointsFor ?? original.pointsFor,
    pointsAgainst: input.pointsAgainst ?? original.pointsAgainst,
    status: input.void ? 'voided' : 'corrected',
    finalisedAt: now,
    finalisedByUserId: ctx.principal.userId ?? null,
    supersedesResultId: original.id,
    correctionReason: input.reason.trim(),
    correctionAuthorisedByUserId: input.authorisedByUserId,
  }).returning();

  await writeAudit(db, { ...ctx, reason: input.reason.trim(), authority: String(input.authorisedByUserId) }, {
    entityType: 'competition_result',
    entityId: original.id,
    action: 'update',
    oldValue: { placing: original.placing, medal: original.medal, status: original.status },
    newValue: { supersededByResultId: row.id, placing: row.placing, medal: row.medal, status: row.status },
  });

  return row;
}

/**
 * The results that currently stand: the head of every supersession chain, with
 * the chain that produced them so a change is visible rather than invisible.
 */
export async function officialResults(db: DB, categoryId: number) {
  const rows = await db.select().from(s.competitionResults)
    .where(eq(s.competitionResults.categoryId, categoryId));

  const supersededIds = new Set(rows.filter((r: any) => r.supersedesResultId != null).map((r: any) => r.supersedesResultId));
  return rows
    .filter((r: any) => !supersededIds.has(r.id))
    .sort((a: any, b: any) => a.placing - b.placing || a.entryId - b.entryId)
    .map((r: any) => ({
      ...r,
      corrected: r.supersedesResultId != null,
      supersedes: r.supersedesResultId ?? null,
    }));
}

// ─── Protests ───────────────────────────────────────────────────────────────

/**
 * Lodge a protest.
 *
 * Whether a protest carries a fee, and how much, is a competition regulation —
 * so no amount is invented here. The caller states whether a fee is due and
 * attaches the order once one exists; until then the protest sits at
 * `fee_pending` rather than being silently treated as validly lodged.
 */
export async function lodgeProtest(
  db: DB,
  ctx: AuditContext,
  input: {
    eventId: number;
    matchId?: number | null;
    categoryId?: number | null;
    lodgedByPersonId: number;
    onBehalfOfEntryId?: number | null;
    grounds: string;
    feeRequired?: boolean;
    feeOrderId?: number | null;
  },
  now: Date = new Date()
) {
  const event = (await db.select().from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, input.eventId)).limit(1))[0];
  if (!event) throw new MatchError('unknown_event', 'Unknown competition event');
  assertCan(ctx.principal, 'competition:read', eventResource(event));

  // Filing in somebody else's name is an OFFICIAL act — a protest handed in at
  // the table and keyed by the tatami manager — not something every holder of
  // competition:read may do. Without this, a protest could be attributed to a
  // person who never made one; and since only the lodger may withdraw it, it
  // would also be out of their hands.
  if (input.lodgedByPersonId == null) {
    throw new MatchError('lodger_required', 'A protest must record who lodged it.');
  }
  const lodgingFor = await principalPersonId(db, ctx);
  if (lodgingFor == null || lodgingFor !== input.lodgedByPersonId) {
    assertCan(ctx.principal, 'result:finalize', eventResource(event));
  }

  if (!input.grounds?.trim()) {
    throw new MatchError('grounds_required', 'A protest must state its grounds.');
  }

  let match: any = null;
  if (input.matchId != null) {
    match = (await db.select().from(s.matches).where(eq(s.matches.id, input.matchId)).limit(1))[0];
    if (!match) throw new MatchError('unknown_match', 'Unknown match');
    if (match.eventId !== input.eventId) {
      throw new MatchError('match_not_in_event', 'That match does not belong to this event.');
    }
  }

  const status = input.feeRequired && input.feeOrderId == null ? 'fee_pending' : 'lodged';

  const [row] = await db.insert(s.protests).values({
    eventId: input.eventId,
    matchId: input.matchId ?? null,
    categoryId: input.categoryId ?? match?.categoryId ?? null,
    lodgedByPersonId: input.lodgedByPersonId,
    onBehalfOfEntryId: input.onBehalfOfEntryId ?? null,
    grounds: input.grounds.trim(),
    status,
    feeOrderId: input.feeOrderId ?? null,
    lodgedAt: now,
  }).returning();

  // A completed bout under protest is flagged as such, so the scoreboard and
  // any downstream reader can see the result is not yet settled.
  if (match && match.status === 'completed') {
    assertTransition('completed', 'under_protest');
    await db.update(s.matches).set({ status: 'under_protest', updatedAt: now })
      .where(eq(s.matches.id, match.id));
  }

  await writeAudit(db, { ...ctx, reason: input.grounds.trim() }, {
    entityType: 'protest',
    entityId: row.id,
    action: 'create',
    newValue: { eventId: input.eventId, matchId: input.matchId ?? null, status },
  });

  return row;
}

/**
 * Decide a protest.
 *
 * Upholding a protest does NOT rewrite the result. It records that the panel
 * found for the protester; changing a locked result is a separate, separately
 * authorised act through correctResult(), so the decision and the amendment are
 * two entries in the record rather than one silent one.
 */
export async function decideProtest(
  db: DB,
  ctx: AuditContext,
  input: {
    protestId: number;
    outcome: 'upheld' | 'dismissed' | 'withdrawn';
    decision: string;
    decidedByPersonId?: number | null;
  },
  now: Date = new Date()
) {
  const protest = (await db.select().from(s.protests)
    .where(eq(s.protests.id, input.protestId)).limit(1))[0];
  if (!protest) throw new MatchError('unknown_protest', 'Unknown protest');

  const event = (await db.select().from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, protest.eventId)).limit(1))[0];
  if (!event) throw new MatchError('unknown_event', 'Unknown competition event');

  // Resolved from the caller's OWN account, never from a person id they
  // supplied — otherwise acting as somebody else would be a matter of typing
  // their number.
  const me = await principalPersonId(db, ctx);

  if (input.outcome === 'withdrawn') {
    // Only the person who lodged it may withdraw it; anyone else needs the
    // authority to decide it.
    const isLodger = me != null && me === protest.lodgedByPersonId;
    if (isLodger) assertCan(ctx.principal, 'competition:read', eventResource(event));
    else assertCan(ctx.principal, 'result:finalize', eventResource(event));
  } else {
    assertCan(ctx.principal, 'result:finalize', eventResource(event));
  }

  if (!input.decision?.trim()) {
    throw new MatchError('decision_required', 'A protest decision must record its reasoning.');
  }
  if (['upheld', 'dismissed', 'withdrawn'].includes(protest.status)) {
    throw new MatchError('already_decided', `This protest was already ${protest.status}.`);
  }
  if (protest.status === 'fee_pending') {
    throw new MatchError('fee_pending', 'The protest fee required by the regulations has not been recorded against this protest.');
  }

  // ATTRIBUTION. A decision recorded against a name is evidence about that
  // person, so it may not be pointed at somebody who had no part in it: a
  // withdrawal belongs to the lodger (or the official who took it), and a jury
  // decision to an official this event actually appointed.
  let decidedByPersonId = input.decidedByPersonId ?? null;
  if (input.outcome === 'withdrawn') {
    if (decidedByPersonId != null
      && decidedByPersonId !== protest.lodgedByPersonId
      && decidedByPersonId !== me) {
      throw new MatchError(
        'withdrawal_attribution',
        'A withdrawal is recorded against the person who lodged the protest, or the official who accepted it — not a third party.'
      );
    }
    decidedByPersonId = decidedByPersonId ?? me ?? protest.lodgedByPersonId;
  } else if (decidedByPersonId != null && decidedByPersonId !== me) {
    await assertAppointed(db, event.id, decidedByPersonId, 'A protest decision');
  }

  const [row] = await db.update(s.protests).set({
    status: input.outcome,
    decision: input.decision.trim(),
    decidedByPersonId,
    decidedAt: now,
  }).where(eq(s.protests.id, input.protestId)).returning();

  if (protest.matchId != null) {
    const match = (await db.select().from(s.matches).where(eq(s.matches.id, protest.matchId)).limit(1))[0];
    if (match?.status === 'under_protest') {
      assertTransition('under_protest', 'completed');
      await db.update(s.matches).set({ status: 'completed', updatedAt: now })
        .where(eq(s.matches.id, match.id));
    }
  }

  await writeAudit(db, { ...ctx, reason: input.decision.trim() }, {
    entityType: 'protest',
    entityId: input.protestId,
    action: input.outcome === 'upheld' ? 'approve' : 'reject',
    oldValue: { status: protest.status },
    newValue: { status: input.outcome, decidedByPersonId },
  });

  return row;
}
