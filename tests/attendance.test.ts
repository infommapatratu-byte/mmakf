// Taking the register.
//
// THE DEFECT THIS CLOSES: `session_attendance` was READ by src/db/grading.ts to
// count a candidate's sessions since their last grade, and by src/db/athletes.ts
// to show a member their training — and NOTHING IN THE REPOSITORY EVER WROTE A
// ROW. Grading was counting a number that was always zero.
//
// So the load-bearing test in this file is the last one: a register taken here
// must be visible to the reader that already existed, through the join it
// already makes. If that ever stops being true, attendance has forked and a
// candidate will be refused a grading they trained for.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import * as ops from '../src/db/operations.schema';
import * as sch from '../src/db/scheduling.schema';
import { createPerson } from '../src/db/federation';
import {
  createSchedule, draftVersion, publishVersion, createClass, generateSessions,
  cancelSession, bookClassSession,
} from '../src/db/scheduling';
import { register, takeRegister, missingRegisters, isAttendanceError } from '../src/db/attendance';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

const nat: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
let clubAdmin: Principal;
let theCoach: Principal;
let otherCoach: Principal;
let member: Principal;

const ctx = (p: Principal = nat): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

let db: any;
let JH: number, CLUB: number, VENUE: number;
let coach1: number, coach2: number, alice: number, bob: number;
let klassId: number;

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
  const [club] = await db.insert(s.dojos)
    .values({ code: 'D-1', name: 'Ramgarh Centre', stateUnitId: JH, status: 'active' })
    .returning({ id: s.dojos.id });
  CLUB = club.id;
  const [venue] = await db.insert(ops.venues)
    .values({ code: 'V-1', name: 'Ramgarh hall', kind: 'dojo', dojoId: CLUB, stateUnitId: JH })
    .returning({ id: ops.venues.id });
  VENUE = venue.id;

  const c1 = await createPerson(db, ctx(), { fullName: 'Sensei One', stateUnitId: JH });
  const c2 = await createPerson(db, ctx(), { fullName: 'Sensei Two', stateUnitId: JH });
  const a = await createPerson(db, ctx(), { fullName: 'Alice', stateUnitId: JH });
  const b = await createPerson(db, ctx(), { fullName: 'Bob', stateUnitId: JH });
  coach1 = c1.id; coach2 = c2.id; alice = a.id; bob = b.id;
  for (const id of [coach1, coach2, alice, bob]) {
    await db.update(s.persons).set({ dojoId: CLUB, status: 'active' }).where(eq(s.persons.id, id));
  }

  await db.insert(s.users).values([
    { id: 1, email: 'nat@x.test', status: 'active' },
    { id: 2, email: 'club@x.test', status: 'active' },
    { id: 3, email: 'coach1@x.test', status: 'active', personId: coach1 },
    { id: 4, email: 'coach2@x.test', status: 'active', personId: coach2 },
    { id: 5, email: 'alice@x.test', status: 'active', personId: alice },
  ]);
  clubAdmin = { userId: 2, label: 'club admin', bindings: [{ role: 'DOJO_ADMIN', scopeType: 'dojo', scopeId: CLUB }] };
  // INSTRUCTOR holds no 'attendance:write'. That is the point of the coach route.
  theCoach = { userId: 3, label: 'sensei one', bindings: [{ role: 'INSTRUCTOR', scopeType: 'dojo', scopeId: CLUB }] };
  otherCoach = { userId: 4, label: 'sensei two', bindings: [{ role: 'INSTRUCTOR', scopeType: 'dojo', scopeId: CLUB }] };
  member = { userId: 5, label: 'alice', bindings: [{ role: 'MEMBER', scopeType: 'dojo', scopeId: CLUB }] };

  // The room, open all day every day, so the class can be placed anywhere.
  const hall = await createSchedule(db, ctx(), {
    name: 'hall', purpose: 'training', owner: { scope: 'dojo', id: CLUB }, venueId: VENUE,
  });
  const hv = await draftVersion(db, ctx(), hall.id, {
    effectiveFrom: '2019-01-01',
    rules: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ dayOfWeek: d, opensAt: '06:00', closesAt: '22:00' })),
  });
  await publishVersion(db, ctx(), hv.id, 'fixture');

  const klass = await createClass(db, ctx(), {
    name: 'Kihon', slug: 'kihon-attendance', owner: { scope: 'dojo', id: CLUB },
    venueId: VENUE, capacity: 10, defaultCoachPersonId: coach1, activate: true,
  });
  klassId = klass.id;
  const cs = await createSchedule(db, ctx(), {
    name: 'kihon times', purpose: 'class', owner: { scope: 'dojo', id: CLUB }, classId: klassId,
  });
  const cv = await draftVersion(db, ctx(), cs.id, {
    effectiveFrom: '2019-01-01',
    rules: [{ dayOfWeek: 1, opensAt: '18:00', closesAt: '19:30' }],
  });
  await publishVersion(db, ctx(), cv.id, 'fixture');
});

