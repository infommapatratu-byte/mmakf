// Returns, refunds and buyer/seller disputes.
//
// ─── THE RULE THAT DECIDES THE SHAPE OF THIS FILE ───────────────────────────
//
//     "Each seller must configure: return window, eligible products, condition,
//      return shipping, exchange, refund. BUT SELLER POLICY CANNOT VIOLATE
//      MANDATORY PLATFORM/LEGAL REQUIREMENTS."
//
// So there are two policies and one answer. `effectiveReturnPolicy()` takes the
// MORE GENEROUS of the seller's own window and the marketplace floor, in one
// function, and every eligibility check goes through it. A seller offering
// fourteen days when MMAKF mandates seven gives fourteen; a seller offering
// three gives seven.
//
// AND THE FLOOR SHIPS UNSET. MMAKF has not published a marketplace-wide return
// window. Until it does, the seller's own window stands and the surfaces say
// exactly that — because a seven-day floor invented here would be enforced
// against sellers who never agreed to it, and quoted to buyers as though the
// federation had promised it.
//
// ─── AND THE ONE THAT DECIDES THE ELIGIBILITY CHECK ─────────────────────────
//
// `eligibilityAtRequest` is FROZEN onto the request. A seller who shortens
// their window on Tuesday must not thereby invalidate Monday's request, and
// without the frozen copy the recomputation on Wednesday says the request was
// never eligible in the first place. Same discipline as the invoice tax
// snapshot and the commission freeze.
//
// ─── REFUND ≠ RETURN ────────────────────────────────────────────────────────
//
// A return is goods coming back. A refund is money going back. They usually
// travel together and they are not the same event: a damaged-in-transit item is
// refunded without ever coming back, and a rejected return comes back to the
// buyer with no refund at all. Keeping them apart is what lets both happen.

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, allocateFederationId, type AuditContext } from '@/db/federation';
import { assertCan, type Principal } from '@/lib/rbac';
import { MarketplaceError } from '@/db/marketplace';
import { restockReturn } from '@/db/inventory';
import { accrueRefund } from '@/db/marketplace-finance';
import { slaFor, ownSellerRecord } from '@/db/seller-orders';

type DB = any;

export const RETURN_FLOOR_NOT_SET =
  'MMAKF has published no marketplace-wide minimum return window. Until it does, ' +
  'each seller’s own policy stands and is shown as theirs, not as the federation’s.';

export const RETURN_POLICY_NOT_SET =
  'This seller has not published a return policy. Nothing is assumed on their ' +
  'behalf; a request is decided by them and by the federation on its facts.';

// ─── Policy ─────────────────────────────────────────────────────────────────

export interface EffectiveReturnPolicy {
  /** Null means neither the seller nor MMAKF has published a window. */
  windowDays: number | null;
  /** Which of the two produced the answer. */
  source: 'seller' | 'marketplace_floor' | 'none';
  sellerWindowDays: number | null;
  floorWindowDays: number | null;
  nonReturnable: boolean;
  nonReturnableReason: string | null;
  returnShippingPaidBy: string | null;
  exchangeOffered: boolean | null;
  conditionRequirements: string | null;
  notes: string[];
}

/**
 * The seller's policy and the marketplace floor, reconciled.
 *
 * MORE GENEROUS WINS on the window, which is the only reading of "seller policy
 * cannot violate mandatory requirements" that actually protects a buyer: taking
 * the seller's number when it is larger honours their offer, and taking the
 * floor when it is larger enforces the requirement.
 *
 * `nonReturnable` is the ONE thing a seller may set that the floor does not
 * override, and only because some goods genuinely cannot come back — a bespoke
 * gi, a digital course. It carries a required reason so the buyer is told why
 * before they buy rather than after they ask.
 */
