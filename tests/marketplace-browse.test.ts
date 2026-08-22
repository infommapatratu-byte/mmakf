// Category landing pages, brand pages and marketplace browse.
//
// WHAT THIS SUITE IS ABOUT, AND IT IS NOT "THE LIST RENDERS"
// ─────────────────────────────────────────────────────────
//
// A browse surface is the first place in a marketplace where a visibility bug
// becomes a PUBLICATION. The product page shows one item to somebody who
// already had its reference; a category page shows everything, to everybody,
// including a crawler. So the assertions here are almost entirely refusals:
//
//   · an item that is unapproved, edited since approval, quarantined, or whose
//     seller is suspended or shop closed is ABSENT — and absent from the COUNT
//     as well as from the page, which is the assertion that proves the
//     exclusion happened in the QUERY and not in a `.filter()` afterwards;
//   · a filter the federation has no column for is REFUSED, not ignored;
//   · an age filter does not treat "unstated" as "suitable for a child";
//   · a category path from a URL cannot smuggle a LIKE wildcard into the
//     prefix match and browse a subtree it never named;
//   · pagination is real — the total is the real total, pages are disjoint,
//     and equal prices do not make one item appear twice and another vanish.
//
// The happy path is asserted exactly once per function, because it is the part
// that fails loudly on its own.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { registerAccount } from '../src/db/onboarding';
import {
  applyToSell, approveSeller, createListing, submitListing, reviewListing,
  updateListing, suspendSeller, isMarketplaceError,
} from '../src/db/marketplace';
import { addVariant, adoptProposedTaxonomy, quarantineListing } from '../src/db/catalogue';
import { createLocation, receiveStock } from '../src/db/inventory';
import { setStoreOpen, updateStore, claimBrandAuthorisation, decideBrandAuthorisation } from '../src/db/seller-registry';
import {
  browseCategory, browseBrand, categoryBreadcrumbs, childCategories, facets,
  publishableCategoryPaths, publishableBrandSlugs,
  normaliseFilters, assertBrowsablePath,
  LEVEL_FILTER_NOT_BACKED, AGE_BAND_NOT_SET, AGE_UNSTATED_IS_NOT_ALL_AGES,
  MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE,
} from '../src/db/marketplace-browse';
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

/**
 * An approved, publicly visible item.
 *
 * `detail` is written with a direct UPDATE rather than through a seller-facing
 * function, for one reason worth recording: no such function exists yet. The
 * 0029 product-detail block (category, brand, discipline, age suitability,
 * Shotokan relevance) has a schema, a content hash and a reviewer's eyes on it,
 * and nothing in the seller portal writes it. That is a gap in a DIFFERENT
 * slice, and this suite must not paper over it by pretending to a writer — it
 * seeds the columns the browse queries read, exactly as
 * tests/marketplace-platform.test.ts does for the same columns.
 */
async function product(
  sc: any,
  title: string,
  priceMinor: number,
  stock: number,
  detail: Record<string, unknown> = {},
) {
  const created = await createListing(db, ctxOf(sc.principal), {
    title, category: 'equipment', priceMinor,
    media: [{ url: `https://cdn.example.in/${encodeURIComponent(title)}.jpg`, alt: title }],
  });
  const v = await addVariant(db, ctxOf(sc.principal), created.listingId, {
    label: 'Standard', priceMinor,
  });
  if (stock > 0) {
    await receiveStock(db, ctxOf(sc.principal), {
      variantId: v.variantId, locationId: sc.locationId, qty: stock, reason: 'Opening stock',
    });
  }
  await submitListing(db, ctxOf(sc.principal), created.listingId);
  await reviewListing(db, ctxOf(national()), created.listingId, { decision: 'approve', reason: 'Fine.' });

  // Written AFTER approval on purpose: none of these columns feeds the v1 hash
  // when the rest of the block is empty, so the item stays approved and public.
  if (Object.keys(detail).length) {
    await db.update(s.listings).set(detail).where(eq(s.listings.id, created.listingId));
  }
  return { listingId: created.listingId, variantId: v.variantId, ref: created.ref };
}

/** A category id by slug — the taxonomy is adopted, not invented, in beforeAll. */
async function catId(slug: string): Promise<number> {
  const row = (await db.select().from(s.marketplaceCategories)
    .where(eq(s.marketplaceCategories.slug, slug)).limit(1))[0];
  if (!row) throw new Error(`no category ${slug}`);
  return row.id;
}

