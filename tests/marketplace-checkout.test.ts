// The marketplace basket, priced — and the promise that pricing writes nothing.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// /shop/product/[ref] had an "Add to basket" button that silently lost the
// item: it wrote localStorage key `mmakf.basket` with `{variantId, quantity}`
// and sent the buyer to /checkout, which reads key `mmakf.basket.v1` with
// `{v, q}`. The buyer was told the item was added and arrived at an empty
// basket.
//
// AND MAKING THE KEYS MATCH WOULD HAVE BEEN WORSE THAN THE BUG. /checkout
// resolves ids against `product_variants`; the marketplace sells
// `listing_variants`. The same integer means a different thing in each, so a
// merged basket either drops the line or charges for a different product.
//
// So the marketplace got its own basket, its own checkout page, and — the part
// this file tests — its own PRICING function. Before it, the only way to learn
// a basket's total was to call checkout(), which allocates an order number,
// writes seller orders and reserves stock for forty-five minutes. A page that
// merely displayed a total would have created an order every time somebody
// looked at it.
//
// The two things that must hold, and that everything below is about:
//
//   · cartPreview() WRITES NOTHING;
//   · it refuses exactly what checkout() refuses, because they share
//     priceCart() — so the figure a buyer is shown and the figure they are
//     charged cannot drift apart.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { cartPreview } from '../src/db/seller-orders';
import { isMarketplaceError } from '../src/db/marketplace';

let db: any;
let seq = 0;

async function makeSeller(over: Record<string, any> = {}) {
  seq += 1;
  const [u] = await db.insert(s.users)
    .values({ email: `mk-${seq}@example.in`, status: 'active' })
    .returning({ id: s.users.id });
  const [row] = await db.insert(s.sellers).values({
    ref: `MMAKF-SEL-2026-${String(seq).padStart(6, '0')}`,
    userId: u.id,
    tradingName: `Trader ${seq}`,
    status: 'approved',
    storeStatus: 'open',
    storeSlug: `trader-${seq}`,
    ...over,
  }).returning();
  return row;
}

/** An approved, unedited listing with one active variant. */
async function makeItem(
  sellerId: number,
  opts: { priceMinor?: number; taxRateBps?: number; qty?: number; listing?: Record<string, any> } = {}
) {
  seq += 1;
  const hash = `hash-${seq}`;
  const [listing] = await db.insert(s.listings).values({
    ref: `MMAKF-LST-2026-${String(seq).padStart(6, '0')}`,
    sellerId,
    title: `Item ${seq}`,
    category: 'uniform',
    priceMinor: opts.priceMinor ?? 250000,
    currency: 'INR',
    status: 'approved',
    contentHash: hash,
    approvedContentHash: hash,
    taxRateBps: opts.taxRateBps ?? 0,
    ...(opts.listing ?? {}),
  }).returning();

  const [variant] = await db.insert(s.listingVariants).values({
    listingId: listing.id,
    sellerId,
    sku: `SKU-${seq}`,
    label: `Size ${seq}`,
    priceMinor: opts.priceMinor ?? 250000,
    currency: 'INR',
    status: 'active',
    availableQty: opts.qty ?? 10,
  }).returning();

  return { listing, variant };
}

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
});

beforeEach(async () => {
  await db.delete(s.orderLines);
  await db.delete(s.sellerOrders);
  await db.delete(s.orders);
  await db.delete(s.listingVariants);
  await db.delete(s.listings);
  await db.delete(s.sellers);
  await db.delete(s.users);
});

// ─────────────────────────────────────────────────────────────────────────────
// It prices
// ─────────────────────────────────────────────────────────────────────────────