export async function effectiveReturnPolicy(
  db: DB, sellerId: number, categoryId?: number | null
): Promise<EffectiveReturnPolicy> {
  const rows = await db.select().from(s.returnPolicies).where(and(
    eq(s.returnPolicies.active, true),
    sql`(${s.returnPolicies.sellerId} = ${sellerId} or ${s.returnPolicies.sellerId} is null)`,
  ));

  const floor = rows.find((r: any) => r.sellerId == null) ?? null;
  const own = rows.find((r: any) =>
    r.sellerId === sellerId && (categoryId == null || r.categoryId == null || r.categoryId === categoryId)) ?? null;

  const sellerWindow = own?.windowDays ?? null;
  const floorWindow = floor?.windowDays ?? null;

  const notes: string[] = [];
  if (floorWindow == null) notes.push(RETURN_FLOOR_NOT_SET);
  if (sellerWindow == null) notes.push(RETURN_POLICY_NOT_SET);

  let windowDays: number | null = null;
  let source: EffectiveReturnPolicy['source'] = 'none';
  if (sellerWindow != null && floorWindow != null) {
    windowDays = Math.max(sellerWindow, floorWindow);
    source = windowDays === sellerWindow ? 'seller' : 'marketplace_floor';
  } else if (sellerWindow != null) { windowDays = sellerWindow; source = 'seller'; }
  else if (floorWindow != null) { windowDays = floorWindow; source = 'marketplace_floor'; }

  return {
    windowDays,
    source,
    sellerWindowDays: sellerWindow,
    floorWindowDays: floorWindow,
    nonReturnable: !!own?.nonReturnable,
    nonReturnableReason: own?.nonReturnableReason ?? null,
    returnShippingPaidBy: own?.returnShippingPaidBy ?? floor?.returnShippingPaidBy ?? null,
    exchangeOffered: own?.exchangeOffered ?? null,
    conditionRequirements: own?.conditionRequirements ?? floor?.conditionRequirements ?? null,
    notes,
  };
}

export async function setReturnPolicy(
  db: DB, ctx: AuditContext,
  input: {
    windowDays?: number | null;
    returnShippingPaidBy?: 'buyer' | 'seller' | 'platform' | null;
    conditionRequirements?: string | null;
    exchangeOffered?: boolean | null;
    nonReturnable?: boolean;
    nonReturnableReason?: string | null;
    categoryId?: number | null;
    /** Set only by the federation, and only with `marketplace:review`. */
    marketplaceFloor?: boolean;
  }
) {
  let sellerId: number | null;
  if (input.marketplaceFloor) {
    assertCan(ctx.principal, 'marketplace:review', {});
    sellerId = null;
  } else {
    sellerId = (await ownSellerRecord(db, ctx.principal)).id;
  }

  if (input.nonReturnable && !String(input.nonReturnableReason ?? '').trim()) {
    throw new MarketplaceError(
      'reason_required',
      'Marking goods non-returnable requires a reason. A buyer is entitled to know before they buy, not after they ask.'
    );
  }
  if (input.windowDays != null && (!Number.isInteger(input.windowDays) || input.windowDays < 0)) {
    throw new MarketplaceError('bad_window', 'A return window must be a whole number of days, zero or more.');
  }

  await db.update(s.returnPolicies).set({ active: false }).where(and(
    sellerId == null ? isNull(s.returnPolicies.sellerId) : eq(s.returnPolicies.sellerId, sellerId),
    input.categoryId == null ? isNull(s.returnPolicies.categoryId) : eq(s.returnPolicies.categoryId, input.categoryId),
    eq(s.returnPolicies.active, true),
  ));

  const [row] = await db.insert(s.returnPolicies).values({
    sellerId,
    categoryId: input.categoryId ?? null,
    windowDays: input.windowDays ?? null,
    returnShippingPaidBy: input.returnShippingPaidBy ?? null,
    conditionRequirements: input.conditionRequirements ?? null,
    exchangeOffered: input.exchangeOffered ?? null,
    nonReturnable: !!input.nonReturnable,
    nonReturnableReason: input.nonReturnableReason ?? null,
    setByUserId: ctx.principal?.userId ?? null,
  }).returning({ id: s.returnPolicies.id });

  await writeAudit(db, ctx, {
    entityType: 'return_policy', entityId: row.id, action: 'create',
    newValue: { sellerId, windowDays: input.windowDays ?? null, marketplaceFloor: !!input.marketplaceFloor },
  });
  return { policyId: row.id };
}

// ─── Requesting a return ────────────────────────────────────────────────────

export interface ReturnRequestInput {
  sellerOrderId: number;
  reason: string;
  reasonDetail?: string | null;
  remedySought?: 'refund' | 'exchange';
  items: { orderLineId: number; quantity: number; condition?: (typeof s.returnItemCondition.enumValues)[number] }[];
  evidence?: Record<string, unknown> | null;
}

/**
 * A buyer asking to send something back.
 *
 * AGAINST A SELLER ORDER, never against the whole order. Returning Seller A's
 * gi must leave Seller B's mitts untouched, and a return that pointed at the
 * order would have to remember which parts of it it meant — which is the same
 * bug as a shared total, arriving through a different door.
 */
