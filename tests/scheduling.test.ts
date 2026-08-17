// The federation scheduling engine.
//
// THE DEFECT THIS SUITE EXISTS TO STOP COMING BACK: the site published ONE
// timetable — the hombu dojo's — as "the MMAKF schedule", with the seasonal
// Sunday timings written into a string in a seed file. Every affiliated club in
// the country was represented as training at six in the morning because Patratu
// does, and no administrator could change any of it without a developer.
//
// So the spine of this file is the SEPARATION: HQ, Club A and Club B are set up
// with three genuinely different weeks, and every assertion after that is
// either "the club's answer is the club's" or "the federation's row did not
// move". The rest is the arithmetic where the quiet bugs live — an off-by-one
// in the day-of-week conversion silently moves Sunday's timings onto Saturday,
// and the only symptom is a family arriving to a locked dojo.
//
// The last test in the file greps the source. It is not a style check: a single
// hard-coded '06:00' in the engine would make everything above it a
// coincidence.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import * as ops from '../src/db/operations.schema';
import * as sch from '../src/db/scheduling.schema';
import { createPerson } from '../src/db/federation';
import {
  // time
  zonedInstant, zonedDay, zonedTime, isoDayOfWeek, addDays, daysBetween,
  mergedMinutes, windowContains,
  // seasons
  defineSeason, activateSeason, moveSeason, listSeasons, seasonsOn,
  // schedules
  createSchedule, draftVersion, setRules, publishVersion, withdrawVersion,
  resolveSchedule, versionInForce,
  // days
  openingHoursOn, timetable, publicTimetable,
  // classes
  createClass, generateSessions, detectConflicts,
  bookableSessions, bookClassSession, cancelSessionBooking, cancelSession,
  isSchedulingError,
} from '../src/db/scheduling';
import { notifyForEvent } from '../src/lib/notifications';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

const TZ = 'Asia/Kolkata';

const nat: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
let clubAdminA: Principal;
let clubAdminB: Principal;
let stateAdmin: Principal;
let member: Principal;

const ctx = (p: Principal = nat): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

let db: any;
let JH: number, RMG: number;
let HQ_DOJO: number, CLUB_A: number, CLUB_B: number;
let HQ_VENUE: number, A_VENUE: number, B_VENUE: number;
let coach1: number, coach2: number, student: number;

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of MIGRATIONS) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand Association', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
  const [rmg] = await db.insert(s.districtUnits)
    .values({ code: 'MMAKF-DIST-JH-RMG', stateUnitId: JH, district: 'Ramgarh', name: 'Ramgarh District', status: 'active' })
    .returning({ id: s.districtUnits.id });
  RMG = rmg.id;

  const dojos = await db.insert(s.dojos).values([
    { code: 'MMAKF-DOJO-HQ', name: 'MMAKF Hombu Dojo', stateUnitId: JH, districtUnitId: RMG, city: 'Patratu', status: 'active', slug: 'mmakf-hombu-dojo' },
    { code: 'MMAKF-DOJO-A', name: 'MMAKF Ramgarh Centre', stateUnitId: JH, districtUnitId: RMG, city: 'Ramgarh', status: 'active', slug: 'mmakf-ramgarh-centre' },
    { code: 'MMAKF-DOJO-B', name: 'MMAKF Bokaro Dojo', stateUnitId: JH, city: 'Bokaro', status: 'active', slug: 'mmakf-bokaro-dojo' },
  ]).returning({ id: s.dojos.id });
  [HQ_DOJO, CLUB_A, CLUB_B] = dojos.map((d: any) => d.id);

  const venues = await db.insert(ops.venues).values([
    { code: 'V-HQ', name: 'Hombu training hall', kind: 'dojo', dojoId: HQ_DOJO, stateUnitId: JH, districtUnitId: RMG, timezone: TZ, slug: 'hombu-hall' },
    { code: 'V-A', name: 'Ramgarh hall', kind: 'dojo', dojoId: CLUB_A, stateUnitId: JH, districtUnitId: RMG, timezone: TZ, slug: 'ramgarh-hall' },
    { code: 'V-B', name: 'Bokaro hall', kind: 'dojo', dojoId: CLUB_B, stateUnitId: JH, timezone: TZ, slug: 'bokaro-hall' },
  ]).returning({ id: ops.venues.id });
  [HQ_VENUE, A_VENUE, B_VENUE] = venues.map((v: any) => v.id);

  const c1 = await createPerson(db, ctx(), { fullName: 'Sensei Vikas Pathak', stateUnitId: JH });
  const c2 = await createPerson(db, ctx(), { fullName: 'Sensei Sumitra Devi', stateUnitId: JH });
  const st = await createPerson(db, ctx(), { fullName: 'A Student', stateUnitId: JH });
  coach1 = c1.id; coach2 = c2.id; student = st.id;

  await db.insert(s.users).values([
    { id: 1, email: 'nat@example.test', status: 'active' },
    { id: 2, email: 'a@example.test', status: 'active' },
    { id: 3, email: 'b@example.test', status: 'active' },
    { id: 4, email: 'state@example.test', status: 'active' },
    { id: 5, email: 'member@example.test', status: 'active', personId: student },
  ]);

  clubAdminA = { userId: 2, label: 'club A admin', bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: CLUB_A }] };
  clubAdminB = { userId: 3, label: 'club B admin', bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: CLUB_B }] };
  stateAdmin = { userId: 4, label: 'state admin', bindings: [{ role: 'STATE_ADMIN', scopeType: 'state', scopeId: JH }] };
  member = { userId: 5, label: 'member', bindings: [{ role: 'MEMBER', scopeType: 'dojo', scopeId: CLUB_A }] };
});

