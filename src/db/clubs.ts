// Finding a club, and what a club's own page says.
//
// ═══════════════════════════════════════════════════════════════════════════
// TWO QUESTIONS, TWO SURFACES, ONE REGISTER
// ═══════════════════════════════════════════════════════════════════════════
//
// /dojos already answers a parent's question — *is the club my child trains at
// actually affiliated, today?* — and it answers it by listing lapsed units
// rather than hiding them, because the person most in need of that page is the
// parent of a child already training somewhere.
//
// This module answers the OTHER question: *where can my child train?* That is a
// search, not a register, and the difference shows in what each one refuses.
// The register lists a lapsed club and says so. The search DOES NOT OFFER ONE:
// sending a new family to a club whose charter expired, on the federation's own
// recommendation, is a different act from letting a existing family look their
// club up.
//
// Both read the same rows. Neither has a copy of the other's rules.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS MODULE WILL NOT DO
// ═══════════════════════════════════════════════════════════════════════════
//
// IT WILL NOT INVENT A LOCATION PAGE. The federation's instruction is explicit
// — "DO NOT generate fake location pages. Only index real verified locations."
// `publishableClubs()` returns only clubs that are currently affiliated AND
// carry a slug somebody set, and the sitemap expands exactly that list. A club
// with no slug is not published under one guessed from its name: a public URL
// that moves the next time somebody corrects a spelling is a link a parent had
// bookmarked.
//
// IT WILL NOT GUESS A DISTANCE. `nearbyClubs()` computes one only where the
// venue carries real coordinates. Everything else comes back with
// `distanceKm: null` and is ordered after the ones that do — an ordering that
// SAYS it is not by distance beats one that silently is not.
//
// IT WILL NOT PUBLISH A TIMETABLE THE CLUB HAS NOT PUBLISHED. `clubProfile()`
// returns `week.configured === false` when nothing is in force, and the page
// renders that as "this club has not published its timings — contact them",
// never as an empty week. A guessed timing sends somebody to a locked door,
// which is the one failure this whole area exists to prevent.

import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import * as ops from '@/db/operations.schema';
import * as sch from '@/db/scheduling.schema';
import {
  publishedWeek, todayIso, addDays,
  type PublishedWeek, type IsoDate,
} from '@/db/scheduling';

type DB = any;

// ─── Rows ───────────────────────────────────────────────────────────────────

export interface ClubSummary {
  id: number;
  code: string;
  slug: string | null;
  name: string;
  city: string | null;
  state: string | null;
  district: string | null;
  /** Currently affiliated. A search never offers anything else. */
  affiliated: boolean;
  standing: 'chartered' | 'provisional';
  charterValidUntil: string | null;
  timezone: string;
  /** Straight-line kilometres, or null when no coordinates are recorded. */
  distanceKm: number | null;
  /** Distinct audiences and levels its published classes serve. */
  audiences: string[];
  levels: string[];
  disciplines: string[];
  /** True when at least one active class is delivered online or hybrid. */
  online: boolean;
  classCount: number;
}

export interface ClubVenue {
  id: number;
  name: string;
  slug: string | null;
  kind: string;
  addressLine: string | null;
  city: string | null;
  postcode: string | null;
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  capacity: number | null;
  /** Absent means UNSURVEYED, never "no". See the note on venues.accessibility. */
  accessibility: Record<string, unknown> | null;
  facilities: unknown;
  parking: string | null;
  transport: string | null;
}

export interface ClubClass {
  id: number;
  slug: string;
  name: string;
  summary: string | null;
  discipline: string | null;
  level: string | null;
  audience: string | null;
  ageMin: number | null;
  ageMax: number | null;
  mode: string;
  capacity: number | null;
  requiresBooking: boolean;
  venueId: number | null;
}

export interface ClubProfile {
  club: ClubSummary;
  venues: ClubVenue[];
  classes: ClubClass[];
  /** The next seven days, resolved through the inheritance chain. */
  week: PublishedWeek;
  /** Named instructors with a live assignment here. Never a telephone number. */
  instructors: Array<{ personId: number; fullName: string; role: string | null }>;
}

