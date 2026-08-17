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
//    else's shop is the whole act; each one is gated inside marketplace.ts
//    against the seller's own scope, and refuses self-review. The name of that
//    check is deliberately not written anywhere in this file — a route that can
//    name a permission check is a route that is one edit away from making one.)
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
// The marketplace platform (migration 0029). Same construction as `mkt` above:
// every one of these modules holds its own authorisation, scoping, state
// machine, reason requirements and audit writes, and nothing below re-decides
// any of it.
import * as reg from '@/db/seller-registry';
import * as cat from '@/db/catalogue';
import * as inv from '@/db/inventory';
import * as so from '@/db/seller-orders';
import * as fin from '@/db/marketplace-finance';
import * as ret from '@/db/returns';

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
 * IT NEVER MULTIPLIES A DECIMAL BY A HUNDRED. Measured in this repository's own
 * Node: ₹19.99 through that arithmetic is 1998.9999999999998 and ₹8.20 is
 * 819.9999999999999, each of which truncates to a paisa less than the seller
 * asked for. ₹450.50 and ₹1,799.99 happen to come out exact — a fact about
 * those two numbers in binary, not a rule, and a price column needs a rule.
 * Here the rupees and the paise are taken out of the decimal string as DIGITS
 * and read once, so no arithmetic is ever performed on a fractional value and
 * the result is exact for every input this accepts.
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

  // '450' and '50' are joined as text and read as one integer. Nothing here
  // scales anything, so there is no rounding rule to get wrong and none to
  // disagree with a second copy of it elsewhere.
  return Number(m[1] + (m[2] ?? '').padEnd(2, '0'));
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

/**
 * The same rule, for the other amounts the platform acts carry.
 *
 * ONE FUNCTION, PARAMETERISED BY FIELD NAME, rather than six copies of
 * `priceMinorFromBody`. Six copies is six chances for one of them to gain a
 * `* 100` during a refactor, and the whole point of rupeesToPaise() is that
 * there is exactly one grammar for a price in this surface.
 *
 * Each refuses a `*Minor` field for the same reason `priceMinor` is refused: a
 * caller that could send paise directly is a caller that has its own
 * conversion, and two conversions is two rounding rules.
 */
function minorFrom(b: Body, rupeeKey: string, minorKey: string, what: string): number {
  if (b[minorKey] !== undefined) {
    throw new InputError(
      `This endpoint takes ${what} in rupees as \`${rupeeKey}\`. Paise are computed on the server, ` +
      'in one place, so that the conversion cannot differ between callers.'
    );
  }
  const minor = rupeesToPaise(b[rupeeKey]);
  if (minor === null) {
    throw new InputError(
      `Enter ${what} in rupees — for example 450.50. Digits, and at most two decimal places.`
    );
  }
  return minor;
}

const amountMinorFromBody = (b: Body) => minorFrom(b, 'amountRupees', 'amountMinor', 'the amount');
const refundMinorFromBody = (b: Body) => minorFrom(b, 'refundRupees', 'refundMinor', 'the refund');
const penaltyMinorFromBody = (b: Body) => minorFrom(b, 'penaltyRupees', 'penaltyMinor', 'the penalty');
const flatMinorFromBody = (b: Body) => minorFrom(b, 'flatRupees', 'flatMinor', 'the flat charge');

/**
 * A payout adjustment, which is the ONE amount here that may be negative.
 *
 * `rupeesToPaise()` deliberately refuses a minus sign — a negative PRICE is
 * always an error and letting one through is how a basket total is reduced by a
 * caller. An adjustment is the opposite case: reducing what a seller is owed is
 * the ordinary use, so the sign is read separately and applied here, and the
 * magnitude still goes through the one conversion.
 */
function signedAmountMinorFromBody(b: Body): number {
  const raw = String(b.amountRupees ?? '').trim();
  const negative = raw.startsWith('-');
  const magnitude = minorFrom(
    { ...b, amountRupees: negative ? raw.slice(1) : raw },
    'amountRupees', 'amountMinor', 'the adjustment',
  );
  return negative ? -magnitude : magnitude;
}

