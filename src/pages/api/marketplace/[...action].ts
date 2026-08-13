// The marketplace write path — sellers, listings, and the two decisions MMAKF
// makes about them.
//
// ONE ROUTE, MANY ACTS, NO LOCAL POLICY. Every branch below is a thin dispatch
// onto an exported function in src/db/marketplace.ts. That module holds the
// authorisation, the scoping, the state machine, the reason requirements and
// the audit writes; nothing here re-decides any of it. A second copy of a gate
// is the copy that drifts, and a drifted gate on the marketplace is an item on
// the public site that nobody approved. Same construction as
// /api/governance/[...action].ts.
//
// ─── THE THREE RULES THIS FILE EXISTS TO HOLD ───────────────────────────────
//
// 1. NO CALLER EVER NAMES THE SELLER. There is no `sellerId` and no `userId` in
//    any seller-side handler below. `applyToSell`, `withdrawFromSelling`,
//    `createListing`, `updateListing`, `setListingStock`, `submitListing` and
//    `withdrawListing` all resolve the seller from `ctx.principal.userId`
//    inside their own SQL. A listing id names WHICH item, never WHOSE — the
//    module puts the caller's user id in the WHERE clause, so another seller's
//    listing does not come back as "forbidden", it simply does not exist.
//    (The reviewer-side handlers do take a seller id, because deciding somebody
//    else's shop is the whole act; each one is gated by assertCan() on the
//    seller's own scope, and refuses self-review.)
//
// 2. PRICES ARRIVE IN RUPEES AND ARE CONVERTED HERE, EXACTLY ONCE.
//    `rupeesToPaise()` below is the only rupee→paise conversion in the seller
//    surface, and `priceMinor` is REFUSED if a caller sends it. A second
//    conversion site is a second rounding rule, and two rounding rules on money
//    is how ₹450.50 becomes 450.5 in a column that means paise.
//
// 3. AUTHORISATION IS SERVER-SIDE, ON EVERY ACTION, EVERY TIME. The portal
//    hides controls a seller cannot use. That is a courtesy to the seller, not
//    a control: every handler here is reached with a bare fetch just as easily
//    as with a click, and the refusal that matters is the one marketplace.ts
//    makes after this route has stopped being involved.

import type { APIRoute } from 'astro';
import { identify, clientIp } from '@/lib/session';
import { rateLimit, tooManyRequests } from '@/lib/ratelimit';
import { isConfigured, db } from '@/db';
import { ForbiddenError } from '@/lib/rbac';
import type { AuditContext } from '@/db/federation';
import * as mkt from '@/db/marketplace';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ─── Money: the single rupee→paise conversion ───────────────────────────────

/**
 * A refusal of the seller's INPUT, as opposed to a refusal of the ACT. Kept
 * distinct from MarketplaceError so the two are not reported with each other's
 * wording: "that price is not a price" is a different sentence from "a seller
 * must be approved before listing".
 */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}

/**
 * Rupees, as a human types them, to integer paise.
 *
 * THIS IS THE ONLY PLACE THE CONVERSION HAPPENS. The form collects rupees
 * because that is what a price is to the person setting it; the column holds
 * paise because that is the only representation that survives being multiplied
 * by a quantity. Between those two facts sits exactly one function.
 *
 * IT DOES NOT MULTIPLY BY 100. `450.50 * 100` is 45050.000000000007 in IEEE-754
 * and `1799.99 * 100` is 179998.99999999997 — the second of which truncates to
 * a rupee less than the seller asked for. The rupees and the paise are parsed
 * as separate integers out of the decimal string and combined with integer
 * arithmetic, so the result is exact for every input this accepts.
 *
 * IT REFUSES RATHER THAN ROUNDS. `450.555` is not a price in India, it is a
 * typo or a machine sending the wrong units, and quietly turning it into
 * ₹450.56 hides which. Returns null; the caller reports the refusal.
 *
 * Accepts what a person actually types: `450.50`, `₹450.50`, `1,799`, ` 1799 `.
 */
export function rupeesToPaise(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;

  // A number is turned back into its decimal text and parsed by the same rule,
  // so there is one grammar for a price and not two.
  const text = String(value).trim().replace(/[₹\s,]/g, '');
  if (text === '') return null;

  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;

  const rupees = Number(m[1]);
  const paise = Number((m[2] ?? '').padEnd(2, '0') || '0');
  return rupees * 100 + paise;
}

/**
 * The price for a create/update, in paise.
 *
 * `priceMinor` from a caller is REFUSED outright rather than ignored. Accepting
 * it would give the surface a second way to set a price — one that skips the
 * conversion above — and the second way is the one that is still there after
 * somebody "simplifies" the first.
 */
function priceMinorFromBody(b: Body): number {
  if (b.priceMinor !== undefined) {
    throw new InputError(
      'This endpoint takes a price in rupees as `priceRupees`. Paise are computed on the server, ' +
      'in one place, so that the conversion cannot differ between callers.'
    );
  }
  const minor = rupeesToPaise(b.priceRupees);
  if (minor === null) {
    throw new InputError(
      'Enter the price in rupees — for example 450.50. Digits, and at most two decimal places.'
    );
  }
  return minor;
}

