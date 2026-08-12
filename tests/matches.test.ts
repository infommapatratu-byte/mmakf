// Match lifecycle, live scoring and result finalisation, against real Postgres.
//
// The invariants these tests exist to protect:
//   · the event log is the record of truth and the cached score cannot drift;
//   · a correction APPENDS a reversal and never edits history;
//   · a locked result is superseded, never rewritten;
//   · no point value, tie-break, discard rule or placing is ever assumed.
//
// EVERY RULESET IN THIS FILE IS A TEST FIXTURE, NOT MMAKF POLICY. The point
// values below are chosen to exercise the code; the federation's own
// regulations are configuration it supplies, and nothing here asserts what they
// should contain.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, asc, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  MatchError, transitionMatch, allowedTransitions, recordMatchEvent, correctMatchEvent,
  scoreFromLog, replayScore, reconcileMatchScore, explainMatch, senshuSide,
  recordKataScore, computeKataResult, finaliseKataScoring,
  completeMatch, finaliseResults, correctResult, officialResults,
  lodgeProtest, decideProtest, requireRuleset, sideOf,
  type ScoringRuleset,
} from '../src/db/matches';
import type { Principal } from '../src/lib/rbac';

let db: any, JH: number, OTHER_STATE: number, DOJO: number, EVT: number;
let REF_P: number, J1: number, J2: number, J3: number, J4: number, J5: number, OUTSIDER_P: number;
let LODGER_P: number, ATHLETE_P: number;

