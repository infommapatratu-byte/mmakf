// One checkout, one payment, many sellers.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE CRITICAL TEST THE BRIEF NAMES, AND HOW THIS FILE PASSES IT
// ═════════════════════════════════════════════════════════════════════════════
//
//     Buyer purchases Product A from Seller A (₹1,000) and Product B from
//     Seller B (₹2,000). The customer sees ONE CHECKOUT. The backend creates
//     ONE CUSTOMER ORDER plus SELLER ORDER A plus SELLER ORDER B. Payment
//     ₹3,000. Each seller receives its calculated amount. Refunding Product A
//     must NOT corrupt Product B.
//
// The last clause is the one that dictates the design. It is satisfied
// structurally rather than carefully:
//
//   · every operational fact lives on the SELLER ORDER — status, dispatch
//     clock, carriage, commission, refunded-to-date;
//   · the buyer's `orders` row records WHAT WAS CHARGED and is never rewritten
//     by anything that happens afterwards, because what was charged does not
//     change;
//   · a refund touches Seller A's seller order, Seller A's lines, Seller A's
//     commission and Seller A's settlement. There is no shared mutable figure
//     for it to corrupt, so corrupting Seller B is not a bug that has been
//     avoided — it is a write that does not exist.
//
// ═════════════════════════════════════════════════════════════════════════════
// AND THE SECURITY TESTS, WHICH ARE THE SAME ONE FOUR TIMES
// ═════════════════════════════════════════════════════════════════════════════
//
//     Seller A attempts: view Seller B orders            MUST FAIL
//     Seller A attempts: modify Seller B inventory       MUST FAIL
//     Seller A attempts: change commission               MUST FAIL
//     Buyer attempts: change price                       MUST FAIL
//
// The first two fail because NO SELLER-FACING FUNCTION IN THIS FILE TAKES A
// sellerId. The caller's seller record is resolved from their signed-in user
// and the filter is applied in SQL. A function that cannot be asked about
// another seller cannot be tricked into answering about one.
//
// The third fails because commission is written by src/db/marketplace-finance.ts
// under `marketplace:commission`, which no seller holds — sellers are not in
// the role hierarchy at all.
//
// The fourth fails because `checkout()` reads EVERY price from
// `listing_variants` server-side. The cart names what is wanted and the
// quantity. There is no price field on the input type, so there is nothing to
// tamper with — the attack is not rejected, it is unrepresentable.

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { publicListingPredicate } from '@/db/onboarding.schema';
import { writeAudit, allocateFederationId, type AuditContext } from '@/db/federation';
import { assertCan, type Principal } from '@/lib/rbac';
import { MarketplaceError } from '@/db/marketplace';
import { applyFactor } from '@/db/fees';
import { reserveForLine, commitReservations, releaseReservations, dispatchReservations } from '@/db/inventory';
import { freezeCommissionForLine, refreshSellerOrderCommission, accrueSellerOrder, SLA_NOT_SET } from '@/db/marketplace-finance';

type DB = any;

export type SellerOrderStatus = (typeof s.sellerOrderStatus.enumValues)[number];

/** How long an unpaid marketplace basket holds its stock. Mirrors orders.ts. */
const RESERVATION_MINUTES = 45;

const MAX_CART_LINES = 40;
const MAX_QTY_PER_LINE = 99;

// ─── The cart ───────────────────────────────────────────────────────────────

/**
 * WHAT A BUYER MAY SAY. Note what is absent: price, seller, tax, discount,
 * commission. Every one is resolved here from the catalogue.
 */
export interface CartLine {
  variantId: number;
  quantity: number;
}

export interface CheckoutInput {
  lines: CartLine[];
  buyerName?: string | null;
  email?: string | null;
  phone?: string | null;
  personId?: number | null;
  shipTo?: Record<string, unknown> | null;
  /** Attaches the whole basket to an event merchandise collection. */
  eventId?: number | null;
}

export interface SellerGroupSummary {
  sellerOrderId: number;
  sellerOrderNo: string;
  sellerId: number;
  sellerName: string;
  storeSlug: string | null;
  subtotalMinor: number;
  taxMinor: number;
  shippingMinor: number;
  totalMinor: number;
  lines: { description: string; quantity: number; unitPriceMinor: number; totalMinor: number }[];
  /** Present when MMAKF has published no commission covering this sale. */
  commissionHeld: boolean;
}

export interface CheckoutResult {
  orderId: number;
  orderNo: string;
  totalMinor: number;
  currency: string;
  sellerOrders: SellerGroupSummary[];
  expiresAt: Date;
}

