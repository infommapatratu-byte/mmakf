// Commission, settlement and seller payouts.
//
// ─── THE INSTRUCTION THAT SHAPES EVERY TABLE HERE ───────────────────────────
//
//     "Never hardcode: 10% 15% 20%. Commission is configuration."
//
// This file takes that further than it is usually taken. It is not enough that
// the rate is stored in a table instead of a constant — the rate has to be
// VERSIONED, EFFECTIVE-DATED, and FROZEN ONTO THE ORDER LINE at the moment of
// sale. Three separate failures are being prevented:
//
//   1. A rate typed into code. Obvious, and the one everybody fixes.
//   2. A rate in a table that somebody edits. MMAKF changes commission from 8%
//      to 10% in June, and every settlement statement for January through May
//      silently reprints at 10%. The seller's own records no longer match
//      MMAKF's, and neither party can prove which is right.
//   3. A rate that is merely *looked up* at settlement time. Same failure,
//      arriving later and harder to see.
//
// So: `commission_rules` names WHO and WHAT a rate applies to;
// `commission_rule_versions` holds the RATE with its effective dates and never
// changes once published; and `order_line_commissions` copies the resolved
// figures onto the line at checkout and is never recomputed.
//
// ─── AND THE REFUSAL THAT MATTERS MORE THAN ANY OF IT ───────────────────────
//
// WHEN NO RULE MATCHES, THE COMMISSION IS NULL. Not zero.
//
// Zero is a decision — it says MMAKF takes nothing from this sale — and nobody
// made it. A marketplace that defaults to zero pays out the full basket to a
// seller and discovers the shortfall at the end of the quarter. A marketplace
// that defaults to 10% takes ten percent of a real person's money on the say-so
// of an engineer. Both are worse than stopping.
//
// So an unresolved commission blocks SETTLEMENT and blocks nothing else: the
// buyer still buys, the seller still ships, and the money sits until the
// federation publishes a rule. src/db/marketplace-finance.ts reports exactly
// which seller orders are held and why.
//
// MONEY IS INTEGER MINOR UNITS. Rates are BASIS POINTS — 1250 is 12.5% — for
// the same reason: a percentage stored as a float rounds differently on
// different machines, and a settlement that disagrees with itself by one paisa
// is a settlement somebody has to reconcile by hand.

import {
  pgTable, serial, text, integer, bigint, timestamp, date, boolean,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './schema';
import { sellers, listings } from './onboarding.schema';
import { marketplaceCategories } from './catalogue.schema';
import { payoutAccounts } from './seller.schema';
import { orders, orderLines, refunds } from './commerce.schema';
import { sellerOrders, marketplaceDisputes, returnRequests } from './marketplace-orders.schema';

// ─── Commission rules ───────────────────────────────────────────────────────

/**
 * The axes a commission may vary along — exactly the ones the brief names.
 *
 * A rule may pin any combination: "12% on protective equipment, except for
 * seller 41, except during the National Championship campaign" is three rules
 * at three specificities, not one rule with three columns of special cases.
 * `priority` breaks ties, and where priority ties too, the MORE SPECIFIC rule
 * wins — measured by how many axes it pins. That ordering is stated in SQL in
 * src/db/marketplace-finance.ts rather than left to the planner, because a
 * commission that depends on row order is a commission that changes after a
 * VACUUM.
 */
export const commissionRules = pgTable('commission_rules', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),
  label: text('label').notNull(),
  description: text('description'),

  // ── The axes. All nullable; null means "does not constrain". ──────────────
  sellerId: integer('seller_id').references(() => sellers.id),
  sellerTier: text('seller_tier'),
  sellerType: text('seller_type'),
  categoryId: integer('category_id').references(() => marketplaceCategories.id),
  /** Matches this category AND everything beneath it, by path prefix. */
  categorySubtree: boolean('category_subtree').notNull().default(true),
  listingId: integer('listing_id').references(() => listings.id),
  campaignCode: text('campaign_code'),
  contractRef: text('contract_ref'),

  priority: integer('priority').notNull().default(100),
  active: boolean('active').notNull().default(true),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('commission_rules_code_uk').on(t.code),
  sellerIdx: index('commission_rules_seller_idx').on(t.sellerId).where(sql`active`),
  categoryIdx: index('commission_rules_category_idx').on(t.categoryId).where(sql`active`),
  activeIdx: index('commission_rules_active_idx').on(t.active, t.priority),
}));

