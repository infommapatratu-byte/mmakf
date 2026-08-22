// Directory-scale schedule resolution.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS AND WHY IT IS NOT `openingHoursOn` IN A LOOP
// ═══════════════════════════════════════════════════════════════════════════
//
// `openingHoursOn()` in src/db/scheduling.ts answers "what is open here on this
// day" for ONE target, and it is the canonical answer. It resolves the schedule,
// then the version, then the seasons, then the rules, then the exceptions —
// roughly six round trips per call.
//
// /dojos asks that question once per club. The register page therefore shipped
// with a cap of sixty clubs and a note apologising for it, because six hundred
// clubs would have meant three and a half thousand queries to render one list.
// A cap is not an architecture: it publishes some clubs' hours and not others,
// and which ones depends on alphabetical order.
//
// This module answers the same question for a SET of clubs in a fixed number of
// queries — twelve, whether the set holds two clubs or two thousand. Nothing
// about the answer changes; only the number of round trips taken to reach it.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DUPLICATION, AND WHAT MAKES IT SAFE
// ═══════════════════════════════════════════════════════════════════════════
//
// Composing a day from rules, seasons and exceptions is written twice: once in
// `openingHoursOn` for one target, once here for many. That is a real cost and
// it is taken deliberately, because the alternatives are worse — rewriting the
// canonical single-target resolver in terms of this one would put every booking
// path in the federation behind a set-based query it does not need, and calling
// the canonical one N times is the problem this module exists to remove.
//
// What makes the duplication safe is that it is not trusted. tests/schedule-
// directory.test.ts is a DIFFERENTIAL suite: for a fixture of clubs covering
// every shape that resolution can take — own schedule, district schedule, state
// schedule, national schedule, nothing at all, seasonal rules, closed-day
// exceptions, replace/add/remove exceptions — it asserts that this module and
// `openingHoursOn` return THE SAME WINDOWS for every club on every day. If the
// canonical resolver changes and this one does not, that suite fails by name.
// The tests are the contract; this comment is only the reason for it.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE INVARIANT THIS MODULE MUST NEVER BREAK
// ═══════════════════════════════════════════════════════════════════════════
//
// A CLUB THAT HAS PUBLISHED NOTHING RETURNS `configured: false`. It does not
// return an empty day, and it does not return the headquarters' hours. The
// federation's own site once published one club's clock as every club's, and a
// parent in Bokaro read that their child's dojo opened at six in the morning.
// `configured: false` renders as "ask the club", which is the truth.
//
// Where a club's answer DOES come from a level above it, `inheritedFrom` names
// that level and `isOwnSchedule` is false, so the surface can say whose hours
// these are. An inherited answer that does not say so is the same defect wearing
// a better disguise.