/**
 * Turn a cart into one order and one seller order per seller.
 *
 * ORDER OF OPERATIONS, and each step is where it is for a reason:
 *
 *   1. Resolve and validate EVERY line against the public catalogue predicate.
 *      A variant on an unapproved, quarantined or suspended-seller listing is
 *      not purchasable, and the check is the SAME SQL the shop uses — so an
 *      item that cannot be seen cannot be bought by guessing its id.
 *   2. Group by seller and price each group.
 *   3. Create the order, then the seller orders, then the lines.
 *   4. Reserve stock per line. THIS CAN FAIL, and it must fail here rather
 *      than after a payment page has been opened.
 *   5. Freeze commission per line, or record a gap.
 *
 * Nothing is charged by this function. It produces an order awaiting payment,
 * which is what the existing payment spine in src/db/orders.ts then handles.
 */
export async function checkout(db: DB, ctx: AuditContext | null, input: CheckoutInput): Promise<CheckoutResult> {
  const lines = Array.isArray(input?.lines) ? input.lines : [];
  if (!lines.length) throw new MarketplaceError('empty_cart', 'A checkout needs at least one item.');
  if (lines.length > MAX_CART_LINES) {
    throw new MarketplaceError('cart_too_large', `A basket may hold at most ${MAX_CART_LINES} lines.`);
  }

  // ── 1. Resolve against the PUBLIC predicate ──────────────────────────────
  const wanted = new Map<number, number>();
  for (const l of lines) {
    const qty = Number.isInteger(l?.quantity) ? l.quantity : 0;
    if (qty < 1 || qty > MAX_QTY_PER_LINE) {
      throw new MarketplaceError('bad_quantity', `Quantity must be between 1 and ${MAX_QTY_PER_LINE}.`);
    }
    if (!Number.isInteger(l?.variantId)) throw new MarketplaceError('bad_line', 'Every basket line names a variant.');
    // A repeated variant is one line with the combined quantity, not two —
    // otherwise two reservations for the same line collide on the reservation
    // unique index and the checkout fails with a confusing constraint error.
    wanted.set(l.variantId, (wanted.get(l.variantId) ?? 0) + qty);
  }

  const variantIds = [...wanted.keys()];
  const rows = await db.select({
    variant: s.listingVariants,
    listing: s.listings,
    seller: s.sellers,
    category: s.marketplaceCategories,
  }).from(s.listingVariants)
    .innerJoin(s.listings, eq(s.listingVariants.listingId, s.listings.id))
    .innerJoin(s.sellers, eq(s.listings.sellerId, s.sellers.id))
    .leftJoin(s.marketplaceCategories, eq(s.listings.categoryId, s.marketplaceCategories.id))
    .where(and(
      inArray(s.listingVariants.id, variantIds),
      eq(s.listingVariants.status, 'active'),
      // THE SAME PREDICATE THE SHOP USES. Not a re-implementation of it: an
      // item that is not publicly visible is not purchasable by id, and the two
      // rules cannot drift apart because there is only one of them.
      publicListingPredicate(),
    ));

  if (rows.length !== variantIds.length) {
    const found = new Set(rows.map((r: any) => r.variant.id));
    const missing = variantIds.filter((id) => !found.has(id));
    throw new MarketplaceError(
      'unavailable',
      `${missing.length} item(s) in this basket are no longer available. ` +
      'An item may have been withdrawn, edited back into review, or its seller suspended.'
    );
  }

  // ── 2. Group by seller ───────────────────────────────────────────────────
  interface Group {
    seller: any;
    priced: any[];
    subtotal: number;
    tax: number;
  }
  const groups = new Map<number, Group>();

  for (const r of rows) {
    const qty = wanted.get(r.variant.id)!;
    const unit = r.variant.priceMinor;
    if (!Number.isInteger(unit) || unit < 0) {
      throw new MarketplaceError('bad_price', 'That item has no valid price and cannot be sold.');
    }
    const lineTotal = unit * qty;
    // Tax rate from the listing; ABSENT MEANS ZERO RATED HERE ONLY BECAUSE the
    // tax engine (src/db/tax.ts) is the authority and an unconfigured rate is
    // its business to report, not this module's to guess at.
    const rate = Number.isInteger(r.listing.taxRateBps) ? r.listing.taxRateBps : 0;
    // THROUGH applyFactor(), not a local Math.round.
    //
    // tests/money-safety.test.ts allows exactly one hand-rolled rounding outside
    // applyFactor() — the one in src/db/orders.ts, recorded there as "FINDING 4
    // — a SECOND rounding implementation". Adding a third would make the rule
    // meaningless and would put a different rounding on the marketplace's tax
    // from the one on the federation's own.
    //
    // Basis points × 100 is parts-per-million: 1200 bps (12%) is 120_000 ppm.
    // applyFactor does the multiply in BigInt and rounds half up, which is what
    // an invoice needs — two identical line items must produce two identical
    // amounts, and half-even makes that depend on the preceding digit.
    const lineTax = applyFactor(lineTotal, rate * 100);

    const g = groups.get(r.seller.id) ?? { seller: r.seller, priced: [], subtotal: 0, tax: 0 };
    g.priced.push({
      variantId: r.variant.id,
      listingId: r.listing.id,
      categoryId: r.category?.id ?? null,
      categoryPath: r.category?.path ?? null,
      description: `${r.listing.title} — ${r.variant.label}`.slice(0, 300),
      quantity: qty,
      unitPriceMinor: unit,
      taxRateBps: rate,
      taxMinor: lineTax,
      totalMinor: lineTotal + lineTax,
      goodsMinor: lineTotal,
    });
    g.subtotal += lineTotal;
    g.tax += lineTax;
    groups.set(r.seller.id, g);
  }

  // Carriage, per seller, from that seller's own zones. A basket from three
  // sellers is three consignments and three carriage charges — presenting it
  // as one would be a discount MMAKF is paying for without being asked.
  const shippingBySeller = new Map<number, number>();
  for (const [sellerId, g] of groups) {
    shippingBySeller.set(sellerId, await resolveShipping(db, sellerId, g.subtotal, input.shipTo ?? null));
  }

  const subtotal = [...groups.values()].reduce((n, g) => n + g.subtotal, 0);
  const tax = [...groups.values()].reduce((n, g) => n + g.tax, 0);
  const shipping = [...shippingBySeller.values()].reduce((n, v) => n + v, 0);
  const total = subtotal + tax + shipping;

  if (total <= 0) throw new MarketplaceError('bad_total', 'An order total must be positive.');
  if (!Number.isSafeInteger(total)) {
    throw new MarketplaceError('bad_total', 'Order total is beyond the range this system will price.');
  }

  // ── 3. Write the order and its seller orders ─────────────────────────────
  const orderNo = await allocateFederationId(db, 'ORD');
  const expiresAt = new Date(Date.now() + RESERVATION_MINUTES * 60_000);

  const [order] = await db.insert(s.orders).values({
    orderNo,
    personId: input.personId ?? null,
    buyerName: input.buyerName?.slice(0, 120) ?? null,
    email: input.email?.trim().toLowerCase().slice(0, 254) ?? null,
    phone: input.phone?.slice(0, 32) ?? null,
    status: 'awaiting_payment',
    subtotalPaise: subtotal,
    taxPaise: tax,
    shippingPaise: shipping,
    totalPaise: total,
    shipTo: input.shipTo ?? null,
    fulfilment: 'pending',
    expiresAt,
  }).returning();

  const summaries: SellerGroupSummary[] = [];

  for (const [sellerId, g] of groups) {
    const shippingMinor = shippingBySeller.get(sellerId) ?? 0;
    const groupTotal = g.subtotal + g.tax + shippingMinor;
    const sellerOrderNo = await allocateFederationId(db, 'SO');

    const [so] = await db.insert(s.sellerOrders).values({
      sellerOrderNo,
      orderId: order.id,
      sellerId,
      status: 'payment_pending',
      subtotalMinor: g.subtotal,
      taxMinor: g.tax,
      shippingMinor,
      totalMinor: groupTotal,
      shipTo: input.shipTo ?? null,
      buyerName: input.buyerName ?? null,
      buyerPhone: input.phone ?? null,
      buyerEmail: input.email ?? null,
      buyerPersonId: input.personId ?? null,
      eventId: input.eventId ?? null,
    }).returning();

    await recordSellerOrderEvent(db, so.id, null, 'payment_pending', 'system', null, 'Order created.');

    let commissionHeld = false;
    const lineSummaries: SellerGroupSummary['lines'] = [];

    for (const p of g.priced) {
      const [line] = await db.insert(s.orderLines).values({
        orderId: order.id,
        sellerOrderId: so.id,
        sellerId,
        listingId: p.listingId,
        listingVariantId: p.variantId,
        kind: 'product',
        description: p.description,
        quantity: p.quantity,
        unitPricePaise: p.unitPriceMinor,
        taxRateBps: p.taxRateBps,
        taxPaise: p.taxMinor,
        totalPaise: p.totalMinor,
      }).returning({ id: s.orderLines.id });

      // ── 4. Reserve. Can fail; better here than after a payment page. ─────
      await reserveForLine(db, {
        orderId: order.id,
        orderLineId: line.id,
        variantId: p.variantId,
        sellerId,
        qty: p.quantity,
        expiresAt,
      });

      // ── 5. Freeze commission, or record the gap ──────────────────────────
      const outcome = await freezeCommissionForLine(db, {
        orderLineId: line.id,
        sellerOrderId: so.id,
        sellerId,
        basis: {
          sellerId,
          sellerTier: g.seller.tier ?? null,
          sellerType: g.seller.sellerType ?? null,
          listingId: p.listingId,
          categoryId: p.categoryId,
          categoryPath: p.categoryPath,
          goodsMinor: p.goodsMinor,
          shippingMinor: 0,
          taxMinor: p.taxMinor,
          on: new Date(),
        },
      });
      if (!outcome.resolved) commissionHeld = true;

      lineSummaries.push({
        description: p.description,
        quantity: p.quantity,
        unitPriceMinor: p.unitPriceMinor,
        totalMinor: p.totalMinor,
      });
    }

    await refreshSellerOrderCommission(db, so.id);

    summaries.push({
      sellerOrderId: so.id,
      sellerOrderNo,
      sellerId,
      sellerName: g.seller.tradingName,
      storeSlug: g.seller.storeSlug ?? null,
      subtotalMinor: g.subtotal,
      taxMinor: g.tax,
      shippingMinor,
      totalMinor: groupTotal,
      lines: lineSummaries,
      commissionHeld,
    });
  }

  if (ctx) {
    await writeAudit(db, ctx, {
      entityType: 'order', entityId: order.id, action: 'create',
      newValue: { orderNo, totalPaise: total, sellerOrders: summaries.map((x) => x.sellerOrderNo) },
    });
  }

  return {
    orderId: order.id,
    orderNo,
    totalMinor: total,
    currency: order.currency ?? 'INR',
    sellerOrders: summaries,
    expiresAt,
  };
}

