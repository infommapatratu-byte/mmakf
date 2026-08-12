// Order and payment operations (§15-18, §49-52).
//
// The rule this module exists to enforce: an order becomes PAID only when a
// payment is confirmed CAPTURED from the provider's own record, for the amount
// we asked for, in the currency we asked for. Not when the customer returns
// from a payment page, not when the browser says so, not when someone reports
// it on WhatsApp.

import { and, eq, sql, desc } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from './schema';
import { writeAudit, type AuditContext } from './federation';
import { isUniqueViolation } from './pgerror';
import { assertCan, assertCanAnywhere, type Principal } from '@/lib/rbac';
import type { VerifiedPayment } from '@/lib/payments';

type DB = any;

// ─── Money ──────────────────────────────────────────────────────────────────

/**
 * All arithmetic is integer paise. Rupee values only ever appear at the edges,
 * for display, and are formatted from paise — never parsed back into one.
 */
export function paise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function formatINR(amountPaise: number): string {
  const sign = amountPaise < 0 ? '-' : '';
  const abs = Math.abs(amountPaise);
  const rupees = Math.floor(abs / 100);
  const p = String(abs % 100).padStart(2, '0');
  // Indian digit grouping: 12,34,567.89 — not 1,234,567.89.
  const str = String(rupees);
  const last3 = str.slice(-3);
  const rest = str.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${sign}₹${grouped}.${p}`;
}

// ─── Order numbers ──────────────────────────────────────────────────────────

async function nextOrderNo(db: DB, year = new Date().getFullYear()): Promise<string> {
  await db.insert(s.idSequences).values({ prefix: 'ORD', year, next: 1 })
    .onConflictDoNothing({ target: [s.idSequences.prefix, s.idSequences.year] });
  const rows = await db.update(s.idSequences)
    .set({ next: sql`${s.idSequences.next} + 1` })
    .where(and(eq(s.idSequences.prefix, 'ORD'), eq(s.idSequences.year, year)))
    .returning({ next: s.idSequences.next });
  return `MMAKF-ORD-${year}-${String((rows[0]?.next ?? 1) - 1).padStart(6, '0')}`;
}

/**
 * Invoice numbers run in their own unbroken sequence.
 *
 * Deliberately separate from order numbers: orders are abandoned before payment
 * all the time, and a tax document series with gaps in it is a problem at audit.
 */
async function nextInvoiceNo(db: DB, year = new Date().getFullYear()): Promise<string> {
  await db.insert(s.idSequences).values({ prefix: 'INV', year, next: 1 })
    .onConflictDoNothing({ target: [s.idSequences.prefix, s.idSequences.year] });
  const rows = await db.update(s.idSequences)
    .set({ next: sql`${s.idSequences.next} + 1` })
    .where(and(eq(s.idSequences.prefix, 'INV'), eq(s.idSequences.year, year)))
    .returning({ next: s.idSequences.next });
  return `MMAKF/${year}/${String((rows[0]?.next ?? 1) - 1).padStart(5, '0')}`;
}

// ─── Order creation ─────────────────────────────────────────────────────────

export interface DraftLine {
  kind: 'product' | 'membership' | 'affiliation' | 'event_entry' | 'grading' | 'course' | 'certificate' | 'donation' | 'other';
  description: string;
  quantity?: number;
  /** Omit for catalogue/fee lines — the price is then read from the server. */
  unitPricePaise?: number;
  variantId?: number;
  feeCode?: string;
  refType?: string;
  refId?: number;
  taxRateBps?: number;
}

export interface DraftOrder {
  personId?: number | null;
  buyerName?: string;
  email?: string;
  phone?: string;
  lines: DraftLine[];
  shipTo?: Record<string, unknown> | null;
  shippingPaise?: number;
}

export class OrderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
  }
}

/**
 * Create an order, pricing it ENTIRELY on the server.
 *
 * A client-supplied price is never trusted for anything in the catalogue or the
 * fee schedule — that is the oldest e-commerce attack there is. A caller may
 * only name what they are buying; what it costs is looked up here.
 */
export async function createOrder(db: DB, ctx: AuditContext | null, draft: DraftOrder) {
  if (!Array.isArray(draft.lines) || draft.lines.length === 0) {
    throw new OrderError('empty', 'An order must contain at least one line');
  }
  if (draft.lines.length > 50) {
    throw new OrderError('too_many_lines', 'An order may contain at most 50 lines');
  }

  const priced: any[] = [];
  let subtotal = 0;
  let tax = 0;

  for (const line of draft.lines) {
    const qty = Number.isInteger(line.quantity) ? line.quantity! : 1;
    if (qty < 1 || qty > 99) throw new OrderError('bad_quantity', 'Quantity must be between 1 and 99');

    let unit: number;
    let description = String(line.description ?? '').slice(0, 300);
    let taxRateBps = 0;

    if (line.variantId != null) {
      const v = (await db.select().from(s.productVariants).where(eq(s.productVariants.id, line.variantId)).limit(1))[0];
      if (!v || v.status !== 'active') throw new OrderError('unavailable', 'That item is not available');
      if (v.stockQty - v.reservedQty < qty) throw new OrderError('out_of_stock', `Only ${Math.max(0, v.stockQty - v.reservedQty)} left of ${v.label}`);

      const product = (await db.select().from(s.products).where(eq(s.products.id, v.productId)).limit(1))[0];
      unit = v.pricePaise;
      taxRateBps = product?.taxRateBps ?? 0;
      description = `${product?.name ?? 'Item'} — ${v.label}`;
    } else if (line.feeCode) {
      const fee = (await db.select().from(s.feeSchedule)
        .where(and(eq(s.feeSchedule.code, line.feeCode), eq(s.feeSchedule.active, true)))
        .orderBy(desc(s.feeSchedule.effectiveFrom)).limit(1))[0];
      // §68: a fee the federation has not published is not invented here.
      if (!fee) throw new OrderError('fee_not_published', `No published fee for ${line.feeCode}`);
      unit = fee.amountPaise;
      description = fee.label;
    } else if (Number.isInteger(line.unitPricePaise) && line.kind === 'donation') {
      // Donations are the one case where the payer sets the amount.
      unit = line.unitPricePaise!;
      if (unit < 100) throw new OrderError('bad_amount', 'Minimum donation is ₹1');
    } else {
      throw new OrderError('unpriced', `Line "${description}" names no variant, fee code, or permitted amount`);
    }

    if (!Number.isInteger(unit) || unit < 0) throw new OrderError('bad_amount', 'Invalid price');

    const lineTotal = unit * qty;
    const lineTax = Math.round((lineTotal * taxRateBps) / 10_000);
    subtotal += lineTotal;
    tax += lineTax;

    priced.push({
      kind: line.kind, variantId: line.variantId ?? null, feeCode: line.feeCode ?? null,
      refType: line.refType ?? null, refId: line.refId ?? null,
      description, quantity: qty, unitPricePaise: unit,
      taxRateBps, taxPaise: lineTax, totalPaise: lineTotal + lineTax,
    });
  }

  const shipping = Number.isInteger(draft.shippingPaise) ? draft.shippingPaise! : 0;
  const total = subtotal + tax + shipping;
  if (total <= 0) throw new OrderError('bad_total', 'Order total must be positive');

  const orderNo = await nextOrderNo(db);
  const needsShipping = priced.some((l) => l.kind === 'product');

  const [order] = await db.insert(s.orders).values({
    orderNo,
    personId: draft.personId ?? null,
    buyerName: draft.buyerName?.slice(0, 120) ?? null,
    email: draft.email?.trim().toLowerCase().slice(0, 254) ?? null,
    phone: draft.phone?.slice(0, 32) ?? null,
    status: 'awaiting_payment',
    subtotalPaise: subtotal,
    taxPaise: tax,
    shippingPaise: shipping,
    totalPaise: total,
    shipTo: draft.shipTo ?? null,
    fulfilment: needsShipping ? 'pending' : 'not_required',
    // Unpaid orders release their stock reservation after 45 minutes, so an
    // abandoned checkout cannot hold the last item indefinitely.
    expiresAt: new Date(Date.now() + 45 * 60_000),
  }).returning();

  for (const line of priced) {
    await db.insert(s.orderLines).values({ ...line, orderId: order.id });
    if (line.variantId) {
      await db.update(s.productVariants)
        .set({ reservedQty: sql`${s.productVariants.reservedQty} + ${line.quantity}` })
        .where(eq(s.productVariants.id, line.variantId));
    }
  }

  if (ctx) {
    await writeAudit(db, ctx, {
      entityType: 'order', entityId: order.id, action: 'create',
      newValue: { orderNo, totalPaise: total, lines: priced.length },
    });
  }
  return { ...order, lines: priced };
}

// ─── Payment confirmation ───────────────────────────────────────────────────

/**
 * Record a payment attempt against an order.
 *
 * Creating the attempt does NOT pay the order. Only confirmPayment() does, and
 * only on a captured status from the provider.
 */
export async function beginPayment(
  db: DB,
  orderId: number,
  input: { provider: string; providerOrderId: string; amountPaise: number; idempotencyKey: string }
) {
  const order = (await db.select().from(s.orders).where(eq(s.orders.id, orderId)).limit(1))[0];
  if (!order) throw new OrderError('unknown_order', 'Unknown order');
  if (order.status === 'paid' || order.status === 'fulfilled') {
    throw new OrderError('already_paid', 'This order has already been paid');
  }
  if (input.amountPaise !== order.totalPaise) {
    throw new OrderError('amount_mismatch', 'Payment amount does not match the order total');
  }

  const [payment] = await db.insert(s.payments).values({
    orderId,
    provider: input.provider,
    providerOrderId: input.providerOrderId,
    amountPaise: input.amountPaise,
    status: 'created',
    idempotencyKey: input.idempotencyKey,
  }).returning();
  return payment;
}

/**
 * Confirm a payment from a VERIFIED provider record.
 *
 * Three checks before an order is marked paid, all of which have to pass:
 *   1. the payment status is `captured` — authorized is money held, not taken;
 *   2. the amount equals the order total exactly;
 *   3. the currency matches.
 *
 * Idempotent: the provider will deliver the same event more than once, and
 * fulfilling twice is worse than not fulfilling at all.
 */
export async function confirmPayment(
  db: DB,
  ctx: AuditContext | null,
  verified: VerifiedPayment
): Promise<{ orderId: number; alreadyProcessed: boolean } | null> {
  const existing = (await db.select().from(s.payments)
    .where(and(
      eq(s.payments.provider, ctx?.authority ?? ''),
      eq(s.payments.providerPaymentId, verified.providerPaymentId)
    )).limit(1))[0];

  // Match on the provider order id, which is what we stored when checkout began.
  const payment = existing ?? (await db.select().from(s.payments)
    .where(eq(s.payments.providerOrderId, verified.providerOrderId))
    .orderBy(desc(s.payments.id)).limit(1))[0];

  if (!payment) return null;

  if (payment.status === 'captured') {
    return { orderId: payment.orderId, alreadyProcessed: true };   // replay
  }

  const order = (await db.select().from(s.orders).where(eq(s.orders.id, payment.orderId)).limit(1))[0];
  if (!order) return null;

  if (verified.status !== 'captured') {
    await db.update(s.payments).set({
      status: verified.status === 'failed' ? 'failed' : verified.status === 'authorized' ? 'authorized' : 'created',
      providerPaymentId: verified.providerPaymentId,
      failureReason: verified.failureReason ?? null,
      updatedAt: new Date(),
    }).where(eq(s.payments.id, payment.id));
    return { orderId: order.id, alreadyProcessed: false };
  }

  // A captured amount that does not match is never quietly accepted: it is an
  // integration fault or an attack, and a human must look at it.
  if (verified.amountPaise !== order.totalPaise || verified.currency !== order.currency) {
    await db.update(s.payments).set({
      status: 'failed',
      providerPaymentId: verified.providerPaymentId,
      failureReason: `Amount or currency mismatch: provider reported ${verified.amountPaise} ${verified.currency}, order is ${order.totalPaise} ${order.currency}`,
      updatedAt: new Date(),
    }).where(eq(s.payments.id, payment.id));
    if (ctx) {
      await writeAudit(db, ctx, {
        entityType: 'payment', entityId: payment.id, action: 'update',
        oldValue: { expected: order.totalPaise }, newValue: { received: verified.amountPaise, flagged: true },
      });
    }
    throw new OrderError('amount_mismatch', 'Captured amount does not match the order total');
  }

  await db.update(s.payments).set({
    status: 'captured',
    providerPaymentId: verified.providerPaymentId,
    method: verified.method ?? null,
    providerFeePaise: verified.feePaise ?? null,
    providerTaxPaise: verified.taxPaise ?? null,
    capturedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(s.payments.id, payment.id));

  await db.update(s.orders).set({ status: 'paid', paidAt: new Date(), updatedAt: new Date() })
    .where(eq(s.orders.id, order.id));

  // Reserved stock becomes sold stock.
  const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
  for (const line of lines) {
    if (!line.variantId) continue;
    await db.update(s.productVariants).set({
      stockQty: sql`${s.productVariants.stockQty} - ${line.quantity}`,
      reservedQty: sql`GREATEST(0, ${s.productVariants.reservedQty} - ${line.quantity})`,
    }).where(eq(s.productVariants.id, line.variantId));
  }

  await postLedger(db, order, payment, verified);
  await issueInvoice(db, order.id);

  if (ctx) {
    await writeAudit(db, ctx, {
      entityType: 'order', entityId: order.id, action: 'update',
      oldValue: { status: order.status },
      newValue: { status: 'paid', paymentId: payment.id, amountPaise: verified.amountPaise },
    });
  }
  return { orderId: order.id, alreadyProcessed: false };
}

/** Double-entry postings so the treasurer's report derives from one record. */
async function postLedger(db: DB, order: any, payment: any, verified: VerifiedPayment) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));

  for (const line of lines) {
    await db.insert(s.ledgerEntries).values({
      account: `income.${line.kind}`,
      direction: 'credit',
      amountPaise: line.totalPaise,
      orderId: order.id,
      paymentId: payment.id,
      description: line.description,
      occurredOn: today,
    });
  }

  await db.insert(s.ledgerEntries).values({
    account: 'assets.gateway_receivable',
    direction: 'debit',
    amountPaise: order.totalPaise,
    orderId: order.id,
    paymentId: payment.id,
    description: `Payment received — ${order.orderNo}`,
    occurredOn: today,
  });

  // The gateway's cut is an expense, not a discount on income.
  if (verified.feePaise) {
    await db.insert(s.ledgerEntries).values({
      account: 'expense.gateway_fees',
      direction: 'debit',
      amountPaise: verified.feePaise + (verified.taxPaise ?? 0),
      orderId: order.id,
      paymentId: payment.id,
      description: `${payment.provider} fee — ${order.orderNo}`,
      occurredOn: today,
    });
  }
}

/** Issue the receipt, freezing exactly what it says. Idempotent. */
export async function issueInvoice(db: DB, orderId: number) {
  const existing = (await db.select().from(s.invoices).where(eq(s.invoices.orderId, orderId)).limit(1))[0];
  if (existing) return existing;

  const order = (await db.select().from(s.orders).where(eq(s.orders.id, orderId)).limit(1))[0];
  if (!order) throw new OrderError('unknown_order', 'Unknown order');
  const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, orderId));

  const [invoice] = await db.insert(s.invoices).values({
    orderId,
    invoiceNo: await nextInvoiceNo(db),
    // Frozen: a later catalogue or address edit must not alter an issued receipt.
    snapshot: {
      orderNo: order.orderNo,
      buyerName: order.buyerName,
      email: order.email,
      phone: order.phone,
      shipTo: order.shipTo,
      lines: lines.map((l: any) => ({
        description: l.description, quantity: l.quantity,
        unitPricePaise: l.unitPricePaise, taxPaise: l.taxPaise, totalPaise: l.totalPaise,
      })),
      subtotalPaise: order.subtotalPaise,
      taxPaise: order.taxPaise,
      shippingPaise: order.shippingPaise,
      totalPaise: order.totalPaise,
      currency: order.currency,
      issuedAt: new Date().toISOString(),
    },
    verifyToken: crypto.randomBytes(18).toString('base64url'),
  }).returning();

  return invoice;
}

// ─── Webhook intake ─────────────────────────────────────────────────────────

/**
 * Log a provider callback before acting on it, and refuse duplicates.
 *
 * Returns false when this event has been seen before — the replay guard. Every
 * gateway retries webhooks, and fulfilling an order twice is worse than a
 * delayed fulfilment.
 */
export async function recordWebhook(
  db: DB,
  input: { provider: string; eventId: string; eventType: string; signatureValid: boolean; payload: unknown }
): Promise<{ fresh: boolean; id: number | null }> {
  try {
    const [row] = await db.insert(s.paymentEvents).values({
      provider: input.provider,
      eventId: input.eventId,
      eventType: input.eventType,
      signatureValid: input.signatureValid,
      payload: input.payload as any,
    }).returning({ id: s.paymentEvents.id });
    return { fresh: true, id: row.id };
  } catch (err: any) {
    // Drizzle wraps the driver error, so the SQLSTATE is not on the outermost
    // object — see src/db/pgerror.ts. Matching only the wrapper meant the
    // replay guard never fired and every retried webhook raised a 500.
    if (isUniqueViolation(err)) return { fresh: false, id: null };
    throw err;
  }
}

export async function markWebhookProcessed(db: DB, id: number, error?: string) {
  await db.update(s.paymentEvents)
    .set({ processedAt: new Date(), processingError: error ?? null })
    .where(eq(s.paymentEvents.id, id));
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function orderByNumber(db: DB, orderNo: string) {
  const order = (await db.select().from(s.orders).where(eq(s.orders.orderNo, orderNo)).limit(1))[0];
  if (!order) return null;
  const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
  const payments = await db.select().from(s.payments).where(eq(s.payments.orderId, order.id));
  return { ...order, lines, payments };
}

export async function listOrders(db: DB, principal: Principal, limit = 100) {
  assertCanAnywhere(principal, 'finance:read');
  return db.select().from(s.orders).orderBy(desc(s.orders.id)).limit(limit);
}

/**
 * Release reservations held by orders that were never paid, so an abandoned
 * checkout does not hold the last item forever. Safe to run repeatedly.
 */
export async function expireStaleOrders(db: DB): Promise<number> {
  const stale = await db.select().from(s.orders)
    .where(and(eq(s.orders.status, 'awaiting_payment'), sql`${s.orders.expiresAt} < now()`));

  for (const order of stale) {
    const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
    for (const line of lines) {
      if (!line.variantId) continue;
      await db.update(s.productVariants)
        .set({ reservedQty: sql`GREATEST(0, ${s.productVariants.reservedQty} - ${line.quantity})` })
        .where(eq(s.productVariants.id, line.variantId));
    }
    await db.update(s.orders).set({ status: 'expired', updatedAt: new Date() }).where(eq(s.orders.id, order.id));
  }
  return stale.length;
}

/** Refunds require authority and a reason, and never delete the payment (§78). */
export async function requestRefund(
  db: DB,
  ctx: AuditContext,
  input: { paymentId: number; amountPaise: number; reason: string }
) {
  assertCan(ctx.principal, 'finance:write', {});
  if (!input.reason?.trim()) throw new OrderError('no_reason', 'A refund requires a reason');

  const payment = (await db.select().from(s.payments).where(eq(s.payments.id, input.paymentId)).limit(1))[0];
  if (!payment) throw new OrderError('unknown_payment', 'Unknown payment');
  if (payment.status !== 'captured' && payment.status !== 'partially_refunded') {
    throw new OrderError('not_refundable', 'Only a captured payment can be refunded');
  }

  const already = await db.select().from(s.refunds).where(eq(s.refunds.paymentId, payment.id));
  const refunded = already.reduce((sum: number, r: any) => sum + (r.status === 'failed' ? 0 : r.amountPaise), 0);
  if (input.amountPaise <= 0 || refunded + input.amountPaise > payment.amountPaise) {
    throw new OrderError('over_refund', 'Refund exceeds the amount captured');
  }

  const [refund] = await db.insert(s.refunds).values({
    paymentId: payment.id,
    orderId: payment.orderId,
    amountPaise: input.amountPaise,
    reason: input.reason.trim(),
    status: 'requested',
    requestedByUserId: ctx.principal.userId ?? null,
  }).returning();

  await writeAudit(db, { ...ctx, reason: input.reason }, {
    entityType: 'refund', entityId: refund.id, action: 'create',
    newValue: { paymentId: payment.id, amountPaise: input.amountPaise },
  });
  return refund;
}
