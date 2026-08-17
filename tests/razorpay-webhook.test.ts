// POST /api/payments/razorpay/webhook — the endpoint, not the adapter.
//
// tests/commerce.test.ts already proves the HMAC and the money rules in
// isolation. These prove the things only the ENDPOINT can get wrong, and every
// one of them is a way the federation could lose money or fulfil for free:
//
//   · a forged, tampered or unsigned body reaching the fulfilment path;
//   · a rejection being dropped instead of recorded, so a wrong webhook secret
//     looks identical to silence;
//   · Razorpay's retries — which are guaranteed, not hypothetical — issuing a
//     second receipt and a second set of ledger postings;
//   · a captured amount that is not the amount MMAKF asked for being accepted
//     because the webhook said so.
//
// The suite drives real Postgres (PGlite) through the real migrations, and
// signs its deliveries with a real HMAC over the exact bytes it sends.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, desc, eq } from 'drizzle-orm';
import crypto from 'node:crypto';

import * as s from '../src/db/schema';
import * as o from '../src/db/operations.schema';
import { __setTestClient } from '../src/db';
import { createOrder, beginPayment } from '../src/db/orders';

// Both are read at request time, but the route module is imported once, so they
// are set before the import to keep the order of effects obvious.
process.env.DATABASE_URL = 'postgresql://razorpay-webhook-test/pglite';
const SECRET = 'whsec_test_only_never_a_live_value';
process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;

const route = await import('../src/pages/api/payments/razorpay/webhook');

let db: any;
let VARIANT: number;

const URL_ = 'https://mmakf.in/api/payments/razorpay/webhook';

// ─── Deliveries ─────────────────────────────────────────────────────────────

interface Delivered {
  status: number;
  body: any;
}

/**
 * Post a delivery the way Razorpay does: a JSON body, and a signature over the
 * EXACT bytes of that body. `sent` exists so a test can tamper with the bytes
 * after they were signed.
 */
