// A club republishes its timings, and the people who train there are told.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FAILURE THIS SUITE EXISTS TO CATCH
// ═══════════════════════════════════════════════════════════════════════════
//
// This chain is six links long and every link is in a different file:
//
//   publishVersion()          src/db/scheduling.ts     writes the event
//     payload: ownerScope, ownerId, scheduleId, versionId, effectiveFrom
//   NOTIFIABLE                src/lib/notifications.ts declares audience 'unit_members'
//   resolveRecipients()       src/lib/notifications.ts READS payload.ownerScope
//                                                       and payload.ownerId
//   notifyForEvent()          src/lib/notifications.ts writes the inbox rows
//   consume()                 src/lib/domain-events.ts drains the feed
//   /api/cron/reconcile       the runner
//
// Every one of those has its own passing unit test, and the chain can still be
// dead: the resolver returns `[]` unless `payload.ownerScope === 'dojo'`, so a
// producer that stopped writing that one key would notify NOBODY, silently,
// while every test in the repository stayed green and the code kept looking
// correct. There is no error, no log line, and no failing assertion anywhere —
// just a club whose members are never told their Sunday class moved.
//
// So this suite does not test a link. It runs the whole chain against a real
// database and asserts that a named person, who trains at a named club, ends up
// with a row in their inbox.
//
// ═══════════════════════════════════════════════════════════════════════════
// AND THAT IT REACHES A CLUB'S MEMBERS AND NOBODY ELSE
// ═══════════════════════════════════════════════════════════════════════════
//
// The same fan-out that must happen for a club must NOT happen for a state or
// for the federation. "Every member in the country" is not something one
// administrator saving a form may trigger; a national announcement is a
// circular, which is a different act with a different approval path. Both
// directions are asserted.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, inArray } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  createSchedule, draftVersion, publishVersion,
  type ScheduleOwner, type RuleInput,
} from '../src/db/scheduling';
import { consume } from '../src/lib/domain-events';
import { notifyForEvent, NOTIFIABLE } from '../src/lib/notifications';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

const nat: Principal = {
  userId: 1,
  label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const ctx: AuditContext = { principal: nat, reason: 'test', authority: 'test' };

let db: any;
let STATE = 0;
let CLUB = 0;
let OTHER_CLUB = 0;

/** People who train at CLUB. */
let TRAINS_HERE: number[] = [];
/** Someone at a different club, who must hear nothing. */
let TRAINS_ELSEWHERE = 0;
/** Someone who has left. */
let LAPSED = 0;

const everyWeekday = (opensAt: string, closesAt: string): RuleInput[] =>
  [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, opensAt, closesAt, kind: 'open' as const }));

async function publishFor(owner: ScheduleOwner, name: string, rules: RuleInput[]): Promise<number> {
  const schedule = await createSchedule(db, ctx, { name, purpose: 'training', owner });
  const version = await draftVersion(db, ctx, schedule.id, { effectiveFrom: '2020-01-01', rules });
  await publishVersion(db, ctx, version.id, 'test publication');
  return version.id;
}

/** Drain the feed exactly as the reconcile cron does. */
async function drain() {
  return consume(db, 'notifications', async (e) => { await notifyForEvent(db, ctx, e); }, {
    maxClassification: 'member',
  });
}

async function inboxFor(personIds: number[]) {
  if (!personIds.length) return [];
  return db.select().from(s.notifications).where(inArray(s.notifications.personId, personIds));
}

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
    .values({ code: 'CN-ST', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  STATE = st.id;

  const clubs = await db.insert(s.dojos).values([
    { code: 'CN-CLUB', name: 'Notified Club', stateUnitId: STATE, status: 'active' },
    { code: 'CN-OTHER', name: 'Other Club', stateUnitId: STATE, status: 'active' },
  ]).returning({ id: s.dojos.id });
  CLUB = clubs[0].id;
  OTHER_CLUB = clubs[1].id;

  const people = await db.insert(s.persons).values([
    { federationId: 'MMAKF-MEM-2026-000001', fullName: 'Asha Kumari', dojoId: CLUB, stateUnitId: STATE, status: 'active' },
    { federationId: 'MMAKF-MEM-2026-000002', fullName: 'Ravi Singh', dojoId: CLUB, stateUnitId: STATE, status: 'active' },
    { federationId: 'MMAKF-MEM-2026-000003', fullName: 'Neha Das', dojoId: OTHER_CLUB, stateUnitId: STATE, status: 'active' },
    { federationId: 'MMAKF-MEM-2026-000004', fullName: 'Left Member', dojoId: CLUB, stateUnitId: STATE, status: 'inactive' },
  ]).returning({ id: s.persons.id });
  TRAINS_HERE = [people[0].id, people[1].id];
  TRAINS_ELSEWHERE = people[2].id;
  LAPSED = people[3].id;
});

