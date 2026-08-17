// The entitlement engine — payment activates the service (§15-18).
//
// Every test here is either the rule that makes the engine safe or the attack
// that would break it. The four the brief names are the spine:
//
//   · a verified capture ACTIVATES what was bought;
//   · a replay does NOT duplicate it;
//   · a completed refund REVOKES it, and keeps the record;
//   · a browser asserting success, with no verified payment behind it,
//     activates NOTHING.
//
// The rest are the refusals: eligibility is re-checked at the moment the money
// clears and a paid fee does not override it, and a membership term nobody
// configured produces a blocked entitlement rather than a term this system made
// up.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from '../src/db/schema';
import { createOrder, beginPayment, confirmPayment, requestRefund, completeRefund } from '../src/db/orders';
import {
  activateForOrder, configureTerm, revokeForRefund, termEndsOn, subjectForLine,
  blockedEntitlements, activationBacklog, entitlementsForOrder, EntitlementError,
} from '../src/db/entitlements';
import { standing } from '../src/db/membership';
import type { Principal } from '../src/lib/rbac';
import type { VerifiedPayment } from '../src/lib/payments';
import type { AuditContext } from '../src/db/federation';

let db: any;
let STATE: number, DOJO: number, EVENT: number, CATEGORY: number, COACH: number;

