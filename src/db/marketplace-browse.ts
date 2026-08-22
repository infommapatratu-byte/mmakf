// Browsing the marketplace — category subtrees, brand pages, facets and real
// pagination.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS MODULE EXISTS TO CLOSE
// ═════════════════════════════════════════════════════════════════════════════
//
// The taxonomy shipped with migration 0029 and `adoptProposedTaxonomy()` writes
// twenty-six categories into it. A seller files an item under one. A reviewer
// approves it. And then there was NOWHERE TO BROWSE IT: the only public entry
// points were /shop/product/[ref], which needs the reference of the item you
// were already looking for, and /shop/seller/[slug], which needs to know whose
// shop it is. A buyer who wanted headgear for a nine-year-old had no route to
// it at all, and neither did a search engine — so the federation was carrying
// the cost of moderating a catalogue nobody could reach.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE ONE RULE EVERY QUERY IN THIS FILE OBEYS
// ═════════════════════════════════════════════════════════════════════════════
//
// EVERY public read goes through `publicListingPredicate()` from
// '@/db/onboarding.schema', in the WHERE clause, before a row is fetched.
//
// It is not re-implemented here and nothing is filtered after fetching. That is
// not a style preference — it is the only reason the following five facts hold
// on a browse page for the same reason they hold on the product page:
//
//   · an unapproved item is absent;
//   · an item edited since approval is absent;
//   · a quarantined item is absent;
//   · a suspended seller's whole catalogue is absent, in the same instant;
//   · a closed shop's whole catalogue is absent, without suspending anybody.
//
// A `.filter()` after the fetch would produce the same page today and a wrong
// COUNT immediately (the count query and the row query would disagree), a wrong
// facet the day after, and an item nobody approved on the day somebody added a
// third caller. Four callers already share this predicate; this module is the
// fifth, and it adds no sixth definition.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY A PREFIX MATCH AND NOT A RECURSIVE QUERY
// ═════════════════════════════════════════════════════════════════════════════
//
// `marketplace_categories.path` is MATERIALISED ANCESTRY —
// 'protective-equipment/headgear' — maintained by src/db/catalogue.ts on write.
// So "everything under protective equipment" is
//
//     path = 'protective-equipment' or path like 'protective-equipment/%'
//
// which is ONE index scan on `marketplace_categories_path_idx`. A recursive CTE
// would walk the tree on every page load to rediscover an answer already stored
// in the row, and it is the shape that is fine at forty categories and
// pathological at four hundred. The comment on the table says so; this module
// is the caller that has to mean it.
//
// The path arriving from a URL is VALIDATED against a slug grammar before it is
// interpolated (see `assertBrowsablePath`). Two reasons, and the second is the
// one people forget: parameters stop SQL injection, and they do NOT stop LIKE
// injection — a path containing `%` would be a wildcard inside the pattern and
// would match categories the caller never named.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE FILTERS THE BRIEF NAMES, AND WHICH OF THEM ARE REAL
// ═════════════════════════════════════════════════════════════════════════════
//
// The brief asks for: Shotokan · kata · kumite · beginner · competition ·
// training · children · adults. Mapped onto columns that actually exist on
// `listings`, they fall into three groups.
//
// HONOURED, because a column holds the answer:
//
//   Shotokan   → `listings.shotokan_relevant`, a real boolean the seller sets
//                and a reviewer sees. NULL is UNSTATED and is not matched:
//                a seller who never answered has not said "no", and has not
//                said "yes" either.
//   kata /     → `listings.discipline`. Free text, seller-declared, with no
//   kumite       controlled vocabulary anywhere in this codebase — so the
//                values on offer are NOT hard-coded here. `facets()` reads the
//                distinct values that are actually present in the subtree, with
//                their counts, and the surface offers only those. A "kata"
//                filter therefore appears exactly when some item in view claims
//                the discipline "kata", and can never be a control that matches
//                nothing.
//   children / → `listings.age_min_years` / `age_max_years`, but NOT as two
//   adults       buttons. See AGE_BAND_NOT_SET below: MMAKF has published no
//                age at which a product stops being a child's, and this module
//                will not invent one. The buyer states an age; the query
//                returns items whose own stated range covers it.
//   price band → `listings.price_minor`, which src/db/catalogue.ts maintains as
//                the LOWEST live variant price. The bands are not thresholds
//                somebody chose — see `facets()`.
//   in stock   → `listing_variants.available_qty`, per the brief, and as an
//                EXISTS in SQL rather than the `listings.stock_qty` roll-up,
//                because the roll-up is a cache and the variant rows are the
//                thing the reservation actually reads.
//
// REFUSED, because no column backs them:
//
//   beginner · competition · training
//
// There is no skill-level column, no intended-use column and no purpose column
// on `listings`, and nothing in migration 0029 or 0025 adds one. A control
// labelled "Beginner" that resolved to `discipline ilike '%beginner%'` would
// return an arbitrary handful of items whose sellers happened to type the word,
// and a buyer would read the empty result as "MMAKF sells nothing for
// beginners". THE CONTROL IS THEREFORE ABSENT (§70) — not disabled, not
// present-and-ignored — and `LEVEL_FILTER_NOT_BACKED` says so in words, once,
// where a future author will find it before re-adding the control.
//
// Two of those three words are, however, CATEGORIES in the adopted taxonomy:
// 'training-equipment', 'kata-equipment', 'kumite-equipment'. Browsing a
// category is how the federation's own taxonomy answers that question, and the
// surface links there instead of pretending to a filter.
//
// ═════════════════════════════════════════════════════════════════════════════
// PAGINATION IS REAL
// ═════════════════════════════════════════════════════════════════════════════
//
// Every browse returns a TOTAL from a count query that shares its WHERE clause
// with the row query — literally the same array of predicates, built once by
// `browseWhere()` and handed to both. A page that showed "24 items" because 24
// is where the LIMIT fell, on a category holding four hundred, is the failure
// this replaces; and a count computed from a second, hand-written copy of the
// filter is the same failure with a longer fuse.
//
// The ORDER always ends in a tie-break on id. Without it Postgres may order two
// equally-priced rows differently between page 1 and page 2, and the buyer sees
// one item twice and never sees another at all.

