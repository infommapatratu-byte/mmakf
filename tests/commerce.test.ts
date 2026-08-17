// Commerce and payments — behaviour and attacks (§15-18, §49-52).
//
// This is money. Every test here is either an invariant the federation's
// accounts depend on, or an attack that would let someone pay less than they
// owe, get fulfilled without paying, or be charged twice.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  createOrder, beginPayment, confirmPayment, recordWebhook, issueInvoice,
  requestRefund, expireStaleOrders, orderByNumber, formatINR, paise, OrderError,
} from '../src/db/orders';
import type { Principal } from '../src/lib/rbac';
import type { VerifiedPayment } from '../src/lib/payments';
import { razorpay } from '../src/lib/payments/razorpay';
import { manualUpi, upiDeepLink } from '../src/lib/payments/manual-upi';
import { paymentStatusReport, activeProvider } from '../src/lib/payments';
import crypto from 'node:crypto';

let db: any, VARIANT: number, PRODUCT: number;

const finance: Principal = {
  userId: 1, label: 'treasurer',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 2, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};

const captured = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
  providerOrderId: '',
  amountPaise: 0,
  currency: 'INR',
  status: 'captured',
  method: 'upi',
  ...over,
});

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [p] = await db.insert(s.products).values({
    sku: 'GI-STD', name: 'Shotokan Gi', category: 'Uniform', status: 'active', taxRateBps: 500,
  }).returning({ id: s.products.id });
  PRODUCT = p.id;

  const [v] = await db.insert(s.productVariants).values({
    productId: PRODUCT, sku: 'GI-STD-150', label: 'Size 150cm',
    pricePaise: 180000, stockQty: 5, status: 'active',
  }).returning({ id: s.productVariants.id });
  VARIANT = v.id;

  await db.insert(s.feeSchedule).values({
    code: 'membership.athlete.annual', label: 'Athlete membership (annual)',
    kind: 'membership', amountPaise: 50000, effectiveFrom: '2026-01-01', active: true,
  });
});

describe('money arithmetic', () => {
  it('keeps everything in integer paise', () => {
    expect(paise(1800)).toBe(180000);
    expect(paise(0.1) + paise(0.2)).toBe(paise(0.3));   // the float trap
    expect(Number.isInteger(paise(19.99))).toBe(true);
  });

  it('formats with Indian digit grouping', () => {
    expect(formatINR(180000)).toBe('₹1,800.00');
    expect(formatINR(123456789)).toBe('₹12,34,567.89');   // not 1,234,567.89
    expect(formatINR(50)).toBe('₹0.50');
    expect(formatINR(0)).toBe('₹0.00');
    expect(formatINR(-25000)).toBe('-₹250.00');
  });
});

