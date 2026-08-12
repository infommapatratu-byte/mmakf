// Commerce and finance schema (§15-18, §49-52).
//
// Replaces the UPI-deep-link-plus-WhatsApp arrangement, under which the
// federation held no record that a payment had ever occurred. A national body
// must be able to answer, for any rupee: who paid, for what, when, under which
// reference, and what was issued in return. A chat thread cannot answer that.
//
// Design rules enforced here:
//  · MONEY IS INTEGER PAISE. Never a float — 0.1 + 0.2 is not 0.3, and a
//    federation's accounts cannot drift by rounding.
//  · ONE ORDER SPINE for every money flow. Membership fees, affiliation
//    renewals, event entries, grading fees, course fees and shop purchases are
//    all order lines of different kinds, not six separate ad-hoc mechanisms.
//  · PAYMENT RECORDS ARE APPEND-ONLY. Attempts are never overwritten by later
//    attempts; a failed attempt is evidence, not noise.
//  · WEBHOOKS ARE LOGGED RAW before interpretation, so a disputed settlement can
//    be reconstructed from what the provider actually sent.
//  · FEE AMOUNTS ARE CONFIGURED, NEVER HARD-CODED. What MMAKF charges is the
//    federation's decision; that a fee exists and is collectable is engineering.

import {
  pgTable, serial, text, integer, timestamp, date, boolean,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { persons, dojos, stateUnits } from './schema';

// ─── Enums ──────────────────────────────────────────────────────────────────

export const productStatus = pgEnum('product_status', ['draft', 'active', 'out_of_stock', 'discontinued']);

/**
 * Order lifecycle.
 *
 *   draft ─▶ awaiting_payment ─▶ paid ─▶ fulfilled
 *              │                  │
 *              ├─▶ failed         └─▶ refunded / partially_refunded
 *              ├─▶ expired
 *              └─▶ cancelled
 *
 * `paid` means money is captured and reconciled — never merely that a customer
 * returned from a payment page, which proves nothing.
 */
export const orderStatus = pgEnum('order_status', [
  'draft', 'awaiting_payment', 'paid', 'fulfilled',
  'cancelled', 'expired', 'failed', 'refunded', 'partially_refunded',
]);

/** What an order line is FOR. Every federation money flow appears here. */
export const orderLineKind = pgEnum('order_line_kind', [
  'product',            // shop goods
  'membership',         // individual membership fee / renewal
  'affiliation',        // dojo or unit affiliation / renewal
  'event_entry',        // competition or seminar entry
  'grading',            // examination fee
  'course',             // academy course
  'certificate',        // certificate issue or replacement
  'donation',
  'other',
]);

export const paymentStatus = pgEnum('payment_status', [
  'created',            // provider order opened, customer has not paid
  'authorized',         // funds held, not yet captured
  'captured',           // money actually taken — the only status that means paid
  'failed',
  'cancelled',
  'refunded',
  'partially_refunded',
]);

export const refundStatus = pgEnum('refund_status', ['requested', 'processing', 'completed', 'failed']);

export const fulfilmentStatus = pgEnum('fulfilment_status', [
  'not_required', 'pending', 'packed', 'dispatched', 'delivered', 'returned',
]);

// ─── Catalogue ──────────────────────────────────────────────────────────────

export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  sku: text('sku').notNull(),
  name: text('name').notNull(),
  summary: text('summary'),
  description: text('description'),
  category: text('category'),
  // HSN/SAC classification for GST. Nullable because it is a tax decision the
  // federation's accountant makes, not something to be guessed here.
  hsnCode: text('hsn_code'),
  taxRateBps: integer('tax_rate_bps'),        // basis points, e.g. 1200 = 12%
  imageUrl: text('image_url'),
  status: productStatus('status').notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  skuIdx: uniqueIndex('products_sku_uk').on(t.sku),
  statusIdx: index('products_status_idx').on(t.status),
}));

/**
 * A variant is what is actually bought — a gi in size 150cm, a belt in 280cm.
 * Price and stock live here, never on the product, because they differ per
 * variant and a single price on the parent is how oversells happen.
 */
export const productVariants = pgTable('product_variants', {
  id: serial('id').primaryKey(),
  productId: integer('product_id').notNull().references(() => products.id),
  sku: text('sku').notNull(),
  label: text('label').notNull(),             // "Size 150cm", "280cm"
  pricePaise: integer('price_paise').notNull(),
  comparePricePaise: integer('compare_price_paise'),   // struck-through MRP
  stockQty: integer('stock_qty').notNull().default(0),
  // Stock reserved by orders awaiting payment. Available = stock - reserved.
  // Without this, two people pay for the last gi within the same minute.
  reservedQty: integer('reserved_qty').notNull().default(0),
  status: productStatus('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  skuIdx: uniqueIndex('product_variants_sku_uk').on(t.sku),
  productIdx: index('product_variants_product_idx').on(t.productId),
}));