async function deliver(
  payload: unknown,
  opts: {
    eventId?: string | null;
    signature?: string | null;
    secret?: string;
    sent?: string;
  } = {}
): Promise<Delivered> {
  const signedBytes = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const bytes = opts.sent ?? signedBytes;

  const signature = opts.signature !== undefined
    ? opts.signature
    : crypto.createHmac('sha256', opts.secret ?? SECRET).update(signedBytes).digest('hex');

  const headers = new Headers({ 'content-type': 'application/json' });
  if (signature) headers.set('x-razorpay-signature', signature);
  if (opts.eventId !== null) headers.set('x-razorpay-event-id', opts.eventId ?? `evt_${crypto.randomBytes(6).toString('hex')}`);

  const request = new Request(URL_, { method: 'POST', headers, body: bytes });
  const res: Response = await (route.POST as any)({ request, url: new URL(URL_) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// ─── Event bodies ───────────────────────────────────────────────────────────

function paymentEvent(input: {
  event?: string;
  paymentId: string;
  orderId: string;
  amountPaise: number;
  currency?: string;
  status?: string;
}) {
  return {
    entity: 'event',
    account_id: 'acc_TEST',
    event: input.event ?? 'payment.captured',
    contains: ['payment'],
    payload: {
      payment: {
        entity: {
          id: input.paymentId,
          entity: 'payment',
          amount: input.amountPaise,
          currency: input.currency ?? 'INR',
          status: input.status ?? 'captured',
          order_id: input.orderId,
          method: 'upi',
          fee: 2124,
          tax: 324,
        },
      },
    },
    created_at: 1_770_000_000,
  };
}

function refundEvent(input: {
  event?: string;
  refundId: string;
  paymentId: string;
  amountPaise: number;
  currency?: string;
  status?: string;
}) {
  return {
    entity: 'event',
    account_id: 'acc_TEST',
    event: input.event ?? 'refund.processed',
    contains: ['refund', 'payment'],
    payload: {
      refund: {
        entity: {
          id: input.refundId,
          entity: 'refund',
          amount: input.amountPaise,
          currency: input.currency ?? 'INR',
          payment_id: input.paymentId,
          status: input.status ?? 'processed',
        },
      },
    },
    created_at: 1_770_000_100,
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** An order with a payment attempt open against a gateway order id, as checkout leaves it. */
async function orderAwaitingPayment(): Promise<{ order: any; gatewayOrderId: string }> {
  const order = await createOrder(db, null, {
    email: 'buyer@example.in',
    lines: [{ kind: 'product', description: 'Gi', variantId: VARIANT }],
  });
  const gatewayOrderId = `order_${crypto.randomBytes(6).toString('hex')}`;
  await beginPayment(db, order.id, {
    provider: 'razorpay',
    providerOrderId: gatewayOrderId,
    amountPaise: order.totalPaise,
    idempotencyKey: `idem_${crypto.randomBytes(8).toString('hex')}`,
  });
  return { order, gatewayOrderId };
}

const reload = (id: number) =>
  db.select().from(s.orders).where(eq(s.orders.id, id)).limit(1).then((r: any[]) => r[0]);

const eventRow = (eventId: string) =>
  db.select().from(s.paymentEvents).where(eq(s.paymentEvents.eventId, eventId)).limit(1)
    .then((r: any[]) => r[0]);

const paymentsFor = (orderId: number) =>
  db.select().from(s.payments).where(eq(s.payments.orderId, orderId));

const invoicesFor = (orderId: number) =>
  db.select().from(s.invoices).where(eq(s.invoices.orderId, orderId));

const ledgerFor = (orderId: number) =>
  db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.orderId, orderId));

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  __setTestClient(db);

  const [p] = await db.insert(s.products).values({
    sku: 'GI-WEBHOOK', name: 'Shotokan Gi', status: 'active', taxRateBps: 500,
  }).returning({ id: s.products.id });
  const [v] = await db.insert(s.productVariants).values({
    productId: p.id, sku: 'GI-WEBHOOK-150', label: 'Size 150cm',
    pricePaise: 180000, stockQty: 500, status: 'active',
  }).returning({ id: s.productVariants.id });
  VARIANT = v.id;
});

// ─── Signature ──────────────────────────────────────────────────────────────

describe('signature verification', () => {
  it('accepts a correctly signed delivery and marks the order paid', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    const eventId = 'evt_valid_signature';

    const res = await deliver(
      paymentEvent({ paymentId: 'pay_valid_1', orderId: gatewayOrderId, amountPaise: order.totalPaise }),
      { eventId }
    );

    expect(res.status).toBe(200);
    expect((await reload(order.id)).status).toBe('paid');

    const stored = await eventRow(eventId);
    expect(stored.signatureValid).toBe(true);
    expect(stored.processedAt).not.toBeNull();
    expect(stored.processingError).toBeNull();
    // Linked to what it turned out to be about, so reconciliation is one query.
    expect(stored.orderId).toBe(order.id);
  });

  it('refuses a FORGED signature with 400, records it, and fulfils nothing', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    const body = paymentEvent({ paymentId: 'pay_forged', orderId: gatewayOrderId, amountPaise: order.totalPaise });

    // A signature of the right shape and length, made with the wrong secret —
    // the case a length check alone would let through.
    const forged = crypto.createHmac('sha256', 'attacker-guessed-secret')
      .update(JSON.stringify(body)).digest('hex');
    expect(forged).toHaveLength(64);

    const res = await deliver(body, { signature: forged });

    expect(res.status).toBe(400);
    expect((await reload(order.id)).status).toBe('awaiting_payment');

    const rejected = await db.select().from(s.paymentEvents)
      .where(eq(s.paymentEvents.eventType, 'invalid_signature'))
      .orderBy(desc(s.paymentEvents.id)).limit(1);
    expect(rejected[0].signatureValid).toBe(false);
    // The unverified body is NOT stored; its shape is.
    expect(rejected[0].payload.bodySha256).toHaveLength(64);
    expect(JSON.stringify(rejected[0].payload)).not.toContain('pay_forged');
  });

  it('refuses a MISSING signature with 400', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    const res = await deliver(
      paymentEvent({ paymentId: 'pay_unsigned', orderId: gatewayOrderId, amountPaise: order.totalPaise }),
      { signature: null }
    );

    expect(res.status).toBe(400);
    expect((await reload(order.id)).status).toBe('awaiting_payment');

    const rejected = await db.select().from(s.paymentEvents)
      .where(eq(s.paymentEvents.eventType, 'invalid_signature'))
      .orderBy(desc(s.paymentEvents.id)).limit(1);
    expect(rejected[0].payload.signaturePresent).toBe(false);
  });

  it('refuses a body TAMPERED WITH after signing — the amount is not negotiable', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    const honest = JSON.stringify(
      paymentEvent({ paymentId: 'pay_tampered', orderId: gatewayOrderId, amountPaise: order.totalPaise })
    );
    // Same length, so nothing can pass on a length check alone.
    const tampered = honest.replace(`"amount":${order.totalPaise}`, '"amount":000001');
    expect(tampered).not.toBe(honest);

    const res = await deliver(honest, { sent: tampered });

    expect(res.status).toBe(400);
    expect((await reload(order.id)).status).toBe('awaiting_payment');
  });

  it('rejects a body re-serialised from the parsed JSON — the RAW bytes are what is signed', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    const body = paymentEvent({ paymentId: 'pay_reserialised', orderId: gatewayOrderId, amountPaise: order.totalPaise });
    const raw = JSON.stringify(body, null, 2);          // what the sender signed
    const reserialised = JSON.stringify(JSON.parse(raw));  // what a careless proxy forwards

    expect(reserialised).not.toBe(raw);
    expect((await deliver(raw, { sent: reserialised })).status).toBe(400);
    // And the same bytes, unmodified, verify.
    expect((await deliver(raw)).status).toBe(200);
  });

  it('never returns or echoes the webhook secret', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    const res = await deliver(
      paymentEvent({ paymentId: 'pay_secret_check', orderId: gatewayOrderId, amountPaise: order.totalPaise })
    );
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('reports a MISSING SECRET as 503, not as a forged request', async () => {
    // Told apart deliberately: 400 on every delivery would fill Razorpay's
    // dashboard with "signature failed" and hide that nobody set the variable.
    const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    try {
      const { order, gatewayOrderId } = await orderAwaitingPayment();
      const res = await deliver(
        paymentEvent({ paymentId: 'pay_no_secret', orderId: gatewayOrderId, amountPaise: order.totalPaise })
      );
      expect(res.status).toBe(503);
    } finally {
      process.env.RAZORPAY_WEBHOOK_SECRET = saved;
    }
  });
});

