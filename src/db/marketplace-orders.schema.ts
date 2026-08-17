// The multi-seller order split, shipping, returns and buyer disputes.
//
// ─── THE ONE STRUCTURAL DECISION EVERYTHING ELSE FOLLOWS FROM ───────────────
//
// A buyer sees ONE checkout. The federation records ONE order and ONE payment.
// But the WORK is per seller, and so is the money owed, the dispatch clock, the
// return address, the refund, the rating and the settlement.
//
// So an order has SELLER ORDERS beneath it, and every operational thing hangs
// off the seller order rather than the order:
//
//     orders                (the buyer's transaction — one payment, one receipt)
//       └── seller_orders   (the unit of work, money and accountability)
//             └── order_lines
//
// The brief's critical test is exactly this shape: ₹1,000 from Seller A and
// ₹2,000 from Seller B is one checkout, one ₹3,000 payment, two seller orders,
// two settlements — and refunding Product A must not corrupt Product B.
//
// THAT LAST CLAUSE IS THE WHOLE REASON FOR THE TABLE. If status lived on the
// order, then "shipped" would be a lie the moment one of two sellers had
// shipped, and a refund would have to reach into a shared total and hope. With
// a seller order, a refund touches Seller A's row, Seller A's lines, Seller A's
// commission and Seller A's settlement, and there is no shared mutable figure
// for it to corrupt. The order's own totals are never rewritten by a refund;
// they are what was charged, and what was charged does not change.
//
// ─── WHAT A SELLER IS ALLOWED TO SEE ────────────────────────────────────────
//
// `seller_orders.sellerId` is the isolation boundary and it is filtered IN SQL
// on every seller-facing read (src/db/seller-orders.ts). `order_lines` carries
// a denormalised `seller_id` for the same reason stock_items does: a check that
// requires a join is a check somebody eventually writes without the join.
//
// MONEY IS INTEGER MINOR UNITS throughout, as everywhere else in this codebase.

import {
  pgTable, serial, text, integer, timestamp, boolean, date,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users, persons } from './schema';
import { sellers, listings } from './onboarding.schema';
import { listingVariants } from './catalogue.schema';
import { inventoryLocations } from './inventory.schema';
import { orders, orderLines, refunds, payments } from './commerce.schema';

// ─── Seller order status ────────────────────────────────────────────────────

/**
 * The fifteen states the brief names, and no others.
 *
 * Two notes on why this is not simply the existing `orderStatus` with extras:
 *
 *   · `orderStatus` describes MONEY — draft, awaiting_payment, paid, refunded.
 *     This describes WORK — accepted, packed, shipped, delivered. One order can
 *     be `paid` while one seller order is `shipped` and another is still
 *     `seller_accepted`, and a single enum cannot hold both facts at once.
 *
 *   · `disputed` and `return_requested` are states of the WORK, not of the
 *     payment. A disputed seller order still has a captured payment behind it;
 *     conflating the two would make the ledger disagree with the gateway.
 */
export const sellerOrderStatus = pgEnum('seller_order_status', [
  'order_created',
  'payment_pending',
  'paid',
  'seller_accepted',
  'processing',
  'packed',
  'shipped',
  'in_transit',
  'delivered',
  'return_requested',
  'returned',
  'refund_pending',
  'refunded',
  'cancelled',
  'disputed',
]);

/**
 * One seller's part of one buyer's order.
 *
 * ON THE MONEY COLUMNS. Every figure here is RESOLVED SERVER-SIDE from the
 * catalogue at the moment of checkout and then FROZEN. Nothing is read back
 * from the browser, and nothing is recomputed later from a listing that may
 * have been repriced — the brief's "Never trust price, quantity, discount,
 * seller ID, commission or tax from browser" is enforced by there being no code
 * path that writes these from request input.
 *
 * `commissionMinor` and `sellerPayableMinor` are NULLABLE, and that nullability
 * is load-bearing. When MMAKF has published no commission rule that matches,
 * the correct value is not zero — zero is a decision that the federation takes
 * nothing, which nobody made. It is UNKNOWN, the seller order is not settleable
 * until a rule exists, and src/db/marketplace-finance.ts says so in as many
 * words rather than paying out a figure it invented.
 */