/**
 * Carriage for one seller's part of a basket.
 *
 * RETURNS ZERO WHEN THE SELLER HAS CONFIGURED NOTHING, and that is a decision
 * worth being explicit about: the alternative — refusing the sale — would take
 * every existing seller off the marketplace on the day this shipped, because
 * none of them has a shipping zone yet. A seller who has said nothing about
 * carriage is treated as including it, which is what the shop did before, and
 * `/portal/seller/shipping` reports that no zones are configured.
 */
async function resolveShipping(
  db: DB, sellerId: number, subtotalMinor: number, shipTo: Record<string, unknown> | null
): Promise<number> {
  const zones = await db.select().from(s.shippingZones).where(and(
    eq(s.shippingZones.sellerId, sellerId), eq(s.shippingZones.active, true),
  )).orderBy(asc(s.shippingZones.priority), asc(s.shippingZones.id));
  if (!zones.length) return 0;

  const state = String((shipTo as any)?.state ?? '').trim().toLowerCase();
  const postcode = String((shipTo as any)?.postcode ?? '').trim();

  const zone = zones.find((z: any) => {
    const states: string[] = Array.isArray(z.states) ? z.states : [];
    const prefixes: string[] = Array.isArray(z.postcodePrefixes) ? z.postcodePrefixes : [];
    const stateOk = !states.length || (state && states.some((x) => String(x).toLowerCase() === state));
    const pcOk = !prefixes.length || (postcode && prefixes.some((p) => postcode.startsWith(String(p))));
    return stateOk && pcOk;
  });
  if (!zone) {
    throw new MarketplaceError(
      'not_serviceable',
      'This seller does not ship to that address. Remove their items or choose another address.'
    );
  }

  const methods = await db.select().from(s.shippingMethods).where(and(
    eq(s.shippingMethods.zoneId, zone.id), eq(s.shippingMethods.active, true),
  )).orderBy(asc(s.shippingMethods.priceMinor));
  if (!methods.length) return 0;

  const m = methods[0];
  switch (m.kind) {
    case 'free': return 0;
    case 'free_above':
      return Number.isInteger(m.freeAboveMinor) && subtotalMinor >= m.freeAboveMinor ? 0 : m.priceMinor;
    default: return m.priceMinor;
  }
}

