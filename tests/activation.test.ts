// Payment activates the programme — and everything that comes with it.
//
// The federation described this hop in more detail than any other, so the tests
// are written against its own words rather than against the implementation:
//
//   · "the training programme becomes active FOR THE PAID PERIOD" — the
//     entitlement holds a start AND an end, and neither is invented;
//   · "participants may be registered against it" — and not against a
//     programme nobody has paid for;
//   · "sessions are schedulable, and the coach assignment engine may run" —
//     inside the paid period, and not outside it;
//   · "supporting resources become reachable FOR THAT PERIOD" — the technical
//     library, live classes and course material, through the tables that
//     already hold them;
//   · "an expired entitlement stops granting access THE MOMENT IT EXPIRES" —
//     which is tested by moving the clock and running no job at all;
//   · "a refund REVOKES the entitlement with a reason and a timestamp, and
//     never deletes it."
//
// And the two refusals that matter more than any of it: a period the federation
// has not stated is never guessed, and a browser claiming success activates
// nothing.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from '../src/db/schema';
import * as ops from '../src/db/operations.schema';
import { createOrder, beginPayment, confirmPayment, requestRefund, completeRefund } from '../src/db/orders';
import {
  activateForOrder, configureTerm, revokeForRefund, termEndsOn, EntitlementError,
} from '../src/db/entitlements';
import {
  programPeriod, parseResourceGrants, programStanding, assertProgramActive,
  resourceAccess, libraryAccess, liveClassAccess, courseAccess, courseMaterialAccess,
  registerParticipant, removeParticipant, scheduleSession, programPortalView,
  expiringPrograms, isActivationError, RESOURCE_KINDS,
} from '../src/db/activation';
import { recommendCoaches } from '../src/db/coaches';
import type { Principal } from '../src/lib/rbac';
import type { VerifiedPayment } from '../src/lib/payments';
import type { AuditContext } from '../src/db/federation';

let db: any;
let STATE: number, INSTITUTION: number, COURSE: number, OTHER_COURSE: number;

const admin: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const finance: Principal = {
  userId: 2, label: 'treasurer',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};

const ctx = (p: Principal = admin): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

const captured = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
  providerOrderId: '',
  amountPaise: 0,
  currency: 'INR',
  status: 'captured',
  method: 'upi',
  ...over,
});

const iso = (d: Date) => d.toISOString().slice(0, 10);
const plusDays = (from: Date, n: number) => new Date(from.getTime() + n * 86_400_000);

let seq = 0;

/** A programme, with whatever dates the test wants it to have (usually none). */
async function makeProgram(over: Record<string, unknown> = {}) {
  seq++;
  const [p] = await db.insert(s.trainingPrograms).values({
    code: `MMAKF-PRG-2026-${String(100000 + seq)}`,
    title: 'Karate for schools — Ranchi',
    institutionId: INSTITUTION,
    status: 'planned',
    ...over,
  }).returning({ id: s.trainingPrograms.id });
  return p.id as number;
}