describe('order creation prices on the SERVER', () => {
  it('ignores a price supplied by the client', async () => {
    const order = await createOrder(db, null, {
      email: 'buyer@example.in',
      // The attack: claim the gi costs ₹1.
      lines: [{ kind: 'product', description: 'Gi', variantId: VARIANT, unitPricePaise: 100 }],
    });
    expect(order.lines[0].unitPricePaise).toBe(180000);
    expect(order.subtotalPaise).toBe(180000);
    expect(order.taxPaise).toBe(9000);                  // 5% server-side rate
    expect(order.totalPaise).toBe(189000);
  });

  it('ignores a client-supplied price on a fee line too', async () => {
    const order = await createOrder(db, null, {
      email: 'buyer@example.in',
      lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual', unitPricePaise: 1 }],
    });
    expect(order.lines[0].unitPricePaise).toBe(50000);
    expect(order.lines[0].description).toBe('Athlete membership (annual)');
  });

  it('refuses a fee the federation has not published rather than inventing one', async () => {
    await expect(createOrder(db, null, {
      lines: [{ kind: 'grading', description: 'Dan grading', feeCode: 'grading.dan.shodan' }],
    })).rejects.toThrow(/No published fee/i);
  });

  it('refuses a line that names no variant, fee, or permitted amount', async () => {
    await expect(createOrder(db, null, {
      lines: [{ kind: 'other', description: 'Anything', unitPricePaise: 999999 }],
    })).rejects.toThrow(/names no variant, fee code, or permitted amount/i);
  });

  it('refuses empty orders, absurd quantities and oversized baskets', async () => {
    await expect(createOrder(db, null, { lines: [] })).rejects.toThrow(/at least one/i);
    await expect(createOrder(db, null, {
      lines: [{ kind: 'product', description: 'Gi', variantId: VARIANT, quantity: 0 }],
    })).rejects.toThrow(/quantity/i);
    await expect(createOrder(db, null, {
      lines: [{ kind: 'product', description: 'Gi', variantId: VARIANT, quantity: -3 }],
    })).rejects.toThrow(/quantity/i);
    await expect(createOrder(db, null, {
      lines: Array.from({ length: 51 }, () => ({ kind: 'product' as const, description: 'Gi', variantId: VARIANT })),
    })).rejects.toThrow(/50 lines/i);
  });

  it('issues sequential, unguessable-format order numbers', async () => {
    const a = await createOrder(db, null, { lines: [{ kind: 'product', description: 'Gi', variantId: VARIANT }] });
    const b = await createOrder(db, null, { lines: [{ kind: 'product', description: 'Gi', variantId: VARIANT }] });
    expect(a.orderNo).toMatch(/^MMAKF-ORD-\d{4}-\d{6}$/);
    expect(a.orderNo).not.toBe(b.orderNo);
  });
});

describe('stock', () => {
  it('reserves on order and refuses to oversell', async () => {
    const [v] = await db.insert(s.productVariants).values({
      productId: PRODUCT, sku: 'BELT-SCARCE', label: 'Last belt', pricePaise: 40000, stockQty: 2, status: 'active',
    }).returning({ id: s.productVariants.id });

    await createOrder(db, null, { lines: [{ kind: 'product', description: 'Belt', variantId: v.id, quantity: 2 }] });

    await expect(createOrder(db, null, {
      lines: [{ kind: 'product', description: 'Belt', variantId: v.id, quantity: 1 }],
    })).rejects.toThrow(/left|out_of_stock/i);
  });

  it('releases the reservation when an unpaid order expires', async () => {
    const [v] = await db.insert(s.productVariants).values({
      productId: PRODUCT, sku: 'BELT-EXPIRE', label: 'Expiring', pricePaise: 40000, stockQty: 1, status: 'active',
    }).returning({ id: s.productVariants.id });

    const order = await createOrder(db, null, { lines: [{ kind: 'product', description: 'Belt', variantId: v.id }] });
    await db.update(s.orders).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(s.orders.id, order.id));

    expect(await expireStaleOrders(db)).toBeGreaterThan(0);
    const [after] = await db.select().from(s.productVariants).where(eq(s.productVariants.id, v.id));
    expect(after.reservedQty).toBe(0);
    // The item is buyable again.
    await expect(createOrder(db, null, { lines: [{ kind: 'product', description: 'Belt', variantId: v.id }] })).resolves.toBeTruthy();
  });

  it('refuses a discontinued variant', async () => {
    const [v] = await db.insert(s.productVariants).values({
      productId: PRODUCT, sku: 'GONE', label: 'Gone', pricePaise: 1000, stockQty: 9, status: 'discontinued',
    }).returning({ id: s.productVariants.id });
    await expect(createOrder(db, null, {
      lines: [{ kind: 'product', description: 'x', variantId: v.id }],
    })).rejects.toThrow(/not available/i);
  });
});

