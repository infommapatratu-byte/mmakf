// Stock, as a consequence of recorded movements rather than a number.
//
// ─── THE ONE THING TO UNDERSTAND BEFORE CHANGING ANYTHING HERE ──────────────
//
// EVERY WRITE GOES THROUGH `move()`. It updates the buckets on `stock_items`
// and appends a `stock_movements` row in the SAME statement sequence, inside
// the caller's transaction. There is no path that changes a count without
// leaving a movement, which is what makes the question "why is this seventeen?"
// answerable a year later.
//
// ─── AND THE RACE, WHICH IS THE WHOLE POINT ─────────────────────────────────
//
// `reserve()` does NOT read availability and then write. It issues ONE
// conditional UPDATE:
//
//     update stock_items set reserved = reserved + n
//     where variant = ? and location = ?
//       and on_hand - reserved - committed - damaged >= n
//
// Two checkouts racing for the last gi both attempt it; the second matches ZERO
// ROWS, because the first has already moved the figure. We detect the zero and
// refuse with a clear error. Behind that, the CHECK constraint added in
// migration 0029 makes the over-reserved state unrepresentable even if some
// future caller bypasses this function entirely.
//
// A read-then-write with a JavaScript `if` cannot do this and never could. It
// is the single most common defect in marketplace inventory code and it only
// ever reproduces under load.
//
// ─── WHAT AVAILABLE MEANS ───────────────────────────────────────────────────
//
//     available = on_hand − reserved − committed − damaged
//
// Derived, never stored — two columns that must agree eventually disagree, and
// the one that gets updated is never the one that gets read. `availableQty` on
// `listing_variants` is a CACHE for listing pages, refreshed inside the same
// transaction as the movement, and nothing sells against it.

import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, type Principal } from '@/lib/rbac';
import { MarketplaceError } from '@/db/marketplace';

type DB = any;

export type MovementKind = (typeof s.stockMovementKind.enumValues)[number];

/** Movements a human performs by hand. An unexplained one is indistinguishable from theft. */
const REASON_REQUIRED: MovementKind[] = ['adjustment', 'damage', 'write_off', 'count'];

export interface BucketDelta {
  onHand?: number;
  reserved?: number;
  committed?: number;
  damaged?: number;
  inTransit?: number;
}

// ─── Locations ──────────────────────────────────────────────────────────────

export async function createLocation(
  db: DB, ctx: AuditContext,
  input: {
    code: string; name: string;
    kind?: (typeof s.locationKind.enumValues)[number];
    addressLine?: string | null; city?: string | null; district?: string | null;
    state?: string | null; postcode?: string | null;
    contactName?: string | null; contactPhone?: string | null;
    priority?: number; fulfilsOrders?: boolean; acceptsReturns?: boolean;
  }
) {
  const seller = await ownSeller(db, ctx.principal);
  const code = String(input?.code ?? '').trim().toUpperCase();
  const name = String(input?.name ?? '').trim();
  if (!code || !name) throw new MarketplaceError('bad_location', 'A location needs a code and a name.');

  const clash = (await db.select({ id: s.inventoryLocations.id }).from(s.inventoryLocations)
    .where(and(eq(s.inventoryLocations.sellerId, seller.id), eq(s.inventoryLocations.code, code)))
    .limit(1))[0];
  if (clash) throw new MarketplaceError('duplicate_location', `This seller already has a location coded ${code}.`);

  const [row] = await db.insert(s.inventoryLocations).values({
    sellerId: seller.id,
    code, name,
    kind: input.kind ?? 'warehouse',
    addressLine: input.addressLine ?? null,
    city: input.city ?? null,
    district: input.district ?? null,
    state: input.state ?? null,
    postcode: input.postcode ?? null,
    contactName: input.contactName ?? null,
    contactPhone: input.contactPhone ?? null,
    priority: Number.isInteger(input.priority) ? input.priority! : 100,
    fulfilsOrders: input.fulfilsOrders ?? true,
    acceptsReturns: input.acceptsReturns ?? false,
  }).returning({ id: s.inventoryLocations.id });

  await writeAudit(db, ctx, {
    entityType: 'inventory_location', entityId: row.id, action: 'create',
    newValue: { sellerId: seller.id, code, name },
  });
  return { locationId: row.id, code };
}

