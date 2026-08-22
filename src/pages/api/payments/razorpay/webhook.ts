// POST /api/payments/razorpay/webhook — Razorpay's own account of what happened.
//
// This endpoint is the ONLY thing in the system allowed to say "money was
// taken". The browser returning from checkout is a claim made by a party that
// controls the claim; this is a server-to-server statement signed with a secret
// only Razorpay and this deployment hold.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RAW BODY IS THE WHOLE PROBLEM
// ─────────────────────────────────────────────────────────────────────────────
//
// Razorpay signs the EXACT BYTES it sent. `JSON.parse` followed by
// `JSON.stringify` is not a round trip: it normalises whitespace, can reorder
// nothing but re-emits numbers and unicode escapes in its own style, and drops
// the trailing newline. Any of that changes the HMAC input, and then EVERY
// delivery fails verification — silently, because a failed signature looks
// exactly like an attack. So the body is read once as text, verified against
// those bytes, and only then parsed. Nothing between the socket and the HMAC is
// allowed to touch it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS ROUTE EXISTS ALONGSIDE /api/payments/webhook
// ─────────────────────────────────────────────────────────────────────────────
//
// The generic route dispatches by `?provider=`. Razorpay's dashboard wants one
// fixed URL per integration, and a provider-specific path means the URL an
// operator pastes into the dashboard cannot be pointed at the wrong adapter by
// a query string. Both share the same intake tables and the same replay guard,
// so an event cannot be processed twice by arriving at both doors.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS DELIBERATE HERE
// ─────────────────────────────────────────────────────────────────────────────
//
//  · Invalid or missing signature → 400, NOT PROCESSED, and RECORDED. A stream
//    of these means either an attack or a webhook secret that does not match
//    the dashboard, and both are invisible if rejections are dropped on the
//    floor. The unverified body itself is not stored: it is attacker-controlled
//    data. Its size and digest are, which is enough to see a pattern.
//  · The replay guard is a UNIQUE INDEX (payment_events.provider, event_id),
//    not a SELECT-then-INSERT. Razorpay retries, and two retries can land in
//    two concurrent invocations; a check-then-insert lets both through and
//    fulfils twice. The database refuses the second one.
//  · Once the event is durably stored the answer is ALWAYS 200. A 5xx asks
//    Razorpay to redeliver, and redelivery cannot help: the replay guard would
//    reject it. Processing failures are written onto the event row, where the
//    reconciler and a human can see them, instead of into a retry storm.
//  · The downstream work is NOT detached from the response. On the serverless
//    runtime this deploys to, the process may be frozen the instant the
//    response is flushed, so "ack first, work after" would silently lose the
//    work. Storing the raw event before doing anything is what makes the ack
//    safe: a killed invocation leaves processed_at NULL and the event is picked
//    up again, from a record of what Razorpay actually sent.
//  · Unknown event types are STORED and IGNORED. Razorpay adds event types; an
//    unrecognised one is news, not an error, and rejecting it would make the
//    dashboard show failures for events we simply do not act on.
//
// SECRETS: RAZORPAY_WEBHOOK_SECRET is read for a presence check and handed to
// the adapter for the HMAC. It is never logged, never stored, never returned.

import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { db, isConfigured } from '@/db';
import * as s from '@/db/schema';
import { confirmPayment, federationToday, markWebhookProcessed, recordWebhook } from '@/db/orders';
import { writeAudit, type AuditContext } from '@/db/federation';
import { createTask } from '@/db/tasks';
import { razorpay, type VerifiedPayment } from '@/lib/payments';

export const prerender = false;

const PROVIDER = 'razorpay';

/**
 * A Razorpay event is a few kilobytes. The cap exists so a hostile caller
 * cannot make the function buffer an arbitrary amount of memory before the
 * signature — which is the only thing that makes the body trustworthy — has
 * even been looked at.
 */
const MAX_BODY_BYTES = 1_000_000;

/** The event types this route acts on. Everything else is stored and ignored. */
export const HANDLED_EVENTS = [
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'refund.processed',
  'refund.failed',
] as const;

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/** 200 means "durably recorded", never "fulfilled". */
const ack = (note: string) => json(200, { received: true, note });

/**
 * The principal a webhook acts as.
 *
 * `authority` is what confirmPayment matches payments on, so it must be the
 * provider id. There is no user: nobody at MMAKF pressed anything, and an audit
 * row that named a person would be a lie.
 */