export const sellerOrders = pgTable('seller_orders', {
  id: serial('id').primaryKey(),
  sellerOrderNo: text('seller_order_no').notNull(),      // MMAKF-SO-2026-000001
  orderId: integer('order_id').notNull().references(() => orders.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),

  status: sellerOrderStatus('status').notNull().default('order_created'),

  subtotalMinor: integer('subtotal_minor').notNull().default(0),
  taxMinor: integer('tax_minor').notNull().default(0),
  shippingMinor: integer('shipping_minor').notNull().default(0),
  discountMinor: integer('discount_minor').notNull().default(0),
  totalMinor: integer('total_minor').notNull().default(0),
  currency: text('currency').notNull().default('INR'),

  /** Null until a commission rule that matches has been published. */
  commissionMinor: integer('commission_minor'),
  commissionTaxMinor: integer('commission_tax_minor'),
  sellerPayableMinor: integer('seller_payable_minor'),
  /** False while any line has no resolved commission. Blocks settlement. */
  commissionResolved: boolean('commission_resolved').notNull().default(false),

  /** Refunded so far against this seller order, in minor units. */
  refundedMinor: integer('refunded_minor').notNull().default(0),

  /**
   * The delivery address AS GIVEN AT CHECKOUT, copied per seller order.
   *
   * Copied rather than referenced because a seller needs to see the address
   * they shipped to, not the address the buyer has today, and because a buyer
   * editing their profile must not silently rewrite a dispatched consignment's
   * paperwork. Sellers see only their own copy; there is no join from here to
   * another seller's row.
   */
  shipTo: jsonb('ship_to'),
  buyerName: text('buyer_name'),
  /** Contact for THIS consignment. Never the buyer's whole person record. */
  buyerPhone: text('buyer_phone'),
  buyerEmail: text('buyer_email'),
  buyerPersonId: integer('buyer_person_id').references(() => persons.id),

  fulfilmentLocationId: integer('fulfilment_location_id').references(() => inventoryLocations.id),
  shippingMethodId: integer('shipping_method_id'),

  // ── The clock ─────────────────────────────────────────────────────────────
  //
  // Both SLA columns are NULLABLE. When MMAKF has set no SLA, the due time is
  // absent rather than computed from a window an engineer chose; an escalation
  // fired against an invented deadline is an accusation the federation cannot
  // stand behind.
  acceptBy: timestamp('accept_by', { withTimezone: true }),
  dispatchBy: timestamp('dispatch_by', { withTimezone: true }),

  paidAt: timestamp('paid_at', { withTimezone: true }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  packedAt: timestamp('packed_at', { withTimezone: true }),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledByUserId: integer('cancelled_by_user_id').references(() => users.id),
  cancelReason: text('cancel_reason'),
  /** Who cancelled: buyer | seller | federation | system. */
  cancelledBy: text('cancelled_by'),

  sellerNotes: text('seller_notes'),
  /** Set when the order is attached to a competition or event collection. */
  eventId: integer('event_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  noUk: uniqueIndex('seller_orders_no_uk').on(t.sellerOrderNo),
  // ONE SELLER ORDER PER (ORDER, SELLER). Without it a retried checkout splits
  // the same basket twice and the seller is paid for one basket, twice.
  orderSellerUk: uniqueIndex('seller_orders_order_seller_uk').on(t.orderId, t.sellerId),
  sellerIdx: index('seller_orders_seller_idx').on(t.sellerId, t.status),
  orderIdx: index('seller_orders_order_idx').on(t.orderId),
  statusIdx: index('seller_orders_status_idx').on(t.status, t.createdAt),
  // The escalation queue's own index: only rows with a clock still running.
  dispatchDueIdx: index('seller_orders_dispatch_due_idx').on(t.dispatchBy)
    .where(sql`dispatched_at is null and dispatch_by is not null`),
}));

/**
 * Every state a seller order has been in, and who moved it.
 *
 * A status column answers "where is it now?" and nothing else. After a dispute
 * the question is always "when did they say it shipped, and when did it
 * actually move?", and only a log can answer that. Append-only.
 */
export const sellerOrderEvents = pgTable('seller_order_events', {
  id: serial('id').primaryKey(),
  sellerOrderId: integer('seller_order_id').notNull().references(() => sellerOrders.id),
  fromStatus: sellerOrderStatus('from_status'),
  toStatus: sellerOrderStatus('to_status').notNull(),
  note: text('note'),
  byUserId: integer('by_user_id').references(() => users.id),
  /** buyer | seller | federation | system — an actor role, not an identity. */
  byActor: text('by_actor').notNull().default('system'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orderIdx: index('seller_order_events_order_idx').on(t.sellerOrderId, t.at),
}));

// ─── Shipping configuration ─────────────────────────────────────────────────

/**
 * Where a seller will ship to.
 *
 * States and postcode prefixes as JSONB arrays rather than a join table: a zone
 * is read whole, on every checkout, and is edited perhaps twice a year. A join
 * table would be the textbook answer and would turn one row read into a second
 * query on the hottest path in the marketplace.
 */
export const shippingZones = pgTable('shipping_zones', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  name: text('name').notNull(),
  /** ISO country codes. ['IN'] for most sellers. */
  countries: jsonb('countries'),
  /** State names, matching the federation's own state list. Null = all. */
  states: jsonb('states'),
  /** Postcode prefixes, e.g. ['82', '83']. Null = all within the states. */
  postcodePrefixes: jsonb('postcode_prefixes'),
  /** Zones are matched most-specific first; lower sorts earlier. */
  priority: integer('priority').notNull().default(100),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sellerIdx: index('shipping_zones_seller_idx').on(t.sellerId, t.active),
}));

