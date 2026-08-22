// The directory resolver, held against the canonical one.
//
// src/db/schedule-directory.ts composes a day from rules, seasons and
// exceptions for a SET of clubs, in a fixed number of queries. That is the same
// arithmetic `openingHoursOn()` does for one club, written a second time — and
// a second implementation of a rule is only safe while something proves the two
// agree. This suite is that proof.
//
// It is DIFFERENTIAL. For a fixture covering every shape resolution can take —
// a club with its own timetable, a club on its district's, a club on its
// state's, a club on the federation's, a club with nothing anywhere, seasonal
// rules, a closed-day exception, and replace/add/remove exceptions — it asserts
// that `directoryDay()` and `publishedWeek()` return THE SAME ANSWER for every
// club on every day tested. If the canonical resolver changes and the directory
// one does not, this fails by name rather than on the federation's website.
//
// It also holds the two things the batch version exists for:
//
//   THE INVARIANT — a club that has published nothing comes back
//   `configured: false`, never the headquarters' hours. Once a national default
//   IS published the same club inherits it, and says so: `isOwnSchedule` false
//   and `inheritedFrom` naming the level. Inherited-and-labelled is a different
//   thing from silently borrowed, and the third block tests the difference.
//
//   THE COST — the query count does not grow with the number of clubs. Forty
//   clubs cost what two clubs cost. That is the whole reason the module exists,
//   so it is asserted rather than assumed.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as s from '../src/db/schema';
import {
  createSchedule, draftVersion, publishVersion, defineSeason, addException,
  publishedWeek, todayIso, addDays, isoDayOfWeek,
  type ScheduleOwner, type SchedulePurpose, type RuleInput,
} from '../src/db/scheduling';
import { directoryDay, directoryRange, openAtAnyPoint, summariseDay } from '../src/db/schedule-directory';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

