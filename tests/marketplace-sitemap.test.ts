// What the marketplace invites a crawler to index — and what it must never.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS
// ─────────────────────────────────────────────────────────────────────────────
//
// /shop/product/[ref] and /shop/seller/[slug] are dynamic routes, and for as
// long as they had no entry in DYNAMIC_ROUTE_POLICY they contributed nothing to
// the sitemap. That default is safe, and it made the federation's whole
// marketplace undiscoverable.
//
// The obvious fix is the dangerous one. `select ref from listings` would hand a
// crawler the URL of every DRAFT, REJECTED, QUARANTINED and
// EDITED-SINCE-APPROVAL item in the marketplace — items no human at MMAKF ever
// approved — published under the federation's own domain with the federation's
// own sitemap as the invitation. Search engines keep what they are given.
//
// So both expansions are built on publicListingPredicate(), the SAME predicate
// the shop index, the product page and the storefront resolve through. This
// file is the proof that the reuse actually holds: every test below makes a row
// fail exactly ONE of the five conditions and asserts it is absent.
//
// Against a real Postgres (PGlite) with every migration applied, because the
// visibility rule is a SQL predicate and does not exist in a mock.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  publishableListings, publishableStorefronts,
  SITEMAP_LISTING_CAP, SITEMAP_STOREFRONT_CAP,
} from '../src/db/marketplace';
import { renderSitemap, classifyRoute, DYNAMIC_ROUTE_POLICY } from '../src/lib/seo';

let db: any;
let seq = 0;

/**
 * A seller, in whatever standing the test needs.
 *
 * Each gets its OWN user, because `sellers_user_uk` is a real constraint: one
 * account trades under one seller record. Reusing a single user id here would
 * fail on the second seller — which it did, and which is the constraint doing
 * its job rather than a nuisance to work around.
 */
async function makeSeller(over: Record<string, any> = {}) {
  seq += 1;
  const [u] = await db.insert(s.users)
    .values({ email: `seller-${seq}@example.in`, status: 'active' })
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

/**
 * A listing, approved and unedited unless the test says otherwise.
 *
 * `contentHash === approvedContentHash` is the default because that is the
 * state of an item a human has approved and nobody has touched since. A test
 * that wants the "edited after approval" case changes one of the two.
 */
async function makeListing(sellerId: number, over: Record<string, any> = {}) {
  seq += 1;
  const hash = `hash-${seq}`;
  const [row] = await db.insert(s.listings).values({
    ref: `MMAKF-LST-2026-${String(seq).padStart(6, '0')}`,
    sellerId,
    title: `Item ${seq}`,
    category: 'uniform',
    priceMinor: 250000,
    currency: 'INR',
    status: 'approved',
    contentHash: hash,
    approvedContentHash: hash,
    ...over,
  }).returning();
  return row;
}

const refs = async () => (await publishableListings(db)).values;
const slugs = async () => (await publishableStorefronts(db)).values;

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
  await db.delete(s.listings);
  await db.delete(s.sellers);
  await db.delete(s.users);
});

// ─────────────────────────────────────────────────────────────────────────────
// The one case that SHOULD be advertised
// ─────────────────────────────────────────────────────────────────────────────