/**
 * THE RATE. Published once, never edited.
 *
 * `rateBps` and `flatMinor` may both be set: some contracts are a percentage
 * plus a per-order handling charge, and a model that forced one or the other
 * would be worked around by inflating the percentage — which then applies to
 * a ₹9,000 order as though it were a handling charge.
 *
 * `minMinor` / `maxMinor` cap the result. A percentage with no floor takes
 * eleven paise on a keyring; with no ceiling it takes ₹4,000 on a competition
 * mat. Both are real and both need to be expressible without a second rule.
 *
 * `publishedAt` NULL means DRAFT. A draft version is never resolved against —
 * the resolver filters on it in SQL — so a rate can be prepared, reviewed and
 * approved without any chance of it reaching a live checkout half-finished.
 */
export const commissionRuleVersions = pgTable('commission_rule_versions', {
  id: serial('id').primaryKey(),
  ruleId: integer('rule_id').notNull().references(() => commissionRules.id),
  version: integer('version').notNull(),

  /** Basis points. 1250 = 12.5%. Never a float, never a fraction. */
  rateBps: integer('rate_bps'),
  flatMinor: integer('flat_minor'),
  minMinor: integer('min_minor'),
  maxMinor: integer('max_minor'),
  currency: text('currency').notNull().default('INR'),

  /**
   * Whether commission is charged on the goods only, or on shipping too.
   *
   * An explicit column because it is the single most common source of dispute
   * between a marketplace and its sellers, and because the two answers differ
   * by real money on every order. There is no default that is right for
   * everyone, so there is no default: NULL means MMAKF has not said, and the
   * resolver treats an unanswered basis as an unresolved commission.
   */
  chargedOnShipping: boolean('charged_on_shipping'),
  chargedOnTax: boolean('charged_on_tax'),

  /** Tax the federation must charge ON its commission, if any. */
  commissionTaxRateBps: integer('commission_tax_rate_bps'),

  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),

  approvedByUserId: integer('approved_by_user_id').references(() => users.id),
  /** The resolution, meeting or contract behind the rate. */
  authority: text('authority'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  versionUk: uniqueIndex('commission_rule_versions_version_uk').on(t.ruleId, t.version),
  // The resolver's index: published versions, by rule, in date order.
  liveIdx: index('commission_rule_versions_live_idx').on(t.ruleId, t.effectiveFrom)
    .where(sql`published_at is not null`),
}));

/**
 * WHAT WAS ACTUALLY CHARGED, on one order line, frozen at checkout.
 *
 * Every input is copied, not referenced: the rate, the basis, the rule version.
 * `ruleVersionId` is PROVENANCE — "this figure came from that version" — and is
 * never read back to recompute the amount, exactly as `invoices.fxRateId` is
 * never read back to recompute a total. Same rule, same reason.
 *
 * ONE ROW PER ORDER LINE, by unique index. A retried checkout must not charge
 * commission twice, and only a constraint settles it when two requests race.
 */
export const orderLineCommissions = pgTable('order_line_commissions', {
  id: serial('id').primaryKey(),
  orderLineId: integer('order_line_id').notNull().references(() => orderLines.id),
  sellerOrderId: integer('seller_order_id').notNull().references(() => sellerOrders.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),

  ruleId: integer('rule_id').references(() => commissionRules.id),
  ruleVersionId: integer('rule_version_id').references(() => commissionRuleVersions.id),

  /** The figures as applied. Frozen copies, not lookups. */
  rateBps: integer('rate_bps'),
  flatMinor: integer('flat_minor'),
  /** What the rate was applied to — goods, or goods plus carriage. */
  basisMinor: integer('basis_minor').notNull(),
  basisDescription: text('basis_description'),

  commissionMinor: integer('commission_minor').notNull(),
  commissionTaxMinor: integer('commission_tax_minor').notNull().default(0),
  sellerPayableMinor: integer('seller_payable_minor').notNull(),
  currency: text('currency').notNull().default('INR'),

  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  lineUk: uniqueIndex('order_line_commissions_line_uk').on(t.orderLineId),
  sellerOrderIdx: index('order_line_commissions_seller_order_idx').on(t.sellerOrderId),
  sellerIdx: index('order_line_commissions_seller_idx').on(t.sellerId),
}));