describe('an order becomes PAID only on a verified capture', () => {
  async function pending() {
    const order = await createOrder(db, null, {
      email: 'payer@example.in',
      lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
    });
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    return { order, payment };
  }

  it('marks the order paid, decrements stock and issues a receipt', async () => {
    const { order, payment } = await pending();
    const result = await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise, feePaise: 1180,
    }));
    expect(result!.alreadyProcessed).toBe(false);

    const after = await orderByNumber(db, order.orderNo);
    expect(after!.status).toBe('paid');
    expect(after!.paidAt).toBeTruthy();

    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.orderId, order.id));
    expect(invoice.invoiceNo).toMatch(/^MMAKF\/\d{4}\/\d{5}$/);
  });

  it('ATTACK: an underpayment does NOT pay the order', async () => {
    const { order, payment } = await pending();
    await expect(confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId,
      amountPaise: order.totalPaise - 1,       // one paisa short
    }))).rejects.toThrow(/does not match the order total/i);

    const after = await orderByNumber(db, order.orderNo);
    expect(after!.status).toBe('awaiting_payment');
    expect(after!.payments.some((p: any) => p.status === 'captured')).toBe(false);
  });

  it('ATTACK: a different currency does NOT pay the order', async () => {
    const { order, payment } = await pending();
    await expect(confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise, currency: 'USD',
    }))).rejects.toThrow(/does not match the order total/i);
    expect((await orderByNumber(db, order.orderNo))!.status).toBe('awaiting_payment');
  });

  it('an AUTHORIZED payment is money held, not taken — the order stays unpaid', async () => {
    const { order, payment } = await pending();
    await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise, status: 'authorized',
    }));
    expect((await orderByNumber(db, order.orderNo))!.status).toBe('awaiting_payment');
  });

  it('a failed payment records the reason and leaves the order unpaid', async () => {
    const { order, payment } = await pending();
    await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise,
      status: 'failed', failureReason: 'Insufficient funds',
    }));
    const after = await orderByNumber(db, order.orderNo);
    expect(after!.status).toBe('awaiting_payment');
    expect(after!.payments[0].failureReason).toBe('Insufficient funds');
  });

  it('ATTACK: paying an already-paid order is refused', async () => {
    const { order, payment } = await pending();
    await confirmPayment(db, null, captured({ providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise }));
    await expect(beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: 'order_second', amountPaise: order.totalPaise,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toThrow(/already been paid/i);
  });

  it('ATTACK: beginning a payment for the wrong amount is refused', async () => {
    const order = await createOrder(db, null, {
      lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
    });
    await expect(beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: 'order_x', amountPaise: 1,
      idempotencyKey: crypto.randomUUID(),
    })).rejects.toThrow(/does not match/i);
  });

  it('a repeated capture event is idempotent — nothing is fulfilled twice', async () => {
    const { order, payment } = await pending();
    const event = captured({ providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise });

    const first = await confirmPayment(db, null, event);
    const second = await confirmPayment(db, null, event);
    expect(first!.alreadyProcessed).toBe(false);
    expect(second!.alreadyProcessed).toBe(true);

    const invoices = await db.select().from(s.invoices).where(eq(s.invoices.orderId, order.id));
    expect(invoices.length).toBe(1);                                  // one receipt
    const ledger = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.orderId, order.id));
    expect(ledger.filter((l: any) => l.account === 'assets.gateway_receivable').length).toBe(1);
  });

  it('every payment attempt is kept — a failed try is evidence, not noise', async () => {
    const order = await createOrder(db, null, {
      lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
    });
    const a = await beginPayment(db, order.id, { provider: 'razorpay', providerOrderId: 'ord_a', amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID() });
    await confirmPayment(db, null, captured({ providerOrderId: 'ord_a', amountPaise: order.totalPaise, status: 'failed', failureReason: 'Card declined' }));
    const b = await beginPayment(db, order.id, { provider: 'razorpay', providerOrderId: 'ord_b', amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID() });
    await confirmPayment(db, null, captured({ providerOrderId: 'ord_b', amountPaise: order.totalPaise }));

    const attempts = await db.select().from(s.payments).where(eq(s.payments.orderId, order.id));
    expect(attempts.length).toBe(2);
    expect(attempts.find((p: any) => p.id === a.id).status).toBe('failed');
    expect(attempts.find((p: any) => p.id === b.id).status).toBe('captured');
  });
});

