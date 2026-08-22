// Telling members a timetable changed.
//
// THE TWO FAILURES THIS FILE STANDS BETWEEN.
//
// SILENCE. A state office moves every club's Sunday and nobody is told, so a
// family turns up to a locked dojo. src/lib/notifications.ts refuses to fan out
// automatically above club scope and its comment says a circular "is a different
// act with a different approval path" — a path that did not exist until now.
//
// AND THE OPPOSITE. One mistyped form writes to every member in the country and
// cannot be recalled. So the audience is COUNTED AND FROZEN, the administrator
// confirms the number they were shown, and above a threshold a second person
// agrees — through src/lib/approvals.ts, not through a second implementation.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, inArray } from 'drizzle-orm';
import * as s from '../src/db/schema';
import * as sch from '../src/db/scheduling.schema';
import { createPerson } from '../src/db/federation';
import { createSchedule, draftVersion, publishVersion } from '../src/db/scheduling';
import {
  announcementAudience, draftAnnouncement, requestAnnouncementApproval,
  sendAnnouncement, cancelAnnouncement, listAnnouncements,
  TWO_PERSON_THRESHOLD, isAnnounceError,
} from '../src/db/schedule-announce';
import { approve } from '../src/lib/approvals';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

const nat: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const secondNat: Principal = {
  userId: 2, label: 'general secretary',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
let clubAdmin: Principal;
let otherClubAdmin: Principal;

const ctx = (p: Principal = nat): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

let db: any;
let JH: number, RMG: number;
let CLUB_A: number, CLUB_B: number;
let clubScheduleId: number;
let clubVersionId: number;
let nationalScheduleId: number;
let nationalVersionId: number;

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
    .values({ code: 'ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;
  const [rmg] = await db.insert(s.districtUnits)
    .values({ code: 'D-RMG', stateUnitId: JH, district: 'Ramgarh', name: 'Ramgarh', status: 'active' })
    .returning({ id: s.districtUnits.id });
  RMG = rmg.id;
  const dojos = await db.insert(s.dojos).values([
    { code: 'D-A', name: 'Club A', stateUnitId: JH, districtUnitId: RMG, status: 'active' },
    { code: 'D-B', name: 'Club B', stateUnitId: JH, districtUnitId: RMG, status: 'active' },
  ]).returning({ id: s.dojos.id });
  CLUB_A = dojos[0].id; CLUB_B = dojos[1].id;

  await db.insert(s.users).values([
    { id: 1, email: 'nat@x.test', status: 'active' },
    { id: 2, email: 'gensec@x.test', status: 'active' },
    { id: 3, email: 'cluba@x.test', status: 'active' },
    { id: 4, email: 'clubb@x.test', status: 'active' },
  ]);
  clubAdmin = { userId: 3, label: 'club A admin', bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: CLUB_A }] };
  otherClubAdmin = { userId: 4, label: 'club B admin', bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: CLUB_B }] };

  // Three at Club A, one at Club B, one placed only at state level, and one
  // placed nowhere at all — the last is the interesting one.
  for (const [name, dojoId] of [['A1', CLUB_A], ['A2', CLUB_A], ['A3', CLUB_A], ['B1', CLUB_B]] as const) {
    const p = await createPerson(db, ctx(), { fullName: name, stateUnitId: JH, districtUnitId: RMG });
    await db.update(s.persons).set({ dojoId, status: 'active' }).where(eq(s.persons.id, p.id));
  }
  const stateOnly = await createPerson(db, ctx(), { fullName: 'State only', stateUnitId: JH });
  await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, stateOnly.id));
  const unplaced = await createPerson(db, ctx(), { fullName: 'Unplaced' });
  await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, unplaced.id));
  // And one who is placed but NOT active.
  const inactive = await createPerson(db, ctx(), { fullName: 'Left the club', stateUnitId: JH });
  await db.update(s.persons).set({ dojoId: CLUB_A, status: 'inactive' }).where(eq(s.persons.id, inactive.id));

  const clubSchedule = await createSchedule(db, ctx(), {
    name: 'Club A training', purpose: 'training', owner: { scope: 'dojo', id: CLUB_A },
  });
  clubScheduleId = clubSchedule.id;
  const cv = await draftVersion(db, ctx(), clubScheduleId, {
    effectiveFrom: '2026-10-01', rules: [{ dayOfWeek: 1, opensAt: '18:00', closesAt: '20:00' }],
  });
  await publishVersion(db, ctx(), cv.id, 'fixture');
  clubVersionId = cv.id;

  const natSchedule = await createSchedule(db, ctx(), {
    name: 'National default', purpose: 'training', owner: { scope: 'national', id: null },
  });
  nationalScheduleId = natSchedule.id;
  const nv = await draftVersion(db, ctx(), nationalScheduleId, {
    effectiveFrom: '2026-10-01', rules: [{ dayOfWeek: 7, opensAt: '08:00', closesAt: '12:00' }],
  });
  await publishVersion(db, ctx(), nv.id, 'fixture');
  nationalVersionId = nv.id;
});