export const shippingRateKind = pgEnum('shipping_rate_kind', [
  'flat', 'per_item', 'by_weight', 'free', 'free_above',
]);

/**
 * A way of getting goods from a zone to a buyer, and what it costs.
 *
 * `priceMinor` HAS NO DEFAULT AND IS REQUIRED. A shipping method with an
 * unstated price would quote zero at checkout and the seller would eat the
 * carriage on every order until somebody noticed.
 */
export const shippingMethods = pgTable('shipping_methods', {
  id: serial('id').primaryKey(),
  zoneId: integer('zone_id').notNull().references(() => shippingZones.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  name: text('name').notNull(),
  kind: shippingRateKind('kind').notNull(),
  priceMinor: integer('price_minor').notNull().default(0),
  perKgMinor: integer('per_kg_minor'),
  perItemMinor: integer('per_item_minor'),
  /** For 'free_above': the basket total at which carriage becomes free. */
  freeAboveMinor: integer('free_above_minor'),
  currency: text('currency').notNull().default('INR'),

  /** Working days. Displayed to the buyer as a range, never as a promise date. */
  minDays: integer('min_days'),
  maxDays: integer('max_days'),
  carrier: text('carrier'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  zoneIdx: index('shipping_methods_zone_idx').on(t.zoneId, t.active),
  sellerIdx: index('shipping_methods_seller_idx').on(t.sellerId),
}));

// ─── Shipments ──────────────────────────────────────────────────────────────

export const shipmentStatus = pgEnum('shipment_status', [
  'created', 'label_printed', 'picked_up', 'in_transit',
  'out_for_delivery', 'delivered', 'failed', 'returned_to_origin', 'lost',
]);

/**
 * A physical consignment.
 *
 * SEPARATE FROM THE SELLER ORDER because one seller order can ship in two
 * parcels, and because a tracking number belongs to a parcel rather than to an
 * order. Flattening tracking onto the seller order makes the second parcel
 * unrepresentable, and the second parcel is what a buyer rings about.
 *
 * "DO NOT FAKE TRACKING" — the brief. So `trackingNumber` and `trackingUrl` are
 * nullable and nothing generates them. A shipment with no tracking is displayed
 * as a shipment with no tracking; the alternative is a link that 404s at the
 * carrier, which is worse than nothing because the buyer believes it.
 */
export const shipments = pgTable('shipments', {
  id: serial('id').primaryKey(),
  sellerOrderId: integer('seller_order_id').notNull().references(() => sellerOrders.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  ref: text('ref').notNull(),

  carrier: text('carrier'),
  service: text('service'),
  trackingNumber: text('tracking_number'),
  trackingUrl: text('tracking_url'),

  status: shipmentStatus('status').notNull().default('created'),
  fromLocationId: integer('from_location_id').references(() => inventoryLocations.id),

  weightGrams: integer('weight_grams'),
  packageCount: integer('package_count').notNull().default(1),

  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  expectedBy: date('expected_by'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  deliveredTo: text('delivered_to'),
  failureReason: text('failure_reason'),

  /** Raw carrier scan history, appended as it arrives. Never interpreted away. */
  trackingEvents: jsonb('tracking_events'),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('shipments_ref_uk').on(t.ref),
  orderIdx: index('shipments_seller_order_idx').on(t.sellerOrderId),
  sellerIdx: index('shipments_seller_idx').on(t.sellerId, t.status),
  // Tracking numbers are unique per carrier where present — two consignments
  // sharing one is a data-entry error that otherwise surfaces as a buyer being
  // shown somebody else's parcel.
  trackingUk: uniqueIndex('shipments_tracking_uk').on(t.carrier, t.trackingNumber)
    .where(sql`tracking_number is not null`),
}));

export const shipmentItems = pgTable('shipment_items', {
  id: serial('id').primaryKey(),
  shipmentId: integer('shipment_id').notNull().references(() => shipments.id),
  orderLineId: integer('order_line_id').notNull().references(() => orderLines.id),
  qty: integer('qty').notNull(),
}, (t) => ({
  shipmentIdx: index('shipment_items_shipment_idx').on(t.shipmentId),
  lineUk: uniqueIndex('shipment_items_line_uk').on(t.shipmentId, t.orderLineId),
}));

// ─── Returns ────────────────────────────────────────────────────────────────

/**
 * A seller's return policy — within limits MMAKF sets.
 *
 * The brief: "seller policy cannot violate mandatory platform/legal
 * requirements". So the policy row records the SELLER'S window, and
 * src/db/returns.ts takes the MORE GENEROUS of the seller's window and the
 * marketplace minimum. A seller offering fourteen days when MMAKF mandates
 * seven gives fourteen; a seller offering three gives seven. The comparison
 * lives in one function and the marketplace minimum is configuration, not a
 * constant — MMAKF has not set it, and until it does the seller's own window
 * stands and the surface says so.
 */
export const returnPolicies = pgTable('return_policies', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').references(() => sellers.id),
  /** Null seller = the marketplace-wide floor, set by the federation. */
  categoryId: integer('category_id'),

  windowDays: integer('window_days'),
  /** Whether the buyer may return without giving a reason. */
  noReasonRequired: boolean('no_reason_required'),
  /** buyer | seller | platform — who pays the return carriage. */
  returnShippingPaidBy: text('return_shipping_paid_by'),
  conditionRequirements: text('condition_requirements'),
  exchangeOffered: boolean('exchange_offered'),
  nonReturnable: boolean('non_returnable').notNull().default(false),
  nonReturnableReason: text('non_returnable_reason'),

  setByUserId: integer('set_by_user_id').references(() => users.id),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sellerIdx: index('return_policies_seller_idx').on(t.sellerId, t.active),
}));