// ─── Filters ────────────────────────────────────────────────────────────────

export interface ClubFilter {
  stateUnitId?: number | null;
  districtUnitId?: number | null;
  /** Matched case- and punctuation-insensitively; never fuzzily. */
  city?: string | null;
  /** kids | adults | women | competition | school | corporate | … */
  audience?: string | null;
  level?: string | null;
  discipline?: string | null;
  /** Only clubs with an online or hybrid class. */
  onlineOnly?: boolean;
  /** A child of this age must fall inside a published class's age range. */
  age?: number | null;
  limit?: number;
}

const norm = (v: unknown): string =>
  String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Currently-affiliated clubs, decorated with what their classes serve.
 *
 * 'active' and 'provisional' only. A lapsed, suspended or revoked unit is on
 * the register at /dojos with its standing stated in words, and is NOT a search
 * result — see the header note.
 */
export async function findClubs(db: DB, filter: ClubFilter = {}): Promise<ClubSummary[]> {
  const today = todayIso();
  const conds: any[] = [inArray(s.dojos.status, ['active', 'provisional'])];
  if (filter.stateUnitId) conds.push(eq(s.dojos.stateUnitId, filter.stateUnitId));
  if (filter.districtUnitId) conds.push(eq(s.dojos.districtUnitId, filter.districtUnitId));

  const rows = await db.select({
    id: s.dojos.id, code: s.dojos.code, slug: s.dojos.slug, name: s.dojos.name,
    city: s.dojos.city, status: s.dojos.status,
    charterExpires: s.dojos.affiliationExpiresOn,
    timezone: s.dojos.timezone,
    stateUnitId: s.dojos.stateUnitId, districtUnitId: s.dojos.districtUnitId,
  }).from(s.dojos).where(and(...conds)).orderBy(asc(s.dojos.name)).limit(filter.limit ?? 300);

  if (!rows.length) return [];

  const ids = rows.map((r: any) => r.id);
  const [states, districts, classes] = await Promise.all([
    db.select({ id: s.stateUnits.id, name: s.stateUnits.name }).from(s.stateUnits),
    db.select({ id: s.districtUnits.id, name: s.districtUnits.name }).from(s.districtUnits),
    db.select().from(sch.dojoClasses).where(and(
      eq(sch.dojoClasses.ownerScope, 'dojo'),
      inArray(sch.dojoClasses.ownerId, ids),
      eq(sch.dojoClasses.status, 'active'),
      eq(sch.dojoClasses.publicVisible, true)
    )),
  ]);
  const stateName = new Map(states.map((x: any) => [x.id, x.name]));
  const districtName = new Map(districts.map((x: any) => [x.id, x.name]));

  const byClub = new Map<number, any[]>();
  for (const c of classes) {
    const list = byClub.get(c.ownerId) ?? [];
    list.push(c);
    byClub.set(c.ownerId, list);
  }

  let out: ClubSummary[] = rows.map((r: any) => {
    const own = byClub.get(r.id) ?? [];
    const uniq = (key: string) => [...new Set(own.map((c: any) => c[key]).filter(Boolean))] as string[];
    return {
      id: r.id, code: r.code, slug: r.slug ?? null, name: r.name,
      city: r.city ?? null,
      state: r.stateUnitId ? (stateName.get(r.stateUnitId) ?? null) : null,
      district: r.districtUnitId ? (districtName.get(r.districtUnitId) ?? null) : null,
      // Charter dates are what the register holds; an expiry in the past is
      // reported rather than filtered, because the status column is what says
      // whether the federation has acted on it.
      affiliated: true,
      standing: r.status === 'provisional' ? 'provisional' : 'chartered',
      charterValidUntil: r.charterExpires ?? null,
      timezone: r.timezone ?? 'Asia/Kolkata',
      distanceKm: null,
      audiences: uniq('audience'),
      levels: uniq('level'),
      disciplines: uniq('discipline'),
      online: own.some((c: any) => c.mode === 'online' || c.mode === 'hybrid'),
      classCount: own.length,
    };
  });

  // Class-derived filters are applied here rather than in SQL because they ask
  // about the SET of a club's classes, and a join would drop a club that has
  // one matching class among several rather than keeping it.
  if (filter.city) {
    const want = norm(filter.city);
    out = out.filter((c) => norm(c.city) === want);
  }
  if (filter.audience) {
    const want = norm(filter.audience);
    out = out.filter((c) => c.audiences.some((a) => norm(a) === want));
  }
  if (filter.level) {
    const want = norm(filter.level);
    out = out.filter((c) => c.levels.some((l) => norm(l) === want));
  }
  if (filter.discipline) {
    const want = norm(filter.discipline);
    out = out.filter((c) => c.disciplines.some((d) => norm(d) === want));
  }
  if (filter.onlineOnly) out = out.filter((c) => c.online);
  if (filter.age != null) {
    const age = filter.age;
    out = out.filter((c) => (byClub.get(c.id) ?? []).some((k: any) =>
      (k.ageMin == null || age >= k.ageMin) && (k.ageMax == null || age <= k.ageMax)
    ));
  }
  return out;
}

