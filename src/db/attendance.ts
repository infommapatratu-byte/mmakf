// Taking the register at a class.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT WAS MISSING, AND WHY IT MATTERED MORE THAN IT LOOKED
// ═══════════════════════════════════════════════════════════════════════════
//
// `session_attendance` has existed since the education wave. It is READ in two
// places that matter:
//
//   · src/db/grading.ts counts a candidate's attended sessions since their last
//     grade, which is part of whether they may be examined at all;
//   · src/db/athletes.ts reports it on a member's own passport.
//
// NOTHING WROTE IT. Not one function in the repository inserted a row. So the
// grading engine was counting a number that was always zero, and a member's
// passport reported training they had done as training they had not.
//
// This module is the writer. It writes to the tables that already exist —
// `training_sessions` for the sheet and `session_attendance` for the marks — so
// every existing reader counts it without being changed. A
// `class_session_attendance` table would have left grading silently ignoring
// half the federation's attendance, and that defect surfaces years later as a
// candidate refused a grading they had in fact trained for.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FOUR RULES
// ═══════════════════════════════════════════════════════════════════════════
//
// ONE. A REGISTER BELONGS TO AN OCCURRENCE, AND AT MOST ONE.
// `training_sessions.class_session_id` is unique when set. Taking the register
// twice AMENDS the first one; it does not create a second. Two registers for one
// class are two answers to "who was there", and nobody downstream can tell which
// the instructor meant.
//
// TWO. PRESENT IS NEVER ASSUMED. There is no "mark everyone present" default and
// no implicit absence: a person the instructor did not mark is ABSENT FROM THE
// REGISTER ENTIRELY, which is different from being marked absent. Attendance
// feeds a grading eligibility count, and a system that filled in the gaps would
// be inventing training somebody did not do — or denying training they did.
//
// THREE. AN AMENDMENT IS RECORDED, NOT OVERWRITTEN. `programAttendance` already
// established this pattern for institutional delivery with
// `correctedFromPresent`. `session_attendance` has no such column, so the
// original value goes into the AUDIT ROW instead — writeAudit()'s `oldValue`,
// which is what the audit spine is for. An instructor who corrects a mark leaves
// a trail either way, and inventing a column here would fork the pattern.
//
// FOUR. YOU CANNOT TAKE A REGISTER AT A CLASS THAT DID NOT HAPPEN. A cancelled
// occurrence is refused. A FUTURE occurrence is refused too, and that is the one
// worth stating: marking Thursday's attendance on Tuesday is a prediction, and a
// prediction in an attendance register is indistinguishable afterwards from a
// record.
//
// ═══════════════════════════════════════════════════════════════════════════
// AUTHORITY
// ═══════════════════════════════════════════════════════════════════════════
//
// 'attendance:write' in the CLUB's scope — or the coach teaching that very
// occurrence, who is the person actually standing on the mat. That second route
// is deliberate and narrow: it lets an instructor mark their own class without
// the club administrator's authority, and it does not let them mark anybody
// else's, because it is checked against `class_sessions.coach_person_id`.

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import * as sch from '@/db/scheduling.schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, can, type Principal } from '@/lib/rbac';
import { SchedulingError, resourceForOwner, type IsoDate } from '@/db/scheduling';

type DB = any;

export class AttendanceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AttendanceError';
    this.code = code;
  }
}

/** See booking.ts for why identity is checked by shape and not `instanceof`. */
export function isAttendanceError(err: unknown): err is AttendanceError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'AttendanceError';
}

export interface Mark {
  personId: number;
  present: boolean;
  note?: string | null;
}

export interface RegisterRow {
  personId: number;
  fullName: string;
  present: boolean | null;
  note: string | null;
  /** True when this person holds a live booking on the occurrence. */
  booked: boolean;
  recordedAt: string | null;
}

export interface Register {
  sessionId: number;
  sessionRef: string;
  className: string;
  localDate: IsoDate;
  localStart: string;
  localEnd: string;
  status: string;
  /** Null until somebody takes the register. */
  trainingSessionId: number | null;
  takenAt: string | null;
  rows: RegisterRow[];
  presentCount: number;
  markedCount: number;
  /** True when the occurrence is in the future, so a register may not be taken. */
  notYet: boolean;
  cancelled: boolean;
}

