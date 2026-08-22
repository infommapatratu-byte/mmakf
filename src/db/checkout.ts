// The checkout a student or a parent actually walks — and the two questions it
// exists to answer honestly.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT AM I BEING CHARGED FOR, AND WHY IS IT THAT MUCH?
// ─────────────────────────────────────────────────────────────────────────────
//
// Every figure on a checkout page is a claim the federation is making to
// somebody about to hand over money for their child's training. So this module
// produces a BREAKDOWN, never a total: one line per thing bought, with the
// service, what one unit of it is, how often it recurs, how long the payment
// covers, the rule that priced it and the condition that matched, then each
// reduction as its own line with its own reason, then tax where the federation
// has published one, and only then a total that is the sum of what is above it.
//
// A lump sum is not a price. It is a number somebody is asked to trust.
//
// AND THERE IS NO MEMBERSHIP LINE ON IT. A student pays for TRAINING. Nothing
// in this file adds a membership charge, derives one, or reads membership
// standing before pricing — membership is a separate register for coaches,
// officials, examiners and clubs, and it has never been a condition of buying
// training. tests/checkout.test.ts keeps that true by reading this file.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BROWSER NAMES WHAT. THE SERVER DECIDES WHAT IT COSTS.
// ─────────────────────────────────────────────────────────────────────────────
//
// A request may carry a service code, a count, a beneficiary's name, a
// circumstance a fee rule matches on, and discount CODES. It may not carry a
// price, a discount amount, a tax, a total, a currency, a framework, or the
// DATE the price is read on — a client that chooses the pricing date chooses
// last year's cheaper framework, which is the same attack wearing a calendar.
//
// That is enforced twice, and the two are different in kind:
//
//   1. BY CONSTRUCTION. parseCheckoutRequest() builds the server's own request
//      object out of a whitelist. There is no field on CheckoutRequest that
//      could hold a price, so a forged one has nowhere to land however deeply
//      the body nests it. This is the guarantee that does not depend on
//      anybody remembering anything.
//
//   2. BY DETECTION. The same parse walks the raw body and REPORTS every
//      money-, date- and identity-shaped key it found, at any depth, so a
//      caller can refuse the request outright and log it. A client sending a
//      price is either broken or hostile, and both are worth knowing about.
//
// Detection alone would be a filter — and a filter is a promise that somebody
// keeps the list current. Construction alone would be silent. Both, and
// tests/checkout.test.ts submits a forged total through every route and proves
// the computed figure is identical to the one computed without it.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHEN THE FEDERATION HAS NOT PUBLISHED A PRICE
// ─────────────────────────────────────────────────────────────────────────────
//
// The answer is "pricing unavailable — request a quotation", and it is the
// answer for EVERYTHING today, because MMAKF has published no fee framework.
// Not zero, not a remembered price, not the last framework that was in force,
// not a seed value, not a figure the client sent. An unpayable checkout carries
// NO totalMinor PROPERTY AT ALL and throws on any attempt to coerce it to a
// number or a string — the discipline src/db/fee-catalogue.ts applies to one
// fee, applied to a basket.

import {
  activeFramework, computeReduction, formatINR,
  type FeeInputs, type Reduction,
} from '@/db/fees';
import {
  catalogueEntry, feeFor, isPriced,
  type FeeResult, type FeeViewer,
} from '@/db/fee-catalogue';
import { normaliseCode, resolveDiscountCodes, MAX_CODES_PER_REQUEST } from '@/db/discounts';
import { termEndsOn, termFor } from '@/db/entitlements';

type DB = any;

export class CheckoutError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CheckoutError';
    this.code = code;
  }
}

/** Identified by shape, not `instanceof` — see src/lib/calendar.ts for why. */
export function isCheckoutError(err: unknown): err is CheckoutError {
  return Boolean(err)
    && typeof (err as any).code === 'string'
    && (err as any).name === 'CheckoutError';
}

// ─── Limits ─────────────────────────────────────────────────────────────────

/** Distinct services in one basket. */
export const MAX_ITEMS = 20;
/**
 * Units across the whole basket.
 *
 * Each unit is priced by its OWN call to the fee engine — see the note on
 * expansion below — so this also bounds how many framework evaluations one
 * anonymous request can ask for, and it is capped for that reason as much as
 * for the buyer's.
 */
export const MAX_UNITS = 20;
/** Circumstances a buyer may declare per item. */
export const MAX_SELECTIONS = 12;

const SERVICE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
const AUDIENCE = /^[a-z][a-z_]{1,31}$/;
const SELECTION_KEY = /^[a-zA-Z][a-zA-Z0-9_]{1,39}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ─── What a client may never send ───────────────────────────────────────────