export async function requestReturn(
  db: DB, ctx: AuditContext, input: ReturnRequestInput
) {
  const rows = await db.select({ so: s.sellerOrders, seller: s.sellers })
    .from(s.sellerOrders).innerJoin(s.sellers, eq(s.sellerOrders.sellerId, s.sellers.id))
    .where(eq(s.sellerOrders.id, input.sellerOrderId)).limit(1);
  if (!rows.length) throw new MarketplaceError('unknown_seller_order', 'No such order.');
  const { so } = rows[0];

  await assertBuyerOf(db, ctx.principal, so);

  if (!String(input?.reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'A return request needs a reason.');
  }
  if (!Array.isArray(input.items) || !input.items.length) {
    throw new MarketplaceError('no_items', 'A return request must name at least one item.');
  }
  if (so.status !== 'delivered' && so.status !== 'return_requested') {
    throw new MarketplaceError(
      'not_delivered',
      `Goods that are ${so.status} have not been delivered. If they have not arrived, raise a dispute instead — ` +
      'a return of something the buyer never received is a different problem with a different remedy.'
    );
  }

  const policy = await effectiveReturnPolicy(db, so.sellerId);

  if (policy.nonReturnable) {
    throw new MarketplaceError(
      'non_returnable',
      `This seller lists these goods as non-returnable: ${policy.nonReturnableReason}. ` +
      'If the item is faulty or not as described, raise a dispute — a non-return policy does not cover that.'
    );
  }

  // Window check, ONLY where a window exists. No window means no expiry, which
  // is the honest reading of "nobody has published one".
  if (policy.windowDays != null && so.deliveredAt) {
    const elapsedDays = Math.floor((Date.now() - new Date(so.deliveredAt).getTime()) / 86_400_000);
    if (elapsedDays > policy.windowDays) {
      throw new MarketplaceError(
        'window_closed',
        `The return window of ${policy.windowDays} days (set by the ${policy.source.replace('_', ' ')}) ` +
        `closed ${elapsedDays - policy.windowDays} day(s) ago.`
      );
    }
  }

  const lines = await db.select().from(s.orderLines).where(and(
    eq(s.orderLines.sellerOrderId, so.id),
    inArray(s.orderLines.id, input.items.map((i) => i.orderLineId)),
  ));
  if (lines.length !== input.items.length) {
    throw new MarketplaceError('bad_items', 'One or more items are not on this order.');
  }

  const sla = await slaFor(db, so.sellerId);
  const ref = await allocateFederationId(db, 'RET');

  const [req] = await db.insert(s.returnRequests).values({
    ref,
    sellerOrderId: so.id,
    orderId: so.orderId,
    sellerId: so.sellerId,
    buyerPersonId: so.buyerPersonId ?? null,
    requestedByUserId: ctx.principal?.userId ?? null,
    reason: input.reason,
    reasonDetail: input.reasonDetail ?? null,
    evidence: input.evidence ?? null,
    remedySought: input.remedySought ?? 'refund',
    // FROZEN. What the policy said when the buyer asked.
    eligibilityAtRequest: policy as any,
    returnShippingPaidBy: policy.returnShippingPaidBy,
    respondBy: sla.returnResponseHours
      ? new Date(Date.now() + sla.returnResponseHours * 3_600_000)
      : null,
  }).returning({ id: s.returnRequests.id });

  for (const item of input.items) {
    const line = lines.find((l: any) => l.id === item.orderLineId)!;
    const qty = Number.isInteger(item.quantity) ? item.quantity : 0;
    if (qty < 1 || qty > line.quantity) {
      throw new MarketplaceError('bad_quantity', `Cannot return ${qty} of an item ${line.quantity} were bought of.`);
    }
    await db.insert(s.returnItems).values({
      returnRequestId: req.id,
      orderLineId: line.id,
      variantId: line.listingVariantId ?? null,
      requestedQty: qty,
      buyerStatedCondition: item.condition ?? null,
      // The value attributable to this item, frozen from the line so a later
      // repricing cannot change what a buyer is owed.
      refundableMinor: Math.round((line.totalPaise / line.quantity) * qty),
    });
  }

  if (so.status === 'delivered') {
    await db.update(s.sellerOrders)
      .set({ status: 'return_requested', updatedAt: new Date() })
      .where(eq(s.sellerOrders.id, so.id));
    await db.insert(s.sellerOrderEvents).values({
      sellerOrderId: so.id, fromStatus: 'delivered', toStatus: 'return_requested',
      byActor: 'buyer', byUserId: ctx.principal?.userId ?? null, note: input.reason,
    });
  }

  await writeAudit(db, ctx, {
    entityType: 'return_request', entityId: req.id, action: 'create',
    newValue: { ref, sellerOrderId: so.id, reason: input.reason },
  });

  return { returnRequestId: req.id, ref, policy };
}