describe('cartPreview prices a basket from the catalogue', () => {
  it('reads the price from the variant, never from the caller', async () => {
    const seller = await makeSeller();
    const { variant } = await makeItem(seller.id, { priceMinor: 250000 });

    const preview = await cartPreview(db, [{ variantId: variant.id, quantity: 2 }]);

    expect(preview.sellers).toHaveLength(1);
    expect(preview.sellers[0].lines[0].unitPriceMinor).toBe(250000);
    expect(preview.sellers[0].lines[0].quantity).toBe(2);
    expect(preview.subtotalMinor).toBe(500000);
    expect(preview.totalMinor).toBe(500000);
    expect(preview.currency).toBe('INR');
  });

  it('applies the listing tax rate through the shared money primitive', async () => {
    const seller = await makeSeller();
    // 1800 bps = 18%. ₹2,500 × 18% = ₹450.
    const { variant } = await makeItem(seller.id, { priceMinor: 250000, taxRateBps: 1800 });

    const preview = await cartPreview(db, [{ variantId: variant.id, quantity: 1 }]);
    expect(preview.taxMinor).toBe(45000);
    expect(preview.totalMinor).toBe(295000);
  });

  it('SPLITS BY SELLER — a basket from two traders is two obligations', async () => {
    const a = await makeSeller({ storeSlug: 'trader-a' });
    const b = await makeSeller({ storeSlug: 'trader-b' });
    const itemA = await makeItem(a.id, { priceMinor: 100000 });
    const itemB = await makeItem(b.id, { priceMinor: 200000 });

    const preview = await cartPreview(db, [
      { variantId: itemA.variant.id, quantity: 1 },
      { variantId: itemB.variant.id, quantity: 1 },
    ]);

    expect(preview.sellers).toHaveLength(2);
    const byName = new Map(preview.sellers.map((x) => [x.sellerName, x]));
    expect(byName.get(a.tradingName)!.subtotalMinor).toBe(100000);
    expect(byName.get(b.tradingName)!.subtotalMinor).toBe(200000);
    expect(preview.subtotalMinor).toBe(300000);
    // Each carries its own store address, so the buyer can see whose it is.
    expect(byName.get(a.tradingName)!.storeSlug).toBe('trader-a');
  });

  it('combines a repeated variant into one line', async () => {
    const seller = await makeSeller();
    const { variant } = await makeItem(seller.id, { priceMinor: 100000 });

    // Two reservations for one variant would collide on the reservation unique
    // index at checkout, so the merge happens during pricing.
    const preview = await cartPreview(db, [
      { variantId: variant.id, quantity: 2 },
      { variantId: variant.id, quantity: 3 },
    ]);

    expect(preview.sellers[0].lines).toHaveLength(1);
    expect(preview.sellers[0].lines[0].quantity).toBe(5);
    expect(preview.subtotalMinor).toBe(500000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// It writes nothing — the whole reason it is not checkout()
// ─────────────────────────────────────────────────────────────────────────────

describe('cartPreview has no side effects', () => {
  it('creates no order, no seller order and no order line', async () => {
    const seller = await makeSeller();
    const { variant } = await makeItem(seller.id);

    // Priced five times, as a browser adjusting quantities would.
    for (let i = 1; i <= 5; i += 1) {
      await cartPreview(db, [{ variantId: variant.id, quantity: i }]);
    }

    expect(await db.select().from(s.orders)).toHaveLength(0);
    expect(await db.select().from(s.sellerOrders)).toHaveLength(0);
    expect(await db.select().from(s.orderLines)).toHaveLength(0);
  });

  it('reserves no stock, so looking at a basket cannot hold somebody else\'s goods', async () => {
    const seller = await makeSeller();
    const { variant } = await makeItem(seller.id, { qty: 3 });

    await cartPreview(db, [{ variantId: variant.id, quantity: 3 }]);

    const [after] = await db.select().from(s.listingVariants)
      .where(eq(s.listingVariants.id, variant.id));
    expect(after.availableQty).toBe(3);
    expect(await db.select().from(s.stockReservations)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// It refuses what checkout refuses — the same predicate, by construction
// ─────────────────────────────────────────────────────────────────────────────

describe('cartPreview refuses exactly what cannot be bought', () => {
  const failFor = async (variantId: number) => {
    try {
      await cartPreview(db, [{ variantId, quantity: 1 }]);
      return null;
    } catch (e: any) {
      return e;
    }
  };

  it('refuses an item whose listing is not approved', async () => {
    const seller = await makeSeller();
    const { variant, listing } = await makeItem(seller.id);
    await db.update(s.listings).set({ status: 'submitted' }).where(eq(s.listings.id, listing.id));

    const err = await failFor(variant.id);
    expect(isMarketplaceError(err)).toBe(true);
    expect(err.code).toBe('unavailable');
    // The sentence a buyer reads names the possibilities rather than a code.
    expect(err.message).toMatch(/withdrawn|review|suspended/i);
  });

  it('refuses a QUARANTINED item', async () => {
    const seller = await makeSeller();
    const { variant, listing } = await makeItem(seller.id);
    await db.update(s.listings)
      .set({ quarantinedAt: new Date(), quarantineReason: 'counterfeit report' })
      .where(eq(s.listings.id, listing.id));

    expect((await failFor(variant.id))?.code).toBe('unavailable');
  });

  it('refuses an item EDITED SINCE APPROVAL', async () => {
    const seller = await makeSeller();
    const { variant, listing } = await makeItem(seller.id);
    await db.update(s.listings)
      .set({ contentHash: 'something-else-entirely' })
      .where(eq(s.listings.id, listing.id));

    expect((await failFor(variant.id))?.code).toBe('unavailable');
  });

  it('refuses an item whose seller is SUSPENDED', async () => {
    const seller = await makeSeller();
    const { variant } = await makeItem(seller.id);
    await db.update(s.sellers).set({ status: 'suspended' }).where(eq(s.sellers.id, seller.id));

    expect((await failFor(variant.id))?.code).toBe('unavailable');
  });

  it('refuses an item whose shop is CLOSED', async () => {
    const seller = await makeSeller();
    const { variant } = await makeItem(seller.id);
    await db.update(s.sellers)
      .set({ storeStatus: 'closed_by_seller' })
      .where(eq(s.sellers.id, seller.id));

    expect((await failFor(variant.id))?.code).toBe('unavailable');
  });

  it('refuses a DISCONTINUED variant of an otherwise public listing', async () => {
    const seller = await makeSeller();
    const { variant } = await makeItem(seller.id);
    await db.update(s.listingVariants)
      .set({ status: 'discontinued' })
      .where(eq(s.listingVariants.id, variant.id));

    expect((await failFor(variant.id))?.code).toBe('unavailable');
  });

  it('refuses a variant id that never existed, in the same words', async () => {
    // A guessed id must not be distinguishable from a withdrawn one, or the
    // endpoint becomes an oracle for which ids are real.
    expect((await failFor(999_999))?.code).toBe('unavailable');
  });
});

describe('cartPreview refuses a malformed basket', () => {
  it('refuses an empty basket', async () => {
    await expect(cartPreview(db, [])).rejects.toMatchObject({ code: 'empty_cart' });
  });

  it('refuses more lines than a basket may hold', async () => {
    const lines = Array.from({ length: 41 }, (_, i) => ({ variantId: i + 1, quantity: 1 }));
    await expect(cartPreview(db, lines)).rejects.toMatchObject({ code: 'cart_too_large' });
  });

  it('refuses a quantity outside 1..99', async () => {
    const seller = await makeSeller();
    const { variant } = await makeItem(seller.id);
    for (const quantity of [0, -1, 100, 1.5]) {
      await expect(cartPreview(db, [{ variantId: variant.id, quantity }]))
        .rejects.toMatchObject({ code: 'bad_quantity' });
    }
  });

  it('refuses a line that names no variant', async () => {
    await expect(cartPreview(db, [{ variantId: NaN, quantity: 1 } as any]))
      .rejects.toMatchObject({ code: 'bad_line' });
  });
});
