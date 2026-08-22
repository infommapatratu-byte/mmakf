/**
 * POST /api/shop/price — what this marketplace basket costs, priced by the server.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS IS SEPARATE FROM /api/marketplace/*
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * That route requires a session for every one of its forty actions, and it is
 * right to: applying to sell, editing a listing, shipping an order and taking
 * a payment all belong to an account. Checkout does too — an order belongs to
 * somebody.
 *
 * SEEING A TOTAL DOES NOT. A visitor who has put two gis in a basket and wants
 * to know what they come to has not yet decided to buy anything, and answering
 * "sign in first" is how a shop loses the sale it was about to make. Routing
 * the display price through the authenticated endpoint would also have meant a
 * signed-out basket page rendering an empty box with no explanation.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT DISCLOSES, WHICH IS NOTHING NEW
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Prices, tax and carriage for items that are ALREADY public. cartPreview()
 * resolves through publicListingPredicate() — the same five conditions the shop
 * index, the product page and checkout itself use — so a draft, quarantined or
 * suspended-seller item is `unavailable` here exactly as it is absent from the
 * shop. An id cannot be guessed into a price for something nobody approved.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * AND WHAT IT DOES NOT DO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * IT WRITES NOTHING. No order, no seller order, no reservation, no audit row.
 * That is the whole reason cartPreview() exists as a function separate from
 * checkout(): before it, the only way to learn a basket's total was to call
 * checkout(), which allocates an order number and holds forty-five minutes of
 * stock — so a page that merely displayed a total would have created an order
 * every time somebody looked at it.
 *
 * IT IS NOT THE PRICE ANYBODY IS CHARGED. checkout() re-prices from the same
 * function at the moment the order is created, so a stale tab cannot fix a
 * figure. What this returns is what the catalogue says right now.
 */

import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import { rateLimit } from '@/lib/ratelimit';
import { cartPreview } from '@/db/seller-orders';
import { isMarketplaceError } from '@/db/marketplace';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // A basket is one visitor's, and a price answer is never worth caching:
      // an item can be withdrawn between two requests and the second must say so.
      'Cache-Control': 'no-store',
    },
  });

export const POST: APIRoute = async ({ request }) => {
  // Bounded because it is unauthenticated. Generous enough that adjusting
  // quantities on a basket page never trips it.
  const rl = await rateLimit(request, 'shop-price', 60, 300);
  if (!rl.ok) {
    return json({ error: 'Too many price checks. Try again shortly.', code: 'rate_limited' }, 429);
  }

  if (!isConfigured()) {
    return json({
      error: 'The marketplace is not available on this deployment.',
      code: 'unavailable',
    }, 503);
  }

  let body: any;
  try {
    const raw = await request.text();
    if (raw.length > 65536) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  // The cart names WHAT and HOW MANY, and there is no price field to tamper
  // with. Coerced here rather than trusted: cartPreview() refuses a line whose
  // variant or quantity is not a whole number, and this makes the refusal come
  // from the module rather than from a type error.
  const lines = Array.isArray(body.lines)
    ? (body.lines as any[]).slice(0, 100).map((l) => ({
        variantId: Number(l?.variantId),
        quantity: Number(l?.quantity),
      }))
    : [];

  if (!lines.length) {
    // An empty basket is not an error — it is the ordinary state of a page
    // somebody has just cleared — so it answers with zeros rather than a 400.
    return json({
      ok: true,
      result: {
        sellers: [], subtotalMinor: 0, taxMinor: 0,
        shippingMinor: 0, totalMinor: 0, currency: 'INR',
      },
    });
  }

  try {
    // shipTo is NOT accepted from the browser here. Carriage depends on the
    // destination, and an address typed on the checkout page is collected by
    // the authenticated checkout call rather than by an open endpoint — so this
    // returns the seller's default-zone carriage and the final figure comes
    // from checkout(). A price shown here that ignored a stated address would
    // be a quote MMAKF did not honour.
    const result = await cartPreview(db(), lines, null);
    return json({ ok: true, result });
  } catch (err: any) {
    if (isMarketplaceError(err)) {
      // The module's own sentence, verbatim — it was written for the person who
      // hit it, and "unavailable" in particular tells a buyer exactly why an
      // item has gone.
      return json({ error: err.message, code: err.code }, 400);
    }
    console.error('[api/shop/price] unexpected', err);
    return json({ error: 'The basket could not be priced.' }, 500);
  }
};
