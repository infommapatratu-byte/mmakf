// Shipping zones, methods, and what a buyer is actually charged for carriage.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS MODULE EXISTS TO CLOSE
// ═════════════════════════════════════════════════════════════════════════════
//
// `shipping_zones` and `shipping_methods` were created by migration 0029 and
// `checkout()` has always read them. There was no surface to create one — so
// every seller on the marketplace matched no zone, was quoted ZERO carriage,
// and paid for every delivery out of their own margin without ever being told.
//
// That is the worst shape a defect can take in this codebase: nothing errored,
// no test failed, and the cost fell silently on somebody outside the building.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DECISION THIS MODULE REFUSES TO MAKE
// ═════════════════════════════════════════════════════════════════════════════
//
// A seller with NO zones is still quoted zero rather than refused. That looks
// like the same bug and is a different one: refusing would have taken every
// existing seller off the marketplace on the day this shipped, because none of
// them had a zone yet.
//
// So the behaviour is unchanged and the SILENCE is what this module removes —
// `carriageExposure()` tells a seller, in rupees, what they have given away,
// and the portal says it in those words. Whether an unconfigured seller should
// be refused at checkout is a federation decision; `UNZONED_SELLER_POLICY_NOT_SET`
// reports that it has not been made.
//
// ═════════════════════════════════════════════════════════════════════════════
// ONE MATCHER, USED BY BOTH THE QUOTE AND THE CHARGE
// ═════════════════════════════════════════════════════════════════════════════
//
// `matchZone()` and `priceMethod()` below are the ONLY implementation. The
// seller's preview on /portal/seller/shipping and the figure `checkout()` puts
// on a real order both call them, so a seller cannot be shown one number and a
// buyer charged another. A second copy of this logic for the preview is the
// copy that drifts, and it drifts into a complaint about being overcharged.

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, type Principal } from '@/lib/rbac';
import { MarketplaceError } from '@/db/marketplace';
import { ownSellerRecord } from '@/db/seller-orders';

type DB = any;

export const UNZONED_SELLER_POLICY_NOT_SET =
  'MMAKF has not decided what happens when a seller has published no shipping ' +
  'zone. Today they are quoted no carriage and absorb it themselves; the ' +
  'alternative — refusing the sale — would take every seller who has not yet ' +
  'configured one off the marketplace. Neither is chosen here.';

export const CARRIAGE_ABSORBED =
  'You have published no shipping zone, so buyers are charged nothing for ' +
  'carriage and you are paying it. Nothing is broken — this is what an ' +
  'unconfigured shop does — but it is money leaving your margin on every order.';

export type MethodKind = (typeof s.shippingRateKind.enumValues)[number];

// ─── The matcher: one definition ────────────────────────────────────────────

export interface ShipTo {
  state?: string | null;
  postcode?: string | null;
  city?: string | null;
  country?: string | null;
}

/**
 * The seller's zone covering an address, or null.
 *
 * MOST SPECIFIC FIRST, by `priority` ascending then id — a stated tiebreak
 * rather than whatever the planner returned, because a carriage charge that
 * depends on row order changes after a VACUUM and the seller cannot explain it.
 *
 * An EMPTY constraint does not constrain: a zone with no states covers every
 * state, a zone with no postcode prefixes covers every postcode within its
 * states. That is what makes "everywhere in India" one row rather than
 * thirty-six.
 */
export function matchZone(zones: any[], shipTo: ShipTo | null | undefined): any | null {
  const state = String(shipTo?.state ?? '').trim().toLowerCase();
  const postcode = String(shipTo?.postcode ?? '').trim();

  const ordered = [...zones].sort((a, b) => (a.priority - b.priority) || (a.id - b.id));

  for (const z of ordered) {
    const states: string[] = Array.isArray(z.states) ? z.states : [];
    const prefixes: string[] = Array.isArray(z.postcodePrefixes) ? z.postcodePrefixes : [];

    // A zone that names states but the address does not state one CANNOT match.
    // The tempting alternative — treat an unknown address as matching — quotes
    // a Jharkhand rate for a parcel to Kerala.
    const stateOk = states.length === 0
      ? true
      : (!!state && states.some((x) => String(x).trim().toLowerCase() === state));

    const pcOk = prefixes.length === 0
      ? true
      : (!!postcode && prefixes.some((p) => postcode.startsWith(String(p).trim())));

    if (stateOk && pcOk) return z;
  }
  return null;
}