/**
 * Keys the SERVER owns, whatever a request says.
 *
 * Three families, listed together because they are one idea: a figure the buyer
 * supplied is a figure the buyer chose.
 *
 *   MONEY     — an amount, a discount, a tax, a total, a currency. The oldest
 *               e-commerce attack there is.
 *   TIME      — the date the price is read on, the framework, a validity. A
 *               buyer who picks the pricing date picks the cheapest framework
 *               the federation ever published, and nothing about the request
 *               looks tampered with afterwards.
 *   IDENTITY  — who the buyer is, and which quotation they are paying. Those
 *               come from the session and from the quotation's own acceptance
 *               record (src/db/quote-to-order.ts), never from a body.
 *
 * Compared after lower-casing and stripping `_` and `-`, so `amount_minor`,
 * `AmountMinor` and `amount-minor` are one key. `discountCodes` normalises to
 * `discountcodes`, which is not in the set — a buyer may absolutely send codes;
 * what they may not send is what a code is worth.
 */
const SERVER_OWNED_KEYS: ReadonlySet<string> = new Set([
  // money
  'amount', 'amounts', 'amountminor', 'amountpaise', 'amountinr',
  'price', 'prices', 'priceminor', 'pricepaise', 'unitprice', 'unitpriceminor', 'unitpricepaise',
  'paise', 'minor', 'rupees', 'inr',
  'subtotal', 'subtotalminor', 'total', 'totalminor', 'totalpaise', 'grandtotal', 'nettotal',
  'tax', 'taxes', 'taxminor', 'taxpaise', 'taxrate', 'taxratebps', 'gst', 'cgst', 'sgst', 'igst',
  'discount', 'discountminor', 'discountamount', 'discountpercent', 'discountpaise',
  'reduction', 'reductionminor', 'rebate', 'concession', 'concessionminor',
  'fee', 'fees', 'feeminor', 'feeamount', 'cost', 'charge', 'rate', 'shipping', 'shippingpaise',
  'currency', 'adjustment', 'adjustmentminor',
  // time
  'asat', 'asof', 'asatdate', 'pricedate', 'effectivefrom', 'effectiveto',
  'validuntil', 'validfrom', 'backdate',
  'framework', 'frameworkid', 'frameworkcode', 'frameworkversion',
  // identity
  'personid', 'institutionid', 'userid', 'principal', 'role', 'roles',
  'quoteid', 'quoteversionid', 'orderid', 'paymentid',
]);

const normaliseKey = (k: string): string => k.toLowerCase().replace(/[_-]/g, '');

/**
 * Every server-owned key in a request body, at any depth, as a path.
 *
 * Reported rather than stripped. Stripping is what the whitelist already does,
 * silently and by construction; this exists so a surface can say NO and write
 * it down. A body arriving with `items[0].amountPaise` in it is a fact about
 * either a broken client or somebody probing, and both deserve a 400 rather
 * than a quietly correct price.
 */
export function findServerOwnedFields(body: unknown, maxDepth = 6): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > maxDepth || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.slice(0, 100).forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const here = path ? `${path}.${k}` : k;
      if (SERVER_OWNED_KEYS.has(normaliseKey(k))) found.push(here);
      walk(v, here, depth + 1);
    }
  };
  walk(body, '', 0);
  return [...new Set(found)].sort();
}

/** Fail-loud form of the above, for callers that want to refuse rather than report. */
export function assertNoServerOwnedFields(body: unknown): void {
  const found = findServerOwnedFields(body);
  if (found.length) {
    throw new CheckoutError(
      'client_supplied_server_field',
      `This request carries ${found.length} field(s) the federation decides for itself: ${found.join(', ')}. ` +
      'A checkout says WHAT is being bought. What it costs, when it is priced and who is buying are read on the server.'
    );
  }
}

// ─── The request, after the whitelist ───────────────────────────────────────

/**
 * Quantity keys the FEE ENGINE multiplies by.
 *
 * Stripped from a buyer's selections without exception, and the reason is
 * subtle enough to be worth writing down. `participants`, `sessions`,
 * `campuses` and the rest are the numbers a per-unit fee rule multiplies its
 * unit amount by. A buyer who sets `travelKm: 0` deletes a travel charge; one
 * who sets `sessions: 1` buys a term of training at the price of a lesson.
 * Neither looks like tampering — they are counts, and a count is the one thing
 * a client is supposed to be allowed to send.
 *
 * A self-serve checkout therefore declares ONE participant per line and nothing
 * else. A request that genuinely needs a count — a school, a camp, a course
 * with a session plan — is a QUOTATION, prepared by the office through
 * issueQuote() in src/db/fees.ts and paid through src/db/quote-to-order.ts at
 * the figure that was accepted.
 */
const ENGINE_QUANTITY_KEYS: readonly string[] = [
  'participants', 'sessions', 'batches', 'campuses', 'instructors', 'weeks', 'travelKm',
  'serviceId', 'serviceCode',
];

export interface CheckoutItem {
  readonly serviceCode: string;
  /** How many of this service. Each unit becomes its own line — never a multiply. */
  readonly quantity: number;
  /** Whose line this is. A child's name, for the family case. Display only. */
  readonly beneficiaryLabel: string | null;
  /** Circumstances a fee rule may match on. CLAIMS, not prices. */
  readonly selections: Readonly<Record<string, string | number | boolean>>;
}

export interface CheckoutRequest {
  readonly items: readonly CheckoutItem[];
  /** Codes only. What a code is worth is resolved by src/db/discounts.ts. */
  readonly discountCodes: readonly string[];
  /** The kind of customer, as claimed. Fee rules discriminate on it. */
  readonly audience: string | null;
}

