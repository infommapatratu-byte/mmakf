// The register's cache, held to the only standard that matters.
//
// A cache on a public timetable is a liability before it is an optimisation.
// Wrong, it publishes a club's old hours to a parent who travels to a dojo that
// is shut — strictly worse than any amount of slowness. So this suite spends
// almost all of its assertions on staleness and almost none on speed:
//
//   1. THE ANSWER IS THE SAME. Cached and uncached must be indistinguishable,
//      including the case that matters most — a club that has published nothing
//      is PRESENT with `configured: false`, never dropped and never closed.
//
//   2. EVERY WAY THE CONFIGURATION CAN MOVE INVALIDATES IT. Publishing a
//      successor, adding an exception, REMOVING an exception, moving a season.
//      The remove case is the one a timestamp-only fingerprint would miss, and
//      it is why the digest counts rows as well.
//
//   3. IT IS NEVER LOAD-BEARING. With the table missing entirely the register
//      still answers, correctly, and says why it could not use the cache.
//
// The speed assertion is last and is the least important thing here.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  createSchedule, draftVersion, publishVersion, defineSeason, moveSeason,
  addException, removeException,
  type ScheduleOwner, type RuleInput,
} from '../src/db/scheduling';
import { directoryDay } from '../src/db/schedule-directory';
import { cachedDirectoryDay, scheduleFingerprint, sweepScheduleCache } from '../src/db/schedule-cache';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

const nat: Principal = {
  userId: 1,
  label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const ctx: AuditContext = { principal: nat, reason: 'test', authority: 'test' };

const DAY = '2026-09-14';          // a Monday
let db: any;
let STATE = 0;
let OPEN_CLUB = 0;                  // publishes a timetable
let SILENT_CLUB = 0;                // publishes nothing, ever
let scheduleId = 0;

const weekdays = (opensAt: string, closesAt: string): RuleInput[] =>
  [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, opensAt, closesAt, kind: 'open' as const }));

async function publish(owner: ScheduleOwner, name: string, rules: RuleInput[], from = '2020-01-01') {
  const schedule = await createSchedule(db, ctx, { name, purpose: 'training', owner });
  const version = await draftVersion(db, ctx, schedule.id, { effectiveFrom: from, rules });
  await publishVersion(db, ctx, version.id, 'test');
  return schedule.id;
}

/** Read through the cache, and report what it did. */
async function read(ids: number[] = [OPEN_CLUB, SILENT_CLUB]) {
  return cachedDirectoryDay(db, ids, DAY);
}

const windowsOf = (day: any) =>
  (day?.windows ?? []).map((w: any) => `${w.opensAt}-${w.closesAt}`);

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  await db.insert(s.users).values({ id: 1, email: 'nat@example.test', status: 'active' });

  const [st] = await db.insert(s.stateUnits)
    .values({ code: 'CA-ST', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  STATE = st.id;
  const dojos = await db.insert(s.dojos).values([
    { code: 'CA-OPEN', name: 'Cached Club', stateUnitId: STATE, status: 'active' },
    { code: 'CA-SILENT', name: 'Silent Club', stateUnitId: STATE, status: 'active' },
  ]).returning({ id: s.dojos.id });
  OPEN_CLUB = dojos[0].id;
  SILENT_CLUB = dojos[1].id;

  scheduleId = await publish({ scope: 'dojo', id: OPEN_CLUB }, 'Cached Club training', weekdays('18:00', '20:00'));
});

describe('the migration actually created the table', () => {
  it('schedule_day_cache exists and is empty', async () => {
    const rows = await db.execute(sql`select count(*)::int as n from schedule_day_cache`);
    const list = Array.isArray(rows) ? rows : (rows as any).rows;
    expect(Number(list[0].n)).toBe(0);
  });
});