/** The seller's decision on a return. */
export async function decideReturn(
  db: DB, ctx: AuditContext, returnRequestId: number,
  decision: { approve: boolean; reason: string; returnToLocationId?: number | null }
) {
  const seller = await ownSellerRecord(db, ctx.principal);
  const req = (await db.select().from(s.returnRequests).where(and(
    eq(s.returnRequests.id, returnRequestId),
    eq(s.returnRequests.sellerId, seller.id),     // THE ISOLATION FILTER, in SQL
  )).limit(1))[0];
  if (!req) throw new MarketplaceError('not_your_return', 'No such return on your seller account.');

  if (!String(decision?.reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'A return decision requires a reason the buyer can read.');
  }
  if (!['requested', 'seller_reviewing'].includes(req.status)) {
    throw new MarketplaceError('already_decided', `That return is already ${req.status}.`);
  }

  const now = new Date();
  if (!decision.approve) {
    await db.update(s.returnRequests).set({
      status: 'rejected', decisionReason: decision.reason,
      decidedByUserId: ctx.principal?.userId ?? null,
      sellerRespondedAt: now, updatedAt: now,
    }).where(eq(s.returnRequests.id, returnRequestId));

    await writeAudit(db, { ...ctx, reason: decision.reason }, {
      entityType: 'return_request', entityId: returnRequestId, action: 'reject',
      newValue: { status: 'rejected' },
    });
    return { returnRequestId, status: 'rejected' as const };
  }

  // An approved return gets an RMA. The buyer needs something to write on the
  // parcel, and the warehouse needs something to match it against.
  const rma = `${req.ref}-RMA`;
  await db.update(s.returnRequests).set({
    status: 'authorised',
    rmaNumber: rma,
    returnToLocationId: decision.returnToLocationId ?? null,
    decisionReason: decision.reason,
    decidedByUserId: ctx.principal?.userId ?? null,
    sellerRespondedAt: now,
    updatedAt: now,
  }).where(eq(s.returnRequests.id, returnRequestId));

  await writeAudit(db, { ...ctx, reason: decision.reason }, {
    entityType: 'return_request', entityId: returnRequestId, action: 'approve',
    newValue: { status: 'authorised', rma },
  });
  return { returnRequestId, status: 'authorised' as const, rmaNumber: rma };
}

/**
 * Goods arrived and were inspected.
 *
 * THE TWO QUANTITIES ARE THE POINT. Sellable units go back to stock; damaged
 * units go to the damaged bucket. What they do not account for is the
 * interesting remainder — an item received and neither restocked nor written
 * off is one somebody has to explain, and the arithmetic here refuses to let it
 * disappear.
 */