export interface ParsedCheckoutRequest {
  readonly request: CheckoutRequest;
  /** Server-owned keys the body carried. Empty on a well-behaved request. */
  readonly refusedFields: readonly string[];
  /** Strings that were not usable as codes at all — empty, malformed, over the cap. */
  readonly rejectedCodes: readonly string[];
}

/**
 * Build the server's own request out of a body it does not trust.
 *
 * Throws on structure it cannot make sense of; REPORTS the fields it refuses.
 * The distinction matters: a basket with no items is a request nobody can
 * answer, while a basket carrying a forged total is a request that can be
 * answered perfectly well — and the answer must not be the forged number.
 */
export function parseCheckoutRequest(body: unknown): ParsedCheckoutRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CheckoutError('bad_request', 'A checkout request is an object naming what is being bought.');
  }
  const b = body as Record<string, unknown>;
  const refusedFields = findServerOwnedFields(b);

  const rawItems = b.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new CheckoutError('no_items', 'A checkout must name at least one service.');
  }
  if (rawItems.length > MAX_ITEMS) {
    throw new CheckoutError('too_many_items', `A basket may name at most ${MAX_ITEMS} services.`);
  }

  const items: CheckoutItem[] = [];
  let units = 0;

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new CheckoutError('bad_item', 'Each basket line is an object naming a service.');
    }
    const r = raw as Record<string, unknown>;

    const serviceCode = String(r.serviceCode ?? '').trim();
    if (!SERVICE_CODE.test(serviceCode)) {
      throw new CheckoutError('bad_service_code', 'A basket line names a service by its catalogue code.');
    }

    const quantity = Number.isInteger(r.quantity) ? (r.quantity as number) : 1;
    if (quantity < 1 || quantity > MAX_UNITS) {
      throw new CheckoutError('bad_quantity', `A quantity is a whole number between 1 and ${MAX_UNITS}.`);
    }
    units += quantity;
    if (units > MAX_UNITS) {
      throw new CheckoutError('too_many_units', `A basket may hold at most ${MAX_UNITS} units in total.`);
    }

    const label = typeof r.beneficiaryLabel === 'string' ? r.beneficiaryLabel.trim().slice(0, 80) : '';

    // ── Selections ──
    //
    // Primitives only, and no engine quantity key (see above). An object or an
    // array here would be a condition form matchConditions() does not
    // understand, and it treats what it cannot understand as NOT matching — so
    // accepting one would silently narrow a rule rather than fail.
    const selections: Record<string, string | number | boolean> = {};
    const rawSel = r.selections;
    if (rawSel != null) {
      if (typeof rawSel !== 'object' || Array.isArray(rawSel)) {
        throw new CheckoutError('bad_selections', 'Selections are a flat object of plain values.');
      }
      const entries = Object.entries(rawSel as Record<string, unknown>);
      if (entries.length > MAX_SELECTIONS) {
        throw new CheckoutError('too_many_selections', `At most ${MAX_SELECTIONS} selections per line.`);
      }
      for (const [k, v] of entries) {
        if (!SELECTION_KEY.test(k)) continue;
        if (SERVER_OWNED_KEYS.has(normaliseKey(k))) continue;
        if (ENGINE_QUANTITY_KEYS.includes(k)) continue;
        if (typeof v === 'string') selections[k] = v.slice(0, 80);
        else if (typeof v === 'number' && Number.isFinite(v)) selections[k] = v;
        else if (typeof v === 'boolean') selections[k] = v;
      }
    }

    items.push(Object.freeze({
      serviceCode,
      quantity,
      beneficiaryLabel: label || null,
      selections: Object.freeze(selections),
    }));
  }

  // ── Discount codes ──
  const rejectedCodes: string[] = [];
  const discountCodes: string[] = [];
  const rawCodes = Array.isArray(b.discountCodes) ? b.discountCodes : [];
  for (const c of rawCodes.slice(0, MAX_CODES_PER_REQUEST + 1)) {
    const code = normaliseCode(c);
    if (!code) {
      if (c != null && String(c).trim()) rejectedCodes.push(String(c).slice(0, 40));
      continue;
    }
    if (discountCodes.includes(code)) continue;
    if (discountCodes.length >= MAX_CODES_PER_REQUEST) {
      rejectedCodes.push(code);
      continue;
    }
    discountCodes.push(code);
  }

  const rawAudience = typeof b.audience === 'string' ? b.audience.trim().toLowerCase() : '';
  const audience = AUDIENCE.test(rawAudience) ? rawAudience : null;

  return Object.freeze({
    request: Object.freeze({
      items: Object.freeze(items),
      discountCodes: Object.freeze(discountCodes),
      audience,
    }),
    refusedFields: Object.freeze(refusedFields),
    rejectedCodes: Object.freeze(rejectedCodes),
  });
}

// ─── The breakdown ──────────────────────────────────────────────────────────