// ─── Body coercion ──────────────────────────────────────────────────────────
//
// Coercion only. Every rule about what a value MEANS — a title is required, a
// category is one of the federation's four, a reason is mandatory, stock is a
// whole number — belongs to marketplace.ts, and its refusal message is what the
// seller is shown.

type Body = Record<string, unknown>;

const str = (b: Body, k: string): string => (typeof b[k] === 'string' ? (b[k] as string) : '');

const optStr = (b: Body, k: string): string | null => {
  const v = b[k];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
};

/** Optional unit id. Unparseable becomes NaN so the module refuses it rather
 *  than this route silently turning "typed nonsense" into "not supplied". */
const optInt = (b: Body, k: string): number | null => {
  const v = b[k];
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
};

/** A required numeric id. NaN is passed through so the module refuses it. */
function reqInt(b: Body, k: string): number {
  const n = Number(b[k]);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
}

/**
 * Media, as the listing form sends it.
 *
 * Passed straight through to updateListing/createListing, which normalise and
 * refuse it. Supplying `media` REPLACES the whole set — that is the module's
 * contract, and the portal states it on the form rather than restating it here
 * as a different rule.
 */
function media(b: Body): mkt.ListingMediaInput[] | undefined {
  if (b.media === undefined) return undefined;
  if (!Array.isArray(b.media)) return [];
  return (b.media as any[]).map((m, i) => ({
    url: String(m?.url ?? '').trim(),
    alt: typeof m?.alt === 'string' && m.alt.trim() ? m.alt.trim() : null,
    sortOrder: Number.isFinite(Number(m?.sortOrder)) ? Math.trunc(Number(m.sortOrder)) : i,
  }));
}

// ─── The dispatch table ─────────────────────────────────────────────────────

type Handler = (ctx: AuditContext, b: Body) => Promise<unknown>;

/**
 * How hard each family of acts may be hammered.
 *
 * Applying to sell is registration-shaped and gets a registration-shaped limit:
 * a signed-in account can only ever hold one seller row, so a burst of these is
 * never legitimate traffic. Editing is the ordinary work of running a shop and
 * gets room to be done.
 */
const BUCKETS: Record<string, { bucket: string; limit: number; windowSeconds: number }> = {
  'seller/apply': { bucket: 'marketplace-apply', limit: 5, windowSeconds: 3600 },
};
const DEFAULT_BUCKET = { bucket: 'marketplace-write', limit: 60, windowSeconds: 60 };

const HANDLERS: Record<string, Handler> = {
  // ── The seller's own record. No caller names the seller. ──────────────────

  'seller/apply': (ctx, b) => mkt.applyToSell(db(), ctx, {
    tradingName: str(b, 'tradingName'),
    contactEmail: optStr(b, 'contactEmail'),
    contactPhone: optStr(b, 'contactPhone'),
    addressLine: optStr(b, 'addressLine'),
    city: optStr(b, 'city'),
    postcode: optStr(b, 'postcode'),
    stateUnitId: optInt(b, 'stateUnitId'),
    districtUnitId: optInt(b, 'districtUnitId'),
    dojoId: optInt(b, 'dojoId'),
    // Captured, never required. Whether MMAKF demands any of these before
    // somebody may sell is a federation decision that has not been made, and
    // refusing here would be this route making it.
    gstin: optStr(b, 'gstin'),
    pan: optStr(b, 'pan'),
    bankAccountName: optStr(b, 'bankAccountName'),
    bankAccountNumber: optStr(b, 'bankAccountNumber'),
    bankIfsc: optStr(b, 'bankIfsc'),
  }),

  'seller/withdraw': (ctx, b) => mkt.withdrawFromSelling(db(), ctx, optStr(b, 'reason')),

  // ── Listings, the seller's side ───────────────────────────────────────────

  'listing/create': (ctx, b) => mkt.createListing(db(), ctx, {
    title: str(b, 'title'),
    description: optStr(b, 'description'),
    category: str(b, 'category') as mkt.ListingCategory,
    priceMinor: priceMinorFromBody(b),
    stockQty: b.stockQty === undefined ? 0 : reqInt(b, 'stockQty'),
    media: media(b) ?? [],
  }),

  // RULE 6 LIVES BEHIND THIS ONE. If the edit moves reviewable content and the
  // listing was approved, updateListing returns it to `submitted`, clears the
  // approved hash, and it leaves the public shop in the same instant. The
  // result carries `returnedToReview` so the seller is TOLD rather than finding
  // out when the item vanishes.
  'listing/update': (ctx, b) => mkt.updateListing(db(), ctx, reqInt(b, 'listingId'), {
    ...(b.title === undefined ? {} : { title: str(b, 'title') }),
    ...(b.description === undefined ? {} : { description: optStr(b, 'description') }),
    ...(b.category === undefined ? {} : { category: str(b, 'category') as mkt.ListingCategory }),
    ...(b.priceRupees === undefined && b.priceMinor === undefined ? {} : { priceMinor: priceMinorFromBody(b) }),
    ...(b.media === undefined ? {} : { media: media(b) }),
  }),

  // Stock is NOT reviewable content and does not disturb an approval — see the
  // reasoning in marketplace.ts. It gets its own act so that selling three gis
  // does not push a listing into the review queue three times in a day.
  'listing/stock': (ctx, b) => mkt.setListingStock(db(), ctx, reqInt(b, 'listingId'), reqInt(b, 'stockQty')),

  'listing/submit': (ctx, b) => mkt.submitListing(db(), ctx, reqInt(b, 'listingId')),

  'listing/withdraw': (ctx, b) => mkt.withdrawListing(db(), ctx, reqInt(b, 'listingId'), optStr(b, 'reason')),

  // ── The federation's side ─────────────────────────────────────────────────
  //
  // These DO take a seller or listing id, because deciding somebody else's
  // record is the entire act. Every one is gated inside marketplace.ts by
  // assertCan() against that seller's own scope, refuses self-review, and
  // requires a recorded reason — none of which is re-implemented here.

  'seller/approve': (ctx, b) => mkt.approveSeller(db(), ctx, reqInt(b, 'sellerId'), str(b, 'reason')),
  'seller/reject': (ctx, b) => mkt.rejectSeller(db(), ctx, reqInt(b, 'sellerId'), str(b, 'reason')),
  'seller/suspend': (ctx, b) => mkt.suspendSeller(db(), ctx, reqInt(b, 'sellerId'), str(b, 'reason')),
  'seller/reinstate': (ctx, b) => mkt.reinstateSeller(db(), ctx, reqInt(b, 'sellerId'), str(b, 'reason')),

  'listing/review': (ctx, b) => mkt.reviewListing(db(), ctx, reqInt(b, 'listingId'), {
    decision: str(b, 'decision') as 'approve' | 'reject',
    reason: str(b, 'reason'),
  } as mkt.ListingDecision),

  'listing/delist': (ctx, b) => mkt.delistListing(db(), ctx, reqInt(b, 'listingId'), str(b, 'reason')),
};

