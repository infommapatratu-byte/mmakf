// Reviews, seller performance, fraud signals, promotions and featured slots.
//
// ─── WHY PRODUCT RATINGS AND SELLER RATINGS ARE TWO TABLES ──────────────────
//
// The brief separates them and it is right to. They answer different questions
// and they fail differently:
//
//   · A PRODUCT rating is about the item. It should follow the item across
//     sellers, and it must survive the seller leaving the marketplace.
//   · A SELLER rating is about the service — packing, dispatch, communication,
//     whether the right thing arrived. A seller who ships promptly is not made
//     good by selling a good gi, and a seller who never posts anything is not
//     redeemed by the manufacturer's quality.
//
// Averaging them together produces a number that means neither, and it is the
// number every marketplace regrets shipping.
//
// ─── AND WHY BOTH REQUIRE A PURCHASE ────────────────────────────────────────
//
// Every review row points at an ORDER LINE or a SELLER ORDER, uniquely. That is
// the fake-review defence, and it is a constraint rather than a check: no code
// path can write a review without naming the purchase it came from, and no
// purchase can be reviewed twice. A moderation queue on top of unverified
// reviews is a queue that has already lost.
//
// ─── PERFORMANCE: MEASURED HERE, ENFORCED NOWHERE ───────────────────────────
//
// "Do not automatically punish based on one incident." So nothing in this file
// suspends anybody, restricts anybody or withholds a payout. It computes
// evidence and files it. Every enforcement action in this marketplace is taken
// by a person holding `marketplace:suspend`, against a record they can read.

import {
  pgTable, serial, text, integer, timestamp, boolean, date,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users, persons } from './schema';
import { sellers, listings } from './onboarding.schema';
import { marketplaceCategories, listingVariants } from './catalogue.schema';
import { orders, orderLines } from './commerce.schema';
import { sellerOrders } from './marketplace-orders.schema';

// ─── Reviews ────────────────────────────────────────────────────────────────

export const reviewStatus = pgEnum('marketplace_review_status', [
  'pending', 'published', 'rejected', 'hidden', 'withdrawn',
]);

/**
 * A rating of the ITEM, tied to the line that bought it.
 *
 * `rating` is 1..5 and the CHECK constraint lives in the migration. It is not a
 * decoration: a rating of 0 or 11 arriving through an API and landing in an
 * average is the sort of defect that is only ever noticed as "the numbers look
 * odd", weeks later, with no way to tell which rows are wrong.
 *
 * `status` defaults to 'pending' rather than 'published'. Moderation before
 * publication, not after — the brief requires review content to be moderated,
 * and a review that is visible while it waits has already done whatever damage
 * it was going to do.
 */
export const productReviews = pgTable('product_reviews', {
  id: serial('id').primaryKey(),
  listingId: integer('listing_id').notNull().references(() => listings.id),
  variantId: integer('variant_id').references(() => listingVariants.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),

  /** THE VERIFIED-PURCHASE ANCHOR. Unique — one review per line, for ever. */
  orderLineId: integer('order_line_id').notNull().references(() => orderLines.id),
  orderId: integer('order_id').notNull().references(() => orders.id),
  personId: integer('person_id').references(() => persons.id),
  byUserId: integer('by_user_id').references(() => users.id),

  rating: integer('rating').notNull(),
  title: text('title'),
  body: text('body'),
  media: jsonb('media'),

  status: reviewStatus('status').notNull().default('pending'),
  moderatedByUserId: integer('moderated_by_user_id').references(() => users.id),
  moderatedAt: timestamp('moderated_at', { withTimezone: true }),
  moderationReason: text('moderation_reason'),
  /** What an automated classifier thought. ADVISORY — a human decides. */
  moderationSignals: jsonb('moderation_signals'),

  /** The seller's public reply. One per review; edits overwrite it. */
  sellerReply: text('seller_reply'),
  sellerRepliedAt: timestamp('seller_replied_at', { withTimezone: true }),

  helpfulCount: integer('helpful_count').notNull().default(0),
  reportedCount: integer('reported_count').notNull().default(0),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  lineUk: uniqueIndex('product_reviews_line_uk').on(t.orderLineId),
  // The public listing page's index: published reviews for one listing.
  publishedIdx: index('product_reviews_published_idx').on(t.listingId, t.createdAt)
    .where(sql`status = 'published'`),
  sellerIdx: index('product_reviews_seller_idx').on(t.sellerId),
  queueIdx: index('product_reviews_queue_idx').on(t.status, t.createdAt),
}));

/**
 * A rating of the SERVICE, tied to the seller order.
 *
 * Three sub-scores rather than one, because "3 stars" tells a seller nothing
 * they can act on and tells a buyer nothing they can weigh. Each is nullable:
 * a buyer who only wants to say the parcel was late should not have to invent
 * an opinion about communication in order to say it.
 */