// ─── Idempotency ────────────────────────────────────────────────────────────

describe('idempotency', () => {
  it('turns TEN deliveries of the same event into ONE state transition', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    const body = paymentEvent({ paymentId: 'pay_ten_times', orderId: gatewayOrderId, amountPaise: order.totalPaise });
    const eventId = 'evt_delivered_ten_times';

    const results = [];
    for (let i = 0; i < 10; i++) results.push(await deliver(body, { eventId }));

    // Every delivery is acknowledged — a 5xx would only make Razorpay retry.
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(results.slice(1).every((r) => r.body.note === 'replay')).toBe(true);

    // ONE of everything.
    const events = await db.select().from(s.paymentEvents).where(eq(s.paymentEvents.eventId, eventId));
    expect(events.length).toBe(1);

    expect((await reload(order.id)).status).toBe('paid');
    expect((await invoicesFor(order.id)).length).toBe(1);

    const captured = (await paymentsFor(order.id)).filter((p: any) => p.status === 'captured');
    expect(captured.length).toBe(1);

    // Two income lines (one order line, one gateway fee) plus the receivable.
    const ledger = await ledgerFor(order.id);
    expect(ledger.filter((l: any) => l.account === 'assets.gateway_receivable').length).toBe(1);
    expect(ledger.filter((l: any) => l.account === 'income.product').length).toBe(1);
  });

  it('does not fulfil twice when the SAME capture arrives under two event ids', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    const body = paymentEvent({ paymentId: 'pay_two_ids', orderId: gatewayOrderId, amountPaise: order.totalPaise });

    const first = await deliver(body, { eventId: 'evt_two_ids_a' });
    const second = await deliver(body, { eventId: 'evt_two_ids_b' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // Both events are stored — they are genuinely two deliveries — but the
    // money logic recognised the second as a payment already confirmed.
    expect((await eventRow('evt_two_ids_b')).processingError).toBeNull();
    expect((await invoicesFor(order.id)).length).toBe(1);
    expect((await ledgerFor(order.id)).filter((l: any) => l.account === 'assets.gateway_receivable').length).toBe(1);
  });

  it('keeps a capture and a later refund apart even with no event-id header', async () => {
    // Both events carry the same payment entity. Keying the replay guard on the
    // payment id alone would make the refund look like a replay of the capture
    // and drop it silently — with the money already back in the payer's account.
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    const paymentId = 'pay_no_event_header';

    await deliver(
      paymentEvent({ paymentId, orderId: gatewayOrderId, amountPaise: order.totalPaise }),
      { eventId: null }
    );
    const refund = await deliver(
      refundEvent({ refundId: 'rfnd_no_header', paymentId, amountPaise: order.totalPaise }),
      { eventId: null }
    );

    expect(refund.body.note).not.toBe('replay');
    expect((await reload(order.id)).status).toBe('refunded');
  });
});