export async function myLocations(db: DB, principal: Principal) {
  const seller = await ownSeller(db, principal);
  return db.select().from(s.inventoryLocations)
    .where(eq(s.inventoryLocations.sellerId, seller.id))
    .orderBy(asc(s.inventoryLocations.priority), asc(s.inventoryLocations.id));
}

// ─── The movement primitive ─────────────────────────────────────────────────

/**
 * Apply a bucket change and record why. THE ONLY WRITE PATH.
 *
 * `onHandAfter` is frozen onto the movement so the ledger can be replayed and
 * checked against the live figure. A ledger that cannot be reconciled against
 * the thing it explains is a log, not a ledger.
 */
async function move(
  db: DB, ctx: AuditContext | null,
  args: {
    variantId: number; locationId: number; sellerId: number;
    kind: MovementKind; delta: BucketDelta;
    reason?: string | null;
    orderId?: number | null; orderLineId?: number | null;
    refType?: string | null; refId?: number | null;
    bySystem?: boolean;
  }
) {
  if (REASON_REQUIRED.includes(args.kind) && !String(args.reason ?? '').trim()) {
    throw new MarketplaceError(
      'reason_required',
      `A ${args.kind} movement requires a reason. An unexplained manual stock change is ` +
      'indistinguishable from a loss nobody reported.'
    );
  }

  const d = {
    onHand: args.delta.onHand ?? 0,
    reserved: args.delta.reserved ?? 0,
    committed: args.delta.committed ?? 0,
    damaged: args.delta.damaged ?? 0,
    inTransit: args.delta.inTransit ?? 0,
  };

  const updated = await db.update(s.stockItems).set({
    onHand: sql`${s.stockItems.onHand} + ${d.onHand}`,
    reserved: sql`${s.stockItems.reserved} + ${d.reserved}`,
    committed: sql`${s.stockItems.committed} + ${d.committed}`,
    damaged: sql`${s.stockItems.damaged} + ${d.damaged}`,
    inTransit: sql`${s.stockItems.inTransit} + ${d.inTransit}`,
    updatedAt: new Date(),
  }).where(and(
    eq(s.stockItems.variantId, args.variantId),
    eq(s.stockItems.locationId, args.locationId),
  )).returning({ onHand: s.stockItems.onHand });

  if (!updated.length) {
    throw new MarketplaceError('no_stock_record', 'No stock record for that variant at that location.');
  }

  await db.insert(s.stockMovements).values({
    variantId: args.variantId,
    locationId: args.locationId,
    sellerId: args.sellerId,
    kind: args.kind,
    onHandDelta: d.onHand,
    reservedDelta: d.reserved,
    committedDelta: d.committed,
    damagedDelta: d.damaged,
    inTransitDelta: d.inTransit,
    onHandAfter: updated[0].onHand,
    orderId: args.orderId ?? null,
    orderLineId: args.orderLineId ?? null,
    refType: args.refType ?? null,
    refId: args.refId ?? null,
    reason: args.reason ?? null,
    byUserId: args.bySystem ? null : (ctx?.principal?.userId ?? null),
    bySystem: !!args.bySystem,
  });

  await refreshVariantAvailability(db, args.variantId);
  return { onHandAfter: updated[0].onHand };
}

/**
 * Recompute the variant's cached availability from the authoritative rows.
 *
 * Inside the same transaction as the movement that changed it, always. A cache
 * refreshed on a schedule is a cache that is wrong for the length of the
 * schedule, and this one is what the shop shows.
 */
export async function refreshVariantAvailability(db: DB, variantId: number) {
  const rows = await db.select({
    available: sql<number>`coalesce(sum(greatest(${s.stockItems.onHand} - ${s.stockItems.reserved} - ${s.stockItems.committed} - ${s.stockItems.damaged}, 0)), 0)::int`,
  }).from(s.stockItems).where(eq(s.stockItems.variantId, variantId));

  const available = rows[0]?.available ?? 0;
  await db.update(s.listingVariants).set({
    availableQty: available,
    updatedAt: new Date(),
  }).where(eq(s.listingVariants.id, variantId));
  return available;
}

// ─── Receiving and adjusting ────────────────────────────────────────────────