export async function inspectReturn(
  db: DB, ctx: AuditContext, returnRequestId: number,
  input: {
    locationId: number;
    items: {
      returnItemId: number;
      receivedQty: number;
      sellableQty: number;
      damagedQty: number;
      result: (typeof s.returnInspectionResult.enumValues)[number];
      notes?: string | null;
    }[];
  }
) {
  const seller = await ownSellerRecord(db, ctx.principal);
  const req = (await db.select().from(s.returnRequests).where(and(
    eq(s.returnRequests.id, returnRequestId),
    eq(s.returnRequests.sellerId, seller.id),
  )).limit(1))[0];
  if (!req) throw new MarketplaceError('not_your_return', 'No such return on your seller account.');
  if (!['authorised', 'in_transit', 'received'].includes(req.status)) {
    throw new MarketplaceError('bad_state', `A return that is ${req.status} cannot be inspected.`);
  }

  const now = new Date();
  let approvedRefund = 0;

  for (const it of input.items) {
    const row = (await db.select().from(s.returnItems).where(and(
      eq(s.returnItems.id, it.returnItemId),
      eq(s.returnItems.returnRequestId, returnRequestId),
    )).limit(1))[0];
    if (!row) throw new MarketplaceError('unknown_item', 'No such item on this return.');

    if (it.sellableQty + it.damagedQty > it.receivedQty) {
      throw new MarketplaceError(
        'bad_inspection',
        'Sellable plus damaged cannot exceed what was received. The arithmetic has to add up before ' +
        'anything is restocked or refunded.'
      );
    }
    if (it.receivedQty > row.requestedQty) {
      throw new MarketplaceError('bad_inspection', 'More items received than the buyer asked to return.');
    }

    // Refund only what was actually received and found acceptable. A return
    // that arrives as an empty box is received and refundable for nothing.
    const perUnit = row.refundableMinor != null && row.requestedQty > 0
      ? Math.round(row.refundableMinor / row.requestedQty) : 0;
    // 'not_the_item' and 'not_received' refund NOTHING: the buyer sent back
    // something else, or an empty box. 'rejected' is the inspector refusing the
    // return outright. Only goods that actually arrived and were recognisable
    // are refundable, and the distinction is why the enum has five outcomes
    // rather than a boolean.
    const refundable = it.result === 'sellable' || it.result === 'damaged'
      ? perUnit * it.receivedQty
      : 0;
    approvedRefund += refundable;

    await db.update(s.returnItems).set({
      receivedQty: it.receivedQty,
      restockedQty: it.sellableQty,
      damagedQty: it.damagedQty,
      inspectionResult: it.result,
      inspectionNotes: it.notes ?? null,
      inspectedByUserId: ctx.principal?.userId ?? null,
      inspectedAt: now,
      approvedRefundMinor: refundable,
    }).where(eq(s.returnItems.id, it.returnItemId));

    if (row.variantId && (it.sellableQty > 0 || it.damagedQty > 0)) {
      await restockReturn(db, ctx, {
        variantId: row.variantId,
        locationId: input.locationId,
        sellerId: seller.id,
        sellableQty: it.sellableQty,
        damagedQty: it.damagedQty,
        returnRequestId,
        reason: it.notes ?? `Return ${req.ref} inspected.`,
      });
    }

    // A counterfeit finding on a return is the strongest evidence there is:
    // the item is in the federation's hands. It opens a case rather than being
    // filed as a note nobody reads.
    if (it.result === 'counterfeit') {
      const { openAuthenticityCase } = await import('@/db/catalogue');
      const line = (await db.select().from(s.orderLines)
        .where(eq(s.orderLines.id, row.orderLineId)).limit(1))[0];
      try {
        await openAuthenticityCase(db, ctx, {
          sellerId: seller.id,
          listingId: line?.listingId ?? null,
          complainantKind: 'buyer',
          orderId: req.orderId,
          allegation: `Return ${req.ref} inspected as counterfeit: ${it.notes ?? 'no detail given'}`,
          quarantineListing: true,
        });
      } catch {
        // The seller inspecting their own return holds no `marketplace:review`,
        // so the case cannot be opened by them — which is correct. The finding
        // is on the return item either way, and the federation's own queue
        // picks it up from there.
      }
    }
  }

  await db.update(s.returnRequests).set({
    status: 'inspected', receivedAt: req.receivedAt ?? now, inspectedAt: now, updatedAt: now,
  }).where(eq(s.returnRequests.id, returnRequestId));

  return { returnRequestId, approvedRefundMinor: approvedRefund };
}

/**
 * Refund an inspected return.
 *
 * SEPARATE FROM THE INSPECTION, and requiring `marketplace:dispute` or the
 * seller's own hand, because money leaving is a different act from goods
 * arriving. The settlement line and the commission reversal are posted by
 * src/db/marketplace-finance.ts, which is the only place that touches a
 * seller's account.
 */
