// The draw engine, against real Postgres.
//
// The invariant these tests exist to protect: A DRAW CAN BE REPRODUCED FROM ITS
// OWN RECORD. Everything else here supports that claim — that the seed drives
// every random decision, that the record carries enough to re-run it, and that
// a published draw is superseded with a reason rather than quietly redrawn.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  generateDraw, publishDraw, planDraw, readDraw, verifyDrawReproducible,
  createRng, canonicalOrder, seedInputDigest, ALGORITHM_VERSION, DrawError,
} from '../src/db/draws';
import type { Principal } from '../src/lib/rbac';

let db: any, JH: number, DOJO: number, EVENT: number;
let catSeq = 0, personSeq = 0, entrySeq = 0;

const NOW = new Date('2026-08-12T00:00:00Z');

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 2, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
const referee: Principal = {
  userId: 3, label: 'referee',
  bindings: [{ role: 'REFEREE', scopeType: 'national', scopeId: null }],
};

async function makeCategory(over: Record<string, unknown> = {}) {
  const [c] = await db.insert(s.eventCategories).values({
    eventId: EVENT,
    code: `CAT-${String(++catSeq).padStart(3, '0')}`,
    label: `Category ${catSeq}`,
    discipline: 'kumite',
    ...over,
  }).returning();
  return c;
}

/** n confirmed entries, optionally seeded. Seeds are applied in order. */
async function makeEntries(categoryId: number, n: number, seeds: Array<number | null> = []) {
  const out: any[] = [];
  for (let i = 0; i < n; i++) {
    personSeq++;
    const [p] = await db.insert(s.persons).values({
      federationId: `MMAKF-MEM-2026-${String(personSeq).padStart(6, '0')}`,
      fullName: `Athlete ${personSeq}`,
      stateUnitId: JH, dojoId: DOJO, status: 'active',
    }).returning();
    entrySeq++;
    const [e] = await db.insert(s.eventEntries).values({
      entryNo: `MMAKF-ENT-2026-${String(entrySeq).padStart(6, '0')}`,
      eventId: EVENT, categoryId, personId: p.id,
      dojoId: DOJO, stateUnitId: JH,
      status: 'confirmed',
      seed: seeds[i] ?? null,
    }).returning();
    out.push(e);
  }
  return out;
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

  const [ev] = await db.insert(s.competitionEvents).values({
    code: 'MMAKF-EVT-2026-000001',
    title: 'National Championship 2026',
    kind: 'national_championship',
    status: 'registration_closed',
    startsOn: '2026-09-01',
  }).returning({ id: s.competitionEvents.id });
  EVENT = ev.id;
});

// ─── The central requirement ────────────────────────────────────────────────

describe('THE INVARIANT: a draw is reproducible from its recorded seed', () => {
  it('regenerating from the same seed produces an IDENTICAL bracket', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 13);

    const first = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: 'MMAKF-DRAW-SEED-2026-09-01-KUM61',
    }, NOW);

    // A second generation, from the seed the first one recorded.
    const second = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: first.draw.randomSeed,
    }, NOW);

    expect(second.draw.id).not.toBe(first.draw.id);            // a new draw row…
    expect(second.plan.matches).toEqual(first.plan.matches);   // …and the same bracket

    const a = await readDraw(db, first.draw.id, national);
    const b = await readDraw(db, second.draw.id, national);
    expect(b.matches).toEqual(a.matches);                      // identical once persisted, too
  });

  it('verifies a stored draw by re-running it from its own record', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 11);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'audit-me' }, NOW);

    const check = await verifyDrawReproducible(db, draw.id, national);
    expect(check.reproducible).toBe(true);
    expect(check.differences).toEqual([]);
    expect(check.algorithmVersion).toBe(ALGORITHM_VERSION);
  });

  it('ATTACK: a bracket edited behind the engine no longer reproduces, and says where', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    const entries = await makeEntries(cat.id, 8);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'tamper' }, NOW);

    const rows = await db.select().from(s.matches).where(eq(s.matches.drawId, draw.id));
    const first = rows.sort((x: any, y: any) => x.id - y.id)[0];
    const intruder = entries.find((e) => e.id !== first.redEntryId && e.id !== first.blueEntryId)!;
    await db.update(s.matches).set({ redEntryId: intruder.id }).where(eq(s.matches.id, first.id));

    const check = await verifyDrawReproducible(db, draw.id, national);
    expect(check.reproducible).toBe(false);
    expect(check.differences.join(' ')).toMatch(/Bout 1: stored red=/);
  });

  it('a different seed produces a different bracket', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 16);

    const a = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'seed-alpha' }, NOW);
    const b = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'seed-beta' }, NOW);

    expect(b.plan.order.map((o) => o.entryNo)).not.toEqual(a.plan.order.map((o) => o.entryNo));
    expect(b.plan.matches).not.toEqual(a.plan.matches);
  });

  it('the record carries the exact ordered entry list the bracket was built from', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    const entries = await makeEntries(cat.id, 6);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'record' }, NOW);

    const stored = draw.seedInput as any;
    expect(stored.entries.map((e: any) => e.entryNo).sort())
      .toEqual(entries.map((e) => e.entryNo).sort());
    expect(stored.algorithmVersion).toBe(ALGORITHM_VERSION);
    expect(stored.entryStatusesIncluded).toContain('confirmed');
    expect(draw.randomSeed).toBe('record');
  });
});