let HEADGEAR: number, GLOVES: number, GI: number, BOOKS: number;
let ADIDAS: number;
let SHOP: any;

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

  HEADGEAR = await catId('headgear');
  GLOVES = await catId('gloves');
  GI = await catId('karate-gi');
  BOOKS = await catId('books');

  // A brand record. NOTHING IN THE CODEBASE CREATES ONE — there is no
  // createBrand() anywhere — so this insert is the honest way to get a brand
  // into a test, and the absence is reported rather than worked around.
  const [brand] = await db.insert(s.brands)
    .values({ slug: 'kensho', name: 'Kensho', description: 'A brand record, for the test.' })
    .returning();
  ADIDAS = brand.id;

  SHOP = await seller('main');
  await updateStore(db, ctxOf(SHOP.principal), { storeSlug: 'main-supplies' });
}, 180_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('THE PUBLIC PREDICATE decides what is browsable — in the query', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('an approved item in a category is browsable, and the total counts it', async () => {
    const sc = await seller('visible');
    await product(sc, 'Visible headgear', 250000, 4, { categoryId: HEADGEAR });

    const page = await browseCategory(db, { path: 'protective-equipment/headgear' });
    expect(page.category?.slug).toBe('headgear');
    expect(page.items.map((i) => i.title)).toContain('Visible headgear');
    expect(page.total).toBe(page.items.length);
  });

  it('a listing that was never approved is absent from the page AND from the total', async () => {
    const sc = await seller('draft');
    const created = await createListing(db, ctxOf(sc.principal), {
      title: 'Unapproved headgear', category: 'equipment', priceMinor: 100000,
      media: [{ url: 'https://cdn.example.in/x.jpg', alt: 'x' }],
    });
    await db.update(s.listings).set({ categoryId: HEADGEAR }).where(eq(s.listings.id, created.listingId));

    const page = await browseCategory(db, { path: 'protective-equipment/headgear' });
    expect(page.items.map((i) => i.title)).not.toContain('Unapproved headgear');
    // THE ASSERTION THAT MATTERS. A page filtered after the fetch would show the
    // right rows over the wrong number, and the wrong number is the one a
    // reviewer would eventually be asked to explain.
    expect(page.total).toBe(page.items.length);
  });

  it('an item edited since approval leaves the category in the same instant', async () => {
    const sc = await seller('edited');
    const p = await product(sc, 'Edited gloves', 90000, 3, { categoryId: GLOVES });
    const before = await browseCategory(db, { path: 'protective-equipment/gloves' });
    expect(before.items.map((i) => i.title)).toContain('Edited gloves');

    const res = await updateListing(db, ctxOf(sc.principal), p.listingId, { title: 'Edited gloves mk II' });
    expect(res.returnedToReview).toBe(true);

    const after = await browseCategory(db, { path: 'protective-equipment/gloves' });
    expect(after.items.map((i) => i.title)).not.toContain('Edited gloves mk II');
    expect(after.total).toBe(before.total - 1);
  });

  it('a quarantined item is absent while its rows are all still there', async () => {
    const sc = await seller('quarantine');
    const p = await product(sc, 'Suspect headgear', 120000, 2, { categoryId: HEADGEAR });
    const before = await browseCategory(db, { path: 'protective-equipment/headgear' });

    await quarantineListing(db, ctxOf(national()), p.listingId, 'Counterfeit report under investigation.');

    const after = await browseCategory(db, { path: 'protective-equipment/headgear' });
    expect(after.items.map((i) => i.title)).not.toContain('Suspect headgear');
    expect(after.total).toBe(before.total - 1);
    // Nothing was deleted: the listing row survives the withdrawal.
    const row = (await db.select().from(s.listings).where(eq(s.listings.id, p.listingId)))[0];
    expect(row.quarantinedAt).not.toBeNull();
  });

  it('suspending a seller withdraws their whole catalogue from every category at once', async () => {
    const sc = await seller('suspendable');
    await product(sc, 'Doomed gi A', 300000, 5, { categoryId: GI });
    await product(sc, 'Doomed gi B', 400000, 5, { categoryId: GI });
    const before = await browseCategory(db, { path: 'uniforms' });
    expect(before.items.map((i) => i.title)).toContain('Doomed gi A');

    await suspendSeller(db, ctxOf(national()), sc.sellerId, 'Under investigation.');

    const after = await browseCategory(db, { path: 'uniforms' });
    expect(after.items.map((i) => i.title)).not.toContain('Doomed gi A');
    expect(after.items.map((i) => i.title)).not.toContain('Doomed gi B');
    expect(after.total).toBe(before.total - 2);
  });

  it('a seller closing their own shop empties their catalogue without being suspended', async () => {
    const sc = await seller('closer');
    await product(sc, 'Closed shop book', 50000, 5, { categoryId: BOOKS });
    const before = await browseCategory(db, { path: 'books' });
    expect(before.items.map((i) => i.title)).toContain('Closed shop book');

    await setStoreOpen(db, ctxOf(sc.principal), false, 'Away for a fortnight.');

    const after = await browseCategory(db, { path: 'books' });
    expect(after.items.map((i) => i.title)).not.toContain('Closed shop book');
    expect(after.total).toBe(before.total - 1);

    // And the seller is still approved — the two axes did not get confused.
    const row = (await db.select().from(s.sellers).where(eq(s.sellers.id, sc.sellerId)))[0];
    expect(row.status).toBe('approved');
  });

  it('the facet counts obey the same predicate, so a hidden item cannot inflate one', async () => {
    const sc = await seller('facetghost');
    const p = await product(sc, 'Ghost gloves', 111100, 3, { categoryId: GLOVES, discipline: 'ghostwork' });
    const before = await facets(db, 'protective-equipment/gloves');
    expect(before.disciplines.map((d) => d.value)).toContain('ghostwork');

    await quarantineListing(db, ctxOf(national()), p.listingId, 'Withdrawn pending investigation.');

    const after = await facets(db, 'protective-equipment/gloves');
    expect(after.disciplines.map((d) => d.value)).not.toContain('ghostwork');
    expect(after.total).toBe(before.total - 1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('THE SUBTREE MATCH — one prefix, and it cannot be widened', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('a parent shows everything filed under its descendants', async () => {
    const sc = await seller('subtree');
    await product(sc, 'Subtree headgear', 260000, 1, { categoryId: HEADGEAR });
    await product(sc, 'Subtree gloves', 160000, 1, { categoryId: GLOVES });

    const parent = await browseCategory(db, { path: 'protective-equipment', limit: MAX_PAGE_SIZE });
    const titles = parent.items.map((i) => i.title);
    expect(titles).toContain('Subtree headgear');
    expect(titles).toContain('Subtree gloves');
  });

  it('a child does not show its siblings', async () => {
    const page = await browseCategory(db, { path: 'protective-equipment/headgear', limit: MAX_PAGE_SIZE });
    expect(page.items.map((i) => i.title)).not.toContain('Subtree gloves');
  });

  it('the prefix stops at a slash — a category whose NAME starts the same is not swept in', async () => {
    // The bug this catches: `path like 'protective-equipment%'`, without the
    // slash, quietly annexes every category whose slug merely begins with the
    // same letters. It is invisible until somebody adds one.
    const [neighbour] = await db.insert(s.marketplaceCategories).values({
      slug: 'protective-equipmentalia', name: 'Protective equipmentalia',
      path: 'protective-equipmentalia', depth: 0,
    }).returning();
    const sc = await seller('neighbour');
    await product(sc, 'Not really protective', 10000, 1, { categoryId: neighbour.id });

    const page = await browseCategory(db, { path: 'protective-equipment', limit: MAX_PAGE_SIZE });
    expect(page.items.map((i) => i.title)).not.toContain('Not really protective');

    const own = await browseCategory(db, { path: 'protective-equipmentalia' });
    expect(own.items.map((i) => i.title)).toContain('Not really protective');
  });

  it('refuses a path carrying a LIKE wildcard rather than browsing everything', async () => {
    // Parameterisation stops SQL injection and does NOT stop LIKE injection.
    // '%' in the pattern would match every category in the taxonomy.
    for (const bad of ['%', 'protective-equipment/%', '_eadgear', 'Protective Equipment', '../etc', 'a//b']) {
      await expect(browseCategory(db, { path: bad })).rejects.toMatchObject({ code: 'bad_category_path' });
    }
    expect(assertBrowsablePath('/protective-equipment/headgear/')).toBe('protective-equipment/headgear');
  });

  it('an unknown or retired category is null rather than an empty-looking real one', async () => {
    const unknown = await browseCategory(db, { path: 'no-such-category' });
    expect(unknown.category).toBeNull();
    expect(unknown.total).toBe(0);

    const [retired] = await db.insert(s.marketplaceCategories).values({
      slug: 'retired-thing', name: 'Retired thing', path: 'retired-thing', depth: 0, active: false,
    }).returning();
    const sc = await seller('retired');
    await product(sc, 'Item in a retired category', 20000, 1, { categoryId: retired.id });

    const page = await browseCategory(db, { path: 'retired-thing' });
    // The PAGE is gone — there is no browsing a category the federation retired.
    expect(page.category).toBeNull();
    expect(page.items).toEqual([]);
  });

  it('but a retired DESCENDANT keeps its items findable from the parent', async () => {
    // Deactivating a category is a decision about the taxonomy, not about the
    // items already approved under it. Excluding them would leave an item
    // withdrawn from browsing and NOT withdrawn from sale — still on its own
    // page, still in the sitemap, still on its seller's storefront.
    const parentId = await catId('training-equipment');
    const [dead] = await db.insert(s.marketplaceCategories).values({
      slug: 'retired-mitts', name: 'Retired mitts', path: 'training-equipment/retired-mitts',
      depth: 1, parentId, active: false,
    }).returning();
    const sc = await seller('deadchild');
    await product(sc, 'Mitt under a retired node', 30000, 1, { categoryId: dead.id });

    const parent = await browseCategory(db, { path: 'training-equipment', limit: MAX_PAGE_SIZE });
    expect(parent.items.map((i) => i.title)).toContain('Mitt under a retired node');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('THE FILTERS — the ones with a column, and the ones without', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('refuses the brief\'s unbacked filters by name instead of ignoring them', async () => {
    for (const key of ['level', 'beginner', 'competition', 'training', 'purpose']) {
      await expect(
        browseCategory(db, { path: 'books', filters: { [key]: 'x' } as any })
      ).rejects.toMatchObject({ code: 'unsupported_filter' });
    }
    // And the refusal explains itself, because "unsupported" on its own sends
    // the next author to add the column rather than to read why there is none.
    try {
      normaliseFilters({ level: 'beginner' } as any);
      throw new Error('should have refused');
    } catch (err: any) {
      expect(isMarketplaceError(err)).toBe(true);
      expect(err.message).toBe(LEVEL_FILTER_NOT_BACKED);
    }
  });

  it('refuses children/adults with the reason the boundary is not MMAKF\'s to guess', () => {
    for (const key of ['children', 'adults', 'ageBand']) {
      expect(() => normaliseFilters({ [key]: true } as any))
        .toThrowError(AGE_BAND_NOT_SET);
    }
  });

  it('refuses an entirely unknown filter rather than returning the whole catalogue', () => {
    expect(() => normaliseFilters({ colour: 'white' } as any)).toThrowError(/no "colour" filter/);
  });

  it('Shotokan matches only a stated yes — silence is not a no, and not a yes', async () => {
    const sc = await seller('shotokan');
    await product(sc, 'Shotokan gi', 500000, 2, { categoryId: GI, shotokanRelevant: true });
    await product(sc, 'Unstated gi', 500000, 2, { categoryId: GI });
    await product(sc, 'Explicitly not gi', 500000, 2, { categoryId: GI, shotokanRelevant: false });

    const all = await browseCategory(db, { path: 'uniforms/karate-gi', limit: MAX_PAGE_SIZE });
    const only = await browseCategory(db, {
      path: 'uniforms/karate-gi', filters: { shotokan: true }, limit: MAX_PAGE_SIZE,
    });
    const titles = only.items.map((i) => i.title);
    expect(titles).toContain('Shotokan gi');
    expect(titles).not.toContain('Unstated gi');
    expect(titles).not.toContain('Explicitly not gi');
    expect(only.total).toBeLessThan(all.total);
  });

  it('discipline matches exactly and case-insensitively, and never by substring', async () => {
    const sc = await seller('discipline');
    await product(sc, 'Kata belt', 40000, 1, { categoryId: await catId('belts'), discipline: 'Kata' });
    await product(sc, 'Kumite belt', 40000, 1, { categoryId: await catId('belts'), discipline: 'kumite' });

    const kata = await browseCategory(db, {
      path: 'uniforms/belts', filters: { discipline: 'KATA' }, limit: MAX_PAGE_SIZE,
    });
    expect(kata.items.map((i) => i.title)).toEqual(['Kata belt']);

    // A substring match would return both for 'kat'. It returns neither.
    const partial = await browseCategory(db, {
      path: 'uniforms/belts', filters: { discipline: 'kat' }, limit: MAX_PAGE_SIZE,
    });
    expect(partial.items).toEqual([]);
    expect(partial.total).toBe(0);
  });

  it('an age filter never treats "unstated" as "suitable for a child", and says how many it hid', async () => {
    const sc = await seller('ages');
    const cat = await catId('chest-protection');
    await product(sc, 'Junior chest guard', 200000, 1, { categoryId: cat, ageMinYears: 6, ageMaxYears: 12 });
    await product(sc, 'Senior chest guard', 200000, 1, { categoryId: cat, ageMinYears: 16 });
    await product(sc, 'Up-to-twelve guard', 200000, 1, { categoryId: cat, ageMaxYears: 12 });
    await product(sc, 'Unstated guard', 200000, 1, { categoryId: cat });

    const nine = await browseCategory(db, {
      path: 'protective-equipment/chest-protection', filters: { age: 9 }, limit: MAX_PAGE_SIZE,
    });
    const titles = nine.items.map((i) => i.title);
    expect(titles).toContain('Junior chest guard');
    // A one-sided statement is a real statement and is honoured.
    expect(titles).toContain('Up-to-twelve guard');
    expect(titles).not.toContain('Senior chest guard');
    // THE REFUSAL. Nothing is assumed about an item whose seller said nothing.
    expect(titles).not.toContain('Unstated guard');
    expect(nine.excludedForUnstatedAge).toBeGreaterThanOrEqual(1);
    expect(AGE_UNSTATED_IS_NOT_ALL_AGES).toMatch(/not a statement/);

    // No age filter: the count is null rather than zero, because "none were
    // hidden" and "the question was not asked" are different answers.
    const unfiltered = await browseCategory(db, { path: 'protective-equipment/chest-protection' });
    expect(unfiltered.excludedForUnstatedAge).toBeNull();
  });

  it('refuses an age that is not a whole number of years', () => {
    expect(() => normaliseFilters({ age: 9.5 } as any)).toThrowError(/whole number of years/);
    expect(() => normaliseFilters({ age: -1 })).toThrowError(/whole number of years/);
    expect(() => normaliseFilters({ age: 500 })).toThrowError(/whole number of years/);
  });

  it('in-stock is decided by the variant rows, not by the listing roll-up', async () => {
    const sc = await seller('stock');
    const cat = await catId('bags');
    await product(sc, 'Bag with stock', 70000, 3, { categoryId: cat });
    const none = await product(sc, 'Bag with none', 70000, 0, { categoryId: cat });

    // Prove the roll-up and the variant agree today, so the assertion below is
    // about WHICH ONE IS READ rather than about a coincidence.
    const v = (await db.select().from(s.listingVariants)
      .where(eq(s.listingVariants.listingId, none.listingId)))[0];
    expect(v.availableQty).toBe(0);

    const inStock = await browseCategory(db, { path: 'bags', filters: { inStock: true }, limit: MAX_PAGE_SIZE });
    expect(inStock.items.map((i) => i.title)).toContain('Bag with stock');
    expect(inStock.items.map((i) => i.title)).not.toContain('Bag with none');

    const everything = await browseCategory(db, { path: 'bags', limit: MAX_PAGE_SIZE });
    expect(everything.items.map((i) => i.title)).toContain('Bag with none');
    expect(everything.items.find((i) => i.title === 'Bag with none')!.inStock).toBe(false);
    expect(everything.total).toBeGreaterThan(inStock.total);
  });

  it('a price bound is integer minor units, and rupees are refused rather than converted', () => {
    // THERE IS NO RUPEE→PAISE CONVERSION IN THIS MODULE. rupeesToPaise() in the
    // API route is the only one there is, and a second would be a second
    // rounding rule.
    expect(() => normaliseFilters({ priceMinMinor: 450.5 } as any)).toThrowError(/whole number of paise/);
    expect(() => normaliseFilters({ priceMinMinor: -1 })).toThrowError(/whole number of paise/);
    expect(() => normaliseFilters({ priceMinMinor: 90000, priceMaxMinor: 1000 }))
      .toThrowError(/lowest price you gave is above the highest/);
  });

  it('a price band selects on the lowest live variant price', async () => {
    const sc = await seller('prices');
    const cat = await catId('footwear');
    await product(sc, 'Cheap shoes', 100000, 1, { categoryId: cat });
    await product(sc, 'Dear shoes', 900000, 1, { categoryId: cat });

    const cheap = await browseCategory(db, {
      path: 'footwear', filters: { priceMaxMinor: 500000 }, limit: MAX_PAGE_SIZE,
    });
    expect(cheap.items.map((i) => i.title)).toEqual(['Cheap shoes']);
    expect(cheap.total).toBe(1);
  });

  it('refuses an order it does not implement instead of quietly using another', () => {
    expect(() => normaliseFilters({ sort: 'cheapest' } as any)).toThrowError(/no "cheapest" order/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('PAGINATION IS REAL', () => {
// ═════════════════════════════════════════════════════════════════════════════

  const CAT = 'recovery';

  it('reports the true total and walks every page without repeating or losing an item', async () => {
    const sc = await seller('paging');
    const cat = await catId(CAT);
    // ALL AT THE SAME PRICE. Without the id tie-break in the ORDER BY, two of
    // these are free to swap places between page 1 and page 2 — the buyer sees
    // one twice and never sees another.
    for (let i = 0; i < 7; i += 1) await product(sc, `Roller ${i}`, 55500, 1, { categoryId: cat });

    const first = await browseCategory(db, { path: CAT, filters: { sort: 'price_asc' }, limit: 3, offset: 0 });
    expect(first.total).toBe(7);
    expect(first.items).toHaveLength(3);

    const seen = new Set<number>();
    for (let offset = 0; offset < first.total; offset += 3) {
      const page = await browseCategory(db, { path: CAT, filters: { sort: 'price_asc' }, limit: 3, offset });
      for (const item of page.items) seen.add(item.id);
    }
    expect(seen.size).toBe(7);
  });

  it('an offset past the end is an empty page over a true total, not a wrapped one', async () => {
    const page = await browseCategory(db, { path: CAT, limit: 3, offset: 999 });
    expect(page.items).toEqual([]);
    expect(page.total).toBe(7);
    expect(page.offset).toBe(999);
  });

  it('caps a request for an enormous page AND says it did', async () => {
    const page = await browseCategory(db, { path: CAT, limit: 100_000 });
    expect(page.limit).toBe(MAX_PAGE_SIZE);
    expect(page.limitCapped).toBe(true);
    // Nothing is lost: the cap is on one request, not on the catalogue.
    expect(page.total).toBe(7);

    const ordinary = await browseCategory(db, { path: CAT });
    expect(ordinary.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(ordinary.limitCapped).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('THE TREE — breadcrumbs and children', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('breadcrumbs run root first', async () => {
    const crumbs = await categoryBreadcrumbs(db, 'protective-equipment/headgear');
    expect(crumbs.map((c) => c.slug)).toEqual(['protective-equipment', 'headgear']);
    expect(crumbs[0].depth).toBe(0);
  });

  it('breadcrumbs for an unknown path are empty, so a page 404s rather than trailing nowhere', async () => {
    expect(await categoryBreadcrumbs(db, 'not-a-category')).toEqual([]);
  });

  it('children carry a real count of their whole subtree', async () => {
    const roots = await childCategories(db, null);
    const protective = roots.find((c) => c.slug === 'protective-equipment')!;
    expect(protective).toBeTruthy();

    const kids = await childCategories(db, 'protective-equipment');
    const headgear = kids.find((c) => c.slug === 'headgear')!;
    const direct = await browseCategory(db, { path: 'protective-equipment/headgear', limit: MAX_PAGE_SIZE });
    expect(headgear.itemCount).toBe(direct.total);

    // The parent's count is the sum of its subtree, so a parent is never
    // reported as emptier than a child it contains.
    expect(protective.itemCount).toBeGreaterThanOrEqual(headgear.itemCount);
  });

  it('a child with nothing in it reports zero rather than being hidden', async () => {
    const kids = await childCategories(db, 'protective-equipment');
    const foot = kids.find((c) => c.slug === 'foot-protection')!;
    expect(foot).toBeTruthy();
    expect(foot.itemCount).toBe(0);
  });

  it('a retired child is not offered as a place to browse', async () => {
    const kids = await childCategories(db, 'training-equipment');
    expect(kids.map((c) => c.slug)).not.toContain('retired-mitts');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('FACETS — counted from populated columns, never from a word list', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('offers only discipline values that some visible item actually claims', async () => {
    const f = await facets(db, 'uniforms/belts');
    const values = f.disciplines.map((d) => d.value);
    expect(values).toContain('kata');
    expect(values).toContain('kumite');
    // Never a hard-coded vocabulary: nothing claims these, so they are absent.
    expect(values).not.toContain('beginner');
    expect(values).not.toContain('competition');
    for (const d of f.disciplines) expect(d.count).toBeGreaterThan(0);
  });

  it('names the brief\'s filters it cannot honour, each with a reason', async () => {
    const f = await facets(db, 'books');
    expect(f.unavailable.map((u) => u.name).sort())
      .toEqual(['adults', 'beginner', 'children', 'competition', 'training']);
    for (const u of f.unavailable) expect(u.reason.length).toBeGreaterThan(60);
  });

  it('price bands are real prices with real counts, and they add up to the total', async () => {
    const f = await facets(db, 'protective-equipment');
    expect(f.total).toBeGreaterThan(0);
    expect(f.priceBands.length).toBeGreaterThan(0);
    const summed = f.priceBands.reduce((n, b) => n + b.count, 0);
    expect(summed).toBe(f.total);
    for (const b of f.priceBands) {
      expect(Number.isInteger(b.minMinor)).toBe(true);
      expect(Number.isInteger(b.maxMinor)).toBe(true);
      expect(b.minMinor).toBeLessThanOrEqual(b.maxMinor);
      expect(b.count).toBeGreaterThan(0);
    }
    expect(f.priceBands[0].minMinor).toBe(f.priceFloorMinor);
    expect(f.priceBands[f.priceBands.length - 1].maxMinor).toBe(f.priceCeilingMinor);
  });

  it('an empty category is described as empty rather than padded', async () => {
    const f = await facets(db, 'protective-equipment/foot-protection');
    expect(f.total).toBe(0);
    expect(f.disciplines).toEqual([]);
    expect(f.sports).toEqual([]);
    expect(f.priceBands).toEqual([]);
    expect(f.priceFloorMinor).toBeNull();
  });

  it('reports public items filed under NO category, which no category page can reach', async () => {
    const sc = await seller('uncategorised');
    await product(sc, 'Filed nowhere', 12300, 1);   // no categoryId at all

    const root = await facets(db, null);
    expect(root.uncategorised).toBeGreaterThanOrEqual(1);
    // Meaningless inside a subtree, so it is null there rather than zero.
    const sub = await facets(db, 'books');
    expect(sub.uncategorised).toBeNull();
  });

  it('is empty for a category that does not exist, rather than describing the whole marketplace', async () => {
    const f = await facets(db, 'no-such-node');
    expect(f.total).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('BRAND PAGES — a claim by a seller, and what MMAKF verified', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('shows only that brand\'s public items', async () => {
    const sc = await seller('branded');
    await product(sc, 'Kensho mitts', 150000, 2, { categoryId: await catId('mitts'), brandId: ADIDAS });
    await product(sc, 'Unbranded mitts', 150000, 2, { categoryId: await catId('mitts') });

    const page = await browseBrand(db, { slug: 'kensho', limit: MAX_PAGE_SIZE });
    expect(page.brand?.name).toBe('Kensho');
    expect(page.items.map((i) => i.title)).toContain('Kensho mitts');
    expect(page.items.map((i) => i.title)).not.toContain('Unbranded mitts');
    expect(page.total).toBe(page.items.length);
  });

  it('a suspended seller\'s branded stock leaves the brand page too', async () => {
    const sc = await seller('brandsuspend');
    await product(sc, 'Kensho pads', 175000, 2, { categoryId: await catId('pads'), brandId: ADIDAS });
    const before = await browseBrand(db, { slug: 'kensho', limit: MAX_PAGE_SIZE });
    expect(before.items.map((i) => i.title)).toContain('Kensho pads');

    await suspendSeller(db, ctxOf(national()), sc.sellerId, 'Under investigation.');

    const after = await browseBrand(db, { slug: 'kensho', limit: MAX_PAGE_SIZE });
    expect(after.items.map((i) => i.title)).not.toContain('Kensho pads');
    expect(after.total).toBe(before.total - 1);
  });

  it('names a seller as authorised only where a CURRENT verified authorisation exists', async () => {
    const authorised = await seller('authorised');
    const claiming = await seller('claiming');
    const lapsed = await seller('lapsed');
    const cat = await catId('apparel');

    await product(authorised, 'Kensho tee (authorised)', 80000, 1, { categoryId: cat, brandId: ADIDAS });
    await product(claiming, 'Kensho tee (claimed only)', 80000, 1, { categoryId: cat, brandId: ADIDAS });
    await product(lapsed, 'Kensho tee (expired letter)', 80000, 1, { categoryId: cat, brandId: ADIDAS });

    const a = await claimBrandAuthorisation(db, ctxOf(authorised.principal), {
      brandId: ADIDAS, relationship: 'distributor',
    });
    await decideBrandAuthorisation(db, ctxOf(national()), a.authorisationId, {
      status: 'verified', reason: 'Letter seen.',
    });

    // A claim nobody has decided. THE STRING IS NOT THE BADGE.
    await claimBrandAuthorisation(db, ctxOf(claiming.principal), {
      brandId: ADIDAS, relationship: 'distributor',
    });

    // Verified once, and expired. The ordinary failure of every system like
    // this is that it verifies and never looks again.
    const l = await claimBrandAuthorisation(db, ctxOf(lapsed.principal), {
      brandId: ADIDAS, relationship: 'reseller', validTo: '2020-01-01',
    });
    await decideBrandAuthorisation(db, ctxOf(national()), l.authorisationId, {
      status: 'verified', reason: 'Letter seen at the time.',
    });

    const page = await browseBrand(db, { slug: 'kensho', limit: MAX_PAGE_SIZE });
    expect(page.authorisedSellerIds).toContain(authorised.sellerId);
    expect(page.authorisedSellerIds).not.toContain(claiming.sellerId);
    expect(page.authorisedSellerIds).not.toContain(lapsed.sellerId);
  });

  it('an unknown brand is null, and a malformed one is refused', async () => {
    const page = await browseBrand(db, { slug: 'no-such-brand' });
    expect(page.brand).toBeNull();
    expect(page.items).toEqual([]);
    await expect(browseBrand(db, { slug: 'Kensho%' })).rejects.toMatchObject({ code: 'bad_brand_slug' });
  });

  it('applies the same filters and the same refusals as a category page', async () => {
    await expect(browseBrand(db, { slug: 'kensho', filters: { level: 'beginner' } as any }))
      .rejects.toMatchObject({ code: 'unsupported_filter' });

    const cheap = await browseBrand(db, { slug: 'kensho', filters: { priceMaxMinor: 90000 }, limit: MAX_PAGE_SIZE });
    expect(cheap.items.every((i) => i.priceMinor <= 90000)).toBe(true);
    expect(cheap.total).toBe(cheap.items.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('SITEMAP EXPANSION — no doorway pages', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('advertises only categories with something in them, plus their ancestors', async () => {
    const slice = await publishableCategoryPaths(db);
    expect(slice.values).toContain('protective-equipment/headgear');
    // The ancestor of a populated child is itself populated, by definition.
    expect(slice.values).toContain('protective-equipment');
    // Nothing has ever been filed here. A page exists; it is not advertised.
    expect(slice.values).not.toContain('protective-equipment/foot-protection');
    expect(slice.values).not.toContain('federation-merchandise');
    expect(slice.truncated).toBe(false);
  });

  it('never advertises a retired category, even as somebody\'s ancestor', async () => {
    const slice = await publishableCategoryPaths(db);
    expect(slice.values).not.toContain('training-equipment/retired-mitts');
    expect(slice.values).not.toContain('retired-thing');
  });

  it('reports truncation rather than silently dropping the tail', async () => {
    const capped = await publishableCategoryPaths(db, 2);
    expect(capped.values).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it('advertises a brand only once it carries a public item', async () => {
    const [quiet] = await db.insert(s.brands)
      .values({ slug: 'nobody-sells-this', name: 'Nobody sells this' }).returning();
    expect(quiet.id).toBeGreaterThan(0);

    const slice = await publishableBrandSlugs(db);
    expect(slice.values).toContain('kensho');
    expect(slice.values).not.toContain('nobody-sells-this');
  });
});
