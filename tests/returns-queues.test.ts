// The reads that let a return be worked, and the isolation they keep.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THESE THREE FUNCTIONS HAD TO EXIST
// ═════════════════════════════════════════════════════════════════════════════
//
// inspectReturn() takes one row per RETURN ITEM — received, sellable, damaged
// and a finding for each. myReturns() returns the request rows and nothing
// else. So the seller portal could show that a return existed and could not
// draw the form that closes it: the inspection, the restock and the refund were
// reachable over HTTP and by no control a human could press. A return could be
// asked for and authorised, and the money stopped there.
//
// On the federation's side it was worse: nothing listed a return at all.
// There was no returnQueue(), so a return whose seller had gone quiet was
// invisible to the only party that could act — refundReturn() has always
// permitted `marketplace:dispute` to post a refund the seller has not.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS ASSERTED
// ═════════════════════════════════════════════════════════════════════════════
//
// The isolation, above all. myReturnItems() takes ids from a page, and a page's
// ids can be edited — so the authorisation must be the `seller_id = mine` in
// the join and not a filter applied afterwards. The test for that is: ask for
// another seller's return item by its real id and get nothing back.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { registerAccount } from '../src/db/onboarding';
import { applyToSell, approveSeller, createListing, submitListing, reviewListing } from '../src/db/marketplace';
import { addVariant, adoptProposedTaxonomy } from '../src/db/catalogue';
import { createLocation, receiveStock } from '../src/db/inventory';
import {
  checkout, onOrderPaid, acceptSellerOrder, markPacked, shipSellerOrder, markDelivered,
} from '../src/db/seller-orders';
import {
  setReturnPolicy, requestReturn, decideReturn, inspectReturn,
  myReturnItems, returnQueue, returnItemsForAdmin,
} from '../src/db/returns';
import {
  createCommissionRule, draftCommissionVersion, publishCommissionVersion,
} from '../src/db/marketplace-finance';
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
  const applied = await applyToSell(db, ctxOf(principal), { tradingName: `${tag} Supplies`, stateUnitId: JH });
  await approveSeller(db, ctxOf(national()), applied.sellerId, 'Checked.');
  const loc = await createLocation(db, ctxOf(principal), {
    code: `W${seq}`, name: 'Warehouse', acceptsReturns: true,
  });
  // Without a stated window every return is refused, which is correct and is
  // not what these tests are about.
  await setReturnPolicy(db, ctxOf(principal), { windowDays: 30 });
  return { principal, sellerId: applied.sellerId, locationId: loc.locationId };
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
  await reviewListing(db, ctxOf(national()), created.listingId, { decision: 'approve', reason: 'Fine.' });
  return { listingId: created.listingId, variantId: v.variantId };
}

async function commissionAt(rateBps: number) {
  const rule = await createCommissionRule(db, ctxOf(national()), {
    code: `rq.commission.${++seq}`, label: `Test ${rateBps}`,
  });
  const v = await draftCommissionVersion(db, ctxOf(national()), rule.ruleId, {
    rateBps, chargedOnShipping: false, chargedOnTax: false, effectiveFrom: '2020-01-01',
  });
  await publishCommissionVersion(db, ctxOf(national()), v.versionId, 'Resolution 2026/1');
}

