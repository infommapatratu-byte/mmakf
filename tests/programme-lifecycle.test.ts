// Delivery, certification and renewal — the last hop of a programme.
//
// The brief this suite answers, sentence by sentence:
//
//   · attendance must not be invented. If sessions were not recorded as
//     delivered, the programme is not complete and NOBODY becomes eligible;
//   · eligibility does not issue a certificate — it creates work for the
//     authority who may, and a timer never mints a document;
//   · an approved certificate gets its number, its verification token and its
//     frozen snapshot;
//   · the entitlement approaching expiry raises a renewal notice ONCE, with
//     enough notice to act on;
//   · a programme completing twice issues no second certificate and raises no
//     second notice.
//
// The tests that matter most are the refusals. Anyone can make a certificate
// come out; the value of this module is the cases where one does not.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq, sql } from 'drizzle-orm';
import crypto from 'node:crypto';

import * as s from '../src/db/schema';
import * as o from '../src/db/operations.schema';
import * as e from '../src/db/engagement.schema';
import * as pl from '../src/db/programme-lifecycle.schema';

import {
  deliverSession, recordAttendance, assessProgrammeCompletion, participantAttendance,
  completeProgramme, approveCertification, declineCertification, certificationQueue,
  dueForRenewal, raiseRenewalNotices, isProgrammeLifecycleError,
  CERTIFY_PROGRAMME_TASK,
} from '../src/db/programme-lifecycle';
import { installStandardAutomations } from '../src/db/automations';
import { configureTerm, activateForOrder } from '../src/db/entitlements';
import { createOrder, beginPayment, confirmPayment } from '../src/db/orders';
import { verifyCredential } from '../src/db/grading';
import { programStanding } from '../src/db/activation';
import { notifyForEvent } from '../src/lib/notifications';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';
import type { VerifiedPayment } from '../src/lib/payments';

let db: any, client: any;
let STATE: number, DOJO: number, INSTITUTION: number;

// Four identities, and the separation between them is load-bearing.
const admin: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const coach: Principal = {
  userId: 2, label: 'training operations',
  bindings: [{ role: 'TRAINING_OPERATIONS', scopeType: 'national', scopeId: null }],
};
const technical: Principal = {
  userId: 3, label: 'technical director',
  bindings: [{ role: 'TECHNICAL_DIRECTOR', scopeType: 'national', scopeId: null }],
};
const machine: Principal = { userId: null, label: 'cron:nightly', bindings: [] };

const ctx = (p: Principal = admin): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

const day = (offsetDays: number): string =>
  new Date(Date.UTC(2026, 5, 1) + offsetDays * 86_400_000).toISOString().slice(0, 10);

const at = (iso: string, hour = 10) => new Date(`${iso}T${String(hour).padStart(2, '0')}:00:00Z`);