/**
 * A seller order whose commission could NOT be resolved, and why.
 *
 * The honest alternative to inventing a rate. One row per unresolved seller
 * order, carrying the reason a rule was not found, so that
 * /admin/marketplace/commissions can show the federation a list titled
 * "sales you have not told us how to charge for" rather than silently settling
 * at a number.
 *
 * Cleared when a rule is published and the resolver runs again.
 */
export const commissionGaps = pgTable('commission_gaps', {
  id: serial('id').primaryKey(),
  sellerOrderId: integer('seller_order_id').notNull().references(() => sellerOrders.id),
  orderLineId: integer('order_line_id').references(() => orderLines.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  categoryId: integer('category_id').references(() => marketplaceCategories.id),
  /** no_rule | no_published_version | basis_unstated | ambiguous */
  reason: text('reason').notNull(),
  detail: text('detail'),
  amountAtRiskMinor: integer('amount_at_risk_minor'),
  raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedByRuleVersionId: integer('resolved_by_rule_version_id').references(() => commissionRuleVersions.id),
}, (t) => ({
  openUk: uniqueIndex('commission_gaps_open_uk').on(t.sellerOrderId, t.orderLineId)
    .where(sql`resolved_at is null`),
  sellerIdx: index('commission_gaps_seller_idx').on(t.sellerId).where(sql`resolved_at is null`),
}));

// ─── Settlement ─────────────────────────────────────────────────────────────

export const settlementStatus = pgEnum('seller_settlement_status', [
  'open',        // accruing; lines may still be added
  'closed',      // the period is sealed; the net is final
  'approved',    // a human with authority has released it for payment
  'paying',
  'paid',
  'on_hold',
  'cancelled',
]);

/**
 * A seller's account for a period.
 *
 * THE ARITHMETIC THE BRIEF ASKS FOR, as columns rather than as a query:
 *
 *     GROSS SALES − COMMISSION − TAX − REFUNDS − ADJUSTMENTS = PAYABLE
 *
 * Stored rather than derived, because a statement is a document. Recomputing it
 * from live tables means last quarter's statement changes when a refund is
 * processed today, and a seller who printed it in April cannot reconcile it in
 * July. The lines are kept too, so the total can always be shown its working.
 *
 * `open` → `closed` is the moment the figures stop moving. Anything arriving
 * after that — a late refund, a dispute award — lands in the NEXT period as an
 * adjustment line that names the settlement it relates to. That is how real
 * ledgers handle it, and it is the only way a closed statement stays closed.
 */
export const sellerSettlements = pgTable('seller_settlements', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                     // MMAKF-STL-2026-000001
  sellerId: integer('seller_id').notNull().references(() => sellers.id),

  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  /** daily | weekly | monthly — what the federation chose for this seller. */
  cadence: text('cadence'),

  status: settlementStatus('status').notNull().default('open'),

  grossMinor: integer('gross_minor').notNull().default(0),
  commissionMinor: integer('commission_minor').notNull().default(0),
  commissionTaxMinor: integer('commission_tax_minor').notNull().default(0),
  refundMinor: integer('refund_minor').notNull().default(0),
  adjustmentMinor: integer('adjustment_minor').notNull().default(0),
  shippingMinor: integer('shipping_minor').notNull().default(0),
  taxCollectedMinor: integer('tax_collected_minor').notNull().default(0),
  gatewayFeeMinor: integer('gateway_fee_minor').notNull().default(0),
  netPayableMinor: integer('net_payable_minor').notNull().default(0),
  currency: text('currency').notNull().default('INR'),

  orderCount: integer('order_count').notNull().default(0),

  /**
   * Set when any seller order in the period has an unresolved commission.
   * A settlement in this state CANNOT be approved — the constraint is in
   * src/db/marketplace-finance.ts and it is the point of the column.
   */
  hasUnresolvedCommission: boolean('has_unresolved_commission').notNull().default(false),

  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedByUserId: integer('closed_by_user_id').references(() => users.id),
  approvedByUserId: integer('approved_by_user_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  holdReason: text('hold_reason'),
  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('seller_settlements_ref_uk').on(t.ref),
  // ONE OPEN SETTLEMENT PER SELLER. Two would split a period's sales between
  // them at random, and the seller would be paid twice for neither.
  openUk: uniqueIndex('seller_settlements_open_uk').on(t.sellerId)
    .where(sql`status = 'open'`),
  sellerIdx: index('seller_settlements_seller_idx').on(t.sellerId, t.periodStart),
  statusIdx: index('seller_settlements_status_idx').on(t.status),
}));

