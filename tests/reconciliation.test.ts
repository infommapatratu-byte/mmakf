// Reconciliation, disputes and gateway routing.
//
// Three things this suite exists to prove, against a real Postgres engine
// rather than a mock:
//
//  1. TWO ATTEMPTS ON ONE INTENT CANNOT BOTH SUCCEED. Not "should not" — the
//     second is refused by the database, which is the only guarantee that holds
//     when two webhooks arrive together. A failed attempt on gateway A must
//     never become a second CHARGE on gateway B.
//
//  2. AN UNRECONCILED ITEM IS AN ALERT. Every classification that is not
//     MATCHED puts a task in the finance queue, and running the same
//     reconciliation twice does not put it there twice — because an exceptions
//     queue that grows a copy a night is one nobody reads.
//
//  3. NOTHING IS INVENTED. No gateway rate is hard-coded, no settlement
//     deadline is assumed, and with no credentials configured the router says
//     so plainly instead of naming a gateway that cannot take the money.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and, inArray } from 'drizzle-orm';
import * as s from '../src/db/schema';
import * as r from '../src/db/reconciliation.schema';
import * as o from '../src/db/operations.schema';
import {
  openIntent, startAttempt, settleAttempt, closeIntent, attemptsForIntent,
  importGatewayTransactions, upsertCostRate, estimateGatewayCost, surchargeMinor,
  runReconciliation, openExceptions, resolveException,
  openDispute, submitEvidence, resolveDispute,
  disputesDueWithin, undefendedDisputes, disputeExposure, lapseUndefendedDisputes,
  upsertRoutingRule, chooseGateway, recordGatewayProbe, gatewayStanding,
  isReconciliationError, RECONCILIATION_STATUSES, isException,
} from '../src/db/reconciliation';
import { statusOf, needsAction, knownStatuses } from '../src/lib/status';
import { ForbiddenError, type Principal } from '../src/lib/rbac';

let db: any;

const finance: Principal = {
  userId: 1, label: 'finance',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 2, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
const ctx = { principal: finance };
const athleteCtx = { principal: athlete };

const DAY = 86_400_000;
const T0 = new Date('2026-03-01T00:00:00.000Z');
const T1 = new Date('2026-04-01T00:00:00.000Z');
const MID = new Date('2026-03-15T10:00:00.000Z');

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  await db.insert(s.users).values([
    { id: 1, email: 'finance@mmakf.in', status: 'active' },
    { id: 2, email: 'athlete@mmakf.in', status: 'active' },
  ]);
});