import { and, asc, desc, eq, gte, lte, or, sql, type SQL } from 'drizzle-orm';
import * as s from '@/db/schema';
import { publicListingPredicate } from '@/db/onboarding.schema';
import { MarketplaceError } from '@/db/marketplace';
import { categoryAncestry, verifiedBrandAuthorisation } from '@/db/catalogue';

type DB = any;

// ─── What MMAKF has not decided, said out loud ──────────────────────────────

/**
 * Why there is no "Beginner", "Competition" or "Training" control.
 *
 * Exported rather than written into a page, so that the one place this is
 * explained is the place a future author lands in when they wonder where the
 * control went — and so a test can assert the surface says it.
 */
export const LEVEL_FILTER_NOT_BACKED =
  'The brief names "beginner", "competition" and "training" as filters. No column ' +
  'on a listing records a skill level or an intended use, so there is nothing to ' +
  'filter on and no control is offered — a control that quietly matched a handful ' +
  'of items whose seller happened to type the word would read as "MMAKF sells ' +
  'nothing for beginners". Kata, kumite and training equipment are CATEGORIES in ' +
  'the adopted taxonomy, and browsing one is the answer that does exist.';

/**
 * Why "children" and "adults" are one age box and not two buttons.
 *
 * A child/adult boundary for PRODUCT SUITABILITY is a federation decision that
 * has not been made. MINOR_AGE in src/lib/registration.ts is eighteen and is
 * the age of majority for CONSENT — reusing it here would quietly announce that
 * MMAKF considers a seventeen-year-old's sparring gloves children's equipment,
 * which the federation has never said and which no reviewer approved.
 */
export const AGE_BAND_NOT_SET =
  'MMAKF has published no age at which a product stops being a child\'s and ' +
  'becomes an adult\'s, so this page offers no "children" and "adults" buttons. ' +
  'State an age and it will show the items whose sellers stated a suitable age ' +
  'range that covers it.';

/**
 * The rule that makes the age filter safe, and the reason its result looks thin.
 *
 * `age_min_years` NULL means UNSTATED. It does not mean "suitable for
 * everyone", and src/db/catalogue.ts keeps those two apart everywhere for the
 * reason this constant records: an unstated age read as "all ages" on a piece
 * of protective equipment is the exact shape of a harm this system exists to
 * prevent. So an item that states nothing is EXCLUDED from an age-filtered
 * result, and the count of what was excluded is returned so the surface can say
 * so rather than leaving the buyer to think the shelf is empty.
 */
export const AGE_UNSTATED_IS_NOT_ALL_AGES =
  'Items whose seller stated no age suitability are not shown when you filter by ' +
  'age. An unstated age is not a statement that something is safe for a child.';

/**
 * What the facet counts mean, exactly.
 *
 * They describe the CATEGORY SUBTREE, not the filter combination currently
 * applied. Recomputing every count against every other selected filter is one
 * query per facet per keystroke, and the version of that which people ship is a
 * cached count that is silently wrong. A number that is stated to be
 * unconditional is honest; a number that looks conditional and is not, is not.
 */
export const FACET_COUNTS_ARE_UNCONDITIONAL =
  'These counts describe everything in this category and below it, not the ' +
  'filters you have selected.';

// ─── Bounds ─────────────────────────────────────────────────────────────────

/** Items per page when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 24;

/**
 * The largest page a caller may ask for.
 *
 * A CEILING ON ONE REQUEST, NOT A CEILING ON THE CATALOGUE. Nothing is
 * truncated: `total` is the real count and the offset reaches every row. It
 * exists so that `?limit=100000` is a slow page rather than a way to make the
 * federation's database serve a full catalogue dump to anybody who asks. When
 * it bites, the result says so in `limitCapped` and the surface prints it.
 */
export const MAX_PAGE_SIZE = 96;

/** How many price bands `facets()` will describe. See the band note there. */
export const PRICE_BAND_COUNT = 4;

/** Sitemap caps, matching the shape SITEMAP_LISTING_CAP uses in marketplace.ts. */
export const SITEMAP_CATEGORY_CAP = 500;
export const SITEMAP_BRAND_CAP = 500;

// ─── Types ──────────────────────────────────────────────────────────────────

export type BrowseSort = 'newest' | 'price_asc' | 'price_desc';

export const BROWSE_SORTS: readonly BrowseSort[] = ['newest', 'price_asc', 'price_desc'];

export interface BrowseFilters {
  /** Only items whose seller asserted Shotokan relevance. NULL is not "no". */
  shotokan?: boolean;
  /** An exact (case-insensitive) match on `listings.discipline`. */
  discipline?: string | null;
  /** An exact (case-insensitive) match on `listings.sport`. */
  sport?: string | null;
  /** Items whose stated age range covers this age. See AGE_BAND_NOT_SET. */
  age?: number | null;
  /** Only items with a live variant carrying stock. */
  inStock?: boolean;
  /** INTEGER MINOR UNITS. There is no rupee→paise conversion in this module. */
  priceMinMinor?: number | null;
  priceMaxMinor?: number | null;
  sort?: BrowseSort;
}

/** The filters as the query actually applied them, for the surface to echo. */
export interface AppliedFilters {
  shotokan: boolean;
  discipline: string | null;
  sport: string | null;
  age: number | null;
  inStock: boolean;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  sort: BrowseSort;
  /** True when any of the above narrows the result. */
  any: boolean;
}

export interface BrowseItem {
  id: number;
  ref: string;
  title: string;
  description: string | null;
  /** The LOWEST live variant price, in integer minor units. */
  priceMinor: number;
  currency: string;
  variantCount: number;
  inStock: boolean;
  image: string | null;
  imageAlt: string | null;
  sellerTradingName: string;
  sellerStoreSlug: string | null;
  brandName: string | null;
  brandSlug: string | null;
  categoryName: string | null;
  categoryPath: string | null;
  shotokanRelevant: boolean | null;
  discipline: string | null;
  ageMinYears: number | null;
  ageMaxYears: number | null;
}

export interface BrowsePage {
  items: BrowseItem[];
  /** The REAL number of matching items, from a count sharing the row WHERE. */
  total: number;
  limit: number;
  offset: number;
  /** True when the caller asked for a bigger page than MAX_PAGE_SIZE. */
  limitCapped: boolean;
  filters: AppliedFilters;
  /**
   * How many items the age filter removed for stating no age at all. Null when
   * no age filter is applied. See AGE_UNSTATED_IS_NOT_ALL_AGES.
   */
  excludedForUnstatedAge: number | null;
}

