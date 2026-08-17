// Inventory: locations, buckets, and an append-only movement ledger.
//
// ─── THE INSTRUCTION THIS FILE OBEYS ────────────────────────────────────────
//
// "Never simply decrement stock in frontend code." And the deeper one:
// "Never manually reconcile stock after every order."
//
// Both point at the same design. A stock level must not be a number somebody
// adjusts; it must be the CONSEQUENCE of recorded events. When the count is
// wrong — and it will be, because a real warehouse loses things — the question
// is "which movement is missing?", and a schema with only a current count
// cannot be asked it.
//
// ─── THE FOUR BUCKETS, AND WHY AVAILABLE IS NOT ONE OF THEM ─────────────────
//
//   on_hand    physically present at this location.
//   reserved   held for an order that has NOT been paid for. Released on
//              expiry or cancellation.
//   committed  paid for, not yet dispatched. Still physically present, and
//              absolutely not sellable.
//   damaged    present and not sellable. Kept apart because writing damage off
//              against on_hand loses the fact that it happened, and the return
//              rate of a seller who keeps damaging stock is a thing MMAKF
//              needs to see.
//   in_transit sent between this seller's own locations. Belongs to nobody's
//              sellable count until it lands.
//
// AVAILABLE IS DERIVED: on_hand − reserved − committed − damaged. It is not a
// column, because two columns that must agree eventually disagree, and the one
// that gets updated is never the one that gets read.
//
// ─── HOW THE OVERSELL IS ACTUALLY PREVENTED ─────────────────────────────────
//
// Not by checking availability and then writing. That is a read-then-write
// race, and two customers buying the last gi in the same second both read
// "one left". It is prevented by a CHECK CONSTRAINT on stock_items that makes
// the over-reserved state unrepresentable, combined with a conditional UPDATE
// that reserves only where enough is available. The loser's UPDATE matches zero
// rows and their transaction is rolled back with a clear error, rather than
// both succeeding and one buyer being told later.
//
// The constraint is the load-bearing part. The conditional update is what turns
// a constraint violation into a good error message.

import {
  pgTable, serial, text, integer, timestamp, boolean,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users, stateUnits, districtUnits } from './schema';
import { sellers } from './onboarding.schema';
import { listingVariants } from './catalogue.schema';
import { orders, orderLines } from './commerce.schema';

// ─── Locations ──────────────────────────────────────────────────────────────

export const locationKind = pgEnum('inventory_location_kind', [
  'warehouse', 'store', 'fulfilment_centre', 'dropship', 'dojo',
]);

/**
 * Somewhere stock physically is.
 *
 * A seller with one shelf still gets a location row, and that is not
 * ceremony — it is what makes the second shelf, added eighteen months later,
 * a data change rather than a migration of every stock figure in the system.
 *
 * `priority` drives fulfilment source selection. LOWER IS PREFERRED, and where
 * two locations tie the resolver takes the lower id — a stated tiebreak rather
 * than whatever order the planner happened to return, because a non-deterministic
 * fulfilment source produces bugs that cannot be reproduced.
 */
export const inventoryLocations = pgTable('inventory_locations', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  kind: locationKind('kind').notNull().default('warehouse'),

  addressLine: text('address_line'),
  city: text('city'),
  district: text('district'),
  state: text('state'),
  postcode: text('postcode'),
  country: text('country').notNull().default('IN'),
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),

  contactName: text('contact_name'),
  contactPhone: text('contact_phone'),

  priority: integer('priority').notNull().default(100),
  /** Whether this location may be picked as a fulfilment source at all. */
  fulfilsOrders: boolean('fulfils_orders').notNull().default(true),
  acceptsReturns: boolean('accepts_returns').notNull().default(false),
  active: boolean('active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('inventory_locations_code_uk').on(t.sellerId, t.code),
  sellerIdx: index('inventory_locations_seller_idx').on(t.sellerId, t.active),
}));

// ─── Stock ──────────────────────────────────────────────────────────────────