async function makePerson(name: string, over: Record<string, unknown> = {}) {
  seq++;
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(200000 + seq)}`,
    fullName: name, status: 'active', dob: '2012-05-05',
    stateUnitId: STATE, ...over,
  }).returning({ id: s.persons.id });
  return p.id as number;
}

/** Order → payment attempt → verified capture. The whole money path, honestly. */
async function payForProgram(programId: number, feeCode: string) {
  const order = await createOrder(db, null, {
    email: 'principal@school.example.in',
    lines: [{ kind: 'program', feeCode, refType: 'program', refId: programId, description: 'Programme' }],
  });
  const payment = await beginPayment(db, order.id, {
    provider: 'razorpay',
    providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
    amountPaise: order.totalPaise,
    idempotencyKey: crypto.randomUUID(),
  });
  await confirmPayment(db, null, captured({
    providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise, feePaise: 1180,
  }));
  return { order, payment };
}

const entitlementFor = async (programId: number) =>
  (await db.select().from(s.entitlements).where(and(
    eq(s.entitlements.subject, 'program'),
    eq(s.entitlements.subjectId, programId)
  )))[0];

const grantsFor = async (entitlementId: number) =>
  db.select().from(s.entitlementResources)
    .where(eq(s.entitlementResources.entitlementId, entitlementId));

const entitlementsOfOrder = (orderId: number) =>
  db.select().from(s.entitlements).where(eq(s.entitlements.orderId, orderId));

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [st] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand unit', status: 'active',
  }).returning({ id: s.stateUnits.id });
  STATE = st.id;

  const [inst] = await db.insert(s.institutions).values({
    code: 'MMAKF-INST-2026-000001', name: 'St Xavier’s, Ranchi', kind: 'school',
    status: 'contracted', stateUnitId: STATE,
  }).returning({ id: s.institutions.id });
  INSTITUTION = inst.id;

  const [c1] = await db.insert(s.courses).values({
    slug: 'shotokan-foundations', title: 'Shotokan foundations', status: 'published',
  }).returning({ id: s.courses.id });
  COURSE = c1.id;

  const [c2] = await db.insert(s.courses).values({
    slug: 'referee-level-1', title: 'Referee level 1', status: 'published',
  }).returning({ id: s.courses.id });
  OTHER_COURSE = c2.id;

  // The federation's published fees. Not one rupee figure is shipped in code —
  // these are rows, exactly as a real framework would be.
  await db.insert(s.feeSchedule).values([
    { code: 'program.school.term', label: 'School programme (one term)', kind: 'program', amountPaise: 5000000, effectiveFrom: '2026-01-01', active: true },
    { code: 'program.unconfigured', label: 'School programme, term not stated', kind: 'program', amountPaise: 4000000, effectiveFrom: '2026-01-01', active: true },
    { code: 'program.openended', label: 'School programme, open-ended term', kind: 'program', amountPaise: 4500000, effectiveFrom: '2026-01-01', active: true },
    { code: 'program.bare', label: 'School programme, no resources configured', kind: 'program', amountPaise: 3000000, effectiveFrom: '2026-01-01', active: true },
  ]);

  // WHAT THAT FEE BUYS — the federation's decision, recorded rather than inferred.
  await configureTerm(db, ctx(), {
    feeCode: 'program.school.term', subject: 'program', termMonths: 6,
    resources: [
      { kind: 'technical_library' },
      { kind: 'live_classes' },
      { kind: 'course', resourceId: COURSE },
    ],
    approvedBy: 'Executive Committee', notes: 'One school term, with the library and live classes.',
  });

  await configureTerm(db, ctx(), {
    feeCode: 'program.openended', subject: 'program', openEnded: true,
    approvedBy: 'Executive Committee',
  });

  await configureTerm(db, ctx(), {
    feeCode: 'program.bare', subject: 'program', termMonths: 3,
    approvedBy: 'Executive Committee',
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the period is stated or the activation is refused', () => {
  it('never invents a term: no programme dates and no configured term blocks the payment', async () => {
    const programId = await makeProgram();
    const { order } = await payForProgram(programId, 'program.unconfigured');

    const rows = await entitlementsOfOrder(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('blocked');
    expect(rows[0].validFrom).toBeNull();
    expect(rows[0].validTo).toBeNull();
    expect(rows[0].reason).toMatch(/no entitlement term is configured/i);
    // The refusal names both halves, so nobody has to guess which to fix.
    expect(rows[0].reason).toMatch(/states no start and end/i);
    // And the money is emphatically still taken.
    const order2 = (await db.select().from(s.orders).where(eq(s.orders.id, order.id)))[0];
    expect(order2.status).toBe('paid');
  });

  it('refuses an OPEN-ENDED term for a programme, rather than granting the library for ever', async () => {
    const programId = await makeProgram();
    const { order } = await payForProgram(programId, 'program.openended');

    const rows = await entitlementsOfOrder(order.id);
    expect(rows[0].status).toBe('blocked');
    expect(rows[0].reason).toMatch(/open-ended/i);
    expect(rows[0].reason).toMatch(/for ever/i);
    expect(await grantsFor(rows[0].id)).toHaveLength(0);
  });

  it('takes the PROGRAMME’s own dates in preference to a derived term', () => {
    const period = programPeriod({
      paidOn: '2026-02-10',
      programStartsOn: '2026-04-01',
      programEndsOn: '2027-03-31',
      feeCode: 'program.school.term',
      term: { feeCode: 'program.school.term', termMonths: 6, openEnded: false },
    });
    expect(period).toEqual({ ok: true, validFrom: '2026-04-01', validTo: '2027-03-31', source: 'programme_dates' });
  });

  it('derives from the configured term only where the programme states no window', () => {
    const period = programPeriod({
      paidOn: '2026-02-10', programStartsOn: null, programEndsOn: null,
      feeCode: 'program.school.term',
      term: { feeCode: 'program.school.term', termMonths: 6, openEnded: false },
    });
    // Six whole months from 10 February ends on 9 August — the day BEFORE the
    // anniversary. One day of overlap is one day of unpaid cover.
    expect(period).toEqual({ ok: true, validFrom: '2026-02-10', validTo: '2026-08-09', source: 'configured_term' });
  });

  it('refuses a programme whose recorded dates run backwards', () => {
    const period = programPeriod({
      paidOn: '2026-02-10', programStartsOn: '2026-09-01', programEndsOn: '2026-04-01',
      feeCode: null, term: null,
    });
    expect(period.ok).toBe(false);
    expect((period as any).reason).toMatch(/not a period/i);
  });
});

describe('a verified capture activates the programme', () => {
  let programId: number;
  let orderId: number;

  beforeAll(async () => {
    programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    const { order } = await payForProgram(programId, 'program.school.term');
    orderId = order.id;
  });

  it('records BOTH dates on the entitlement', async () => {
    const ent = await entitlementFor(programId);
    expect(ent.status).toBe('active');
    expect(ent.validFrom).toBe('2026-04-01');
    expect(ent.validTo).toBe('2026-09-30');
    expect(ent.paymentId).toBeTruthy();
  });

  it('grants exactly the resources the federation configured, and no others', async () => {
    const ent = await entitlementFor(programId);
    const grants = await grantsFor(ent.id);
    expect(grants.map((g: any) => g.resourceKind).sort())
      .toEqual(['course', 'live_classes', 'technical_library']);
    expect(grants.every((g: any) => g.validFrom === '2026-04-01' && g.validTo === '2026-09-30')).toBe(true);
    const course = grants.find((g: any) => g.resourceKind === 'course');
    expect(course.resourceId).toBe(COURSE);
  });

  it('publishes PROGRAM_ACTIVATED with the period on it', async () => {
    const events = await db.select().from(s.domainEvents)
      .where(eq(s.domainEvents.eventType, 'PROGRAM_ACTIVATED'));
    const mine = events.find((e: any) => Number(e.entityId) === programId);
    expect(mine).toBeTruthy();
    expect(mine.payload.validFrom).toBe('2026-04-01');
    expect(mine.payload.validTo).toBe('2026-09-30');
  });

  it('reports the programme as live inside the period and not outside it', async () => {
    const inside = await programStanding(db, programId, new Date('2026-06-01T10:00:00Z'));
    expect(inside.active).toBe(true);

    const before = await programStanding(db, programId, new Date('2026-03-31T10:00:00Z'));
    expect(before.active).toBe(false);
    expect(before.reason).toMatch(/does not begin until 2026-04-01/);

    const after = await programStanding(db, programId, new Date('2026-10-01T10:00:00Z'));
    expect(after.active).toBe(false);
    expect(after.reason).toMatch(/ended on 2026-09-30/);
  });

  it('is idempotent: a replayed activation creates no second entitlement and does not extend the period', async () => {
    const before = await entitlementsOfOrder(orderId);
    await activateForOrder(db, null, orderId);
    await activateForOrder(db, null, orderId);
    const after = await entitlementsOfOrder(orderId);

    expect(after).toHaveLength(before.length);
    expect(after[0].validTo).toBe('2026-09-30');
    expect(await grantsFor(after[0].id)).toHaveLength(3);
  });
});

describe('a browser claiming success activates nothing', () => {
  it('refuses without a payment this system verified as captured', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    const order = await createOrder(db, null, {
      email: 'principal@school.example.in',
      lines: [{ kind: 'program', feeCode: 'program.school.term', refType: 'program', refId: programId, description: 'Programme' }],
    });

    await expect(activateForOrder(db, null, order.id))
      .rejects.toThrow(/no payment this system has verified as captured/i);

    expect(await entitlementsOfOrder(order.id)).toHaveLength(0);
    expect(await entitlementFor(programId)).toBeUndefined();
    // And the programme is not deliverable on the strength of the attempt.
    const standing = await programStanding(db, programId);
    expect(standing.active).toBe(false);
    expect(standing.reason).toMatch(/no payment has activated this programme/i);
  });
});

describe('supporting resources are reachable for that period, and not a day longer', () => {
  let programId: number;
  let child: number;
  let stranger: number;

  beforeAll(async () => {
    programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    await payForProgram(programId, 'program.school.term');

    child = await makePerson('A pupil');
    stranger = await makePerson('Somebody else');
    await registerParticipant(db, ctx(), { programId, personId: child, joinedOn: '2026-04-01' },
      new Date('2026-04-01T09:00:00Z'));
  });

  it('opens the technical library to somebody on the roll', async () => {
    const decision = await libraryAccess(db, child, new Date('2026-06-15T09:00:00Z'));
    expect(decision.allowed).toBe(true);
    expect(decision.validTo).toBe('2026-09-30');
    expect(decision.programId).toBe(programId);
  });

  it('opens live classes and the named course, and NOT a course nobody granted', async () => {
    const at = new Date('2026-06-15T09:00:00Z');
    expect((await liveClassAccess(db, child, at)).allowed).toBe(true);
    expect((await courseAccess(db, child, COURSE, at)).allowed).toBe(true);

    const other = await courseAccess(db, child, OTHER_COURSE, at);
    expect(other.allowed).toBe(false);
    expect(other.reason).toMatch(/no mmakf training programme you are on includes/i);
  });

  it('lets a COURSE grant cover that course’s material, and not the reverse', async () => {
    const at = new Date('2026-06-15T09:00:00Z');
    expect((await courseMaterialAccess(db, child, COURSE, at)).allowed).toBe(true);
    expect((await courseMaterialAccess(db, child, OTHER_COURSE, at)).allowed).toBe(false);
  });

  it('grants nothing at all to somebody who is not on the roll', async () => {
    const decision = await libraryAccess(db, stranger, new Date('2026-06-15T09:00:00Z'));
    expect(decision.allowed).toBe(false);
    expect(decision.entitlementId).toBeNull();
  });

  it('STOPS THE MOMENT IT EXPIRES — no sweep, no cron, no job', async () => {
    // 23:30 on 30 September IN RANCHI. (23:00Z would be half past four on the
    // 1st there, which is a day the school did not pay for — see the
    // federation-day test at the foot of this file.)
    const lastDay = await libraryAccess(db, child, new Date('2026-09-30T18:00:00Z'));
    expect(lastDay.allowed).toBe(true);

    // Nothing whatsoever is run between these two lines. The clock moves one
    // day and the answer changes, because the answer is a date comparison.
    const nextDay = await libraryAccess(db, child, new Date('2026-10-01T00:01:00Z'));
    expect(nextDay.allowed).toBe(false);
    expect(nextDay.reason).toMatch(/ended on 2026-09-30/);
  });

  it('has not started before the start date, and says so', async () => {
    const early = await libraryAccess(db, child, new Date('2026-03-31T09:00:00Z'));
    expect(early.allowed).toBe(false);
    expect(early.reason).toMatch(/from 2026-04-01/);
  });

  it('closes when the participant leaves the roll, without touching the entitlement', async () => {
    const leaver = await makePerson('A pupil who moved school');
    await registerParticipant(db, ctx(), { programId, personId: leaver, joinedOn: '2026-04-01' },
      new Date('2026-04-01T09:00:00Z'));
    expect((await libraryAccess(db, leaver, new Date('2026-06-01T09:00:00Z'))).allowed).toBe(true);

    await removeParticipant(db, ctx(), (await db.select().from(s.programParticipants).where(and(
      eq(s.programParticipants.programId, programId),
      eq(s.programParticipants.personId, leaver)
    )))[0].id, '2026-05-31');

    expect((await libraryAccess(db, leaver, new Date('2026-06-01T09:00:00Z'))).allowed).toBe(false);
    // The rest of the school is unaffected.
    expect((await libraryAccess(db, child, new Date('2026-06-01T09:00:00Z'))).allowed).toBe(true);
  });

  it('refuses a course check that names no course rather than guessing', async () => {
    const decision = await resourceAccess(db, { personId: child, kind: 'course', at: new Date('2026-06-01T09:00:00Z') });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/must name which one/i);
  });
});

describe('participants, sessions and the assignment engine are gated on the payment', () => {
  it('will not register a participant against a programme nobody has paid for', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    const person = await makePerson('An unpaid-for pupil');

    await expect(registerParticipant(db, ctx(), { programId, personId: person },
      new Date('2026-05-01T09:00:00Z')))
      .rejects.toThrow(/no payment has activated this programme/i);

    const rows = await db.select().from(s.programParticipants)
      .where(eq(s.programParticipants.programId, programId));
    expect(rows).toHaveLength(0);
  });

  it('registers idempotently, and enrols the participant onto the granted course', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    await payForProgram(programId, 'program.school.term');
    const person = await makePerson('A twice-submitted pupil');
    const at = new Date('2026-04-02T09:00:00Z');

    const first = await registerParticipant(db, ctx(), { programId, personId: person }, at);
    const second = await registerParticipant(db, ctx(), { programId, personId: person }, at);

    expect(first.status).toBe('registered');
    expect(second.status).toBe('replayed');
    expect(second.participantId).toBe(first.participantId);

    const roll = await db.select().from(s.programParticipants).where(and(
      eq(s.programParticipants.programId, programId),
      eq(s.programParticipants.personId, person)
    ));
    expect(roll).toHaveLength(1);

    // The course the programme includes, through the table the academy reads.
    const enrolments = await db.select().from(s.enrolments).where(and(
      eq(s.enrolments.courseId, COURSE), eq(s.enrolments.personId, person)
    ));
    expect(enrolments).toHaveLength(1);
    expect(enrolments[0].status).toBe('active');
    // AND IT EXPIRES WITH THE PROGRAMME. An enrolment that outlived the fee
    // that bought it is the same defect as an entitlement that does.
    expect(enrolments[0].expiresAt?.toISOString().slice(0, 10)).toBe('2026-09-30');
  });

  it('schedules a session inside the paid period and refuses one outside it', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    await payForProgram(programId, 'program.school.term');

    const session = await scheduleSession(db, ctx(), {
      programId,
      startsAt: new Date('2026-05-12T09:00:00Z'),
      endsAt: new Date('2026-05-12T10:00:00Z'),
      title: 'Week 6 — kihon',
    });
    expect(session.seq).toBe(1);
    expect(session.status).toBe('scheduled');

    await expect(scheduleSession(db, ctx(), {
      programId,
      startsAt: new Date('2026-10-12T09:00:00Z'),
      endsAt: new Date('2026-10-12T10:00:00Z'),
    })).rejects.toThrow(/ended on 2026-09-30/);

    // A session that starts on the last paid day and runs past it is refused
    // too — the federation was not paid to deliver the part after midnight.
    await expect(scheduleSession(db, ctx(), {
      programId,
      startsAt: new Date('2026-09-30T23:30:00Z'),
      endsAt: new Date('2026-10-01T00:30:00Z'),
    })).rejects.toThrow(/ended on 2026-09-30/);

    const rows = await db.select().from(ops.programSessions)
      .where(eq(ops.programSessions.programId, programId));
    expect(rows).toHaveLength(1);
  });

  it('will not run the coach assignment engine against an unpaid programme', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    await expect(recommendCoaches(db, ctx(), {
      programId,
      criteria: {
        startsAt: new Date('2026-05-12T09:00:00Z'),
        endsAt: new Date('2026-05-12T10:00:00Z'),
      } as any,
    })).rejects.toThrow(/no payment has activated this programme/i);

    const rows = await db.select().from(ops.coachAssignments)
      .where(eq(ops.coachAssignments.programId, programId));
    expect(rows).toHaveLength(0);
  });
});

describe('a refund revokes, with a reason and a timestamp, and deletes nothing', () => {
  it('closes the entitlement and every door it opened, and keeps the record', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    const { order } = await payForProgram(programId, 'program.school.term');
    const person = await makePerson('A pupil at a refunded school');
    await registerParticipant(db, ctx(), { programId, personId: person }, new Date('2026-04-02T09:00:00Z'));

    const at = new Date('2026-06-01T09:00:00Z');
    expect((await libraryAccess(db, person, at)).allowed).toBe(true);

    const payment = (await db.select().from(s.payments).where(eq(s.payments.orderId, order.id)))[0];
    const refund = await requestRefund(db, ctx(finance), {
      paymentId: payment.id, amountPaise: payment.amountPaise, reason: 'School withdrew before the term began',
    });
    await completeRefund(db, ctx(finance), { refundId: refund.id, providerRefundId: 'rfnd_x' });

    const ent = await entitlementFor(programId);
    expect(ent.status).toBe('revoked');
    expect(ent.revokedAt).toBeTruthy();
    expect(ent.reason).toMatch(/School withdrew/);
    // NOT DELETED. The period it held is still readable.
    expect(ent.validFrom).toBe('2026-04-01');
    expect(ent.validTo).toBe('2026-09-30');

    const grants = await grantsFor(ent.id);
    expect(grants).toHaveLength(3);
    expect(grants.every((g: any) => g.status === 'revoked' && g.revokedAt)).toBe(true);
    expect(grants.every((g: any) => g.validTo === '2026-09-30')).toBe(true);

    const after = await libraryAccess(db, person, at);
    expect(after.allowed).toBe(false);
    expect(after.reason).toMatch(/withdrawn when the fee was refunded/i);

    // And nothing more may be scheduled or registered against it.
    await expect(assertProgramActive(db, programId, at)).rejects.toThrow(/revoked/i);
  });
});

describe('configuration is refused rather than half-understood', () => {
  it('rejects a resource kind MMAKF does not grant', () => {
    expect(() => parseResourceGrants([{ kind: 'everything' }])).toThrow(/is not a resource MMAKF grants/i);
    expect(() => parseResourceGrants([{ kind: 'course' }])).toThrow(/must name which one/i);
    expect(() => parseResourceGrants([{ kind: 'technical_library', resourceId: 3 }])).toThrow(/names no single record/i);
  });

  it('treats absence as nothing, never as everything', () => {
    expect(parseResourceGrants(null)).toEqual([]);
    expect(parseResourceGrants([])).toEqual([]);
  });

  it('collapses the same grant listed twice', () => {
    expect(parseResourceGrants([{ kind: 'technical_library' }, { kind: 'technical_library' }]))
      .toEqual([{ kind: 'technical_library', resourceId: null }]);
  });

  it('refuses to hang supporting resources off a non-programme fee', async () => {
    await expect(configureTerm(db, ctx(), {
      feeCode: 'grading.dan.1', subject: 'grading',
      termMonths: 12, resources: [{ kind: 'technical_library' }],
    })).rejects.toThrow(/granted by a PROGRAMME entitlement/i);
  });

  it('keeps the vocabulary closed and in one place', () => {
    expect([...RESOURCE_KINDS].sort())
      .toEqual(['course', 'course_material', 'live_classes', 'technical_library']);
  });
});

describe('the reports a person actually works', () => {
  it('shows the institution its programme, its calendar, its coaches and its standing', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    await payForProgram(programId, 'program.school.term');
    await scheduleSession(db, ctx(), {
      programId,
      startsAt: new Date('2026-05-19T09:00:00Z'),
      endsAt: new Date('2026-05-19T10:00:00Z'),
    });

    const view = await programPortalView(db, admin, programId, new Date('2026-06-01T09:00:00Z'));
    expect(view.standing.active).toBe(true);
    expect(view.standing.validTo).toBe('2026-09-30');
    expect(view.sessions).toHaveLength(1);
    expect(view.resources.map((r) => r.kind).sort())
      .toEqual(['course', 'live_classes', 'technical_library']);
    expect(view.coaches).toEqual([]);
  });

  it('lists programmes whose paid period is about to end', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    await payForProgram(programId, 'program.school.term');

    const soon = await expiringPrograms(db, admin, 30, new Date('2026-09-10T09:00:00Z'));
    expect(soon.some((r: any) => r.programId === programId)).toBe(true);

    const notYet = await expiringPrograms(db, admin, 30, new Date('2026-05-10T09:00:00Z'));
    expect(notYet.some((r: any) => r.programId === programId)).toBe(false);
  });
});

describe('a programme with no supporting resources configured is honest about it', () => {
  it('activates the training and grants nothing else', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-06-30' });
    await payForProgram(programId, 'program.bare');

    const ent = await entitlementFor(programId);
    expect(ent.status).toBe('active');
    expect(ent.validFrom).toBe('2026-04-01');
    expect(await grantsFor(ent.id)).toHaveLength(0);
    expect((ent.detail as any).resourcesConfigured).toBe(false);

    const person = await makePerson('A pupil on a training-only programme');
    await registerParticipant(db, ctx(), { programId, personId: person }, new Date('2026-04-02T09:00:00Z'));
    // Training is active; the library was never part of what was bought.
    expect((await programStanding(db, programId, new Date('2026-05-01T09:00:00Z'))).active).toBe(true);
    expect((await libraryAccess(db, person, new Date('2026-05-01T09:00:00Z'))).allowed).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE ATTACKS
//
// Everything below was written by reading the module for ways to get more than
// was paid for, or to keep it after the money went back. Four of them found
// something.
// ═══════════════════════════════════════════════════════════════════════════

describe('IT STARTS WORKING WHEN THE FEDERATION PUBLISHES THE FEE — no code change', () => {
  // The claim the whole design rests on, tested as a before-and-after rather
  // than asserted in a comment. Nothing between the two halves of this test is
  // a code change: the only things that happen are two INSERTs, one into
  // `fee_schedule` and one into `entitlement_terms`, both of them data a
  // federation officer enters through a form.
  const FEE = 'program.corporate.block';

  it('refuses to sell what has no published fee, then sells it the moment one exists', async () => {
    const programId = await makeProgram();

    // ── BEFORE. No published fee. Not zero, not a placeholder, not a figure
    //    borrowed from another federation — the order cannot even be raised.
    await expect(payForProgram(programId, FEE)).rejects.toThrow(/no published fee/i);
    expect(await db.select().from(s.entitlements)
      .where(and(eq(s.entitlements.subject, 'program'), eq(s.entitlements.subjectId, programId)))
    ).toHaveLength(0);

    // ── ROW ONE. The federation publishes the fee.
    await db.insert(s.feeSchedule).values({
      code: FEE, label: 'Corporate block (twelve months)', kind: 'program',
      amountPaise: 1250000, effectiveFrom: '2026-01-01', active: true,
    });

    // The money now moves — a REAL figure, and it is the published one.
    const secondProgram = await makeProgram();
    const { order: unconfigured } = await payForProgram(secondProgram, FEE);
    expect(unconfigured.totalPaise).toBe(1250000);
    // …but nothing is delivered on a term nobody stated. Blocked, refundable,
    // and on the finance desk's queue rather than quietly running for a year.
    const blocked = (await entitlementsOfOrder(unconfigured.id))[0];
    expect(blocked.status).toBe('blocked');
    expect(blocked.reason).toMatch(/no entitlement term is configured/i);

    // ── ROW TWO. The federation states what the fee buys.
    await configureTerm(db, ctx(), {
      feeCode: FEE, subject: 'program', termMonths: 12,
      resources: [{ kind: 'technical_library' }, { kind: 'live_classes' }],
      approvedBy: 'Executive Committee',
    });

    // ── AFTER. The identical call sequence, against the identical code.
    const thirdProgram = await makeProgram();
    const { order } = await payForProgram(thirdProgram, FEE);
    expect(order.totalPaise).toBe(1250000);

    const ent = await entitlementFor(thirdProgram);
    expect(ent.status).toBe('active');
    expect(ent.validFrom).toBeTruthy();
    expect(ent.validTo).toBe(termEndsOn(ent.validFrom, 12));
    expect((ent.detail as any).periodSource).toBe('configured_term');
    // And the version of the published fee that priced it is on the record, so
    // a later edit to the schedule cannot retell what this school was charged.
    expect(ent.feeVersion).toMatch(new RegExp('^' + FEE + '@2026-01-01#'));

    const grants = await grantsFor(ent.id);
    expect(grants.map((g: any) => g.resourceKind).sort()).toEqual(['live_classes', 'technical_library']);

    const person = await makePerson('A trainee at the corporate client');
    await registerParticipant(db, ctx(), { programId: thirdProgram, personId: person });
    expect((await libraryAccess(db, person)).allowed).toBe(true);
  });

  it('a later fee change does not re-date or re-price what was already issued', async () => {
    const programId = await makeProgram();
    const { order } = await payForProgram(programId, FEE);
    const before = await entitlementFor(programId);
    const line = (await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id)))[0];

    // The federation raises the fee and shortens the term.
    await db.insert(s.feeSchedule).values({
      code: FEE, label: 'Corporate block (revised)', kind: 'program',
      amountPaise: 2000000, effectiveFrom: '2027-01-01', active: true,
    });
    await configureTerm(db, ctx(), {
      feeCode: FEE, subject: 'program', termMonths: 1, approvedBy: 'Executive Committee',
    });

    const after = await entitlementFor(programId);
    expect(after.validFrom).toBe(before.validFrom);
    expect(after.validTo).toBe(before.validTo);
    expect(after.feeVersion).toBe(before.feeVersion);
    // The order line still says what was actually charged.
    expect((await db.select().from(s.orderLines).where(eq(s.orderLines.id, line.id)))[0].unitPricePaise)
      .toBe(1250000);
    // And the grants still run to the day they always ran to.
    const grants = await grantsFor(before.id);
    expect(grants.every((g: any) => g.validTo === before.validTo)).toBe(true);
  });
});

describe('the derived term cannot outrun the end the federation recorded', () => {
  it('caps the period at the programme own end date', () => {
    // The commonest half-filled row: an end agreed with the school, no start.
    // Six months from a February payment would have run to 31 July — four
    // months of library, live classes and course material past the day the
    // federation said the programme finishes.
    const period = programPeriod({
      paidOn: '2026-02-01', programStartsOn: null, programEndsOn: '2026-03-31',
      feeCode: 'program.school.term',
      term: { feeCode: 'program.school.term', termMonths: 6, openEnded: false },
    });
    expect(period).toEqual({
      ok: true, validFrom: '2026-02-01', validTo: '2026-03-31', source: 'programme_end',
    });
  });

  it('leaves the derived term alone where the programme ends after it', () => {
    const period = programPeriod({
      paidOn: '2026-02-10', programStartsOn: null, programEndsOn: '2030-03-31',
      feeCode: 'program.school.term',
      term: { feeCode: 'program.school.term', termMonths: 6, openEnded: false },
    });
    expect(period).toEqual({
      ok: true, validFrom: '2026-02-10', validTo: '2026-08-09', source: 'configured_term',
    });
  });

  it('refuses an end that falls before the day the money was taken', () => {
    const period = programPeriod({
      paidOn: '2026-06-01', programStartsOn: null, programEndsOn: '2026-03-31',
      feeCode: 'program.school.term',
      term: { feeCode: 'program.school.term', termMonths: 6, openEnded: false },
    });
    expect(period.ok).toBe(false);
    expect((period as any).reason).toMatch(/before/i);
  });

  it('caps end to end, through the whole money path', async () => {
    const programId = await makeProgram({ endsOn: '2030-12-31' });
    await payForProgram(programId, 'program.school.term');
    const ent = await entitlementFor(programId);
    expect(ent.status).toBe('active');
    expect(ent.validTo).toBe(termEndsOn(ent.validFrom, 6));
    const capped = await makeProgram({ endsOn: iso(plusDays(new Date(), 20)) });
    await payForProgram(capped, 'program.school.term');
    const cappedEnt = await entitlementFor(capped);
    expect(cappedEnt.status).toBe('active');
    expect(cappedEnt.validTo).toBe(iso(plusDays(new Date(), 20)));
    expect((cappedEnt.detail as any).periodSource).toBe('programme_end');
    const grants = await grantsFor(cappedEnt.id);
    expect(grants.every((g: any) => g.validTo === cappedEnt.validTo)).toBe(true);
  });
});

describe('a period that had already elapsed when the money arrived says so', () => {
  // A programme settled in arrears is legitimate and is not refused. But an
  // entitlement whose whole period is behind it opens no door and appears in
  // neither queue a person works, so a mis-dated programme would otherwise be
  // indistinguishable from a correctly late payment. The fact is on the row.
  it('records the fact on the entitlement rather than leaving it to be inferred', async () => {
    const programId = await makeProgram({ startsOn: '2020-01-01', endsOn: '2020-12-31' });
    const { order } = await payForProgram(programId, 'program.school.term');

    const rows = await entitlementsOfOrder(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('active');
    expect(rows[0].validTo).toBe('2020-12-31');
    expect((rows[0].detail as any).periodElapsedAtPayment).toBe(true);
    expect((rows[0].detail as any).paidOn).toBeTruthy();

    // And it opens nothing, which is the honest consequence rather than a bug.
    const person = await makePerson('A pupil at a school that paid years late');
    await expect(registerParticipant(db, ctx(), { programId, personId: person }))
      .rejects.toThrow(/paid period ended/i);
  });

  it('does not set the flag on a programme still running', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    await payForProgram(programId, 'program.school.term');
    const ent = await entitlementFor(programId);
    expect((ent.detail as any).periodElapsedAtPayment).toBe(false);
  });
});

describe('a refund closes the SECOND door too — the course enrolment', () => {
  it('suspends the enrolment the programme opened, and leaves one bought privately alone', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    const { order } = await payForProgram(programId, 'program.school.term');

    const schoolPupil = await makePerson('A pupil enrolled by the school');
    await registerParticipant(db, ctx(), { programId, personId: schoolPupil },
      new Date('2026-04-02T09:00:00Z'));

    const programEnrolment = (await db.select().from(s.enrolments).where(and(
      eq(s.enrolments.personId, schoolPupil), eq(s.enrolments.courseId, COURSE)
    )))[0];
    expect(programEnrolment.status).toBe('active');
    // Provenance: the order that bought it is on the row, which is the only
    // thing that lets a refund tell it from one a family paid for.
    expect(programEnrolment.orderId).toBe(order.id);

    // Somebody else who bought the same course themselves.
    const payingPupil = await makePerson('A pupil whose family bought the course');
    const [privately] = await db.insert(s.enrolments).values({
      courseId: COURSE, personId: payingPupil, status: 'active', orderId: null,
    }).returning();

    const payment = (await db.select().from(s.payments).where(eq(s.payments.orderId, order.id)))[0];
    const refund = await requestRefund(db, ctx(finance), {
      paymentId: payment.id, amountPaise: payment.amountPaise, reason: 'School cancelled the contract',
    });
    await completeRefund(db, ctx(finance), { refundId: refund.id, providerRefundId: 'rfnd_enrol' });

    // THE ENROLMENT THE PROGRAMME OPENED IS CLOSED. Not deleted — suspended,
    // so the record of what the school held survives.
    const afterProgramme = (await db.select().from(s.enrolments)
      .where(eq(s.enrolments.id, programEnrolment.id)))[0];
    expect(afterProgramme.status).toBe('suspended');

    // AND THE ONE NOBODY REFUNDED IS UNTOUCHED.
    const afterPrivate = (await db.select().from(s.enrolments)
      .where(eq(s.enrolments.id, privately.id)))[0];
    expect(afterPrivate.status).toBe('active');
  });
});

describe('the day access ends is the federation day, not the server day', () => {
  it('is still open at 22:30 on the last day in India, and shut three hours later', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    await payForProgram(programId, 'program.school.term');
    const person = await makePerson('A pupil reading late on the last night');
    await registerParticipant(db, ctx(), { programId, personId: person },
      new Date('2026-04-02T09:00:00Z'));

    // 30 September, 22:30 in Ranchi. Inside the paid period.
    expect((await libraryAccess(db, person, new Date('2026-09-30T17:00:00Z'))).allowed).toBe(true);

    // 1 October, 01:30 in Ranchi — but still 30 September in UTC, which is the
    // five-and-a-half-hour window in which the library used to stay open after
    // the programme had ended.
    const after = await libraryAccess(db, person, new Date('2026-09-30T20:00:00Z'));
    expect(after.allowed).toBe(false);
    expect(after.reason).toMatch(/ended on 2026-09-30/);
  });
});

describe('nothing here can be reached without the money', () => {
  it('exposes no way to grant a resource from an id and a promise', async () => {
    const activation = await import('../src/db/activation');
    // Every exported name that could write a grant, and neither of them does so
    // without a LineContext — which only activateForOrder() builds, and only
    // after reading a payment this system marked captured.
    const writers = Object.keys(activation).filter((k) => /grant/i.test(k));
    // parseResourceGrants is a pure parser that touches no database, and
    // revokeProgramGrants only ever CLOSES doors. Nothing exported here opens
    // one: grantResources() is module-private and decideProgram() takes a
    // LineContext, which only activateForOrder() builds and only after reading
    // a payment this system marked captured.
    expect(writers.sort()).toEqual(['parseResourceGrants', 'revokeProgramGrants']);
    expect(typeof (activation as any).grantResources).toBe('undefined');
    expect(await (activation as any).parseResourceGrants([{ kind: 'technical_library' }]))
      .toEqual([{ kind: 'technical_library', resourceId: null }]);
  });

  it('refuses to activate an order whose payment was never captured', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    const order = await createOrder(db, null, {
      email: 'principal@school.example.in',
      lines: [{ kind: 'program', feeCode: 'program.school.term', refType: 'program', refId: programId, description: 'Programme' }],
    });
    await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: 'order_' + crypto.randomBytes(5).toString('hex'),
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    // The browser came back saying it worked. It is a claim, not a fact.
    await expect(activateForOrder(db, null, order.id)).rejects.toThrow(EntitlementError);
    await expect(activateForOrder(db, null, order.id)).rejects.toThrow(/verified as captured/i);
    expect(await entitlementsOfOrder(order.id)).toHaveLength(0);
  });
});

describe('a pupil put back on the roll is actually back on it', () => {
  it('reinstates rather than reporting a replay that changed nothing', async () => {
    const programId = await makeProgram({ startsOn: '2026-04-01', endsOn: '2026-09-30' });
    await payForProgram(programId, 'program.school.term');
    const pupil = await makePerson('A pupil who left and came back');

    const first = await registerParticipant(db, ctx(), { programId, personId: pupil },
      new Date('2026-04-02T09:00:00Z'));
    expect(first.status).toBe('registered');

    await removeParticipant(db, ctx(), first.participantId, '2026-05-31');
    const gone = await libraryAccess(db, pupil, new Date('2026-06-15T09:00:00Z'));
    expect(gone.allowed).toBe(false);

    // The school asks for them back. The unique index cannot tell this from a
    // double-click, and reporting it as a replay left the pupil locked out with
    // no error anywhere to say why.
    const back = await registerParticipant(db, ctx(), { programId, personId: pupil },
      new Date('2026-06-16T09:00:00Z'));
    expect(back.status).toBe('reinstated');
    expect(back.participantId).toBe(first.participantId);
    expect((await libraryAccess(db, pupil, new Date('2026-06-20T09:00:00Z'))).allowed).toBe(true);

    // And it is still one row on the roll, not two.
    const roll = await db.select().from(s.programParticipants).where(and(
      eq(s.programParticipants.programId, programId),
      eq(s.programParticipants.personId, pupil)
    ));
    expect(roll).toHaveLength(1);

    // A genuine double-click is still a replay and still changes nothing.
    const again = await registerParticipant(db, ctx(), { programId, personId: pupil },
      new Date('2026-06-16T09:00:01Z'));
    expect(again.status).toBe('replayed');
  });
});
