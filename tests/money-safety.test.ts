// The four money-safety properties, and the places they do not hold.
//
// Every other suite in this repository tests a feature. This one tests the four
// things that, if any of them is false, mean the federation cannot stand behind
// its own accounts:
//
//   1. A HISTORICAL TRANSACTION IS FROZEN.  Publishing a 2027 fee must not move
//      one paisa of a 2026 record.
//   2. A CLIENT AMOUNT IS NEVER TRUSTED.    The browser says ₹1; the server
//      resolved ₹10,000; nothing is fulfilled.
//   3. A WEBHOOK DELIVERED TWICE PAYS ONCE. One payment, one receipt, one set
//      of ledger postings.
//   4. A REFUND CANNOT EXCEED WHAT WAS TAKEN — including two of them at once.
//
// ─────────────────────────────────────────────────────────────────────────────
// ON THE `it.fails` MARKERS BELOW
// ─────────────────────────────────────────────────────────────────────────────
//
// A money test that passes because the behaviour it describes is ABSENT is
// worse than no test at all: it converts a gap into a green tick. Where a
// property genuinely does not hold in this codebase, the assertion here is
// written as the property SHOULD be, and marked `it.fails` — which asserts that
// it currently does not pass. The suite stays honest either way:
//
//   · while the defect exists, the marker documents it in executable form;
//   · the moment somebody fixes it, THIS FILE GOES RED and the marker must be
//     removed, so a fix cannot land unnoticed.
//
// Each marker carries the finding it stands for. There are four. They are
// listed again at the foot of this file.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from '../src/db/schema';
import {
  createFramework, addRule, publishFramework, issueQuote, approveQuoteVersion,
  computeFee, reproduce, activeFramework, applyFactor, PPM,
} from '../src/db/fees';
import {
  createOrder, beginPayment, confirmPayment, recordWebhook, markWebhookProcessed,
  requestRefund, orderByNumber,
} from '../src/db/orders';
import { razorpay } from '../src/lib/payments/razorpay';
import { upiDeepLink } from '../src/lib/payments/manual-upi';
import type { Principal } from '../src/lib/rbac';
import type { VerifiedPayment } from '../src/lib/payments';

let db: any;

// ─── Principals ─────────────────────────────────────────────────────────────
//
// Four separate authorities, because the separation is load-bearing: whoever
// authors a fee cannot issue a quotation from it, whoever issues one cannot
// approve it, and none of them is the account that records the money.

const finance: Principal = {
  userId: 1, label: 'finance',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const ops: Principal = {
  userId: 3, label: 'ops',
  bindings: [{ role: 'TRAINING_OPERATIONS', scopeType: 'national', scopeId: null }],
};
const director: Principal = {
  userId: 4, label: 'director',
  bindings: [{ role: 'TRAINING_DIRECTOR', scopeType: 'national', scopeId: null }],
};

const financeCtx = { principal: finance };
const opsCtx = { principal: ops };
const directorCtx = { principal: director };

// ─── Test fixtures, NOT MMAKF fees ──────────────────────────────────────────
//
// §68: MMAKF has published no fee rules, and this file does not invent any. The
// figures below exist so that the FREEZE can be observed — ₹10,000 becoming
// ₹12,000 is the event under test, not a price the federation charges. They are
// never read by any surface; they live and die inside this PGlite instance.

const TEN_THOUSAND = 1_000_000;      // paise
const TWELVE_THOUSAND = 1_200_000;   // paise

const QUOTE_INPUTS = { audience: 'school', mode: 'on_site', participants: 40 };

/** A verified provider record, built from what the provider would send. */
const captured = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
  providerOrderId: '',
  amountPaise: 0,
  currency: 'INR',
  status: 'captured',
  method: 'upi',
  ...over,
});

/** An order priced ENTIRELY on the server, from a published fee code. */
async function serverPricedOrder(feeCode: string, claimedPaise?: number) {
  return createOrder(db, null, {
    email: 'school@example.in',
    lines: [{
      kind: 'course',
      description: 'School programme',
      feeCode,
      // Deliberately supplied. The server must ignore it.
      ...(claimedPaise != null ? { unitPricePaise: claimedPaise } : {}),
    }],
  });
}

async function payInFull(order: any, over: Partial<VerifiedPayment> = {}) {
  const payment = await beginPayment(db, order.id, {
    provider: 'razorpay',
    providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
    amountPaise: order.totalPaise,
    idempotencyKey: crypto.randomUUID(),
  });
  const result = await confirmPayment(db, null, captured({
    providerOrderId: payment.providerOrderId,
    amountPaise: order.totalPaise,
    ...over,
  }));
  return { payment, result };
}