export async function refundReturn(
  db: DB, ctx: AuditContext, returnRequestId: number,
  input: { amountMinor?: number | null; fundedBy: 'seller' | 'platform'; reason: string }
) {
  const seller = await ownSellerRecord(db, ctx.principal).catch(() => null);
  const req = (await db.select().from(s.returnRequests)
    .where(eq(s.returnRequests.id, returnRequestId)).limit(1))[0];
  if (!req) throw new MarketplaceError('unknown_return', 'No such return.');

  if (!seller || seller.id !== req.sellerId) {
    // Not the seller — then it takes federation authority.
    assertCan(ctx.principal, 'marketplace:dispute', {});
  }
  if (!String(input?.reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'A refund requires a reason (§78).');
  }

  const items = await db.select().from(s.returnItems)
    .where(eq(s.returnItems.returnRequestId, returnRequestId));
  const assessed = items.reduce((n: number, i: any) => n + (i.approvedRefundMinor ?? 0), 0);

  const amount = Number.isInteger(input.amountMinor) ? input.amountMinor! : assessed;
  if (amount <= 0) throw new MarketplaceError('nothing_to_refund', 'Nothing was assessed as refundable on this return.');
  if (amount > assessed) {
    throw new MarketplaceError(
      'over_refund',
      `A refund of ${amount} exceeds the ${assessed} assessed at inspection. ` +
      'Raise an adjustment instead — an over-refund posted as a refund cannot be told from an error later.'
    );
  }

  await accrueRefund(db, {
    sellerOrderId: req.sellerOrderId,
    returnRequestId,
    amountMinor: amount,
    description: `Return ${req.ref}`,
    fundedBy: input.fundedBy,
  });

  await db.update(s.returnRequests).set({
    status: 'refunded', refundedMinor: amount, refundFundedBy: input.fundedBy,
    closedAt: new Date(), updatedAt: new Date(),
  }).where(eq(s.returnRequests.id, returnRequestId));

  const so = (await db.select().from(s.sellerOrders)
    .where(eq(s.sellerOrders.id, req.sellerOrderId)).limit(1))[0];
  await db.update(s.sellerOrders).set({ status: 'refunded', updatedAt: new Date() })
    .where(eq(s.sellerOrders.id, req.sellerOrderId));
  await db.insert(s.sellerOrderEvents).values({
    sellerOrderId: req.sellerOrderId, fromStatus: so.status, toStatus: 'refunded',
    byActor: seller ? 'seller' : 'federation', byUserId: ctx.principal?.userId ?? null,
    note: input.reason,
  });

  await writeAudit(db, { ...ctx, reason: input.reason }, {
    entityType: 'return_request', entityId: returnRequestId, action: 'update',
    newValue: { status: 'refunded', amountMinor: amount, fundedBy: input.fundedBy },
  });
  return { returnRequestId, refundedMinor: amount };
}

// ─── Disputes ───────────────────────────────────────────────────────────────

/**
 * A buyer raising a formal dispute.
 *
 * DISTINCT FROM A `buyer_report`, which is the lightweight "my parcel is late"
 * that a seller resolves in a day. Forcing every query through the dispute
 * machinery — with a clock, an adjudication and a penalty column — would make
 * the dispute queue useless within a month, and a useless queue is one nobody
 * reads.
 */
export async function raiseDispute(
  db: DB, ctx: AuditContext,
  input: {
    sellerOrderId: number;
    kind: (typeof s.marketplaceDisputeKind.enumValues)[number];
    summary: string;
    evidence?: Record<string, unknown> | null;
    returnRequestId?: number | null;
  }
) {
  const so = (await db.select().from(s.sellerOrders)
    .where(eq(s.sellerOrders.id, input.sellerOrderId)).limit(1))[0];
  if (!so) throw new MarketplaceError('unknown_seller_order', 'No such order.');
  await assertBuyerOf(db, ctx.principal, so);

  if (!String(input?.summary ?? '').trim()) {
    throw new MarketplaceError('summary_required', 'A dispute needs to say what went wrong.');
  }

  const sla = await slaFor(db, so.sellerId);
  const ref = await allocateFederationId(db, 'DSP');

  const [row] = await db.insert(s.marketplaceDisputes).values({
    ref,
    orderId: so.orderId,
    sellerOrderId: so.id,
    sellerId: so.sellerId,
    returnRequestId: input.returnRequestId ?? null,
    raisedByPersonId: so.buyerPersonId ?? null,
    raisedByUserId: ctx.principal?.userId ?? null,
    kind: input.kind,
    summary: input.summary,
    buyerEvidence: input.evidence ?? null,
    respondBy: sla.disputeResponseHours
      ? new Date(Date.now() + sla.disputeResponseHours * 3_600_000)
      : null,
  }).returning({ id: s.marketplaceDisputes.id });

  await db.update(s.sellerOrders).set({ status: 'disputed', updatedAt: new Date() })
    .where(eq(s.sellerOrders.id, so.id));
  await db.insert(s.sellerOrderEvents).values({
    sellerOrderId: so.id, fromStatus: so.status, toStatus: 'disputed',
    byActor: 'buyer', byUserId: ctx.principal?.userId ?? null, note: input.summary,
  });

  await writeAudit(db, ctx, {
    entityType: 'marketplace_dispute', entityId: row.id, action: 'create',
    newValue: { ref, sellerOrderId: so.id, kind: input.kind },
  });
  return { disputeId: row.id, ref, respondBy: sla.disputeResponseHours ? true : false };
}

