// The money path into a right to train, attacked.
//
// Every case here is a defect that was reachable in this codebase and is not
// any more. They are kept as tests because each one was a way for a family to
// pay MMAKF and get nothing, or to get something nobody paid for.
//
//   A1  a grant BLOCKED for want of a published framework was permanent. The
//       unique index on order_line_id is not partial, so the blocked row held
//       the slot for ever and the cure the code itself names — publish the
//       framework and re-run — collided with it and reported "already granted".
//       Today no framework is published, so this was every training payment.
//   A2  renewTraining() took ANY paid order line. A one-rupee donation bought a
//       month on the mat and recorded 100 paise against a 1,20,000 paise product.
//   A3  a forged unit price on a training line.
//   A4  confirmPayment() never issued training at all: money taken, no
//       entitlement, and not even the blocked row the finance desk refunds from.
//   A5  idempotency, run three times.
//   A6  a non-training order is untouched by any of it.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from '../src/db/schema';
import {
  createOrder, beginPayment, confirmPayment, requestRefund, completeRefund,
} from '../src/db/orders';
import { createFramework, addRule, publishFramework } from '../src/db/fees';
import {
  defineTrainingProduct, publishTrainingProduct, openTrainingPlan,
  activateTrainingForOrder, trainingAccess, renewTraining, blockedTraining,
  trainingHistory, isTrainingProductError,
} from '../src/db/training-products';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any, client: PGlite, STATE: number, CLUB: number;
const admin: Principal = { userId: 1, label: 'admin', bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }] };
const finance: Principal = { userId: 2, label: 'treasurer', bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }] };
const ctx = (p: Principal = admin): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });
const FEE_CODE = 'MMAKF-FEE-TRN-SHOTOKAN-MONTHLY';
const today = new Date().toISOString().slice(0, 10);
const captured = (over: any = {}) => ({
  providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
  providerOrderId: '', amountPaise: 0, currency: 'INR', status: 'captured', method: 'upi', ...over,
});

async function pay(lines: any[], personId: number | null) {
  const order = await createOrder(db, null, { personId, email: 'p@example.in', lines });
  const attempt = await beginPayment(db, order.id, {
    provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
    amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
  });
  await confirmPayment(db, null, captured({ providerOrderId: attempt.providerOrderId, amountPaise: order.totalPaise }) as any);
  return order;
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  const [u] = await db.insert(s.stateUnits).values({ code: 'ST', state: 'JH', name: 'JH', status: 'active' }).returning({ id: s.stateUnits.id });
  STATE = u.id;
  const [d] = await db.insert(s.dojos).values({ code: 'D1', name: 'A', stateUnitId: STATE, status: 'active' }).returning({ id: s.dojos.id });
  CLUB = d.id;
  await db.insert(s.users).values([{ email: 'a@e.in' }, { email: 'b@e.in' }]);
  await db.insert(s.feeCatalogueEntries).values({
    code: FEE_CODE, slug: 'trn', name: 'Training', category: 'training', audience: 'athlete',
    unit: 'per_month', frequency: 'monthly', displayPolicy: 'public', status: 'published',
  });
  await db.insert(s.feeSchedule).values({
    code: FEE_CODE, label: 'Training', kind: 'training', amountPaise: 120000,
    effectiveFrom: '2020-01-01', active: true,
  });
});