describe('the catalogue and the resolver agree about who hears', () => {
  it('SCHEDULE_PUBLISHED is addressed to the club’s own members', () => {
    expect(NOTIFIABLE.SCHEDULE_PUBLISHED.audience).toBe('unit_members');
    // Essential: a member cannot switch off being told their own club moved.
    expect(NOTIFIABLE.SCHEDULE_PUBLISHED.essential).toBe(true);
  });
});

describe('a club publishes, and its members are told', () => {
  it('reaches every active member of that club, once each', async () => {
    await publishFor({ scope: 'dojo', id: CLUB }, 'Notified Club training', everyWeekday('18:00', '20:00'));
    const drained = await drain();
    expect(drained.delivered).toBeGreaterThan(0);

    const inbox = await inboxFor(TRAINS_HERE);
    expect(inbox.length, 'both members of the club must have a row').toBe(2);
    for (const row of inbox) {
      expect(row.title).toBe(NOTIFIABLE.SCHEDULE_PUBLISHED.title);
      expect(row.domainEventId, 'the row must be traceable to the event that caused it').toBeTruthy();
    }
  });

  it('does not reach a member of a different club', async () => {
    expect((await inboxFor([TRAINS_ELSEWHERE])).length).toBe(0);
  });

  it('does not reach somebody who has left', async () => {
    // `persons.status = 'inactive'` is the record of having left. Telling them
    // their old club moved its Sunday class is a message about somewhere they
    // no longer train.
    expect((await inboxFor([LAPSED])).length).toBe(0);
  });

  it('does not notify twice when the feed is drained again', async () => {
    const before = (await inboxFor(TRAINS_HERE)).length;
    await drain();
    await drain();
    expect((await inboxFor(TRAINS_HERE)).length, 'the cursor and the dedupe key must both hold').toBe(before);
  });
});

describe('the fan-out a form may not trigger', () => {
  it('a STATE publication reaches nobody', async () => {
    const before = (await db.select().from(s.notifications)).length;
    await publishFor({ scope: 'state', id: STATE }, 'State training', everyWeekday('06:00', '08:00'));
    await drain();
    const after = (await db.select().from(s.notifications)).length;
    expect(after, 'a state schedule must not notify every member in the state').toBe(before);
  });

  it('a NATIONAL publication reaches nobody', async () => {
    const before = (await db.select().from(s.notifications)).length;
    await publishFor({ scope: 'national', id: null }, 'National operating hours', everyWeekday('09:00', '17:00'));
    await drain();
    const after = (await db.select().from(s.notifications)).length;
    expect(after, 'a national schedule must not notify the whole federation').toBe(before);
  });
});

describe('the payload keys the resolver depends on', () => {
  it('every SCHEDULE_PUBLISHED event on the feed carries ownerScope and ownerId', async () => {
    // THE SILENT NO-OP GUARD. resolveRecipients() returns [] unless
    // payload.ownerScope === 'dojo'. A producer that stopped writing that key
    // would notify nobody while every other test stayed green, so the key is
    // asserted on the stored rows rather than on the call site.
    const rows = await db.select().from(s.domainEvents)
      .where(eq(s.domainEvents.eventType, 'SCHEDULE_PUBLISHED'));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      const payload = row.payload as any;
      expect(payload, `event ${row.id} has no payload`).toBeTruthy();
      expect(Object.keys(payload)).toContain('ownerScope');
      expect(Object.keys(payload)).toContain('ownerId');
      expect(['national', 'state', 'district', 'dojo', 'institution']).toContain(payload.ownerScope);
    }
    // And at least one of them was the club publication, which is the one that
    // had to resolve to people.
    expect(rows.some((r: any) => r.payload?.ownerScope === 'dojo' && r.payload?.ownerId === CLUB)).toBe(true);
  });
});