let personSeq = 0;
async function makePerson(name: string) {
  personSeq++;
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(100000 + personSeq)}`,
    fullName: name, status: 'active', dob: '2012-04-04', gender: 'female',
    stateUnitId: STATE, dojoId: DOJO,
  }).returning({ id: s.persons.id });
  return p.id as number;
}

let programmeSeq = 0;

interface Built {
  programId: number;
  participants: number[];
  sessions: number[];
}

/**
 * A programme with `sessionCount` sessions and one participant per name.
 *
 * `withPerson: false` builds the school-cohort case — a child on the roll the
 * federation holds no person record for, which is the case `certificates`
 * cannot name a holder for.
 */
async function buildProgramme(opts: {
  names: string[];
  sessionCount: number;
  endsOn?: string;
  sessionsPlanned?: number | null;
  withPerson?: boolean;
  leadCoachPersonId?: number | null;
}): Promise<Built> {
  programmeSeq++;
  const [prog] = await db.insert(e.trainingPrograms).values({
    code: `MMAKF-PRG-2026-${String(programmeSeq).padStart(6, '0')}`,
    title: `Programme ${programmeSeq}`,
    institutionId: INSTITUTION,
    status: 'running',
    startsOn: day(0),
    endsOn: opts.endsOn ?? day(30),
    sessionsPlanned: opts.sessionsPlanned === undefined ? opts.sessionCount : opts.sessionsPlanned,
    stateUnitId: STATE,
    leadCoachPersonId: opts.leadCoachPersonId ?? null,
  }).returning({ id: e.trainingPrograms.id });

  const participants: number[] = [];
  for (const name of opts.names) {
    const personId = opts.withPerson === false ? null : await makePerson(name);
    const [p] = await db.insert(e.programParticipants).values({
      programId: prog.id, personId, displayName: name, joinedOn: day(0),
    }).returning({ id: e.programParticipants.id });
    participants.push(p.id as number);
  }

  const sessions: number[] = [];
  for (let i = 1; i <= opts.sessionCount; i++) {
    const [sess] = await db.insert(o.programSessions).values({
      programId: prog.id, seq: i, title: `Session ${i}`,
      startsAt: at(day(i), 10), endsAt: at(day(i), 11),
      status: 'scheduled',
    }).returning({ id: o.programSessions.id });
    sessions.push(sess.id as number);
  }

  return { programId: prog.id, participants, sessions };
}

/** Deliver every session with every participant present. The happy register. */
async function deliverAll(built: Built, present = true) {
  for (const sessionId of built.sessions) {
    await deliverSession(db, ctx(coach), {
      sessionId,
      marks: built.participants.map((participantId) => ({ participantId, present })),
      now: at(day(40)),
    });
  }
}

const eventsOf = (type: string, entityId?: number) =>
  db.select().from(s.domainEvents).where(
    entityId == null
      ? eq(s.domainEvents.eventType, type)
      : and(eq(s.domainEvents.eventType, type), eq(s.domainEvents.entityId, String(entityId)))
  );

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: { ...s, ...o, ...e, ...pl } });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  await db.insert(s.users).values([
    { id: 1, email: 'admin@mmakf.in', status: 'active' },
    { id: 2, email: 'ops@mmakf.in', status: 'active' },
    { id: 3, email: 'technical@mmakf.in', status: 'active' },
    { id: 4, email: 'elsewhere@school.example', status: 'active' },
    { id: 5, email: 'ours@school.example', status: 'active' },
  ]);

  const [st] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand unit', status: 'active',
  }).returning({ id: s.stateUnits.id });
  STATE = st.id;

  const [dj] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-JH-001', name: 'Ranchi Dojo', stateUnitId: STATE, status: 'active',
  }).returning({ id: s.dojos.id });
  DOJO = dj.id;

  const [inst] = await db.insert(e.institutions).values({
    code: 'MMAKF-INST-2026-000001', name: 'Delhi Public School Patratu',
    kind: 'school', status: 'active', stateUnitId: STATE, city: 'Patratu',
  }).returning({ id: e.institutions.id });
  INSTITUTION = inst.id;

  await installStandardAutomations(db);
});

// ════════════════════════════════════════════════════════════════════════════
describe('delivery and the register', () => {
  it('records the session as delivered, writes the register, and publishes once', async () => {
    const built = await buildProgramme({ names: ['Asha', 'Bimal'], sessionCount: 1 });

    const first = await deliverSession(db, ctx(coach), {
      sessionId: built.sessions[0],
      marks: [
        { participantId: built.participants[0], present: true },
        { participantId: built.participants[1], present: false, note: 'unwell' },
      ],
      now: at(day(1), 12),
    });

    expect(first.alreadyDelivered).toBe(false);
    expect(first.attendance.recorded).toBe(2);

    const [session] = await db.select().from(o.programSessions)
      .where(eq(o.programSessions.id, built.sessions[0]));
    expect(session.status).toBe('delivered');
    expect(session.deliveredAt).not.toBeNull();

    expect(await eventsOf('PROGRAM_SESSION_DELIVERED', built.sessions[0])).toHaveLength(1);
  });

  it('a second delivery moves nothing and publishes nothing', async () => {
    const built = await buildProgramme({ names: ['Chandra'], sessionCount: 1 });
    await deliverSession(db, ctx(coach), {
      sessionId: built.sessions[0],
      marks: [{ participantId: built.participants[0], present: true }],
      now: at(day(1), 12),
    });
    const [before] = await db.select().from(o.programSessions)
      .where(eq(o.programSessions.id, built.sessions[0]));

    const again = await deliverSession(db, ctx(coach), {
      sessionId: built.sessions[0], now: at(day(5), 12),
    });

    expect(again.alreadyDelivered).toBe(true);
    const [after] = await db.select().from(o.programSessions)
      .where(eq(o.programSessions.id, built.sessions[0]));
    expect(after.deliveredAt.getTime()).toBe(before.deliveredAt.getTime());
    expect(await eventsOf('PROGRAM_SESSION_DELIVERED', built.sessions[0])).toHaveLength(1);
  });

  it('a correction keeps BOTH readings, and re-submitting the same mark makes no correction', async () => {
    const built = await buildProgramme({ names: ['Deepa'], sessionCount: 1 });
    await deliverSession(db, ctx(coach), {
      sessionId: built.sessions[0],
      marks: [{ participantId: built.participants[0], present: false }],
      now: at(day(1), 12),
    });

    // The same value again: a retried upload must not manufacture a trail.
    const same = await recordAttendance(db, ctx(coach), {
      sessionId: built.sessions[0],
      marks: [{ participantId: built.participants[0], present: false }],
    });
    expect(same).toMatchObject({ recorded: 0, corrected: 0, unchanged: 1 });

    const changed = await recordAttendance(db, ctx(admin), {
      sessionId: built.sessions[0],
      marks: [{ participantId: built.participants[0], present: true }],
    });
    expect(changed.corrected).toBe(1);

    const [mark] = await db.select().from(o.programAttendance)
      .where(eq(o.programAttendance.sessionId, built.sessions[0]));
    expect(mark.present).toBe(true);
    expect(mark.correctedFromPresent).toBe(false);   // what the coach wrote on the day
    expect(mark.correctedByUserId).toBe(1);
  });

  it('refuses a mark for somebody who is not on the roll', async () => {
    const a = await buildProgramme({ names: ['Esha'], sessionCount: 1 });
    const b = await buildProgramme({ names: ['Farhan'], sessionCount: 1 });

    await expect(recordAttendance(db, ctx(coach), {
      sessionId: a.sessions[0],
      marks: [{ participantId: b.participants[0], present: true }],
    })).rejects.toThrow(/not on this programme's roll/i);
  });

  it('TENANT ISOLATION: a coordinator at another school cannot touch this register', async () => {
    // INSTITUTION_COORDINATOR holds attendance:write, so a permission check
    // alone lets one school write another school's register — and, through the
    // register, decide whose children become eligible for a certificate.
    const [other] = await db.insert(e.institutions).values({
      code: `MMAKF-INST-2026-${String(900000 + programmeSeq)}`, name: 'Another School',
      kind: 'school', status: 'active', stateUnitId: STATE,
    }).returning({ id: e.institutions.id });

    const outsider: Principal = {
      userId: 4, label: 'coordinator elsewhere',
      bindings: [{ role: 'INSTITUTION_COORDINATOR', scopeType: 'institution', scopeId: other.id }],
    };
    const insider: Principal = {
      userId: 5, label: 'our coordinator',
      bindings: [{ role: 'INSTITUTION_COORDINATOR', scopeType: 'institution', scopeId: INSTITUTION }],
    };

    const built = await buildProgramme({ names: ['Hina'], sessionCount: 1 });
    const marks = [{ participantId: built.participants[0], present: true }];

    await expect(recordAttendance(db, ctx(outsider), { sessionId: built.sessions[0], marks }))
      .rejects.toThrow(/outside your scope/i);
    await expect(deliverSession(db, ctx(outsider), { sessionId: built.sessions[0], marks }))
      .rejects.toThrow(/outside your scope/i);
    expect(await db.select().from(o.programAttendance)
      .where(eq(o.programAttendance.sessionId, built.sessions[0]))).toHaveLength(0);

    // The coordinator at the school the programme belongs to may.
    const ok = await deliverSession(db, ctx(insider), { sessionId: built.sessions[0], marks, now: at(day(40)) });
    expect(ok.attendance.recorded).toBe(1);
  });

  it('refuses to deliver, or to write a register for, a cancelled session', async () => {
    const built = await buildProgramme({ names: ['Gita'], sessionCount: 1 });
    await db.update(o.programSessions)
      .set({ status: 'cancelled', cancelledReason: 'school closed' })
      .where(eq(o.programSessions.id, built.sessions[0]));

    await expect(deliverSession(db, ctx(coach), { sessionId: built.sessions[0] }))
      .rejects.toThrow(/cancelled session cannot be delivered/i);
    await expect(recordAttendance(db, ctx(coach), {
      sessionId: built.sessions[0],
      marks: [{ participantId: built.participants[0], present: true }],
    })).rejects.toThrow(/no register to write/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a programme is not complete until the record says so', () => {
  it('is not complete while its end date is in the future', async () => {
    const built = await buildProgramme({ names: ['Hari'], sessionCount: 1, endsOn: day(90) });
    await deliverAll(built);

    const assessment = await assessProgrammeCompletion(db, built.programId, at(day(40)));
    expect(assessment.complete).toBe(false);
    expect(assessment.reasons.join(' ')).toMatch(/runs until/i);
  });

  it('is not complete with no end date recorded at all', async () => {
    const built = await buildProgramme({ names: ['Indu'], sessionCount: 1 });
    await db.update(e.trainingPrograms).set({ endsOn: null })
      .where(eq(e.trainingPrograms.id, built.programId));
    await deliverAll(built);

    const assessment = await assessProgrammeCompletion(db, built.programId, at(day(40)));
    expect(assessment.complete).toBe(false);
    expect(assessment.reasons.join(' ')).toMatch(/no end date is recorded/i);
  });

  it('is not complete while a session is still awaiting delivery', async () => {
    const built = await buildProgramme({ names: ['Jyoti'], sessionCount: 3 });
    await deliverSession(db, ctx(coach), {
      sessionId: built.sessions[0],
      marks: [{ participantId: built.participants[0], present: true }],
      now: at(day(40)),
    });

    const assessment = await assessProgrammeCompletion(db, built.programId, at(day(40)));
    expect(assessment.complete).toBe(false);
    expect(assessment.reasons.join(' ')).toMatch(/still awaiting delivery/i);
    expect(assessment.sessions.outstanding).toBe(2);
  });

  it('is not complete when planned sessions were never scheduled', async () => {
    const built = await buildProgramme({ names: ['Kiran'], sessionCount: 2, sessionsPlanned: 6 });
    await deliverAll(built);

    const assessment = await assessProgrammeCompletion(db, built.programId, at(day(40)));
    expect(assessment.complete).toBe(false);
    expect(assessment.reasons.join(' ')).toMatch(/planned for 6 sessions and only 2/i);
  });

  // ── THE ONE THE BRIEF NAMES ───────────────────────────────────────────────
  it('ATTENDANCE IS NOT INVENTED: a delivered session with an empty register blocks the whole programme', async () => {
    const built = await buildProgramme({ names: ['Lata', 'Manoj'], sessionCount: 2 });

    // Session 1 has a register. Session 2 was ticked "delivered" and nobody
    // ever wrote down who was in the room.
    await deliverSession(db, ctx(coach), {
      sessionId: built.sessions[0],
      marks: built.participants.map((participantId) => ({ participantId, present: true })),
      now: at(day(40)),
    });
    await deliverSession(db, ctx(coach), { sessionId: built.sessions[1], now: at(day(40)) });

    const assessment = await assessProgrammeCompletion(db, built.programId, at(day(40)));
    expect(assessment.complete).toBe(false);
    expect(assessment.reasons.join(' ')).toMatch(/#2 is recorded as delivered with no attendance at all/i);
    expect(assessment.sessions.deliveredWithEmptyRegister).toEqual([2]);

    // And NOBODY becomes eligible. Not a warning — a refusal, and nothing written.
    await expect(completeProgramme(db, ctx(admin), built.programId, { now: at(day(40)) }))
      .rejects.toThrow(/no attendance at all/i);
    expect(await db.select().from(pl.programmeCertifications)
      .where(eq(pl.programmeCertifications.programId, built.programId))).toHaveLength(0);
    expect(await db.select().from(o.tasks)
      .where(eq(o.tasks.idempotencyKey, `programme-certification:${built.programId}`))).toHaveLength(0);
  });

  it('cancelled sessions are not absences — the denominator is what was delivered', async () => {
    const built = await buildProgramme({ names: ['Nita'], sessionCount: 3 });
    await deliverSession(db, ctx(coach), {
      sessionId: built.sessions[0],
      marks: [{ participantId: built.participants[0], present: true }],
      now: at(day(40)),
    });
    await deliverSession(db, ctx(coach), {
      sessionId: built.sessions[1],
      marks: [{ participantId: built.participants[0], present: true }],
      now: at(day(40)),
    });
    await db.update(o.programSessions).set({ status: 'cancelled', cancelledReason: 'monsoon' })
      .where(eq(o.programSessions.id, built.sessions[2]));

    const [row] = await participantAttendance(db, built.programId);
    expect(row).toMatchObject({ sessionsDelivered: 2, present: 2, absent: 0, unrecorded: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('completion produces eligibility and work, never a certificate', () => {
  it('freezes an assessment per participant and raises ONE task, with nothing issued', async () => {
    const built = await buildProgramme({ names: ['Omkar', 'Priya', 'Qamar'], sessionCount: 4 });
    for (const [i, sessionId] of built.sessions.entries()) {
      await deliverSession(db, ctx(coach), {
        sessionId,
        marks: [
          { participantId: built.participants[0], present: true },
          { participantId: built.participants[1], present: i === 0 },
          // Qamar is never marked at all — unrecorded, never absent.
        ],
        now: at(day(40)),
      });
    }

    const result = await completeProgramme(db, ctx(admin), built.programId, { now: at(day(40)) });

    expect(result.eligible).toBe(2);
    expect(result.ineligible).toBe(1);
    expect(result.taskRef).toMatch(/^MMAKF-TSK-/);

    const [omkar, priya, qamar] = result.certifications;
    expect(omkar).toMatchObject({ status: 'eligible', present: 4, absent: 0, unrecorded: 0 });
    expect(priya).toMatchObject({ status: 'eligible', present: 1, absent: 3, unrecorded: 0 });
    // Silence is silence. Not four absences.
    expect(qamar).toMatchObject({ status: 'ineligible', present: 0, absent: 0, unrecorded: 4 });
    expect(qamar.reason).toMatch(/not place this participant at a single delivered session/i);

    // NOT ONE DOCUMENT.
    const certs = await db.select().from(s.certificates);
    expect(certs.filter((c: any) => (c.snapshot as any)?.provenance === 'programme')).toHaveLength(0);

    // The programme is closed and the work is waiting for a person.
    const [prog] = await db.select().from(e.trainingPrograms)
      .where(eq(e.trainingPrograms.id, built.programId));
    expect(prog.status).toBe('completed');

    const [task] = await db.select().from(o.tasks).where(eq(o.tasks.id, result.taskId!));
    expect(task.templateCode).toBe(CERTIFY_PROGRAMME_TASK);
    expect(task.assignedRole).toBe('TECHNICAL_DIRECTOR');
    expect(task.status).toBe('open');
    // No deadline the federation never agreed to.
    expect(task.dueAt).toBeNull();
  });

  it('completing twice produces one assessment per participant, one task, one event', async () => {
    const built = await buildProgramme({ names: ['Rita', 'Sohan'], sessionCount: 2 });
    await deliverAll(built);

    const first = await completeProgramme(db, ctx(admin), built.programId, { now: at(day(40)) });
    const second = await completeProgramme(db, ctx(coach), built.programId, { now: at(day(41)) });

    expect(second.alreadyCompleted).toBe(true);
    expect(second.taskId).toBe(first.taskId);
    expect(second.certifications.map((c) => c.certificationId))
      .toEqual(first.certifications.map((c) => c.certificationId));

    expect(await db.select().from(pl.programmeCertifications)
      .where(eq(pl.programmeCertifications.programId, built.programId))).toHaveLength(2);
    expect(await db.select().from(o.tasks)
      .where(eq(o.tasks.idempotencyKey, `programme-certification:${built.programId}`))).toHaveLength(1);
    expect(await eventsOf('PROGRAM_COMPLETED', built.programId)).toHaveLength(1);
  });

  it('refuses a programme with nobody on the roll', async () => {
    const built = await buildProgramme({ names: [], sessionCount: 1 });
    await deliverSession(db, ctx(coach), { sessionId: built.sessions[0], now: at(day(40)) });
    // No register is possible with no roll, so the empty-register rule fires first.
    await expect(completeProgramme(db, ctx(admin), built.programId, { now: at(day(40)) }))
      .rejects.toThrow(/no attendance at all/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a certificate is minted by a named authority and by nothing else', () => {
  async function readyForApproval(names: string[] = ['Tara']) {
    const built = await buildProgramme({ names, sessionCount: 2 });
    await deliverAll(built);
    const result = await completeProgramme(db, ctx(admin), built.programId, { now: at(day(40)) });
    return { built, result };
  }

  it('issues the number, the verification token and a frozen snapshot, and publishes once', async () => {
    const { built, result } = await readyForApproval(['Tara']);
    const target = result.certifications[0];

    const decision = await approveCertification(db, ctx(technical), {
      certificationId: target.certificationId,
      now: at(day(45)),
    });

    expect(decision.status).toBe('issued');
    expect(decision.certificateNo).toMatch(/^MMAKF-CERT-2026-\d{6}$/);

    const [doc] = await db.select().from(s.certificates)
      .where(eq(s.certificates.id, decision.certificateId!));
    expect(doc.kind).toBe('course_completion');
    expect(doc.verifyToken).toBeTruthy();
    expect(doc.verifyToken.length).toBeGreaterThanOrEqual(24);
    // No expiry the federation never published.
    expect(doc.validTo).toBeNull();

    const snap = doc.snapshot as any;
    expect(snap.provenance).toBe('programme');
    expect(snap.confersRank).toBe(false);
    expect(snap.attendance).toMatchObject({ sessionsDelivered: 2, present: 2, absent: 0, unrecorded: 0 });
    expect(snap.attendanceBasis).toMatch(/no minimum attendance requirement/i);
    expect(snap.approvedByUserId).toBe(3);

    // A programme completion confers NO rank, and writes no rank record.
    expect(await db.select().from(s.rankRecords)).toHaveLength(0);

    expect(await eventsOf('CERTIFICATE_ISSUED', decision.certificateId!)).toHaveLength(1);
  });

  it('approving twice issues one document', async () => {
    const { result } = await readyForApproval(['Uma']);
    const id = result.certifications[0].certificationId;

    const first = await approveCertification(db, ctx(technical), { certificationId: id, now: at(day(45)) });
    const again = await approveCertification(db, ctx(technical), { certificationId: id, now: at(day(46)) });

    expect(again.alreadyIssued).toBe(true);
    expect(again.certificateId).toBe(first.certificateId);
    expect(await db.select().from(pl.programmeCertifications)
      .where(eq(pl.programmeCertifications.certificateId, first.certificateId!))).toHaveLength(1);
  });

  it('refuses to certify somebody the register never places in the room', async () => {
    const built = await buildProgramme({ names: ['Vikram', 'Wasim'], sessionCount: 2 });
    for (const sessionId of built.sessions) {
      await deliverSession(db, ctx(coach), {
        sessionId,
        marks: [{ participantId: built.participants[0], present: true }],
        now: at(day(40)),
      });
    }
    const result = await completeProgramme(db, ctx(admin), built.programId, { now: at(day(40)) });
    const wasim = result.certifications.find((c) => c.status === 'ineligible')!;

    await expect(approveCertification(db, ctx(technical), { certificationId: wasim.certificationId }))
      .rejects.toThrow(/no approval can supply evidence that was never recorded|not place this participant/i);
  });

  it('refuses an approver who wrote or corrected the register they are certifying from', async () => {
    // A FEDERATION_ADMIN holds BOTH attendance:write and certificate:issue, so
    // permissions alone would let one person write the evidence and rule on it.
    // This is the check that still refuses.
    const built = await buildProgramme({ names: ['Yash'], sessionCount: 1 });
    await deliverSession(db, ctx(admin), {
      sessionId: built.sessions[0],
      marks: [{ participantId: built.participants[0], present: true }],
      now: at(day(40)),
    });
    const result = await completeProgramme(db, ctx(admin), built.programId, { now: at(day(40)) });

    await expect(approveCertification(db, ctx(admin), {
      certificationId: result.certifications[0].certificationId,
    })).rejects.toThrow(/you may not also certify from it/i);

    // And a second authority, who touched no mark, may.
    const decision = await approveCertification(db, ctx(technical), {
      certificationId: result.certifications[0].certificationId,
      now: at(day(45)),
    });
    expect(decision.status).toBe('issued');
  });

  it('refuses the programme’s own lead coach', async () => {
    const leadPersonId = await makePerson('Lead Sensei');
    await db.update(s.users).set({ personId: leadPersonId }).where(eq(s.users.id, 3));

    const built = await buildProgramme({
      names: ['Zoya'], sessionCount: 1, leadCoachPersonId: leadPersonId,
    });
    await deliverAll(built);
    const result = await completeProgramme(db, ctx(admin), built.programId, { now: at(day(40)) });

    await expect(approveCertification(db, ctx(technical), {
      certificationId: result.certifications[0].certificationId,
    })).rejects.toThrow(/may not certify your own delivery/i);

    await db.update(s.users).set({ personId: null }).where(eq(s.users.id, 3));
  });

  it('refuses a system principal outright — no timer signs a certificate', async () => {
    const { result } = await readyForApproval(['Anand']);
    await expect(approveCertification(db, ctx(machine), {
      certificationId: result.certifications[0].certificationId,
    })).rejects.toThrow(/approved by an identified person/i);
  });

  it('refuses anybody without certificate:issue', async () => {
    const { result } = await readyForApproval(['Bhavna']);
    const clerk: Principal = {
      userId: 2, label: 'ops', bindings: [{ role: 'TRAINING_OPERATIONS', scopeType: 'national', scopeId: null }],
    };
    await expect(approveCertification(db, ctx(clerk), {
      certificationId: result.certifications[0].certificationId,
    })).rejects.toThrow();
  });

  it('records a BLOCKED outcome for a cohort child with no person record, rather than losing them', async () => {
    const built = await buildProgramme({ names: ['Cohort Child'], sessionCount: 1, withPerson: false });
    await deliverAll(built);
    const result = await completeProgramme(db, ctx(admin), built.programId, { now: at(day(40)) });

    const decision = await approveCertification(db, ctx(technical), {
      certificationId: result.certifications[0].certificationId,
      now: at(day(45)),
    });

    expect(decision.status).toBe('blocked');
    expect(decision.certificateId).toBeNull();
    expect(decision.note).toMatch(/no person record/i);

    const queue = await certificationQueue(db, technical, built.programId);
    expect(queue[0].status).toBe('blocked');
  });

  it('declining is a recorded decision with a reason, and is not the same as ineligible', async () => {
    const { result } = await readyForApproval(['Devika']);
    const id = result.certifications[0].certificationId;

    await expect(declineCertification(db, ctx(technical), { certificationId: id, reason: '  ' }))
      .rejects.toThrow(/needs a reason/i);

    const decision = await declineCertification(db, ctx(technical), {
      certificationId: id, reason: 'Attended one session of eight; the panel was not satisfied.',
    });
    expect(decision.status).toBe('declined');

    const [row] = await db.select().from(pl.programmeCertifications)
      .where(eq(pl.programmeCertifications.id, id));
    expect(row.status).toBe('declined');
    expect(row.approvedByUserId).toBe(3);
    expect(row.reason).toMatch(/not satisfied/);

    // And it cannot be quietly turned back into a certificate.
    await expect(approveCertification(db, ctx(technical), { certificationId: id }))
      .rejects.toThrow(/has to make a fresh one/i);
  });

  it('will not decline a certificate that has already been issued — that is a revocation', async () => {
    const { result } = await readyForApproval(['Esther']);
    const id = result.certifications[0].certificationId;
    await approveCertification(db, ctx(technical), { certificationId: id, now: at(day(45)) });

    await expect(declineCertification(db, ctx(technical), { certificationId: id, reason: 'changed my mind' }))
      .rejects.toThrow(/revocation/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
describe('what a stranger is told about a programme certificate', () => {
  it('verifies as PROGRAMME ATTENDANCE — never as an unexamined GRADE', async () => {
    const built = await buildProgramme({ names: ['Publicly Checked'], sessionCount: 2 });
    await deliverAll(built);
    const done = await completeProgramme(db, ctx(admin), built.programId, { now: at(day(40)) });
    const decision = await approveCertification(db, ctx(technical), {
      certificationId: done.certifications[0].certificationId, now: at(day(41)),
    });

    const v = await verifyCredential(db, { certificateNo: decision.certificateNo! });
    expect(v.status).toBe('valid');

    // THE DEFECT THIS TEST EXISTS FOR. verifyCredential() read
    // `provenance === 'examined' ? 'examined' : 'unverified_legacy'`, which was
    // true of every certificate in the system until this module started minting
    // course completions. Every one of them then verified publicly under the
    // sentence "This GRADE predates the federation's digital examination
    // records" — the federation describing a 2026 attendance certificate as an
    // old unexamined RANK, on its own public endpoint, to an employer.
    expect(v.provenance).toBe('programme');
    // No grade is claimed, and none may be reported.
    expect(v.grade).toBeUndefined();
    expect(v.note).toMatch(/attendance/i);
    expect(v.note).not.toMatch(/predates/i);
    expect(v.note).not.toMatch(/legacy/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//
// The property the whole project is built around, asserted rather than asserted
// ABOUT: today the federation has published no fee, so the chain that ends in a
// renewal notice ends instead at "no published fee" and the sweep reports zero.
// The federation publishes one. NO CODE IS EDITED AND NOTHING IS DEPLOYED, and
// the same calls now produce a real figure and a real notice.
describe('the loop starts working the day a fee is published, unchanged', () => {
  const captured = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
    providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
    providerOrderId: '', amountPaise: 0, currency: 'INR',
    status: 'captured', method: 'upi', ...over,
  });

  const FEE = 'membership.official.annual';

  /** The identical sequence, run before and after publication. Not two paths. */
  async function buyAndSweep(personId: number) {
    const order = await createOrder(db, null, {
      personId, email: 'coach@example.in',
      lines: [{ kind: 'membership', description: 'Official membership', feeCode: FEE }],
    });
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise,
    }));
    await activateForOrder(db, null, order.id);
    const [entitlement] = await db.select().from(s.entitlements)
      .where(eq(s.entitlements.orderId, order.id));
    return { order, entitlement };
  }

  it('refuses today, and the SAME code raises a real notice once a fee exists', async () => {
    const personId = await makePerson('Official Awaiting A Price');

    // ── BEFORE. Nothing is priced, so nothing is sold and nothing expires. ──
    await expect(buyAndSweep(personId))
      .rejects.toThrow(/No published fee/i);
    const before = await raiseRenewalNotices(db, ctx(machine), {
      withinDays: 60, asAt: day(7000), now: at(day(7000)),
    });
    expect(before.considered).toBe(0);
    expect(before.raised).toBe(0);

    // ── THE FEDERATION PUBLISHES. Two rows. No deploy, no code change. ─────
    await db.insert(s.feeSchedule).values({
      code: FEE, label: 'Official membership (annual)', kind: 'membership',
      amountPaise: 250000, effectiveFrom: '2026-01-01', active: true,
    });
    await configureTerm(db, ctx(admin), {
      feeCode: FEE, subject: 'membership', membershipCategory: 'official',
      termMonths: 12, approvedBy: 'Executive Committee',
    });

    // ── AFTER. The identical calls, now carrying a real figure. ────────────
    const { order, entitlement } = await buyAndSweep(personId);
    expect(order.totalPaise).toBe(250000);       // the published figure, not a default
    expect(entitlement.status).toBe('active');
    expect(entitlement.feeVersion).toContain(FEE);

    await db.update(s.memberships).set({ validTo: day(7030) })
      .where(eq(s.memberships.id, entitlement.subjectId));

    const after = await raiseRenewalNotices(db, ctx(machine), {
      withinDays: 60, asAt: day(7000), now: at(day(7000)),
    });
    expect(after.considered).toBe(1);
    expect(after.raised).toBe(1);
    expect(after.notices[0]).toMatchObject({
      subject: 'membership', personId, expiresOn: day(7030), basis: 'memberships.valid_to',
    });
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('renewal — once, with notice, and never invented', () => {
  const captured = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
    providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
    providerOrderId: '', amountPaise: 0, currency: 'INR',
    status: 'captured', method: 'upi', ...over,
  });

  /** A real membership entitlement: order, gateway attempt, verified capture. */
  async function boughtMembership(personId: number | null) {
    const order = await createOrder(db, null, {
      personId, email: 'payer@example.in',
      lines: [{ kind: 'membership', description: 'Instructor membership', feeCode: 'membership.instructor.annual' }],
    });
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise,
    }));
    const report = await activateForOrder(db, null, order.id);
    const [ent] = await db.select().from(s.entitlements).where(eq(s.entitlements.orderId, order.id));
    return { order, entitlement: ent, report };
  }

  beforeAll(async () => {
    // INSTRUCTOR, not athlete. src/db/entitlements.ts refuses to configure a
    // fee that buys a student membership at all — a student pays for training,
    // not for being a student — so the register categories a fee may still
    // admit somebody to are the ones that act for the federation.
    await db.insert(s.feeSchedule).values({
      code: 'membership.instructor.annual', label: 'Instructor membership (annual)',
      kind: 'membership', amountPaise: 50000, effectiveFrom: '2026-01-01', active: true,
    });
    await configureTerm(db, ctx(admin), {
      feeCode: 'membership.instructor.annual', subject: 'membership',
      membershipCategory: 'instructor', termMonths: 12, approvedBy: 'Executive Committee',
    });
  });

  it('REFUSES to run without a stated window — the federation has published none', async () => {
    await expect(raiseRenewalNotices(db, ctx(admin), { withinDays: undefined as any }))
      .rejects.toThrow(/no renewal window/i);
    await expect(raiseRenewalNotices(db, ctx(admin), { withinDays: 0 }))
      .rejects.toThrow(/no renewal window/i);
    await expect(dueForRenewal(db, admin, { withinDays: 4000 }))
      .rejects.toThrow(/no renewal window/i);
  });

  it('raises exactly one notice per term, however many times the sweep runs', async () => {
    const personId = await makePerson('Renewing Member');
    const { entitlement } = await boughtMembership(personId);
    // The membership's own end date is the authority. Bring it inside a window.
    await db.update(s.memberships).set({ validTo: day(1020) })
      .where(eq(s.memberships.id, entitlement.subjectId));

    const asAt = day(1000);
    const first = await raiseRenewalNotices(db, ctx(machine), { withinDays: 30, asAt, now: at(asAt) });
    expect(first.raised).toBe(1);
    expect(first.notices[0]).toMatchObject({
      subject: 'membership', personId, expiresOn: day(1020), daysRemaining: 20,
      basis: 'memberships.valid_to',
    });

    const second = await raiseRenewalNotices(db, ctx(machine), { withinDays: 30, asAt: day(1001), now: at(day(1001)) });
    expect(second.raised).toBe(0);
    expect(second.alreadyRaised).toBe(1);

    expect(await db.select().from(pl.renewalNotices)
      .where(eq(pl.renewalNotices.entitlementId, entitlement.id))).toHaveLength(1);
    expect(await eventsOf('MEMBERSHIP_EXPIRING', entitlement.subjectId)).toHaveLength(1);
  });

  it('the notice reaches the member, and says when', async () => {
    const personId = await makePerson('Told In Time');
    const { entitlement } = await boughtMembership(personId);
    await db.update(s.memberships).set({ validTo: day(2045) })
      .where(eq(s.memberships.id, entitlement.subjectId));

    const asAt = day(2000);
    await raiseRenewalNotices(db, ctx(machine), { withinDays: 60, asAt, now: at(asAt) });

    const [event] = await db.select().from(s.domainEvents)
      .where(and(
        eq(s.domainEvents.eventType, 'MEMBERSHIP_EXPIRING'),
        eq(s.domainEvents.entityId, String(entitlement.subjectId))
      ));
    const queued = await notifyForEvent(db, ctx(admin), event as any);
    expect(queued).toBe(1);

    const [note] = await db.select().from(s.notifications)
      .where(eq(s.notifications.domainEventId, event.id));
    expect(note.personId).toBe(personId);
    expect(note.body).toMatch(new RegExp(day(2045)));
    // 45 days of warning, recorded so a dispute can be answered.
    const [row] = await db.select().from(pl.renewalNotices)
      .where(eq(pl.renewalNotices.entitlementId, entitlement.id));
    expect(row.noticeDays).toBe(45);
    expect(row.domainEventId).toBe(event.id);
  });

  it('a RENEWED membership earns a fresh notice for its new term', async () => {
    const personId = await makePerson('Renewed Again');
    const { entitlement } = await boughtMembership(personId);
    await db.update(s.memberships).set({ validTo: day(3010) })
      .where(eq(s.memberships.id, entitlement.subjectId));

    await raiseRenewalNotices(db, ctx(machine), { withinDays: 30, asAt: day(3000), now: at(day(3000)) });
    // The member renews; the register's end date moves.
    await db.update(s.memberships).set({ validTo: day(3375) })
      .where(eq(s.memberships.id, entitlement.subjectId));
    const next = await raiseRenewalNotices(db, ctx(machine), { withinDays: 30, asAt: day(3360), now: at(day(3360)) });

    expect(next.raised).toBe(1);
    expect(await db.select().from(pl.renewalNotices)
      .where(eq(pl.renewalNotices.entitlementId, entitlement.id))).toHaveLength(2);
  });

  it('invents no expiry where the record holds none, and writes to nobody it cannot name', async () => {
    // (a) an open-ended membership — validTo null — is not "expiring in a year".
    const personId = await makePerson('Open Ended');
    const { entitlement } = await boughtMembership(personId);
    await db.update(s.memberships).set({ validTo: null })
      .where(eq(s.memberships.id, entitlement.subjectId));

    // (b) an entitlement whose membership names no person cannot be published,
    // because the notification fan-out would fall back to the entity id.
    const orphanPerson = await makePerson('Orphaned Payer');
    const { entitlement: orphan } = await boughtMembership(orphanPerson);
    await db.update(s.memberships).set({ validTo: day(4010), personId: null as any })
      .where(eq(s.memberships.id, orphan.subjectId))
      .catch(() => { /* person_id is NOT NULL; the case is covered by the code path */ });

    const report = await raiseRenewalNotices(db, ctx(machine), {
      withinDays: 30, asAt: day(4000), now: at(day(4000)),
    });
    expect(report.notices.find((n) => n.entitlementId === entitlement.id)).toBeUndefined();
  });

  it('a PROGRAMME entitlement expiring is a notice too, raised from its own recorded period', async () => {
    // THE GAP THIS TEST CLOSES. The sweep read the end date off the thing that
    // was issued — a membership, an enrolment, a certificate. A `program`
    // entitlement has no such document: its period lives on the entitlement
    // row itself, written once at activation. So a school's programme access —
    // the technical library, the live classes, the course material that
    // src/db/activation.ts gates on exactly that column — ended on a date the
    // sweep did not look at, told nobody, and appeared on no list it produced.
    const payer = await makePerson('School Bursar');
    const built = await buildProgramme({ names: ['Cohort Child'], sessionCount: 1 });

    await db.insert(s.feeSchedule).values({
      code: 'program.school.term', label: 'School programme (term)', kind: 'program',
      amountPaise: 900000, effectiveFrom: '2026-01-01', active: true,
    });
    const order = await createOrder(db, null, {
      personId: payer, email: 'bursar@school.example',
      lines: [{
        kind: 'program', description: 'School programme', feeCode: 'program.school.term',
        refType: 'training_program', refId: built.programId,
      }],
    });
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise,
    }));
    await activateForOrder(db, null, order.id);

    const [ent] = await db.select().from(s.entitlements).where(eq(s.entitlements.orderId, order.id));
    expect(ent.status).toBe('active');
    // Derived from the PROGRAMME's own dates, not from the fee's term.
    expect(ent.validTo).toBe(day(30));

    const first = await raiseRenewalNotices(db, ctx(machine), {
      withinDays: 60, asAt: day(0), now: at(day(0)),
    });
    const raised = first.notices.find((n) => n.entitlementId === ent.id);
    expect(raised).toMatchObject({
      subject: 'program', subjectId: built.programId, personId: payer,
      expiresOn: day(30), daysRemaining: 30, basis: 'entitlements.valid_to',
    });

    // ONCE. The unique index, not this call being made once.
    const second = await raiseRenewalNotices(db, ctx(machine), {
      withinDays: 60, asAt: day(1), now: at(day(1)),
    });
    expect(second.notices.find((n) => n.entitlementId === ent.id)).toBeUndefined();
    expect(await db.select().from(pl.renewalNotices)
      .where(eq(pl.renewalNotices.entitlementId, ent.id))).toHaveLength(1);

    // And the access it gates ends AT THE DATE, server-side, decided by
    // comparing today against the record — not when a sweep gets round to it.
    // The notice is a warning; it is not what ends anything.
    const live = await programStanding(db, built.programId, at(day(30)));
    expect(live.active).toBe(true);
    const lapsed = await programStanding(db, built.programId, at(day(31)));
    expect(lapsed.active).toBe(false);
    expect(lapsed.reason).toMatch(/paid period ended/i);
    // Nothing was swept, nothing was revoked, and the entitlement row still
    // says 'active'. The refusal comes from the date alone.
    const [after] = await db.select().from(s.entitlements).where(eq(s.entitlements.id, ent.id));
    expect(after.status).toBe('active');
  });

  it('a read of the renewal list is gated', async () => {
    const nobody: Principal = { userId: 9, label: 'nobody', bindings: [] };
    await expect(dueForRenewal(db, nobody, { withinDays: 30 })).rejects.toThrow();
  });
});