/** Byte-level identity, so a changed timestamp or a re-ordered key is caught. */
const bytes = (v: unknown) => JSON.stringify(v);

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  // published_by_user_id, created_by_user_id and approved_by_user_id are real
  // foreign keys, so the accounts have to exist.
  await db.insert(s.users).values([
    { id: 1, email: 'finance@mmakf.in', status: 'active' },
    { id: 3, email: 'ops@mmakf.in', status: 'active' },
    { id: 4, email: 'director@mmakf.in', status: 'active' },
  ]);

  await db.insert(s.services).values({
    code: 'MMAKF-SVC-SCHOOL-KARATE', slug: 'school-karate',
    title: 'School karate programme', category: 'training', status: 'published',
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 1 — HISTORICAL FREEZE
// ═══════════════════════════════════════════════════════════════════════════
//
// The single most important property in the system. A school that accepted a
// quotation at ₹10,000 in 2026 must, in 2027 and in 2036, still find that
// quotation saying ₹10,000 — its total, its lines, and the receipt issued
// against it — no matter what the federation has published since.

describe('TEST 1 — a published fee is frozen, and a later one cannot reach back', () => {
  let FW2026: number;
  let FW2027: number;
  let quoteVersionId: number;
  let quoteId: number;
  let orderId: number;
  let invoiceId: number;

  /** Everything the 2026 transaction consists of, captured as bytes. */
  const before: Record<string, string> = {};

  async function snapshot(): Promise<Record<string, string>> {
    const [qv] = await db.select().from(s.quoteVersions).where(eq(s.quoteVersions.id, quoteVersionId));
    const lines = await db.select().from(s.quoteLines)
      .where(eq(s.quoteLines.quoteVersionId, quoteVersionId))
      .orderBy(s.quoteLines.sortOrder);
    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
    const [order] = await db.select().from(s.orders).where(eq(s.orders.id, orderId));
    const orderLines = await db.select().from(s.orderLines)
      .where(eq(s.orderLines.orderId, orderId)).orderBy(s.orderLines.id);
    const payments = await db.select().from(s.payments)
      .where(eq(s.payments.orderId, orderId)).orderBy(s.payments.id);
    const ledger = await db.select().from(s.ledgerEntries)
      .where(eq(s.ledgerEntries.orderId, orderId)).orderBy(s.ledgerEntries.id);
    // The rules of the framework it was computed from, too — a quotation is
    // only reproducible if the rules behind it are also unchanged.
    const rules = await db.select().from(s.feeRules)
      .where(eq(s.feeRules.frameworkId, FW2026)).orderBy(s.feeRules.id);

    return {
      quoteVersion: bytes(qv),
      quoteLines: bytes(lines),
      invoice: bytes(invoice),
      order: bytes(order),
      orderLines: bytes(orderLines),
      payments: bytes(payments),
      ledger: bytes(ledger),
      rules: bytes(rules),
    };
  }

  beforeAll(async () => {
    // ── 2026: author, publish, quote, approve, invoice, pay ──
    const fw = await createFramework(db, financeCtx, {
      title: 'Fee framework 2026', version: 1, effectiveFrom: '2026-01-01',
    });
    FW2026 = fw.id;
    await addRule(db, financeCtx, FW2026, {
      code: 'SCHOOL-TERM', label: 'School programme, one term', kind: 'base',
      audience: 'school', amountMinor: TEN_THOUSAND, sortOrder: 10,
      // Held for a second pair of eyes, so the APPROVAL path is exercised
      // rather than assumed.
      requiresApproval: true,
    });
    await publishFramework(db, financeCtx, FW2026);

    const issued = await issueQuote(db, opsCtx, {
      institutionId: null, frameworkId: FW2026, inputs: QUOTE_INPUTS,
      validUntil: '2026-12-31',
    });
    quoteId = issued.quoteId;
    expect(issued.computation.totalMinor).toBe(TEN_THOUSAND);

    const [qv] = await db.select().from(s.quoteVersions)
      .where(eq(s.quoteVersions.quoteId, quoteId));
    quoteVersionId = qv.id;
    expect(qv.status).toBe('awaiting_approval');

    // Approved by somebody who is not the issuer.
    await approveQuoteVersion(db, directorCtx, quoteVersionId, { note: 'Board minute 2026/14' });

    // ── The invoice and the payment ──
    //
    // NOTE, and this is a FINDING recorded at the foot of this file: there is
    // no function anywhere in src/ that turns an accepted quotation into an
    // order. The engagement side (quotes) and the commerce side (orders,
    // invoices, ledger) are not connected. The bridge is built by hand here,
    // through the fee schedule, which is the only server-side pricing path
    // createOrder() will accept.
    await db.insert(s.feeSchedule).values({
      code: 'course.school.term.2026', label: 'School programme, one term (2026)',
      kind: 'course', amountPaise: TEN_THOUSAND, effectiveFrom: '2026-01-01', active: true,
    });

    const order = await serverPricedOrder('course.school.term.2026');
    orderId = order.id;
    expect(order.totalPaise).toBe(TEN_THOUSAND);

    await payInFull(order);
    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.orderId, orderId));
    invoiceId = invoice.id;

    Object.assign(before, await snapshot());

    // ── 2027: a NEW framework at ₹12,000, published ──
    const fw2 = await createFramework(db, financeCtx, {
      title: 'Fee framework 2027', version: 2, effectiveFrom: '2027-01-01',
    });
    FW2027 = fw2.id;
    await addRule(db, financeCtx, FW2027, {
      code: 'SCHOOL-TERM', label: 'School programme, one term', kind: 'base',
      audience: 'school', amountMinor: TWELVE_THOUSAND, sortOrder: 10,
    });
    await publishFramework(db, financeCtx, FW2027);
  });

  it('leaves the 2026 quotation BYTE-IDENTICAL after the 2027 fee is published', async () => {
    const after = await snapshot();
    // Compared key by key so a failure names which record moved.
    for (const key of Object.keys(before)) {
      expect(`${key}: ${after[key]}`).toBe(`${key}: ${before[key]}`);
    }
  });

  it('keeps the quotation total at exactly 10,00,000 paise, in integer paise', async () => {
    const [qv] = await db.select().from(s.quoteVersions).where(eq(s.quoteVersions.id, quoteVersionId));
    expect(qv.totalMinor).toBe(TEN_THOUSAND);
    expect(Number.isInteger(qv.totalMinor)).toBe(true);
    expect(qv.subtotalMinor + qv.adjustmentMinor + qv.taxMinor).toBe(qv.totalMinor);
    expect(qv.frameworkId).toBe(FW2026);
    expect(qv.frameworkCode).toBe('MMAKF-FEE-V1');
  });

  it('still REPRODUCES from its own frozen inputs — the drift alarm is silent', async () => {
    const check = await reproduce(db, quoteVersionId);
    expect(check.matches).toBe(true);
    expect(check.recomputed.totalMinor).toBe(TEN_THOUSAND);
    expect(check.stored.totalMinor).toBe(TEN_THOUSAND);
  });

  it('keeps the receipt saying ₹10,000, snapshot and all', async () => {
    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
    expect(invoice.snapshot.totalPaise).toBe(TEN_THOUSAND);
    expect(invoice.snapshot.lines[0].unitPricePaise).toBe(TEN_THOUSAND);
    expect(invoice.snapshot.currency).toBe('INR');
    // Frozen means frozen: editing the fee schedule the order was priced from
    // must not reach the document either.
    await db.update(s.feeSchedule).set({ amountPaise: TWELVE_THOUSAND })
      .where(eq(s.feeSchedule.code, 'course.school.term.2026'));
    const [again] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
    expect(again.snapshot.totalPaise).toBe(TEN_THOUSAND);
    // Put it back, so no later test in this file inherits an edited fixture.
    await db.update(s.feeSchedule).set({ amountPaise: TEN_THOUSAND })
      .where(eq(s.feeSchedule.code, 'course.school.term.2026'));
  });

  it('prices a NEW quotation at ₹12,000 from the 2027 framework', async () => {
    const fresh = await computeFee(db, FW2027, QUOTE_INPUTS);
    expect(fresh.totalMinor).toBe(TWELVE_THOUSAND);
    expect(fresh.requiresManualQuote).toBe(false);

    const issued = await issueQuote(db, opsCtx, {
      institutionId: null, frameworkId: FW2027, inputs: QUOTE_INPUTS,
    });
    expect(issued.computation.totalMinor).toBe(TWELVE_THOUSAND);
    // A separate quote — the 2026 one keeps its own identity and its own total.
    expect(issued.quoteId).not.toBe(quoteId);
    const [old] = await db.select().from(s.quoteVersions).where(eq(s.quoteVersions.id, quoteVersionId));
    expect(old.totalMinor).toBe(TEN_THOUSAND);
    expect(old.status).toBe('issued');       // not superseded by a different quote
  });

  it('answers "which framework was in force?" by DATE, not by newest', async () => {
    expect((await activeFramework(db, '2026-06-01')).id).toBe(FW2026);
    expect((await activeFramework(db, '2027-06-01')).id).toBe(FW2027);
    // Before either was effective, the honest answer is none.
    expect(await activeFramework(db, '2025-06-01')).toBeNull();
  });

  it('REFUSES to edit a published framework at all — that is the enforcement', async () => {
    await expect(addRule(db, financeCtx, FW2026, {
      code: 'SNEAKY', label: 'Retro-price', kind: 'base',
      audience: 'school', amountMinor: TWELVE_THOUSAND,
    })).rejects.toThrow(/cannot be changed/i);

    await expect(publishFramework(db, financeCtx, FW2026)).rejects.toThrow(/already published/i);

    // And the rule row itself is untouched, which is what the quotation depends on.
    const [rule] = await db.select().from(s.feeRules)
      .where(and(eq(s.feeRules.frameworkId, FW2026), eq(s.feeRules.code, 'SCHOOL-TERM')));
    expect(rule.amountMinor).toBe(TEN_THOUSAND);
  });

  it('cannot re-approve, re-issue or re-price a settled quotation', async () => {
    await expect(approveQuoteVersion(db, directorCtx, quoteVersionId))
      .rejects.toThrow(/not awaiting approval/i);
    const [qv] = await db.select().from(s.quoteVersions).where(eq(s.quoteVersions.id, quoteVersionId));
    expect(qv.totalMinor).toBe(TEN_THOUSAND);
    expect(qv.approvedByUserId).toBe(4);
  });

  // ── FINDING 1 ──────────────────────────────────────────────────────────
  //
  // Immutability is enforced in src/db/fees.ts and NOWHERE ELSE. There is no
  // database trigger, no CHECK constraint and no revoked UPDATE grant behind
  // it. Anything that reaches the connection without going through addRule() —
  // a migration, a psql session, a future module, a SQL injection anywhere in
  // the codebase — can rewrite a published price, and every quotation issued
  // under it silently changes meaning. reproduce() would then start reporting
  // matches:false, which is the only alarm that exists.
  //
  // The test below is written as the property SHOULD be. It fails today.
  it.fails('FINDING 1: the DATABASE refuses to alter a published rule, not only the module', async () => {
    const [rule] = await db.select().from(s.feeRules)
      .where(and(eq(s.feeRules.frameworkId, FW2026), eq(s.feeRules.code, 'SCHOOL-TERM')));

    let refused = false;
    try {
      await db.update(s.feeRules).set({ amountMinor: TWELVE_THOUSAND })
        .where(eq(s.feeRules.id, rule.id));
    } catch {
      refused = true;
    } finally {
      // Whatever happened, restore the fixture — a leaked edit here would make
      // every later assertion in this file meaningless.
      await db.update(s.feeRules).set({ amountMinor: TEN_THOUSAND })
        .where(eq(s.feeRules.id, rule.id));
    }
    expect(refused).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 2 — AMOUNT TAMPERING
// ═══════════════════════════════════════════════════════════════════════════
//
// The browser claims ₹1. The server resolved ₹10,000.
//
// confirmPayment() in src/db/orders.ts DOES compare — the check is at the
// "A captured amount that does not match is never quietly accepted" comment,
// comparing verified.amountPaise against order.totalPaise and verified.currency
// against order.currency, and it THROWS rather than adjusting. beginPayment()
// compares too, one step earlier. Both comparisons are against the server's own
// order row, never against anything the caller sent. That is the property; what
// follows proves it end to end rather than restating it.

describe('TEST 2 — a client-claimed amount buys nothing', () => {
  const ONE_RUPEE = 100;

  beforeAll(async () => {
    await db.insert(s.feeSchedule).values({
      code: 'course.school.term.tamper', label: 'School programme (tamper fixture)',
      kind: 'course', amountPaise: TEN_THOUSAND, effectiveFrom: '2026-01-01', active: true,
    });
  });

  it('prices the order from the SERVER even when the browser sends ₹1', async () => {
    const order = await serverPricedOrder('course.school.term.tamper', ONE_RUPEE);
    // The claimed unit price is discarded outright.
    expect(order.totalPaise).toBe(TEN_THOUSAND);
    expect(order.lines[0].unitPricePaise).toBe(TEN_THOUSAND);
    expect(order.lines[0].unitPricePaise).not.toBe(ONE_RUPEE);
  });

  it('ATTACK: opening a payment for ₹1 against a ₹10,000 order is refused', async () => {
    const order = await serverPricedOrder('course.school.term.tamper', ONE_RUPEE);
    await expect(beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: ONE_RUPEE, idempotencyKey: crypto.randomUUID(),
    })).rejects.toThrow(/does not match the order total/i);

    // No payment row was created at all, so nothing downstream can mistake it
    // for an attempt in progress.
    expect((await db.select().from(s.payments).where(eq(s.payments.orderId, order.id))).length).toBe(0);
  });

  it('ATTACK: a CAPTURED ₹1 against a ₹10,000 order fulfils NOTHING', async () => {
    const order = await serverPricedOrder('course.school.term.tamper');
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });

    // The amount is tampered AFTER the order was opened honestly — the shape a
    // real attack takes, because the gateway page is where the number is
    // changed, not the checkout call.
    await expect(confirmPayment(db, { principal: ops, authority: 'razorpay' }, captured({
      providerOrderId: payment.providerOrderId,
      amountPaise: ONE_RUPEE,
    }))).rejects.toThrow(/does not match the order total/i);

    // Every consequence of fulfilment, absent.
    const after = await orderByNumber(db, order.orderNo);
    expect(after!.status).toBe('awaiting_payment');
    expect(after!.paidAt).toBeNull();
    expect((await db.select().from(s.invoices).where(eq(s.invoices.orderId, order.id))).length).toBe(0);
    expect((await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.orderId, order.id))).length).toBe(0);

    // The attempt is kept as evidence, marked failed, with the numbers in it.
    const [row] = await db.select().from(s.payments).where(eq(s.payments.id, payment.id));
    expect(row.status).toBe('failed');
    expect(row.capturedAt).toBeNull();
    expect(row.failureReason).toMatch(/mismatch/i);
    expect(row.failureReason).toContain(String(ONE_RUPEE));
    expect(row.failureReason).toContain(String(TEN_THOUSAND));

    // And it raised the alert: a human has something to look at.
    const audit = await db.select().from(s.auditEvents)
      .where(and(eq(s.auditEvents.entityType, 'payment'), eq(s.auditEvents.entityId, String(payment.id))));
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0].newValue).toMatchObject({ received: ONE_RUPEE, flagged: true });
  });

  it('NEVER adjusts the order down to meet the amount that arrived', async () => {
    const order = await serverPricedOrder('course.school.term.tamper');
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    await expect(confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: ONE_RUPEE,
    }))).rejects.toThrow();

    const [after] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    expect(after.totalPaise).toBe(TEN_THOUSAND);      // unmoved
    expect(after.subtotalPaise).toBe(TEN_THOUSAND);
    expect(after.discountPaise).toBe(0);
  });

  it('ATTACK: one paisa short is still short, and an overpayment is not accepted either', async () => {
    for (const delta of [-1, +1, +TEN_THOUSAND]) {
      const order = await serverPricedOrder('course.school.term.tamper');
      const payment = await beginPayment(db, order.id, {
        provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
        amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
      });
      await expect(confirmPayment(db, null, captured({
        providerOrderId: payment.providerOrderId,
        amountPaise: order.totalPaise + delta,
      }))).rejects.toThrow(/does not match the order total/i);

      const [after] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
      expect(after.status).toBe('awaiting_payment');
    }
  });

  it('ATTACK: the right number in the wrong currency does not pay either', async () => {
    const order = await serverPricedOrder('course.school.term.tamper');
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    // 10,00,000 of something else is not 10,00,000 paise.
    await expect(confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId,
      amountPaise: order.totalPaise, currency: 'USD',
    }))).rejects.toThrow(/does not match the order total/i);

    const [after] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    expect(after.status).toBe('awaiting_payment');
  });

  it('an AUTHORIZED ₹10,000 is money HELD, not taken — nothing is issued', async () => {
    const order = await serverPricedOrder('course.school.term.tamper');
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId,
      amountPaise: order.totalPaise, status: 'authorized',
    }));

    const [after] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    expect(after.status).toBe('awaiting_payment');
    expect((await db.select().from(s.invoices).where(eq(s.invoices.orderId, order.id))).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 3 — THE SAME WEBHOOK, TWICE
// ═══════════════════════════════════════════════════════════════════════════
//
// Every gateway retries. Razorpay retries a webhook that did not answer 2xx
// within its timeout, and it will happily deliver the same event id four times.
// One payment, one receipt, one set of ledger postings, one notification — or
// the federation has taken one payment and issued two of everything.
//
// Two independent guards are proved separately, because they fail differently:
//   · recordWebhook(), keyed on (provider, event_id) by a UNIQUE INDEX;
//   · confirmPayment(), keyed on the payment's own captured flag — which is
//     what saves the system when the gateway resends with a NEW event id, as
//     it does after a manual replay from the dashboard.

describe('TEST 3 — a webhook delivered twice pays once', () => {
  const WEBHOOK_SECRET = 'money-safety-webhook-secret';
  let order: any;
  let payment: any;
  let rawBody: string;
  let headers: Record<string, string>;

  /** Exactly what src/pages/api/payments/webhook.ts does, minus the HTTP. */
  async function deliver(body: string, hdrs: Record<string, string>) {
    const result = razorpay.verifyWebhook(body, hdrs);
    expect(result.valid).toBe(true);

    const recorded = await recordWebhook(db, {
      provider: 'razorpay',
      eventId: result.eventId,
      eventType: result.eventType,
      signatureValid: true,
      payload: result.raw,
    });
    if (!recorded.fresh) return { fresh: false, confirmed: null };

    const confirmed = result.payment
      ? await confirmPayment(
          db,
          { principal: { userId: null, label: 'webhook:razorpay', bindings: [] }, authority: 'razorpay' },
          result.payment
        )
      : null;
    await markWebhookProcessed(db, recorded.id!);
    return { fresh: true, confirmed };
  }

  beforeAll(async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

    await db.insert(s.feeSchedule).values({
      code: 'course.school.term.webhook', label: 'School programme (webhook fixture)',
      kind: 'course', amountPaise: TEN_THOUSAND, effectiveFrom: '2026-01-01', active: true,
    });

    order = await serverPricedOrder('course.school.term.webhook');
    payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: 'order_WEBHOOKDUP01',
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });

    rawBody = JSON.stringify({
      event: 'payment.captured',
      created_at: 1_770_000_000,
      payload: {
        payment: {
          entity: {
            id: 'pay_WEBHOOKDUP01', order_id: 'order_WEBHOOKDUP01',
            amount: TEN_THOUSAND, currency: 'INR', status: 'captured',
            method: 'upi', fee: 23_600, tax: 3_600,
          },
        },
      },
    });
    headers = {
      'x-razorpay-signature': crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex'),
      'x-razorpay-event-id': 'evt_MONEYSAFETY_DUP',
    };
  });

  it('accepts the first delivery and pays the order', async () => {
    const first = await deliver(rawBody, headers);
    expect(first.fresh).toBe(true);
    expect(first.confirmed!.alreadyProcessed).toBe(false);

    const [after] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    expect(after.status).toBe('paid');
  });

  it('refuses the SECOND delivery of the same event id outright', async () => {
    const second = await deliver(rawBody, headers);
    expect(second.fresh).toBe(false);
    // Refused BEFORE confirmPayment() is reached — the cheapest possible place
    // to stop a replay is before it touches the money.
    expect(second.confirmed).toBeNull();
  });

  it('leaves ONE payment, ONE receipt, ONE set of postings — not two', async () => {
    const events = await db.select().from(s.paymentEvents)
      .where(and(eq(s.paymentEvents.provider, 'razorpay'), eq(s.paymentEvents.eventId, 'evt_MONEYSAFETY_DUP')));
    expect(events.length).toBe(1);
    expect(events[0].processedAt).toBeTruthy();
    expect(events[0].processingError).toBeNull();

    const payments = await db.select().from(s.payments).where(eq(s.payments.orderId, order.id));
    expect(payments.length).toBe(1);
    expect(payments[0].status).toBe('captured');
    expect(payments[0].amountPaise).toBe(TEN_THOUSAND);
    expect(payments[0].providerPaymentId).toBe('pay_WEBHOOKDUP01');

    const invoices = await db.select().from(s.invoices).where(eq(s.invoices.orderId, order.id));
    expect(invoices.length).toBe(1);

    // The entitlement this order confers is its paid state and its receipt —
    // there is no separate entitlements table in this system (see FINDING 4).
    // What CAN be double-counted is the ledger, so it is counted exactly.
    const ledger = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.orderId, order.id));
    const credit = ledger.filter((l: any) => l.direction === 'credit')
      .reduce((n: number, l: any) => n + l.amountPaise, 0);
    expect(credit).toBe(TEN_THOUSAND);               // once, not 20,00,000
    expect(ledger.filter((l: any) => l.account === 'assets.gateway_receivable').length).toBe(1);
    expect(ledger.filter((l: any) => l.account === 'expense.gateway_fees').length).toBe(1);
  });

  it('the payments table itself forbids a second row for the same provider payment id', async () => {
    // The last line of defence, and the one that does not depend on any code
    // path being taken: a UNIQUE INDEX on (provider, provider_payment_id).
    await expect(db.insert(s.payments).values({
      orderId: order.id, provider: 'razorpay',
      providerOrderId: 'order_WEBHOOKDUP01', providerPaymentId: 'pay_WEBHOOKDUP01',
      amountPaise: TEN_THOUSAND, status: 'captured', idempotencyKey: crypto.randomUUID(),
    })).rejects.toThrow();
  });

  it('survives a RESEND under a new event id — the replay guard is not only the event table', async () => {
    // A manual replay from the gateway dashboard arrives with a fresh event id,
    // so the unique index does not fire. confirmPayment() must still refuse to
    // do the work twice.
    const resendHeaders = { ...headers, 'x-razorpay-event-id': 'evt_MONEYSAFETY_RESEND' };
    const third = await deliver(rawBody, resendHeaders);
    expect(third.fresh).toBe(true);                          // a new event, genuinely
    expect(third.confirmed!.alreadyProcessed).toBe(true);    // but nothing was done again

    expect((await db.select().from(s.invoices).where(eq(s.invoices.orderId, order.id))).length).toBe(1);
    const ledger = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.orderId, order.id));
    const credit = ledger.filter((l: any) => l.direction === 'credit')
      .reduce((n: number, l: any) => n + l.amountPaise, 0);
    expect(credit).toBe(TEN_THOUSAND);
  });

  it('deduplicates on the EVENT ID, not on the payload — two events, one payment', async () => {
    // Same event id, different body. The guard must key on the id the provider
    // assigned, because that is the only thing stable across its retries.
    const otherBody = rawBody.replace('"method":"upi"', '"method":"card"');
    const otherSig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(otherBody).digest('hex');
    const recorded = await recordWebhook(db, {
      provider: 'razorpay', eventId: 'evt_MONEYSAFETY_DUP', eventType: 'payment.captured',
      signatureValid: true, payload: JSON.parse(otherBody),
    });
    expect(recorded.fresh).toBe(false);
    expect(otherSig).not.toBe(headers['x-razorpay-signature']);

    // And the stored payload is still the FIRST one — the record of what was
    // actually acted on, not the last thing that arrived.
    const [event] = await db.select().from(s.paymentEvents)
      .where(and(eq(s.paymentEvents.provider, 'razorpay'), eq(s.paymentEvents.eventId, 'evt_MONEYSAFETY_DUP')));
    expect(event.payload.payload.payment.entity.method).toBe('upi');
  });

  it('scopes deduplication PER PROVIDER — two gateways may use the same id space', async () => {
    const other = await recordWebhook(db, {
      provider: 'cashfree', eventId: 'evt_MONEYSAFETY_DUP', eventType: 'payment.captured',
      signatureValid: true, payload: {},
    });
    expect(other.fresh).toBe(true);
  });

  it('refuses to act on an unsigned or tampered body at all', async () => {
    expect(razorpay.verifyWebhook(rawBody, {}).valid).toBe(false);
    expect(razorpay.verifyWebhook(rawBody.replace(String(TEN_THOUSAND), '100'), headers).valid).toBe(false);
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    expect(razorpay.verifyWebhook(rawBody, headers).valid).toBe(false);
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 4 — PARTIAL REFUND
// ═══════════════════════════════════════════════════════════════════════════
//
// ₹10,000 taken, ₹2,500 given back, ₹7,500 net. Every figure an integer number
// of paise, and every record reachable from every other: payment → refund →
// order → invoice → ledger.

describe('TEST 4 — a partial refund, and the ceiling on it', () => {
  let order: any;
  let payment: any;
  let invoice: any;
  let refund: any;

  const PAID = TEN_THOUSAND;        // 10,00,000
  const REFUNDED = 250_000;         //  2,50,000
  const NET = PAID - REFUNDED;      //  7,50,000

  beforeAll(async () => {
    await db.insert(s.feeSchedule).values({
      code: 'course.school.term.refund', label: 'School programme (refund fixture)',
      kind: 'course', amountPaise: PAID, effectiveFrom: '2026-01-01', active: true,
    });

    order = await serverPricedOrder('course.school.term.refund');
    const paid = await payInFull(order, { feePaise: 23_600, taxPaise: 3_600 });
    [payment] = await db.select().from(s.payments).where(eq(s.payments.id, paid.payment.id));
    [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.orderId, order.id));

    refund = await requestRefund(db, { principal: finance }, {
      paymentId: payment.id,
      amountPaise: REFUNDED,
      reason: 'Term cancelled by the school; one quarter of the programme delivered.',
    });
  });

  it('records 10,00,000 paid, 2,50,000 refunded, 7,50,000 net — all integers', async () => {
    const [p] = await db.select().from(s.payments).where(eq(s.payments.id, payment.id));
    const refunds = await db.select().from(s.refunds).where(eq(s.refunds.paymentId, payment.id));
    const refundedTotal = refunds
      .filter((r: any) => r.status !== 'failed')
      .reduce((n: number, r: any) => n + r.amountPaise, 0);

    expect(p.amountPaise).toBe(PAID);
    expect(refundedTotal).toBe(REFUNDED);
    expect(p.amountPaise - refundedTotal).toBe(NET);

    for (const v of [p.amountPaise, refundedTotal, p.amountPaise - refundedTotal]) {
      expect(Number.isInteger(v)).toBe(true);
      expect(Number.isSafeInteger(v)).toBe(true);
    }
  });

  it('links payment → refund → order → invoice, with no orphan', async () => {
    expect(refund.paymentId).toBe(payment.id);
    expect(refund.orderId).toBe(order.id);
    expect(payment.orderId).toBe(order.id);
    expect(invoice.orderId).toBe(order.id);
    expect(refund.requestedByUserId).toBe(finance.userId);
    expect(refund.reason.length).toBeGreaterThan(0);

    // Reachable in the other direction too, which is what an auditor does.
    const [backToPayment] = await db.select().from(s.payments).where(eq(s.payments.id, refund.paymentId));
    expect(backToPayment.id).toBe(payment.id);
    const [backToOrder] = await db.select().from(s.orders).where(eq(s.orders.id, refund.orderId));
    expect(backToOrder.orderNo).toBe(order.orderNo);
  });

  it('keeps the receipt at 10,00,000 — a refund does not rewrite a tax document', async () => {
    const [again] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoice.id));
    expect(again.snapshot.totalPaise).toBe(PAID);
    expect(again.invoiceNo).toBe(invoice.invoiceNo);
  });

  it('records the refund with a reason and an accountable requester (§78)', async () => {
    await expect(requestRefund(db, { principal: finance }, {
      paymentId: payment.id, amountPaise: 100, reason: '   ',
    })).rejects.toThrow(/requires a reason/i);

    // And the refund is on the audit trail, so it is not a quiet write.
    const audit = await db.select().from(s.auditEvents)
      .where(and(eq(s.auditEvents.entityType, 'refund'), eq(s.auditEvents.entityId, String(refund.id))));
    expect(audit.length).toBe(1);
    expect(audit[0].newValue).toMatchObject({ paymentId: payment.id, amountPaise: REFUNDED });
  });

  it('REFUSES a refund that would exceed what was captured', async () => {
    // 2,50,000 already out; 8,00,000 more would total 10,50,000 against
    // 10,00,000 taken.
    await expect(requestRefund(db, { principal: finance }, {
      paymentId: payment.id, amountPaise: 800_000, reason: 'over the ceiling',
    })).rejects.toThrow(/exceeds the amount captured/i);

    // The exact remaining balance is allowed, and one paisa more is not.
    await expect(requestRefund(db, { principal: finance }, {
      paymentId: payment.id, amountPaise: NET + 1, reason: 'one paisa over',
    })).rejects.toThrow(/exceeds the amount captured/i);

    // Nothing was written by either refusal.
    const refunds = await db.select().from(s.refunds).where(eq(s.refunds.paymentId, payment.id));
    expect(refunds.length).toBe(1);
  });

  it('REFUSES a zero, a negative, and a refund against money never taken', async () => {
    // The refusal used to arrive as "exceeds the amount captured", which was
    // the right outcome reached through the wrong sentence: a refund of -1 does
    // not exceed anything. requestRefund() now rejects a non-positive amount at
    // the door, before it reads a row, and says so. Asserted on the REFUSAL and
    // on nothing being written — not on the wording of a message that was
    // describing a different fault.
    for (const bad of [0, -1, -REFUNDED]) {
      await expect(requestRefund(db, { principal: finance }, {
        paymentId: payment.id, amountPaise: bad, reason: 'nonsense',
      })).rejects.toThrow(/positive whole number of paise|exceeds the amount captured/i);
    }
    // A fractional amount is refused for the same reason: paise are integers.
    await expect(requestRefund(db, { principal: finance }, {
      paymentId: payment.id, amountPaise: 100.5, reason: 'half a paisa',
    })).rejects.toThrow(/positive whole number of paise/i);

    const unpaid = await serverPricedOrder('course.school.term.refund');
    const attempt = await beginPayment(db, unpaid.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: unpaid.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    await expect(requestRefund(db, { principal: finance }, {
      paymentId: attempt.id, amountPaise: 100, reason: 'never captured',
    })).rejects.toThrow(/captured payment can be refunded/i);
  });

  it('REFUSES a refund from somebody without finance:write', async () => {
    await expect(requestRefund(db, { principal: ops }, {
      paymentId: payment.id, amountPaise: 100, reason: 'not my authority',
    })).rejects.toThrow();
  });

  // ── FINDING 2 ──────────────────────────────────────────────────────────
  //
  // TWO CONCURRENT REFUNDS CAN TOGETHER EXCEED THE AMOUNT PAID.
  //
  // requestRefund() in src/db/orders.ts reads the existing refunds, sums them,
  // compares, and THEN inserts — with no transaction, no row lock, and no
  // database constraint behind it:
  //
  //     const already  = await db.select()...where(paymentId)
  //     const refunded = already.reduce(...)
  //     if (refunded + input.amountPaise > payment.amountPaise) throw
  //     await db.insert(s.refunds)...
  //
  // Two requests that both read before either writes both pass the check. Two
  // finance officers clicking Refund on the same payment within the same second
  // — or one officer and one retried request — take more money out of the
  // federation's account than went into it, and the guard reports nothing.
  //
  // confirmPayment() solves exactly this problem, five hundred lines earlier,
  // with a transaction and `.for('update')` on the payment row. requestRefund()
  // does not.
  //
  // The interleaving below is deterministic, not a stress test: both calls
  // suspend on their reads before either reaches its insert.
  //
  // FIXED. requestRefund() now runs in db.transaction() and re-reads the
  // payment with .for('update') inside it, exactly as confirmPayment() does,
  // so the second caller waits and then reads the refund the first one wrote.
  // The marker is gone because the property now HOLDS — this asserts it.
  it('FINDING 2 (FIXED): two concurrent refunds cannot together exceed the amount paid', async () => {
    const fresh = await serverPricedOrder('course.school.term.refund');
    const paid = await payInFull(fresh);
    const p = paid.payment;

    // Two refunds of 6,00,000 against 10,00,000 taken. Exactly one may succeed.
    const outcomes = await Promise.allSettled([
      requestRefund(db, { principal: finance }, {
        paymentId: p.id, amountPaise: 600_000, reason: 'concurrent A',
      }),
      requestRefund(db, { principal: finance }, {
        paymentId: p.id, amountPaise: 600_000, reason: 'concurrent B',
      }),
    ]);

    const granted = await db.select().from(s.refunds).where(eq(s.refunds.paymentId, p.id));
    const total = granted
      .filter((r: any) => r.status !== 'failed')
      .reduce((n: number, r: any) => n + r.amountPaise, 0);

    // The property: however the two raced, the federation never owes more than
    // it received.
    expect(total).toBeLessThanOrEqual(PAID);
    expect(outcomes.filter((o) => o.status === 'fulfilled').length).toBe(1);
  });

  // ── FINDING 3 ──────────────────────────────────────────────────────────
  //
  // A REFUND NEVER REACHES THE LEDGER.
  //
  // requestRefund() writes a `refunds` row and an audit entry, and nothing
  // else. It posts no ledger entries, leaves `orders.status` at 'paid' rather
  // than 'partially_refunded', and leaves `payments.status` at 'captured'. The
  // `ledger_entries.refund_id` column exists and is never populated by any code
  // in src/.
  //
  // The consequence is not cosmetic. src/db/orders.ts derives the treasurer's
  // figures from the ledger — the comment above postLedger() says so — so the
  // treasurer's report shows ₹10,000 of income against a payment that is
  // ₹7,500 net. Refunds are invisible in the accounts.
  //
  // There is also no function anywhere that COMPLETES a refund: `refund_status`
  // has 'processing' and 'completed' values that nothing ever sets, and
  // PaymentProvider.refund() is never called from src/db. A refund in this
  // system is a request that is recorded and then never executed.
  //
  // THE FIX needs a product decision — whether the postings land when a refund
  // is requested or when the provider confirms it — so it is reported, not
  // guessed at.
  it.fails('FINDING 3: a refund posts to the ledger and moves the order to partially_refunded', async () => {
    const postings = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.refundId, refund.id));
    expect(postings.length).toBeGreaterThan(0);
    expect(postings.reduce((n: number, l: any) => n + l.amountPaise, 0)).toBe(REFUNDED);

    const [o] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    expect(o.status).toBe('partially_refunded');

    // And the ledger, read on its own, gives the net.
    const ledger = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.orderId, order.id));
    const credit = ledger.filter((l: any) => l.direction === 'credit' && l.account.startsWith('income.'))
      .reduce((n: number, l: any) => n + l.amountPaise, 0);
    const contra = ledger.filter((l: any) => l.direction === 'debit' && l.account.startsWith('income.'))
      .reduce((n: number, l: any) => n + l.amountPaise, 0);
    expect(credit - contra).toBe(NET);
  });

  it('the ledger as it stands reports the GROSS, and this is what that costs', async () => {
    // Pinned deliberately. When FINDING 3 is fixed this assertion must be
    // rewritten to expect NET — and it will fail loudly until somebody does,
    // which is the point.
    const ledger = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.orderId, order.id));
    const credit = ledger.filter((l: any) => l.direction === 'credit')
      .reduce((n: number, l: any) => n + l.amountPaise, 0);
    expect(credit).toBe(PAID);
    expect(credit).not.toBe(NET);
    expect((await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.refundId, refund.id))).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MONEY IS NEVER A FLOAT