describe('the generator itself is deterministic', () => {
  it('the same seed gives the same stream; a different seed does not', () => {
    const a = createRng('same');
    const b = createRng('same');
    const c = createRng('other');
    const draw5 = (r: ReturnType<typeof createRng>) => [1, 2, 3, 4, 5].map(() => r.nextUint32());
    const first = draw5(a);
    expect(draw5(b)).toEqual(first);
    expect(draw5(c)).not.toEqual(first);
    // Every value must be an unsigned 32-bit integer: a signed intermediate
    // would silently change the stream on some seeds.
    expect(first.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff)).toBe(true);
  });

  it('nextInt stays inside its bound', () => {
    const r = createRng('bounds');
    for (let i = 0; i < 500; i++) {
      const v = r.nextInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it('the pure planner is a function of its inputs alone', () => {
    const entries = Array.from({ length: 9 }, (_, i) => ({
      entryId: i + 1, entryNo: `E-${String(i + 1).padStart(3, '0')}`, seed: null,
    }));
    const one = planDraw({ entries, format: 'single_elimination', seed: 'pure' });
    // Input order must not matter: canonicalisation happens inside.
    const two = planDraw({ entries: [...entries].reverse(), format: 'single_elimination', seed: 'pure' });
    expect(two.matches).toEqual(one.matches);
    expect(two.order).toEqual(one.order);
  });

  it('orders entries without locale-dependent comparison', () => {
    const ordered = canonicalOrder([
      { entryId: 3, entryNo: 'E-003', seed: null },
      { entryId: 1, entryNo: 'E-001', seed: 2 },
      { entryId: 2, entryNo: 'E-002', seed: 1 },
    ]);
    expect(ordered.map((e) => e.entryNo)).toEqual(['E-002', 'E-001', 'E-003']);
  });
});

// ─── Bracket shape ──────────────────────────────────────────────────────────

describe('single elimination', () => {
  it.each([
    [5, 8, 3, 7],
    [8, 8, 3, 7],
    [16, 16, 4, 15],
  ])('%i entries → a bracket of %i, %i rounds, %i bouts', async (n, size, rounds, bouts) => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, n);
    const { draw, plan } = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: `rounds-${n}`,
    }, NOW);

    expect(plan.bracketSize).toBe(size);
    expect(plan.roundsCount).toBe(rounds);
    expect(plan.matches.length).toBe(bouts);
    expect(draw.roundsCount).toBe(rounds);
    expect(draw.entryCount).toBe(n);
    expect(plan.matches.filter((m) => m.round === 'F').length).toBe(1);
  });

  it('byes land on the top seeds, and those entries advance automatically', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    const entries = await makeEntries(cat.id, 5, [1, 2, 3, 4, 5]);
    const { plan } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'byes' }, NOW);

    // Seeds 1..5 are placed in seed order, so positions 1..5 are entries 1..5.
    expect(plan.order.map((o) => o.entryNo)).toEqual(entries.map((e) => e.entryNo));

    const byes = plan.matches.filter((m) => m.bye);
    expect(byes.length).toBe(3);                                   // 8-position bracket, 5 entries
    expect(byes.map((m) => m.winner).sort())
      .toEqual([entries[0].entryNo, entries[1].entryNo, entries[2].entryNo].sort());
    for (const b of byes) {
      expect(b.status).toBe('walkover');
      expect(b.winMethod).toBe('bye');
      expect(b.byeReason).toMatch(/No opponent/);
    }

    // The bye winner is already standing in the next round: progression is data.
    for (const b of byes) {
      const next = plan.matches.find((m) => m.index === b.advancesToIndex)!;
      const slot = b.advancesToSlot === 'red' ? next.red : next.blue;
      expect(slot).toBe(b.winner);
    }
  });

  it('the top two seeds can only meet in the final', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    const entries = await makeEntries(cat.id, 16, Array.from({ length: 16 }, (_, i) => i + 1));
    const { plan } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'seeded-16' }, NOW);

    const one = entries[0].entryNo, two = entries[1].entryNo;
    const met = plan.matches.find(
      (m) => (m.red === one && m.blue === two) || (m.red === two && m.blue === one)
    );
    expect(met).toBeUndefined();   // they cannot be drawn together in round one

    // Follow each of them down the bracket: their paths only converge at the final.
    const pathOf = (entryNo: string) => {
      const seen: number[] = [];
      let m = plan.matches.find((x) => x.red === entryNo || x.blue === entryNo)!;
      while (m) {
        seen.push(m.index);
        if (m.advancesToIndex == null) break;
        m = plan.matches.find((x) => x.index === m.advancesToIndex)!;
      }
      return seen;
    };
    const shared = pathOf(one).filter((i) => pathOf(two).includes(i));
    expect(shared).toEqual([plan.matches[plan.matches.length - 1].index]);   // the final only
  });

  it('every bout but the final records where its winner goes', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 8);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'wiring' }, NOW);

    const { matches } = await readDraw(db, draw.id, national);
    const finals = matches.filter((m) => m.round === 'F');
    expect(finals.length).toBe(1);
    // The final goes nowhere — both columns must be clear, not merely one.
    expect(finals[0].advancesToIndex).toBeNull();
    expect(finals[0].advancesToSlot).toBeNull();
    const raw = await db.select().from(s.matches).where(eq(s.matches.drawId, draw.id));
    expect(raw.filter((r: any) => r.advancesToMatchId == null).length).toBe(1);
    for (const m of matches.filter((x) => x.round !== 'F')) {
      expect(m.advancesToIndex).not.toBeNull();
      expect(['red', 'blue']).toContain(m.advancesToSlot);
    }
  });

  it('records the reason for a bye in the append-only match log', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 5, [1, 2, 3, 4, 5]);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'bye-log' }, NOW);

    const walkovers = await db.select().from(s.matches).where(eq(s.matches.drawId, draw.id));
    const wo = walkovers.filter((m: any) => m.status === 'walkover');
    expect(wo.length).toBe(3);

    for (const m of wo) {
      const events = await db.select().from(s.matchEvents).where(eq(s.matchEvents.matchId, m.id));
      expect(events.length).toBe(1);
      expect(events[0].action).toBe('bye');
      expect(events[0].note).toMatch(/No opponent/);
      expect(events[0].side).toBe(m.redEntryId ? 'red' : 'blue');
    }
  });

  it('refuses a field of one — there is no draw to make', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 1);
    await expect(generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'lonely' }, NOW))
      .rejects.toThrow(/at least two entries/i);
  });

  it('draws only entries the event has accepted', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    const entries = await makeEntries(cat.id, 6);
    await db.update(s.eventEntries).set({ status: 'withdrawn' }).where(eq(s.eventEntries.id, entries[0].id));
    await db.update(s.eventEntries).set({ status: 'fee_pending' }).where(eq(s.eventEntries.id, entries[1].id));

    const { plan } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'accepted' }, NOW);
    expect(plan.entryCount).toBe(4);
    expect(plan.order.map((o) => o.entryNo)).not.toContain(entries[0].entryNo);
    expect(plan.order.map((o) => o.entryNo)).not.toContain(entries[1].entryNo);
  });
});

