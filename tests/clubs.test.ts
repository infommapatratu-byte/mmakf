// Finding a club, and what a club's own page says.
//
// TWO REFUSALS CARRY THIS FILE, and both have a victim if they fail.
//
// A SEARCH MUST NOT OFFER A LAPSED CLUB. /dojos lists one deliberately, with
// its standing in words, because the person reading that page is the parent of
// a child already training there. This surface is the opposite case — a family
// choosing where to start — and offering them a club whose charter expired, on
// the federation's own recommendation, is the federation vouching for something
// it has withdrawn.
//
// AND A CLUB PAGE MUST NOT LIST STUDENTS AS INSTRUCTORS. `persons.dojoId` is
// where a MEMBER is placed. The instructor list joins `instructor_quals`
// INNER — a left join, which is the natural way to write it, would publish the
// name of every child at the club under the heading "Who teaches here".

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
  findClubs, nearbyClubs, clubProfile, publishableClubs, haversineKm,
} from '../src/db/clubs';
import {
  createSchedule, draftVersion, publishVersion, createClass,
} from '../src/db/scheduling';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

const nat: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const ctx: AuditContext = { principal: nat, reason: 'test', authority: 'test' };

let db: any;
let JH: number, RMG: number, BOK: number;
let RAMGARH: number, BOKARO: number, LAPSED: number, NOSLUG: number;
let RAMGARH_VENUE: number, BOKARO_VENUE: number;
let sensei: number, student: number;

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of MIGRATIONS) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  await db.insert(s.users).values({ id: 1, email: 'nat@example.test', status: 'active' });

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand Association', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
  const districts = await db.insert(s.districtUnits).values([
    { code: 'D-RMG', stateUnitId: JH, district: 'Ramgarh', name: 'Ramgarh District', status: 'active' },
    { code: 'D-BOK', stateUnitId: JH, district: 'Bokaro', name: 'Bokaro District', status: 'active' },
  ]).returning({ id: s.districtUnits.id });
  RMG = districts[0].id; BOK = districts[1].id;

  const dojos = await db.insert(s.dojos).values([
    { code: 'D-1', name: 'MMAKF Ramgarh Centre', slug: 'mmakf-ramgarh-centre', stateUnitId: JH, districtUnitId: RMG, city: 'Ramgarh', status: 'active', affiliationExpiresOn: '2027-03-31' },
    { code: 'D-2', name: 'MMAKF Bokaro Dojo', slug: 'mmakf-bokaro-dojo', stateUnitId: JH, districtUnitId: BOK, city: 'Bokaro', status: 'active' },
    { code: 'D-3', name: 'MMAKF Former Club', slug: 'mmakf-former-club', stateUnitId: JH, districtUnitId: RMG, city: 'Hazaribagh', status: 'expired' },
    // Affiliated, and nobody has given it a public address. It must appear in a
    // SEARCH and must not appear in the SITEMAP — see publishableClubs().
    { code: 'D-4', name: 'MMAKF Patratu Centre', stateUnitId: JH, districtUnitId: RMG, city: 'Patratu', status: 'active' },
  ]).returning({ id: s.dojos.id });
  [RAMGARH, BOKARO, LAPSED, NOSLUG] = dojos.map((d: any) => d.id);

  const venues = await db.insert(ops.venues).values([
    { code: 'V-1', name: 'Ramgarh hall', kind: 'dojo', dojoId: RAMGARH, stateUnitId: JH, districtUnitId: RMG, city: 'Ramgarh', latitude: '23.630000', longitude: '85.520000', accessibility: { stepFree: true, hearingLoop: null } },
    { code: 'V-2', name: 'Bokaro hall', kind: 'dojo', dojoId: BOKARO, stateUnitId: JH, districtUnitId: BOK, city: 'Bokaro', latitude: '23.660000', longitude: '86.150000' },
  ]).returning({ id: ops.venues.id });
  RAMGARH_VENUE = venues[0].id; BOKARO_VENUE = venues[1].id;

  const teacher = await createPerson(db, ctx, { fullName: 'Sensei Vikas Pathak', stateUnitId: JH });
  const pupil = await createPerson(db, ctx, { fullName: 'A Child', stateUnitId: JH });
  sensei = teacher.id; student = pupil.id;
  // status 'active': clubProfile() lists active members only, so a person the
  // register has not confirmed is not published as one of a club's instructors.
  await db.update(s.persons).set({ dojoId: RAMGARH, status: 'active' }).where(eq(s.persons.id, sensei));
  await db.update(s.persons).set({ dojoId: RAMGARH, status: 'active' }).where(eq(s.persons.id, student));
  await db.insert(s.instructorQuals).values({
    personId: sensei, level: 'senior', grantedOn: '2020-01-01', status: 'active',
  });
});

beforeEach(async () => {
  await db.execute?.('DELETE FROM schedule_rules');
  await db.execute?.('DELETE FROM schedule_versions');
  await db.execute?.('DELETE FROM schedules');
  await db.execute?.('DELETE FROM dojo_classes');
  await db.execute?.('DELETE FROM postal_codes');
});