/** A whole number that may be negative — a stock correction, and only that. */
function signedInt(b: Body, k: string): number {
  const n = Number(b[k]);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new InputError(`"${k}" must be a whole number — a stock correction cannot be a fraction of an item.`);
  }
  return n;
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
 * READ IN ONE PLACE, FOR ONE ACT. Photographs are reviewable content: swapping
 * one changes what a reviewer would be looking at exactly as changing the title
 * does. `listing/update` is the act that knows that — it is the act RULE 6 lives
 * behind — so it is the only act that reads media. A media setter of its own, or
 * a second read on create, would be a second write to reviewable content, and
 * the second one is the one that forgets to recompute the content hash.
 *
 * Passed straight through to updateListing(), which normalises and refuses it.
 * Supplying `media` REPLACES the whole set — that is the module's contract, and
 * the portal states it on the form rather than restating it here as a different
 * rule.
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
  // The long form of the same act, and the same reasoning: an account can only
  // ever hold one seller row, so a burst is never legitimate traffic.
  'seller/register': { bucket: 'marketplace-apply', limit: 5, windowSeconds: 3600 },
  // Checkout is the one act here that RESERVES STOCK and allocates an order
  // number before any money is involved. A loop against it holds a seller's
  // entire inventory for forty-five minutes at a time, which is a denial of
  // service against the seller rather than against this server — so it is
  // limited more tightly than editing, and separately from it.
  'checkout': { bucket: 'marketplace-checkout', limit: 12, windowSeconds: 300 },
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

  // A new item is created with no photographs. They are added on the item's own
  // page, through listing/update, which is where the effect of changing what a
  // reviewer looked at is spelled out and where RULE 6 is applied. Reading media
  // here as well would give reviewable content two ways in, and the portal
  // already tells the seller there is one.
  //
  // Photographs sent to this act are REFUSED, not ignored — the same rule this
  // route applies to a price in the wrong units two functions above. A caller
  // that uploaded three images and got back a listing with none would find out
  // at review, and the seller would be the one waiting.
  'listing/create': (ctx, b) => {
    if (b.media !== undefined) {
      throw new InputError(
        'Photographs are added to an item after it exists, on the item\'s own page, because changing ' +
        'what a reviewer looks at is an edit and is reported as one. Create the item, then add them.'
      );
    }
    return mkt.createListing(db(), ctx, {
      title: str(b, 'title'),
      description: optStr(b, 'description'),
      category: str(b, 'category') as mkt.ListingCategory,
      priceMinor: priceMinorFromBody(b),
      stockQty: b.stockQty === undefined ? 0 : reqInt(b, 'stockQty'),
    });
  },

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
  // record is the entire act. Every one is gated inside marketplace.ts against
  // that seller's own scope, refuses self-review, and requires a recorded
  // reason — none of which is re-implemented, or even named, here.

  'seller/approve': (ctx, b) => mkt.approveSeller(db(), ctx, reqInt(b, 'sellerId'), str(b, 'reason')),
  'seller/reject': (ctx, b) => mkt.rejectSeller(db(), ctx, reqInt(b, 'sellerId'), str(b, 'reason')),
  'seller/suspend': (ctx, b) => mkt.suspendSeller(db(), ctx, reqInt(b, 'sellerId'), str(b, 'reason')),
  'seller/reinstate': (ctx, b) => mkt.reinstateSeller(db(), ctx, reqInt(b, 'sellerId'), str(b, 'reason')),

  'listing/review': (ctx, b) => mkt.reviewListing(db(), ctx, reqInt(b, 'listingId'), {
    decision: str(b, 'decision') as 'approve' | 'reject',
    reason: str(b, 'reason'),
  } as mkt.ListingDecision),

  'listing/delist': (ctx, b) => mkt.delistListing(db(), ctx, reqInt(b, 'listingId'), str(b, 'reason')),

  // ═══════════════════════════════════════════════════════════════════════════
  // THE MARKETPLACE PLATFORM (migration 0029)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // RULE 1 STILL HOLDS, and it is the reason this block can be read quickly:
  // NOT ONE seller-side handler below names a seller. `variant/add`,
  // `stock/receive`, `order/accept`, `return/decide` and every other one
  // resolve the caller's seller row from `ctx.principal.userId` inside their
  // own SQL. A variant id names WHICH item; it never names WHOSE.
  //
  // RULE 2 STILL HOLDS: rupees arrive, `priceMinorFromBody()` converts once.
  //
  // The federation-side handlers DO take ids, because deciding somebody else's
  // record is the entire act. Each is gated in its own module against the
  // seller's scope.

  // ── Registration: the full application ────────────────────────────────────
  //
  // A superset of `seller/apply` above, and deliberately a SECOND act rather
  // than more optional fields on the first. The short form is what an existing
  // dojo uses; this is the one /seller/apply posts, and it creates the frozen
  // submission, the structured addresses and a verification row per check.
  'seller/register': (ctx, b) => reg.registerAsSeller(db(), ctx, {
    sellerType: str(b, 'sellerType') as any,
    businessType: str(b, 'businessType') as any,
    tradingName: str(b, 'tradingName'),
    legalName: optStr(b, 'legalName'),
    brandName: optStr(b, 'brandName'),
    registrationNumber: optStr(b, 'registrationNumber'),
    email: optStr(b, 'email'),
    phone: optStr(b, 'phone'),
    alternatePhone: optStr(b, 'alternatePhone'),
    website: optStr(b, 'website'),
    businessDescription: optStr(b, 'businessDescription'),
    yearsOperating: optInt(b, 'yearsOperating'),
    businessCategory: optStr(b, 'businessCategory'),
    gstin: optStr(b, 'gstin'),
    pan: optStr(b, 'pan'),
    stateUnitId: optInt(b, 'stateUnitId'),
    districtUnitId: optInt(b, 'districtUnitId'),
    dojoId: optInt(b, 'dojoId'),
    addresses: Array.isArray(b.addresses) ? (b.addresses as any[]) : [],
    requestedCategories: Array.isArray(b.requestedCategories) ? (b.requestedCategories as string[]) : null,
    requestedBrands: Array.isArray(b.requestedBrands) ? (b.requestedBrands as string[]) : null,
    expectedMonthlyOrders: optInt(b, 'expectedMonthlyOrders'),
    hasWarehouse: b.hasWarehouse === undefined ? null : Boolean(b.hasWarehouse),
    shipsNationally: b.shipsNationally === undefined ? null : Boolean(b.shipsNationally),
    motivation: optStr(b, 'motivation'),
  }),

  // ── The storefront, which is not the seller ───────────────────────────────
  'store/update': (ctx, b) => reg.updateStore(db(), ctx, {
    ...(b.storeSlug === undefined ? {} : { storeSlug: optStr(b, 'storeSlug') }),
    ...(b.storeTagline === undefined ? {} : { storeTagline: optStr(b, 'storeTagline') }),
    ...(b.storeAbout === undefined ? {} : { storeAbout: optStr(b, 'storeAbout') }),
    ...(b.storeLogoUrl === undefined ? {} : { storeLogoUrl: optStr(b, 'storeLogoUrl') }),
    ...(b.storeSpecialisms === undefined ? {} : {
      storeSpecialisms: Array.isArray(b.storeSpecialisms) ? (b.storeSpecialisms as string[]) : null,
    }),
  }),

  // Closing a shop is NOT a suspension, and this is the act that keeps the two
  // apart. A seller going away for a fortnight must not have to be suspended.
  'store/open': (ctx) => reg.setStoreOpen(db(), ctx, true, null),
  'store/close': (ctx, b) => reg.setStoreOpen(db(), ctx, false, optStr(b, 'reason')),

  // ── Variants. Price in rupees, converted by the one function. ─────────────
  //
  // Adding or repricing a variant RETURNS THE LISTING TO REVIEW — the result
  // carries `returnedToReview` so the seller is told rather than finding out
  // when the item leaves the shop.
  'variant/add': (ctx, b) => cat.addVariant(db(), ctx, reqInt(b, 'listingId'), {
    label: str(b, 'label'),
    priceMinor: priceMinorFromBody(b),
    sellerSku: optStr(b, 'sellerSku'),
    barcode: optStr(b, 'barcode'),
    gtin: optStr(b, 'gtin'),
    attributes: (b.attributes && typeof b.attributes === 'object') ? (b.attributes as any) : null,
    weightGrams: optInt(b, 'weightGrams'),
    sortOrder: optInt(b, 'sortOrder') ?? 0,
  }),

  'variant/update': (ctx, b) => cat.updateVariant(db(), ctx, reqInt(b, 'variantId'), {
    ...(b.label === undefined ? {} : { label: str(b, 'label') }),
    ...(b.priceRupees === undefined && b.priceMinor === undefined ? {} : { priceMinor: priceMinorFromBody(b) }),
    ...(b.sellerSku === undefined ? {} : { sellerSku: optStr(b, 'sellerSku') }),
    ...(b.weightGrams === undefined ? {} : { weightGrams: optInt(b, 'weightGrams') }),
  }),

  // DISCONTINUES, never deletes. An order line points at this row for as long
  // as the order exists.
  'variant/discontinue': (ctx, b) =>
    cat.discontinueVariant(db(), ctx, reqInt(b, 'variantId'), str(b, 'reason')),

  // ── Inventory ─────────────────────────────────────────────────────────────
  'location/create': (ctx, b) => inv.createLocation(db(), ctx, {
    code: str(b, 'code'),
    name: str(b, 'name'),
    kind: (optStr(b, 'kind') ?? 'warehouse') as any,
    addressLine: optStr(b, 'addressLine'),
    city: optStr(b, 'city'),
    district: optStr(b, 'district'),
    state: optStr(b, 'state'),
    postcode: optStr(b, 'postcode'),
    contactName: optStr(b, 'contactName'),
    contactPhone: optStr(b, 'contactPhone'),
    priority: optInt(b, 'priority') ?? 100,
    acceptsReturns: b.acceptsReturns === undefined ? false : Boolean(b.acceptsReturns),
  }),

  'stock/receive': (ctx, b) => inv.receiveStock(db(), ctx, {
    variantId: reqInt(b, 'variantId'),
    locationId: reqInt(b, 'locationId'),
    qty: reqInt(b, 'qty'),
    reason: optStr(b, 'reason'),
  }),

  // A manual correction, and it REQUIRES a reason — an unexplained stock change
  // is indistinguishable from a loss nobody reported. The requirement lives in
  // inventory.ts; this route does not restate it, it simply passes what came.
  'stock/adjust': (ctx, b) => inv.adjustStock(db(), ctx, {
    variantId: reqInt(b, 'variantId'),
    locationId: reqInt(b, 'locationId'),
    delta: signedInt(b, 'delta'),
    reason: str(b, 'reason'),
  }),

  'stock/count': (ctx, b) => inv.recordStockCount(db(), ctx, {
    variantId: reqInt(b, 'variantId'),
    locationId: reqInt(b, 'locationId'),
    countedQty: reqInt(b, 'countedQty'),
    note: optStr(b, 'note'),
  }),

  'stock/lowrule': (ctx, b) => inv.setLowStockRule(db(), ctx, {
    variantId: optInt(b, 'variantId'),
    threshold: reqInt(b, 'threshold'),
    notifyEmail: optStr(b, 'notifyEmail'),
  }),

  // ── Checkout ──────────────────────────────────────────────────────────────
  //
  // The cart names WHAT and HOW MANY. There is no price field on CartLine, so
  // a tampered price is not rejected — it has nowhere to go. Every figure is
  // resolved from `listing_variants` server-side.
  'checkout': (ctx, b) => so.checkout(db(), ctx, {
    lines: Array.isArray(b.lines)
      ? (b.lines as any[]).map((l) => ({
          variantId: Number(l?.variantId),
          quantity: Number(l?.quantity),
        }))
      : [],
    buyerName: optStr(b, 'buyerName'),
    email: optStr(b, 'email'),
    phone: optStr(b, 'phone'),
    personId: optInt(b, 'personId'),
    shipTo: (b.shipTo && typeof b.shipTo === 'object') ? (b.shipTo as any) : null,
    eventId: optInt(b, 'eventId'),
  }),

  // ── Fulfilment. The seller's own orders, resolved from the session. ───────
  'order/accept': (ctx, b) => so.acceptSellerOrder(db(), ctx, reqInt(b, 'sellerOrderId')),
  'order/pack': (ctx, b) => so.markPacked(db(), ctx, reqInt(b, 'sellerOrderId')),

  // TRACKING IS OPTIONAL AND NOTHING IS FABRICATED HERE. A consignment with no
  // tracking number is recorded as one; the result says `trackingRecorded`
  // so the surface can state it plainly rather than showing a dead link.
  'order/ship': (ctx, b) => so.shipSellerOrder(db(), ctx, reqInt(b, 'sellerOrderId'), {
    carrier: optStr(b, 'carrier'),
    service: optStr(b, 'service'),
    trackingNumber: optStr(b, 'trackingNumber'),
    trackingUrl: optStr(b, 'trackingUrl'),
    weightGrams: optInt(b, 'weightGrams'),
    packageCount: optInt(b, 'packageCount') ?? 1,
    fromLocationId: optInt(b, 'fromLocationId'),
  }),

  'order/delivered': (ctx, b) =>
    so.markDelivered(db(), ctx, reqInt(b, 'sellerOrderId'), { deliveredTo: optStr(b, 'deliveredTo') }),

  'order/cancel': (ctx, b) => so.cancelSellerOrder(
    db(), ctx, reqInt(b, 'sellerOrderId'), str(b, 'reason'),
    (optStr(b, 'by') ?? 'seller') as 'buyer' | 'seller' | 'federation',
  ),

  // ── Shipping configuration ────────────────────────────────────────────────
  'return-policy/set': (ctx, b) => ret.setReturnPolicy(db(), ctx, {
    windowDays: optInt(b, 'windowDays'),
    returnShippingPaidBy: (optStr(b, 'returnShippingPaidBy') ?? null) as any,
    conditionRequirements: optStr(b, 'conditionRequirements'),
    exchangeOffered: b.exchangeOffered === undefined ? null : Boolean(b.exchangeOffered),
    nonReturnable: Boolean(b.nonReturnable),
    nonReturnableReason: optStr(b, 'nonReturnableReason'),
    // Only the federation may set the floor, and setReturnPolicy asserts it.
    marketplaceFloor: Boolean(b.marketplaceFloor),
  }),

  // ── Returns ───────────────────────────────────────────────────────────────
  'return/request': (ctx, b) => ret.requestReturn(db(), ctx, {
    sellerOrderId: reqInt(b, 'sellerOrderId'),
    reason: str(b, 'reason'),
    reasonDetail: optStr(b, 'reasonDetail'),
    remedySought: (optStr(b, 'remedySought') ?? 'refund') as 'refund' | 'exchange',
    items: Array.isArray(b.items)
      ? (b.items as any[]).map((i) => ({
          orderLineId: Number(i?.orderLineId),
          quantity: Number(i?.quantity),
          condition: i?.condition,
        }))
      : [],
  }),

  'return/decide': (ctx, b) => ret.decideReturn(db(), ctx, reqInt(b, 'returnRequestId'), {
    approve: Boolean(b.approve),
    reason: str(b, 'reason'),
    returnToLocationId: optInt(b, 'returnToLocationId'),
  }),

  'return/inspect': (ctx, b) => ret.inspectReturn(db(), ctx, reqInt(b, 'returnRequestId'), {
    locationId: reqInt(b, 'locationId'),
    items: Array.isArray(b.items)
      ? (b.items as any[]).map((i) => ({
          returnItemId: Number(i?.returnItemId),
          receivedQty: Number(i?.receivedQty),
          sellableQty: Number(i?.sellableQty),
          damagedQty: Number(i?.damagedQty),
          result: i?.result,
          notes: i?.notes ?? null,
        }))
      : [],
  }),

  'return/refund': (ctx, b) => ret.refundReturn(db(), ctx, reqInt(b, 'returnRequestId'), {
    amountMinor: b.amountRupees === undefined && b.amountMinor === undefined
      ? null : amountMinorFromBody(b),
    fundedBy: (optStr(b, 'fundedBy') ?? 'seller') as 'seller' | 'platform',
    reason: str(b, 'reason'),
  }),

  // ── Disputes ──────────────────────────────────────────────────────────────
  'dispute/raise': (ctx, b) => ret.raiseDispute(db(), ctx, {
    sellerOrderId: reqInt(b, 'sellerOrderId'),
    kind: str(b, 'kind') as any,
    summary: str(b, 'summary'),
    returnRequestId: optInt(b, 'returnRequestId'),
  }),

  'dispute/respond': (ctx, b) =>
    ret.respondToDispute(db(), ctx, reqInt(b, 'disputeId'), { response: str(b, 'response') }),

  // A PENALTY IS NEVER COMPUTED. Whatever the deciding officer enters, with its
  // own separately stated reason — required by decideDispute(), not here.
  'dispute/decide': (ctx, b) => ret.decideDispute(db(), ctx, reqInt(b, 'disputeId'), {
    outcome: str(b, 'outcome') as any,
    reason: str(b, 'reason'),
    refundMinor: b.refundRupees === undefined && b.refundMinor === undefined
      ? null : refundMinorFromBody(b),
    refundFundedBy: (optStr(b, 'refundFundedBy') ?? 'seller') as 'seller' | 'platform',
    penaltyMinor: b.penaltyRupees === undefined && b.penaltyMinor === undefined
      ? null : penaltyMinorFromBody(b),
    penaltyReason: optStr(b, 'penaltyReason'),
  }),

  'report/create': (ctx, b) => ret.reportProblem(db(), ctx, {
    sellerOrderId: reqInt(b, 'sellerOrderId'),
    orderLineId: optInt(b, 'orderLineId'),
    kind: str(b, 'kind'),
    detail: str(b, 'detail'),
  }),

  // ═══════════════════════════════════════════════════════════════════════════
  // THE FEDERATION'S SIDE
  // ═══════════════════════════════════════════════════════════════════════════

  'verification/decide': (ctx, b) => reg.decideVerification(db(), ctx, {
    sellerId: reqInt(b, 'sellerId'),
    check: str(b, 'check') as any,
    status: str(b, 'status') as any,
    reason: optStr(b, 'reason'),
    expiresAt: optStr(b, 'expiresAt') ? new Date(String(b.expiresAt)) : null,
  }),

  'seller/restrict': (ctx, b) => reg.restrictSeller(db(), ctx, reqInt(b, 'sellerId'), {
    categories: Array.isArray(b.categories) ? (b.categories as string[]) : [],
    reason: str(b, 'reason'),
  }),
  'seller/unrestrict': (ctx, b) =>
    reg.liftRestriction(db(), ctx, reqInt(b, 'sellerId'), str(b, 'reason')),

  // ── Badges. THE ONLY WRITE PATH, and no seller can reach it. ──────────────
  //
  // grantBadge() refuses the derived badges outright: granting `verified_seller`
  // by hand would assert a verification that never happened.
  'badge/grant': (ctx, b) => reg.grantBadge(db(), ctx, {
    badge: str(b, 'badge') as any,
    sellerId: optInt(b, 'sellerId'),
    listingId: optInt(b, 'listingId'),
    reason: str(b, 'reason'),
    authority: optStr(b, 'authority'),
  }),
  'badge/revoke': (ctx, b) => reg.revokeBadge(db(), ctx, reqInt(b, 'grantId'), str(b, 'reason')),

  // ── Brands ────────────────────────────────────────────────────────────────
  //
  // A seller CLAIMS; the federation VERIFIES. `brand/claim` does not take a
  // status — claimBrandAuthorisation() always writes 'claimed', so there is no
  // request shape in which a seller asserts their own verification.
  'brand/claim': (ctx, b) => reg.claimBrandAuthorisation(db(), ctx, {
    brandId: reqInt(b, 'brandId'),
    relationship: str(b, 'relationship') as any,
    scope: optStr(b, 'scope'),
    issuer: optStr(b, 'issuer'),
    issuerContact: optStr(b, 'issuerContact'),
    referenceNumber: optStr(b, 'referenceNumber'),
    validFrom: optStr(b, 'validFrom'),
    validTo: optStr(b, 'validTo'),
  }),
  'brand/decide': (ctx, b) => reg.decideBrandAuthorisation(db(), ctx, reqInt(b, 'authorisationId'), {
    status: str(b, 'status') as 'verified' | 'rejected' | 'revoked',
    reason: str(b, 'reason'),
  }),

  // ── Catalogue governance ──────────────────────────────────────────────────
  'taxonomy/adopt': (ctx) => cat.adoptProposedTaxonomy(db(), ctx),

  // Quarantine: ONE column, and the item leaves every public surface at once
  // while its orders, reviews and revisions survive.
  'listing/quarantine': (ctx, b) =>
    cat.quarantineListing(db(), ctx, reqInt(b, 'listingId'), str(b, 'reason')),
  'listing/unquarantine': (ctx, b) =>
    cat.liftQuarantine(db(), ctx, reqInt(b, 'listingId'), str(b, 'reason')),

  'flag/raise': (ctx, b) => cat.raiseListingFlag(db(), ctx, reqInt(b, 'listingId'), {
    kind: str(b, 'kind') as any,
    detail: str(b, 'detail'),
  }),
  'flag/decide': (ctx, b) => cat.decideListingFlag(db(), ctx, reqInt(b, 'flagId'), {
    status: str(b, 'status') as 'upheld' | 'dismissed',
    reason: str(b, 'reason'),
    actionTaken: optStr(b, 'actionTaken'),
  }),

  'authenticity/open': (ctx, b) => cat.openAuthenticityCase(db(), ctx, {
    sellerId: reqInt(b, 'sellerId'),
    listingId: optInt(b, 'listingId'),
    brandId: optInt(b, 'brandId'),
    complainantKind: str(b, 'complainantKind') as any,
    complainantName: optStr(b, 'complainantName'),
    complainantContact: optStr(b, 'complainantContact'),
    orderId: optInt(b, 'orderId'),
    allegation: str(b, 'allegation'),
    quarantineListing: Boolean(b.quarantineListing),
  }),
  'authenticity/decide': (ctx, b) => cat.decideAuthenticityCase(db(), ctx, reqInt(b, 'caseId'), {
    status: str(b, 'status') as 'upheld' | 'dismissed',
    decision: str(b, 'decision'),
  }),

  // ── Commission. `marketplace:commission`, which no seller holds. ──────────
  'commission/rule': (ctx, b) => fin.createCommissionRule(db(), ctx, {
    code: str(b, 'code'),
    label: str(b, 'label'),
    description: optStr(b, 'description'),
    sellerId: optInt(b, 'sellerId'),
    sellerTier: optStr(b, 'sellerTier'),
    sellerType: optStr(b, 'sellerType'),
    categoryId: optInt(b, 'categoryId'),
    listingId: optInt(b, 'listingId'),
    campaignCode: optStr(b, 'campaignCode'),
    contractRef: optStr(b, 'contractRef'),
    priority: optInt(b, 'priority') ?? 100,
  }),

  // DRAFT. `chargedOnShipping` and `chargedOnTax` are read as booleans and
  // draftCommissionVersion() refuses when either is absent — there is no safe
  // default and this route does not supply one.
  'commission/draft': (ctx, b) => fin.draftCommissionVersion(db(), ctx, reqInt(b, 'ruleId'), {
    rateBps: optInt(b, 'rateBps'),
    flatMinor: b.flatRupees === undefined && b.flatMinor === undefined ? null : flatMinorFromBody(b),
    minMinor: optInt(b, 'minMinor'),
    maxMinor: optInt(b, 'maxMinor'),
    chargedOnShipping: b.chargedOnShipping as any,
    chargedOnTax: b.chargedOnTax as any,
    commissionTaxRateBps: optInt(b, 'commissionTaxRateBps'),
    effectiveFrom: str(b, 'effectiveFrom'),
    effectiveTo: optStr(b, 'effectiveTo'),
    notes: optStr(b, 'notes'),
  }),

  'commission/publish': (ctx, b) =>
    fin.publishCommissionVersion(db(), ctx, reqInt(b, 'versionId'), str(b, 'authority')),

  'commission/reresolve': (ctx) => fin.reresolveCommissionGaps(db(), ctx),

  // ── Settlement and payout ─────────────────────────────────────────────────
  'settlement/close': (ctx, b) => fin.closeSettlement(db(), ctx, reqInt(b, 'settlementId')),
  'settlement/approve': (ctx, b) =>
    fin.approveSettlement(db(), ctx, reqInt(b, 'settlementId'), optStr(b, 'note')),
  'settlement/accrue': (ctx, b) => fin.accrueSellerOrder(db(), reqInt(b, 'sellerOrderId')),
  'settlement/statement': (ctx, b) => fin.generateStatement(db(), ctx, {
    sellerId: reqInt(b, 'sellerId'),
    settlementId: reqInt(b, 'settlementId'),
    cadence: (optStr(b, 'cadence') ?? 'monthly') as 'daily' | 'weekly' | 'monthly',
  }),

  'payout/create': (ctx, b) => fin.createPayout(db(), ctx, reqInt(b, 'settlementId')),
  'payout/paid': (ctx, b) => fin.markPayoutPaid(db(), ctx, reqInt(b, 'payoutId'), {
    providerPayoutId: optStr(b, 'providerPayoutId'),
    utr: optStr(b, 'utr'),
  }),

  // The function through which a person's income is reduced. Requires a reason
  // and records an approver; adjustPayable() enforces both.
  'payout/adjust': (ctx, b) => fin.adjustPayable(db(), ctx, {
    sellerId: reqInt(b, 'sellerId'),
    kind: str(b, 'kind') as any,
    amountMinor: signedAmountMinorFromBody(b),
    reason: str(b, 'reason'),
    authority: optStr(b, 'authority'),
    disputeId: optInt(b, 'disputeId'),
  }),
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
  // ── The platform's own refusals of AUTHORITY (0029) ──────────────────────
  //
  // Every one of these means "this is not yours", and each is 403 rather than
  // 404 ONLY because the caller is a seller being told about their own account.
  // The isolation errors below — not_your_order and its siblings — are 404, on
  // purpose: they are returned when a seller asks about somebody else's row,
  // and a 403 there would confirm that the id exists.
  'closed_by_federation',
  'derived_badge',       // a badge that must come from evidence, not a grant
]);