export const sellerReviews = pgTable('seller_reviews', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  /** THE VERIFIED-PURCHASE ANCHOR. Unique — one review per seller order. */
  sellerOrderId: integer('seller_order_id').notNull().references(() => sellerOrders.id),
  personId: integer('person_id').references(() => persons.id),
  byUserId: integer('by_user_id').references(() => users.id),

  ratingOverall: integer('rating_overall').notNull(),
  ratingDelivery: integer('rating_delivery'),
  ratingCommunication: integer('rating_communication'),
  ratingPackaging: integer('rating_packaging'),
  ratingAccuracy: integer('rating_accuracy'),

  body: text('body'),
  status: reviewStatus('status').notNull().default('pending'),
  moderatedByUserId: integer('moderated_by_user_id').references(() => users.id),
  moderatedAt: timestamp('moderated_at', { withTimezone: true }),
  moderationReason: text('moderation_reason'),

  sellerReply: text('seller_reply'),
  sellerRepliedAt: timestamp('seller_replied_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orderUk: uniqueIndex('seller_reviews_order_uk').on(t.sellerOrderId),
  publishedIdx: index('seller_reviews_published_idx').on(t.sellerId, t.createdAt)
    .where(sql`status = 'published'`),
  queueIdx: index('seller_reviews_queue_idx').on(t.status, t.createdAt),
}));

// ─── Performance ────────────────────────────────────────────────────────────

/**
 * A seller's measured conduct over a window.
 *
 * A SNAPSHOT PER PERIOD, not a running figure on the seller row. Two reasons,
 * and the second is the one that matters:
 *
 *   1. A running figure cannot show a trend, and a seller whose dispatch times
 *      have doubled since February looks identical to one who has always been
 *      slow.
 *   2. AN ENFORCEMENT DECISION MUST CITE EVIDENCE THAT DOES NOT MOVE. If a
 *      seller is restricted in May on the strength of a 30% return rate, and
 *      the figure is recomputed in June from live tables, the record no longer
 *      supports the decision — and the seller's appeal is against a number
 *      nobody can reproduce.
 *
 * Every rate is in BASIS POINTS and every count is a count. Nothing here is a
 * float, and nothing here is a verdict.
 */
export const sellerPerformanceSnapshots = pgTable('seller_performance_snapshots', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),

  ordersCount: integer('orders_count').notNull().default(0),
  acceptedCount: integer('accepted_count').notNull().default(0),
  cancelledBySellerCount: integer('cancelled_by_seller_count').notNull().default(0),
  dispatchedCount: integer('dispatched_count').notNull().default(0),
  onTimeDispatchCount: integer('on_time_dispatch_count').notNull().default(0),
  deliveredCount: integer('delivered_count').notNull().default(0),
  returnCount: integer('return_count').notNull().default(0),
  refundCount: integer('refund_count').notNull().default(0),
  disputeCount: integer('dispute_count').notNull().default(0),
  disputesUpheldCount: integer('disputes_upheld_count').notNull().default(0),
  complaintCount: integer('complaint_count').notNull().default(0),
  counterfeitCaseCount: integer('counterfeit_case_count').notNull().default(0),

  acceptanceRateBps: integer('acceptance_rate_bps'),
  onTimeDispatchRateBps: integer('on_time_dispatch_rate_bps'),
  cancellationRateBps: integer('cancellation_rate_bps'),
  returnRateBps: integer('return_rate_bps'),
  refundRateBps: integer('refund_rate_bps'),
  disputeRateBps: integer('dispute_rate_bps'),
  medianDispatchHours: integer('median_dispatch_hours'),

  ratingAvgBps: integer('rating_avg_bps'),
  ratingCount: integer('rating_count').notNull().default(0),
  /** How far the seller's own stock figures were from a physical count. */
  inventoryAccuracyBps: integer('inventory_accuracy_bps'),

  /**
   * The composite. NULLABLE, and null whenever the window holds too few orders
   * to mean anything — `MIN_ORDERS_FOR_SCORE` in src/db/marketplace-trust.ts.
   * A seller with two orders and one return does not have a 50% return rate in
   * any sense a human would defend, and a score computed from it would be used
   * as though it did.
   */
  scoreBps: integer('score_bps'),
  band: text('band'),
  /** The inputs and the weights, frozen, so the score can be explained. */
  workings: jsonb('workings'),

  computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  periodUk: uniqueIndex('seller_performance_period_uk').on(t.sellerId, t.periodStart, t.periodEnd),
  sellerIdx: index('seller_performance_seller_idx').on(t.sellerId, t.periodEnd),
  bandIdx: index('seller_performance_band_idx').on(t.band, t.periodEnd),
}));