/** The seller's answer, with their evidence. */
export async function respondToDispute(
  db: DB, ctx: AuditContext, disputeId: number,
  input: { response: string; evidence?: Record<string, unknown> | null }
) {
  const seller = await ownSellerRecord(db, ctx.principal);
  const d = (await db.select().from(s.marketplaceDisputes).where(and(
    eq(s.marketplaceDisputes.id, disputeId),
    eq(s.marketplaceDisputes.sellerId, seller.id),
  )).limit(1))[0];
  if (!d) throw new MarketplaceError('not_your_dispute', 'No such dispute on your seller account.');
  if (!String(input?.response ?? '').trim()) {
    throw new MarketplaceError('response_required', 'A response needs to say something.');
  }

  await db.update(s.marketplaceDisputes).set({
    status: 'under_review',
    sellerResponse: input.response,
    sellerEvidence: input.evidence ?? null,
    sellerRespondedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(s.marketplaceDisputes.id, disputeId));

  await db.insert(s.marketplaceDisputeMessages).values({
    disputeId, byUserId: ctx.principal?.userId ?? null, byActor: 'seller',
    body: input.response, attachments: input.evidence ?? null, visibleTo: 'all',
  });

  return { disputeId, status: 'under_review' as const };
}

/**
 * The federation's decision.
 *
 * A PENALTY IS NEVER COMPUTED HERE. `penaltyMinor` is whatever the deciding
 * officer enters and nothing more — what MMAKF charges a seller for a breach is
 * a federation decision with a contract behind it, and a penalty schedule this
 * file invented would be deducted from a real person's settlement.
 */
export async function decideDispute(
  db: DB, ctx: AuditContext, disputeId: number,
  decision: {
    outcome: 'buyer_upheld' | 'seller_upheld' | 'partial' | 'no_fault';
    reason: string;
    refundMinor?: number | null;
    refundFundedBy?: 'seller' | 'platform';
    penaltyMinor?: number | null;
    penaltyReason?: string | null;
  }
) {
  assertCan(ctx.principal, 'marketplace:dispute', {});
  const d = (await db.select().from(s.marketplaceDisputes)
    .where(eq(s.marketplaceDisputes.id, disputeId)).limit(1))[0];
  if (!d) throw new MarketplaceError('unknown_dispute', 'No such dispute.');
  if (!String(decision?.reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'A dispute decision requires a stated reason — both parties read it.');
  }
  if (d.status === 'resolved' || d.status === 'closed') {
    throw new MarketplaceError('already_decided', `That dispute is already ${d.status}.`);
  }
  if (decision.penaltyMinor != null && !String(decision.penaltyReason ?? '').trim()) {
    throw new MarketplaceError(
      'penalty_reason_required',
      'A penalty against a seller requires its own stated reason, separate from the outcome.'
    );
  }

  const now = new Date();
  await db.update(s.marketplaceDisputes).set({
    status: 'resolved',
    outcome: decision.outcome,
    decisionReason: decision.reason,
    decidedByUserId: ctx.principal?.userId ?? null,
    decidedAt: now,
    refundMinor: decision.refundMinor ?? null,
    penaltyMinor: decision.penaltyMinor ?? null,
    penaltyReason: decision.penaltyReason ?? null,
    closedAt: now,
    updatedAt: now,
  }).where(eq(s.marketplaceDisputes.id, disputeId));

  if (decision.refundMinor && decision.refundMinor > 0 && d.sellerOrderId) {
    await accrueRefund(db, {
      sellerOrderId: d.sellerOrderId,
      amountMinor: decision.refundMinor,
      description: `Dispute ${d.ref} — ${decision.outcome}`,
      fundedBy: decision.refundFundedBy ?? 'seller',
    });
  }

  if (decision.penaltyMinor && decision.penaltyMinor !== 0) {
    const { adjustPayable } = await import('@/db/marketplace-finance');
    await adjustPayable(db, ctx, {
      sellerId: d.sellerId,
      kind: 'penalty',
      amountMinor: -Math.abs(decision.penaltyMinor),
      reason: decision.penaltyReason!,
      disputeId,
    });
  }

  await writeAudit(db, { ...ctx, reason: decision.reason }, {
    entityType: 'marketplace_dispute', entityId: disputeId, action: 'approve',
    oldValue: { status: d.status },
    newValue: { status: 'resolved', outcome: decision.outcome, refundMinor: decision.refundMinor ?? null },
  });
  return { disputeId, outcome: decision.outcome };
}

/**
 * A lightweight buyer report. The first thing a buyer reaches for.
 *
 * Every report links to an order, a seller and — where the buyer says which —
 * a product, which is exactly what the brief requires. It can be escalated into
 * a dispute; it does not start as one.
 */
export async function reportProblem(
  db: DB, ctx: AuditContext,
  input: {
    sellerOrderId: number;
    orderLineId?: number | null;
    kind: string;
    detail: string;
    evidence?: Record<string, unknown> | null;
  }
) {
  const so = (await db.select().from(s.sellerOrders)
    .where(eq(s.sellerOrders.id, input.sellerOrderId)).limit(1))[0];
  if (!so) throw new MarketplaceError('unknown_seller_order', 'No such order.');
  await assertBuyerOf(db, ctx.principal, so);

  if (!String(input?.detail ?? '').trim()) {
    throw new MarketplaceError('detail_required', 'A report needs to say what happened.');
  }

  const line = input.orderLineId
    ? (await db.select().from(s.orderLines).where(and(
        eq(s.orderLines.id, input.orderLineId), eq(s.orderLines.sellerOrderId, so.id),
      )).limit(1))[0]
    : null;

  const ref = await allocateFederationId(db, 'RPT');
  const [row] = await db.insert(s.buyerReports).values({
    ref,
    orderId: so.orderId,
    sellerOrderId: so.id,
    sellerId: so.sellerId,
    orderLineId: line?.id ?? null,
    listingId: line?.listingId ?? null,
    reportedByPersonId: so.buyerPersonId ?? null,
    reportedByUserId: ctx.principal?.userId ?? null,
    kind: input.kind,
    detail: input.detail,
    evidence: input.evidence ?? null,
  }).returning({ id: s.buyerReports.id });

  return { reportId: row.id, ref };
}

// ─── Queues ─────────────────────────────────────────────────────────────────

export async function myReturns(db: DB, principal: Principal, limit = 100) {
  const seller = await ownSellerRecord(db, principal);
  return db.select().from(s.returnRequests)
    .where(eq(s.returnRequests.sellerId, seller.id))
    .orderBy(desc(s.returnRequests.requestedAt))
    .limit(Math.min(limit, 500));
}

export async function myDisputes(db: DB, principal: Principal, limit = 100) {
  const seller = await ownSellerRecord(db, principal);
  return db.select().from(s.marketplaceDisputes)
    .where(eq(s.marketplaceDisputes.sellerId, seller.id))
    .orderBy(desc(s.marketplaceDisputes.raisedAt))
    .limit(Math.min(limit, 500));
}

export async function disputeQueue(db: DB, principal: Principal, limit = 200) {
  assertCan(principal, 'marketplace:read', {});
  return db.select({
    dispute: s.marketplaceDisputes,
    sellerName: s.sellers.tradingName,
    sellerRef: s.sellers.ref,
    orderNo: s.orders.orderNo,
  }).from(s.marketplaceDisputes)
    .innerJoin(s.sellers, eq(s.marketplaceDisputes.sellerId, s.sellers.id))
    .innerJoin(s.orders, eq(s.marketplaceDisputes.orderId, s.orders.id))
    .where(inArray(s.marketplaceDisputes.status, ['open', 'seller_responding', 'under_review', 'escalated']))
    .orderBy(asc(s.marketplaceDisputes.respondBy), desc(s.marketplaceDisputes.raisedAt))
    .limit(Math.min(limit, 500));
}

// ─── The buyer check ────────────────────────────────────────────────────────

/**
 * Prove the caller is the buyer on this seller order.
 *
 * Matched on the PERSON behind the signed-in account, never on an id in a URL.
 * A federation officer with `marketplace:dispute` may act on a buyer's behalf,
 * which is what a support desk is for — and the audit records which of the two
 * it was.
 */
async function assertBuyerOf(db: DB, principal: Principal, sellerOrder: any) {
  if (principal?.userId == null) {
    throw new MarketplaceError('not_signed_in', 'Sign in to raise this.');
  }
  const user = (await db.select({ personId: s.users.personId }).from(s.users)
    .where(eq(s.users.id, principal.userId)).limit(1))[0];

  if (user?.personId != null && sellerOrder.buyerPersonId === user.personId) return;

  try {
    assertCan(principal, 'marketplace:dispute', {});
  } catch {
    throw new MarketplaceError('not_your_order', 'That order does not belong to this account.');
  }
}