describe('round robin', () => {
  it('pairs every entry with every other exactly once', async () => {
    const cat = await makeCategory({ drawFormat: 'round_robin' });
    const entries = await makeEntries(cat.id, 5);
    const { plan } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'rr5' }, NOW);

    expect(plan.matches.length).toBe(10);                    // 5 * 4 / 2
    expect(plan.roundsCount).toBe(5);                        // odd field: one sits out each round
    const pairs = plan.matches.map((m) => [m.red, m.blue].sort().join('|'));
    expect(new Set(pairs).size).toBe(10);
    for (const e of entries) {
      expect(plan.matches.filter((m) => m.red === e.entryNo || m.blue === e.entryNo).length).toBe(4);
    }
  });

  it('wires no progression, and says why', async () => {
    const cat = await makeCategory({ drawFormat: 'round_robin' });
    await makeEntries(cat.id, 4);
    const { plan } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'rr4' }, NOW);

    expect(plan.matches.every((m) => m.advancesToIndex === null)).toBe(true);
    expect(plan.notes.join(' ')).toMatch(/standings/i);
  });
});

describe('pool then elimination', () => {
  it('refuses to invent the pool structure', async () => {
    const cat = await makeCategory({ drawFormat: 'pool_then_elimination' });
    await makeEntries(cat.id, 8);
    await expect(generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'nopools' }, NOW))
      .rejects.toThrow(/regulations the federation sets/i);
  });

  it('builds pools and the bracket the qualifiers feed', async () => {
    const cat = await makeCategory({ drawFormat: 'pool_then_elimination' });
    await makeEntries(cat.id, 8);
    const { plan } = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: 'pools-8', pools: { poolCount: 2, advancePerPool: 2 },
    }, NOW);

    const pool = plan.matches.filter((m) => m.round === 'pool');
    expect(pool.length).toBe(12);                                  // two pools of four
    expect(new Set(pool.map((m) => m.poolLabel))).toEqual(new Set(['A', 'B']));

    const knockout = plan.matches.filter((m) => m.round !== 'pool');
    expect(knockout.length).toBe(3);                               // 4 qualifiers: 2 SF + F
    const semis = knockout.filter((m) => m.round === 'SF');
    // Cross-pool pairing falls out of the seeding: A1 v B2 and B1 v A2.
    expect(semis.map((m) => `${m.redSource}v${m.blueSource}`).sort()).toEqual(['A1vB2', 'B1vA2']);
    expect(semis.every((m) => m.advancesToIndex === knockout.find((k) => k.round === 'F')!.index)).toBe(true);
  });

  it('reports a same-pool meeting rather than applying a swap rule nobody approved', async () => {
    const cat = await makeCategory({ drawFormat: 'pool_then_elimination' });
    await makeEntries(cat.id, 9);
    const { plan } = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: 'pools-9', pools: { poolCount: 3, advancePerPool: 2 },
    }, NOW);

    expect(plan.bracketSize).toBe(8);                              // six qualifiers
    expect(plan.notes.join(' ')).toMatch(/same pool/i);
    // Byes go to the pool winners at the top of the qualifier order.
    const byes = plan.matches.filter((m) => m.bye);
    expect(byes.length).toBe(2);
    expect(byes.every((m) => m.winner === null)).toBe(true);       // who benefits is not yet known
  });

  it('refuses a pool that cannot supply the qualifiers asked of it', async () => {
    const cat = await makeCategory({ drawFormat: 'pool_then_elimination' });
    await makeEntries(cat.id, 6);
    await expect(generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: 'toosmall', pools: { poolCount: 3, advancePerPool: 3 },
    }, NOW)).rejects.toThrow(/holds 2 entries but 3 are set to advance/i);
  });
});

// ─── Refusals ───────────────────────────────────────────────────────────────

describe('an unimplemented format is refused, never approximated', () => {
  it.each(['single_elimination_repechage', 'kata_flag', 'kata_scoring', 'team_elimination'])(
    'refuses %s', async (format) => {
      const cat = await makeCategory({ drawFormat: format as any });
      await makeEntries(cat.id, 8);
      await expect(generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'x' }, NOW))
        .rejects.toThrow(/does not implement/i);
    }
  );

  it('names the code so a caller can branch on it', async () => {
    const cat = await makeCategory({ drawFormat: 'kata_flag' });
    await makeEntries(cat.id, 4);
    const err = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'x' }, NOW)
      .catch((e) => e);
    expect(err).toBeInstanceOf(DrawError);
    expect(err.code).toBe('format_not_implemented');
  });

  it('refuses a category whose format the federation has not set', async () => {
    const cat = await makeCategory({});                            // drawFormat null
    await makeEntries(cat.id, 4);
    await expect(generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'x' }, NOW))
      .rejects.toThrow(/No draw format is set/i);
  });

  it('refuses a blank seed rather than recording one that means nothing', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 4);
    await expect(generateDraw(db, { principal: national }, { categoryId: cat.id, seed: '   ' }, NOW))
      .rejects.toThrow(/blank seed/i);
  });

  it('records a generated seed when none is supplied, so the draw stays reproducible', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 4);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id }, NOW);
    expect(draw.randomSeed).toMatch(/^[0-9a-f]{32}$/);
    expect((await verifyDrawReproducible(db, draw.id, national)).reproducible).toBe(true);
  });
});