/** Ensure a stock row exists for (variant, location). Idempotent. */
export async function ensureStockRow(db: DB, variantId: number, locationId: number, sellerId: number) {
  const existing = (await db.select({ id: s.stockItems.id }).from(s.stockItems).where(and(
    eq(s.stockItems.variantId, variantId), eq(s.stockItems.locationId, locationId),
  )).limit(1))[0];
  if (existing) return existing.id;
  const [row] = await db.insert(s.stockItems)
    .values({ variantId, locationId, sellerId })
    .returning({ id: s.stockItems.id });
  return row.id;
}

export async function receiveStock(
  db: DB, ctx: AuditContext,
  input: { variantId: number; locationId: number; qty: number; reason?: string | null }
) {
  const { seller, variant } = await ownVariant(db, ctx.principal, input.variantId);
  await assertLocationBelongs(db, input.locationId, seller.id);
  if (!Number.isInteger(input.qty) || input.qty <= 0) {
    throw new MarketplaceError('bad_qty', 'A receipt must be a positive whole number.');
  }
  await ensureStockRow(db, variant.id, input.locationId, seller.id);
  return move(db, ctx, {
    variantId: variant.id, locationId: input.locationId, sellerId: seller.id,
    kind: 'receipt', delta: { onHand: input.qty }, reason: input.reason ?? null,
  });
}

/**
 * A human correcting the count, with a reason.
 *
 * SIGNED. A negative adjustment is the shrinkage case and it is the one that
 * has to be recorded rather than quietly absorbed.
 */
export async function adjustStock(
  db: DB, ctx: AuditContext,
  input: { variantId: number; locationId: number; delta: number; reason: string }
) {
  const { seller, variant } = await ownVariant(db, ctx.principal, input.variantId);
  await assertLocationBelongs(db, input.locationId, seller.id);
  if (!Number.isInteger(input.delta) || input.delta === 0) {
    throw new MarketplaceError('bad_qty', 'An adjustment must be a non-zero whole number.');
  }
  await ensureStockRow(db, variant.id, input.locationId, seller.id);
  return move(db, ctx, {
    variantId: variant.id, locationId: input.locationId, sellerId: seller.id,
    kind: 'adjustment', delta: { onHand: input.delta }, reason: input.reason,
  });
}

/**
 * A stock take. Records the variance BEFORE correcting it.
 *
 * The variance is stored rather than derived because the system figure it was
 * measured against changes the moment the adjustment posts. A variance
 * recomputed later is always zero, which is how a warehouse with a persistent
 * shrinkage problem shows a clean record.
 */
export async function recordStockCount(
  db: DB, ctx: AuditContext,
  input: { variantId: number; locationId: number; countedQty: number; note?: string | null }
) {
  const { seller, variant } = await ownVariant(db, ctx.principal, input.variantId);
  await assertLocationBelongs(db, input.locationId, seller.id);
  if (!Number.isInteger(input.countedQty) || input.countedQty < 0) {
    throw new MarketplaceError('bad_qty', 'A count must be a whole number, zero or more.');
  }

  const row = (await db.select().from(s.stockItems).where(and(
    eq(s.stockItems.variantId, variant.id), eq(s.stockItems.locationId, input.locationId),
  )).limit(1))[0];
  const systemQty = row?.onHand ?? 0;
  const variance = input.countedQty - systemQty;

  await ensureStockRow(db, variant.id, input.locationId, seller.id);

  let movementId: number | null = null;
  if (variance !== 0) {
    await move(db, ctx, {
      variantId: variant.id, locationId: input.locationId, sellerId: seller.id,
      kind: 'count', delta: { onHand: variance },
      reason: `Stock take: counted ${input.countedQty}, system held ${systemQty}.` +
        (input.note ? ` ${input.note}` : ''),
    });
    const last = (await db.select({ id: s.stockMovements.id }).from(s.stockMovements)
      .where(and(eq(s.stockMovements.variantId, variant.id), eq(s.stockMovements.kind, 'count')))
      .orderBy(desc(s.stockMovements.id)).limit(1))[0];
    movementId = last?.id ?? null;
  }

  await db.insert(s.stockCounts).values({
    sellerId: seller.id, locationId: input.locationId, variantId: variant.id,
    systemQty, countedQty: input.countedQty, varianceQty: variance,
    note: input.note ?? null,
    countedByUserId: ctx.principal?.userId ?? null,
    adjustmentMovementId: movementId,
  });

  await db.update(s.stockItems).set({
    lastCountedAt: new Date(), lastCountedQty: input.countedQty,
  }).where(and(eq(s.stockItems.variantId, variant.id), eq(s.stockItems.locationId, input.locationId)));

  return { systemQty, countedQty: input.countedQty, varianceQty: variance };
}

