// The attention engine, against real Postgres.
//
// THE CLAIMS THESE TESTS DEFEND
//
//  1. EVERY FIGURE IS A COUNT OF ROWS THAT EXIST. The fixture below is
//     hand-built and every expected number is worked out from it by hand, never
//     by re-running the module's own query. An assertion that says "whatever the
//     code returned" has stopped being evidence.
//
//  2. SCOPE IS ENFORCED IN THE QUERY. A count leaks as quietly as a row: if the
//     predicate were applied after the read, or not at all, the numbers here
//     would still look plausible. So the isolation is asserted in both
//     directions — the right figure for your own unit, and a REFUSAL rather
//     than the national figure where the table cannot be narrowed.
//
//  3. THE DICTIONARY DECIDES WHAT IS ACTIONABLE. The engine must not hold its
//     own opinion about which statuses are waiting on somebody, so the last
//     block asserts the derivation against src/lib/status.ts itself.
//
// The fixture invents no MMAKF data: the units are called "State A" and "State
// B" and exist for the duration of one in-memory database.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as s from '../src/db/schema';
import {
  attention, changedToday, upcomingCompetitions, actionableStatuses, NEVER_COUNTED,
} from '../src/lib/attention';
import { needsAction } from '../src/lib/status';
import type { Principal } from '../src/lib/rbac';
import type { ScopeRef } from '../src/db/analytics';

let db: any;
let A = 0, B = 0, DOJO = 0, P1 = 0, P2 = 0;

const superAdmin: Principal = {
  userId: 1, label: 'super-admin',
  bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
};
/** A coach manager holds no membership, finance or competition authority. */
const coachManager: Principal = {
  userId: 3, label: 'coach-manager',
  bindings: [{ role: 'COACH_MANAGER', scopeType: 'national', scopeId: null }],
};
let stateAdmin: Principal;

const inA = (): ScopeRef => ({
  kind: 'state', stateUnitId: A, districtUnitId: null, dojoId: null, label: 'State A',
});
const inB = (): ScopeRef => ({
  kind: 'state', stateUnitId: B, districtUnitId: null, dojoId: null, label: 'State B',
});

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  [{ id: A }] = await db.insert(s.stateUnits).values({
    code: 'T-ST-A', state: 'A', name: 'State A', status: 'active',
  }).returning({ id: s.stateUnits.id });
  [{ id: B }] = await db.insert(s.stateUnits).values({
    code: 'T-ST-B', state: 'B', name: 'State B', status: 'active',
  }).returning({ id: s.stateUnits.id });

  // Suspended, which the dictionary marks actionable for a unit.
  [{ id: DOJO }] = await db.insert(s.dojos).values({
    code: 'T-DOJO-1', name: 'Dojo One', stateUnitId: A, status: 'suspended',
  }).returning({ id: s.dojos.id });

  [{ id: P1 }] = await db.insert(s.persons).values({
    federationId: 'T-MEM-1', fullName: 'One', stateUnitId: A, dojoId: DOJO, status: 'active',
  }).returning({ id: s.persons.id });
  [{ id: P2 }] = await db.insert(s.persons).values({
    federationId: 'T-MEM-2', fullName: 'Two', stateUnitId: B, status: 'active',
  }).returning({ id: s.persons.id });

  // One actionable row per shape the engine has to handle: a table with its own
  // unit columns (leads, competition_events), a table reachable only through the
  // person (memberships, certificates, support_tickets), and the unit itself.
  await db.insert(s.memberships).values([
    { personId: P1, category: 'athlete', validFrom: '2026-01-01', status: 'pending' },
    { personId: P2, category: 'athlete', validFrom: '2026-01-01', status: 'pending' },
  ]);
  await db.insert(s.leads).values({
    ref: 'T-LEAD-1', audience: 'school', status: 'new', stateUnitId: A,
  });
  await db.insert(s.supportTickets).values({
    ticketNo: 'T-TKT-1', category: 'general', subject: 'x', body: 'y',
    raisedByPersonId: P1, status: 'open',
  });
  await db.insert(s.competitionEvents).values({
    code: 'T-EVT-1', title: 'Event', kind: 'other', status: 'sanction_review',
    startsOn: '2099-01-01', stateUnitId: A,
  });
  await db.insert(s.certificates).values({
    certificateNo: 'T-CERT-1', kind: 'kyu_grade', personId: P1, title: 'c',
    issuedOn: '2026-01-01', issuingAuthority: 'MMAKF', status: 'suspended',
    verifyToken: 'tok-1', snapshot: {},
  });
  // A draft application, to prove drafts are never counted as work.
  await db.insert(s.leads).values({
    ref: 'T-LEAD-2', audience: 'school', status: 'won', stateUnitId: A,
  });

  stateAdmin = {
    userId: 2, label: 'state-admin',
    bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: A }],
  };
});