beforeEach(async () => {
  // Order matters: every referent before what it points at.
  await db.execute?.('DELETE FROM notifications');
  await db.execute?.('DELETE FROM domain_events');
  await db.execute?.('DELETE FROM bookings');
  await db.execute?.('DELETE FROM class_sessions');
  await db.execute?.('DELETE FROM schedule_rules');
  await db.execute?.('DELETE FROM schedule_exceptions');
  await db.execute?.('DELETE FROM schedule_versions');
  await db.execute?.('DELETE FROM schedules');
  await db.execute?.('DELETE FROM dojo_classes');
  await db.execute?.('DELETE FROM seasons');
  await db.execute?.('DELETE FROM venue_blackouts');
  await db.execute?.('DELETE FROM coach_availability');
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Create a schedule, draft one version with rules, publish it. One call. */
async function publishSchedule(
  principal: Principal,
  input: {
    name: string;
    purpose?: 'operating' | 'training' | 'office' | 'administrative' | 'class';
    owner: { scope: any; id?: number | null };
    venueId?: number | null;
    classId?: number | null;
    effectiveFrom: string;
    rules: any[];
  }
) {
  const schedule = await createSchedule(db, ctx(principal), {
    name: input.name,
    purpose: input.purpose ?? 'training',
    owner: input.owner,
    venueId: input.venueId ?? null,
    classId: input.classId ?? null,
  });
  const version = await draftVersion(db, ctx(principal), schedule.id, {
    effectiveFrom: input.effectiveFrom,
    rules: input.rules,
  });
  await publishVersion(db, ctx(principal), version.id, 'test fixture');
  return { schedule, version };
}

const open = (dayOfWeek: number, opensAt: string, closesAt: string, extra: any = {}) =>
  ({ dayOfWeek, opensAt, closesAt, ...extra });

const windowsOf = (day: any) => day.windows.map((w: any) => `${w.opensAt}-${w.closesAt}`);

// ═══════════════════════════════════════════════════════════════════════════
// TIME
// ═══════════════════════════════════════════════════════════════════════════

describe('wall clock and calendar', () => {
  it('places a local time at the right instant, in the venue timezone', () => {
    // 06:00 in Patratu is 00:30 UTC. A naive `new Date('2026-09-15T06:00')` on a
    // UTC server is 06:00 UTC — five and a half hours late, and the member is
    // told to arrive after the class has ended.
    expect(zonedInstant('2026-09-15', '06:00', TZ).toISOString()).toBe('2026-09-15T00:30:00.000Z');
    expect(zonedDay(zonedInstant('2026-09-15', '06:00', TZ), TZ)).toBe('2026-09-15');
    expect(zonedTime(zonedInstant('2026-09-15', '06:00', TZ), TZ)).toBe('06:00');
  });

  it('handles a zone that observes daylight saving, which India does not', () => {
    // Not because MMAKF needs it today, but because the directive forbids the
    // data model assuming IST forever, and a one-pass offset lookup is wrong
    // for the hour either side of a transition.
    const summer = zonedInstant('2026-07-01', '09:00', 'Europe/London');
    const winter = zonedInstant('2026-12-01', '09:00', 'Europe/London');
    expect(summer.toISOString()).toBe('2026-07-01T08:00:00.000Z');   // BST, UTC+1
    expect(winter.toISOString()).toBe('2026-12-01T09:00:00.000Z');   // GMT, UTC+0
  });

  it('refuses a timezone the platform does not know, rather than guessing', () => {
    expect(() => zonedInstant('2026-09-15', '06:00', 'Asia/Patratu')).toThrow(/not a timezone/i);
  });

  it('numbers days ISO — 1 is Monday and 7 is Sunday', () => {
    // JavaScript's getDay() is 0-is-Sunday. Mixing the two conventions moves
    // Sunday's timetable onto Saturday, which is why the conversion lives in
    // exactly one function.
    expect(isoDayOfWeek('2026-09-14')).toBe(1);   // a Monday
    expect(isoDayOfWeek('2026-09-20')).toBe(7);   // a Sunday
  });

  it('walks a date range inclusively at both ends', () => {
    expect(daysBetween('2026-09-14', '2026-09-16')).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('merges and tests windows without inventing time', () => {
    const w = (a: string, b: string) => ({ opensAt: a, closesAt: b, source: 'rule' as const });
    expect(mergedMinutes([w('06:00', '09:00'), w('08:00', '10:00')])).toEqual([{ opensAt: '06:00', closesAt: '10:00' }]);
    expect(windowContains([w('06:00', '09:00')], '06:30', '07:30')).toBe(true);
    // Two adjoining windows do NOT contain a session that spans the seam unless
    // they merge — and they do merge, because 09:00-09:00 is not a gap.
    expect(windowContains([w('06:00', '09:00'), w('17:00', '20:00')], '08:00', '18:00')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE CORE RULE: HQ IS NOT EVERYBODY
// ═══════════════════════════════════════════════════════════════════════════

describe('HQ, Club A and Club B are three different weeks', () => {
  beforeEach(async () => {
    // HQ: Mon–Sat morning and evening. Sunday handled by the seasonal test.
    await publishSchedule(nat, {
      name: 'MMAKF Hombu Dojo — training hours',
      owner: { scope: 'dojo', id: HQ_DOJO },
      effectiveFrom: '2026-01-01',
      rules: [
        ...[1, 2, 3, 4, 5, 6].flatMap((d) => [
          open(d, '06:00', '09:00', { label: 'Morning' }),
          open(d, '17:00', '20:00', { label: 'Evening' }),
        ]),
      ],
    });

    // Club A: the directive's example. Different every weekday, Sunday closed.
    await publishSchedule(clubAdminA, {
      name: 'Ramgarh Centre — training hours',
      owner: { scope: 'dojo', id: CLUB_A },
      effectiveFrom: '2026-01-01',
      rules: [
        open(1, '06:00', '07:30'), open(1, '17:00', '19:00'),
        open(2, '17:00', '20:00'),
        open(3, '06:00', '08:00'),
        open(4, '17:00', '20:00'),
        open(5, '17:00', '19:00'),
        open(6, '07:00', '10:00'),
        { dayOfWeek: 7, kind: 'closed' },
      ],
    });

    // Club B: weekday evenings only, and it trains on Sunday.
    await publishSchedule(clubAdminB, {
      name: 'Bokaro Dojo — training hours',
      owner: { scope: 'dojo', id: CLUB_B },
      effectiveFrom: '2026-01-01',
      rules: [
        ...[1, 2, 3, 4, 5].map((d) => open(d, '18:00', '21:00')),
        open(6, '07:00', '11:00'),
        open(7, '08:00', '12:00'),
      ],
    });
  });

  it('gives each club its own Monday', async () => {
    const monday = '2026-09-14';
    const hq = await openingHoursOn(db, { purpose: 'training', dojoId: HQ_DOJO }, monday);
    const a = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_A }, monday);
    const b = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_B }, monday);

    expect(windowsOf(hq)).toEqual(['06:00-09:00', '17:00-20:00']);
    expect(windowsOf(a)).toEqual(['06:00-07:30', '17:00-19:00']);
    expect(windowsOf(b)).toEqual(['18:00-21:00']);
  });

  it('closes Club A on Sunday while Club B trains — no global assumption', async () => {
    const sunday = '2026-09-20';
    const a = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_A }, sunday);
    const b = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_B }, sunday);

    expect(a.open).toBe(false);
    expect(a.unconfigured).toBe(false);      // CLOSED is a statement; unconfigured is not
    expect(b.open).toBe(true);
    expect(windowsOf(b)).toEqual(['08:00-12:00']);
  });

  it('tells "closed" apart from "nobody has said" — the distinction a member acts on', async () => {
    // A club with no schedule at all and no ancestor with one.
    const orphan = await openingHoursOn(db, { purpose: 'office', dojoId: CLUB_A }, '2026-09-14');
    expect(orphan.unconfigured).toBe(true);
    expect(orphan.open).toBe(false);
    expect(orphan.scheduleId).toBeNull();

    const closedSunday = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_A }, '2026-09-20');
    expect(closedSunday.unconfigured).toBe(false);
    expect(closedSunday.scheduleId).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INHERITANCE
// ═══════════════════════════════════════════════════════════════════════════

describe('inheritance is resolved, never copied', () => {
  it('lets an unconfigured club inherit the federation, and says which level it came from', async () => {
    await publishSchedule(nat, {
      name: 'MMAKF national default office hours',
      purpose: 'office',
      owner: { scope: 'national', id: null },
      effectiveFrom: '2026-01-01',
      rules: [...[1, 2, 3, 4, 5].map((d) => open(d, '10:00', '17:00'))],
    });

    const day = await openingHoursOn(db, { purpose: 'office', dojoId: CLUB_A }, '2026-09-14');
    expect(day.open).toBe(true);
    expect(windowsOf(day)).toEqual(['10:00-17:00']);
    expect(day.isOwnSchedule).toBe(false);
    expect(day.inheritedFromLabel).toBe('the national federation');
  });

  it('lets the club override, and does NOT mutate the federation default', async () => {
    const fed = await publishSchedule(nat, {
      name: 'MMAKF national default Sunday',
      owner: { scope: 'national', id: null },
      effectiveFrom: '2026-01-01',
      rules: [open(7, '06:00', '10:00')],
    });
    await publishSchedule(clubAdminA, {
      name: 'Ramgarh Sunday',
      owner: { scope: 'dojo', id: CLUB_A },
      effectiveFrom: '2026-01-01',
      rules: [open(7, '08:00', '12:00')],
    });

    const club = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_A }, '2026-09-20');
    expect(windowsOf(club)).toEqual(['08:00-12:00']);
    expect(club.isOwnSchedule).toBe(true);

    // The federation's own answer is untouched — this is the assertion that
    // "the club override wins; do NOT mutate the federation default" is true.
    const federation = await openingHoursOn(db, { purpose: 'training', scopeIdIgnored: true } as any, '2026-09-20');
    expect(windowsOf(federation)).toEqual(['06:00-10:00']);
    const stillThere = await db.select().from(sch.scheduleRules)
      .where(eq(sch.scheduleRules.versionId, fed.version.id));
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0].opensAt).toBe('06:00');
  });

  it('prefers the state over the federation, and the district over the state', async () => {
    await publishSchedule(nat, {
      name: 'national', owner: { scope: 'national', id: null },
      effectiveFrom: '2026-01-01', rules: [open(1, '06:00', '07:00')],
    });
    await publishSchedule(nat, {
      name: 'state', owner: { scope: 'state', id: JH },
      effectiveFrom: '2026-01-01', rules: [open(1, '08:00', '09:00')],
    });
    let day = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_A }, '2026-09-14');
    expect(windowsOf(day)).toEqual(['08:00-09:00']);

    await publishSchedule(nat, {
      name: 'district', owner: { scope: 'district', id: RMG },
      effectiveFrom: '2026-01-01', rules: [open(1, '10:00', '11:00')],
    });
    day = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_A }, '2026-09-14');
    expect(windowsOf(day)).toEqual(['10:00-11:00']);
    expect(day.inheritedFromLabel).toBe('the district association');
  });

  it('prefers a ROOM-specific schedule over its own club', async () => {
    await publishSchedule(clubAdminA, {
      name: 'club-wide', owner: { scope: 'dojo', id: CLUB_A },
      effectiveFrom: '2026-01-01', rules: [open(1, '06:00', '09:00')],
    });
    await publishSchedule(clubAdminA, {
      name: 'second hall', owner: { scope: 'dojo', id: CLUB_A }, venueId: A_VENUE,
      effectiveFrom: '2026-01-01', rules: [open(1, '19:00', '21:00')],
    });
    const day = await openingHoursOn(db, { purpose: 'training', venueId: A_VENUE }, '2026-09-14');
    expect(windowsOf(day)).toEqual(['19:00-21:00']);
  });

  it('does not stop the walk at a schedule that has published nothing yet', async () => {
    await publishSchedule(nat, {
      name: 'national', owner: { scope: 'national', id: null },
      effectiveFrom: '2026-01-01', rules: [open(1, '06:00', '07:00')],
    });
    // The club exists in the register and somebody made a schedule object for
    // it, but nothing is in force. That must inherit, not render blank.
    await createSchedule(db, ctx(clubAdminA), {
      name: 'Ramgarh (not yet configured)', purpose: 'training', owner: { scope: 'dojo', id: CLUB_A },
    });
    const day = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_A }, '2026-09-14');
    expect(day.unconfigured).toBe(false);
    expect(windowsOf(day)).toEqual(['06:00-07:00']);
    expect(day.inheritedFromLabel).toBe('the national federation');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SEASONS
