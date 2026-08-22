// Reviews, seller performance and fraud signals.
//
// ─── THE RULE THAT SHAPES EVERY FUNCTION HERE ───────────────────────────────
//
//     "Do not automatically punish based on one incident."
//
// So NOTHING in this file suspends anybody, restricts anybody, withholds a
// payout or hides a listing. It computes evidence and files it. Every
// enforcement action in this marketplace is taken by a person holding
// `marketplace:suspend`, against a record they can read — and the record is
// what this module exists to produce.
//
// ─── AND THE THREE REFUSALS ─────────────────────────────────────────────────
//
//  1. A REVIEW REQUIRES A PURCHASE. `leaveProductReview()` takes an order line,
//     proves the caller bought it, and the database's unique NOT NULL index
//     does the rest. There is no code path to an unverified review because
//     there is no row shape for one.
//
//  2. A SCORE BELOW A MINIMUM ORDER COUNT IS NULL, NOT ZERO. A seller with two
//     orders and one return does not have a 50% return rate in any sense a
//     human would defend, and a score computed from it would be quoted as
//     though they did.
//
//  3. NOTHING IS PUBLISHED UNMODERATED. Reviews arrive `pending`. A review that
//     is visible while it waits has already done whatever damage it was going
//     to do, and taking it down afterwards does not undo that.

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, type Principal } from '@/lib/rbac';
import { MarketplaceError } from '@/db/marketplace';

type DB = any;

/**
 * Below this many completed orders in the window, a composite score is NULL.
 *
 * Not a tuning constant — a statement about what a rate means. Ten is the point
 * at which one bad order stops being half the sample; MMAKF may raise it, and
 * `workings` records the figure that was used so an old snapshot can still be
 * read against the rule it was computed under.
 */
export const MIN_ORDERS_FOR_SCORE = 10;

export const PERFORMANCE_NOT_COMPUTED =
  'Not enough completed orders in this period for a rate to mean anything. ' +
  'The counts below are real; the score is deliberately absent rather than ' +
  'computed from a sample too small to defend.';

// ─── Reviews ────────────────────────────────────────────────────────────────

/**
 * Review an item you bought.
 *
 * THE PURCHASE IS THE ANCHOR. The order line is looked up together with its
 * seller order and the buyer behind it, in one query, and the caller must be
 * that buyer. A second review of the same line collides on
 * `product_reviews_line_uk` — which is the fake-review defence, and it is a
 * constraint rather than a check because two requests arriving together can
 * both pass a check.
 */
export async function leaveProductReview(
  db: DB, ctx: AuditContext,
  input: { orderLineId: number; rating: number; title?: string | null; body?: string | null }
) {
  if (ctx.principal?.userId == null) {
    throw new MarketplaceError('not_signed_in', 'Sign in to review something you bought.');
  }
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new MarketplaceError('bad_rating', 'A rating is a whole number from 1 to 5.');
  }

  const user = (await db.select({ personId: s.users.personId }).from(s.users)
    .where(eq(s.users.id, ctx.principal.userId)).limit(1))[0];

  const rows = await db.select({ line: s.orderLines, so: s.sellerOrders })
    .from(s.orderLines)
    .innerJoin(s.sellerOrders, eq(s.orderLines.sellerOrderId, s.sellerOrders.id))
    .where(eq(s.orderLines.id, input.orderLineId)).limit(1);

  if (!rows.length) throw new MarketplaceError('unknown_line', 'No such purchase.');
  const { line, so } = rows[0];

  // The same message whether it belongs to somebody else or does not exist.
  if (user?.personId == null || so.buyerPersonId !== user.personId) {
    throw new MarketplaceError('not_your_purchase', 'No such purchase on this account.');
  }
  // Reviewing something that has not arrived is reviewing an expectation.
  if (!['delivered', 'return_requested', 'returned', 'refunded'].includes(so.status)) {
    throw new MarketplaceError(
      'not_delivered',
      `These goods are ${so.status}. A review is about what arrived, so it waits until something has.`
    );
  }

  try {
    const [row] = await db.insert(s.productReviews).values({
      listingId: line.listingId!,
      variantId: line.listingVariantId ?? null,
      sellerId: line.sellerId!,
      orderLineId: line.id,
      orderId: so.orderId,
      personId: user.personId,
      byUserId: ctx.principal.userId,
      rating: input.rating,
      title: input.title?.trim() || null,
      body: input.body?.trim() || null,
      // PENDING. Moderation before publication, not after.
      status: 'pending',
    }).returning({ id: s.productReviews.id });
    return { reviewId: row.id, status: 'pending' as const };
  } catch (err: any) {
    if (String(err?.cause?.message ?? err?.message ?? '').includes('product_reviews_line_uk')) {
      throw new MarketplaceError('already_reviewed', 'You have already reviewed this purchase.');
    }
    throw err;
  }
}