// ─── Fee schedule (§18 — configurable, never invented) ──────────────────────

/**
 * What the federation charges, and for what.
 *
 * Amounts are set by MMAKF through the admin console. Nothing in the codebase
 * ships a rupee figure: an unconfigured fee makes its surface report that the
 * fee is not published, rather than displaying a number nobody approved.
 */
export const feeSchedule = pgTable('fee_schedule', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),               // membership.athlete.annual
  label: text('label').notNull(),
  kind: orderLineKind('kind').notNull(),
  amountPaise: integer('amount_paise').notNull(),
  // Scope lets a state set its own fee where the constitution permits it.
  scopeType: text('scope_type').notNull().default('national'),
  scopeId: integer('scope_id'),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  approvedBy: text('approved_by'),            // the authority that set it
  notes: text('notes'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: index('fee_schedule_code_idx').on(t.code),
  activeIdx: index('fee_schedule_active_idx').on(t.active, t.effectiveFrom),
}));

// ─── Orders ─────────────────────────────────────────────────────────────────

export const orders = pgTable('orders', {
  id: serial('id').primaryKey(),
  orderNo: text('order_no').notNull(),        // MMAKF-ORD-2026-000001
  personId: integer('person_id').references(() => persons.id),

  // Contact captured at purchase. Kept on the order even when a person record
  // exists, because a receipt must reflect what was true when it was issued.
  email: text('email'),
  phone: text('phone'),
  buyerName: text('buyer_name'),

  status: orderStatus('status').notNull().default('draft'),

  // Every amount in integer paise.
  subtotalPaise: integer('subtotal_paise').notNull().default(0),
  taxPaise: integer('tax_paise').notNull().default(0),
  shippingPaise: integer('shipping_paise').notNull().default(0),
  discountPaise: integer('discount_paise').notNull().default(0),
  totalPaise: integer('total_paise').notNull().default(0),
  currency: text('currency').notNull().default('INR'),

  shipTo: jsonb('ship_to'),                   // null for fee-only orders
  fulfilment: fulfilmentStatus('fulfilment').notNull().default('not_required'),

  // Set only when a payment is CAPTURED, never on returning from a payment page.
  paidAt: timestamp('paid_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelReason: text('cancel_reason'),
  // An unpaid order releases its stock reservation after this instant.
  expiresAt: timestamp('expires_at', { withTimezone: true }),

  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orderNoIdx: uniqueIndex('orders_order_no_uk').on(t.orderNo),
  personIdx: index('orders_person_idx').on(t.personId),
  statusIdx: index('orders_status_idx').on(t.status),
  emailIdx: index('orders_email_idx').on(t.email),
}));

export const orderLines = pgTable('order_lines', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull().references(() => orders.id),
  kind: orderLineKind('kind').notNull(),

  // What this line pays for: a variant, a fee, an event, a grading. Kept as a
  // loose reference because the referent differs by kind.
  variantId: integer('variant_id').references(() => productVariants.id),
  feeCode: text('fee_code'),
  refType: text('ref_type'),
  refId: integer('ref_id'),

  // The description and price are COPIED here at purchase. A receipt must not
  // change because the catalogue was edited afterwards.
  description: text('description').notNull(),
  quantity: integer('quantity').notNull().default(1),
  unitPricePaise: integer('unit_price_paise').notNull(),
  taxRateBps: integer('tax_rate_bps').notNull().default(0),
  taxPaise: integer('tax_paise').notNull().default(0),
  totalPaise: integer('total_paise').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ orderIdx: index('order_lines_order_idx').on(t.orderId) }));

// ─── Payments ───────────────────────────────────────────────────────────────

/**
 * A payment ATTEMPT. Multiple rows per order are normal and expected: a customer
 * whose card fails and who then pays by UPI leaves two rows, and both are kept.
 * Overwriting the first would destroy the evidence of what happened.
 */
export const payments = pgTable('payments', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull().references(() => orders.id),

  provider: text('provider').notNull(),               // razorpay | cashfree | manual_upi
  providerOrderId: text('provider_order_id'),
  providerPaymentId: text('provider_payment_id'),

  amountPaise: integer('amount_paise').notNull(),
  currency: text('currency').notNull().default('INR'),
  status: paymentStatus('status').notNull().default('created'),
  method: text('method'),                              // upi | card | netbanking | wallet
  // The provider's own fee and tax, needed to reconcile a settlement against
  // what was charged — gross received is never what lands in the bank.
  providerFeePaise: integer('provider_fee_paise'),
  providerTaxPaise: integer('provider_tax_paise'),

  capturedAt: timestamp('captured_at', { withTimezone: true }),
  failureReason: text('failure_reason'),

  // Makes retrying a request safe: the same key can never charge twice.
  idempotencyKey: text('idempotency_key'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orderIdx: index('payments_order_idx').on(t.orderId),
  providerPaymentIdx: uniqueIndex('payments_provider_payment_uk').on(t.provider, t.providerPaymentId),
  idempotencyIdx: uniqueIndex('payments_idempotency_uk').on(t.idempotencyKey),
  statusIdx: index('payments_status_idx').on(t.status),
}));