const totals = (r: { registers: Array<{ key: string; total: number | null }> }) =>
  Object.fromEntries(r.registers.map((x) => [x.key, x.total]));

describe('national reach', () => {
  it('counts every register, and produces every one it offers', async () => {
    const r = await attention(db, superAdmin);
    // A register that failed to count is a defect, not a zero. Named in the
    // message so a broken query says WHICH query.
    expect(r.registers.filter((x) => x.unavailable).map((x) => `${x.key}: ${x.unavailable}`)).toEqual([]);

    const by = totals(r);
    expect(by.memberships).toBe(2);
    expect(by.leads).toBe(1);          // `won` is terminal and is not work
    expect(by.tickets).toBe(1);
    expect(by.events).toBe(1);
    expect(by.certificates).toBe(1);
    expect(by.dojos).toBe(1);
    expect(by.applications).toBe(0);
    expect(by.bookings).toBe(0);
    expect(by.tasks).toBe(0);
    expect(by.quotes).toBe(0);
    expect(by.payments).toBe(0);
  });

  it('gives every item a destination', async () => {
    const r = await attention(db, superAdmin);
    for (const reg of r.registers) {
      expect(reg.href, `${reg.key} has no destination`).toBeTruthy();
      for (const item of reg.items) {
        expect(item.href, `${reg.key}:${item.status} has no destination`).toBeTruthy();
        // A filterable destination must actually carry the status it claims to
        // filter by, or the reader arrives at an unfiltered list believing
        // otherwise.
        if (item.hrefFiltered) expect(item.href).toContain(`status=${item.status}`);
      }
    }
  });

  it('zero-fills every actionable status rather than dropping it', async () => {
    const r = await attention(db, superAdmin);
    const bookings = r.registers.find((x) => x.key === 'bookings')!;
    expect(bookings.items.length).toBeGreaterThan(0);
    for (const i of bookings.items) expect(i.count).toBe(0);
  });
});

describe('scope is enforced in the query', () => {
  it('narrows to the unit asked for', async () => {
    const by = totals(await attention(db, superAdmin, { scope: inA() }));
    expect(by.memberships).toBe(1);   // the other pending membership is in State B
    expect(by.tickets).toBe(1);
    expect(by.leads).toBe(1);
    expect(by.events).toBe(1);
    expect(by.dojos).toBe(1);
  });

  it('reports the other unit as empty rather than as the national figure', async () => {
    const by = totals(await attention(db, superAdmin, { scope: inB() }));
    expect(by.memberships).toBe(1);   // State B holds exactly one
    expect(by.tickets).toBe(0);
    expect(by.leads).toBe(0);
    expect(by.events).toBe(0);
    expect(by.dojos).toBe(0);
  });

  it('refuses a register that carries no unit column, and says why', async () => {
    const r = await attention(db, superAdmin, { scope: inA() });
    for (const key of ['tasks', 'quotes', 'payments']) {
      const reg = r.registers.find((x) => x.key === key)!;
      expect(reg.total, `${key} reported a figure it cannot narrow`).toBeNull();
      expect(reg.unavailable).toBeTruthy();
      for (const i of reg.items) expect(i.count).toBeNull();
    }
  });

  it('states the caveat when it had to narrow through the person', async () => {
    const r = await attention(db, superAdmin, { scope: inA() });
    // memberships records no unit of its own, so the figure is a floor.
    expect(r.registers.find((x) => x.key === 'memberships')!.scopeCaveat).toMatch(/floor, not a total/);
    // leads carries its own state column, so no caveat is claimed.
    expect(r.registers.find((x) => x.key === 'leads')!.scopeCaveat).toBeNull();
  });

  it('applies a scoped credential’s own reach without being asked for a scope', async () => {
    const by = totals(await attention(db, stateAdmin));
    expect(by.memberships).toBe(1);   // only the person filed to State A
    expect(by.leads).toBe(1);
    expect(by.dojos).toBe(1);
  });

  it('never widens a scoped credential to another unit', async () => {
    // A state administrator asking for the other state: the reach predicate and
    // the unit predicate are both applied, and they cannot both hold.
    const by = totals(await attention(db, stateAdmin, { scope: inB() }));
    expect(by.memberships).toBe(0);
    expect(by.leads).toBe(0);
    expect(by.dojos).toBe(0);
  });
});