describe('webhook intake', () => {
  it('accepts an event once and refuses the replay', async () => {
    const first = await recordWebhook(db, {
      provider: 'razorpay', eventId: 'evt_replay_1', eventType: 'payment.captured',
      signatureValid: true, payload: { ok: true },
    });
    const second = await recordWebhook(db, {
      provider: 'razorpay', eventId: 'evt_replay_1', eventType: 'payment.captured',
      signatureValid: true, payload: { ok: true },
    });
    expect(first.fresh).toBe(true);
    expect(second.fresh).toBe(false);
  });

  it('stores the raw payload so a disputed settlement can be reconstructed', async () => {
    await recordWebhook(db, {
      provider: 'razorpay', eventId: 'evt_raw_1', eventType: 'payment.captured',
      signatureValid: true, payload: { payload: { payment: { entity: { id: 'pay_x', amount: 12345 } } } },
    });
    const [row] = await db.select().from(s.paymentEvents).where(eq(s.paymentEvents.eventId, 'evt_raw_1'));
    expect(row.payload.payload.payment.entity.amount).toBe(12345);
  });

  it('records that a signature failed rather than discarding the evidence', async () => {
    await recordWebhook(db, {
      provider: 'razorpay', eventId: 'evt_bad_sig', eventType: 'payment.captured',
      signatureValid: false, payload: { hostile: true },
    });
    const [row] = await db.select().from(s.paymentEvents).where(eq(s.paymentEvents.eventId, 'evt_bad_sig'));
    expect(row.signatureValid).toBe(false);
  });
});

describe('receipts', () => {
  it('freeze what they say — a later catalogue edit cannot change an issued receipt', async () => {
    const order = await createOrder(db, null, {
      lines: [{ kind: 'product', description: 'Gi', variantId: VARIANT }],
    });
    const invoice = await issueInvoice(db, order.id);
    const originalTotal = invoice.snapshot.totalPaise;

    await db.update(s.productVariants).set({ pricePaise: 999999 }).where(eq(s.productVariants.id, VARIANT));
    await db.update(s.products).set({ name: 'Renamed Product' }).where(eq(s.products.id, PRODUCT));

    const [again] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoice.id));
    expect(again.snapshot.totalPaise).toBe(originalTotal);
    expect(JSON.stringify(again.snapshot)).toContain('Shotokan Gi');
    expect(JSON.stringify(again.snapshot)).not.toContain('Renamed Product');

    await db.update(s.productVariants).set({ pricePaise: 180000 }).where(eq(s.productVariants.id, VARIANT));
  });

  it('are issued once per order', async () => {
    const order = await createOrder(db, null, { lines: [{ kind: 'product', description: 'Gi', variantId: VARIANT }] });
    const a = await issueInvoice(db, order.id);
    const b = await issueInvoice(db, order.id);
    expect(a.id).toBe(b.id);
  });

  it('carry an unguessable public verification token', async () => {
    // Its own line item: shared catalogue stock is consumed by earlier tests.
    const order = await createOrder(db, null, {
      lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
    });
    const invoice = await issueInvoice(db, order.id);
    expect(invoice.verifyToken.length).toBeGreaterThanOrEqual(20);
    expect(invoice.verifyToken).not.toContain(order.orderNo);
  });

  it('number in their own unbroken series, separate from order numbers', async () => {
    const rows = await db.select().from(s.invoices);
    const numbers = rows.map((r: any) => Number(r.invoiceNo.split('/')[2])).sort((a: number, b: number) => a - b);
    for (let i = 1; i < numbers.length; i++) expect(numbers[i] - numbers[i - 1]).toBe(1);
  });
});

