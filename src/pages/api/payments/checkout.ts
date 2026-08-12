// Open a checkout: create the order, then ask the provider for a payment.
//
// The client names WHAT it is buying. It never sends a price — every amount is
// looked up server-side from the catalogue or the published fee schedule.

import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { isConfigured, db } from '@/db';
import { createOrder, beginPayment, OrderError } from '@/db/orders';
import { activeProvider, PaymentProviderError } from '@/lib/payments';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { clientIp } from '@/lib/session';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const ALLOWED_KINDS = new Set([
  'product', 'membership', 'affiliation', 'event_entry',
  'grading', 'course', 'certificate', 'donation',
]);

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'checkout', 10, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  // §70: report the real state rather than rendering a checkout that cannot work.
  if (!isConfigured()) {
    return json({ error: 'Online payment is not available on this deployment yet.', code: 'no_database' }, 503);
  }
  const provider = activeProvider();
  if (!provider) {
    return json({ error: 'No payment method is configured. Contact the federation office.', code: 'no_provider' }, 503);
  }

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > 32 * 1024) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.lines)) {
    return json({ error: 'Invalid request' }, 400);
  }

  // Whitelist what a client may say about a line. Anything else — a price, a
  // tax rate, a discount — is dropped before it reaches the pricing code.
  const lines = body.lines.slice(0, 50).map((l: any) => ({
    kind: ALLOWED_KINDS.has(l?.kind) ? l.kind : 'other',
    description: typeof l?.description === 'string' ? l.description.slice(0, 300) : '',
    quantity: Number.isInteger(l?.quantity) ? l.quantity : 1,
    variantId: Number.isInteger(l?.variantId) ? l.variantId : undefined,
    feeCode: typeof l?.feeCode === 'string' ? l.feeCode.slice(0, 80) : undefined,
    refType: typeof l?.refType === 'string' ? l.refType.slice(0, 40) : undefined,
    refId: Number.isInteger(l?.refId) ? l.refId : undefined,
    // A donation is the one case where the payer chooses the amount; the
    // pricing code accepts this field only for that kind.
    unitPricePaise: l?.kind === 'donation' && Number.isInteger(l?.amountPaise) ? l.amountPaise : undefined,
  }));

  try {
    const order = await createOrder(db(), null, {
      buyerName: typeof body.name === 'string' ? body.name : undefined,
      email: typeof body.email === 'string' ? body.email : undefined,
      phone: typeof body.phone === 'string' ? body.phone : undefined,
      shipTo: body.shipTo && typeof body.shipTo === 'object' && !Array.isArray(body.shipTo) ? body.shipTo : null,
      lines,
    });

    const idempotencyKey = crypto.randomUUID();
    const providerOrder = await provider.createOrder({
      amountPaise: order.totalPaise,
      currency: order.currency,
      reference: order.orderNo,
      customer: {
        name: order.buyerName ?? undefined,
        email: order.email ?? undefined,
        phone: order.phone ?? undefined,
      },
      notes: { orderNo: order.orderNo },
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
      // Out of stock and unpublished fees are the customer's business; the rest
      // are reported plainly without leaking internals.
      const status = err.code === 'out_of_stock' ? 409 : 400;
      return json({ error: err.message, code: err.code }, status);
    }
    if (err instanceof PaymentProviderError) {
      console.error('[checkout] provider failure', err.message, clientIp(request));
      return json({ error: 'The payment provider could not be reached. Please try again.', code: 'provider_error' }, 502);
    }
    console.error('[checkout] unexpected', err);
    return json({ error: 'Could not start checkout' }, 500);
  }
};