/**
 * Raw provider callbacks, stored before interpretation.
 *
 * The unique index on (provider, eventId) is the replay guard: a provider that
 * retries a webhook — which they all do — must not fulfil an order twice.
 */
export const paymentEvents = pgTable('payment_events', {
  id: serial('id').primaryKey(),
  provider: text('provider').notNull(),
  eventId: text('event_id').notNull(),
  eventType: text('event_type').notNull(),
  signatureValid: boolean('signature_valid').notNull(),
  payload: jsonb('payload').notNull(),
  paymentId: integer('payment_id').references(() => payments.id),
  orderId: integer('order_id').references(() => orders.id),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  processingError: text('processing_error'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  eventIdx: uniqueIndex('payment_events_provider_event_uk').on(t.provider, t.eventId),
  typeIdx: index('payment_events_type_idx').on(t.eventType),
}));

export const refunds = pgTable('refunds', {
  id: serial('id').primaryKey(),
  paymentId: integer('payment_id').notNull().references(() => payments.id),
  orderId: integer('order_id').notNull().references(() => orders.id),
  amountPaise: integer('amount_paise').notNull(),
  reason: text('reason').notNull(),                    // never optional (§78)
  status: refundStatus('status').notNull().default('requested'),
  providerRefundId: text('provider_refund_id'),
  requestedByUserId: integer('requested_by_user_id'),
  approvedByUserId: integer('approved_by_user_id'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  paymentIdx: index('refunds_payment_idx').on(t.paymentId),
  orderIdx: index('refunds_order_idx').on(t.orderId),
}));

/**
 * The receipt/invoice actually issued. Numbered in its own unbroken sequence,
 * separate from order numbers, because a tax document series must not have gaps
 * — and orders can be abandoned before ever being paid.
 */
export const invoices = pgTable('invoices', {
  id: serial('id').primaryKey(),
  orderId: integer('order_id').notNull().references(() => orders.id),
  invoiceNo: text('invoice_no').notNull(),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  // A frozen copy of everything printed. Regenerating from live data would let a
  // later catalogue or address edit silently alter an issued document.
  snapshot: jsonb('snapshot').notNull(),
  gstin: text('gstin'),
  placeOfSupply: text('place_of_supply'),
  verifyToken: text('verify_token').notNull(),         // powers the public check
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  invoiceNoIdx: uniqueIndex('invoices_invoice_no_uk').on(t.invoiceNo),
  orderIdx: index('invoices_order_idx').on(t.orderId),
  tokenIdx: uniqueIndex('invoices_verify_token_uk').on(t.verifyToken),
}));

/**
 * Provider settlement batches — what actually reached the bank.
 *
 * Reconciliation is comparing this against captured payments. Without it the
 * treasurer knows what was charged but not what was received, which is the gap
 * where losses hide.
 */
export const settlements = pgTable('settlements', {
  id: serial('id').primaryKey(),
  provider: text('provider').notNull(),
  providerSettlementId: text('provider_settlement_id').notNull(),
  amountPaise: integer('amount_paise').notNull(),
  feePaise: integer('fee_paise').notNull().default(0),
  taxPaise: integer('tax_paise').notNull().default(0),
  utr: text('utr'),                                    // bank reference
  settledAt: timestamp('settled_at', { withTimezone: true }),
  reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  idIdx: uniqueIndex('settlements_provider_id_uk').on(t.provider, t.providerSettlementId),
}));

/**
 * Double-entry ledger. Every captured payment, refund, fee and settlement posts
 * here, so the treasurer's report is derived from one authoritative record
 * rather than assembled by querying several tables and hoping they agree.
 */
export const ledgerEntries = pgTable('ledger_entries', {
  id: serial('id').primaryKey(),
  account: text('account').notNull(),          // membership_income | shop_income | gateway_fees | bank
  direction: text('direction').notNull(),      // debit | credit
  amountPaise: integer('amount_paise').notNull(),
  currency: text('currency').notNull().default('INR'),
  orderId: integer('order_id').references(() => orders.id),
  paymentId: integer('payment_id').references(() => payments.id),
  refundId: integer('refund_id').references(() => refunds.id),
  settlementId: integer('settlement_id').references(() => settlements.id),
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  dojoId: integer('dojo_id').references(() => dojos.id),
  description: text('description').notNull(),
  occurredOn: date('occurred_on').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  accountIdx: index('ledger_account_idx').on(t.account, t.occurredOn),
  orderIdx: index('ledger_order_idx').on(t.orderId),
}));