describe('registers out of reach', () => {
  it('omits them and names them once, rather than refusing eleven times', async () => {
    const r = await attention(db, coachManager);
    const keys = r.registers.map((x) => x.key);
    expect(keys).toContain('coaches');
    expect(keys).not.toContain('payments');
    expect(keys).not.toContain('memberships');
    expect(r.outOfReach.map((x) => x.action)).toContain('finance:read');
    expect(r.outOfReach.map((x) => x.action)).toContain('membership:read');
  });
});

describe('the dated figures', () => {
  it('counts competitions from today forward, narrowed', async () => {
    expect((await upcomingCompetitions(db, superAdmin)).count).toBe(1);
    expect((await upcomingCompetitions(db, superAdmin, { scope: inA() })).count).toBe(1);
    expect((await upcomingCompetitions(db, superAdmin, { scope: inB() })).count).toBe(0);
  });

  it('excludes a cancelled event, because a cancelled event is not upcoming', async () => {
    await db.insert(s.competitionEvents).values({
      code: 'T-EVT-2', title: 'Called off', kind: 'other', status: 'cancelled',
      startsOn: '2099-02-01', stateUnitId: A,
    });
    expect((await upcomingCompetitions(db, superAdmin)).count).toBe(1);
  });

  it('withholds the audit figure from a credential without audit:read', async () => {
    const mine = await changedToday(db, superAdmin);
    expect(typeof mine.count).toBe('number');

    const theirs = await changedToday(db, coachManager);
    expect(theirs.count).toBeNull();
    expect(theirs.unavailable).toMatch(/audit:read/);
    // No destination either: a link to a page that will refuse is not a link.
    expect(theirs.href).toBeNull();
  });
});

describe('the dictionary decides what is actionable', () => {
  it('derives the set from status.ts rather than holding its own list', () => {
    // REWRITTEN. This re-implemented actionableStatuses() line for line and then
    // asserted the two agreed — f(x) === f(x), which passes whatever either one
    // does. It also compared ticket statuses against 'draft', which no ticket
    // can hold, so TypeScript correctly refused a comparison with no overlap.
    //
    // What is worth asserting is the CONTRACT: every value returned is one the
    // dictionary calls actionable, and nothing else in the enum is.
    const values = s.ticketStatus.enumValues;
    const actionable = actionableStatuses(values, 'ticket');

    expect(actionable.length, 'no ticket status is actionable, which cannot be right').toBeGreaterThan(0);
    for (const v of actionable) {
      expect(needsAction(v, 'ticket'), `${v} is counted and the dictionary does not call it actionable`).toBe(true);
    }
    for (const v of values.filter((x) => !actionable.includes(x))) {
      expect(needsAction(v, 'ticket'), `${v} is actionable and is not being counted`).toBe(false);
    }
  });

  it('never counts a draft, on an enum that actually has one', () => {
    // The real behaviour of NEVER_COUNTED, tested where it can bite. A draft is
    // somebody's unfinished work, not the federation's outstanding work, and
    // counting it would put a number on a dashboard that nobody can act on.
    // quoteStatus, because it genuinely carries a draft. src/db/schema.ts
    // re-exports engagement.schema but not operations.schema, so
    // applicationStatus is not reachable through `s` — using it here failed at
    // runtime while typechecking clean, which is the whole reason this assertion
    // names the enum it is testing rather than trusting one to be there.
    const values = s.quoteStatus.enumValues;
    expect(values, 'this enum no longer has a draft, so the guard tests nothing')
      .toContain(NEVER_COUNTED);
    expect(actionableStatuses(values, 'quote')).not.toContain(NEVER_COUNTED);
  });

  it('never counts a draft as work', async () => {
    const r = await attention(db, superAdmin);
    for (const reg of r.registers) {
      expect(reg.items.map((i) => i.status)).not.toContain('draft');
    }
  });

  it('counts a terminal status nowhere', async () => {
    const r = await attention(db, superAdmin);
    const lead = r.registers.find((x) => x.key === 'leads')!;
    expect(lead.items.map((i) => i.status)).not.toContain('won');
    expect(lead.items.map((i) => i.status)).not.toContain('lost');
  });
});