const NOW = new Date('2026-08-12T10:00:00Z');

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const referee: Principal = {
  userId: 2, label: 'referee',
  bindings: [{ role: 'REFEREE', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 3, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
const otherStateAdmin: Principal = {
  userId: 4, label: 'state-admin-elsewhere',
  bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: -1 }],
};
/** The team manager who actually lodges the protests, resolved via user 9. */
const lodger: Principal = {
  userId: 9, label: 'team-manager',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
/** A second national admin, so two-person control on corrections is testable. */
const secondAdmin: Principal = {
  userId: 5, label: 'federation-admin-2',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};

// ── Fixture rulesets. Test values only — see the file header. ───────────────

const RULES: ScoringRuleset = {
  code: 'TEST-RULES-A',
  actions: {
    yuko: { points: 1, awardTo: 'signalled' },
    waza_ari: { points: 2, awardTo: 'signalled' },
    ippon: { points: 3, awardTo: 'signalled' },
    chukoku: { points: 0, penalty: true },
    hansoku: { points: 3, awardTo: 'opponent', penalty: true, endsMatch: true, winMethod: 'hansoku' },
  },
  tieBreak: ['senshu'],
  kata: { minScore: 500, maxScore: 1000, discardHighest: 1, discardLowest: 1, minJudges: 3 },
  placings: {
    losersPlacing: { SF: 3 },
    medals: { '1': 'gold', '2': 'silver', '3': 'bronze' },
  },
};

/** Same actions, but the federation has set no tie-break. */
const RULES_NO_TIEBREAK: ScoringRuleset = { ...RULES, code: 'TEST-RULES-B', tieBreak: undefined };

/** Same actions, but no placing policy at all. */
const RULES_NO_PLACINGS: ScoringRuleset = { ...RULES, code: 'TEST-RULES-C', placings: undefined };

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

async function makePerson(name: string) {
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${uniq()}`, fullName: name,
    stateUnitId: JH, dojoId: DOJO, status: 'active',
  }).returning();
  return p.id as number;
}

async function makeCategory(label = 'Cadet Male Kumite -61kg') {
  const [cat] = await db.insert(s.eventCategories).values({
    eventId: EVT, code: `CAT-${uniq()}`, label, discipline: 'kumite',
  }).returning();
  const [draw] = await db.insert(s.draws).values({
    categoryId: cat.id, format: 'single_elimination', entryCount: 4, algorithmVersion: 'test-1',
  }).returning();
  return { categoryId: cat.id as number, drawId: draw.id as number };
}

async function makeEntry(categoryId: number, name: string) {
  const personId = await makePerson(name);
  const [e] = await db.insert(s.eventEntries).values({
    entryNo: `MMAKF-ENT-2026-${uniq()}`, eventId: EVT, categoryId,
    personId, dojoId: DOJO, stateUnitId: JH, status: 'confirmed',
  }).returning();
  return e.id as number;
}

async function makeMatch(over: Record<string, unknown>) {
  const [m] = await db.insert(s.matches).values({
    eventId: EVT, matchNo: `M-${uniq()}`, round: 'F', roundOrder: 10, ...over,
  }).returning();
  return m;
}

/** A bout with both competitors, already in progress. */
async function liveMatch() {
  const { categoryId, drawId } = await makeCategory();
  const red = await makeEntry(categoryId, 'Red Competitor');
  const blue = await makeEntry(categoryId, 'Blue Competitor');
  let match = await makeMatch({ categoryId, drawId, redEntryId: red, blueEntryId: blue });
  await transitionMatch(db, { principal: national }, { matchId: match.id, to: 'called' }, NOW);
  match = await transitionMatch(db, { principal: national }, { matchId: match.id, to: 'in_progress' }, NOW);
  return { match, red, blue, categoryId, drawId };
}

const score = (m: any) => `${m.redScore}-${m.blueScore}`;
const reload = async (id: number) =>
  (await db.select().from(s.matches).where(eq(s.matches.id, id)).limit(1))[0];

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'ST-JH', state: 'Jharkhand', name: 'JH', status: 'active' }).returning();
  JH = jh.id;
  const [other] = await db.insert(s.stateUnits)
    .values({ code: 'ST-XX', state: 'Elsewhere', name: 'XX', status: 'active' }).returning();
  OTHER_STATE = other.id;
  const [d] = await db.insert(s.dojos)
    .values({ code: 'DJ-1', name: 'Hombu', stateUnitId: JH, status: 'active' }).returning();
  DOJO = d.id;

  const [ev] = await db.insert(s.competitionEvents).values({
    code: 'MMAKF-EVT-2026-000001', title: 'National Championship',
    kind: 'national_championship', status: 'live',
    startsOn: '2026-08-12', stateUnitId: JH, rulesetVersion: 'TEST-RULES-A',
  }).returning();
  EVT = ev.id;

  REF_P = await makePerson('Appointed Referee');
  J1 = await makePerson('Judge One');
  J2 = await makePerson('Judge Two');
  J3 = await makePerson('Judge Three');
  J4 = await makePerson('Judge Four');
  J5 = await makePerson('Judge Five');
  OUTSIDER_P = await makePerson('Not Appointed');
  LODGER_P = await makePerson('Team Manager');

  await db.insert(s.eventOfficials).values([
    { eventId: EVT, personId: REF_P, role: 'referee' },
    { eventId: EVT, personId: J1, role: 'judge' },
    { eventId: EVT, personId: J2, role: 'judge' },
    { eventId: EVT, personId: J3, role: 'judge' },
    { eventId: EVT, personId: J4, role: 'judge' },
    { eventId: EVT, personId: J5, role: 'judge' },
  ]);

  // The lodger's account, so a protest withdrawal can be checked against the
  // caller's OWN person rather than one they typed in.
  await db.insert(s.users).values({ id: 9, personId: LODGER_P, email: 'manager@example.test' });

  // The athlete principal gets an account too, so "lodging in somebody else's
  // name" can be attacked by a caller who genuinely is somebody.
  ATHLETE_P = await makePerson('Competing Athlete');
  await db.insert(s.users).values({ id: 3, personId: ATHLETE_P, email: 'athlete@example.test' });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the state machine refuses illegal transitions', () => {
  it('runs scheduled → called → in progress and stamps the start', async () => {
    const { match } = await liveMatch();
    expect(match.status).toBe('in_progress');
    expect(match.startedAt).toBeTruthy();
  });

  it('ATTACK: a scheduled bout cannot jump straight to in progress', async () => {
    const { categoryId, drawId } = await makeCategory();
    const red = await makeEntry(categoryId, 'A'), blue = await makeEntry(categoryId, 'B');
    const m = await makeMatch({ categoryId, drawId, redEntryId: red, blueEntryId: blue });
    await expect(transitionMatch(db, { principal: national }, { matchId: m.id, to: 'in_progress' }, NOW))
      .rejects.toThrow(/cannot move to in progress/i);
  });

  it('ATTACK: a completed bout cannot be restarted', async () => {
    const { match } = await liveMatch();
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'ippon', officialPersonId: REF_P, clockSeconds: 12, ruleset: RULES,
    }, NOW);
    await completeMatch(db, { principal: national }, { matchId: match.id, ruleset: RULES }, NOW);

    await expect(transitionMatch(db, { principal: national }, { matchId: match.id, to: 'in_progress' }, NOW))
      .rejects.toThrow(/cannot move to in progress/i);
  });

  it('ATTACK: a cancelled bout is final — it has no exits at all', async () => {
    expect(allowedTransitions('cancelled')).toEqual([]);
    const { match } = await liveMatch();
    await transitionMatch(db, { principal: national }, {
      matchId: match.id, to: 'cancelled', reason: 'mat closed by the technical delegate',
    }, NOW);
    await expect(transitionMatch(db, { principal: national }, { matchId: match.id, to: 'called' }, NOW))
      .rejects.toThrow(/this state is final/i);
  });

  it('refuses to complete a bout through the generic transition', async () => {
    const { match } = await liveMatch();
    await expect(transitionMatch(db, { principal: national }, { matchId: match.id, to: 'completed' }, NOW))
      .rejects.toThrow(/completeMatch/);
  });

  it('a terminal transition demands a reason', async () => {
    const { match } = await liveMatch();
    await expect(transitionMatch(db, { principal: national }, { matchId: match.id, to: 'cancelled' }, NOW))
      .rejects.toThrow(/requires a reason/i);
  });

  it('ATTACK: a walkover must name who advances, and cannot name a stranger', async () => {
    const { categoryId, drawId } = await makeCategory();
    const red = await makeEntry(categoryId, 'Present'), blue = await makeEntry(categoryId, 'Absent');
    const strangerCat = await makeCategory();
    const stranger = await makeEntry(strangerCat.categoryId, 'Somebody Else');
    const m = await makeMatch({ categoryId, drawId, redEntryId: red, blueEntryId: blue });

    await expect(transitionMatch(db, { principal: national }, {
      matchId: m.id, to: 'walkover', reason: 'blue did not appear',
    }, NOW)).rejects.toThrow(/must name the competitor/i);

    await expect(transitionMatch(db, { principal: national }, {
      matchId: m.id, to: 'walkover', reason: 'blue did not appear', winnerEntryId: stranger,
    }, NOW)).rejects.toThrow(/not a competitor in this match/i);

    const done = await transitionMatch(db, { principal: national }, {
      matchId: m.id, to: 'walkover', reason: 'blue did not appear', winnerEntryId: red,
    }, NOW);
    expect(done.winnerEntryId).toBe(red);
    expect(done.endedAt).toBeTruthy();
  });

  it('ATTACK: a bout with only one competitor cannot start', async () => {
    const { categoryId, drawId } = await makeCategory();
    const red = await makeEntry(categoryId, 'Lonely');
    const m = await makeMatch({ categoryId, drawId, redEntryId: red, blueEntryId: null });
    await transitionMatch(db, { principal: national }, { matchId: m.id, to: 'called' }, NOW);
    await expect(transitionMatch(db, { principal: national }, { matchId: m.id, to: 'in_progress' }, NOW))
      .rejects.toThrow(/only one competitor/i);
  });

  it('ATTACK: an administrator of another state cannot touch this bout', async () => {
    const { match } = await liveMatch();
    await expect(transitionMatch(db, { principal: otherStateAdmin }, { matchId: match.id, to: 'paused' }, NOW))
      .rejects.toThrow(/Forbidden/);
  });
});

describe('scoring is append-only and configured, never assumed', () => {
  it('ATTACK: refuses to score at all without a ruleset', async () => {
    const { match } = await liveMatch();
    await expect(recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'yuko', officialPersonId: REF_P, ruleset: undefined as any,
    }, NOW)).rejects.toThrow(/not assumed here/i);
    expect(() => requireRuleset(null)).toThrow(MatchError);
  });

  it('ATTACK: refuses an action the ruleset does not price', async () => {
    const { match } = await liveMatch();
    await expect(recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'sanbon', officialPersonId: REF_P, ruleset: RULES,
    }, NOW)).rejects.toThrow(/has not set its value/i);
  });

  it('ATTACK: refuses a ruleset that prices an action without saying who it goes to', async () => {
    expect(() => requireRuleset({ code: 'X', actions: { yuko: { points: 1 } } }))
      .toThrow(/does not say to which competitor/i);
  });

  it('ATTACK: refuses a ruleset whose penalty credits the offender', async () => {
    expect(() => requireRuleset({
      code: 'X', actions: { hansoku: { points: 3, awardTo: 'signalled', penalty: true } },
    })).toThrow(/credit the competitor who committed it/i);
  });

  it('numbers events monotonically and keeps the cache equal to the log', async () => {
    const { match } = await liveMatch();
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'yuko', officialPersonId: REF_P, clockSeconds: 8, ruleset: RULES,
    }, NOW);
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'blue', action: 'waza_ari', officialPersonId: REF_P, clockSeconds: 21, ruleset: RULES,
    }, NOW);
    const last = await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'ippon', officialPersonId: REF_P, clockSeconds: 44, ruleset: RULES,
    }, NOW);

    expect(last.event.sequence).toBe(3);
    expect(last.event.officialPersonId).toBe(REF_P);
    expect(last.event.clockSeconds).toBe(44);
    expect(last.score).toMatchObject({ red: 4, blue: 2 });
    expect(score(await reload(match.id))).toBe('4-2');
  });

  it('ATTACK: a completed bout cannot be scored', async () => {
    const { match } = await liveMatch();
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'yuko', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);
    await completeMatch(db, { principal: national }, { matchId: match.id, ruleset: RULES }, NOW);

    await expect(recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'blue', action: 'ippon', officialPersonId: REF_P, ruleset: RULES,
    }, NOW)).rejects.toThrow(/only be recorded while a bout is in progress/i);

    expect(score(await reload(match.id))).toBe('1-0');
  });

  it('ATTACK: a person not appointed to the event cannot put points on the board', async () => {
    const { match } = await liveMatch();
    await expect(recordMatchEvent(db, { principal: national }, {
      matchId: match.id, side: 'red', action: 'ippon', officialPersonId: OUTSIDER_P, ruleset: RULES,
    }, NOW)).rejects.toThrow(/not an appointed official/i);
  });

  it('credits a penalty to the opponent and tallies it against the offender', async () => {
    const { match } = await liveMatch();
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'chukoku', penaltyCode: 'C1',
      officialPersonId: REF_P, ruleset: RULES,
    }, NOW);
    const r = await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'hansoku', penaltyCode: 'H1',
      officialPersonId: REF_P, ruleset: RULES,
    }, NOW);

    // The points go to blue; both infringements are recorded against red.
    expect(r.score).toMatchObject({ red: 0, blue: 3 });
    expect(r.score.penalties.red).toEqual({ C1: 1, H1: 1 });
    expect(r.score.penalties.blue).toEqual({});
  });

  it('ATTACK: an infringement must carry its code', async () => {
    const { match } = await liveMatch();
    await expect(recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'chukoku', officialPersonId: REF_P, ruleset: RULES,
    }, NOW)).rejects.toThrow(/must carry its penalty code/i);
  });

  it('ATTACK: a referee holds result:enter but not result:finalize', async () => {
    const { match, categoryId } = await liveMatch();
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'ippon', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);
    await completeMatch(db, { principal: referee }, { matchId: match.id, ruleset: RULES }, NOW);
    await expect(finaliseResults(db, { principal: referee }, { categoryId, ruleset: RULES }, NOW))
      .rejects.toThrow(/Forbidden/);
  });
});

describe('a correction appends a reversal — it never edits history', () => {
  it('leaves the original row untouched and recomputes from the log', async () => {
    const { match } = await liveMatch();
    const first = await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'ippon', officialPersonId: REF_P, clockSeconds: 5, ruleset: RULES,
    }, NOW);
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'blue', action: 'yuko', officialPersonId: REF_P, clockSeconds: 30, ruleset: RULES,
    }, NOW);
    expect(score(await reload(match.id))).toBe('3-1');

    const before = (await db.select().from(s.matchEvents)
      .where(eq(s.matchEvents.id, first.event.id)).limit(1))[0];

    const c = await correctMatchEvent(db, { principal: referee }, {
      eventId: first.event.id, reason: 'signalled in error — no contact', officialPersonId: REF_P,
    }, NOW);

    // The original is byte-identical.
    const after = (await db.select().from(s.matchEvents)
      .where(eq(s.matchEvents.id, first.event.id)).limit(1))[0];
    expect(after).toEqual(before);

    // The reversal is a NEW row carrying the exact negation.
    expect(c.reversal.reversesEventId).toBe(first.event.id);
    expect(c.reversal.points).toBe(-3);
    expect(c.reversal.sequence).toBe(3);
    expect(c.score).toMatchObject({ red: 0, blue: 1 });
    expect(score(await reload(match.id))).toBe('0-1');

    // Nothing was deleted: three rows, one of which no longer stands.
    const log = await db.select().from(s.matchEvents)
      .where(eq(s.matchEvents.matchId, match.id)).orderBy(asc(s.matchEvents.sequence));
    expect(log.length).toBe(3);

    const explained = await explainMatch(db, match.id);
    expect(explained.events.map((e: any) => e.standing)).toEqual([false, true, false]);
    expect(explained.cacheAgrees).toBe(true);
  });

  it('ATTACK: the same action cannot be withdrawn twice, and a reversal cannot be reversed', async () => {
    const { match } = await liveMatch();
    const e = await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'waza_ari', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);
    const c = await correctMatchEvent(db, { principal: referee }, {
      eventId: e.event.id, reason: 'wrong competitor', officialPersonId: REF_P,
    }, NOW);

    await expect(correctMatchEvent(db, { principal: referee }, {
      eventId: e.event.id, reason: 'again', officialPersonId: REF_P,
    }, NOW)).rejects.toThrow(/already been withdrawn/i);

    await expect(correctMatchEvent(db, { principal: referee }, {
      eventId: c.reversal.id, reason: 'undo the undo', officialPersonId: REF_P,
    }, NOW)).rejects.toThrow(/itself a correction/i);
  });

  it('ATTACK: a correction with no reason is refused', async () => {
    const { match } = await liveMatch();
    const e = await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'blue', action: 'yuko', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);
    await expect(correctMatchEvent(db, { principal: referee }, {
      eventId: e.event.id, reason: '   ', officialPersonId: REF_P,
    }, NOW)).rejects.toThrow(/must record why/i);
  });

  it('ATTACK: the log closes when the bout does — no quiet amendment afterwards', async () => {
    const { match } = await liveMatch();
    const e = await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'ippon', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);
    await completeMatch(db, { principal: national }, { matchId: match.id, ruleset: RULES }, NOW);

    await expect(correctMatchEvent(db, { principal: referee }, {
      eventId: e.event.id, reason: 'on review the point was not scored', officialPersonId: REF_P,
    }, NOW)).rejects.toThrow(/corrected through a protest/i);
  });
});

describe('the cached score can never drift from the event log', () => {
  it('ATTACK: a scoreboard tampered with outside the log is put right by the next append', async () => {
    const { match } = await liveMatch();
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'yuko', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);

    // Somebody writes to the cache directly.
    await db.update(s.matches).set({ redScore: 99, blueScore: 7 }).where(eq(s.matches.id, match.id));
    expect(score(await reload(match.id))).toBe('99-7');

    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'blue', action: 'yuko', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);
    expect(score(await reload(match.id))).toBe('1-1');
    expect(await scoreFromLog(db, match.id)).toMatchObject({ red: 1, blue: 1 });
  });

  it('ATTACK: reconciliation SAYS the cache had drifted rather than silently healing it', async () => {
    const { match } = await liveMatch();
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'ippon', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);
    await db.update(s.matches).set({ redScore: 42 }).where(eq(s.matches.id, match.id));

    const before = await db.select().from(s.auditEvents);
    const r = await reconcileMatchScore(db, { principal: national }, match.id, NOW);
    expect(r.drifted).toBe(true);
    expect(r.cached).toEqual({ red: 42, blue: 0 });
    expect(r.score).toMatchObject({ red: 3, blue: 0 });

    const after = await db.select().from(s.auditEvents);
    expect(after.length).toBeGreaterThan(before.length);

    const clean = await reconcileMatchScore(db, { principal: national }, match.id, NOW);
    expect(clean.drifted).toBe(false);
  });

  it('ATTACK: a hand-forged reversal that does not cancel is caught, not summed', async () => {
    const { match } = await liveMatch();
    const e = await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'ippon', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);
    // A reversal claiming to withdraw the ippon while giving back only 1 point.
    await db.insert(s.matchEvents).values({
      matchId: match.id, sequence: 99, side: 'red', action: 'ippon',
      points: -1, reversesEventId: e.event.id,
    });
    await expect(scoreFromLog(db, match.id)).rejects.toThrow(/does not reconcile/i);
  });

  it('replayScore is pure arithmetic over the rows it is given', () => {
    expect(replayScore([
      { id: 1, sequence: 1, side: 'red', points: 3 },
      { id: 2, sequence: 2, side: 'blue', points: 1 },
      { id: 3, sequence: 3, side: 'red', points: -3, reversesEventId: 1 },
    ])).toMatchObject({ red: 0, blue: 1, eventCount: 3, liveEventCount: 1 });
  });
});

describe('kata scoring: integers in hundredths, discards recorded', () => {
  async function kataPanel(scores: number[]) {
    const { categoryId, drawId } = await makeCategory('Cadet Male Kata');
    const entryId = await makeEntry(categoryId, 'Kata Competitor');
    const m = await makeMatch({ categoryId, drawId, redEntryId: entryId, round: 'F' });
    const judges = [J1, J2, J3, J4, J5];
    for (let i = 0; i < scores.length; i++) {
      await recordKataScore(db, { principal: national }, {
        entryId, matchId: m.id, judgePersonId: judges[i], judgePosition: i + 1,
        kataName: 'Bassai Dai', totalScore: scores[i], ruleset: RULES,
      }, NOW);
    }
    return { entryId, matchId: m.id as number };
  }

  it('discards the highest and the lowest and records WHICH', async () => {
    const { entryId, matchId } = await kataPanel([720, 740, 730, 750, 710]);
    const result = await finaliseKataScoring(db, { principal: national }, { entryId, matchId, ruleset: RULES }, NOW);

    expect(result.judgesScoring).toBe(5);
    expect(result.discarded.map((d) => [d.totalScore, d.as]).sort())
      .toEqual([[710, 'lowest'], [750, 'highest']].sort());
    expect(result.counted.map((c) => c.totalScore).sort()).toEqual([720, 730, 740]);
    expect(result.total).toBe(2190);           // integers in hundredths: 21.90

    // The discards are on the record, not merely in the return value.
    const rows = await db.select().from(s.kataScores).where(eq(s.kataScores.entryId, entryId));
    expect(rows.filter((r: any) => r.discarded).map((r: any) => r.totalScore).sort()).toEqual([710, 750]);
  });

  it('ATTACK: a score outside the configured bounds is refused', async () => {
    const { categoryId } = await makeCategory('Kata Bounds');
    const entryId = await makeEntry(categoryId, 'Out Of Range');
    await expect(recordKataScore(db, { principal: national }, {
      entryId, judgePersonId: J1, totalScore: 1100, ruleset: RULES,
    }, NOW)).rejects.toThrow(/outside the 5.00–10.00 range/);
    await expect(recordKataScore(db, { principal: national }, {
      entryId, judgePersonId: J1, totalScore: 499, ruleset: RULES,
    }, NOW)).rejects.toThrow(/outside the 5.00–10.00 range/);
  });

  it('ATTACK: a fractional score is refused — kata marks are hundredths, not floats', async () => {
    const { categoryId } = await makeCategory('Kata Float');
    const entryId = await makeEntry(categoryId, 'Fractional');
    await expect(recordKataScore(db, { principal: national }, {
      entryId, judgePersonId: J1, totalScore: 7.25, ruleset: RULES,
    }, NOW)).rejects.toThrow(/integer in hundredths/i);
  });

  it('ATTACK: refuses to judge kata under a ruleset with no kata arrangement', async () => {
    const { categoryId } = await makeCategory('Kata No Rules');
    const entryId = await makeEntry(categoryId, 'No Rules');
    const noKata: ScoringRuleset = { code: 'TEST-RULES-D', actions: RULES.actions };
    await expect(recordKataScore(db, { principal: national }, {
      entryId, judgePersonId: J1, totalScore: 700, ruleset: noKata,
    }, NOW)).rejects.toThrow(/not assumed here/i);
  });

  it('ATTACK: refuses a panel too small to survive its own discard rule', async () => {
    const { entryId, matchId } = await kataPanel([700, 800]);
    await expect(finaliseKataScoring(db, { principal: national }, { entryId, matchId, ruleset: RULES }, NOW))
      .rejects.toThrow(/needs 5 to discard/i);
  });

  it('ATTACK: a person not appointed to the event cannot judge', async () => {
    const { categoryId } = await makeCategory('Kata Outsider');
    const entryId = await makeEntry(categoryId, 'Judged By Nobody');
    await expect(recordKataScore(db, { principal: national }, {
      entryId, judgePersonId: OUTSIDER_P, totalScore: 700, ruleset: RULES,
    }, NOW)).rejects.toThrow(/not an appointed official/i);
  });

  it('nothing is discarded when the federation has set no discard rule', () => {
    const rules: ScoringRuleset = {
      code: 'TEST-RULES-E', actions: RULES.actions,
      kata: { minScore: 500, maxScore: 1000 },
    };
    const r = computeKataResult(
      [{ id: 1, totalScore: 700 }, { id: 2, totalScore: 900 }, { id: 3, totalScore: 800 }],
      rules
    );
    expect(r.discarded).toEqual([]);
    expect(r.total).toBe(2400);
  });

  it('a judge re-marking updates their own row, never another judge’s', async () => {
    const { categoryId, drawId } = await makeCategory('Kata Remark');
    const entryId = await makeEntry(categoryId, 'Remarked');
    const m = await makeMatch({ categoryId, drawId, redEntryId: entryId });
    await recordKataScore(db, { principal: national }, {
      entryId, matchId: m.id, judgePersonId: J1, totalScore: 700, ruleset: RULES,
    }, NOW);
    await recordKataScore(db, { principal: national }, {
      entryId, matchId: m.id, judgePersonId: J2, totalScore: 800, ruleset: RULES,
    }, NOW);
    await recordKataScore(db, { principal: national }, {
      entryId, matchId: m.id, judgePersonId: J1, totalScore: 750, ruleset: RULES,
    }, NOW);

    const rows = await db.select().from(s.kataScores).where(eq(s.kataScores.entryId, entryId));
    expect(rows.length).toBe(2);
    expect(rows.find((r: any) => r.judgePersonId === J1).totalScore).toBe(750);
    expect(rows.find((r: any) => r.judgePersonId === J2).totalScore).toBe(800);
  });
});

describe('completing a bout', () => {
  it('takes the winner from the log and advances them into the next match', async () => {
    const { categoryId, drawId } = await makeCategory('Bracket');
    const a = await makeEntry(categoryId, 'A'), b = await makeEntry(categoryId, 'B');
    const final = await makeMatch({ categoryId, drawId, round: 'F', roundOrder: 20 });
    const semi = await makeMatch({
      categoryId, drawId, round: 'SF', roundOrder: 10,
      redEntryId: a, blueEntryId: b, advancesToMatchId: final.id, advancesToSlot: 'red',
    });

    await transitionMatch(db, { principal: national }, { matchId: semi.id, to: 'called' }, NOW);
    await transitionMatch(db, { principal: national }, { matchId: semi.id, to: 'in_progress' }, NOW);
    await recordMatchEvent(db, { principal: referee }, {
      matchId: semi.id, side: 'blue', action: 'waza_ari', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);

    const done = await completeMatch(db, { principal: national }, { matchId: semi.id, ruleset: RULES }, NOW);
    expect(done.winnerEntryId).toBe(b);
    expect(done.winMethod).toBe('points');
    expect((await reload(final.id)).redEntryId).toBe(b);
  });

  it('ATTACK: a level bout is NOT decided when the regulations set no tie-break', async () => {
    const { match } = await liveMatch();
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'yuko', officialPersonId: REF_P, ruleset: RULES_NO_TIEBREAK,
    }, NOW);
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'blue', action: 'yuko', officialPersonId: REF_P, ruleset: RULES_NO_TIEBREAK,
    }, NOW);

    await expect(completeMatch(db, { principal: national }, { matchId: match.id, ruleset: RULES_NO_TIEBREAK }, NOW))
      .rejects.toThrow(/sets no tie-break/i);
    expect((await reload(match.id)).status).toBe('in_progress');
  });

  it('decides a level bout by senshu when the ruleset says so — and a withdrawn point moves it', async () => {
    const { match, red, blue } = await liveMatch();
    const first = await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'yuko', officialPersonId: REF_P, clockSeconds: 5, ruleset: RULES,
    }, NOW);
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'blue', action: 'yuko', officialPersonId: REF_P, clockSeconds: 40, ruleset: RULES,
    }, NOW);

    expect(senshuSide(await db.select().from(s.matchEvents)
      .where(eq(s.matchEvents.matchId, match.id)).orderBy(asc(s.matchEvents.sequence)), false)).toBe('red');

    // Red's opening point is withdrawn; blue's is then the first that stands.
    await correctMatchEvent(db, { principal: referee }, {
      eventId: first.event.id, reason: 'video review: no valid technique', officialPersonId: REF_P,
    }, NOW);
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'yuko', officialPersonId: REF_P, clockSeconds: 80, ruleset: RULES,
    }, NOW);

    const done = await completeMatch(db, { principal: national }, { matchId: match.id, ruleset: RULES }, NOW);
    expect(done.score).toMatchObject({ red: 1, blue: 1 });
    expect(done.winMethod).toBe('senshu');
    expect(done.winnerEntryId).toBe(blue);
    expect(sideOf(done.match, blue)).toBe('blue');
    expect(done.winnerEntryId).not.toBe(red);
  });

  it('an action the regulations say ends the bout settles it, and names its own win method', async () => {
    const { match, blue } = await liveMatch();
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'ippon', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'hansoku', penaltyCode: 'H1', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);

    const done = await completeMatch(db, { principal: national }, { matchId: match.id, ruleset: RULES }, NOW);
    expect(done.winMethod).toBe('hansoku');
    expect(done.winnerEntryId).toBe(blue);
  });

  it('a stated referee decision is recorded as stated, and demands a reason', async () => {
    const { match, red } = await liveMatch();
    await expect(completeMatch(db, { principal: national }, {
      matchId: match.id, ruleset: RULES,
      decision: { winnerEntryId: red, winMethod: 'kiken', reason: '' },
    }, NOW)).rejects.toThrow(/must record why/i);

    const done = await completeMatch(db, { principal: national }, {
      matchId: match.id, ruleset: RULES,
      decision: { winnerEntryId: red, winMethod: 'kiken', reason: 'blue withdrew injured on medical advice' },
    }, NOW);
    expect(done.winMethod).toBe('kiken');
    expect(done.winnerEntryId).toBe(red);
  });

  it('ATTACK: a bout cannot be completed twice', async () => {
    const { match } = await liveMatch();
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'ippon', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);
    await completeMatch(db, { principal: national }, { matchId: match.id, ruleset: RULES }, NOW);
    await expect(completeMatch(db, { principal: national }, { matchId: match.id, ruleset: RULES }, NOW))
      .rejects.toThrow(/cannot move to completed/i);
  });

  it('ATTACK: a winner cannot be pushed into a slot somebody else already holds', async () => {
    const { categoryId, drawId } = await makeCategory('Occupied Slot');
    const a = await makeEntry(categoryId, 'A'), b = await makeEntry(categoryId, 'B');
    const squatter = await makeEntry(categoryId, 'Already There');
    const final = await makeMatch({ categoryId, drawId, round: 'F', roundOrder: 20, redEntryId: squatter });
    const semi = await makeMatch({
      categoryId, drawId, round: 'SF', roundOrder: 10,
      redEntryId: a, blueEntryId: b, advancesToMatchId: final.id, advancesToSlot: 'red',
    });
    await transitionMatch(db, { principal: national }, { matchId: semi.id, to: 'called' }, NOW);
    await transitionMatch(db, { principal: national }, { matchId: semi.id, to: 'in_progress' }, NOW);
    await recordMatchEvent(db, { principal: referee }, {
      matchId: semi.id, side: 'red', action: 'ippon', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);

    await expect(completeMatch(db, { principal: national }, { matchId: semi.id, ruleset: RULES }, NOW))
      .rejects.toThrow(/already taken by another entry/i);
  });
});

// ─── Results ────────────────────────────────────────────────────────────────

/** A four-competitor single-elimination bracket, all bouts decided. */
async function playedBracket() {
  const { categoryId, drawId } = await makeCategory('Finalised Category');
  const a = await makeEntry(categoryId, 'A'), b = await makeEntry(categoryId, 'B');
  const c = await makeEntry(categoryId, 'C'), d = await makeEntry(categoryId, 'D');

  const final = await makeMatch({ categoryId, drawId, round: 'F', roundOrder: 20 });
  const sf1 = await makeMatch({
    categoryId, drawId, round: 'SF', roundOrder: 10, redEntryId: a, blueEntryId: b,
    advancesToMatchId: final.id, advancesToSlot: 'red',
  });
  const sf2 = await makeMatch({
    categoryId, drawId, round: 'SF', roundOrder: 10, redEntryId: c, blueEntryId: d,
    advancesToMatchId: final.id, advancesToSlot: 'blue',
  });

  for (const [m, side] of [[sf1, 'red'], [sf2, 'red']] as const) {
    await transitionMatch(db, { principal: national }, { matchId: m.id, to: 'called' }, NOW);
    await transitionMatch(db, { principal: national }, { matchId: m.id, to: 'in_progress' }, NOW);
    await recordMatchEvent(db, { principal: referee }, {
      matchId: m.id, side, action: 'ippon', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);
    await completeMatch(db, { principal: national }, { matchId: m.id, ruleset: RULES }, NOW);
  }

  await transitionMatch(db, { principal: national }, { matchId: final.id, to: 'called' }, NOW);
  await transitionMatch(db, { principal: national }, { matchId: final.id, to: 'in_progress' }, NOW);
  await recordMatchEvent(db, { principal: referee }, {
    matchId: final.id, side: 'blue', action: 'waza_ari', officialPersonId: REF_P, ruleset: RULES,
  }, NOW);
  await completeMatch(db, { principal: national }, { matchId: final.id, ruleset: RULES }, NOW);

  return { categoryId, drawId, a, b, c, d, final, sf1, sf2 };
}

describe('results are computed from the bracket and then LOCK', () => {
  it('places every competitor, medals them by policy, and marks the set final', async () => {
    const { categoryId, a, c } = await playedBracket();
    const rows = await finaliseResults(db, { principal: national }, { categoryId, ruleset: RULES }, NOW);

    const byPlacing = Object.fromEntries(rows.map((r: any) => [r.placing, r]));
    expect(byPlacing[1].entryId).toBe(c);            // won the final
    expect(byPlacing[1].medal).toBe('gold');
    expect(byPlacing[2].entryId).toBe(a);
    expect(byPlacing[2].medal).toBe('silver');
    expect(rows.filter((r: any) => r.placing === 3).length).toBe(2);
    expect(rows.every((r: any) => r.status === 'final')).toBe(true);
    expect(rows.every((r: any) => r.finalisedAt)).toBe(true);

    const champion = byPlacing[1];
    expect(champion.matchesWon).toBe(2);
    expect(champion.matchesLost).toBe(0);
    expect(champion.pointsFor).toBe(5);              // 3 in the semi, 2 in the final
    expect(champion.pointsAgainst).toBe(0);
  });

  it('ATTACK: a category cannot be finalised twice', async () => {
    const { categoryId } = await playedBracket();
    await finaliseResults(db, { principal: national }, { categoryId, ruleset: RULES }, NOW);
    await expect(finaliseResults(db, { principal: national }, { categoryId, ruleset: RULES }, NOW))
      .rejects.toThrow(/already final/i);
  });

  it('ATTACK: an unfinished bout blocks finalisation and is named', async () => {
    const { categoryId, drawId } = await makeCategory('Unfinished');
    const a = await makeEntry(categoryId, 'A'), b = await makeEntry(categoryId, 'B');
    const m = await makeMatch({ categoryId, drawId, round: 'F', roundOrder: 20, redEntryId: a, blueEntryId: b });
    await transitionMatch(db, { principal: national }, { matchId: m.id, to: 'called' }, NOW);

    await expect(finaliseResults(db, { principal: national }, { categoryId, ruleset: RULES }, NOW))
      .rejects.toThrow(new RegExp(`${m.matchNo} \\(called\\)`));
  });

  it('ATTACK: refuses to invent a placing the federation has not set', async () => {
    const { categoryId } = await playedBracket();
    await expect(finaliseResults(db, { principal: national }, { categoryId, ruleset: RULES_NO_PLACINGS }, NOW))
      .rejects.toThrow(/is not assumed here/i);

    const noSF: ScoringRuleset = { ...RULES, code: 'TEST-RULES-F', placings: { medals: { '1': 'gold' } } };
    await expect(finaliseResults(db, { principal: national }, { categoryId, ruleset: noSF }, NOW))
      .rejects.toThrow(/does not say what placing the loser of SF receives/i);
  });

  it('ATTACK: refuses when the deciding bout cannot be identified', async () => {
    const { categoryId, drawId } = await makeCategory('Two Finals');
    const a = await makeEntry(categoryId, 'A'), b = await makeEntry(categoryId, 'B');
    const c = await makeEntry(categoryId, 'C'), d = await makeEntry(categoryId, 'D');
    for (const [x, y] of [[a, b], [c, d]]) {
      const m = await makeMatch({ categoryId, drawId, round: 'F', roundOrder: 20, redEntryId: x, blueEntryId: y });
      await transitionMatch(db, { principal: national }, { matchId: m.id, to: 'called' }, NOW);
      await transitionMatch(db, { principal: national }, { matchId: m.id, to: 'in_progress' }, NOW);
      await recordMatchEvent(db, { principal: referee }, {
        matchId: m.id, side: 'red', action: 'ippon', officialPersonId: REF_P, ruleset: RULES,
      }, NOW);
      await completeMatch(db, { principal: national }, { matchId: m.id, ruleset: RULES }, NOW);
    }
    await expect(finaliseResults(db, { principal: national }, { categoryId, ruleset: RULES }, NOW))
      .rejects.toThrow(/deciding bout could not be identified/i);
  });
});

describe('a locked result is superseded, never edited', () => {
  async function finalised() {
    const b = await playedBracket();
    const rows = await finaliseResults(db, { principal: national }, { categoryId: b.categoryId, ruleset: RULES }, NOW);
    return { ...b, rows };
  }

  it('ATTACK: a correction with no reason, or no authorising user, is refused', async () => {
    const { rows } = await finalised();
    const gold = rows.find((r: any) => r.placing === 1);

    await expect(correctResult(db, { principal: national }, {
      resultId: gold.id, reason: '  ', authorisedByUserId: 5,
    }, NOW)).rejects.toThrow(/requires a reason/i);

    await expect(correctResult(db, { principal: national }, {
      resultId: gold.id, reason: 'doping violation confirmed', authorisedByUserId: null as any,
    }, NOW)).rejects.toThrow(/requires the user who authorised it/i);
  });

  it('ATTACK: nobody may authorise their own correction', async () => {
    const { rows } = await finalised();
    const gold = rows.find((r: any) => r.placing === 1);
    await expect(correctResult(db, { principal: national }, {
      resultId: gold.id, reason: 'clerical error in the placing', authorisedByUserId: national.userId!,
    }, NOW)).rejects.toThrow(/second person/i);
  });

  it('creates a NEW superseding row and leaves the original exactly as it was', async () => {
    const { rows, categoryId } = await finalised();
    const gold = rows.find((r: any) => r.placing === 1);
    const before = (await db.select().from(s.competitionResults)
      .where(eq(s.competitionResults.id, gold.id)).limit(1))[0];

    const corrected = await correctResult(db, { principal: national }, {
      resultId: gold.id, placing: 2, medal: 'silver',
      reason: 'appeal upheld: the deciding point was withdrawn on video review',
      authorisedByUserId: secondAdmin.userId!,
    }, NOW);

    const after = (await db.select().from(s.competitionResults)
      .where(eq(s.competitionResults.id, gold.id)).limit(1))[0];
    expect(after).toEqual(before);                       // untouched, field for field

    expect(corrected.id).not.toBe(gold.id);
    expect(corrected.supersedesResultId).toBe(gold.id);
    expect(corrected.placing).toBe(2);
    expect(corrected.correctionReason).toMatch(/appeal upheld/);
    expect(corrected.correctionAuthorisedByUserId).toBe(secondAdmin.userId);

    // The register reads the head of the chain, and says it was corrected.
    const official = await officialResults(db, categoryId);
    expect(official.find((r: any) => r.id === gold.id)).toBeUndefined();
    const head = official.find((r: any) => r.id === corrected.id);
    expect(head.corrected).toBe(true);
    expect(head.supersedes).toBe(gold.id);

    const audit = await db.select().from(s.auditEvents).where(and(
      eq(s.auditEvents.entityType, 'competition_result'),
      eq(s.auditEvents.entityId, String(gold.id))
    ));
    expect(audit.length).toBe(1);
    expect(audit[0].reason).toMatch(/appeal upheld/);
    expect(audit[0].authority).toBe(String(secondAdmin.userId));
  });

  it('ATTACK: only the current row may be corrected — a superseded one cannot', async () => {
    const { rows } = await finalised();
    const gold = rows.find((r: any) => r.placing === 1);
    await correctResult(db, { principal: national }, {
      resultId: gold.id, placing: 2, reason: 'first correction', authorisedByUserId: 5,
    }, NOW);
    await expect(correctResult(db, { principal: national }, {
      resultId: gold.id, placing: 3, reason: 'second bite', authorisedByUserId: 5,
    }, NOW)).rejects.toThrow(/already been corrected/i);
  });

  it('ATTACK: a referee cannot correct an official result', async () => {
    const { rows } = await finalised();
    const gold = rows.find((r: any) => r.placing === 1);
    await expect(correctResult(db, { principal: referee }, {
      resultId: gold.id, placing: 4, reason: 'because I say so', authorisedByUserId: 5,
    }, NOW)).rejects.toThrow(/Forbidden/);
  });
});

// Review additions. Each of these fails against the module as first written.
describe('REVIEW: the regulations decide, not this module', () => {
  /** A penalty that awards a point without ending the bout. */
  const CHUI = { points: 1, awardTo: 'opponent' as const, penalty: true };

  /** Same actions, plus a penalty that can score — which makes senshu ambiguous. */
  const AMBIG: ScoringRuleset = {
    code: 'TEST-RULES-SENSHU',
    actions: { ...RULES.actions, hansoku_chui: CHUI },
    tieBreak: ['senshu'],
  };

  /** A bout level at 1-1 where blue's point came from red's infringement. */
  async function levelOnAPenalty(ruleset: ScoringRuleset) {
    const { match, red, blue } = await liveMatch();
    // Signalled against red, so the point is credited to blue: blue scores
    // first in time, but only by virtue of a penalty.
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'hansoku_chui', penaltyCode: 'C1',
      officialPersonId: REF_P, clockSeconds: 10, ruleset,
    }, NOW);
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'yuko', officialPersonId: REF_P, clockSeconds: 60, ruleset,
    }, NOW);
    return { match, red, blue };
  }

  it('ATTACK: senshu is NOT decided when the ruleset does not say whether a penalty point counts', async () => {
    const { match } = await levelOnAPenalty(AMBIG);
    await expect(completeMatch(db, { principal: national }, { matchId: match.id, ruleset: AMBIG }, NOW))
      .rejects.toThrow(/senshuFromPenaltyPoints|does not say/i);
    expect((await reload(match.id)).status).toBe('in_progress');   // nothing decided, nothing written
  });

  it('decides it either way once the federation HAS said, and the two readings differ', async () => {
    const counts: ScoringRuleset = { ...AMBIG, code: 'TEST-RULES-SENSHU-Y', senshuFromPenaltyPoints: true };
    const ignores: ScoringRuleset = { ...AMBIG, code: 'TEST-RULES-SENSHU-N', senshuFromPenaltyPoints: false };

    const a = await levelOnAPenalty(counts);
    const doneA = await completeMatch(db, { principal: national }, { matchId: a.match.id, ruleset: counts }, NOW);
    expect(doneA.score).toMatchObject({ red: 1, blue: 1 });
    expect(doneA.winMethod).toBe('senshu');
    expect(doneA.winnerEntryId).toBe(a.blue);          // the penalty point came first

    const b = await levelOnAPenalty(ignores);
    const doneB = await completeMatch(db, { principal: national }, { matchId: b.match.id, ruleset: ignores }, NOW);
    expect(doneB.winnerEntryId).toBe(b.red);           // red's yuko is the first point that counts
  });

  it('ATTACK: an action that ends the bout must say who the bout goes to', () => {
    expect(() => requireRuleset({
      code: 'TEST-RULES-SHIKKAKU-BAD',
      actions: { shikkaku: { points: 0, penalty: true, endsMatch: true, winMethod: 'shikkaku' } },
    })).toThrow(/which competitor it is awarded to/i);
  });

  it('ATTACK: a disqualification carrying no points does not crown the competitor it was signalled against', async () => {
    const rules: ScoringRuleset = {
      code: 'TEST-RULES-SHIKKAKU',
      actions: {
        ...RULES.actions,
        // The offender is disqualified; the bout goes to the opponent and NO
        // points are awarded. This is the shape that used to hand the win to
        // the disqualified competitor.
        shikkaku: { points: 0, awardTo: 'opponent', penalty: true, endsMatch: true, winMethod: 'shikkaku' },
      },
    };
    const { match, red, blue } = await liveMatch();
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'shikkaku', penaltyCode: 'SK',
      officialPersonId: REF_P, ruleset: rules,
    }, NOW);

    const done = await completeMatch(db, { principal: national }, { matchId: match.id, ruleset: rules }, NOW);
    expect(done.winMethod).toBe('shikkaku');
    expect(done.winnerEntryId).toBe(blue);
    expect(done.winnerEntryId).not.toBe(red);
    // …and the infringement is still tallied against the competitor who committed it.
    expect(done.score.penalties.red).toEqual({ SK: 1 });
    expect(done.score.penalties.blue).toEqual({});
  });

  it('ATTACK: a walkover invents no win method — the reason carries the explanation', async () => {
    const { categoryId, drawId } = await makeCategory('No Invented Kiken');
    const red = await makeEntry(categoryId, 'Present'), blue = await makeEntry(categoryId, 'Absent');
    const m = await makeMatch({ categoryId, drawId, redEntryId: red, blueEntryId: blue });

    const done = await transitionMatch(db, { principal: national }, {
      matchId: m.id, to: 'walkover', winnerEntryId: red,
      reason: 'blue was not on the mat when called for the third time',
    }, NOW);
    expect(done.winMethod).toBeNull();

    // A win method may still be stated — but only where a result exists to
    // carry it, never on a pause or a cancellation.
    const { match: live } = await liveMatch();
    await expect(transitionMatch(db, { principal: national }, {
      matchId: live.id, to: 'paused', winMethod: 'points',
    }, NOW)).rejects.toThrow(/win method belongs to a result/i);
  });
});

describe('REVIEW: a locked record is built only on evidence', () => {
  it('ATTACK: a tampered scoreboard cannot be laundered into a final result', async () => {
    const { categoryId, final } = await playedBracket();

    // Somebody writes to the scoreboard outside the event log.
    await db.update(s.matches).set({ redScore: 9 }).where(eq(s.matches.id, final.id));

    await expect(finaliseResults(db, { principal: national }, { categoryId, ruleset: RULES }, NOW))
      .rejects.toThrow(new RegExp(final.matchNo + '[^]*replays to'));

    // Nothing was written on the way to that refusal.
    expect((await db.select().from(s.competitionResults)
      .where(eq(s.competitionResults.categoryId, categoryId))).length).toBe(0);

    // Reconciled against the log, the same finalisation goes through and the
    // figures are the log's, not the tampered cache's.
    const fixed = await reconcileMatchScore(db, { principal: national }, final.id, NOW);
    expect(fixed.drifted).toBe(true);
    const rows = await finaliseResults(db, { principal: national }, { categoryId, ruleset: RULES }, NOW);
    expect(rows.find((r: any) => r.placing === 1).pointsFor).toBe(5);
  });

  it('ATTACK: finalisation refuses to write over placings that already exist', async () => {
    const { categoryId, a } = await playedBracket();
    await db.insert(s.competitionResults).values({
      eventId: EVT, categoryId, entryId: a, placing: 1, status: 'provisional',
    });
    await expect(finaliseResults(db, { principal: national }, { categoryId, ruleset: RULES }, NOW))
      .rejects.toThrow(/already carries 1 result row\(s\) \(provisional\)/i);
  });

  it('an inconsistent log is still EXPLAINABLE — explainMatch reports it instead of refusing', async () => {
    const { match } = await liveMatch();
    const first = await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'ippon', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);

    // A reversal forged outside this module, returning less than it withdrew.
    await db.insert(s.matchEvents).values({
      matchId: match.id, sequence: 99, side: 'red', action: 'ippon',
      points: -1, reversesEventId: first.event.id, at: NOW,
    });

    const x = await explainMatch(db, match.id);
    expect(x.consistent).toBe(false);
    expect(x.problem).toMatch(/does not reconcile/i);
    expect(x.score).toBeNull();
    expect(x.events.length).toBe(2);                   // the rows are still there to be read
    expect(x.events.map((e: any) => e.points).sort()).toEqual([-1, 3]);
  });
});

describe('REVIEW: kata panels close, and marks belong to their own bout', () => {
  async function totalledPanel() {
    const { categoryId, drawId } = await makeCategory('Kata Closed Panel');
    const entryId = await makeEntry(categoryId, 'Kata Competitor');
    const m = await makeMatch({ categoryId, drawId, redEntryId: entryId, round: 'F' });
    const judges = [J1, J2, J3, J4, J5];
    for (let i = 0; i < judges.length; i++) {
      await recordKataScore(db, { principal: national }, {
        entryId, matchId: m.id, judgePersonId: judges[i], judgePosition: i + 1,
        totalScore: 700 + i * 10, ruleset: RULES,
      }, NOW);
    }
    const result = await finaliseKataScoring(db, { principal: national }, { entryId, matchId: m.id, ruleset: RULES }, NOW);
    return { entryId, matchId: m.id as number, result };
  }

  it('ATTACK: a judge who had not marked cannot add a score after the panel is totalled', async () => {
    const { entryId, matchId, result } = await totalledPanel();
    expect(result.total).toBe(2160);

    await expect(recordKataScore(db, { principal: national }, {
      entryId, matchId, judgePersonId: REF_P, judgePosition: 6, totalScore: 1000, ruleset: RULES,
    }, NOW)).rejects.toThrow(/already been computed/i);

    // Nor may a judge who did mark revise theirs afterwards.
    await expect(recordKataScore(db, { principal: national }, {
      entryId, matchId, judgePersonId: J1, totalScore: 999, ruleset: RULES,
    }, NOW)).rejects.toThrow(/already been computed/i);

    // The panel total stands unchanged when recomputed from the rows on record.
    const again = await finaliseKataScoring(db, { principal: national }, { entryId, matchId, ruleset: RULES }, NOW);
    expect(again.total).toBe(result.total);
  });

  it('ATTACK: a mark cannot be filed against a bout in another category', async () => {
    const mine = await makeCategory('Kata Mine');
    const theirs = await makeCategory('Kata Theirs');
    const entryId = await makeEntry(mine.categoryId, 'Mine');
    const foreign = await makeMatch({ categoryId: theirs.categoryId, drawId: theirs.drawId, round: 'F' });

    await expect(recordKataScore(db, { principal: national }, {
      entryId, matchId: foreign.id, judgePersonId: J1, totalScore: 700, ruleset: RULES,
    }, NOW)).rejects.toThrow(/different category/i);
  });
});

describe('protests', () => {
  async function completedBout() {
    const { match, red, blue, categoryId } = await liveMatch();
    await recordMatchEvent(db, { principal: referee }, {
      matchId: match.id, side: 'red', action: 'ippon', officialPersonId: REF_P, ruleset: RULES,
    }, NOW);
    await completeMatch(db, { principal: national }, { matchId: match.id, ruleset: RULES }, NOW);
    return { match, red, blue, categoryId };
  }

  it('lodging against a completed bout flags it as unsettled', async () => {
    const { match, blue } = await completedBout();
    const p = await lodgeProtest(db, { principal: lodger }, {
      eventId: EVT, matchId: match.id, lodgedByPersonId: LODGER_P, onBehalfOfEntryId: blue,
      grounds: 'the winning technique landed after the referee called yame',
    }, NOW);
    expect(p.status).toBe('lodged');
    expect((await reload(match.id)).status).toBe('under_protest');
  });

  it('ATTACK: a protest must state its grounds, and must belong to its event', async () => {
    const { match } = await completedBout();
    await expect(lodgeProtest(db, { principal: lodger }, {
      eventId: EVT, matchId: match.id, lodgedByPersonId: LODGER_P, grounds: '   ',
    }, NOW)).rejects.toThrow(/must state its grounds/i);

    const [otherEvent] = await db.insert(s.competitionEvents).values({
      code: `MMAKF-EVT-2026-${uniq()}`, title: 'Another', kind: 'state_championship',
      stateUnitId: OTHER_STATE,
    }).returning();
    await expect(lodgeProtest(db, { principal: national }, {
      eventId: otherEvent.id, matchId: match.id, lodgedByPersonId: LODGER_P, grounds: 'wrong event',
    }, NOW)).rejects.toThrow(/does not belong to this event/i);
  });

  it('sits at fee_pending while the regulation fee is unrecorded, and cannot be decided', async () => {
    const { match } = await completedBout();
    const p = await lodgeProtest(db, { principal: lodger }, {
      eventId: EVT, matchId: match.id, lodgedByPersonId: LODGER_P,
      grounds: 'scoring error', feeRequired: true,
    }, NOW);
    expect(p.status).toBe('fee_pending');
    await expect(decideProtest(db, { principal: national }, {
      protestId: p.id, outcome: 'dismissed', decision: 'no', decidedByPersonId: REF_P,
    }, NOW)).rejects.toThrow(/fee required by the regulations/i);
  });

  it('deciding it returns the bout to completed but does NOT rewrite the result', async () => {
    const { match, categoryId } = await completedBout();
    const winnerBefore = (await reload(match.id)).winnerEntryId;

    const p = await lodgeProtest(db, { principal: lodger }, {
      eventId: EVT, matchId: match.id, categoryId, lodgedByPersonId: LODGER_P,
      grounds: 'the point was signalled by an unlicensed judge',
    }, NOW);
    const decided = await decideProtest(db, { principal: national }, {
      protestId: p.id, outcome: 'upheld',
      decision: 'Upheld. The appeal jury found the signal irregular; the result is referred for correction.',
      decidedByPersonId: REF_P,
    }, NOW);

    expect(decided.status).toBe('upheld');
    expect(decided.decidedAt).toBeTruthy();
    const after = await reload(match.id);
    expect(after.status).toBe('completed');
    expect(after.winnerEntryId).toBe(winnerBefore);      // upholding changes nothing by itself
  });

  it('ATTACK: a protest cannot be decided twice, nor without reasoning', async () => {
    const { match } = await completedBout();
    const p = await lodgeProtest(db, { principal: lodger }, {
      eventId: EVT, matchId: match.id, lodgedByPersonId: LODGER_P, grounds: 'timing',
    }, NOW);

    await expect(decideProtest(db, { principal: national }, {
      protestId: p.id, outcome: 'dismissed', decision: '  ', decidedByPersonId: REF_P,
    }, NOW)).rejects.toThrow(/must record its reasoning/i);

    await decideProtest(db, { principal: national }, {
      protestId: p.id, outcome: 'dismissed', decision: 'The clock record supports the referee.',
      decidedByPersonId: REF_P,
    }, NOW);
    await expect(decideProtest(db, { principal: national }, {
      protestId: p.id, outcome: 'upheld', decision: 'changed my mind', decidedByPersonId: REF_P,
    }, NOW)).rejects.toThrow(/already dismissed/i);
  });

  it('ATTACK: an athlete cannot decide a protest, nor withdraw somebody else’s', async () => {
    const { match } = await completedBout();
    const p = await lodgeProtest(db, { principal: lodger }, {
      eventId: EVT, matchId: match.id, lodgedByPersonId: LODGER_P, grounds: 'grounds',
    }, NOW);

    await expect(decideProtest(db, { principal: athlete }, {
      protestId: p.id, outcome: 'dismissed', decision: 'I dismiss it', decidedByPersonId: REF_P,
    }, NOW)).rejects.toThrow(/Forbidden/);

    // Naming the lodger's person id is not the same as being them.
    await expect(decideProtest(db, { principal: athlete }, {
      protestId: p.id, outcome: 'withdrawn', decision: 'withdrawn', decidedByPersonId: LODGER_P,
    }, NOW)).rejects.toThrow(/Forbidden/);
  });

  it('ATTACK: a protest cannot be lodged in somebody else’s name', async () => {
    const { match } = await completedBout();

    // An athlete with a real account, typing the team manager's person id.
    await expect(lodgeProtest(db, { principal: athlete }, {
      eventId: EVT, matchId: match.id, lodgedByPersonId: LODGER_P,
      grounds: 'filed in the manager’s name so that only he can take it back',
    }, NOW)).rejects.toThrow(/Forbidden/);

    // In their own name, they may.
    const mine = await lodgeProtest(db, { principal: athlete }, {
      eventId: EVT, matchId: match.id, lodgedByPersonId: ATHLETE_P,
      grounds: 'the deciding technique was signalled after yame',
    }, NOW);
    expect(mine.lodgedByPersonId).toBe(ATHLETE_P);

    // An official may still key in a protest handed over at the table.
    const onPaper = await lodgeProtest(db, { principal: national }, {
      eventId: EVT, matchId: match.id, lodgedByPersonId: LODGER_P,
      grounds: 'handed to the tatami manager in writing',
    }, NOW);
    expect(onPaper.lodgedByPersonId).toBe(LODGER_P);
  });

  it('ATTACK: a decision cannot be attributed to someone who had no part in it', async () => {
    const { match } = await completedBout();
    const p = await lodgeProtest(db, { principal: lodger }, {
      eventId: EVT, matchId: match.id, lodgedByPersonId: LODGER_P, grounds: 'scoring',
    }, NOW);

    // A jury decision recorded against a person this event never appointed.
    await expect(decideProtest(db, { principal: national }, {
      protestId: p.id, outcome: 'dismissed', decision: 'The jury did not agree.',
      decidedByPersonId: OUTSIDER_P,
    }, NOW)).rejects.toThrow(/not an appointed official/i);

    // A withdrawal recorded against a third party.
    await expect(decideProtest(db, { principal: lodger }, {
      protestId: p.id, outcome: 'withdrawn', decision: 'Withdrawn.',
      decidedByPersonId: OUTSIDER_P,
    }, NOW)).rejects.toThrow(/not a third party/i);

    // Withdrawn by the lodger: attributed to the lodger without being told.
    const done = await decideProtest(db, { principal: lodger }, {
      protestId: p.id, outcome: 'withdrawn', decision: 'Withdrawn before the jury sat.',
    }, NOW);
    expect(done.decidedByPersonId).toBe(LODGER_P);
  });

  it('the lodger may withdraw their own protest', async () => {
    const { match } = await completedBout();
    const p = await lodgeProtest(db, { principal: lodger }, {
      eventId: EVT, matchId: match.id, lodgedByPersonId: LODGER_P, grounds: 'on reflection, nothing in it',
    }, NOW);
    const done = await decideProtest(db, { principal: lodger }, {
      protestId: p.id, outcome: 'withdrawn', decision: 'Withdrawn by the team manager before the jury sat.',
    }, NOW);
    expect(done.status).toBe('withdrawn');
    expect((await reload(match.id)).status).toBe('completed');
  });
});