export interface CategoryBrowse extends BrowsePage {
  /** The node itself. NULL means no such active category — the page 404s. */
  category: CategoryNode | null;
}

export interface BrandBrowse extends BrowsePage {
  brand: BrandNode | null;
  /**
   * Seller ids on THIS PAGE that hold a current verified authorisation for this
   * brand. Resolved through verifiedBrandAuthorisation() — see the note there.
   */
  authorisedSellerIds: number[];
}

export interface CategoryNode {
  id: number;
  slug: string;
  name: string;
  path: string;
  depth: number;
  description: string | null;
}

export interface BrandNode {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  website: string | null;
  logoUrl: string | null;
}

export interface ChildCategory extends CategoryNode {
  /** Public items in this child AND everything below it. A real count. */
  itemCount: number;
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface PriceBand {
  /** Both edges are REAL PRICES of real items. See the note in facets(). */
  minMinor: number;
  maxMinor: number;
  count: number;
}

export interface Facets {
  path: string | null;
  total: number;
  /** Items whose seller ticked Shotokan relevance, and those who left it blank. */
  shotokanRelevant: number;
  shotokanUnstated: number;
  inStock: number;
  disciplines: FacetValue[];
  sports: FacetValue[];
  /** Items stating at least one age bound, and those stating none. */
  ageStated: number;
  ageUnstated: number;
  ageLowestStated: number | null;
  ageHighestStated: number | null;
  priceFloorMinor: number | null;
  priceCeilingMinor: number | null;
  priceBands: PriceBand[];
  /**
   * Public items filed under NO taxonomy node, so unreachable from any category
   * page. Computed only at the root (path null), where it is meaningful.
   */
  uncategorised: number | null;
  /** The brief's filters this deployment cannot honour, with the reason. */
  unavailable: { name: string; reason: string }[];
}

// ─── Input validation ───────────────────────────────────────────────────────

/**
 * A category path from a URL, or a refusal.
 *
 * The grammar is the slug grammar `adoptProposedTaxonomy()` writes: lowercase
 * alphanumerics and single hyphens, separated by single slashes. Everything
 * else is refused BEFORE it reaches a LIKE pattern.
 *
 * Parameterisation is not enough on its own here. A parameterised
 * `path like $1 || '/%'` is injection-proof and is still WRONG if $1 contains
 * `%` or `_`, because those are wildcards inside the pattern and the caller
 * would be browsing categories they never named. Validating the grammar removes
 * both characters, and the refusal is a 404 on the page rather than a silent
 * wider match.
 */
const PATH_GRAMMAR = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

export function assertBrowsablePath(path: string): string {
  const p = String(path ?? '').trim().toLowerCase().replace(/^\/+|\/+$/g, '');
  if (!p || !PATH_GRAMMAR.test(p) || p.length > 200) {
    throw new MarketplaceError(
      'bad_category_path',
      'That is not a category address. A category address is made of lowercase words joined by hyphens, ' +
      'and its ancestors joined by slashes — for example protective-equipment/headgear.'
    );
  }
  return p;
}

/** A brand slug from a URL. Same reasoning as the path, minus the slashes. */
const SLUG_GRAMMAR = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertBrandSlug(slug: string): string {
  const v = String(slug ?? '').trim().toLowerCase();
  if (!v || !SLUG_GRAMMAR.test(v) || v.length > 120) {
    throw new MarketplaceError(
      'bad_brand_slug',
      'That is not a brand address. A brand address is lowercase words joined by hyphens.'
    );
  }
  return v;
}

/** Every filter key this module understands. Anything else is refused. */
const KNOWN_FILTER_KEYS = new Set([
  'shotokan', 'discipline', 'sport', 'age', 'inStock',
  'priceMinMinor', 'priceMaxMinor', 'sort',
]);

/**
 * The brief's filter names that map onto no column, and what to say instead.
 *
 * REFUSED RATHER THAN IGNORED. A caller — a hand-typed URL, a future page, an
 * integration — that asks for `level: 'beginner'` and receives an unfiltered
 * result would present the whole catalogue as "beginner equipment". Silently
 * dropping an unknown filter is the same defect as a control that matches
 * nothing, arriving through a different door.
 */
const REFUSED_FILTER_KEYS: Record<string, string> = {
  level: LEVEL_FILTER_NOT_BACKED,
  beginner: LEVEL_FILTER_NOT_BACKED,
  competition: LEVEL_FILTER_NOT_BACKED,
  training: LEVEL_FILTER_NOT_BACKED,
  purpose: LEVEL_FILTER_NOT_BACKED,
  children: AGE_BAND_NOT_SET,
  adults: AGE_BAND_NOT_SET,
  ageBand: AGE_BAND_NOT_SET,
};

export function normaliseFilters(raw: BrowseFilters | null | undefined): AppliedFilters {
  const f: Record<string, unknown> = (raw ?? {}) as any;

  for (const key of Object.keys(f)) {
    if (f[key] === undefined) continue;
    if (REFUSED_FILTER_KEYS[key]) {
      throw new MarketplaceError('unsupported_filter', REFUSED_FILTER_KEYS[key]);
    }
    if (!KNOWN_FILTER_KEYS.has(key)) {
      throw new MarketplaceError(
        'unknown_filter',
        `There is no "${key}" filter on the marketplace. The filters that exist are: ` +
        `${[...KNOWN_FILTER_KEYS].join(', ')}.`
      );
    }
  }

  const text = (v: unknown): string | null => {
    const t = String(v ?? '').trim().toLowerCase();
    return t ? t.slice(0, 60) : null;
  };

  // MONEY IS INTEGER MINOR UNITS. A float here would be rupees arriving from
  // somewhere that thought it could convert them, and this module is not that
  // place — rupeesToPaise() in the API route is the only conversion there is.
  const priceBound = (v: unknown, which: string): number | null => {
    if (v == null || v === '') return null;
    if (!Number.isInteger(v) || (v as number) < 0) {
      throw new MarketplaceError(
        'bad_price_filter',
        `A ${which} price must be a whole number of paise, zero or more. ₹450.50 is 45050.`
      );
    }
    return v as number;
  };

  const priceMinMinor = priceBound(f.priceMinMinor, 'lowest');
  const priceMaxMinor = priceBound(f.priceMaxMinor, 'highest');
  if (priceMinMinor != null && priceMaxMinor != null && priceMinMinor > priceMaxMinor) {
    // Refused rather than swapped. Swapping guesses what somebody meant and
    // then shows them a result they cannot explain; refusing tells them.
    throw new MarketplaceError(
      'bad_price_range',
      'The lowest price you gave is above the highest. Nothing could match that, so nothing was searched.'
    );
  }

  let age: number | null = null;
  if (f.age != null && f.age !== '') {
    if (!Number.isInteger(f.age) || (f.age as number) < 0 || (f.age as number) > 120) {
      throw new MarketplaceError(
        'bad_age',
        'An age is a whole number of years between 0 and 120.'
      );
    }
    age = f.age as number;
  }

  const sort = (f.sort ?? 'newest') as BrowseSort;
  if (!BROWSE_SORTS.includes(sort)) {
    throw new MarketplaceError(
      'bad_sort',
      `There is no "${String(f.sort)}" order. Choose one of: ${BROWSE_SORTS.join(', ')}.`
    );
  }

  const applied: AppliedFilters = {
    shotokan: f.shotokan === true,
    discipline: text(f.discipline),
    sport: text(f.sport),
    age,
    inStock: f.inStock === true,
    priceMinMinor,
    priceMaxMinor,
    sort,
    any: false,
  };
  applied.any = !!(applied.shotokan || applied.discipline || applied.sport
    || applied.age != null || applied.inStock
    || applied.priceMinMinor != null || applied.priceMaxMinor != null);
  return applied;
}

function normalisePaging(limit?: number | null, offset?: number | null) {
  const askedFor = Number.isInteger(limit) ? (limit as number) : DEFAULT_PAGE_SIZE;
  const capped = askedFor > MAX_PAGE_SIZE;
  return {
    limit: Math.min(MAX_PAGE_SIZE, Math.max(1, askedFor)),
    offset: Number.isInteger(offset) ? Math.max(0, offset as number) : 0,
    limitCapped: capped,
  };
}

// ─── The SQL fragments, written once ────────────────────────────────────────

/**
 * "Has something a buyer could actually put in a basket."
 *
 * `listing_variants.available_qty` per the brief, and NOT `listings.stock_qty`.
 * The roll-up column is a cache maintained by refreshListingFromVariants(); the
 * variant rows are what a reservation reads. Using the cache would eventually
 * show "in stock" on an item whose last variant was sold in the second between
 * the sale and the refresh — and the buyer would meet `insufficient_stock` at
 * checkout with no idea why.
 *
 * `status <> 'discontinued'` because a discontinued variant may still carry a
 * quantity that is being returned or written off; it is not for sale.
 */
function hasStock(): SQL {
  return sql`exists (
    select 1 from ${s.listingVariants} v
     where v.listing_id = ${s.listings.id}
       and v.status <> 'discontinued'
       and v.available_qty > 0
  )`;
}

/** The subtree of one materialised path. ONE prefix match, never a recursion. */
function inSubtree(path: string): SQL {
  return or(
    eq(s.marketplaceCategories.path, path),
    sql`${s.marketplaceCategories.path} like ${path + '/'} || '%'`,
  ) as SQL;
}

function filterPredicates(f: AppliedFilters): SQL[] {
  const out: SQL[] = [];

  // NULL is not FALSE. A seller who never answered the Shotokan question has
  // not said the item is irrelevant to Shotokan; they have said nothing, and a
  // filter that treated silence as an answer would publish the silence as one.
  if (f.shotokan) out.push(eq(s.listings.shotokanRelevant, true) as SQL);

  if (f.discipline) out.push(sql`lower(${s.listings.discipline}) = ${f.discipline}`);
  if (f.sport) out.push(sql`lower(${s.listings.sport}) = ${f.sport}`);
  if (f.inStock) out.push(hasStock());
  if (f.priceMinMinor != null) out.push(gte(s.listings.priceMinor, f.priceMinMinor) as SQL);
  if (f.priceMaxMinor != null) out.push(lte(s.listings.priceMinor, f.priceMaxMinor) as SQL);

  // ── The age rule, and why it is three clauses rather than one ─────────────
  //
  // 1. the item must state AT LEAST ONE bound — an item stating nothing is
  //    excluded, because unstated is not "all ages" (AGE_UNSTATED_IS_NOT_ALL_AGES);
  // 2. a stated LOWER bound must not be above the age;
  // 3. a stated UPPER bound must not be below it.
  //
  // A one-sided statement is honoured on its own terms: "up to 12 years" is a
  // real statement about a nine-year-old, and demanding both bounds would
  // discard it. Requiring both would also, in this catalogue, discard almost
  // everything — and a filter that returns nothing is read as an empty shelf.
  if (f.age != null) {
    const n = f.age;
    out.push(sql`(
      (${s.listings.ageMinYears} is not null or ${s.listings.ageMaxYears} is not null)
      and (${s.listings.ageMinYears} is null or ${s.listings.ageMinYears} <= ${n})
      and (${s.listings.ageMaxYears} is null or ${s.listings.ageMaxYears} >= ${n})
    )`);
  }

  return out;
}

/**
 * The complete WHERE for a browse, built ONCE and handed to both the row query
 * and the count query.
 *
 * This is the function that makes "PAGINATION MUST BE REAL" true. Two
 * hand-written copies of the same conditions produce a page of 24 items over a
 * stated total of 31 that nobody can reconcile, and the direction of the error
 * is unpredictable because it depends on which copy somebody last edited.
 */
function browseWhere(scope: SQL[], f: AppliedFilters): SQL {
  return and(publicListingPredicate(), ...scope, ...filterPredicates(f)) as SQL;
}

function orderFor(sort: BrowseSort) {
  // EVERY ordering ends in a tie-break on id. Two items at ₹1,799 have no
  // defined relative order without one, so Postgres is free to return them in
  // a different order for `offset 0` and `offset 24` — which shows the buyer
  // one item twice and hides another entirely. The bug is invisible in testing
  // with distinct prices and immediate in a real catalogue full of round
  // numbers.
  switch (sort) {
    case 'price_asc': return [asc(s.listings.priceMinor), desc(s.listings.id)];
    case 'price_desc': return [desc(s.listings.priceMinor), desc(s.listings.id)];
    case 'newest':
    default: return [desc(s.listings.updatedAt), desc(s.listings.id)];
  }
}

/** The columns a browse card needs. An ALLOW-LIST, not a `select *`. */
const ITEM_COLUMNS = {
  id: s.listings.id,
  ref: s.listings.ref,
  title: s.listings.title,
  description: s.listings.description,
  priceMinor: s.listings.priceMinor,
  currency: s.listings.currency,
  variantCount: s.listings.variantCount,
  shotokanRelevant: s.listings.shotokanRelevant,
  discipline: s.listings.discipline,
  ageMinYears: s.listings.ageMinYears,
  ageMaxYears: s.listings.ageMaxYears,
  sellerId: s.listings.sellerId,
  sellerTradingName: s.sellers.tradingName,
  sellerStoreSlug: s.sellers.storeSlug,
  inStock: sql<boolean>`(exists (
    select 1 from ${s.listingVariants} v
     where v.listing_id = ${s.listings.id}
       and v.status <> 'discontinued'
       and v.available_qty > 0
  ))`,
  image: sql<string | null>`(
    select url from listing_media
     where listing_id = ${s.listings.id}
     order by sort_order asc limit 1
  )`,
  imageAlt: sql<string | null>`(
    select alt from listing_media
     where listing_id = ${s.listings.id}
     order by sort_order asc limit 1
  )`,
};

function shapeItem(r: any, extra: Partial<BrowseItem> = {}): BrowseItem {
  return {
    id: r.id,
    ref: r.ref,
    title: r.title,
    description: r.description ?? null,
    priceMinor: r.priceMinor,
    currency: r.currency ?? 'INR',
    variantCount: r.variantCount ?? 0,
    inStock: !!r.inStock,
    image: r.image ?? null,
    imageAlt: r.imageAlt ?? null,
    sellerTradingName: r.sellerTradingName,
    sellerStoreSlug: r.sellerStoreSlug ?? null,
    brandName: r.brandName ?? null,
    brandSlug: r.brandSlug ?? null,
    categoryName: r.categoryName ?? null,
    categoryPath: r.categoryPath ?? null,
    shotokanRelevant: r.shotokanRelevant ?? null,
    discipline: r.discipline ?? null,
    ageMinYears: r.ageMinYears ?? null,
    ageMaxYears: r.ageMaxYears ?? null,
    ...extra,
  };
}

/**
 * How many items the age filter removed for stating no age at all.
 *
 * The SAME scope and the SAME other filters, with the age clause replaced by
 * its complement. Counted rather than estimated, because the sentence the page
 * prints — "eleven more items are in this category but state no age" — is a
 * claim about the federation's own catalogue and must be true.
 */
async function countUnstatedAge(db: DB, base: (w: SQL) => any, scope: SQL[], f: AppliedFilters): Promise<number> {
  const withoutAge: AppliedFilters = { ...f, age: null };
  const where = and(
    publicListingPredicate(),
    ...scope,
    ...filterPredicates(withoutAge),
    sql`${s.listings.ageMinYears} is null and ${s.listings.ageMaxYears} is null`,
  ) as SQL;
  const rows = await base(where);
  return rows[0]?.n ?? 0;
}

// ─── Category browse ────────────────────────────────────────────────────────

/**
 * Everything on public sale in a category and below it.
 *
 * THE JOIN ONTO `marketplace_categories` DOES NOT REQUIRE THE NODE TO BE ACTIVE,
 * and that is deliberate. Deactivating a category is a decision about the
 * TAXONOMY; it is not a decision about the items already approved under it. If
 * this query demanded `active`, deactivating 'mitts' would make every approved
 * mitt unfindable from 'training-equipment' while remaining on its own product
 * page, in the sitemap, and on its seller's storefront — withdrawn from
 * browsing and not withdrawn from sale, which is the worst of both. The node
 * the caller NAMED must be active (there is no page for a retired category),
 * and its descendants are counted whether or not the federation still offers
 * them as a place to file something new.
 */
export async function browseCategory(
  db: DB,
  opts: { path: string; filters?: BrowseFilters | null; limit?: number | null; offset?: number | null }
): Promise<CategoryBrowse> {
  const path = assertBrowsablePath(opts.path);
  const filters = normaliseFilters(opts.filters);
  const { limit, offset, limitCapped } = normalisePaging(opts.limit, opts.offset);

  const node = (await db.select({
    id: s.marketplaceCategories.id,
    slug: s.marketplaceCategories.slug,
    name: s.marketplaceCategories.name,
    path: s.marketplaceCategories.path,
    depth: s.marketplaceCategories.depth,
    description: s.marketplaceCategories.description,
  }).from(s.marketplaceCategories)
    .where(and(eq(s.marketplaceCategories.path, path), eq(s.marketplaceCategories.active, true)))
    .limit(1))[0] ?? null;

  const empty: CategoryBrowse = {
    category: node, items: [], total: 0, limit, offset, limitCapped, filters,
    excludedForUnstatedAge: null,
  };
  if (!node) return empty;

  const scope = [inSubtree(path)];
  const where = browseWhere(scope, filters);

  const rowsQuery = (w: SQL) => db.select({
    ...ITEM_COLUMNS,
    brandName: s.brands.name,
    brandSlug: s.brands.slug,
    categoryName: s.marketplaceCategories.name,
    categoryPath: s.marketplaceCategories.path,
  })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.listings.sellerId, s.sellers.id))
    .innerJoin(s.marketplaceCategories, eq(s.listings.categoryId, s.marketplaceCategories.id))
    .leftJoin(s.brands, eq(s.listings.brandId, s.brands.id))
    .where(w);

  const countQuery = (w: SQL) => db.select({ n: sql<number>`count(*)::int` })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.listings.sellerId, s.sellers.id))
    .innerJoin(s.marketplaceCategories, eq(s.listings.categoryId, s.marketplaceCategories.id))
    .where(w);

  // Sequential, not Promise.all. The row query and the count query run against
  // one connection in every environment this is tested in, and interleaving
  // them buys nothing measurable while making a failure harder to read.
  const rows = await rowsQuery(where).orderBy(...orderFor(filters.sort)).limit(limit).offset(offset);
  const counted = await countQuery(where);

  return {
    ...empty,
    items: rows.map((r: any) => shapeItem(r)),
    total: counted[0]?.n ?? 0,
    excludedForUnstatedAge: filters.age == null
      ? null
      : await countUnstatedAge(db, countQuery, scope, filters),
  };
}