const admin: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const finance: Principal = {
  userId: 2, label: 'treasurer',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 3, label: 'an athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
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

const today = new Date().toISOString().slice(0, 10);

/** A person in the register, in good standing unless told otherwise. */
async function makePerson(name: string, over: Record<string, unknown> = {}) {
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(Math.floor(Math.random() * 899999) + 100000)}`,
    fullName: name, status: 'active', dob: '2000-05-05', gender: 'male',
    stateUnitId: STATE, dojoId: DOJO, ...over,
  }).returning({ id: s.persons.id });
  return p.id as number;
}

/** Order → payment attempt → verified capture. The whole money path, honestly. */
async function payFor(lines: any[], opts: { personId?: number | null } = {}) {
  const order = await createOrder(db, null, {
    personId: opts.personId ?? null,
    email: 'payer@example.in',
    lines,
  });
  const payment = await beginPayment(db, order.id, {
    provider: 'razorpay',
    providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
    amountPaise: order.totalPaise,
    idempotencyKey: crypto.randomUUID(),
  });
  const result = await confirmPayment(db, null, captured({
    providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise, feePaise: 1180,
  }));
  return { order, payment, result };
}

const entitlementsOf = (orderId: number) =>
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

  const [dj] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-JH-001', name: 'Ranchi Dojo', stateUnitId: STATE, status: 'active',
  }).returning({ id: s.dojos.id });
  DOJO = dj.id;

  // The federation's published fees. Nothing in the code ships a rupee figure.
  await db.insert(s.feeSchedule).values([
    { code: 'membership.athlete.annual', label: 'Athlete membership (annual)', kind: 'membership', amountPaise: 50000, effectiveFrom: '2026-01-01', active: true },
    { code: 'membership.unconfigured', label: 'Membership, term not stated', kind: 'membership', amountPaise: 40000, effectiveFrom: '2026-01-01', active: true },
    { code: 'entry.national', label: 'National championship entry', kind: 'event_entry', amountPaise: 80000, effectiveFrom: '2026-01-01', active: true },
    { code: 'booking.coaching', label: 'Personal coaching session', kind: 'course', amountPaise: 120000, effectiveFrom: '2026-01-01', active: true },
  ]);

  // What that membership fee BUYS — the federation's decision, recorded.
  await configureTerm(db, ctx(), {
    feeCode: 'membership.athlete.annual', subject: 'membership',
    membershipCategory: 'athlete', termMonths: 12,
    approvedBy: 'Executive Committee', notes: 'Annual athlete membership.',
  });

  const [ev] = await db.insert(s.competitionEvents).values({
    code: 'MMAKF-EVT-2026-000001', title: 'National Championship', kind: 'national_championship',
    status: 'registration_open', startsOn: '2026-12-01', stateUnitId: STATE,
  }).returning({ id: s.competitionEvents.id });
  EVENT = ev.id;

  const [cat] = await db.insert(s.eventCategories).values({
    eventId: EVENT, code: 'SEN-M-KUM', label: 'Senior Male Kumite', discipline: 'kumite',
    feeCode: 'entry.national',
  }).returning({ id: s.eventCategories.id });
  CATEGORY = cat.id;

  COACH = await makePerson('Coach Sensei');
});

// ─── The rule ───────────────────────────────────────────────────────────────

describe('an entitlement is created ONLY from a server-verified payment', () => {
  it('ATTACK: a browser asserting success activates NOTHING', async () => {
    const personId = await makePerson('Hopeful Payer');
    const order = await createOrder(db, null, {
      personId, email: 'hopeful@example.in',
      lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
    });
    // The browser's claim, in its strongest form: a payment attempt was even
    // opened at the gateway. It is still not a capture.
    await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: 'order_client_says_paid',
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });

    await expect(activateForOrder(db, null, order.id)).rejects.toThrow(/no payment this system has verified as captured/i);

    expect(await entitlementsOf(order.id)).toHaveLength(0);
    const memberships = await db.select().from(s.memberships).where(eq(s.memberships.personId, personId));
    expect(memberships).toHaveLength(0);
    // And the order is still exactly what it was.
    const [after] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    expect(after.status).toBe('awaiting_payment');
  });

  it('refuses an order whose payment is captured but whose confirmation never finished', async () => {
    const personId = await makePerson('Half Confirmed');
    const order = await createOrder(db, null, {
      personId, lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
    });
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    // The wreck confirmPayment() names: money captured, order never marked paid.
    await db.update(s.payments).set({ status: 'captured', capturedAt: new Date() }).where(eq(s.payments.id, payment.id));

    await expect(activateForOrder(db, null, order.id)).rejects.toThrow(/incomplete confirmation/i);
    expect(await entitlementsOf(order.id)).toHaveLength(0);
  });

  it('an entitlement cannot be written without a payment — the schema says so', async () => {
    const order = await createOrder(db, null, {
      lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
    });
    const [line] = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
    await expect(db.insert(s.entitlements).values({
      subject: 'membership', orderId: order.id, orderLineId: line.id, paymentId: null as any, status: 'active',
    })).rejects.toThrow();
  });
});

// ─── Membership ─────────────────────────────────────────────────────────────

describe('a captured membership fee reaches the register', () => {
  it('issues the membership, and the member then verifies', async () => {
    const personId = await makePerson('New Member');
    const { order } = await payFor(
      [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
      { personId }
    );

    const [ent] = await entitlementsOf(order.id);
    expect(ent.status).toBe('active');
    expect(ent.subject).toBe('membership');
    expect(ent.subjectId).toBeTruthy();
    expect(ent.paymentId).toBeTruthy();
    expect(ent.invoiceId).toBeTruthy();
    // WHICH published fee priced it, frozen at activation.
    expect(ent.feeVersion).toMatch(/^membership\.athlete\.annual@2026-01-01#\d+$/);
    expect(ent.activatedBy).toBe('system:entitlement-activation');

    // The register — the thing /verify reads.
    const answer = await standing(db, admin, personId, 'athlete');
    expect(answer.standing).toBe('in_good_standing');
    expect(answer.membership!.id).toBe(ent.subjectId);

    // A twelve-month term beginning today ends the day BEFORE the anniversary.
    expect(answer.membership!.validTo).toBe(termEndsOn(today, 12));
  });

  it('emits a domain event and writes an audit row for the activation', async () => {
    const personId = await makePerson('Audited Member');
    const { order } = await payFor(
      [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
      { personId }
    );
    const [ent] = await entitlementsOf(order.id);

    const events = await db.select().from(s.domainEvents)
      .where(and(eq(s.domainEvents.entityType, 'entitlement'), eq(s.domainEvents.entityId, String(ent.id))));
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('ENTITLEMENT_ACTIVATED');
    // Money names a person and an amount together: never below confidential.
    expect(events[0].classification).toBe('confidential');

    const audits = await db.select().from(s.auditEvents)
      .where(and(eq(s.auditEvents.entityType, 'entitlement'), eq(s.auditEvents.entityId, String(ent.id))));
    expect(audits).toHaveLength(1);
    expect(audits[0].actorLabel).toBe('system:entitlement-activation');
  });

  it('will not invent a term the federation has not published', async () => {
    const personId = await makePerson('Unconfigured Fee');
    const { order } = await payFor(
      [{ kind: 'membership', description: 'x', feeCode: 'membership.unconfigured' }],
      { personId }
    );

    const [ent] = await entitlementsOf(order.id);
    expect(ent.status).toBe('blocked');
    expect(ent.reason).toMatch(/no entitlement term is configured/i);
    expect(ent.subjectId).toBeNull();
    // No membership was issued, and none was invented with a made-up term.
    expect(await db.select().from(s.memberships).where(eq(s.memberships.personId, personId))).toHaveLength(0);
    // It is on the exceptions queue, where somebody can refund it.
    const queue = await blockedEntitlements(db, finance);
    expect(queue.some((r: any) => r.id === ent.id)).toBe(true);
  });

  it('blocks rather than issuing when the order names no person', async () => {
    const { order } = await payFor([{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }]);
    const [ent] = await entitlementsOf(order.id);
    expect(ent.status).toBe('blocked');
    expect(ent.reason).toMatch(/names no person/i);
  });

  it('a payment does not reverse a revocation', async () => {
    const personId = await makePerson('Revoked Member');
    await db.insert(s.memberships).values({
      personId, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31',
      status: 'revoked', revokedReason: 'Disciplinary decision.',
    });

    const { order } = await payFor(
      [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
      { personId }
    );
    const [ent] = await entitlementsOf(order.id);
    expect(ent.status).toBe('blocked');
    expect(ent.reason).toMatch(/revoked/i);
    // Still exactly one membership row, still revoked.
    const rows = await db.select().from(s.memberships).where(eq(s.memberships.personId, personId));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('revoked');
  });
});

// ─── Idempotency ────────────────────────────────────────────────────────────

describe('a replay does not duplicate anything', () => {
  it('re-running activation issues ONE membership and ONE entitlement', async () => {
    const personId = await makePerson('Replayed Member');
    const { order } = await payFor(
      [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
      { personId }
    );

    // The gateway retries. The cron retries. An administrator presses it again.
    const again = await activateForOrder(db, null, order.id);
    await activateForOrder(db, null, order.id);

    expect(again.replayed).toBe(1);
    expect(again.activated).toBe(0);
    expect(await entitlementsOf(order.id)).toHaveLength(1);
    expect(await db.select().from(s.memberships).where(eq(s.memberships.personId, personId))).toHaveLength(1);
  });

  it('a replayed webhook capture confirms once and issues once', async () => {
    const personId = await makePerson('Webhook Replay');
    const order = await createOrder(db, null, {
      personId, lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
    });
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    const verified = captured({ providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise });

    const first = await confirmPayment(db, null, verified);
    const second = await confirmPayment(db, null, verified);      // the retry

    expect(first!.alreadyProcessed).toBe(false);
    expect(second!.alreadyProcessed).toBe(true);
    expect(await entitlementsOf(order.id)).toHaveLength(1);
    expect(await db.select().from(s.memberships).where(eq(s.memberships.personId, personId))).toHaveLength(1);
  });

  it('the guard is a database constraint, not a code path', async () => {
    const personId = await makePerson('Constraint Proof');
    const { order } = await payFor(
      [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
      { personId }
    );
    const [ent] = await entitlementsOf(order.id);

    // Going around the module entirely still cannot produce a second row.
    await expect(db.insert(s.entitlements).values({
      subject: 'membership', orderId: ent.orderId, orderLineId: ent.orderLineId,
      paymentId: ent.paymentId, status: 'active',
    })).rejects.toThrow();
  });
});

// ─── Event entries ──────────────────────────────────────────────────────────

describe('a captured entry fee clears the entry — only if eligibility still holds', () => {
  async function entryFor(personId: number, status = 'fee_pending') {
    const [entry] = await db.insert(s.eventEntries).values({
      entryNo: `MMAKF-ENT-2026-${String(Math.floor(Math.random() * 899999) + 100000)}`,
      eventId: EVENT, categoryId: CATEGORY, personId, dojoId: DOJO, stateUnitId: STATE, status,
    }).returning();
    return entry;
  }

  async function memberInGoodStanding(name: string) {
    const personId = await makePerson(name);
    await db.insert(s.memberships).values({
      personId, category: 'athlete', validFrom: '2026-01-01', validTo: '2030-12-31', status: 'active',
    });
    return personId;
  }

  it('confirms the entry and records the order against it', async () => {
    const personId = await memberInGoodStanding('Eligible Competitor');
    const entry = await entryFor(personId);

    const { order } = await payFor(
      [{ kind: 'event_entry', description: 'Entry', feeCode: 'entry.national', refType: 'event_entry', refId: entry.id }],
      { personId }
    );

    const [ent] = await entitlementsOf(order.id);
    expect(ent.status).toBe('active');
    expect(ent.subject).toBe('event_entry');
    expect(ent.subjectId).toBe(entry.id);

    const [after] = await db.select().from(s.eventEntries).where(eq(s.eventEntries.id, entry.id));
    expect(after.status).toBe('confirmed');
    expect(after.orderId).toBe(order.id);
  });

  it('PAYMENT DOES NOT OVERRIDE ELIGIBILITY: an uncovered competitor stays unconfirmed', async () => {
    // No membership at all: the eligibility rules refuse them, and the fee
    // arriving afterwards changes nothing about that.
    const personId = await makePerson('Uncovered Competitor');
    const entry = await entryFor(personId);

    const { order } = await payFor(
      [{ kind: 'event_entry', description: 'Entry', feeCode: 'entry.national', refType: 'event_entry', refId: entry.id }],
      { personId }
    );

    const [ent] = await entitlementsOf(order.id);
    expect(ent.status).toBe('blocked');
    expect(ent.reason).toMatch(/does not override eligibility/i);
    expect(ent.reason).toMatch(/membership/i);

    const [after] = await db.select().from(s.eventEntries).where(eq(s.eventEntries.id, entry.id));
    expect(after.status).toBe('fee_pending');
    // The evidence is frozen on the row, so the refusal can be explained later.
    expect((ent.detail as any).checks[0].reasons.length).toBeGreaterThan(0);
  });

  it('will not clear a withdrawn entry', async () => {
    const personId = await memberInGoodStanding('Withdrawn Competitor');
    const entry = await entryFor(personId, 'withdrawn');

    const { order } = await payFor(
      [{ kind: 'event_entry', description: 'Entry', feeCode: 'entry.national', refType: 'event_entry', refId: entry.id }],
      { personId }
    );
    const [ent] = await entitlementsOf(order.id);
    expect(ent.status).toBe('blocked');
    expect(ent.reason).toMatch(/withdrawn/i);
  });
});

// ─── Bookings ───────────────────────────────────────────────────────────────

describe('a captured booking fee confirms the booking', () => {
  async function bookingFor(personId: number, status = 'requested') {
    const [b] = await db.insert(s.bookings).values({
      ref: `MMAKF-BKG-2026-${String(Math.floor(Math.random() * 899999) + 100000)}`,
      kind: 'personal_coaching', status, personId, coachPersonId: COACH, dojoId: DOJO,
      startsAt: new Date('2026-11-01T10:00:00Z'), endsAt: new Date('2026-11-01T11:00:00Z'),
    }).returning();
    return b;
  }

  it('moves it from requested to confirmed', async () => {
    const personId = await makePerson('Booking Payer');
    const booking = await bookingFor(personId);

    const { order } = await payFor(
      [{ kind: 'course', description: 'Session', feeCode: 'booking.coaching', refType: 'booking', refId: booking.id }],
      { personId }
    );

    const [ent] = await entitlementsOf(order.id);
    expect(ent.status).toBe('active');
    expect(ent.subject).toBe('booking');
    const [after] = await db.select().from(s.bookings).where(eq(s.bookings.id, booking.id));
    expect(after.status).toBe('confirmed');
  });

  it('will not confirm a booking that was cancelled before the money arrived', async () => {
    const personId = await makePerson('Late Payer');
    const booking = await bookingFor(personId, 'cancelled');

    const { order } = await payFor(
      [{ kind: 'course', description: 'Session', feeCode: 'booking.coaching', refType: 'booking', refId: booking.id }],
      { personId }
    );
    const [ent] = await entitlementsOf(order.id);
    expect(ent.status).toBe('blocked');
    expect(ent.reason).toMatch(/cancelled/i);
  });
});

// ─── Refunds ────────────────────────────────────────────────────────────────

describe('a completed refund reverses the entitlement', () => {
  it('revokes the membership, keeps the record, and states why', async () => {
    const personId = await makePerson('Refunded Member');
    const { order } = await payFor(
      [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
      { personId }
    );
    const [before] = await entitlementsOf(order.id);
    expect(before.status).toBe('active');

    const [payment] = await db.select().from(s.payments)
      .where(and(eq(s.payments.orderId, order.id), eq(s.payments.status, 'captured')));
    const refund = await requestRefund(db, ctx(finance), {
      paymentId: payment.id, amountPaise: payment.amountPaise, reason: 'Paid twice by mistake.',
    });
    const done = await completeRefund(db, ctx(finance), { refundId: refund.id, providerRefundId: 'rfnd_1' });

    expect(done.fullyRefunded).toBe(true);
    expect(done.revocation!.revoked).toBe(1);

    // NOT DELETED. The row is still there, with its history intact.
    const [after] = await entitlementsOf(order.id);
    expect(after.id).toBe(before.id);
    expect(after.status).toBe('revoked');
    expect(after.revokedAt).toBeTruthy();
    expect(after.refundId).toBe(refund.id);
    expect(after.reason).toMatch(/Paid twice by mistake/);
    expect(after.subjectId).toBe(before.subjectId);      // it still names what it withdrew

    // A refunded membership is a REVOKED membership with a history.
    const [membership] = await db.select().from(s.memberships).where(eq(s.memberships.id, before.subjectId));
    expect(membership.status).toBe('revoked');
    const answer = await standing(db, admin, personId, 'athlete');
    expect(answer.standing).toBe('revoked');

    const events = await db.select().from(s.domainEvents)
      .where(and(eq(s.domainEvents.entityType, 'entitlement'), eq(s.domainEvents.entityId, String(after.id))));
    expect(events.map((e: any) => e.eventType)).toContain('ENTITLEMENT_REVOKED');
  });

  it('returns a cleared entry to fee_pending rather than deleting it', async () => {
    const personId = await makePerson('Refunded Competitor');
    await db.insert(s.memberships).values({
      personId, category: 'athlete', validFrom: '2026-01-01', validTo: '2030-12-31', status: 'active',
    });
    const [entry] = await db.insert(s.eventEntries).values({
      entryNo: `MMAKF-ENT-2026-${String(Math.floor(Math.random() * 899999) + 100000)}`,
      eventId: EVENT, categoryId: CATEGORY, personId, dojoId: DOJO, stateUnitId: STATE, status: 'fee_pending',
    }).returning();

    const { order } = await payFor(
      [{ kind: 'event_entry', description: 'Entry', feeCode: 'entry.national', refType: 'event_entry', refId: entry.id }],
      { personId }
    );
    const [payment] = await db.select().from(s.payments)
      .where(and(eq(s.payments.orderId, order.id), eq(s.payments.status, 'captured')));
    const refund = await requestRefund(db, ctx(finance), {
      paymentId: payment.id, amountPaise: payment.amountPaise, reason: 'Event postponed.',
    });
    await completeRefund(db, ctx(finance), { refundId: refund.id });

    const [after] = await db.select().from(s.eventEntries).where(eq(s.eventEntries.id, entry.id));
    expect(after.status).toBe('fee_pending');           // lodged and unpaid, exactly as before
  });

  it('refuses to reverse anything on a refund that has not completed', async () => {
    const personId = await makePerson('Intending Refund');
    const { order } = await payFor(
      [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
      { personId }
    );
    const [payment] = await db.select().from(s.payments)
      .where(and(eq(s.payments.orderId, order.id), eq(s.payments.status, 'captured')));
    const refund = await requestRefund(db, ctx(finance), {
      paymentId: payment.id, amountPaise: payment.amountPaise, reason: 'Considering it.',
    });

    await expect(revokeForRefund(db, ctx(finance), refund.id)).rejects.toThrow(/never by one that was merely requested/i);
    const [still] = await entitlementsOf(order.id);
    expect(still.status).toBe('active');
  });

  it('a PARTIAL refund withdraws nothing, and says so', async () => {
    const personId = await makePerson('Part Refunded');
    const { order } = await payFor(
      [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
      { personId }
    );
    const [payment] = await db.select().from(s.payments)
      .where(and(eq(s.payments.orderId, order.id), eq(s.payments.status, 'captured')));
    const refund = await requestRefund(db, ctx(finance), {
      paymentId: payment.id, amountPaise: Math.floor(payment.amountPaise / 2), reason: 'Goodwill.',
    });
    const done = await completeRefund(db, ctx(finance), { refundId: refund.id });

    expect(done.fullyRefunded).toBe(false);
    expect(done.revocation!.outcomes[0].status).toBe('retained');
    const [after] = await entitlementsOf(order.id);
    expect(after.status).toBe('active');
  });

  it('completing the same refund twice posts one reversal', async () => {
    const personId = await makePerson('Double Completed');
    const { order } = await payFor(
      [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
      { personId }
    );
    const [payment] = await db.select().from(s.payments)
      .where(and(eq(s.payments.orderId, order.id), eq(s.payments.status, 'captured')));
    const refund = await requestRefund(db, ctx(finance), {
      paymentId: payment.id, amountPaise: payment.amountPaise, reason: 'Cancelled by the member.',
    });

    await completeRefund(db, ctx(finance), { refundId: refund.id });
    const second = await completeRefund(db, ctx(finance), { refundId: refund.id });
    expect(second.alreadyCompleted).toBe(true);

    const ledger = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.refundId, refund.id));
    expect(ledger).toHaveLength(2);                     // one debit, one credit — not four
  });
});

// ─── Configuration and reads ────────────────────────────────────────────────

describe('what a fee buys is configured, never inferred', () => {
  it('refuses a term with no length and no explicit open-ended decision', async () => {
    await expect(configureTerm(db, ctx(), {
      feeCode: 'membership.nothing.stated', subject: 'membership', membershipCategory: 'athlete',
    })).rejects.toThrow(/no default/i);
  });

  it('refuses a membership term that does not say which register it admits to', async () => {
    await expect(configureTerm(db, ctx(), {
      feeCode: 'membership.no.category', subject: 'membership', termMonths: 12,
    })).rejects.toThrow(/WHICH register/i);
  });

  it('is gated on feeframework:write, not on the authority to take money', async () => {
    // A member who can pay a fee cannot decide what fees buy. The gate is the
    // one src/db/fees.ts uses for the pricing rules themselves: whoever edits a
    // rule changes every future outcome silently.
    await expect(configureTerm(db, ctx(athlete), {
      feeCode: 'membership.athlete.forged', subject: 'membership', membershipCategory: 'athlete', termMonths: 120,
    })).rejects.toThrow();
    expect(await db.select().from(s.entitlementTerms)
      .where(eq(s.entitlementTerms.feeCode, 'membership.athlete.forged'))).toHaveLength(0);
  });

  it('records an open-ended entitlement as a decision, not as a blank', async () => {
    const row = await configureTerm(db, ctx(), {
      feeCode: 'membership.life', subject: 'membership', membershipCategory: 'athlete', openEnded: true,
      approvedBy: 'General Council',
    });
    expect(row.openEnded).toBe(true);
    expect(row.termMonths).toBeNull();
  });
});

describe('terms arithmetic', () => {
  it('ends a twelve-month term the day before the anniversary', () => {
    expect(termEndsOn('2026-01-01', 12)).toBe('2026-12-31');
    expect(termEndsOn('2026-06-15', 12)).toBe('2027-06-14');
  });

  it('clamps a month-end start instead of drifting into the next month', () => {
    // 31 January plus one month is not 3 March.
    expect(termEndsOn('2026-01-31', 1)).toBe('2026-02-27');
  });
});

describe('routing a line to what it bought', () => {
  it('reads refType before kind, because kind is a billing category', () => {
    expect(subjectForLine({ kind: 'course', refType: 'booking' })).toBe('booking');
    expect(subjectForLine({ kind: 'membership' })).toBe('membership');
    // A gi and a donation entitle the payer to nothing in this table.
    expect(subjectForLine({ kind: 'product' })).toBeNull();
    expect(subjectForLine({ kind: 'donation' })).toBeNull();
  });
});

describe('reads are gated and useful', () => {
  it('refuses a reader without finance:read', async () => {
    await expect(blockedEntitlements(db, athlete)).rejects.toThrow();
    await expect(activationBacklog(db, athlete)).rejects.toThrow();
    await expect(entitlementsForOrder(db, athlete, 1)).rejects.toThrow();
  });

  it('lists paid lines that were never activated at all', async () => {
    // The silent failure: a capture confirmed, the process died before
    // activation. Nothing else would ever have looked at it again.
    const personId = await makePerson('Never Activated');
    const { order } = await payFor(
      [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
      { personId }
    );
    await db.delete(s.entitlements).where(eq(s.entitlements.orderId, order.id));

    const backlog = await activationBacklog(db, finance);
    expect(backlog.some((r: any) => r.orderId === order.id)).toBe(true);

    // And re-running activation clears it.
    await activateForOrder(db, null, order.id);
    const after = await activationBacklog(db, finance);
    expect(after.some((r: any) => r.orderId === order.id)).toBe(false);
  });
});