describe('refunds', () => {
  async function paidOrder() {
    const order = await createOrder(db, null, {
      lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
    });
    const oid = `ord_${crypto.randomBytes(5).toString('hex')}`;
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: oid, amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    await confirmPayment(db, null, captured({ providerOrderId: oid, amountPaise: order.totalPaise }));
    return { order, payment };
  }

  it('require authority, a reason, and cannot exceed what was captured', async () => {
    const { payment } = await paidOrder();

    await expect(requestRefund(db, { principal: athlete }, {
      paymentId: payment.id, amountPaise: 100, reason: 'Because',
    })).rejects.toThrow(/Forbidden/);

    await expect(requestRefund(db, { principal: finance }, {
      paymentId: payment.id, amountPaise: 100, reason: '   ',
    })).rejects.toThrow(/reason/i);

    await expect(requestRefund(db, { principal: finance }, {
      paymentId: payment.id, amountPaise: 50_000_00, reason: 'Overclaim',
    })).rejects.toThrow(/exceeds/i);

    const refund = await requestRefund(db, { principal: finance }, {
      paymentId: payment.id, amountPaise: 10000, reason: 'Duplicate entry fee',
    });
    expect(refund.status).toBe('requested');
  });

  it('cannot cumulatively exceed the captured amount', async () => {
    const { payment } = await paidOrder();
    await requestRefund(db, { principal: finance }, { paymentId: payment.id, amountPaise: 30000, reason: 'Partial' });
    await expect(requestRefund(db, { principal: finance }, {
      paymentId: payment.id, amountPaise: 30000, reason: 'Second partial',
    })).rejects.toThrow(/exceeds/i);
  });

  it('cannot refund a payment that was never captured', async () => {
    const order = await createOrder(db, null, { lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }] });
    const p = await beginPayment(db, order.id, { provider: 'razorpay', providerOrderId: 'ord_never', amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID() });
    await expect(requestRefund(db, { principal: finance }, {
      paymentId: p.id, amountPaise: 100, reason: 'Nope',
    })).rejects.toThrow(/captured/i);
  });
});

describe('the ledger', () => {
  it('balances: debits equal credits', async () => {
    const rows = await db.select().from(s.ledgerEntries);
    const debit = rows.filter((r: any) => r.direction === 'debit').reduce((n: number, r: any) => n + r.amountPaise, 0);
    const credit = rows.filter((r: any) => r.direction === 'credit').reduce((n: number, r: any) => n + r.amountPaise, 0);
    // Gateway fees are an expense posted as an extra debit, so debits exceed
    // credits by exactly the total fees charged.
    const fees = rows.filter((r: any) => r.account === 'expense.gateway_fees').reduce((n: number, r: any) => n + r.amountPaise, 0);
    expect(debit - fees).toBe(credit);
  });

  it('posts the gateway fee as an expense, not as reduced income', async () => {
    const rows = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.account, 'expense.gateway_fees'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].direction).toBe('debit');
  });

  it('attributes income to the kind of thing that was sold', async () => {
    const rows = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.account, 'income.membership'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => r.direction === 'credit')).toBe(true);
  });
});

