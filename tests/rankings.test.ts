// The ranking engine, against real Postgres.
//
// The invariant these tests exist to protect: EVERY RANKING IS EXPLAINABLE, AND
// EVERY POINT CAME FROM THE RULESET. Points are hand-computed here from a
// fixture ruleset; if the engine ever grows a points value of its own, or
// silently drops a result instead of naming why, these fail.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createPerson } from '../src/db/federation';
import {
  computeRanking, publishRanking, explainRanking, categoryKeyFor, RankingError,
  type RankingContribution,
} from '../src/db/rankings';
import type { Principal } from '../src/lib/rbac';

let db: any, JH: number, DOJO: number;

/** The as-at date every hand computation below is done against. */
const AS_OF = '2026-08-12';
const NOW = new Date('2026-08-12T00:00:00Z');

// The three category keys the fixture uses. Kept apart so each table can be
// hand-computed without one test's fixture perturbing another's arithmetic.
const CAT_MAIN = 'kumite|male|cadet|max61000';
const CAT_TIE = 'kata|female|junior|open';
const CAT_EXCL = 'kumite|female|senior|open';
const CAT_TEAM = 'team_kata|mixed|senior|open';

const CATEGORY_SHAPE: Record<string, any> = {
  [CAT_MAIN]: { discipline: 'kumite', gender: 'male', ageGroup: 'cadet', maxWeightGrams: 61000 },
  [CAT_TIE]: { discipline: 'kata', gender: 'female', ageGroup: 'junior' },
  [CAT_EXCL]: { discipline: 'kumite', gender: 'female', ageGroup: 'senior' },
  [CAT_TEAM]: { discipline: 'team_kata', gender: 'mixed', ageGroup: 'senior' },
};

// THE FIXTURE POINTS TABLE. This is federation configuration, and it is the ONLY
// place a points value appears anywhere in this suite or in the engine.
//   national_championship: 1st 1000, 2nd 700, 3rd 400
//   state_championship:    1st 300,  2nd 200, 3rd 100
// `open_national` is deliberately absent, as is national 4th place.
const POINTS = {
  points: {
    national_championship: { 1: 1000, 2: 700, 3: 400 },
    state_championship: { 1: 300, 2: 200, 3: 100 },
  },
};

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const stateAdmin: Principal = {
  userId: 2, label: 'state-admin',
  bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: 1 }],
};
const athlete: Principal = {
  userId: 3, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};

const P: Record<string, number> = {};
let RS_BASE: number, RS_WINDOW: number, RS_BESTN: number, RS_TIE: number, RS_PREV: number, RS_DRAFT: number;

let seq = 0;
const nextCode = (p: string) => `MMAKF-${p}-2026-${String(++seq).padStart(6, '0')}`;

async function makePerson(name: string) {
  const p = await createPerson(db, { principal: national }, {
    fullName: name, stateUnitId: JH, dojoId: DOJO,
  } as any);
  P[name] = p.id;
  return p.id;
}

async function makeRuleset(code: string, over: Record<string, unknown> = {}) {
  const [r] = await db.insert(s.rankingRulesets).values({
    code, title: code, rules: POINTS, status: 'active', effectiveFrom: '2020-01-01', ...over,
  }).returning({ id: s.rankingRulesets.id });
  return r.id;
}

/** An event plus one category matching `categoryKey`. */
async function makeEvent(kind: string, startsOn: string | null, categoryKey: string) {
  const [ev] = await db.insert(s.competitionEvents).values({
    code: nextCode('EVT'), title: `${kind} ${startsOn ?? 'undated'}`,
    kind: kind as any, status: 'results_final', startsOn, stateUnitId: JH,
  }).returning();
  const [cat] = await db.insert(s.eventCategories).values({
    eventId: ev.id, code: nextCode('CAT'), label: categoryKey,
    ...CATEGORY_SHAPE[categoryKey],
  }).returning();
  return { event: ev, category: cat };
}