// ─── Distance ───────────────────────────────────────────────────────────────

const EARTH_KM = 6371;
const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Great-circle distance in kilometres.
 *
 * Straight-line, and the surfaces say so. A road distance needs a routing
 * service this project does not have, and presenting a straight line AS a road
 * distance would tell a parent a forty-minute journey is twelve minutes.
 */
export function haversineKm(
  a: { lat: number; lon: number }, b: { lat: number; lon: number }
): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface NearbyOrigin {
  latitude?: number | null;
  longitude?: number | null;
  /** An Indian PIN code, resolved through `postal_codes` when coordinates are absent. */
  postalCode?: string | null;
  city?: string | null;
}

/**
 * Clubs, nearest first where a distance can be computed at all.
 *
 * THE ORDERING IS HONEST ABOUT ITSELF. Clubs whose venue carries coordinates
 * are ordered by distance; every other club follows, alphabetically, with
 * `distanceKm: null`. A list that silently mixed the two would present an
 * arbitrary order as a proximity ranking, and the reader would drive to the top
 * one.
 *
 * LOCATION IS NEVER TAKEN WITHOUT BEING GIVEN. This function receives an
 * origin; it does not read one. The page asks for consent, or accepts a PIN
 * code, a city or nothing at all — which returns the same list unordered by
 * distance rather than an error.
 */