/** One rule's contribution to one line, with the condition that matched it. */
export interface CheckoutDetail {
  readonly kind: string;
  readonly label: string;
  readonly quantity: number | null;
  readonly unitAmountMinor: number | null;
  readonly amountMinor: number;
  readonly because: string | null;
}

export interface CheckoutServiceLine {
  readonly serviceCode: string;
  readonly name: string;
  readonly beneficiaryLabel: string | null;
  /** 1-based, for "Aarav — 1 of 2". A line is always ONE unit. */
  readonly unitIndex: number;
  readonly unitCount: number;
  /** What one unit is: per_person, per_month, per_certificate. */
  readonly unitOfSale: string | null;
  /** How often it recurs: monthly, annual, per_event, one_time. */
  readonly frequency: string | null;
  /** How long a payment covers, from src/db/entitlements.ts. Never guessed. */
  readonly termMonths: number | null;
  readonly termLabel: string;
  /** Priced or not, as src/db/fee-catalogue.ts decides. Narrow with isPriced(). */
  readonly fee: FeeResult;
  /** Priced only. Null on an unpriced line — never 0, which reads as free. */
  readonly netMinor: number | null;
  readonly taxMinor: number | null;
  readonly grossMinor: number | null;
  readonly detail: readonly CheckoutDetail[];
}

export interface CheckoutReductionLine {
  readonly source: 'discount' | 'concession';
  /** The RULE code, never the token the buyer typed — that may be a secret. */
  readonly code: string;
  readonly label: string;
  /** NEGATIVE paise. */
  readonly amountMinor: number;
  readonly because: string;
  readonly runningTotalMinor: number;
}

export interface RefusedCode {
  readonly code: string;
  readonly reason: string;
}

export interface PayableCheckout {
  readonly outcome: 'payable';
  readonly asAt: string;
  readonly currency: string;
  readonly frameworkCode: string;
  readonly frameworkVersion: number;
  readonly lines: readonly CheckoutServiceLine[];
  readonly reductions: readonly CheckoutReductionLine[];
  /** Sum of the service lines before tax and before any reduction. */
  readonly subtotalMinor: number;
  /** NEGATIVE, and kept apart from concessions so a campaign report cannot read hardship. */
  readonly discountMinor: number;
  readonly concessionMinor: number;
  readonly taxMinor: number;
  readonly totalMinor: number;
  readonly refusedCodes: readonly RefusedCode[];
}

export type CheckoutUnavailableReason =
  | 'nothing_to_buy'
  | 'no_framework'
  | 'framework_not_yet_in_force'
  | 'framework_expired'
  | 'framework_changed'
  | 'not_published'
  | 'term_not_stated'
  | 'mixed_currency'
  | 'zero_total'
  | 'needs_approval'
  | 'register_unreadable';

export interface CheckoutBlocker {
  readonly serviceCode: string;
  readonly beneficiaryLabel: string | null;
  /** The sentence the buyer reads. */
  readonly notice: string;
  /** Operator detail. Never rendered to a buyer. */
  readonly detail: string | null;
}

export const CHECKOUT_UNPAYABLE: unique symbol = Symbol('MMAKF.CHECKOUT_UNPAYABLE');

/**
 * A checkout that cannot be paid, and deliberately NO `totalMinor` PROPERTY.
 *
 * Same construction as UnpricedFee in src/db/fee-catalogue.ts, for the same
 * reason: the absence is the compile-time half of the guarantee, and the
 * throwing `Symbol.toPrimitive` is the half that survives a cast, an `any`, or
 * an .astro template where the type checker is not looking.
 */
export interface UnpayableCheckout {
  readonly outcome: typeof CHECKOUT_UNPAYABLE;
  readonly asAt: string;
  readonly reason: CheckoutUnavailableReason;
  /** One sentence, for the buyer. */
  readonly notice: string;
  readonly lines: readonly CheckoutServiceLine[];
  readonly blocking: readonly CheckoutBlocker[];
  readonly refusedCodes: readonly RefusedCode[];
  readonly [Symbol.toPrimitive]: (hint: string) => never;
}

export type CheckoutQuote = PayableCheckout | UnpayableCheckout;

export function isPayable(q: CheckoutQuote): q is PayableCheckout {
  return q.outcome === 'payable';
}

/**
 * The federation's own sentence for each way a checkout cannot be paid.
 *
 * Every one of them ends in the same place — ask the office — because that is
 * the true next step in all of them. None shows a figure, and none says "free".
 */