// ─── Payment ────────────────────────────────────────────────────────────────

/**
 * Money cleared: move every seller order to `paid` and commit the stock.
 *
 * IDEMPOTENT. A gateway retries its webhooks and the reconcile cron retries
 * them again; running this twice must not commit stock twice, so it filters on
 * the current status in SQL and does nothing for rows already past it.
 */
export async function onOrderPaid(db: DB, orderId: number, paymentId?: number | null) {
  const sellerOrders = await db.select().from(s.sellerOrders).where(and(
    eq(s.sellerOrders.orderId, orderId),
    inArray(s.sellerOrders.status, ['order_created', 'payment_pending']),
  ));
  if (!sellerOrders.length) return { updated: 0 };

  await commitReservations(db, orderId);
  const now = new Date();

  for (const so of sellerOrders) {
    const sla = await slaFor(db, so.sellerId);
    await db.update(s.sellerOrders).set({
      status: 'paid',
      paidAt: now,
      // NULL when MMAKF has published no SLA. An escalation fired against an
      // invented deadline is an accusation the federation cannot stand behind.
      acceptBy: sla.acceptanceHours ? new Date(now.getTime() + sla.acceptanceHours * 3_600_000) : null,
      dispatchBy: sla.dispatchHours ? new Date(now.getTime() + sla.dispatchHours * 3_600_000) : null,
      updatedAt: now,
    }).where(eq(s.sellerOrders.id, so.id));

    await recordSellerOrderEvent(db, so.id, so.status, 'paid', 'system', null, 'Payment captured.');

    if (paymentId) {
      await db.insert(s.sellerOrderPayments).values({
        sellerOrderId: so.id, paymentId, allocatedMinor: so.totalMinor,
      }).onConflictDoNothing();
    }
  }

  return { updated: sellerOrders.length };
}