// ─── Brand browse ───────────────────────────────────────────────────────────

/**
 * Everything on public sale carrying one brand.
 *
 * A BRAND ON A LISTING IS A CLAIM BY ITS SELLER — see docs/marketplace. This
 * page therefore groups items by what sellers said, and says nothing about
 * whether MMAKF agrees. Where the federation HAS verified a seller's
 * authorisation for the brand, that fact is available in `authorisedSellerIds`.
 *
 * AND IT IS RESOLVED BY CALLING verifiedBrandAuthorisation() ONCE PER SELLER ON
 * THE PAGE, not by a second copy of its rule in this query's SQL. That rule is
 * four conditions — verified, not revoked, valid_from reached, valid_to not
 * passed — and the fourth is the one every system like this gets wrong, by
 * checking once and never looking again. A copy of it here would be a copy that
 * drifts, and the drift renders an expired letter of authorisation as a live
 * endorsement of somebody's stock. The cost is one query per distinct seller in
 * a page of at most MAX_PAGE_SIZE items; that is a bounded N and a deliberate
 * trade, and it is written down here so nobody "optimises" it into a join.
 */
export async function browseBrand(
  db: DB,
  opts: { slug: string; filters?: BrowseFilters | null; limit?: number | null; offset?: number | null }
): Promise<BrandBrowse> {
  const slug = assertBrandSlug(opts.slug);
  const filters = normaliseFilters(opts.filters);
  const { limit, offset, limitCapped } = normalisePaging(opts.limit, opts.offset);

  const brand = (await db.select({
    id: s.brands.id,
    slug: s.brands.slug,
    name: s.brands.name,
    description: s.brands.description,
    website: s.brands.website,
    logoUrl: s.brands.logoUrl,
  }).from(s.brands).where(eq(s.brands.slug, slug)).limit(1))[0] ?? null;

  const empty: BrandBrowse = {
    brand, items: [], total: 0, limit, offset, limitCapped, filters,
    excludedForUnstatedAge: null, authorisedSellerIds: [],
  };
  if (!brand) return empty;

  const scope = [eq(s.listings.brandId, brand.id) as SQL];
  const where = browseWhere(scope, filters);

  const rowsQuery = (w: SQL) => db.select({
    ...ITEM_COLUMNS,
    categoryName: s.marketplaceCategories.name,
    categoryPath: s.marketplaceCategories.path,
  })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.listings.sellerId, s.sellers.id))
    // LEFT join onto the taxonomy: a brand page must show an item whose seller
    // has not filed it under a category. The category page cannot (there is no
    // node to browse it from), which is exactly why facets() reports how many
    // such items exist.
    .leftJoin(s.marketplaceCategories, eq(s.listings.categoryId, s.marketplaceCategories.id))
    .where(w);

  const countQuery = (w: SQL) => db.select({ n: sql<number>`count(*)::int` })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.listings.sellerId, s.sellers.id))
    .where(w);

  const rows = await rowsQuery(where).orderBy(...orderFor(filters.sort)).limit(limit).offset(offset);
  const counted = await countQuery(where);

  const items = rows.map((r: any) => shapeItem(r, { brandName: brand.name, brandSlug: brand.slug }));

  const sellerIds: number[] = [...new Set<number>(rows.map((r: any) => Number(r.sellerId)))];
  const authorised: number[] = [];
  for (const sellerId of sellerIds) {
    if (await verifiedBrandAuthorisation(db, brand.id, sellerId)) authorised.push(sellerId);
  }

  return {
    ...empty,
    items,
    total: counted[0]?.n ?? 0,
    authorisedSellerIds: authorised,
    excludedForUnstatedAge: filters.age == null
      ? null
      : await countUnstatedAge(db, countQuery, scope, filters),
  };
}