const UNAVAILABLE_NOTICE: Readonly<Record<CheckoutUnavailableReason, string>> = Object.freeze({
  nothing_to_buy: 'There is nothing in this basket to pay for.',
  no_framework:
    'Pricing unavailable — the federation has not published a fee framework, so there is no amount to charge. Request a quotation from the federation office.',
  framework_not_yet_in_force:
    'Pricing unavailable — the fee framework that covers this has not come into force yet. Request a quotation from the federation office.',
  framework_expired:
    'Pricing unavailable — the fee framework that covered this has expired and the federation has not published its replacement. Request a quotation from the federation office.',
  framework_changed:
    'Pricing unavailable — the federation’s fee framework changed while this basket was being priced. Reload the page so every line is priced under one framework.',
  not_published:
    'Pricing unavailable — the federation has not published a fee for everything in this basket. Request a quotation from the federation office.',
  term_not_stated:
    'Pricing unavailable — the federation has not recorded how long this purchase covers, so it cannot be sold until it does. Request a quotation from the federation office.',
  mixed_currency:
    'Pricing unavailable — this basket priced in more than one currency, which this checkout will not add together. Request a quotation from the federation office.',
  zero_total:
    'Pricing unavailable — this basket priced at nothing, which the federation has not published as free. Request a quotation from the federation office.',
  needs_approval:
    'This basket needs the federation office to approve it before it can be paid. Request a quotation and the office will confirm the figure.',
  register_unreadable:
    'Pricing unavailable — the federation’s fee register could not be read just now. Nothing has been charged. Please try again shortly.',
});

function unpayable(
  asAt: string,
  reason: CheckoutUnavailableReason,
  lines: readonly CheckoutServiceLine[],
  blocking: readonly CheckoutBlocker[] = [],
  refusedCodes: readonly RefusedCode[] = []
): UnpayableCheckout {
  return Object.freeze({
    outcome: CHECKOUT_UNPAYABLE,
    asAt,
    reason,
    notice: UNAVAILABLE_NOTICE[reason],
    lines: Object.freeze(lines.slice()),
    blocking: Object.freeze(blocking.slice()),
    refusedCodes: Object.freeze(refusedCodes.slice()),
    [Symbol.toPrimitive](hint: string): never {
      throw new CheckoutError(
        'checkout_not_payable',
        `This checkout has no total (${reason}), and this code tried to use it as a ${hint}. ` +
        'There is no number here on purpose — narrow it with isPayable() first.'
      );
    },
  });
}

// ─── Terms ──────────────────────────────────────────────────────────────────

/**
 * Frequencies that describe a PERIOD OF COVER rather than a single act.
 *
 * A payment for one of these has to say what it buys and for how long, and the
 * federation records that in entitlement_terms — never here. Selling a month of
 * training with no recorded term takes money for an entitlement the activation
 * engine will then refuse to grant; configureTerm() in src/db/entitlements.ts
 * will not default a term either, and says why.
 */
const RECURRING: ReadonlySet<string> = new Set([
  'monthly', 'annual', 'biennial', 'triennial', 'per_term',
]);

function termLabelFor(term: any, frequency: string | null, asAt: string): string {
  if (!term) {
    return frequency && RECURRING.has(frequency)
      ? 'The federation has not recorded how long this covers.'
      : 'A single charge — this does not renew.';
  }
  if (term.openEnded) return 'No expiry — the federation has recorded this as open-ended.';
  const months = Number(term.termMonths);
  if (!Number.isInteger(months) || months < 1) {
    return 'The federation has not recorded how long this covers.';
  }
  return `${months} ${months === 1 ? 'month' : 'months'} — cover to ${termEndsOn(asAt, months)}.`;
}

// ─── Pricing a basket ───────────────────────────────────────────────────────

export interface PriceCheckoutOptions {
  /**
   * The date the framework is read on. SERVER-SUPPLIED ONLY.
   *
   * Present so tests and the office can price as at a date, and absent from
   * every client path — parseCheckoutRequest() lists every spelling of it among
   * the fields it refuses. Defaults to today, which is what a buyer gets.
   */
  asAt?: string;
  /** Who is being shown the figure. Defaults to the most restrictive. */
  viewer?: FeeViewer;
  /** For discount validity windows. Defaults to now. */
  now?: Date;
  /** WHO is buying, from the session — never from the request body. */
  subject?: {
    personId?: number | null;
    institutionId?: number | null;
    dojoId?: number | null;
    stateUnitId?: number | null;
    districtUnitId?: number | null;
  };
}

/** Deterministic memo key, so `{a:1,b:2}` and `{b:2,a:1}` are one entry. */
function stableJson(v: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));
}

/**
 * Price a basket, WITHOUT writing anything.
 *
 * Reads the catalogue, the framework in force and the buyer's discount codes,
 * and returns either a payable breakdown or an honest refusal. It creates no
 * order, reserves nothing and takes no money — src/db/orders.ts is the only
 * writer of an order and it prices independently, so a bug here can show
 * somebody the wrong figure but cannot charge it.
 *
 * ── ONE LINE PER UNIT, AND THIS MODULE NEVER MULTIPLIES ──
 *
 * A quantity of two is TWO lines, each priced by its own call to the fee
 * engine. Multiplying one computed fee by two would be this module deciding a
 * price, which is exactly what src/db/fees.ts exists to be the only place for —
 * and it silently under-charges the moment a framework prices a service with a
 * flat `base` rule rather than a per-participant one.
 *
 * Identical inputs are memoised per call, so two children on the same service
 * cost one framework evaluation and still produce two lines with two names.
 */