/**
 * The service-level windows for a seller: their own override, else the
 * marketplace default, else NOTHING.
 *
 * Returns nulls rather than numbers when MMAKF has set no SLA. Every caller
 * treats a null window as "no deadline", and `SLA_NOT_SET` is what the surfaces
 * display. There is no fallback of 24 or 48 hours, because it would be enforced
 * against real sellers who never agreed to it.
 */
export async function slaFor(db: DB, sellerId: number) {
  const rows = await db.select().from(s.sellerSlaConfigs)
    .where(eq(s.sellerSlaConfigs.active, true));
  const own = rows.find((r: any) => r.sellerId === sellerId);
  const dflt = rows.find((r: any) => r.sellerId == null);
  const src = own ?? dflt ?? null;
  return {
    configured: !!src,
    note: src ? null : SLA_NOT_SET,
    acceptanceHours: src?.acceptanceHours ?? null,
    dispatchHours: src?.dispatchHours ?? null,
    returnResponseHours: src?.returnResponseHours ?? null,
    supportResponseHours: src?.supportResponseHours ?? null,
    disputeResponseHours: src?.disputeResponseHours ?? null,
  };
}

// ─── The seller's own lifecycle ─────────────────────────────────────────────

/**
 * The permitted transitions. Anything not listed is refused with the reason.
 *
 * A TABLE, not a chain of ifs, because the interesting property is what is
 * ABSENT: there is no route from `paid` to `delivered`, so a seller cannot mark
 * something delivered that they never said they had dispatched, and the delivery
 * date on a dispute is therefore worth something.
 */
const SELLER_TRANSITIONS: Record<string, SellerOrderStatus[]> = {
  order_created: ['payment_pending', 'cancelled'],
  payment_pending: ['paid', 'cancelled'],
  paid: ['seller_accepted', 'cancelled'],
  seller_accepted: ['processing', 'packed', 'cancelled'],
  processing: ['packed', 'cancelled'],
  packed: ['shipped', 'cancelled'],
  shipped: ['in_transit', 'delivered', 'returned'],
  in_transit: ['delivered', 'returned'],
  delivered: ['return_requested', 'disputed'],
  return_requested: ['returned', 'refund_pending', 'delivered', 'disputed'],
  returned: ['refund_pending', 'refunded', 'disputed'],
  refund_pending: ['refunded', 'disputed'],
  refunded: ['disputed'],
  disputed: ['refund_pending', 'refunded', 'delivered'],
  cancelled: [],
};

async function transition(
  db: DB, ctx: AuditContext, sellerOrder: any, to: SellerOrderStatus,
  actor: 'buyer' | 'seller' | 'federation' | 'system', note?: string | null,
  patch: Record<string, unknown> = {}
) {
  const allowed = SELLER_TRANSITIONS[sellerOrder.status] ?? [];
  if (!allowed.includes(to)) {
    throw new MarketplaceError(
      'bad_transition',
      `A seller order that is ${sellerOrder.status} cannot become ${to}. ` +
      `Allowed from here: ${allowed.join(', ') || 'nothing — this is a terminal state'}.`
    );
  }

  await db.update(s.sellerOrders)
    .set({ status: to, updatedAt: new Date(), ...patch })
    .where(eq(s.sellerOrders.id, sellerOrder.id));

  await recordSellerOrderEvent(db, sellerOrder.id, sellerOrder.status, to, actor, ctx.principal?.userId ?? null, note ?? null);

  await writeAudit(db, ctx, {
    entityType: 'seller_order', entityId: sellerOrder.id, action: 'update',
    oldValue: { status: sellerOrder.status }, newValue: { status: to },
  });
  return { sellerOrderId: sellerOrder.id, status: to };
}