const nat: Principal = {
  userId: 1,
  label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const ctx: AuditContext = { principal: nat, reason: 'test', authority: 'test' };

let db: any;
let STATE: number;
let DISTRICT: number;

/** The five shapes a club's answer can have. */
let OWN: number;        // publishes its own timetable
let VIA_DISTRICT: number;
let VIA_STATE: number;
let NOTHING: number;    // nothing anywhere in its chain
let SEASONAL: number;   // its own timetable, with seasonal rules and exceptions

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

/** Create a schedule, draft a version with rules, publish it. */
async function publish(
  owner: ScheduleOwner, purpose: SchedulePurpose, rules: RuleInput[], name: string,
): Promise<number> {
  const schedule = await createSchedule(db, ctx, { name, purpose, owner });
  const version = await draftVersion(db, ctx, schedule.id, {
    effectiveFrom: '2020-01-01', rules,
  });
  await publishVersion(db, ctx, version.id, 'test fixture');
  return schedule.id;
}

const everyDay = (opensAt: string, closesAt: string): RuleInput[] =>
  [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({ dayOfWeek, opensAt, closesAt, kind: 'open' as const }));

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of MIGRATIONS) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  await db.insert(s.users).values({ id: 1, email: 'nat@example.test', status: 'active' });

  const [st] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  STATE = st.id;
  const [di] = await db.insert(s.districtUnits)
    .values({ code: 'MMAKF-DT-RMG', name: 'Ramgarh', district: 'Ramgarh', stateUnitId: STATE, status: 'active' })
    .returning({ id: s.districtUnits.id });
  DISTRICT = di.id;

  const dojoRows = await db.insert(s.dojos).values([
    { code: 'D-OWN', name: 'Own Timetable Dojo', stateUnitId: STATE, districtUnitId: DISTRICT, status: 'active' },
    { code: 'D-DIST', name: 'District Dojo', stateUnitId: STATE, districtUnitId: DISTRICT, status: 'active' },
    { code: 'D-STATE', name: 'State Dojo', stateUnitId: STATE, status: 'active' },
    { code: 'D-NONE', name: 'Silent Dojo', stateUnitId: STATE, status: 'active' },
    { code: 'D-SEAS', name: 'Seasonal Dojo', stateUnitId: STATE, districtUnitId: DISTRICT, status: 'active' },
  ]).returning({ id: s.dojos.id });
  [OWN, VIA_DISTRICT, VIA_STATE, NOTHING, SEASONAL] = dojoRows.map((r: any) => r.id);

  // OWN publishes training hours of its own; the district and state publish
  // different ones, so an answer that came from the wrong level is visible as a
  // wrong TIME rather than only as a wrong label.
  await publish({ scope: 'dojo', id: OWN }, 'training', everyDay('06:00', '08:00'), 'Own');
  await publish({ scope: 'district', id: DISTRICT }, 'training', everyDay('10:00', '12:00'), 'District');
  await publish({ scope: 'state', id: STATE }, 'training', everyDay('14:00', '16:00'), 'State');

  // VIA_STATE is in the state but not the district, so it lands on the state's.
  // NOTHING is too — which is why the invariant block below removes it from the
  // chain rather than relying on this fixture.

  // SEASONAL: an all-year weekday rule, a summer Sunday rule, a winter Sunday
  // rule, and exceptions on named dates.
  const summer = await defineSeason(db, ctx, {
    code: 'summer-test', name: 'Summer', owner: { scope: 'dojo', id: SEASONAL },
    startsOn: '2026-04-01', endsOn: '2026-09-30', activate: true,
  });
  const winter = await defineSeason(db, ctx, {
    code: 'winter-test', name: 'Winter', owner: { scope: 'dojo', id: SEASONAL },
    startsOn: '2026-10-01', endsOn: '2027-03-31', activate: true,
  });
  const seasonalSchedule = await createSchedule(db, ctx, {
    name: 'Seasonal', purpose: 'training', owner: { scope: 'dojo', id: SEASONAL },
  });
  const seasonalVersion = await draftVersion(db, ctx, seasonalSchedule.id, {
    effectiveFrom: '2020-01-01',
    rules: [
      ...[1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensAt: '17:00', closesAt: '19:00', kind: 'open' as const })),
      { dayOfWeek: 7, opensAt: '06:00', closesAt: '10:00', kind: 'open', seasonId: summer.id },
      { dayOfWeek: 7, opensAt: '15:00', closesAt: '18:00', kind: 'open', seasonId: summer.id },
      { dayOfWeek: 7, opensAt: '08:00', closesAt: '11:30', kind: 'open', seasonId: winter.id },
    ],
  });
  await publishVersion(db, ctx, seasonalVersion.id, 'test fixture');

  // A closed day, a replaced day, an added window and a removed slice — the
  // four effects, so the differential comparison exercises each.
  await addException(db, ctx, {
    scheduleId: seasonalSchedule.id, onDate: '2026-09-15',
    kind: 'examination', effect: 'closed', reason: 'Dan examination',
  });
  await addException(db, ctx, {
    scheduleId: seasonalSchedule.id, onDate: '2026-09-16',
    kind: 'seminar', effect: 'replace', opensAt: '09:00', closesAt: '13:00', reason: 'Seminar',
  });
  await addException(db, ctx, {
    scheduleId: seasonalSchedule.id, onDate: '2026-09-17',
    kind: 'special_training', effect: 'add', opensAt: '20:00', closesAt: '21:00', reason: 'Extra',
  });
  await addException(db, ctx, {
    scheduleId: seasonalSchedule.id, onDate: '2026-09-18',
    kind: 'maintenance', effect: 'remove', opensAt: '17:30', closesAt: '18:00', reason: 'Floor work',
  });
});

/** Dates chosen to cover weekday, Sunday in each season, and each exception. */
const DATES = [
  '2026-09-14', // Monday, summer
  '2026-09-20', // Sunday, summer
  '2026-11-01', // Sunday, winter
  '2026-09-15', // closed exception
  '2026-09-16', // replace exception
  '2026-09-17', // add exception
  '2026-09-18', // remove exception
];