// ─── The tree ───────────────────────────────────────────────────────────────

/**
 * A category's ancestry, ROOT FIRST, ready for <Base breadcrumbs>.
 *
 * Built by resolving the node and then calling categoryAncestry() in
 * src/db/catalogue.ts, which already orders by the PATH rather than by id — so
 * a category moved under a new parent reports where it is now, not where it
 * was. Re-deriving the ancestry from the path string here would be a second
 * implementation of that ordering, and the second one is the one that keeps the
 * old tree.
 *
 * Returns [] for an unknown or inactive path, which the page renders as a 404
 * rather than as a trail to nowhere.
 */
export async function categoryBreadcrumbs(db: DB, path: string): Promise<CategoryNode[]> {
  const p = assertBrowsablePath(path);
  const node = (await db.select({ id: s.marketplaceCategories.id })
    .from(s.marketplaceCategories)
    .where(and(eq(s.marketplaceCategories.path, p), eq(s.marketplaceCategories.active, true)))
    .limit(1))[0];
  if (!node) return [];

  const ancestry = await categoryAncestry(db, node.id);
  return ancestry.map((c: any) => ({
    id: c.id, slug: c.slug, name: c.name, path: c.path, depth: c.depth,
    description: c.description ?? null,
  }));
}

/**
 * The direct children of a category — or the roots, when `path` is null.
 *
 * Each carries a REAL count of the public items in its own subtree, so the
 * surface can say "Headgear (12)" and "Gloves (0)" instead of offering
 * twenty-six identical links, six of which lead to an empty page. Rendering a
 * link with no count is how a taxonomy becomes a maze.
 *
 * TWO QUERIES, NOT ONE PER CHILD. The second groups every public item in the
 * parent's subtree by its own category path and the counts are summed into the
 * children here. A correlated subquery per child would be N queries and — worse
 * — would have to restate publicListingPredicate() in raw SQL to do it.
 */