export const returnStatus = pgEnum('return_request_status', [
  'requested',
  'seller_reviewing',
  'approved',
  'rejected',
  'authorised',       // an RMA exists; the buyer may send it
  'in_transit',
  'received',
  'inspected',
  'refund_pending',
  'refunded',
  'exchanged',
  'closed',
  'cancelled',
]);

/**
 * A buyer asking to send something back.
 *
 * AGAINST A SELLER ORDER, never against the whole order. Returning Seller A's
 * gi must leave Seller B's mitts untouched, and a return that pointed at the
 * order would have to remember which parts of it it meant.
 *
 * `eligibilityAtRequest` freezes what the policy said when the buyer asked. A
 * seller who shortens their return window on Tuesday must not thereby
 * invalidate Monday's request, and without the frozen copy the recomputation
 * on Wednesday says the request was never eligible.
 */
export const returnRequests = pgTable('return_requests', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                      // MMAKF-RET-2026-000001
  sellerOrderId: integer('seller_order_id').notNull().references(() => sellerOrders.id),
  orderId: integer('order_id').notNull().references(() => orders.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  buyerPersonId: integer('buyer_person_id').references(() => persons.id),
  requestedByUserId: integer('requested_by_user_id').references(() => users.id),

  reason: text('reason').notNull(),
  reasonDetail: text('reason_detail'),
  evidence: jsonb('evidence'),
  /** refund | exchange — what the buyer asked for. */
  remedySought: text('remedy_sought').notNull().default('refund'),

  status: returnStatus('status').notNull().default('requested'),

  /** The policy as it stood when the request was made. Frozen. */
  eligibilityAtRequest: jsonb('eligibility_at_request'),
  returnShippingPaidBy: text('return_shipping_paid_by'),

  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  respondBy: timestamp('respond_by', { withTimezone: true }),
  sellerRespondedAt: timestamp('seller_responded_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  decidedByUserId: integer('decided_by_user_id').references(() => users.id),

  /** The return authorisation number given to the buyer. */
  rmaNumber: text('rma_number'),
  returnToLocationId: integer('return_to_location_id').references(() => inventoryLocations.id),
  carrier: text('carrier'),
  trackingNumber: text('tracking_number'),
  pickupScheduledFor: date('pickup_scheduled_for'),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  inspectedAt: timestamp('inspected_at', { withTimezone: true }),

  refundId: integer('refund_id').references(() => refunds.id),
  refundedMinor: integer('refunded_minor'),
  /** seller | platform — who bears the refund. Drives the settlement line. */
  refundFundedBy: text('refund_funded_by'),

  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('return_requests_ref_uk').on(t.ref),
  sellerOrderIdx: index('return_requests_seller_order_idx').on(t.sellerOrderId),
  sellerIdx: index('return_requests_seller_idx').on(t.sellerId, t.status),
  statusIdx: index('return_requests_status_idx').on(t.status, t.requestedAt),
  dueIdx: index('return_requests_due_idx').on(t.respondBy)
    .where(sql`seller_responded_at is null and respond_by is not null`),
}));