describe('Razorpay adapter', () => {
  const SECRET = 'test_key_secret';
  const WEBHOOK = 'test_webhook_secret';

  it('verifies a genuine checkout signature and rejects a forged one', () => {
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    const orderId = 'order_ABC123', paymentId = 'pay_XYZ789';
    const good = crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');

    expect(razorpay.verifyCheckout({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: good })).toBe(true);
    expect(razorpay.verifyCheckout({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: 'deadbeef' })).toBe(false);
    // Swapping the ids must not verify under the same signature.
    expect(razorpay.verifyCheckout({ razorpay_order_id: paymentId, razorpay_payment_id: orderId, razorpay_signature: good })).toBe(false);
    expect(razorpay.verifyCheckout({ razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: '' })).toBe(false);
    delete process.env.RAZORPAY_KEY_SECRET;
  });

  it('verifies a webhook over the RAW body and rejects tampering', () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK;
    const body = JSON.stringify({
      event: 'payment.captured',
      created_at: 1770000000,
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 50000, currency: 'INR', status: 'captured', method: 'upi', fee: 1180, tax: 180 } } },
    });
    const sig = crypto.createHmac('sha256', WEBHOOK).update(body).digest('hex');

    const ok = razorpay.verifyWebhook(body, { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'evt_1' });
    expect(ok.valid).toBe(true);
    expect(ok.eventType).toBe('payment.captured');
    expect(ok.payment!.amountPaise).toBe(50000);
    expect(ok.payment!.status).toBe('captured');
    expect(ok.payment!.feePaise).toBe(1180);

    // A single byte changed anywhere invalidates it.
    expect(razorpay.verifyWebhook(body.replace('50000', '50001'), { 'x-razorpay-signature': sig }).valid).toBe(false);
    expect(razorpay.verifyWebhook(body, { 'x-razorpay-signature': 'ff' }).valid).toBe(false);
    expect(razorpay.verifyWebhook(body, {}).valid).toBe(false);
    expect(razorpay.verifyWebhook('', { 'x-razorpay-signature': sig }).valid).toBe(false);

    // Re-serialised JSON has different bytes and must not verify — the reason
    // the raw body has to be preserved through the request pipeline.
    expect(razorpay.verifyWebhook(JSON.stringify(JSON.parse(body)) + ' ', { 'x-razorpay-signature': sig }).valid).toBe(false);
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });

  it('refuses to verify anything when unconfigured', () => {
    delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    expect(razorpay.verifyCheckout({ razorpay_order_id: 'a', razorpay_payment_id: 'b', razorpay_signature: 'c' })).toBe(false);
    expect(razorpay.verifyWebhook('{}', { 'x-razorpay-signature': 'x' }).valid).toBe(false);
    expect(razorpay.isConfigured()).toBe(false);
  });

  it('rejects a non-integer or non-positive amount before calling the API', async () => {
    process.env.RAZORPAY_KEY_ID = 'rzp_test_A1b2C3d4E5'; process.env.RAZORPAY_KEY_SECRET = 's';
    for (const amount of [0, -100, 12.5, NaN]) {
      await expect(razorpay.createOrder({
        amountPaise: amount, currency: 'INR', reference: 'MMAKF-ORD-2026-000001', idempotencyKey: 'k1',
      })).rejects.toThrow(/positive integer/i);
    }
    delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
  });
});

describe('manual UPI is honest about what it is', () => {
  it('never claims a payment is verified', () => {
    expect(manualUpi.verifyCheckout({ any: 'thing' })).toBe(false);
    expect(manualUpi.verifyWebhook('{"paid":true}', {}).valid).toBe(false);
  });

  it('refuses to pretend it can query or refund automatically', async () => {
    await expect(manualUpi.fetchPayment('pay_x')).rejects.toThrow(/bank statement/i);
    await expect(manualUpi.refund('pay_x', 100, 'reason')).rejects.toThrow(/finance officer/i);
  });

  it('builds a deep link carrying the order reference for reconciliation', () => {
    process.env.MMAKF_UPI_ID = '9939144318@ybl';
    const link = upiDeepLink({ amountPaise: 189000, reference: 'MMAKF-ORD-2026-000042' });
    expect(link).toContain('pa=9939144318%40ybl');
    expect(link).toContain('am=1890.00');            // rupees, two decimals
    expect(link).toContain('cu=INR');
    expect(decodeURIComponent(link)).toContain('MMAKF-ORD-2026-000042');
  });

  it('tells the payer that confirmation is manual', async () => {
    process.env.MMAKF_UPI_ID = '9939144318@ybl';
    const r = await manualUpi.createOrder({
      amountPaise: 50000, currency: 'INR', reference: 'MMAKF-ORD-2026-000043', idempotencyKey: 'k',
    });
    expect(String(r.checkout.instruction)).toMatch(/office confirms receipt/i);
    delete process.env.MMAKF_UPI_ID;
  });
});