export async function nearbyClubs(
  db: DB, origin: NearbyOrigin, filter: ClubFilter = {}
): Promise<ClubSummary[]> {
  const clubs = await findClubs(db, filter);
  if (!clubs.length) return clubs;

  let from: { lat: number; lon: number } | null = null;
  if (origin.latitude != null && origin.longitude != null) {
    from = { lat: Number(origin.latitude), lon: Number(origin.longitude) };
  }

  // A PIN CODE IS NOT A COORDINATE, and this does not pretend it is.
  //
  // `postal_codes` maps a code to an ADMINISTRATIVE AREA — it carries no
  // latitude and no longitude, because the register is a map of places and not
  // a gazetteer of points. So a PIN code produces an AREA MATCH: clubs whose
  // venue sits in that area come first, in name order, with `distanceKm: null`.
  // Manufacturing a coordinate for the centre of a postal district and then
  // publishing "3.4 km" from it would be a measurement nobody took.
  let areaIds: number[] = [];
  if (!from && origin.postalCode) {
    const code = String(origin.postalCode).replace(/\s+/g, '').toUpperCase();
    const rows = await db.select({ areaId: s.postalCodes.areaId })
      .from(s.postalCodes).where(eq(s.postalCodes.code, code));
    areaIds = rows.map((r: any) => r.areaId).filter(Boolean);
  }

  if (!from) {
    if (areaIds.length) {
      const venuesInArea = await db.select({ dojoId: ops.venues.dojoId })
        .from(ops.venues).where(and(
          inArray(ops.venues.areaId, areaIds),
          eq(ops.venues.active, true)
        ));
      const local = new Set(venuesInArea.map((v: any) => v.dojoId).filter(Boolean));
      if (local.size) {
        return [...clubs.filter((c) => local.has(c.id)), ...clubs.filter((c) => !local.has(c.id))];
      }
      // A PIN code we know, with no club recorded in it. The list is returned
      // whole and unreordered rather than empty: "no club in your postal
      // district" and "no clubs at all" are different answers, and the second
      // one is false.
      return clubs;
    }
    if (origin.city) {
      const want = norm(origin.city);
      return [...clubs.filter((c) => norm(c.city) === want), ...clubs.filter((c) => norm(c.city) !== want)];
    }
    return clubs;
  }

  const venues = await db.select({
    dojoId: ops.venues.dojoId,
    latitude: ops.venues.latitude,
    longitude: ops.venues.longitude,
  }).from(ops.venues).where(and(
    inArray(ops.venues.dojoId, clubs.map((c) => c.id)),
    eq(ops.venues.active, true)
  ));

  const nearestByClub = new Map<number, number>();
  for (const v of venues) {
    if (v.dojoId == null || v.latitude == null || v.longitude == null) continue;
    const km = haversineKm(from, { lat: Number(v.latitude), lon: Number(v.longitude) });
    const best = nearestByClub.get(v.dojoId);
    if (best == null || km < best) nearestByClub.set(v.dojoId, km);
  }

  const withDistance = clubs
    .map((c) => ({ ...c, distanceKm: nearestByClub.has(c.id) ? Math.round(nearestByClub.get(c.id)! * 10) / 10 : null }))
    .filter((c) => c.distanceKm != null)
    .sort((a, b) => (a.distanceKm as number) - (b.distanceKm as number));
  const without = clubs
    .filter((c) => !nearestByClub.has(c.id))
    .map((c) => ({ ...c, distanceKm: null }));

  return [...withDistance, ...without];
}

// ─── One club ───────────────────────────────────────────────────────────────

/**
 * A club's public page, by slug.
 *
 * Returns null for a slug nobody set, for a club that never reached at least
 * provisional affiliation, and for one whose affiliation has ended. The last is
 * the one worth stating: a former club's page is NOT quietly rewritten to say
 * it is affiliated, and it is not left up either — the register at /dojos is
 * where a former affiliation is reported, in words, with its standing.
 */