describe('cached and uncached are the same answer', () => {
  it('agrees with directoryDay on a cold cache, and warms it', async () => {
    const direct = await directoryDay(db, [OPEN_CLUB, SILENT_CLUB], DAY);
    const { days, outcome } = await read();

    expect(outcome.used).toBe(true);
    expect(outcome.hits, 'a cold cache hits nothing').toBe(0);
    expect(outcome.misses).toBe(2);

    expect(windowsOf(days.get(OPEN_CLUB))).toEqual(windowsOf(direct.get(OPEN_CLUB)));
    expect(days.get(OPEN_CLUB)!.configured).toBe(true);
    // The club that has said nothing is PRESENT and unconfigured, through the
    // cache exactly as without it.
    expect(days.get(SILENT_CLUB)).toBeTruthy();
    expect(days.get(SILENT_CLUB)!.configured).toBe(false);
  });

  it('serves the second read from the cache, unchanged', async () => {
    const { days, outcome } = await read();
    expect(outcome.hits, 'both clubs should now be cached').toBe(2);
    expect(outcome.misses).toBe(0);
    expect(windowsOf(days.get(OPEN_CLUB))).toEqual(['18:00-20:00']);
    expect(days.get(SILENT_CLUB)!.configured).toBe(false);
  });

  it('caches the unconfigured answer too, rather than re-resolving it forever', async () => {
    const rows = await db.execute(sql`select dojo_id from schedule_day_cache order by dojo_id`);
    const list = Array.isArray(rows) ? rows : (rows as any).rows;
    expect(list.length).toBe(2);
  });
});

describe('every way the configuration moves invalidates it', () => {
  it('publishing a successor', async () => {
    const before = await scheduleFingerprint(db);
    const version = await draftVersion(db, ctx, scheduleId, {
      effectiveFrom: '2026-09-01', rules: weekdays('17:00', '19:00'),
    });
    await publishVersion(db, ctx, version.id, 'moved an hour earlier');

    expect(await scheduleFingerprint(db), 'publishing must change the fingerprint').not.toBe(before);

    const { days, outcome } = await read();
    expect(outcome.hits, 'the old rows must not be served').toBe(0);
    expect(windowsOf(days.get(OPEN_CLUB)), 'the NEW hours').toEqual(['17:00-19:00']);
  });

  it('adding an exception', async () => {
    await read();                                   // warm
    const before = await scheduleFingerprint(db);
    await addException(db, ctx, {
      scheduleId, onDate: DAY, kind: 'holiday', effect: 'closed', reason: 'Public holiday',
    });
    expect(await scheduleFingerprint(db)).not.toBe(before);

    const { days, outcome } = await read();
    expect(outcome.hits).toBe(0);
    expect(days.get(OPEN_CLUB)!.open, 'closed by the exception').toBe(false);
    expect(days.get(OPEN_CLUB)!.configured, 'closed is not unconfigured').toBe(true);
  });

  it('REMOVING an exception — the case a timestamp alone would miss', async () => {
    // Two exceptions, then delete the OLDER one. max(created_at) is unchanged,
    // so a fingerprint made only of timestamps would leave every cached day
    // intact and wrong. The row counts are in the digest for exactly this.
    const older = await addException(db, ctx, {
      scheduleId, onDate: '2026-09-15', kind: 'maintenance', effect: 'closed', reason: 'Floor work',
    });
    await addException(db, ctx, {
      scheduleId, onDate: '2026-09-16', kind: 'seminar', effect: 'closed', reason: 'Seminar',
    });
    await read();                                   // warm on this configuration

    const maxBefore = await newestExceptionAt();
    const before = await scheduleFingerprint(db);

    await removeException(db, ctx, older.id, 'Cancelled the maintenance');

    expect(await newestExceptionAt(), 'the newest exception is untouched by design')
      .toBe(maxBefore);
    expect(await scheduleFingerprint(db), 'the digest must still move, on the count')
      .not.toBe(before);

    const { outcome } = await read();
    expect(outcome.hits, 'the cache must have been invalidated by the delete').toBe(0);
  });

  it('moving a season', async () => {
    const season = await defineSeason(db, ctx, {
      code: 'ca-summer', name: 'Summer', owner: { scope: 'dojo', id: OPEN_CLUB },
      startsOn: '2026-04-01', endsOn: '2026-09-30', activate: true,
    });
    await read();                                   // warm
    const before = await scheduleFingerprint(db);
    await moveSeason(db, ctx, season.id, { startsOn: '2026-04-01', endsOn: '2026-10-31' });
    expect(await scheduleFingerprint(db)).not.toBe(before);
    expect((await read()).outcome.hits).toBe(0);
  });
});