/** A result for one person in one category. Returns the result row. */
async function makeResult(
  ctx: { event: any; category: any },
  personId: number | null,
  placing: number,
  medal: string | null,
  status: 'provisional' | 'final' | 'corrected' | 'voided' = 'final',
  over: Record<string, unknown> = {}
) {
  const [entry] = await db.insert(s.eventEntries).values({
    entryNo: nextCode('ENT'), eventId: ctx.event.id, categoryId: ctx.category.id,
    personId, dojoId: DOJO, stateUnitId: JH, status: 'confirmed',
  }).returning();
  const [res] = await db.insert(s.competitionResults).values({
    eventId: ctx.event.id, categoryId: ctx.category.id, entryId: entry.id, personId,
    placing, medal: medal as any, status,
    finalisedAt: status === 'provisional' ? null : NOW,
    ...over,
  }).returning();
  return res;
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'ST-JH', state: 'Jharkhand', name: 'JH', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
  const [d] = await db.insert(s.dojos)
    .values({ code: 'DJ-1', name: 'Hombu', stateUnitId: JH, status: 'active' })
    .returning({ id: s.dojos.id });
  DOJO = d.id;

  // Rulesets. Identical points; each adds ONE option, so a test can attribute a
  // difference in the table to that option alone.
  RS_BASE = await makeRuleset('RS-BASE');
  RS_WINDOW = await makeRuleset('RS-WINDOW', { windowMonths: 12 });
  RS_BESTN = await makeRuleset('RS-BESTN', { bestNResults: 2 });
  RS_TIE = await makeRuleset('RS-TIE', { tieBreak: [{ key: 'goldCount', direction: 'desc' }] });
  RS_PREV = await makeRuleset('RS-PREV');
  RS_DRAFT = await makeRuleset('RS-DRAFT', { status: 'draft' });

  for (const n of ['A', 'B', 'C', 'D', 'Pat', 'Qadir', 'Gita']) await makePerson(n);

  // ── CAT_MAIN, hand computed ──
  // E1 national 2026-05-01 : A 1st (1000), B 2nd (700), D 4th (placing not priced)
  const e1 = await makeEvent('national_championship', '2026-05-01', CAT_MAIN);
  await makeResult(e1, P.A, 1, 'gold');
  await makeResult(e1, P.B, 2, 'silver');
  await makeResult(e1, P.D, 4, null);
  // E2 state 2026-03-01 : A 3rd (100), B 1st (300)
  const e2 = await makeEvent('state_championship', '2026-03-01', CAT_MAIN);
  await makeResult(e2, P.A, 3, 'bronze');
  await makeResult(e2, P.B, 1, 'gold');
  // E3 national 2024-01-15 : A 1st (1000) — inside no window, outside a 12-month one
  const e3 = await makeEvent('national_championship', '2024-01-15', CAT_MAIN);
  await makeResult(e3, P.A, 1, 'gold');
  // E4 national 2026-06-01 : C 1st but PROVISIONAL — must never move a ranking
  const e4 = await makeEvent('national_championship', '2026-06-01', CAT_MAIN);
  await makeResult(e4, P.C, 1, 'gold', 'provisional');
  // E5 open_national 2026-07-01 : D 1st — an event kind the ruleset does not price
  const e5 = await makeEvent('open_national', '2026-07-01', CAT_MAIN);
  await makeResult(e5, P.D, 1, 'gold');

  // ── CAT_TIE : two athletes level on 700 with different gold counts ──
  const t1 = await makeEvent('national_championship', '2026-04-01', CAT_TIE);
  await makeResult(t1, P.Pat, 2, 'silver');      // 700
  await makeResult(t1, P.Qadir, 3, 'bronze');    // 400
  const t2 = await makeEvent('state_championship', '2026-05-01', CAT_TIE);
  await makeResult(t2, P.Qadir, 1, 'gold');      // 300  → 700 total, one gold

  // ── CAT_EXCL : every exclusion reason, on one athlete ──
  const g1 = await makeEvent('national_championship', '2026-06-15', CAT_EXCL);
  await makeResult(g1, P.Gita, 1, 'gold');                       // 1000, counts
  const g2 = await makeEvent('national_championship', '2026-02-01', CAT_EXCL);
  await makeResult(g2, P.Gita, 1, 'gold', 'voided');             // voided
  const g3 = await makeEvent('national_championship', '2026-03-05', CAT_EXCL);
  const wrong = await makeResult(g3, P.Gita, 3, 'bronze');       // superseded
  await db.insert(s.competitionResults).values({
    eventId: g3.event.id, categoryId: g3.category.id, entryId: wrong.entryId,
    personId: P.Gita, placing: 1, medal: 'gold', status: 'corrected',
    finalisedAt: NOW, supersedesResultId: wrong.id,
    correctionReason: 'Scoring error on the semi-final protest.',
  });                                                            // 1000, counts
  const g4 = await makeEvent('national_championship', null, CAT_EXCL);
  await makeResult(g4, P.Gita, 1, 'gold', 'final', { finalisedAt: null });  // no date
  const g5 = await makeEvent('national_championship', '2026-09-01', CAT_EXCL);
  await makeResult(g5, P.Gita, 1, 'gold');                       // after the as-at date

  // ── CAT_TEAM : a team result carrying no person ──
  const tm = await makeEvent('national_championship', '2026-05-20', CAT_TEAM);
  await makeResult(tm, null, 1, 'gold');
});

const find = (w: any, resultLike: (c: RankingContribution) => boolean): RankingContribution =>
  w.contributions.find(resultLike);

/**
 * A `db` that holds its FIRST UPDATE open until `onReach()`'s promise settles.
 *
 * Concurrency attacks on a check-then-write need the write suspended at exactly
 * the instant between the two, and a single in-process Postgres will not
 * schedule that for you. Drizzle query builders are lazy thenables, so wrapping
 * `then` postpones the statement without changing it: the same SQL runs, just
 * later, against whatever the world looks like by then.
 */