function webhookContext(): AuditContext {
  return {
    principal: { userId: null, label: `${PROVIDER}:webhook`, bindings: [] },
    authority: PROVIDER,
  };
}

/**
 * A processing failure that still knows which order and payment it concerns, so
 * the stored event can be linked to them even though the work did not complete.
 */
class EventFault extends Error {
  readonly orderId: number | null;
  readonly paymentId: number | null;
  constructor(message: string, ids: { orderId?: number | null; paymentId?: number | null } = {}) {
    super(message);
    this.name = 'EventFault';
    this.orderId = ids.orderId ?? null;
    this.paymentId = ids.paymentId ?? null;
  }
}

interface EventOutcome {
  note: string;
  orderId?: number | null;
  paymentId?: number | null;
}

// ─── Identity of an event ───────────────────────────────────────────────────

/**
 * The key the replay guard runs on.
 *
 * `x-razorpay-event-id` is what Razorpay sends and is unique per DELIVERY GROUP
 * — every retry of one event carries the same value, which is exactly what is
 * wanted.
 *
 * The fallback matters more than it looks. A refund event carries BOTH the
 * refund entity and the payment entity, so keying on the payment id alone would
 * give `payment.captured` and `refund.processed` for one payment the same key —
 * and the second, a genuinely different event, would be swallowed as a replay
 * and the refund would never be applied. The fallback therefore includes the
 * event name and the most specific entity id present, and finally the digest of
 * the body so two different events can never collide.
 */
function gatewayEventId(headers: Record<string, string>, body: any, rawBody: string): string {
  const header = headers['x-razorpay-event-id'];
  if (header) return header.slice(0, 200);

  const refundId = body?.payload?.refund?.entity?.id;
  const paymentId = body?.payload?.payment?.entity?.id;
  const entityId = refundId ?? paymentId;
  const digest = crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
  return `derived:${String(body?.event ?? 'unknown')}:${String(entityId ?? '')}:${digest}`;
}

// ─── Rejections ─────────────────────────────────────────────────────────────

/** The declared event name, for triage only, hard-bounded. */
function declaredEvent(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody);
    const name = parsed?.event;
    return typeof name === 'string' ? name.slice(0, 64) : null;
  } catch {
    return null;
  }
}

/**
 * Record a delivery that failed verification.
 *
 * The event id is unique PER ATTEMPT on purpose. Keying on the body digest
 * would collapse a thousand forged deliveries into one row and hide the very
 * thing this record exists to make visible.
 */
async function recordRejection(rawBody: string, headers: Record<string, string>): Promise<void> {
  try {
    await recordWebhook(db(), {
      provider: PROVIDER,
      eventId: `invalid:${Date.now()}:${crypto.randomBytes(8).toString('hex')}`,
      eventType: 'invalid_signature',
      signatureValid: false,
      // NOT the body. It did not verify, so it is unauthenticated input; enough
      // is kept to correlate deliveries and spot a wrong secret.
      payload: {
        bodyBytes: Buffer.byteLength(rawBody, 'utf8'),
        bodySha256: crypto.createHash('sha256').update(rawBody).digest('hex'),
        signaturePresent: Boolean(headers['x-razorpay-signature']),
        eventIdHeader: headers['x-razorpay-event-id'] ?? null,
        declaredEvent: declaredEvent(rawBody),
        at: new Date().toISOString(),
      },
    });
  } catch (err: any) {
    // Recording a rejection must never mask the rejection itself.
    console.error('[razorpay-webhook] could not record a rejected delivery:', String(err?.message ?? err));
  }
}

// ─── What the money was supposed to be ──────────────────────────────────────

interface Expectation {
  payment: any;
  order: any;
  amountPaise: number;
  currency: string;
  /** What the figure was read from, for the exception message. */
  label: string;
}

/**
 * Resolve the MMAKF figure a captured payment must equal.
 *
 * The invoice governs where one exists, because the invoice is the frozen
 * document the payer holds. At capture time there usually is none yet — it is
 * issued as part of confirmation — so the order total is the figure, and it is
 * the same number the invoice will state.
 *
 * The lookup is by our own payment record, never by anything the webhook says
 * about what it is for.
 */
