// The last hop: the period runs, then produces what it promised.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE CHAIN THIS FILE CLOSES
// ─────────────────────────────────────────────────────────────────────────────
//
//   an application becomes a quotation becomes a contract becomes a programme
//   becomes a schedule of sessions                                (already built)
//        ↓
//   sessions are DELIVERED and attendance is RECORDED             (deliverSession)
//        ↓
//   the programme reaches its end date with its sessions delivered, and its
//   participants become ELIGIBLE                                  (completeProgramme)
//        ↓
//   a NAMED AUTHORITY approves, and a certificate is minted with its number,
//   its verification token and its frozen snapshot                (approveCertification)
//        ↓
//   the entitlement approaching expiry raises ONE renewal notice  (raiseRenewalNotices)
//
// ─────────────────────────────────────────────────────────────────────────────
// ELIGIBILITY IS NOT ISSUE, AND NO TIMER MINTS A CERTIFICATE
// ─────────────────────────────────────────────────────────────────────────────
//
// `completeProgramme()` writes eligibility rows and raises ONE piece of work for
// the authority who may certify. It issues nothing. `approveCertification()` is
// a separate call, gated on 'certificate:issue', requiring a real user id, and
// refusing an approver who wrote the very register they are certifying from.
//
// This is not caution for its own sake. A certificate is the federation's word
// that somebody trained, given to an employer, a school or another association
// years later. §39 and the federation's own instruments put that decision with
// a person, and the failure mode of automating it is not "a wrong row" — it is a
// document in circulation that MMAKF cannot defend and cannot recall.
//
// ─────────────────────────────────────────────────────────────────────────────
// ATTENDANCE IS NEVER INVENTED — IN EITHER DIRECTION
// ─────────────────────────────────────────────────────────────────────────────
//
// Three things follow from that sentence and they are the spine of this file:
//
//  1. A delivered session with an EMPTY register stops the whole programme from
//     completing. Not a warning: the programme is not complete, nobody becomes
//     eligible, and the assessment names the session numbers. A cohort
//     certified off a register nobody filled in is the exact document the brief
//     says the federation cannot defend.
//
//  2. A participant with NO mark at a delivered session is UNRECORDED, never
//     absent. The count is carried separately all the way onto the certificate
//     snapshot. Turning silence into an absence would be this system inventing
//     attendance in the direction that harms the participant; turning it into a
//     presence would invent it in the direction that harms the federation.
//
//  3. A participant the register never once places in the room is INELIGIBLE,
//     and no approval can override it. That is the only verdict this system
//     reaches on its own, and it is a verdict about the RECORD, not the person.
//
// ─────────────────────────────────────────────────────────────────────────────
// THERE IS NO ATTENDANCE THRESHOLD HERE, AND THAT IS DELIBERATE
// ─────────────────────────────────────────────────────────────────────────────
//
// MMAKF has published no minimum attendance requirement for certification. This
// module therefore states the figures and refuses to grade them. "Present at 9
// of 24 delivered sessions" is put in front of a named authority, printed on the
// certificate snapshot, and left to them. An 80% rule invented here would be
// this system setting the federation's certification standard by constant — the
// same class of error as inventing a fee, and harder to spot because nobody
// disputes a rule that merely says no.
//
// ─────────────────────────────────────────────────────────────────────────────
// IDEMPOTENT AT EVERY HOP, BY UNIQUE INDEX
// ─────────────────────────────────────────────────────────────────────────────
//
//   programme_certifications (program_id, participant_id)  one assessment
//   programme_certifications (certificate_id)              one owner per document
//   tasks.idempotency_key                                  one work item
//   renewal_notices (entitlement_id, expires_on)           one notice per term
//   domain_events correlation_id                           one event per fact
//
// A programme completing twice issues no second certificate and raises no second
// notice, and the reason is the database, not a SELECT that two concurrent
// callers both pass.

import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from './schema';
import * as o from './operations.schema';
import * as e from './engagement.schema';
import * as pl from './programme-lifecycle.schema';
import { allocateFederationId, writeAudit, type AuditContext } from './federation';
import { isUniqueViolation } from './pgerror';
import { createTask, taskTemplate } from './tasks';
import { publish } from '@/lib/domain-events';
import {
  assertCanAnywhere, visibleScopes,
  type Action, type Principal,
} from '@/lib/rbac';

type DB = any; // drizzle client or transaction (postgres.js in prod, PGlite in tests)

export class ProgrammeLifecycleError extends Error {
  readonly code: string;
  readonly detail: unknown;
  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = 'ProgrammeLifecycleError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

/** Shape check, not `instanceof` — see the note in src/lib/workflow.ts. */
export function isProgrammeLifecycleError(err: unknown): err is ProgrammeLifecycleError {
  return !!err && typeof err === 'object' && (err as any).name === 'ProgrammeLifecycleError'
    && typeof (err as any).code === 'string';
}

const ISSUING_AUTHORITY = 'Modern Martial Arts Karate-Do Federation of India';

/**
 * The task the federation's certifying authority actually works.
 *
 * `dueInHours` is null here as it is on every other template in this project.
 * MMAKF has published no turnaround for certification, and a deadline invented
 * here is a service commitment the system reports the federation as missing.
 */
export const CERTIFY_PROGRAMME_TASK = 'CERTIFY_PROGRAMME_PARTICIPANTS';

const isoDate = (v: Date | string | null | undefined): string | null =>
  !v ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

/** Sessions that are still expected to happen. Neither delivered nor concluded. */
const OUTSTANDING_SESSION_STATUSES = ['scheduled', 'rescheduled'] as const;

/**
 * Holding the action is necessary and NOT sufficient — the programme has to be
 * one this principal can see.
 *
 * THIS IS NOT BELT AND BRACES, IT IS THE TENANT BOUNDARY. INSTITUTION_COORDINATOR
 * holds 'attendance:write' and is bound at `institution` scope: a coordinator at
 * one school passes `assertCanAnywhere` for every programme in the federation,
 * and without this would be one guessed id away from writing the register of a
 * different school's cohort — and, through the register, of shaping whose
 * children get certified. The predicate goes on the PROGRAMME, because that is
 * the row that knows which unit and which client a session belongs to.
 *
 * Fails closed at both ends: no scope at all is a refusal, and a scoped
 * principal matching none of the programme's three scopes is a refusal.
 */
function assertProgrammeInScope(principal: Principal, programme: any, action: Action): void {
  assertCanAnywhere(principal, action);
  const scopes = visibleScopes(principal, action);
  if (scopes.kind === 'all') return;
  if (scopes.kind === 'none') {
    throw new ProgrammeLifecycleError(
      'forbidden',
      `You hold ${action}, but no binding carrying it resolves to a unit or an institution, ` +
      'so there is no scope this programme could fall inside.'
    );
  }
  if (programme.stateUnitId != null && scopes.states.includes(programme.stateUnitId)) return;
  if (programme.districtUnitId != null && scopes.districts.includes(programme.districtUnitId)) return;
  if (programme.institutionId != null && scopes.institutions.includes(programme.institutionId)) return;
  throw new ProgrammeLifecycleError(
    'forbidden',
    `Programme ${programme.code ?? programme.id} is outside your scope.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DELIVERY — sessions happen, and the register is written
// ═══════════════════════════════════════════════════════════════════════════

export interface AttendanceMark {
  participantId: number;
  present: boolean;
  note?: string | null;
}

export interface AttendanceResult {
  sessionId: number;
  recorded: number;
  corrected: number;
  unchanged: number;
}

async function loadSession(db: DB, sessionId: number) {
  const [row] = await db.select().from(o.programSessions)
    .where(eq(o.programSessions.id, sessionId)).limit(1);
  if (!row) throw new ProgrammeLifecycleError('session_not_found', `No programme session ${sessionId}.`);
  return row;
}

async function loadProgramme(db: DB, programId: number) {
  const [row] = await db.select().from(e.trainingPrograms)
    .where(eq(e.trainingPrograms.id, programId)).limit(1);
  if (!row) throw new ProgrammeLifecycleError('programme_not_found', `No training programme ${programId}.`);
  return row;
}

/**
 * Write the register for one session.
 *
 * A MARK FOR SOMEBODY WHO IS NOT ON THE PROGRAMME IS REFUSED, not silently
 * dropped. Attendance is the evidence a certificate rests on, and a register
 * that quietly accepts strangers is a register that can be pointed at anybody.
 *
 * A CORRECTION KEEPS BOTH READINGS. `corrected_from_present` holds what the
 * coach wrote on the day; the row holds what it was changed to, with who changed
 * it and when (PART AV). Re-submitting the SAME value changes nothing at all,
 * which is what makes a retried upload safe — it must not manufacture a
 * correction trail out of an unchanged mark.
 */
export async function recordAttendance(
  db: DB,
  ctx: AuditContext,
  input: { sessionId: number; marks: AttendanceMark[]; now?: Date }
): Promise<AttendanceResult> {
  const now = input.now ?? new Date();
  const session = await loadSession(db, input.sessionId);
  assertProgrammeInScope(ctx.principal, await loadProgramme(db, session.programId), 'attendance:write');

  if (session.status === 'cancelled') {
    throw new ProgrammeLifecycleError(
      'session_cancelled',
      'This session was cancelled. Nobody attended it, so there is no register to write.'
    );
  }

  const marks = input.marks ?? [];
  if (!marks.length) return { sessionId: session.id, recorded: 0, corrected: 0, unchanged: 0 };

  const ids = [...new Set(marks.map((m) => Number(m.participantId)))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw new ProgrammeLifecycleError('bad_participant', 'Every mark must name a participant.');
  }

  const onRoll = await db.select({ id: e.programParticipants.id })
    .from(e.programParticipants)
    .where(and(
      eq(e.programParticipants.programId, session.programId),
      inArray(e.programParticipants.id, ids)
    ));
  const known = new Set<number>(onRoll.map((r: any) => r.id));
  const strangers = ids.filter((id) => !known.has(id));
  if (strangers.length) {
    throw new ProgrammeLifecycleError(
      'not_on_programme',
      `Participants ${strangers.join(', ')} are not on this programme's roll, so no attendance can be recorded for them.`,
      { programId: session.programId, participantIds: strangers }
    );
  }