function holdFirstUpdate(realDb: any, onReach: () => Promise<unknown>): any {
  let armed = true;
  const defer = (builder: any): any => new Proxy(builder, {
    get(t, prop) {
      if (prop === 'then') {
        return (ok: any, no: any) =>
          onReach().then(() => t.then(ok, no), () => t.then(ok, no));
      }
      const v = t[prop];
      if (typeof v !== 'function') return v;
      return (...a: any[]) => {
        const out = v.apply(t, a);
        return out && typeof out.then === 'function' ? defer(out) : out;
      };
    },
  });
  return new Proxy(realDb, {
    get(t, prop) {
      const v = t[prop];
      if (prop !== 'update' || !armed) return typeof v === 'function' ? v.bind(t) : v;
      return (...a: any[]) => { armed = false; return defer(t.update(...a)); };
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────

describe('category keys are derived, never invented', () => {
  it('renders every component, using grams and * for what is unset', () => {
    expect(categoryKeyFor({ discipline: 'kumite', gender: 'Male', ageGroup: 'Cadet', maxWeightGrams: 61000 }))
      .toBe('kumite|male|cadet|max61000');
    expect(categoryKeyFor({ discipline: 'kata', gender: null, ageGroup: null }))
      .toBe('kata|*|*|open');
    expect(categoryKeyFor({ discipline: 'kumite', gender: 'male', ageGroup: 'senior', minWeightGrams: 84000 }))
      .toBe('kumite|male|senior|min84000');
  });
});

describe('the hand-computed table', () => {
  it('matches points computed by hand from the ruleset', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'base',
    }, NOW);

    // A: national 1st 1000 + state 3rd 100 + national 1st 1000 = 2100
    // B: national 2nd  700 + state 1st 300                     = 1000
    // C: only result is provisional                            =    0
    // D: open_national (kind unpriced) + national 4th (placing unpriced) = 0
    expect(r.entries.map((e) => [e.personId, e.rank, e.points])).toEqual([
      [P.A, 1, 2100],
      [P.B, 2, 1000],
      [P.C, 3, 0],
      [P.D, 3, 0],
    ]);
    expect(r.athleteCount).toBe(4);
    expect(r.eventCount).toBe(3);           // E1, E2, E3 — the events that scored
  });

  it('names the rule that produced every point', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'rules-cited',
    }, NOW);
    const a = r.entries.find((e) => e.personId === P.A)!.working;

    const counted = a.contributions.filter((c) => c.counted);
    expect(counted.map((c) => c.rule).sort()).toEqual([
      'rules.points.national_championship.1',
      'rules.points.national_championship.1',
      'rules.points.state_championship.3',
    ]);
    // Points sum to the stored total, from the cited rules and nothing else.
    expect(counted.reduce((n, c) => n + c.points, 0)).toBe(a.totalPoints);
    expect(a.rulesetCode).toBe('RS-BASE');
    expect(a.asOf).toBe(AS_OF);
  });

  it('persists the working, not a summary', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'persisted',
    }, NOW);
    const rows = await db.select().from(s.rankingEntries).where(eq(s.rankingEntries.periodId, r.periodId));
    const a = rows.find((x: any) => x.personId === P.A);
    expect(a.contributions.contributions.length).toBe(3);
    expect(a.contributions.options.window.applied).toBe(false);
    expect(a.stateUnitId).toBe(JH);
    expect(a.dojoId).toBe(DOJO);
  });
});

describe('only finalised results move a ranking', () => {
  it('excludes a provisional result AND says that is why', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'provisional',
    }, NOW);
    const c = r.entries.find((e) => e.personId === P.C)!;
    expect(c.points).toBe(0);
    const only = c.working.contributions[0];
    expect(only.counted).toBe(false);
    expect(only.reason).toBe('result not final');
    expect(only.detail).toMatch(/provisional/i);
  });

  it('excludes voided, superseded, undated and future results, each by name', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_EXCL, asOf: AS_OF, label: 'exclusions',
    }, NOW);
    const g = r.entries.find((e) => e.personId === P.Gita)!;

    // 1000 for the clean win + 1000 for the correction. Nothing else.
    expect(g.points).toBe(2000);

    const reasons = g.working.contributions.map((c) => c.reason).sort();
    expect(reasons).toEqual([
      'after the as-at date',
      'counted',
      'counted',
      'no event date on record',
      'result superseded',
      'result voided',
    ]);
    expect(find(g.working, (c) => c.reason === 'result superseded').detail).toMatch(/correction is scored instead/i);
    expect(find(g.working, (c) => c.reason === 'after the as-at date').detail).toMatch(/2026-09-01.*2026-08-12/);
  });

  it('a correction supersedes rather than double-counts', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_EXCL, asOf: AS_OF, label: 'correction',
    }, NOW);
    const g = r.entries.find((e) => e.personId === P.Gita)!;
    const sameEvent = g.working.contributions.filter((c) => c.eventDate === '2026-03-05');
    expect(sameEvent.length).toBe(2);
    expect(sameEvent.filter((c) => c.counted).length).toBe(1);
    expect(sameEvent.find((c) => c.counted)!.resultStatus).toBe('corrected');
  });
});

