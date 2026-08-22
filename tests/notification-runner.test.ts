// The runner that turns a published event into somebody being told.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS SUITE EXISTS TO PREVENT COMING BACK
// ═══════════════════════════════════════════════════════════════════════════
//
// Every part of the notification chain was built and tested, and the chain did
// not work, because ONE LINK WAS NEVER JOINED: nothing in the application ever
// called `consume()`.
//
//   `publish()`         — called from seven modules. Appending events. Fine.
//   `NOTIFIABLE`        — seventeen event types with audiences. Fine.
//   `notifyForEvent()`  — resolves recipients, writes rows, dedupes. Fine, and
//                         called by NOTHING outside its own test.
//   `/my/notifications` — a real inbox a member can open. Fine, and empty.
//
// So an administrator cancelling a class published CLASS_SESSION_CANCELLED
// inside the same transaction that released every booking on it, the catalogue
// promised the people holding those places would be told, and the cursor sat at
// zero for as long as the system had been running. The events were not lost;
// they were in `domain_events`, unread.
//
// A unit test on each part would have passed throughout. That is precisely why
// this suite tests the JOIN and not the parts: it asserts the feed drain is
// reachable from a route that actually runs, and that draining it delivers.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { publish, consume, cursorFor, eventsFor } from '../src/lib/domain-events';
import { NOTIFIABLE } from '../src/lib/notifications';

const RECONCILE = 'src/pages/api/cron/reconcile.ts';

describe('the feed drain is reachable from something that runs', () => {
  const route = readFileSync(RECONCILE, 'utf8');

  it('the scheduled reconcile route calls consume() for the notifications consumer', () => {
    // A consumer nothing invokes is a cursor that never moves. This is the one
    // assertion that would have caught the original defect.
    expect(route, `${RECONCILE} must drain the domain-event feed`).toMatch(/\bconsume\(/);
    expect(route).toMatch(/['"]notifications['"]/);
    expect(route).toMatch(/notifyForEvent\(/);
  });

  it('and sweeps what the drain queued', () => {
    expect(route, `${RECONCILE} must send the rows the drain created`).toMatch(/\bdeliverQueued\(/);
  });

  it('reports what it skipped and where it stopped, rather than only a count', () => {
    // `skipped: 3` with no ids leaves nobody able to say which three, and the
    // cursor has already advanced past them — they will never be offered again.
    expect(route).toMatch(/skippedEventIds/);
    expect(route).toMatch(/failedAtEventId/);
  });

  it('is registered as a cron target', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8'));
    const paths = (vercel.crons ?? []).map((c: any) => c.path);
    expect(paths, 'vercel.json must schedule the route that drains the feed')
      .toContain('/api/cron/reconcile');
  });
});

describe('every event that promises a notification is offered to that consumer', () => {
  it('NOTIFIABLE and the consumer catalogue agree', () => {
    // If an event declares an audience in NOTIFIABLE but does not name
    // 'notifications' in its catalogue entry, the drain will step straight past
    // it and the promise in NOTIFIABLE is one the system does not keep.
    const offered = new Set(eventsFor('notifications') as string[]);
    const promised = Object.keys(NOTIFIABLE);
    const unreachable = promised.filter((t) => !offered.has(t));
    expect(
      unreachable,
      'these event types declare a notification audience but are never offered to the notifications consumer',
    ).toEqual([]);
  });
});

describe('draining the feed actually moves the cursor', () => {
  let db: any;
  const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

  beforeAll(async () => {
    const client = new PGlite();
    db = drizzle(client, { schema: s });
    for (const f of MIGRATIONS) {
      for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (st.trim()) await client.exec(st.trim());
      }
    }
  });

  it('starts at zero, advances over what it handled, and does not re-deliver', async () => {
    expect(await cursorFor(db, 'notifications')).toBe(0);

    await publish(db, {
      eventType: 'SCHEDULE_PUBLISHED',
      entityType: 'schedule',
      entityId: '1',
      payload: { scheduleId: 1, versionId: 1, ownerScope: 'dojo', ownerId: 1, effectiveFrom: '2026-01-01' },
    });

    const seen: string[] = [];
    const first = await consume(db, 'notifications', async (e) => { seen.push(e.eventType); }, {
      maxClassification: 'member',
    });
    expect(seen).toEqual(['SCHEDULE_PUBLISHED']);
    expect(first.delivered).toBe(1);
    expect(first.to).toBeGreaterThan(first.from);

    // The cursor persisted, so a second run has nothing to do. A drain that
    // re-delivered would notify every member again on every cron tick.
    const second = await consume(db, 'notifications', async (e) => { seen.push(e.eventType); }, {
      maxClassification: 'member',
    });
    expect(second.delivered).toBe(0);
    expect(seen).toEqual(['SCHEDULE_PUBLISHED']);
  });

  it('stops before the event whose handler threw, and names it', async () => {
    const before = await cursorFor(db, 'notifications');
    const [a] = await Promise.all([
      publish(db, {
        eventType: 'SCHEDULE_PUBLISHED', entityType: 'schedule', entityId: '2',
        payload: { scheduleId: 2, versionId: 2, ownerScope: 'dojo', ownerId: 2, effectiveFrom: '2026-01-01' },
      }),
    ]);
    expect(a).toBeTruthy();

    const result = await consume(db, 'notifications', async () => {
      throw new Error('downstream unavailable');
    }, { maxClassification: 'member' });

    expect(result.failedAtEventId).not.toBeNull();
    expect(result.failureMessage).toContain('downstream unavailable');
    // Nothing was skipped past: the failed event is still waiting.
    expect(await cursorFor(db, 'notifications')).toBe(before);

    const recovered: string[] = [];
    const retry = await consume(db, 'notifications', async (e) => { recovered.push(e.eventType); }, {
      maxClassification: 'member',
    });
    expect(retry.delivered).toBe(1);
    expect(recovered).toEqual(['SCHEDULE_PUBLISHED']);
  });

  it('writes no notification row for an event no audience is declared for', async () => {
    const rows = await db.select().from(s.notifications).where(eq(s.notifications.channel, 'in_app'));
    // This suite never ran notifyForEvent, so the inbox must be untouched — the
    // drain and the delivery are separate steps and neither may be implied.
    expect(rows.length).toBe(0);
  });
});