beforeEach(async () => {
  await db.execute?.('DELETE FROM notifications');
  await db.execute?.('DELETE FROM schedule_announcements');
  await db.execute?.("DELETE FROM domain_events WHERE event_type = 'SCHEDULE_ANNOUNCED'");
});

// ═══════════════════════════════════════════════════════════════════════════
// WHO IT REACHES
// ═══════════════════════════════════════════════════════════════════════════

describe('the audience', () => {
  it('is the active people placed under that unit', async () => {
    expect(await announcementAudience(db, { scope: 'dojo', id: CLUB_A })).toHaveLength(3);
    expect(await announcementAudience(db, { scope: 'dojo', id: CLUB_B })).toHaveLength(1);
  });

  it('excludes somebody who is no longer active', async () => {
    const ids = await announcementAudience(db, { scope: 'dojo', id: CLUB_A });
    const inactive = await db.select({ id: s.persons.id }).from(s.persons)
      .where(eq(s.persons.fullName, 'Left the club'));
    expect(ids).not.toContain(inactive[0].id);
  });

  it('excludes somebody with no placement at all, even nationally', async () => {
    // A person record created by an intake that has not been placed is not
    // somebody with a timetable. Writing to them writes to a form.
    const national = await announcementAudience(db, { scope: 'national', id: null });
    const unplaced = await db.select({ id: s.persons.id }).from(s.persons)
      .where(eq(s.persons.fullName, 'Unplaced'));
    expect(national).not.toContain(unplaced[0].id);
    // Five placed and active: A1, A2, A3, B1 and the state-only one.
    expect(national).toHaveLength(5);
  });

  it('reaches nobody for an institution — a client is not a member', async () => {
    expect(await announcementAudience(db, { scope: 'institution', id: 1 })).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DRAFTING FREEZES THE NUMBER
// ═══════════════════════════════════════════════════════════════════════════

describe('drafting', () => {
  it('counts the audience and sends nothing', async () => {
    const draft = await draftAnnouncement(db, ctx(clubAdmin), {
      scheduleId: clubScheduleId, versionId: clubVersionId,
      reason: 'Monday moved to 18:30 from the start of the winter term',
    });
    expect(draft.status).toBe('draft');
    expect(draft.audienceCount).toBe(3);
    expect(draft.sentCount).toBe(0);
    expect(draft.requiresTwoPeople).toBe(false);
    expect(await db.select().from(s.notifications)).toHaveLength(0);
  });

  it('refuses an announcement with no reason', async () => {
    await expect(draftAnnouncement(db, ctx(clubAdmin), {
      scheduleId: clubScheduleId, reason: '   ',
    })).rejects.toThrow(/must record why/);
  });

  it('refuses to announce a version members cannot see yet', async () => {
    const unpublished = await draftVersion(db, ctx(clubAdmin), clubScheduleId, {
      effectiveFrom: '2027-01-01', rules: [{ dayOfWeek: 1, opensAt: '19:00', closesAt: '21:00' }],
    });
    await expect(draftAnnouncement(db, ctx(clubAdmin), {
      scheduleId: clubScheduleId, versionId: unpublished.id, reason: 'why',
    })).rejects.toThrow(/still a draft/);
  });

  it('refuses a version belonging to a different schedule', async () => {
    await expect(draftAnnouncement(db, ctx(), {
      scheduleId: clubScheduleId, versionId: nationalVersionId, reason: 'why',
    })).rejects.toThrow(/different schedule/);
  });

  it('does not let one club announce another club’s timetable', async () => {
    await expect(draftAnnouncement(db, ctx(otherClubAdmin), {
      scheduleId: clubScheduleId, reason: 'why',
    })).rejects.toThrow();
  });

  it('does not let a club administrator announce the federation default', async () => {
    await expect(draftAnnouncement(db, ctx(clubAdmin), {
      scheduleId: nationalScheduleId, reason: 'why',
    })).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SENDING
// ═══════════════════════════════════════════════════════════════════════════

describe('sending', () => {
  it('writes to exactly the audience, once', async () => {
    const draft = await draftAnnouncement(db, ctx(clubAdmin), {
      scheduleId: clubScheduleId, versionId: clubVersionId, reason: 'Monday moved',
    });
    const result = await sendAnnouncement(db, ctx(clubAdmin), draft.id, draft.audienceCount);

    expect(result.queued).toBe(3);
    expect(result.announcement.status).toBe('sent');
    expect(result.announcement.sentCount).toBe(3);
    expect(result.shortfall).toBe(0);

    const notes = await db.select().from(s.notifications);
    expect(notes).toHaveLength(3);
    expect(notes[0].title).toMatch(/timings have changed/i);
    expect(notes[0].linkUrl).toBe('/my/schedule');
    // THE HOURS ARE NOT IN THE BODY. A notification is one line; half a
    // timetable is worse than none.
    expect(notes[0].body).not.toMatch(/\d\d:\d\d/);
    // The effective date IS, because that is the one fact that decides whether
    // the recipient has to act before their next session.
    expect(notes[0].body).toMatch(/2026-10-01/);
  });

  it('refuses a number the administrator did not actually see', async () => {
    // The difference between clicking a button and stating a figure. An
    // administrator who cannot reproduce the number is on a stale page.
    const draft = await draftAnnouncement(db, ctx(clubAdmin), {
      scheduleId: clubScheduleId, reason: 'Monday moved',
    });
    await expect(sendAnnouncement(db, ctx(clubAdmin), draft.id, draft.audienceCount + 1))
      .rejects.toThrow(/Nothing has been sent/);
    expect(await db.select().from(s.notifications)).toHaveLength(0);
  });

  it('cannot be sent twice, even when the send is retried', async () => {
    const draft = await draftAnnouncement(db, ctx(clubAdmin), {
      scheduleId: clubScheduleId, reason: 'Monday moved',
    });
    await sendAnnouncement(db, ctx(clubAdmin), draft.id, draft.audienceCount);
    await expect(sendAnnouncement(db, ctx(clubAdmin), draft.id, draft.audienceCount))
      .rejects.toThrow(/already gone out/);
    expect(await db.select().from(s.notifications)).toHaveLength(3);
  });

  it('puts the announcement on the event feed, with the frozen count', async () => {
    const draft = await draftAnnouncement(db, ctx(clubAdmin), {
      scheduleId: clubScheduleId, reason: 'Monday moved',
    });
    await sendAnnouncement(db, ctx(clubAdmin), draft.id, draft.audienceCount);

    const [event] = await db.select().from(s.domainEvents)
      .where(eq(s.domainEvents.eventType, 'SCHEDULE_ANNOUNCED'));
    expect(event.payload).toMatchObject({ announcementId: draft.id, audienceCount: 3 });

    // Every notification carries the event id, which is the ONLY deduplication
    // queue() has. Without it a retried send writes to everybody twice.
    const notes = await db.select().from(s.notifications);
    expect(notes.every((n: any) => n.domainEventId === event.id)).toBe(true);
  });

  it('records what actually went out, not what was promised', async () => {
    const draft = await draftAnnouncement(db, ctx(clubAdmin), {
      scheduleId: clubScheduleId, reason: 'Monday moved',
    });
    expect(draft.audienceCount).toBe(3);

    // Somebody leaves the club between drafting and sending. The frozen count is
    // what was authorised; sentCount is what happened, and the gap is reported
    // rather than hidden.
    const a3 = await db.select({ id: s.persons.id }).from(s.persons).where(eq(s.persons.fullName, 'A3'));
    await db.update(s.persons).set({ status: 'inactive' }).where(eq(s.persons.id, a3[0].id));

    const result = await sendAnnouncement(db, ctx(clubAdmin), draft.id, 3);
    expect(result.announcement.audienceCount).toBe(3);
    expect(result.announcement.sentCount).toBe(2);
    expect(result.shortfall).toBe(1);

    // Put them back for the other tests in the file.
    await db.update(s.persons).set({ status: 'active' }).where(eq(s.persons.id, a3[0].id));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TWO PEOPLE, ABOVE THE THRESHOLD
// ═══════════════════════════════════════════════════════════════════════════

describe('a large fan-out takes two people', () => {
  let bulkIds: number[] = [];

  beforeEach(async () => {
    // Enough people at Club B to cross the threshold. Inserted directly: this is
    // about the count, and createPerson() for 200 people is a slow way to make a
    // number.
    if (!bulkIds.length) {
      const rows = await db.insert(s.persons).values(
        Array.from({ length: TWO_PERSON_THRESHOLD + 5 }, (_, i) => ({
          federationId: `MMAKF-BULK-${String(i).padStart(6, '0')}`,
          fullName: `Bulk ${i}`,
          stateUnitId: JH,
          dojoId: CLUB_B,
          status: 'active' as const,
        }))
      ).returning({ id: s.persons.id });
      bulkIds = rows.map((r: any) => r.id);
    }
  });

  it('will not send without a second person agreeing', async () => {
    const draft = await draftAnnouncement(db, ctx(), {
      scheduleId: nationalScheduleId, reason: 'Sunday timings moved nationally',
    });
    expect(draft.audienceCount).toBeGreaterThan(TWO_PERSON_THRESHOLD);
    expect(draft.requiresTwoPeople).toBe(true);

    await expect(sendAnnouncement(db, ctx(), draft.id, draft.audienceCount))
      .rejects.toThrow(/needs a second person/);
    expect(await db.select().from(s.notifications)).toHaveLength(0);
  });

  it('sends once a second person has agreed, and only then', async () => {
    const draft = await draftAnnouncement(db, ctx(), {
      scheduleId: nationalScheduleId, reason: 'Sunday timings moved nationally',
    });
    const { requestId } = await requestAnnouncementApproval(db, ctx(), draft.id);

    // Still refused: raising a request is not agreeing to it.
    await expect(sendAnnouncement(db, ctx(), draft.id, draft.audienceCount))
      .rejects.toThrow(/is pending/);

    await approve(db, { principal: secondNat, reason: 'Agreed at the executive meeting', authority: 'test' }, requestId);
    const result = await sendAnnouncement(db, ctx(), draft.id, draft.audienceCount);

    expect(result.announcement.status).toBe('sent');
    expect(result.queued).toBe(draft.audienceCount);
    const notes = await db.select().from(s.notifications);
    expect(notes).toHaveLength(draft.audienceCount);
  });

  it('refuses an approval request nobody needed', async () => {
    // An approval nobody needed teaches people that approvals are theatre.
    const draft = await draftAnnouncement(db, ctx(clubAdmin), {
      scheduleId: clubScheduleId, reason: 'Monday moved',
    });
    await expect(requestAnnouncementApproval(db, ctx(clubAdmin), draft.id))
      .rejects.toThrow(/under the 200 that needs a second person/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WITHDRAWING
// ═══════════════════════════════════════════════════════════════════════════

describe('withdrawing', () => {
  it('cancels a draft, and the draft stays on the record', async () => {
    const draft = await draftAnnouncement(db, ctx(clubAdmin), {
      scheduleId: clubScheduleId, reason: 'Monday moved',
    });
    const cancelled = await cancelAnnouncement(db, ctx(clubAdmin), draft.id, 'Prepared against the wrong version');
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.cancelledReason).toMatch(/wrong version/);

    const listed = await listAnnouncements(db, clubAdmin, clubScheduleId);
    expect(listed.map((a) => a.id)).toContain(draft.id);

    await expect(sendAnnouncement(db, ctx(clubAdmin), draft.id, draft.audienceCount))
      .rejects.toThrow(/was cancelled/);
  });

  it('cannot unsend something that has gone out', async () => {
    const draft = await draftAnnouncement(db, ctx(clubAdmin), {
      scheduleId: clubScheduleId, reason: 'Monday moved',
    });
    await sendAnnouncement(db, ctx(clubAdmin), draft.id, draft.audienceCount);
    await expect(cancelAnnouncement(db, ctx(clubAdmin), draft.id, 'changed my mind'))
      .rejects.toThrow(/cannot be unsent/);
  });

  it('refuses a withdrawal with no reason', async () => {
    const draft = await draftAnnouncement(db, ctx(clubAdmin), {
      scheduleId: clubScheduleId, reason: 'Monday moved',
    });
    await expect(cancelAnnouncement(db, ctx(clubAdmin), draft.id, ' ')).rejects.toThrow(/must record why/);
  });
});