describe('an event kind or placing the ruleset does not cover', () => {
  it('contributes ZERO and says "not covered by ruleset" — never a guess', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'uncovered',
    }, NOW);
    const d = r.entries.find((e) => e.personId === P.D)!;
    expect(d.points).toBe(0);
    expect(d.working.contributions.length).toBe(2);

    const kind = find(d.working, (c) => c.eventKind === 'open_national');
    expect(kind.points).toBe(0);
    expect(kind.rule).toBeNull();
    expect(kind.reason).toBe('not covered by ruleset');
    expect(kind.detail).toMatch(/no points for the event kind "open_national"/);

    // The kind IS priced here; the placing is not. Neither is interpolated from
    // the neighbouring 3rd place.
    const placing = find(d.working, (c) => c.eventKind === 'national_championship');
    expect(placing.placing).toBe(4);
    expect(placing.points).toBe(0);
    expect(placing.reason).toBe('not covered by ruleset');
    expect(placing.detail).toMatch(/no points for placing 4/);
  });
});

describe('windowMonths', () => {
  it('excludes results outside the rolling window, with the dates', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_WINDOW, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'window',
    }, NOW);
    const a = r.entries.find((e) => e.personId === P.A)!;
    expect(a.points).toBe(1100);                       // 2100 − the 2024 national

    const out = find(a.working, (c) => c.eventDate === '2024-01-15');
    expect(out.counted).toBe(false);
    expect(out.reason).toBe('outside window');
    expect(out.detail).toMatch(/2024-01-15.*12-month window opening on 2025-08-12/);
    expect(a.working.options.window).toMatchObject({ applied: true, value: 12, source: 'ruleset column' });
  });

  it('applies no window at all when the ruleset sets none, and records that', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'no-window',
    }, NOW);
    const a = r.entries.find((e) => e.personId === P.A)!;
    expect(a.points).toBe(2100);
    expect(a.working.options.window.applied).toBe(false);
    expect(a.working.options.window.source).toBe('not set by the ruleset');
    expect(a.working.options.window.detail).toMatch(/No rolling window is set/);
  });
});

describe('bestNResults', () => {
  it('counts only the best N and marks the rest beyond best-N', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BESTN, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'best-n',
    }, NOW);
    const a = r.entries.find((e) => e.personId === P.A)!;
    expect(a.points).toBe(2000);                       // 1000 + 1000, not the 100

    const dropped = find(a.working, (c) => c.reason === 'beyond best-N');
    expect(dropped.eventDate).toBe('2026-03-01');
    expect(dropped.counted).toBe(false);
    // The result was still priced; best-N is the only reason it did not count,
    // and the working shows what it was worth.
    expect(dropped.points).toBe(100);
    expect(dropped.rule).toBe('rules.points.state_championship.3');
    expect(a.working.options.bestN).toMatchObject({ applied: true, value: 2 });
  });

  it('leaves an athlete with fewer than N results untouched', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BESTN, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'best-n-short',
    }, NOW);
    const b = r.entries.find((e) => e.personId === P.B)!;
    expect(b.points).toBe(1000);
    expect(b.working.contributions.every((c) => c.reason !== 'beyond best-N')).toBe(true);
  });
});

describe('tie-break', () => {
  it('WITHOUT a configured tie-break, equal points SHARE a rank', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_TIE, asOf: AS_OF, label: 'tie-none',
    }, NOW);
    expect(r.entries.map((e) => e.points)).toEqual([700, 700]);
    expect(r.entries.map((e) => e.rank)).toEqual([1, 1]);
    // Separating them would mean applying a rule the federation never approved.
    expect(r.entries[0].working.tieBreakNote).toMatch(/SHARE a rank/);
    expect(r.entries[0].working.sharedRankWithPersonIds).toEqual([r.entries[1].personId]);
  });

  it('WITH a tie-break, it separates them and the working shows the numbers', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_TIE, categoryKey: CAT_TIE, asOf: AS_OF, label: 'tie-gold',
    }, NOW);
    expect(r.entries.map((e) => [e.personId, e.rank, e.points])).toEqual([
      [P.Qadir, 1, 700],                                // one gold
      [P.Pat, 2, 700],                                  // none
    ]);
    expect(r.entries[0].working.tieBreakValues).toEqual({ goldCount: 1 });
    expect(r.entries[1].working.tieBreakValues).toEqual({ goldCount: 0 });
    expect(r.entries[0].working.sharedRankWithPersonIds).toEqual([]);
  });

  it('refuses a tie-break key it cannot derive from stored data', async () => {
    const id = await makeRuleset('RS-TIE-BAD', { tieBreak: [{ key: 'coachPreference', direction: 'desc' }] });
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_TIE, asOf: AS_OF,
    }, NOW)).rejects.toThrow(/cannot derive/i);
  });

  it('refuses a tie-break step that does not state its direction', async () => {
    const id = await makeRuleset('RS-TIE-NODIR', { tieBreak: ['goldCount'] });
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_TIE, asOf: AS_OF,
    }, NOW)).rejects.toThrow(/must state its direction|must state "direction"/i);
  });

  it('honours direction: bestPlacing ascending puts the better placing first', async () => {
    const id = await makeRuleset('RS-TIE-PLACING', {
      tieBreak: [{ key: 'bestPlacing', direction: 'asc' }],
    });
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_TIE, asOf: AS_OF,
    }, NOW);
    // Pat's best counted placing is 2nd, Qadir's is 1st.
    expect(r.entries.map((e) => [e.personId, e.rank])).toEqual([[P.Qadir, 1], [P.Pat, 2]]);
  });
});

