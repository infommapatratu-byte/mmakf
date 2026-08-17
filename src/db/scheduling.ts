// The federation scheduling engine.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE ONE RULE
// ═══════════════════════════════════════════════════════════════════════════
//
// MMAKF HQ's schedule is not every club's schedule. It never was, and until
// this module existed the site said otherwise: /schedule rendered the hombu
// dojo's hours under the heading "The weekly timetable" and /facilities printed
// them beside the words "Open seven days". Every affiliated club in the country
// was represented, on the federation's own site, as training at six in the
// morning because that is when Patratu does.
//
// So the contract of this module is narrow and absolute: NOTHING HERE KNOWS
// WHAT TIME ANYTHING OPENS. There is no default hour, no fallback timetable, no
// "if the club has not configured anything, assume the federation's". A club
// with nothing configured INHERITS — visibly, with the level it inherited from
// named in the result so the page can say so — and a club that has configured
// something OVERRIDES, and the federation's row is not touched either way.
//
// Search this file for a time literal and you will find none. That is the test.
//
// ═══════════════════════════════════════════════════════════════════════════
// HOW A DAY IS RESOLVED, IN ORDER
// ═══════════════════════════════════════════════════════════════════════════
//
//   1. FIND THE SCHEDULE. Walk from the most specific level to the least —
//      this room → this club → this district → this state → the federation —
//      and stop at the first level that has a schedule for the purpose asked
//      about WITH A VERSION IN FORCE on the date asked about. A schedule that
//      exists but has published nothing does not stop the walk; it delegates,
//      which is what makes "we created the club last week and have not filled
//      in its hours yet" render the federation's default rather than a blank.
//
//   2. FIND THE VERSION. The one whose effective window contains the date.
//      Versions are effective-dated and superseded, never edited, so a March
//      attendance record renders against March's timetable — see
//      `openingHoursOn(..., { asOf })`.
//
//   3. FIND THE SEASON. Seasons are rows with dates somebody chose. If any
//      season-scoped rule matches the date's day-of-week, THE SEASON-SCOPED
//      RULES WIN and the all-year rules for that day are ignored. That is
//      specificity, not union: a club with an all-year Sunday and a summer
//      Sunday means "and in summer, this instead", never "both at once".
//
//   4. APPLY THE EXCEPTIONS. A `closed` exception shuts the day whatever the
//      rules say. Otherwise `replace` supplants the day's windows, `add` unions
//      and `remove` subtracts, in that order — so "closed all day except
//      06:00–08:00" is one replace, and "open as usual but the hall is out for
//      two hours" is one remove.
//
//   5. SUBTRACT THE BLACKOUTS. `venue_blackouts` is the room being physically
//      unavailable. It is subtracted last because a maintenance order beats an
//      administrator's optimism.
//
// Every one of those five steps is data. None of them is code that knows about
// Sunday.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS MODULE REFUSES TO DECIDE
// ═══════════════════════════════════════════════════════════════════════════
//
// Following src/db/booking.ts, which says the same thing about its own domain:
// session length, notice period, cancellation window and how far ahead booking
// opens are FEDERATION POLICY and MMAKF has set none of them. Nothing here
// invents one. `generateSessions()` requires an explicit horizon; there is no
// default of "the next eight weeks". A plausible default would read as though
// the federation had made a rule it has not made.
//
// It also refuses to decide what "summer" means. `seasons` is a table.
//
// ═══════════════════════════════════════════════════════════════════════════
// PRIVACY
// ═══════════════════════════════════════════════════════════════════════════
//
// `schedule_exceptions.reason` is free text an administrator typed, and the
// honest reasons are the sensitive ones — a bereavement, a police enquiry, a
// safeguarding review. `publicTimetable()` returns the fact of a closure and
// the KIND ('holiday', 'maintenance'), never the reason, and says the reason
// was withheld rather than rendering an empty field that reads as "no reason
// given". The same rule src/db/booking.ts applies to a coach's availability.

import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import * as ops from '@/db/operations.schema';
import * as sch from '@/db/scheduling.schema';
import { allocateFederationId, writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, can, type Principal, type Resource } from '@/lib/rbac';

type DB = any;

// ─── Errors ─────────────────────────────────────────────────────────────────

export class SchedulingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SchedulingError';
    this.code = code;
  }
}

/** See booking.ts for why identity is checked by shape and not `instanceof`. */
export function isSchedulingError(err: unknown): err is SchedulingError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'SchedulingError';
}

// ═══════════════════════════════════════════════════════════════════════════
// TIME
// ═══════════════════════════════════════════════════════════════════════════
//
// src/db/booking.ts fixes IST as +05:30 and says why: India has one civil
// timezone and has observed no daylight saving since 1945, so the offset is
// EXACT rather than approximate. That remains true and that module is not
// changed.
//
// This module cannot make the same assumption, because the directive is
// explicit that the data model must not assume IST forever — a venue carries an
// IANA timezone and a schedule carries one too. So conversion here goes through
// Intl, which is in the platform and needs no dependency, and it is written to
// survive a zone that DOES observe daylight saving even though none of MMAKF's
// do today. The two-pass offset resolution below is what makes that true.

export type IsoDate = string;   // YYYY-MM-DD
export type Wall = string;      // HH:MM, 24 hour, wall clock in some timezone

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export const DAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function assertIsoDate(value: unknown, label = 'date'): IsoDate {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new SchedulingError('bad_date', `Expected ${label} as an ISO date (YYYY-MM-DD); received ${JSON.stringify(value)}.`);
  }
  if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new SchedulingError('bad_date', `${value} is not a real date.`);
  }
  return value;
}

export function assertWall(value: unknown, label = 'time'): Wall {
  if (typeof value !== 'string' || !HHMM.test(value)) {
    throw new SchedulingError('bad_time', `Expected ${label} as a 24-hour time (HH:MM); received ${JSON.stringify(value)}.`);
  }
  return value;
}

/**
 * An IANA timezone the platform actually knows.
 *
 * Validated rather than trusted: an unknown zone makes every instant this
 * module produces wrong by an unknown amount, and it would do so silently
 * because `Intl` throws only when you ask it to format.
 */
export function assertTimezone(tz: unknown): string {
  if (typeof tz !== 'string' || !tz.trim()) {
    throw new SchedulingError('bad_timezone', 'A schedule needs an IANA timezone.');
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
  } catch {
    throw new SchedulingError('bad_timezone', `${JSON.stringify(tz)} is not a timezone this system knows. Use an IANA name such as Asia/Kolkata.`);
  }
  return tz;
}

/** The zone's offset from UTC, in milliseconds, AT a given instant. */
function offsetMsAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const at: Record<string, string> = {};
  for (const p of parts) at[p.type] = p.value;
  const asIfUtc = Date.UTC(
    Number(at.year), Number(at.month) - 1, Number(at.day),
    // Some ICU builds render midnight as hour 24. Modulo rather than a special
    // case, because the bug it prevents is a whole day out and shows up once.
    Number(at.hour) % 24, Number(at.minute), Number(at.second)
  );
  return asIfUtc - instant.getTime();
}

/**
 * The instant a wall-clock time on a calendar day begins, in a named zone.
 *
 * THIS IS THE FUNCTION THAT STOPS TUESDAY BECOMING MONDAY — the same trap
 * src/db/booking.ts documents at length. `new Date('2026-09-15T06:00')` is
 * parsed in the SERVER's zone, which on a Vercel function is UTC, so a 06:00
 * class in Patratu would be stored as 11:30 and a member would be told to
 * arrive at a dojo that opened five and a half hours earlier.
 *
 * Two passes: guess the offset using the naive instant, then re-read it at the
 * corrected instant. One pass is wrong for the hour either side of a daylight
 * transition. India has none; a zone MMAKF adds later might.
 */
export function zonedInstant(dayIso: IsoDate, timeHHMM: Wall, timeZone: string): Date {
  assertIsoDate(dayIso);
  assertWall(timeHHMM);
  assertTimezone(timeZone);
  const [y, m, d] = dayIso.split('-').map(Number);
  const [hh, mm] = timeHHMM.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  const firstPass = naive - offsetMsAt(new Date(naive), timeZone);
  const settled = naive - offsetMsAt(new Date(firstPass), timeZone);
  return new Date(settled);
}

/** The calendar day an instant falls on, in a named zone. The inverse of the above. */
export function zonedDay(at: Date | string, timeZone: string): IsoDate {
  const instant = at instanceof Date ? at : new Date(at);
  assertTimezone(timeZone);
  return new Date(instant.getTime() + offsetMsAt(instant, timeZone)).toISOString().slice(0, 10);
}

/** The wall-clock time of an instant, in a named zone, as HH:MM. */
export function zonedTime(at: Date | string, timeZone: string): Wall {
  const instant = at instanceof Date ? at : new Date(at);
  assertTimezone(timeZone);
  return new Date(instant.getTime() + offsetMsAt(instant, timeZone)).toISOString().slice(11, 16);
}

/**
 * ISO-8601 day of week: 1 = Monday … 7 = Sunday.
 *
 * A calendar date's day-of-week is the same in every timezone, so this needs no
 * zone. The conversion from JavaScript's 0-is-Sunday happens HERE and nowhere
 * else — every `day_of_week` in the database is ISO, and mixing the two
 * conventions is the defect this single function exists to make impossible.
 */