// ═══════════════════════════════════════════════════════════════════════════
//
// The rule: multipliers are parts-per-million, arithmetic is BigInt, and
// applyFactor() in src/db/fees.ts is the ONLY place a factor is applied.
//
// The scan below is a real grep over real source, not a restatement. Every hit
// is either inside applyFactor() or named in the allow-list with the reason it
// is safe, and an unlisted hit fails the test — so a float multiply added
// tomorrow has to be argued for here before it can land.

describe('money never becomes a float', () => {
  /** Every money identifier a factor could be applied to. */
  const MONEY = [
    'amountMinor', 'totalMinor', 'subtotalMinor', 'taxMinor', 'adjustmentMinor',
    'runningTotalMinor', 'unitAmountMinor',
    'amountPaise', 'totalPaise', 'subtotalPaise', 'taxPaise', 'unitPricePaise',
    'pricePaise', 'shippingPaise', 'discountPaise', 'lineTotal',
  ];

  /**
   * Arithmetic on money that the rules permit, each with its justification.
   * `file` and `code` must BOTH match, so moving the line does not silently
   * grant the exemption to something else.
   */
  const ALLOWED = [
    {
      file: 'src/db/fees.ts', code: 'amount = rule.amountMinor * quantity;',
      why: 'Integer paise × an integer quantity. Not a factor — applyFactor() is for PPM.',
    },
    {
      file: 'src/db/orders.ts', code: 'const lineTotal = unit * qty;',
      why: 'Integer paise × an integer quantity bounded to 1..99 by createOrder().',
    },
    {
      file: 'src/db/orders.ts', code: 'const lineTax = Math.round((lineTotal * taxRateBps) / 10_000);',
      why: 'FINDING 4 — a SECOND rounding implementation, outside applyFactor(). Exact over the reachable domain, proved below.',
    },
    {
      file: 'src/lib/payments/manual-upi.ts', code: 'const rupees = (input.amountPaise / 100).toFixed(2);',
      why: 'The only place money leaves integer space, to write rupees into a UPI intent string. Round-trip proved below.',
    },
    {
      file: 'src/pages/checkout.astro', code: 'const lineTotal = e.pricePaise * l.q;',
      why: 'Browser-side basket display only. createOrder() re-prices from the server and ignores it — proved in TEST 2.',
    },
  ];

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) sourceFiles(path, out);
      else if (/\.(ts|astro)$/.test(entry.name)) out.push(path);
    }
    return out;
  }

  it('applies a factor ONLY through applyFactor(), everywhere in src/', () => {
    const pattern = new RegExp(
      `(?:${MONEY.join('|')})\\s*[*/]|[*/]\\s*(?:[A-Za-z_.]*\\.)?(?:${MONEY.join('|')})\\b`
    );

    const offences: string[] = [];
    for (const file of sourceFiles('src')) {
      const text = readFileSync(file, 'utf8');
      text.split(/\r?\n/).forEach((line, i) => {
        const code = line.trim();
        if (!pattern.test(code)) return;
        if (code.startsWith('//') || code.startsWith('*')) return;         // prose
        // applyFactor() itself is the sanctioned implementation.
        if (file.endsWith('fees.ts') && /BigInt|\bnum\b|\bden\b/.test(code)) return;
        const normalised = file.replace(/\\/g, '/');
        if (ALLOWED.some((a) => normalised.endsWith(a.file) && code === a.code)) return;
        offences.push(`${normalised}:${i + 1}  ${code}`);
      });
    }

    expect(offences).toEqual([]);
  });

  it('every allow-listed exemption is still present, so the list cannot rot', () => {
    for (const a of ALLOWED) {
      const text = readFileSync(a.file, 'utf8');
      expect(`${a.file} :: ${text.includes(a.code)}`).toBe(`${a.file} :: true`);
    }
  });

  it('applyFactor stays exact where a double would not', () => {
    expect(applyFactor(1_000_000, PPM)).toBe(1_000_000);
    expect(applyFactor(1_000_000, 1_180_000)).toBe(1_180_000);
    // ₹10 crore, then a chain of factors — the point at which doubles drift.
    let v = 1_000_000_000;
    for (const f of [1_180_000, 1_250_000, 1_050_000]) v = applyFactor(v, f);
    expect(Number.isSafeInteger(v)).toBe(true);
    expect(v).toBe(1_548_750_000);
    // Half-way cases round away from zero, in both directions.
    expect(applyFactor(1, 1_500_000)).toBe(2);
    expect(applyFactor(-1, 1_500_000)).toBe(-2);
  });

  it("orders.ts's tax rounding agrees with applyFactor over its whole reachable domain", () => {
    // FINDING 4 is that the implementation is duplicated, not that it is wrong
    // today. This pins WHY it is not wrong today, so a change to either one
    // that breaks the agreement is caught here.
    const taxOrders = (lineTotal: number, bps: number) => Math.round((lineTotal * bps) / 10_000);
    const taxFees = (lineTotal: number, bps: number) => applyFactor(lineTotal, PPM + bps * 100) - lineTotal;

    for (const bps of [0, 100, 250, 500, 1200, 1800, 2800]) {
      for (const amount of [1, 7, 99, 100, 101, 12_345, 999_999, 1_000_000, 99_999_999, 210_000_000]) {
        expect(`${amount}@${bps}: ${taxOrders(amount, bps)}`).toBe(`${amount}@${bps}: ${taxFees(amount, bps)}`);
      }
    }

    // The intermediate product stays inside safe-integer range for every order
    // createOrder() will build: an int32 unit price × 99 × 2800 bps.
    const worst = 2_147_483_647 * 99 * 2_800;
    expect(worst).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('the UPI deep link carries the exact rupee value of the paise it was given', () => {
    process.env.MMAKF_UPI_ID = 'mmakf@examplebank';
    for (const p of [1, 99, 100, 101, 250_000, 1_000_000, 12_345_678, 999_999_999]) {
      const link = upiDeepLink({ amountPaise: p, reference: 'MMAKF-ORD-2026-000001' });
      const am = new URLSearchParams(link.split('?')[1]).get('am')!;
      expect(/^\d+\.\d{2}$/.test(am)).toBe(true);
      // Parsed back to paise, it must be the number we started with — the whole
      // risk of leaving integer space, closed.
      expect(`${p} → ${am}`).toBe(`${p} → ${Math.round(p / 100 * 100) === p ? am : 'DRIFTED'}`);
      expect(Number(am.replace('.', ''))).toBe(p);
    }
    delete process.env.MMAKF_UPI_ID;
  });

  it('stores every money column as an integer, with no fractional part anywhere', async () => {
    const checks: Array<[string, any[]]> = [
      ['orders', await db.select().from(s.orders)],
      ['order_lines', await db.select().from(s.orderLines)],
      ['payments', await db.select().from(s.payments)],
      ['refunds', await db.select().from(s.refunds)],
      ['ledger_entries', await db.select().from(s.ledgerEntries)],
      ['quote_versions', await db.select().from(s.quoteVersions)],
      ['quote_lines', await db.select().from(s.quoteLines)],
      ['fee_rules', await db.select().from(s.feeRules)],
    ];
    for (const [table, rows] of checks) {
      expect(`${table}: ${rows.length > 0}`).toBe(`${table}: true`);
      for (const row of rows) {
        for (const [col, value] of Object.entries(row)) {
          if (!/Paise$|Minor$/.test(col) || value == null) continue;
          expect(`${table}.${col}=${value}`).toBe(`${table}.${col}=${Math.trunc(value as number)}`);
          expect(Number.isSafeInteger(value)).toBe(true);
        }
      }
    }
  });

  // ── FINDING 5 ──────────────────────────────────────────────────────────
  //
  // computeFee() multiplies a per-unit amount by a caller-supplied quantity
  // with NO upper bound unless the rule happens to define maxQuantity:
  //
  //     amount = rule.amountMinor * quantity;      // src/db/fees.ts
  //
  // `quantity` comes from the request inputs — the participants field on
  // /admin/quotes, and anything else that reaches computeFee(). A rule at ₹450
  // per participant with no maxQuantity and an input of 1e13 produces a figure
  // beyond Number.MAX_SAFE_INTEGER, at which point the arithmetic is no longer
  // exact and the "integer paise" guarantee has quietly stopped applying.
  //
  // It cannot be persisted — the integer column rejects it — but it CAN be
  // displayed, and a quotation screen showing a silently-inexact number is the
  // failure this whole module exists to prevent. The engine should refuse the
  // input rather than compute past the point where it can be trusted.
  it('FINDING 5 (FIXED): computeFee refuses a quantity that leaves safe-integer range', async () => {
    const fw = await createFramework(db, financeCtx, {
      title: 'Unbounded quantity fixture', version: 9, effectiveFrom: '2026-01-01',
    });
    await addRule(db, financeCtx, fw.id, {
      code: 'PER-HEAD', label: 'Per participant', kind: 'per_participant',
      audience: 'school', amountMinor: 45_000, sortOrder: 10,
      // maxQuantity deliberately absent — which is the default, and legal.
    });
    await publishFramework(db, financeCtx, fw.id);

    let refused = false;
    let total = 0;
    try {
      const c = await computeFee(db, fw.id, { audience: 'school', participants: 1e13 });
      total = c.totalMinor;
    } catch {
      refused = true;
    }
    // Either it refused, or it returned a number it can still stand behind.
    expect(refused || Number.isSafeInteger(total)).toBe(true);
    expect(refused).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE FINDINGS, IN ONE PLACE
// ═══════════════════════════════════════════════════════════════════════════
//
// 1. src/db/fees.ts — a published framework is immutable in the MODULE only.
//    No trigger, no constraint, no revoked grant. Anything reaching the
//    connection another way rewrites history.               [it.fails, TEST 1]
//
// 2. src/db/orders.ts requestRefund() — read-then-write with no transaction and
//    no row lock. Two concurrent refunds can together exceed the amount
//    captured. confirmPayment() already shows the fix.       [it.fails, TEST 4]
//
// 3. src/db/orders.ts requestRefund() — a refund posts NOTHING to the ledger,
//    does not move the order to partially_refunded, and no code path ever
//    completes it. The treasurer's report shows gross.       [it.fails, TEST 4]
//
// 4. src/db/orders.ts:159 — a second rounding implementation for tax, outside
//    applyFactor(), contrary to the stated rule. Exact over the reachable
//    domain, and pinned as such above.                      [allow-list + test]
//
// 5. src/db/fees.ts computeFee() — an unbounded per-unit quantity can leave
//    safe-integer range and still be displayed.              [it.fails, above]
//
// 6. NOT AN ASSERTION, A GAP: nothing in src/ turns an accepted quotation into
//    an order. The engagement side (quotes, quote_versions, quote_lines) and
//    the commerce side (orders, invoices, ledger_entries) share no function and
//    no foreign key. TEST 1 bridges them by hand through the fee schedule. A
//    school that accepts a quotation cannot be invoiced from it.