// ─── Amount verification ────────────────────────────────────────────────────

describe('amount verification on capture', () => {
  it('refuses to fulfil a capture for the WRONG AMOUNT and raises a finance task', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    const eventId = 'evt_wrong_amount';

    const res = await deliver(
      paymentEvent({ paymentId: 'pay_wrong_amount', orderId: gatewayOrderId, amountPaise: 100 }),
      { eventId }
    );

    // Acknowledged — it is on record — but nothing was given for the money.
    expect(res.status).toBe(200);
    expect((await reload(order.id)).status).toBe('awaiting_payment');
    expect((await invoicesFor(order.id)).length).toBe(0);
    expect((await ledgerFor(order.id)).length).toBe(0);

    const stored = await eventRow(eventId);
    expect(stored.processingError).toMatch(/PAYMENT_AMOUNT_MISMATCH/);
    expect(stored.orderId).toBe(order.id);

    // The attempt itself carries the evidence.
    const attempt = (await paymentsFor(order.id))[0];
    expect(attempt.status).toBe('failed');
    expect(attempt.failureReason).toMatch(/PAYMENT_AMOUNT_MISMATCH/);

    // And a human has been asked to look at it.
    const task = (await db.select().from(o.tasks)
      .where(eq(o.tasks.idempotencyKey, 'razorpay:mismatch:pay_wrong_amount')).limit(1))[0];
    expect(task).toBeTruthy();
    expect(task.assignedRole).toBe('FINANCE_OFFICER');
    expect(task.priority).toBe('urgent');
    expect(task.title).toContain(order.orderNo);
  });

  it('refuses a capture in the WRONG CURRENCY even when the number matches', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    const eventId = 'evt_wrong_currency';

    const res = await deliver(
      paymentEvent({
        paymentId: 'pay_wrong_currency', orderId: gatewayOrderId,
        amountPaise: order.totalPaise, currency: 'USD',
      }),
      { eventId }
    );

    expect(res.status).toBe(200);
    expect((await reload(order.id)).status).toBe('awaiting_payment');
    expect((await eventRow(eventId)).processingError).toMatch(/PAYMENT_AMOUNT_MISMATCH/);
    expect((await invoicesFor(order.id)).length).toBe(0);
  });

  it('raises a finance exception for a capture that matches no MMAKF order', async () => {
    const eventId = 'evt_unmatched';
    const res = await deliver(
      paymentEvent({ paymentId: 'pay_orphan', orderId: 'order_never_seen', amountPaise: 500000 }),
      { eventId }
    );

    expect(res.status).toBe(200);
    expect((await eventRow(eventId)).processingError).toMatch(/PAYMENT_UNMATCHED/);
    const task = (await db.select().from(o.tasks)
      .where(eq(o.tasks.idempotencyKey, 'razorpay:unmatched:pay_orphan')).limit(1))[0];
    expect(task).toBeTruthy();
    expect(task.assignedRole).toBe('FINANCE_OFFICER');
  });

  it('raises ONE task however many times the bad capture is redelivered', async () => {
    const { gatewayOrderId } = await orderAwaitingPayment();
    const body = paymentEvent({ paymentId: 'pay_repeat_mismatch', orderId: gatewayOrderId, amountPaise: 42 });

    for (let i = 0; i < 3; i++) await deliver(body, { eventId: `evt_repeat_mismatch_${i}` });

    const tasks = await db.select().from(o.tasks)
      .where(eq(o.tasks.idempotencyKey, 'razorpay:mismatch:pay_repeat_mismatch'));
    expect(tasks.length).toBe(1);
  });
});

// ─── Event types ────────────────────────────────────────────────────────────