// ─── Status mapping ─────────────────────────────────────────────────────────
//
// Listed explicitly rather than inferred from the spelling of a code, for the
// reason set out in the governance route: a substring rule gets the interesting
// cases wrong, and the interesting cases are the ones an operator reads.

const UNAUTHENTICATED = new Set(['not_signed_in']);

const FORBIDDEN = new Set([
  'forbidden',           // no marketplace:* in this scope
  'self_review',         // deciding your own shop
  'not_a_seller',        // no seller record at all
  'seller_not_approved', // gate one of two
]);

const NOT_FOUND = new Set(['unknown_seller', 'unknown_listing']);

const CONFLICT = new Set(['already_applied', 'bad_transition']);

function statusFor(code: string): number {
  if (UNAUTHENTICATED.has(code)) return 401;
  if (FORBIDDEN.has(code)) return 403;
  if (NOT_FOUND.has(code)) return 404;
  if (CONFLICT.has(code)) return 409;
  return 400;
}

// ─── The route ──────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request, params }) => {
  const action = String(params.action ?? '').replace(/^\/+|\/+$/g, '');
  const limits = BUCKETS[action] ?? DEFAULT_BUCKET;
  const rl = await rateLimit(request, limits.bucket, limits.limit, limits.windowSeconds);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSeconds);

  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, action) ? HANDLERS[action] : undefined;
  if (!handler) return json({ error: 'Unknown marketplace action' }, 404);

  // identify() is the only way this route learns who the caller is, and the
  // only source of the seller identity every handler below resolves.
  const identity = await identify(request.headers.get('cookie'));
  if (!identity) return json({ error: 'Sign in to do this' }, 401);

  if (!isConfigured()) {
    return json({
      error:
        'The federation database is not configured on this deployment, so nothing can be recorded. Set DATABASE_URL.',
      code: 'unavailable',
    }, 503);
  }

  let body: Body;
  try {
    const raw = await request.text();
    if (raw.length > 262144) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(raw);
  } catch {
    return json({ error: 'Invalid request' }, 400);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return json({ error: 'Invalid request' }, 400);
  }

  const ctx: AuditContext = {
    principal: identity.principal,
    ip: clientIp(request),
    reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null,
    authority: identity.shared ? `shared:${identity.via}` : 'user',
  };

  try {
    const result = await handler(ctx, body);
    return json({ ok: true, result }, 200);
  } catch (err: any) {
    if (err instanceof InputError) {
      return json({ error: err.message, code: 'bad_input' }, 400);
    }
    if (err instanceof ForbiddenError) {
      return json({
        error: 'Your credential does not hold the authority this action requires, in this scope.',
        code: 'forbidden',
      }, 403);
    }
    // The module's own sentence, verbatim. It was written to be read by the
    // person who hit it, and rewording it here is how the seller and the office
    // start being told two different things.
    if (mkt.isMarketplaceError(err)) {
      return json({ error: err.message, code: err.code }, statusFor(err.code));
    }
    console.error('[marketplace] unexpected', action, err);
    return json({ error: 'Could not record this. Nothing was changed.' }, 500);
  }
};