export const settlementLineKind = pgEnum('settlement_line_kind', [
  'sale',
  'shipping',
  'tax_collected',
  'commission',
  'commission_tax',
  'refund',
  'refund_commission_reversal',
  'gateway_fee',
  'adjustment',
  'penalty',
  'hold',
  'release',
  'carry_forward',
]);

/**
 * One movement on a seller's account. SIGNED.
 *
 * Sales are positive; commission, refunds and penalties are negative. Storing
 * the sign rather than a kind-plus-magnitude means the statement total is
 * `sum(amount_minor)` and cannot disagree with the lines it is made of — which
 * is precisely the failure the brief describes when it says every seller must
 * be able to follow order → revenue → commission → deductions → net.
 *
 * `refundCommissionReversal` exists because refunding a sale must give back the
 * commission taken on it. A marketplace that keeps its commission on refunded
 * goods is one a seller stops trusting the first time they notice.
 */
export const settlementLines = pgTable('settlement_lines', {
  id: serial('id').primaryKey(),
  settlementId: integer('settlement_id').notNull().references(() => sellerSettlements.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  kind: settlementLineKind('kind').notNull(),

  /** Negative for anything deducted. The sign is the meaning. */
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull().default('INR'),

  sellerOrderId: integer('seller_order_id').references(() => sellerOrders.id),
  orderId: integer('order_id').references(() => orders.id),
  orderLineId: integer('order_line_id').references(() => orderLines.id),
  refundId: integer('refund_id').references(() => refunds.id),
  returnRequestId: integer('return_request_id').references(() => returnRequests.id),
  disputeId: integer('dispute_id').references(() => marketplaceDisputes.id),

  description: text('description').notNull(),
  occurredOn: date('occurred_on').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  settlementIdx: index('settlement_lines_settlement_idx').on(t.settlementId, t.occurredOn),
  sellerOrderIdx: index('settlement_lines_seller_order_idx').on(t.sellerOrderId),
  // A sale posts to a settlement ONCE. The replay guard for the accrual job,
  // which will be run twice by a cron that overlaps itself.
  saleUk: uniqueIndex('settlement_lines_sale_uk').on(t.sellerOrderId, t.kind, t.orderLineId)
    .where(sql`kind in ('sale', 'commission', 'commission_tax', 'shipping')`),
}));

export const payoutStatus = pgEnum('seller_payout_status', [
  'pending', 'queued', 'processing', 'paid', 'failed', 'reversed', 'cancelled',
]);

/**
 * Money actually leaving the federation for a seller.
 *
 * SEPARATE FROM THE SETTLEMENT because a settlement is an ACCOUNT and a payout
 * is a TRANSFER, and they fail independently: a correct settlement can have a
 * failed payout behind a wrong IFSC, and the seller needs to see that the
 * amount is right and the transfer is stuck, not one confused status.
 *
 * `idempotencyKey` is unique and required. A payout is the one operation in
 * this system where a retry that goes through twice cannot be undone by a
 * status change; it has to be prevented, and it has to be prevented in the
 * database rather than in a caller's control flow.
 */
