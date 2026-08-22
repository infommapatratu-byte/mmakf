// Shipping zones, methods, and the carriage a buyer is actually charged.
//
// THE DEFECT THIS SUITE EXISTS TO STOP COMING BACK: `shipping_zones` and
// `shipping_methods` were created by migration 0029 and nothing could write
// them, so every seller matched no zone, was quoted ZERO carriage, and paid for
// every delivery out of their own margin. Nothing errored and no test failed.
//
// So what is asserted here is mostly the arithmetic and the boundaries:
//
//   · the quote a seller previews is the CHARGE a buyer pays — literally the
//     same function, proved by pricing a real checkout against it;
//   · a seller with no zone is still quoted zero (unchanged, deliberate) and
//     `carriageExposure()` now SAYS SO;
//   · a seller WITH zones that miss the address refuses the sale;
//   · the by-weight rate goes through BigInt arithmetic identical to
//     fees.applyFactor(), proved differentially rather than asserted.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { registerAccount } from '../src/db/onboarding';
import { applyToSell, approveSeller, createListing, submitListing, reviewListing } from '../src/db/marketplace';
import { addVariant, adoptProposedTaxonomy } from '../src/db/catalogue';
import { createLocation, receiveStock } from '../src/db/inventory';
import { checkout } from '../src/db/seller-orders';
import {
  createCommissionRule, draftCommissionVersion, publishCommissionVersion,
} from '../src/db/marketplace-finance';
import {
  createZone, createMethod, deactivateZone, deactivateMethod, myZones,
  quoteCarriage, previewCarriage, carriageExposure, matchZone, priceMethod,
  CARRIAGE_ABSORBED, UNZONED_SELLER_POLICY_NOT_SET,
} from '../src/db/shipping';
import { applyFactor } from '../src/db/fees';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any, pg: PGlite;
let JH: number, BR: number, ADMIN: number;
const PW = 'a-perfectly-ordinary-passphrase';

const national = (): Principal => ({
  userId: ADMIN, label: 'admin@mmakf.in',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
});
const ctxOf = (p: Principal): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

let seq = 0;

async function seller(tag: string) {
  const r = await registerAccount(db, { email: `${tag}-${++seq}@example.in`, password: PW });
  const principal = { userId: r.userId, label: r.email, bindings: [] } as Principal;
  const applied = await applyToSell(db, ctxOf(principal), { tradingName: `${tag} Supplies`, stateUnitId: JH });
  await approveSeller(db, ctxOf(national()), applied.sellerId, 'Checked.');
  const loc = await createLocation(db, ctxOf(principal), { code: 'W1', name: 'Warehouse' });
  return { principal, sellerId: applied.sellerId, locationId: loc.locationId };
}

async function product(sc: any, title: string, priceMinor: number, stock: number, weightGrams?: number) {
  const created = await createListing(db, ctxOf(sc.principal), {
    title, category: 'equipment', priceMinor,
    media: [{ url: `https://cdn.example.in/${encodeURIComponent(title)}.jpg`, alt: title }],
  });
  const v = await addVariant(db, ctxOf(sc.principal), created.listingId, {
    label: 'Standard', priceMinor, weightGrams: weightGrams ?? null,
  });
  await receiveStock(db, ctxOf(sc.principal), {
    variantId: v.variantId, locationId: sc.locationId, qty: stock, reason: 'Opening stock',
  });
  await submitListing(db, ctxOf(sc.principal), created.listingId);
  await reviewListing(db, ctxOf(national()), created.listingId, { decision: 'approve', reason: 'Fine.' });
  return { listingId: created.listingId, variantId: v.variantId };
}