describe('a genuinely public item', () => {
  it('is advertised, and so is the storefront carrying it', async () => {
    const seller = await makeSeller({ storeSlug: 'kime-supplies' });
    const item = await makeListing(seller.id);

    expect(await refs()).toEqual([item.ref]);
    expect(await slugs()).toEqual(['kime-supplies']);
  });

  it('reaches the sitemap as a well-formed absolute URL', async () => {
    const seller = await makeSeller({ storeSlug: 'kime-supplies' });
    const item = await makeListing(seller.id);

    const xml = renderSitemap(
      [`/shop/product/${item.ref}`, `/shop/seller/${seller.storeSlug}`],
      'https://www.mmakf.in'
    );

    expect(xml).toContain(`<loc>https://www.mmakf.in/shop/product/${item.ref}</loc>`);
    expect(xml).toContain('<loc>https://www.mmakf.in/shop/seller/kime-supplies</loc>');
    // No development origin ever reaches a published sitemap.
    expect(xml).not.toContain('localhost');
    expect(xml).not.toContain('127.0.0.1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The five conditions of publicListingPredicate(), one at a time
// ─────────────────────────────────────────────────────────────────────────────

describe('an item that fails any one condition is not advertised', () => {
  it('excludes a DRAFT item', async () => {
    const seller = await makeSeller();
    await makeListing(seller.id, { status: 'draft' });
    expect(await refs()).toEqual([]);
  });

  it('excludes a SUBMITTED item awaiting review', async () => {
    const seller = await makeSeller();
    await makeListing(seller.id, { status: 'submitted' });
    expect(await refs()).toEqual([]);
  });

  it('excludes a REJECTED item', async () => {
    const seller = await makeSeller();
    await makeListing(seller.id, { status: 'rejected' });
    expect(await refs()).toEqual([]);
  });

  it('excludes a DELISTED item', async () => {
    const seller = await makeSeller();
    await makeListing(seller.id, { status: 'delisted' });
    expect(await refs()).toEqual([]);
  });

  it('excludes a QUARANTINED item', async () => {
    const seller = await makeSeller();
    const item = await makeListing(seller.id);
    expect(await refs()).toEqual([item.ref]);

    // One column, and the item leaves every public surface at once.
    await db.update(s.listings)
      .set({ quarantinedAt: new Date(), quarantineReason: 'counterfeit report' })
      .where(eq(s.listings.id, item.id));

    expect(await refs()).toEqual([]);
  });

  it('excludes an item EDITED SINCE APPROVAL', async () => {
    const seller = await makeSeller();
    const item = await makeListing(seller.id);
    expect(await refs()).toEqual([item.ref]);

    // The seller changes the gi into something else. content_hash moves away
    // from approved_content_hash, and the approval no longer describes the item.
    await db.update(s.listings)
      .set({ contentHash: 'a-different-item-entirely' })
      .where(eq(s.listings.id, item.id));

    expect(await refs()).toEqual([]);
  });

  it('excludes every item of a SUSPENDED seller, without deleting a row', async () => {
    const seller = await makeSeller();
    await makeListing(seller.id);
    await makeListing(seller.id);
    expect(await refs()).toHaveLength(2);

    await db.update(s.sellers).set({ status: 'suspended' }).where(eq(s.sellers.id, seller.id));

    expect(await refs()).toEqual([]);
    expect(await slugs()).toEqual([]);
    // The rows are still there. A suspension is not a deletion.
    expect(await db.select().from(s.listings)).toHaveLength(2);
  });

  it('excludes every item of a CLOSED shop', async () => {
    const seller = await makeSeller();
    await makeListing(seller.id);
    expect(await refs()).toHaveLength(1);

    await db.update(s.sellers)
      .set({ storeStatus: 'closed_by_seller' })
      .where(eq(s.sellers.id, seller.id));

    expect(await refs()).toEqual([]);
    expect(await slugs()).toEqual([]);
  });

  it('excludes an item whose seller is still only APPLIED', async () => {
    const seller = await makeSeller({ status: 'applied' });
    await makeListing(seller.id);
    expect(await refs()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Storefronts — the thin-doorway rule
// ─────────────────────────────────────────────────────────────────────────────

describe('storefronts', () => {
  it('does NOT advertise an approved, open shop with nothing in it', async () => {
    await makeSeller({ storeSlug: 'empty-shop' });
    // Approved seller, open store, slug set — and no item a searcher wanted.
    // A page carrying a trading name and a tagline is a doorway, and a domain
    // full of doorways is a penalised domain.
    expect(await slugs()).toEqual([]);
  });

  it('does NOT advertise a shop whose only items are unapproved', async () => {
    const seller = await makeSeller({ storeSlug: 'pending-shop' });
    await makeListing(seller.id, { status: 'submitted' });
    await makeListing(seller.id, { status: 'draft' });
    expect(await slugs()).toEqual([]);
  });

  it('starts advertising a shop the moment its first item is approved', async () => {
    const seller = await makeSeller({ storeSlug: 'growing-shop' });
    const item = await makeListing(seller.id, { status: 'submitted' });
    expect(await slugs()).toEqual([]);

    await db.update(s.listings).set({ status: 'approved' }).where(eq(s.listings.id, item.id));
    expect(await slugs()).toEqual(['growing-shop']);
  });

  it('does NOT advertise a seller who has chosen no store slug', async () => {
    const seller = await makeSeller({ storeSlug: null });
    const item = await makeListing(seller.id);

    // The item is public and discoverable at its own URL …
    expect(await refs()).toEqual([item.ref]);
    // … but the storefront has no address, and inventing one from the trading
    // name would publish a URL that moves the next time somebody corrects a
    // spelling. The same rule publishableClubs() applies.
    expect(await slugs()).toEqual([]);
  });

  it('lists each storefront once however many items it carries', async () => {
    const seller = await makeSeller({ storeSlug: 'busy-shop' });
    await makeListing(seller.id);
    await makeListing(seller.id);
    await makeListing(seller.id);

    expect(await refs()).toHaveLength(3);
    expect(await slugs()).toEqual(['busy-shop']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bounds — a cap that hides itself reads as "everything is in there"
// ─────────────────────────────────────────────────────────────────────────────

describe('the caps', () => {
  it('reports truncation rather than silently dropping the tail', async () => {
    const seller = await makeSeller({ storeSlug: 'many-items' });
    await makeListing(seller.id);
    await makeListing(seller.id);
    await makeListing(seller.id);

    const capped = await publishableListings(db, 2);
    expect(capped.values).toHaveLength(2);
    expect(capped.truncated).toBe(true);

    const roomy = await publishableListings(db, 10);
    expect(roomy.values).toHaveLength(3);
    expect(roomy.truncated).toBe(false);
  });

  it('reports truncation on storefronts too', async () => {
    for (let i = 0; i < 3; i += 1) {
      const seller = await makeSeller({ storeSlug: `shop-${i}` });
      await makeListing(seller.id);
    }
    const capped = await publishableStorefronts(db, 2);
    expect(capped.values).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it('keeps both caps under the sitemap protocol ceiling of 50,000 URLs', async () => {
    expect(SITEMAP_LISTING_CAP).toBeGreaterThan(0);
    expect(SITEMAP_STOREFRONT_CAP).toBeGreaterThan(0);
    expect(SITEMAP_LISTING_CAP + SITEMAP_STOREFRONT_CAP).toBeLessThan(50_000);
  });

  it('never issues an unbounded query, whatever it is asked for', async () => {
    const seller = await makeSeller({ storeSlug: 'bounds' });
    await makeListing(seller.id);
    // A caller passing 0 or a negative would, without the floor, produce
    // `limit 1` at best and an error at worst. It produces one row.
    expect((await publishableListings(db, 0)).values).toHaveLength(1);
    expect((await publishableListings(db, -5)).values).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The policy that authorises the expansion at all
// ─────────────────────────────────────────────────────────────────────────────

describe('the written expansion policy', () => {
  it('records why each marketplace route is expanded', () => {
    for (const route of ['/shop/product/[ref]', '/shop/seller/[slug]']) {
      const policy = DYNAMIC_ROUTE_POLICY[route];
      expect(policy, `${route} has no written expansion policy`).toBeTruthy();
      // A policy that does not name the predicate is a policy that could be
      // satisfied by `select ref from listings`, which is the defect.
      expect(policy).toContain('publicListingPredicate');
      expect(classifyRoute(route).kind).toBe('dynamic');
    }
  });

  it('keeps the shop application page out of the index', () => {
    // A signed-out visitor meets a sign-in explanation, so to a crawler it is a
    // gate with nothing behind it.
    expect(classifyRoute('/seller/apply').kind).toBe('excluded');
  });
});