export const returnItemCondition = pgEnum('return_item_condition', [
  'unopened', 'opened_unused', 'used', 'damaged', 'incomplete', 'not_as_described', 'wrong_item',
]);

export const returnInspectionResult = pgEnum('return_inspection_result', [
  'pending', 'sellable', 'damaged', 'counterfeit', 'not_the_item', 'not_received', 'rejected',
]);

/**
 * What is coming back, and what was found when it arrived.
 *
 * `restockedQty` and `damagedQty` must sum to at most `receivedQty`, and what
 * they do NOT account for is the interesting remainder: an item received and
 * neither restocked nor written off is one somebody has to explain. The
 * inspection is what closes the loop between a refund and the inventory, and
 * the brief's "Approved return: restore sellable inventory. Damaged return:
 * move to damaged inventory" is implemented as two stock movements posted from
 * exactly these two columns.
 */
export const returnItems = pgTable('return_items', {
  id: serial('id').primaryKey(),
  returnRequestId: integer('return_request_id').notNull().references(() => returnRequests.id),
  orderLineId: integer('order_line_id').notNull().references(() => orderLines.id),
  variantId: integer('variant_id').references(() => listingVariants.id),

  requestedQty: integer('requested_qty').notNull(),
  receivedQty: integer('received_qty'),
  restockedQty: integer('restocked_qty'),
  damagedQty: integer('damaged_qty'),

  buyerStatedCondition: returnItemCondition('buyer_stated_condition'),
  inspectionResult: returnInspectionResult('inspection_result').notNull().default('pending'),
  inspectionNotes: text('inspection_notes'),
  inspectedByUserId: integer('inspected_by_user_id').references(() => users.id),
  inspectedAt: timestamp('inspected_at', { withTimezone: true }),

  /** The amount attributable to this item, frozen from the order line. */
  refundableMinor: integer('refundable_minor'),
  approvedRefundMinor: integer('approved_refund_minor'),
}, (t) => ({
  requestIdx: index('return_items_request_idx').on(t.returnRequestId),
  lineIdx: index('return_items_line_idx').on(t.orderLineId),
}));