async function person(name: string) {
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(Math.floor(Math.random() * 899999) + 100000)}`,
    fullName: name, status: 'active', dob: '2014-05-05', gender: 'female', stateUnitId: STATE, dojoId: CLUB,
  }).returning({ id: s.persons.id });
  return p.id as number;
}
async function product(code: string) {
  const p = await defineTrainingProduct(db, ctx(), {
    code, slug: code.toLowerCase(), title: 'Shotokan monthly', discipline: 'Shotokan',
    programme: 'Junior', period: 'monthly', feeCode: FEE_CODE, clubId: CLUB,
  });
  await publishTrainingProduct(db, ctx(), p.id);
  return (await db.select().from(s.trainingProducts).where(eq(s.trainingProducts.id, p.id)))[0];
}
// `as const` on the two literals: without it TypeScript widens them to `string`
// and the object stops satisfying DraftLine, whose `kind` and `refType` are
// unions. Nothing about the values changes.
const trainingLine = (plan: any) => ({
  kind: 'training' as const, description: 'Training', feeCode: FEE_CODE,
  refType: 'training_plan' as const, refId: plan.id,
});

describe('ATTACK — money taken, nothing granted', () => {
  it('A1: a grant blocked for want of a framework is rescued when one is published', async () => {
    const kid = await person('Blocked child');
    const prod = await product('MMAKF-TRN-A1');
    const plan = await openTrainingPlan(db, ctx(), { personId: kid, productId: prod.id, clubId: CLUB, startsOn: today });
    const order = await pay([trainingLine(plan)], kid);

    const first = await activateTrainingForOrder(db, null, order.id);
    expect(first.blocked).toBe(1);
    expect(first.granted).toBe(0);

    // Re-running with the blocker STILL in place says blocked, not "granted".
    const again = await activateTrainingForOrder(db, null, order.id);
    expect(again.blocked).toBe(1);
    expect(again.granted).toBe(0);
    expect(await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.orderLineId, again.outcomes[0].orderLineId))).toHaveLength(1);

    // The federation publishes its framework — the cure the code names.
    const fw = await createFramework(db, ctx(), { title: 'FW', version: 1, effectiveFrom: '2020-01-01' });
    await addRule(db, ctx(), fw.id, { code: 'TRN-BASE', label: 'Training', kind: 'base', amountMinor: 120000 });
    await publishFramework(db, ctx(), fw.id);

    const rescued = await activateTrainingForOrder(db, null, order.id);
    expect(rescued.granted).toBe(1);
    expect(rescued.blocked).toBe(0);
    expect((await trainingAccess(db, { personId: kid })).allowed).toBe(true);
    expect(await blockedTraining(db, finance)).toHaveLength(0);

    // ONE row, still. The rescue resolved the blocked row; it did not add one.
    const rows = await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.personId, kid));
    expect(rows).toHaveLength(1);
    expect(rows[0].priceFrameworkId).toBe(fw.id);
    // The original refusal is kept, not erased.
    expect(rows[0].detail.resolvedFromBlocked).toMatch(/no fee framework in force/i);

    // And rescuing twice grants nothing twice.
    const third = await activateTrainingForOrder(db, null, order.id);
    expect(third.outcomes[0].status).toBe('replayed');
    expect(await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.personId, kid))).toHaveLength(1);
  });

  it('A2: renewTraining refuses an order line that bought something else', async () => {
    const kid = await person('Renewed child');
    const other = await person('Somebody else');
    const prod = await product('MMAKF-TRN-A2');
    const plan = await openTrainingPlan(db, ctx(), { personId: kid, productId: prod.id, clubId: CLUB, startsOn: today });
    const order = await pay([trainingLine(plan)], kid);
    // confirmPayment() already issued it; this call is the idempotent replay.
    const rep = await activateTrainingForOrder(db, null, order.id);
    expect(rep.outcomes[0].status).toBe('replayed');
    const entId = rep.outcomes[0].entitlementId!;

    // A ₹1 DONATION, paid for. It used to buy a month on the mat.
    const donation = await pay([{ kind: 'donation', description: 'Donation', unitPricePaise: 100 }], kid);
    const [dline] = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, donation.id));
    await expect(renewTraining(db, ctx(), { previousEntitlementId: entId, orderLineId: dline.id }))
      .rejects.toMatchObject({ code: 'line_not_training' });

    // A training line for somebody else's plan.
    const otherPlan = await openTrainingPlan(db, ctx(), { personId: other, productId: prod.id, clubId: CLUB, startsOn: today });
    const otherOrder = await pay([trainingLine(otherPlan)], other);
    const [oline] = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, otherOrder.id));
    await expect(renewTraining(db, ctx(), { previousEntitlementId: entId, orderLineId: oline.id }))
      .rejects.toMatchObject({ code: 'line_not_for_this_term' });

    // A one-off product line bought on somebody else's order.
    const strangerOrder = await pay([{
      kind: 'training', description: 'Training', feeCode: FEE_CODE,
      refType: 'training_product', refId: prod.id,
    }], other);
    const [pline] = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, strangerOrder.id));
    await expect(renewTraining(db, ctx(), { previousEntitlementId: entId, orderLineId: pline.id }))
      .rejects.toMatchObject({ code: 'line_not_for_this_person' });

    // The honest renewal still works — and the payment path performs it, so the
    // second month begins the day after the first ends rather than overlapping it.
    const [firstTerm] = await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.id, entId));
    await pay([trainingLine(plan)], kid);
    const terms = await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.personId, kid));
    expect(terms).toHaveLength(2);
    const row = terms.find((t: any) => t.id !== entId)!;
    expect(row.renewalSequence).toBe(2);
    expect(row.renewedFromEntitlementId).toBe(entId);
    expect(row.amountPaidMinor).toBe(120000);
    const dayAfter = new Date(`${firstTerm.validUntil}T00:00:00Z`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    expect(row.validFrom).toBe(dayAfter.toISOString().slice(0, 10));

    // And no free term was recorded against the child.
    const history = await trainingHistory(db, admin, kid);
    expect(history.every((h: any) => h.amountPaidMinor === 120000)).toBe(true);
  });

  it('A3: a client-supplied price on a training line is ignored, not honoured', async () => {
    const kid = await person('Forger');
    const prod = await product('MMAKF-TRN-A3');
    const plan = await openTrainingPlan(db, ctx(), { personId: kid, productId: prod.id, clubId: CLUB, startsOn: today });
    const o = await createOrder(db, null, {
      personId: kid, email: 'f@e.in',
      lines: [{ ...trainingLine(plan), unitPricePaise: 1 } as any],
    });
    expect(o.totalPaise).toBe(120000);
    await expect(createOrder(db, null, {
      personId: kid, email: 'f@e.in',
      lines: [{ kind: 'training', description: 'Training', unitPricePaise: 1, refType: 'training_plan', refId: plan.id } as any],
    })).rejects.toMatchObject({ code: 'unpriced' });
  });

  it('A4: confirming a payment issues the right to train, with no second call', async () => {
    const kid = await person('Wired child');
    const prod = await product('MMAKF-TRN-A4');
    const plan = await openTrainingPlan(db, ctx(), { personId: kid, productId: prod.id, clubId: CLUB, startsOn: today });
    await pay([trainingLine(plan)], kid);

    const access = await trainingAccess(db, { personId: kid });
    expect(access.allowed).toBe(true);
    expect(await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.personId, kid))).toHaveLength(1);
  });

  it('A5: a replayed webhook issues the term once', async () => {
    const kid = await person('Replayed child');
    const prod = await product('MMAKF-TRN-A5');
    const plan = await openTrainingPlan(db, ctx(), { personId: kid, productId: prod.id, clubId: CLUB, startsOn: today });
    const order = await createOrder(db, null, { personId: kid, email: 'r@e.in', lines: [trainingLine(plan)] });
    const attempt = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    const v = captured({ providerOrderId: attempt.providerOrderId, amountPaise: order.totalPaise });
    await confirmPayment(db, null, v as any);
    await confirmPayment(db, null, v as any);
    await confirmPayment(db, null, v as any);
    await activateTrainingForOrder(db, null, order.id);

    expect(await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.personId, kid))).toHaveLength(1);
    expect(await db.select().from(s.invoices).where(eq(s.invoices.orderId, order.id))).toHaveLength(1);
  });

  it('A7: a completed FULL refund ends the right to train; a partial one does not', async () => {
    const kid = await person('Refunded child');
    const prod = await product('MMAKF-TRN-A7');
    const plan = await openTrainingPlan(db, ctx(), { personId: kid, productId: prod.id, clubId: CLUB, startsOn: today });
    const order = await pay([trainingLine(plan)], kid);
    expect((await trainingAccess(db, { personId: kid })).allowed).toBe(true);

    const [payment] = await db.select().from(s.payments).where(eq(s.payments.orderId, order.id));

    // HALF THE FEE BACK. What that buys back is a decision nobody has taken, so
    // the child stays on the mat and the desk is told so.
    const part = await requestRefund(db, ctx(finance), {
      paymentId: payment.id, amountPaise: 60000, reason: 'Half the term missed',
    });
    const partDone: any = await completeRefund(db, ctx(finance), { refundId: part.id });
    expect(partDone.trainingRevocation.outcomes[0].status).toBe('retained');
    expect((await trainingAccess(db, { personId: kid })).allowed).toBe(true);

    // THE REST OF IT. Now the payment is fully refunded and the term ends.
    const rest = await requestRefund(db, ctx(finance), {
      paymentId: payment.id, amountPaise: 60000, reason: 'Family moved away',
    });
    const restDone: any = await completeRefund(db, ctx(finance), { refundId: rest.id });
    expect(restDone.trainingRevocation.revoked).toBe(1);

    const decision = await trainingAccess(db, { personId: kid });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/revoked/i);

    // THE ROW IS KEPT, with the refund and the reason on it.
    const [row] = await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.personId, kid));
    expect(row.status).toBe('revoked');
    expect(row.refundId).toBe(rest.id);
    expect(row.validUntil).not.toBeNull();
    expect(row.amountPaidMinor).toBe(120000);
    expect(row.priceFrameworkId).not.toBeNull();
  });

  it('A6: a merchandise order is untouched by the training path', async () => {
    const kid = await person('Shopper');
    await db.insert(s.feeSchedule).values({
      code: 'MMAKF-FEE-DOC-CARD', label: 'Card', kind: 'other', amountPaise: 20000,
      effectiveFrom: '2020-01-01', active: true,
    });
    const order = await pay([{ kind: 'other', description: 'Card', feeCode: 'MMAKF-FEE-DOC-CARD' }], kid);
    expect(await db.select().from(s.trainingEntitlements)
      .where(eq(s.trainingEntitlements.orderId, order.id))).toHaveLength(0);
    expect((await trainingAccess(db, { personId: kid })).allowed).toBe(false);
  });
});