export async function clubProfile(db: DB, slug: string): Promise<ClubProfile | null> {
  const clean = String(slug ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean)) return null;

  const [dojo] = await db.select().from(s.dojos).where(eq(s.dojos.slug, clean)).limit(1);
  if (!dojo) return null;
  if (!['active', 'provisional'].includes(dojo.status)) return null;

  const [states, districts, venueRows, classRows] = await Promise.all([
    db.select({ id: s.stateUnits.id, name: s.stateUnits.name }).from(s.stateUnits)
      .where(dojo.stateUnitId ? eq(s.stateUnits.id, dojo.stateUnitId) : sql`false`),
    db.select({ id: s.districtUnits.id, name: s.districtUnits.name }).from(s.districtUnits)
      .where(dojo.districtUnitId ? eq(s.districtUnits.id, dojo.districtUnitId) : sql`false`),
    db.select().from(ops.venues).where(and(eq(ops.venues.dojoId, dojo.id), eq(ops.venues.active, true)))
      .orderBy(asc(ops.venues.name)),
    db.select().from(sch.dojoClasses).where(and(
      eq(sch.dojoClasses.ownerScope, 'dojo'),
      eq(sch.dojoClasses.ownerId, dojo.id),
      eq(sch.dojoClasses.status, 'active'),
      eq(sch.dojoClasses.publicVisible, true)
    )).orderBy(asc(sch.dojoClasses.name)),
  ]);

  const from = todayIso();
  const week = await publishedWeek(db, { dojoId: dojo.id }, from, addDays(from, 6));

  // Named instructors, and NOTHING ELSE ABOUT THEM. A club page publishes who
  // teaches; it does not publish a telephone number, an email address or a date
  // of birth, and this select is the reason it cannot start to.
  //
  // AND ONLY PEOPLE WHO ACTUALLY HOLD AN INSTRUCTOR CREDENTIAL. The join is an
  // INNER join on `instructor_quals` deliberately: `persons.dojoId` is where a
  // member is placed, so a left join here would publish the name of every
  // student at the club — including every child — under the heading
  // "instructors". That is the single worst thing a club page could do.
  const instructors = await db.select({
    personId: s.persons.id,
    fullName: s.persons.fullName,
    role: s.instructorQuals.level,
  }).from(s.persons)
    .innerJoin(s.instructorQuals, and(
      eq(s.instructorQuals.personId, s.persons.id),
      eq(s.instructorQuals.status, 'active')
    ))
    .where(and(eq(s.persons.dojoId, dojo.id), eq(s.persons.status, 'active')))
    .orderBy(asc(s.persons.fullName))
    .limit(40);

  const uniq = (key: string) => [...new Set(classRows.map((c: any) => c[key]).filter(Boolean))] as string[];

  return {
    club: {
      id: dojo.id, code: dojo.code, slug: dojo.slug, name: dojo.name,
      city: dojo.city ?? null,
      state: states[0]?.name ?? null,
      district: districts[0]?.name ?? null,
      affiliated: true,
      standing: dojo.status === 'provisional' ? 'provisional' : 'chartered',
      charterValidUntil: dojo.affiliationExpiresOn ?? null,
      timezone: dojo.timezone ?? 'Asia/Kolkata',
      distanceKm: null,
      audiences: uniq('audience'),
      levels: uniq('level'),
      disciplines: uniq('discipline'),
      online: classRows.some((c: any) => c.mode === 'online' || c.mode === 'hybrid'),
      classCount: classRows.length,
    },
    venues: venueRows.map((v: any) => ({
      id: v.id, name: v.name, slug: v.slug ?? null, kind: v.kind,
      addressLine: v.addressLine ?? null, city: v.city ?? null, postcode: v.postcode ?? null,
      latitude: v.latitude == null ? null : Number(v.latitude),
      longitude: v.longitude == null ? null : Number(v.longitude),
      timezone: v.timezone ?? 'Asia/Kolkata',
      capacity: v.capacity ?? null,
      accessibility: v.accessibility ?? null,
      facilities: v.facilities ?? null,
      parking: v.parking ?? null,
      transport: v.transport ?? null,
    })),
    classes: classRows.map((c: any) => ({
      id: c.id, slug: c.slug, name: c.name, summary: c.summary ?? null,
      discipline: c.discipline ?? null, level: c.level ?? null, audience: c.audience ?? null,
      ageMin: c.ageMin ?? null, ageMax: c.ageMax ?? null,
      mode: c.mode, capacity: c.capacity ?? null,
      requiresBooking: c.requiresBooking, venueId: c.venueId ?? null,
    })),
    week,
    instructors: instructors
      .filter((r: any, i: number, all: any[]) => all.findIndex((x) => x.personId === r.personId) === i)
      .map((r: any) => ({ personId: r.personId, fullName: r.fullName, role: r.role ?? null })),
  };
}

/**
 * The slugs the sitemap may expand — and no others.
 *
 * "Only index real verified locations." A club is here when it is currently
 * affiliated AND somebody set a slug for it. Both halves matter: the first
 * stops a lapsed club being advertised as the federation's recommendation, and
 * the second stops a URL being minted from a name that will change.
 */
export async function publishableClubs(db: DB): Promise<Array<{ slug: string; name: string; city: string | null }>> {
  const rows = await db.select({ slug: s.dojos.slug, name: s.dojos.name, city: s.dojos.city })
    .from(s.dojos)
    .where(and(inArray(s.dojos.status, ['active', 'provisional']), sql`${s.dojos.slug} is not null`))
    .orderBy(asc(s.dojos.name));
  return rows.map((r: any) => ({ slug: r.slug as string, name: r.name, city: r.city ?? null }));
}