/** Rate the SERVICE — a different question from rating the goods. */
export async function leaveSellerReview(
  db: DB, ctx: AuditContext,
  input: {
    sellerOrderId: number; ratingOverall: number;
    ratingDelivery?: number | null; ratingCommunication?: number | null;
    ratingPackaging?: number | null; ratingAccuracy?: number | null;
    body?: string | null;
  }
) {
  if (ctx.principal?.userId == null) {
    throw new MarketplaceError('not_signed_in', 'Sign in to review a seller you bought from.');
  }
  for (const [k, v] of Object.entries(input)) {
    if (k.startsWith('rating') && v != null && (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 5)) {
      throw new MarketplaceError('bad_rating', 'Every rating is a whole number from 1 to 5.');
    }
  }

  const user = (await db.select({ personId: s.users.personId }).from(s.users)
    .where(eq(s.users.id, ctx.principal.userId)).limit(1))[0];
  const so = (await db.select().from(s.sellerOrders)
    .where(eq(s.sellerOrders.id, input.sellerOrderId)).limit(1))[0];

  if (!so || user?.personId == null || so.buyerPersonId !== user.personId) {
    throw new MarketplaceError('not_your_purchase', 'No such order on this account.');
  }

  try {
    const [row] = await db.insert(s.sellerReviews).values({
      sellerId: so.sellerId,
      sellerOrderId: so.id,
      personId: user.personId,
      byUserId: ctx.principal.userId,
      ratingOverall: input.ratingOverall,
      ratingDelivery: input.ratingDelivery ?? null,
      ratingCommunication: input.ratingCommunication ?? null,
      ratingPackaging: input.ratingPackaging ?? null,
      ratingAccuracy: input.ratingAccuracy ?? null,
      body: input.body?.trim() || null,
      status: 'pending',
    }).returning({ id: s.sellerReviews.id });
    return { reviewId: row.id, status: 'pending' as const };
  } catch (err: any) {
    if (String(err?.cause?.message ?? err?.message ?? '').includes('seller_reviews_order_uk')) {
      throw new MarketplaceError('already_reviewed', 'You have already reviewed this order.');
    }
    throw err;
  }
}

/**
 * Publish, reject or hide a review.
 *
 * `marketplace:review` — the same authority that decides whether a gi may be
 * advertised, because a review is content on the federation's marketplace and
 * publishing one is the same class of decision.
 */
export async function moderateReview(
  db: DB, ctx: AuditContext,
  input: {
    kind: 'product' | 'seller';
    reviewId: number;
    status: 'published' | 'rejected' | 'hidden';
    reason?: string | null;
  }
) {
  assertCan(ctx.principal, 'marketplace:review', {});
  if (input.status !== 'published' && !String(input.reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'Refusing or hiding a review requires a reason.');
  }

  const table = input.kind === 'product' ? s.productReviews : s.sellerReviews;
  const row = (await db.select().from(table).where(eq(table.id, input.reviewId)).limit(1))[0];
  if (!row) throw new MarketplaceError('unknown_review', 'No such review.');

  await db.update(table).set({
    status: input.status,
    moderatedByUserId: ctx.principal?.userId ?? null,
    moderatedAt: new Date(),
    moderationReason: input.reason ?? null,
    updatedAt: new Date(),
  }).where(eq(table.id, input.reviewId));

  await refreshSellerRating(db, row.sellerId);

  await writeAudit(db, { ...ctx, reason: input.reason ?? undefined }, {
    entityType: `${input.kind}_review`, entityId: input.reviewId,
    action: input.status === 'published' ? 'approve' : 'reject',
    oldValue: { status: row.status }, newValue: { status: input.status },
  });
  return { reviewId: input.reviewId, status: input.status };
}