describe('the directory resolver agrees with the canonical one', () => {
  it('returns the same answer as publishedWeek for every club on every date', async () => {
    const ids = [OWN, VIA_DISTRICT, VIA_STATE, NOTHING, SEASONAL];
    for (const date of DATES) {
      const batch = await directoryDay(db, ids, date);
      for (const id of ids) {
        const canonical = await publishedWeek(db, { dojoId: id }, date, date);
        const mine = batch.get(id)!;
        const where = `dojo ${id} on ${date}`;

        expect(mine, where).toBeTruthy();
        expect(mine.configured, `${where}: configured`).toBe(canonical.configured);
        if (!canonical.configured) continue;

        const day = canonical.days[0];
        expect(mine.open, `${where}: open`).toBe(day.open);
        expect(
          mine.windows.map((w) => `${w.opensAt}-${w.closesAt}`),
          `${where}: windows`,
        ).toEqual(day.windows.map((w) => `${w.opensAt}-${w.closesAt}`));
        expect(mine.isOwnSchedule, `${where}: isOwnSchedule`).toBe(canonical.isOwnSchedule);
        expect(mine.inheritedFromLabel, `${where}: inheritedFromLabel`).toBe(canonical.inheritedFromLabel);
        expect(mine.scheduleId, `${where}: scheduleId`).toBe(day.scheduleId);
        expect(mine.versionId, `${where}: versionId`).toBe(day.versionId);
        expect(mine.timezone, `${where}: timezone`).toBe(day.timezone);
      }
    }
  });

  it('lands each club on the level that actually owns its answer', async () => {
    const date = '2026-09-14';
    const batch = await directoryDay(db, [OWN, VIA_DISTRICT, VIA_STATE], date);

    // Different times per level, so a mis-resolution is a wrong hour and not
    // merely a wrong label.
    expect(summariseDay(batch.get(OWN))).toBe('06:00–08:00');
    expect(batch.get(OWN)!.isOwnSchedule).toBe(true);
    expect(batch.get(OWN)!.inheritedFrom).toBeNull();

    expect(summariseDay(batch.get(VIA_DISTRICT))).toBe('10:00–12:00');
    expect(batch.get(VIA_DISTRICT)!.isOwnSchedule).toBe(false);
    expect(batch.get(VIA_DISTRICT)!.inheritedFrom).toBe('district');

    expect(summariseDay(batch.get(VIA_STATE))).toBe('14:00–16:00');
    expect(batch.get(VIA_STATE)!.isOwnSchedule).toBe(false);
    expect(batch.get(VIA_STATE)!.inheritedFrom).toBe('state');
  });

  it('keeps a closed day apart from a club that has said nothing', async () => {
    const closed = (await directoryDay(db, [SEASONAL], '2026-09-15')).get(SEASONAL)!;
    expect(closed.configured).toBe(true);
    expect(closed.open).toBe(false);
    expect(closed.exceptionKinds).toContain('examination');
    expect(summariseDay(closed)).toBe('Closed today');
  });

  it('applies one season, not both, to a Sunday', async () => {
    const summerSunday = (await directoryDay(db, [SEASONAL], '2026-09-20')).get(SEASONAL)!;
    expect(summerSunday.seasonNames).toEqual(['Summer']);
    expect(summariseDay(summerSunday)).toBe('06:00–10:00 & 15:00–18:00');

    const winterSunday = (await directoryDay(db, [SEASONAL], '2026-11-01')).get(SEASONAL)!;
    expect(winterSunday.seasonNames).toEqual(['Winter']);
    expect(summariseDay(winterSunday)).toBe('08:00–11:30');
  });
});