export async function priceCheckout(
  db: DB,
  request: CheckoutRequest,
  opts: PriceCheckoutOptions = {}
): Promise<CheckoutQuote> {
  const asAt = opts.asAt ?? new Date().toISOString().slice(0, 10);
  if (!ISO_DATE.test(asAt)) {
    throw new CheckoutError('bad_date', 'A pricing date is an ISO calendar date, yyyy-mm-dd.');
  }
  const viewer: FeeViewer = opts.viewer ?? 'public';

  if (!request.items.length) return unpayable(asAt, 'nothing_to_buy', []);

  // ── The framework in force, checked twice ──
  //
  // activeFramework() already filters on the effective dates in SQL. It is
  // re-asserted here because THIS is the function that decides whether somebody
  // may be charged today, and "an expired fee cannot price a new order" is a
  // guarantee this module makes rather than one it borrows. The two spellings
  // also give the buyer the right sentence: a framework that has expired and
  // one that has not started yet are different facts about the federation.
  //
  // NOTED AND CARRIED, NOT RETURNED ON. A buyer whose federation has published
  // nothing must still see the two things they put in the basket, each with the
  // federation's own sentence beside it — an empty page under a single notice
  // does not tell a parent that we understood what they asked for. So the state
  // is recorded here and the lines are built regardless; the refusal comes
  // after them, carrying the right reason.
  let framework: any = null;
  let frameworkState: CheckoutUnavailableReason | 'ok' = 'ok';
  try {
    framework = await activeFramework(db, asAt);
  } catch {
    frameworkState = 'register_unreadable';
  }
  if (frameworkState === 'ok') {
    if (!framework) frameworkState = 'no_framework';
    else if (framework.effectiveFrom && asAt < String(framework.effectiveFrom).slice(0, 10)) {
      frameworkState = 'framework_not_yet_in_force';
    } else if (framework.effectiveTo && asAt > String(framework.effectiveTo).slice(0, 10)) {
      frameworkState = 'framework_expired';
    }
  }

  // ── Every unit, priced on its own ──
  const feeCache = new Map<string, FeeResult>();
  const entryCache = new Map<string, any>();
  const termCache = new Map<string, any>();

  const lines: CheckoutServiceLine[] = [];
  const blocking: CheckoutBlocker[] = [];

  for (const item of request.items) {
    let entry: any;
    let term: any;
    try {
      if (!entryCache.has(item.serviceCode)) {
        entryCache.set(item.serviceCode, await catalogueEntry(db, item.serviceCode));
      }
      entry = entryCache.get(item.serviceCode);
      if (!termCache.has(item.serviceCode)) {
        termCache.set(item.serviceCode, await termFor(db, item.serviceCode));
      }
      term = termCache.get(item.serviceCode);
    } catch {
      return unpayable(asAt, 'register_unreadable', lines);
    }

    const frequency: string | null = entry?.frequency ?? null;
    const unitOfSale: string | null = entry?.unit ?? null;
    const name: string = entry?.name ?? item.serviceCode;

    // ONE participant per line, and the buyer cannot say otherwise — see
    // ENGINE_QUANTITY_KEYS. `audience` is a claim a fee rule discriminates on.
    const inputs: FeeInputs = { ...item.selections, participants: 1 };
    if (request.audience) inputs.audience = request.audience;

    const key = `${item.serviceCode}|${viewer}|${stableJson(inputs)}`;
    let fee: FeeResult;
    try {
      if (!feeCache.has(key)) {
        feeCache.set(key, await feeFor(db, item.serviceCode, inputs, { asAt, viewer }));
      }
      fee = feeCache.get(key)!;
    } catch {
      return unpayable(asAt, 'register_unreadable', lines);
    }

    for (let u = 1; u <= item.quantity; u += 1) {
      // Re-bound as a const so `isPriced()` narrows it. The narrowing is what
      // makes it impossible to read an amount off an unpriced line here — the
      // compile-time half of the guarantee src/db/fee-catalogue.ts describes.
      const f: FeeResult = fee;
      const common = {
        serviceCode: item.serviceCode,
        name,
        beneficiaryLabel: item.beneficiaryLabel,
        unitIndex: u,
        unitCount: item.quantity,
        unitOfSale,
        frequency,
        termMonths: term && !term.openEnded ? (term.termMonths ?? null) : null,
        termLabel: termLabelFor(term, frequency, asAt),
        fee: f,
      };

      if (!isPriced(f)) {
        // NO AMOUNT AT ALL on the line — not 0, which reads as free. The buyer
        // still sees the line, because "we have not published a fee for the
        // thing you asked for" is information they came here for.
        lines.push(Object.freeze({
          ...common,
          netMinor: null,
          taxMinor: null,
          grossMinor: null,
          detail: Object.freeze([] as CheckoutDetail[]),
        }));
        blocking.push(Object.freeze({
          serviceCode: item.serviceCode,
          beneficiaryLabel: item.beneficiaryLabel,
          notice: f.notice,
          detail: f.detail,
        }));
        continue;
      }

      const taxMinor = f.lines
        .filter((l) => l.kind === 'tax')
        .reduce((n, l) => n + l.amountMinor, 0);

      lines.push(Object.freeze({
        ...common,
        netMinor: f.amountMinor - taxMinor,
        taxMinor,
        grossMinor: f.amountMinor,
        detail: Object.freeze(f.lines.map((l) => Object.freeze({
          kind: l.kind,
          label: l.label,
          quantity: l.quantity,
          unitAmountMinor: l.unitAmountMinor,
          amountMinor: l.amountMinor,
          because: l.because,
        }))),
      }));

      // A period of cover with no recorded term is money taken for an
      // entitlement nothing can grant. Refused BEFORE payment rather than
      // discovered at activation, when the money is already in.
      if (frequency && RECURRING.has(frequency) && !term) {
        blocking.push(Object.freeze({
          serviceCode: item.serviceCode,
          beneficiaryLabel: item.beneficiaryLabel,
          notice: UNAVAILABLE_NOTICE.term_not_stated,
          detail: `No entitlement term is configured for ${item.serviceCode}, which recurs ${frequency}.`,
        }));
        continue;
      }

      // A line priced under a framework other than the one in force means the
      // federation published a new version between the two reads. Refused
      // rather than added up: half a basket at last month's prices is a total
      // no framework ever produced.
      if (framework && f.frameworkCode !== framework.code) {
        return unpayable(asAt, 'framework_changed', lines);
      }
    }
  }

  // The framework state, now that the buyer has their lines to look at.
  if (frameworkState !== 'ok') return unpayable(asAt, frameworkState, lines, blocking);

  if (blocking.length) {
    const termOnly = blocking.every((b) => b.notice === UNAVAILABLE_NOTICE.term_not_stated);
    return unpayable(asAt, termOnly ? 'term_not_stated' : 'not_published', lines, blocking);
  }

  const currencies = new Set(lines.map((l) => (isPriced(l.fee) ? l.fee.currency : '')));
  if (currencies.size !== 1) return unpayable(asAt, 'mixed_currency', lines);
  const currency = [...currencies][0];

  let subtotal = 0;
  let tax = 0;
  for (const l of lines) {
    subtotal += l.netMinor as number;
    tax += l.taxMinor as number;
  }
  let running = subtotal + tax;

  // ── Reductions, resolved by the server from CODES ──
  //
  // Applied to the BASKET, not to a line, because a family discount is one
  // decision about one purchase — applying it per child would multiply it by
  // the number of children, which is the opposite of what a sibling rate means.
  //
  // The inputs a discount rule matches on describe the basket: how many people
  // it is for, how many lines it has, and the single service code when there is
  // one. A sibling rate is `{ "beneficiaries": { "min": 2 } }`.
  const beneficiaries = new Set(
    lines.map((l, i) => l.beneficiaryLabel ?? `line:${i}`)
  ).size;
  const serviceCodes = new Set(lines.map((l) => l.serviceCode));
  const basketInputs: FeeInputs = {
    beneficiaries,
    lines: lines.length,
    ...(request.audience ? { audience: request.audience } : {}),
    ...(serviceCodes.size === 1 ? { serviceCode: [...serviceCodes][0] } : {}),
  };

  const refusedCodes: RefusedCode[] = [];
  let resolved: { applied: Reduction[]; refused: Array<{ code: string; reason: string }> } = {
    applied: [], refused: [],
  };
  if (request.discountCodes.length) {
    try {
      resolved = await resolveDiscountCodes(db, {
        codes: [...request.discountCodes],
        inputs: basketInputs,
        subject: { ...(opts.subject ?? {}) },
        asAt: opts.now ?? new Date(),
      });
    } catch {
      return unpayable(asAt, 'register_unreadable', lines);
    }
  }
  for (const r of resolved.refused) refusedCodes.push(Object.freeze({ code: r.code, reason: r.reason }));

  const reductions: CheckoutReductionLine[] = [];
  let discountTotal = 0;
  let concessionTotal = 0;
  let needsApproval = false;

  for (const r of resolved.applied) {
    // ── Why a before-tax reduction is REFUSED rather than applied ──
    //
    // Each line here was priced by its own computeFee(), which computed that
    // line's tax on that line's subtotal. A basket-level reduction arrives
    // afterwards, and subtracting it "before tax" would mean restating a tax the
    // fee engine has already decided — this module recomputing a published
    // figure, which is precisely what it must not do. When the basket carries NO
    // tax the two stages are the same point and the reduction applies normally;
    // when it does carry tax, the buyer is told why their code did nothing
    // rather than being handed a total that quietly disagrees with the
    // framework.
    if (r.stage === 'before_tax' && tax !== 0) {
      refusedCodes.push(Object.freeze({
        code: r.sourceCode,
        reason:
          'That reduction applies before tax, and the tax on this basket has already been computed by the fee framework. ' +
          'The federation office can issue a quotation that applies it in the right place.',
      }));
      continue;
    }

    // computeReduction() from src/db/fees.ts — the SAME arithmetic and the same
    // clamps a quotation uses, not a second opinion about what a code is worth.
    const outcome = computeReduction(running, r);
    if (!outcome.applied) {
      refusedCodes.push(Object.freeze({ code: r.sourceCode, reason: outcome.because }));
      continue;
    }
    const amount = -outcome.reductionMinor;
    running += amount;
    if (r.source === 'discount') discountTotal += amount;
    else concessionTotal += amount;
    if (r.requiresApproval) needsApproval = true;

    reductions.push(Object.freeze({
      source: r.source,
      code: r.sourceCode,
      label: r.label,
      amountMinor: amount,
      because: outcome.notes.join('; ') || r.because,
      runningTotalMinor: running,
    }));
  }

  if (needsApproval) return unpayable(asAt, 'needs_approval', lines, [], refusedCodes);

  // The zero refusal, as src/db/fee-catalogue.ts makes it for a single fee: a
  // free service is a POLICY the federation states, not an outcome arithmetic
  // fell into — and the realistic way a basket reaches zero is a discount
  // matching when the rule it was meant to reduce did not.
  if (!Number.isInteger(running) || running <= 0) {
    return unpayable(asAt, 'zero_total', lines, [], refusedCodes);
  }

  // subtotal + reductions + tax = total, by construction. Asserted because this
  // is the figure a gateway order would be created from, and a breakdown whose
  // lines do not add up to its total is a breakdown nobody can defend.
  if (subtotal + discountTotal + concessionTotal + tax !== running) {
    throw new CheckoutError(
      'not_reconcilable',
      'This basket’s lines do not add up to its total. Refusing to present a figure this system cannot reconstruct.'
    );
  }

  return Object.freeze({
    outcome: 'payable' as const,
    asAt,
    currency,
    frameworkCode: framework.code,
    frameworkVersion: framework.version,
    lines: Object.freeze(lines),
    reductions: Object.freeze(reductions),
    subtotalMinor: subtotal,
    discountMinor: discountTotal,
    concessionMinor: concessionTotal,
    taxMinor: tax,
    totalMinor: running,
    refusedCodes: Object.freeze(refusedCodes),
  });
}