async function expectationFor(dbi: any, verified: VerifiedPayment): Promise<Expectation | null> {
  let payment: any = null;

  if (verified.providerPaymentId) {
    payment = (await dbi.select().from(s.payments)
      .where(and(
        eq(s.payments.provider, PROVIDER),
        eq(s.payments.providerPaymentId, verified.providerPaymentId),
      )).limit(1))[0] ?? null;
  }

  if (!payment && verified.providerOrderId) {
    // The attempt opened at checkout, before Razorpay minted a payment id.
    payment = (await dbi.select().from(s.payments)
      .where(eq(s.payments.providerOrderId, verified.providerOrderId))
      .orderBy(desc(s.payments.id)).limit(1))[0] ?? null;
  }

  if (!payment) return null;

  const order = (await dbi.select().from(s.orders)
    .where(eq(s.orders.id, payment.orderId)).limit(1))[0];
  if (!order) return null;

  const invoice = (await dbi.select().from(s.invoices)
    .where(eq(s.invoices.orderId, order.id)).limit(1))[0];
  const snapshot: any = invoice?.snapshot ?? null;

  const fromInvoice = Number.isInteger(snapshot?.totalPaise);
  return {
    payment,
    order,
    amountPaise: fromInvoice ? Number(snapshot.totalPaise) : Number(order.totalPaise),
    currency: String((fromInvoice ? snapshot.currency : order.currency) ?? 'INR'),
    label: invoice ? `invoice ${invoice.invoiceNo}` : `order ${order.orderNo}`,
  };
}

// ─── Finance exceptions ─────────────────────────────────────────────────────

/**
 * Put a money problem in front of a human.
 *
 * Idempotent by construction: the key is derived from the gateway payment id,
 * so ten redeliveries of one bad capture raise ONE task rather than ten. No due
 * date is invented — MMAKF has agreed no service clock for this, and inventing
 * one would be the system committing the federation to a promise (§ tasks.ts).
 */
async function raiseFinanceException(
  dbi: any,
  ctx: AuditContext,
  input: { key: string; title: string; detail: string; paymentId?: number | null }
): Promise<void> {
  try {
    await createTask(dbi, ctx, {
      title: input.title.slice(0, 200),
      detail: input.detail,
      subjectKind: 'payment',
      subjectId: input.paymentId ?? null,
      assignedRole: 'FINANCE_OFFICER',
      priority: 'urgent',
      dueAt: null,
      idempotencyKey: input.key.slice(0, 200),
    });
  } catch (err: any) {
    // The exception is already on the event row; failing to queue it must not
    // also lose the record that it happened.
    console.error('[razorpay-webhook] could not raise the finance task:', String(err?.message ?? err));
  }
}

// ─── Capture ────────────────────────────────────────────────────────────────

/**
 * A captured payment: the only path that can mark an order paid.
 *
 * The amount is checked BEFORE confirmation, against MMAKF's own figure. A
 * mismatch is never reconciled by adjusting our side to match — that is how a
 * ₹1 payment fulfils a ₹1,800 order. confirmPayment() carries the same guard;
 * this one exists so the webhook can raise the alert and name the document the
 * figure came from.
 */