export async function childCategories(db: DB, path: string | null): Promise<ChildCategory[]> {
  const p = path == null || path === '' ? null : assertBrowsablePath(path);

  let parentId: number | null = null;
  if (p !== null) {
    const node = (await db.select({ id: s.marketplaceCategories.id })
      .from(s.marketplaceCategories)
      .where(and(eq(s.marketplaceCategories.path, p), eq(s.marketplaceCategories.active, true)))
      .limit(1))[0];
    if (!node) return [];
    parentId = node.id;
  }

  const children = await db.select({
    id: s.marketplaceCategories.id,
    slug: s.marketplaceCategories.slug,
    name: s.marketplaceCategories.name,
    path: s.marketplaceCategories.path,
    depth: s.marketplaceCategories.depth,
    description: s.marketplaceCategories.description,
  }).from(s.marketplaceCategories)
    .where(and(
      eq(s.marketplaceCategories.active, true),
      parentId == null
        ? sql`${s.marketplaceCategories.parentId} is null`
        : eq(s.marketplaceCategories.parentId, parentId),
    ))
    .orderBy(asc(s.marketplaceCategories.sortOrder), asc(s.marketplaceCategories.name));

  if (!children.length) return [];

  const perPath = await db.select({
    path: s.marketplaceCategories.path,
    n: sql<number>`count(*)::int`,
  })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.listings.sellerId, s.sellers.id))
    .innerJoin(s.marketplaceCategories, eq(s.listings.categoryId, s.marketplaceCategories.id))
    .where(p === null
      ? (publicListingPredicate() as SQL)
      : and(publicListingPredicate(), inSubtree(p)) as SQL)
    .groupBy(s.marketplaceCategories.path);

  return children.map((c: any) => ({
    id: c.id, slug: c.slug, name: c.name, path: c.path, depth: c.depth,
    description: c.description ?? null,
    itemCount: perPath.reduce(
      (n: number, r: any) =>
        n + (r.path === c.path || String(r.path).startsWith(`${c.path}/`) ? r.n : 0),
      0,
    ),
  }));
}