// ─── Handing the figure to a payment provider ───────────────────────────────

export interface PaymentIntent {
  readonly amountMinor: number;
  readonly currency: string;
  readonly frameworkCode: string;
  readonly frameworkVersion: number;
  readonly lineCount: number;
}

/**
 * The figure a gateway order is created from — and the ONLY source of it.
 *
 * Takes a server-computed quote and nothing else. There is deliberately no
 * overload that accepts an amount, because the day one exists somebody will
 * pass a request body into it.
 */
export function paymentIntent(quote: CheckoutQuote): PaymentIntent {
  if (!isPayable(quote)) {
    throw new CheckoutError(
      'checkout_not_payable',
      `${quote.notice} Refusing to open a payment for a basket with no published price.`
    );
  }
  return Object.freeze({
    amountMinor: quote.totalMinor,
    currency: quote.currency,
    frameworkCode: quote.frameworkCode,
    frameworkVersion: quote.frameworkVersion,
    lineCount: quote.lines.length,
  });
}

/**
 * What came back from the gateway must be what we asked for.
 *
 * The third leg of the tamper story, and the one the first two cannot catch: a
 * provider order created with the right amount and then altered, a client that
 * opened the checkout widget with its own figure, an integration pointed at the
 * wrong environment. confirmPayment() in src/db/orders.ts makes the same
 * comparison again before an order is marked paid — twice, deliberately,
 * because these are two different moments and only the later one is
 * authoritative about money.
 */