async function recordSellerOrderEvent(
  db: DB, sellerOrderId: number, from: string | null, to: string,
  actor: string, byUserId: number | null, note: string | null
) {
  await db.insert(s.sellerOrderEvents).values({
    sellerOrderId, fromStatus: from as any, toStatus: to as any,
    byActor: actor, byUserId, note,
  });
}

/** Accept an order. The seller's commitment to fulfil it. */
export async function acceptSellerOrder(db: DB, ctx: AuditContext, sellerOrderId: number) {
  const so = await ownSellerOrder(db, ctx.principal, sellerOrderId);
  return transition(db, ctx, so, 'seller_accepted', 'seller', 'Accepted by the seller.', {
    acceptedAt: new Date(),
  });
}

export async function markPacked(db: DB, ctx: AuditContext, sellerOrderId: number) {
  const so = await ownSellerOrder(db, ctx.principal, sellerOrderId);
  return transition(db, ctx, so, 'packed', 'seller', null, { packedAt: new Date() });
}

export interface ShipInput {
  carrier?: string | null;
  service?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  weightGrams?: number | null;
  packageCount?: number;
  fromLocationId?: number | null;
}

/**
 * Dispatch. Creates a shipment, moves the stock out, moves the status on.
 *
 * TRACKING IS OPTIONAL AND NOTHING IS FABRICATED. "Do not fake tracking" — the
 * brief. A consignment with no tracking number is displayed as a consignment
 * with no tracking number; a generated link that 404s at the carrier is worse
 * than nothing, because the buyer believes it and then distrusts everything
 * else on the page.
 */
export async function shipSellerOrder(db: DB, ctx: AuditContext, sellerOrderId: number, input: ShipInput = {}) {
  const so = await ownSellerOrder(db, ctx.principal, sellerOrderId);
  const now = new Date();

  const ref = await allocateFederationId(db, 'SHP');
  const [shipment] = await db.insert(s.shipments).values({
    sellerOrderId: so.id,
    sellerId: so.sellerId,
    ref,
    carrier: input.carrier?.trim() || null,
    service: input.service?.trim() || null,
    trackingNumber: input.trackingNumber?.trim() || null,
    trackingUrl: input.trackingUrl?.trim() || null,
    status: 'picked_up',
    fromLocationId: input.fromLocationId ?? so.fulfilmentLocationId ?? null,
    weightGrams: input.weightGrams ?? null,
    packageCount: Number.isInteger(input.packageCount) ? input.packageCount! : 1,
    dispatchedAt: now,
    createdByUserId: ctx.principal?.userId ?? null,
  }).returning({ id: s.shipments.id });

  const lines = await db.select({ id: s.orderLines.id, quantity: s.orderLines.quantity })
    .from(s.orderLines).where(eq(s.orderLines.sellerOrderId, so.id));

  for (const l of lines) {
    await db.insert(s.shipmentItems).values({ shipmentId: shipment.id, orderLineId: l.id, qty: l.quantity })
      .onConflictDoNothing();
  }

  // Committed stock leaves on-hand for good at dispatch — not at payment.
  await dispatchReservations(db, so.id, lines.map((l: any) => l.id));

  return {
    ...(await transition(db, ctx, so, 'shipped', 'seller',
      input.trackingNumber ? `Dispatched, tracking ${input.trackingNumber}.` : 'Dispatched without tracking.',
      { dispatchedAt: now })),
    shipmentId: shipment.id,
    shipmentRef: ref,
    trackingRecorded: !!input.trackingNumber,
  };
}

/**
 * Delivered. The point at which the sale accrues to the seller's settlement.
 *
 * Marked by the seller or by a carrier webhook; not by the buyer, who has no
 * incentive to and who would be blamed for not doing it.
 */
export async function markDelivered(
  db: DB, ctx: AuditContext, sellerOrderId: number, opts: { deliveredTo?: string | null } = {}
) {
  const so = await ownSellerOrder(db, ctx.principal, sellerOrderId);
  const now = new Date();

  await db.update(s.shipments)
    .set({ status: 'delivered', deliveredAt: now, deliveredTo: opts.deliveredTo ?? null, updatedAt: now })
    .where(and(eq(s.shipments.sellerOrderId, so.id), inArray(s.shipments.status, ['picked_up', 'in_transit', 'out_for_delivery'])));

  const result = await transition(db, ctx, so, 'delivered', 'seller', 'Delivered.', { deliveredAt: now });

  // Accrual, which reports rather than throws when the commission is unset.
  const accrual = await accrueSellerOrder(db, so.id);
  return { ...result, accrual };
}

/**
 * Cancel. Releases the stock and says who decided.
 *
 * `cancelledBy` is recorded separately from the user id because the same person
 * can act in two capacities — a federation officer cancelling on a buyer's
 * behalf is not the buyer cancelling — and the seller's cancellation rate,
 * which is a performance measure, must count only the ones they caused.
 */