// ─── Buyer/seller disputes ──────────────────────────────────────────────────

/**
 * NOT the same thing as `disputes` in reconciliation.schema.ts.
 *
 * That table records a CHARGEBACK — the card network telling MMAKF that a
 * cardholder has gone to their bank. This one records a buyer telling MMAKF
 * that a seller has let them down. They have different parties, different
 * evidence, different clocks and different outcomes, and the only thing they
 * share is the word. Merging them would have put a marketplace complaint into
 * the treasurer's reconciliation queue.
 */
export const marketplaceDisputeKind = pgEnum('marketplace_dispute_kind', [
  'item_not_received',
  'not_as_described',
  'damaged_on_arrival',
  'counterfeit',
  'wrong_item',
  'missing_parts',
  'refund_not_received',
  'seller_conduct',
  'delivery_dispute',
  'other',
]);

export const marketplaceDisputeStatus = pgEnum('marketplace_dispute_status', [
  'open', 'seller_responding', 'under_review', 'resolved', 'withdrawn', 'escalated', 'closed',
]);

export const marketplaceDisputes = pgTable('marketplace_disputes', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                     // MMAKF-DSP-2026-000001
  orderId: integer('order_id').notNull().references(() => orders.id),
  sellerOrderId: integer('seller_order_id').references(() => sellerOrders.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  listingId: integer('listing_id').references(() => listings.id),
  returnRequestId: integer('return_request_id').references(() => returnRequests.id),

  raisedByPersonId: integer('raised_by_person_id').references(() => persons.id),
  raisedByUserId: integer('raised_by_user_id').references(() => users.id),
  kind: marketplaceDisputeKind('kind').notNull(),
  summary: text('summary').notNull(),
  buyerEvidence: jsonb('buyer_evidence'),

  status: marketplaceDisputeStatus('status').notNull().default('open'),
  respondBy: timestamp('respond_by', { withTimezone: true }),
  sellerResponse: text('seller_response'),
  sellerEvidence: jsonb('seller_evidence'),
  sellerRespondedAt: timestamp('seller_responded_at', { withTimezone: true }),

  assignedToUserId: integer('assigned_to_user_id').references(() => users.id),
  decidedByUserId: integer('decided_by_user_id').references(() => users.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  /** buyer_upheld | seller_upheld | partial | no_fault */
  outcome: text('outcome'),
  decisionReason: text('decision_reason'),

  refundId: integer('refund_id').references(() => refunds.id),
  refundMinor: integer('refund_minor'),
  /**
   * A charge against the seller beyond the refund.
   *
   * NULLABLE AND NEVER COMPUTED. What MMAKF penalises, and by how much, is a
   * federation decision with a contract behind it. A penalty schedule invented
   * here would be deducted from a real person's settlement.
   */
  penaltyMinor: integer('penalty_minor'),
  penaltyReason: text('penalty_reason'),

  raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('marketplace_disputes_ref_uk').on(t.ref),
  sellerIdx: index('marketplace_disputes_seller_idx').on(t.sellerId, t.status),
  orderIdx: index('marketplace_disputes_order_idx').on(t.orderId),
  statusIdx: index('marketplace_disputes_status_idx').on(t.status, t.raisedAt),
}));