beforeEach(async () => {
  await db.execute?.('DELETE FROM audit_events');
  await db.execute?.('DELETE FROM session_attendance');
  await db.execute?.('DELETE FROM training_sessions');
  await db.execute?.('DELETE FROM bookings');
  await db.execute?.('DELETE FROM class_sessions');
});

/** A Monday well in the past, so the future guard never fires. */
const PAST_MONDAY = '2024-01-08';
/** A Monday well in the future. */
const FUTURE_MONDAY = '2099-01-05';

/**
 * A held place on an occurrence, inserted directly.
 *
 * bookClassSession() rightly refuses a session that has already started, and
 * every marking test needs a class in the PAST. What is under test here is the
 * roster read, not the booking path — booking is covered in
 * tests/scheduling.test.ts.
 */
let bookingSeq = 0;
async function holdPlace(sessionId: number, personId: number) {
  const [session] = await db.select().from(sch.classSessions).where(eq(sch.classSessions.id, sessionId));
  await db.insert(s.bookings).values({
    ref: `MMAKF-BKG-2024-${String(++bookingSeq).padStart(6, '0')}`,
    kind: 'class', status: 'confirmed',
    personId, classSessionId: sessionId,
    startsAt: session.startsAt, endsAt: session.endsAt,
  });
}