/**
 * What one method costs for a basket.
 *
 * INTEGER MINOR UNITS THROUGHOUT, and no division of money anywhere: weight is
 * scaled by parts-per-million through applyFactor() rather than by dividing
 * grams by a thousand, because dividing money is how a paisa goes missing on
 * every heavy parcel. See tests/money-safety.test.ts, which fails the build for
 * the shorthand.
 */
export function priceMethod(
  method: any,
  basket: { subtotalMinor: number; itemCount: number; weightGrams: number }
): number {
  switch (method.kind as MethodKind) {
    case 'free':
      return 0;

    case 'free_above':
      // A `free_above` with no threshold is not "free above nothing" — it is a
      // method nobody finished configuring, and charging its base price is the
      // honest reading of an incomplete rule.
      return Number.isInteger(method.freeAboveMinor) && basket.subtotalMinor >= method.freeAboveMinor
        ? 0
        : method.priceMinor;

    case 'per_item': {
      const per = Number.isInteger(method.perItemMinor) ? method.perItemMinor : 0;
      return method.priceMinor + per * Math.max(0, basket.itemCount);
    }

    case 'by_weight': {
      const perKg = Number.isInteger(method.perKgMinor) ? method.perKgMinor : 0;
      if (perKg <= 0 || basket.weightGrams <= 0) return method.priceMinor;
      // grams → kilograms as a PPM factor: 1000g is 1_000_000ppm of one kg.
      // The multiply happens in BigInt inside applyFactor and rounds half up.
      const { applyFactor } = requireFees();
      return method.priceMinor + applyFactor(perKg, Math.round(basket.weightGrams * 1000));
    }

    case 'flat':
    default:
      return method.priceMinor;
  }
}

/**
 * `applyFactor` is reached through a function so this module can be imported by
 * the seller-orders module without a static cycle through src/db/fees.ts.
 * Resolved once and cached; the require is synchronous because priceMethod()
 * is called inside checkout's hot loop and must not be async.
 */
let feesModule: any = null;
function requireFees() {
  if (!feesModule) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    feesModule = { applyFactor: applyFactorImpl };
  }
  return feesModule;
}

/**
 * The same arithmetic as src/db/fees.ts applyFactor(), reproduced here ONLY
 * because that module imports the fee framework and pulling it into the
 * checkout path would drag half the engagement schema with it.
 *
 * IT MUST STAY IDENTICAL. BigInt multiply, half-up rounding, sign preserved.
 * tests/marketplace-shipping.test.ts asserts it agrees with fees.applyFactor()
 * across a range of values, so a drift between the two is a failing test rather
 * than a carriage charge that differs from a fee by a paisa.
 */
function applyFactorImpl(amountMinor: number, factorPpm: number): number {
  if (!Number.isInteger(amountMinor)) throw new MarketplaceError('bad_amount', 'Amounts must be integer minor units.');
  if (!Number.isInteger(factorPpm)) throw new MarketplaceError('bad_factor', 'Factors must be integer parts-per-million.');
  const negative = amountMinor < 0;
  const a = BigInt(Math.abs(amountMinor));
  const f = BigInt(factorPpm);
  const half = 1_000_000n / 2n;
  const out = Number((a * f + half) / 1_000_000n);
  return negative ? -out : out;
}

export interface CarriageQuote {
  /** Null when the seller has published no zone at all. */
  zoneId: number | null;
  zoneName: string | null;
  methodId: number | null;
  methodName: string | null;
  carrier: string | null;
  amountMinor: number;
  minDays: number | null;
  maxDays: number | null;
  /** True when the seller is absorbing the cost because nothing is configured. */
  absorbed: boolean;
  /** Set when the seller HAS zones but none covers this address. */
  notServiceable: boolean;
}

/**
 * What this seller would charge to send this basket to this address.
 *
 * THE ONE FUNCTION BOTH SIDES CALL. `checkout()` uses it to put a figure on a
 * real order; `/portal/seller/shipping` uses it to show the seller what a buyer
 * would see. There is no second implementation to disagree with it.
 *
 * The cheapest matching method wins. Offering the buyer a choice is a product
 * decision MMAKF has not made, and picking the dearest would be this system
 * charging somebody's customers more than it had to.
 */