describe('determinism', () => {
  it('recomputing the same inputs produces identical output', async () => {
    const args = { rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'determinism' };
    const first = await computeRanking(db, { principal: national }, args, NOW);
    const second = await computeRanking(db, { principal: national }, args, NOW);

    expect(second.periodId).toBe(first.periodId);      // same period, recomputed
    expect(JSON.stringify(second.entries)).toBe(JSON.stringify(first.entries));

    const stored = await db.select().from(s.rankingEntries)
      .where(eq(s.rankingEntries.periodId, first.periodId));
    expect(stored.length).toBe(4);                     // replaced, not appended
  });

  it('defaults the label to the as-at date so a recompute lands on the same table', async () => {
    const a = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BESTN, categoryKey: CAT_TIE, asOf: AS_OF,
    }, NOW);
    expect(a.label).toBe(AS_OF);
    const b = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BESTN, categoryKey: CAT_TIE, asOf: new Date(`${AS_OF}T09:00:00Z`),
    }, NOW);
    expect(b.periodId).toBe(a.periodId);
  });
});

describe('publication is a separate, audited act', () => {
  it('publishes a computed table and stamps who did it', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_PREV, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'prev-1',
    }, NOW);
    const published = await publishRanking(db, { principal: national }, r.periodId, NOW);
    expect(published.publishedAt).toBeTruthy();
    expect(published.publishedByUserId).toBe(1);

    const audit = await db.select().from(s.auditEvents)
      .where(and(eq(s.auditEvents.entityType, 'ranking_period'), eq(s.auditEvents.action, 'finalize')));
    expect(audit.length).toBeGreaterThan(0);
  });

  it('ATTACK: recomputing does not silently replace a published table', async () => {
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: RS_PREV, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'prev-1',
    }, NOW)).rejects.toThrow(/published.*not replaced in place/i);
  });

  it('carries previousRank forward from the last published table', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_PREV, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'prev-2',
    }, NOW);
    expect(r.entries.find((e) => e.personId === P.A)!.previousRank).toBe(1);
    expect(r.entries.find((e) => e.personId === P.B)!.previousRank).toBe(2);
  });

  it('refuses to publish twice', async () => {
    const period = (await db.select().from(s.rankingPeriods).where(and(
      eq(s.rankingPeriods.rulesetId, RS_PREV), eq(s.rankingPeriods.label, 'prev-1')
    )).limit(1))[0];
    await expect(publishRanking(db, { principal: national }, period.id, NOW))
      .rejects.toThrow(/already published|was published on/i);
  });

  it('refuses to publish an empty table', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_TEAM, asOf: AS_OF, label: 'team',
    }, NOW);
    expect(r.athleteCount).toBe(0);
    await expect(publishRanking(db, { principal: national }, r.periodId, NOW))
      .rejects.toThrow(/no entries/i);
  });
});

describe('team results are not split by an unapproved rule', () => {
  it('reports an unattributed result instead of inventing a share', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_TEAM, asOf: AS_OF, label: 'team-count',
    }, NOW);
    expect(r.unattributedResults).toBe(1);
    expect(r.entries).toEqual([]);
  });
});

describe('the ruleset is the only source of policy', () => {
  it('ATTACK: refuses a ruleset carrying a rule this engine does not implement', async () => {
    const id = await makeRuleset('RS-DECAY', { rules: { ...POINTS, decay: { perYear: 0.5 } } });
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_MAIN, asOf: AS_OF,
    }, NOW)).rejects.toThrow(/declares "decay", which this engine does not implement/);
  });

  it('ATTACK: refuses non-integer points rather than rounding them', async () => {
    const id = await makeRuleset('RS-FLOAT', {
      rules: { points: { national_championship: { 1: 2.5 } } },
    });
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_MAIN, asOf: AS_OF,
    }, NOW)).rejects.toThrow(/non-negative whole numbers/i);
  });

  it('refuses a ruleset the federation has not approved', async () => {
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: RS_DRAFT, categoryKey: CAT_MAIN, asOf: AS_OF,
    }, NOW)).rejects.toThrow(/is draft/i);
  });

  it('refuses an as-at date outside the ruleset’s effective period', async () => {
    const id = await makeRuleset('RS-LAPSED', { effectiveFrom: '2020-01-01', effectiveTo: '2025-12-31' });
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_MAIN, asOf: AS_OF,
    }, NOW)).rejects.toThrow(/ceased to apply on 2025-12-31/);
  });

  it('ATTACK: refuses a ruleset whose column and rules disagree', async () => {
    const id = await makeRuleset('RS-CONFLICT', {
      windowMonths: 12, rules: { ...POINTS, windowMonths: 24 },
    });
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_MAIN, asOf: AS_OF,
    }, NOW)).rejects.toThrow(/disagree/i);
  });

  it('accepts the flat rules layout the schema documents, and cites it', async () => {
    const id = await makeRuleset('RS-FLAT', {
      rules: { national_championship: { 1: 1000, 2: 700, 3: 400 }, state_championship: { 1: 300, 3: 100 } },
    });
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_MAIN, asOf: AS_OF,
    }, NOW);
    const a = r.entries.find((e) => e.personId === P.A)!;
    expect(a.points).toBe(2100);
    expect(find(a.working, (c) => c.eventDate === '2026-03-01').rule).toBe('rules.state_championship.3');
  });

  it('refuses a category key that is not a real discipline', async () => {
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: 'freestyle|male|cadet|open', asOf: AS_OF,
    }, NOW)).rejects.toThrow(/not a competition discipline/i);
  });

  it('refuses to rank a discipline the ruleset does not apply to', async () => {
    const id = await makeRuleset('RS-KATA-ONLY', { discipline: 'kata' });
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_MAIN, asOf: AS_OF,
    }, NOW)).rejects.toThrow(/applies to kata/i);
  });
});