/**
 * The conversation on a dispute, with who may see each message.
 *
 * `visibleTo` matters: a reviewer's internal note about a seller's history must
 * not be readable by the buyer or the seller, and a system without the column
 * either publishes the note or forces the reviewer to keep it somewhere the
 * case file cannot reach.
 */
export const marketplaceDisputeMessages = pgTable('marketplace_dispute_messages', {
  id: serial('id').primaryKey(),
  disputeId: integer('dispute_id').notNull().references(() => marketplaceDisputes.id),
  byUserId: integer('by_user_id').references(() => users.id),
  byActor: text('by_actor').notNull(),            // buyer | seller | federation | system
  body: text('body').notNull(),
  attachments: jsonb('attachments'),
  /** all | buyer | seller | federation */
  visibleTo: text('visible_to').notNull().default('all'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  disputeIdx: index('marketplace_dispute_messages_dispute_idx').on(t.disputeId, t.at),
}));

/**
 * A buyer complaint that is not yet a dispute.
 *
 * The brief lists what a buyer may report — wrong product, damaged, missing
 * delivery, counterfeit, refund issue, seller issue — and requires each to link
 * to an order, a seller and a product. Kept separate from `marketplaceDisputes`
 * because most reports are resolved by the seller in a day and should never
 * become a formal case with a clock and an adjudication; forcing them to would
 * make the dispute queue useless within a month.
 */
export const buyerReports = pgTable('buyer_reports', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),
  orderId: integer('order_id').references(() => orders.id),
  sellerOrderId: integer('seller_order_id').references(() => sellerOrders.id),
  sellerId: integer('seller_id').references(() => sellers.id),
  listingId: integer('listing_id').references(() => listings.id),
  orderLineId: integer('order_line_id').references(() => orderLines.id),

  reportedByPersonId: integer('reported_by_person_id').references(() => persons.id),
  reportedByUserId: integer('reported_by_user_id').references(() => users.id),
  kind: text('kind').notNull(),
  detail: text('detail').notNull(),
  evidence: jsonb('evidence'),

  status: text('status').notNull().default('open'),   // open | resolved | escalated | closed
  escalatedToDisputeId: integer('escalated_to_dispute_id').references(() => marketplaceDisputes.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolution: text('resolution'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('buyer_reports_ref_uk').on(t.ref),
  sellerIdx: index('buyer_reports_seller_idx').on(t.sellerId, t.status),
  orderIdx: index('buyer_reports_order_idx').on(t.orderId),
}));

/**
 * Which payment paid for which seller order.
 *
 * A JOIN TABLE AND NOT A COLUMN, because one payment covers several seller
 * orders — that is the whole point of a single checkout — and because a partial
 * refund later attaches to one of them. The allocated amount is stored rather
 * than derived so that the arithmetic that split a ₹3,000 capture into ₹1,000
 * and ₹2,000 is a record, not a recomputation that could come out differently
 * after a rounding change.
 */
export const sellerOrderPayments = pgTable('seller_order_payments', {
  id: serial('id').primaryKey(),
  sellerOrderId: integer('seller_order_id').notNull().references(() => sellerOrders.id),
  paymentId: integer('payment_id').notNull().references(() => payments.id),
  allocatedMinor: integer('allocated_minor').notNull(),
  /** The gateway's own charge, apportioned. Needed to reconcile a settlement. */
  gatewayFeeShareMinor: integer('gateway_fee_share_minor'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pairUk: uniqueIndex('seller_order_payments_uk').on(t.sellerOrderId, t.paymentId),
  paymentIdx: index('seller_order_payments_payment_idx').on(t.paymentId),
}));