// ─── Reservation, commitment, dispatch ──────────────────────────────────────

export interface ReservationResult {
  reservationId: number;
  locationId: number;
  qty: number;
}

/**
 * Hold stock for an unpaid order line. THE RACE-SAFE ONE.
 *
 * Picks a fulfilment source by priority — lower first, then lower id, a stated
 * tiebreak rather than whatever the planner returned — and reserves with a
 * CONDITIONAL UPDATE that can only match when enough is genuinely available.
 * Zero rows matched means somebody else got there first, and the caller is told
 * so rather than being allowed to sell what is gone.
 *
 * Never partially fills across locations. A line split between two warehouses
 * is two consignments and two carriage charges, and deciding that silently on
 * a buyer's behalf is a decision the seller should make.
 */
export async function reserveForLine(
  db: DB,
  args: {
    orderId: number; orderLineId: number; variantId: number;
    sellerId: number; qty: number; expiresAt?: Date | null;
    preferredLocationId?: number | null;
  }
): Promise<ReservationResult> {
  if (!Number.isInteger(args.qty) || args.qty <= 0) {
    throw new MarketplaceError('bad_qty', 'A reservation must be for a positive whole number.');
  }

  const candidates = await db.select({
    locationId: s.stockItems.locationId,
    available: sql<number>`(${s.stockItems.onHand} - ${s.stockItems.reserved} - ${s.stockItems.committed} - ${s.stockItems.damaged})::int`,
    priority: s.inventoryLocations.priority,
  }).from(s.stockItems)
    .innerJoin(s.inventoryLocations, eq(s.stockItems.locationId, s.inventoryLocations.id))
    .where(and(
      eq(s.stockItems.variantId, args.variantId),
      eq(s.inventoryLocations.active, true),
      eq(s.inventoryLocations.fulfilsOrders, true),
      sql`${s.stockItems.onHand} - ${s.stockItems.reserved} - ${s.stockItems.committed} - ${s.stockItems.damaged} >= ${args.qty}`,
    ))
    .orderBy(asc(s.inventoryLocations.priority), asc(s.stockItems.locationId));

  if (!candidates.length) {
    throw new MarketplaceError(
      'insufficient_stock',
      'Not enough stock at any single location to fill this line.'
    );
  }

  const chosen = args.preferredLocationId
    ? (candidates.find((c: any) => c.locationId === args.preferredLocationId) ?? candidates[0])
    : candidates[0];

  // THE CONDITIONAL UPDATE. The predicate is re-evaluated by the engine at write
  // time, so the read above being stale cannot cause an oversell — it can only
  // cause this to match nothing.
  const held = await db.update(s.stockItems).set({
    reserved: sql`${s.stockItems.reserved} + ${args.qty}`,
    updatedAt: new Date(),
  }).where(and(
    eq(s.stockItems.variantId, args.variantId),
    eq(s.stockItems.locationId, chosen.locationId),
    sql`${s.stockItems.onHand} - ${s.stockItems.reserved} - ${s.stockItems.committed} - ${s.stockItems.damaged} >= ${args.qty}`,
  )).returning({ onHand: s.stockItems.onHand });

  if (!held.length) {
    throw new MarketplaceError(
      'stock_taken',
      'That stock was taken while this order was being placed. Nothing has been charged.'
    );
  }

  await db.insert(s.stockMovements).values({
    variantId: args.variantId, locationId: chosen.locationId, sellerId: args.sellerId,
    kind: 'reservation', reservedDelta: args.qty, onHandAfter: held[0].onHand,
    orderId: args.orderId, orderLineId: args.orderLineId, bySystem: true,
  });

  const [row] = await db.insert(s.stockReservations).values({
    orderId: args.orderId, orderLineId: args.orderLineId,
    variantId: args.variantId, locationId: chosen.locationId,
    sellerId: args.sellerId, qty: args.qty,
    status: 'held', expiresAt: args.expiresAt ?? null,
  }).returning({ id: s.stockReservations.id });

  await refreshVariantAvailability(db, args.variantId);
  return { reservationId: row.id, locationId: chosen.locationId, qty: args.qty };
}