// ─── Facets ─────────────────────────────────────────────────────────────────

/**
 * What is actually in this subtree, with counts, from populated columns only.
 *
 * EVERY NUMBER HERE IS COUNTED, NOT ESTIMATED, and every value on offer came
 * out of the data. `disciplines` and `sports` are not a hard-coded list of
 * words from the brief — they are `group by lower(column)` over the items in
 * view, so a control for "kata" exists exactly when an item in view claims the
 * discipline "kata". That is what makes it impossible for this surface to offer
 * a filter that matches nothing.
 *
 * THE PRICE BANDS DESERVE THEIR OWN PARAGRAPH. Their edges are not thresholds
 * anybody chose: MMAKF has published no price bands and this module will not
 * invent "under ₹500". They are computed with `ntile()` over the DISTINCT
 * PRICES PRESENT, so each band's edges are real prices of real items and each
 * band's count is the real number of items between them. ntile divides the
 * number of ROWS, never an amount of money — there is no division of money
 * anywhere in this file, which is what tests/money-safety.test.ts is there to
 * keep true.
 *
 * FOUR QUERIES, and they are separate on purpose: one filtered-aggregate roll
 * up, one discipline grouping, one sport grouping, one band computation. Fusing
 * them into a single statement with cross joins produces a query nobody can
 * read and a plan nobody can predict, for one network round trip.
 */
export async function facets(db: DB, path: string | null): Promise<Facets> {
  const p = path == null || path === '' ? null : assertBrowsablePath(path);

  const unavailable = [
    { name: 'beginner', reason: LEVEL_FILTER_NOT_BACKED },
    { name: 'competition', reason: LEVEL_FILTER_NOT_BACKED },
    { name: 'training', reason: LEVEL_FILTER_NOT_BACKED },
    { name: 'children', reason: AGE_BAND_NOT_SET },
    { name: 'adults', reason: AGE_BAND_NOT_SET },
  ];

  const blank: Facets = {
    path: p, total: 0, shotokanRelevant: 0, shotokanUnstated: 0, inStock: 0,
    disciplines: [], sports: [], ageStated: 0, ageUnstated: 0,
    ageLowestStated: null, ageHighestStated: null,
    priceFloorMinor: null, priceCeilingMinor: null, priceBands: [],
    uncategorised: null, unavailable,
  };

  if (p !== null) {
    const node = (await db.select({ id: s.marketplaceCategories.id })
      .from(s.marketplaceCategories)
      .where(and(eq(s.marketplaceCategories.path, p), eq(s.marketplaceCategories.active, true)))
      .limit(1))[0];
    if (!node) return blank;
  }

  const where = p === null
    ? (publicListingPredicate() as SQL)
    : and(publicListingPredicate(), inSubtree(p)) as SQL;

  // One builder, so the four aggregate reads below cannot disagree about what
  // "in this subtree and public" means.
  const from = (sel: Record<string, unknown>) => db.select(sel)
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.listings.sellerId, s.sellers.id))
    .innerJoin(s.marketplaceCategories, eq(s.listings.categoryId, s.marketplaceCategories.id))
    .where(where);

  const roll = (await from({
    total: sql<number>`count(*)::int`,
    shotokanRelevant: sql<number>`count(*) filter (where ${s.listings.shotokanRelevant} is true)::int`,
    shotokanUnstated: sql<number>`count(*) filter (where ${s.listings.shotokanRelevant} is null)::int`,
    inStock: sql<number>`count(*) filter (where ${hasStock()})::int`,
    ageStated: sql<number>`count(*) filter (where ${s.listings.ageMinYears} is not null or ${s.listings.ageMaxYears} is not null)::int`,
    ageUnstated: sql<number>`count(*) filter (where ${s.listings.ageMinYears} is null and ${s.listings.ageMaxYears} is null)::int`,
    ageLowestStated: sql<number | null>`min(${s.listings.ageMinYears})`,
    ageHighestStated: sql<number | null>`max(${s.listings.ageMaxYears})`,
    priceFloorMinor: sql<number | null>`min(${s.listings.priceMinor})`,
    priceCeilingMinor: sql<number | null>`max(${s.listings.priceMinor})`,
  }))[0] ?? {};

  const disciplines = await from({
    value: sql<string>`lower(${s.listings.discipline})`,
    count: sql<number>`count(*)::int`,
  }).groupBy(sql`lower(${s.listings.discipline})`)
    .having(sql`lower(${s.listings.discipline}) is not null and length(trim(lower(${s.listings.discipline}))) > 0`)
    .orderBy(sql`count(*) desc, lower(${s.listings.discipline}) asc`);

  const sports = await from({
    value: sql<string>`lower(${s.listings.sport})`,
    count: sql<number>`count(*)::int`,
  }).groupBy(sql`lower(${s.listings.sport})`)
    .having(sql`lower(${s.listings.sport}) is not null and length(trim(lower(${s.listings.sport}))) > 0`)
    .orderBy(sql`count(*) desc, lower(${s.listings.sport}) asc`);

  // The bands. `ntile` over DISTINCT prices, summing the item counts at each
  // price — so a category where four hundred items all cost ₹1,799 produces one
  // band of four hundred rather than four bands with identical edges.
  const bandRows = await db.select({
    band: sql<number>`t.band`,
    lo: sql<number>`min(t.p)::int`,
    hi: sql<number>`max(t.p)::int`,
    count: sql<number>`sum(t.n)::int`,
  }).from(sql`(
    select q.p, q.n, ntile(${PRICE_BAND_COUNT}) over (order by q.p) as band
      from (
        select ${s.listings.priceMinor} as p, count(*)::int as n
          from ${s.listings}
          inner join ${s.sellers} on ${s.sellers.id} = ${s.listings.sellerId}
          inner join ${s.marketplaceCategories} on ${s.marketplaceCategories.id} = ${s.listings.categoryId}
         where ${where}
         group by ${s.listings.priceMinor}
      ) q
  ) t`).groupBy(sql`t.band`).orderBy(sql`t.band`);

  // Items filed under no taxonomy node at all. Only meaningful at the root: in
  // a subtree the answer is "none of them, by construction". Reported so the
  // federation can SEE that an approved item is invisible to every category
  // page, rather than discovering it when a seller asks why.
  let uncategorised: number | null = null;
  if (p === null) {
    const rows = await db.select({ n: sql<number>`count(*)::int` })
      .from(s.listings)
      .innerJoin(s.sellers, eq(s.listings.sellerId, s.sellers.id))
      .where(and(publicListingPredicate(), sql`${s.listings.categoryId} is null`) as SQL);
    uncategorised = rows[0]?.n ?? 0;
  }

  return {
    ...blank,
    total: roll.total ?? 0,
    shotokanRelevant: roll.shotokanRelevant ?? 0,
    shotokanUnstated: roll.shotokanUnstated ?? 0,
    inStock: roll.inStock ?? 0,
    ageStated: roll.ageStated ?? 0,
    ageUnstated: roll.ageUnstated ?? 0,
    ageLowestStated: roll.ageLowestStated ?? null,
    ageHighestStated: roll.ageHighestStated ?? null,
    priceFloorMinor: roll.priceFloorMinor ?? null,
    priceCeilingMinor: roll.priceCeilingMinor ?? null,
    disciplines: disciplines.map((r: any) => ({ value: String(r.value), count: r.count })),
    sports: sports.map((r: any) => ({ value: String(r.value), count: r.count })),
    priceBands: bandRows.map((r: any) => ({ minMinor: r.lo, maxMinor: r.hi, count: r.count })),
    uncategorised,
  };
}

