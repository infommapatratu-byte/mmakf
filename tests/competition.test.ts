// Competition events, categories and entries, against real Postgres.
//
// The invariants these tests exist to protect:
//   · an event cannot skip the lifecycle — no draft goes live, and registration
//     cannot open on a championship nobody sanctioned;
//   · an entry carries the evidence for its own eligibility decision;
//   · a rule MMAKF never set is never applied, and the record says it was unset.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createPerson } from '../src/db/federation';
import {
  LEGAL_TRANSITIONS, CompetitionError,
  createEvent, transitionEvent, sanctionEvent, addCategory,
  checkEntryEligibility, enterEvent, checkIn, recordWeighIn, withdraw,
  listEvents, eventWithCategories, categoryEntries,
} from '../src/db/competition';
import type { Principal } from '../src/lib/rbac';

let db: any, JH: number, KA: number, DOJO_JH: number, DOJO_JH2: number, DOJO_KA: number;
let OFFICIAL: number, PRESIDENT_P: number;

const NOW = new Date('2026-08-12T00:00:00Z');

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const president: Principal = {
  userId: 2, label: 'president',
  bindings: [{ role: 'PRESIDENT', scopeType: 'national', scopeId: null }],
};
let stateJH: Principal;   // STATE_ADMIN bound to Jharkhand
let stateKA: Principal;   // STATE_ADMIN bound to Karnataka
const athlete: Principal = {
  userId: 5, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
const member: Principal = {
  userId: 6, label: 'member',
  bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }],
};

/** An active member of the federation, ready to compete. */
async function makeAthlete(
  name: string,
  over: { dob?: string; gender?: string; stateUnitId?: number; dojoId?: number } = {},
  membership: { status?: string; validFrom?: string; validTo?: string | null } = {}
) {
  const p = await createPerson(db, { principal: national }, {
    fullName: name,
    stateUnitId: over.stateUnitId ?? JH,
    dojoId: over.dojoId ?? DOJO_JH,
  } as any);
  await db.update(s.persons).set({
    status: 'active', dob: over.dob ?? '2000-01-01', gender: over.gender ?? 'male',
  }).where(eq(s.persons.id, p.id));
  await db.insert(s.memberships).values({
    personId: p.id,
    category: 'athlete',
    validFrom: membership.validFrom ?? '2026-01-01',
    validTo: membership.validTo === undefined ? '2026-12-31' : membership.validTo,
    status: (membership.status ?? 'active') as any,
  });
  return p;
}