// ═══════════════════════════════════════════════════════════════════════════

describe('seasons are rows with dates, not words in a string', () => {
  let summer: number, winter: number;

  beforeEach(async () => {
    const su = await defineSeason(db, ctx(), {
      code: 'summer-2026', name: 'Summer 2026', owner: { scope: 'national', id: null },
      startsOn: '2026-04-01', endsOn: '2026-09-30', activate: true,
    });
    const wi = await defineSeason(db, ctx(), {
      code: 'winter-2026', name: 'Winter 2026', owner: { scope: 'national', id: null },
      startsOn: '2026-10-01', endsOn: '2027-03-31', activate: true,
    });
    summer = su.id; winter = wi.id;
  });

  it('renders the HQ Sunday the federation actually asked for, both ways round', async () => {
    // This is the change that started the whole wave, expressed as data:
    //   Sunday · Summer 06:00–10:00 & 15:00–18:00
    //          · Winter 08:00–11:30 & 16:00–18:30
    await publishSchedule(nat, {
      name: 'MMAKF Hombu Dojo — training hours',
      owner: { scope: 'dojo', id: HQ_DOJO },
      effectiveFrom: '2026-01-01',
      rules: [
        open(7, '06:00', '10:00', { seasonId: summer, label: 'Sunday morning' }),
        open(7, '15:00', '18:00', { seasonId: summer, label: 'Sunday afternoon' }),
        open(7, '08:00', '11:30', { seasonId: winter, label: 'Sunday morning' }),
        open(7, '16:00', '18:30', { seasonId: winter, label: 'Sunday afternoon' }),
      ],
    });

    const inSummer = await openingHoursOn(db, { purpose: 'training', dojoId: HQ_DOJO }, '2026-09-20');
    expect(windowsOf(inSummer)).toEqual(['06:00-10:00', '15:00-18:00']);
    expect(inSummer.seasons.map((x: any) => x.name)).toContain('Summer 2026');

    const inWinter = await openingHoursOn(db, { purpose: 'training', dojoId: HQ_DOJO }, '2026-10-04');
    expect(windowsOf(inWinter)).toEqual(['08:00-11:30', '16:00-18:30']);
    expect(inWinter.seasons.map((x: any) => x.name)).toContain('Winter 2026');
  });

  it('lets a season rule replace the all-year rule for that day, not union with it', async () => {
    await publishSchedule(nat, {
      name: 'HQ', owner: { scope: 'dojo', id: HQ_DOJO },
      effectiveFrom: '2026-01-01',
      rules: [
        open(7, '09:00', '11:00'),                          // all year
        open(7, '06:00', '10:00', { seasonId: summer }),    // and in summer, this instead
      ],
    });
    const summerSunday = await openingHoursOn(db, { purpose: 'training', dojoId: HQ_DOJO }, '2026-09-20');
    expect(windowsOf(summerSunday)).toEqual(['06:00-10:00']);

    // Outside both is impossible here — the two seasons cover the year — so
    // check a day the seasons do not: 2027-04-05 falls after Winter 2026 ends.
    const unseasoned = await openingHoursOn(db, { purpose: 'training', dojoId: HQ_DOJO }, '2027-04-11');
    expect(windowsOf(unseasoned)).toEqual(['09:00-11:00']);
  });

  it('is administration, not a deploy: moving the changeover date moves the timetable', async () => {
    await publishSchedule(nat, {
      name: 'HQ', owner: { scope: 'dojo', id: HQ_DOJO },
      effectiveFrom: '2026-01-01',
      rules: [
        open(7, '06:00', '10:00', { seasonId: summer }),
        open(7, '08:00', '11:30', { seasonId: winter }),
      ],
    });
    const day = '2026-09-20';
    expect(windowsOf(await openingHoursOn(db, { purpose: 'training', dojoId: HQ_DOJO }, day))).toEqual(['06:00-10:00']);

    // Summer ends early this year; winter starts early. One UPDATE each.
    await moveSeason(db, ctx(), summer, { startsOn: '2026-04-01', endsOn: '2026-09-15' });
    await moveSeason(db, ctx(), winter, { startsOn: '2026-09-16', endsOn: '2027-03-31' });
    expect(windowsOf(await openingHoursOn(db, { purpose: 'training', dojoId: HQ_DOJO }, day))).toEqual(['08:00-11:30']);
  });

  it('refuses two active seasons that cover the same date', async () => {
    await expect(defineSeason(db, ctx(), {
      code: 'monsoon-2026', name: 'Monsoon 2026', owner: { scope: 'national', id: null },
      startsOn: '2026-06-01', endsOn: '2026-08-31', activate: true,
    })).rejects.toThrow(/overlaps Summer 2026/);
  });

  it('lets a club define local seasons that replace the federation, for that club only', async () => {
    await defineSeason(db, ctx(clubAdminA), {
      code: 'ramgarh-exam-term', name: 'Ramgarh exam term', owner: { scope: 'dojo', id: CLUB_A },
      startsOn: '2026-09-01', endsOn: '2026-09-30', activate: true,
    });
    const forClub = await seasonsOn(db, [{ scope: 'dojo', id: CLUB_A }, { scope: 'national', id: null }], '2026-09-20');
    expect(forClub.map((x) => x.code)).toEqual(['ramgarh-exam-term']);

    // Club B, which defined nothing, still gets the federation's.
    const forOther = await seasonsOn(db, [{ scope: 'dojo', id: CLUB_B }, { scope: 'national', id: null }], '2026-09-20');
    expect(forOther.map((x) => x.code)).toEqual(['summer-2026']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EXCEPTIONS
// ═══════════════════════════════════════════════════════════════════════════

describe('special days beat the pattern', () => {
  let scheduleId: number;

  beforeEach(async () => {
    const made = await publishSchedule(clubAdminA, {
      name: 'Ramgarh', owner: { scope: 'dojo', id: CLUB_A },
      effectiveFrom: '2026-01-01',
      rules: [open(7, '08:00', '12:00'), open(2, '17:00', '20:00')],
    });
    scheduleId = made.schedule.id;
  });

  it('closes a day for a grading, and says so', async () => {
    const { addException } = await import('../src/db/scheduling');
    await addException(db, ctx(clubAdminA), {
      scheduleId, onDate: '2026-09-20', kind: 'grading', effect: 'closed',
      reason: 'Kyu grading examination — no open training',
    });
    const day = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_A }, '2026-09-20', { principal: clubAdminA });
    expect(day.open).toBe(false);
    expect(day.exceptions[0].kind).toBe('grading');
    expect(day.exceptions[0].reason).toMatch(/grading examination/);
  });

  it('withholds the reason from the public timetable, and says it withheld it', async () => {
    const { addException } = await import('../src/db/scheduling');
    await addException(db, ctx(clubAdminA), {
      scheduleId, onDate: '2026-09-20', kind: 'closure', effect: 'closed',
      reason: 'Sensei bereavement',
    });
    const [day] = await publicTimetable(db, { purpose: 'training', dojoId: CLUB_A }, '2026-09-20', '2026-09-20');
    expect(day.open).toBe(false);
    expect(day.exceptions[0].kind).toBe('closure');    // the fact of it, yes
    expect(day.exceptions[0].reason).toBeNull();       // the reason, no
    expect(day.exceptions[0].reasonWithheld).toBe(true);
  });

  it('replaces a day with different hours for a seminar', async () => {
    const { addException } = await import('../src/db/scheduling');
    await addException(db, ctx(clubAdminA), {
      scheduleId, onDate: '2026-09-20', kind: 'seminar', effect: 'replace',
      opensAt: '09:00', closesAt: '17:00', reason: 'Visiting instructor seminar',
    });
    const day = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_A }, '2026-09-20');
    expect(windowsOf(day)).toEqual(['09:00-17:00']);
  });

  it('cuts a maintenance window out of an otherwise ordinary day', async () => {
    const { addException } = await import('../src/db/scheduling');
    await addException(db, ctx(clubAdminA), {
      scheduleId, onDate: '2026-09-20', kind: 'maintenance', effect: 'remove',
      opensAt: '09:00', closesAt: '10:00', reason: 'Floor resurfacing',
    });
    const day = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_A }, '2026-09-20');
    expect(windowsOf(day)).toEqual(['08:00-09:00', '10:00-12:00']);
  });

  it('refuses a partly-open day on top of a full closure — that is a contradiction', async () => {
    const { addException } = await import('../src/db/scheduling');
    await addException(db, ctx(clubAdminA), {
      scheduleId, onDate: '2026-09-20', kind: 'holiday', effect: 'closed', reason: 'Public holiday',
    });
    await expect(addException(db, ctx(clubAdminA), {
      scheduleId, onDate: '2026-09-20', kind: 'special_training', effect: 'add',
      opensAt: '06:00', closesAt: '08:00', reason: 'Squad session',
    })).rejects.toThrow(/already recorded as closed/);
  });

  it('subtracts a venue blackout, which beats an administrator optimism', async () => {
    await publishSchedule(clubAdminA, {
      name: 'Ramgarh hall', owner: { scope: 'dojo', id: CLUB_A }, venueId: A_VENUE,
      effectiveFrom: '2026-01-01', rules: [open(7, '08:00', '12:00')],
    });
    await db.insert(ops.venueBlackouts).values({
      venueId: A_VENUE,
      startsAt: zonedInstant('2026-09-20', '09:00', TZ),
      endsAt: zonedInstant('2026-09-20', '10:30', TZ),
      reason: 'Electrical work',
    });
    const day = await openingHoursOn(db, { purpose: 'training', venueId: A_VENUE }, '2026-09-20');
    expect(windowsOf(day)).toEqual(['08:00-09:00', '10:30-12:00']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VERSIONING
// ═══════════════════════════════════════════════════════════════════════════

describe('history is not overwritten', () => {
  it('keeps the timetable that was in force when an attendance record was made', async () => {
    // The directive's own example: 18:00–20:00 until 30 September, 17:00–21:00
    // from 1 October, and BOTH stored.
    const made = await publishSchedule(clubAdminA, {
      name: 'Ramgarh', owner: { scope: 'dojo', id: CLUB_A },
      effectiveFrom: '2026-01-01', rules: [open(1, '18:00', '20:00')],
    });

    const next = await draftVersion(db, ctx(clubAdminA), made.schedule.id, {
      effectiveFrom: '2026-10-01',
      rules: [open(1, '17:00', '21:00')],
    });
    const { superseded } = await publishVersion(db, ctx(clubAdminA), next.id, 'Winter evening extension agreed at the September committee');

    expect(superseded).not.toBeNull();
    expect(superseded!.effectiveTo).toBe('2026-09-30');

    const before = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_A }, '2026-09-14');
    const after = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_A }, '2026-10-05');
    expect(windowsOf(before)).toEqual(['18:00-20:00']);
    expect(windowsOf(after)).toEqual(['17:00-21:00']);
    expect(before.versionId).not.toBe(after.versionId);

    // And the old rules are still rows, not a memory.
    const oldRules = await db.select().from(sch.scheduleRules).where(eq(sch.scheduleRules.versionId, made.version.id));
    expect(oldRules[0].opensAt).toBe('18:00');
  });

  it('refuses to edit a published version — a successor is the only way', async () => {
    const made = await publishSchedule(clubAdminA, {
      name: 'Ramgarh', owner: { scope: 'dojo', id: CLUB_A },
      effectiveFrom: '2026-01-01', rules: [open(1, '18:00', '20:00')],
    });
    await expect(setRules(db, ctx(clubAdminA), made.version.id, [open(1, '19:00', '21:00')]))
      .rejects.toThrow(/cannot be edited/);
  });

  it('records who published and why, and refuses without either', async () => {
    const schedule = await createSchedule(db, ctx(clubAdminA), {
      name: 'Ramgarh', purpose: 'training', owner: { scope: 'dojo', id: CLUB_A },
    });
    const v = await draftVersion(db, ctx(clubAdminA), schedule.id, {
      effectiveFrom: '2026-01-01', rules: [open(1, '18:00', '20:00')],
    });
    await expect(publishVersion(db, ctx(clubAdminA), v.id, '   ')).rejects.toThrow(/must record why/);

    await publishVersion(db, ctx(clubAdminA), v.id, 'Initial timetable');
    const [row] = await db.select().from(sch.scheduleVersions).where(eq(sch.scheduleVersions.id, v.id));
    expect(row.publishedByUserId).toBe(clubAdminA.userId);
    expect(row.publishedAt).not.toBeNull();
    expect(row.reason).toBe('Initial timetable');

    // And the audit spine has it, with the reason the context carried.
    const audit = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'schedule_version'));
    expect(audit.some((a: any) => a.action === 'approve')).toBe(true);
  });

  it('refuses a draft that says nothing at all', async () => {
    const schedule = await createSchedule(db, ctx(clubAdminA), {
      name: 'Empty', purpose: 'training', owner: { scope: 'dojo', id: CLUB_A },
    });
    const v = await draftVersion(db, ctx(clubAdminA), schedule.id, { effectiveFrom: '2026-01-01' });
    await expect(publishVersion(db, ctx(clubAdminA), v.id, 'why')).rejects.toThrow(/no rules at all/);
  });

  it('keeps a draft invisible until it is published', async () => {
    const made = await publishSchedule(clubAdminA, {
      name: 'Ramgarh', owner: { scope: 'dojo', id: CLUB_A },
      effectiveFrom: '2026-01-01', rules: [open(1, '18:00', '20:00')],
    });
    await draftVersion(db, ctx(clubAdminA), made.schedule.id, {
      effectiveFrom: '2026-02-01', rules: [open(1, '05:00', '06:00')],
    });
    const day = await openingHoursOn(db, { purpose: 'training', dojoId: CLUB_A }, '2026-09-14');
    expect(windowsOf(day)).toEqual(['18:00-20:00']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTHORITY
// ═══════════════════════════════════════════════════════════════════════════

describe('who may change a timetable', () => {
  it('stops a club administrator editing the federation default', async () => {
    await expect(createSchedule(db, ctx(clubAdminA), {
      name: 'National (hijacked)', purpose: 'training', owner: { scope: 'national', id: null },
    })).rejects.toThrow();
  });

  it('stops one club administrator editing another club', async () => {
    await expect(createSchedule(db, ctx(clubAdminB), {
      name: 'Ramgarh (hijacked)', purpose: 'training', owner: { scope: 'dojo', id: CLUB_A },
    })).rejects.toThrow();
  });

  it('lets the state administrator reach a club inside their own state', async () => {
    const schedule = await createSchedule(db, ctx(stateAdmin), {
      name: 'Ramgarh, set by the state office', purpose: 'training', owner: { scope: 'dojo', id: CLUB_A },
    });
    expect(schedule.ownerScope).toBe('dojo');
    expect(schedule.ownerId).toBe(CLUB_A);
  });

  it('refuses a schedule owned by "some dojo, unspecified"', async () => {
    await expect(createSchedule(db, ctx(), {
      name: 'Nowhere', purpose: 'training', owner: { scope: 'dojo', id: null } as any,
    })).rejects.toThrow(/must name which dojo/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CLASSES, WHICH ARE NOT THE BUILDING
// ═══════════════════════════════════════════════════════════════════════════

describe('a class is not the room it happens in', () => {
  beforeEach(async () => {
    // The hall is open a long day; the classes inside it are not.
    await publishSchedule(clubAdminA, {
      name: 'Ramgarh hall hours', owner: { scope: 'dojo', id: CLUB_A }, venueId: A_VENUE,
      effectiveFrom: '2026-01-01',
      rules: [...[1, 2, 3, 4, 5, 6, 7].map((d) => open(d, '06:00', '21:00'))],
    });
  });

  async function makeClass(overrides: any = {}) {
    return await createClass(db, ctx(clubAdminA), {
      name: 'Kihon Fundamentals', slug: `kihon-${Math.abs(Math.round(Math.sin(overrides.seed ?? 1) * 1e9))}`,
      owner: { scope: 'dojo', id: CLUB_A }, venueId: A_VENUE, mode: 'at_dojo',
      capacity: 2, defaultCoachPersonId: coach1, activate: true, ...overrides,
    });
  }

  it('generates only the class windows, inside the hall hours', async () => {
    const klass = await makeClass({ seed: 1 });
    await publishSchedule(clubAdminA, {
      name: 'Kihon times', purpose: 'class', owner: { scope: 'dojo', id: CLUB_A }, classId: klass.id,
      effectiveFrom: '2026-01-01',
      rules: [open(1, '18:00', '19:30')],
    });

    const result = await generateSessions(db, ctx(clubAdminA), klass.id, '2026-09-14', '2026-09-27');
    expect(result.created).toBe(2);                 // two Mondays
    expect(result.refused).toHaveLength(0);

    const sessions = await db.select().from(sch.classSessions).where(eq(sch.classSessions.classId, klass.id));
    expect(sessions.map((x: any) => `${x.localDate} ${x.localStart}-${x.localEnd}`).sort())
      .toEqual(['2026-09-14 18:00-19:30', '2026-09-21 18:00-19:30']);
    // Provenance: each occurrence names the version that produced it.
    expect(sessions.every((x: any) => x.scheduleVersionId != null)).toBe(true);
  });

  it('REFUSES a class window the building is not open for, and reports it', async () => {
    const klass = await makeClass({ seed: 2 });
    await publishSchedule(clubAdminA, {
      name: 'Late class', purpose: 'class', owner: { scope: 'dojo', id: CLUB_A }, classId: klass.id,
      effectiveFrom: '2026-01-01',
      rules: [open(1, '21:30', '22:30')],           // the hall shuts at 21:00
    });
    const result = await generateSessions(db, ctx(clubAdminA), klass.id, '2026-09-14', '2026-09-14');
    expect(result.created).toBe(0);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0].reason).toMatch(/the venue is open 06:00–21:00/);
  });

  it('does not place a class on a day the building is closed', async () => {
    const klass = await makeClass({ seed: 3 });
    await publishSchedule(clubAdminA, {
      name: 'Monday class', purpose: 'class', owner: { scope: 'dojo', id: CLUB_A }, classId: klass.id,
      effectiveFrom: '2026-01-01', rules: [open(1, '18:00', '19:30')],
    });
    const { addException } = await import('../src/db/scheduling');
    const hall = await db.select().from(sch.schedules).where(eq(sch.schedules.venueId, A_VENUE));
    await addException(db, ctx(clubAdminA), {
      scheduleId: hall[0].id, onDate: '2026-09-14', kind: 'holiday', effect: 'closed',
      reason: 'Public holiday',
    });
    const result = await generateSessions(db, ctx(clubAdminA), klass.id, '2026-09-14', '2026-09-14');
    expect(result.created).toBe(0);
    expect(result.refused[0].reason).toMatch(/closed that day/);
  });

  it('is idempotent — regenerating the same window creates nothing new', async () => {
    const klass = await makeClass({ seed: 4 });
    await publishSchedule(clubAdminA, {
      name: 'Monday class', purpose: 'class', owner: { scope: 'dojo', id: CLUB_A }, classId: klass.id,
      effectiveFrom: '2026-01-01', rules: [open(1, '18:00', '19:30')],
    });
    const first = await generateSessions(db, ctx(clubAdminA), klass.id, '2026-09-14', '2026-09-14');
    const again = await generateSessions(db, ctx(clubAdminA), klass.id, '2026-09-14', '2026-09-14');
    expect(first.created).toBe(1);
    expect(again.created).toBe(0);
    expect(again.skippedExisting).toBe(1);
  });

  it('refuses to invent a weekly pattern for a class that has none', async () => {
    const klass = await makeClass({ seed: 5 });
    await expect(generateSessions(db, ctx(clubAdminA), klass.id, '2026-09-14', '2026-09-14'))
      .rejects.toThrow(/no published class schedule/);
  });

  it('keeps an online class out of the dojo, and requires a room for every other mode', async () => {
    const online = await createClass(db, ctx(clubAdminA), {
      name: 'Online: Kata Series', slug: 'online-kata-series',
      owner: { scope: 'dojo', id: CLUB_A }, mode: 'online', activate: true,
      onlinePlatform: 'youtube', onlineUrl: 'https://example.test/live',
    });
    expect(online.venueId).toBeNull();

    await expect(createClass(db, ctx(clubAdminA), {
      name: 'Online with a hall', slug: 'online-with-a-hall',
      owner: { scope: 'dojo', id: CLUB_A }, mode: 'online', venueId: A_VENUE,
    })).rejects.toThrow(/does not consume a physical dojo/);

    await expect(createClass(db, ctx(clubAdminA), {
      name: 'Hybrid without a hall', slug: 'hybrid-without-a-hall',
      owner: { scope: 'dojo', id: CLUB_A }, mode: 'hybrid',
    })).rejects.toThrow(/must name it/);
  });

  it('generates an online class without consulting any building', async () => {
    const online = await createClass(db, ctx(clubAdminA), {
      name: 'Online: Kihon', slug: 'online-kihon',
      owner: { scope: 'dojo', id: CLUB_A }, mode: 'online', activate: true, capacity: null,
    });
    await publishSchedule(clubAdminA, {
      name: 'Online times', purpose: 'class', owner: { scope: 'dojo', id: CLUB_A }, classId: online.id,
      effectiveFrom: '2026-01-01',
      rules: [open(7, '19:00', '20:00')],           // the hall is shut; irrelevant
    });
    const result = await generateSessions(db, ctx(clubAdminA), online.id, '2026-09-20', '2026-09-20');
    expect(result.created).toBe(1);
    const [session] = await db.select().from(sch.classSessions).where(eq(sch.classSessions.classId, online.id));
    expect(session.venueId).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFLICTS
// ═══════════════════════════════════════════════════════════════════════════

describe('nothing is double-booked silently', () => {
  async function twoClassesAtTheSameHour(sameCoach: boolean, sameVenue: boolean) {
    await publishSchedule(clubAdminA, {
      name: 'A hall', owner: { scope: 'dojo', id: CLUB_A }, venueId: A_VENUE,
      effectiveFrom: '2026-01-01', rules: [open(1, '06:00', '21:00')],
    });
    await publishSchedule(clubAdminB, {
      name: 'B hall', owner: { scope: 'dojo', id: CLUB_B }, venueId: B_VENUE,
      effectiveFrom: '2026-01-01', rules: [open(1, '06:00', '21:00')],
    });

    const first = await createClass(db, ctx(clubAdminA), {
      name: 'First', slug: 'first-class', owner: { scope: 'dojo', id: CLUB_A },
      venueId: A_VENUE, defaultCoachPersonId: coach1, activate: true,
    });
    const second = await createClass(db, ctx(), {
      name: 'Second', slug: 'second-class',
      owner: { scope: 'dojo', id: sameVenue ? CLUB_A : CLUB_B },
      venueId: sameVenue ? A_VENUE : B_VENUE,
      defaultCoachPersonId: sameCoach ? coach1 : coach2,
      activate: true,
    });
    for (const k of [first, second]) {
      await publishSchedule(nat, {
        name: `${k.name} times`, purpose: 'class',
        owner: { scope: 'dojo', id: k.ownerId }, classId: k.id,
        effectiveFrom: '2026-01-01', rules: [open(1, '18:00', '19:30')],
      });
    }
    await generateSessions(db, ctx(), first.id, '2026-09-14', '2026-09-14');
    return await generateSessions(db, ctx(), second.id, '2026-09-14', '2026-09-14');
  }

  it('refuses to put one coach in two places at once', async () => {
    const result = await twoClassesAtTheSameHour(true, false);
    expect(result.created).toBe(0);
    expect(result.conflicts.some((c: any) => c.kind === 'coach_double_booked')).toBe(true);
    expect(result.refused[0].reason).toMatch(/the coach already teaches/);
  });

  it('refuses to put two classes in one room at once', async () => {
    const result = await twoClassesAtTheSameHour(false, true);
    expect(result.created).toBe(0);
    expect(result.conflicts.some((c: any) => c.kind === 'venue_double_booked')).toBe(true);
  });

  it('allows two coaches in two rooms at the same hour', async () => {
    const result = await twoClassesAtTheSameHour(false, false);
    expect(result.created).toBe(1);
    expect(result.conflicts).toHaveLength(0);
  });

  it('sees a coach recorded as away, without repeating why', async () => {
    await db.insert(s.coachAvailability).values({
      personId: coach1, kind: 'leave',
      startsAt: zonedInstant('2026-09-14', '00:00', TZ),
      endsAt: zonedInstant('2026-09-15', '00:00', TZ),
      reason: 'Bereavement',
    });
    const conflicts = await detectConflicts(db, {
      startsAt: zonedInstant('2026-09-14', '18:00', TZ),
      endsAt: zonedInstant('2026-09-14', '19:30', TZ),
      coachPersonId: coach1,
    });
    expect(conflicts.some((c) => c.kind === 'coach_unavailable')).toBe(true);
    expect(JSON.stringify(conflicts)).not.toMatch(/Bereavement/);
  });

  it('sees a coach already held by an ordinary booking, not only by a class', async () => {
    await db.insert(s.bookings).values({
      ref: 'MMAKF-BKG-2026-000999', kind: 'personal_coaching', status: 'confirmed',
      coachPersonId: coach1,
      startsAt: zonedInstant('2026-09-14', '18:00', TZ),
      endsAt: zonedInstant('2026-09-14', '19:00', TZ),
    });
    const conflicts = await detectConflicts(db, {
      startsAt: zonedInstant('2026-09-14', '18:30', TZ),
      endsAt: zonedInstant('2026-09-14', '19:30', TZ),
      coachPersonId: coach1,
    });
    expect(conflicts.some((c) => c.kind === 'coach_double_booked' && c.withKind === 'booking')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BOOKING A PLACE
// ═══════════════════════════════════════════════════════════════════════════

describe('booking a place in a class', () => {
  let klassId: number, sessionId: number;

  beforeEach(async () => {
    await publishSchedule(clubAdminA, {
      name: 'A hall', owner: { scope: 'dojo', id: CLUB_A }, venueId: A_VENUE,
      effectiveFrom: '2026-01-01', rules: [open(1, '06:00', '21:00')],
    });
    const klass = await createClass(db, ctx(clubAdminA), {
      name: 'Kids Program', slug: 'kids-program', owner: { scope: 'dojo', id: CLUB_A },
      venueId: A_VENUE, capacity: 2, defaultCoachPersonId: coach1, activate: true,
    });
    klassId = klass.id;
    await publishSchedule(clubAdminA, {
      name: 'Kids times', purpose: 'class', owner: { scope: 'dojo', id: CLUB_A }, classId: klassId,
      effectiveFrom: '2026-01-01', rules: [open(1, '18:00', '19:00')],
    });
    // Far enough ahead that the "already started" guard never fires.
    await generateSessions(db, ctx(clubAdminA), klassId, '2099-01-05', '2099-01-05');
    const [session] = await db.select().from(sch.classSessions).where(eq(sch.classSessions.classId, klassId));
    sessionId = session.id;
  });

  it('holds a place and reports what is left', async () => {
    const held = await bookClassSession(db, ctx(member), sessionId, student);
    expect(held.seatsRemaining).toBe(1);
    const [session] = await db.select().from(sch.classSessions).where(eq(sch.classSessions.id, sessionId));
    expect(session.bookedCount).toBe(1);
  });

  it('refuses the same person twice', async () => {
    await bookClassSession(db, ctx(member), sessionId, student);
    await expect(bookClassSession(db, ctx(member), sessionId, student)).rejects.toThrow(/already held/);
  });

  it('does not overfill the class when everybody clicks at once', async () => {
    // The measured version of the capacity guarantee. Read the caveat in
    // tests/booking.test.ts: PGlite serialises transactions in-engine, so what
    // this proves is that the COUNT AND THE INSERT ARE IN ONE TRANSACTION —
    // remove it and this test fails with five bookings in a class of two.
    const people = [];
    for (let i = 0; i < 5; i++) {
      const p = await createPerson(db, ctx(), { fullName: `Student ${i}`, stateUnitId: JH });
      people.push(p.id);
    }
    const results = await Promise.allSettled(
      people.map((pid) => bookClassSession(db, ctx(nat), sessionId, pid))
    );
    const taken = results.filter((r) => r.status === 'fulfilled').length;
    expect(taken).toBe(2);
    const [session] = await db.select().from(sch.classSessions).where(eq(sch.classSessions.id, sessionId));
    expect(session.bookedCount).toBe(2);
    expect(results.filter((r) => r.status === 'rejected').every((r: any) => /full/.test(String(r.reason?.message)))).toBe(true);
  });

  it('gives the place back when a booking is cancelled', async () => {
    const held = await bookClassSession(db, ctx(member), sessionId, student);
    const after = await cancelSessionBooking(db, ctx(member), held.bookingId, 'Unwell');
    expect(after.seatsRemaining).toBe(2);
  });

  it('cancels the session and every place held on it, with the reason attached', async () => {
    await bookClassSession(db, ctx(member), sessionId, student);
    const result = await cancelSession(db, ctx(clubAdminA), sessionId, 'Instructor at a national camp');
    expect(result.bookingsCancelled).toBe(1);

    const bookings = await db.select().from(s.bookings).where(eq(s.bookings.classSessionId, sessionId));
    expect(bookings[0].status).toBe('cancelled');
    expect(bookings[0].cancelledReason).toMatch(/Instructor at a national camp/);

    await expect(bookClassSession(db, ctx(member), sessionId, student)).rejects.toThrow(/cancelled/);
  });

  it('refuses a cancellation with no reason', async () => {
    await expect(cancelSession(db, ctx(clubAdminA), sessionId, '  ')).rejects.toThrow(/must record why/);
  });

  it('tells the people who held a place — and does not tell them why', async () => {
    // The federation's instruction: when a class moves or is called off, the
    // affected students are notified. This is that path end to end — the event
    // is published in the same transaction that cancels the bookings, and the
    // notification consumer resolves the audience from those bookings.
    await bookClassSession(db, ctx(member), sessionId, student);
    await cancelSession(db, ctx(clubAdminA), sessionId, 'Instructor bereavement');

    const [event] = await db.select().from(s.domainEvents)
      .where(eq(s.domainEvents.eventType, 'CLASS_SESSION_CANCELLED'));
    expect(event).toBeTruthy();
    // The reason is NOT on the feed. It is in the audit trail and on the
    // administrator's screen; a notification travels through channels the
    // federation does not control.
    expect(JSON.stringify(event.payload)).not.toMatch(/bereavement/i);

    const queued = await notifyForEvent(db, ctx(clubAdminA), {
      id: event.id, eventType: event.eventType, entityType: event.entityType,
      entityId: event.entityId, payload: event.payload,
    });
    expect(queued).toBe(1);

    const [note] = await db.select().from(s.notifications);
    expect(note.personId).toBe(student);
    expect(note.title).toMatch(/cancelled/i);
    expect(note.body).not.toMatch(/bereavement/i);
    expect(note.body).toMatch(/Kids Program/);
  });

  it('offers only sessions somebody can genuinely take', async () => {
    let offered = await bookableSessions(db, { classId: klassId }, '2099-01-01', '2099-01-31');
    expect(offered).toHaveLength(1);
    expect(offered[0].seatsRemaining).toBe(2);

    // A blackout declared after the timetable was generated removes it, without
    // a sweep somebody has to remember to run.
    await db.insert(ops.venueBlackouts).values({
      venueId: A_VENUE,
      startsAt: zonedInstant('2099-01-05', '17:00', TZ),
      endsAt: zonedInstant('2099-01-05', '20:00', TZ),
      reason: 'Hall let for an election count',
    });
    offered = await bookableSessions(db, { classId: klassId }, '2099-01-01', '2099-01-31');
    expect(offered).toHaveLength(0);
  });

  it('does not offer a session that has already started', async () => {
    await generateSessions(db, ctx(clubAdminA), klassId, '2026-09-14', '2026-09-14');
    // `now` is passed rather than taken from the clock, so this test asserts the
    // rule and not the date it happens to be run on.
    const before = await bookableSessions(db, { classId: klassId }, '2026-09-01', '2026-09-30', { now: new Date('2026-09-01T00:00:00Z') });
    const after = await bookableSessions(db, { classId: klassId }, '2026-09-01', '2026-09-30', { now: new Date('2026-09-30T00:00:00Z') });
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE GUARD
// ═══════════════════════════════════════════════════════════════════════════

describe('no hard-coded hours anywhere in the engine', () => {
  /**
   * Executable lines only. The prose around them cites real examples on
   * purpose — the schema's own comment says a season code looks like
   * 'summer-2026', which is documentation, not a decision.
   */
  const codeOf = (path: string) =>
    readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')            // block comments, including JSDoc
      .replace(/(^|[^:])\/\/.*$/gm, '$1')          // line and trailing comments, sparing '://'
      .split('\n')
      .join('\n');

  it('carries no opening time of its own', () => {
    // THE POINT OF THE ENTIRE WAVE. A single '06:00' in here would mean some
    // club's timetable is a coincidence rather than a record — and it is exactly
    // the line a future change adds "just as a sensible default".
    //
    // '00:00' is permitted and is the ONLY permitted literal: it is the boundary
    // of a calendar day, used to turn a date into the instant it begins, and it
    // is not an hour anybody opens at. The assertion is written as an exact set
    // rather than as an exclusion so that a second carve-out cannot be smuggled
    // in beside it.
    for (const path of ['src/db/scheduling.ts', 'src/db/scheduling.schema.ts']) {
      const found = new Set(
        [...codeOf(path).matchAll(/['"`](([01]\d|2[0-3]):[0-5]\d)['"`]/g)].map((m) => m[1])
      );
      expect([...found].sort(), `${path} should carry no opening time`).toEqual(
        path.endsWith('scheduling.ts') ? ['00:00'] : []
      );
    }
  });

  /**
   * Executable code with every quoted string removed as well.
   *
   * A weekday inside a string is a MESSAGE — "dayOfWeek must be 1 (Monday) to 7
   * (Sunday)" is the engine explaining itself to an administrator, and forbidding
   * it would only make the error worse. What must not exist is a weekday or a
   * season name the code BRANCHES on, and after the strings are gone anything
   * left is exactly that.
   */
  const logicOf = (path: string) =>
    codeOf(path)
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``');

  it('branches on no day of the week', () => {
    expect(logicOf('src/db/scheduling.ts'))
      .not.toMatch(/\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/);
  });

  it('branches on no season', () => {
    // 'Summer' and 'Winter' are rows in `seasons` with dates an administrator
    // chose. If either word reaches the logic, something is deciding in code
    // what a season means.
    expect(logicOf('src/db/scheduling.ts')).not.toMatch(/\b[Ss]ummer|[Ww]inter\b/);
    expect(logicOf('src/db/scheduling.schema.ts')).not.toMatch(/\b[Ss]ummer|[Ww]inter\b/);
  });
});