describe('authority', () => {
  it('ATTACK: an athlete cannot make a draw', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 4);
    await expect(generateDraw(db, { principal: athlete }, { categoryId: cat.id, seed: 'x' }, NOW))
      .rejects.toThrow(/Forbidden/);
  });

  it('ATTACK: a referee may enter results but may not make or publish a draw', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 4);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'ref' }, NOW);
    await expect(generateDraw(db, { principal: referee }, { categoryId: cat.id, seed: 'y' }, NOW))
      .rejects.toThrow(/Forbidden/);
    await expect(publishDraw(db, { principal: referee }, draw.id, NOW)).rejects.toThrow(/Forbidden/);
  });

  it('ATTACK: a state admin cannot draw an event outside their state', async () => {
    const [other] = await db.insert(s.stateUnits)
      .values({ code: 'ST-MH', state: 'Maharashtra', name: 'MH', status: 'active' })
      .returning({ id: s.stateUnits.id });
    const [stateEvent] = await db.insert(s.competitionEvents).values({
      code: 'MMAKF-EVT-2026-000002', title: 'Jharkhand State Championship',
      kind: 'state_championship', status: 'registration_closed', stateUnitId: JH,
    }).returning({ id: s.competitionEvents.id });
    const [cat] = await db.insert(s.eventCategories).values({
      eventId: stateEvent.id, code: 'SCAT-1', label: 'State cat',
      discipline: 'kumite', drawFormat: 'single_elimination',
    }).returning();

    // Entries belong to the state event's own category.
    for (let i = 0; i < 4; i++) {
      personSeq++; entrySeq++;
      const [p] = await db.insert(s.persons).values({
        federationId: `MMAKF-MEM-2026-${String(personSeq).padStart(6, '0')}`,
        fullName: `State Athlete ${personSeq}`, stateUnitId: JH, dojoId: DOJO, status: 'active',
      }).returning();
      await db.insert(s.eventEntries).values({
        entryNo: `MMAKF-ENT-2026-${String(entrySeq).padStart(6, '0')}`,
        eventId: stateEvent.id, categoryId: cat.id, personId: p.id,
        stateUnitId: JH, dojoId: DOJO, status: 'confirmed',
      });
    }

    const mhAdmin: Principal = {
      userId: 9, label: 'mh-admin',
      bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: other.id }],
    };
    const jhAdmin: Principal = {
      userId: 10, label: 'jh-admin',
      bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }],
    };

    await expect(generateDraw(db, { principal: mhAdmin }, { categoryId: cat.id, seed: 'x' }, NOW))
      .rejects.toThrow(/Forbidden/);
    await expect(generateDraw(db, { principal: jhAdmin }, { categoryId: cat.id, seed: 'x' }, NOW))
      .resolves.toBeTruthy();
  });
});

// ─── Publication and supersession ───────────────────────────────────────────

describe('publication', () => {
  it('is a separate, audited act', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 4);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'pub' }, NOW);
    expect(draw.publishedAt).toBeNull();

    const published = await publishDraw(db, { principal: national }, draw.id, NOW);
    expect(published.publishedAt).toBeTruthy();
    expect(published.publishedByUserId).toBe(1);

    const audit = await db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, String(draw.id)));
    expect(audit.some((a: any) => a.action === 'create')).toBe(true);
    expect(audit.some((a: any) => a.action === 'finalize')).toBe(true);
  });

  it('refuses to publish twice', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 4);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'twice' }, NOW);
    await publishDraw(db, { principal: national }, draw.id, NOW);
    await expect(publishDraw(db, { principal: national }, draw.id, NOW)).rejects.toThrow(/already published/i);
  });

  it('ATTACK: regenerating a PUBLISHED draw without a reason is refused', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 8);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'p1' }, NOW);
    await publishDraw(db, { principal: national }, draw.id, NOW);

    await expect(generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'p2' }, NOW))
      .rejects.toThrow(/requires a recorded reason/i);
  });

  it('supersedes rather than replaces, keeping the published draw and its bouts', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 8);
    const { draw: original } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'orig' }, NOW);
    await publishDraw(db, { principal: national }, original.id, NOW);

    const reason = 'Two entries were recorded in the wrong category; the technical delegate ordered a redraw.';
    const { draw: replacement } = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: 'redraw', reason,
    }, NOW);

    expect(replacement.supersedesDrawId).toBe(original.id);
    expect(replacement.regenerationReason).toBe(reason);

    // The superseded draw is intact: nothing was deleted.
    const old = await readDraw(db, original.id, national);
    expect(old.matches.length).toBe(7);
    expect(old.draw.publishedAt).toBeTruthy();

    // …and the reason reached the audit spine.
    const audit = await db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, String(replacement.id)));
    expect(audit[0].reason).toBe(reason);
    expect(audit[0].oldValue.supersededDrawId).toBe(original.id);

    // A superseded draw can no longer be published.
    const { draw: third } = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: 'third', reason: 'again',
    }, NOW);
    await expect(publishDraw(db, { principal: national }, replacement.id, NOW)).rejects.toThrow(/superseded/i);
    expect(third.supersedesDrawId).toBe(replacement.id);
  });

  it('ATTACK: a draw whose bouts have been contested cannot be redrawn over', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 4);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'live' }, NOW);
    const [m] = await db.select().from(s.matches).where(eq(s.matches.drawId, draw.id));
    await db.update(s.matches).set({ status: 'completed' }).where(eq(s.matches.id, m.id));

    await expect(generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: 'nope', reason: 'a coach complained',
    }, NOW)).rejects.toThrow(/already been contested/i);
  });

  it('a regenerated draw gets its own match numbers, so nothing collides', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 4);
    const a = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'n1' }, NOW);
    const b = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'n2' }, NOW);

    const nosA = [...a.matchIdByNo.keys()];
    const nosB = [...b.matchIdByNo.keys()];
    expect(nosA.some((n) => nosB.includes(n))).toBe(false);
    expect(nosA[0]).toMatch(/-D\d+-001$/);
  });
});

