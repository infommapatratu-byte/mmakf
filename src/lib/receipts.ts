// Payment receipts: one email (and one inbox entry for a known person) per paid order.
//
// WHY NOT THROUGH THE DOMAIN-EVENT FEED. ORDER_PAID is catalogued with a
// 'confidential' floor, and the notifications consumer drains only up to
// 'member', so a receipt routed through the feed would be stepped over and never
// sent. A receipt is the buyer's own record of their own payment; it is queued
// directly, addressed to the order's own email (and the person, when there is
// one), and deduplicated on notifications.dedupe_key — a unique column — so a
// redelivered webhook, a replayed event or a retried cron can never send two.
//
// IT NEVER THROWS INTO THE PAYMENT PATH. The money is already recorded when this
// runs; failing to queue a receipt must not turn a captured payment into a 500
// that Razorpay retries. Failures are logged and reported to the caller.

import { eq } from 'drizzle-orm';
import * as s from '@/db/schema';
import { isUniqueViolation } from '@/db/pgerror';
import { render } from '@/lib/email-templates';
import { formatINR } from '@/db/fees';
import { log } from '@/lib/observability';

type DB = any;

export interface ReceiptResult {
  queued: number;
  deduplicated: number;
  skipped?: string;
}

function paidOnIST(d: Date | string | null | undefined): string {
  const date = d ? new Date(d) : new Date();
  return date.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }) + ' IST';
}

/** Queue the receipt for one order. Safe to call any number of times. */
export async function queuePaymentReceipt(db: DB, orderId: number): Promise<ReceiptResult> {
  const order = (await db.select().from(s.orders).where(eq(s.orders.id, orderId)).limit(1))[0];
  if (!order) return { queued: 0, deduplicated: 0, skipped: 'no such order' };
  if (!order.paidAt) return { queued: 0, deduplicated: 0, skipped: 'order is not paid' };

  const invoice = (await db.select().from(s.invoices).where(eq(s.invoices.orderId, orderId)).limit(1))[0] ?? null;
  const person = order.personId
    ? (await db.select().from(s.persons).where(eq(s.persons.id, order.personId)).limit(1))[0] ?? null
    : null;

  const recipientEmail: string | null = order.email || person?.email || null;
  const fullName = person?.fullName || order.buyerName || 'Member';
  const values = {
    fullName,
    orderNo: order.orderNo,
    amount: formatINR(Number(order.totalPaise)),
    paidOn: paidOnIST(order.paidAt),
    invoiceNo: invoice?.invoiceNo ?? 'issued with your order',
  };
  const rendered = render('payment_receipt', values);
  const linkUrl = invoice?.invoiceNo ? `/my/invoice/${encodeURIComponent(invoice.invoiceNo)}` : '/my/orders';

  const result: ReceiptResult = { queued: 0, deduplicated: 0 };
  const channels: Array<'email' | 'in_app'> = [];
  if (recipientEmail || order.personId) channels.push('email');
  if (order.personId) channels.push('in_app');
  if (!channels.length) return { ...result, skipped: 'order has no email and no person' };

  for (const channel of channels) {
    try {
      await db.insert(s.notifications).values({
        personId: order.personId ?? null,
        userId: null,
        channel,
        title: rendered.subject,
        body: rendered.text,
        linkUrl,
        recipientEmail: channel === 'email' ? recipientEmail : null,
        recipientName: fullName,
        template: 'payment_receipt',
        payload: values as any,
        topic: rendered.topic,
        priority: 'high',
        dedupeKey: `receipt:order:${orderId}:${channel}`,
        status: 'queued',
      });
      result.queued++;
    } catch (err) {
      if (isUniqueViolation(err)) { result.deduplicated++; continue; }
      throw err;
    }
  }
  return result;
}

/** The webhook's entry point: never throws, always logs. */
export async function queuePaymentReceiptSafely(db: DB, orderId: number): Promise<void> {
  try {
    const r = await queuePaymentReceipt(db, orderId);
    log.info('receipts.queued', { orderId, ...r });
  } catch (err: any) {
    log.warn('receipts.failed', { orderId, error: String(err?.message ?? err).slice(0, 300) });
  }
}