async function loadOccurrence(db: DB, sessionId: number) {
  const rows = await db.select({ session: sch.classSessions, klass: sch.dojoClasses })
    .from(sch.classSessions)
    .innerJoin(sch.dojoClasses, eq(sch.dojoClasses.id, sch.classSessions.classId))
    .where(eq(sch.classSessions.id, sessionId))
    .limit(1);
  if (!rows.length) throw new AttendanceError('not_found', `No class session ${sessionId}.`);
  return rows[0];
}

/**
 * May this principal mark this occurrence?
 *
 * Two routes, and the second is the narrow one: the coach teaching THIS session.
 * It is checked against the row rather than against a role, so an instructor can
 * mark their own class and nobody else's.
 */
async function assertMayMark(db: DB, principal: Principal, session: any, klass: any): Promise<void> {
  const isTheCoach = session.coachPersonId != null && (await ownPersonId(db, principal)) === session.coachPersonId;
  if (isTheCoach) return;
  assertCan(principal, 'attendance:write', await resourceForOwner(db, {
    scope: klass.ownerScope, id: klass.ownerId ?? null,
  }));
}

/**
 * The caller's OWN person id, from their own user row. Never from the request.
 *
 * The same helper, for the same reason, as the private one in src/db/booking.ts
 * and src/db/scheduling.ts: it is what makes "I am the coach" a claim this
 * module can check rather than one the caller asserts.
 */
async function ownPersonId(db: DB, principal: Principal | null | undefined): Promise<number | null> {
  if (!principal || principal.userId == null) return null;
  const row = (
    await db.select({ personId: s.users.personId }).from(s.users)
      .where(eq(s.users.id, principal.userId)).limit(1)
  )[0];
  return row?.personId ?? null;
}

/**
 * The sheet for one occurrence: who was expected, and what has been marked.
 *
 * THE ROSTER IS THE PEOPLE WHO BOOKED, PLUS ANYBODY ALREADY MARKED. Not "every
 * member of the club": a class of eight in a club of two hundred would render a
 * two-hundred-line register, and an instructor scrolling that will mark the
 * wrong person. Somebody who turned up without booking is added by marking them,
 * which is why the second half of that union exists — once marked, they stay on
 * the sheet.
 *
 * `present: null` means NOT MARKED, and is deliberately not `false`. An
 * unmarked person is not an absent person, and grading counts presence.
 */
export async function register(db: DB, principal: Principal, sessionId: number): Promise<Register> {
  const { session, klass } = await loadOccurrence(db, sessionId);
  assertCan(principal, 'attendance:read', await resourceForOwner(db, {
    scope: klass.ownerScope, id: klass.ownerId ?? null,
  }));

  const sheet = (
    await db.select().from(s.trainingSessions)
      .where(eq(s.trainingSessions.classSessionId, sessionId)).limit(1)
  )[0] ?? null;

  const booked = await db.select({ personId: s.bookings.personId })
    .from(s.bookings)
    .where(and(
      eq(s.bookings.classSessionId, sessionId),
      inArray(s.bookings.status, ['requested', 'proposed', 'confirmed', 'rescheduled', 'completed'])
    ));
  const bookedIds = new Set(booked.map((b: any) => b.personId).filter(Boolean) as number[]);

  const marks = sheet
    ? await db.select().from(s.sessionAttendance).where(eq(s.sessionAttendance.sessionId, sheet.id))
    : [];
  const markById = new Map<number, any>(marks.map((m: any) => [m.personId, m]));

  const ids = [...new Set([...bookedIds, ...markById.keys()])];
  const people = ids.length
    ? await db.select({ id: s.persons.id, fullName: s.persons.fullName })
        .from(s.persons).where(inArray(s.persons.id, ids)).orderBy(asc(s.persons.fullName))
    : [];

  const rows: RegisterRow[] = people.map((p: any) => {
    const mark = markById.get(p.id);
    return {
      personId: p.id,
      fullName: p.fullName,
      present: mark ? Boolean(mark.present) : null,
      note: mark?.note ?? null,
      booked: bookedIds.has(p.id),
      recordedAt: mark?.recordedAt ? new Date(mark.recordedAt).toISOString() : null,
    };
  });

  return {
    sessionId: session.id,
    sessionRef: session.ref,
    className: klass.name,
    localDate: session.localDate,
    localStart: session.localStart,
    localEnd: session.localEnd,
    status: session.status,
    trainingSessionId: sheet?.id ?? null,
    takenAt: sheet?.createdAt ? new Date(sheet.createdAt).toISOString() : null,
    rows,
    presentCount: rows.filter((r) => r.present === true).length,
    markedCount: rows.filter((r) => r.present !== null).length,
    notYet: new Date(session.startsAt).getTime() > Date.now(),
    cancelled: session.status === 'cancelled',
  };
}