/** The seller's own public reply. One per review; an edit replaces it. */
export async function replyToReview(
  db: DB, ctx: AuditContext,
  input: { kind: 'product' | 'seller'; reviewId: number; reply: string }
) {
  const { ownSellerRecord } = await import('@/db/seller-orders');
  const seller = await ownSellerRecord(db, ctx.principal);
  if (!String(input.reply ?? '').trim()) {
    throw new MarketplaceError('reply_required', 'A reply needs to say something.');
  }

  const table = input.kind === 'product' ? s.productReviews : s.sellerReviews;
  const updated = await db.update(table).set({
    sellerReply: input.reply.trim(),
    sellerRepliedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(table.id, input.reviewId),
    // THE ISOLATION FILTER, in SQL. A seller replying to another seller's
    // review is not refused afterwards — the UPDATE matches nothing.
    eq(table.sellerId, seller.id),
  )).returning({ id: table.id });

  if (!updated.length) throw new MarketplaceError('not_your_review', 'No such review on your seller account.');
  return { reviewId: input.reviewId };
}

export async function reviewQueue(db: DB, principal: Principal, limit = 100) {
  assertCan(principal, 'marketplace:read', {});
  const product = await db.select({
    review: s.productReviews, listingTitle: s.listings.title, sellerName: s.sellers.tradingName,
  }).from(s.productReviews)
    .innerJoin(s.listings, eq(s.productReviews.listingId, s.listings.id))
    .innerJoin(s.sellers, eq(s.productReviews.sellerId, s.sellers.id))
    .where(eq(s.productReviews.status, 'pending'))
    .orderBy(asc(s.productReviews.createdAt)).limit(limit);

  const seller = await db.select({
    review: s.sellerReviews, sellerName: s.sellers.tradingName,
  }).from(s.sellerReviews)
    .innerJoin(s.sellers, eq(s.sellerReviews.sellerId, s.sellers.id))
    .where(eq(s.sellerReviews.status, 'pending'))
    .orderBy(asc(s.sellerReviews.createdAt)).limit(limit);

  return { product, seller };
}

/**
 * Refresh the cached rating on the seller row.
 *
 * FROM PUBLISHED SELLER REVIEWS ONLY. A pending review must not move a public
 * average — that would publish its effect while the review itself is still
 * being looked at, which is the moderation gate leaking through the back.
 */
export async function refreshSellerRating(db: DB, sellerId: number) {
  const agg = (await db.select({
    n: sql<number>`count(*)::int`,
    avgBps: sql<number>`coalesce(round(avg(${s.sellerReviews.ratingOverall}) * 10000), 0)::int`,
  }).from(s.sellerReviews).where(and(
    eq(s.sellerReviews.sellerId, sellerId),
    eq(s.sellerReviews.status, 'published'),
  )))[0];

  await db.update(s.sellers).set({
    ratingAvgBps: agg.n > 0 ? agg.avgBps : null,
    ratingCount: agg.n,
    updatedAt: new Date(),
  }).where(eq(s.sellers.id, sellerId));

  return { count: agg.n, avgBps: agg.n > 0 ? agg.avgBps : null };
}

// ─── Performance ────────────────────────────────────────────────────────────

/** Basis points, guarding the zero-denominator that would otherwise be NaN. */
const rate = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((numerator / denominator) * 10_000) : null;