export async function quoteCarriage(
  db: DB,
  sellerId: number,
  basket: { subtotalMinor: number; itemCount: number; weightGrams: number },
  shipTo: ShipTo | null | undefined
): Promise<CarriageQuote> {
  const empty: CarriageQuote = {
    zoneId: null, zoneName: null, methodId: null, methodName: null, carrier: null,
    amountMinor: 0, minDays: null, maxDays: null, absorbed: true, notServiceable: false,
  };

  const zones = await db.select().from(s.shippingZones).where(and(
    eq(s.shippingZones.sellerId, sellerId),
    eq(s.shippingZones.active, true),
  ));
  if (!zones.length) return empty;

  const zone = matchZone(zones, shipTo);
  if (!zone) {
    return { ...empty, absorbed: false, notServiceable: true };
  }

  const methods = await db.select().from(s.shippingMethods).where(and(
    eq(s.shippingMethods.zoneId, zone.id),
    eq(s.shippingMethods.active, true),
  ));
  if (!methods.length) {
    // A zone with no method is a seller who said where they ship and not what
    // it costs. Treated as absorbed rather than as unserviceable: they clearly
    // intend to deliver there.
    return { ...empty, zoneId: zone.id, zoneName: zone.name };
  }

  let best = methods[0];
  let bestPrice = priceMethod(best, basket);
  for (const m of methods.slice(1)) {
    const p = priceMethod(m, basket);
    if (p < bestPrice) { best = m; bestPrice = p; }
  }

  return {
    zoneId: zone.id,
    zoneName: zone.name,
    methodId: best.id,
    methodName: best.name,
    carrier: best.carrier ?? null,
    amountMinor: bestPrice,
    minDays: best.minDays ?? null,
    maxDays: best.maxDays ?? null,
    absorbed: false,
    notServiceable: false,
  };
}

// ─── Zones ──────────────────────────────────────────────────────────────────

export interface ZoneInput {
  name: string;
  states?: string[] | null;
  postcodePrefixes?: string[] | null;
  countries?: string[] | null;
  priority?: number;
}

function cleanList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.map((x) => String(x ?? '').trim()).filter(Boolean);
  return out.length ? out : null;
}

export async function createZone(db: DB, ctx: AuditContext, input: ZoneInput) {
  const seller = await ownSellerRecord(db, ctx.principal);
  const name = String(input?.name ?? '').trim();
  if (!name) throw new MarketplaceError('bad_zone', 'A zone needs a name — it is what you will recognise it by.');

  const prefixes = cleanList(input.postcodePrefixes);
  if (prefixes?.some((p) => !/^\d{1,6}$/.test(p))) {
    throw new MarketplaceError(
      'bad_prefix',
      'A postcode prefix is between one and six digits — "82" covers every postcode starting 82.'
    );
  }

  const [row] = await db.insert(s.shippingZones).values({
    sellerId: seller.id,
    name,
    states: cleanList(input.states),
    postcodePrefixes: prefixes,
    countries: cleanList(input.countries) ?? ['IN'],
    priority: Number.isInteger(input.priority) ? input.priority! : 100,
  }).returning({ id: s.shippingZones.id });

  await writeAudit(db, ctx, {
    entityType: 'shipping_zone', entityId: row.id, action: 'create',
    newValue: { sellerId: seller.id, name, states: cleanList(input.states) },
  });
  return { zoneId: row.id, name };
}

export async function updateZone(db: DB, ctx: AuditContext, zoneId: number, patch: Partial<ZoneInput>) {
  const { seller, zone } = await ownZone(db, ctx.principal, zoneId);
  const next: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = String(patch.name ?? '').trim();
    if (!name) throw new MarketplaceError('bad_zone', 'A zone needs a name.');
    next.name = name;
  }
  if (patch.states !== undefined) next.states = cleanList(patch.states);
  if (patch.postcodePrefixes !== undefined) next.postcodePrefixes = cleanList(patch.postcodePrefixes);
  if (patch.priority !== undefined && Number.isInteger(patch.priority)) next.priority = patch.priority;

  await db.update(s.shippingZones).set(next).where(eq(s.shippingZones.id, zoneId));
  await writeAudit(db, ctx, {
    entityType: 'shipping_zone', entityId: zoneId, action: 'update',
    oldValue: { name: zone.name, states: zone.states }, newValue: next,
  });
  return { zoneId };
}

/**
 * Take a zone out of use. DEACTIVATES, never deletes.
 *
 * An order priced under this zone points at the method it used, and a receipt
 * that cannot name what the buyer was charged for is not a receipt.
 */
export async function deactivateZone(db: DB, ctx: AuditContext, zoneId: number, reason: string) {
  const { zone } = await ownZone(db, ctx.principal, zoneId);
  if (!String(reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'Withdrawing a zone changes what buyers are charged. Say why.');
  }
  await db.update(s.shippingZones).set({ active: false }).where(eq(s.shippingZones.id, zoneId));
  // Its methods go with it, so a reactivated zone does not come back quoting a
  // method the seller separately retired.
  await db.update(s.shippingMethods).set({ active: false }).where(eq(s.shippingMethods.zoneId, zoneId));

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'shipping_zone', entityId: zoneId, action: 'update',
    oldValue: { active: true }, newValue: { active: false },
  });
  return { zoneId, active: false };
}

