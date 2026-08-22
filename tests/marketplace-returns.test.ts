// Returns, refunds, disputes and reviews.
//
// The module the first pass shipped without a test file. What is asserted here
// is what the code refuses, because the refusals are the whole design:
//
//   · a return window is the MORE GENEROUS of the seller's and MMAKF's, and
//     neither is invented when unset;
//   · what a policy said WHEN THE BUYER ASKED is frozen, so the seller cannot
//     shorten it retroactively;
//   · the inspection arithmetic must add up before anything is restocked;
//   · a refund cannot exceed what inspection assessed;
//   · refunding gives back the commission taken on the refunded goods;
//   · a review requires a purchase, and one purchase cannot be reviewed twice.
//
// Against a real Postgres (PGlite) with every migration applied.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { registerAccount } from '../src/db/onboarding';
import {
  applyToSell, approveSeller, createListing, submitListing, reviewListing,
} from '../src/db/marketplace';
import { addVariant, adoptProposedTaxonomy } from '../src/db/catalogue';
import { createLocation, receiveStock } from '../src/db/inventory';
import {
  checkout, onOrderPaid, acceptSellerOrder, markPacked, shipSellerOrder, markDelivered,
} from '../src/db/seller-orders';
import {
  createCommissionRule, draftCommissionVersion, publishCommissionVersion, myAccount,
} from '../src/db/marketplace-finance';
import {
  effectiveReturnPolicy, setReturnPolicy, requestReturn, decideReturn,
  inspectReturn, refundReturn, raiseDispute, respondToDispute, decideDispute,
  reportProblem, RETURN_FLOOR_NOT_SET, RETURN_POLICY_NOT_SET,
} from '../src/db/returns';
import {
  leaveProductReview, leaveSellerReview, moderateReview, refreshSellerRating,
  computeSellerPerformance, PERFORMANCE_NOT_COMPUTED, MIN_ORDERS_FOR_SCORE,
} from '../src/db/marketplace-trust';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any, pg: PGlite;
let JH: number, ADMIN: number;
const PW = 'a-perfectly-ordinary-passphrase';

const national = (): Principal => ({
  userId: ADMIN, label: 'admin@mmakf.in',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
});
const ctxOf = (p: Principal): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

let seq = 0;

/** A buyer with a person record, so the ownership checks have something to match. */
async function buyer(tag: string) {
  const r = await registerAccount(db, { email: `${tag}-${++seq}@example.in`, password: PW });
  const [person] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(++seq).padStart(6, '0')}`,
    fullName: `${tag} Buyer`, status: 'active',
  }).returning();
  await db.update(s.users).set({ personId: person.id }).where(eq(s.users.id, r.userId));
  return {
    userId: r.userId, personId: person.id,
    principal: { userId: r.userId, label: r.email, bindings: [] } as Principal,
  };
}

async function seller(tag: string) {
  const r = await registerAccount(db, { email: `${tag}-${++seq}@example.in`, password: PW });
  const principal = { userId: r.userId, label: r.email, bindings: [] } as Principal;
  const applied = await applyToSell(db, ctxOf(principal), {
    tradingName: `${tag} Supplies`, stateUnitId: JH,
  });
  await approveSeller(db, ctxOf(national()), applied.sellerId, 'Checked at the state office.');
  const loc = await createLocation(db, ctxOf(principal), { code: 'W1', name: 'Warehouse', acceptsReturns: true });
  return { ...r, principal, sellerId: applied.sellerId, locationId: loc.locationId };
}

async function product(sc: any, title: string, priceMinor: number, stock: number) {
  const created = await createListing(db, ctxOf(sc.principal), {
    title, category: 'equipment', priceMinor,
    media: [{ url: `https://cdn.example.in/${encodeURIComponent(title)}.jpg`, alt: title }],
  });
  const v = await addVariant(db, ctxOf(sc.principal), created.listingId, { label: 'Standard', priceMinor });
  await receiveStock(db, ctxOf(sc.principal), {
    variantId: v.variantId, locationId: sc.locationId, qty: stock, reason: 'Opening stock',
  });
  await submitListing(db, ctxOf(sc.principal), created.listingId);
  await reviewListing(db, ctxOf(national()), created.listingId, {
    decision: 'approve', reason: 'Correctly described.',
  });
  return { listingId: created.listingId, variantId: v.variantId };
}