describe('provider selection reports the truth (§70)', () => {
  it('reports not-ready when nothing is configured', () => {
    delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.MMAKF_UPI_ID; delete process.env.PAYMENT_PROVIDER;
    expect(activeProvider()).toBeNull();
    expect(paymentStatusReport()).toEqual({ ready: false, provider: null, label: null, automatic: false });
  });

  it('falls back to manual UPI, and marks it as NOT automatic', () => {
    process.env.MMAKF_UPI_ID = '9939144318@ybl';
    const report = paymentStatusReport();
    expect(report.ready).toBe(true);
    expect(report.provider).toBe('manual_upi');
    expect(report.automatic).toBe(false);
    delete process.env.MMAKF_UPI_ID;
  });

  it('prefers a configured gateway over manual UPI', () => {
    process.env.MMAKF_UPI_ID = '9939144318@ybl';
    process.env.RAZORPAY_KEY_ID = 'rzp_test_A1b2C3d4E5'; process.env.RAZORPAY_KEY_SECRET = 'secret';
    // The webhook secret is part of what makes this gateway configured, not an
    // optional extra. A signed webhook is the only thing this system accepts as
    // proof that money moved — there is no browser-return route and the
    // reconcile cron only re-drives events that already arrived — so without it
    // Razorpay holds itself back and manual UPI carries the federation.
    // tests/payment-mode.test.ts asserts that refusal in its own right. THIS
    // test is about PREFERENCE: that a gateway which can actually take a payment
    // end to end beats manual UPI. So it supplies one that can.
    process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';
    const report = paymentStatusReport();
    expect(report.provider).toBe('razorpay');
    expect(report.automatic).toBe(true);
    delete process.env.MMAKF_UPI_ID;
    delete process.env.RAZORPAY_KEY_ID; delete process.env.RAZORPAY_KEY_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
  });
});

// ─── Atomicity of a confirmation ────────────────────────────────────────────
//
// Confirming a payment is six kinds of write: the payment, the order, the
// stock, the ledger, the receipt, the audit trail. Any one of them landing
// without the others is money taken with nothing issued for it — and because
// the payment row is what the replay guard reads, a half-finished confirmation
// used to answer "already processed" to every retry that came afterwards, so
// nothing ever repaired it.

/**
 * A database handle whose first ledger insert fails, the way a dropped backend
 * or a constraint violation does part-way through a confirmation. Everything
 * else passes straight through to the real database, so whatever survives the
 * fault is exactly what the code actually committed.
 */
function faultyAtLedger(real: any): any {
  const trap = (target: any): any => new Proxy(target, {
    get(t: any, prop: string | symbol) {
      if (prop === 'insert') {
        return (table: any) => {
          if (table === s.ledgerEntries) throw new Error('connection terminated unexpectedly');
          return t.insert(table);
        };
      }
      if (prop === 'transaction') {
        return (fn: any, ...rest: any[]) => t.transaction((tx: any) => fn(trap(tx)), ...rest);
      }
      const value = Reflect.get(t, prop);
      return typeof value === 'function' ? value.bind(t) : value;
    },
  });
  return trap(real);
}

