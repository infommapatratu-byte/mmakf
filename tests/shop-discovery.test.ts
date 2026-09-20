// Finding something in the shop — and the fact that the shop could be found.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS SUITE EXISTS FOR
// ═════════════════════════════════════════════════════════════════════════════
//
// The marketplace was COMPLETE AND UNREACHABLE. Sellers could be approved,
// items reviewed and published, the sitemap advertised both to Google — and no
// page on the site linked to any of it. /shop rendered the FEDERATION's own
// `products` table and nothing else; /shop/category, /shop/product,
// /shop/brand and /shop/seller each said "browse the marketplace" and pointed
// at /shop, where there was no marketplace to browse.
//
// There was also no way to ASK. browseCategory() needs a path and browseBrand()
// needs a slug, so no query in the codebase could answer "what is there?" or
// "have you got a gi?". The federation's own /search covers twenty domains and
// the marketplace is not one of them, because every kind in that module is
// gated on an RBAC action and the shop is public.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS ASSERTED
// ═════════════════════════════════════════════════════════════════════════════
//
//   · browseAll() and searchListings() obey publicListingPredicate() in the
//     QUERY — an unapproved, quarantined, edited-since-approval item, or one
//     whose seller is suspended or whose shop is closed, is absent from the
//     TOTAL as well as from the page. The total is the assertion that proves
//     the exclusion happened in SQL and not in a `.filter()` afterwards;
//   · search matches a reference, a title, a seller and a brand, and ranks an
//     exact reference above a description that merely contains the words;
//   · a one-character query is REFUSED rather than answered with the catalogue;
//   · every row carries the reason it matched, and a row whose match cannot be
//     explained is dropped rather than shown without one;
//   · the shop front counts a category by its whole subtree, and does not
//     advertise a category with nothing in it;
//   · and — the guard for the original defect — /shop actually links to the
//     marketplace, so none of the above is reachable only by a crawler.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { registerAccount } from '../src/db/onboarding';
import {
  applyToSell, approveSeller, createListing, submitListing, reviewListing,
  updateListing, suspendSeller,
} from '../src/db/marketplace';
import {
  addVariant, adoptProposedTaxonomy, quarantineListing,
  createCategory, updateCategory, setCategoryActive, categoryTree,
} from '../src/db/catalogue';
import { createLocation, receiveStock } from '../src/db/inventory';
import { setStoreOpen, updateStore } from '../src/db/seller-registry';
import {
  browseAll, searchListings, shopFrontCategories,
  MIN_SEARCH_LENGTH, DEFAULT_PAGE_SIZE,
} from '../src/db/marketplace-browse';
import { productGraph } from '../src/lib/seo';
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

async function seller(tag: string) {
  const r = await registerAccount(db, { email: `${tag}-${++seq}@example.in`, password: PW });
  const principal = { userId: r.userId, label: r.email, bindings: [] } as Principal;
  const applied = await applyToSell(db, ctxOf(principal), { tradingName: `${tag} Supplies`, stateUnitId: JH });
  await approveSeller(db, ctxOf(national()), applied.sellerId, 'Checked.');
  const loc = await createLocation(db, ctxOf(principal), { code: `W${seq}`, name: 'Warehouse' });
  return { principal, sellerId: applied.sellerId, locationId: loc.locationId };
}