/**
 * The count of one variant at one location.
 *
 * `sellerId` is DENORMALISED onto this row on purpose. It is reachable through
 * the variant, but every isolation check in src/db/inventory.ts filters on it
 * IN SQL, and a check that needs a join is a check somebody eventually writes
 * without the join. Seller A adjusting Seller B's stock is one of the attacks
 * the brief names explicitly, and the column is what makes the filter cheap
 * enough that nobody is tempted to skip it.
 *
 * THE CHECK CONSTRAINTS LIVE IN THE MIGRATION, not here, because Drizzle's
 * table builder has no expression for them in this version. They are:
 *
 *   on_hand >= 0, reserved >= 0, committed >= 0, damaged >= 0, in_transit >= 0
 *   reserved + committed + damaged <= on_hand
 *
 * The second is the one that prevents the oversell. Do not remove it to fix a
 * failing test; the failing test is the bug.
 */
export const stockItems = pgTable('stock_items', {
  id: serial('id').primaryKey(),
  variantId: integer('variant_id').notNull().references(() => listingVariants.id),
  locationId: integer('location_id').notNull().references(() => inventoryLocations.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),

  onHand: integer('on_hand').notNull().default(0),
  reserved: integer('reserved').notNull().default(0),
  committed: integer('committed').notNull().default(0),
  damaged: integer('damaged').notNull().default(0),
  inTransit: integer('in_transit').notNull().default(0),

  /** Last physical count, so drift can be measured rather than guessed at. */
  lastCountedAt: timestamp('last_counted_at', { withTimezone: true }),
  lastCountedQty: integer('last_counted_qty'),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  placeUk: uniqueIndex('stock_items_place_uk').on(t.variantId, t.locationId),
  sellerIdx: index('stock_items_seller_idx').on(t.sellerId),
  variantIdx: index('stock_items_variant_idx').on(t.variantId),
}));

/**
 * Every reason a count ever changed. APPEND-ONLY.
 *
 * The bucket deltas are signed and are recorded per bucket rather than as one
 * "quantity", because the interesting movements are transfers BETWEEN buckets:
 * paying for an order moves one unit from reserved to committed and changes the
 * on-hand total not at all. A single quantity column would record that as zero,
 * which is exactly the movement an investigation is looking for.
 */
export const stockMovementKind = pgEnum('stock_movement_kind', [
  'receipt',          // goods arrived
  'reservation',      // held for an unpaid order
  'release',          // reservation expired or order cancelled
  'commit',           // order paid; stock is spoken for
  'dispatch',         // left the building
  'return_in',        // came back from a buyer
  'restock',          // an inspected return judged sellable
  'damage',           // moved to the damaged bucket
  'write_off',        // removed from the damaged bucket, gone
  'adjustment',       // a human corrected the count, with a reason
  'transfer_out',
  'transfer_in',
  'count',            // a stock take recorded a true figure
]);

export const stockMovements = pgTable('stock_movements', {
  id: serial('id').primaryKey(),
  variantId: integer('variant_id').notNull().references(() => listingVariants.id),
  locationId: integer('location_id').notNull().references(() => inventoryLocations.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  kind: stockMovementKind('kind').notNull(),

  onHandDelta: integer('on_hand_delta').notNull().default(0),
  reservedDelta: integer('reserved_delta').notNull().default(0),
  committedDelta: integer('committed_delta').notNull().default(0),
  damagedDelta: integer('damaged_delta').notNull().default(0),
  inTransitDelta: integer('in_transit_delta').notNull().default(0),

  /** The resulting on-hand, frozen, so the ledger can be replayed and checked. */
  onHandAfter: integer('on_hand_after').notNull(),

  orderId: integer('order_id').references(() => orders.id),
  orderLineId: integer('order_line_id').references(() => orderLines.id),
  refType: text('ref_type'),
  refId: integer('ref_id'),

  /**
   * Why. NOT NULL for 'adjustment', 'damage' and 'write_off' — those are the
   * three a human performs by hand, and an unexplained manual stock change is
   * indistinguishable from theft.
   */
  reason: text('reason'),
  byUserId: integer('by_user_id').references(() => users.id),
  bySystem: boolean('by_system').notNull().default(false),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  variantIdx: index('stock_movements_variant_idx').on(t.variantId, t.at),
  sellerIdx: index('stock_movements_seller_idx').on(t.sellerId, t.at),
  orderIdx: index('stock_movements_order_idx').on(t.orderId),
}));