// ─── Edges that only show up in a real competition ──────────────────────────

describe('edges', () => {
  it('two entries make a final and nothing else', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 2);
    const { plan } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'two' }, NOW);
    expect(plan.bracketSize).toBe(2);
    expect(plan.roundsCount).toBe(1);
    expect(plan.matches.length).toBe(1);
    expect(plan.matches[0].round).toBe('F');
    expect(plan.matches[0].bye).toBe(false);
  });

  it('three entries give the single seed the bye', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    const entries = await makeEntries(cat.id, 3, [1, 2, 3]);
    const { plan } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'three' }, NOW);
    const byes = plan.matches.filter((m) => m.bye);
    expect(byes.length).toBe(1);
    expect(byes[0].winner).toBe(entries[0].entryNo);
  });

  it('a round robin reproduces from its record', async () => {
    const cat = await makeCategory({ drawFormat: 'round_robin' });
    await makeEntries(cat.id, 6);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'rr-repro' }, NOW);
    const check = await verifyDrawReproducible(db, draw.id, national);
    expect(check.differences).toEqual([]);
    expect(check.reproducible).toBe(true);
  });

  it('a pool draw reproduces from its record, pool structure included', async () => {
    const cat = await makeCategory({ drawFormat: 'pool_then_elimination' });
    await makeEntries(cat.id, 9);
    const { draw } = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: 'pool-repro', pools: { poolCount: 3, advancePerPool: 2 },
    }, NOW);
    const check = await verifyDrawReproducible(db, draw.id, national);
    expect(check.differences).toEqual([]);
    expect(check.reproducible).toBe(true);
    expect((draw.seedInput as any).pools).toEqual({ poolCount: 3, advancePerPool: 2 });
  });

  it('a superseded draw still reproduces — history stays defensible', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 7);
    const { draw: first } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'hist-1' }, NOW);
    await publishDraw(db, { principal: national }, first.id, NOW);
    await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'hist-2', reason: 'redraw ordered' }, NOW);

    expect((await verifyDrawReproducible(db, first.id, national)).reproducible).toBe(true);
  });

  it('FAILS CLOSED: a draw from another algorithm version is not claimed to reproduce', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 4);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'old-algo' }, NOW);
    await db.update(s.draws).set({ algorithmVersion: 'mmakf-draw-0' }).where(eq(s.draws.id, draw.id));

    const check = await verifyDrawReproducible(db, draw.id, national);
    expect(check.reproducible).toBe(false);
    expect(check.recomputed).toBeNull();
    expect(check.differences.join(' ')).toMatch(/will not claim otherwise/i);
  });

  it('FAILS CLOSED: a draw record stripped of its seed input cannot be verified', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 4);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'no-input' }, NOW);
    await db.update(s.draws).set({ seedInput: null }).where(eq(s.draws.id, draw.id));

    const check = await verifyDrawReproducible(db, draw.id, national);
    expect(check.reproducible).toBe(false);
    expect(check.differences.join(' ')).toMatch(/does not carry the seed and entry list/i);
  });

  it('an entry withdrawn AFTER the draw does not change what the draw reproduces to', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    const entries = await makeEntries(cat.id, 8);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'withdraw-after' }, NOW);
    await db.update(s.eventEntries).set({ status: 'withdrawn' }).where(eq(s.eventEntries.id, entries[3].id));

    const check = await verifyDrawReproducible(db, draw.id, national);
    expect(check.reproducible).toBe(true);
  });

  it('duplicate seeds are reported, not silently resolved', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 4, [1, 1, null, null]);
    const { plan } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'dupseed' }, NOW);
    expect(plan.notes.join(' ')).toMatch(/same seed/i);
  });
});


// ─── A draw is checked against a competition that has actually been run ─────
//
// The reproduction check exists to answer an accusation, and an accusation
// arrives AFTER the event. A check that reports "not reproducible" the moment a
// bout is won is worthless precisely when it is needed: results and progression
// are what the competition wrote, not what the draw did.