export const sellerPayouts = pgTable('seller_payouts', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                     // MMAKF-PAY-2026-000001
  settlementId: integer('settlement_id').references(() => sellerSettlements.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  payoutAccountId: integer('payout_account_id').references(() => payoutAccounts.id),

  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull().default('INR'),

  provider: text('provider'),
  providerPayoutId: text('provider_payout_id'),
  /** Bank reference, once the transfer has landed. */
  utr: text('utr'),

  status: payoutStatus('status').notNull().default('pending'),
  initiatedByUserId: integer('initiated_by_user_id').references(() => users.id),
  initiatedAt: timestamp('initiated_at', { withTimezone: true }),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  failureReason: text('failure_reason'),
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  reversedReason: text('reversed_reason'),

  /** THE DOUBLE-PAYMENT GUARD. Required, unique, and checked by the database. */
  idempotencyKey: text('idempotency_key').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('seller_payouts_ref_uk').on(t.ref),
  idempotencyUk: uniqueIndex('seller_payouts_idempotency_uk').on(t.idempotencyKey),
  providerUk: uniqueIndex('seller_payouts_provider_uk').on(t.provider, t.providerPayoutId)
    .where(sql`provider_payout_id is not null`),
  sellerIdx: index('seller_payouts_seller_idx').on(t.sellerId, t.status),
  settlementIdx: index('seller_payouts_settlement_idx').on(t.settlementId),
}));

export const adjustmentKind = pgEnum('payout_adjustment_kind', [
  'hold', 'release', 'penalty', 'correction', 'chargeback', 'goodwill', 'recovery',
]);

/**
 * A deliberate change to what a seller is owed, outside the ordinary sales
 * arithmetic.
 *
 * REQUIRES AN APPROVER AND A REASON, both NOT NULL in every code path that
 * writes one. This is the table through which a person's income is reduced;
 * an unattributed row here is indistinguishable from an error and from theft,
 * and the seller is entitled to know who decided and why.
 */
export const payoutAdjustments = pgTable('payout_adjustments', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  settlementId: integer('settlement_id').references(() => sellerSettlements.id),
  kind: adjustmentKind('kind').notNull(),
  /** Signed. Negative reduces what the seller is paid. */
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull().default('INR'),

  reason: text('reason').notNull(),
  authority: text('authority'),
  disputeId: integer('dispute_id').references(() => marketplaceDisputes.id),
  requestedByUserId: integer('requested_by_user_id').references(() => users.id),
  approvedByUserId: integer('approved_by_user_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),

  /** Set when the adjustment has been posted onto a settlement. */
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  appliedLineId: integer('applied_line_id').references(() => settlementLines.id),
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  reversedReason: text('reversed_reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sellerIdx: index('payout_adjustments_seller_idx').on(t.sellerId),
  pendingIdx: index('payout_adjustments_pending_idx').on(t.sellerId)
    .where(sql`applied_at is null and approved_at is not null`),
}));

/**
 * A seller-facing statement, frozen.
 *
 * The brief asks for daily, weekly and monthly statements. Generating them on
 * demand from live tables would mean the March statement changes in April; so
 * the rendered figures are snapshotted here with the settlement they came from,
 * and the seller downloads a document rather than a query result.
 *
 * `bigint` on the totals because a statement can aggregate a year and an
 * `integer` of paise runs out at roughly ₹21 crore — a ceiling a large
 * distributor could reach, and one that would fail as a silent wrap rather
 * than as an error.
 */
export const sellerStatements = pgTable('seller_statements', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  settlementId: integer('settlement_id').references(() => sellerSettlements.id),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  cadence: text('cadence').notNull(),

  grossMinor: bigint('gross_minor', { mode: 'number' }).notNull().default(0),
  commissionMinor: bigint('commission_minor', { mode: 'number' }).notNull().default(0),
  refundMinor: bigint('refund_minor', { mode: 'number' }).notNull().default(0),
  adjustmentMinor: bigint('adjustment_minor', { mode: 'number' }).notNull().default(0),
  netMinor: bigint('net_minor', { mode: 'number' }).notNull().default(0),
  currency: text('currency').notNull().default('INR'),

  /** Every line as printed. A frozen copy, not a pointer. */
  snapshot: jsonb('snapshot').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('seller_statements_ref_uk').on(t.ref),
  periodUk: uniqueIndex('seller_statements_period_uk').on(t.sellerId, t.cadence, t.periodStart),
  sellerIdx: index('seller_statements_seller_idx').on(t.sellerId, t.periodStart),
}));