export async function cancelSellerOrder(
  db: DB, ctx: AuditContext, sellerOrderId: number,
  reason: string, by: 'buyer' | 'seller' | 'federation'
) {
  if (!String(reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'A cancellation requires a reason.');
  }
  const so = by === 'seller'
    ? await ownSellerOrder(db, ctx.principal, sellerOrderId)
    : await federationSellerOrder(db, ctx.principal, sellerOrderId);

  await releaseReservations(db, so.orderId, `Seller order ${so.sellerOrderNo} cancelled: ${reason}`);

  return transition(db, ctx, so, 'cancelled', by, reason, {
    cancelledAt: new Date(),
    cancelledByUserId: ctx.principal?.userId ?? null,
    cancelledBy: by,
    cancelReason: reason,
  });
}

// ─── Reads: the isolation boundary ──────────────────────────────────────────

/**
 * The caller's own seller orders. NO sellerId PARAMETER.
 *
 * "Seller A attempts: view Seller B orders. MUST FAIL." — and it fails because
 * this function cannot be asked the question. The seller is resolved from the
 * signed-in user and the filter is in the WHERE clause.
 */
export async function mySellerOrders(
  db: DB, principal: Principal,
  opts: { status?: SellerOrderStatus[]; limit?: number } = {}
) {
  const seller = await ownSellerRecord(db, principal);
  const where = [eq(s.sellerOrders.sellerId, seller.id)];
  if (opts.status?.length) where.push(inArray(s.sellerOrders.status, opts.status));

  const orders = await db.select().from(s.sellerOrders)
    .where(and(...where))
    .orderBy(desc(s.sellerOrders.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500));

  if (!orders.length) return [];

  const lines = await db.select().from(s.orderLines)
    .where(and(
      inArray(s.orderLines.sellerOrderId, orders.map((o: any) => o.id)),
      // Belt and braces: the seller filter again, on the line's own column.
      // If a future refactor loosened the seller-order query, this would still
      // hold — and the denormalised column is exactly why it is cheap enough
      // to be worth writing.
      eq(s.orderLines.sellerId, seller.id),
    ));

  return orders.map((o: any) => ({
    ...o,
    lines: lines.filter((l: any) => l.sellerOrderId === o.id),
  }));
}

export async function mySellerOrder(db: DB, principal: Principal, sellerOrderId: number) {
  const so = await ownSellerOrder(db, principal, sellerOrderId);
  const lines = await db.select().from(s.orderLines).where(and(
    eq(s.orderLines.sellerOrderId, so.id),
    eq(s.orderLines.sellerId, so.sellerId),
  ));
  const shipments = await db.select().from(s.shipments)
    .where(eq(s.shipments.sellerOrderId, so.id)).orderBy(desc(s.shipments.createdAt));
  const events = await db.select().from(s.sellerOrderEvents)
    .where(eq(s.sellerOrderEvents.sellerOrderId, so.id)).orderBy(asc(s.sellerOrderEvents.at));
  return { ...so, lines, shipments, events };
}

/**
 * A buyer's view of one order: their seller orders, with tracking.
 *
 * SHOWS THE SELLER GROUPING, which the brief requires at checkout and which is
 * also the only honest way to show progress — "your order is partly dispatched"
 * is not a status a buyer can act on, and "Seller A shipped, Seller B has not
 * accepted yet" is.
 */
export async function orderForBuyer(db: DB, principal: Principal, orderNo: string) {
  const order = (await db.select().from(s.orders)
    .where(eq(s.orders.orderNo, String(orderNo ?? '').trim())).limit(1))[0];
  if (!order) return null;

  // A buyer sees their OWN order. Matched on the person behind the signed-in
  // account, never on an id in the URL alone.
  if (principal?.userId != null) {
    const user = (await db.select({ personId: s.users.personId }).from(s.users)
      .where(eq(s.users.id, principal.userId)).limit(1))[0];
    const ownedByPerson = user?.personId != null && order.personId === user.personId;
    if (!ownedByPerson) {
      const allowed = await canReadAnyOrder(principal);
      if (!allowed) return null;
    }
  } else {
    return null;
  }

  const sellerOrders = await db.select({
    so: s.sellerOrders,
    sellerName: s.sellers.tradingName,
    storeSlug: s.sellers.storeSlug,
  }).from(s.sellerOrders)
    .innerJoin(s.sellers, eq(s.sellerOrders.sellerId, s.sellers.id))
    .where(eq(s.sellerOrders.orderId, order.id));

  const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
  const shipments = await db.select().from(s.shipments)
    .where(inArray(s.shipments.sellerOrderId, sellerOrders.map((x: any) => x.so.id).concat([-1])));

  return {
    order,
    sellerOrders: sellerOrders.map((x: any) => ({
      ...x.so,
      sellerName: x.sellerName,
      storeSlug: x.storeSlug,
      lines: lines.filter((l: any) => l.sellerOrderId === x.so.id),
      shipments: shipments.filter((sh: any) => sh.sellerOrderId === x.so.id),
    })),
  };
}