async function publishClasses() {
  await createClass(db, ctx, {
    name: 'Kids Program', slug: 'ramgarh-kids', owner: { scope: 'dojo', id: RAMGARH },
    venueId: RAMGARH_VENUE, audience: 'kids', level: 'beginner', discipline: 'shotokan',
    ageMin: 5, ageMax: 14, activate: true,
  });
  await createClass(db, ctx, {
    name: 'Online Kata', slug: 'ramgarh-online-kata', owner: { scope: 'dojo', id: RAMGARH },
    mode: 'online', audience: 'adults', level: 'all', discipline: 'shotokan', activate: true,
  });
  await createClass(db, ctx, {
    name: 'Evening Kumite', slug: 'bokaro-kumite', owner: { scope: 'dojo', id: BOKARO },
    venueId: BOKARO_VENUE, audience: 'adults', level: 'advanced', discipline: 'shotokan',
    ageMin: 16, activate: true,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SEARCH
// ═══════════════════════════════════════════════════════════════════════════

describe('finding a club', () => {
  it('offers currently-affiliated clubs and NOT a lapsed one', async () => {
    const found = await findClubs(db);
    const names = found.map((c) => c.name);
    expect(names).toContain('MMAKF Ramgarh Centre');
    expect(names).toContain('MMAKF Bokaro Dojo');
    // The whole point. /dojos lists this one, with its standing in words.
    expect(names).not.toContain('MMAKF Former Club');
  });

  it('describes a club by the classes it has actually published', async () => {
    await publishClasses();
    const [ramgarh] = (await findClubs(db)).filter((c) => c.id === RAMGARH);
    expect(ramgarh.audiences.sort()).toEqual(['adults', 'kids']);
    expect(ramgarh.online).toBe(true);
    expect(ramgarh.classCount).toBe(2);

    const [bokaro] = (await findClubs(db)).filter((c) => c.id === BOKARO);
    expect(bokaro.online).toBe(false);
  });

  it('filters by who the class is for, by level and by city', async () => {
    await publishClasses();
    expect((await findClubs(db, { audience: 'kids' })).map((c) => c.id)).toEqual([RAMGARH]);
    expect((await findClubs(db, { level: 'advanced' })).map((c) => c.id)).toEqual([BOKARO]);
    expect((await findClubs(db, { city: 'bokaro' })).map((c) => c.id)).toEqual([BOKARO]);
    expect((await findClubs(db, { onlineOnly: true })).map((c) => c.id)).toEqual([RAMGARH]);
  });

  it('answers "where can my eight-year-old train" with the club that takes eight-year-olds', async () => {
    await publishClasses();
    expect((await findClubs(db, { age: 8 })).map((c) => c.id)).toEqual([RAMGARH]);
    expect((await findClubs(db, { age: 30 })).map((c) => c.id).sort()).toEqual([RAMGARH, BOKARO].sort());
  });

  it('keeps a club that has published nothing — it still trains', async () => {
    // A club with no class list is not a club that does not exist. Filtering it
    // out of an UNFILTERED search would remove it from the federation's own
    // directory for the sin of not having typed its timetable in yet.
    const found = await findClubs(db);
    expect(found.map((c) => c.id)).toContain(NOSLUG);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NEARBY
// ═══════════════════════════════════════════════════════════════════════════

describe('nearby', () => {
  it('measures a real distance and orders by it', async () => {
    // Standing in Bokaro: the Bokaro club is nearer than the Ramgarh one.
    const near = await nearbyClubs(db, { latitude: 23.66, longitude: 86.15 });
    expect(near[0].id).toBe(BOKARO);
    expect(near[0].distanceKm).toBeLessThan(5);
    const ramgarh = near.find((c) => c.id === RAMGARH)!;
    expect(ramgarh.distanceKm).toBeGreaterThan(50);
  });

  it('puts clubs with no coordinates AFTER the measured ones, with no distance', async () => {
    // The ordering has to say what it is. A club with no coordinates appearing
    // between two measured ones would present an arbitrary position as a
    // proximity ranking, and somebody would drive to it.
    const near = await nearbyClubs(db, { latitude: 23.66, longitude: 86.15 });
    const measured = near.filter((c) => c.distanceKm != null);
    const unmeasured = near.filter((c) => c.distanceKm == null);
    expect(measured.length).toBeGreaterThan(0);
    expect(unmeasured.length).toBeGreaterThan(0);
    expect(near.slice(0, measured.length).every((c) => c.distanceKm != null)).toBe(true);
  });

  it('treats a PIN code as an AREA, not as a coordinate', async () => {
    // `postal_codes` maps a code to an administrative area and carries no
    // latitude at all. Inventing one for the centre of a postal district and
    // publishing "3.4 km" from it would be a measurement nobody took.
    const [country] = await db.insert(s.countries)
      .values({ iso2: 'IN', iso3: 'IND', name: 'India', defaultTimezone: 'Asia/Kolkata' })
      .returning({ id: s.countries.id });
    const [area] = await db.insert(s.adminAreas)
      .values({ countryId: country.id, level: 'district', code: 'BOKARO', path: 'IN/BOKARO', depth: 1, name: 'Bokaro' })
      .returning({ id: s.adminAreas.id });
    await db.insert(s.postalCodes).values({ countryId: country.id, code: '827001', areaId: area.id });
    await db.update(ops.venues).set({ areaId: area.id }).where(eq(ops.venues.id, BOKARO_VENUE));

    const near = await nearbyClubs(db, { postalCode: '827001' });
    expect(near[0].id).toBe(BOKARO);
    expect(near[0].distanceKm).toBeNull();   // an area match is not a distance
  });

  it('returns the whole list for a PIN code with no club in it', async () => {
    // "No club in your postal district" and "there are no clubs" are different
    // answers, and the second one is false.
    const near = await nearbyClubs(db, { postalCode: '999999' });
    expect(near.length).toBeGreaterThan(0);
  });

  it('computes a straight line, and only a straight line', () => {
    // Roughly 64 km between Ramgarh and Bokaro as the crow flies. The surfaces
    // label it straight-line because a road distance needs a routing service
    // this project does not have.
    const km = haversineKm({ lat: 23.63, lon: 85.52 }, { lat: 23.66, lon: 86.15 });
    expect(km).toBeGreaterThan(55);
    expect(km).toBeLessThan(75);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE CLUB'S OWN PAGE
// ═══════════════════════════════════════════════════════════════════════════

describe('a club profile', () => {
  it('returns the club, its rooms and its classes', async () => {
    await publishClasses();
    const profile = (await clubProfile(db, 'mmakf-ramgarh-centre'))!;
    expect(profile.club.name).toBe('MMAKF Ramgarh Centre');
    expect(profile.club.standing).toBe('chartered');
    expect(profile.club.charterValidUntil).toBe('2027-03-31');
    expect(profile.venues.map((v) => v.name)).toEqual(['Ramgarh hall']);
    expect(profile.classes.map((c) => c.slug).sort()).toEqual(['ramgarh-kids', 'ramgarh-online-kata']);
  });

  it('lists instructors and NOT students', async () => {
    // The single worst thing this page could do. `persons.dojoId` holds every
    // member of the club, including the children.
    const profile = (await clubProfile(db, 'mmakf-ramgarh-centre'))!;
    expect(profile.instructors.map((i) => i.fullName)).toEqual(['Sensei Vikas Pathak']);
    expect(JSON.stringify(profile.instructors)).not.toMatch(/A Child/);
  });

  it('says the timings are not published rather than showing an empty week', async () => {
    const profile = (await clubProfile(db, 'mmakf-bokaro-dojo'))!;
    expect(profile.week.configured).toBe(false);
    expect(profile.week.days).toEqual([]);
  });

  it('shows the club its own published week', async () => {
    const schedule = await createSchedule(db, ctx, {
      name: 'Ramgarh training', purpose: 'training', owner: { scope: 'dojo', id: RAMGARH },
    });
    const version = await draftVersion(db, ctx, schedule.id, {
      effectiveFrom: '2020-01-01',
      rules: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: '18:00', closesAt: '21:00' })),
    });
    await publishVersion(db, ctx, version.id, 'test');

    const profile = (await clubProfile(db, 'mmakf-ramgarh-centre'))!;
    expect(profile.week.configured).toBe(true);
    expect(profile.week.isOwnSchedule).toBe(true);
    expect(profile.week.days[0].windows[0].opensAt).toBe('18:00');
  });

  it('has NO page for a lapsed club', async () => {
    // Leaving it up is the federation vouching for a club it has withdrawn
    // from; rewriting it to say "formerly affiliated" is still a promotional
    // page. The register at /dojos is where a former affiliation is reported.
    expect(await clubProfile(db, 'mmakf-former-club')).toBeNull();
  });

  it('has NO page for a slug nobody set, and refuses a malformed one', async () => {
    expect(await clubProfile(db, 'mmakf-patratu-centre')).toBeNull();
    expect(await clubProfile(db, '../admin')).toBeNull();
    expect(await clubProfile(db, 'Not A Slug')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WHAT THE SITEMAP MAY ADVERTISE
// ═══════════════════════════════════════════════════════════════════════════

describe('publishable clubs', () => {
  it('advertises only affiliated clubs that carry a slug somebody set', async () => {
    // "DO NOT generate fake location pages. Only index real verified locations."
    const slugs = (await publishableClubs(db)).map((c) => c.slug);
    expect(slugs.sort()).toEqual(['mmakf-bokaro-dojo', 'mmakf-ramgarh-centre']);
    expect(slugs).not.toContain('mmakf-former-club');   // lapsed
    // And the affiliated club with no slug contributes no URL at all, rather
    // than one minted from its name that moves when the name is corrected.
    expect(slugs).toHaveLength(2);
  });

  it('agrees with clubProfile — every advertised URL resolves', async () => {
    // A sitemap that computes slugs its own way advertises URLs that 404. This
    // is the assertion that stops the two drifting.
    for (const club of await publishableClubs(db)) {
      expect(await clubProfile(db, club.slug), `/clubs/${club.slug}`).not.toBeNull();
    }
  });
});