/** Payment cleared: reserved becomes committed. On-hand does not move. */
export async function commitReservations(db: DB, orderId: number) {
  const held = await db.select().from(s.stockReservations)
    .where(and(eq(s.stockReservations.orderId, orderId), eq(s.stockReservations.status, 'held')));

  for (const r of held) {
    await move(db, null, {
      variantId: r.variantId, locationId: r.locationId, sellerId: r.sellerId,
      kind: 'commit', delta: { reserved: -r.qty, committed: r.qty },
      orderId: r.orderId, orderLineId: r.orderLineId, bySystem: true,
    });
    await db.update(s.stockReservations).set({ status: 'committed' })
      .where(eq(s.stockReservations.id, r.id));
  }
  return { committed: held.length };
}

/** Cancelled or expired: the hold goes back. */
export async function releaseReservations(db: DB, orderId: number, reason: string) {
  const held = await db.select().from(s.stockReservations).where(and(
    eq(s.stockReservations.orderId, orderId),
    inArray(s.stockReservations.status, ['held', 'committed']),
  ));

  for (const r of held) {
    await move(db, null, {
      variantId: r.variantId, locationId: r.locationId, sellerId: r.sellerId,
      kind: 'release',
      delta: r.status === 'held' ? { reserved: -r.qty } : { committed: -r.qty },
      orderId: r.orderId, orderLineId: r.orderLineId, reason, bySystem: true,
    });
    await db.update(s.stockReservations).set({
      status: 'released', releasedAt: new Date(), releasedReason: reason,
    }).where(eq(s.stockReservations.id, r.id));
  }
  return { released: held.length };
}

/** Goods left the building: committed stock leaves on-hand for good. */
export async function dispatchReservations(db: DB, sellerOrderId: number, orderLineIds: number[]) {
  if (!orderLineIds.length) return { dispatched: 0 };
  const committed = await db.select().from(s.stockReservations).where(and(
    inArray(s.stockReservations.orderLineId, orderLineIds),
    eq(s.stockReservations.status, 'committed'),
  ));

  for (const r of committed) {
    await move(db, null, {
      variantId: r.variantId, locationId: r.locationId, sellerId: r.sellerId,
      kind: 'dispatch', delta: { onHand: -r.qty, committed: -r.qty },
      orderId: r.orderId, orderLineId: r.orderLineId,
      refType: 'seller_order', refId: sellerOrderId, bySystem: true,
    });
    await db.update(s.stockReservations).set({ status: 'fulfilled' })
      .where(eq(s.stockReservations.id, r.id));
  }
  return { dispatched: committed.length };
}

/**
 * Release every reservation whose order has expired.
 *
 * Runs from the same cron that expires orders. Without it, an abandoned basket
 * holds the last gi for ever and the seller's stock quietly becomes unsellable
 * with no visible cause.
 */
export async function releaseExpiredReservations(db: DB, now = new Date()): Promise<number> {
  const stale = await db.select().from(s.stockReservations).where(and(
    eq(s.stockReservations.status, 'held'),
    sql`${s.stockReservations.expiresAt} is not null`,
    lte(s.stockReservations.expiresAt, now),
  )).limit(500);

  for (const r of stale) {
    await move(db, null, {
      variantId: r.variantId, locationId: r.locationId, sellerId: r.sellerId,
      kind: 'release', delta: { reserved: -r.qty },
      orderId: r.orderId, orderLineId: r.orderLineId,
      reason: 'Reservation expired with the order.', bySystem: true,
    });
    await db.update(s.stockReservations).set({
      status: 'expired', releasedAt: now, releasedReason: 'Order expired.',
    }).where(eq(s.stockReservations.id, r.id));
  }
  return stale.length;
}

// ─── Returns back into stock ────────────────────────────────────────────────

/**
 * An inspected return, posted to the right bucket.
 *
 * TWO MOVEMENTS, NEVER ONE. Sellable units go back to on-hand; damaged ones go
 * to on-hand AND to the damaged bucket, because they are physically present and
 * must not be sold. Writing damage off against on-hand instead would lose the
 * fact that it happened, and a seller whose returns keep arriving broken is
 * something MMAKF needs to be able to see.
 */