  const result: AttendanceResult = { sessionId: session.id, recorded: 0, corrected: 0, unchanged: 0 };

  for (const mark of marks) {
    const present = mark.present === true;
    // Insert first and let the unique index decide. A SELECT then INSERT is the
    // race two coaches submitting the same register at once would both pass.
    const inserted = await db.insert(o.programAttendance).values({
      sessionId: session.id,
      participantId: mark.participantId,
      present,
      note: mark.note ?? null,
      recordedByUserId: ctx.principal.userId ?? null,
      recordedAt: now,
    }).onConflictDoNothing({
      target: [o.programAttendance.sessionId, o.programAttendance.participantId],
    }).returning({ id: o.programAttendance.id });

    if (inserted.length) { result.recorded++; continue; }

    const [existing] = await db.select().from(o.programAttendance)
      .where(and(
        eq(o.programAttendance.sessionId, session.id),
        eq(o.programAttendance.participantId, mark.participantId)
      )).limit(1);

    if (!existing || existing.present === present) { result.unchanged++; continue; }

    await db.update(o.programAttendance).set({
      present,
      note: mark.note ?? existing.note,
      correctedFromPresent: existing.present,
      correctedAt: now,
      correctedByUserId: ctx.principal.userId ?? null,
    }).where(eq(o.programAttendance.id, existing.id));
    result.corrected++;
  }

  await writeAudit(db, ctx, {
    entityType: 'program_session', entityId: session.id, action: 'update',
    newValue: {
      register: true, recorded: result.recorded,
      corrected: result.corrected, unchanged: result.unchanged,
    },
  });

  return result;
}

export interface DeliverSessionResult {
  sessionId: number;
  programId: number;
  delivered: boolean;
  alreadyDelivered: boolean;
  attendance: AttendanceResult;
  note: string;
}

/**
 * Record that a session was delivered, with its register.
 *
 * DELIVERY AND THE REGISTER ARE ALLOWED TO ARRIVE SEPARATELY, because in the
 * field they do: a coach marks the session done from a phone in a school
 * corridor and uploads the marks that evening. Refusing delivery without marks
 * would make the honest sequence impossible and push somebody into typing marks
 * they do not have.
 *
 * The cost of allowing it is a "delivered, register empty" state, and that cost
 * is paid in exactly one place — `assessProgrammeCompletion()` refuses to call
 * the programme complete while any such session exists, and names it. The gap is
 * therefore visible and blocking rather than invisible and permissive.
 *
 * Idempotent: a second call does not move `deliveredAt`, does not re-publish,
 * and still accepts a register that arrived late.
 */