export function assertGatewayAmount(
  quote: CheckoutQuote,
  reported: { amountMinor: unknown; currency: unknown }
): void {
  const intent = paymentIntent(quote);
  const amount = reported?.amountMinor;
  const currency = reported?.currency;
  if (!Number.isInteger(amount) || amount !== intent.amountMinor || currency !== intent.currency) {
    throw new CheckoutError(
      'amount_mismatch',
      `The payment provider reported ${String(amount)} ${String(currency)} for a basket the federation priced at ` +
      `${intent.amountMinor} ${intent.currency} (${formatINR(intent.amountMinor)}). ` +
      'Refusing to fulfil: the figure charged and the figure computed must be the same figure.'
    );
  }
}

/**
 * The breakdown in words, from the quote alone.
 *
 * For a receipt, an email, a plain-text fallback, and the test that reads it.
 * It re-derives nothing — every figure here is one the quote already carries.
 */
export function describeCheckout(quote: CheckoutQuote): string[] {
  const out: string[] = [];
  for (const l of quote.lines) {
    const who = l.beneficiaryLabel ? ` — ${l.beneficiaryLabel}` : '';
    const unit = l.unitCount > 1 ? ` (${l.unitIndex} of ${l.unitCount})` : '';
    const amount = isPriced(l.fee) ? formatINR(l.fee.amountMinor) : l.fee.notice;
    out.push(`${l.name}${who}${unit}: ${amount}`);
    out.push(`    ${l.termLabel}`);
  }
  if (!isPayable(quote)) {
    out.push(quote.notice);
    return out;
  }
  for (const r of quote.reductions) {
    out.push(`${r.label} (${r.code}): ${formatINR(r.amountMinor)} — ${r.because}`);
  }
  if (quote.taxMinor) out.push(`Tax: ${formatINR(quote.taxMinor)}`);
  out.push(`Total: ${formatINR(quote.totalMinor)}`);
  return out;
}