const RANCHI = { line1: '1 Road', city: 'Ranchi', state: 'Jharkhand', postcode: '834001' };
const PATNA = { line1: '2 Road', city: 'Patna', state: 'Bihar', postcode: '800001' };

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
  const [br] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-BR', state: 'Bihar', name: 'Bihar', status: 'active' }).returning();
  JH = jh.id; BR = br.id;

  ADMIN = (await registerAccount(db, { email: 'admin@mmakf.in', password: PW })).userId;
  await adoptProposedTaxonomy(db, ctxOf(national()));

  const rule = await createCommissionRule(db, ctxOf(national()), {
    code: 'ship.commission', label: 'Test 10%',
  });
  const v = await draftCommissionVersion(db, ctxOf(national()), rule.ruleId, {
    rateBps: 1000, chargedOnShipping: false, chargedOnTax: false, effectiveFrom: '2020-01-01',
  });
  await publishCommissionVersion(db, ctxOf(national()), v.versionId, 'Resolution 2026/1');
}, 180_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('THE MATCHER — one definition, used by the quote and the charge', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('an empty constraint does not constrain', () => {
    const everywhere = [{ id: 1, priority: 100, states: null, postcodePrefixes: null }];
    expect(matchZone(everywhere, PATNA)?.id).toBe(1);
    // Even an address with nothing stated at all.
    expect(matchZone(everywhere, {})?.id).toBe(1);
  });

  it('a zone naming states does NOT match an address with no state', () => {
    // The tempting alternative — treat unknown as matching — quotes a Jharkhand
    // rate for a parcel to Kerala.
    const zones = [{ id: 1, priority: 100, states: ['Jharkhand'], postcodePrefixes: null }];
    expect(matchZone(zones, { postcode: '834001' })).toBeNull();
    expect(matchZone(zones, RANCHI)?.id).toBe(1);
  });

  it('matches on state case-insensitively, and on postcode by prefix', () => {
    const zones = [{ id: 1, priority: 100, states: ['jharkhand'], postcodePrefixes: ['83'] }];
    expect(matchZone(zones, RANCHI)?.id).toBe(1);
    expect(matchZone(zones, { state: 'Jharkhand', postcode: '999999' })).toBeNull();
  });

  it('the narrow zone wins when priority says so, and the tiebreak is stated', () => {
    const zones = [
      { id: 9, priority: 100, states: null, postcodePrefixes: null },          // everywhere
      { id: 2, priority: 10, states: ['Jharkhand'], postcodePrefixes: null },  // narrow, first
    ];
    expect(matchZone(zones, RANCHI)?.id).toBe(2);
    // Equal priority falls back to the LOWER ID, deterministically — a carriage
    // charge that depended on row order would change after a VACUUM.
    const tied = [
      { id: 7, priority: 50, states: null, postcodePrefixes: null },
      { id: 3, priority: 50, states: null, postcodePrefixes: null },
    ];
    expect(matchZone(tied, RANCHI)?.id).toBe(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('METHOD PRICING — integer arithmetic, no division of money', () => {
// ═════════════════════════════════════════════════════════════════════════════

  const basket = (over: Partial<{ subtotalMinor: number; itemCount: number; weightGrams: number }> = {}) =>
    ({ subtotalMinor: 100_000, itemCount: 1, weightGrams: 0, ...over });

  it('flat charges its price whatever the basket', () => {
    expect(priceMethod({ kind: 'flat', priceMinor: 6_000 }, basket())).toBe(6_000);
    expect(priceMethod({ kind: 'flat', priceMinor: 6_000 }, basket({ subtotalMinor: 9_000_000 }))).toBe(6_000);
  });

  it('free is free', () => {
    expect(priceMethod({ kind: 'free', priceMinor: 6_000 }, basket())).toBe(0);
  });

  it('free_above waives only at the threshold', () => {
    const m = { kind: 'free_above', priceMinor: 6_000, freeAboveMinor: 200_000 };
    expect(priceMethod(m, basket({ subtotalMinor: 199_999 }))).toBe(6_000);
    expect(priceMethod(m, basket({ subtotalMinor: 200_000 }))).toBe(0);
  });

  it('a free_above with NO threshold charges its price rather than being free', () => {
    // It is not "free above nothing" — it is a rule nobody finished writing,
    // and charging the base price is the honest reading of an incomplete one.
    const m = { kind: 'free_above', priceMinor: 6_000, freeAboveMinor: null };
    expect(priceMethod(m, basket({ subtotalMinor: 9_000_000 }))).toBe(6_000);
  });

  it('per_item adds per item', () => {
    const m = { kind: 'per_item', priceMinor: 5_000, perItemMinor: 1_500 };
    expect(priceMethod(m, basket({ itemCount: 3 }))).toBe(5_000 + 4_500);
  });

  it('by_weight agrees with the canonical applyFactor(), value for value', () => {
    // A DIFFERENTIAL PROOF, not an assertion of a hand-computed number. The
    // module carries its own copy of applyFactor to avoid dragging the fee
    // framework into the checkout path, and the whole risk of that copy is
    // that it drifts. This is what catches the drift.
    const perKg = 4_000;
    for (const grams of [1, 250, 499, 500, 501, 999, 1000, 1001, 2500, 7_777, 100_000]) {
      const viaModule = priceMethod(
        { kind: 'by_weight', priceMinor: 0, perKgMinor: perKg },
        basket({ weightGrams: grams }),
      );
      const viaCanonical = applyFactor(perKg, Math.round(grams * 1000));
      expect(viaModule).toBe(viaCanonical);
    }
  });

  it('by_weight falls back to the base price when nothing is weighed', () => {
    // A variant whose weight nobody recorded must not acquire an invented one.
    const m = { kind: 'by_weight', priceMinor: 5_000, perKgMinor: 4_000 };
    expect(priceMethod(m, basket({ weightGrams: 0 }))).toBe(5_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('CONFIGURATION — and what it refuses', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('refuses a postcode prefix that is not one', async () => {
    const sc = await seller('badprefix');
    await expect(createZone(db, ctxOf(sc.principal), {
      name: 'Nonsense', postcodePrefixes: ['not-a-postcode'],
    })).rejects.toMatchObject({ code: 'bad_prefix' });
  });

  it('refuses a free_above with no threshold, and a by_weight with no rate', async () => {
    const sc = await seller('incomplete');
    const z = await createZone(db, ctxOf(sc.principal), { name: 'Everywhere' });

    await expect(createMethod(db, ctxOf(sc.principal), z.zoneId, {
      name: 'Half-written', kind: 'free_above', priceMinor: 6_000,
    })).rejects.toMatchObject({ code: 'threshold_required' });

    await expect(createMethod(db, ctxOf(sc.principal), z.zoneId, {
      name: 'Half-written', kind: 'by_weight', priceMinor: 6_000,
    })).rejects.toMatchObject({ code: 'rate_required' });
  });

  it('refuses a NEGATIVE carriage price — it is a discount nobody authorised', async () => {
    const sc = await seller('negative');
    const z = await createZone(db, ctxOf(sc.principal), { name: 'Everywhere' });
    await expect(createMethod(db, ctxOf(sc.principal), z.zoneId, {
      name: 'Refund by post', kind: 'flat', priceMinor: -50_000,
    })).rejects.toMatchObject({ code: 'bad_price' });
  });

  it('refuses a delivery estimate that ends before it begins', async () => {
    const sc = await seller('backwards');
    const z = await createZone(db, ctxOf(sc.principal), { name: 'Everywhere' });
    await expect(createMethod(db, ctxOf(sc.principal), z.zoneId, {
      name: 'Time travel', kind: 'flat', priceMinor: 6_000, minDays: 7, maxDays: 3,
    })).rejects.toMatchObject({ code: 'bad_days' });
  });

  it('one seller cannot touch another seller’s zone or method', async () => {
    const owner = await seller('zone-owner');
    const other = await seller('zone-interloper');
    const z = await createZone(db, ctxOf(owner.principal), { name: 'Mine' });
    const m = await createMethod(db, ctxOf(owner.principal), z.zoneId, {
      name: 'Standard', kind: 'flat', priceMinor: 6_000,
    });

    await expect(createMethod(db, ctxOf(other.principal), z.zoneId, {
      name: 'Mine now', kind: 'flat', priceMinor: 0,
    })).rejects.toMatchObject({ code: 'not_your_zone' });

    await expect(deactivateZone(db, ctxOf(other.principal), z.zoneId, 'taking it'))
      .rejects.toMatchObject({ code: 'not_your_zone' });

    await expect(deactivateMethod(db, ctxOf(other.principal), m.methodId, 'taking it'))
      .rejects.toMatchObject({ code: 'not_your_method' });

    // And it cannot even SEE it.
    const mine = await myZones(db, other.principal);
    expect(mine.every((z2: any) => z2.id !== z.zoneId)).toBe(true);
  });

  it('withdrawing a zone withdraws its methods with it', async () => {
    const sc = await seller('withdrawer');
    const z = await createZone(db, ctxOf(sc.principal), { name: 'Everywhere' });
    await createMethod(db, ctxOf(sc.principal), z.zoneId, { name: 'Std', kind: 'flat', priceMinor: 6_000 });
    await deactivateZone(db, ctxOf(sc.principal), z.zoneId, 'Carrier withdrew from the region.');

    // A reactivated zone must not come back quoting a method that was
    // separately retired, so they go together.
    const methods = await db.select().from(s.shippingMethods).where(eq(s.shippingMethods.zoneId, z.zoneId));
    expect(methods.every((m: any) => m.active === false)).toBe(true);
    expect(await myZones(db, sc.principal)).toHaveLength(1);   // kept, not deleted
  });

  it('withdrawing requires a reason — it changes what buyers are charged', async () => {
    const sc = await seller('unexplained-zone');
    const z = await createZone(db, ctxOf(sc.principal), { name: 'Everywhere' });
    await expect(deactivateZone(db, ctxOf(sc.principal), z.zoneId, '  '))
      .rejects.toMatchObject({ code: 'reason_required' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('THE QUOTE IS THE CHARGE', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('a seller with no zone is quoted zero — and told they are paying it', async () => {
    const sc = await seller('unzoned');
    const p = await product(sc, 'Unzoned gi', 100_000, 5);

    const quote = await quoteCarriage(db, sc.sellerId, { subtotalMinor: 100_000, itemCount: 1, weightGrams: 0 }, RANCHI);
    expect(quote.amountMinor).toBe(0);
    expect(quote.absorbed).toBe(true);
    expect(quote.notServiceable).toBe(false);

    // The behaviour is unchanged. What is new is that it is no longer silent.
    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }], email: 'a@example.in', shipTo: RANCHI,
    });
    expect(order.sellerOrders[0].shippingMinor).toBe(0);

    const exposure = await carriageExposure(db, sc.principal);
    expect(exposure.configured).toBe(false);
    expect(exposure.note).toBe(CARRIAGE_ABSORBED);
    expect(exposure.absorbedOrders).toBeGreaterThan(0);
  });

  it('what the seller previews is exactly what the buyer is charged', async () => {
    const sc = await seller('previewer');
    const p = await product(sc, 'Quoted gi', 150_000, 5);
    const z = await createZone(db, ctxOf(sc.principal), { name: 'Jharkhand', states: ['Jharkhand'] });
    await createMethod(db, ctxOf(sc.principal), z.zoneId, {
      name: 'Standard', kind: 'flat', priceMinor: 7_500, carrier: 'India Post', minDays: 3, maxDays: 7,
    });

    const preview = await previewCarriage(db, sc.principal,
      { subtotalMinor: 150_000, itemCount: 1, weightGrams: 0 }, RANCHI);
    expect(preview.amountMinor).toBe(7_500);
    expect(preview.methodName).toBe('Standard');

    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }], email: 'b@example.in', shipTo: RANCHI,
    });
    // THE SAME NUMBER, from the same function. Not two computations that agree.
    expect(order.sellerOrders[0].shippingMinor).toBe(preview.amountMinor);
    expect(order.totalMinor).toBe(150_000 + 7_500);
  });

  it('the CHEAPEST matching method wins', async () => {
    const sc = await seller('cheapest');
    const p = await product(sc, 'Choice gi', 100_000, 5);
    const z = await createZone(db, ctxOf(sc.principal), { name: 'Everywhere' });
    await createMethod(db, ctxOf(sc.principal), z.zoneId, { name: 'Express', kind: 'flat', priceMinor: 20_000 });
    await createMethod(db, ctxOf(sc.principal), z.zoneId, { name: 'Economy', kind: 'flat', priceMinor: 4_000 });

    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }], email: 'c@example.in', shipTo: RANCHI,
    });
    expect(order.sellerOrders[0].shippingMinor).toBe(4_000);
  });

  it('a seller WITH zones that miss the address refuses the sale', async () => {
    const sc = await seller('jharkhand-only');
    const p = await product(sc, 'Local only', 100_000, 5);
    const z = await createZone(db, ctxOf(sc.principal), { name: 'Jharkhand', states: ['Jharkhand'] });
    await createMethod(db, ctxOf(sc.principal), z.zoneId, { name: 'Std', kind: 'flat', priceMinor: 6_000 });

    await expect(checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }], email: 'd@example.in', shipTo: PATNA,
    })).rejects.toMatchObject({ code: 'not_serviceable' });

    // And the preview says the same thing, so the seller can see it coming.
    const preview = await previewCarriage(db, sc.principal,
      { subtotalMinor: 100_000, itemCount: 1, weightGrams: 0 }, PATNA);
    expect(preview.notServiceable).toBe(true);
  });

  it('a zone with no method is absorbed, not unserviceable', async () => {
    // A seller who said WHERE they ship and not what it costs clearly intends
    // to deliver there. Refusing would turn a half-finished setup into lost
    // business.
    const sc = await seller('zone-no-method');
    const p = await product(sc, 'Half configured', 100_000, 5);
    await createZone(db, ctxOf(sc.principal), { name: 'Everywhere' });

    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }], email: 'e@example.in', shipTo: RANCHI,
    });
    expect(order.sellerOrders[0].shippingMinor).toBe(0);
  });

  it('weight reaches the quote from the variants, not from the caller', async () => {
    const sc = await seller('weighed');
    const p = await product(sc, 'Heavy mat', 500_000, 5, 4_000);   // 4kg
    const z = await createZone(db, ctxOf(sc.principal), { name: 'Everywhere' });
    await createMethod(db, ctxOf(sc.principal), z.zoneId, {
      name: 'By weight', kind: 'by_weight', priceMinor: 5_000, perKgMinor: 3_000,
    });

    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 2 }], email: 'f@example.in', shipTo: RANCHI,
    });
    // 2 × 4kg = 8kg. Base 5000 + 8 × 3000.
    const expected = 5_000 + applyFactor(3_000, Math.round(8_000 * 1000));
    expect(order.sellerOrders[0].shippingMinor).toBe(expected);
  });

  it('a multi-seller basket is charged carriage PER SELLER', async () => {
    const a = await seller('carriage-a');
    const b = await seller('carriage-b');
    const pa = await product(a, 'A item', 100_000, 5);
    const pb = await product(b, 'B item', 100_000, 5);

    for (const sc of [a, b]) {
      const z = await createZone(db, ctxOf(sc.principal), { name: 'Everywhere' });
      await createMethod(db, ctxOf(sc.principal), z.zoneId, { name: 'Std', kind: 'flat', priceMinor: 6_000 });
    }

    const order = await checkout(db, null, {
      lines: [{ variantId: pa.variantId, quantity: 1 }, { variantId: pb.variantId, quantity: 1 }],
      email: 'g@example.in', shipTo: RANCHI,
    });

    // Two consignments, two charges. Presenting it as one would be a discount
    // MMAKF pays for without being asked.
    expect(order.sellerOrders).toHaveLength(2);
    expect(order.sellerOrders.every((so: any) => so.shippingMinor === 6_000)).toBe(true);
    expect(order.totalMinor).toBe(200_000 + 12_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('EXPOSURE — what the seller is giving away, and turning away', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('names the states a zone set does not cover', async () => {
    const sc = await seller('partial-cover');
    await createZone(db, ctxOf(sc.principal), { name: 'Jharkhand only', states: ['Jharkhand'] });

    const exposure = await carriageExposure(db, sc.principal);
    expect(exposure.configured).toBe(true);
    expect(exposure.coveredStates).toContain('Jharkhand');
    expect(exposure.uncoveredStates).toContain('Bihar');
    expect(exposure.coversEverywhere).toBe(false);
  });

  it('a zone covering everywhere leaves nothing uncovered', async () => {
    const sc = await seller('full-cover');
    await createZone(db, ctxOf(sc.principal), { name: 'Everywhere' });

    const exposure = await carriageExposure(db, sc.principal);
    expect(exposure.coversEverywhere).toBe(true);
    expect(exposure.uncoveredStates).toEqual([]);
  });

  it('reports no rupee figure for what absorbed carriage cost', async () => {
    // What a parcel costs to send is a fact about the seller's carrier that
    // MMAKF does not hold. A figure here would be invented, and inventing one
    // is the fabrication the rest of this codebase refuses.
    const sc = await seller('no-figure');
    const exposure = await carriageExposure(db, sc.principal);
    expect(Object.keys(exposure)).not.toContain('absorbedCostMinor');
    expect(typeof exposure.absorbedOrders).toBe('number');
  });

  it('the unzoned-seller policy is reported as undecided, not chosen', () => {
    expect(UNZONED_SELLER_POLICY_NOT_SET).toMatch(/has not decided/i);
  });
});