async function applyCapture(dbi: any, ctx: AuditContext, verified: VerifiedPayment): Promise<EventOutcome> {
  const expected = await expectationFor(dbi, verified);

  if (!expected) {
    await raiseFinanceException(dbi, ctx, {
      key: `${PROVIDER}:unmatched:${verified.providerPaymentId}`,
      title: 'Captured Razorpay payment matches no MMAKF order',
      detail:
        `Razorpay reports ${verified.amountPaise} paise ${verified.currency} captured as payment ` +
        `${verified.providerPaymentId} against gateway order ${verified.providerOrderId || '(none)'}, ` +
        'and no MMAKF payment record matches either identifier. Money may have been taken for ' +
        'something the federation has no record of selling. Reconcile against the Razorpay ' +
        'dashboard before issuing anything.',
    });
    throw new EventFault(
      `PAYMENT_UNMATCHED: no MMAKF payment record for Razorpay payment ${verified.providerPaymentId}`
    );
  }

  const amountWrong = verified.amountPaise !== expected.amountPaise;
  const currencyWrong = verified.currency !== expected.currency;

  if (amountWrong || currencyWrong) {
    const summary =
      `PAYMENT_AMOUNT_MISMATCH: Razorpay captured ${verified.amountPaise} paise ${verified.currency}; ` +
      `${expected.label} is for ${expected.amountPaise} paise ${expected.currency}. Not fulfilled.`;

    // Evidence on the attempt itself, so the mismatch is visible from the order
    // as well as from the event log. A payment already captured is left alone —
    // overwriting a good capture with a later bad event would be the mismatch
    // doing damage rather than being contained.
    if (expected.payment.status !== 'captured') {
      await dbi.update(s.payments).set({
        status: 'failed',
        // (provider, provider_payment_id) is UNIQUE. Only claim the gateway id
        // when the row does not already carry one, or a second bad event for a
        // different payment id would raise a constraint violation here instead
        // of a finance task.
        providerPaymentId: expected.payment.providerPaymentId ?? verified.providerPaymentId,
        failureReason: summary.slice(0, 500),
        updatedAt: new Date(),
      }).where(eq(s.payments.id, expected.payment.id));
    }

    await writeAudit(dbi, ctx, {
      entityType: 'payment',
      entityId: expected.payment.id,
      action: 'update',
      oldValue: { expectedPaise: expected.amountPaise, expectedCurrency: expected.currency, source: expected.label },
      newValue: { receivedPaise: verified.amountPaise, receivedCurrency: verified.currency, fulfilled: false },
    });

    await raiseFinanceException(dbi, ctx, {
      key: `${PROVIDER}:mismatch:${verified.providerPaymentId}`,
      title: `Payment amount mismatch on ${expected.order.orderNo}`,
      detail:
        `${summary}\n\n` +
        `Gateway payment: ${verified.providerPaymentId}\n` +
        `Gateway order:   ${verified.providerOrderId || '(none)'}\n` +
        `MMAKF order:     ${expected.order.orderNo} (id ${expected.order.id})\n\n` +
        'Nothing has been fulfilled and no receipt has been issued. Decide whether to refund ' +
        'the payer or to correct the order, then act deliberately — this must not be cleared ' +
        'by replaying the webhook.',
      paymentId: expected.payment.id,
    });

    throw new EventFault(summary, { orderId: expected.order.id, paymentId: expected.payment.id });
  }

  const outcome = await confirmPayment(dbi, ctx, verified);
  return {
    note: outcome?.alreadyProcessed ? 'payment.captured (already confirmed)' : 'payment.captured',
    orderId: expected.order.id,
    paymentId: expected.payment.id,
  };
}

// ─── Refunds ────────────────────────────────────────────────────────────────

/**
 * Apply a refund outcome reported by the gateway.
 *
 * A refund can be started from the Razorpay dashboard as well as from MMAKF, so
 * an event with no matching request is adopted rather than rejected: the money
 * has moved either way and the federation's books have to say so. What is never
 * done is inventing a reason — the adopted row says plainly where it came from.
 *
 * Idempotent: a refund already settled is left exactly as it is.
 */