async function commissionAt(rateBps: number, over: Record<string, unknown> = {}) {
  const rule = await createCommissionRule(db, ctxOf(national()), {
    code: `ret.commission.${++seq}`, label: `Test ${rateBps}`, ...over,
  });
  const v = await draftCommissionVersion(db, ctxOf(national()), rule.ruleId, {
    rateBps, chargedOnShipping: false, chargedOnTax: false, effectiveFrom: '2020-01-01',
  });
  await publishCommissionVersion(db, ctxOf(national()), v.versionId, 'Resolution 2026/1');
}

/** A delivered order: the state every return and review starts from. */
async function delivered(sc: any, b: any, variantId: number, qty = 1) {
  const order = await checkout(db, ctxOf(b.principal), {
    lines: [{ variantId, quantity: qty }],
    personId: b.personId, email: 'buyer@example.in', buyerName: 'A Buyer',
    shipTo: { line1: '1 Road', city: 'Ranchi', state: 'Jharkhand', postcode: '834001' },
  });
  const soId = order.sellerOrders[0].sellerOrderId;
  await onOrderPaid(db, order.orderId, null);
  await acceptSellerOrder(db, ctxOf(sc.principal), soId);
  await markPacked(db, ctxOf(sc.principal), soId);
  await shipSellerOrder(db, ctxOf(sc.principal), soId, { carrier: 'India Post' });
  await markDelivered(db, ctxOf(sc.principal), soId);
  const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.sellerOrderId, soId));
  return { orderId: order.orderId, sellerOrderId: soId, lines };
}

beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
  db = drizzle(pg, { schema: s });

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' }).returning();
  JH = jh.id;
  ADMIN = (await registerAccount(db, { email: 'admin@mmakf.in', password: PW })).userId;
  await adoptProposedTaxonomy(db, ctxOf(national()));
  await commissionAt(1000);
}, 180_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('RETURN POLICY — two policies, one answer', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('invents nothing when neither the seller nor MMAKF has published a window', async () => {
    const sc = await seller('nopolicy');
    const p = await effectiveReturnPolicy(db, sc.sellerId);
    expect(p.windowDays).toBeNull();
    expect(p.source).toBe('none');
    expect(p.notes).toContain(RETURN_FLOOR_NOT_SET);
    expect(p.notes).toContain(RETURN_POLICY_NOT_SET);
  });

  it('takes the SELLER’s window when it is more generous than the floor', async () => {
    const sc = await seller('generous');
    await setReturnPolicy(db, ctxOf(national()), { windowDays: 7, marketplaceFloor: true });
    await setReturnPolicy(db, ctxOf(sc.principal), { windowDays: 14 });

    const p = await effectiveReturnPolicy(db, sc.sellerId);
    expect(p.windowDays).toBe(14);
    expect(p.source).toBe('seller');
  });

  it('takes the FLOOR when the seller offers less', async () => {
    const sc = await seller('stingy');
    await setReturnPolicy(db, ctxOf(sc.principal), { windowDays: 3 });

    const p = await effectiveReturnPolicy(db, sc.sellerId);
    // The floor of 7 was published by the test above and is marketplace-wide.
    expect(p.windowDays).toBe(7);
    expect(p.source).toBe('marketplace_floor');
  });

  it('refuses to mark goods non-returnable without saying why', async () => {
    const sc = await seller('unexplained');
    await expect(setReturnPolicy(db, ctxOf(sc.principal), {
      nonReturnable: true, nonReturnableReason: '   ',
    })).rejects.toMatchObject({ code: 'reason_required' });
  });

  it('a seller cannot set the marketplace floor', async () => {
    const sc = await seller('overreach');
    await expect(setReturnPolicy(db, ctxOf(sc.principal), {
      windowDays: 999, marketplaceFloor: true,
    })).rejects.toThrow(/permission|denied|forbidden|not permitted/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('THE RETURN ENGINE', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('freezes what the policy said when the buyer asked', async () => {
    const sc = await seller('freezer');
    const b = await buyer('freezer-buyer');
    await setReturnPolicy(db, ctxOf(sc.principal), { windowDays: 30 });
    const p = await product(sc, 'Frozen policy gi', 100_000, 3);
    const d = await delivered(sc, b, p.variantId);

    const req = await requestReturn(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId,
      reason: 'Too small',
      items: [{ orderLineId: d.lines[0].id, quantity: 1 }],
    });
    expect(req.policy.windowDays).toBe(30);

    // The seller shortens their window AFTER the request.
    await setReturnPolicy(db, ctxOf(sc.principal), { windowDays: 1 });

    const stored = (await db.select().from(s.returnRequests)
      .where(eq(s.returnRequests.id, req.returnRequestId)))[0];
    // Monday's request is still judged against Monday's policy.
    expect((stored.eligibilityAtRequest as any).windowDays).toBe(30);
  });

  it('refuses a return of goods that have not been delivered, and says what to do instead', async () => {
    const sc = await seller('undelivered');
    const b = await buyer('undelivered-buyer');
    const p = await product(sc, 'Still in transit', 50_000, 2);

    const order = await checkout(db, ctxOf(b.principal), {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: b.personId, email: 'x@example.in',
    });
    await onOrderPaid(db, order.orderId, null);

    await expect(requestReturn(db, ctxOf(b.principal), {
      sellerOrderId: order.sellerOrders[0].sellerOrderId,
      reason: 'Never arrived',
      items: [{ orderLineId: 1, quantity: 1 }],
    })).rejects.toMatchObject({ code: 'not_delivered' });
  });

  it('a buyer cannot return somebody else’s order', async () => {
    const sc = await seller('victim-seller');
    const b1 = await buyer('real-buyer');
    const b2 = await buyer('other-buyer');
    const p = await product(sc, 'Not yours', 50_000, 3);
    const d = await delivered(sc, b1, p.variantId);

    await expect(requestReturn(db, ctxOf(b2.principal), {
      sellerOrderId: d.sellerOrderId, reason: 'Mine now',
      items: [{ orderLineId: d.lines[0].id, quantity: 1 }],
    })).rejects.toMatchObject({ code: 'not_your_order' });
  });

  it('a seller cannot decide another seller’s return', async () => {
    const sc = await seller('owner');
    const other = await seller('interloper');
    const b = await buyer('return-buyer');
    const p = await product(sc, 'Contested', 50_000, 3);
    const d = await delivered(sc, b, p.variantId);
    const req = await requestReturn(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId, reason: 'Wrong size',
      items: [{ orderLineId: d.lines[0].id, quantity: 1 }],
    });

    await expect(decideReturn(db, ctxOf(other.principal), req.returnRequestId, {
      approve: true, reason: 'I will take this one',
    })).rejects.toMatchObject({ code: 'not_your_return' });
  });

  it('the inspection arithmetic must add up before anything is restocked', async () => {
    const sc = await seller('arithmetic');
    const b = await buyer('arithmetic-buyer');
    const p = await product(sc, 'Countable', 50_000, 5);
    const d = await delivered(sc, b, p.variantId, 2);
    const req = await requestReturn(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId, reason: 'Both wrong',
      items: [{ orderLineId: d.lines[0].id, quantity: 2 }],
    });
    await decideReturn(db, ctxOf(sc.principal), req.returnRequestId, {
      approve: true, reason: 'Send them back.',
    });
    const items = await db.select().from(s.returnItems)
      .where(eq(s.returnItems.returnRequestId, req.returnRequestId));

    await expect(inspectReturn(db, ctxOf(sc.principal), req.returnRequestId, {
      locationId: sc.locationId,
      items: [{
        returnItemId: items[0].id, receivedQty: 2, sellableQty: 2, damagedQty: 1,
        result: 'sellable',
      }],
    })).rejects.toMatchObject({ code: 'bad_inspection' });
  });

  it('restocks sellable units and moves damaged ones to the damaged bucket', async () => {
    const sc = await seller('inspector');
    const b = await buyer('inspector-buyer');
    const p = await product(sc, 'Two back', 50_000, 5);
    const d = await delivered(sc, b, p.variantId, 2);

    let stock = (await db.select().from(s.stockItems).where(eq(s.stockItems.variantId, p.variantId)))[0];
    expect(stock.onHand).toBe(3);          // 5 − 2 dispatched

    const req = await requestReturn(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId, reason: 'One is torn',
      items: [{ orderLineId: d.lines[0].id, quantity: 2 }],
    });
    await decideReturn(db, ctxOf(sc.principal), req.returnRequestId, { approve: true, reason: 'Send them.' });
    const items = await db.select().from(s.returnItems)
      .where(eq(s.returnItems.returnRequestId, req.returnRequestId));

    await inspectReturn(db, ctxOf(sc.principal), req.returnRequestId, {
      locationId: sc.locationId,
      items: [{
        returnItemId: items[0].id, receivedQty: 2, sellableQty: 1, damagedQty: 1,
        result: 'damaged', notes: 'One torn at the seam.',
      }],
    });

    stock = (await db.select().from(s.stockItems).where(eq(s.stockItems.variantId, p.variantId)))[0];
    expect(stock.onHand).toBe(5);          // both came back
    expect(stock.damaged).toBe(1);         // one is present and unsellable

    // Available is DERIVED and excludes the damaged one.
    const variant = (await db.select().from(s.listingVariants)
      .where(eq(s.listingVariants.id, p.variantId)))[0];
    expect(variant.availableQty).toBe(4);
  });

  it('an empty box is received and refundable for nothing', async () => {
    const sc = await seller('emptybox');
    const b = await buyer('emptybox-buyer');
    const p = await product(sc, 'Nothing inside', 90_000, 3);
    const d = await delivered(sc, b, p.variantId);
    const req = await requestReturn(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId, reason: 'Changed my mind',
      items: [{ orderLineId: d.lines[0].id, quantity: 1 }],
    });
    await decideReturn(db, ctxOf(sc.principal), req.returnRequestId, { approve: true, reason: 'Send it.' });
    const items = await db.select().from(s.returnItems)
      .where(eq(s.returnItems.returnRequestId, req.returnRequestId));

    const result = await inspectReturn(db, ctxOf(sc.principal), req.returnRequestId, {
      locationId: sc.locationId,
      items: [{
        returnItemId: items[0].id, receivedQty: 1, sellableQty: 0, damagedQty: 0,
        result: 'not_the_item', notes: 'The box held a towel.',
      }],
    });
    expect(result.approvedRefundMinor).toBe(0);

    await expect(refundReturn(db, ctxOf(sc.principal), req.returnRequestId, {
      fundedBy: 'seller', reason: 'Goodwill',
    })).rejects.toMatchObject({ code: 'nothing_to_refund' });
  });

  it('a refund cannot exceed what inspection assessed', async () => {
    const sc = await seller('overrefund');
    const b = await buyer('overrefund-buyer');
    const p = await product(sc, 'Assessed', 100_000, 3);
    const d = await delivered(sc, b, p.variantId);
    const req = await requestReturn(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId, reason: 'Faulty',
      items: [{ orderLineId: d.lines[0].id, quantity: 1 }],
    });
    await decideReturn(db, ctxOf(sc.principal), req.returnRequestId, { approve: true, reason: 'Send it.' });
    const items = await db.select().from(s.returnItems)
      .where(eq(s.returnItems.returnRequestId, req.returnRequestId));
    await inspectReturn(db, ctxOf(sc.principal), req.returnRequestId, {
      locationId: sc.locationId,
      items: [{ returnItemId: items[0].id, receivedQty: 1, sellableQty: 1, damagedQty: 0, result: 'sellable' }],
    });

    await expect(refundReturn(db, ctxOf(sc.principal), req.returnRequestId, {
      amountMinor: 500_000, fundedBy: 'seller', reason: 'Generous',
    })).rejects.toMatchObject({ code: 'over_refund' });
  });

  it('refunding returns the commission taken on the refunded goods', async () => {
    const sc = await seller('reverser');
    const b = await buyer('reverser-buyer');
    const p = await product(sc, 'Commission back', 100_000, 3);
    const d = await delivered(sc, b, p.variantId);

    const req = await requestReturn(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId, reason: 'Not as described',
      items: [{ orderLineId: d.lines[0].id, quantity: 1 }],
    });
    await decideReturn(db, ctxOf(sc.principal), req.returnRequestId, { approve: true, reason: 'Send it.' });
    const items = await db.select().from(s.returnItems)
      .where(eq(s.returnItems.returnRequestId, req.returnRequestId));
    await inspectReturn(db, ctxOf(sc.principal), req.returnRequestId, {
      locationId: sc.locationId,
      items: [{ returnItemId: items[0].id, receivedQty: 1, sellableQty: 1, damagedQty: 0, result: 'sellable' }],
    });
    await refundReturn(db, ctxOf(sc.principal), req.returnRequestId, {
      fundedBy: 'seller', reason: 'Return accepted.',
    });

    const lines = await db.select().from(s.settlementLines)
      .where(eq(s.settlementLines.sellerOrderId, d.sellerOrderId));

    const refund = lines.find((l: any) => l.kind === 'refund');
    const reversal = lines.find((l: any) => l.kind === 'refund_commission_reversal');
    expect(refund!.amountMinor).toBe(-100_000);
    // 10% of ₹1,000, given back. Positive: the sign is the meaning.
    expect(reversal!.amountMinor).toBe(10_000);
  });

  it('a PLATFORM-funded refund costs the seller nothing', async () => {
    const sc = await seller('platformfunded');
    const b = await buyer('platformfunded-buyer');
    const p = await product(sc, 'MMAKF pays', 80_000, 3);
    const d = await delivered(sc, b, p.variantId);
    const req = await requestReturn(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId, reason: 'Damaged in transit',
      items: [{ orderLineId: d.lines[0].id, quantity: 1 }],
    });
    await decideReturn(db, ctxOf(sc.principal), req.returnRequestId, { approve: true, reason: 'Send it.' });
    const items = await db.select().from(s.returnItems)
      .where(eq(s.returnItems.returnRequestId, req.returnRequestId));
    await inspectReturn(db, ctxOf(sc.principal), req.returnRequestId, {
      locationId: sc.locationId,
      items: [{ returnItemId: items[0].id, receivedQty: 1, sellableQty: 0, damagedQty: 1, result: 'damaged' }],
    });
    await refundReturn(db, ctxOf(sc.principal), req.returnRequestId, {
      fundedBy: 'platform', reason: 'Carrier damage — MMAKF absorbs it.',
    });

    const lines = await db.select().from(s.settlementLines)
      .where(and(
        eq(s.settlementLines.sellerOrderId, d.sellerOrderId),
        eq(s.settlementLines.kind, 'refund'),
      ));
    // No deduction on the seller's statement for a cost they did not incur.
    expect(lines).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('DISPUTES', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('a buyer raises, the seller answers, the federation decides', async () => {
    const sc = await seller('disputed');
    const b = await buyer('disputed-buyer');
    const p = await product(sc, 'Contested item', 120_000, 3);
    const d = await delivered(sc, b, p.variantId);

    const dispute = await raiseDispute(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId,
      kind: 'not_as_described',
      summary: 'The gi is a different weight from the listing.',
    });

    let so = (await db.select().from(s.sellerOrders).where(eq(s.sellerOrders.id, d.sellerOrderId)))[0];
    expect(so.status).toBe('disputed');

    await respondToDispute(db, ctxOf(sc.principal), dispute.disputeId, {
      response: 'The listing states 12oz and 12oz was sent.',
    });

    await decideDispute(db, ctxOf(national()), dispute.disputeId, {
      outcome: 'partial',
      reason: 'The photographs were ambiguous. Half refunded; no fault found against the seller.',
      refundMinor: 60_000,
      refundFundedBy: 'seller',
    });

    const row = (await db.select().from(s.marketplaceDisputes)
      .where(eq(s.marketplaceDisputes.id, dispute.disputeId)))[0];
    expect(row.status).toBe('resolved');
    expect(row.outcome).toBe('partial');
    expect(row.penaltyMinor).toBeNull();      // nothing computed one
  });

  it('a penalty requires its own reason, separate from the outcome', async () => {
    const sc = await seller('penalised');
    const b = await buyer('penalised-buyer');
    const p = await product(sc, 'Penalty item', 50_000, 3);
    const d = await delivered(sc, b, p.variantId);
    const dispute = await raiseDispute(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId, kind: 'counterfeit', summary: 'This is not the brand advertised.',
    });

    await expect(decideDispute(db, ctxOf(national()), dispute.disputeId, {
      outcome: 'buyer_upheld', reason: 'Upheld on the photographs.',
      penaltyMinor: 500_000,
    })).rejects.toMatchObject({ code: 'penalty_reason_required' });
  });

  it('a seller cannot decide a dispute against themselves', async () => {
    const sc = await seller('selfjudge');
    const b = await buyer('selfjudge-buyer');
    const p = await product(sc, 'Self-judged', 50_000, 3);
    const d = await delivered(sc, b, p.variantId);
    const dispute = await raiseDispute(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId, kind: 'damaged_on_arrival', summary: 'Arrived broken.',
    });

    await expect(decideDispute(db, ctxOf(sc.principal), dispute.disputeId, {
      outcome: 'seller_upheld', reason: 'I find in my own favour.',
    })).rejects.toThrow(/permission|denied|forbidden|not permitted/i);
  });

  it('a buyer report links an order, a seller and a product without becoming a case', async () => {
    const sc = await seller('reporter');
    const b = await buyer('reporter-buyer');
    const p = await product(sc, 'Reported', 40_000, 3);
    const d = await delivered(sc, b, p.variantId);

    const r = await reportProblem(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId,
      orderLineId: d.lines[0].id,
      kind: 'damaged_product',
      detail: 'A seam is loose but I would rather keep it.',
    });

    const row = (await db.select().from(s.buyerReports).where(eq(s.buyerReports.id, r.reportId)))[0];
    expect(row.sellerId).toBe(sc.sellerId);
    expect(row.listingId).toBe(p.listingId);
    expect(row.status).toBe('open');
    // Not a dispute. No clock, no adjudication.
    expect(row.escalatedToDisputeId).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('REVIEWS — a purchase, or nothing', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('a buyer can review what they bought, and it starts unpublished', async () => {
    const sc = await seller('reviewed');
    const b = await buyer('reviewer');
    const p = await product(sc, 'Reviewable gi', 100_000, 3);
    const d = await delivered(sc, b, p.variantId);

    const r = await leaveProductReview(db, ctxOf(b.principal), {
      orderLineId: d.lines[0].id, rating: 5, title: 'Good', body: 'Well made.',
    });
    expect(r.status).toBe('pending');

    // NOT visible until moderated.
    const published = await db.select().from(s.productReviews).where(and(
      eq(s.productReviews.listingId, p.listingId),
      eq(s.productReviews.status, 'published'),
    ));
    expect(published).toHaveLength(0);

    await moderateReview(db, ctxOf(national()), {
      kind: 'product', reviewId: r.reviewId, status: 'published',
    });
    const after = (await db.select().from(s.productReviews)
      .where(eq(s.productReviews.id, r.reviewId)))[0];
    expect(after.status).toBe('published');
  });

  it('somebody who did not buy it cannot review it', async () => {
    const sc = await seller('unbought');
    const b1 = await buyer('actual-buyer');
    const b2 = await buyer('bystander');
    const p = await product(sc, 'Only for buyers', 60_000, 3);
    const d = await delivered(sc, b1, p.variantId);

    await expect(leaveProductReview(db, ctxOf(b2.principal), {
      orderLineId: d.lines[0].id, rating: 1, body: 'Never used it.',
    })).rejects.toMatchObject({ code: 'not_your_purchase' });
  });

  it('one purchase cannot be reviewed twice', async () => {
    const sc = await seller('once');
    const b = await buyer('once-buyer');
    const p = await product(sc, 'Reviewed once', 60_000, 3);
    const d = await delivered(sc, b, p.variantId);

    await leaveProductReview(db, ctxOf(b.principal), { orderLineId: d.lines[0].id, rating: 5 });
    await expect(leaveProductReview(db, ctxOf(b.principal), {
      orderLineId: d.lines[0].id, rating: 1,
    })).rejects.toMatchObject({ code: 'already_reviewed' });
  });

  it('a rating outside 1..5 is refused', async () => {
    const sc = await seller('ratings');
    const b = await buyer('ratings-buyer');
    const p = await product(sc, 'Rated', 60_000, 3);
    const d = await delivered(sc, b, p.variantId);

    await expect(leaveProductReview(db, ctxOf(b.principal), {
      orderLineId: d.lines[0].id, rating: 11,
    })).rejects.toMatchObject({ code: 'bad_rating' });
  });

  it('only PUBLISHED seller reviews move the public average', async () => {
    const sc = await seller('averaged');
    const b = await buyer('averaged-buyer');
    const p = await product(sc, 'Averaged', 60_000, 5);
    const d = await delivered(sc, b, p.variantId);

    await leaveSellerReview(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId, ratingOverall: 1, body: 'Slow.',
    });
    await refreshSellerRating(db, sc.sellerId);

    let seller1 = (await db.select().from(s.sellers).where(eq(s.sellers.id, sc.sellerId)))[0];
    // Pending: it must not drag the average down before anybody has read it.
    expect(seller1.ratingCount).toBe(0);
    expect(seller1.ratingAvgBps).toBeNull();

    const rev = (await db.select().from(s.sellerReviews)
      .where(eq(s.sellerReviews.sellerId, sc.sellerId)))[0];
    await moderateReview(db, ctxOf(national()), {
      kind: 'seller', reviewId: rev.id, status: 'published',
    });

    seller1 = (await db.select().from(s.sellers).where(eq(s.sellers.id, sc.sellerId)))[0];
    expect(seller1.ratingCount).toBe(1);
    expect(seller1.ratingAvgBps).toBe(10_000);   // 1.00 star
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('PERFORMANCE — measured, never enforced', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('produces NO score below the minimum order count, and says so', async () => {
    const sc = await seller('tooquiet');
    const b = await buyer('tooquiet-buyer');
    const p = await product(sc, 'One sale', 50_000, 5);
    await delivered(sc, b, p.variantId);

    const today = new Date().toISOString().slice(0, 10);
    const result = await computeSellerPerformance(db, ctxOf(national()), {
      sellerId: sc.sellerId, periodStart: '2020-01-01', periodEnd: today,
    });

    expect(result.ordersCount).toBeLessThan(MIN_ORDERS_FOR_SCORE);
    // NULL, not zero, and not a flattering number either.
    expect(result.scoreBps).toBeNull();
    expect(result.band).toBeNull();
    expect(result.note).toBe(PERFORMANCE_NOT_COMPUTED);
  });

  it('records the counts even when it will not score them', async () => {
    const sc = await seller('counted');
    const b = await buyer('counted-buyer');
    const p = await product(sc, 'Counted sale', 50_000, 5);
    await delivered(sc, b, p.variantId);

    const today = new Date().toISOString().slice(0, 10);
    await computeSellerPerformance(db, ctxOf(national()), {
      sellerId: sc.sellerId, periodStart: '2020-01-01', periodEnd: today,
    });

    const snap = (await db.select().from(s.sellerPerformanceSnapshots)
      .where(eq(s.sellerPerformanceSnapshots.sellerId, sc.sellerId)))[0];
    expect(snap.ordersCount).toBe(1);
    expect(snap.deliveredCount).toBe(1);
    expect(snap.acceptedCount).toBe(1);
    // The working is frozen with it, so an old snapshot can be read against the
    // rule it was computed under.
    expect((snap.workings as any).minOrdersForScore).toBe(MIN_ORDERS_FOR_SCORE);
  });

  it('computing performance changes nothing about the seller’s standing', async () => {
    const sc = await seller('unpunished');
    const b = await buyer('unpunished-buyer');
    const p = await product(sc, 'Bad seller item', 50_000, 5);
    const d = await delivered(sc, b, p.variantId);

    // A dispute upheld against them.
    const dispute = await raiseDispute(db, ctxOf(b.principal), {
      sellerOrderId: d.sellerOrderId, kind: 'not_as_described', summary: 'Wrong item entirely.',
    });
    await decideDispute(db, ctxOf(national()), dispute.disputeId, {
      outcome: 'buyer_upheld', reason: 'Upheld.',
    });

    const before = (await db.select().from(s.sellers).where(eq(s.sellers.id, sc.sellerId)))[0];
    await computeSellerPerformance(db, ctxOf(national()), {
      sellerId: sc.sellerId, periodStart: '2020-01-01', periodEnd: new Date().toISOString().slice(0, 10),
    });
    const after = (await db.select().from(s.sellers).where(eq(s.sellers.id, sc.sellerId)))[0];

    // The band may be written; the STANDING may not.
    expect(after.status).toBe(before.status);
    expect(after.storeStatus).toBe(before.storeStatus);
    expect(after.restrictedAt).toBe(before.restrictedAt);
  });
});