/** Drive an event all the way to open registration, the honest way. */
async function openEvent(
  category: Partial<Parameters<typeof addCategory>[2]> = {},
  event: Partial<Parameters<typeof createEvent>[2]> = {}
) {
  const ev = await createEvent(db, { principal: national }, {
    title: 'Test Championship', kind: 'national_championship',
    startsOn: '2026-09-01', endsOn: '2026-09-02', stateUnitId: JH,
    ...event,
  } as any);
  await transitionEvent(db, { principal: national }, { eventId: ev.id, to: 'technical_review', reason: 'ready' }, NOW);
  await transitionEvent(db, { principal: national }, { eventId: ev.id, to: 'sanction_review', reason: 'technical clearance given' }, NOW);
  await sanctionEvent(db, { principal: president }, {
    eventId: ev.id, sanctionedByPersonId: PRESIDENT_P, sanctionReference: 'MMAKF/SANC/2026/001',
  }, NOW);
  const cat = await addCategory(db, { principal: national }, {
    eventId: ev.id,
    code: `CAT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    label: 'Test Category', discipline: 'kumite',
    ...category,
  } as any);
  await transitionEvent(db, { principal: national }, { eventId: ev.id, to: 'published', reason: 'calendar published' }, NOW);
  await transitionEvent(db, { principal: national }, { eventId: ev.id, to: 'registration_open', reason: 'entries invited' }, NOW);
  const fresh = (await db.select().from(s.competitionEvents).where(eq(s.competitionEvents.id, ev.id)))[0];
  return { event: fresh, category: cat };
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
  const [ka] = await db.insert(s.stateUnits)
    .values({ code: 'ST-KA', state: 'Karnataka', name: 'KA', status: 'active' })
    .returning({ id: s.stateUnits.id });
  KA = ka.id;

  const [d1] = await db.insert(s.dojos)
    .values({ code: 'DJ-JH-1', name: 'Hombu', stateUnitId: JH, status: 'active' })
    .returning({ id: s.dojos.id });
  DOJO_JH = d1.id;
  const [d2] = await db.insert(s.dojos)
    .values({ code: 'DJ-JH-2', name: 'Second Dojo', stateUnitId: JH, status: 'active' })
    .returning({ id: s.dojos.id });
  DOJO_JH2 = d2.id;
  const [d3] = await db.insert(s.dojos)
    .values({ code: 'DJ-KA-1', name: 'Bengaluru Dojo', stateUnitId: KA, status: 'active' })
    .returning({ id: s.dojos.id });
  DOJO_KA = d3.id;

  stateJH = { userId: 3, label: 'jh-admin', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }] };
  stateKA = { userId: 4, label: 'ka-admin', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: KA }] };

  const pres = await createPerson(db, { principal: national }, { fullName: 'Sanctioning Authority', stateUnitId: JH } as any);
  PRESIDENT_P = pres.id;
  const off = await createPerson(db, { principal: national }, { fullName: 'Weigh-in Official', stateUnitId: JH } as any);
  OFFICIAL = off.id;
  // Applying four migrations into a fresh in-process Postgres runs past the
  // default 10s hook budget on a cold cache.
}, 120_000);

// ─────────────────────────────────────────────────────────────────────────────

describe('the lifecycle is a state machine, not a column', () => {
  it('always creates in draft, with an allocated event code', async () => {
    const ev = await createEvent(db, { principal: national }, {
      title: 'National Championship', kind: 'national_championship', stateUnitId: JH,
      // A caller-supplied status is not part of the input type and is ignored.
      status: 'registration_open',
    } as any);
    expect(ev.status).toBe('draft');
    expect(ev.code).toMatch(/^MMAKF-EVT-\d{4}-\d{6}$/);
  });

  it('ATTACK: refuses to take a draft straight to live', async () => {
    const ev = await createEvent(db, { principal: national }, {
      title: 'Skip The Queue', kind: 'open_national', stateUnitId: JH,
    } as any);
    await expect(transitionEvent(db, { principal: national }, {
      eventId: ev.id, to: 'live', reason: 'we are in a hurry',
    }, NOW)).rejects.toThrow(/cannot go from draft to live/i);
  });

  it('ATTACK: refuses to open registration on an event nobody sanctioned', async () => {
    // Written straight into the table, bypassing every earlier guard — the state
    // column alone must not be enough to take entries.
    const [raw] = await db.insert(s.competitionEvents).values({
      code: 'MMAKF-EVT-2026-900001', title: 'Unsanctioned', kind: 'open_national',
      status: 'published', stateUnitId: JH,
    }).returning();
    await addCategory(db, { principal: national }, {
      eventId: raw.id, code: 'C1', label: 'Cat', discipline: 'kata',
    } as any);

    await expect(transitionEvent(db, { principal: national }, {
      eventId: raw.id, to: 'registration_open', reason: 'entries invited',
    }, NOW)).rejects.toThrow(/has not been sanctioned/i);
  });

  it('refuses to open registration on an event with nothing to enter', async () => {
    const ev = await createEvent(db, { principal: national }, {
      title: 'No Categories', kind: 'open_national', stateUnitId: JH,
    } as any);
    await transitionEvent(db, { principal: national }, { eventId: ev.id, to: 'technical_review', reason: 'r' }, NOW);
    await transitionEvent(db, { principal: national }, { eventId: ev.id, to: 'sanction_review', reason: 'r' }, NOW);
    await sanctionEvent(db, { principal: president }, {
      eventId: ev.id, sanctionedByPersonId: PRESIDENT_P, sanctionReference: 'MMAKF/SANC/2026/EMPTY',
    }, NOW);
    await transitionEvent(db, { principal: national }, { eventId: ev.id, to: 'published', reason: 'r' }, NOW);

    await expect(transitionEvent(db, { principal: national }, {
      eventId: ev.id, to: 'registration_open', reason: 'entries invited',
    }, NOW)).rejects.toThrow(/no categories/i);
  });

  it('refuses approval except through sanctionEvent', async () => {
    const ev = await createEvent(db, { principal: national }, {
      title: 'Self Approved', kind: 'state_championship', stateUnitId: JH,
    } as any);
    await transitionEvent(db, { principal: national }, { eventId: ev.id, to: 'technical_review', reason: 'r' }, NOW);
    await transitionEvent(db, { principal: national }, { eventId: ev.id, to: 'sanction_review', reason: 'r' }, NOW);
    await expect(transitionEvent(db, { principal: national }, {
      eventId: ev.id, to: 'approved', reason: 'looks fine to me',
    }, NOW)).rejects.toThrow(/only through sanctionEvent/i);
  });

  it('demands a reason for every move, and records actor, time and reason', async () => {
    const ev = await createEvent(db, { principal: national }, {
      title: 'Reasoned', kind: 'seminar', stateUnitId: JH,
    } as any);
    await expect(transitionEvent(db, { principal: national }, {
      eventId: ev.id, to: 'technical_review', reason: '   ',
    }, NOW)).rejects.toThrow(/must record why/i);

    await transitionEvent(db, { principal: national }, {
      eventId: ev.id, to: 'technical_review', reason: 'submitted for technical review',
    }, NOW);
    const audit = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'competition_event'));
    const row = audit.find((a: any) => Number(a.entityId) === ev.id && a.action === 'update');
    expect(row.reason).toBe('submitted for technical review');
    expect(row.actorLabel).toBe('federation-admin');
    expect(row.oldValue).toEqual({ status: 'draft' });
    expect(row.newValue.status).toBe('technical_review');
    expect(row.newValue.at).toBe(NOW.toISOString());
  });

  it('treats cancelled and archived as terminal', async () => {
    expect(LEGAL_TRANSITIONS.cancelled).toEqual([]);
    expect(LEGAL_TRANSITIONS.archived).toEqual([]);

    const ev = await createEvent(db, { principal: national }, {
      title: 'Called Off', kind: 'camp', stateUnitId: JH,
    } as any);
    await transitionEvent(db, { principal: national }, {
      eventId: ev.id, to: 'cancelled', reason: 'venue withdrawn',
    }, NOW);
    await expect(transitionEvent(db, { principal: national }, {
      eventId: ev.id, to: 'draft', reason: 'back on',
    }, NOW)).rejects.toThrow(/is final and cannot change status/i);
  });

  it('the exported map never promises a move the module refuses', async () => {
    // LEGAL_TRANSITIONS is exported so an admin screen can render the legal
    // moves instead of keeping a copy that drifts. `postponed` listed
    // `approved`, which transitionEvent refuses unconditionally — a button that
    // always throws, and a state machine that lies about itself.
    for (const [from, tos] of Object.entries(LEGAL_TRANSITIONS)) {
      expect(tos, `${from} must not offer approved`).not.toContain('approved');
    }

    const ev = await createEvent(db, { principal: national }, {
      title: 'Postponed Then Resumed', kind: 'national_championship', stateUnitId: JH,
    } as any);
    await transitionEvent(db, { principal: national }, { eventId: ev.id, to: 'technical_review', reason: 'r' }, NOW);
    await transitionEvent(db, { principal: national }, { eventId: ev.id, to: 'sanction_review', reason: 'r' }, NOW);
    await sanctionEvent(db, { principal: president }, {
      eventId: ev.id, sanctionedByPersonId: PRESIDENT_P, sanctionReference: 'MMAKF/SANC/2026/PPD',
    }, NOW);
    await transitionEvent(db, { principal: national }, {
      eventId: ev.id, to: 'postponed', reason: 'venue flooded',
    }, NOW);
    await expect(transitionEvent(db, { principal: national }, {
      eventId: ev.id, to: 'approved', reason: 'resuming',
    }, NOW)).rejects.toThrow(/only through sanctionEvent/i);

    // It resumes by publication, and keeps the sanction it already carried —
    // a postponement does not withdraw the federation's approval.
    const back = await transitionEvent(db, { principal: national }, {
      eventId: ev.id, to: 'published', reason: 'new date confirmed',
    }, NOW);
    expect(back.status).toBe('published');
    expect(back.sanctionReference).toBe('MMAKF/SANC/2026/PPD');
  });

  it('refuses a no-op transition rather than writing a meaningless audit row', async () => {
    const ev = await createEvent(db, { principal: national }, {
      title: 'Same Again', kind: 'camp', stateUnitId: JH,
    } as any);
    await expect(transitionEvent(db, { principal: national }, {
      eventId: ev.id, to: 'draft', reason: 'no change',
    }, NOW)).rejects.toThrow(/already draft/i);
  });

  it('stamps who finalised the results, and when', async () => {
    const { event } = await openEvent();
    for (const to of ['registration_closed', 'check_in', 'live', 'results_pending', 'results_final'] as const) {
      await transitionEvent(db, { principal: national }, { eventId: event.id, to, reason: `moving to ${to}` }, NOW);
    }
    const [fresh] = await db.select().from(s.competitionEvents).where(eq(s.competitionEvents.id, event.id));
    expect(fresh.status).toBe('results_final');
    expect(fresh.resultsFinalisedAt).toBeTruthy();
    expect(fresh.resultsFinalisedByUserId).toBe(1);
  });

  it('ATTACK: refuses a transition by a principal with no competition authority', async () => {
    const ev = await createEvent(db, { principal: national }, {
      title: 'Not Yours', kind: 'camp', stateUnitId: JH,
    } as any);
    await expect(transitionEvent(db, { principal: athlete }, {
      eventId: ev.id, to: 'cancelled', reason: 'I do not like it',
    }, NOW)).rejects.toThrow(/Forbidden/);
  });

  it('ATTACK: refuses an event created outside the creator’s state', async () => {
    await expect(createEvent(db, { principal: stateKA }, {
      title: 'Cross Border', kind: 'state_championship', stateUnitId: JH,
    } as any)).rejects.toThrow(/Forbidden/);
  });

  it('refuses an event that ends before it starts', async () => {
    await expect(createEvent(db, { principal: national }, {
      title: 'Time Travel', kind: 'camp', stateUnitId: JH,
      startsOn: '2026-09-10', endsOn: '2026-09-01',
    } as any)).rejects.toThrow(/cannot end .* before it starts/i);
  });
});

describe('sanction — a championship without it is not a federation event', () => {
  async function awaitingSanction(title = 'Awaiting Sanction') {
    const ev = await createEvent(db, { principal: national }, {
      title, kind: 'national_championship', stateUnitId: JH,
    } as any);
    await transitionEvent(db, { principal: national }, { eventId: ev.id, to: 'technical_review', reason: 'r' }, NOW);
    await transitionEvent(db, { principal: national }, { eventId: ev.id, to: 'sanction_review', reason: 'r' }, NOW);
    return ev;
  }

  it('records who sanctioned it, under what reference, and approves it', async () => {
    const ev = await awaitingSanction();
    const row = await sanctionEvent(db, { principal: president }, {
      eventId: ev.id, sanctionedByPersonId: PRESIDENT_P,
      sanctionReference: 'MMAKF/SANC/2026/017', rulesetVersion: 'MMAKF-COMP-RULES-2026',
    }, NOW);

    expect(row.status).toBe('approved');
    expect(row.sanctionedByPersonId).toBe(PRESIDENT_P);
    expect(row.sanctionReference).toBe('MMAKF/SANC/2026/017');
    expect(row.sanctionedAt).toBeTruthy();

    const audit = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'competition_event'));
    const approval = audit.find((a: any) => Number(a.entityId) === ev.id && a.action === 'approve');
    expect(approval.authority).toBe('MMAKF/SANC/2026/017');
  });

  it('ATTACK: refuses a second sanction rather than overwriting the first', async () => {
    const ev = await awaitingSanction('Sanctioned Twice');
    await sanctionEvent(db, { principal: president }, {
      eventId: ev.id, sanctionedByPersonId: PRESIDENT_P, sanctionReference: 'MMAKF/SANC/2026/018',
    }, NOW);
    await expect(sanctionEvent(db, { principal: president }, {
      eventId: ev.id, sanctionedByPersonId: OFFICIAL, sanctionReference: 'MMAKF/SANC/2026/999',
    }, NOW)).rejects.toThrow(/already sanctioned/i);

    const [fresh] = await db.select().from(s.competitionEvents).where(eq(s.competitionEvents.id, ev.id));
    expect(fresh.sanctionReference).toBe('MMAKF/SANC/2026/018');
    expect(fresh.sanctionedByPersonId).toBe(PRESIDENT_P);
  });

  it('requires a federation reference', async () => {
    const ev = await awaitingSanction('No Reference');
    await expect(sanctionEvent(db, { principal: president }, {
      eventId: ev.id, sanctionedByPersonId: PRESIDENT_P, sanctionReference: '  ',
    }, NOW)).rejects.toThrow(/reference/i);
  });

  it('refuses to sanction an event that is not in sanction review', async () => {
    const ev = await createEvent(db, { principal: national }, {
      title: 'Straight To Sanction', kind: 'camp', stateUnitId: JH,
    } as any);
    await expect(sanctionEvent(db, { principal: president }, {
      eventId: ev.id, sanctionedByPersonId: PRESIDENT_P, sanctionReference: 'MMAKF/SANC/2026/020',
    }, NOW)).rejects.toThrow(/sanction review/i);
  });

  it('ATTACK: a state administrator can run an event but cannot sanction one', async () => {
    const ev = await awaitingSanction('State Self Sanction');
    await expect(sanctionEvent(db, { principal: stateJH }, {
      eventId: ev.id, sanctionedByPersonId: PRESIDENT_P, sanctionReference: 'MMAKF/SANC/2026/021',
    }, NOW)).rejects.toThrow(/Forbidden/);
  });

  it('the sanctioning person must be on the federation register', async () => {
    const ev = await awaitingSanction('Ghost Sanctioner');
    await expect(sanctionEvent(db, { principal: president }, {
      eventId: ev.id, sanctionedByPersonId: 999999, sanctionReference: 'MMAKF/SANC/2026/022',
    }, NOW)).rejects.toThrow(/not on the federation register/i);
  });
});

describe('categories — a bound the federation set must at least be coherent', () => {
  let EV: number;
  beforeAll(async () => {
    const ev = await createEvent(db, { principal: national }, {
      title: 'Category Bench', kind: 'open_national', stateUnitId: JH,
    } as any);
    EV = ev.id;
  });

  it('accepts a category with no bounds at all — every rule is MMAKF’s to set', async () => {
    const cat = await addCategory(db, { principal: national }, {
      eventId: EV, code: 'OPEN-KATA', label: 'Open Kata', discipline: 'kata',
    } as any);
    expect(cat.minAgeYears).toBeNull();
    expect(cat.maxWeightGrams).toBeNull();
    expect(cat.minGradeOrdinal).toBeNull();
  });

  it('ATTACK: refuses an inverted weight bound', async () => {
    await expect(addCategory(db, { principal: national }, {
      eventId: EV, code: 'BAD-W', label: 'Bad Weight', discipline: 'kumite',
      minWeightGrams: 75_000, maxWeightGrams: 61_000,
    } as any)).rejects.toThrow(/Minimum weight 75000g is above maximum weight 61000g/);
  });

  it('ATTACK: refuses an inverted age bound and an inverted birth window', async () => {
    await expect(addCategory(db, { principal: national }, {
      eventId: EV, code: 'BAD-A', label: 'Bad Age', discipline: 'kumite',
      minAgeYears: 18, maxAgeYears: 14,
    } as any)).rejects.toThrow(/Minimum age 18 is above maximum age 14/);

    await expect(addCategory(db, { principal: national }, {
      eventId: EV, code: 'BAD-B', label: 'Bad Birth Window', discipline: 'kumite',
      bornOnOrAfter: '2012-01-01', bornOnOrBefore: '2009-12-31',
    } as any)).rejects.toThrow(/is later than born-on-or-before/i);
  });

  it('ATTACK: refuses a weight that is not whole grams', async () => {
    await expect(addCategory(db, { principal: national }, {
      eventId: EV, code: 'FLOAT-W', label: 'Float Weight', discipline: 'kumite',
      maxWeightGrams: 61_500.5,
    } as any)).rejects.toThrow(/must be a whole number/i);
  });

  it('a team category needs a team size; an individual category cannot carry one', async () => {
    await expect(addCategory(db, { principal: national }, {
      eventId: EV, code: 'TEAM-NOSIZE', label: 'Team Kata', discipline: 'team_kata',
    } as any)).rejects.toThrow(/must state how many competitors/i);

    await expect(addCategory(db, { principal: national }, {
      eventId: EV, code: 'IND-SIZE', label: 'Individual', discipline: 'kata', teamSize: 3,
    } as any)).rejects.toThrow(/individual category cannot carry a team size/i);

    const ok = await addCategory(db, { principal: national }, {
      eventId: EV, code: 'TEAM-OK', label: 'Team Kata', discipline: 'team_kata', teamSize: 3,
    } as any);
    expect(ok.teamSize).toBe(3);
  });

  it('refuses a minimum grade with no kind — kyu descends and dan ascends', async () => {
    await expect(addCategory(db, { principal: national }, {
      eventId: EV, code: 'GRADE-HALF', label: 'Half A Rule', discipline: 'kumite',
      minGradeOrdinal: 3,
    } as any)).rejects.toThrow(/needs both an ordinal and a kind/i);
  });

  it('translates a duplicate category code into a clear error', async () => {
    await addCategory(db, { principal: national }, {
      eventId: EV, code: 'DUP-1', label: 'First', discipline: 'kumite',
    } as any);
    await expect(addCategory(db, { principal: national }, {
      eventId: EV, code: 'DUP-1', label: 'Second', discipline: 'kata',
    } as any)).rejects.toThrow(/already has a category with the code DUP-1/i);
  });

  it('does NOT dictate the federation’s gender vocabulary — any label it uses is stored', async () => {
    // The module previously enforced female|male|mixed. `persons.gender` is free
    // text filled in by MMAKF's own registration, so that list was the module
    // inventing which categories the federation is permitted to run.
    const cat = await addCategory(db, { principal: national }, {
      eventId: EV, code: 'GIRLS-KATA', label: 'Girls Kata', discipline: 'kata', gender: 'Girls',
    } as any);
    expect(cat.gender).toBe('girls');

    // A blank restriction is neither a restriction nor an absence, and is refused.
    await expect(addCategory(db, { principal: national }, {
      eventId: EV, code: 'BLANK-G', label: 'Blank Gender', discipline: 'kumite', gender: '   ',
    } as any)).rejects.toThrow(/either be set to a label the federation uses/i);
  });

  it('applies a federation-chosen gender label literally, and reports what it compared', async () => {
    const ev = await createEvent(db, { principal: national }, {
      title: 'Vocabulary', kind: 'open_national', stateUnitId: JH, startsOn: '2026-09-01',
    } as any);
    const cat = await addCategory(db, { principal: national }, {
      eventId: ev.id, code: 'WOMEN-KUM', label: 'Women Kumite', discipline: 'kumite', gender: 'women',
    } as any);
    const female = await makeAthlete('Recorded As Female', { gender: 'female' });

    const r = await checkEntryEligibility(db, national, female.id, cat.id, NOW);
    // Refused — not because the module has an opinion about gender, but because
    // the label the federation configured does not match the one it recorded.
    // The check says exactly what it compared, so MMAKF can see the mismatch.
    expect(r.eligible).toBe(false);
    expect(r.checks.find((c) => c.rule === 'gender')!.detail)
      .toBe('category is women; competitor is female');
  });

  it('ATTACK: refuses a category added by someone outside the event’s state', async () => {
    await expect(addCategory(db, { principal: stateKA }, {
      eventId: EV, code: 'INTRUDER', label: 'Intruder', discipline: 'kata',
    } as any)).rejects.toThrow(/Forbidden/);
  });
});

describe('entry — the eligibility engine, with its evidence', () => {
  it('stores the decision AND every check behind it', async () => {
    const { category } = await openEvent();
    const p = await makeAthlete('Eligible Competitor');

    const entry = await enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: p.id,
    }, NOW);

    expect(entry.status).toBe('confirmed');
    expect(entry.entryNo).toMatch(/^MMAKF-ENT-\d{4}-\d{6}$/);
    expect(entry.eligibility.eligible).toBe(true);
    expect(entry.eligibility.checkedAt).toBe(NOW.toISOString());
    // Six rules considered: person, membership, birth window, age, gender, grade.
    expect(entry.eligibility.checks.length).toBe(6);
    // The category as it stood is frozen with the decision.
    expect(entry.eligibilitySnapshot.category.code).toBe(category.code);
    expect(entry.eligibilitySnapshot.sanction.reference).toBe('MMAKF/SANC/2026/001');
  });

  it('a category with NO age bound accepts any age, and SAYS the rule was not set', async () => {
    const { category } = await openEvent();
    const infant = await makeAthlete('Very Young', { dob: '2022-05-01' });
    const veteran = await makeAthlete('Very Senior', { dob: '1948-05-01' });

    for (const p of [infant, veteran]) {
      const r = await checkEntryEligibility(db, national, p.id, category.id, NOW);
      expect(r.eligible).toBe(true);
      expect(r.checks.find((c) => c.rule === 'age_birth_window')!.detail)
        .toBe('no birth-date window set for this category');
      expect(r.checks.find((c) => c.rule === 'age_years')!.detail)
        .toBe('no age bound set for this category');
      expect(r.checks.find((c) => c.rule === 'min_grade')!.detail)
        .toBe('no minimum grade set for this category');
      // Unset is reported as unset — never as "passed the requirement".
      // Four of the six rules here are ones MMAKF has not configured.
      expect(r.checks.filter((c) => /^no .* set for this category$/.test(c.detail)).length).toBe(4);
    }
  });

  it('ATTACK: an athlete outside the birth window is refused, and told the numbers', async () => {
    // Cadet: born 2009-01-01 .. 2011-12-31, as the regulations for this event set it.
    const { category } = await openEvent({
      code: 'CAD-M-KUM', label: 'Cadet Male Kumite',
      bornOnOrAfter: '2009-01-01', bornOnOrBefore: '2011-12-31',
    } as any);
    const tooOld = await makeAthlete('Too Old For Cadet', { dob: '2008-12-31' });

    const entry = await enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: tooOld.id,
    }, NOW);

    expect(entry.status).toBe('ineligible');
    expect(entry.ineligibleReason).toMatch(/born 2009-01-01 to 2011-12-31.*born 2008-12-31/);
    const check = entry.eligibility.checks.find((c: any) => c.rule === 'age_birth_window')!;
    expect(check.passed).toBe(false);
    expect(check.detail).toBe('born 2008-12-31; window 2009-01-01 .. 2011-12-31');
  });

  it('accepts an athlete inside the birth window', async () => {
    const { category } = await openEvent({
      code: 'CAD-2', label: 'Cadet', bornOnOrAfter: '2009-01-01', bornOnOrBefore: '2011-12-31',
    } as any);
    const ok = await makeAthlete('Cadet', { dob: '2010-06-15' });
    const entry = await enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: ok.id,
    }, NOW);
    expect(entry.status).toBe('confirmed');
  });

  it('ATTACK: refuses a duplicate entry, and says so in words a club can read', async () => {
    const { category } = await openEvent();
    const p = await makeAthlete('Entered Twice');
    await enterEvent(db, { principal: national }, { categoryId: category.id, personId: p.id }, NOW);

    // The guard is the database's unique index, not this handler — the driver
    // error is translated rather than leaking as a 500.
    // The refusal names the entry that is in the way and the state it is in, so
    // the club can act on it rather than argue with it.
    await expect(enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: p.id,
    }, NOW)).rejects.toThrow(/already has entry MMAKF-ENT-\d{4}-\d{6} in this category \(confirmed\)/);

    const rows = await db.select().from(s.eventEntries).where(eq(s.eventEntries.categoryId, category.id));
    expect(rows.length).toBe(1);
  });

  it('explains the duplicate refusal when the earlier entry was WITHDRAWN', async () => {
    // The unique index is (category, person) and does not exclude withdrawn
    // entries, so a club that withdrew a competitor and tried to re-enter them
    // was told "already entered" — true of the database, and unrecognisable to
    // the only people who could act on it.
    const { category } = await openEvent();
    const p = await makeAthlete('Withdrew Then Returned');
    const first = await enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: p.id,
    }, NOW);
    await withdraw(db, { principal: national }, { entryId: first.id, reason: 'travel cancelled' }, NOW);

    const err = await enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: p.id,
    }, NOW).catch((e) => e);
    expect(err.code).toBe('already_entered');
    expect(err.message).toContain(first.entryNo);
    expect(err.message).toMatch(/\(withdrawn\)/);
  });

  it('ATTACK: refuses entry to a closed event', async () => {
    const { event, category } = await openEvent();
    await transitionEvent(db, { principal: national }, {
      eventId: event.id, to: 'registration_closed', reason: 'entries closed',
    }, NOW);
    const p = await makeAthlete('Late Entry');

    await expect(enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: p.id,
    }, NOW)).rejects.toThrow(/Entries are not open: this event is registration closed/i);
  });

  it('ATTACK: refuses entry to an unsanctioned event even when its status says open', async () => {
    const [raw] = await db.insert(s.competitionEvents).values({
      code: 'MMAKF-EVT-2026-900002', title: 'Looks Open', kind: 'open_national',
      status: 'registration_open', stateUnitId: JH,
    }).returning();
    const [cat] = await db.insert(s.eventCategories).values({
      eventId: raw.id, code: 'FAKE', label: 'Fake', discipline: 'kata',
    }).returning();
    const p = await makeAthlete('Hopeful');

    await expect(enterEvent(db, { principal: national }, {
      categoryId: cat.id, personId: p.id,
    }, NOW)).rejects.toThrow(/has not been sanctioned/i);
  });

  it('ATTACK: refuses entry by a principal with no competition authority', async () => {
    const { category } = await openEvent();
    const p = await makeAthlete('Self Entering');
    await expect(enterEvent(db, { principal: athlete }, {
      categoryId: category.id, personId: p.id,
    }, NOW)).rejects.toThrow(/Forbidden/);
  });

  it('ATTACK: a state administrator cannot enter another state’s athlete', async () => {
    const { category } = await openEvent();
    const karnataka = await makeAthlete('Karnataka Athlete', { stateUnitId: KA, dojoId: DOJO_KA });

    await expect(enterEvent(db, { principal: stateJH }, {
      categoryId: category.id, personId: karnataka.id,
    }, NOW)).rejects.toThrow(/Forbidden/);

    // …and their own is fine.
    const jharkhand = await makeAthlete('Jharkhand Athlete');
    const ok = await enterEvent(db, { principal: stateJH }, {
      categoryId: category.id, personId: jharkhand.id,
    }, NOW);
    expect(ok.status).toBe('confirmed');
  });

  it('records an ineligible entry rather than discarding it — a refusal is history', async () => {
    const { category } = await openEvent();
    const lapsed = await makeAthlete('Lapsed Member', {}, { validFrom: '2024-01-01', validTo: '2024-12-31' });

    const entry = await enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: lapsed.id,
    }, NOW);
    expect(entry.status).toBe('ineligible');
    // The date tested is the DAY OF COMPETITION (2026-09-01), not the day the
    // entry was keyed in (2026-08-12), and the record names which and why.
    expect(entry.ineligibleReason)
      .toMatch(/No active federation membership covering 2026-09-01 \(first day of competition\)/);
    expect(entry.eligibility.checks.find((c: any) => c.rule === 'membership_active')!.detail)
      .toMatch(/none covering 2026-09-01/);
  });

  it('ATTACK: a membership that lapses BETWEEN entry and competition does not get in', async () => {
    // Valid today, expired on the day of the championship. Testing "today"
    // admits this competitor to an event their cover does not reach — and
    // insurance and safeguarding hang off that cover.
    const { category } = await openEvent();      // starts 2026-09-01
    const lapsing = await makeAthlete('Cover Runs Out First', {}, {
      validFrom: '2026-01-01', validTo: '2026-08-31',
    });

    const r = await checkEntryEligibility(db, national, lapsing.id, category.id, NOW);
    expect(r.asOf).toBe('2026-09-01');
    expect(r.asOfBasis).toBe('competition_start');
    expect(r.eligible).toBe(false);
    expect(r.checks.find((c) => c.rule === 'membership_active')!.detail)
      .toMatch(/1 active membership\(s\) on record, none covering 2026-09-01/);
  });

  it('ATTACK: age is decided on the day of competition, not the day of entry', async () => {
    // Born 2008-08-20: seventeen on 2026-08-12 when the entry is made, EIGHTEEN
    // on 2026-09-01 when they would step on the mat. Checking the entry date
    // puts a legal adult in a cadet category and keeps them out of the senior
    // one — in the same afternoon, from the same date of birth.
    const cadet = await openEvent({ code: 'U18', label: 'Under 18', maxAgeYears: 17 } as any);
    const senior = await openEvent({ code: 'O18', label: 'Senior', minAgeYears: 18 } as any);
    const borderline = await makeAthlete('Eighteen On The Day', { dob: '2008-08-20' });

    const juniorCheck = await checkEntryEligibility(db, national, borderline.id, cadet.category.id, NOW);
    expect(juniorCheck.eligible).toBe(false);
    expect(juniorCheck.checks.find((c) => c.rule === 'age_years')!.detail)
      .toBe('age 18 on 2026-09-01 (first day of competition); bounds unset .. 17');
    expect(juniorCheck.reasons.join(' ')).toMatch(/is 18 on 2026-09-01/);

    const seniorCheck = await checkEntryEligibility(db, national, borderline.id, senior.category.id, NOW);
    expect(seniorCheck.eligible).toBe(true);
  });

  it('falls back to the entry date when the event states no start date, and SAYS it did', async () => {
    const { category } = await openEvent({}, { startsOn: null, endsOn: null } as any);
    const p = await makeAthlete('Undated Event');

    const entry = await enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: p.id,
    }, NOW);
    expect(entry.eligibility.asOf).toBe('2026-08-12');
    expect(entry.eligibility.asOfBasis).toBe('entry_date');
    // An assumption the federation can see is an assumption it can correct.
    expect(entry.eligibilitySnapshot.checks.find((c: any) => c.rule === 'membership_active').detail)
      .toMatch(/date of entry; this event states no start date/);
  });

  it('ATTACK: cannot probe another state’s competitor for their grade and standing', async () => {
    // The eligibility answer is a reading of one person's record — membership
    // standing, grade, gender, age band, whether they are suspended. Exported
    // ungated, it let anyone holding competition:read anywhere walk person ids
    // and collect all of it.
    const { category } = await openEvent();
    const karnataka = await makeAthlete('Not JH’s To Inspect', { stateUnitId: KA, dojoId: DOJO_KA });

    await expect(checkEntryEligibility(db, stateJH, karnataka.id, category.id, NOW))
      .rejects.toThrow(/Forbidden: competition:read/);
    await expect(checkEntryEligibility(db, member, karnataka.id, category.id, NOW))
      .rejects.toThrow(/Forbidden/);
    // Their own administrator may ask, even about a category in another state's
    // event — the question is about the competitor, not the championship.
    await expect(checkEntryEligibility(db, stateKA, karnataka.id, category.id, NOW))
      .resolves.toBeTruthy();
  });

  it('refuses a competitor whose own record is not active', async () => {
    const { category } = await openEvent();
    const suspended = await makeAthlete('Suspended');
    await db.update(s.persons).set({ status: 'suspended' }).where(eq(s.persons.id, suspended.id));

    const r = await checkEntryEligibility(db, national, suspended.id, category.id, NOW);
    expect(r.eligible).toBe(false);
    expect(r.checks.find((c) => c.rule === 'person_active')!.detail).toBe('person status suspended');
  });

  it('applies a gender restriction only where the category sets one', async () => {
    const female = await openEvent({ code: 'F-KATA', label: 'Female Kata', discipline: 'kata', gender: 'female' } as any);
    const mixed = await openEvent({ code: 'MIX-KATA', label: 'Mixed Kata', discipline: 'kata', gender: 'mixed' } as any);
    const man = await makeAthlete('Male Competitor', { gender: 'male' });

    const refused = await checkEntryEligibility(db, national, man.id, female.category.id, NOW);
    expect(refused.eligible).toBe(false);
    expect(refused.reasons.join(' ')).toMatch(/for female competitors/i);

    const accepted = await checkEntryEligibility(db, national, man.id, mixed.category.id, NOW);
    expect(accepted.eligible).toBe(true);
    expect(accepted.checks.find((c) => c.rule === 'gender')!.detail).toBe('category is mixed');
  });

  it('THE TRAP: kyu ordinals descend, so a beginner is refused and a dan holder is not', async () => {
    // "At least 3rd kyu" — a 9th kyu is a beginner and has a HIGHER ordinal.
    const { category } = await openEvent({
      code: 'ADV-KUM', label: 'Advanced Kumite', minGradeOrdinal: 3, minGradeKind: 'kyu',
    } as any);

    const beginner = await makeAthlete('Ninth Kyu');
    await db.insert(s.rankRecords).values({
      personId: beginner.id, kind: 'kyu', gradeLabel: '9th Kyu', gradeOrdinal: 9,
      awardedOn: '2026-01-01', status: 'active',
    });
    const advanced = await makeAthlete('Second Kyu');
    await db.insert(s.rankRecords).values({
      personId: advanced.id, kind: 'kyu', gradeLabel: '2nd Kyu', gradeOrdinal: 2,
      awardedOn: '2026-01-01', status: 'active',
    });
    const blackBelt = await makeAthlete('Shodan Holder');
    await db.insert(s.rankRecords).values({
      personId: blackBelt.id, kind: 'dan', gradeLabel: 'Shodan', gradeOrdinal: 1,
      awardedOn: '2020-01-01', status: 'active',
    });

    const a = await checkEntryEligibility(db, national, beginner.id, category.id, NOW);
    expect(a.eligible).toBe(false);
    expect(a.checks.find((c) => c.rule === 'min_grade')!.detail)
      .toBe('holds 9th Kyu (kyu 9), minimum kyu 3');

    const b = await checkEntryEligibility(db, national, advanced.id, category.id, NOW);
    expect(b.eligible).toBe(true);

    // A black belt is above every kyu grade, and must not be refused.
    const c = await checkEntryEligibility(db, national, blackBelt.id, category.id, NOW);
    expect(c.eligible).toBe(true);
    expect(c.checks.find((x) => x.rule === 'min_grade')!.detail).toMatch(/above every kyu grade/);
  });

  it('dan ordinals ascend, so a minimum dan grade compares the other way', async () => {
    const { category } = await openEvent({
      code: 'DAN-KUM', label: 'Dan Kumite', minGradeOrdinal: 2, minGradeKind: 'dan',
    } as any);
    const shodan = await makeAthlete('Shodan Only');
    await db.insert(s.rankRecords).values({
      personId: shodan.id, kind: 'dan', gradeLabel: 'Shodan', gradeOrdinal: 1,
      awardedOn: '2020-01-01', status: 'active',
    });
    const nidan = await makeAthlete('Nidan');
    await db.insert(s.rankRecords).values({
      personId: nidan.id, kind: 'dan', gradeLabel: 'Nidan', gradeOrdinal: 2,
      awardedOn: '2022-01-01', status: 'active',
    });

    expect((await checkEntryEligibility(db, national, shodan.id, category.id, NOW)).eligible).toBe(false);
    expect((await checkEntryEligibility(db, national, nidan.id, category.id, NOW)).eligible).toBe(true);

    // The refusal a club actually reads said "2 dan" via a suffix that produced
    // "3th kyu" elsewhere. A federation notice is quoted back at the federation.
    const refused = await checkEntryEligibility(db, national, shodan.id, category.id, NOW);
    expect(refused.reasons.join(' ')).toBe('This category requires at least 2nd dan.');
  });

  it('writes ordinals a federation can put in writing — 1st, 2nd, 3rd, not 3th', async () => {
    const grades: Array<[number, string]> = [[1, '1st kyu'], [2, '2nd kyu'], [3, '3rd kyu'], [4, '4th kyu']];
    for (const [ordinal, expected] of grades) {
      const { category } = await openEvent({
        code: `ORD-${ordinal}`, label: `Minimum ${ordinal} kyu`,
        minGradeOrdinal: ordinal, minGradeKind: 'kyu',
      } as any);
      const ungraded = await makeAthlete(`Ungraded ${ordinal}`);
      const r = await checkEntryEligibility(db, national, ungraded.id, category.id, NOW);
      expect(r.reasons.join(' ')).toBe(`This category requires at least ${expected}.`);
    }
  });

  it('FAILS CLOSED on a grade bound that a raw insert left unusable', async () => {
    const { event } = await openEvent();
    // addCategory refuses this pairing; only a direct insert can produce it.
    const [broken] = await db.insert(s.eventCategories).values({
      eventId: event.id, code: 'BROKEN-GRADE', label: 'Broken', discipline: 'kumite',
      minGradeOrdinal: 3, minGradeKind: null,
    }).returning();
    const p = await makeAthlete('Against A Broken Rule');

    const r = await checkEntryEligibility(db, national, p.id, broken.id, NOW);
    expect(r.eligible).toBe(false);
    expect(r.checks.find((c) => c.rule === 'min_grade')!.detail).toMatch(/cannot be applied/);
  });

  it('enforces a registration window only when one is set, and records which', async () => {
    const closed = await openEvent({}, {
      title: 'Window Closed',
      registrationOpensAt: new Date('2026-01-01T00:00:00Z'),
      registrationClosesAt: new Date('2026-06-30T23:59:59Z'),
    });
    const p = await makeAthlete('After The Window');
    await expect(enterEvent(db, { principal: national }, {
      categoryId: closed.category.id, personId: p.id,
    }, NOW)).rejects.toThrow(/Registration closed 2026-06-30/);

    const open = await openEvent();
    const q = await makeAthlete('No Window At All');
    const entry = await enterEvent(db, { principal: national }, {
      categoryId: open.category.id, personId: q.id,
    }, NOW);
    expect(entry.eligibilitySnapshot.registrationWindow.enforced).toBe(false);
  });

  it('honours an entry quota the federation set, and none it did not', async () => {
    const { category } = await openEvent({ code: 'CAPPED', label: 'Capped', maxEntries: 1 } as any);
    const first = await makeAthlete('First In');
    const second = await makeAthlete('Second In');

    await enterEvent(db, { principal: national }, { categoryId: category.id, personId: first.id }, NOW);
    await expect(enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: second.id,
    }, NOW)).rejects.toThrow(/limited to 1 entries and is full/i);
  });

  it('honours a per-dojo quota', async () => {
    const { category } = await openEvent({ code: 'DOJO-CAP', label: 'Dojo Cap', entriesPerDojo: 1 } as any);
    const a = await makeAthlete('Dojo One A', { dojoId: DOJO_JH });
    const b = await makeAthlete('Dojo One B', { dojoId: DOJO_JH });
    const c = await makeAthlete('Dojo Two A', { dojoId: DOJO_JH2 });

    await enterEvent(db, { principal: national }, { categoryId: category.id, personId: a.id }, NOW);
    await expect(enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: b.id,
    }, NOW)).rejects.toThrow(/entries per dojo/i);
    // A different dojo is unaffected.
    await expect(enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: c.id,
    }, NOW)).resolves.toBeTruthy();
  });

  it('makes an entry fee_pending when the category carries a fee code and no order', async () => {
    const { category } = await openEvent({ code: 'PAID', label: 'Paid Category', feeCode: 'ENTRY-STD' } as any);
    const p = await makeAthlete('Owes A Fee');
    const entry = await enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: p.id,
    }, NOW);
    // No fee amount is invented here — only the fact that one is configured and
    // unpaid, which is why the entry is not confirmed.
    expect(entry.status).toBe('fee_pending');
  });

  it('takes a team entry, checks every member, and blocks double entry', async () => {
    const { category } = await openEvent({
      code: 'TEAM-KATA', label: 'Team Kata', discipline: 'team_kata', teamSize: 3,
    } as any);
    const members = [
      await makeAthlete('Team A One'), await makeAthlete('Team A Two'), await makeAthlete('Team A Three'),
    ];

    await expect(enterEvent(db, { principal: national }, {
      categoryId: category.id, members: members.slice(0, 2).map((m) => ({ personId: m.id })),
    }, NOW)).rejects.toThrow(/teams of 3; 2 competitor\(s\)/);

    const entry = await enterEvent(db, { principal: national }, {
      categoryId: category.id, members: members.map((m) => ({ personId: m.id })),
    }, NOW);
    expect(entry.status).toBe('confirmed');
    expect(entry.personId).toBeNull();
    expect(entry.eligibility.members.length).toBe(3);

    const rows = await db.select().from(s.entryMembers).where(eq(s.entryMembers.entryId, entry.id));
    expect(rows.length).toBe(3);

    // A competitor already in one team cannot appear in another — the unique
    // index cannot see this, so the module checks it explicitly.
    const spare = await makeAthlete('Team B One');
    const spare2 = await makeAthlete('Team B Two');
    await expect(enterEvent(db, { principal: national }, {
      categoryId: category.id,
      members: [{ personId: members[0].id }, { personId: spare.id }, { personId: spare2.id }],
    }, NOW)).rejects.toThrow(/already entered in this category/i);
  });

  it('a team is only as eligible as its least eligible member', async () => {
    const { category } = await openEvent({
      code: 'TEAM-KUM', label: 'Team Kumite', discipline: 'team_kumite', teamSize: 2,
      bornOnOrAfter: '2009-01-01', bornOnOrBefore: '2011-12-31',
    } as any);
    const ok = await makeAthlete('Team C In Window', { dob: '2010-01-01' });
    const bad = await makeAthlete('Team C Out Of Window', { dob: '1999-01-01' });

    const entry = await enterEvent(db, { principal: national }, {
      categoryId: category.id, members: [{ personId: ok.id }, { personId: bad.id }],
    }, NOW);
    expect(entry.status).toBe('ineligible');
    expect(entry.eligibility.members.find((m: any) => m.personId === ok.id).eligible).toBe(true);
    expect(entry.eligibility.members.find((m: any) => m.personId === bad.id).eligible).toBe(false);
  });

  it('carries a typed, machine-readable code on every refusal', async () => {
    const { category } = await openEvent();
    const err = await enterEvent(db, { principal: national }, { categoryId: category.id }, NOW)
      .catch((e) => e);
    expect(err).toBeInstanceOf(CompetitionError);
    expect(err.code).toBe('no_competitor');
  });
});

describe('check-in, weigh-in and withdrawal', () => {
  /** An event standing at check-in with one confirmed entry. */
  async function atCheckIn(category: Record<string, unknown> = {}) {
    const { event, category: cat } = await openEvent(category as any);
    const p = await makeAthlete(`Competitor ${Math.random().toString(36).slice(2, 7)}`);
    const entry = await enterEvent(db, { principal: national }, {
      categoryId: cat.id, personId: p.id,
    }, NOW);
    await transitionEvent(db, { principal: national }, { eventId: event.id, to: 'registration_closed', reason: 'closed' }, NOW);
    await transitionEvent(db, { principal: national }, { eventId: event.id, to: 'check_in', reason: 'day one' }, NOW);
    return { event, category: cat, entry, person: p };
  }

  it('checks a confirmed competitor in and stamps the time', async () => {
    const { entry } = await atCheckIn();
    const row = await checkIn(db, { principal: national }, entry.id, NOW);
    expect(row.status).toBe('checked_in');
    expect(row.checkedInAt).toBeTruthy();
    await expect(checkIn(db, { principal: national }, entry.id, NOW)).rejects.toThrow(/already checked in/i);
  });

  it('ATTACK: refuses check-in before check-in has opened', async () => {
    const { category } = await openEvent();
    const p = await makeAthlete('Early Bird');
    const entry = await enterEvent(db, { principal: national }, { categoryId: category.id, personId: p.id }, NOW);
    await expect(checkIn(db, { principal: national }, entry.id, NOW))
      .rejects.toThrow(/Check-in is not open/i);
  });

  it('ATTACK: refuses check-in for an entry whose fee was never recorded', async () => {
    const { entry } = await atCheckIn({ code: 'PAY-FIRST', label: 'Pay First', feeCode: 'ENTRY-STD' });
    expect(entry.status).toBe('fee_pending');
    await expect(checkIn(db, { principal: national }, entry.id, NOW))
      .rejects.toThrow(/Only a confirmed entry can check in; this one is fee pending/i);
  });

  it('records a weigh-in in whole grams, with the official who took it', async () => {
    const { entry } = await atCheckIn({ code: 'W-61', label: 'Kumite -61kg', maxWeightGrams: 61_000 });
    await checkIn(db, { principal: national }, entry.id, NOW);

    const r = await recordWeighIn(db, { principal: national }, {
      entryId: entry.id, grams: 60_450, officialPersonId: OFFICIAL,
    }, NOW);

    expect(r.withinLimit).toBe(true);
    expect(r.entry.status).toBe('weighed_in');
    expect(r.entry.weighInGrams).toBe(60_450);
    expect(r.entry.weighInByPersonId).toBe(OFFICIAL);
  });

  it('ATTACK: refuses a weight that is not an integer number of grams', async () => {
    const { entry } = await atCheckIn();
    await checkIn(db, { principal: national }, entry.id, NOW);
    // 61.5 kg carelessly passed as kilograms, or a float that will not sum.
    await expect(recordWeighIn(db, { principal: national }, {
      entryId: entry.id, grams: 61.5, officialPersonId: OFFICIAL,
    }, NOW)).rejects.toThrow(/whole grams/i);
    await expect(recordWeighIn(db, { principal: national }, {
      entryId: entry.id, grams: 0, officialPersonId: OFFICIAL,
    }, NOW)).rejects.toThrow(/greater than zero/i);
  });

  it('records an over-limit weight but does not advance the entry, and never invents a disqualification', async () => {
    const { entry } = await atCheckIn({ code: 'W-60', label: 'Kumite -60kg', maxWeightGrams: 60_000 });
    await checkIn(db, { principal: national }, entry.id, NOW);

    const r = await recordWeighIn(db, { principal: national }, {
      entryId: entry.id, grams: 61_200, officialPersonId: OFFICIAL,
    }, NOW);

    expect(r.withinLimit).toBe(false);
    expect(r.detail).toBe('61200g against bounds unset .. 60000');
    expect(r.entry.weighInGrams).toBe(61_200);   // the measurement stands
    expect(r.entry.status).toBe('checked_in');   // …but nothing was decided for the officials
  });

  it('says the rule was not set when the category has no weight limit', async () => {
    const { entry } = await atCheckIn();
    await checkIn(db, { principal: national }, entry.id, NOW);
    const r = await recordWeighIn(db, { principal: national }, {
      entryId: entry.id, grams: 82_300, officialPersonId: OFFICIAL,
    }, NOW);
    expect(r.withinLimit).toBeNull();
    expect(r.detail).toMatch(/no weight limit set for this category/);
    expect(r.entry.status).toBe('weighed_in');
  });

  it('refuses a weigh-in for a competitor who never checked in, or by an unknown official', async () => {
    const { entry } = await atCheckIn();
    await expect(recordWeighIn(db, { principal: national }, {
      entryId: entry.id, grams: 70_000, officialPersonId: OFFICIAL,
    }, NOW)).rejects.toThrow(/Only a checked-in entry can be weighed/i);

    await checkIn(db, { principal: national }, entry.id, NOW);
    await expect(recordWeighIn(db, { principal: national }, {
      entryId: entry.id, grams: 70_000, officialPersonId: 999999,
    }, NOW)).rejects.toThrow(/not on the federation register/i);
  });

  it('requires a reason to withdraw, and keeps it on the record', async () => {
    const { category } = await openEvent();
    const p = await makeAthlete('Withdrawing');
    const entry = await enterEvent(db, { principal: national }, { categoryId: category.id, personId: p.id }, NOW);

    await expect(withdraw(db, { principal: national }, { entryId: entry.id, reason: ' ' }, NOW))
      .rejects.toThrow(/must record why/i);

    const row = await withdraw(db, { principal: national }, {
      entryId: entry.id, reason: 'Injured in training',
    }, NOW);
    expect(row.status).toBe('withdrawn');
    expect(row.withdrawnReason).toBe('Injured in training');

    const audit = await db.select().from(s.auditEvents).where(eq(s.auditEvents.entityType, 'event_entry'));
    expect(audit.some((a: any) => a.reason === 'Injured in training')).toBe(true);

    await expect(withdraw(db, { principal: national }, { entryId: entry.id, reason: 'again' }, NOW))
      .rejects.toThrow(/already withdrawn/i);
  });

  it('ATTACK: refuses to withdraw an entry once the results are final', async () => {
    const { event, category } = await openEvent();
    const p = await makeAthlete('Too Late To Withdraw');
    const entry = await enterEvent(db, { principal: national }, { categoryId: category.id, personId: p.id }, NOW);
    for (const to of ['registration_closed', 'check_in', 'live', 'results_pending', 'results_final'] as const) {
      await transitionEvent(db, { principal: national }, { eventId: event.id, to, reason: `to ${to}` }, NOW);
    }
    await expect(withdraw(db, { principal: national }, {
      entryId: entry.id, reason: 'changed our minds',
    }, NOW)).rejects.toThrow(/results are final/i);
  });

  it('ATTACK: cannot rewrite a weigh-in once the results are final', async () => {
    // The official record lock was enforced on withdrawal and nowhere else, so
    // the recorded weight of a competitor in a FINALISED championship could
    // still be overwritten — and the row would carry no sign it had ever said
    // anything else. A weight is the evidence behind a weight-class medal.
    const { event, entry } = await atCheckIn({ code: 'LOCK-W', label: 'Locked', maxWeightGrams: 70_000 });
    await checkIn(db, { principal: national }, entry.id, NOW);
    await recordWeighIn(db, { principal: national }, {
      entryId: entry.id, grams: 69_800, officialPersonId: OFFICIAL,
    }, NOW);
    for (const to of ['live', 'results_pending', 'results_final'] as const) {
      await transitionEvent(db, { principal: national }, { eventId: event.id, to, reason: `to ${to}` }, NOW);
    }

    const err = await recordWeighIn(db, { principal: national }, {
      entryId: entry.id, grams: 66_000, officialPersonId: OFFICIAL,
    }, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(CompetitionError);
    expect(err.code).toBe('results_final');

    const [fresh] = await db.select().from(s.eventEntries).where(eq(s.eventEntries.id, entry.id));
    expect(fresh.weighInGrams).toBe(69_800);      // the official measurement stands

    // …and the same lock covers check-in, whatever route the entry took there.
    await expect(checkIn(db, { principal: national }, entry.id, NOW))
      .rejects.toThrow(/results are final/i);
  });

  it('ATTACK: refuses withdrawal by an administrator from another state', async () => {
    const { category } = await openEvent();
    const p = await makeAthlete('Not Karnataka’s To Withdraw');
    const entry = await enterEvent(db, { principal: national }, { categoryId: category.id, personId: p.id }, NOW);
    await expect(withdraw(db, { principal: stateKA }, {
      entryId: entry.id, reason: 'meddling',
    }, NOW)).rejects.toThrow(/Forbidden/);
  });
});

describe('reads are scope-filtered in the query, never after it', () => {
  it('shows a state administrator their own state and not another’s', async () => {
    await createEvent(db, { principal: national }, {
      title: 'Jharkhand State Championship', kind: 'state_championship', stateUnitId: JH,
    } as any);
    await createEvent(db, { principal: national }, {
      title: 'Karnataka State Championship', kind: 'state_championship', stateUnitId: KA,
    } as any);

    const jh = await listEvents(db, stateJH, { limit: 500 });
    const titles = jh.map((e: any) => e.title);
    expect(titles).toContain('Jharkhand State Championship');
    expect(titles).not.toContain('Karnataka State Championship');
    expect(jh.every((e: any) => e.stateUnitId === JH || e.stateUnitId === null)).toBe(true);
  });

  it('shows a published national event to a scoped administrator, but not a national draft', async () => {
    const draft = await createEvent(db, { principal: national }, {
      title: 'Unannounced National Plan', kind: 'national_championship',
    } as any);
    const published = await createEvent(db, { principal: national }, {
      title: 'Announced National Championship', kind: 'national_championship',
    } as any);
    await transitionEvent(db, { principal: national }, { eventId: published.id, to: 'technical_review', reason: 'r' }, NOW);
    await transitionEvent(db, { principal: national }, { eventId: published.id, to: 'sanction_review', reason: 'r' }, NOW);
    await sanctionEvent(db, { principal: president }, {
      eventId: published.id, sanctionedByPersonId: PRESIDENT_P, sanctionReference: 'MMAKF/SANC/2026/NAT',
    }, NOW);
    await transitionEvent(db, { principal: national }, { eventId: published.id, to: 'published', reason: 'r' }, NOW);

    const seen = await listEvents(db, stateJH, { limit: 500 });
    const titles = seen.map((e: any) => e.title);
    expect(titles).toContain('Announced National Championship');
    expect(titles).not.toContain('Unannounced National Plan');

    await expect(eventWithCategories(db, stateJH, draft.id)).rejects.toThrow(/Forbidden/);
    await expect(eventWithCategories(db, stateJH, published.id)).resolves.toBeTruthy();
  });

  it('refuses a principal who holds no competition authority at all', async () => {
    await expect(listEvents(db, member)).rejects.toThrow(/Forbidden/);
  });

  it('returns an event with its categories in display order', async () => {
    const { event } = await openEvent();
    await addCategory(db, { principal: national }, {
      eventId: event.id, code: 'ZZZ', label: 'Last', discipline: 'kata', displayOrder: 1,
    } as any);
    await addCategory(db, { principal: national }, {
      eventId: event.id, code: 'AAA', label: 'First', discipline: 'kata', displayOrder: 0,
    } as any);

    const { categories } = await eventWithCategories(db, national, event.id);
    expect(categories.length).toBe(3);
    expect(categories[categories.length - 1].code).toBe('ZZZ');
  });

  it('lists a category’s entries WITHOUT dates of birth or contact details', async () => {
    const { category } = await openEvent();
    const p = await makeAthlete('Listed Competitor');
    await db.update(s.persons).set({ email: 'private@example.in', phone: '9999999999' })
      .where(eq(s.persons.id, p.id));
    await enterEvent(db, { principal: national }, { categoryId: category.id, personId: p.id }, NOW);

    const { entries } = await categoryEntries(db, national, category.id);
    expect(entries.length).toBe(1);
    expect(entries[0].fullName).toBe('Listed Competitor');

    const keys = Object.keys(entries[0]);
    expect(keys).not.toContain('dob');
    expect(keys).not.toContain('email');
    expect(keys).not.toContain('phone');
    const dumped = JSON.stringify(entries);
    expect(dumped).not.toContain('private@example.in');
    expect(dumped).not.toContain('9999999999');
    expect(dumped).not.toContain('2000-01-01');
  });

  it('withholds WHY a competitor was refused from readers who do not administer them', async () => {
    // `competition:read` is held by athletes, instructors, referees and every
    // rival dojo. An entry list may say a competitor is ineligible; the free
    // text behind it quotes a lapsed membership, an injury or a suspension.
    const { category } = await openEvent();
    const lapsed = await makeAthlete('Refused In Public', {}, { validFrom: '2024-01-01', validTo: '2024-12-31' });
    const e = await enterEvent(db, { principal: national }, {
      categoryId: category.id, personId: lapsed.id,
    }, NOW);
    expect(e.status).toBe('ineligible');

    const asAthlete = await categoryEntries(db, athlete, category.id);
    const seen = asAthlete.entries.find((r: any) => r.personId === lapsed.id)!;
    expect(seen.status).toBe('ineligible');          // the fact is on the list
    expect(seen.ineligibleReason).toBeNull();        // the reason is not
    // Withheld is said out loud, so nobody reads silence as "no reason given".
    expect(seen.reasonsWithheld).toBe(true);

    // The administrators who could have written it can still read it.
    for (const p of [national, stateJH]) {
      const rows = (await categoryEntries(db, p, category.id)).entries;
      const row = rows.find((r: any) => r.personId === lapsed.id)!;
      expect(row.ineligibleReason).toMatch(/No active federation membership/);
      expect(row.reasonsWithheld).toBe(false);
    }
  });

  it('refuses an entry list to an administrator outside the event’s scope', async () => {
    const { category } = await openEvent();
    await expect(categoryEntries(db, stateKA, category.id)).rejects.toThrow(/Forbidden/);
  });
});