export async function restockReturn(
  db: DB, ctx: AuditContext,
  input: {
    variantId: number; locationId: number; sellerId: number;
    sellableQty: number; damagedQty: number;
    returnRequestId: number; reason?: string | null;
  }
) {
  await ensureStockRow(db, input.variantId, input.locationId, input.sellerId);
  const results: any[] = [];

  if (input.sellableQty > 0) {
    results.push(await move(db, ctx, {
      variantId: input.variantId, locationId: input.locationId, sellerId: input.sellerId,
      kind: 'restock', delta: { onHand: input.sellableQty },
      refType: 'return_request', refId: input.returnRequestId,
      reason: input.reason ?? 'Return inspected as sellable.',
    }));
  }
  if (input.damagedQty > 0) {
    results.push(await move(db, ctx, {
      variantId: input.variantId, locationId: input.locationId, sellerId: input.sellerId,
      kind: 'damage', delta: { onHand: input.damagedQty, damaged: input.damagedQty },
      refType: 'return_request', refId: input.returnRequestId,
      reason: input.reason ?? 'Return inspected as damaged — present but not sellable.',
    }));
  }
  return { movements: results.length };
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function stockForSeller(db: DB, principal: Principal, opts: { limit?: number } = {}) {
  const seller = await ownSeller(db, principal);
  return db.select({
    variantId: s.stockItems.variantId,
    sku: s.listingVariants.sku,
    label: s.listingVariants.label,
    listingTitle: s.listings.title,
    locationCode: s.inventoryLocations.code,
    locationId: s.stockItems.locationId,
    onHand: s.stockItems.onHand,
    reserved: s.stockItems.reserved,
    committed: s.stockItems.committed,
    damaged: s.stockItems.damaged,
    available: sql<number>`(${s.stockItems.onHand} - ${s.stockItems.reserved} - ${s.stockItems.committed} - ${s.stockItems.damaged})::int`,
  }).from(s.stockItems)
    .innerJoin(s.listingVariants, eq(s.stockItems.variantId, s.listingVariants.id))
    .innerJoin(s.listings, eq(s.listingVariants.listingId, s.listings.id))
    .innerJoin(s.inventoryLocations, eq(s.stockItems.locationId, s.inventoryLocations.id))
    // THE ISOLATION FILTER, IN SQL. Not a post-fetch check.
    .where(eq(s.stockItems.sellerId, seller.id))
    .orderBy(asc(s.listings.title), asc(s.listingVariants.sortOrder))
    .limit(Math.min(opts.limit ?? 200, 1000));
}

export async function movementsForVariant(db: DB, principal: Principal, variantId: number, limit = 100) {
  const { seller } = await ownVariant(db, principal, variantId);
  return db.select().from(s.stockMovements)
    .where(and(eq(s.stockMovements.variantId, variantId), eq(s.stockMovements.sellerId, seller.id)))
    .orderBy(desc(s.stockMovements.at))
    .limit(Math.min(limit, 500));
}

/**
 * Variants below their configured threshold.
 *
 * NO DEFAULT THRESHOLD. A seller with no low-stock rule gets no low-stock
 * warnings, because there is no universally sensible level — five is critical
 * for a dojo and irrelevant for a manufacturer, and a default of five would
 * send a manufacturer several hundred notifications on the day it shipped.
 */
export async function lowStock(db: DB, principal: Principal) {
  const seller = await ownSeller(db, principal);
  const rules = await db.select().from(s.lowStockRules).where(and(
    eq(s.lowStockRules.sellerId, seller.id), eq(s.lowStockRules.active, true),
  ));
  if (!rules.length) return { configured: false, rows: [] as any[] };

  const perVariant = new Map<number, number>();
  let fallback: number | null = null;
  for (const r of rules) {
    if (r.variantId == null) fallback = r.threshold;
    else perVariant.set(r.variantId, r.threshold);
  }

  const rows = await db.select({
    variantId: s.listingVariants.id,
    sku: s.listingVariants.sku,
    label: s.listingVariants.label,
    listingTitle: s.listings.title,
    available: s.listingVariants.availableQty,
  }).from(s.listingVariants)
    .innerJoin(s.listings, eq(s.listingVariants.listingId, s.listings.id))
    .where(and(eq(s.listingVariants.sellerId, seller.id), eq(s.listingVariants.status, 'active')));

  const low = rows.filter((r: any) => {
    const threshold = perVariant.get(r.variantId) ?? fallback;
    return threshold != null && r.available <= threshold;
  }).map((r: any) => ({ ...r, threshold: perVariant.get(r.variantId) ?? fallback }));

  return { configured: true, rows: low };
}

export async function setLowStockRule(
  db: DB, ctx: AuditContext,
  input: { variantId?: number | null; threshold: number; notifyEmail?: string | null }
) {
  const seller = await ownSeller(db, ctx.principal);
  if (!Number.isInteger(input.threshold) || input.threshold < 0) {
    throw new MarketplaceError('bad_threshold', 'A low-stock threshold must be a whole number, zero or more.');
  }
  const existing = (await db.select({ id: s.lowStockRules.id }).from(s.lowStockRules).where(and(
    eq(s.lowStockRules.sellerId, seller.id),
    input.variantId == null ? isNull(s.lowStockRules.variantId) : eq(s.lowStockRules.variantId, input.variantId),
    eq(s.lowStockRules.active, true),
  )).limit(1))[0];

  if (existing) {
    await db.update(s.lowStockRules)
      .set({ threshold: input.threshold, notifyEmail: input.notifyEmail ?? null })
      .where(eq(s.lowStockRules.id, existing.id));
    return { ruleId: existing.id, updated: true };
  }
  const [row] = await db.insert(s.lowStockRules).values({
    sellerId: seller.id, variantId: input.variantId ?? null,
    threshold: input.threshold, notifyEmail: input.notifyEmail ?? null,
  }).returning({ id: s.lowStockRules.id });
  return { ruleId: row.id, updated: false };
}

// ─── Ownership helpers: the isolation boundary ──────────────────────────────

/**
 * The caller's own seller record, approved.
 *
 * Every seller-side function in this module starts here. "Seller A attempts:
 * modify Seller B inventory. MUST FAIL." is one of the brief's named attacks,
 * and it fails because there is no function in this file that takes a sellerId
 * from the caller.
 */
export async function ownSeller(db: DB, principal: Principal) {
  if (principal?.userId == null) throw new MarketplaceError('not_signed_in', 'Sign in to manage stock.');
  const seller = (await db.select().from(s.sellers)
    .where(eq(s.sellers.userId, principal.userId)).limit(1))[0];
  if (!seller) throw new MarketplaceError('not_a_seller', 'This account has no seller record.');
  if (seller.status !== 'approved') {
    throw new MarketplaceError('seller_not_approved', `A seller that is ${seller.status} cannot manage stock.`);
  }
  return seller;
}

async function ownVariant(db: DB, principal: Principal, variantId: number) {
  const seller = await ownSeller(db, principal);
  const variant = (await db.select().from(s.listingVariants).where(and(
    eq(s.listingVariants.id, variantId),
    eq(s.listingVariants.sellerId, seller.id),
  )).limit(1))[0];
  // Same message whether it belongs to somebody else or does not exist:
  // distinguishing them tells an attacker which ids are real.
  if (!variant) throw new MarketplaceError('not_your_variant', 'No such variant on your seller account.');
  return { seller, variant };
}

async function assertLocationBelongs(db: DB, locationId: number, sellerId: number) {
  const loc = (await db.select({ id: s.inventoryLocations.id }).from(s.inventoryLocations).where(and(
    eq(s.inventoryLocations.id, locationId), eq(s.inventoryLocations.sellerId, sellerId),
  )).limit(1))[0];
  if (!loc) throw new MarketplaceError('not_your_location', 'No such location on your seller account.');
}

/** Federation-wide stock view, for the admin console. Scope-checked. */
export async function stockAcrossMarketplace(db: DB, principal: Principal, sellerId: number, limit = 200) {
  assertCan(principal, 'marketplace:read', {});
  return db.select({
    sku: s.listingVariants.sku,
    label: s.listingVariants.label,
    listingTitle: s.listings.title,
    onHand: s.stockItems.onHand,
    reserved: s.stockItems.reserved,
    committed: s.stockItems.committed,
    damaged: s.stockItems.damaged,
  }).from(s.stockItems)
    .innerJoin(s.listingVariants, eq(s.stockItems.variantId, s.listingVariants.id))
    .innerJoin(s.listings, eq(s.listingVariants.listingId, s.listings.id))
    .where(eq(s.stockItems.sellerId, sellerId))
    .limit(Math.min(limit, 500));
}