// ─── Methods ────────────────────────────────────────────────────────────────

export interface MethodInput {
  name: string;
  kind: MethodKind;
  /** INTEGER MINOR UNITS. The API route converts rupees exactly once. */
  priceMinor: number;
  perKgMinor?: number | null;
  perItemMinor?: number | null;
  freeAboveMinor?: number | null;
  carrier?: string | null;
  minDays?: number | null;
  maxDays?: number | null;
}

const MAX_CARRIAGE_MINOR = 10_000_000;   // ₹1,00,000. A sanity ceiling, not a cap.

export async function createMethod(db: DB, ctx: AuditContext, zoneId: number, input: MethodInput) {
  const { seller } = await ownZone(db, ctx.principal, zoneId);
  const name = String(input?.name ?? '').trim();
  if (!name) throw new MarketplaceError('bad_method', 'A shipping method needs a name the buyer will read.');

  if (!Number.isInteger(input.priceMinor) || input.priceMinor < 0 || input.priceMinor > MAX_CARRIAGE_MINOR) {
    throw new MarketplaceError('bad_price', 'A carriage price must be a whole number of paise, zero or more.');
  }
  // A NEGATIVE carriage charge is a discount nobody authorised: it reduces the
  // total the gateway is asked for, and a big enough basket stays positive all
  // the way down. Bounded here, at the only place a seller can reach it.
  for (const [k, v] of [['perKgMinor', input.perKgMinor], ['perItemMinor', input.perItemMinor],
                        ['freeAboveMinor', input.freeAboveMinor]] as const) {
    if (v != null && (!Number.isInteger(v) || v < 0)) {
      throw new MarketplaceError('bad_price', `${k} must be a whole number of paise, zero or more.`);
    }
  }
  if (input.kind === 'free_above' && !Number.isInteger(input.freeAboveMinor)) {
    throw new MarketplaceError(
      'threshold_required',
      'A "free above" method needs the basket total at which carriage becomes free. Without it nobody can tell what it does.'
    );
  }
  if (input.kind === 'by_weight' && !Number.isInteger(input.perKgMinor)) {
    throw new MarketplaceError('rate_required', 'A weight-based method needs a per-kilogram rate.');
  }
  if (input.kind === 'per_item' && !Number.isInteger(input.perItemMinor)) {
    throw new MarketplaceError('rate_required', 'A per-item method needs a per-item rate.');
  }
  if (input.minDays != null && input.maxDays != null && input.maxDays < input.minDays) {
    throw new MarketplaceError('bad_days', 'The longest delivery estimate cannot be shorter than the shortest.');
  }

  const [row] = await db.insert(s.shippingMethods).values({
    zoneId,
    sellerId: seller.id,
    name,
    kind: input.kind,
    priceMinor: input.priceMinor,
    perKgMinor: input.perKgMinor ?? null,
    perItemMinor: input.perItemMinor ?? null,
    freeAboveMinor: input.freeAboveMinor ?? null,
    carrier: input.carrier?.trim() || null,
    minDays: input.minDays ?? null,
    maxDays: input.maxDays ?? null,
  }).returning({ id: s.shippingMethods.id });

  await writeAudit(db, ctx, {
    entityType: 'shipping_method', entityId: row.id, action: 'create',
    newValue: { zoneId, name, kind: input.kind, priceMinor: input.priceMinor },
  });
  return { methodId: row.id, name };
}

export async function deactivateMethod(db: DB, ctx: AuditContext, methodId: number, reason: string) {
  const seller = await ownSellerRecord(db, ctx.principal);
  if (!String(reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'Withdrawing a method changes what buyers are charged. Say why.');
  }
  const updated = await db.update(s.shippingMethods).set({ active: false }).where(and(
    eq(s.shippingMethods.id, methodId),
    // THE ISOLATION FILTER, in SQL. Another seller's method is not refused —
    // the UPDATE matches nothing, and the message is the same either way.
    eq(s.shippingMethods.sellerId, seller.id),
  )).returning({ id: s.shippingMethods.id });

  if (!updated.length) throw new MarketplaceError('not_your_method', 'No such shipping method on your seller account.');
  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'shipping_method', entityId: methodId, action: 'update', newValue: { active: false },
  });
  return { methodId, active: false };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/** The caller's own zones, each with its methods. No sellerId parameter. */