/**
 * An SLA breach, recorded so escalation is a record rather than an email.
 *
 * Written only where an SLA has actually been configured — see
 * `seller_sla_configs`, which ships empty. No SLA means no breach, not a breach
 * against a default nobody agreed to.
 */
export const slaBreaches = pgTable('marketplace_sla_breaches', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  sellerOrderId: integer('seller_order_id').references(() => sellerOrders.id),
  /** acceptance | dispatch | return_response | support | dispute_response */
  kind: text('kind').notNull(),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  breachedAt: timestamp('breached_at', { withTimezone: true }).notNull().defaultNow(),
  overdueHours: integer('overdue_hours'),
  /** none | notified | escalated | actioned — what was done about it. */
  escalation: text('escalation').notNull().default('none'),
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
  escalatedToUserId: integer('escalated_to_user_id').references(() => users.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  note: text('note'),
}, (t) => ({
  breachUk: uniqueIndex('marketplace_sla_breaches_uk').on(t.sellerOrderId, t.kind),
  sellerIdx: index('marketplace_sla_breaches_seller_idx').on(t.sellerId, t.breachedAt),
}));

// ─── Fraud and abuse ────────────────────────────────────────────────────────

export const fraudSignalKind = pgEnum('fraud_signal_kind', [
  'duplicate_seller_account',
  'shared_contact_details',
  'suspicious_review_pattern',
  'unusual_order_velocity',
  'payment_anomaly',
  'rapid_refund_pattern',
  'inventory_manipulation',
  'counterfeit_indicator',
  'brand_impersonation',
  'federation_impersonation',
  'price_manipulation',
  'other',
]);

export const fraudSignalStatus = pgEnum('fraud_signal_status', [
  'open', 'reviewing', 'actioned', 'dismissed', 'false_positive',
]);

/**
 * Something a detector noticed. NOT something the system has decided.
 *
 * "AI can flag. Human review for serious enforcement." — the brief, and this
 * table is the boundary between the two halves of that sentence. A signal has a
 * severity, evidence and a status; it has no power. Nothing reads
 * `fraud_signals` and suspends anybody.
 *
 * `subjectType`/`subjectId` rather than eleven nullable foreign keys, because
 * the subjects genuinely differ — a seller, a listing, an order, a review, a
 * person — and a table with eleven mostly-null columns invites a query that
 * forgets one. The referential looseness is the deliberate cost of that.
 */
export const fraudSignals = pgTable('fraud_signals', {
  id: serial('id').primaryKey(),
  subjectType: text('subject_type').notNull(),    // seller | listing | order | review | person
  subjectId: integer('subject_id').notNull(),
  /** Denormalised where the subject has one, so a seller's signals collate. */
  sellerId: integer('seller_id').references(() => sellers.id),

  kind: fraudSignalKind('kind').notNull(),
  /** 1..5. Severity is the detector's opinion, not a mandate. */
  severity: integer('severity').notNull().default(1),
  detail: text('detail').notNull(),
  evidence: jsonb('evidence'),

  detector: text('detector').notNull(),           // which check raised it
  raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),

  status: fraudSignalStatus('status').notNull().default('open'),
  reviewedByUserId: integer('reviewed_by_user_id').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  actionTaken: text('action_taken'),
}, (t) => ({
  subjectIdx: index('fraud_signals_subject_idx').on(t.subjectType, t.subjectId),
  sellerIdx: index('fraud_signals_seller_idx').on(t.sellerId, t.status),
  openIdx: index('fraud_signals_open_idx').on(t.status, t.severity, t.raisedAt),
  // One live signal of a kind per subject, so a detector that runs hourly does
  // not bury the queue under the same finding a hundred times.
  liveUk: uniqueIndex('fraud_signals_live_uk').on(t.subjectType, t.subjectId, t.kind)
    .where(sql`status in ('open', 'reviewing')`),
}));

// ─── Promotions ─────────────────────────────────────────────────────────────

export const promotionStatus = pgEnum('seller_promotion_status', [
  'draft', 'awaiting_seller_consent', 'awaiting_federation_approval',
  'scheduled', 'active', 'ended', 'revoked',
]);

/**
 * A price reduction on a seller's goods.
 *
 * THE CONSENT GATE IS THE POINT. The brief: "Seller-specific promotions require
 * seller authorization." A marketplace that can discount a seller's stock
 * without asking is a marketplace that spends the seller's money — the discount
 * comes out of the seller's payable, not the platform's commission, unless
 * somebody says otherwise. So `sellerConsentAt` is required before a promotion
 * created by an administrator can go live, and `fundedBy` is required before
 * any of it is calculated.
 *
 * Kept apart from `discount_policies` (src/db/discounts.schema.ts), which is the
 * federation's own fee discounting for memberships and courses. Same word,
 * different money, different approvers.
 */