export const reservationStatus = pgEnum('stock_reservation_status', [
  'held', 'committed', 'released', 'expired', 'fulfilled',
]);

/**
 * A named hold on stock for one order line.
 *
 * WHY THIS EXISTS WHEN stock_items.reserved ALREADY COUNTS THEM: because a
 * count cannot be released. When an order expires, something has to know WHICH
 * two units to give back and at which location, and a bare counter does not.
 * Without this table the expiry job either releases nothing or releases a guess.
 *
 * `expiresAt` is copied from the order rather than computed here, so the
 * reservation and the order it belongs to cannot disagree about when it lapses.
 */
export const stockReservations = pgTable('stock_reservations', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull().references(() => orders.id),
  orderLineId: integer('order_line_id').notNull().references(() => orderLines.id),
  variantId: integer('variant_id').notNull().references(() => listingVariants.id),
  locationId: integer('location_id').notNull().references(() => inventoryLocations.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  qty: integer('qty').notNull(),
  status: reservationStatus('status').notNull().default('held'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releasedReason: text('released_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // ONE LIVE RESERVATION PER ORDER LINE PER LOCATION. The replay guard: a
  // retried checkout must not hold the same stock twice, and a constraint is
  // the only thing that settles it when two requests arrive together.
  liveUk: uniqueIndex('stock_reservations_live_uk').on(t.orderLineId, t.locationId)
    .where(sql`status in ('held', 'committed')`),
  orderIdx: index('stock_reservations_order_idx').on(t.orderId),
  expiryIdx: index('stock_reservations_expiry_idx').on(t.expiresAt)
    .where(sql`status = 'held'`),
  sellerIdx: index('stock_reservations_seller_idx').on(t.sellerId),
}));

/**
 * When to tell somebody stock is running out.
 *
 * `threshold` IS REQUIRED AND HAS NO DEFAULT. There is no sensible universal
 * low-stock level — five is critical for a dojo and irrelevant for a
 * manufacturer — and a default of five would send a manufacturer several
 * hundred notifications on the day it shipped, after which they would turn
 * notifications off and miss the ones that mattered.
 *
 * A row with `variantId` null applies to every variant of the seller's that has
 * no rule of its own.
 */
export const lowStockRules = pgTable('low_stock_rules', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  variantId: integer('variant_id').references(() => listingVariants.id),
  locationId: integer('location_id').references(() => inventoryLocations.id),
  threshold: integer('threshold').notNull(),
  notifyEmail: text('notify_email'),
  active: boolean('active').notNull().default(true),
  lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sellerIdx: index('low_stock_rules_seller_idx').on(t.sellerId, t.active),
  variantIdx: index('low_stock_rules_variant_idx').on(t.variantId),
}));

/**
 * A stock take: what was counted, against what the system believed.
 *
 * The variance is the interesting column, and it is stored rather than derived
 * because the system figure it was measured against changes the moment the
 * adjustment posts. A variance recomputed later is always zero, which is how a
 * warehouse with a persistent shrinkage problem shows a clean record.
 */
export const stockCounts = pgTable('stock_counts', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  locationId: integer('location_id').notNull().references(() => inventoryLocations.id),
  variantId: integer('variant_id').notNull().references(() => listingVariants.id),
  systemQty: integer('system_qty').notNull(),
  countedQty: integer('counted_qty').notNull(),
  varianceQty: integer('variance_qty').notNull(),
  note: text('note'),
  countedByUserId: integer('counted_by_user_id').references(() => users.id),
  countedAt: timestamp('counted_at', { withTimezone: true }).notNull().defaultNow(),
  adjustmentMovementId: integer('adjustment_movement_id').references(() => stockMovements.id),
}, (t) => ({
  sellerIdx: index('stock_counts_seller_idx').on(t.sellerId, t.countedAt),
  varianceIdx: index('stock_counts_variance_idx').on(t.varianceQty),
}));