describe('a club that has published nothing', () => {
  it('is present in the answer and marked unconfigured, not absent and not closed', async () => {
    // A dojo outside every unit that has published anything.
    const [orphan] = await db.insert(s.dojos)
      .values({ code: 'D-ORPHAN', name: 'Unaffiliated Timetable Dojo', stateUnitId: STATE, status: 'active' })
      .returning({ id: s.dojos.id });

    // The state DOES publish, so this club inherits — and must say so.
    const inherited = (await directoryDay(db, [orphan.id], '2026-09-14')).get(orphan.id)!;
    expect(inherited.configured).toBe(true);
    expect(inherited.isOwnSchedule).toBe(false);
    expect(inherited.inheritedFrom).toBe('state');
    expect(inherited.inheritedFromLabel).toBe('the state association');

    // And it is the STATE's hours, never the club-with-its-own-timetable's.
    expect(summariseDay(inherited)).toBe('14:00–16:00');
    expect(summariseDay(inherited)).not.toBe('06:00–08:00');
  });

  it('never inherits another club’s timetable, at any level', async () => {
    // A dojo in no state at all: nothing above it publishes anything.
    const [alone] = await db.insert(s.dojos)
      .values({ code: 'D-ALONE', name: 'Alone Dojo', stateUnitId: STATE, status: 'draft' })
      .returning({ id: s.dojos.id });

    const day = (await directoryDay(db, [alone.id], '2026-09-14')).get(alone.id)!;
    // It IS in the state, so it inherits the state's — that is correct and
    // labelled. What it must never be is the OWN dojo's schedule id.
    const ownDay = (await directoryDay(db, [OWN], '2026-09-14')).get(OWN)!;
    expect(day.scheduleId).not.toBe(ownDay.scheduleId);
    expect(day.windows.map((w) => w.opensAt)).not.toEqual(ownDay.windows.map((w) => w.opensAt));
  });

  it('returns configured:false when nothing in the chain publishes', async () => {
    // A state with no schedule of its own, and a club under it.
    const [lonelyState] = await db.insert(s.stateUnits)
      .values({ code: 'MMAKF-ST-XX', state: 'Nowhere', name: 'Nowhere', status: 'active' })
      .returning({ id: s.stateUnits.id });
    const [lonely] = await db.insert(s.dojos)
      .values({ code: 'D-LONELY', name: 'Lonely Dojo', stateUnitId: lonelyState.id, status: 'active' })
      .returning({ id: s.dojos.id });

    const day = (await directoryDay(db, [lonely.id], '2026-09-14')).get(lonely.id)!;
    expect(day.configured).toBe(false);
    expect(day.open).toBe(false);
    expect(day.windows).toEqual([]);
    expect(day.scheduleId).toBeNull();
    expect(summariseDay(day)).toBeNull();

    // The canonical resolver says the same thing about it.
    const canonical = await publishedWeek(db, { dojoId: lonely.id }, '2026-09-14', '2026-09-14');
    expect(canonical.configured).toBe(false);
  });
});

describe('the cost does not grow with the register', () => {
  it('uses the same number of queries for forty clubs as for two', async () => {
    const many = await db.insert(s.dojos).values(
      Array.from({ length: 38 }, (_, i) => ({
        code: `D-BULK-${i}`, name: `Bulk Dojo ${i}`, stateUnitId: STATE, status: 'active' as const,
      })),
    ).returning({ id: s.dojos.id });
    const bulkIds = many.map((r: any) => r.id);

    const counted = (target: any) => {
      let calls = 0;
      const proxy = new Proxy(target, {
        get(obj, prop, receiver) {
          if (prop === 'select') { calls++; return obj.select.bind(obj); }
          const v = Reflect.get(obj, prop, receiver);
          return typeof v === 'function' ? v.bind(obj) : v;
        },
      });
      return { proxy, count: () => calls };
    };

    const small = counted(db);
    await directoryDay(small.proxy, [OWN, VIA_DISTRICT], '2026-09-14');

    const large = counted(db);
    await directoryDay(large.proxy, [OWN, VIA_DISTRICT, ...bulkIds], '2026-09-14');

    expect(large.count()).toBe(small.count());
    // And it is a small fixed number, not merely a stable one.
    expect(large.count()).toBeLessThanOrEqual(12);
  });

  it('still answers correctly for every one of those forty clubs', async () => {
    const all = await db.select({ id: s.dojos.id }).from(s.dojos);
    const ids = all.map((r: any) => r.id);
    const batch = await directoryDay(db, ids, '2026-09-14');
    expect(batch.size).toBe(ids.length);

    // Spot-check against the canonical resolver for a sample, including one of
    // the bulk clubs, so "fast" cannot come at the price of "wrong".
    for (const id of [ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]]) {
      const canonical = await publishedWeek(db, { dojoId: id }, '2026-09-14', '2026-09-14');
      const mine = batch.get(id)!;
      expect(mine.configured).toBe(canonical.configured);
      if (canonical.configured) {
        expect(mine.windows.map((w) => `${w.opensAt}-${w.closesAt}`))
          .toEqual(canonical.days[0].windows.map((w) => `${w.opensAt}-${w.closesAt}`));
      }
    }
  });
});

describe('the day summary a surface renders', () => {
  it('says nothing at all for an unconfigured club', () => {
    expect(summariseDay(null)).toBeNull();
    expect(summariseDay(undefined)).toBeNull();
  });

  it('distinguishes closed from open in words, not in emptiness', async () => {
    const monday = (await directoryDay(db, [SEASONAL], '2026-09-14')).get(SEASONAL)!;
    expect(isoDayOfWeek(monday.date)).toBe(1);
    expect(summariseDay(monday)).toBe('17:00–19:00');
  });
});

