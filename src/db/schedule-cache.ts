// The register's cache.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IT IS FOR
// ═══════════════════════════════════════════════════════════════════════════
//
// `directoryDay()` answers "what does each of these clubs publish today" in a
// fixed twelve queries however many clubs are listed. That is bounded, and it is
// paid on every render of /dojos — one of the most requested pages on the site,
// whose answer changes perhaps twice a year per club.
//
// This module pays it once. On a hit the register costs TWO queries: the
// fingerprint, and the cached rows.
//
// ═══════════════════════════════════════════════════════════════════════════
// A CACHE THAT CAN BE EMPTY BUT CANNOT BE WRONG
// ═══════════════════════════════════════════════════════════════════════════
//
// This is the whole design, and every other decision here follows from it.
//
// A wrong cache publishes a club's old hours to a parent, who travels to a dojo
// that is shut. That failure is strictly worse than any amount of slowness, so
// the cache is built to make it structurally impossible rather than merely
// unlikely:
//
//   · A row is usable only while its `fingerprint` equals the CURRENT
//     fingerprint of the entire scheduling configuration.
//   · The fingerprint is COARSE — it covers every schedule, version, season and
//     exception in the federation. One club publishing invalidates every cached
//     day everywhere.
//   · There is no targeted invalidation and there must not be. Working out which
//     clubs a change affects is a second model of the inheritance chain, and the
//     day it disagrees with `resolveSchedule()` is the day the site lies. Coarse
//     invalidation cannot disagree with anything.
//   · Nothing writes here except this file, and nothing reads the payload as
//     authority. Truncate the table and the only consequence is a slower render.
//
// COUNTS ARE IN THE DIGEST, NOT ONLY TIMESTAMPS. A DELETE moves no timestamp: if
// an administrator removed an exception that was not the newest one, `max(
// created_at)` would be unchanged and every cached day would stay intact and
// wrong. The row counts change on any delete, so they are digested too.
//
// RULES HAVE NO TIMESTAMP, AND NEED NONE. `setRules()` refuses to touch anything
// but a draft, and a draft is invisible to every read in the engine. A draft's
// rules become readable only when the version is published, which stamps
// `published_at` — which is digested. The one table without a timestamp is the
// one table whose changes cannot affect a published answer.

import { and, eq, inArray, sql } from 'drizzle-orm';
import * as sch from './scheduling.schema';
import { directoryDay, type DirectoryDay } from './schedule-directory';
import type { IsoDate } from './scheduling';

type DB = any;

/** How many (club, day) rows one call will write back. A register page, not a year. */
const MAX_WRITE_BACK = 600;

export interface CacheOutcome {
  /** Clubs answered from the cache. */
  hits: number;
  /** Clubs that had to be resolved. */
  misses: number;
  /** False when the cache could not be used at all — see `reason`. */
  used: boolean;
  /** Why the cache was skipped, when it was. Never a silent fallback. */
  reason: string | null;
  fingerprint: string;
}

/**
 * A digest of the whole scheduling configuration, in one query.
 *
 * Four aggregates, unioned: the row count and the newest relevant timestamp of
 * `schedules`, `schedule_versions`, `seasons` and `schedule_exceptions`. For
 * versions the timestamp is the greatest of published_at, withdrawn_at and
 * created_at, because publication and withdrawal are what change a PUBLISHED
 * answer and neither touches created_at.
 *
 * Deliberately one opaque string. Callers compare it; they never interpret it.
 * A structured fingerprint invites somebody to reason about WHICH part changed,
 * which is the targeted invalidation this design refuses.
 */
export async function scheduleFingerprint(db: DB): Promise<string> {
  const rows = await db.execute(sql`
    select 'sch' as k, count(*)::text as n,
           coalesce(max(greatest(updated_at, created_at))::text, '-') as t
      from schedules
    union all
    select 'ver', count(*)::text,
           coalesce(max(greatest(coalesce(published_at, created_at),
                                 coalesce(withdrawn_at, created_at),
                                 created_at))::text, '-')
      from schedule_versions
    union all
    select 'sea', count(*)::text,
           coalesce(max(greatest(updated_at, created_at))::text, '-')
      from seasons
    union all
    select 'exc', count(*)::text, coalesce(max(created_at)::text, '-')
      from schedule_exceptions
  `);
  return digestRows(rows);
}

function digestRows(result: any): string {
  const rows: any[] = Array.isArray(result) ? result : (result?.rows ?? []);
  return rows
    .map((r: any) => `${r.k}:${r.n}:${r.t}`)
    .sort()
    .join('|');
}

/**
 * `directoryDay()`, cached.
 *
 * Same signature, same answer, same guarantees — a club that has published
 * nothing is still PRESENT in the map with `configured: false`, because "we
 * asked and they have not said" is a different answer from "we did not ask" and
 * caching must not blur the two.
 *
 * THE CACHE IS NEVER LOAD-BEARING. Every failure path below falls through to a
 * direct resolve and records why in `outcome.reason`. A register that went blank
 * because a cache table was missing would be the cache causing the outage it
 * exists to prevent.
 */