export async function deliverSession(
  db: DB,
  ctx: AuditContext,
  input: { sessionId: number; marks?: AttendanceMark[]; notes?: string | null; now?: Date }
): Promise<DeliverSessionResult> {
  const now = input.now ?? new Date();
  const session = await loadSession(db, input.sessionId);
  assertProgrammeInScope(ctx.principal, await loadProgramme(db, session.programId), 'attendance:write');

  if (session.status === 'cancelled') {
    throw new ProgrammeLifecycleError(
      'session_cancelled',
      `Session ${session.seq} was cancelled${session.cancelledReason ? ` (${session.cancelledReason})` : ''}. ` +
      'A cancelled session cannot be delivered; schedule a replacement instead.'
    );
  }

  const alreadyDelivered = session.status === 'delivered';

  if (!alreadyDelivered) {
    // Guarded on the status we read, so two concurrent deliveries settle on one
    // `deliveredAt` rather than the later one overwriting the earlier.
    await db.update(o.programSessions).set({
      status: 'delivered',
      deliveredAt: now,
      notes: input.notes ?? session.notes,
      updatedAt: now,
    }).where(and(
      eq(o.programSessions.id, session.id),
      ne(o.programSessions.status, 'delivered')
    ));
  }

  const attendance = input.marks?.length
    ? await recordAttendance(db, ctx, { sessionId: session.id, marks: input.marks, now })
    : { sessionId: session.id, recorded: 0, corrected: 0, unchanged: 0 };

  if (!alreadyDelivered) {
    await writeAudit(db, ctx, {
      entityType: 'program_session', entityId: session.id, action: 'finalize',
      oldValue: { status: session.status },
      newValue: { status: 'delivered', deliveredAt: now.toISOString() },
    });

    await publish(db, {
      eventType: 'PROGRAM_SESSION_DELIVERED',
      entityType: 'program_session',
      entityId: session.id,
      payload: {
        programId: session.programId,
        sessionId: session.id,
        seq: session.seq,
        marksRecorded: attendance.recorded,
      },
      // The same session delivered twice is one fact, not two.
      correlationId: `program-session:${session.id}:delivered`,
      actor: ctx.principal,
      occurredAt: now,
    });
  }

  return {
    sessionId: session.id,
    programId: session.programId,
    delivered: true,
    alreadyDelivered,
    attendance,
    note: alreadyDelivered
      ? 'This session was already recorded as delivered; the delivery was not recorded a second time.'
      : 'The session is recorded as delivered.',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPLETION — has the programme actually finished?
// ═══════════════════════════════════════════════════════════════════════════

export interface ProgrammeCheck {
  rule: string;
  ok: boolean;
  detail: string;
}

export interface SessionTally {
  total: number;
  delivered: number;
  cancelled: number;
  outstanding: number;
  other: number;
  planned: number | null;
  deliveredWithEmptyRegister: number[];
}

export interface CompletionAssessment {
  programId: number;
  asAt: string;
  endsOn: string | null;
  status: string;
  complete: boolean;
  reasons: string[];
  checks: ProgrammeCheck[];
  sessions: SessionTally;
}

/**
 * Is this programme finished, and can it be said so from the record alone?
 *
 * A PURE READ. It writes nothing, so it can be shown on an administrator's
 * screen ahead of time and answers the only question that matters there: what
 * is still missing. `reasons` is written to be read by a human who now has to go
 * and fix something.
 *
 * Seven checks, and the last is the one this whole module exists for.
 */
export async function assessProgrammeCompletion(
  db: DB,
  programId: number,
  now: Date = new Date()
): Promise<CompletionAssessment> {
  const programme = await loadProgramme(db, programId);
  const asAt = now.toISOString().slice(0, 10);
  const endsOn = isoDate(programme.endsOn);

  const sessions = await db.select({
    id: o.programSessions.id,
    seq: o.programSessions.seq,
    status: o.programSessions.status,
  })
    .from(o.programSessions)
    .where(eq(o.programSessions.programId, programId))
    .orderBy(asc(o.programSessions.seq));

  const delivered = sessions.filter((x: any) => x.status === 'delivered');
  const cancelled = sessions.filter((x: any) => x.status === 'cancelled');
  const outstanding = sessions.filter((x: any) =>
    (OUTSTANDING_SESSION_STATUSES as readonly string[]).includes(x.status));
  const other = sessions.filter((x: any) =>
    x.status !== 'delivered' && x.status !== 'cancelled'
    && !(OUTSTANDING_SESSION_STATUSES as readonly string[]).includes(x.status));

  // Delivered sessions whose register is empty. One query rather than one per
  // session: a twenty-four-session programme should not cost twenty-four trips.
  const deliveredIds = delivered.map((x: any) => x.id as number);
  let withRegister = new Set<number>();
  if (deliveredIds.length) {
    const rows = await db.select({ sessionId: o.programAttendance.sessionId })
      .from(o.programAttendance)
      .where(inArray(o.programAttendance.sessionId, deliveredIds))
      .groupBy(o.programAttendance.sessionId);
    withRegister = new Set<number>(rows.map((r: any) => r.sessionId));
  }
  const emptyRegisters = delivered
    .filter((x: any) => !withRegister.has(x.id))
    .map((x: any) => x.seq as number);

  const tally: SessionTally = {
    total: sessions.length,
    delivered: delivered.length,
    cancelled: cancelled.length,
    outstanding: outstanding.length,
    other: other.length,
    planned: programme.sessionsPlanned ?? null,
    deliveredWithEmptyRegister: emptyRegisters,
  };

  const checks: ProgrammeCheck[] = [];
  const add = (rule: string, ok: boolean, detail: string) => { checks.push({ rule, ok, detail }); };

  add('programme_not_cancelled', programme.status !== 'cancelled',
    programme.status === 'cancelled'
      ? 'This programme was cancelled. A cancelled programme certifies nobody.'
      : 'The programme is not cancelled.');

  add('end_date_recorded', endsOn != null,
    endsOn != null
      ? `The programme is recorded as ending on ${endsOn}.`
      : 'No end date is recorded for this programme, so nothing here can say it has finished. ' +
        'Record the end date the federation agreed with the institution.');

  add('end_date_passed', endsOn != null && endsOn <= asAt,
    endsOn == null
      ? 'No end date to have passed.'
      : endsOn <= asAt
        ? `The end date ${endsOn} has passed.`
        : `The programme runs until ${endsOn}; today is ${asAt}. It has not finished.`);

  add('sessions_on_the_register', sessions.length > 0,
    sessions.length > 0
      ? `${sessions.length} session${sessions.length === 1 ? '' : 's'} are on the register.`
      : 'No sessions have ever been scheduled against this programme, so there is nothing to have delivered.');

  add('planned_sessions_accounted_for',
    programme.sessionsPlanned == null || sessions.length >= programme.sessionsPlanned,
    programme.sessionsPlanned == null
      ? 'The programme states no planned number of sessions, so there is no shortfall to measure.'
      : sessions.length >= programme.sessionsPlanned
        ? `All ${programme.sessionsPlanned} planned sessions are on the register.`
        : `The programme was planned for ${programme.sessionsPlanned} sessions and only ${sessions.length} ` +
          'are on the register. The missing ones were never scheduled, so nothing records whether they happened.');

  add('no_session_outstanding', outstanding.length === 0,
    outstanding.length === 0
      ? 'No session is still awaiting delivery.'
      : `${outstanding.length} session${outstanding.length === 1 ? ' is' : 's are'} still ` +
        `awaiting delivery (${outstanding.map((x: any) => `#${x.seq}`).join(', ')}). ` +
        'Deliver or cancel each one before the programme can be completed.');

  add('at_least_one_session_delivered', delivered.length > 0,
    delivered.length > 0
      ? `${delivered.length} session${delivered.length === 1 ? ' was' : 's were'} delivered.`
      : 'Not one session was delivered. Nobody trained, so nobody can be certified as having done so.');

  // THE CHECK THIS MODULE EXISTS FOR.
  add('every_delivered_session_has_a_register', emptyRegisters.length === 0,
    emptyRegisters.length === 0
      ? 'Every delivered session has a register.'
      : `Session${emptyRegisters.length === 1 ? '' : 's'} ${emptyRegisters.map((n: number) => `#${n}`).join(', ')} ` +
        `${emptyRegisters.length === 1 ? 'is' : 'are'} recorded as delivered with no attendance at all. ` +
        'Attendance is the only evidence a certificate rests on and it is not invented here — ' +
        'record the register, or correct the session status.');

  const reasons = checks.filter((c) => !c.ok).map((c) => c.detail);

  return {
    programId,
    asAt,
    endsOn,
    status: programme.status,
    complete: reasons.length === 0,
    reasons,
    checks,
    sessions: tally,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ELIGIBILITY — who the register places in the room
// ═══════════════════════════════════════════════════════════════════════════

export interface ParticipantAttendance {
  participantId: number;
  personId: number | null;
  displayName: string | null;
  leftOn: string | null;
  sessionsDelivered: number;
  marksRecorded: number;
  present: number;
  absent: number;
  unrecorded: number;
}

/**
 * Each participant's attendance across the sessions the programme DELIVERED.
 *
 * The denominator is delivered sessions and nothing else. Cancelled sessions are
 * not absences — nobody was asked to attend them — and counting them would
 * penalise a cohort for the federation's own rescheduling.
 */
export async function participantAttendance(
  db: DB,
  programId: number
): Promise<ParticipantAttendance[]> {
  const deliveredIds = (await db.select({ id: o.programSessions.id })
    .from(o.programSessions)
    .where(and(
      eq(o.programSessions.programId, programId),
      eq(o.programSessions.status, 'delivered')
    ))).map((r: any) => r.id as number);

  const roll = await db.select({
    participantId: e.programParticipants.id,
    personId: e.programParticipants.personId,
    displayName: e.programParticipants.displayName,
    fullName: s.persons.fullName,
    leftOn: e.programParticipants.leftOn,
  })
    .from(e.programParticipants)
    .leftJoin(s.persons, eq(s.persons.id, e.programParticipants.personId))
    .where(eq(e.programParticipants.programId, programId))
    .orderBy(asc(e.programParticipants.id));

  const marks = new Map<number, { present: number; absent: number }>();
  if (deliveredIds.length) {
    const rows = await db.select({
      participantId: o.programAttendance.participantId,
      present: sql<number>`count(*) filter (where ${o.programAttendance.present})::int`,
      absent: sql<number>`count(*) filter (where not ${o.programAttendance.present})::int`,
    })
      .from(o.programAttendance)
      .where(inArray(o.programAttendance.sessionId, deliveredIds))
      .groupBy(o.programAttendance.participantId);
    for (const r of rows as any[]) {
      marks.set(r.participantId, { present: Number(r.present), absent: Number(r.absent) });
    }
  }

  return roll.map((p: any) => {
    const m = marks.get(p.participantId) ?? { present: 0, absent: 0 };
    const marksRecorded = m.present + m.absent;
    return {
      participantId: p.participantId,
      personId: p.personId ?? null,
      displayName: p.fullName ?? p.displayName ?? null,
      leftOn: isoDate(p.leftOn),
      sessionsDelivered: deliveredIds.length,
      marksRecorded,
      present: m.present,
      absent: m.absent,
      // Never an absence. See the file header.
      unrecorded: deliveredIds.length - marksRecorded,
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPLETION — freeze the evidence, and put it in front of a person
// ═══════════════════════════════════════════════════════════════════════════

export interface CertificationRow {
  certificationId: number;
  participantId: number;
  personId: number | null;
  displayName: string | null;
  status: 'eligible' | 'ineligible' | 'issued' | 'declined' | 'blocked';
  present: number;
  absent: number;
  unrecorded: number;
  sessionsDelivered: number;
  reason: string | null;
}

export interface CompleteProgrammeResult {
  programId: number;
  assessment: CompletionAssessment;
  alreadyCompleted: boolean;
  eligible: number;
  ineligible: number;
  taskId: number | null;
  taskRef: string | null;
  certifications: CertificationRow[];
  note: string;
}

/**
 * Close a programme that has finished, freeze the register, and raise the work.
 *
 * WHAT THIS DOES NOT DO: issue a certificate. Not one, not to anybody, ever. It
 * writes an eligibility row per participant and ONE task for the certifying
 * authority. `approveCertification()` is the only thing in this file that mints
 * a document, and a person has to call it.
 *
 * ONE TASK, NOT ONE PER CHILD. A school cohort is four hundred participants;
 * four hundred tasks is not a queue, it is a denial of service on the one
 * administrator who would have to work it. The task names the programme, and the
 * certification rows beneath it are the list.
 *
 * Idempotent throughout. Called twice — a retried workflow, two administrators —
 * it produces one assessment per participant and one task, because both are
 * claimed by unique indexes rather than by a prior read.
 */
export async function completeProgramme(
  db: DB,
  ctx: AuditContext,
  programId: number,
  opts: { now?: Date } = {}
): Promise<CompleteProgrammeResult> {
  const now = opts.now ?? new Date();

  const programme = await loadProgramme(db, programId);
  assertProgrammeInScope(ctx.principal, programme, 'program:write');
  const assessment = await assessProgrammeCompletion(db, programId, now);

  if (!assessment.complete) {
    // NOTHING is written. A half-completed programme with eligibility rows for
    // a register that is still missing sessions is worse than no rows at all:
    // the rows look like evidence.
    throw new ProgrammeLifecycleError(
      'not_complete',
      assessment.reasons.join(' '),
      { checks: assessment.checks, sessions: assessment.sessions }
    );
  }

  const attendance = await participantAttendance(db, programId);
  if (!attendance.length) {
    throw new ProgrammeLifecycleError(
      'no_participants',
      'This programme has nobody on its roll, so there is nobody to certify. ' +
      'Record the participants before completing it.'
    );
  }

  const alreadyCompleted = programme.status === 'completed';

  const created = await db.transaction(async (tx: DB) => {
    if (!alreadyCompleted) {
      await tx.update(e.trainingPrograms)
        .set({ status: 'completed', updatedAt: now })
        .where(and(
          eq(e.trainingPrograms.id, programId),
          ne(e.trainingPrograms.status, 'completed')
        ));
    }

    // ── Freeze one assessment per participant ─────────────────────────────
    for (const a of attendance) {
      const ineligible = a.present === 0;
      await tx.insert(pl.programmeCertifications).values({
        programId,
        participantId: a.participantId,
        personId: a.personId,
        status: ineligible ? 'ineligible' : 'eligible',
        sessionsDelivered: a.sessionsDelivered,
        marksRecorded: a.marksRecorded,
        sessionsPresent: a.present,
        sessionsAbsent: a.absent,
        sessionsUnrecorded: a.unrecorded,
        assessedAt: now,
        reason: ineligible
          ? 'The register does not place this participant at a single delivered session, ' +
            'so there is no evidence a certificate could rest on.'
          : null,
        detail: {
          programmeCode: programme.code,
          endsOn: assessment.endsOn,
          sessions: assessment.sessions,
          leftOn: a.leftOn,
          // Said on the record, because the figures above invite a threshold
          // that does not exist and somebody reading this row in three years
          // will assume one was applied.
          thresholdApplied: null,
          thresholdNote:
            'MMAKF has published no minimum attendance requirement. The counts are the register; ' +
            'whether they are sufficient is a named authority’s decision, recorded on approval.',
        } as any,
        createdAt: now,
        updatedAt: now,
      }).onConflictDoNothing({
        target: [pl.programmeCertifications.programId, pl.programmeCertifications.participantId],
      });
    }

    const rows = await tx.select().from(pl.programmeCertifications)
      .where(eq(pl.programmeCertifications.programId, programId))
      .orderBy(asc(pl.programmeCertifications.participantId));

    return { rows, eligibleRows: rows.filter((r: any) => r.status === 'eligible') };
  });

  // ── One piece of work for the authority who may certify ─────────────────
  //
  // OUTSIDE THE TRANSACTION, and that is not a style choice. `createTask()`
  // makes itself idempotent by attempting the INSERT and, on a unique
  // violation, SELECTing the task that already exists. Inside a transaction
  // that recovery is impossible: Postgres aborts the whole transaction on the
  // constraint error and refuses every statement after it, so the second call
  // died on the very query that exists to make the second call safe.
  //
  // The cost is that the certification rows and the task are not written
  // atomically. That is the right trade here, because the failure it admits is
  // one this function already handles: a process dying between the two leaves
  // eligibility recorded with no task, and re-running completeProgramme —
  // which the whole design expects — inserts nothing new and raises the missing
  // task. The alternative failure, a task nobody can find twice over, is not
  // recoverable by re-running anything.
  let task: any = null;
  if (created.eligibleRows.length) {
    // The template carries the role and the escalation. Where it has not been
    // installed the task is still raised, with the same title and role stated
    // inline — a missing template must not mean a missing piece of work.
    const tpl = await taskTemplate(db, CERTIFY_PROGRAMME_TASK);
    task = await createTask(db, ctx, {
      templateCode: tpl ? CERTIFY_PROGRAMME_TASK : null,
      title: `Certify participants — ${programme.title}`,
      detail:
        `${programme.code} finished on ${assessment.endsOn}. ` +
        `${assessment.sessions.delivered} of ${assessment.sessions.total} sessions were delivered and ` +
        `${created.eligibleRows.length} of ${created.rows.length} participants appear in the register. ` +
        'Review each one and approve or decline. MMAKF has published no minimum attendance requirement, ' +
        'so the sufficiency of the figures is your decision and it is recorded against your name.',
      subjectKind: 'training_program',
      subjectId: programId,
      institutionId: programme.institutionId ?? null,
      assignedRole: tpl ? undefined : 'TECHNICAL_DIRECTOR',
      priority: 'normal',
      // ONE task per programme, whatever retries this. The unique index on
      // tasks.idempotency_key is the guarantee, not this call being made once.
      idempotencyKey: `programme-certification:${programId}`,
      now,
    });

    await db.update(pl.programmeCertifications)
      .set({ taskId: task.id, updatedAt: now })
      .where(and(
        eq(pl.programmeCertifications.programId, programId),
        isNull(pl.programmeCertifications.taskId)
      ));
  }

  if (!alreadyCompleted) {
    await writeAudit(db, ctx, {
      entityType: 'training_program', entityId: programId, action: 'finalize',
      oldValue: { status: programme.status },
      newValue: {
        status: 'completed',
        eligible: created.eligibleRows.length,
        assessed: created.rows.length,
        taskRef: task?.ref ?? null,
      },
    });
  }

  await publish(db, {
    eventType: 'PROGRAM_COMPLETED',
    entityType: 'training_program',
    entityId: programId,
    payload: {
      programId,
      code: programme.code,
      institutionId: programme.institutionId ?? null,
      endsOn: assessment.endsOn,
      sessionsDelivered: assessment.sessions.delivered,
      participantsAssessed: created.rows.length,
      participantsEligible: created.eligibleRows.length,
      taskRef: task?.ref ?? null,
    },
    correlationId: `programme:${programId}:completed`,
    actor: ctx.principal,
    occurredAt: now,
  });

  const finalRows = await db.select({
    certificationId: pl.programmeCertifications.id,
    participantId: pl.programmeCertifications.participantId,
    personId: pl.programmeCertifications.personId,
    displayName: e.programParticipants.displayName,
    fullName: s.persons.fullName,
    status: pl.programmeCertifications.status,
    present: pl.programmeCertifications.sessionsPresent,
    absent: pl.programmeCertifications.sessionsAbsent,
    unrecorded: pl.programmeCertifications.sessionsUnrecorded,
    sessionsDelivered: pl.programmeCertifications.sessionsDelivered,
    reason: pl.programmeCertifications.reason,
  })
    .from(pl.programmeCertifications)
    .innerJoin(e.programParticipants,
      eq(e.programParticipants.id, pl.programmeCertifications.participantId))
    .leftJoin(s.persons, eq(s.persons.id, pl.programmeCertifications.personId))
    .where(eq(pl.programmeCertifications.programId, programId))
    .orderBy(asc(pl.programmeCertifications.participantId));

  const certifications: CertificationRow[] = finalRows.map((r: any) => ({
    certificationId: r.certificationId,
    participantId: r.participantId,
    personId: r.personId ?? null,
    displayName: r.fullName ?? r.displayName ?? null,
    status: r.status,
    present: r.present,
    absent: r.absent,
    unrecorded: r.unrecorded,
    sessionsDelivered: r.sessionsDelivered,
    reason: r.reason ?? null,
  }));

  const eligible = certifications.filter((c) => c.status === 'eligible').length;
  const ineligible = certifications.filter((c) => c.status === 'ineligible').length;

  return {
    programId,
    assessment,
    alreadyCompleted,
    eligible,
    ineligible,
    taskId: task?.id ?? null,
    taskRef: task?.ref ?? null,
    certifications,
    note: alreadyCompleted
      ? 'This programme was already completed; the existing assessment was returned and nothing was issued again.'
      : `${eligible} participant${eligible === 1 ? '' : 's'} may now be certified by an authority. ` +
        'No certificate has been issued — that decision is a person’s.',
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// APPROVAL — a named authority, and only then a document
// ═══════════════════════════════════════════════════════════════════════════

export interface CertificationDecision {
  certificationId: number;
  status: 'issued' | 'declined' | 'blocked';
  certificateId: number | null;
  certificateNo: string | null;
  alreadyIssued: boolean;
  note: string;
}

async function loadCertification(db: DB, certificationId: number) {
  const [row] = await db.select().from(pl.programmeCertifications)
    .where(eq(pl.programmeCertifications.id, certificationId)).limit(1);
  if (!row) {
    throw new ProgrammeLifecycleError('certification_not_found', `No certification ${certificationId}.`);
  }
  return row;
}

/**
 * Who may not sign this off.
 *
 * THE PERSON WHO WROTE THE REGISTER MAY NOT CERTIFY FROM IT. That is the same
 * rule as "the approver may not be the issuer" on a quotation, moved to the
 * document that matters more: the register is the whole evidence base, and one
 * person who both writes the evidence and rules on it is not a control, it is a
 * signature.
 *
 * The lead coach is refused for the same reason even where they touched no mark
 * themselves — the programme is theirs, and certifying their own delivery is the
 * conflict the rule is named for.
 *
 * A SYSTEM PRINCIPAL IS REFUSED OUTRIGHT. An automation has no identity to
 * separate from the recorder's, so there is nothing for this rule to check, and
 * a certificate signed by nobody is exactly what §39 forbids.
 *
 * Three gates in order, and each refuses for its own reason: identity, then
 * authority-and-scope (`assertProgrammeInScope`, so holding 'certificate:issue'
 * somewhere is not holding it over THIS programme), then separation of duties.
 */
async function assertMayCertify(db: DB, ctx: AuditContext, programme: any): Promise<void> {
  // IDENTITY BEFORE AUTHORITY, and that ordering is the message rather than the
  // outcome. A cron with no bindings fails the permission gate too, but
  // "Forbidden: certificate:issue" sends its operator looking for a role to
  // grant. The refusal they need to read is that certification is not
  // automatable at all, and no grant will make it so.
  const userId = ctx.principal.userId ?? null;
  if (userId == null) {
    throw new ProgrammeLifecycleError(
      'no_identified_approver',
      'A certificate must be approved by an identified person. This call carries no user id — ' +
      'an automation or a system context cannot certify that somebody trained.'
    );
  }

  assertProgrammeInScope(ctx.principal, programme, 'certificate:issue');

  const [wrote] = await db.select({ id: o.programAttendance.id })
    .from(o.programAttendance)
    .innerJoin(o.programSessions, eq(o.programSessions.id, o.programAttendance.sessionId))
    .where(and(
      eq(o.programSessions.programId, programme.id),
      or(
        eq(o.programAttendance.recordedByUserId, userId),
        eq(o.programAttendance.correctedByUserId, userId)
      )
    ))
    .limit(1);

  if (wrote) {
    throw new ProgrammeLifecycleError(
      'approver_wrote_the_register',
      'You recorded or corrected attendance on this programme, so you may not also certify from it. ' +
      'A second authority has to approve these certificates.'
    );
  }

  if (programme.leadCoachPersonId != null) {
    const [me] = await db.select({ personId: s.users.personId })
      .from(s.users).where(eq(s.users.id, userId)).limit(1);
    if (me?.personId && me.personId === programme.leadCoachPersonId) {
      throw new ProgrammeLifecycleError(
        'approver_is_the_lead_coach',
        'You are the lead coach on this programme, so you may not certify your own delivery. ' +
        'A second authority has to approve these certificates.'
      );
    }
  }
}

/**
 * Approve one eligibility row, and mint the certificate.
 *
 * ONE TRANSACTION, AND THE CLAIM IS ITS LAST STATEMENT. src/db/entitlements.ts
 * claims before it acts, because the thing it acts on lives outside its own
 * transaction. Here it cannot: `programme_certifications_issued_ck` requires a
 * row calling itself issued to name its certificate, so the status and the
 * certificate id have to move together, in one guarded UPDATE, after the
 * document exists.
 *
 * The safety is identical, because the whole thing is one transaction. The guard
 * is on the status this call read AND on `certificate_id IS NULL`, so exactly
 * one of two concurrent approvals matches a row; the loser raises, its
 * transaction rolls back, and the certificate it had inserted is undone with it.
 * Nothing survives to be a second document and the reference sequence is not
 * even spent. The loser then re-reads and returns the winner's certificate.
 *
 * `certificate_id` is unique on this table, so even a defect elsewhere cannot
 * attach two certifications to one document.
 */
export async function approveCertification(
  db: DB,
  ctx: AuditContext,
  input: {
    certificationId: number;
    title?: string;
    signedByPersonId?: number | null;
    issuedOn?: string;
    now?: Date;
  }
): Promise<CertificationDecision> {
  const now = input.now ?? new Date();
  const cert = await loadCertification(db, input.certificationId);
  const programme = await loadProgramme(db, cert.programId);

  await assertMayCertify(db, ctx, programme);

  if (cert.status === 'issued') {
    const existing = cert.certificateId
      ? (await db.select().from(s.certificates)
          .where(eq(s.certificates.id, cert.certificateId)).limit(1))[0]
      : null;
    return {
      certificationId: cert.id,
      status: 'issued',
      certificateId: existing?.id ?? null,
      certificateNo: existing?.certificateNo ?? null,
      alreadyIssued: true,
      note: 'This certificate had already been issued; it was not issued again.',
    };
  }

  if (cert.status === 'ineligible') {
    throw new ProgrammeLifecycleError(
      'ineligible',
      cert.reason ??
      'The register does not place this participant at a single delivered session. ' +
      'No approval can supply evidence that was never recorded.'
    );
  }

  if (cert.status === 'declined') {
    throw new ProgrammeLifecycleError(
      'already_declined',
      `This certification was declined${cert.reason ? ` (${cert.reason})` : ''}. ` +
      'Reversing a recorded decision is not an edit — the federation has to make a fresh one.'
    );
  }

  // The holder, read from the roll AS IT IS NOW rather than only from the
  // frozen copy. `blocked` exists precisely for the cohort child who had no
  // person record at completion; once the federation registers them, the same
  // approval should be able to finish, and that is only possible if this looks
  // at the participant again.
  const [participant] = await db.select().from(e.programParticipants)
    .where(eq(e.programParticipants.id, cert.participantId)).limit(1);
  const personId: number | null = cert.personId ?? participant?.personId ?? null;

  // A participant the federation holds no person record for. `certificates`
  // requires one, and there is nothing here to invent — a certificate needs a
  // named holder in the register or it verifies to nobody. Recorded rather than
  // thrown, so the school desk gets the whole list of children to enrol.
  if (personId == null) {
    const reason =
      'This participant has no person record in the federation register, so a certificate has no holder to name. ' +
      'Register the participant, then approve again — this decision is kept and does not have to be retaken.';
    if (cert.status === 'blocked') {
      throw new ProgrammeLifecycleError('blocked', cert.reason ?? reason);
    }
    await db.update(pl.programmeCertifications)
      .set({ status: 'blocked', reason, approvedByUserId: ctx.principal.userId ?? null, approvedAt: now, updatedAt: now })
      .where(and(
        eq(pl.programmeCertifications.id, cert.id),
        eq(pl.programmeCertifications.status, 'eligible')
      ));
    await writeAudit(db, ctx, {
      entityType: 'programme_certification', entityId: cert.id, action: 'update',
      oldValue: { status: 'eligible' }, newValue: { status: 'blocked', reason },
    });
    return {
      certificationId: cert.id,
      status: 'blocked',
      certificateId: null,
      certificateNo: null,
      alreadyIssued: false,
      note: reason,
    };
  }

  const [person] = await db.select().from(s.persons)
    .where(eq(s.persons.id, personId)).limit(1);
  if (!person) {
    throw new ProgrammeLifecycleError(
      'person_not_found',
      `Person ${personId} is no longer in the register, so no certificate can name them.`
    );
  }

  const issuedOn = input.issuedOn ?? now.toISOString().slice(0, 10);
  const title = input.title?.trim()
    || `${programme.title} — Programme Completion`;

  let outcome: any = null;
  try {
    outcome = await db.transaction(async (tx: DB) => {
      const certificateNo = await allocateFederationId(tx, 'CERT', now.getFullYear());

    const [document] = await tx.insert(s.certificates).values({
      certificateNo,
      // 'course_completion' and NOT a grade. An institutional programme confers
      // no rank and never becomes one; no rank_records row is written here, and
      // the snapshot says so in words a verifier reads.
      kind: 'course_completion',
      personId,
      title,
      issuedOn,
      validFrom: issuedOn,
      // NULL. The federation has published no validity period for a programme
      // completion, and a date invented here would expire a document MMAKF
      // never said expires.
      validTo: null,
      issuingAuthority: ISSUING_AUTHORITY,
      signedByPersonId: input.signedByPersonId ?? programme.leadCoachPersonId ?? null,
      status: 'issued',
      // Unguessable, and the only thing the QR carries — never the person id.
      verifyToken: crypto.randomBytes(18).toString('base64url'),
      snapshot: {
        certificateNo,
        holder: person.fullName,
        federationId: person.federationId,
        programme: {
          code: programme.code,
          title: programme.title,
          startsOn: isoDate(programme.startsOn),
          endsOn: isoDate(programme.endsOn),
          institutionId: programme.institutionId ?? null,
        },
        attendance: {
          sessionsDelivered: cert.sessionsDelivered,
          present: cert.sessionsPresent,
          absent: cert.sessionsAbsent,
          // Printed, not hidden. A reader is entitled to know how much of the
          // register was silent about this person.
          unrecorded: cert.sessionsUnrecorded,
        },
        // The sentence that stops a later reader inferring a standard that does
        // not exist. It is on the document, not only in this file.
        attendanceBasis:
          'MMAKF has published no minimum attendance requirement for programme certification. ' +
          'The figures above are the register as it stood on completion, and the decision to certify ' +
          'was taken by the named approver.',
        approvedBy: ctx.principal.label,
        approvedByUserId: ctx.principal.userId ?? null,
        issuedAt: now.toISOString(),
        // Distinguishes this from an examined grade at every verification.
        provenance: 'programme',
        confersRank: false,
      } as any,
    }).returning();

      // CLAIM, and it is the LAST statement of the transaction rather than the
      // first. `programme_certifications_issued_ck` demands that a row calling
      // itself issued names its certificate, so status and certificate_id have
      // to move in ONE statement — a claim that set the status first would fail
      // the constraint before there was anything to name.
      //
      // The safety is not weakened by the reordering: this update is guarded on
      // the status this call read and on `certificate_id IS NULL`, so of two
      // concurrent approvals exactly one matches a row. The loser throws, its
      // WHOLE transaction rolls back, and the certificate it had just inserted
      // — number and all — is undone with it. Nothing survives to be a second
      // document, and the sequence is not even spent.
      const claimed = await tx.update(pl.programmeCertifications)
        .set({
          status: 'issued',
          certificateId: document.id,
          personId,
          approvedByUserId: ctx.principal.userId ?? null,
          approvedAt: now,
          reason: null,
          updatedAt: now,
        })
        .where(and(
          eq(pl.programmeCertifications.id, cert.id),
          eq(pl.programmeCertifications.status, cert.status),
          isNull(pl.programmeCertifications.certificateId)
        ))
        .returning({ id: pl.programmeCertifications.id });

      if (!claimed.length) throw new ProgrammeLifecycleError('lost_race', 'lost');

      return document;
    });
  } catch (err) {
    if (!isProgrammeLifecycleError(err) || err.code !== 'lost_race') throw err;
    outcome = null;
  }

  if (!outcome) {
    const again = await loadCertification(db, cert.id);
    const existing = again.certificateId
      ? (await db.select().from(s.certificates)
          .where(eq(s.certificates.id, again.certificateId)).limit(1))[0]
      : null;
    return {
      certificationId: cert.id,
      status: again.status,
      certificateId: existing?.id ?? null,
      certificateNo: existing?.certificateNo ?? null,
      alreadyIssued: again.status === 'issued',
      note: 'Another approval reached this certification first; nothing was issued a second time.',
    };
  }

  await writeAudit(db, ctx, {
    entityType: 'certificate', entityId: outcome.id, action: 'approve',
    newValue: {
      certificateNo: outcome.certificateNo,
      personId: cert.personId,
      programId: programme.id,
      certificationId: cert.id,
      provenance: 'programme',
    },
  });

  await publish(db, {
    eventType: 'CERTIFICATE_ISSUED',
    entityType: 'certificate',
    entityId: outcome.id,
    payload: {
      personId,
      certificateId: outcome.id,
      certificateNo: outcome.certificateNo,
      provenance: 'programme',
      issuingAuthority: ISSUING_AUTHORITY,
      awardedOn: issuedOn,
    },
    // One document, one event, however many retries reach here.
    correlationId: `programme-certification:${cert.id}`,
    actor: ctx.principal,
    occurredAt: now,
  });

  return {
    certificationId: cert.id,
    status: 'issued',
    certificateId: outcome.id,
    certificateNo: outcome.certificateNo,
    alreadyIssued: false,
    note: `Certificate ${outcome.certificateNo} was issued to ${person.fullName}.`,
  };
}

/**
 * An authority looks at the figures and says no.
 *
 * A real answer and a kept one. `declined` is not `ineligible`: the first is a
 * federation decision with a name and a reason against it, the second is an
 * absence of evidence. Collapsing them would lose the only record that anybody
 * considered the case at all.
 */
export async function declineCertification(
  db: DB,
  ctx: AuditContext,
  input: { certificationId: number; reason: string; now?: Date }
): Promise<CertificationDecision> {
  const now = input.now ?? new Date();
  const reason = String(input.reason ?? '').trim();
  if (!reason) {
    throw new ProgrammeLifecycleError(
      'reason_required',
      'Declining a certification needs a reason. The participant is entitled to be told one.'
    );
  }

  const cert = await loadCertification(db, input.certificationId);
  const programme = await loadProgramme(db, cert.programId);
  await assertMayCertify(db, ctx, programme);

  if (cert.status === 'issued') {
    throw new ProgrammeLifecycleError(
      'already_issued',
      'This certificate has already been issued. Withdrawing it is a revocation, which is a different act ' +
      'with its own record — it does not happen by editing this row.'
    );
  }

  const updated = await db.update(pl.programmeCertifications)
    .set({
      status: 'declined',
      reason,
      approvedByUserId: ctx.principal.userId ?? null,
      approvedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(pl.programmeCertifications.id, cert.id),
      inArray(pl.programmeCertifications.status, ['eligible', 'blocked'])
    ))
    .returning({ id: pl.programmeCertifications.id });

  if (!updated.length) {
    return {
      certificationId: cert.id,
      status: cert.status,
      certificateId: cert.certificateId ?? null,
      certificateNo: null,
      alreadyIssued: cert.status === 'issued',
      note: `This certification is ${cert.status}; nothing was changed.`,
    };
  }

  await writeAudit(db, ctx, {
    entityType: 'programme_certification', entityId: cert.id, action: 'reject',
    oldValue: { status: cert.status }, newValue: { status: 'declined', reason },
  });

  return {
    certificationId: cert.id,
    status: 'declined',
    certificateId: null,
    certificateNo: null,
    alreadyIssued: false,
    note: 'The certification was declined, with the reason recorded.',
  };
}

/** The certifying authority's list for one programme. */
export async function certificationQueue(
  db: DB,
  principal: Principal,
  programId: number,
  opts: { status?: string; limit?: number } = {}
): Promise<CertificationRow[]> {
  assertProgrammeInScope(principal, await loadProgramme(db, programId), 'certificate:read');
  const limit = Math.max(1, Math.min(1000, Math.floor(opts.limit ?? 500)));

  const where: any[] = [eq(pl.programmeCertifications.programId, programId)];
  if (opts.status) where.push(eq(pl.programmeCertifications.status, opts.status as any));

  const rows = await db.select({
    certificationId: pl.programmeCertifications.id,
    participantId: pl.programmeCertifications.participantId,
    personId: pl.programmeCertifications.personId,
    displayName: e.programParticipants.displayName,
    fullName: s.persons.fullName,
    status: pl.programmeCertifications.status,
    present: pl.programmeCertifications.sessionsPresent,
    absent: pl.programmeCertifications.sessionsAbsent,
    unrecorded: pl.programmeCertifications.sessionsUnrecorded,
    sessionsDelivered: pl.programmeCertifications.sessionsDelivered,
    reason: pl.programmeCertifications.reason,
  })
    .from(pl.programmeCertifications)
    .innerJoin(e.programParticipants,
      eq(e.programParticipants.id, pl.programmeCertifications.participantId))
    .leftJoin(s.persons, eq(s.persons.id, pl.programmeCertifications.personId))
    .where(and(...where))
    .orderBy(asc(pl.programmeCertifications.participantId))
    .limit(limit);

  return rows.map((r: any) => ({
    certificationId: r.certificationId,
    participantId: r.participantId,
    personId: r.personId ?? null,
    displayName: r.fullName ?? r.displayName ?? null,
    status: r.status,
    present: r.present,
    absent: r.absent,
    unrecorded: r.unrecorded,
    sessionsDelivered: r.sessionsDelivered,
    reason: r.reason ?? null,
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// RENEWAL — the entitlement approaching expiry, told once
// ═══════════════════════════════════════════════════════════════════════════

export interface ExpiringEntitlement {
  entitlementId: number;
  subject: string;
  subjectId: number | null;
  personId: number | null;
  expiresOn: string;
  daysRemaining: number;
  basis: string;
}

export interface RenewalSweepReport {
  asAt: string;
  withinDays: number;
  considered: number;
  raised: number;
  alreadyRaised: number;
  withNoRecipient: number;
  notices: ExpiringEntitlement[];
  truncated: boolean;
}

const MAX_RENEWAL_ROWS = 1000;

function requireWindow(withinDays: unknown): number {
  const n = Number(withinDays);
  if (!Number.isInteger(n) || n < 1 || n > 365) {
    throw new ProgrammeLifecycleError(
      'window_not_stated',
      'State how many days of notice to give, as a whole number of days between 1 and 365. ' +
      'There is no default here: MMAKF has published no renewal window, and a number this system chose ' +
      'would become the federation’s notice period without anybody deciding it.'
    );
  }
  return n;
}

/**
 * Active entitlements whose term is running out, with WHERE the date came from.
 *
 * THE EXPIRY IS NEVER DERIVED FROM THE FEE. `entitlement_terms.term_months` says
 * how long a term runs, but the authoritative end date is on the thing that was
 * issued — the membership row that `renew()` may since have extended, the
 * certificate the office may have re-dated, the enrolment somebody extended by
 * hand. Recomputing months from the payment would produce a date that disagrees
 * with the member's own record, and the member is looking at the record.
 *
 * WHERE NO EXPIRY EXISTS, NONE IS INVENTED. An entitlement whose subject carries
 * no end date — an event entry, a grading fee, an open-ended membership — yields
 * nothing at all here. It is not "expiring in 12 months by default", and the
 * `basis` column on every notice that IS raised names the column the date came
 * from, so a disputed notice can be traced to a real value.
 *
 * AND WHERE ONE DOES EXIST, IT IS NOT SKIPPED FOR WANT OF A SUBJECT TABLE. A
 * fourth pass reads `entitlements.valid_to` for every subject the three above
 * did not claim — `program` today — because that column is the period the payer
 * bought, recorded once at activation and never recomputed. Leaving it out was
 * not caution: it was a school's programme access ending on a date nothing in
 * this system would report.
 *
 * GATED ON 'finance:read' AND NOT NARROWED BY SCOPE, which is the same treatment
 * `blockedEntitlements()` and `activationBacklog()` give the same table, and it
 * is stated here rather than left to be discovered. Only four roles hold that
 * action and none of them is an institution-side one, so no client can reach
 * this; a FINANCE_OFFICER bound to one state would nevertheless see the whole
 * register's renewals. Narrowing it means deciding whose renewals a state
 * treasurer may see, and that is a federation decision nobody has taken.
 */
export async function dueForRenewal(
  db: DB,
  principal: Principal,
  opts: { withinDays: number; asAt?: string; limit?: number }
): Promise<{ asAt: string; withinDays: number; rows: ExpiringEntitlement[]; truncated: boolean }> {
  assertCanAnywhere(principal, 'finance:read');
  return dueForRenewalInternal(db, opts);
}

async function dueForRenewalInternal(
  db: DB,
  opts: { withinDays: number; asAt?: string; limit?: number }
): Promise<{ asAt: string; withinDays: number; rows: ExpiringEntitlement[]; truncated: boolean }> {
  const withinDays = requireWindow(opts.withinDays);
  const asAt = opts.asAt ?? new Date().toISOString().slice(0, 10);
  const limit = Math.max(1, Math.min(MAX_RENEWAL_ROWS, Math.floor(opts.limit ?? 500)));

  const horizon = new Date(`${asAt}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + withinDays);
  const horizonIso = horizon.toISOString().slice(0, 10);

  const daysBetween = (to: string) =>
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${asAt}T00:00:00Z`)) / 86_400_000);

  const rows: ExpiringEntitlement[] = [];

  // ── Memberships ────────────────────────────────────────────────────────
  const memberships = await db.select({
    entitlementId: s.entitlements.id,
    subjectId: s.entitlements.subjectId,
    personId: s.memberships.personId,
    validTo: s.memberships.validTo,
  })
    .from(s.entitlements)
    .innerJoin(s.memberships, eq(s.memberships.id, s.entitlements.subjectId))
    .where(and(
      eq(s.entitlements.status, 'active'),
      eq(s.entitlements.subject, 'membership'),
      eq(s.memberships.status, 'active'),
      isNotNull(s.memberships.validTo),
      gte(s.memberships.validTo, asAt),
      lte(s.memberships.validTo, horizonIso)
    ))
    .orderBy(asc(s.memberships.validTo), asc(s.entitlements.id))
    .limit(limit + 1);

  for (const r of memberships as any[]) {
    rows.push({
      entitlementId: r.entitlementId,
      subject: 'membership',
      subjectId: r.subjectId ?? null,
      personId: r.personId ?? null,
      expiresOn: isoDate(r.validTo)!,
      daysRemaining: daysBetween(isoDate(r.validTo)!),
      basis: 'memberships.valid_to',
    });
  }

  // ── Course enrolments ──────────────────────────────────────────────────
  const courses = await db.select({
    entitlementId: s.entitlements.id,
    subjectId: s.entitlements.subjectId,
    personId: s.enrolments.personId,
    expiresAt: s.enrolments.expiresAt,
  })
    .from(s.entitlements)
    .innerJoin(s.enrolments, eq(s.enrolments.id, s.entitlements.subjectId))
    .where(and(
      eq(s.entitlements.status, 'active'),
      eq(s.entitlements.subject, 'course'),
      eq(s.enrolments.status, 'active'),
      isNotNull(s.enrolments.expiresAt),
      gte(s.enrolments.expiresAt, new Date(`${asAt}T00:00:00Z`)),
      lte(s.enrolments.expiresAt, new Date(`${horizonIso}T23:59:59Z`))
    ))
    .orderBy(asc(s.enrolments.expiresAt), asc(s.entitlements.id))
    .limit(limit + 1);

  for (const r of courses as any[]) {
    const on = isoDate(r.expiresAt)!;
    rows.push({
      entitlementId: r.entitlementId,
      subject: 'course',
      subjectId: r.subjectId ?? null,
      personId: r.personId ?? null,
      expiresOn: on,
      daysRemaining: daysBetween(on),
      basis: 'enrolments.expires_at',
    });
  }

  // ── Certificates and documents that carry an end date ──────────────────
  const documents = await db.select({
    entitlementId: s.entitlements.id,
    subject: s.entitlements.subject,
    subjectId: s.entitlements.subjectId,
    personId: s.certificates.personId,
    validTo: s.certificates.validTo,
  })
    .from(s.entitlements)
    .innerJoin(s.certificates, eq(s.certificates.id, s.entitlements.subjectId))
    .where(and(
      eq(s.entitlements.status, 'active'),
      inArray(s.entitlements.subject, ['certificate', 'document']),
      inArray(s.certificates.status, ['issued', 'reissued']),
      isNotNull(s.certificates.validTo),
      gte(s.certificates.validTo, asAt),
      lte(s.certificates.validTo, horizonIso)
    ))
    .orderBy(asc(s.certificates.validTo), asc(s.entitlements.id))
    .limit(limit + 1);

  for (const r of documents as any[]) {
    rows.push({
      entitlementId: r.entitlementId,
      subject: r.subject,
      subjectId: r.subjectId ?? null,
      personId: r.personId ?? null,
      expiresOn: isoDate(r.validTo)!,
      daysRemaining: daysBetween(isoDate(r.validTo)!),
      basis: 'certificates.valid_to',
    });
  }

  // ── Everything else a payment bought that carries a recorded end date ──
  //
  // THIS BRANCH IS THE FIX FOR A SILENT LAPSE, and the silence was the whole
  // problem. The three branches above read the end date off the thing that was
  // ISSUED, which is right where such a thing exists. Where it does not — a
  // `program` entitlement, whose subject is a training programme and not a
  // document with a validity date — the sweep found nothing and reported
  // nothing, so an institution's programme access simply stopped: the technical
  // library, the live classes and the course material that src/db/activation.ts
  // gates on `entitlements.valid_to` all closed on a date nobody was told about
  // and no list showed.
  //
  // `entitlements.valid_to` IS NOT A GUESS AND IS NOT DERIVED FROM THE FEE. It
  // is the period the payer actually bought, written once at activation from the
  // programme's own dates or the federation's configured term, and never
  // recomputed — the schema comment on that column says so in as many words: "a
  // fee rule edited in 2028 must not re-date what a school bought in 2026".
  // Reading a value the federation recorded is the opposite of inventing one.
  //
  // NOT AN ALLOWLIST OF SUBJECTS, deliberately. It is everything the three
  // branches above did not claim, so a subject the federation adds next is
  // covered the day it starts issuing terms rather than the day somebody
  // remembers this file. Nothing is invented for the subjects that legitimately
  // never expire — an event entry, a grading, a booking write no `valid_to` at
  // all, and `isNotNull` drops them without this code needing to know their
  // names.
  //
  // THE RECIPIENT IS THE ORDER'S OWN PERSON, not one derived from the subject.
  // `entitlements` names no person, and the honest answer to "who is told" is
  // the person the order was raised for. Where the order names nobody — an
  // institutional order raised against a contract — the row still appears in
  // this list and `raiseRenewalNotices()` counts it in `withNoRecipient` rather
  // than publishing an event the fan-out would address to whoever shares an id
  // with the entitlement.
  const others = await db.select({
    entitlementId: s.entitlements.id,
    subject: s.entitlements.subject,
    subjectId: s.entitlements.subjectId,
    personId: s.orders.personId,
    validTo: s.entitlements.validTo,
  })
    .from(s.entitlements)
    .innerJoin(s.orders, eq(s.orders.id, s.entitlements.orderId))
    .where(and(
      eq(s.entitlements.status, 'active'),
      notInArray(s.entitlements.subject, ['membership', 'course', 'certificate', 'document']),
      isNotNull(s.entitlements.validTo),
      gte(s.entitlements.validTo, asAt),
      lte(s.entitlements.validTo, horizonIso)
    ))
    .orderBy(asc(s.entitlements.validTo), asc(s.entitlements.id))
    .limit(limit + 1);

  for (const r of others as any[]) {
    const on = isoDate(r.validTo)!;
    rows.push({
      entitlementId: r.entitlementId,
      subject: r.subject,
      subjectId: r.subjectId ?? null,
      personId: r.personId ?? null,
      expiresOn: on,
      daysRemaining: daysBetween(on),
      basis: 'entitlements.valid_to',
    });
  }

  rows.sort((a, b) => a.expiresOn.localeCompare(b.expiresOn) || a.entitlementId - b.entitlementId);
  const truncated = rows.length > limit;
  return { asAt, withinDays, rows: rows.slice(0, limit), truncated };
}

/**
 * Raise the renewal notice, once, for everything running out inside the window.
 *
 * NOT AUTHORISATION-GATED, and for the same reason `escalateOverdueTasks()` is
 * not: this is a scheduled job run by a cron with no role bindings, not a query
 * surface. It reaches no HTTP route except through one that gates itself, and
 * every recipient is resolved from the record rather than from an argument.
 *
 * ONCE IS ENFORCED BY THE DATABASE. `renewal_notices (entitlement_id,
 * expires_on)` is unique, so a sweep run every morning for six weeks writes one
 * row and publishes one event. Renewing the entitlement moves the expiry date,
 * which earns the NEXT term its own notice with no scheduling state kept
 * anywhere.
 *
 * AN ENTITLEMENT WITH NOBODY TO WRITE TO IS COUNTED, NOT GUESSED AT. The
 * notification fan-out resolves 'subject' from `payload.personId` and falls back
 * to the event's entity id; publishing without a personId would therefore
 * address the notice to whichever PERSON happens to share an id with the
 * ENTITLEMENT. So a row with no person is reported in `withNoRecipient` and no
 * event is published for it.
 */
export async function raiseRenewalNotices(
  db: DB,
  ctx: AuditContext,
  opts: { withinDays: number; asAt?: string; limit?: number; now?: Date }
): Promise<RenewalSweepReport> {
  const now = opts.now ?? new Date();
  const { asAt, withinDays, rows, truncated } = await dueForRenewalInternal(db, {
    withinDays: opts.withinDays,
    asAt: opts.asAt ?? now.toISOString().slice(0, 10),
    limit: opts.limit,
  });

  const report: RenewalSweepReport = {
    asAt, withinDays,
    considered: rows.length,
    raised: 0,
    alreadyRaised: 0,
    withNoRecipient: 0,
    notices: [],
    truncated,
  };

  for (const row of rows) {
    if (row.personId == null) {
      report.withNoRecipient++;
      continue;
    }

    // The unique index decides whether this is the first notice for this term.
    // A SELECT first would let two overlapping sweeps both find nothing.
    let claimed: any[];
    try {
      claimed = await db.insert(pl.renewalNotices).values({
        entitlementId: row.entitlementId,
        subject: row.subject as any,
        subjectId: row.subjectId,
        personId: row.personId,
        expiresOn: row.expiresOn,
        noticeDays: row.daysRemaining,
        basis: row.basis,
        raisedAt: now,
      }).onConflictDoNothing({
        target: [pl.renewalNotices.entitlementId, pl.renewalNotices.expiresOn],
      }).returning({ id: pl.renewalNotices.id });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      claimed = [];
    }

    if (!claimed.length) { report.alreadyRaised++; continue; }

    // MEMBERSHIP_EXPIRING has been in the catalogue and in NOTIFIABLE since the
    // beginning with no producer at all. This is its producer. Everything that
    // is not a membership travels as ENTITLEMENT_EXPIRING, which says the same
    // thing about a subject the member's own words for a membership would
    // misdescribe.
    const isMembership = row.subject === 'membership';
    const { event } = await publish(db, {
      eventType: isMembership ? 'MEMBERSHIP_EXPIRING' : 'ENTITLEMENT_EXPIRING',
      entityType: isMembership ? 'membership' : 'entitlement',
      entityId: isMembership ? (row.subjectId ?? row.entitlementId) : row.entitlementId,
      payload: isMembership
        ? {
            personId: row.personId,
            membershipId: row.subjectId,
            expiresOn: row.expiresOn,
            entitlementId: row.entitlementId,
            noticeDays: row.daysRemaining,
          }
        : {
            personId: row.personId,
            entitlementId: row.entitlementId,
            subject: row.subject,
            subjectId: row.subjectId,
            expiresOn: row.expiresOn,
            noticeDays: row.daysRemaining,
          },
      // One notice per term on the feed as well as in the table.
      correlationId: `renewal:${row.entitlementId}:${row.expiresOn}`,
      actor: ctx.principal,
      occurredAt: now,
    });

    await db.update(pl.renewalNotices)
      .set({ domainEventId: event.id })
      .where(eq(pl.renewalNotices.id, claimed[0].id));

    report.raised++;
    report.notices.push(row);
  }

  if (report.raised > 0) {
    await writeAudit(db, ctx, {
      entityType: 'renewal_notice', entityId: null, action: 'create',
      newValue: { asAt, withinDays, raised: report.raised, alreadyRaised: report.alreadyRaised },
    });
  }

  return report;
}