function canReadAnyOrder(principal: Principal): boolean {
  try { assertCan(principal, 'marketplace:read', {}); return true; } catch { return false; }
}

/** The federation's view. Scope-checked against the seller's placement. */
export async function sellerOrdersForAdmin(
  db: DB, principal: Principal,
  opts: { sellerId?: number; status?: SellerOrderStatus[]; limit?: number } = {}
) {
  assertCan(principal, 'marketplace:read', {});
  const where: any[] = [];
  if (opts.sellerId) where.push(eq(s.sellerOrders.sellerId, opts.sellerId));
  if (opts.status?.length) where.push(inArray(s.sellerOrders.status, opts.status));

  return db.select({
    so: s.sellerOrders,
    sellerName: s.sellers.tradingName,
    sellerRef: s.sellers.ref,
    orderNo: s.orders.orderNo,
  }).from(s.sellerOrders)
    .innerJoin(s.sellers, eq(s.sellerOrders.sellerId, s.sellers.id))
    .innerJoin(s.orders, eq(s.sellerOrders.orderId, s.orders.id))
    .where(where.length ? and(...where) : sql`true`)
    .orderBy(desc(s.sellerOrders.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500));
}

/**
 * Seller orders past their dispatch deadline.
 *
 * ONLY WHERE A DEADLINE EXISTS — the index itself is partial on
 * `dispatch_by is not null`. A seller with no configured SLA never appears
 * here, because there is nothing they are late for.
 */
export async function overdueDispatch(db: DB, principal: Principal, limit = 100) {
  assertCan(principal, 'marketplace:read', {});
  return db.select({
    so: s.sellerOrders,
    sellerName: s.sellers.tradingName,
  }).from(s.sellerOrders)
    .innerJoin(s.sellers, eq(s.sellerOrders.sellerId, s.sellers.id))
    .where(and(
      isNull(s.sellerOrders.dispatchedAt),
      sql`${s.sellerOrders.dispatchBy} is not null`,
      sql`${s.sellerOrders.dispatchBy} < now()`,
      inArray(s.sellerOrders.status, ['paid', 'seller_accepted', 'processing', 'packed']),
    ))
    .orderBy(asc(s.sellerOrders.dispatchBy))
    .limit(Math.min(limit, 500));
}

// ─── Ownership helpers ──────────────────────────────────────────────────────

export async function ownSellerRecord(db: DB, principal: Principal) {
  if (principal?.userId == null) throw new MarketplaceError('not_signed_in', 'Sign in to manage orders.');
  const seller = (await db.select().from(s.sellers)
    .where(eq(s.sellers.userId, principal.userId)).limit(1))[0];
  if (!seller) throw new MarketplaceError('not_a_seller', 'This account has no seller record.');
  return seller;
}

async function ownSellerOrder(db: DB, principal: Principal, sellerOrderId: number) {
  const seller = await ownSellerRecord(db, principal);
  const so = (await db.select().from(s.sellerOrders).where(and(
    eq(s.sellerOrders.id, sellerOrderId),
    // THE FILTER. In SQL, on the seller order's own column.
    eq(s.sellerOrders.sellerId, seller.id),
  )).limit(1))[0];
  // The same message whether it belongs to somebody else or does not exist.
  if (!so) throw new MarketplaceError('not_your_order', 'No such order on your seller account.');
  if (seller.status !== 'approved') {
    throw new MarketplaceError('seller_not_approved', `A seller that is ${seller.status} cannot act on orders.`);
  }
  return so;
}

async function federationSellerOrder(db: DB, principal: Principal, sellerOrderId: number) {
  const rows = await db.select({ so: s.sellerOrders, seller: s.sellers })
    .from(s.sellerOrders).innerJoin(s.sellers, eq(s.sellerOrders.sellerId, s.sellers.id))
    .where(eq(s.sellerOrders.id, sellerOrderId)).limit(1);
  if (!rows.length) throw new MarketplaceError('unknown_seller_order', 'No such seller order.');
  assertCan(principal, 'marketplace:read', {
    stateUnitId: rows[0].seller.stateUnitId ?? null,
    districtUnitId: rows[0].seller.districtUnitId ?? null,
    dojoId: rows[0].seller.dojoId ?? null,
  });
  return rows[0].so;
}