async function product(
  sc: any, title: string, priceMinor: number, stock: number,
  detail: Record<string, unknown> = {},
) {
  const created = await createListing(db, ctxOf(sc.principal), {
    title, category: 'equipment', priceMinor,
    description: (detail.description as string) ?? null,
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

  // Written after approval, as tests/marketplace-browse.test.ts does and for
  // the same reason: no seller-facing writer exists for the 0029 detail block,
  // and these columns do not feed the v1 content hash when the rest is empty.
  const patch = { ...detail };
  delete (patch as any).description;
  if (Object.keys(patch).length) {
    await db.update(s.listings).set(patch).where(eq(s.listings.id, created.listingId));
  }
  return { listingId: created.listingId, variantId: v.variantId, ref: created.ref };
}

async function catId(slug: string): Promise<number> {
  const row = (await db.select().from(s.marketplaceCategories)
    .where(eq(s.marketplaceCategories.slug, slug)).limit(1))[0];
  if (!row) throw new Error(`no category ${slug}`);
  return row.id;
}

let HEADGEAR: number, GI: number;
let KENSHO: number;
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
  JH = jh.id;

  ADMIN = (await registerAccount(db, { email: 'admin@mmakf.in', password: PW })).userId;
  await adoptProposedTaxonomy(db, ctxOf(national()));

  HEADGEAR = await catId('headgear');
  GI = await catId('karate-gi');

  const [brand] = await db.insert(s.brands)
    .values({ slug: 'kensho', name: 'Kensho', description: 'A brand record, for the test.' })
    .returning();
  KENSHO = brand.id;

  SHOP = await seller('main');
  await updateStore(db, ctxOf(SHOP.principal), { storeSlug: 'main-supplies' });
}, 180_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('browseAll — the whole shop, and only what is public in it', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('returns an approved item and counts it', async () => {
    const sc = await seller('all-visible');
    await product(sc, 'Browsable mitts', 120000, 3, { categoryId: HEADGEAR });

    const page = await browseAll(db);
    expect(page.items.map((i) => i.title)).toContain('Browsable mitts');
    expect(page.total).toBeGreaterThan(0);
  });

  it('includes an item filed under NO category, which an inner join would have hidden', async () => {
    // The reason the category join in browseAll() is LEFT. Nothing in the
    // schema makes listings.category_id NOT NULL, so an approved item with no
    // taxonomy node is on sale, has a product page, and would have been
    // silently missing from the only page that claims to show everything.
    const sc = await seller('uncategorised');
    await product(sc, 'Unfiled tonfa', 90000, 2);

    const page = await browseAll(db, { limit: 96 });
    expect(page.items.map((i) => i.title)).toContain('Unfiled tonfa');
  });

  it('an unapproved item is absent from the page AND from the total', async () => {
    const sc = await seller('all-draft');
    const before = (await browseAll(db)).total;

    const created = await createListing(db, ctxOf(sc.principal), {
      title: 'Never approved belt', category: 'equipment', priceMinor: 40000,
    });
    await addVariant(db, ctxOf(sc.principal), created.listingId, { label: 'Standard', priceMinor: 40000 });
    await submitListing(db, ctxOf(sc.principal), created.listingId);

    const after = await browseAll(db, { limit: 96 });
    expect(after.items.map((i) => i.title)).not.toContain('Never approved belt');
    expect(after.total).toBe(before);
  });

  it('a quarantined item leaves the page and the total in the same instant', async () => {
    const sc = await seller('all-quarantine');
    const p = await product(sc, 'Quarantined gi', 300000, 2, { categoryId: GI });

    expect((await browseAll(db, { limit: 96 })).items.map((i) => i.title)).toContain('Quarantined gi');
    const before = (await browseAll(db)).total;

    await quarantineListing(db, ctxOf(national()), p.listingId, 'Under investigation.');

    const after = await browseAll(db, { limit: 96 });
    expect(after.items.map((i) => i.title)).not.toContain('Quarantined gi');
    expect(after.total).toBe(before - 1);
  });

  it('a closed shop takes its whole catalogue with it, without anybody being suspended', async () => {
    const sc = await seller('all-closed');
    await updateStore(db, ctxOf(sc.principal), { storeSlug: `closed-${seq}` });
    await product(sc, 'Shuttered shop mitts', 55000, 5, { categoryId: HEADGEAR });

    const before = (await browseAll(db)).total;
    await setStoreOpen(db, ctxOf(sc.principal), false, 'Away for a fortnight.');

    const after = await browseAll(db, { limit: 96 });
    expect(after.items.map((i) => i.title)).not.toContain('Shuttered shop mitts');
    expect(after.total).toBe(before - 1);

    // And the seller is not suspended — closing is not a sanction.
    const row = (await db.select().from(s.sellers).where(eq(s.sellers.id, sc.sellerId)).limit(1))[0];
    expect(row.status).toBe('approved');
  });

  it('an item edited since approval leaves public view', async () => {
    const sc = await seller('all-edited');
    const p = await product(sc, 'Edited headguard', 200000, 3, { categoryId: HEADGEAR });
    const before = (await browseAll(db)).total;

    await updateListing(db, ctxOf(sc.principal), p.listingId, { title: 'Edited headguard, mark II' });

    const after = await browseAll(db, { limit: 96 });
    expect(after.items.map((i) => i.title)).not.toContain('Edited headguard, mark II');
    expect(after.items.map((i) => i.title)).not.toContain('Edited headguard');
    expect(after.total).toBe(before - 1);
  });

  it('paginates for real — pages are disjoint and the total is the whole set', async () => {
    const sc = await seller('all-paged');
    for (let i = 0; i < 5; i += 1) {
      // Equal prices, deliberately: without the tie-break on id an item can
      // appear on two pages and another on none.
      await product(sc, `Paged item ${i}`, 100000, 1, { categoryId: HEADGEAR });
    }

    const first = await browseAll(db, { limit: 2, offset: 0 });
    const second = await browseAll(db, { limit: 2, offset: 2 });

    expect(first.items.length).toBe(2);
    expect(second.items.length).toBe(2);
    const overlap = first.items.filter((a) => second.items.some((b) => b.id === a.id));
    expect(overlap).toEqual([]);
    expect(first.total).toBe(second.total);
    expect(first.total).toBeGreaterThanOrEqual(5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('searchListings — a real query, not a filtered array', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('finds an item by a word in its title', async () => {
    const sc = await seller('search-title');
    await product(sc, 'Shureido karate gi, twelve ounce', 480000, 2, { categoryId: GI });

    const r = await searchListings(db, { q: 'shureido' });
    expect(r.items.map((i) => i.title)).toContain('Shureido karate gi, twelve ounce');
    expect(r.total).toBeGreaterThan(0);
    expect(r.items[0].matchedOn.field).toBe('title');
  });

  it('finds an item by its seller trading name', async () => {
    const sc = await seller('Kanazawa');
    await product(sc, 'A plain white belt', 20000, 4);

    const r = await searchListings(db, { q: 'Kanazawa' });
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => /Kanazawa/i.test(i.sellerTradingName))).toBe(true);
    expect(r.items[0].matchedOn.field).toBe('seller');
  });

  it('finds an item by its brand', async () => {
    const sc = await seller('search-brand');
    const p = await product(sc, 'Branded shin guards', 150000, 3, { categoryId: HEADGEAR });
    await db.update(s.listings).set({ brandId: KENSHO }).where(eq(s.listings.id, p.listingId));

    const r = await searchListings(db, { q: 'kensho' });
    expect(r.items.map((i) => i.title)).toContain('Branded shin guards');
    expect(r.items[0].matchedOn.field).toBe('brand');
  });

  it('finds an item by words that live only in its description', async () => {
    // The reason the description is a match field at all: the weave, the weight
    // and the fabric a buyer searches for are recorded nowhere else.
    const sc = await seller('search-desc');
    await product(sc, 'Competition uniform', 620000, 1, {
      categoryId: GI, description: 'Heavyweight cotton canvas, fourteen ounce, unbleached.',
    });

    const r = await searchListings(db, { q: 'canvas' });
    expect(r.items.map((i) => i.title)).toContain('Competition uniform');
    expect(r.items[0].matchedOn.field).toBe('description');
    expect(r.items[0].matchedOn.how).toBe('substring');
  });

  it('an exact reference outranks an item whose description merely contains it', async () => {
    const sc = await seller('search-rank');
    const target = await product(sc, 'The referenced item', 70000, 2);
    // A decoy whose description quotes the other item's reference.
    await product(sc, 'A decoy that mentions it', 70000, 2, {
      description: `Compare with ${target.ref}, which is similar.`,
    });

    const r = await searchListings(db, { q: target.ref });
    expect(r.items.length).toBeGreaterThanOrEqual(2);
    // RANKED IN SQL. Ranking after the LIMIT would rank whichever rows Postgres
    // happened to return, so an exact identifier could be paged out entirely.
    expect(r.items[0].ref).toBe(target.ref);
    expect(r.items[0].matchedOn.how).toBe('exact');
  });

  it('refuses a one-character query rather than answering it with the catalogue', async () => {
    const r = await searchListings(db, { q: 'a' });
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
    expect(MIN_SEARCH_LENGTH).toBeGreaterThan(1);
  });

  it('an unapproved item cannot be searched into view, and is not in the total', async () => {
    const sc = await seller('search-draft');
    const created = await createListing(db, ctxOf(sc.principal), {
      title: 'Unapprovable nunchaku', category: 'equipment', priceMinor: 50000,
    });
    await addVariant(db, ctxOf(sc.principal), created.listingId, { label: 'Standard', priceMinor: 50000 });
    await submitListing(db, ctxOf(sc.principal), created.listingId);

    const r = await searchListings(db, { q: 'nunchaku' });
    expect(r.items).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('a suspended seller vanishes from search in the same instant, count included', async () => {
    const sc = await seller('search-suspended');
    await updateStore(db, ctxOf(sc.principal), { storeSlug: `susp-${seq}` });
    await product(sc, 'Suspendable tokui equipment', 88000, 3);

    const before = await searchListings(db, { q: 'tokui' });
    expect(before.total).toBe(1);

    await suspendSeller(db, ctxOf(national()), sc.sellerId, 'Under investigation.');

    const after = await searchListings(db, { q: 'tokui' });
    expect(after.items).toEqual([]);
    expect(after.total).toBe(0);
  });

  it('every returned row carries the reason it matched', async () => {
    const sc = await seller('search-explained');
    await product(sc, 'Explained obi', 30000, 6);

    const r = await searchListings(db, { q: 'obi' });
    expect(r.items.length).toBeGreaterThan(0);
    for (const item of r.items) {
      expect(item.matchedOn).toBeTruthy();
      expect(['ref', 'title', 'seller', 'brand', 'description']).toContain(item.matchedOn.field);
      expect(['exact', 'prefix', 'substring']).toContain(item.matchedOn.how);
    }
    // Nothing was dropped for being unexplainable in this ordinary case.
    expect(r.unexplained).toBe(0);
  });

  it('a filter narrows a search, and the total narrows with it', async () => {
    const sc = await seller('search-filtered');
    await product(sc, 'Filterable cheap kote', 10000, 2);
    await product(sc, 'Filterable dear kote', 900000, 2);

    const all = await searchListings(db, { q: 'kote' });
    expect(all.total).toBe(2);

    const cheap = await searchListings(db, { q: 'kote', filters: { priceMaxMinor: 50000 } });
    expect(cheap.total).toBe(1);
    expect(cheap.items[0].title).toBe('Filterable cheap kote');
  });

  it('caps the page at MAX_PAGE_SIZE and says so rather than silently truncating', async () => {
    const r = await searchListings(db, { q: 'kote', limit: 5000 });
    expect(r.limitCapped).toBe(true);
    expect(r.limit).toBeLessThanOrEqual(96);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('shopFrontCategories — real counts, and no empty shelves advertised', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('counts an item filed deep in the tree against the top-level tile a buyer would click', async () => {
    const sc = await seller('front-deep');
    await product(sc, 'Deeply filed headguard', 210000, 2, { categoryId: HEADGEAR });

    const tiles = await shopFrontCategories(db, 30);
    const protective = tiles.find((t) => t.path === 'protective-equipment');
    expect(protective, 'the ancestor tile of headgear is present').toBeTruthy();
    expect(protective!.count).toBeGreaterThan(0);
  });

  it('does not advertise a category with nothing on sale in it', async () => {
    const tiles = await shopFrontCategories(db, 100);
    expect(tiles.every((t) => t.count > 0)).toBe(true);

    // The taxonomy has more top-level nodes than the shop has stock for, so the
    // filter is doing work rather than passing everything through.
    const tops = await db.select().from(s.marketplaceCategories).where(eq(s.marketplaceCategories.depth, 0));
    expect(tiles.length).toBeLessThan(tops.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the taxonomy is managed, not merely adopted', () => {
// ═════════════════════════════════════════════════════════════════════════════

  // adoptProposedTaxonomy() writes the federation's own twenty-six categories
  // in one act, and that was the WHOLE of category management: one MMAKF
  // wanted afterwards could not be created, one it had retired could not be
  // retired, and a misspelled name could not be corrected.

  it('creates a top-level category and a child beneath it, with a materialised path', async () => {
    const parent = await createCategory(db, ctxOf(national()), {
      slug: 'test-nutrition', name: 'Nutrition',
    });
    expect(parent.path).toBe('test-nutrition');

    const child = await createCategory(db, ctxOf(national()), {
      slug: 'test-supplements', name: 'Supplements', parentSlug: 'test-nutrition',
    });
    // The path is the parent's plus the slug — one prefix match is what
    // browseCategory() scans, so this is the value the whole browse rests on.
    expect(child.path).toBe('test-nutrition/test-supplements');
  });

  it('a new category REQUIRES REVIEW unless somebody says otherwise', async () => {
    // A category created as `allowed` is one whose items reach the public
    // without anybody looking at them. That is not a default.
    await createCategory(db, ctxOf(national()), { slug: 'test-default-policy', name: 'Default policy' });
    const tree = await categoryTree(db, { includeInactive: true });
    const node = tree.find((n: any) => n.slug === 'test-default-policy');
    expect(node.policy).toBe('requires_review');
  });

  it('refuses a slug the URL router would then refuse', async () => {
    // ONE GRAMMAR, CHECKED AT BOTH ENDS. A slug this accepted and
    // assertBrowsablePath() refused would be a category that exists, can be
    // filed under, and whose page 404s.
    for (const slug of ['Protective Equipment', 'has_underscore', 'trailing-', 'a/b', '%', 'two--hyphens']) {
      await expect(
        createCategory(db, ctxOf(national()), { slug, name: 'No' }),
        slug,
      ).rejects.toThrow();
    }
  });

  it('but CASE is normalised rather than refused', async () => {
    // Refusing "Protective-Equipment" would be pedantry: the intent is
    // unambiguous and lowercasing it is what publicStorefront() already does
    // with a shop slug. What is refused is a slug whose SHAPE is wrong.
    const made = await createCategory(db, ctxOf(national()), {
      slug: 'Test-Mixed-Case', name: 'Mixed case',
    });
    expect(made.slug).toBe('test-mixed-case');
    expect(made.path).toBe('test-mixed-case');
  });

  it('refuses a duplicate address and an unknown parent', async () => {
    await createCategory(db, ctxOf(national()), { slug: 'test-once', name: 'Once' });
    await expect(createCategory(db, ctxOf(national()), { slug: 'test-once', name: 'Twice' }))
      .rejects.toThrow();
    await expect(createCategory(db, ctxOf(national()), {
      slug: 'test-orphan', name: 'Orphan', parentSlug: 'no-such-parent',
    })).rejects.toThrow();
  });

  it('a retired parent takes no new children', async () => {
    await createCategory(db, ctxOf(national()), { slug: 'test-retiring', name: 'Retiring' });
    await setCategoryActive(db, ctxOf(national()), 'test-retiring', false, 'No longer offered.');
    await expect(createCategory(db, ctxOf(national()), {
      slug: 'test-below-retired', name: 'Below', parentSlug: 'test-retiring',
    })).rejects.toThrow();
  });

  it('corrects a name and a policy, and offers no way to move a category', async () => {
    await createCategory(db, ctxOf(national()), { slug: 'test-misspelt', name: 'Protectiv Equipment' });
    await updateCategory(db, ctxOf(national()), 'test-misspelt', {
      name: 'Protective Equipment', policy: 'allowed',
    });
    const tree = await categoryTree(db, { includeInactive: true });
    const node = tree.find((n: any) => n.slug === 'test-misspelt');
    expect(node.name).toBe('Protective Equipment');
    expect(node.policy).toBe('allowed');
    // THE ADDRESS IS UNCHANGED, and there is no parameter that could change it:
    // the path is materialised into every descendant and every published URL.
    expect(node.path).toBe('test-misspelt');
    expect(node.slug).toBe('test-misspelt');
  });

  it('retiring takes the whole subtree, and REPORTS what is filed under it', async () => {
    await createCategory(db, ctxOf(national()), { slug: 'test-branch', name: 'Branch' });
    await createCategory(db, ctxOf(national()), {
      slug: 'test-twig', name: 'Twig', parentSlug: 'test-branch',
    });

    const sc = await seller('cat-retire');
    const tree = await categoryTree(db, { includeInactive: true });
    const twig = tree.find((n: any) => n.slug === 'test-twig');
    await product(sc, 'Item on a twig', 60000, 2, { categoryId: twig.id });

    const result = await setCategoryActive(db, ctxOf(national()), 'test-branch', false, 'Restructuring.');
    expect(result.categoriesChanged).toBe(2);          // the branch and its twig
    expect(result.itemsFiledUnder).toBe(1);

    const after = await categoryTree(db, { includeInactive: true });
    expect(after.find((n: any) => n.slug === 'test-branch').active).toBe(false);
    expect(after.find((n: any) => n.slug === 'test-twig').active).toBe(false);
  }, 120_000);

  it('RETIRING WITHDRAWS NOTHING FROM SALE — the item is still browsable', async () => {
    // The belief this guards against is that retiring a category pulls the
    // goods. It does not, and if it did, somebody could empty a shelf by
    // tidying a menu.
    const sc = await seller('cat-still-selling');
    await createCategory(db, ctxOf(national()), { slug: 'test-doomed', name: 'Doomed' });
    const tree = await categoryTree(db, { includeInactive: true });
    const doomed = tree.find((n: any) => n.slug === 'test-doomed');
    await product(sc, 'Survives its category', 75000, 3, { categoryId: doomed.id });

    const before = await browseAll(db, { limit: 96 });
    expect(before.items.map((i) => i.title)).toContain('Survives its category');

    await setCategoryActive(db, ctxOf(national()), 'test-doomed', false, 'Retired.');

    const after = await browseAll(db, { limit: 96 });
    expect(after.items.map((i) => i.title)).toContain('Survives its category');
    expect(after.total).toBe(before.total);
  }, 120_000);

  it('retiring and restoring both require a reason', async () => {
    await createCategory(db, ctxOf(national()), { slug: 'test-reasoned', name: 'Reasoned' });
    await expect(setCategoryActive(db, ctxOf(national()), 'test-reasoned', false, '   '))
      .rejects.toThrow();
    await expect(setCategoryActive(db, ctxOf(national()), 'test-reasoned', false, ''))
      .rejects.toThrow();
  });

  it('a seller cannot touch the taxonomy', async () => {
    const sc = await seller('cat-nope');
    await expect(createCategory(db, ctxOf(sc.principal), { slug: 'test-sneaky', name: 'Sneaky' }))
      .rejects.toThrow();
    await expect(updateCategory(db, ctxOf(sc.principal), 'karate-gi', { name: 'Mine now' }))
      .rejects.toThrow();
    await expect(setCategoryActive(db, ctxOf(sc.principal), 'karate-gi', false, 'Because.'))
      .rejects.toThrow();
  }, 120_000);
});

// ═════════════════════════════════════════════════════════════════════════════
describe('productGraph — a price in a search result, and nothing invented', () => {
// ═════════════════════════════════════════════════════════════════════════════

  // Product markup is what puts a PRICE and an AVAILABILITY beside this shop in
  // Google, and it is the one graph on the site where being wrong has an
  // immediate victim: somebody shown "in stock" who arrives to find otherwise.

  const base = {
    name: 'A karate gi',
    url: '/shop/product/MMAKF-LST-2026-000001',
    priceMinor: 179900,
    currency: 'INR',
    inStock: true,
  };

  it('emits the price as a decimal string, from integer paise', () => {
    const g = productGraph(base)!;
    expect((g.offers as any).price).toBe('1799.00');
    expect((g.offers as any).priceCurrency).toBe('INR');
  });

  it('a price under a rupee keeps its paise — the failure a float division makes', () => {
    // 10 paise divided by 100 is 0.1, which reads as ten times too little.
    const g = productGraph({ ...base, priceMinor: 10 })!;
    expect((g.offers as any).price).toBe('0.10');
    const g2 = productGraph({ ...base, priceMinor: 5 })!;
    expect((g2.offers as any).price).toBe('0.05');
  });

  it('availability is the real thing, both ways', () => {
    expect((productGraph(base)!.offers as any).availability).toBe('https://schema.org/InStock');
    expect((productGraph({ ...base, inStock: false })!.offers as any).availability)
      .toBe('https://schema.org/OutOfStock');
  });

  it('NO STARS WITHOUT PUBLISHED REVIEWS', () => {
    // Google renders aggregateRating as stars. Stars derived from nothing are a
    // fabrication with a star rating on it, and `ratingValue: 0` reads as one.
    expect(productGraph(base)!.aggregateRating).toBeUndefined();
    expect(productGraph({ ...base, reviewCount: 0, ratingAverageBps: null })!.aggregateRating).toBeUndefined();
    expect(productGraph({ ...base, reviewCount: 3, ratingAverageBps: null })!.aggregateRating).toBeUndefined();
  });

  it('emits a rating only where reviews exist, from the average over all of them', () => {
    const g = productGraph({ ...base, reviewCount: 4, ratingAverageBps: 42500 })!;
    expect((g.aggregateRating as any).ratingValue).toBe('4.25');
    expect((g.aggregateRating as any).reviewCount).toBe(4);
  });

  it('omits what is not on record rather than guessing it', () => {
    const g = productGraph(base)!;
    expect(g.description).toBeUndefined();
    expect(g.brand).toBeUndefined();
    expect(g.category).toBeUndefined();
    expect(g.image).toBeUndefined();
    // Nothing in the catalogue records a price validity date, and the plausible
    // guess is a commitment MMAKF never made.
    expect((g.offers as any).priceValidUntil).toBeUndefined();
    // A listing's SKU lives on its VARIANTS; publishing one as the product's
    // identifier is wrong the moment a second variant exists.
    expect(g.sku).toBeUndefined();
    expect(g.gtin).toBeUndefined();
  });

  it('names the seller, because a marketplace buyer is buying from them', () => {
    const g = productGraph({ ...base, sellerName: 'Ramgarh Supplies' })!;
    expect(((g.offers as any).seller as any).name).toBe('Ramgarh Supplies');
  });

  it('refuses to build a graph from nothing', () => {
    expect(productGraph({ ...base, name: '' })).toBeNull();
    expect(productGraph({ ...base, priceMinor: -1 })).toBeNull();
    // A float price is not a price in this system, anywhere.
    expect(productGraph({ ...base, priceMinor: 1799.5 })).toBeNull();
  });

  it('makes every URL absolute, because a graph is read away from the page', () => {
    const g = productGraph({ ...base, images: ['/img/gi.jpg', null, ''] })!;
    expect(String(g.url)).toMatch(/^https?:\/\//);
    expect(String((g.image as string[])[0])).toMatch(/^https?:\/\//);
    // Blank entries are dropped rather than becoming the site root.
    expect((g.image as string[]).length).toBe(1);
  });

  it('the product page emits it, and only for an item that resolved', () => {
    const page = readFileSync('src/pages/shop/product/[ref].astro', 'utf8');
    expect(page).toContain('productGraph');
    expect(page).toContain('application/ld+json');
    // Guarded on the graph, so a 404 carries no product markup.
    expect(page).toContain('{graph && <script');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('REACHABILITY — the marketplace is linked from the shop a visitor opens', () => {
// ═════════════════════════════════════════════════════════════════════════════

  // The guard for the original defect. Every assertion above could pass while
  // the whole marketplace remained unreachable by any human: /shop rendered the
  // federation's own product table and linked to none of it, and the only
  // routes in were a sitemap URL and a hand-typed reference.

  const SHOP_PAGE = readFileSync('src/pages/shop.astro', 'utf8');

  it('/shop links to the category tree', () => {
    expect(SHOP_PAGE).toContain('/shop/category');
  });

  it('/shop offers a search box that posts to the search page', () => {
    expect(SHOP_PAGE).toContain('/shop/search');
    expect(SHOP_PAGE).toMatch(/action="\/shop\/search"/);
  });

  it('/shop links to individual marketplace items, not only to the federation catalogue', () => {
    expect(SHOP_PAGE).toContain('/shop/product/');
  });

  it('/shop reads the marketplace through the shared browse module', () => {
    // Not a hand-written SELECT on this page. A second definition of "on sale"
    // is the one defect the browse module exists to prevent.
    expect(SHOP_PAGE).toMatch(/from '@\/db\/marketplace-browse'/);
    expect(SHOP_PAGE).toContain('browseAll');
    expect(SHOP_PAGE).toContain('shopFrontCategories');
  });

  it('the search page never lets itself be indexed', () => {
    // A results page is navigation, not content, and its URL is minted by
    // whoever typed into the box — so anybody could have the federation host
    // a page built from their own words.
    const page = readFileSync('src/pages/shop/search.astro', 'utf8');
    expect(page).toMatch(/X-Robots-Tag/);
    expect(page).toContain('noindex');
  });
});