describe('verification of a bracket that has been played', () => {
  /** What the record looks like once a bout has been won and the winner advanced. */
  async function playFirstBout(drawId: number) {
    const rows = (await db.select().from(s.matches).where(eq(s.matches.drawId, drawId)))
      .sort((a: any, b: any) => a.id - b.id);
    const bout = rows.find((m: any) => m.redEntryId && m.blueEntryId)!;
    await db.update(s.matches)
      .set({ status: 'completed', winnerEntryId: bout.redEntryId, winMethod: 'points' })
      .where(eq(s.matches.id, bout.id));
    // matches.ts puts the winner into the slot the draw wired it to; this is
    // that row state, reproduced here so the draw module is tested against the
    // database a real competition leaves behind.
    const patch: any = {};
    patch[bout.advancesToSlot === 'red' ? 'redEntryId' : 'blueEntryId'] = bout.redEntryId;
    await db.update(s.matches).set(patch).where(eq(s.matches.id, bout.advancesToMatchId));
    return bout;
  }

  it('a recorded result and a filled progression slot are NOT draw differences', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 8);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'played' }, NOW);
    await publishDraw(db, { principal: national }, draw.id, NOW);

    const fresh = await verifyDrawReproducible(db, draw.id, national);
    expect(fresh.resultsSince).toEqual([]);          // nothing has happened yet

    await playFirstBout(draw.id);

    const check = await verifyDrawReproducible(db, draw.id, national);
    expect(check.differences).toEqual([]);
    expect(check.reproducible).toBe(true);           // the DRAW is untouched
    expect(check.resultsSince.join(' ')).toMatch(/a result has been recorded/i);
    expect(check.resultsSince.join(' ')).toMatch(/filled by progression/i);
  });

  it('ATTACK: a played bracket is still checked — moved wiring is a difference, not a result', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 8);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'played-tamper' }, NOW);
    await playFirstBout(draw.id);

    const rows = (await db.select().from(s.matches).where(eq(s.matches.drawId, draw.id)))
      .sort((a: any, b: any) => a.id - b.id);
    // Re-point the first quarter-final into the OTHER semi-final, so a
    // competitor arrives in the final from the wrong half of the bracket — the
    // classic rigged draw, hidden behind results that are themselves genuine.
    const otherSemi = rows.filter((m: any) => m.round === 'SF')[1];
    expect(rows[0].advancesToMatchId).not.toBe(otherSemi.id);
    await db.update(s.matches).set({ advancesToMatchId: otherSemi.id }).where(eq(s.matches.id, rows[0].id));

    const check = await verifyDrawReproducible(db, draw.id, national);
    expect(check.reproducible).toBe(false);
    expect(check.differences.join(' ')).toMatch(/advancesToIndex/);
    // …and the genuine results around it are still classed as results.
    expect(check.resultsSince.join(' ')).toMatch(/a result has been recorded/i);
  });

  it('ATTACK: a bye reassigned to another competitor is a difference, not a result', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    const entries = await makeEntries(cat.id, 5, [1, 2, 3, 4, 5]);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'bye-tamper' }, NOW);

    const rows = await db.select().from(s.matches).where(eq(s.matches.drawId, draw.id));
    const bye = rows.filter((m: any) => m.status === 'walkover')[0];
    await db.update(s.matches).set({ winnerEntryId: entries[4].id }).where(eq(s.matches.id, bye.id));

    const check = await verifyDrawReproducible(db, draw.id, national);
    expect(check.reproducible).toBe(false);
    expect(check.differences.join(' ')).toMatch(/awarded this bout to .* as a bye/i);
    expect(check.resultsSince.join(' ')).not.toMatch(/awarded this bout/i);
  });
});

// ─── The record itself is tamper-evident ────────────────────────────────────

describe('the record the draw is recomputed from is attested', () => {
  it('ATTACK: rewriting seedInput to change the ACCOUNT of the draw is caught', async () => {
    // The bracket is not touched, so re-running the draw still matches
    // perfectly. What is rewritten is the stored account of it — the warning
    // that two qualifiers from one pool were drawn together. Nothing in the
    // recomputation can notice that, because notes are not an input to it; only
    // the digest written to the audit spine at generation can.
    const cat = await makeCategory({ drawFormat: 'pool_then_elimination' });
    await makeEntries(cat.id, 9);
    const { draw } = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: 'forge-notes', pools: { poolCount: 3, advancePerPool: 2 },
    }, NOW);
    expect((draw.seedInput as any).notes.join(' ')).toMatch(/same pool/i);

    const doctored = { ...(draw.seedInput as any), notes: ['Draw made in the ordinary way.'] };
    await db.update(s.draws).set({ seedInput: doctored }).where(eq(s.draws.id, draw.id));

    const check = await verifyDrawReproducible(db, draw.id, national);
    expect(check.recordIntact).toBe(false);
    expect(check.reproducible).toBe(false);
    expect(check.differences.join(' ')).toMatch(/no longer matches the digest recorded in the audit spine/i);
  });

  it('an untouched record attests, and the digest survives the jsonb round trip', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 6);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'attest' }, NOW);

    const check = await verifyDrawReproducible(db, draw.id, national);
    expect(check.recordIntact).toBe(true);
    expect(check.reproducible).toBe(true);

    // Read back through the database, not from the returning() row: jsonb does
    // not preserve key order, so a digest that depended on it would fail here.
    const stored = (await db.select().from(s.draws).where(eq(s.draws.id, draw.id)))[0];
    const audit = await db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, String(draw.id)));
    const create = audit.find((a: any) => a.action === 'create');
    expect(seedInputDigest(stored.seedInput)).toBe(create.newValue.seedInputDigest);
  });

  it('FAILS CLOSED: a draw whose generation audit record is gone is not certified', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 4);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'no-audit' }, NOW);
    await db.delete(s.auditEvents).where(eq(s.auditEvents.entityId, String(draw.id)));

    const check = await verifyDrawReproducible(db, draw.id, national);
    expect(check.recordIntact).toBeNull();
    expect(check.reproducible).toBe(false);
    expect(check.differences.join(' ')).toMatch(/cannot be attested against the audit spine/i);
  });
});

// ─── Who may see a bracket ──────────────────────────────────────────────────