describe('confirming a payment is all-or-nothing', () => {
  it('commits nothing when a fault interrupts it, and the retry completes the job', async () => {
    const [v] = await db.insert(s.productVariants).values({
      productId: PRODUCT, sku: 'GI-ATOMIC', label: 'Atomicity', pricePaise: 120000, stockQty: 3, status: 'active',
    }).returning({ id: s.productVariants.id });

    const order = await createOrder(db, null, {
      email: 'payer@example.in',
      lines: [{ kind: 'product', description: 'Gi', variantId: v.id }],
    });
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    const event = captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise, feePaise: 2360,
    });

    await expect(confirmPayment(faultyAtLedger(db), null, event)).rejects.toThrow(/connection terminated/i);

    // Nothing may have survived — least of all the capture flag, which is the
    // one the replay guard reads.
    const [paymentAfterFault] = await db.select().from(s.payments).where(eq(s.payments.id, payment.id));
    expect(paymentAfterFault.status).not.toBe('captured');
    const [orderAfterFault] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    expect(orderAfterFault.status).toBe('awaiting_payment');
    const [stockAfterFault] = await db.select().from(s.productVariants).where(eq(s.productVariants.id, v.id));
    expect(stockAfterFault.stockQty).toBe(3);        // not sold
    expect(stockAfterFault.reservedQty).toBe(1);     // still held for this order
    expect((await db.select().from(s.invoices).where(eq(s.invoices.orderId, order.id))).length).toBe(0);
    expect((await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.orderId, order.id))).length).toBe(0);

    // The retry — the gateway's, or the hourly cron's — must finish the work,
    // not report that there was nothing to do.
    const retry = await confirmPayment(db, null, event);
    expect(retry!.alreadyProcessed).toBe(false);

    const [orderAfter] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    expect(orderAfter.status).toBe('paid');
    expect((await db.select().from(s.invoices).where(eq(s.invoices.orderId, order.id))).length).toBe(1);

    const ledger = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.orderId, order.id));
    const debit = ledger.filter((l: any) => l.direction === 'debit').reduce((n: number, l: any) => n + l.amountPaise, 0);
    const credit = ledger.filter((l: any) => l.direction === 'credit').reduce((n: number, l: any) => n + l.amountPaise, 0);
    const fees = ledger.filter((l: any) => l.account === 'expense.gateway_fees').reduce((n: number, l: any) => n + l.amountPaise, 0);
    expect(credit).toBe(order.totalPaise);
    expect(debit - fees).toBe(credit);               // the treasurer's report balances
    expect(fees).toBe(2360);

    const [stockAfter] = await db.select().from(s.productVariants).where(eq(s.productVariants.id, v.id));
    expect(stockAfter.stockQty).toBe(2);             // reserved stock became sold stock
    expect(stockAfter.reservedQty).toBe(0);
  });

  it('refuses to call a half-finished confirmation a replay', async () => {
    const order = await createOrder(db, null, {
      lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.athlete.annual' }],
    });
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    const event = captured({ providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise });

    // Exactly the wreck the un-transacted sequence could leave behind: the
    // capture flag committed, and not one of the writes that follow it.
    await db.update(s.payments)
      .set({ status: 'captured', providerPaymentId: event.providerPaymentId, capturedAt: new Date() })
      .where(eq(s.payments.id, payment.id));

    await expect(confirmPayment(db, null, event)).rejects.toThrow(/did not complete/i);

    // Because it throws, the webhook and the cron record it as still failing
    // instead of clearing the error and counting it as recovered.
    const [after] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    expect(after.status).toBe('awaiting_payment');
  });

  it('never expires an order that money was taken for', async () => {
    const [v] = await db.insert(s.productVariants).values({
      productId: PRODUCT, sku: 'BELT-STUCK', label: 'Stuck', pricePaise: 40000, stockQty: 1, status: 'active',
    }).returning({ id: s.productVariants.id });

    const order = await createOrder(db, null, { lines: [{ kind: 'product', description: 'Belt', variantId: v.id }] });
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    await db.update(s.payments)
      .set({ status: 'captured', providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`, capturedAt: new Date() })
      .where(eq(s.payments.id, payment.id));
    await db.update(s.orders).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(s.orders.id, order.id));

    await expireStaleOrders(db);

    const [after] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    expect(after.status).toBe('awaiting_payment');   // not 'expired'
    const [variant] = await db.select().from(s.productVariants).where(eq(s.productVariants.id, v.id));
    expect(variant.reservedQty).toBe(1);             // the reservation is not released
  });
});