async function newestExceptionAt(): Promise<string> {
  const rows = await db.execute(sql`select coalesce(max(created_at)::text, '-') as t from schedule_exceptions`);
  const list = Array.isArray(rows) ? rows : (rows as any).rows;
  return String(list[0].t);
}

describe('the cache is never load-bearing', () => {
  it('answers correctly with the cache table dropped, and says why', async () => {
    // Not a hypothetical: a deployment mid-migration has the code and not the
    // table. A register that went blank because of its own cache would be the
    // cache causing the outage it exists to prevent.
    await db.execute(sql`ALTER TABLE schedule_day_cache RENAME TO schedule_day_cache_hidden`);
    try {
      const { days, outcome } = await read();
      expect(outcome.used).toBe(false);
      expect(outcome.reason).toBeTruthy();
      // The ANSWER is still right, which is the whole point.
      const direct = await directoryDay(db, [OPEN_CLUB, SILENT_CLUB], DAY);
      expect(windowsOf(days.get(OPEN_CLUB))).toEqual(windowsOf(direct.get(OPEN_CLUB)));
      expect(days.get(SILENT_CLUB)!.configured).toBe(false);
    } finally {
      await db.execute(sql`ALTER TABLE schedule_day_cache_hidden RENAME TO schedule_day_cache`);
    }
  });
});

describe('housekeeping', () => {
  it('sweeps past days and rows from a configuration that has moved on', async () => {
    await read();                                   // warm on the current configuration
    await db.insert(s.dojos).values({ code: 'CA-X', name: 'Sweep Club', stateUnitId: STATE, status: 'active' });

    // A row for a day that has passed, and one from an older configuration.
    await db.execute(sql`
      insert into schedule_day_cache (dojo_id, on_date, fingerprint, payload)
      values (${OPEN_CLUB}, '2020-01-01', 'whatever', '{"configured":false}'::jsonb),
             (${SILENT_CLUB}, '2027-01-01', 'a-fingerprint-from-last-year', '{"configured":false}'::jsonb)
    `);

    const swept = await sweepScheduleCache(db, { onOrAfter: DAY });
    expect(swept.expired, 'the 2020 row is past').toBeGreaterThanOrEqual(1);
    expect(swept.superseded, 'the stale-fingerprint row').toBeGreaterThanOrEqual(1);

    // And the sweep left the usable rows alone.
    const { outcome } = await read();
    expect(outcome.hits).toBe(2);
  });
});

describe('and it is faster', () => {
  it('costs fewer queries on a hit than resolving would', async () => {
    await read();                                   // warm

    const counted = (target: any) => {
      let calls = 0;
      const proxy = new Proxy(target, {
        get(obj, prop, receiver) {
          if (prop === 'select') { calls++; return obj.select.bind(obj); }
          if (prop === 'execute') { calls++; return obj.execute.bind(obj); }
          const v = Reflect.get(obj, prop, receiver);
          return typeof v === 'function' ? v.bind(obj) : v;
        },
      });
      return { proxy, count: () => calls };
    };

    const hit = counted(db);
    await cachedDirectoryDay(hit.proxy, [OPEN_CLUB, SILENT_CLUB], DAY);

    const cold = counted(db);
    await directoryDay(cold.proxy, [OPEN_CLUB, SILENT_CLUB], DAY);

    // The fingerprint and the cache read. Two, against the resolver's dozen.
    expect(hit.count()).toBeLessThan(cold.count());
    expect(hit.count()).toBeLessThanOrEqual(3);
  });
});