async function applyRefund(dbi: any, ctx: AuditContext, body: any, processed: boolean): Promise<EventOutcome> {
  const eventName = processed ? 'refund.processed' : 'refund.failed';
  const entity = body?.payload?.refund?.entity;
  if (!entity?.id) throw new EventFault(`${eventName} carried no refund entity`);

  const providerRefundId = String(entity.id);
  const providerPaymentId = String(entity.payment_id ?? '');
  const amountPaise = Number(entity.amount);
  const currency = String(entity.currency ?? 'INR');

  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new EventFault(`${eventName} for ${providerRefundId} carried a non-integer amount`);
  }
  if (!providerPaymentId) {
    throw new EventFault(`${eventName} for ${providerRefundId} named no payment`);
  }

  const payment = (await dbi.select().from(s.payments)
    .where(and(
      eq(s.payments.provider, PROVIDER),
      eq(s.payments.providerPaymentId, providerPaymentId),
    )).limit(1))[0];

  if (!payment) {
    throw new EventFault(`REFUND_UNMATCHED: no MMAKF payment for Razorpay payment ${providerPaymentId}`);
  }
  if (currency !== payment.currency) {
    throw new EventFault(
      `REFUND_CURRENCY_MISMATCH: refund ${providerRefundId} is in ${currency}, ` +
      `payment ${payment.id} is in ${payment.currency}`,
      { orderId: payment.orderId, paymentId: payment.id }
    );
  }

  let note = '';

  // One transaction: the refund row, the ledger, the payment and the order
  // describe a single fact, and a half-applied refund is a book that does not
  // balance.
  await dbi.transaction(async (tx: any) => {
    let refund = (await tx.select().from(s.refunds)
      .where(and(
        eq(s.refunds.paymentId, payment.id),
        eq(s.refunds.providerRefundId, providerRefundId),
      )).limit(1))[0] ?? null;

    if (!refund) {
      // A refund MMAKF requested, which has not yet been matched to a gateway
      // id. Amount and status both have to agree before adopting it.
      const open = await tx.select().from(s.refunds).where(eq(s.refunds.paymentId, payment.id));
      refund = open.find((r: any) =>
        !r.providerRefundId && r.amountPaise === amountPaise &&
        (r.status === 'requested' || r.status === 'processing')) ?? null;
    }

    if (!refund) {
      [refund] = await tx.insert(s.refunds).values({
        paymentId: payment.id,
        orderId: payment.orderId,
        amountPaise,
        reason: 'Refunded at the gateway; MMAKF holds no refund request for it',
        status: 'requested',
        providerRefundId,
      }).returning();
      note = 'gateway-initiated refund adopted; ';
    }

    if (refund.status === 'completed' || refund.status === 'failed') {
      note += `${eventName} (already settled)`;
      return;
    }

    if (!processed) {
      await tx.update(s.refunds)
        .set({ status: 'failed', providerRefundId })
        .where(eq(s.refunds.id, refund.id));
      note += eventName;
      return;
    }

    await tx.update(s.refunds)
      .set({ status: 'completed', providerRefundId, completedAt: new Date() })
      .where(eq(s.refunds.id, refund.id));

    const order = (await tx.select().from(s.orders)
      .where(eq(s.orders.id, payment.orderId)).limit(1))[0];
    // The federation's own date. A refund posted at 02:00 IST is a refund on
    // that day in India, and /admin/revenue nets it off within a period whose
    // ends are computed in Asia/Kolkata. See federationToday() in src/db/orders.ts.
    const today = federationToday();

    // Double entry, and never by deleting the original postings: the sale
    // happened and the refund happened, and the accounts must show both.
    await tx.insert(s.ledgerEntries).values([
      {
        account: 'income.refunds', direction: 'debit', amountPaise,
        orderId: payment.orderId, paymentId: payment.id, refundId: refund.id,
        description: `Refund ${providerRefundId} — ${order?.orderNo ?? `order ${payment.orderId}`}`,
        occurredOn: today,
      },
      {
        account: 'assets.gateway_receivable', direction: 'credit', amountPaise,
        orderId: payment.orderId, paymentId: payment.id, refundId: refund.id,
        description: `Refund ${providerRefundId} — ${order?.orderNo ?? `order ${payment.orderId}`}`,
        occurredOn: today,
      },
    ]);

    // Whether this was the whole payment is decided from every completed refund
    // against it, not from this one event — three partials make a full refund.
    const all = await tx.select().from(s.refunds).where(eq(s.refunds.paymentId, payment.id));
    const refunded = all.reduce(
      (sum: number, r: any) => sum + (r.status === 'completed' ? r.amountPaise : 0), 0);
    const full = refunded >= payment.amountPaise;
    const state = full ? 'refunded' : 'partially_refunded';

    await tx.update(s.payments).set({ status: state, updatedAt: new Date() })
      .where(eq(s.payments.id, payment.id));
    await tx.update(s.orders).set({ status: state, updatedAt: new Date() })
      .where(eq(s.orders.id, payment.orderId));

    await writeAudit(tx, ctx, {
      entityType: 'refund', entityId: refund.id, action: 'update',
      oldValue: { status: refund.status },
      newValue: { status: 'completed', providerRefundId, amountPaise, orderStatus: state },
    });

    note += `${eventName} (${full ? 'full' : 'partial'})`;
  });

  return { note, orderId: payment.orderId, paymentId: payment.id };
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

/**
 * Act on a VERIFIED event. Exported so the behaviour can be tested without
 * reconstructing an HTTP request for every case.
 *
 * Throwing here does not fail the delivery: the caller has already stored the
 * event and records the fault on it. Throwing is how a fault becomes visible.
 */