export async function cachedDirectoryDay(
  db: DB, dojoIds: number[], dayIso: IsoDate,
): Promise<{ days: Map<number, DirectoryDay>; outcome: CacheOutcome }> {
  const ids = [...new Set(dojoIds.filter((n) => Number.isInteger(n) && n > 0))];
  const empty: CacheOutcome = { hits: 0, misses: 0, used: true, reason: null, fingerprint: '' };
  if (!ids.length) return { days: new Map(), outcome: empty };

  let fingerprint = '';
  try {
    fingerprint = await scheduleFingerprint(db);
  } catch (err) {
    // No fingerprint, no cache — and a resolve rather than a failure.
    return {
      days: await directoryDay(db, ids, dayIso),
      outcome: { hits: 0, misses: ids.length, used: false, reason: 'fingerprint unavailable', fingerprint: '' },
    };
  }

  const days = new Map<number, DirectoryDay>();
  let hits = 0;

  try {
    const cached = await db.select().from(sch.scheduleDayCache).where(and(
      inArray(sch.scheduleDayCache.dojoId, ids),
      eq(sch.scheduleDayCache.onDate, dayIso),
      // The fingerprint IS the validity check. A row from a previous
      // configuration is not read, not repaired and not trusted.
      eq(sch.scheduleDayCache.fingerprint, fingerprint),
    ));
    for (const row of cached) {
      const payload = row.payload as DirectoryDay | null;
      // A payload that does not look like one is discarded rather than served.
      // The table is derived state; nothing here is worth defending.
      if (payload && typeof payload === 'object' && 'configured' in payload) {
        days.set(row.dojoId, { ...payload, dojoId: row.dojoId, date: dayIso });
        hits++;
      }
    }
  } catch (err) {
    return {
      days: await directoryDay(db, ids, dayIso),
      outcome: { hits: 0, misses: ids.length, used: false, reason: 'cache unreadable', fingerprint },
    };
  }

  const missing = ids.filter((id) => !days.has(id));
  if (!missing.length) {
    return { days, outcome: { hits, misses: 0, used: true, reason: null, fingerprint } };
  }

  // The misses cost exactly what they always cost: one batched resolve.
  const resolved = await directoryDay(db, missing, dayIso);
  for (const [id, day] of resolved) days.set(id, day);

  await writeBack(db, resolved, dayIso, fingerprint);

  return { days, outcome: { hits, misses: missing.length, used: true, reason: null, fingerprint } };
}

/**
 * Store what was just resolved.
 *
 * A write-back failure is not an error the reader should ever see: the answer is
 * already in hand and correct, and the only consequence is that the next render
 * resolves again. Swallowed deliberately, and narrowly — the read path above
 * reports its own failures through `outcome.reason`.
 */
async function writeBack(
  db: DB, resolved: Map<number, DirectoryDay>, dayIso: IsoDate, fingerprint: string,
): Promise<void> {
  const values = [...resolved.entries()].slice(0, MAX_WRITE_BACK).map(([dojoId, day]) => ({
    dojoId, onDate: dayIso, fingerprint, payload: day as any,
  }));
  if (!values.length) return;

  try {
    await db.insert(sch.scheduleDayCache).values(values).onConflictDoUpdate({
      target: [sch.scheduleDayCache.dojoId, sch.scheduleDayCache.onDate],
      set: {
        fingerprint: sql`excluded.fingerprint`,
        payload: sql`excluded.payload`,
        computedAt: sql`now()`,
      },
    });
  } catch (err) {
    console.warn('[schedule-cache] write-back failed; the answer served was resolved directly', err);
  }
}

/**
 * Drop rows that can never be used again.
 *
 * Two kinds: days that have passed, and rows from a configuration that has moved
 * on. Neither is read — a stale fingerprint fails the equality check and a past
 * date is never asked for — so this is housekeeping, not correctness, and it
 * belongs on the scheduled sweep rather than on a request.
 *
 * Returns what it removed, because a sweep that reports nothing is a sweep
 * nobody can tell has stopped working.
 */
export async function sweepScheduleCache(
  db: DB, opts: { onOrAfter: IsoDate },
): Promise<{ expired: number; superseded: number }> {
  const fingerprint = await scheduleFingerprint(db);

  const expired = await db.delete(sch.scheduleDayCache)
    .where(sql`${sch.scheduleDayCache.onDate} < ${opts.onOrAfter}`)
    .returning({ id: sch.scheduleDayCache.id });

  const superseded = await db.delete(sch.scheduleDayCache)
    .where(sql`${sch.scheduleDayCache.fingerprint} <> ${fingerprint}`)
    .returning({ id: sch.scheduleDayCache.id });

  return { expired: expired.length, superseded: superseded.length };
}