export function isoDayOfWeek(dayIso: IsoDate): number {
  assertIsoDate(dayIso);
  const jsDay = new Date(`${dayIso}T00:00:00Z`).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

/** `n` days after an ISO date, as an ISO date. Calendar arithmetic, no zone. */
export function addDays(dayIso: IsoDate, n: number): IsoDate {
  assertIsoDate(dayIso);
  return new Date(Date.parse(`${dayIso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Every ISO date from `from` to `to`, INCLUSIVE of both ends. */
export function daysBetween(fromIso: IsoDate, toIso: IsoDate): IsoDate[] {
  assertIsoDate(fromIso, 'from');
  assertIsoDate(toIso, 'to');
  if (toIso < fromIso) {
    throw new SchedulingError('bad_range', `The window ${fromIso}..${toIso} ends before it starts.`);
  }
  const out: IsoDate[] = [];
  for (let d = fromIso; d <= toIso; d = addDays(d, 1)) {
    out.push(d);
    if (out.length > 3_660) {
      throw new SchedulingError('range_too_long', 'A schedule window longer than ten years is almost certainly a mistake.');
    }
  }
  return out;
}

// ─── Window algebra, in minutes past local midnight ─────────────────────────
//
// Minutes rather than instants, because these are wall-clock facts about a day
// and converting each one to an instant before comparing it to another would
// make the arithmetic depend on a timezone that cannot change the answer.

const toMin = (w: Wall): number => {
  const [h, m] = assertWall(w).split(':').map(Number);
  return h * 60 + m;
};
const toWall = (min: number): Wall =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export interface TimeWindow {
  opensAt: Wall;
  closesAt: Wall;
  /** What the timetable calls this window — 'Morning batch', 'Session 2'. */
  label?: string | null;
  /** Where it came from, so a surface can explain itself. */
  source: 'rule' | 'exception';
  /** For an exception window: which kind of day this is. */
  exceptionKind?: string | null;
  seasonId?: number | null;
  seasonName?: string | null;
}

type Span = { s: number; e: number };
const spanOf = (w: TimeWindow): Span => ({ s: toMin(w.opensAt), e: toMin(w.closesAt) });

/** Half-open: 10:00–11:00 and 11:00–12:00 do not overlap. */
function spansOverlap(a: Span, b: Span): boolean {
  return a.s < b.e && b.s < a.e;
}

function mergeSpans(list: Span[]): Span[] {
  const sorted = list.filter((x) => x.e > x.s).sort((a, b) => a.s - b.s);
  const out: Span[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last && x.s <= last.e) last.e = Math.max(last.e, x.e);
    else out.push({ ...x });
  }
  return out;
}

function subtractSpans(base: Span[], cut: Span[]): Span[] {
  const cuts = mergeSpans(cut);
  let pieces = mergeSpans(base);
  for (const c of cuts) {
    const next: Span[] = [];
    for (const p of pieces) {
      if (!spansOverlap(p, c)) { next.push(p); continue; }
      if (p.s < c.s) next.push({ s: p.s, e: c.s });
      if (c.e < p.e) next.push({ s: c.e, e: p.e });
    }
    pieces = next;
  }
  return pieces;
}

/** Everything in `a` that is also in `b`. */
function intersectSpans(a: Span[], b: Span[]): Span[] {
  const out: Span[] = [];
  for (const x of mergeSpans(a)) {
    for (const y of mergeSpans(b)) {
      const s = Math.max(x.s, y.s);
      const e = Math.min(x.e, y.e);
      if (e > s) out.push({ s, e });
    }
  }
  return mergeSpans(out);
}

/**
 * The union of a day's windows, with labels discarded.
 *
 * Labels are kept on the window list a timetable renders and dropped here,
 * where the question is only "is the mat available at 18:40" — merging two
 * labelled sessions would have to invent a name for the result.
 */
export function mergedMinutes(windows: TimeWindow[]): Array<{ opensAt: Wall; closesAt: Wall }> {
  return mergeSpans(windows.map(spanOf)).map((x) => ({ opensAt: toWall(x.s), closesAt: toWall(x.e) }));
}

/** Is `[from,to)` wholly inside the day's open time? */
export function windowContains(windows: TimeWindow[], from: Wall, to: Wall): boolean {
  const want: Span = { s: toMin(from), e: toMin(to) };
  if (want.e <= want.s) return false;
  return mergeSpans(windows.map(spanOf)).some((open) => open.s <= want.s && want.e <= open.e);
}

// ═══════════════════════════════════════════════════════════════════════════
// OWNERSHIP AND AUTHORITY
// ═══════════════════════════════════════════════════════════════════════════

export type OwnerScope = 'national' | 'state' | 'district' | 'dojo' | 'institution';
export type SchedulePurpose = 'operating' | 'training' | 'office' | 'administrative' | 'class';

export interface ScheduleOwner {
  scope: OwnerScope;
  /** Null exactly when scope is 'national'. Enforced by CHECK in migration 0032. */
  id?: number | null;
}

export function normaliseOwner(owner: ScheduleOwner): { scope: OwnerScope; id: number | null } {
  const scope = owner?.scope;
  if (!['national', 'state', 'district', 'dojo', 'institution'].includes(scope as string)) {
    throw new SchedulingError('bad_owner', `Unknown schedule owner scope ${JSON.stringify(scope)}.`);
  }
  const id = owner.id ?? null;
  if (scope === 'national' && id !== null) {
    throw new SchedulingError('bad_owner', 'The national federation is the one level with no row of its own; owner id must be null.');
  }
  if (scope !== 'national' && (id === null || !Number.isInteger(id))) {
    throw new SchedulingError('bad_owner', `A ${scope}-scoped schedule must name which ${scope} it belongs to.`);
  }
  return { scope, id };
}

/**
 * Where an owner sits in the federation, as RBAC understands it.
 *
 * A dojo-owned schedule is reachable by its own administrator AND by the state
 * and district above it, which is only true if the resource carries all three
 * ids. Resolving them here rather than passing `{ dojoId }` alone is what stops
 * a state administrator being locked out of a club in their own state.
 */
export async function resourceForOwner(db: DB, owner: ScheduleOwner): Promise<Resource> {
  const { scope, id } = normaliseOwner(owner);
  switch (scope) {
    case 'national':
      return {};
    case 'state':
      return { stateUnitId: id };
    case 'district': {
      const rows = await db.select({ stateUnitId: s.districtUnits.stateUnitId })
        .from(s.districtUnits).where(eq(s.districtUnits.id, id as number)).limit(1);
      return { districtUnitId: id, stateUnitId: rows[0]?.stateUnitId ?? null };
    }
    case 'dojo': {
      const rows = await db.select({
        stateUnitId: s.dojos.stateUnitId, districtUnitId: s.dojos.districtUnitId,
      }).from(s.dojos).where(eq(s.dojos.id, id as number)).limit(1);
      if (!rows.length) throw new SchedulingError('not_found', `No dojo ${id}.`);
      return { dojoId: id, stateUnitId: rows[0].stateUnitId ?? null, districtUnitId: rows[0].districtUnitId ?? null };
    }
    case 'institution':
      return { institutionId: id };
    default:
      return {};
  }
}

async function assertMayWriteSchedule(db: DB, principal: Principal, owner: ScheduleOwner): Promise<void> {
  assertCan(principal, 'schedule:write', await resourceForOwner(db, owner));
}

/**
 * The caller's OWN person id, from their own user row.
 *
 * Never from the request — the same rule, and the same reason, as the private
 * helper of the same name in src/db/booking.ts: it is what makes "booking for
 * yourself" a claim this module can check rather than one the caller asserts.
 * Duplicated rather than exported from there because a booking-engine internal
 * becoming public API is a wider change than this wave should make, and the
 * function is four lines with no policy in it.
 */
async function ownPersonId(db: DB, principal: Principal | null | undefined): Promise<number | null> {
  if (!principal || principal.userId == null) return null;
  const row = (
    await db.select({ personId: s.users.personId }).from(s.users)
      .where(eq(s.users.id, principal.userId)).limit(1)
  )[0];
  return row?.personId ?? null;
}

// ═══════════════════════════════════════════════════════════════════════════
// SEASONS
// ═══════════════════════════════════════════════════════════════════════════

export interface SeasonInput {
  code: string;
  name: string;
  owner: ScheduleOwner;
  startsOn: IsoDate;
  endsOn: IsoDate;
  inheritable?: boolean;
  notes?: string | null;
  activate?: boolean;
}

export interface SeasonRecord {
  id: number;
  code: string;
  name: string;
  ownerScope: OwnerScope;
  ownerId: number | null;
  startsOn: IsoDate;
  endsOn: IsoDate;
  status: 'draft' | 'active' | 'archived';
  inheritable: boolean;
}

/**
 * Define a season, or refuse to.
 *
 * TWO ACTIVE SEASONS MAY NOT OVERLAP FOR ONE OWNER. If they did, a date would
 * fall in both and the rules for the day would be the union of two timetables
 * that were each written as "instead of the other". The refusal names the
 * season it collided with, because the administrator's next question is always
 * "which one?".
 */
export async function defineSeason(db: DB, ctx: AuditContext, input: SeasonInput): Promise<SeasonRecord> {
  const owner = normaliseOwner(input.owner);
  await assertMayWriteSchedule(db, ctx.principal, owner);

  const code = (input.code ?? '').trim();
  const name = (input.name ?? '').trim();
  if (!code) throw new SchedulingError('code_required', 'A season needs a code, e.g. summer-2026.');
  if (!name) throw new SchedulingError('name_required', 'A season needs a name somebody will recognise.');
  const startsOn = assertIsoDate(input.startsOn, 'startsOn');
  const endsOn = assertIsoDate(input.endsOn, 'endsOn');
  if (endsOn < startsOn) {
    throw new SchedulingError('bad_range', `${name} ends (${endsOn}) before it starts (${startsOn}).`);
  }

  const status = input.activate ? 'active' : 'draft';
  if (status === 'active') {
    const clash = await overlappingSeason(db, owner, startsOn, endsOn, null);
    if (clash) {
      throw new SchedulingError(
        'season_overlap',
        `${name} (${startsOn}..${endsOn}) overlaps ${clash.name} (${clash.startsOn}..${clash.endsOn}). ` +
        'Two active seasons for one owner cannot cover the same date — a rule bound to one of them would be ambiguous.'
      );
    }
  }

  const rows = await db.insert(sch.seasons).values({
    code, name,
    ownerScope: owner.scope as any,
    ownerId: owner.id,
    startsOn, endsOn, status,
    inheritable: input.inheritable ?? true,
    notes: input.notes ?? null,
    createdByUserId: ctx.principal.userId ?? null,
  }).returning();

  const row = rows[0];
  await writeAudit(db, ctx, {
    entityType: 'season', entityId: row.id, action: 'create',
    newValue: { code, name, ownerScope: owner.scope, ownerId: owner.id, startsOn, endsOn, status },
  });
  return toSeason(row);
}

async function overlappingSeason(
  db: DB, owner: { scope: OwnerScope; id: number | null },
  startsOn: IsoDate, endsOn: IsoDate, exceptId: number | null
): Promise<SeasonRecord | null> {
  const rows = await db.select().from(sch.seasons).where(and(
    eq(sch.seasons.ownerScope, owner.scope as any),
    owner.id === null ? isNull(sch.seasons.ownerId) : eq(sch.seasons.ownerId, owner.id),
    eq(sch.seasons.status, 'active'),
    // Inclusive ends: a season running to 30 September contains 30 September.
    lte(sch.seasons.startsOn, endsOn),
    gte(sch.seasons.endsOn, startsOn)
  ));
  const clash = rows.find((r: any) => r.id !== exceptId);
  return clash ? toSeason(clash) : null;
}

/** Bring a drafted season into force, refusing an overlap at the last moment too. */
export async function activateSeason(db: DB, ctx: AuditContext, seasonId: number): Promise<SeasonRecord> {
  const rows = await db.select().from(sch.seasons).where(eq(sch.seasons.id, seasonId)).limit(1);
  if (!rows.length) throw new SchedulingError('not_found', `No season ${seasonId}.`);
  const season = rows[0];
  const owner = { scope: season.ownerScope as OwnerScope, id: season.ownerId ?? null };
  await assertMayWriteSchedule(db, ctx.principal, owner);

  const clash = await overlappingSeason(db, owner, season.startsOn, season.endsOn, seasonId);
  if (clash) {
    throw new SchedulingError('season_overlap', `${season.name} overlaps the active season ${clash.name} (${clash.startsOn}..${clash.endsOn}).`);
  }
  const updated = await db.update(sch.seasons)
    .set({ status: 'active', updatedAt: new Date() })
    .where(eq(sch.seasons.id, seasonId)).returning();
  await writeAudit(db, ctx, {
    entityType: 'season', entityId: seasonId, action: 'update',
    oldValue: { status: season.status }, newValue: { status: 'active' },
  });
  return toSeason(updated[0]);
}

/**
 * Move a season's dates.
 *
 * THE CHANGEOVER DATE IS ADMINISTRATION, NOT A DEPLOY. This function is the
 * whole answer to "the exact dates must be configurable by authorized
 * administration": summer starting a fortnight earlier this year is one UPDATE
 * and an audit row, and every rule bound to that season follows it.
 */
export async function moveSeason(
  db: DB, ctx: AuditContext, seasonId: number,
  window: { startsOn: IsoDate; endsOn: IsoDate }
): Promise<SeasonRecord> {
  const rows = await db.select().from(sch.seasons).where(eq(sch.seasons.id, seasonId)).limit(1);
  if (!rows.length) throw new SchedulingError('not_found', `No season ${seasonId}.`);
  const season = rows[0];
  const owner = { scope: season.ownerScope as OwnerScope, id: season.ownerId ?? null };
  await assertMayWriteSchedule(db, ctx.principal, owner);

  const startsOn = assertIsoDate(window.startsOn, 'startsOn');
  const endsOn = assertIsoDate(window.endsOn, 'endsOn');
  if (endsOn < startsOn) throw new SchedulingError('bad_range', `${startsOn}..${endsOn} ends before it starts.`);

  if (season.status === 'active') {
    const clash = await overlappingSeason(db, owner, startsOn, endsOn, seasonId);
    if (clash) {
      throw new SchedulingError('season_overlap', `Moving ${season.name} to ${startsOn}..${endsOn} would overlap ${clash.name}.`);
    }
  }
  const updated = await db.update(sch.seasons)
    .set({ startsOn, endsOn, updatedAt: new Date() })
    .where(eq(sch.seasons.id, seasonId)).returning();
  await writeAudit(db, ctx, {
    entityType: 'season', entityId: seasonId, action: 'update',
    oldValue: { startsOn: season.startsOn, endsOn: season.endsOn },
    newValue: { startsOn, endsOn },
  });
  return toSeason(updated[0]);
}

function toSeason(row: any): SeasonRecord {
  return {
    id: row.id, code: row.code, name: row.name,
    ownerScope: row.ownerScope, ownerId: row.ownerId ?? null,
    startsOn: row.startsOn, endsOn: row.endsOn,
    status: row.status, inheritable: row.inheritable,
  };
}

export async function listSeasons(db: DB, owner: ScheduleOwner): Promise<SeasonRecord[]> {
  const o = normaliseOwner(owner);
  const rows = await db.select().from(sch.seasons).where(and(
    eq(sch.seasons.ownerScope, o.scope as any),
    o.id === null ? isNull(sch.seasons.ownerId) : eq(sch.seasons.ownerId, o.id)
  )).orderBy(asc(sch.seasons.startsOn));
  return rows.map(toSeason);
}

/**
 * The active seasons covering a date, for a chain of owners.
 *
 * The chain is walked most-specific-first and the FIRST level with any season
 * covering the date wins outright. That is the same specificity rule the
 * schedules follow, and it is what makes "a club can inherit federation season
 * definitions OR define local seasonal schedules" true without a flag: defining
 * one local season replaces the federation's for that club, rather than being
 * silently unioned with it.
 *
 * A season marked `inheritable = false` is skipped for every level but its own.
 */
export async function seasonsOn(
  db: DB, chain: ScheduleOwner[], dayIso: IsoDate
): Promise<SeasonRecord[]> {
  assertIsoDate(dayIso);
  for (let depth = 0; depth < chain.length; depth++) {
    const o = normaliseOwner(chain[depth]);
    const rows = await db.select().from(sch.seasons).where(and(
      eq(sch.seasons.ownerScope, o.scope as any),
      o.id === null ? isNull(sch.seasons.ownerId) : eq(sch.seasons.ownerId, o.id),
      eq(sch.seasons.status, 'active'),
      lte(sch.seasons.startsOn, dayIso),
      gte(sch.seasons.endsOn, dayIso)
    ));
    const usable = depth === 0 ? rows : rows.filter((r: any) => r.inheritable);
    if (usable.length) return usable.map(toSeason);
  }
  return [];
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEDULES AND VERSIONS
// ═══════════════════════════════════════════════════════════════════════════

export interface ScheduleInput {
  name: string;
  purpose: SchedulePurpose;
  owner: ScheduleOwner;
  venueId?: number | null;
  classId?: number | null;
  timezone?: string;
  inheritsFromScheduleId?: number | null;
  publicVisible?: boolean;
  notes?: string | null;
}

export interface ScheduleRecord {
  id: number;
  code: string;
  name: string;
  purpose: SchedulePurpose;
  ownerScope: OwnerScope;
  ownerId: number | null;
  venueId: number | null;
  classId: number | null;
  timezone: string;
  inheritsFromScheduleId: number | null;
  status: 'draft' | 'active' | 'retired';
  publicVisible: boolean;
}

const PURPOSES: SchedulePurpose[] = ['operating', 'training', 'office', 'administrative', 'class'];

/**
 * Create the schedule OBJECT. It says nothing yet — that is a version's job.
 *
 * The timezone comes from the venue when there is one, because the room's clock
 * is the authority on what "six in the morning" means there, and defaults to
 * Asia/Kolkata only when nothing more specific is available. That default is a
 * column with a value, not an assumption in code: changing it is an UPDATE.
 */
export async function createSchedule(db: DB, ctx: AuditContext, input: ScheduleInput): Promise<ScheduleRecord> {
  const owner = normaliseOwner(input.owner);
  await assertMayWriteSchedule(db, ctx.principal, owner);

  if (!PURPOSES.includes(input.purpose)) {
    throw new SchedulingError('bad_purpose', `Unknown schedule purpose ${JSON.stringify(input.purpose)}.`);
  }
  const name = (input.name ?? '').trim();
  if (!name) throw new SchedulingError('name_required', 'A schedule needs a name.');

  if (input.purpose === 'class' && !input.classId) {
    throw new SchedulingError('class_required', 'A class schedule must name its class.');
  }
  if (input.purpose !== 'class' && input.classId) {
    throw new SchedulingError('class_not_allowed', `A ${input.purpose} schedule belongs to a unit or a room, not to one class.`);
  }

  let timezone = input.timezone ?? null;
  if (input.venueId) {
    const venue = await db.select({ id: ops.venues.id, timezone: ops.venues.timezone })
      .from(ops.venues).where(eq(ops.venues.id, input.venueId)).limit(1);
    if (!venue.length) throw new SchedulingError('not_found', `No venue ${input.venueId}.`);
    timezone = timezone ?? venue[0].timezone;
  }
  timezone = assertTimezone(timezone ?? 'Asia/Kolkata');

  if (input.inheritsFromScheduleId) {
    await assertNoInheritanceCycle(db, null, input.inheritsFromScheduleId);
  }

  const code = await allocateFederationId(db, 'SCH');
  const rows = await db.insert(sch.schedules).values({
    code, name, purpose: input.purpose as any,
    ownerScope: owner.scope as any, ownerId: owner.id,
    venueId: input.venueId ?? null,
    classId: input.classId ?? null,
    timezone,
    inheritsFromScheduleId: input.inheritsFromScheduleId ?? null,
    status: 'active',
    publicVisible: input.publicVisible ?? true,
    notes: input.notes ?? null,
    createdByUserId: ctx.principal.userId ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'schedule', entityId: rows[0].id, action: 'create',
    newValue: { code, name, purpose: input.purpose, ownerScope: owner.scope, ownerId: owner.id, venueId: input.venueId ?? null, timezone },
  });
  return toSchedule(rows[0]);
}

/**
 * Follow the explicit-parent chain and refuse a loop.
 *
 * The database can only see one row, so it rejects a schedule that is its own
 * parent and nothing longer. A → B → A is caught here, and it must be: a cycle
 * makes resolution non-terminating, and the symptom is a page that never
 * responds rather than a page that is wrong.
 */
async function assertNoInheritanceCycle(db: DB, selfId: number | null, parentId: number): Promise<void> {
  const seen = new Set<number>();
  if (selfId != null) seen.add(selfId);
  let cursor: number | null = parentId;
  while (cursor != null) {
    if (seen.has(cursor)) {
      throw new SchedulingError('inheritance_cycle', 'That would make a schedule inherit from itself, directly or through a chain.');
    }
    seen.add(cursor);
    const rows: any[] = await db.select({ parent: sch.schedules.inheritsFromScheduleId })
      .from(sch.schedules).where(eq(sch.schedules.id, cursor)).limit(1);
    if (!rows.length) throw new SchedulingError('not_found', `No schedule ${cursor} to inherit from.`);
    cursor = rows[0].parent ?? null;
  }
}

function toSchedule(row: any): ScheduleRecord {
  return {
    id: row.id, code: row.code, name: row.name, purpose: row.purpose,
    ownerScope: row.ownerScope, ownerId: row.ownerId ?? null,
    venueId: row.venueId ?? null, classId: row.classId ?? null,
    timezone: row.timezone,
    inheritsFromScheduleId: row.inheritsFromScheduleId ?? null,
    status: row.status, publicVisible: row.publicVisible,
  };
}

export interface RuleInput {
  dayOfWeek: number;                 // 1 = Monday … 7 = Sunday
  opensAt?: Wall | null;
  closesAt?: Wall | null;
  kind?: 'open' | 'closed';
  seasonId?: number | null;
  label?: string | null;
  displayOrder?: number;
  notes?: string | null;
}

export interface VersionRecord {
  id: number;
  scheduleId: number;
  versionNo: number;
  status: 'draft' | 'published' | 'superseded' | 'withdrawn';
  effectiveFrom: IsoDate;
  effectiveTo: IsoDate | null;
  reason: string | null;
}

/**
 * Draft the next edition of a schedule.
 *
 * A draft is invisible to every read in this module. That is deliberate: an
 * administrator half way through rebuilding a club's week must not have the
 * public timetable change under them line by line.
 */
export async function draftVersion(
  db: DB, ctx: AuditContext,
  scheduleId: number,
  input: { effectiveFrom: IsoDate; effectiveTo?: IsoDate | null; reason?: string | null; rules?: RuleInput[] }
): Promise<VersionRecord> {
  const schedule = await loadSchedule(db, scheduleId);
  await assertMayWriteSchedule(db, ctx.principal, { scope: schedule.ownerScope, id: schedule.ownerId });

  const effectiveFrom = assertIsoDate(input.effectiveFrom, 'effectiveFrom');
  const effectiveTo = input.effectiveTo == null ? null : assertIsoDate(input.effectiveTo, 'effectiveTo');
  if (effectiveTo && effectiveTo < effectiveFrom) {
    throw new SchedulingError('bad_range', `${effectiveFrom}..${effectiveTo} ends before it starts.`);
  }

  const existing = await db.select({ versionNo: sch.scheduleVersions.versionNo })
    .from(sch.scheduleVersions).where(eq(sch.scheduleVersions.scheduleId, scheduleId));
  const versionNo = existing.reduce((n: number, r: any) => Math.max(n, r.versionNo), 0) + 1;

  const rows = await db.insert(sch.scheduleVersions).values({
    scheduleId, versionNo, status: 'draft',
    effectiveFrom, effectiveTo,
    reason: input.reason ?? null,
    createdByUserId: ctx.principal.userId ?? null,
  }).returning();

  const version = rows[0];
  if (input.rules?.length) await setRules(db, ctx, version.id, input.rules);

  await writeAudit(db, ctx, {
    entityType: 'schedule_version', entityId: version.id, action: 'create',
    newValue: { scheduleId, versionNo, effectiveFrom, effectiveTo },
  });
  return toVersion(version);
}

/**
 * Replace a DRAFT version's rules wholesale.
 *
 * Refuses on anything published, and that refusal is the versioning guarantee:
 * there is no path in this module that edits a timetable which has been in
 * force. Changing published hours means drafting a successor, which is one more
 * click and the reason a historical attendance record still makes sense.
 */
export async function setRules(db: DB, ctx: AuditContext, versionId: number, rules: RuleInput[]): Promise<number> {
  const version = await loadVersion(db, versionId);
  const schedule = await loadSchedule(db, version.scheduleId);
  await assertMayWriteSchedule(db, ctx.principal, { scope: schedule.ownerScope, id: schedule.ownerId });

  if (version.status !== 'draft') {
    throw new SchedulingError(
      'not_draft',
      `Version ${version.versionNo} is ${version.status} and cannot be edited. Draft a new version instead — ` +
      'the timetable that was in force is what an attendance record from that week is read against.'
    );
  }

  const values = rules.map((r, i) => {
    const kind = r.kind ?? 'open';
    if (!Number.isInteger(r.dayOfWeek) || r.dayOfWeek < 1 || r.dayOfWeek > 7) {
      throw new SchedulingError('bad_day', `dayOfWeek must be 1 (Monday) to 7 (Sunday); received ${JSON.stringify(r.dayOfWeek)}.`);
    }
    if (kind === 'closed') {
      if (r.opensAt || r.closesAt) {
        throw new SchedulingError('bad_rule', 'A closed day carries no times. Use kind "open" to state hours.');
      }
      return {
        versionId, seasonId: r.seasonId ?? null, dayOfWeek: r.dayOfWeek, kind: 'closed' as const,
        opensAt: null, closesAt: null, label: r.label ?? null,
        displayOrder: r.displayOrder ?? i, notes: r.notes ?? null,
      };
    }
    const opensAt = assertWall(r.opensAt, 'opensAt');
    const closesAt = assertWall(r.closesAt, 'closesAt');
    if (closesAt <= opensAt) {
      throw new SchedulingError(
        'bad_rule',
        `${DAY_NAMES[r.dayOfWeek - 1]} ${opensAt}–${closesAt} ends before it starts. A window crossing midnight is two windows on two days.`
      );
    }
    return {
      versionId, seasonId: r.seasonId ?? null, dayOfWeek: r.dayOfWeek, kind: 'open' as const,
      opensAt, closesAt, label: r.label ?? null,
      displayOrder: r.displayOrder ?? i, notes: r.notes ?? null,
    };
  });

  // Two open windows on the same day and season that overlap are a mistake the
  // administrator wants told about now, not a union the resolver quietly makes.
  const byDay = new Map<string, Span[]>();
  for (const v of values) {
    if (v.kind !== 'open') continue;
    const key = `${v.dayOfWeek}:${v.seasonId ?? 'all'}`;
    const span = { s: toMin(v.opensAt as Wall), e: toMin(v.closesAt as Wall) };
    const list = byDay.get(key) ?? [];
    const clash = list.find((x) => spansOverlap(x, span));
    if (clash) {
      throw new SchedulingError(
        'overlapping_rules',
        `${DAY_NAMES[v.dayOfWeek - 1]} has two overlapping sessions: ${toWall(clash.s)}–${toWall(clash.e)} and ${v.opensAt}–${v.closesAt}.`
      );
    }
    list.push(span);
    byDay.set(key, list);
  }

  await db.delete(sch.scheduleRules).where(eq(sch.scheduleRules.versionId, versionId));
  if (values.length) await db.insert(sch.scheduleRules).values(values);

  await writeAudit(db, ctx, {
    entityType: 'schedule_version', entityId: versionId, action: 'update',
    newValue: { rules: values.length },
  });
  return values.length;
}

/**
 * Put a version in force, and close the one it replaces.
 *
 * THE INCUMBENT IS NOT DELETED AND ITS RULES ARE NOT TOUCHED. It gets an end
 * date — the day before the successor begins — and the status 'superseded',
 * which is a readable state and is what `openingHoursOn(..., { asOf })` reads
 * when it is asked about a date in the past.
 *
 * `reason` is required. Every change must have who, what, when and why; the
 * first three are columns the database insists on, and this is the fourth.
 */
export async function publishVersion(
  db: DB, ctx: AuditContext, versionId: number, reason: string
): Promise<{ version: VersionRecord; superseded: VersionRecord | null }> {
  const version = await loadVersion(db, versionId);
  const schedule = await loadSchedule(db, version.scheduleId);
  const owner = { scope: schedule.ownerScope, id: schedule.ownerId };
  assertCan(ctx.principal, 'schedule:publish', await resourceForOwner(db, owner));

  const why = (reason ?? '').trim();
  if (!why) {
    throw new SchedulingError(
      'reason_required',
      'Publishing a timetable must record why. It is read months later by a member asking when their class moved and who decided it.'
    );
  }
  if (version.status !== 'draft') {
    throw new SchedulingError('not_draft', `Version ${version.versionNo} is already ${version.status}.`);
  }
  if (!ctx.principal.userId) {
    throw new SchedulingError(
      'publisher_required',
      'A published timetable records who published it. This principal has no user id, so it cannot.'
    );
  }

  const ruleCount = await db.select({ id: sch.scheduleRules.id })
    .from(sch.scheduleRules).where(eq(sch.scheduleRules.versionId, versionId));
  if (!ruleCount.length) {
    throw new SchedulingError(
      'no_rules',
      'This version has no rules at all. A schedule with no rules reads as "closed every day", which is a statement to make deliberately: add explicit closed days if that is what is meant.'
    );
  }

  return await db.transaction(async (tx: DB) => {
    // The incumbent: published, and covering or preceding the new start date.
    const incumbents = await tx.select().from(sch.scheduleVersions).where(and(
      eq(sch.scheduleVersions.scheduleId, version.scheduleId),
      eq(sch.scheduleVersions.status, 'published')
    )).orderBy(asc(sch.scheduleVersions.effectiveFrom));

    const live = incumbents.filter((v: any) => v.effectiveTo == null || v.effectiveTo >= version.effectiveFrom);
    if (live.length > 1) {
      throw new SchedulingError('ambiguous_incumbent', 'More than one published version is in force; resolve that before publishing another.');
    }
    let superseded: any = null;
    if (live.length === 1) {
      const prior = live[0];
      if (prior.effectiveFrom >= version.effectiveFrom) {
        throw new SchedulingError(
          'not_after_incumbent',
          `Version ${prior.versionNo} already takes effect on ${prior.effectiveFrom}. A successor must start after it, so that no date is covered by two timetables.`
        );
      }
      const closeOn = addDays(version.effectiveFrom, -1);
      const rows = await tx.update(sch.scheduleVersions)
        .set({ status: 'superseded', effectiveTo: closeOn })
        .where(eq(sch.scheduleVersions.id, prior.id)).returning();
      superseded = rows[0];
    }

    const rows = await tx.update(sch.scheduleVersions).set({
      status: 'published',
      publishedAt: new Date(),
      publishedByUserId: ctx.principal.userId ?? null,
      reason: why,
      supersedesVersionId: superseded?.id ?? null,
    }).where(eq(sch.scheduleVersions.id, versionId)).returning();

    await writeAudit(tx, ctx, {
      entityType: 'schedule_version', entityId: versionId, action: 'approve',
      oldValue: superseded ? { supersededVersionId: superseded.id, supersededEffectiveTo: superseded.effectiveTo } : null,
      newValue: { scheduleId: version.scheduleId, versionNo: version.versionNo, effectiveFrom: version.effectiveFrom, reason: why },
    });

    return { version: toVersion(rows[0]), superseded: superseded ? toVersion(superseded) : null };
  });
}

/** Pull a version that should never have been in force. Distinct from superseding. */
export async function withdrawVersion(db: DB, ctx: AuditContext, versionId: number, reason: string): Promise<VersionRecord> {
  const version = await loadVersion(db, versionId);
  const schedule = await loadSchedule(db, version.scheduleId);
  assertCan(ctx.principal, 'schedule:publish', await resourceForOwner(db, { scope: schedule.ownerScope, id: schedule.ownerId }));

  const why = (reason ?? '').trim();
  if (!why) throw new SchedulingError('reason_required', 'A withdrawal must record why.');
  if (version.status !== 'published') {
    throw new SchedulingError('not_published', `Version ${version.versionNo} is ${version.status}, not published.`);
  }
  const rows = await db.update(sch.scheduleVersions)
    .set({ status: 'withdrawn', withdrawnAt: new Date(), withdrawnReason: why })
    .where(eq(sch.scheduleVersions.id, versionId)).returning();
  await writeAudit(db, ctx, {
    entityType: 'schedule_version', entityId: versionId, action: 'revoke',
    oldValue: { status: 'published' }, newValue: { status: 'withdrawn', reason: why },
  });
  return toVersion(rows[0]);
}

function toVersion(row: any): VersionRecord {
  return {
    id: row.id, scheduleId: row.scheduleId, versionNo: row.versionNo,
    status: row.status, effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo ?? null, reason: row.reason ?? null,
  };
}

async function loadSchedule(db: DB, scheduleId: number): Promise<ScheduleRecord> {
  const rows = await db.select().from(sch.schedules).where(eq(sch.schedules.id, scheduleId)).limit(1);
  if (!rows.length) throw new SchedulingError('not_found', `No schedule ${scheduleId}.`);
  return toSchedule(rows[0]);
}

async function loadVersion(db: DB, versionId: number): Promise<VersionRecord> {
  const rows = await db.select().from(sch.scheduleVersions).where(eq(sch.scheduleVersions.id, versionId)).limit(1);
  if (!rows.length) throw new SchedulingError('not_found', `No schedule version ${versionId}.`);
  return toVersion(rows[0]);
}

// ═══════════════════════════════════════════════════════════════════════════
// EXCEPTIONS
// ═══════════════════════════════════════════════════════════════════════════

export interface ExceptionInput {
  scheduleId: number;
  onDate: IsoDate;
  kind:
    | 'holiday' | 'closure' | 'extended_hours' | 'reduced_hours'
    | 'competition' | 'seminar' | 'camp' | 'maintenance'
    | 'private_booking' | 'examination' | 'grading' | 'special_training';
  effect: 'closed' | 'replace' | 'add' | 'remove';
  opensAt?: Wall | null;
  closesAt?: Wall | null;
  reason: string;
  sourceKind?: string | null;
  sourceId?: number | null;
}

export interface ExceptionRecord {
  id: number;
  scheduleId: number;
  onDate: IsoDate;
  kind: string;
  effect: string;
  opensAt: Wall | null;
  closesAt: Wall | null;
  /** Null on a public read — see the privacy note at the head of this file. */
  reason: string | null;
  reasonWithheld: boolean;
}

/**
 * Record a date that does not follow the pattern.
 *
 * A `closed` exception and a windowed one cannot coexist on a date: "shut all
 * day" and "open 06:00–08:00" are contradictory instructions, and a resolver
 * that silently preferred one would be deciding federation business. The
 * refusal names the exception it collided with.
 */
export async function addException(db: DB, ctx: AuditContext, input: ExceptionInput): Promise<ExceptionRecord> {
  const schedule = await loadSchedule(db, input.scheduleId);
  await assertMayWriteSchedule(db, ctx.principal, { scope: schedule.ownerScope, id: schedule.ownerId });

  const onDate = assertIsoDate(input.onDate, 'onDate');
  const reason = (input.reason ?? '').trim();
  if (!reason) {
    throw new SchedulingError('reason_required', 'A closure or a changed day must record why. A closure nobody can explain is a closure nobody trusts.');
  }

  const existing = await db.select().from(sch.scheduleExceptions).where(and(
    eq(sch.scheduleExceptions.scheduleId, input.scheduleId),
    eq(sch.scheduleExceptions.onDate, onDate)
  ));

  if (input.effect === 'closed') {
    if (input.opensAt || input.closesAt) {
      throw new SchedulingError('bad_exception', 'A closed day carries no times.');
    }
    if (existing.length) {
      throw new SchedulingError(
        'exception_conflict',
        `${onDate} already has ${existing.length} exception(s) on this schedule. Remove them before closing the day outright.`
      );
    }
  } else {
    const closedAlready = existing.find((e: any) => e.effect === 'closed');
    if (closedAlready) {
      throw new SchedulingError(
        'exception_conflict',
        `${onDate} is already recorded as closed (${closedAlready.kind}). Remove that first if the day is in fact partly open.`
      );
    }
    assertWall(input.opensAt, 'opensAt');
    assertWall(input.closesAt, 'closesAt');
    if ((input.closesAt as Wall) <= (input.opensAt as Wall)) {
      throw new SchedulingError('bad_exception', `${input.opensAt}–${input.closesAt} ends before it starts.`);
    }
  }

  const rows = await db.insert(sch.scheduleExceptions).values({
    scheduleId: input.scheduleId, onDate,
    kind: input.kind as any, effect: input.effect as any,
    opensAt: input.effect === 'closed' ? null : (input.opensAt as Wall),
    closesAt: input.effect === 'closed' ? null : (input.closesAt as Wall),
    reason,
    sourceKind: input.sourceKind ?? null,
    sourceId: input.sourceId ?? null,
    createdByUserId: ctx.principal.userId ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'schedule_exception', entityId: rows[0].id, action: 'create',
    newValue: { scheduleId: input.scheduleId, onDate, kind: input.kind, effect: input.effect, reason },
  });
  return toException(rows[0], true);
}

export async function removeException(db: DB, ctx: AuditContext, exceptionId: number, reason: string): Promise<void> {
  const rows = await db.select().from(sch.scheduleExceptions).where(eq(sch.scheduleExceptions.id, exceptionId)).limit(1);
  if (!rows.length) throw new SchedulingError('not_found', `No exception ${exceptionId}.`);
  const schedule = await loadSchedule(db, rows[0].scheduleId);
  await assertMayWriteSchedule(db, ctx.principal, { scope: schedule.ownerScope, id: schedule.ownerId });

  const why = (reason ?? '').trim();
  if (!why) throw new SchedulingError('reason_required', 'Removing an exception must record why.');

  await db.delete(sch.scheduleExceptions).where(eq(sch.scheduleExceptions.id, exceptionId));
  await writeAudit(db, ctx, {
    entityType: 'schedule_exception', entityId: exceptionId, action: 'delete',
    oldValue: { onDate: rows[0].onDate, kind: rows[0].kind, effect: rows[0].effect, reason: rows[0].reason },
    newValue: { removedBecause: why },
  });
}

function toException(row: any, mayReadReason: boolean): ExceptionRecord {
  return {
    id: row.id, scheduleId: row.scheduleId, onDate: row.onDate,
    kind: row.kind, effect: row.effect,
    opensAt: row.opensAt ?? null, closesAt: row.closesAt ?? null,
    reason: mayReadReason ? row.reason : null,
    reasonWithheld: !mayReadReason,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// RESOLUTION
// ═══════════════════════════════════════════════════════════════════════════

export interface ScheduleTarget {
  purpose: SchedulePurpose;
  /** Most specific first: a room. Implies its dojo, district and state. */
  venueId?: number | null;
  dojoId?: number | null;
  districtUnitId?: number | null;
  stateUnitId?: number | null;
  institutionId?: number | null;
  classId?: number | null;
}

export interface ResolvedSchedule {
  schedule: ScheduleRecord;
  version: VersionRecord;
  /** How far up the chain the answer came from. 0 = the level asked about. */
  inheritedDepth: number;
  /** True when the answer is the target's own, not an ancestor's. */
  isOwnSchedule: boolean;
  /** For a surface that must say "following the federation default". */
  inheritedFromLabel: string;
  chain: ScheduleOwner[];
}

/**
 * The chain of owners for a target, most specific first.
 *
 * Built from the database rather than from what the caller passed, because a
 * caller who knows only a venue id must still get the state above it — and
 * because a caller who passes a mismatched dojo and state should not be able to
 * launder a schedule out of a unit it does not belong to.
 */
export async function ownerChain(db: DB, target: ScheduleTarget): Promise<ScheduleOwner[]> {
  const chain: ScheduleOwner[] = [];
  let dojoId = target.dojoId ?? null;
  let districtUnitId = target.districtUnitId ?? null;
  let stateUnitId = target.stateUnitId ?? null;
  let institutionId = target.institutionId ?? null;

  if (target.venueId) {
    const rows = await db.select({
      dojoId: ops.venues.dojoId,
      institutionId: ops.venues.institutionId,
      stateUnitId: ops.venues.stateUnitId,
      districtUnitId: ops.venues.districtUnitId,
    }).from(ops.venues).where(eq(ops.venues.id, target.venueId)).limit(1);
    if (!rows.length) throw new SchedulingError('not_found', `No venue ${target.venueId}.`);
    dojoId = dojoId ?? rows[0].dojoId ?? null;
    institutionId = institutionId ?? rows[0].institutionId ?? null;
    stateUnitId = stateUnitId ?? rows[0].stateUnitId ?? null;
    districtUnitId = districtUnitId ?? rows[0].districtUnitId ?? null;
  }

  if (dojoId) {
    const rows = await db.select({
      stateUnitId: s.dojos.stateUnitId, districtUnitId: s.dojos.districtUnitId,
    }).from(s.dojos).where(eq(s.dojos.id, dojoId)).limit(1);
    if (rows.length) {
      stateUnitId = stateUnitId ?? rows[0].stateUnitId ?? null;
      districtUnitId = districtUnitId ?? rows[0].districtUnitId ?? null;
    }
    chain.push({ scope: 'dojo', id: dojoId });
  }
  if (institutionId) chain.push({ scope: 'institution', id: institutionId });
  if (districtUnitId) {
    const rows = await db.select({ stateUnitId: s.districtUnits.stateUnitId })
      .from(s.districtUnits).where(eq(s.districtUnits.id, districtUnitId)).limit(1);
    if (rows.length) stateUnitId = stateUnitId ?? rows[0].stateUnitId ?? null;
    chain.push({ scope: 'district', id: districtUnitId });
  }
  if (stateUnitId) chain.push({ scope: 'state', id: stateUnitId });
  chain.push({ scope: 'national', id: null });
  return chain;
}

const LEVEL_LABEL: Record<OwnerScope, string> = {
  national: 'the national federation',
  state: 'the state association',
  district: 'the district association',
  dojo: 'the club',
  institution: 'the client organisation',
};

/**
 * Find the schedule that actually governs a target on a date.
 *
 * Candidate order, most specific first:
 *
 *   · this ROOM's own schedule (a second hall with different hours);
 *   · this CLUB's schedule;
 *   · the DISTRICT's, the STATE's, the FEDERATION's.
 *
 * A schedule that exists but has no version in force on the date does NOT stop
 * the walk. That is what makes an unconfigured club inherit rather than render
 * blank, and it is also what makes `effectiveFrom` in the future safe: the new
 * timetable simply is not the answer yet.
 *
 * `inheritsFromScheduleId` is consulted before the walk continues, for the
 * satellite location that follows another club rather than its own district.
 */
export async function resolveSchedule(
  db: DB, target: ScheduleTarget, opts: { asOf?: IsoDate } = {}
): Promise<ResolvedSchedule | null> {
  const asOf = opts.asOf ? assertIsoDate(opts.asOf, 'asOf') : todayIso();

  // A class schedule belongs to its class and inherits from nothing by default:
  // a club's opening hours are not a fallback timetable for a class inside it.
  if (target.purpose === 'class') {
    if (!target.classId) throw new SchedulingError('class_required', 'Resolving a class schedule needs a class id.');
    const rows = await db.select().from(sch.schedules).where(and(
      eq(sch.schedules.classId, target.classId),
      eq(sch.schedules.purpose, 'class'),
      eq(sch.schedules.status, 'active')
    )).limit(1);
    if (!rows.length) return null;
    const resolved = await withVersion(db, toSchedule(rows[0]), asOf, 0, []);
    return resolved;
  }

  const chain = await ownerChain(db, target);

  // Depth 0 is a room-specific schedule, which sits outside the owner chain: it
  // is the most specific thing there is and belongs to whichever level owns it.
  if (target.venueId) {
    const rows = await db.select().from(sch.schedules).where(and(
      eq(sch.schedules.venueId, target.venueId),
      eq(sch.schedules.purpose, target.purpose as any),
      eq(sch.schedules.status, 'active')
    )).limit(1);
    if (rows.length) {
      const hit = await withVersion(db, toSchedule(rows[0]), asOf, 0, chain);
      if (hit) return hit;
    }
  }

  for (let depth = 0; depth < chain.length; depth++) {
    const o = normaliseOwner(chain[depth]);
    const rows = await db.select().from(sch.schedules).where(and(
      eq(sch.schedules.ownerScope, o.scope as any),
      o.id === null ? isNull(sch.schedules.ownerId) : eq(sch.schedules.ownerId, o.id),
      eq(sch.schedules.purpose, target.purpose as any),
      eq(sch.schedules.status, 'active'),
      isNull(sch.schedules.venueId),
      isNull(sch.schedules.classId)
    )).limit(1);
    if (!rows.length) continue;
    const hit = await withVersion(db, toSchedule(rows[0]), asOf, target.venueId ? depth + 1 : depth, chain);
    if (hit) return hit;
  }
  return null;
}

async function withVersion(
  db: DB, schedule: ScheduleRecord, asOf: IsoDate, depth: number, chain: ScheduleOwner[]
): Promise<ResolvedSchedule | null> {
  const version = await versionInForce(db, schedule.id, asOf);
  if (version) {
    return {
      schedule, version, inheritedDepth: depth,
      isOwnSchedule: depth === 0,
      inheritedFromLabel: LEVEL_LABEL[schedule.ownerScope],
      chain,
    };
  }
  // An explicit parent is followed before the hierarchy walk resumes.
  if (schedule.inheritsFromScheduleId) {
    const parent = await loadSchedule(db, schedule.inheritsFromScheduleId);
    return await withVersion(db, parent, asOf, depth + 1, chain);
  }
  return null;
}

/** The published version whose effective window contains `asOf`. */
export async function versionInForce(db: DB, scheduleId: number, asOf: IsoDate): Promise<VersionRecord | null> {
  const rows = await db.select().from(sch.scheduleVersions).where(and(
    eq(sch.scheduleVersions.scheduleId, scheduleId),
    inArray(sch.scheduleVersions.status, ['published', 'superseded']),
    lte(sch.scheduleVersions.effectiveFrom, asOf),
    or(isNull(sch.scheduleVersions.effectiveTo), gte(sch.scheduleVersions.effectiveTo, asOf))
  )).orderBy(asc(sch.scheduleVersions.effectiveFrom));
  if (!rows.length) return null;
  // Most recent start wins if two somehow cover the date. publishVersion()
  // prevents that; a database restored from two halves might not have.
  return toVersion(rows[rows.length - 1]);
}

/** Today, as an ISO date, in a zone. Defaults to the federation's own. */
export function todayIso(timeZone = 'Asia/Kolkata'): IsoDate {
  return zonedDay(new Date(), timeZone);
}

// ═══════════════════════════════════════════════════════════════════════════
// THE DAY
// ═══════════════════════════════════════════════════════════════════════════

export interface ResolvedDay {
  date: IsoDate;
  dayOfWeek: number;                 // ISO 1..7
  dayName: string;
  timezone: string;
  open: boolean;
  windows: TimeWindow[];
  /** Why the day is shut or altered, when the reader may know. */
  exceptions: ExceptionRecord[];
  seasons: SeasonRecord[];
  scheduleId: number | null;
  versionId: number | null;
  /** Named so a page can say "following the national federation's hours". */
  inheritedFromLabel: string | null;
  isOwnSchedule: boolean;
  /** True when no schedule governs this target at all — NOT the same as closed. */
  unconfigured: boolean;
}

export interface DayOptions {
  asOf?: IsoDate;
  /** A caller without `schedule:read` in scope gets exception reasons redacted. */
  principal?: Principal | null;
  /** Skip the venue-blackout subtraction (used when there is no room). */
  ignoreBlackouts?: boolean;
}

/**
 * What is open on one calendar day, for one target.
 *
 * `unconfigured` and `open: false` are DIFFERENT and the distinction is the
 * whole reason this returns an object rather than a list. "This club has not
 * published its hours" sends a member to ring the club; "this club is closed on
 * Sunday" sends them to come back on Monday. A resolver that returned an empty
 * array for both would make the site lie to one of them.
 */
export async function openingHoursOn(
  db: DB, target: ScheduleTarget, dayIso: IsoDate, opts: DayOptions = {}
): Promise<ResolvedDay> {
  assertIsoDate(dayIso);
  const dow = isoDayOfWeek(dayIso);
  const resolved = await resolveSchedule(db, target, { asOf: opts.asOf ?? dayIso });

  if (!resolved) {
    return {
      date: dayIso, dayOfWeek: dow, dayName: DAY_NAMES[dow - 1],
      timezone: 'Asia/Kolkata',
      open: false, windows: [], exceptions: [], seasons: [],
      scheduleId: null, versionId: null,
      inheritedFromLabel: null, isOwnSchedule: false,
      unconfigured: true,
    };
  }

  const { schedule, version } = resolved;
  const tz = schedule.timezone;

  const mayReadReason = opts.principal
    ? can(opts.principal, 'schedule:read', await resourceForOwner(db, { scope: schedule.ownerScope, id: schedule.ownerId }))
    : false;

  // ── Step 3: seasons ──────────────────────────────────────────────────────
  const chain: ScheduleOwner[] = [{ scope: schedule.ownerScope, id: schedule.ownerId }, ...resolved.chain];
  const seasons = await seasonsOn(db, dedupeChain(chain), dayIso);
  const seasonIds = seasons.map((x) => x.id);

  // ── Step 3 continued: rules, with season specificity ─────────────────────
  const allRules = await db.select().from(sch.scheduleRules)
    .where(and(eq(sch.scheduleRules.versionId, version.id), eq(sch.scheduleRules.dayOfWeek, dow)))
    .orderBy(asc(sch.scheduleRules.displayOrder), asc(sch.scheduleRules.opensAt));

  const seasonal = allRules.filter((r: any) => r.seasonId != null && seasonIds.includes(r.seasonId));
  const allYear = allRules.filter((r: any) => r.seasonId == null);
  // SPECIFICITY, NOT UNION. A season rule for this day replaces the all-year
  // rules for this day — "and in summer, this instead", never "both at once".
  const active = seasonal.length ? seasonal : allYear;

  const seasonNameById = new Map(seasons.map((x) => [x.id, x.name]));
  let windows: TimeWindow[] = active
    .filter((r: any) => r.kind === 'open')
    .map((r: any) => ({
      opensAt: r.opensAt, closesAt: r.closesAt, label: r.label,
      source: 'rule' as const,
      seasonId: r.seasonId ?? null,
      seasonName: r.seasonId ? (seasonNameById.get(r.seasonId) ?? null) : null,
    }));

  // ── Step 4: exceptions ───────────────────────────────────────────────────
  const exceptionRows = await db.select().from(sch.scheduleExceptions).where(and(
    eq(sch.scheduleExceptions.scheduleId, schedule.id),
    eq(sch.scheduleExceptions.onDate, dayIso)
  ));
  const exceptions = exceptionRows.map((r: any) => toException(r, mayReadReason));

  const closed = exceptionRows.find((r: any) => r.effect === 'closed');
  if (closed) {
    windows = [];
  } else {
    const replaces = exceptionRows.filter((r: any) => r.effect === 'replace');
    if (replaces.length) {
      windows = replaces.map((r: any) => ({
        opensAt: r.opensAt, closesAt: r.closesAt, label: r.kind,
        source: 'exception' as const, exceptionKind: r.kind,
      }));
    }
    const adds = exceptionRows.filter((r: any) => r.effect === 'add');
    for (const a of adds) {
      windows.push({
        opensAt: a.opensAt, closesAt: a.closesAt, label: a.kind,
        source: 'exception', exceptionKind: a.kind,
      });
    }
    const removes = exceptionRows.filter((r: any) => r.effect === 'remove');
    if (removes.length) {
      windows = applyCuts(windows, removes.map((r: any) => ({ s: toMin(r.opensAt), e: toMin(r.closesAt) })));
    }
  }

  // ── Step 5: blackouts, which beat everybody ──────────────────────────────
  const venueId = schedule.venueId ?? target.venueId ?? null;
  if (venueId && !opts.ignoreBlackouts && windows.length) {
    const dayStart = zonedInstant(dayIso, '00:00', tz);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000);
    const blackouts = await db.select().from(ops.venueBlackouts).where(and(
      eq(ops.venueBlackouts.venueId, venueId),
      lt(ops.venueBlackouts.startsAt, dayEnd),
      gte(ops.venueBlackouts.endsAt, dayStart)
    ));
    if (blackouts.length) {
      const cuts = blackouts.map((b: any) => ({
        s: Math.max(0, Math.round((new Date(b.startsAt).getTime() - dayStart.getTime()) / 60_000)),
        e: Math.min(1440, Math.round((new Date(b.endsAt).getTime() - dayStart.getTime()) / 60_000)),
      })).filter((x: Span) => x.e > x.s);
      windows = applyCuts(windows, cuts);
    }
  }

  windows.sort((a, b) => toMin(a.opensAt) - toMin(b.opensAt));

  return {
    date: dayIso, dayOfWeek: dow, dayName: DAY_NAMES[dow - 1],
    timezone: tz,
    open: windows.length > 0,
    windows, exceptions, seasons,
    scheduleId: schedule.id, versionId: version.id,
    inheritedFromLabel: resolved.inheritedFromLabel,
    isOwnSchedule: resolved.isOwnSchedule,
    unconfigured: false,
  };
}

/** Subtract spans from labelled windows, keeping each surviving piece's label. */
function applyCuts(windows: TimeWindow[], cuts: Span[]): TimeWindow[] {
  const out: TimeWindow[] = [];
  for (const w of windows) {
    for (const piece of subtractSpans([spanOf(w)], cuts)) {
      out.push({ ...w, opensAt: toWall(piece.s), closesAt: toWall(piece.e) });
    }
  }
  return out;
}

function dedupeChain(chain: ScheduleOwner[]): ScheduleOwner[] {
  const seen = new Set<string>();
  const out: ScheduleOwner[] = [];
  for (const o of chain) {
    const key = `${o.scope}:${o.id ?? 'null'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o);
  }
  return out;
}

/** A run of consecutive days, resolved one by one. What a timetable renders. */
export async function timetable(
  db: DB, target: ScheduleTarget, fromIso: IsoDate, toIso: IsoDate, opts: DayOptions = {}
): Promise<ResolvedDay[]> {
  const days = daysBetween(fromIso, toIso);
  const out: ResolvedDay[] = [];
  for (const day of days) out.push(await openingHoursOn(db, target, day, opts));
  return out;
}

/**
 * The week as the public site shows it — reasons redacted, never a principal.
 *
 * A separate function rather than a flag, so that a surface cannot publish an
 * administrator's private note by forgetting to pass one.
 */
export async function publicTimetable(
  db: DB, target: ScheduleTarget, fromIso: IsoDate, toIso: IsoDate
): Promise<ResolvedDay[]> {
  return await timetable(db, target, fromIso, toIso, { principal: null });
}

export interface PublishedWeek {
  /** Empty when nothing is configured. Never a placeholder week. */
  days: ResolvedDay[];
  /** Which question the answer came from: when the mat is free, or when the door is open. */
  purpose: SchedulePurpose | null;
  configured: boolean;
  timezone: string;
  inheritedFromLabel: string | null;
  isOwnSchedule: boolean;
  seasons: SeasonRecord[];
}

/**
 * What one unit or room publishes for a run of days — the read a PAGE wants.
 *
 * TRAINING HOURS FIRST, THEN OPERATING. "When can I train here" is the question
 * a visitor is actually asking, and a unit that has answered it specifically
 * should not have its answer widened to the building's opening hours. Most
 * units publish only one of the two; falling back rather than requiring both is
 * what stops the site demanding a distinction the federation has not drawn.
 *
 * `configured: false` is a FIRST-CLASS RESULT and must be rendered as such. A
 * page that turns it into an empty timetable is telling a parent the club never
 * opens, which is a different and much worse statement than "this club has not
 * published its hours — telephone them".
 */
export async function publishedWeek(
  db: DB, target: Omit<ScheduleTarget, 'purpose'>, fromIso: IsoDate, toIso: IsoDate
): Promise<PublishedWeek> {
  for (const purpose of ['training', 'operating'] as SchedulePurpose[]) {
    const days = await publicTimetable(db, { ...target, purpose }, fromIso, toIso);
    if (days.some((d) => !d.unconfigured)) {
      const first = days.find((d) => !d.unconfigured)!;
      return {
        days, purpose, configured: true,
        timezone: first.timezone,
        inheritedFromLabel: first.inheritedFromLabel,
        isOwnSchedule: first.isOwnSchedule,
        seasons: first.seasons,
      };
    }
  }
  return {
    days: [], purpose: null, configured: false,
    timezone: 'Asia/Kolkata',
    inheritedFromLabel: null, isOwnSchedule: false, seasons: [],
  };
}

/**
 * The dojo the federation runs from, if the register identifies one.
 *
 * Matched on NAME rather than by a flag column, for the reason
 * src/lib/timings.ts already gives about the editorial register: there is no
 * headquarters flag on `dojos`, the list is administrator-editable, and rows
 * get reordered — so "the first one" is not an answer. Returns null when
 * nothing matches, and the caller renders the federation's published strings
 * rather than guessing at a club.
 */
export async function headquartersDojo(db: DB): Promise<{ id: number; name: string; slug: string | null } | null> {
  const rows = await db.select({
    id: s.dojos.id, name: s.dojos.name, slug: s.dojos.slug, status: s.dojos.status,
  }).from(s.dojos);
  const hit = rows.find((d: any) => /hombu|headquarters/i.test(String(d.name ?? '')));
  return hit ? { id: hit.id, name: hit.name, slug: hit.slug ?? null } : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLASSES AND THEIR OCCURRENCES
// ═══════════════════════════════════════════════════════════════════════════

export interface ClassInput {
  name: string;
  slug: string;
  owner: ScheduleOwner;
  venueId?: number | null;
  mode?: 'on_site' | 'at_dojo' | 'online' | 'hybrid';
  summary?: string | null;
  discipline?: string | null;
  style?: string | null;
  level?: string | null;
  audience?: string | null;
  ageMin?: number | null;
  ageMax?: number | null;
  capacity?: number | null;
  defaultCoachPersonId?: number | null;
  requiresBooking?: boolean;
  onlinePlatform?: string | null;
  onlineUrl?: string | null;
  publicVisible?: boolean;
  activate?: boolean;
}

export async function createClass(db: DB, ctx: AuditContext, input: ClassInput): Promise<any> {
  const owner = normaliseOwner(input.owner);
  await assertMayWriteSchedule(db, ctx.principal, owner);

  const name = (input.name ?? '').trim();
  const slug = (input.slug ?? '').trim().toLowerCase();
  if (!name) throw new SchedulingError('name_required', 'A class needs a name.');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new SchedulingError('bad_slug', 'A class slug is lowercase words joined by hyphens.');
  }
  const mode = input.mode ?? 'at_dojo';
  if (mode !== 'online' && !input.venueId) {
    throw new SchedulingError(
      'venue_required',
      `A ${mode} class occupies a room and must name it. Only an online class may have no venue.`
    );
  }
  if (mode === 'online' && input.venueId) {
    throw new SchedulingError(
      'venue_not_allowed',
      'An online class does not consume a physical dojo. Record it as hybrid if it genuinely occupies one.'
    );
  }

  const code = await allocateFederationId(db, 'CLS');
  const rows = await db.insert(sch.dojoClasses).values({
    code, slug, name,
    summary: input.summary ?? null,
    ownerScope: owner.scope as any, ownerId: owner.id,
    venueId: input.venueId ?? null,
    mode: mode as any,
    discipline: input.discipline ?? null,
    style: input.style ?? null,
    level: input.level ?? null,
    audience: input.audience ?? null,
    ageMin: input.ageMin ?? null,
    ageMax: input.ageMax ?? null,
    capacity: input.capacity ?? null,
    defaultCoachPersonId: input.defaultCoachPersonId ?? null,
    requiresBooking: input.requiresBooking ?? true,
    onlinePlatform: input.onlinePlatform ?? null,
    onlineUrl: input.onlineUrl ?? null,
    status: input.activate ? 'active' : 'draft',
    publicVisible: input.publicVisible ?? true,
    createdByUserId: ctx.principal.userId ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'dojo_class', entityId: rows[0].id, action: 'create',
    newValue: { code, slug, name, ownerScope: owner.scope, ownerId: owner.id, venueId: input.venueId ?? null, mode },
  });
  return rows[0];
}

export interface GenerationResult {
  created: number;
  skippedExisting: number;
  /** Occurrences the room was not open for, with the reason. Never silent. */
  refused: Array<{ date: IsoDate; window: string; reason: string }>;
  conflicts: ConflictReport[];
}

/**
 * Turn a class's weekly pattern into real, bookable occurrences.
 *
 * THREE REFUSALS, EACH OF WHICH IS REPORTED RATHER THAN SWALLOWED:
 *
 *   · A class window outside the ROOM's open hours is not created. The dojo
 *     being shut is not a detail the timetable may override, and a member sent
 *     to a locked building is the failure this whole module exists to prevent.
 *   · A window on a day the room is closed — holiday, blackout, exception — is
 *     not created, for the same reason.
 *   · A window that would double-book the coach or the room is created only if
 *     the caller asked to ignore conflicts, and is reported either way.
 *
 * `refused` is returned, not logged. A generator that quietly produced eleven
 * sessions when the administrator expected thirteen is worse than one that
 * produced none, because nobody counts.
 *
 * IDEMPOTENT. Re-running over the same window creates nothing new — the unique
 * index on (class_id, starts_at) is what guarantees it, not this function's
 * memory.
 */
export async function generateSessions(
  db: DB, ctx: AuditContext,
  classId: number,
  fromIso: IsoDate, toIso: IsoDate,
  opts: { ignoreConflicts?: boolean; coachPersonId?: number | null } = {}
): Promise<GenerationResult> {
  const klass = await loadClass(db, classId);
  await assertMayWriteSchedule(db, ctx.principal, { scope: klass.ownerScope, id: klass.ownerId ?? null });

  if (klass.status !== 'active') {
    throw new SchedulingError('class_not_active', `${klass.name} is ${klass.status}; only an active class generates sessions.`);
  }

  const days = daysBetween(fromIso, toIso);
  const result: GenerationResult = { created: 0, skippedExisting: 0, refused: [], conflicts: [] };

  const facilityTarget: ScheduleTarget = {
    purpose: 'training',
    venueId: klass.venueId ?? null,
    dojoId: klass.ownerScope === 'dojo' ? klass.ownerId : null,
    institutionId: klass.ownerScope === 'institution' ? klass.ownerId : null,
  };

  for (const day of days) {
    const classDay = await openingHoursOn(db, { purpose: 'class', classId }, day, { asOf: day });
    if (classDay.unconfigured) {
      throw new SchedulingError(
        'class_unscheduled',
        `${klass.name} has no published class schedule. Draft and publish one before generating sessions — there is no default weekly pattern.`
      );
    }
    if (!classDay.open) continue;

    // An online class consumes no room, so the room's hours do not gate it.
    let facilityDay: ResolvedDay | null = null;
    if (klass.mode !== 'online') {
      // TRAINING HOURS FIRST, THEN OPERATING. A unit that has published when the
      // mat is available is answering a narrower question than "when is the
      // building open", and the narrower answer is the one a class must fit
      // inside. Most units publish only one; falling back rather than requiring
      // both is what stops the engine demanding a distinction the federation has
      // not drawn.
      facilityDay = await openingHoursOn(db, facilityTarget, day, { asOf: day });
      if (facilityDay.unconfigured) {
        facilityDay = await openingHoursOn(db, { ...facilityTarget, purpose: 'operating' }, day, { asOf: day });
      }
      if (facilityDay.unconfigured) {
        throw new SchedulingError(
          'facility_unscheduled',
          `The venue for ${klass.name} has no operating schedule on ${day}, and a class cannot be placed in a building whose hours nobody has recorded.`
        );
      }
    }

    for (const w of classDay.windows) {
      if (facilityDay) {
        if (!facilityDay.open) {
          result.refused.push({
            date: day, window: `${w.opensAt}–${w.closesAt}`,
            reason: facilityDay.exceptions.length
              ? `the venue is closed that day (${facilityDay.exceptions.map((e) => e.kind).join(', ')})`
              : 'the venue is closed that day',
          });
          continue;
        }
        if (!windowContains(facilityDay.windows, w.opensAt, w.closesAt)) {
          result.refused.push({
            date: day, window: `${w.opensAt}–${w.closesAt}`,
            reason: `the venue is open ${mergedMinutes(facilityDay.windows).map((x) => `${x.opensAt}–${x.closesAt}`).join(', ')} that day`,
          });
          continue;
        }
      }

      const tz = classDay.timezone;
      const startsAt = zonedInstant(day, w.opensAt, tz);
      const endsAt = zonedInstant(day, w.closesAt, tz);
      const coachPersonId = opts.coachPersonId ?? klass.defaultCoachPersonId ?? null;

      // ALREADY THERE? Asked BEFORE the conflict check, and that order is the
      // whole of idempotency. A second run over the same fortnight would
      // otherwise find its own previous output sitting in the room and report
      // every session as a venue double-booking — a regeneration that looks
      // like a catastrophe, which is how administrators learn to ignore the
      // conflict list.
      const alreadyThere = await db.select({ id: sch.classSessions.id })
        .from(sch.classSessions)
        .where(and(eq(sch.classSessions.classId, classId), eq(sch.classSessions.startsAt, startsAt)))
        .limit(1);
      if (alreadyThere.length) {
        result.skippedExisting++;
        continue;
      }

      const conflicts = await detectConflicts(db, {
        startsAt, endsAt,
        venueId: klass.mode === 'online' ? null : klass.venueId,
        coachPersonId,
        excludeSessionId: null,
      });
      if (conflicts.length) {
        result.conflicts.push(...conflicts);
        if (!opts.ignoreConflicts) {
          result.refused.push({
            date: day, window: `${w.opensAt}–${w.closesAt}`,
            reason: conflicts.map((c) => c.detail).join('; '),
          });
          continue;
        }
      }

      const ref = await allocateFederationId(db, 'SES');
      const inserted = await db.insert(sch.classSessions).values({
        ref, classId,
        scheduleVersionId: classDay.versionId,
        venueId: klass.mode === 'online' ? null : klass.venueId,
        coachPersonId,
        mode: klass.mode,
        onlineUrl: klass.mode === 'at_dojo' || klass.mode === 'on_site' ? null : klass.onlineUrl,
        startsAt, endsAt,
        localDate: day, localStart: w.opensAt, localEnd: w.closesAt, timezone: tz,
        capacity: klass.capacity ?? null,
        status: 'scheduled',
        createdByUserId: ctx.principal.userId ?? null,
      }).onConflictDoNothing({ target: [sch.classSessions.classId, sch.classSessions.startsAt] }).returning();

      if (inserted.length) result.created++;
      else result.skippedExisting++;
    }
  }

  await writeAudit(db, ctx, {
    entityType: 'dojo_class', entityId: classId, action: 'update',
    newValue: { generated: result.created, from: fromIso, to: toIso, refused: result.refused.length },
  });
  return result;
}

async function loadClass(db: DB, classId: number): Promise<any> {
  const rows = await db.select().from(sch.dojoClasses).where(eq(sch.dojoClasses.id, classId)).limit(1);
  if (!rows.length) throw new SchedulingError('not_found', `No class ${classId}.`);
  return rows[0];
}

// ═══════════════════════════════════════════════════════════════════════════
// CONFLICTS
// ═══════════════════════════════════════════════════════════════════════════

export interface ConflictReport {
  kind: 'coach_double_booked' | 'venue_double_booked' | 'coach_unavailable' | 'venue_blackout' | 'outside_facility_hours' | 'facility_closed' | 'capacity';
  detail: string;
  /** What it collides with, for a screen that offers to open it. */
  withKind?: 'class_session' | 'booking' | 'blackout' | 'availability';
  withId?: number | null;
}

export interface ConflictQuery {
  startsAt: Date;
  endsAt: Date;
  venueId?: number | null;
  coachPersonId?: number | null;
  /** When re-checking an existing session, do not report it colliding with itself. */
  excludeSessionId?: number | null;
  excludeBookingId?: number | null;
}

/**
 * Everything that would make this slot a lie.
 *
 * Returns a LIST, and the list is empty when the slot is clean. Callers decide
 * whether a conflict is fatal — generation refuses by default, an administrator
 * placing a one-off session may be shown them and allowed to proceed — but no
 * caller gets to be unaware of one. "Do not allow silent double booking" is the
 * requirement, and the operative word is silent.
 *
 * NOT PROVEN, AND SAID OUT LOUD: this is a READ. It tells the truth about the
 * moment it ran. The guarantee that two simultaneous writers cannot both pass
 * it comes from the transaction and the advisory lock in `bookClassSession()`
 * and in src/db/booking.ts — not from here.
 */
export async function detectConflicts(db: DB, q: ConflictQuery): Promise<ConflictReport[]> {
  const out: ConflictReport[] = [];
  const startsAt = q.startsAt;
  const endsAt = q.endsAt;
  if (!(startsAt instanceof Date) || !(endsAt instanceof Date) || Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new SchedulingError('bad_range', 'A conflict check needs two real instants.');
  }
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new SchedulingError('bad_range', 'A session must end after it starts.');
  }

  const overlapsSession = (table: any) => and(
    lt(table.startsAt, endsAt),
    sql`${table.endsAt} > ${startsAt}`
  );

  if (q.coachPersonId) {
    const clashes = await db.select({
      id: sch.classSessions.id, ref: sch.classSessions.ref,
      startsAt: sch.classSessions.startsAt, endsAt: sch.classSessions.endsAt,
    }).from(sch.classSessions).where(and(
      eq(sch.classSessions.coachPersonId, q.coachPersonId),
      inArray(sch.classSessions.status, ['scheduled', 'delivered']),
      overlapsSession(sch.classSessions)
    ));
    for (const c of clashes) {
      if (q.excludeSessionId && c.id === q.excludeSessionId) continue;
      out.push({
        kind: 'coach_double_booked',
        detail: `the coach already teaches ${c.ref} at that time`,
        withKind: 'class_session', withId: c.id,
      });
    }

    const bookingClashes = await db.select({
      id: s.bookings.id, ref: s.bookings.ref,
    }).from(s.bookings).where(and(
      eq(s.bookings.coachPersonId, q.coachPersonId),
      inArray(s.bookings.status, ['requested', 'proposed', 'confirmed', 'rescheduled']),
      overlapsSession(s.bookings)
    ));
    for (const b of bookingClashes) {
      if (q.excludeBookingId && b.id === q.excludeBookingId) continue;
      out.push({
        kind: 'coach_double_booked',
        detail: `the coach has booking ${b.ref} at that time`,
        withKind: 'booking', withId: b.id,
      });
    }

    // A coach's diary says where they are NOT. `leave` and `travel` are as
    // disqualifying as an existing class, and the reason is never repeated here
    // — see the privacy note in src/db/booking.ts.
    const away = await db.select({ id: s.coachAvailability.id, kind: s.coachAvailability.kind })
      .from(s.coachAvailability).where(and(
        eq(s.coachAvailability.personId, q.coachPersonId),
        inArray(s.coachAvailability.kind, ['unavailable', 'leave', 'travel']),
        lt(s.coachAvailability.startsAt, endsAt),
        sql`${s.coachAvailability.endsAt} > ${startsAt}`
      ));
    for (const a of away) {
      out.push({
        kind: 'coach_unavailable',
        detail: `the coach is recorded as ${String(a.kind).replace(/_/g, ' ')} at that time`,
        withKind: 'availability', withId: a.id,
      });
    }
  }

  if (q.venueId) {
    const clashes = await db.select({
      id: sch.classSessions.id, ref: sch.classSessions.ref,
    }).from(sch.classSessions).where(and(
      eq(sch.classSessions.venueId, q.venueId),
      inArray(sch.classSessions.status, ['scheduled', 'delivered']),
      overlapsSession(sch.classSessions)
    ));
    for (const c of clashes) {
      if (q.excludeSessionId && c.id === q.excludeSessionId) continue;
      out.push({
        kind: 'venue_double_booked',
        detail: `the room is already used by ${c.ref} at that time`,
        withKind: 'class_session', withId: c.id,
      });
    }

    const blackouts = await db.select({ id: ops.venueBlackouts.id, reason: ops.venueBlackouts.reason })
      .from(ops.venueBlackouts).where(and(
        eq(ops.venueBlackouts.venueId, q.venueId),
        lt(ops.venueBlackouts.startsAt, endsAt),
        sql`${ops.venueBlackouts.endsAt} > ${startsAt}`
      ));
    for (const b of blackouts) {
      out.push({
        kind: 'venue_blackout',
        detail: 'the room is closed for maintenance or an event at that time',
        withKind: 'blackout', withId: b.id,
      });
    }
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOKING A SEAT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A namespace of its own, so a class seat and a coach's diary never contend.
 *
 * src/db/booking.ts holds 42_710 for the coach diary lock and explains at
 * length why an advisory transaction lock is the right instrument here — no row
 * to forget to unlock, released by COMMIT or ROLLBACK, and no Postgres
 * extension required. The same reasoning applies unchanged; only the second
 * argument differs, and it is the SESSION id, so two sessions never block each
 * other and one session serialises perfectly.
 */
export const SESSION_LOCK_NAMESPACE = 42_711;

export interface SessionBooking {
  bookingId: number;
  ref: string;
  sessionId: number;
  personId: number;
  seatsRemaining: number | null;
}

/**
 * Take a seat in a class, or refuse.
 *
 * THE RULE THAT MATTERS MOST: A FULL CLASS DOES NOT TAKE A FIFTEENTH STUDENT.
 * "Read the count, then insert" is a race with a name — two requests both read
 * fourteen of fifteen, both insert, and the coach finds out on the mat. The
 * count and the insert therefore happen inside ONE transaction that begins by
 * taking `pg_advisory_xact_lock(SESSION_LOCK_NAMESPACE, sessionId)`.
 *
 * The database backs the same rule independently:
 * `class_sessions_capacity_ck` refuses a `booked_count` above `capacity`, so a
 * writer that bypassed this function still cannot overfill the room.
 */
export async function bookClassSession(
  db: DB, ctx: AuditContext,
  sessionId: number,
  personId: number,
  opts: { notes?: string | null } = {}
): Promise<SessionBooking> {
  if (!Number.isInteger(sessionId) || !Number.isInteger(personId)) {
    throw new SchedulingError('bad_input', 'A class booking needs a session and a person.');
  }

  return await db.transaction(async (tx: DB) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SESSION_LOCK_NAMESPACE}::int4, ${sessionId}::int4)`);

    const rows = await tx.select().from(sch.classSessions).where(eq(sch.classSessions.id, sessionId)).limit(1);
    if (!rows.length) throw new SchedulingError('not_found', `No class session ${sessionId}.`);
    const session = rows[0];

    if (session.status !== 'scheduled') {
      throw new SchedulingError(
        'not_bookable',
        `That session is ${String(session.status).replace(/_/g, ' ')}${session.cancelledReason ? ` — ${session.cancelledReason}` : ''}.`
      );
    }
    if (new Date(session.startsAt).getTime() <= Date.now()) {
      throw new SchedulingError('in_the_past', 'That session has already started.');
    }

    // Booking for yourself, or holding the authority to book for somebody else.
    const me = await ownPersonId(tx, ctx.principal);
    const isSelf = me != null && me === personId;
    if (!isSelf) {
      const klass = await loadClass(tx, session.classId);
      assertCan(ctx.principal, 'booking:write', await resourceForOwner(tx, { scope: klass.ownerScope, id: klass.ownerId ?? null }));
    }

    const already = await tx.select({ id: s.bookings.id, ref: s.bookings.ref })
      .from(s.bookings).where(and(
        eq(s.bookings.classSessionId, sessionId),
        eq(s.bookings.personId, personId),
        inArray(s.bookings.status, ['requested', 'proposed', 'confirmed', 'rescheduled'])
      )).limit(1);
    if (already.length) {
      throw new SchedulingError('already_booked', `That place is already held under ${already[0].ref}.`);
    }

    if (session.capacity != null && session.bookedCount >= session.capacity) {
      throw new SchedulingError(
        'full',
        `That session is full (${session.capacity} places). Nothing has been booked.`
      );
    }

    const ref = await allocateFederationId(tx, 'BKG');
    const booking = await tx.insert(s.bookings).values({
      ref, kind: 'class', status: 'confirmed',
      personId,
      classSessionId: sessionId,
      coachPersonId: session.coachPersonId ?? null,
      venue: null,
      mode: session.mode,
      startsAt: session.startsAt, endsAt: session.endsAt,
      capacity: 1,
      notes: opts.notes ?? null,
      createdByUserId: ctx.principal.userId ?? null,
    }).returning();

    const updated = await tx.update(sch.classSessions)
      .set({ bookedCount: sql`${sch.classSessions.bookedCount} + 1` })
      .where(eq(sch.classSessions.id, sessionId))
      .returning({ bookedCount: sch.classSessions.bookedCount, capacity: sch.classSessions.capacity });

    await writeAudit(tx, ctx, {
      entityType: 'booking', entityId: booking[0].id, action: 'create',
      newValue: { ref, sessionId, personId, kind: 'class' },
    });

    const remaining = updated[0].capacity == null ? null : updated[0].capacity - updated[0].bookedCount;
    return { bookingId: booking[0].id, ref, sessionId, personId, seatsRemaining: remaining };
  });
}

/** Release a seat, with a reason, and give the place back to the session. */
export async function cancelSessionBooking(
  db: DB, ctx: AuditContext, bookingId: number, reason: string
): Promise<{ sessionId: number; seatsRemaining: number | null }> {
  const why = (reason ?? '').trim();
  if (!why) throw new SchedulingError('reason_required', 'A cancellation must record why.');

  return await db.transaction(async (tx: DB) => {
    const rows = await tx.select().from(s.bookings).where(eq(s.bookings.id, bookingId)).limit(1);
    if (!rows.length) throw new SchedulingError('not_found', `No booking ${bookingId}.`);
    const booking = rows[0];
    if (!booking.classSessionId) {
      throw new SchedulingError('not_a_class_booking', 'That booking is not a class seat; cancel it through src/db/booking.ts.');
    }
    await tx.execute(sql`select pg_advisory_xact_lock(${SESSION_LOCK_NAMESPACE}::int4, ${booking.classSessionId}::int4)`);

    if (['cancelled', 'expired', 'no_show', 'completed'].includes(booking.status)) {
      throw new SchedulingError('not_cancellable', `That booking is already ${String(booking.status).replace(/_/g, ' ')}.`);
    }
    const me = await ownPersonId(tx, ctx.principal);
    const isSelf = me != null && me === booking.personId;
    if (!isSelf) {
      const session = await tx.select().from(sch.classSessions).where(eq(sch.classSessions.id, booking.classSessionId)).limit(1);
      const klass = await loadClass(tx, session[0].classId);
      assertCan(ctx.principal, 'booking:write', await resourceForOwner(tx, { scope: klass.ownerScope, id: klass.ownerId ?? null }));
    }

    await tx.update(s.bookings)
      .set({ status: 'cancelled', cancelledReason: why, updatedAt: new Date() })
      .where(eq(s.bookings.id, bookingId));

    const updated = await tx.update(sch.classSessions)
      .set({ bookedCount: sql`greatest(${sch.classSessions.bookedCount} - 1, 0)` })
      .where(eq(sch.classSessions.id, booking.classSessionId))
      .returning({ bookedCount: sch.classSessions.bookedCount, capacity: sch.classSessions.capacity });

    await writeAudit(tx, ctx, {
      entityType: 'booking', entityId: bookingId, action: 'update',
      oldValue: { status: booking.status }, newValue: { status: 'cancelled', reason: why },
    });

    return {
      sessionId: booking.classSessionId,
      seatsRemaining: updated[0].capacity == null ? null : updated[0].capacity - updated[0].bookedCount,
    };
  });
}

export interface BookableSession {
  id: number;
  ref: string;
  classId: number;
  className: string;
  slug: string;
  venueId: number | null;
  coachPersonId: number | null;
  mode: string;
  startsAt: Date;
  endsAt: Date;
  localDate: IsoDate;
  localStart: Wall;
  localEnd: Wall;
  timezone: string;
  capacity: number | null;
  bookedCount: number;
  seatsRemaining: number | null;
  requiresBooking: boolean;
}

/**
 * Sessions a member can genuinely take a place in.
 *
 * THE POINT OF THIS FUNCTION IS THE THINGS IT DOES NOT RETURN. A federation
 * booking page that lists every slot and then telephones you three days later
 * to say the coach was in Ranchi is the failure src/db/booking.ts was written
 * to prevent, and this is the same refusal for classes: cancelled sessions are
 * out, full sessions are out, sessions in the past are out, and — because the
 * room can be closed after the timetable was generated — sessions whose venue
 * has since been blacked out or whose day has since been declared a holiday are
 * out too. What is left is bookable.
 */
export async function bookableSessions(
  db: DB,
  filter: { classId?: number | null; venueId?: number | null; dojoId?: number | null },
  fromIso: IsoDate, toIso: IsoDate,
  opts: { includeFull?: boolean; now?: Date } = {}
): Promise<BookableSession[]> {
  assertIsoDate(fromIso, 'from');
  assertIsoDate(toIso, 'to');
  const now = opts.now ?? new Date();

  const conditions: any[] = [
    eq(sch.classSessions.status, 'scheduled'),
    gte(sch.classSessions.localDate, fromIso),
    lte(sch.classSessions.localDate, toIso),
  ];
  if (filter.classId) conditions.push(eq(sch.classSessions.classId, filter.classId));
  if (filter.venueId) conditions.push(eq(sch.classSessions.venueId, filter.venueId));

  const rows = await db.select({
    session: sch.classSessions,
    klass: sch.dojoClasses,
  }).from(sch.classSessions)
    .innerJoin(sch.dojoClasses, eq(sch.dojoClasses.id, sch.classSessions.classId))
    .where(and(
      ...conditions,
      eq(sch.dojoClasses.status, 'active'),
      filter.dojoId
        ? and(eq(sch.dojoClasses.ownerScope, 'dojo'), eq(sch.dojoClasses.ownerId, filter.dojoId))
        : sql`true`
    ))
    .orderBy(asc(sch.classSessions.startsAt));

  const out: BookableSession[] = [];
  for (const r of rows) {
    const session = r.session;
    const klass = r.klass;
    if (new Date(session.startsAt).getTime() <= now.getTime()) continue;
    const remaining = session.capacity == null ? null : session.capacity - session.bookedCount;
    if (!opts.includeFull && remaining != null && remaining <= 0) continue;

    // Re-check against the CURRENT state of the world, not the state at
    // generation. A holiday declared last week must remove a session generated
    // last month, and it does so here rather than by a sweep somebody forgot.
    const conflicts = await detectConflicts(db, {
      startsAt: new Date(session.startsAt), endsAt: new Date(session.endsAt),
      venueId: session.venueId, coachPersonId: session.coachPersonId,
      excludeSessionId: session.id,
    });
    if (conflicts.some((c) => c.kind === 'venue_blackout' || c.kind === 'coach_unavailable')) continue;

    if (session.venueId) {
      const day = await openingHoursOn(db, { purpose: 'training', venueId: session.venueId }, session.localDate, { asOf: session.localDate });
      if (!day.unconfigured && !day.open) continue;
    }

    out.push({
      id: session.id, ref: session.ref,
      classId: klass.id, className: klass.name, slug: klass.slug,
      venueId: session.venueId, coachPersonId: session.coachPersonId,
      mode: session.mode,
      startsAt: new Date(session.startsAt), endsAt: new Date(session.endsAt),
      localDate: session.localDate, localStart: session.localStart, localEnd: session.localEnd,
      timezone: session.timezone,
      capacity: session.capacity, bookedCount: session.bookedCount,
      seatsRemaining: remaining,
      requiresBooking: klass.requiresBooking,
    });
  }
  return out;
}

/**
 * Call a session off, and say why.
 *
 * Bookings on it are NOT silently dropped: they are cancelled, each with the
 * session's reason attached, so a member's own record explains what happened
 * rather than showing a place that has quietly vanished.
 */
export async function cancelSession(
  db: DB, ctx: AuditContext, sessionId: number, reason: string
): Promise<{ sessionId: number; bookingsCancelled: number }> {
  const why = (reason ?? '').trim();
  if (!why) throw new SchedulingError('reason_required', 'Cancelling a class must record why. Members are told this reason.');

  const rows = await db.select().from(sch.classSessions).where(eq(sch.classSessions.id, sessionId)).limit(1);
  if (!rows.length) throw new SchedulingError('not_found', `No class session ${sessionId}.`);
  const session = rows[0];
  const klass = await loadClass(db, session.classId);
  await assertMayWriteSchedule(db, ctx.principal, { scope: klass.ownerScope, id: klass.ownerId ?? null });

  if (session.status === 'cancelled') throw new SchedulingError('already_cancelled', 'That session is already cancelled.');

  return await db.transaction(async (tx: DB) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SESSION_LOCK_NAMESPACE}::int4, ${sessionId}::int4)`);

    const held = await tx.select({ id: s.bookings.id }).from(s.bookings).where(and(
      eq(s.bookings.classSessionId, sessionId),
      inArray(s.bookings.status, ['requested', 'proposed', 'confirmed', 'rescheduled'])
    ));
    if (held.length) {
      await tx.update(s.bookings)
        .set({ status: 'cancelled', cancelledReason: `Class cancelled: ${why}`, updatedAt: new Date() })
        .where(inArray(s.bookings.id, held.map((h: any) => h.id)));
    }

    await tx.update(sch.classSessions)
      .set({ status: 'cancelled', cancelledReason: why, bookedCount: 0 })
      .where(eq(sch.classSessions.id, sessionId));

    await writeAudit(tx, ctx, {
      entityType: 'class_session', entityId: sessionId, action: 'update',
      oldValue: { status: session.status, bookedCount: session.bookedCount },
      newValue: { status: 'cancelled', reason: why, bookingsCancelled: held.length },
    });

    return { sessionId, bookingsCancelled: held.length };
  });
}