export async function applyEvent(
  dbi: any,
  ctx: AuditContext,
  eventType: string,
  body: any,
  payment?: VerifiedPayment
): Promise<EventOutcome> {
  switch (eventType) {
    case 'payment.captured':
      if (!payment) throw new EventFault('payment.captured carried no payment entity');
      return applyCapture(dbi, ctx, payment);

    case 'payment.authorized':
    case 'payment.failed': {
      if (!payment) throw new EventFault(`${eventType} carried no payment entity`);
      // Neither status can fulfil anything: authorized is money held, not taken.
      // confirmPayment records the state against the attempt and stops there.
      const outcome = await confirmPayment(dbi, ctx, payment);
      if (!outcome) return { note: `${eventType} (no MMAKF payment record matches)` };
      return { note: eventType, orderId: outcome.orderId };
    }

    case 'refund.processed':
      return applyRefund(dbi, ctx, body, true);

    case 'refund.failed':
      return applyRefund(dbi, ctx, body, false);

    default:
      // Stored, not rejected. Razorpay adds event types.
      return { note: `stored; ${eventType} is not a type this route acts on` };
  }
}

// ─── The endpoint ───────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  if (!isConfigured()) {
    // No database means the event cannot be durably recorded. 503 asks Razorpay
    // to redeliver, which is the one situation where a retry genuinely helps.
    console.error('[razorpay-webhook] DATABASE_URL is not set; cannot record the event.');
    return json(503, { error: 'Not available' });
  }

  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
    // A missing secret is OUR fault, not a forged request, and must not be
    // reported as one — 400 here would fill the dashboard with "delivery
    // failed" and hide the actual cause. The value itself is never printed.
    console.error('[razorpay-webhook] RAZORPAY_WEBHOOK_SECRET is not set; cannot verify any delivery.');
    return json(503, { error: 'Not available' });
  }

  const declared = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json(413, { error: 'Body too large' });
  }

  // ── THE RAW BODY, FIRST, VERBATIM ────────────────────────────────────────
  // Nothing may parse or re-serialise this before the HMAC is computed over it.
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return json(413, { error: 'Body too large' });
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

  // The adapter owns the HMAC: constant-time comparison with a length check
  // first, over these exact bytes. See src/lib/payments/razorpay.ts.
  const result = razorpay.verifyWebhook(rawBody, headers);

  if (!result.valid) {
    await recordRejection(rawBody, headers);
    return json(400, { error: 'Invalid signature' });
  }

  const body: any = result.raw;
  const eventType = result.eventType;
  const eventId = gatewayEventId(headers, body, rawBody);

  let recorded: { fresh: boolean; id: number | null };
  try {
    recorded = await recordWebhook(db(), {
      provider: PROVIDER,
      eventId,
      eventType,
      signatureValid: true,
      // The verified body, stored whole: a disputed settlement is reconstructed
      // from what Razorpay actually sent, not from our reading of it.
      payload: body,
    });
  } catch (err: any) {
    console.error('[razorpay-webhook] could not record the event:', String(err?.message ?? err));
    return json(503, { error: 'Could not record the event' });
  }

  // The DATABASE rejected this as a duplicate — a unique index, not a lookup,
  // so two concurrent deliveries cannot both get past it.
  if (!recorded.fresh || recorded.id == null) return ack('replay');

  const eventRowId = recorded.id;
  const ctx = webhookContext();

  try {
    const outcome = await applyEvent(db(), ctx, eventType, body, result.payment);
    await linkEvent(eventRowId, outcome.orderId, outcome.paymentId);
    await markWebhookProcessed(db(), eventRowId);
    return ack(outcome.note);
  } catch (err: any) {
    const message = String(err?.message ?? err).slice(0, 500);
    // Not the body, not the secret — the fault only.
    console.error('[razorpay-webhook] processing failed:', message);
    try {
      if (err instanceof EventFault) await linkEvent(eventRowId, err.orderId, err.paymentId);
      await markWebhookProcessed(db(), eventRowId, message);
    } catch (inner: any) {
      console.error('[razorpay-webhook] could not record the failure:', String(inner?.message ?? inner));
    }
    // Still 200: the event is on record with its error, and a redelivery would
    // hit the replay guard and change nothing. The exceptions queue is where
    // this gets resolved, not the retry queue.
    return ack('recorded; processing failed');
  }
};

/** Tie the stored event to what it turned out to be about. */
async function linkEvent(id: number, orderId?: number | null, paymentId?: number | null): Promise<void> {
  if (!orderId && !paymentId) return;
  await db().update(s.paymentEvents)
    .set({ orderId: orderId ?? null, paymentId: paymentId ?? null })
    .where(eq(s.paymentEvents.id, id));
}