describe('authorisation', () => {
  it('ATTACK: an athlete cannot compute a ranking', async () => {
    await expect(computeRanking(db, { principal: athlete }, {
      rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'forbidden',
    }, NOW)).rejects.toThrow(/Forbidden/);
  });

  it('ATTACK: a state administrator cannot compute a national table', async () => {
    // competition:write held only in one state; a national ranking has no state
    // to scope against, so the check refuses it.
    await expect(computeRanking(db, { principal: stateAdmin }, {
      rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'forbidden-state',
    }, NOW)).rejects.toThrow(/Forbidden/);
  });

  it('ATTACK: publication needs result:finalize, which a state administrator lacks', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'publish-guard',
    }, NOW);
    await expect(publishRanking(db, { principal: stateAdmin }, r.periodId, NOW))
      .rejects.toThrow(/Forbidden/);
  });
});

describe('explainRanking', () => {
  it('gives an athlete the full working behind a published position', async () => {
    const period = (await db.select().from(s.rankingPeriods).where(and(
      eq(s.rankingPeriods.rulesetId, RS_PREV), eq(s.rankingPeriods.label, 'prev-1')
    )).limit(1))[0];

    const x = await explainRanking(db, { principal: athlete }, { personId: P.A, periodId: period.id });
    expect(x.published).toBe(true);
    expect(x.rank).toBe(1);
    expect(x.points).toBe(2100);
    expect(x.ruleset.code).toBe('RS-PREV');
    expect(x.working.contributions.length).toBe(3);
    expect(x.working.contributions.every((c) => typeof c.reason === 'string' && c.reason.length > 0)).toBe(true);
    expect(x.working.options.bestN.applied).toBe(false);
  });

  it('ATTACK: an unpublished working document is not public', async () => {
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'draft-working',
    }, NOW);
    await expect(explainRanking(db, { principal: athlete }, { personId: P.A, periodId: r.periodId }))
      .rejects.toThrow(/Forbidden/);
    await expect(explainRanking(db, { principal: national }, { personId: P.A, periodId: r.periodId }))
      .resolves.toBeTruthy();
  });

  it('says plainly when an athlete has no entry in that table', async () => {
    const period = (await db.select().from(s.rankingPeriods).where(and(
      eq(s.rankingPeriods.rulesetId, RS_PREV), eq(s.rankingPeriods.label, 'prev-1')
    )).limit(1))[0];
    await expect(explainRanking(db, { principal: athlete }, { personId: P.Gita, periodId: period.id }))
      .rejects.toThrow(RankingError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review pass. Each block below is a defect that WAS present and is now closed;
// every one of these failed before the fix.

describe('ATTACK: a rule the federation approved must never be silently ignored', () => {
  it('refuses a points table keyed by anything but a plain placing', async () => {
    // The damaging case: the federation approves 1000 points for a national
    // title, writes the placing as "first", and the engine finds nothing at
    // key "1". It used to compute a table in which the national champion scored
    // ZERO and was told "the ruleset sets no points for placing 1" — a table
    // that contradicts the approved rules and blames the rules for it.
    const id = await makeRuleset('RS-WORDKEY', {
      rules: { points: { national_championship: { first: 1000, 2: 700 } } },
    });
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'wordkey',
    }, NOW)).rejects.toThrow(/keyed by "first"/);

    // And nothing was written: a refused ruleset leaves no period behind.
    const left = await db.select().from(s.rankingPeriods).where(eq(s.rankingPeriods.rulesetId, id));
    expect(left).toEqual([]);
  });

  it('refuses a padded placing key, which would shadow the real one', async () => {
    const id = await makeRuleset('RS-PADKEY', {
      rules: { points: { national_championship: { '01': 1000 } } },
    });
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'padkey',
    }, NOW)).rejects.toThrow(/keyed by "01"/);
  });

  it('refuses a bad points value at a placing NOBODY reached this season', async () => {
    // Validation is eager on purpose. A 2.5 parked at 8th place used to be
    // invisible until an eighth-place finisher appeared, so whether the ruleset
    // was computable depended on who turned up. Nobody in CAT_MAIN placed 8th.
    const id = await makeRuleset('RS-LATENT-FLOAT', {
      rules: { points: { national_championship: { 1: 1000, 8: 2.5 } } },
    });
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'latent-float',
    }, NOW)).rejects.toThrow(/rules\.points\.national_championship\.8 is 2\.5/);
  });

  it('refuses negative points rather than treating them as a penalty rule', async () => {
    const id = await makeRuleset('RS-NEGATIVE', {
      rules: { points: { national_championship: { 1: 1000, 4: -50 } } },
    });
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'negative',
    }, NOW)).rejects.toThrow(/non-negative whole numbers/i);
  });
});