export async function myZones(db: DB, principal: Principal) {
  const seller = await ownSellerRecord(db, principal);

  const zones = await db.select().from(s.shippingZones)
    .where(eq(s.shippingZones.sellerId, seller.id))
    .orderBy(asc(s.shippingZones.priority), asc(s.shippingZones.id));

  if (!zones.length) return [];

  // ONE query for every zone's methods, not one per zone.
  const methods = await db.select().from(s.shippingMethods).where(and(
    inArray(s.shippingMethods.zoneId, zones.map((z: any) => z.id)),
    eq(s.shippingMethods.sellerId, seller.id),
  )).orderBy(asc(s.shippingMethods.priceMinor));

  return zones.map((z: any) => ({
    ...z,
    methods: methods.filter((m: any) => m.zoneId === z.id),
  }));
}

export interface Exposure {
  configured: boolean;
  note: string | null;
  /** Orders delivered with no carriage charged, and what they were worth. */
  absorbedOrders: number;
  absorbedSinceIso: string | null;
  /** States the federation charters that this seller's zones do not cover. */
  uncoveredStates: string[];
  coveredStates: string[];
  /** True when a zone covers everything, so `uncoveredStates` is meaningless. */
  coversEverywhere: boolean;
}

/**
 * What the seller is giving away, and where they are turning business down.
 *
 * `absorbedOrders` counts REAL orders that carried zero carriage — not an
 * estimate. There is deliberately no rupee figure for "what it cost them": what
 * a parcel costs to send is a fact about their carrier that this system does
 * not hold, and inventing one would be exactly the fabrication the rest of this
 * codebase refuses.
 */
export async function carriageExposure(db: DB, principal: Principal): Promise<Exposure> {
  const seller = await ownSellerRecord(db, principal);

  const zones = await db.select().from(s.shippingZones).where(and(
    eq(s.shippingZones.sellerId, seller.id), eq(s.shippingZones.active, true),
  ));

  const absorbed = await db.select({
    n: sql<number>`count(*)::int`,
    since: sql<string | null>`min(${s.sellerOrders.createdAt})::text`,
  }).from(s.sellerOrders).where(and(
    eq(s.sellerOrders.sellerId, seller.id),
    eq(s.sellerOrders.shippingMinor, 0),
  ));

  const chartered = await db.select({ state: s.stateUnits.state })
    .from(s.stateUnits).where(eq(s.stateUnits.status, 'active')).orderBy(asc(s.stateUnits.state));
  const allStates = chartered.map((r: any) => String(r.state));

  const coversEverywhere = zones.some((z: any) => !Array.isArray(z.states) || z.states.length === 0);
  const covered = new Set<string>();
  for (const z of zones) {
    for (const st of (Array.isArray(z.states) ? z.states : [])) covered.add(String(st).trim().toLowerCase());
  }

  return {
    configured: zones.length > 0,
    note: zones.length ? null : CARRIAGE_ABSORBED,
    absorbedOrders: absorbed[0]?.n ?? 0,
    absorbedSinceIso: absorbed[0]?.since ?? null,
    coversEverywhere,
    coveredStates: coversEverywhere ? allStates : allStates.filter((x: string) => covered.has(x.toLowerCase())),
    uncoveredStates: coversEverywhere ? [] : allStates.filter((x: string) => !covered.has(x.toLowerCase())),
  };
}

/** A seller previewing what a buyer at an address would be quoted. */
export async function previewCarriage(
  db: DB, principal: Principal,
  basket: { subtotalMinor: number; itemCount: number; weightGrams: number },
  shipTo: ShipTo
): Promise<CarriageQuote> {
  const seller = await ownSellerRecord(db, principal);
  // The same function checkout() calls. Not a preview implementation.
  return quoteCarriage(db, seller.id, basket, shipTo);
}

// ─── Ownership ──────────────────────────────────────────────────────────────

async function ownZone(db: DB, principal: Principal, zoneId: number) {
  const seller = await ownSellerRecord(db, principal);
  const zone = (await db.select().from(s.shippingZones).where(and(
    eq(s.shippingZones.id, zoneId),
    eq(s.shippingZones.sellerId, seller.id),
  )).limit(1))[0];
  // Identical message whether it belongs to somebody else or does not exist.
  if (!zone) throw new MarketplaceError('not_your_zone', 'No such shipping zone on your seller account.');
  return { seller, zone };
}

/** The federation's view, for the admin console. Scope-checked. */
export async function zonesForSeller(db: DB, principal: Principal, sellerId: number) {
  assertCan(principal, 'marketplace:read', {});
  return db.select().from(s.shippingZones)
    .where(eq(s.shippingZones.sellerId, sellerId))
    .orderBy(asc(s.shippingZones.priority));
}