export interface TakeRegisterResult {
  trainingSessionId: number;
  sessionId: number;
  marked: number;
  amended: number;
  presentCount: number;
}

/**
 * Record who was there.
 *
 * Creates the `training_sessions` sheet on first use and reuses it afterwards, so
 * a second call AMENDS rather than duplicating. Every changed mark writes an
 * audit row carrying the value it replaced, because attendance is an input to
 * grading eligibility and a silently edited register is a silently edited
 * eligibility decision.
 *
 * `allowFuture` exists for one legitimate case — a camp or a seminar being
 * registered in advance from a signed list — and it is a parameter rather than a
 * default so that the ordinary path cannot record a prediction as a record.
 */
export async function takeRegister(
  db: DB, ctx: AuditContext,
  sessionId: number,
  marks: Mark[],
  opts: { focus?: string | null; allowFuture?: boolean } = {}
): Promise<TakeRegisterResult> {
  const { session, klass } = await loadOccurrence(db, sessionId);
  await assertMayMark(db, ctx.principal, session, klass);

  if (session.status === 'cancelled') {
    throw new AttendanceError(
      'cancelled',
      `That class was cancelled${session.cancelledReason ? ` — ${session.cancelledReason}` : ''}. A register cannot be taken at a class that did not happen.`
    );
  }
  if (session.status === 'rescheduled') {
    throw new AttendanceError(
      'rescheduled',
      'That occurrence was moved. Take the register at the session it moved to, which is the one that ran.'
    );
  }
  if (!opts.allowFuture && new Date(session.startsAt).getTime() > Date.now()) {
    throw new AttendanceError(
      'in_the_future',
      'That class has not started. Marking attendance in advance records a prediction, and afterwards nothing can tell it apart from a record.'
    );
  }
  if (!Array.isArray(marks) || marks.length === 0) {
    throw new AttendanceError('nothing_to_record', 'No marks were given. An empty register is not the same as an empty class.');
  }

  const seen = new Set<number>();
  for (const m of marks) {
    if (!Number.isInteger(m?.personId)) {
      throw new AttendanceError('bad_mark', 'Every mark must name a person.');
    }
    if (typeof m.present !== 'boolean') {
      throw new AttendanceError(
        'bad_mark',
        `Person ${m.personId} has no present/absent value. An unmarked person is left OFF the register rather than assumed absent.`
      );
    }
    if (seen.has(m.personId)) {
      throw new AttendanceError('duplicate_mark', `Person ${m.personId} appears twice in one register.`);
    }
    seen.add(m.personId);
  }

  const known = await db.select({ id: s.persons.id }).from(s.persons)
    .where(inArray(s.persons.id, [...seen]));
  if (known.length !== seen.size) {
    const found = new Set(known.map((p: any) => p.id));
    const missing = [...seen].filter((id) => !found.has(id));
    throw new AttendanceError('unknown_person', `No person on the register: ${missing.join(', ')}.`);
  }

  const recorderPersonId = await ownPersonId(db, ctx.principal);

  return await db.transaction(async (tx: DB) => {
    let sheet = (
      await tx.select().from(s.trainingSessions)
        .where(eq(s.trainingSessions.classSessionId, sessionId)).limit(1)
    )[0] ?? null;

    if (!sheet) {
      const created = await tx.insert(s.trainingSessions).values({
        dojoId: klass.ownerScope === 'dojo' ? klass.ownerId : null,
        title: klass.name,
        heldOn: session.localDate,
        // The wall clock the timetable said, copied rather than recomputed: the
        // register must read the way the class read, even if the venue's
        // timezone is corrected next year.
        startsAt: session.localStart,
        endsAt: session.localEnd,
        instructorPersonId: session.coachPersonId ?? null,
        focus: opts.focus ?? null,
        classSessionId: sessionId,
      }).returning();
      sheet = created[0];
      await writeAudit(tx, ctx, {
        entityType: 'training_session', entityId: sheet.id, action: 'create',
        newValue: { classSessionId: sessionId, heldOn: session.localDate, title: klass.name },
      });
    }

    const existing = await tx.select().from(s.sessionAttendance)
      .where(eq(s.sessionAttendance.sessionId, sheet.id));
    const before = new Map<number, any>(existing.map((r: any) => [r.personId, r]));

    let marked = 0;
    let amended = 0;

    for (const m of marks) {
      const prior = before.get(m.personId);
      const note = m.note?.trim() || null;

      if (!prior) {
        await tx.insert(s.sessionAttendance).values({
          sessionId: sheet.id,
          personId: m.personId,
          present: m.present,
          note,
          recordedByPersonId: recorderPersonId,
        });
        marked++;
        continue;
      }
      if (Boolean(prior.present) === m.present && (prior.note ?? null) === note) continue;

      await tx.update(s.sessionAttendance)
        .set({ present: m.present, note, recordedByPersonId: recorderPersonId, recordedAt: new Date() })
        .where(eq(s.sessionAttendance.id, prior.id));
      // THE VALUE THAT WAS THERE BEFORE. `session_attendance` has no
      // `correctedFrom` column, so the audit row carries it — see rule three in
      // the header. An amended register that leaves no trace is an amended
      // grading eligibility decision that leaves no trace.
      await writeAudit(tx, ctx, {
        entityType: 'session_attendance', entityId: prior.id, action: 'update',
        oldValue: { personId: m.personId, present: Boolean(prior.present), note: prior.note ?? null },
        newValue: { personId: m.personId, present: m.present, note },
      });
      amended++;
    }

    const after = await tx.select({ present: s.sessionAttendance.present })
      .from(s.sessionAttendance).where(eq(s.sessionAttendance.sessionId, sheet.id));
    const presentCount = after.filter((r: any) => r.present === true).length;

    await writeAudit(tx, ctx, {
      entityType: 'class_session', entityId: sessionId, action: 'update',
      newValue: { register: { marked, amended, presentCount, trainingSessionId: sheet.id } },
    });

    // Marking a class delivered is a consequence of the register, not a separate
    // decision somebody has to remember: an occurrence with a register is an
    // occurrence that ran. Only from 'scheduled', so a delivered class stays
    // delivered and an amendment does not re-open its status.
    if (session.status === 'scheduled' && !opts.allowFuture) {
      await tx.update(sch.classSessions)
        .set({ status: 'delivered' })
        .where(and(eq(sch.classSessions.id, sessionId), eq(sch.classSessions.status, 'scheduled')));
    }

    return { trainingSessionId: sheet.id, sessionId, marked, amended, presentCount };
  });
}