async function occurrence(dateIso: string): Promise<number> {
  await generateSessions(db, ctx(), klassId, dateIso, dateIso);
  const [row] = await db.select().from(sch.classSessions)
    .where(eq(sch.classSessions.localDate, dateIso)).limit(1);
  return row.id;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SHEET
// ═══════════════════════════════════════════════════════════════════════════

describe('the register sheet', () => {
  it('rosters the people who booked, and nobody else at the club', async () => {
    // A class of two in a club of four must not render four lines. An instructor
    // scrolling a whole club's membership marks the wrong person.
    const sessionId = await occurrence(FUTURE_MONDAY);
    await bookClassSession(db, ctx(member), sessionId, alice);

    const sheet = await register(db, clubAdmin, sessionId);
    expect(sheet.rows.map((r) => r.fullName)).toEqual(['Alice']);
    expect(sheet.rows[0].booked).toBe(true);
    expect(sheet.rows[0].present).toBeNull();   // not marked is not absent
    expect(sheet.markedCount).toBe(0);
    expect(sheet.notYet).toBe(true);
  });

  it('keeps somebody who turned up without booking, once they are marked', async () => {
    const sessionId = await occurrence(PAST_MONDAY);
    await takeRegister(db, ctx(clubAdmin), sessionId, [{ personId: bob, present: true }]);

    const sheet = await register(db, clubAdmin, sessionId);
    expect(sheet.rows.map((r) => r.fullName)).toEqual(['Bob']);
    expect(sheet.rows[0].booked).toBe(false);
    expect(sheet.rows[0].present).toBe(true);
  });

  it('distinguishes marked-absent from not-marked', async () => {
    const sessionId = await occurrence(PAST_MONDAY);
    await holdPlace(sessionId, alice);
    await holdPlace(sessionId, bob);
    await takeRegister(db, ctx(clubAdmin), sessionId, [{ personId: alice, present: false, note: 'unwell' }]);

    const sheet = await register(db, clubAdmin, sessionId);
    const byName = new Map(sheet.rows.map((r) => [r.fullName, r]));
    expect(byName.get('Alice')!.present).toBe(false);
    expect(byName.get('Alice')!.note).toBe('unwell');
    expect(byName.get('Bob')!.present).toBeNull();
    expect(sheet.markedCount).toBe(1);
    expect(sheet.presentCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TAKING IT
// ═══════════════════════════════════════════════════════════════════════════

describe('taking the register', () => {
  it('creates ONE sheet and amends it on a second call', async () => {
    const sessionId = await occurrence(PAST_MONDAY);
    const first = await takeRegister(db, ctx(clubAdmin), sessionId, [
      { personId: alice, present: true },
      { personId: bob, present: false },
    ]);
    expect(first.marked).toBe(2);
    expect(first.presentCount).toBe(1);

    const second = await takeRegister(db, ctx(clubAdmin), sessionId, [
      { personId: bob, present: true, note: 'arrived late' },
    ]);
    expect(second.trainingSessionId).toBe(first.trainingSessionId);
    expect(second.amended).toBe(1);
    expect(second.marked).toBe(0);
    expect(second.presentCount).toBe(2);

    const sheets = await db.select().from(s.trainingSessions)
      .where(eq(s.trainingSessions.classSessionId, sessionId));
    expect(sheets).toHaveLength(1);
  });

  it('records the value it replaced, in the audit row', async () => {
    // `session_attendance` has no correctedFrom column, so the audit spine
    // carries it. An amended register is an amended grading eligibility.
    const sessionId = await occurrence(PAST_MONDAY);
    await takeRegister(db, ctx(clubAdmin), sessionId, [{ personId: alice, present: true }]);
    await takeRegister(db, ctx(clubAdmin), sessionId, [{ personId: alice, present: false }]);

    const audit = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'session_attendance'));
    expect(audit).toHaveLength(1);
    expect(audit[0].oldValue).toMatchObject({ present: true });
    expect(audit[0].newValue).toMatchObject({ present: false });
  });

  it('changes nothing when the marks are identical', async () => {
    const sessionId = await occurrence(PAST_MONDAY);
    await takeRegister(db, ctx(clubAdmin), sessionId, [{ personId: alice, present: true }]);
    const again = await takeRegister(db, ctx(clubAdmin), sessionId, [{ personId: alice, present: true }]);
    expect(again.marked).toBe(0);
    expect(again.amended).toBe(0);
  });

  it('marks the occurrence delivered, because a register means it ran', async () => {
    const sessionId = await occurrence(PAST_MONDAY);
    await takeRegister(db, ctx(clubAdmin), sessionId, [{ personId: alice, present: true }]);
    const [session] = await db.select().from(sch.classSessions).where(eq(sch.classSessions.id, sessionId));
    expect(session.status).toBe('delivered');
  });

  it('refuses a class that did not happen', async () => {
    const sessionId = await occurrence(PAST_MONDAY);
    await cancelSession(db, ctx(clubAdmin), sessionId, 'Instructor unwell');
    await expect(takeRegister(db, ctx(clubAdmin), sessionId, [{ personId: alice, present: true }]))
      .rejects.toThrow(/did not happen/);
  });

  it('refuses a class that has not started', async () => {
    // Marking Thursday on Tuesday records a prediction, and afterwards nothing
    // can tell it apart from a record.
    const sessionId = await occurrence(FUTURE_MONDAY);
    await expect(takeRegister(db, ctx(clubAdmin), sessionId, [{ personId: alice, present: true }]))
      .rejects.toThrow(/has not started/);
  });

  it('allows a camp to be registered in advance, but only when asked explicitly', async () => {
    const sessionId = await occurrence(FUTURE_MONDAY);
    const result = await takeRegister(
      db, ctx(clubAdmin), sessionId,
      [{ personId: alice, present: true }],
      { allowFuture: true }
    );
    expect(result.marked).toBe(1);
    // And it does NOT claim the class was delivered, because it has not been.
    const [session] = await db.select().from(sch.classSessions).where(eq(sch.classSessions.id, sessionId));
    expect(session.status).toBe('scheduled');
  });

  it('refuses a mark with no present/absent value', async () => {
    const sessionId = await occurrence(PAST_MONDAY);
    await expect(takeRegister(db, ctx(clubAdmin), sessionId, [{ personId: alice } as any]))
      .rejects.toThrow(/left OFF the register rather than assumed absent/);
  });

  it('refuses the same person twice in one register', async () => {
    const sessionId = await occurrence(PAST_MONDAY);
    await expect(takeRegister(db, ctx(clubAdmin), sessionId, [
      { personId: alice, present: true },
      { personId: alice, present: false },
    ])).rejects.toThrow(/appears twice/);
  });

  it('refuses a person who is not on the register at all', async () => {
    const sessionId = await occurrence(PAST_MONDAY);
    await expect(takeRegister(db, ctx(clubAdmin), sessionId, [{ personId: 99_999, present: true }]))
      .rejects.toThrow(/No person on the register/);
  });

  it('refuses an empty register — that is not the same as an empty class', async () => {
    const sessionId = await occurrence(PAST_MONDAY);
    await expect(takeRegister(db, ctx(clubAdmin), sessionId, []))
      .rejects.toThrow(/not the same as an empty class/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WHO MAY MARK
// ═══════════════════════════════════════════════════════════════════════════

describe('authority', () => {
  it('lets the coach teaching THAT session mark it, without attendance:write', async () => {
    // INSTRUCTOR holds no 'attendance:write' anywhere. The route is the row.
    const sessionId = await occurrence(PAST_MONDAY);
    const result = await takeRegister(db, ctx(theCoach), sessionId, [{ personId: alice, present: true }]);
    expect(result.marked).toBe(1);
  });

  it('does NOT let a different instructor mark somebody else’s class', async () => {
    const sessionId = await occurrence(PAST_MONDAY);
    await expect(takeRegister(db, ctx(otherCoach), sessionId, [{ personId: alice, present: true }]))
      .rejects.toThrow();
  });

  it('does not let a member mark a register at all', async () => {
    const sessionId = await occurrence(PAST_MONDAY);
    await expect(takeRegister(db, ctx(member), sessionId, [{ personId: alice, present: true }]))
      .rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE REPORT THAT MAKES IT SELF-CORRECTING
// ═══════════════════════════════════════════════════════════════════════════

describe('missing registers', () => {
  it('lists classes that ran with nobody marked, and drops them once marked', async () => {
    // Without this report, a class whose instructor forgot the register is
    // indistinguishable from a class nobody attended — and grading treats the
    // two the same way.
    const sessionId = await occurrence(PAST_MONDAY);
    let missing = await missingRegisters(db, clubAdmin, { dojoId: CLUB, fromIso: '2024-01-01', toIso: '2024-12-31' });
    expect(missing.map((m) => m.sessionId)).toContain(sessionId);

    await takeRegister(db, ctx(clubAdmin), sessionId, [{ personId: alice, present: true }]);
    missing = await missingRegisters(db, clubAdmin, { dojoId: CLUB, fromIso: '2024-01-01', toIso: '2024-12-31' });
    expect(missing.map((m) => m.sessionId)).not.toContain(sessionId);
  });

  it('does not list a class that has not happened yet', async () => {
    await occurrence(FUTURE_MONDAY);
    const missing = await missingRegisters(db, clubAdmin, { dojoId: CLUB, fromIso: '2099-01-01', toIso: '2099-12-31' });
    expect(missing).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE READER THAT ALREADY EXISTED
// ═══════════════════════════════════════════════════════════════════════════

describe('the existing readers see it', () => {
  it('is visible through the join src/db/grading.ts already makes', async () => {
    // THE LOAD-BEARING TEST. grading.ts counts attended sessions with
    //   session_attendance INNER JOIN training_sessions ON session_id
    //   WHERE person_id = ? AND present = true
    // A separate class_session_attendance table would have made this query blind
    // to every class the engine ran, and a candidate would be refused a grading
    // they had trained for.
    const sessionId = await occurrence(PAST_MONDAY);
    await takeRegister(db, ctx(clubAdmin), sessionId, [
      { personId: alice, present: true },
      { personId: bob, present: false },
    ]);

    const counted = await db
      .select({ id: s.sessionAttendance.id, heldOn: s.trainingSessions.heldOn })
      .from(s.sessionAttendance)
      .innerJoin(s.trainingSessions, eq(s.sessionAttendance.sessionId, s.trainingSessions.id))
      .where(and(eq(s.sessionAttendance.personId, alice), eq(s.sessionAttendance.present, true)));

    expect(counted).toHaveLength(1);
    expect(counted[0].heldOn).toBe(PAST_MONDAY);

    const bobs = await db
      .select({ id: s.sessionAttendance.id })
      .from(s.sessionAttendance)
      .innerJoin(s.trainingSessions, eq(s.sessionAttendance.sessionId, s.trainingSessions.id))
      .where(and(eq(s.sessionAttendance.personId, bob), eq(s.sessionAttendance.present, true)));
    expect(bobs).toHaveLength(0);
  });

  it('carries the wall clock the timetable said onto the sheet', async () => {
    const sessionId = await occurrence(PAST_MONDAY);
    await takeRegister(db, ctx(clubAdmin), sessionId, [{ personId: alice, present: true }]);
    const [sheet] = await db.select().from(s.trainingSessions)
      .where(eq(s.trainingSessions.classSessionId, sessionId));
    expect(sheet.startsAt).toBe('18:00');
    expect(sheet.endsAt).toBe('19:30');
    expect(sheet.heldOn).toBe(PAST_MONDAY);
    expect(sheet.instructorPersonId).toBe(coach1);
  });
});