describe('event types', () => {
  it('records payment.authorized without fulfilling — held is not taken', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    const res = await deliver(
      paymentEvent({
        event: 'payment.authorized', paymentId: 'pay_authorized',
        orderId: gatewayOrderId, amountPaise: order.totalPaise, status: 'authorized',
      }),
      { eventId: 'evt_authorized' }
    );

    expect(res.status).toBe(200);
    expect((await reload(order.id)).status).toBe('awaiting_payment');
    expect((await paymentsFor(order.id))[0].status).toBe('authorized');
    expect((await invoicesFor(order.id)).length).toBe(0);
  });

  it('records payment.failed against the attempt', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    await deliver(
      paymentEvent({
        event: 'payment.failed', paymentId: 'pay_failed',
        orderId: gatewayOrderId, amountPaise: order.totalPaise, status: 'failed',
      }),
      { eventId: 'evt_failed' }
    );

    expect((await paymentsFor(order.id))[0].status).toBe('failed');
    expect((await reload(order.id)).status).toBe('awaiting_payment');
  });

  it('STORES an unknown event type and ignores it — never rejects it', async () => {
    // Razorpay adds event types. Rejecting one we do not act on would report a
    // failure to the dashboard for something that is not a failure.
    const eventId = 'evt_unknown_type';
    const res = await deliver(
      {
        entity: 'event', event: 'payment.dispute.created', contains: ['dispute'],
        payload: { dispute: { entity: { id: 'disp_1', amount: 189000 } } },
        created_at: 1_770_000_500,
      },
      { eventId }
    );

    expect(res.status).toBe(200);
    const stored = await eventRow(eventId);
    expect(stored.eventType).toBe('payment.dispute.created');
    expect(stored.processedAt).not.toBeNull();
    expect(stored.processingError).toBeNull();
    expect(stored.payload.payload.dispute.entity.id).toBe('disp_1');
  });

  it('completes a refund, posts it to the ledger, and moves the order', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    await deliver(
      paymentEvent({ paymentId: 'pay_to_refund', orderId: gatewayOrderId, amountPaise: order.totalPaise }),
      { eventId: 'evt_refund_capture' }
    );

    const res = await deliver(
      refundEvent({ refundId: 'rfnd_full', paymentId: 'pay_to_refund', amountPaise: order.totalPaise }),
      { eventId: 'evt_refund_processed' }
    );

    expect(res.status).toBe(200);
    expect((await reload(order.id)).status).toBe('refunded');

    const refund = (await db.select().from(s.refunds)
      .where(eq(s.refunds.providerRefundId, 'rfnd_full')).limit(1))[0];
    expect(refund.status).toBe('completed');
    expect(refund.amountPaise).toBe(order.totalPaise);

    const ledger = await ledgerFor(order.id);
    expect(ledger.filter((l: any) => l.account === 'income.refunds').length).toBe(1);

    // Redelivery settles nothing a second time.
    const again = await deliver(
      refundEvent({ refundId: 'rfnd_full', paymentId: 'pay_to_refund', amountPaise: order.totalPaise }),
      { eventId: 'evt_refund_processed_again' }
    );
    expect(again.body.note).toMatch(/already settled/);
    expect((await ledgerFor(order.id)).filter((l: any) => l.account === 'income.refunds').length).toBe(1);
  });

  it('records refund.failed without touching the order', async () => {
    const { order, gatewayOrderId } = await orderAwaitingPayment();
    await deliver(
      paymentEvent({ paymentId: 'pay_refund_fails', orderId: gatewayOrderId, amountPaise: order.totalPaise }),
      { eventId: 'evt_refund_fail_capture' }
    );

    await deliver(
      refundEvent({
        event: 'refund.failed', refundId: 'rfnd_failed', paymentId: 'pay_refund_fails',
        amountPaise: order.totalPaise, status: 'failed',
      }),
      { eventId: 'evt_refund_failed' }
    );

    const refund = (await db.select().from(s.refunds)
      .where(eq(s.refunds.providerRefundId, 'rfnd_failed')).limit(1))[0];
    expect(refund.status).toBe('failed');
    // The money never went back, so the order is still paid.
    expect((await reload(order.id)).status).toBe('paid');
  });
});

// ─── Wiring ─────────────────────────────────────────────────────────────────

describe('middleware exemption', () => {
  it('lists this path as signature-authenticated', () => {
    // A server-to-server delivery carries no Origin. Without the exemption the
    // CSRF middleware refuses every webhook with 403 and the failure looks like
    // Razorpay's problem.
    const middleware = readFileSync('src/middleware.ts', 'utf8');
    const list = middleware.slice(
      middleware.indexOf('SIGNATURE_AUTHENTICATED = ['),
      middleware.indexOf('];', middleware.indexOf('SIGNATURE_AUTHENTICATED = ['))
    );
    expect(list).toContain("'/api/payments/razorpay/webhook'");
  });

  it('is a POST-only route with prerendering off', () => {
    expect(typeof (route as any).POST).toBe('function');
    expect((route as any).GET).toBeUndefined();
    expect((route as any).prerender).toBe(false);
  });
});
