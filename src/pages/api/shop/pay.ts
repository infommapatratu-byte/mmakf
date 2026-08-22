/**
 * POST /api/shop/pay — begin payment for a marketplace order that already exists.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS ENDPOINT HAD TO EXIST FOR THE MARKETPLACE TO TAKE MONEY AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * /api/payments/checkout does BOTH halves in one call: it creates an order with
 * createOrder() and then asks the provider for a payment. That works for the
 * federation's own shop, where the order does not exist until the buyer pays.
 *
 * A marketplace order is different, and deliberately so. so.checkout() has to
 * run FIRST, because it does things that must happen before a payment page
 * opens: it splits the basket into one seller order per seller, reserves stock
 * per line, and freezes the commission. Reserving after the buyer has paid
 * would mean taking money for stock somebody else had meanwhile bought.
 *
 * So the order already exists, awaiting payment, and nothing in the codebase
 * could begin a payment against an EXISTING order id — beginPayment() is
 * exported from src/db/orders.ts and had exactly two callers, both of which had
 * just created the order themselves. The marketplace could create orders and
 * could never be paid for. That is the gap this closes.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHO MAY PAY FOR AN ORDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ONLY THE BUYER, and the check is not "is this caller signed in". An order id
 * is a small integer: without an ownership test, any signed-in visitor could
 * count upwards and open a payment against a stranger's basket, learning its
 * total, and — because the provider is handed the buyer's name, email and phone
 * as customer details — those too.
 *
 * The order is matched on the caller's PERSON record, and where the order
 * carries none, on the email address the account is registered with. Both come
 * from the session. Nothing in the request body identifies the buyer.
 *
 * NO AMOUNT IS ACCEPTED FROM THE CALLER either. beginPayment() refuses a figure
 * that does not equal orders.total_paise, and the figure sent here is read from
 * the order rather than passed in, so there is nothing to tamper with.
 */

import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isConfigured, db } from '@/db';
import * as s from '@/db/schema';
import { beginPayment, OrderError } from '@/db/orders';
import { activeProvider, PaymentProviderError } from '@/lib/payments';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { identify, clientIp } from '@/lib/session';

export const prerender = false;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'shop-pay', 10, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  if (!isConfigured()) {
    return json({ error: 'Online payment is not available on this deployment yet.', code: 'no_database' }, 503);
  }
  const provider = activeProvider();
  if (!provider) {
    return json({
      error: 'No payment method is configured. Contact the federation office.',
      code: 'no_provider',
    }, 503);
  }

  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to pay for this order.', code: 'signed_out' }, 401);

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > 8192) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  const orderId = Number(body?.orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return json({ error: 'Which order?', code: 'bad_input' }, 400);
  }

  const order = (await db().select().from(s.orders).where(eq(s.orders.id, orderId)).limit(1))[0];

  // A stranger's order and a non-existent order answer IDENTICALLY. Telling
  // them apart would make this endpoint an oracle for which order ids are real
  // and how far the marketplace's numbering has got.
  const notYours = () => json({ error: 'No such order.', code: 'not_found' }, 404);
  if (!order) return notYours();

  // ── Ownership, from the session and nowhere else ──────────────────────────
  const userId = identity.principal?.userId ?? null;
  let mine = false;
  if (userId != null) {
    const account = (await db()
      .select({ personId: s.users.personId, email: s.users.email })
      .from(s.users).where(eq(s.users.id, userId)).limit(1))[0];

    if (account?.personId != null && order.personId === account.personId) {
      mine = true;
    } else if (order.personId == null && account?.email && order.email) {
      // An order placed by an account with no person record is identified by
      // the address it was placed under. Compared case-insensitively because
      // that is how createOrder() stores it and how a person types it.
      mine = account.email.trim().toLowerCase() === String(order.email).trim().toLowerCase();
    }
  }
  if (!mine) return notYours();

  if (order.status === 'paid' || order.status === 'fulfilled') {
    return json({ error: 'This order has already been paid.', code: 'already_paid' }, 409);
  }
  if (order.status === 'cancelled' || order.status === 'expired') {
    return json({
      error: 'This order is no longer open. Its stock reservation lapsed and the basket must be placed again.',
      code: 'order_closed',
    }, 409);
  }

  const idempotencyKey = crypto.randomUUID();

  try {
    const providerOrder = await provider.createOrder({
      // FROM THE ORDER, never from the request. beginPayment() would refuse a
      // mismatch anyway; sending the order's own figure means there is no
      // second number for the two to disagree about.
      amountPaise: order.totalPaise,
      currency: order.currency,
      reference: order.orderNo,
      customer: {
        name: order.buyerName ?? undefined,
        email: order.email ?? undefined,
        phone: order.phone ?? undefined,
      },
      notes: { orderNo: order.orderNo, marketplace: 'true' },
      idempotencyKey,
    });

    await beginPayment(db(), order.id, {
      provider: provider.id,
      providerOrderId: providerOrder.providerOrderId,
      amountPaise: order.totalPaise,
      idempotencyKey,
    });

    return json({
      ok: true,
      orderNo: order.orderNo,
      amountPaise: order.totalPaise,
      provider: provider.id,
      // Public checkout parameters only — never a secret.
      checkout: providerOrder.checkout,
    }, 200);
  } catch (err: any) {
    if (err instanceof OrderError) {
      return json({ error: err.message, code: err.code }, err.code === 'already_paid' ? 409 : 400);
    }
    if (err instanceof PaymentProviderError) {
      console.error('[shop/pay] provider failure', err.message, clientIp(request));
      return json({
        error: 'The payment provider could not be reached. Your order is still held — please try again.',
        code: 'provider_error',
      }, 502);
    }
    console.error('[shop/pay] unexpected', err);
    return json({ error: 'Could not start the payment. Nothing was charged.' }, 500);
  }
};