/**
 * Occurrences that ran and have no register.
 *
 * The one report that makes this subsystem self-correcting. Without it a class
 * whose instructor forgot the register is indistinguishable from a class nobody
 * attended, and the grading engine treats the two the same way — which is the
 * defect this whole module exists to end.
 */
export async function missingRegisters(
  db: DB, principal: Principal,
  filter: { dojoId?: number | null; fromIso: IsoDate; toIso: IsoDate },
  limit = 200
): Promise<Array<{ sessionId: number; ref: string; className: string; localDate: IsoDate; localStart: string; coachPersonId: number | null }>> {
  assertCan(principal, 'attendance:read', filter.dojoId ? await resourceForOwner(db, { scope: 'dojo', id: filter.dojoId }) : {});

  const rows = await db.select({
    id: sch.classSessions.id,
    ref: sch.classSessions.ref,
    className: sch.dojoClasses.name,
    localDate: sch.classSessions.localDate,
    localStart: sch.classSessions.localStart,
    coachPersonId: sch.classSessions.coachPersonId,
  }).from(sch.classSessions)
    .innerJoin(sch.dojoClasses, eq(sch.dojoClasses.id, sch.classSessions.classId))
    .leftJoin(s.trainingSessions, eq(s.trainingSessions.classSessionId, sch.classSessions.id))
    .where(and(
      isNull(s.trainingSessions.id),
      inArray(sch.classSessions.status, ['scheduled', 'delivered']),
      sql`${sch.classSessions.localDate} >= ${filter.fromIso}`,
      sql`${sch.classSessions.localDate} <= ${filter.toIso}`,
      sql`${sch.classSessions.startsAt} < now()`,
      filter.dojoId
        ? and(eq(sch.dojoClasses.ownerScope, 'dojo'), eq(sch.dojoClasses.ownerId, filter.dojoId))
        : sql`true`
    ))
    .orderBy(asc(sch.classSessions.startsAt))
    .limit(limit);

  return rows.map((r: any) => ({
    sessionId: r.id, ref: r.ref, className: r.className,
    localDate: r.localDate, localStart: r.localStart, coachPersonId: r.coachPersonId,
  }));
}