describe('an unpublished bracket is not public', () => {
  it('ATTACK: nobody reads an unpublished draw without the authority to have made it', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 8);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'secret' }, NOW);

    await expect(readDraw(db, draw.id)).rejects.toThrow(/Forbidden/);              // no viewer at all
    await expect(readDraw(db, draw.id, athlete)).rejects.toThrow(/Forbidden/);
    await expect(readDraw(db, draw.id, referee)).rejects.toThrow(/Forbidden/);     // may score, may not peek
    await expect(verifyDrawReproducible(db, draw.id, athlete)).rejects.toThrow(/Forbidden/);

    // Published, it is the bracket on the wall: no binding required.
    await publishDraw(db, { principal: national }, draw.id, NOW);
    const { matches } = await readDraw(db, draw.id);
    expect(matches.length).toBe(7);
    expect((await verifyDrawReproducible(db, draw.id)).reproducible).toBe(true);
  });
});

// ─── A bracket that has been competed on cannot be redrawn ──────────────────

describe('what counts as "already contested"', () => {
  async function drawnCategory(seed: string, n = 4) {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, n);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed }, NOW);
    const rows = (await db.select().from(s.matches).where(eq(s.matches.drawId, draw.id)))
      .sort((a: any, b: any) => a.id - b.id);
    return { cat, draw, rows };
  }

  it('ATTACK: a walkover awarded against a no-show blocks the redraw', async () => {
    const { cat, rows } = await drawnCategory('wo-block');
    const bout = rows.find((m: any) => m.redEntryId && m.blueEntryId)!;
    // A real no-show: two competitors assigned, one did not appear. Before this
    // was checked, the redraw treated it as an untouched bracket because the
    // engine's own byes are walkovers too.
    await db.update(s.matches)
      .set({ status: 'walkover', winnerEntryId: bout.redEntryId, winMethod: 'kiken' })
      .where(eq(s.matches.id, bout.id));

    await expect(generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: 'again', reason: 'a coach complained',
    }, NOW)).rejects.toThrow(/already been contested/i);
  });

  it('ATTACK: a bout paused mid-contest blocks the redraw', async () => {
    const { cat, rows } = await drawnCategory('paused-block');
    await db.update(s.matches).set({ status: 'paused' }).where(eq(s.matches.id, rows[0].id));
    await expect(generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: 'again', reason: 'x',
    }, NOW)).rejects.toThrow(/already been contested/i);
  });

  it('ATTACK: a bout with points on the log blocks the redraw even if its status still says scheduled', async () => {
    const { cat, rows } = await drawnCategory('scored-block');
    await db.insert(s.matchEvents).values({
      matchId: rows[0].id, sequence: 1, side: 'red', action: 'yuko', points: 1, at: NOW,
    });
    const err = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: 'again', reason: 'x',
    }, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(DrawError);
    expect(err.code).toBe('draw_in_progress');
    expect(err.message).toMatch(rows[0].matchNo);
  });

  it('the engine’s own byes are not contests, so an unplayed bracket can still be redrawn', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 5, [1, 2, 3, 4, 5]);
    const { draw: first } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'bye-ok-1' }, NOW);
    const wo = (await db.select().from(s.matches).where(eq(s.matches.drawId, first.id)))
      .filter((m: any) => m.status === 'walkover');
    expect(wo.length).toBe(3);

    const { draw: second } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'bye-ok-2' }, NOW);
    expect(second.supersedesDrawId).toBe(first.id);
  });
});

// ─── Records that must not drift, and rules that must not be invented ───────

describe('the draw position is a cache of the CURRENT draw', () => {
  it('an entry dropped from the redraw does not keep a position in a bracket nobody is running', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    const entries = await makeEntries(cat.id, 8);
    await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'pos-1' }, NOW);

    const before = await db.select().from(s.eventEntries).where(eq(s.eventEntries.categoryId, cat.id));
    expect(before.every((e: any) => e.drawPosition != null)).toBe(true);

    await db.update(s.eventEntries).set({ status: 'withdrawn' }).where(eq(s.eventEntries.id, entries[0].id));
    await db.update(s.eventEntries).set({ status: 'withdrawn' }).where(eq(s.eventEntries.id, entries[1].id));

    const { plan } = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, seed: 'pos-2', reason: 'two withdrawals',
    }, NOW);

    const after = await db.select().from(s.eventEntries).where(eq(s.eventEntries.categoryId, cat.id));
    const byId = new Map<number, any>(after.map((e: any) => [e.id, e]));
    expect(byId.get(entries[0].id).drawPosition).toBeNull();
    expect(byId.get(entries[1].id).drawPosition).toBeNull();
    for (const o of plan.order) expect(byId.get(o.entryId).drawPosition).toBe(o.position);
  });
});

describe('the format is the federation’s, and an override says so', () => {
  it('ATTACK: drawing a category under a format the federation did not set for it needs a reason', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 6);
    const err = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, format: 'round_robin', seed: 'override',
    }, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(DrawError);
    expect(err.code).toBe('format_override_reason_required');
  });

  it('an override is recorded on the draw, not silently adopted', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 6);
    const { draw, plan } = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, format: 'round_robin', seed: 'override-ok',
      reason: 'The technical delegate ruled the entry count too small for a bracket.',
    }, NOW);

    const stored = draw.seedInput as any;
    expect(stored.formatSource).toBe('caller_override');
    expect(stored.formatConfiguredForCategory).toBe('single_elimination');
    expect(plan.notes.join(' ')).toMatch(/FORMAT OVERRIDE/);
    const audit = await db.select().from(s.auditEvents).where(eq(s.auditEvents.entityId, String(draw.id)));
    expect(audit[0].newValue.formatSource).toBe('caller_override');
  });

  it('a format supplied for a category the federation never configured is not passed off as configuration', async () => {
    const cat = await makeCategory({});                              // drawFormat null
    await makeEntries(cat.id, 4);
    const { draw, plan } = await generateDraw(db, { principal: national }, {
      categoryId: cat.id, format: 'single_elimination', seed: 'unconfigured',
    }, NOW);
    expect((draw.seedInput as any).formatSource).toBe('caller_supplied_none_configured');
    expect((draw.seedInput as any).formatConfiguredForCategory).toBeNull();
    expect(plan.notes.join(' ')).toMatch(/has set NO draw format/i);
  });
});