/**
 * Compute one seller's conduct over a window, and file it.
 *
 * A SNAPSHOT, not a running figure. An enforcement decision must cite evidence
 * that does not move: if a seller is restricted in May on the strength of a 30%
 * return rate and the figure is recomputed in June from live tables, the record
 * no longer supports the decision and the seller's appeal is against a number
 * nobody can reproduce.
 *
 * RETURNS A BAND AND NEVER ACTS ON IT. `at_risk` is a position a human moves a
 * seller into; nothing here reads the band back.
 */
export async function computeSellerPerformance(
  db: DB, ctx: AuditContext,
  input: { sellerId: number; periodStart: string; periodEnd: string }
) {
  assertCan(ctx.principal, 'marketplace:read', {});

  const from = new Date(`${input.periodStart}T00:00:00Z`);
  const to = new Date(`${input.periodEnd}T23:59:59Z`);

  const orders = await db.select().from(s.sellerOrders).where(and(
    eq(s.sellerOrders.sellerId, input.sellerId),
    gte(s.sellerOrders.createdAt, from),
    lte(s.sellerOrders.createdAt, to),
  ));

  const ordersCount = orders.length;
  const accepted = orders.filter((o: any) => o.acceptedAt).length;
  const cancelledBySeller = orders.filter((o: any) => o.cancelledBy === 'seller').length;
  const dispatched = orders.filter((o: any) => o.dispatchedAt).length;
  // ON TIME IS ONLY MEASURABLE WHERE A DEADLINE EXISTS. An order with no
  // `dispatchBy` — because MMAKF has published no SLA — counts as neither on
  // time nor late, rather than being scored against a window nobody set.
  const withDeadline = orders.filter((o: any) => o.dispatchBy && o.dispatchedAt);
  const onTime = withDeadline.filter((o: any) => new Date(o.dispatchedAt) <= new Date(o.dispatchBy)).length;
  const delivered = orders.filter((o: any) => o.deliveredAt).length;

  const orderIds = orders.map((o: any) => o.id);
  const countIn = async (table: any, col: any, extra?: any) => {
    if (!orderIds.length) return 0;
    const r = await db.select({ n: sql<number>`count(*)::int` }).from(table)
      .where(extra ? and(inArray(col, orderIds), extra) : inArray(col, orderIds));
    return r[0]?.n ?? 0;
  };

  const returnCount = await countIn(s.returnRequests, s.returnRequests.sellerOrderId);
  const refundCount = await countIn(s.returnRequests, s.returnRequests.sellerOrderId,
    eq(s.returnRequests.status, 'refunded'));
  const disputeCount = await countIn(s.marketplaceDisputes, s.marketplaceDisputes.sellerOrderId);
  const disputesUpheld = await countIn(s.marketplaceDisputes, s.marketplaceDisputes.sellerOrderId,
    eq(s.marketplaceDisputes.outcome, 'buyer_upheld'));
  const complaints = await countIn(s.buyerReports, s.buyerReports.sellerOrderId);

  const counterfeit = (await db.select({ n: sql<number>`count(*)::int` })
    .from(s.authenticityCases).where(and(
      eq(s.authenticityCases.sellerId, input.sellerId),
      eq(s.authenticityCases.status, 'upheld'),
      gte(s.authenticityCases.openedAt, from),
      lte(s.authenticityCases.openedAt, to),
    )))[0]?.n ?? 0;

  const dispatchHours = orders
    .filter((o: any) => o.paidAt && o.dispatchedAt)
    .map((o: any) => (new Date(o.dispatchedAt).getTime() - new Date(o.paidAt).getTime()) / 3_600_000)
    .sort((a: number, b: number) => a - b);
  const medianDispatchHours = dispatchHours.length
    ? Math.round(dispatchHours[Math.floor(dispatchHours.length / 2)])
    : null;

  const rating = await db.select({
    n: sql<number>`count(*)::int`,
    avgBps: sql<number>`coalesce(round(avg(${s.sellerReviews.ratingOverall}) * 10000), 0)::int`,
  }).from(s.sellerReviews).where(and(
    eq(s.sellerReviews.sellerId, input.sellerId),
    eq(s.sellerReviews.status, 'published'),
  ));

  const acceptanceRateBps = rate(accepted, ordersCount);
  const onTimeDispatchRateBps = rate(onTime, withDeadline.length);
  const cancellationRateBps = rate(cancelledBySeller, ordersCount);
  const returnRateBps = rate(returnCount, ordersCount);
  const refundRateBps = rate(refundCount, ordersCount);
  const disputeRateBps = rate(disputeCount, ordersCount);

  // ── The composite, or nothing ────────────────────────────────────────────
  //
  // Weighted from the rates that ARE measurable, renormalised over those. A
  // seller with no SLA has no on-time figure, and folding a null in as zero
  // would score them as though they had dispatched nothing on time.
  let scoreBps: number | null = null;
  let band: string | null = null;
  const weights: Array<[string, number | null, number, boolean]> = [
    ['acceptance', acceptanceRateBps, 2, false],
    ['onTimeDispatch', onTimeDispatchRateBps, 3, false],
    ['cancellation', cancellationRateBps, 2, true],
    ['returns', returnRateBps, 1, true],
    ['disputes', disputeRateBps, 3, true],
  ];

  if (ordersCount >= MIN_ORDERS_FOR_SCORE) {
    let weighted = 0;
    let total = 0;
    for (const [, value, weight, inverted] of weights) {
      if (value == null) continue;
      weighted += weight * (inverted ? 10_000 - value : value);
      total += weight;
    }
    if (total > 0) {
      scoreBps = Math.round(weighted / total);
      band = scoreBps >= 9_000 ? 'good'
        : scoreBps >= 7_500 ? 'watch'
        : scoreBps >= 6_000 ? 'at_risk'
        : 'critical';
    }
  }

  const workings = {
    minOrdersForScore: MIN_ORDERS_FOR_SCORE,
    weights: weights.map(([k, v, w, inv]) => ({ measure: k, valueBps: v, weight: w, inverted: inv })),
    note: scoreBps == null ? PERFORMANCE_NOT_COMPUTED : null,
    ordersWithoutDeadline: ordersCount - withDeadline.length,
  };

  await db.insert(s.sellerPerformanceSnapshots).values({
    sellerId: input.sellerId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    ordersCount, acceptedCount: accepted, cancelledBySellerCount: cancelledBySeller,
    dispatchedCount: dispatched, onTimeDispatchCount: onTime, deliveredCount: delivered,
    returnCount, refundCount, disputeCount, disputesUpheldCount: disputesUpheld,
    complaintCount: complaints, counterfeitCaseCount: counterfeit,
    acceptanceRateBps, onTimeDispatchRateBps, cancellationRateBps,
    returnRateBps, refundRateBps, disputeRateBps, medianDispatchHours,
    ratingAvgBps: rating[0]?.n > 0 ? rating[0].avgBps : null,
    ratingCount: rating[0]?.n ?? 0,
    scoreBps, band,
    workings: workings as any,
  }).onConflictDoNothing();

  // The cached band on the seller row, for the admin list. NOT read by any
  // enforcement path — there is none.
  await db.update(s.sellers).set({
    performanceScoreBps: scoreBps,
    performanceBand: (band ?? 'unrated') as any,
    performanceComputedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(s.sellers.id, input.sellerId));

  return {
    sellerId: input.sellerId, ordersCount, scoreBps, band,
    note: scoreBps == null ? PERFORMANCE_NOT_COMPUTED : null,
  };
}

/** Every seller's snapshot for one window. Run from a cron, or by hand. */
export async function computeAllPerformance(
  db: DB, ctx: AuditContext, periodStart: string, periodEnd: string
) {
  assertCan(ctx.principal, 'marketplace:read', {});
  const sellers = await db.select({ id: s.sellers.id }).from(s.sellers)
    .where(eq(s.sellers.status, 'approved')).limit(2000);

  const results = [];
  for (const seller of sellers) {
    results.push(await computeSellerPerformance(db, ctx, { sellerId: seller.id, periodStart, periodEnd }));
  }
  return {
    computed: results.length,
    scored: results.filter((r) => r.scoreBps != null).length,
    unscored: results.filter((r) => r.scoreBps == null).length,
    note: PERFORMANCE_NOT_COMPUTED,
  };
}

// ─── Fraud signals ──────────────────────────────────────────────────────────

/**
 * Record something a detector noticed.
 *
 * A SIGNAL HAS NO POWER. Nothing in this codebase reads `fraud_signals` and
 * suspends anybody. The partial unique index means a detector that runs hourly
 * raises one open signal per subject per kind rather than burying the queue
 * under the same finding a hundred times.
 */
export async function raiseFraudSignal(
  db: DB,
  input: {
    subjectType: 'seller' | 'listing' | 'order' | 'review' | 'person';
    subjectId: number;
    sellerId?: number | null;
    kind: (typeof s.fraudSignalKind.enumValues)[number];
    severity?: number;
    detail: string;
    detector: string;
    evidence?: Record<string, unknown> | null;
  }
) {
  const [row] = await db.insert(s.fraudSignals).values({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    sellerId: input.sellerId ?? null,
    kind: input.kind,
    severity: Math.max(1, Math.min(5, input.severity ?? 1)),
    detail: input.detail,
    detector: input.detector,
    evidence: input.evidence ?? null,
  }).onConflictDoNothing().returning({ id: s.fraudSignals.id });
  return { signalId: row?.id ?? null, deduplicated: !row };
}

export async function reviewFraudSignal(
  db: DB, ctx: AuditContext, signalId: number,
  decision: { status: 'actioned' | 'dismissed' | 'false_positive'; reason: string; actionTaken?: string | null }
) {
  assertCan(ctx.principal, 'marketplace:suspend', {});
  if (!String(decision.reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'A decision on a fraud signal requires a reason.');
  }
  await db.update(s.fraudSignals).set({
    status: decision.status,
    reviewedByUserId: ctx.principal?.userId ?? null,
    reviewedAt: new Date(),
    decisionReason: decision.reason,
    actionTaken: decision.actionTaken ?? null,
  }).where(eq(s.fraudSignals.id, signalId));

  await writeAudit(db, { ...ctx, reason: decision.reason }, {
    entityType: 'fraud_signal', entityId: signalId, action: 'update',
    newValue: { status: decision.status, actionTaken: decision.actionTaken ?? null },
  });
  return { signalId, status: decision.status };
}

/**
 * Reviews that look coordinated.
 *
 * FLAGS ONLY. Several five-star reviews from one buyer across one seller's
 * catalogue in a short window is a pattern worth a human look; it is also what
 * a genuinely delighted dojo owner buying six things looks like. That is
 * exactly why this raises a signal and decides nothing.
 */
export async function detectReviewPatterns(db: DB, windowDays = 14) {
  const since = new Date(Date.now() - windowDays * 86_400_000);

  const suspicious = await db.select({
    sellerId: s.productReviews.sellerId,
    personId: s.productReviews.personId,
    n: sql<number>`count(*)::int`,
    avg: sql<number>`avg(${s.productReviews.rating})`,
  }).from(s.productReviews)
    .where(gte(s.productReviews.createdAt, since))
    .groupBy(s.productReviews.sellerId, s.productReviews.personId)
    .having(sql`count(*) >= 4 and avg(${s.productReviews.rating}) >= 4.75`);

  let raised = 0;
  for (const row of suspicious) {
    if (row.personId == null) continue;
    const result = await raiseFraudSignal(db, {
      subjectType: 'seller', subjectId: row.sellerId, sellerId: row.sellerId,
      kind: 'suspicious_review_pattern', severity: 2,
      detail:
        `One buyer left ${row.n} reviews averaging ${Number(row.avg).toFixed(2)} for this seller in ` +
        `${windowDays} days. This is also what a satisfied dojo buying several things looks like — ` +
        'a person decides which.',
      detector: 'review_pattern',
      evidence: { personId: row.personId, count: row.n, averageRating: Number(row.avg) },
    });
    if (result.signalId) raised++;
  }
  return { examined: suspicious.length, raised };
}