// ─── Sitemap expansion ──────────────────────────────────────────────────────

/** The same shape marketplace.ts uses, so the sitemap treats them alike. */
export interface BrowseSitemapSlice {
  values: string[];
  truncated: boolean;
}

/**
 * Category paths worth advertising: those with at least one PUBLIC item in
 * their subtree.
 *
 * THE INNER JOIN IS THE POINT, exactly as it is in publishableStorefronts(). An
 * adopted taxonomy has twenty-six nodes on the day it is adopted and nothing
 * filed under most of them. Advertising all twenty-six would put a set of thin
 * doorway pages on the federation's own domain — a heading, a breadcrumb, and
 * the sentence "nothing here" — which is precisely what a search engine
 * penalises a domain for, and precisely the "DO NOT generate fake location
 * pages" instruction applied to a different noun.
 *
 * The page still renders and still answers 200 for an empty category: it is a
 * real address, linked from its parent, and a buyer who follows the link
 * deserves an honest empty page rather than a 404. It is simply not ADVERTISED.
 */
export async function publishableCategoryPaths(
  db: DB, cap: number = SITEMAP_CATEGORY_CAP
): Promise<BrowseSitemapSlice> {
  const limit = Math.max(1, Math.floor(cap));

  // One row per category that HAS something, then every ancestor of it is
  // implied — a parent with a populated child has a populated subtree by
  // definition, so the ancestors are added here rather than re-queried.
  const rows = await db.selectDistinct({ path: s.marketplaceCategories.path })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.listings.sellerId, s.sellers.id))
    .innerJoin(s.marketplaceCategories, eq(s.listings.categoryId, s.marketplaceCategories.id))
    .where(and(publicListingPredicate(), eq(s.marketplaceCategories.active, true)) as SQL);

  const paths = new Set<string>();
  for (const r of rows) {
    const segments = String(r.path).split('/').filter(Boolean);
    for (let i = 1; i <= segments.length; i += 1) paths.add(segments.slice(0, i).join('/'));
  }

  // An ancestor implied above may itself be inactive — a retired parent whose
  // child is still in use. Its page 404s, so it must not be advertised.
  const active = await db.select({ path: s.marketplaceCategories.path })
    .from(s.marketplaceCategories)
    .where(eq(s.marketplaceCategories.active, true));
  const live = new Set(active.map((r: any) => String(r.path)));

  const values = [...paths].filter((x) => live.has(x)).sort();
  return { values: values.slice(0, limit), truncated: values.length > limit };
}

/** Brand slugs carrying at least one public item. Same doorway-page reasoning. */
export async function publishableBrandSlugs(
  db: DB, cap: number = SITEMAP_BRAND_CAP
): Promise<BrowseSitemapSlice> {
  const limit = Math.max(1, Math.floor(cap));
  const rows = await db.selectDistinct({ slug: s.brands.slug })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.listings.sellerId, s.sellers.id))
    .innerJoin(s.brands, eq(s.listings.brandId, s.brands.id))
    .where(publicListingPredicate() as SQL)
    .orderBy(asc(s.brands.slug));

  const values = rows.map((r: any) => String(r.slug)).filter(Boolean);
  return { values: values.slice(0, limit), truncated: values.length > limit };
}