describe('what the draw refuses to decide, it reports', () => {
  it('states which entry statuses were drawn, so an absence can be explained', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    const entries = await makeEntries(cat.id, 5);
    await db.update(s.eventEntries).set({ status: 'fee_pending' }).where(eq(s.eventEntries.id, entries[0].id));
    const { plan } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'statuses' }, NOW);

    expect(plan.notes.join(' ')).toMatch(/confirmed, checked_in, weighed_in/);
    expect(plan.notes.join(' ')).toMatch(/4 of the 5 entries/);
    expect(plan.notes.join(' ')).toMatch(/1 fee_pending/);
    expect(entries.length).toBe(5);
  });

  it('reports a bracket that exceeds the federation’s configured entry cap without inventing an enforcement', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination', maxEntries: 4 });
    await makeEntries(cat.id, 6);
    const { plan, draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'cap' }, NOW);

    expect(plan.entryCount).toBe(6);                                 // the draw is still made…
    expect(plan.notes.join(' ')).toMatch(/maximum of 4/);             // …and the discrepancy is on the record
    expect((draw.seedInput as any).notes.join(' ')).toMatch(/exceeds the configured cap/i);
  });

  it('a category with no cap set is not measured against one', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    await makeEntries(cat.id, 6);
    const { plan } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'nocap' }, NOW);
    expect(plan.notes.join(' ')).not.toMatch(/maximum of/);
  });

  it('explains that seed NUMBERS were placed by rank, so a gap is not read as an empty seat', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    const entries = await makeEntries(cat.id, 6, [3, 7, null, null, null, null]);
    const { plan } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'sparse-seeds' }, NOW);

    expect(plan.notes.join(' ')).toMatch(/seed 3 → rank 1/);
    expect(plan.notes.join(' ')).toMatch(/seed 7 → rank 2/);
    // And the placement matches the account: placed by RANK, the two seeds sit
    // in opposite halves and their paths converge only at the final. Placed by
    // the literal numbers 3 and 7 in an eight-position bracket they would have
    // faced each other in round one, which is the defect this note exists for.
    expect(plan.order[0].entryNo).toBe(entries[0].entryNo);
    expect(plan.order[1].entryNo).toBe(entries[1].entryNo);
    const pathOf = (entryNo: string) => {
      const seen: number[] = [];
      let m = plan.matches.find((x) => x.red === entryNo || x.blue === entryNo)!;
      while (m) {
        seen.push(m.index);
        if (m.advancesToIndex == null) break;
        m = plan.matches.find((x) => x.index === m.advancesToIndex)!;
      }
      return seen;
    };
    const shared = pathOf(entries[0].entryNo).filter((i) => pathOf(entries[1].entryNo).includes(i));
    expect(shared).toEqual([plan.matches[plan.matches.length - 1].index]);
  });
});

describe('a closed record is not redrawn', () => {
  it('ATTACK: no draw can be generated once the event’s results are finalised', async () => {
    const [ev] = await db.insert(s.competitionEvents).values({
      code: 'MMAKF-EVT-2026-000003', title: 'Finalised Championship',
      kind: 'national_championship', status: 'results_final',
      resultsFinalisedAt: new Date('2026-07-01T00:00:00Z'),
    }).returning({ id: s.competitionEvents.id });
    const [cat] = await db.insert(s.eventCategories).values({
      eventId: ev.id, code: 'FCAT-1', label: 'Finalised cat',
      discipline: 'kumite', drawFormat: 'single_elimination',
    }).returning();
    for (let i = 0; i < 4; i++) {
      personSeq++; entrySeq++;
      const [p] = await db.insert(s.persons).values({
        federationId: `MMAKF-MEM-2026-${String(personSeq).padStart(6, '0')}`,
        fullName: `Finalised Athlete ${personSeq}`, stateUnitId: JH, dojoId: DOJO, status: 'active',
      }).returning();
      await db.insert(s.eventEntries).values({
        entryNo: `MMAKF-ENT-2026-${String(entrySeq).padStart(6, '0')}`,
        eventId: ev.id, categoryId: cat.id, personId: p.id,
        stateUnitId: JH, dojoId: DOJO, status: 'confirmed',
      });
    }

    const err = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'closed' }, NOW)
      .catch((e) => e);
    expect(err).toBeInstanceOf(DrawError);
    expect(err.code).toBe('results_finalised');
  });
});

describe('reading a historical draw', () => {
  it('an entry moved to another category afterwards does not make a sound draw look emptied', async () => {
    const cat = await makeCategory({ drawFormat: 'single_elimination' });
    const entries = await makeEntries(cat.id, 4);
    const { draw } = await generateDraw(db, { principal: national }, { categoryId: cat.id, seed: 'moved' }, NOW);
    await publishDraw(db, { principal: national }, draw.id, NOW);

    const other = await makeCategory({ drawFormat: 'single_elimination' });
    await db.update(s.eventEntries).set({ categoryId: other.id }).where(eq(s.eventEntries.id, entries[0].id));

    const { matches } = await readDraw(db, draw.id);
    expect(matches.flatMap((m) => [m.red, m.blue]).filter(Boolean)).toContain(entries[0].entryNo);
    expect((await verifyDrawReproducible(db, draw.id)).reproducible).toBe(true);
  });
});