describe('ATTACK: one category, one table', () => {
  it('refuses a differently-spelled key instead of opening a second table', async () => {
    // `categoryKeyFor` lower-cases what it derives from a category row, so an
    // upper-cased key matches NOTHING. It used to compute and store an empty
    // period under that spelling — a second ranking table for a category that
    // already had one, with the previousRank chain silently broken.
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: 'kumite|Male|cadet|max61000', asOf: AS_OF, label: 'shadow',
    }, NOW)).rejects.toThrow(/must be given exactly as "kumite\|male\|cadet\|max61000"/);

    const left = await db.select().from(s.rankingPeriods)
      .where(eq(s.rankingPeriods.categoryKey, 'kumite|Male|cadet|max61000'));
    expect(left).toEqual([]);
  });

  it('refuses a weight component it cannot read, rather than ranking nobody', async () => {
    // "-61kg" is a label; the record is grams. This used to produce a perfectly
    // well-formed EMPTY table with no hint that the key was meaningless.
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: 'kumite|male|cadet|61kg', asOf: AS_OF, label: 'badweight',
    }, NOW)).rejects.toThrow(/is not a weight component/);
  });

  it('refuses an empty component instead of guessing it meant "unset"', async () => {
    await expect(computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: 'kumite||cadet|max61000', asOf: AS_OF, label: 'blank',
    }, NOW)).rejects.toThrow(/exactly as "kumite\|\*\|cadet\|max61000"/);
  });
});

describe('ATTACK: a cancelled championship awards nothing', () => {
  it('refuses to score a final result whose event was called off, and names why', async () => {
    const ev = await makeEvent('national_championship', '2026-06-20', CAT_EXCL);
    const res = await makeResult(ev, P.Qadir, 1, 'gold');            // final, 1000 points
    const before = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_EXCL, asOf: AS_OF, label: 'cancel-before',
    }, NOW);
    expect(before.entries.find((e) => e.personId === P.Qadir)!.points).toBe(1000);

    // The federation cancels the event. The result row is untouched — it is
    // still `final` — which is exactly the trap: the ranking used to keep
    // paying out on a competition that did not happen.
    await db.update(s.competitionEvents).set({ status: 'cancelled' })
      .where(eq(s.competitionEvents.id, ev.event.id));

    const after = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_EXCL, asOf: AS_OF, label: 'cancel-after',
    }, NOW);
    const q = after.entries.find((e) => e.personId === P.Qadir)!;
    expect(q.points).toBe(0);
    const c = find(q.working, (x) => x.resultId === res.id);
    expect(c.counted).toBe(false);
    expect(c.reason).toBe('event cancelled');
    expect(c.eventStatus).toBe('cancelled');
    expect(c.detail).toMatch(/cancelled/);

    // Leave the fixture as it was found.
    await db.delete(s.competitionResults).where(eq(s.competitionResults.id, res.id));
  });
});

describe('ATTACK: an unpriced result must not decide a rank', () => {
  it('does not let a result the ruleset never priced feed a tie-break', async () => {
    // D holds an open_national gold (event kind unpriced) and a national 4th
    // (placing unpriced). Both are eligible and both are worth ZERO, so D is
    // level with C, who has nothing at all. Counting them in
    // goldCount/countedResults would let results worth nothing outrank a fellow
    // athlete on metrics meant to measure the form that produced the points.
    const id = await makeRuleset('RS-TIE-UNPRICED', {
      tieBreak: [{ key: 'countedResults', direction: 'desc' }, { key: 'goldCount', direction: 'desc' }],
    });
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'tie-unpriced',
    }, NOW);

    const c = r.entries.find((e) => e.personId === P.C)!;
    const d = r.entries.find((e) => e.personId === P.D)!;
    expect([c.points, d.points]).toEqual([0, 0]);
    expect(d.working.tieBreakValues).toEqual({ countedResults: 0, goldCount: 0 });
    expect(c.working.tieBreakValues).toEqual({ countedResults: 0, goldCount: 0 });
    // Nothing separated them, so they SHARE a rank.
    expect(c.rank).toBe(d.rank);
    expect(d.working.sharedRankWithPersonIds).toContain(P.C);

    // The working still shows D both results, marked unpriced, so D can see why.
    const unpriced = d.working.contributions.filter((x) => !x.priced && x.counted);
    expect(unpriced.length).toBe(2);
    expect(unpriced.every((x) => x.reason === 'not covered by ruleset' && x.points === 0)).toBe(true);

    // And the table says, in words, which results the figures were counted over.
    expect(d.working.options.tieBreak.detail).toMatch(/those the ruleset priced/);
  });
});