const NOT_FOUND = new Set([
  'unknown_seller', 'unknown_listing',
  'unknown_variant', 'unknown_case', 'unknown_flag', 'unknown_brand',
  'unknown_rule', 'unknown_version', 'unknown_settlement', 'unknown_payout',
  'unknown_seller_order', 'unknown_return', 'unknown_dispute', 'unknown_item',
  'unknown_authorisation', 'no_stock_record',
  // THE ISOLATION ERRORS. 404 and not 403, deliberately — see above. A seller
  // asking about another seller's order gets the same answer as one asking
  // about an order that does not exist, because distinguishing them tells an
  // attacker which ids are real.
  'not_your_order', 'not_your_variant', 'not_your_listing',
  'not_your_location', 'not_your_return', 'not_your_dispute',
]);

const CONFLICT = new Set([
  'already_applied', 'bad_transition',
  'already_decided', 'already_published', 'already_paid',
  'duplicate_location', 'slug_taken', 'last_variant',
  // Stock the buyer cannot have. 409 rather than 400: nothing about the
  // REQUEST was wrong — the world changed underneath it, and a client may
  // reasonably retry with a smaller quantity.
  'insufficient_stock', 'stock_taken',
  // Money the federation has not been told how to handle. Also a conflict with
  // the world rather than a bad request.
  'unresolved_commission', 'no_verified_account', 'not_closed', 'not_approved',
  'not_open', 'nothing_payable', 'window_closed', 'non_returnable',
]);

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