/** A delivered order with an authorised return on it, ready to inspect. */
async function authorisedReturn(sc: any, b: any, variantId: number) {
  const order = await checkout(db, ctxOf(b.principal), {
    lines: [{ variantId, quantity: 2 }],
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
  const req = await requestReturn(db, ctxOf(b.principal), {
    sellerOrderId: soId,
    reason: 'Wrong size',
    items: [{ orderLineId: lines[0].id, quantity: 1 }],
  });
  await decideReturn(db, ctxOf(sc.principal), req.returnRequestId, {
    approve: true, reason: 'Send it back.', returnToLocationId: sc.locationId,
  });
  return { returnRequestId: req.returnRequestId, sellerOrderId: soId, lines };
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
describe('myReturnItems — the lines a seller needs in order to inspect', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('returns the item rows for the seller’s own return, keyed by request', async () => {
    const sc = await seller('own');
    const b = await buyer('own');
    const p = await product(sc, 'Own mitts', 80000, 5);
    const r = await authorisedReturn(sc, b, p.variantId);

    const map = await myReturnItems(db, sc.principal, [r.returnRequestId]);
    const items = map.get(r.returnRequestId) ?? [];
    expect(items.length).toBe(1);
    expect(items[0].requestedQty).toBe(1);
    // The frozen attributable amount, which is what the refund ceiling is built
    // from. Without it the seller portal cannot show what a refund would be.
    expect(items[0].refundableMinor).toBeGreaterThan(0);
  }, 240_000);

  it('ANOTHER SELLER’S RETURN YIELDS NOTHING, even asked for by its real id', async () => {
    // The assertion this function's join exists for. The ids come from a page,
    // and a page's ids can be edited; the isolation has to be in the SQL.
    const mine = await seller('mine');
    const theirs = await seller('theirs');
    const b = await buyer('cross');
    const p = await product(theirs, 'Their gi', 200000, 5);
    const r = await authorisedReturn(theirs, b, p.variantId);

    const map = await myReturnItems(db, mine.principal, [r.returnRequestId]);
    expect(map.get(r.returnRequestId)).toBeUndefined();
    expect(map.size).toBe(0);
  }, 240_000);

  it('an empty or nonsense id list reads nothing at all', async () => {
    const sc = await seller('nonsense');
    expect((await myReturnItems(db, sc.principal, [])).size).toBe(0);
    expect((await myReturnItems(db, sc.principal, [0, -1, 999999])).size).toBe(0);
  }, 240_000);

  it('a caller with no seller account is refused rather than shown everything', async () => {
    const b = await buyer('notaseller');
    await expect(myReturnItems(db, b.principal, [1])).rejects.toThrow();
  }, 240_000);
});

// ═════════════════════════════════════════════════════════════════════════════
describe('returnQueue — the federation’s view, and what it leaves out', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('lists a return in flight with its seller and its order named', async () => {
    const sc = await seller('queue');
    const b = await buyer('queue');
    const p = await product(sc, 'Queued belt', 30000, 5);
    const r = await authorisedReturn(sc, b, p.variantId);

    const rows = await returnQueue(db, national());
    const found = rows.find((x: any) => x.request.id === r.returnRequestId);
    expect(found, 'the return is in the queue').toBeTruthy();
    expect(found.sellerName).toContain('queue');
    expect(found.sellerOrderNo).toBeTruthy();
    expect(found.orderNo).toBeTruthy();
  }, 240_000);

  it('drops a return once it is closed — a queue that lists everything is a report', async () => {
    const sc = await seller('closed');
    const b = await buyer('closed');
    const p = await product(sc, 'Closing kote', 45000, 5);
    const r = await authorisedReturn(sc, b, p.variantId);

    expect((await returnQueue(db, national())).some((x: any) => x.request.id === r.returnRequestId)).toBe(true);

    // Inspecting moves it to `inspected`, which is still workable; refunding
    // closes it. The queue keeps the first and drops the second.
    const items = await returnItemsForAdmin(db, national(), [r.returnRequestId]);
    const line = (items.get(r.returnRequestId) ?? [])[0];
    await inspectReturn(db, ctxOf(sc.principal), r.returnRequestId, {
      locationId: sc.locationId,
      items: [{
        returnItemId: line.id, receivedQty: 1, sellableQty: 1, damagedQty: 0, result: 'sellable',
      }],
    });
    expect((await returnQueue(db, national())).some((x: any) => x.request.id === r.returnRequestId)).toBe(true);

    await db.update(s.returnRequests).set({ status: 'refunded' })
      .where(eq(s.returnRequests.id, r.returnRequestId));
    expect((await returnQueue(db, national())).some((x: any) => x.request.id === r.returnRequestId)).toBe(false);
  }, 240_000);

  it('a seller cannot read the federation’s queue', async () => {
    const sc = await seller('noqueue');
    await expect(returnQueue(db, sc.principal)).rejects.toThrow();
    await expect(returnItemsForAdmin(db, sc.principal, [1])).rejects.toThrow();
  }, 240_000);

  it('a buyer cannot read it either', async () => {
    const b = await buyer('noqueue');
    await expect(returnQueue(db, b.principal)).rejects.toThrow();
  }, 240_000);
});