import { and, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import * as s from './schema';
import * as sch from './scheduling.schema';
import {
  DAY_NAMES,
  assertIsoDate,
  isoDayOfWeek,
  type IsoDate,
  type OwnerScope,
  type SchedulePurpose,
  type TimeWindow,
  type Wall,
} from './scheduling';

type DB = any;

// ═══════════════════════════════════════════════════════════════════════════
// WHAT A CALLER GETS BACK
// ═══════════════════════════════════════════════════════════════════════════

export interface DirectoryDay {
  dojoId: number;
  date: IsoDate;
  dayName: string;
  timezone: string;
  /**
   * FALSE means "this club has published nothing", which is NOT "closed".
   * Every surface must keep the two apart. See the invariant above.
   */
  configured: boolean;
  /** True only when the club has published hours; false on a genuine closed day too. */
  open: boolean;
  windows: TimeWindow[];
  /** Which question was answered: when the mat is free, or when the door is open. */
  purpose: SchedulePurpose | null;
  /** Named whenever the answer came from a level above the club. */
  inheritedFrom: OwnerScope | null;
  inheritedFromLabel: string | null;
  isOwnSchedule: boolean;
  /** Exception KINDS only — never the administrator's free-text reason. */
  exceptionKinds: string[];
  seasonNames: string[];
  scheduleId: number | null;
  versionId: number | null;
}

/** Matches LEVEL_LABEL in src/db/scheduling.ts, and is asserted equal by the tests. */
const LEVEL_LABEL: Record<OwnerScope, string> = {
  national: 'the national federation',
  state: 'the state association',
  district: 'the district association',
  dojo: 'the club',
  institution: 'the client organisation',
};

/**
 * Training first, then operating.
 *
 * "When can I train here" is the question a register row is asked, and a club
 * that has answered it specifically must not have its answer widened to the
 * building's opening hours. Same precedence as `publishedWeek()`; the
 * differential tests assert the two agree.
 */
const PURPOSE_ORDER: SchedulePurpose[] = ['training', 'operating'];

/** How far an explicit `inherits_from_schedule_id` chain is followed before it is refused. */
const MAX_EXPLICIT_PARENT_DEPTH = 8;

// ═══════════════════════════════════════════════════════════════════════════
// SPAN ALGEBRA — the same arithmetic the canonical resolver does, on minutes
// ═══════════════════════════════════════════════════════════════════════════

interface Span { s: number; e: number }

const toMin = (w: Wall): number => {
  const [h, m] = String(w).split(':').map(Number);
  return h * 60 + m;
};
const toWall = (min: number): Wall =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const spanOf = (w: TimeWindow): Span => ({ s: toMin(w.opensAt), e: toMin(w.closesAt) });

function subtractSpans(base: Span[], cuts: Span[]): Span[] {
  let out = base.filter((x) => x.e > x.s);
  for (const cut of cuts) {
    const next: Span[] = [];
    for (const b of out) {
      if (cut.e <= b.s || cut.s >= b.e) { next.push(b); continue; }
      if (cut.s > b.s) next.push({ s: b.s, e: cut.s });
      if (cut.e < b.e) next.push({ s: cut.e, e: b.e });
    }
    out = next.filter((x) => x.e > x.s);
  }
  return out;
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

// ═══════════════════════════════════════════════════════════════════════════
// OWNER CHAINS, BUILT FOR THE WHOLE SET AT ONCE
// ═══════════════════════════════════════════════════════════════════════════

interface Owner { scope: OwnerScope; id: number | null }

const ownerKey = (o: Owner): string => `${o.scope}:${o.id ?? 'null'}`;

/**
 * The chain for every club in two queries rather than two per club.
 *
 * Built FROM THE DATABASE, exactly as `ownerChain()` insists: a caller that
 * knows only a dojo id must still get the district and state above it, and a
 * caller must never be able to launder a schedule out of a unit the club does
 * not belong to by passing a mismatched id.
 */
async function chainsFor(db: DB, dojoIds: number[]): Promise<Map<number, Owner[]>> {
  const chains = new Map<number, Owner[]>();
  if (!dojoIds.length) return chains;

  const dojos = await db
    .select({ id: s.dojos.id, stateUnitId: s.dojos.stateUnitId, districtUnitId: s.dojos.districtUnitId })
    .from(s.dojos)
    .where(inArray(s.dojos.id, dojoIds));

  const districtIds = [...new Set(dojos.map((d: any) => d.districtUnitId).filter(Boolean))] as number[];
  const districtState = new Map<number, number | null>();
  if (districtIds.length) {
    const rows = await db
      .select({ id: s.districtUnits.id, stateUnitId: s.districtUnits.stateUnitId })
      .from(s.districtUnits)
      .where(inArray(s.districtUnits.id, districtIds));
    for (const r of rows) districtState.set(r.id, r.stateUnitId ?? null);
  }

  for (const d of dojos) {
    const districtUnitId: number | null = d.districtUnitId ?? null;
    const stateUnitId: number | null =
      d.stateUnitId ?? (districtUnitId ? districtState.get(districtUnitId) ?? null : null);

    const chain: Owner[] = [{ scope: 'dojo', id: d.id }];
    if (districtUnitId) chain.push({ scope: 'district', id: districtUnitId });
    if (stateUnitId) chain.push({ scope: 'state', id: stateUnitId });
    chain.push({ scope: 'national', id: null });
    chains.set(d.id, chain);
  }
  return chains;
}

/** One WHERE covering every (scope, id) pair in every chain. */
function ownerMatch(column: any, idColumn: any, owners: Owner[]) {
  const clauses = owners.map((o) =>
    o.id === null
      ? and(eq(column, o.scope as any), isNull(idColumn))
      : and(eq(column, o.scope as any), eq(idColumn, o.id)),
  );
  return clauses.length === 1 ? clauses[0] : or(...clauses);
}

// ═══════════════════════════════════════════════════════════════════════════
// THE READ
// ═══════════════════════════════════════════════════════════════════════════

/**
 * What each of these clubs publishes on one day.
 *
 * PUBLIC READ. Exception reasons are never loaded, so this function cannot leak
 * one by being called from the wrong place — the same guarantee
 * `publicTimetable()` gives by being a separate function rather than a flag.
 *
 * Returns a Map keyed by dojo id. A club with no entry in `dojoIds` is absent
 * from the map; a club that has published nothing is PRESENT with
 * `configured: false`, because "we asked and they have not said" is a different
 * answer from "we did not ask".
 */
export async function directoryDay(
  db: DB, dojoIds: number[], dayIso: IsoDate,
): Promise<Map<number, DirectoryDay>> {
  assertIsoDate(dayIso);
  const ids = [...new Set(dojoIds.filter((n) => Number.isInteger(n)))];
  const out = new Map<number, DirectoryDay>();
  if (!ids.length) return out;

  const dow = isoDayOfWeek(dayIso);
  const chains = await chainsFor(db, ids);

  // Every distinct owner mentioned by any chain, deduped — the set the two
  // owner-keyed queries below are scoped to.
  const owners: Owner[] = [];
  const seenOwner = new Set<string>();
  for (const chain of chains.values()) {
    for (const o of chain) {
      const k = ownerKey(o);
      if (seenOwner.has(k)) continue;
      seenOwner.add(k);
      owners.push(o);
    }
  }

  const unconfigured = (dojoId: number): DirectoryDay => ({
    dojoId, date: dayIso, dayName: DAY_NAMES[dow - 1], timezone: 'Asia/Kolkata',
    configured: false, open: false, windows: [], purpose: null,
    inheritedFrom: null, inheritedFromLabel: null, isOwnSchedule: false,
    exceptionKinds: [], seasonNames: [], scheduleId: null, versionId: null,
  });

  for (const id of ids) out.set(id, unconfigured(id));
  if (!owners.length) return out;

  // ── Every candidate schedule, both purposes, one query ────────────────────
  //
  // venue and class schedules are excluded exactly as the chain walk in
  // `resolveSchedule()` excludes them: a room's hours and a class's hours are
  // not a unit's hours.
  const scheduleRows = await db.select().from(sch.schedules).where(and(
    ownerMatch(sch.schedules.ownerScope, sch.schedules.ownerId, owners),
    inArray(sch.schedules.purpose, PURPOSE_ORDER as any),
    eq(sch.schedules.status, 'active'),
    isNull(sch.schedules.venueId),
    isNull(sch.schedules.classId),
  ));

  const byOwnerPurpose = new Map<string, any>();
  for (const r of scheduleRows) {
    byOwnerPurpose.set(`${r.ownerScope}:${r.ownerId ?? 'null'}:${r.purpose}`, r);
  }

  // ── Which schedule each club lands on, per purpose, in memory ─────────────
  interface Candidate { dojoId: number; purpose: SchedulePurpose; schedule: any; depth: number }
  const candidates: Candidate[] = [];
  for (const id of ids) {
    const chain = chains.get(id);
    if (!chain) continue;
    for (const purpose of PURPOSE_ORDER) {
      for (let depth = 0; depth < chain.length; depth++) {
        const hit = byOwnerPurpose.get(`${ownerKey(chain[depth])}:${purpose}`);
        if (hit) { candidates.push({ dojoId: id, purpose, schedule: hit, depth }); break; }
      }
    }
  }
  if (!candidates.length) return out;

  // ── The version in force on the day, for every candidate, one query ───────
  const versionFor = await versionsInForce(
    db, [...new Set(candidates.map((c) => c.schedule.id))], dayIso,
  );

  // An explicit parent is followed before the answer is abandoned — the same
  // escape hatch `withVersion()` gives a satellite that follows another club's
  // timetable. Bounded, and one query per level rather than one per club.
  const resolved = new Map<string, { schedule: any; version: any; depth: number }>();
  let pending = candidates.map((c) => ({ ...c, cursor: c.schedule, extra: 0 }));
  for (let hop = 0; hop <= MAX_EXPLICIT_PARENT_DEPTH && pending.length; hop++) {
    const stillPending: typeof pending = [];
    const wantParents: number[] = [];
    for (const p of pending) {
      const version = versionFor.get(p.cursor.id);
      if (version) {
        resolved.set(`${p.dojoId}:${p.purpose}`, {
          schedule: p.cursor, version, depth: p.depth + p.extra,
        });
        continue;
      }
      if (p.cursor.inheritsFromScheduleId) {
        wantParents.push(p.cursor.inheritsFromScheduleId);
        stillPending.push(p);
      }
    }
    if (!stillPending.length || !wantParents.length) break;

    const parents = await db.select().from(sch.schedules)
      .where(inArray(sch.schedules.id, [...new Set(wantParents)]));
    const parentById = new Map<number, any>(parents.map((r: any) => [r.id, r]));
    const parentVersions = await versionsInForce(db, parents.map((r: any) => r.id), dayIso);
    for (const [k, v] of parentVersions) versionFor.set(k, v);

    pending = stillPending
      .map((p) => {
        const next = parentById.get(p.cursor.inheritsFromScheduleId);
        return next ? { ...p, cursor: next, extra: p.extra + 1 } : null;
      })
      .filter(Boolean) as typeof pending;
  }

  // Training wins where a club resolved both.
  const chosen = new Map<number, { schedule: any; version: any; depth: number; purpose: SchedulePurpose }>();
  for (const id of ids) {
    for (const purpose of PURPOSE_ORDER) {
      const hit = resolved.get(`${id}:${purpose}`);
      if (hit) { chosen.set(id, { ...hit, purpose }); break; }
    }
  }
  if (!chosen.size) return out;

  const versionIds = [...new Set([...chosen.values()].map((c) => c.version.id))];
  const scheduleIds = [...new Set([...chosen.values()].map((c) => c.schedule.id))];

  // ── Rules for the weekday, one query ─────────────────────────────────────
  const ruleRows = await db.select().from(sch.scheduleRules).where(and(
    inArray(sch.scheduleRules.versionId, versionIds),
    eq(sch.scheduleRules.dayOfWeek, dow),
  )).orderBy(sch.scheduleRules.displayOrder, sch.scheduleRules.opensAt);
  const rulesByVersion = new Map<number, any[]>();
  for (const r of ruleRows) {
    const list = rulesByVersion.get(r.versionId) ?? [];
    list.push(r);
    rulesByVersion.set(r.versionId, list);
  }

  // ── Seasons in force, one query, resolved per chain in memory ────────────
  const seasonRows = await db.select().from(sch.seasons).where(and(
    ownerMatch(sch.seasons.ownerScope, sch.seasons.ownerId, owners),
    eq(sch.seasons.status, 'active'),
    lte(sch.seasons.startsOn, dayIso),
    gte(sch.seasons.endsOn, dayIso),
  ));
  const seasonsByOwner = new Map<string, any[]>();
  for (const r of seasonRows) {
    const k = `${r.ownerScope}:${r.ownerId ?? 'null'}`;
    const list = seasonsByOwner.get(k) ?? [];
    list.push(r);
    seasonsByOwner.set(k, list);
  }

  // ── Exceptions on the day, one query ─────────────────────────────────────
  const exceptionRows = await db.select().from(sch.scheduleExceptions).where(and(
    inArray(sch.scheduleExceptions.scheduleId, scheduleIds),
    eq(sch.scheduleExceptions.onDate, dayIso),
  ));
  const exceptionsBySchedule = new Map<number, any[]>();
  for (const r of exceptionRows) {
    const list = exceptionsBySchedule.get(r.scheduleId) ?? [];
    list.push(r);
    exceptionsBySchedule.set(r.scheduleId, list);
  }

  // ── Compose ──────────────────────────────────────────────────────────────
  for (const [dojoId, hit] of chosen) {
    const chain = chains.get(dojoId)!;
    // The season chain starts at the SCHEDULE's owner, then continues up the
    // club's chain — the same list `openingHoursOn` builds before calling
    // seasonsOn, and the reason a club on the state's timetable also gets the
    // state's seasons.
    const seasonChain = dedupe([
      { scope: hit.schedule.ownerScope, id: hit.schedule.ownerId ?? null } as Owner,
      ...chain,
    ]);
    const seasons = seasonsForChain(seasonChain, seasonsByOwner);
    const seasonIds = seasons.map((x: any) => x.id);

    const allRules = rulesByVersion.get(hit.version.id) ?? [];
    const seasonal = allRules.filter((r: any) => r.seasonId != null && seasonIds.includes(r.seasonId));
    const allYear = allRules.filter((r: any) => r.seasonId == null);
    // SPECIFICITY, NOT UNION — a season's rules replace the all-year rules for
    // the day. "And in summer, this instead", never "both at once".
    const active = seasonal.length ? seasonal : allYear;

    const seasonNameById = new Map(seasons.map((x: any) => [x.id, x.name]));
    let windows: TimeWindow[] = active
      .filter((r: any) => r.kind === 'open')
      .map((r: any) => ({
        opensAt: r.opensAt, closesAt: r.closesAt, label: r.label,
        source: 'rule' as const,
        seasonId: r.seasonId ?? null,
        seasonName: r.seasonId ? (seasonNameById.get(r.seasonId) ?? null) : null,
      }));

    const exceptions = exceptionsBySchedule.get(hit.schedule.id) ?? [];
    const closed = exceptions.find((r: any) => r.effect === 'closed');
    if (closed) {
      windows = [];
    } else {
      const replaces = exceptions.filter((r: any) => r.effect === 'replace');
      if (replaces.length) {
        windows = replaces.map((r: any) => ({
          opensAt: r.opensAt, closesAt: r.closesAt, label: r.kind,
          source: 'exception' as const, exceptionKind: r.kind,
        }));
      }
      for (const a of exceptions.filter((r: any) => r.effect === 'add')) {
        windows.push({
          opensAt: a.opensAt, closesAt: a.closesAt, label: a.kind,
          source: 'exception', exceptionKind: a.kind,
        });
      }
      const removes = exceptions.filter((r: any) => r.effect === 'remove');
      if (removes.length) {
        windows = applyCuts(windows, removes.map((r: any) => ({ s: toMin(r.opensAt), e: toMin(r.closesAt) })));
      }
    }
    windows.sort((a, b) => toMin(a.opensAt) - toMin(b.opensAt));

    const isOwn = hit.depth === 0;
    out.set(dojoId, {
      dojoId,
      date: dayIso,
      dayName: DAY_NAMES[dow - 1],
      timezone: hit.schedule.timezone ?? 'Asia/Kolkata',
      configured: true,
      open: windows.length > 0,
      windows,
      purpose: hit.purpose,
      inheritedFrom: isOwn ? null : (hit.schedule.ownerScope as OwnerScope),
      inheritedFromLabel: LEVEL_LABEL[hit.schedule.ownerScope as OwnerScope],
      isOwnSchedule: isOwn,
      exceptionKinds: [...new Set(exceptions.map((r: any) => String(r.kind)))],
      seasonNames: seasons.map((x: any) => x.name),
      scheduleId: hit.schedule.id,
      versionId: hit.version.id,
    });
  }

  return out;
}

/** Published or superseded versions whose effective window contains the day. */
async function versionsInForce(db: DB, scheduleIds: number[], dayIso: IsoDate): Promise<Map<number, any>> {
  const byScheduleId = new Map<number, any>();
  if (!scheduleIds.length) return byScheduleId;

  const rows = await db.select().from(sch.scheduleVersions).where(and(
    inArray(sch.scheduleVersions.scheduleId, scheduleIds),
    inArray(sch.scheduleVersions.status, ['published', 'superseded']),
    lte(sch.scheduleVersions.effectiveFrom, dayIso),
    or(isNull(sch.scheduleVersions.effectiveTo), gte(sch.scheduleVersions.effectiveTo, dayIso)),
  )).orderBy(sch.scheduleVersions.effectiveFrom);

  // Most recent start wins where two somehow cover the day. `publishVersion()`
  // prevents that; a database restored from two halves might not.
  for (const r of rows) byScheduleId.set(r.scheduleId, r);
  return byScheduleId;
}

function dedupe(chain: Owner[]): Owner[] {
  const seen = new Set<string>();
  const out: Owner[] = [];
  for (const o of chain) {
    const k = ownerKey(o);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

/**
 * The first level of the chain that has a season, with the inheritance rule
 * `seasonsOn()` applies: a level's OWN seasons all count; a level above it
 * contributes only the seasons it marked inheritable.
 */
function seasonsForChain(chain: Owner[], byOwner: Map<string, any[]>): any[] {
  for (let depth = 0; depth < chain.length; depth++) {
    const rows = byOwner.get(ownerKey(chain[depth])) ?? [];
    const usable = depth === 0 ? rows : rows.filter((r: any) => r.inheritable);
    if (usable.length) return usable;
  }
  return [];
}

/**
 * The register's one-line summary of a club's day.
 *
 * Kept here rather than in the page so that /dojos, a club page and a search
 * result cannot describe the same day in three different ways.
 */
export function summariseDay(day: DirectoryDay | null | undefined): string | null {
  if (!day || !day.configured) return null;
  if (!day.open) return 'Closed today';
  return day.windows.map((w) => `${w.opensAt}–${w.closesAt}`).join(' & ');
}

// ═══════════════════════════════════════════════════════════════════════════
// A RUN OF DAYS, FOR A SET OF CLUBS
// ═══════════════════════════════════════════════════════════════════════════

export interface DirectoryRange {
  from: IsoDate;
  to: IsoDate;
  /** Keyed by dojo id, then by ISO date. A club with nothing published is still present. */
  clubs: Map<number, DirectoryDay[]>;
}

/**
 * The longest run a caller may ask for. A fortnight is what a "this week and
 * next" surface needs; a year would be a query that holds the connection open
 * while somebody scrolls.
 */
export const MAX_RANGE_DAYS = 14;

/**
 * What each of these clubs publishes across a run of days.
 *
 * WHY THIS IS NOT `directoryDay()` IN A LOOP OVER DATES. It is — deliberately —
 * and the reason is worth writing down rather than optimising away. The
 * expensive part of resolution is the *rules and seasons for a weekday*, and
 * those differ per day: a season that starts mid-range changes which rules apply
 * on which side of the boundary, and an exception belongs to one date. Folding
 * fourteen days into one set of queries would mean fetching every rule for every
 * weekday and every exception in the range and re-deriving the specificity rules
 * in memory — a third implementation of the arithmetic, to save at most
 * fourteen bounded round trips.
 *
 * So the cost is fourteen times a FIXED number, not fourteen times the number of
 * clubs. Two thousand clubs over a fortnight cost what two clubs over a
 * fortnight cost, which is the property that mattered. The range is capped so
 * the multiplier cannot grow without a caller asking for it.
 */
export async function directoryRange(
  db: DB, dojoIds: number[], fromIso: IsoDate, toIso: IsoDate,
): Promise<DirectoryRange> {
  assertIsoDate(fromIso);
  assertIsoDate(toIso);
  if (toIso < fromIso) {
    throw new Error(`${fromIso}..${toIso} ends before it starts.`);
  }

  const days: IsoDate[] = [];
  for (let cursor = fromIso; cursor <= toIso; cursor = nextDay(cursor)) {
    days.push(cursor);
    if (days.length > MAX_RANGE_DAYS) {
      throw new Error(
        `A range may span at most ${MAX_RANGE_DAYS} days; ${fromIso}..${toIso} is longer. ` +
        'Ask for the days you are going to show.'
      );
    }
  }

  const ids = [...new Set(dojoIds.filter((n) => Number.isInteger(n) && n > 0))];
  const clubs = new Map<number, DirectoryDay[]>();
  for (const id of ids) clubs.set(id, []);

  for (const day of days) {
    const resolved = await directoryDay(db, ids, day);
    for (const id of ids) {
      const hit = resolved.get(id);
      if (hit) clubs.get(id)!.push(hit);
    }
  }

  return { from: fromIso, to: toIso, clubs };
}

/** One day on, without pulling in the engine's date helpers for a single call. */
function nextDay(dayIso: IsoDate): IsoDate {
  const t = Date.parse(`${dayIso}T00:00:00Z`) + 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Is this club open at all across the run?
 *
 * A club CLOSED on every day of the range is a different answer from a club that
 * has published nothing, and a "find a club open this weekend" surface needs to
 * tell them apart — the first is "not this weekend", the second is "ring them".
 */
export function openAtAnyPoint(days: DirectoryDay[]): 'open' | 'closed' | 'not_published' {
  if (!days.length || days.every((d) => !d.configured)) return 'not_published';
  return days.some((d) => d.open) ? 'open' : 'closed';
}