/** An order plus a captured payment, exactly as commerce would leave them. */
async function makeOrder(opts: {
  orderNo: string; totalPaise: number; currency?: string;
  providerPaymentId?: string | null; capturedAt?: Date | null; provider?: string;
}) {
  const [order] = await db.insert(s.orders).values({
    orderNo: opts.orderNo,
    status: opts.capturedAt ? 'paid' : 'awaiting_payment',
    subtotalPaise: opts.totalPaise,
    totalPaise: opts.totalPaise,
    currency: opts.currency ?? 'INR',
  }).returning();

  let payment = null;
  if (opts.providerPaymentId !== undefined) {
    [payment] = await db.insert(s.payments).values({
      orderId: order.id,
      provider: opts.provider ?? 'razorpay',
      providerPaymentId: opts.providerPaymentId,
      amountPaise: opts.totalPaise,
      currency: opts.currency ?? 'INR',
      status: opts.capturedAt ? 'captured' : 'created',
      capturedAt: opts.capturedAt ?? null,
    }).returning();
  }
  return { order, payment };
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. The double charge
// ═══════════════════════════════════════════════════════════════════════════

describe('at most one successful payment per intent', () => {
  it('PROOF: two attempts on one intent cannot both succeed', async () => {
    // The scenario, exactly: gateway A declines, the office fails over to
    // gateway B, B succeeds — and then A's late authorisation settles and
    // arrives as a success too. Before the constraint, the federation had taken
    // the money twice and its own records said it had taken it once.
    const { order } = await makeOrder({ orderNo: 'MMAKF-ORD-2026-000101', totalPaise: 250_000, providerPaymentId: undefined });
    const intent = await openIntent(db, { orderId: order.id, amountMinor: 250_000 });

    const a = await startAttempt(db, { intentId: intent.id, gateway: 'razorpay' });
    await settleAttempt(db, { attemptId: a.id, outcome: 'failed', failureReason: 'card declined' });

    const b = await startAttempt(db, { intentId: intent.id, gateway: 'manual_upi' });
    await settleAttempt(db, { attemptId: b.id, outcome: 'succeeded', gatewayPaymentId: 'pay_B' });

    // A's late success. The database refuses it.
    const [reopened] = await db.update(r.paymentAttempts)
      .set({ outcome: 'pending', finishedAt: null })
      .where(eq(r.paymentAttempts.id, a.id)).returning();
    expect(reopened.outcome).toBe('pending');

    await expect(
      settleAttempt(db, { attemptId: a.id, outcome: 'succeeded', gatewayPaymentId: 'pay_A' })
    ).rejects.toMatchObject({ code: 'double_success' });

    // And the record still shows exactly one success, which is the fact that
    // matters — not that an exception was thrown.
    const rows = await attemptsForIntent(db, intent.id);
    expect(rows.filter((x: any) => x.outcome === 'succeeded')).toHaveLength(1);
    expect(rows.find((x: any) => x.id === b.id).gatewayPaymentId).toBe('pay_B');
  });

  it('refuses to fail over while the first attempt is still in flight', async () => {
    // The rule that stops the double charge being CREATED rather than caught:
    // an attempt with no answer is not a failed attempt, and retrying elsewhere
    // on an unknown is how one purchase becomes two charges.
    const { order } = await makeOrder({ orderNo: 'MMAKF-ORD-2026-000102', totalPaise: 100_000, providerPaymentId: undefined });
    const intent = await openIntent(db, { orderId: order.id, amountMinor: 100_000 });
    const a = await startAttempt(db, { intentId: intent.id, gateway: 'razorpay' });
    await settleAttempt(db, { attemptId: a.id, outcome: 'pending' });

    await expect(
      startAttempt(db, { intentId: intent.id, gateway: 'manual_upi' })
    ).rejects.toMatchObject({ code: 'attempt_in_flight' });

    // Once it has a terminal answer, failover is legal.
    await settleAttempt(db, { attemptId: a.id, outcome: 'failed' });
    const b = await startAttempt(db, { intentId: intent.id, gateway: 'manual_upi' });
    expect(b.attemptNo).toBe(2);
  });

  it('will not open a second intent for an order somebody has already paid', async () => {
    const { order } = await makeOrder({ orderNo: 'MMAKF-ORD-2026-000103', totalPaise: 50_000, providerPaymentId: undefined });
    const first = await openIntent(db, { orderId: order.id, amountMinor: 50_000 });
    const again = await openIntent(db, { orderId: order.id, amountMinor: 50_000 });
    expect(again.id).toBe(first.id);

    const a = await startAttempt(db, { intentId: first.id, gateway: 'razorpay' });
    await settleAttempt(db, { attemptId: a.id, outcome: 'succeeded', gatewayPaymentId: 'pay_paid' });

    // Still the same intent — a succeeded one is live, not spent.
    const third = await openIntent(db, { orderId: order.id, amountMinor: 50_000 });
    expect(third.id).toBe(first.id);
    expect(third.status).toBe('succeeded');
    await expect(
      startAttempt(db, { intentId: first.id, gateway: 'manual_upi' })
    ).rejects.toMatchObject({ code: 'intent_closed' });
  });

  it('never takes the amount from the caller', async () => {
    const { order } = await makeOrder({ orderNo: 'MMAKF-ORD-2026-000104', totalPaise: 75_000, providerPaymentId: undefined });
    await expect(
      openIntent(db, { orderId: order.id, amountMinor: 1 })
    ).rejects.toMatchObject({ code: 'amount_mismatch' });
  });

  it('refuses a non-integer amount rather than rounding it', async () => {
    const { order } = await makeOrder({ orderNo: 'MMAKF-ORD-2026-000105', totalPaise: 1_000, providerPaymentId: undefined });
    await expect(
      openIntent(db, { orderId: order.id, amountMinor: 1000.5 })
    ).rejects.toMatchObject({ code: 'bad_amount' });
  });

  it('treats a repeated terminal answer as a replay, and a contradiction as an error', async () => {
    const { order } = await makeOrder({ orderNo: 'MMAKF-ORD-2026-000106', totalPaise: 20_000, providerPaymentId: undefined });
    const intent = await openIntent(db, { orderId: order.id, amountMinor: 20_000 });
    const a = await startAttempt(db, { intentId: intent.id, gateway: 'razorpay' });
    await settleAttempt(db, { attemptId: a.id, outcome: 'failed', failureReason: 'declined' });

    // Same answer twice — a gateway retry. Not an error.
    const replay = await settleAttempt(db, { attemptId: a.id, outcome: 'failed' });
    expect(replay.outcome).toBe('failed');

    await expect(
      settleAttempt(db, { attemptId: a.id, outcome: 'abandoned' })
    ).rejects.toMatchObject({ code: 'attempt_settled' });

    await closeIntent(db, intent.id, 'failed', 'Payer gave up after one decline.');
    const [closed] = await db.select().from(r.paymentIntents).where(eq(r.paymentIntents.id, intent.id));
    expect(closed.status).toBe('failed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Reconciliation
// ═══════════════════════════════════════════════════════════════════════════

describe('a run compares two independent accounts of the same money', () => {
  // Every scenario below runs against its OWN gateway name.
  //
  // Deleting rows between tests would work and would be worse: the payments an
  // earlier scenario left behind are exactly the sort of thing a real
  // reconciliation must ignore — MMAKF takes money through more than one
  // gateway and a run for one of them must not classify the other's records as
  // missing. A suite that tidies the residue away stops exercising that.

  it('classifies a clean pair as matched and raises nothing', async () => {
    const { payment } = await makeOrder({
      orderNo: 'MMAKF-ORD-2026-000201', totalPaise: 120_000, provider: 'gw_clean',
      providerPaymentId: 'pay_clean', capturedAt: MID,
    });
    await importGatewayTransactions(db, ctx, {
      gateway: 'gw_clean', source: 'gw_clean settlement report 2026-03',
      rows: [{
        gateway: 'gw_clean', gatewayTxnId: 'txn_clean', kind: 'payment',
        gatewayPaymentId: 'pay_clean', merchantRef: 'MMAKF-ORD-2026-000201',
        amountMinor: 120_000, currency: 'INR', occurredAt: MID, settledAt: new Date(MID.getTime() + DAY),
      }],
    });

    const run = await runReconciliation(db, ctx, {
      gateway: 'gw_clean', periodStart: T0, periodEnd: T1,
    });
    expect(run.status).toBe('completed');
    expect(run.matchedCount).toBe(1);
    expect(run.exceptionCount).toBe(0);
    expect(run.varianceMinor).toBe(0);

    const items = await db.select().from(r.reconciliationItems).where(eq(r.reconciliationItems.runId, run.id));
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('matched');
    expect(items[0].paymentId).toBe(payment.id);
    // A matched item raises nothing. Only exceptions become work.
    expect(items[0].taskId).toBeNull();
  });

  it('finds money the gateway took that MMAKF has no record of — and raises it', async () => {
    // The worst of the nine. Somebody was charged for something the federation
    // does not know it sold.
    await importGatewayTransactions(db, ctx, {
      gateway: 'gw_ghost', source: 'gw_ghost settlement report 2026-03',
      rows: [{
        gateway: 'gw_ghost', gatewayTxnId: 'txn_ghost', kind: 'payment',
        gatewayPaymentId: 'pay_ghost', merchantRef: 'MMAKF-ORD-2026-999999',
        amountMinor: 500_000, currency: 'INR', occurredAt: MID,
      }],
    });

    const run = await runReconciliation(db, ctx, { gateway: 'gw_ghost', periodStart: T0, periodEnd: T1 });
    expect(run.exceptionCount).toBe(1);
    expect(run.varianceMinor).toBe(500_000);

    const [item] = await db.select().from(r.reconciliationItems).where(eq(r.reconciliationItems.runId, run.id));
    expect(item.status).toBe('missing_in_mmakf');
    expect(item.taskId).not.toBeNull();

    const [task] = await db.select().from(o.tasks).where(eq(o.tasks.id, item.taskId));
    expect(task.assignedRole).toBe('FINANCE_OFFICER');
    expect(task.status).toBe('open');
    // Urgent, not "high": a real person's money is somewhere it should not be.
    expect(task.priority).toBe('urgent');
    expect(task.detail).toContain('₹5,000.00');
  });

  it('PROOF: running it again adopts the same task instead of raising a second', async () => {
    // The property that makes a nightly run survivable. Without it, a
    // difference nobody has got to yet grows a copy every night until the queue
    // is unusable and finance stops opening it — which is the same outcome as
    // never having raised it at all.
    await importGatewayTransactions(db, ctx, {
      gateway: 'gw_repeat', source: 'gw_repeat settlement report 2026-03',
      rows: [{
        gateway: 'gw_repeat', gatewayTxnId: 'txn_repeat', kind: 'payment',
        gatewayPaymentId: 'pay_repeat', merchantRef: 'MMAKF-ORD-2026-888888',
        amountMinor: 33_300, currency: 'INR', occurredAt: MID,
      }],
    });

    const first = await runReconciliation(db, ctx, { gateway: 'gw_repeat', periodStart: T0, periodEnd: T1 });
    const second = await runReconciliation(db, ctx, { gateway: 'gw_repeat', periodStart: T0, periodEnd: T1 });
    expect(second.id).not.toBe(first.id);

    const items = await db.select().from(r.reconciliationItems)
      .where(inArray(r.reconciliationItems.runId, [first.id, second.id]));
    expect(items).toHaveLength(2);                               // two observations, both kept
    expect(new Set(items.map((x: any) => x.taskId)).size).toBe(1);   // ONE alert

    const tasks = await db.select().from(o.tasks)
      .where(eq(o.tasks.idempotencyKey, 'recon:gw_repeat:missing_in_mmakf:txn_repeat'));
    expect(tasks).toHaveLength(1);
  });

  it('re-importing the same statement changes nothing', async () => {
    const rows = [{
      gateway: 'gw_idem', gatewayTxnId: 'txn_idem', kind: 'payment' as const,
      gatewayPaymentId: 'pay_idem', merchantRef: 'MMAKF-ORD-2026-777777',
      amountMinor: 10_000, currency: 'INR', occurredAt: MID,
    }];
    const a = await importGatewayTransactions(db, ctx, { gateway: 'gw_idem', source: 'report A', rows });
    const b = await importGatewayTransactions(db, ctx, { gateway: 'gw_idem', source: 'report A (resent)', rows });
    expect(a).toEqual({ imported: 1, alreadyPresent: 0 });
    expect(b).toEqual({ imported: 0, alreadyPresent: 1 });

    // The FIRST source stands. A re-import must not rewrite the evidence.
    const [stored] = await db.select().from(r.gatewayTransactions)
      .where(eq(r.gatewayTransactions.gatewayTxnId, 'txn_idem'));
    expect(stored.source).toBe('report A');
  });

  it('refuses an import that will not say where the figures came from', async () => {
    await expect(importGatewayTransactions(db, ctx, {
      gateway: 'gw_idem', source: '   ', rows: [],
    })).rejects.toMatchObject({ code: 'no_source' });
  });

  it('separates a currency mismatch from an amount mismatch', async () => {
    // Kept apart because once the currencies differ the amounts are not
    // comparable at all, and a variance computed across them would be
    // arithmetic on two different units wearing one column name.
    await makeOrder({
      orderNo: 'MMAKF-ORD-2026-000202', totalPaise: 90_000, currency: 'USD', provider: 'gw_mismatch',
      providerPaymentId: 'pay_usd', capturedAt: MID,
    });
    await makeOrder({
      orderNo: 'MMAKF-ORD-2026-000203', totalPaise: 60_000, provider: 'gw_mismatch',
      providerPaymentId: 'pay_short', capturedAt: MID,
    });
    await importGatewayTransactions(db, ctx, {
      gateway: 'gw_mismatch', source: 'gw_mismatch settlement report 2026-03',
      rows: [
        {
          gateway: 'gw_mismatch', gatewayTxnId: 'txn_usd', kind: 'payment',
          gatewayPaymentId: 'pay_usd', merchantRef: 'MMAKF-ORD-2026-000202',
          amountMinor: 90_000, currency: 'INR', occurredAt: MID,
        },
        {
          gateway: 'gw_mismatch', gatewayTxnId: 'txn_short', kind: 'payment',
          gatewayPaymentId: 'pay_short', merchantRef: 'MMAKF-ORD-2026-000203',
          amountMinor: 59_000, currency: 'INR', occurredAt: MID,
        },
      ],
    });

    const run = await runReconciliation(db, ctx, { gateway: 'gw_mismatch', periodStart: T0, periodEnd: T1 });
    const items = await db.select().from(r.reconciliationItems).where(eq(r.reconciliationItems.runId, run.id));
    const byStatus = Object.fromEntries(items.map((x: any) => [x.status, x]));

    expect(byStatus.currency_mismatch.gatewayCurrency).toBe('INR');
    expect(byStatus.currency_mismatch.mmakfCurrency).toBe('USD');
    expect(byStatus.amount_mismatch.varianceMinor).toBe(-1_000);
    expect(byStatus.amount_mismatch.detail).toContain('-₹10.00');
  });

  it('catches a customer charged twice for one purchase', async () => {
    await makeOrder({
      orderNo: 'MMAKF-ORD-2026-000204', totalPaise: 45_000, provider: 'gw_dup',
      providerPaymentId: 'pay_dup1', capturedAt: MID,
    });
    await importGatewayTransactions(db, ctx, {
      gateway: 'gw_dup', source: 'gw_dup settlement report 2026-03',
      rows: [
        {
          gateway: 'gw_dup', gatewayTxnId: 'txn_dup1', kind: 'payment',
          gatewayPaymentId: 'pay_dup1', merchantRef: 'MMAKF-ORD-2026-000204',
          amountMinor: 45_000, currency: 'INR', occurredAt: MID,
        },
        {
          gateway: 'gw_dup', gatewayTxnId: 'txn_dup2', kind: 'payment',
          gatewayPaymentId: 'pay_dup2', merchantRef: 'MMAKF-ORD-2026-000204',
          amountMinor: 45_000, currency: 'INR', occurredAt: new Date(MID.getTime() + 60_000),
        },
      ],
    });

    const run = await runReconciliation(db, ctx, { gateway: 'gw_dup', periodStart: T0, periodEnd: T1 });
    const items = await db.select().from(r.reconciliationItems).where(eq(r.reconciliationItems.runId, run.id));
    const dup = items.find((x: any) => x.status === 'duplicate');
    expect(dup).toBeTruthy();
    expect(dup.detail).toContain('charged twice');
    // The first charge still reconciles normally; only the extra is an exception.
    expect(items.filter((x: any) => x.status === 'matched')).toHaveLength(1);
  });

  it('reports a capture the gateway statement does not carry', async () => {
    await makeOrder({
      orderNo: 'MMAKF-ORD-2026-000205', totalPaise: 15_000, provider: 'gw_orphan',
      providerPaymentId: 'pay_orphan', capturedAt: MID,
    });
    const run = await runReconciliation(db, ctx, { gateway: 'gw_orphan', periodStart: T0, periodEnd: T1 });
    const [item] = await db.select().from(r.reconciliationItems).where(eq(r.reconciliationItems.runId, run.id));
    expect(item.status).toBe('missing_at_gateway');
    expect(run.varianceMinor).toBe(-15_000);
  });

  it('INVENTS NO SETTLEMENT DEADLINE, and says so on the run', async () => {
    // MMAKF has published no settlement expectation. A default of "T+2" here
    // would be this codebase deciding a commercial term and then raising alerts
    // against it — which is how an exceptions queue fills with noise.
    await makeOrder({
      orderNo: 'MMAKF-ORD-2026-000206', totalPaise: 25_000, provider: 'gw_slow',
      providerPaymentId: 'pay_slow', capturedAt: new Date(T0.getTime() + DAY),
    });
    await importGatewayTransactions(db, ctx, {
      gateway: 'gw_slow', source: 'gw_slow settlement report 2026-03',
      rows: [{
        gateway: 'gw_slow', gatewayTxnId: 'txn_slow', kind: 'payment',
        gatewayPaymentId: 'pay_slow', merchantRef: 'MMAKF-ORD-2026-000206',
        amountMinor: 25_000, currency: 'INR',
        occurredAt: new Date(T0.getTime() + DAY), settledAt: null,
      }],
    });

    const silent = await runReconciliation(db, ctx, {
      gateway: 'gw_slow', periodStart: T0, periodEnd: T1, now: T1,
    });
    expect(silent.unsettledAfterDays).toBeNull();
    expect(silent.matchedCount).toBe(1);
    expect(silent.notes).toContain('Settlement age was NOT checked');

    // Given a period the federation configured, the same row is an exception.
    const checked = await runReconciliation(db, ctx, {
      gateway: 'gw_slow', periodStart: T0, periodEnd: T1, unsettledAfterDays: 5, now: T1,
    });
    const items = await db.select().from(r.reconciliationItems).where(eq(r.reconciliationItems.runId, checked.id));
    expect(items[0].status).toBe('unsettled');
    expect(items[0].detail).toContain('has not arrived');
  });

  it('flags money returned that MMAKF has no refund record for', async () => {
    await importGatewayTransactions(db, ctx, {
      gateway: 'gw_refund', source: 'gw_refund settlement report 2026-03',
      rows: [{
        gateway: 'gw_refund', gatewayTxnId: 'rfnd_unknown', kind: 'refund',
        amountMinor: 30_000, currency: 'INR', occurredAt: MID,
      }],
    });
    const run = await runReconciliation(db, ctx, { gateway: 'gw_refund', periodStart: T0, periodEnd: T1 });
    const [item] = await db.select().from(r.reconciliationItems).where(eq(r.reconciliationItems.runId, run.id));
    expect(item.status).toBe('refunded');
    expect(item.taskId).not.toBeNull();
    // A refund pushes the gateway total the other way.
    expect(run.gatewayTotalMinor).toBe(-30_000);
  });

  it('a chargeback with nobody defending it is its own exception', async () => {
    await importGatewayTransactions(db, ctx, {
      gateway: 'gw_chargeback', source: 'gw_chargeback dispute export 2026-03',
      rows: [{
        gateway: 'gw_chargeback', gatewayTxnId: 'disp_orphan', kind: 'chargeback',
        amountMinor: 80_000, currency: 'INR', occurredAt: MID,
      }],
    });
    const run = await runReconciliation(db, ctx, { gateway: 'gw_chargeback', periodStart: T0, periodEnd: T1 });
    const [item] = await db.select().from(r.reconciliationItems).where(eq(r.reconciliationItems.runId, run.id));
    expect(item.status).toBe('disputed');
    expect(item.detail).toContain('Nobody is defending this');
  });

  it('closing an exception needs an explanation', async () => {
    await importGatewayTransactions(db, ctx, {
      gateway: 'gw_close', source: 'gw_close settlement report 2026-03',
      rows: [{
        gateway: 'gw_close', gatewayTxnId: 'txn_close', kind: 'payment',
        gatewayPaymentId: 'pay_close', merchantRef: 'MMAKF-ORD-2026-666666',
        amountMinor: 12_300, currency: 'INR', occurredAt: MID,
      }],
    });
    const run = await runReconciliation(db, ctx, { gateway: 'gw_close', periodStart: T0, periodEnd: T1 });
    const [item] = await db.select().from(r.reconciliationItems).where(eq(r.reconciliationItems.runId, run.id));

    await expect(resolveException(db, ctx, item.id, '  ')).rejects.toMatchObject({ code: 'no_reason' });

    const open = await openExceptions(db, finance);
    expect(open.map((x: any) => x.id)).toContain(item.id);

    await resolveException(db, ctx, item.id, 'A test transaction on the sandbox key. Not real money.');
    const stillOpen = await openExceptions(db, finance);
    expect(stillOpen.map((x: any) => x.id)).not.toContain(item.id);
  });

  it('refuses a period that ends before it starts, before creating a run', async () => {
    await expect(runReconciliation(db, ctx, {
      gateway: 'gw_none', periodStart: T1, periodEnd: T0,
    })).rejects.toMatchObject({ code: 'bad_period' });
    // Nothing is left sitting at `running`, which every dashboard would read as
    // "still working" for as long as it stayed there.
    const stuck = await db.select().from(r.reconciliationRuns)
      .where(eq(r.reconciliationRuns.status, 'running'));
    expect(stuck).toHaveLength(0);
  });

  it('refuses a reconciliation run to somebody without finance authority', async () => {
    await expect(runReconciliation(db, athleteCtx, {
      gateway: 'gw_clean', periodStart: T0, periodEnd: T1,
    })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(openExceptions(db, athlete)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Disputes — the deadline is the point
// ═══════════════════════════════════════════════════════════════════════════

describe('a chargeback window that passes undefended is money lost', () => {
  it('opens a case with an alert whose deadline IS the evidence deadline', async () => {
    const due = new Date('2026-03-20T00:00:00.000Z');
    const d = await openDispute(db, ctx, {
      gateway: 'razorpay', gatewayDisputeId: 'disp_1',
      amountMinor: 150_000, reason: 'Cardholder does not recognise the transaction.',
      reasonCode: '4837', openedAt: MID, evidenceDueAt: due,
    });
    expect(d.ref).toMatch(/^MMAKF-DSP-2026-\d{6}$/);
    expect(d.status).toBe('evidence_required');

    const [task] = await db.select().from(o.tasks).where(eq(o.tasks.id, d.taskId));
    expect(task.priority).toBe('urgent');
    expect(new Date(task.dueAt).toISOString()).toBe(due.toISOString());
  });

  it('does not open a second case when the gateway redelivers the notice', async () => {
    const again = await openDispute(db, ctx, {
      gateway: 'razorpay', gatewayDisputeId: 'disp_1',
      amountMinor: 150_000, reason: 'Cardholder does not recognise the transaction.',
      openedAt: MID, evidenceDueAt: new Date('2026-03-20T00:00:00.000Z'),
    });
    const all = await db.select().from(r.disputes)
      .where(and(eq(r.disputes.gateway, 'razorpay'), eq(r.disputes.gatewayDisputeId, 'disp_1')));
    expect(all).toHaveLength(1);
    expect(again.id).toBe(all[0].id);
  });

  it('NEVER invents a deadline the gateway did not give', async () => {
    // Card scheme windows differ by scheme, reason code and acquirer. An office
    // that trusted a date the software guessed would file on the wrong day and
    // lose the money believing it was in time.
    const d = await openDispute(db, ctx, {
      gateway: 'razorpay', gatewayDisputeId: 'disp_nodate',
      amountMinor: 20_000, reason: 'Goods not received.', openedAt: MID,
    });
    expect(d.evidenceDueAt).toBeNull();
    expect(d.status).toBe('open');
    const [task] = await db.select().from(o.tasks).where(eq(o.tasks.id, d.taskId));
    expect(task.dueAt).toBeNull();
    expect(task.detail).toContain('no evidence deadline');
  });

  it('counts what is at risk and what is about to lapse', async () => {
    const now = new Date('2026-03-18T00:00:00.000Z');
    const exposure = await disputeExposure(db, finance, now);
    expect(exposure.openCount).toBeGreaterThanOrEqual(2);
    expect(exposure.atRiskMinor.INR).toBeGreaterThanOrEqual(170_000);
    // disp_1 is due on the 20th, which is inside 72 hours of the 18th.
    expect(exposure.dueWithin72h).toBeGreaterThanOrEqual(1);

    const soon = await disputesDueWithin(db, finance, 72, now);
    expect(soon.map((x: any) => x.gatewayDisputeId)).toContain('disp_1');
  });

  it('appends evidence rather than replacing it, and stops the clock', async () => {
    const [d] = await db.select().from(r.disputes).where(eq(r.disputes.gatewayDisputeId, 'disp_1'));
    await submitEvidence(db, ctx, d.id, [
      { label: 'Order and receipt', reference: 'invoice:MMAKF/2026/00012' },
    ]);
    const after = await submitEvidence(db, ctx, d.id, [
      { label: 'Delivery confirmation', reference: 'storage:proof/delivery-1.pdf' },
    ]);
    expect(after.status).toBe('evidence_submitted');
    expect(after.evidence).toHaveLength(2);
    expect(after.evidence[0].label).toBe('Order and receipt');

    const won = await resolveDispute(db, ctx, {
      disputeId: d.id, status: 'won',
      resolution: 'Scheme found in MMAKF\'s favour on the delivery evidence.',
      gatewayFeeMinor: 50_000,
    });
    expect(won.outcomeAmountMinor).toBe(150_000);
    // Won, and the gateway's handling fee is still charged. A win is not free.
    expect(won.gatewayFeeMinor).toBe(50_000);

    await expect(submitEvidence(db, ctx, d.id, [{ label: 'Late', reference: 'x' }]))
      .rejects.toMatchObject({ code: 'dispute_closed' });
  });

  it('PROOF: a lapsed window is recorded as a loss, not tidied away', async () => {
    const due = new Date('2026-03-10T00:00:00.000Z');
    const d = await openDispute(db, ctx, {
      gateway: 'razorpay', gatewayDisputeId: 'disp_lapsed',
      amountMinor: 99_900, reason: 'Duplicate processing claimed.',
      openedAt: new Date('2026-03-02T00:00:00.000Z'), evidenceDueAt: due,
    });

    const now = new Date('2026-03-25T00:00:00.000Z');
    const overdue = await undefendedDisputes(db, finance, now);
    expect(overdue.map((x: any) => x.id)).toContain(d.id);

    const lapsed = await lapseUndefendedDisputes(db, ctx, now);
    expect(lapsed).toBeGreaterThanOrEqual(1);

    const [after] = await db.select().from(r.disputes).where(eq(r.disputes.id, d.id));
    expect(after.status).toBe('expired');
    expect(after.outcomeAmountMinor).toBe(0);
    expect(after.resolution).toContain('succeeds by default');

    // And the loss is countable, which is the whole reason the column exists.
    const exposure = await disputeExposure(db, finance, now);
    expect(exposure.lostMinor.INR).toBeGreaterThanOrEqual(99_900);

    // `expired` on a dispute is a FAILURE, not a neutral timeout.
    expect(statusOf('expired', 'dispute').tone).toBe('bad');
    expect(statusOf('expired').tone).toBe('neutral');
  });

  it('refuses to record MMAKF keeping more than was claimed', async () => {
    const d = await openDispute(db, ctx, {
      gateway: 'razorpay', gatewayDisputeId: 'disp_over',
      amountMinor: 10_000, reason: 'Service not as described.', openedAt: MID,
    });
    await expect(resolveDispute(db, ctx, {
      disputeId: d.id, status: 'won', resolution: 'Won.', outcomeAmountMinor: 20_000,
    })).rejects.toMatchObject({ code: 'bad_amount' });
  });

  it('requires authority and a reason throughout', async () => {
    await expect(openDispute(db, athleteCtx, {
      gateway: 'razorpay', amountMinor: 100, reason: 'x', openedAt: MID,
    })).rejects.toBeInstanceOf(ForbiddenError);

    await expect(openDispute(db, ctx, {
      gateway: 'razorpay', amountMinor: 100, reason: '   ', openedAt: MID,
    })).rejects.toMatchObject({ code: 'no_reason' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Routing, health and "not configured"
// ═══════════════════════════════════════════════════════════════════════════

describe('routing prefers a gateway and never promises one', () => {
  beforeEach(async () => {
    await db.delete(r.paymentRoutingRules);
    await db.delete(r.gatewayHealth);
    delete process.env.MMAKF_UPI_ID;
    delete process.env.RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });

  it('SHIPS HONEST: with no credentials, it says so instead of naming a gateway', async () => {
    // MMAKF's state today. This must read as a configuration fact, not an
    // error — a surface that renders it red is telling the office something is
    // broken when nothing is.
    await upsertRoutingRule(db, ctx, {
      code: 'inr.default', label: 'Everything in rupees', gateway: 'razorpay',
    });
    const decision = await chooseGateway(db, { currency: 'INR', amountMinor: 100_000 });
    expect(decision.gateway).toBeNull();
    expect(decision.reason).toContain('unconfigured');
    expect(decision.considered[0].usable).toBe(false);
    expect(decision.considered[0].note).toContain('not a fault');

    const standing = await gatewayStanding(db, 'razorpay');
    expect(standing.configured).toBe(false);
    expect(standing.usable).toBe(false);
    expect(statusOf('not_configured').tone).toBe('neutral');
  });

  it('says plainly when there are no rules at all', async () => {
    const decision = await chooseGateway(db, { currency: 'INR', amountMinor: 1_000 });
    expect(decision.gateway).toBeNull();
    expect(decision.reason).toContain('No payment routing rules are configured');
  });

  it('routes by priority, currency and amount band, with a total order', async () => {
    process.env.MMAKF_UPI_ID = 'mmakf@examplebank';
    await upsertRoutingRule(db, ctx, {
      code: 'inr.small', label: 'Small rupee payments', priority: 10,
      currency: 'INR', maxAmountMinor: 100_000, gateway: 'manual_upi',
    });
    await upsertRoutingRule(db, ctx, {
      code: 'inr.any', label: 'Everything else in rupees', priority: 90,
      currency: 'INR', gateway: 'manual_upi',
    });

    const small = await chooseGateway(db, { currency: 'INR', amountMinor: 99_999 });
    expect(small.ruleCode).toBe('inr.small');
    // Upper bound EXCLUSIVE, so adjacent bands cannot both claim one amount.
    const atBoundary = await chooseGateway(db, { currency: 'INR', amountMinor: 100_000 });
    expect(atBoundary.ruleCode).toBe('inr.any');
    // Same inputs, same answer — twice.
    const repeat = await chooseGateway(db, { currency: 'INR', amountMinor: 99_999 });
    expect(repeat.ruleCode).toBe(small.ruleCode);

    const usd = await chooseGateway(db, { currency: 'USD', amountMinor: 5_000 });
    expect(usd.gateway).toBeNull();
    expect(usd.reason).toContain('No routing rule matches');
  });

  it('fails over to the fallback when the preferred gateway is observed down', async () => {
    process.env.MMAKF_UPI_ID = 'mmakf@examplebank';
    await upsertRoutingRule(db, ctx, {
      code: 'inr.primary', label: 'Prefer the card gateway',
      currency: 'INR', gateway: 'razorpay', fallbackGateway: 'manual_upi', requireHealthy: true,
    });

    // Razorpay is unconfigured here, so it is not a candidate at all — which is
    // the point: health only ever REMOVES a gateway, it never promotes one.
    const decision = await chooseGateway(db, { currency: 'INR', amountMinor: 200_000 });
    expect(decision.gateway).toBe('manual_upi');
    expect(decision.reason).toContain('fallback');

    // And with credentials present but three failed probes, the same thing
    // happens for a different, recorded reason.
    process.env.RAZORPAY_KEY_ID = 'rzp_test_example';
    process.env.RAZORPAY_KEY_SECRET = 'secret-not-real';
    // The webhook secret is a credential too, and this codebase treats it as
    // load-bearing: without one, Razorpay could take money that nothing could
    // ever confirm, so it withholds itself from selection entirely — see
    // tests/payment-mode.test.ts, 'is not configured when nothing could ever
    // confirm a payment'. "Credentials present" therefore means all three, and
    // this test needs the gateway genuinely usable in order to prove that it is
    // HEALTH, and health alone, that removes it below.
    process.env.RAZORPAY_WEBHOOK_SECRET = 'whsec-not-real';
    for (let i = 0; i < 3; i++) {
      await recordGatewayProbe(db, { gateway: 'razorpay', ok: false, error: 'connect ETIMEDOUT' });
    }
    const health = await gatewayStanding(db, 'razorpay');
    expect(health.configured).toBe(true);
    expect(health.health).toBe('down');
    expect(health.usable).toBe(false);

    const failedOver = await chooseGateway(db, { currency: 'INR', amountMinor: 200_000 });
    expect(failedOver.gateway).toBe('manual_upi');
    expect(failedOver.considered[0].note).toContain('observed down');

    // One success clears it.
    await recordGatewayProbe(db, { gateway: 'razorpay', ok: true });
    const recovered = await gatewayStanding(db, 'razorpay');
    expect(recovered.health).toBe('healthy');
    const back = await chooseGateway(db, { currency: 'INR', amountMinor: 200_000 });
    expect(back.gateway).toBe('razorpay');
  });

  it('never stores a credential in the health record', async () => {
    await recordGatewayProbe(db, { gateway: 'razorpay', ok: false, error: 'HTTP 401 from the gateway' });
    const [row] = await db.select().from(r.gatewayHealth).where(eq(r.gatewayHealth.gateway, 'razorpay'));
    expect(row.lastError).not.toMatch(/rzp_(test|live)_/);
    expect(row.lastError).not.toContain('secret');
  });

  it('refuses a band that is not a range', async () => {
    await expect(upsertRoutingRule(db, ctx, {
      code: 'bad.band', label: 'Nonsense', gateway: 'razorpay',
      minAmountMinor: 500, maxAmountMinor: 500,
    })).rejects.toMatchObject({ code: 'bad_band' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Gateway cost — configuration, never a price
// ═══════════════════════════════════════════════════════════════════════════

describe('what the gateway takes is a cost, not a price', () => {
  it('SHIPS EMPTY: with no rate configured the estimate is null, not a guess', async () => {
    const none = await estimateGatewayCost(db, {
      gateway: 'razorpay', currency: 'INR', amountMinor: 100_000, asAt: '2026-03-15',
    });
    expect(none).toBeNull();
    expect(surchargeMinor(none)).toBe(0);
  });

  it('hard-codes no rate: a figure exists because somebody entered it with a source', async () => {
    await expect(upsertCostRate(db, ctx, {
      gateway: 'razorpay', percentagePpm: 20_000, source: '  ', effectiveFrom: '2026-01-01',
    })).rejects.toMatchObject({ code: 'no_source' });

    await upsertCostRate(db, ctx, {
      gateway: 'razorpay', percentagePpm: 20_000, taxPpm: 180_000, fixedMinor: 0,
      source: 'Razorpay schedule attached to the merchant agreement, 12 Jan 2026',
      effectiveFrom: '2026-01-01',
    });

    // 2% of ₹1,000.00, plus 18% tax on the fee. Through applyFactor(), which is
    // the only place in this codebase a factor multiplies money.
    const est = await estimateGatewayCost(db, {
      gateway: 'razorpay', currency: 'INR', amountMinor: 100_000, asAt: '2026-03-15',
    });
    expect(est!.feeMinor).toBe(2_000);
    expect(est!.taxMinor).toBe(360);
    expect(est!.totalMinor).toBe(2_360);
    expect(est!.source).toContain('merchant agreement');
  });

  it('PROOF: the cost is never added to the customer\'s price by default', async () => {
    const est = await estimateGatewayCost(db, {
      gateway: 'razorpay', currency: 'INR', amountMinor: 100_000, asAt: '2026-03-15',
    });
    expect(est!.passToCustomer).toBe(false);
    expect(surchargeMinor(est)).toBe(0);
  });

  it('will not turn a surcharge on without the policy that approved it', async () => {
    await expect(upsertCostRate(db, ctx, {
      gateway: 'manual_upi', percentagePpm: 10_000,
      source: 'Bank schedule', effectiveFrom: '2026-01-01', passToCustomer: true,
    })).rejects.toMatchObject({ code: 'no_policy' });

    const rate = await upsertCostRate(db, ctx, {
      gateway: 'manual_upi', percentagePpm: 10_000,
      source: 'Bank schedule', effectiveFrom: '2026-01-01',
      passToCustomer: true, approvedPolicyRef: 'EC-2026-04 resolution 7',
    });
    expect(rate.approvedPolicyRef).toBe('EC-2026-04 resolution 7');

    const est = await estimateGatewayCost(db, {
      gateway: 'manual_upi', currency: 'INR', amountMinor: 100_000, asAt: '2026-03-15',
    });
    expect(surchargeMinor(est)).toBe(est!.totalMinor);
  });

  it('requires finance authority to set a rate', async () => {
    await expect(upsertCostRate(db, athleteCtx, {
      gateway: 'razorpay', source: 'x', effectiveFrom: '2026-01-01',
    })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. The vocabulary renders
// ═══════════════════════════════════════════════════════════════════════════

describe('every classification is a status a reader can interpret', () => {
  it('the dictionary knows all nine, and eight of them ask for action', () => {
    const known = new Set(knownStatuses());
    for (const value of RECONCILIATION_STATUSES) {
      expect(known.has(value), `${value} is not in the status dictionary`).toBe(true);
      expect(statusOf(value).tone).toBeTruthy();
    }
    // `matched` is the only one nobody has to do anything about.
    expect(needsAction('matched')).toBe(false);
    for (const value of RECONCILIATION_STATUSES.filter((v) => v !== 'matched')) {
      // `refunded` and `disputed` carry domain sentences; the base entries are
      // what a bare chip renders, and every exception must ask for attention
      // somewhere. Checked through the reconciliation domain, which is how the
      // surfaces read them.
      expect(isException(value)).toBe(true);
    }
  });

  it('does not paint "the federation is short" the same colour as "not settled yet"', () => {
    expect(statusOf('missing_in_mmakf').tone).toBe('bad');
    // Through the reconciliation domain: the bare entry describes a statement
    // imported twice, which is a nuisance. Here it means two charges against
    // one purchase, and somebody is out of pocket until it is refunded.
    expect(statusOf('duplicate', 'reconciliation').tone).toBe('bad');
    expect(statusOf('unsettled').tone).toBe('waiting');
    expect(statusOf('matched').tone).toBe('good');
  });

  it('errors are identified by shape, not instanceof', async () => {
    try {
      await openIntent(db, { orderId: 999_999, amountMinor: 1 });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(isReconciliationError(err)).toBe(true);
      expect((err as any).code).toBe('unknown_order');
    }
  });
});
