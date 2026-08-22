// The price breakdown, computed on the server, for a basket the client names.
//
// It is a READ. It creates no order, reserves nothing, redeems no discount code
// and takes no money — src/db/orders.ts is the only writer of an order. A buyer
// refreshing this endpoint twenty times changes nothing, which is why it can be
// called on every basket edit without an idempotency key.
//
// WHAT IT REFUSES, AND WHY IT SAYS SO RATHER THAN QUIETLY CORRECTING.
//
// A body carrying a price, a total, a tax, a pricing date or a person id is
// refused with 400 and the offending paths named. The parse would have dropped
// them anyway — CheckoutRequest has no field they could land in — so refusing
// costs nothing in safety and buys something in honesty: a client that sends a
// price is broken or hostile, and both are worth telling somebody about rather
// than papering over with a correct answer.

import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import {
  describeCheckout, isCheckoutError, isPayable, parseCheckoutRequest, priceCheckout,
} from '@/db/checkout';
import { isPriced } from '@/db/fee-catalogue';
import { formatINR } from '@/db/fees';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const rl = await rateLimit(request, 'checkout-breakdown', 30, 60);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  // §70: the real state, rather than a checkout that cannot work.
  if (!isConfigured()) {
    return json({
      error: 'The federation’s fee register is not connected on this deployment, so nothing can be priced here.',
      code: 'no_database',
    }, 503);
  }

  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 16 * 1024) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }

  let parsed;
  try {
    parsed = parseCheckoutRequest(body);
  } catch (err) {
    if (isCheckoutError(err)) return json({ error: err.message, code: err.code }, 400);
    return json({ error: 'Invalid request' }, 400);
  }

  if (parsed.refusedFields.length) {
    return json({
      error:
        'This request carries fields the federation decides for itself. A checkout says WHAT is being bought; ' +
        'what it costs, when it is priced and who is buying are read on the server.',
      code: 'client_supplied_server_field',
      fields: parsed.refusedFields,
    }, 400);
  }

  let quote;
  try {
    // asAt is NOT passed. The pricing date is today, on the server's clock, and
    // there is no route by which a request can move it.
    quote = await priceCheckout(db(), parsed.request);
  } catch (err) {
    if (isCheckoutError(err)) return json({ error: err.message, code: err.code }, 400);
    console.error('[checkout/breakdown] unexpected', err);
    return json({ error: 'The basket could not be priced. Nothing has been charged.' }, 500);
  }

  // Every line the buyer is entitled to see, priced or not. An unpriced line
  // carries `amount: null` and its own notice — never 0, which reads as free.
  const lines = quote.lines.map((l) => ({
    serviceCode: l.serviceCode,
    name: l.name,
    for: l.beneficiaryLabel,
    unitIndex: l.unitIndex,
    unitCount: l.unitCount,
    unit: l.unitOfSale,
    frequency: l.frequency,
    term: l.termLabel,
    amountMinor: isPriced(l.fee) ? l.fee.amountMinor : null,
    amount: isPriced(l.fee) ? formatINR(l.fee.amountMinor) : null,
    notice: isPriced(l.fee) ? null : l.fee.notice,
    detail: l.detail.map((d) => ({
      label: d.label,
      quantity: d.quantity,
      unitAmount: d.unitAmountMinor == null ? null : formatINR(d.unitAmountMinor),
      amount: formatINR(d.amountMinor),
      because: d.because,
    })),
  }));

  if (!isPayable(quote)) {
    return json({
      payable: false,
      reason: quote.reason,
      notice: quote.notice,
      lines,
      // Buyer-facing sentences only. `detail` on a blocker is for operators.
      blocking: quote.blocking.map((b) => ({
        serviceCode: b.serviceCode, for: b.beneficiaryLabel, notice: b.notice,
      })),
      refusedCodes: quote.refusedCodes,
      words: describeCheckout(quote),
    }, 200);
  }

  return json({
    payable: true,
    currency: quote.currency,
    framework: `${quote.frameworkCode} v${quote.frameworkVersion}`,
    pricedOn: quote.asAt,
    lines,
    reductions: quote.reductions.map((r) => ({
      code: r.code,
      label: r.label,
      amountMinor: r.amountMinor,
      amount: formatINR(r.amountMinor),
      because: r.because,
    })),
    subtotalMinor: quote.subtotalMinor,
    subtotal: formatINR(quote.subtotalMinor),
    discountMinor: quote.discountMinor,
    concessionMinor: quote.concessionMinor,
    taxMinor: quote.taxMinor,
    tax: formatINR(quote.taxMinor),
    totalMinor: quote.totalMinor,
    total: formatINR(quote.totalMinor),
    refusedCodes: quote.refusedCodes,
    words: describeCheckout(quote),
  }, 200);
};