export const sellerPromotions = pgTable('seller_promotions', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),
  sellerId: integer('seller_id').references(() => sellers.id),
  listingId: integer('listing_id').references(() => listings.id),
  categoryId: integer('category_id').references(() => marketplaceCategories.id),

  name: text('name').notNull(),
  /** percent | flat | bundle | quantity_break | free_shipping */
  kind: text('kind').notNull(),
  valueBps: integer('value_bps'),
  valueMinor: integer('value_minor'),
  minQty: integer('min_qty'),
  minBasketMinor: integer('min_basket_minor'),
  maxRedemptions: integer('max_redemptions'),
  redemptionCount: integer('redemption_count').notNull().default(0),

  /** seller | platform — whose margin pays for it. NO DEFAULT. */
  fundedBy: text('funded_by'),

  campaignCode: text('campaign_code'),
  eventId: integer('event_id'),

  status: promotionStatus('status').notNull().default('draft'),
  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  /** THE GATE. Null means the seller has not agreed and it cannot go live. */
  sellerConsentByUserId: integer('seller_consent_by_user_id').references(() => users.id),
  sellerConsentAt: timestamp('seller_consent_at', { withTimezone: true }),
  approvedByUserId: integer('approved_by_user_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('seller_promotions_ref_uk').on(t.ref),
  sellerIdx: index('seller_promotions_seller_idx').on(t.sellerId, t.status),
  liveIdx: index('seller_promotions_live_idx').on(t.status, t.startsAt, t.endsAt),
}));

/**
 * Editorial placement on the marketplace — featured sellers, collections,
 * championship merchandise.
 *
 * ADMIN-ONLY BY CONSTRUCTION: there is no `sellerId` on the writer side and no
 * code path from a seller surface to this table. "Featured status must be
 * controlled by admin" is the brief's requirement, and a `featured` boolean on
 * the listing — the obvious implementation — is exactly the column a bulk
 * import or a careless update sets by accident.
 */
export const featuredPlacements = pgTable('featured_placements', {
  id: serial('id').primaryKey(),
  /** seller | listing | category | brand | collection */
  subjectType: text('subject_type').notNull(),
  subjectId: integer('subject_id').notNull(),
  /** home_hero | home_rail | category_top | event_collection */
  slot: text('slot').notNull(),
  position: integer('position').notNull().default(0),

  title: text('title'),
  blurb: text('blurb'),
  imageUrl: text('image_url'),

  startsAt: timestamp('starts_at', { withTimezone: true }),
  endsAt: timestamp('ends_at', { withTimezone: true }),
  active: boolean('active').notNull().default(true),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slotIdx: index('featured_placements_slot_idx').on(t.slot, t.position)
    .where(sql`active`),
  subjectIdx: index('featured_placements_subject_idx').on(t.subjectType, t.subjectId),
}));

/**
 * Merchandise attached to a competition or event.
 *
 * The link is a ROW rather than a tag on the listing, because the same event
 * shirt is sold by three sellers and the collection is curated by MMAKF. It
 * also carries `authorisedByUserId`: an event collection is the federation
 * saying "this is the official merchandise for the National Championship", and
 * that is a claim only the federation may make.
 */
export const eventMerchandise = pgTable('event_merchandise', {
  id: serial('id').primaryKey(),
  eventId: integer('event_id').notNull(),
  listingId: integer('listing_id').notNull().references(() => listings.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  collectionLabel: text('collection_label'),
  sortOrder: integer('sort_order').notNull().default(0),
  /** Whether this may be offered during event registration. */
  offerAtRegistration: boolean('offer_at_registration').notNull().default(false),
  /**
   * Whether the event's own policy REQUIRES the item.
   *
   * "Do not make merchandise mandatory unless the event/program policy
   * explicitly requires it." Defaults to false, and the surface renders a
   * required item as a stated requirement with the policy named — never as a
   * pre-ticked box, which is the pattern the brief's "must not manipulate
   * users" is aimed at.
   */
  mandatory: boolean('mandatory').notNull().default(false),
  mandatoryPolicyRef: text('mandatory_policy_ref'),

  authorisedByUserId: integer('authorised_by_user_id').references(() => users.id),
  authorisedAt: timestamp('authorised_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pairUk: uniqueIndex('event_merchandise_pair_uk').on(t.eventId, t.listingId),
  eventIdx: index('event_merchandise_event_idx').on(t.eventId, t.sortOrder),
  sellerIdx: index('event_merchandise_seller_idx').on(t.sellerId),
}));