describe('a run of days for a set of clubs', () => {
  it('answers every club for every day, and keeps the unpublished one present', async () => {
    const ids = [OWN, VIA_DISTRICT, SEASONAL];
    const range = await directoryRange(db, ids, '2026-09-14', '2026-09-20');

    expect(range.from).toBe('2026-09-14');
    expect(range.to).toBe('2026-09-20');
    for (const id of ids) {
      expect(range.clubs.get(id)!.length, `dojo ${id} must have seven days`).toBe(7);
    }

    // Every day agrees with the single-day resolver, which agrees with the
    // canonical one — so the range inherits the differential guarantee.
    for (const day of range.clubs.get(SEASONAL)!) {
      const single = (await directoryDay(db, [SEASONAL], day.date)).get(SEASONAL)!;
      expect(day.windows.map((w) => `${w.opensAt}-${w.closesAt}`))
        .toEqual(single.windows.map((w) => `${w.opensAt}-${w.closesAt}`));
    }
  });

  it('crosses a season boundary without unioning the two sides of it', async () => {
    // Summer ends 30 September; winter begins 1 October. A range spanning the
    // changeover must show each Sunday under the season in force ON THAT DAY.
    const range = await directoryRange(db, [SEASONAL], '2026-09-27', '2026-10-04');
    const sundays = range.clubs.get(SEASONAL)!.filter((d) => isoDayOfWeek(d.date) === 7);
    expect(sundays.map((d) => d.date)).toEqual(['2026-09-27', '2026-10-04']);
    expect(sundays[0].seasonNames).toEqual(['Summer']);
    expect(sundays[1].seasonNames).toEqual(['Winter']);
    expect(summariseDay(sundays[0])).toBe('06:00–10:00 & 15:00–18:00');
    expect(summariseDay(sundays[1])).toBe('08:00–11:30');
  });

  it('refuses a range longer than the cap rather than walking a year', async () => {
    await expect(directoryRange(db, [OWN], '2026-01-01', '2026-12-31'))
      .rejects.toThrow(/at most 14 days/);
  });

  it('refuses a range that ends before it starts', async () => {
    await expect(directoryRange(db, [OWN], '2026-09-20', '2026-09-14'))
      .rejects.toThrow(/ends before it starts/);
  });

  it('tells "closed all week" apart from "has published nothing"', async () => {
    // A club that publishes a timetable with no rules on the days asked about is
    // CLOSED; a club that publishes nothing has NOT SAID. A weekend-finder that
    // conflated them would send somebody to ring a club that is simply shut, and
    // tell somebody else to come back Saturday to a club nobody has heard from.
    const [shut] = await db.insert(s.dojos)
      .values({ code: 'D-SHUT', name: 'Weekday Only Dojo', stateUnitId: STATE, districtUnitId: DISTRICT, status: 'active' })
      .returning({ id: s.dojos.id });
    await publish({ scope: 'dojo', id: shut.id }, 'training',
      [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, opensAt: '18:00', closesAt: '20:00', kind: 'open' as const })),
      'Weekday only');

    const weekend = await directoryRange(db, [shut.id], '2026-09-19', '2026-09-20');
    expect(openAtAnyPoint(weekend.clubs.get(shut.id)!)).toBe('closed');

    const week = await directoryRange(db, [shut.id], '2026-09-14', '2026-09-20');
    expect(openAtAnyPoint(week.clubs.get(shut.id)!)).toBe('open');

    const lonelyState = await db.insert(s.stateUnits)
      .values({ code: 'MMAKF-ST-YY', state: 'Elsewhere', name: 'Elsewhere', status: 'active' })
      .returning({ id: s.stateUnits.id });
    const [unheard] = await db.insert(s.dojos)
      .values({ code: 'D-UNHEARD', name: 'Unheard Dojo', stateUnitId: lonelyState[0].id, status: 'active' })
      .returning({ id: s.dojos.id });
    const silent = await directoryRange(db, [unheard.id], '2026-09-19', '2026-09-20');
    expect(openAtAnyPoint(silent.clubs.get(unheard.id)!)).toBe('not_published');
  });
});