describe('ATTACK: publication is stamped once', () => {
  it('two publishers racing the same table do not overwrite each other', async () => {
    const other: Principal = {
      userId: 99, label: 'second-publisher',
      bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
    };
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'race-publish',
    }, NOW);

    // Both read the period BEFORE either writes, so both see publishedAt null
    // and both pass the check. The guard has to live in the UPDATE itself.
    const LATER = new Date('2026-08-13T00:00:00Z');
    const outcomes = await Promise.allSettled([
      publishRanking(db, { principal: national }, r.periodId, NOW),
      publishRanking(db, { principal: other }, r.periodId, LATER),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled').length).toBe(1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(RankingError);
    expect(rejected.reason.code).toBe('already_published');

    // Exactly one publication stands, and it is the FIRST one.
    const period = (await db.select().from(s.rankingPeriods)
      .where(eq(s.rankingPeriods.id, r.periodId)).limit(1))[0];
    expect(new Date(period.publishedAt).toISOString()).toBe(NOW.toISOString());
    expect(period.publishedByUserId).toBe(1);

    // And the act was audited once, not twice.
    const audits = await db.select().from(s.auditEvents).where(and(
      eq(s.auditEvents.entityType, 'ranking_period'),
      eq(s.auditEvents.entityId, String(r.periodId)),
      eq(s.auditEvents.action, 'finalize')
    ));
    expect(audits.length).toBe(1);
  });

  it('a recompute that reads BEFORE a publication cannot write after it', async () => {
    // The window this closes: computeRanking reads the period, finds it
    // unpublished, and only then writes. Everything published in between used to
    // be wiped — the UPDATE overwrote the row and the very next statement
    // DELETEd every entry out of a table the federation had just put out.
    //
    // Holding compute at exactly that instant is the only way to prove the
    // guard: on one PGlite connection the two calls never interleave there by
    // themselves, and a Promise.all of them is a happy path wearing an attack's
    // clothes. So the recompute's UPDATE is held open while a publication lands.
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'race-recompute',
    }, NOW);
    const published = r.entries.length;
    expect(published).toBeGreaterThan(0);

    let atTheWrite!: () => void;
    const reachedWrite = new Promise<void>((res) => { atTheWrite = res; });
    let release!: () => void;
    const held = new Promise<void>((res) => { release = res; });

    const recompute = computeRanking(holdFirstUpdate(db, () => { atTheWrite(); return held; }),
      { principal: national },
      { rulesetId: RS_BASE, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'race-recompute' },
      NOW);

    await reachedWrite;                 // compute has read the period; nothing written yet
    await publishRanking(db, { principal: national }, r.periodId, NOW);
    release();                          // compute's UPDATE now fires, against a PUBLISHED row

    await expect(recompute).rejects.toThrow(/published while this computation was running/);

    const period = (await db.select().from(s.rankingPeriods)
      .where(eq(s.rankingPeriods.id, r.periodId)).limit(1))[0];
    const rows = await db.select().from(s.rankingEntries)
      .where(eq(s.rankingEntries.periodId, r.periodId));
    expect(period.publishedAt).toBeTruthy();
    expect(rows.length).toBe(published);          // the published table is intact
    expect(period.athleteCount).toBe(published);  // and its counts did not drift
  });
});

describe('a published table stays defensible after the ruleset moves on', () => {
  it('keeps the approved points table in the entry, not only a pointer to it', async () => {
    const id = await makeRuleset('RS-SNAPSHOT');
    const r = await computeRanking(db, { principal: national }, {
      rulesetId: id, categoryKey: CAT_MAIN, asOf: AS_OF, label: 'snapshot',
    }, NOW);
    await publishRanking(db, { principal: national }, r.periodId, NOW);

    // The federation revalues national titles for next season, on the same row.
    await db.update(s.rankingRulesets)
      .set({ rules: { points: { national_championship: { 1: 5000 } } } })
      .where(eq(s.rankingRulesets.id, id));

    const x = await explainRanking(db, { principal: athlete }, { personId: P.A, periodId: r.periodId });
    expect(x.points).toBe(2100);
    // The whole arithmetic is re-derivable from the entry alone: every cited
    // rule path resolves inside the snapshot, to the value that was applied.
    for (const c of x.working.contributions.filter((y) => y.priced)) {
      const bits = c.rule!.split('.');
      const placing = bits.pop()!;
      expect(x.working.pointsTable[bits.join('.')][placing]).toBe(c.points);
    }
    expect(x.working.pointsTable['rules.points.national_championship']['1']).toBe(1000);
  });
});
