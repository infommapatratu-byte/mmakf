// The governed catalogue: taxonomy, product policy, variants, quarantine.
//
// ─── THE RULE THIS MODULE EXISTS TO ENFORCE ─────────────────────────────────
//
//     "Do not allow sellers to bypass marketplace policy by selecting a
//      different category."
//
// The naive implementation reads the chosen category's own policy and stops.
// That is exactly the bypass: MMAKF marks 'weapons' prohibited, a seller files
// a nunchaku under 'training equipment', and the control is silent. So
// `effectivePolicyFor()` walks the ANCESTRY and takes the STRICTEST value it
// finds, and `assertMayList()` refuses on the effective policy rather than the
// declared one.
//
// The other half of the same rule is that policy is not copied down the tree on
// write. A copied value is stale the moment a parent changes, and the staleness
// is invisible — the child still says 'allowed' and nobody can see that it is
// answering a question from last year.
//
// ─── WHAT THIS MODULE REFUSES TO INVENT ─────────────────────────────────────
//
// The taxonomy ships EMPTY. `PROPOSED_TAXONOMY` below is the brief's own list
// of categories in MMAKF's own words, offered as a proposal that the federation
// adopts by running `adoptProposedTaxonomy()`. Quoting it is not inventing it;
// writing it into the database unasked would still be a decision, and adoption
// is one call.
//
// Every category proposed arrives as `requires_review` and NOTHING is proposed
// as prohibited — not even weapons. Whether a kobudo training weapon may be
// sold through the federation's marketplace is a policy judgement with legal
// weight in twelve states, and a prohibition this file invented would look
// exactly like one MMAKF had made.

import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, allocateFederationId, type AuditContext } from '@/db/federation';
import { assertCan, type Principal } from '@/lib/rbac';
import { MarketplaceError } from '@/db/marketplace';

type DB = any;

export const TAXONOMY_NOT_ADOPTED =
  'MMAKF has not adopted a product taxonomy. The categories in the brief are ' +
  'available as a proposal; a federation officer adopts them deliberately.';

export const CATEGORY_POLICY_UNSET =
  'This category carries no policy decision. Until MMAKF makes one, listings ' +
  'in it go to review and are never auto-approved.';

// ─── The proposed taxonomy ──────────────────────────────────────────────────

export interface ProposedCategory {
  slug: string;
  name: string;
  parent?: string;
  legacy?: 'uniform' | 'accessories' | 'equipment' | 'merch';
  /** Set only where the brief itself says the category needs something. */
  requiresSafetyClassification?: boolean;
  requiresAgeStatement?: boolean;
  requiresCertification?: boolean;
  note?: string;
}

/**
 * The brief's category list, transcribed — not designed.
 *
 * Where the brief writes "WEAPONS WHERE LEGALLY AND POLICY-APPROPRIATELY
 * ALLOWED", the qualification is carried into `note` and the category arrives
 * as `requires_review` with `requiresFederationApproval` set, which is the
 * nearest honest rendering of a sentence that defers to a decision nobody has
 * made. It is NOT rendered as `prohibited`, because the brief did not prohibit
 * it, and it is not rendered as `allowed`, because the brief did not allow it.
 *
 * PROTECTIVE EQUIPMENT carries `requiresSafetyClassification` because the brief
 * separately requires products to have a safety classification "where
 * relevant", and headgear that stops a strike is where relevant.
 */
export const PROPOSED_TAXONOMY: readonly ProposedCategory[] = [
  { slug: 'uniforms', name: 'Uniforms', legacy: 'uniform' },
  { slug: 'karate-gi', name: 'Karate-gi', parent: 'uniforms', legacy: 'uniform' },
  { slug: 'belts', name: 'Belts', parent: 'uniforms', legacy: 'uniform' },

  { slug: 'protective-equipment', name: 'Protective equipment', legacy: 'equipment', requiresSafetyClassification: true },
  { slug: 'headgear', name: 'Headgear', parent: 'protective-equipment', legacy: 'equipment', requiresSafetyClassification: true, requiresAgeStatement: true },
  { slug: 'gloves', name: 'Gloves', parent: 'protective-equipment', legacy: 'equipment', requiresSafetyClassification: true },
  { slug: 'chest-protection', name: 'Chest protection', parent: 'protective-equipment', legacy: 'equipment', requiresSafetyClassification: true, requiresAgeStatement: true },
  { slug: 'shin-protection', name: 'Shin protection', parent: 'protective-equipment', legacy: 'equipment', requiresSafetyClassification: true },
  { slug: 'foot-protection', name: 'Foot protection', parent: 'protective-equipment', legacy: 'equipment', requiresSafetyClassification: true },

  { slug: 'training-equipment', name: 'Training equipment', legacy: 'equipment' },
  { slug: 'kata-equipment', name: 'Kata equipment', parent: 'training-equipment', legacy: 'equipment' },
  { slug: 'kumite-equipment', name: 'Kumite equipment', parent: 'training-equipment', legacy: 'equipment' },
  { slug: 'targets', name: 'Targets', parent: 'training-equipment', legacy: 'equipment' },
  { slug: 'mitts', name: 'Mitts', parent: 'training-equipment', legacy: 'equipment' },
  { slug: 'pads', name: 'Pads', parent: 'training-equipment', legacy: 'equipment' },

  {
    slug: 'weapons', name: 'Weapons', legacy: 'equipment',
    note: 'The brief permits this category "where legally and policy-appropriately allowed". ' +
      'MMAKF has not made that determination, so it arrives requiring federation approval ' +
      'per listing and is not proposed as either allowed or prohibited.',
    requiresAgeStatement: true, requiresSafetyClassification: true,
  },

  { slug: 'books', name: 'Books', legacy: 'merch' },
  { slug: 'digital-education', name: 'Digital education', legacy: 'merch' },
  { slug: 'apparel', name: 'Apparel', legacy: 'merch' },
  { slug: 'footwear', name: 'Footwear', legacy: 'accessories' },
  { slug: 'bags', name: 'Bags', legacy: 'accessories' },
  { slug: 'accessories', name: 'Accessories', legacy: 'accessories' },
  { slug: 'sports-science', name: 'Sports science', legacy: 'equipment' },
  { slug: 'recovery', name: 'Recovery', legacy: 'equipment' },
  { slug: 'fitness', name: 'Fitness', legacy: 'equipment' },
  { slug: 'federation-merchandise', name: 'Federation merchandise', legacy: 'merch' },
];

/**
 * Write the proposal into the database, once, deliberately.
 *
 * IDEMPOTENT BY SLUG: running it twice adds nothing and changes nothing that
 * MMAKF has since edited. A federation that has renamed 'Mitts' or restricted
 * 'Weapons' keeps its decision — the adopt path never overwrites an existing
 * row, because a re-run after a deploy would otherwise silently undo policy.
 */
export async function adoptProposedTaxonomy(db: DB, ctx: AuditContext) {
  assertCan(ctx.principal, 'marketplace:review', {});

  const existing = await db.select({ slug: s.marketplaceCategories.slug }).from(s.marketplaceCategories);
  const have = new Set(existing.map((r: any) => r.slug));

  const added: string[] = [];
  for (const c of PROPOSED_TAXONOMY) {
    if (have.has(c.slug)) continue;
    const parent = c.parent
      ? (await db.select().from(s.marketplaceCategories).where(eq(s.marketplaceCategories.slug, c.parent)).limit(1))[0]
      : null;
    if (c.parent && !parent) {
      throw new MarketplaceError('bad_parent', `Proposed category ${c.slug} names a parent (${c.parent}) that is not present.`);
    }

    await db.insert(s.marketplaceCategories).values({
      slug: c.slug,
      name: c.name,
      parentId: parent?.id ?? null,
      path: parent ? `${parent.path}/${c.slug}` : c.slug,
      depth: parent ? parent.depth + 1 : 0,
      legacyCategory: c.legacy ?? null,
      // EVERY proposed category arrives requiring review. Adoption is the
      // federation accepting a list of names; it is not the federation deciding
      // that anything on it may be sold without being looked at.
      policy: 'requires_review',
      policyReason: c.note ?? null,
      requiresSafetyClassification: !!c.requiresSafetyClassification,
      requiresAgeStatement: !!c.requiresAgeStatement,
      requiresCertification: !!c.requiresCertification,
      requiresFederationApproval: c.slug === 'weapons',
      createdByUserId: ctx.principal?.userId ?? null,
    });
    added.push(c.slug);
  }

  if (added.length) {
    await writeAudit(db, ctx, {
      entityType: 'marketplace_taxonomy', entityId: null, action: 'create',
      newValue: { adopted: added },
    });
  }
  return { added, alreadyPresent: PROPOSED_TAXONOMY.length - added.length };
}

// ─── Reading the tree ───────────────────────────────────────────────────────

export async function categoryTree(db: DB, opts: { includeInactive?: boolean } = {}) {
  const rows = await db.select().from(s.marketplaceCategories)
    .where(opts.includeInactive ? sql`true` : eq(s.marketplaceCategories.active, true))
    .orderBy(asc(s.marketplaceCategories.path));
  return rows;
}

export async function categoryBySlug(db: DB, slug: string) {
  return (await db.select().from(s.marketplaceCategories)
    .where(eq(s.marketplaceCategories.slug, String(slug ?? '').trim())).limit(1))[0] ?? null;
}

/** A category and every ancestor of it, root first. */
export async function categoryAncestry(db: DB, categoryId: number) {
  const node = (await db.select().from(s.marketplaceCategories)
    .where(eq(s.marketplaceCategories.id, categoryId)).limit(1))[0];
  if (!node) return [];
  const slugs = String(node.path).split('/').filter(Boolean);
  if (!slugs.length) return [node];
  const rows = await db.select().from(s.marketplaceCategories)
    .where(inArray(s.marketplaceCategories.slug, slugs));
  // Ordered by the path itself rather than by id — a category moved under a
  // new parent keeps its id and changes its ancestry, and id order would then
  // report the tree as it used to be.
  return slugs.map((sl) => rows.find((r: any) => r.slug === sl)).filter(Boolean);
}

export type CategoryPolicy = 'allowed' | 'requires_review' | 'restricted' | 'prohibited';

const STRICTNESS: Record<CategoryPolicy, number> = {
  allowed: 0, requires_review: 1, restricted: 2, prohibited: 3,
};

export interface EffectivePolicy {
  policy: CategoryPolicy;
  /** The category the effective policy came from — often an ancestor. */
  fromSlug: string;
  reason: string | null;
  requiresBrandAuthorisation: boolean;
  requiresCertification: boolean;
  requiresAgeStatement: boolean;
  requiresSafetyClassification: boolean;
  requiresFederationApproval: boolean;
}

/**
 * THE ANTI-BYPASS. The strictest policy anywhere in the ancestry wins, and the
 * requirement flags are the UNION of every ancestor's.
 *
 * Union rather than nearest-ancestor for the flags, because they are
 * independent safeguards: 'protective-equipment' requiring a safety
 * classification and 'headgear' requiring an age statement should require both,
 * and a nearest-wins rule would drop the parent's the moment a child set any
 * flag of its own.
 */
export async function effectivePolicyFor(db: DB, categoryId: number | null | undefined): Promise<EffectivePolicy | null> {
  if (categoryId == null) return null;
  const chain = await categoryAncestry(db, categoryId);
  if (!chain.length) return null;

  let winner: any = chain[0];
  for (const node of chain) {
    if (STRICTNESS[node.policy as CategoryPolicy] > STRICTNESS[winner.policy as CategoryPolicy]) winner = node;
  }

  return {
    policy: winner.policy,
    fromSlug: winner.slug,
    reason: winner.policyReason ?? null,
    requiresBrandAuthorisation: chain.some((c: any) => c.requiresBrandAuthorisation),
    requiresCertification: chain.some((c: any) => c.requiresCertification),
    requiresAgeStatement: chain.some((c: any) => c.requiresAgeStatement),
    requiresSafetyClassification: chain.some((c: any) => c.requiresSafetyClassification),
    requiresFederationApproval: chain.some((c: any) => c.requiresFederationApproval),
  };
}

// ─── The listing gate ───────────────────────────────────────────────────────

export interface ListingGateResult {
  /** Hard refusals. A listing with any of these cannot be submitted. */
  blocking: string[];
  /** Things a reviewer must satisfy themselves about. Never auto-cleared. */
  reviewerMustConfirm: string[];
  policy: EffectivePolicy | null;
}

/**
 * May this seller offer this item, in this category?
 *
 * REPORTS EVERYTHING, then the caller refuses. Returning the full list rather
 * than throwing on the first problem is deliberate: a seller told one fault at
 * a time submits five times and gives up on the fourth, and a reviewer who
 * sees only the first fault approves an item with four others.
 *
 * The restriction check reads the SELLER's restricted categories as well as the
 * category's own policy, which is what makes `sellers.restrictedCategories`
 * mean anything at all.
 */
export async function checkListingAgainstPolicy(
  db: DB,
  input: {
    sellerId: number;
    categoryId?: number | null;
    brandId?: number | null;
    certification?: string | null;
    ageMinYears?: number | null;
    safetyClassification?: string | null;
  }
): Promise<ListingGateResult> {
  const blocking: string[] = [];
  const reviewerMustConfirm: string[] = [];

  const seller = (await db.select().from(s.sellers).where(eq(s.sellers.id, input.sellerId)).limit(1))[0];
  if (!seller) throw new MarketplaceError('unknown_seller', 'No such seller.');

  const policy = await effectivePolicyFor(db, input.categoryId ?? null);

  if (!policy) {
    // Not a refusal, and NOT AN EARLY RETURN — that was a real defect, caught
    // by tests/marketplace-platform.test.ts. Bailing out here skipped the brand
    // and counterfeit checks below, so a seller could evade brand authorisation
    // entirely by naming no category at all. The category gate and the brand
    // gate are independent controls and neither may be conditional on the
    // other.
    //
    // Every listing predating the taxonomy has no category, and refusing them
    // would take the existing shop off the marketplace — so this is a note for
    // the reviewer, not a block.
    reviewerMustConfirm.push(
      'This listing names no catalogue category, so no product policy could be applied. ' + CATEGORY_POLICY_UNSET
    );
  }

  if (policy?.policy === 'prohibited') {
    blocking.push(
      `The category "${policy.fromSlug}" is prohibited on this marketplace` +
      (policy.reason ? `: ${policy.reason}` : '.')
    );
  }

  // The seller-specific restriction. A restricted seller keeps trading in the
  // categories they are trusted with — this is the one that bars the rest.
  const restricted: string[] = Array.isArray(seller.restrictedCategories) ? seller.restrictedCategories : [];
  if (restricted.length && input.categoryId != null) {
    const chain = await categoryAncestry(db, input.categoryId);
    const hit = chain.find((c: any) => restricted.includes(c.slug));
    if (hit) {
      blocking.push(
        `This seller is restricted from "${hit.slug}"` +
        (seller.restrictedReason ? `: ${seller.restrictedReason}` : '.')
      );
    }
  }

  if (policy?.requiresFederationApproval) {
    reviewerMustConfirm.push(
      `"${policy.fromSlug}" requires an explicit federation decision on this listing before it is published.`
    );
  }

  if (policy?.requiresBrandAuthorisation) {
    if (input.brandId == null) {
      blocking.push(`Items in "${policy.fromSlug}" must name the brand they are sold under.`);
    } else {
      const auth = await verifiedBrandAuthorisation(db, input.brandId, input.sellerId);
      if (!auth) {
        blocking.push(
          'This category requires a verified brand authorisation, and this seller holds none for that brand. ' +
          'A claim is not an authorisation — see brand_authorisations.'
        );
      }
    }
  }

  // A brand that is itself restricted requires authorisation whatever the
  // category says. This is the counterfeit control and it is checked here so
  // that no listing path can miss it.
  if (input.brandId != null) {
    const brand = (await db.select().from(s.brands).where(eq(s.brands.id, input.brandId)).limit(1))[0];
    if (!brand) blocking.push('The brand named on this listing is not in the marketplace brand register.');
    else if (brand.status === 'blocked') {
      blocking.push(`"${brand.name}" is blocked on this marketplace and may not be listed.`);
    } else if ((brand.status === 'restricted' || brand.requiresAuthorisation)
      && !(await verifiedBrandAuthorisation(db, input.brandId, input.sellerId))) {
      blocking.push(
        `"${brand.name}" may be listed only by a seller holding a verified authorisation for it.`
      );
    }
  }

  if (policy?.requiresCertification && !String(input.certification ?? '').trim()) {
    blocking.push(`Items in "${policy.fromSlug}" must state their certification.`);
  }

  // ABSENT IS NOT "ALL AGES". The nullability of ageMinYears means UNSTATED, and
  // this is the one place that distinction has consequences.
  if (policy?.requiresAgeStatement && (input.ageMinYears == null)) {
    blocking.push(
      `Items in "${policy.fromSlug}" must state a minimum age. An unstated age is not a statement that ` +
      'the item is suitable for everyone.'
    );
  }

  if (policy?.requiresSafetyClassification && !String(input.safetyClassification ?? '').trim()) {
    blocking.push(`Items in "${policy.fromSlug}" must carry a safety classification.`);
  }

  if (policy?.policy === 'restricted' || policy?.policy === 'requires_review') {
    reviewerMustConfirm.push(
      `"${policy.fromSlug}" is ${policy.policy.replace('_', ' ')}; this listing may never be published without a human decision.`
    );
  }

  return { blocking, reviewerMustConfirm, policy };
}

/** A CURRENT, VERIFIED authorisation. Expiry is checked, not assumed. */
export async function verifiedBrandAuthorisation(db: DB, brandId: number, sellerId: number) {
  const today = new Date().toISOString().slice(0, 10);
  return (await db.select().from(s.brandAuthorisations).where(and(
    eq(s.brandAuthorisations.brandId, brandId),
    eq(s.brandAuthorisations.sellerId, sellerId),
    eq(s.brandAuthorisations.status, 'verified'),
    isNull(s.brandAuthorisations.revokedAt),
    // Dated permissions expire. The ordinary failure of every system like this
    // is that it verifies once and never looks again.
    or(isNull(s.brandAuthorisations.validTo), sql`${s.brandAuthorisations.validTo} >= ${today}`),
    or(isNull(s.brandAuthorisations.validFrom), sql`${s.brandAuthorisations.validFrom} <= ${today}`),
  )).limit(1))[0] ?? null;
}

// ─── Variants ───────────────────────────────────────────────────────────────

export interface VariantInput {
  label: string;
  priceMinor: number;
  sku?: string | null;
  sellerSku?: string | null;
  barcode?: string | null;
  gtin?: string | null;
  attributes?: Record<string, unknown> | null;
  compareAtMinor?: number | null;
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  sortOrder?: number;
}

const MAX_MINOR = 100_000_000;      // ₹10 lakh in paise. A sanity ceiling.

function validateVariant(v: VariantInput) {
  const label = String(v?.label ?? '').trim();
  if (!label) throw new MarketplaceError('bad_variant', 'Every variant needs a label — it is what the buyer chooses.');
  if (!Number.isInteger(v?.priceMinor) || v.priceMinor < 0 || v.priceMinor > MAX_MINOR) {
    throw new MarketplaceError('bad_price', 'A variant price must be a whole number of paise between 0 and 10,00,000.00.');
  }
  return label;
}

/**
 * Add a variant to the caller's own listing.
 *
 * TAKES THE LISTING THROUGH THE REVIEW GATE AGAIN. Adding a size, or a colour,
 * changes what is on offer; `refreshListingFromVariants()` recomputes the
 * content hash, and the public predicate's hash equality does the rest. Stock
 * is untouched by that, and deliberately so.
 */
export async function addVariant(
  db: DB, ctx: AuditContext, listingId: number, input: VariantInput
) {
  const { listing } = await ownListing(db, ctx.principal, listingId);
  const label = validateVariant(input);

  const sku = String(input.sku ?? '').trim() || await nextVariantSku(db, listing);

  const [row] = await db.insert(s.listingVariants).values({
    listingId: listing.id,
    sellerId: listing.sellerId,
    sku,
    sellerSku: input.sellerSku?.trim() || null,
    barcode: input.barcode?.trim() || null,
    gtin: input.gtin?.trim() || null,
    label,
    attributes: input.attributes ?? null,
    priceMinor: input.priceMinor,
    compareAtMinor: input.compareAtMinor ?? null,
    currency: listing.currency ?? 'INR',
    weightGrams: input.weightGrams ?? null,
    lengthMm: input.lengthMm ?? null,
    widthMm: input.widthMm ?? null,
    heightMm: input.heightMm ?? null,
    sortOrder: input.sortOrder ?? 0,
  }).returning({ id: s.listingVariants.id });

  const result = await refreshListingFromVariants(db, ctx, listing.id);
  await writeAudit(db, ctx, {
    entityType: 'listing_variant', entityId: row.id, action: 'create',
    newValue: { listingId: listing.id, sku, label, priceMinor: input.priceMinor },
  });
  return { variantId: row.id, sku, ...result };
}

export async function updateVariant(
  db: DB, ctx: AuditContext, variantId: number, patch: Partial<VariantInput>
) {
  const variant = (await db.select().from(s.listingVariants)
    .where(eq(s.listingVariants.id, variantId)).limit(1))[0];
  if (!variant) throw new MarketplaceError('unknown_variant', 'No such variant.');
  const { listing } = await ownListing(db, ctx.principal, variant.listingId);

  const next: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.label !== undefined) next.label = validateVariant({ label: patch.label, priceMinor: patch.priceMinor ?? variant.priceMinor });
  if (patch.priceMinor !== undefined) {
    validateVariant({ label: patch.label ?? variant.label, priceMinor: patch.priceMinor });
    next.priceMinor = patch.priceMinor;
  }
  for (const k of ['sellerSku', 'barcode', 'gtin', 'attributes', 'compareAtMinor',
    'weightGrams', 'lengthMm', 'widthMm', 'heightMm', 'sortOrder'] as const) {
    if (patch[k] !== undefined) next[k] = patch[k] as any;
  }

  await db.update(s.listingVariants).set(next).where(eq(s.listingVariants.id, variantId));
  const result = await refreshListingFromVariants(db, ctx, listing.id);

  await writeAudit(db, ctx, {
    entityType: 'listing_variant', entityId: variantId, action: 'update',
    oldValue: { label: variant.label, priceMinor: variant.priceMinor },
    newValue: next,
  });
  return { variantId, ...result };
}

/**
 * Withdraw a variant from sale.
 *
 * DISCONTINUES, NEVER DELETES. An order line points at this row for as long as
 * the order exists, and a receipt that cannot name what was bought is not a
 * receipt. The variant stops being offered and stops counting toward the
 * listing's stock.
 */
export async function discontinueVariant(db: DB, ctx: AuditContext, variantId: number, reason: string) {
  const variant = (await db.select().from(s.listingVariants)
    .where(eq(s.listingVariants.id, variantId)).limit(1))[0];
  if (!variant) throw new MarketplaceError('unknown_variant', 'No such variant.');
  const { listing } = await ownListing(db, ctx.principal, variant.listingId);

  const live = await db.select({ n: sql<number>`count(*)::int` }).from(s.listingVariants).where(and(
    eq(s.listingVariants.listingId, listing.id),
    ne(s.listingVariants.status, 'discontinued'),
  ));
  if ((live[0]?.n ?? 0) <= 1) {
    throw new MarketplaceError(
      'last_variant',
      'A listing must keep at least one live variant. Withdraw the listing instead — that is the ' +
      'reversible action, and it leaves the item where the federation can still see it.'
    );
  }

  await db.update(s.listingVariants)
    .set({ status: 'discontinued', updatedAt: new Date() })
    .where(eq(s.listingVariants.id, variantId));

  const result = await refreshListingFromVariants(db, ctx, listing.id);
  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'listing_variant', entityId: variantId, action: 'update',
    oldValue: { status: variant.status }, newValue: { status: 'discontinued' },
  });
  return { variantId, ...result };
}

async function nextVariantSku(db: DB, listing: any): Promise<string> {
  const n = (await db.select({ n: sql<number>`count(*)::int` })
    .from(s.listingVariants).where(eq(s.listingVariants.listingId, listing.id)))[0]?.n ?? 0;
  return `${listing.ref}-V${String(n + 1).padStart(2, '0')}`;
}

/**
 * Recompute the listing's roll-ups and its content hash after a variant change.
 *
 * THE ROLL-UPS ARE DERIVED HERE AND NOWHERE ELSE. `listings.priceMinor` becomes
 * the lowest live variant price (what the shop shows as "from"), `stockQty` the
 * sum of live availability, `variantCount` the count. Nothing else writes them,
 * so they cannot drift apart from the variants they summarise.
 *
 * And the hash. If the listing was approved and the variant set has changed in
 * a way a reviewer would care about, the listing goes back to 'submitted' —
 * which is the same rule editing a title obeys, applied to the field a buyer
 * actually pays for.
 */
export async function refreshListingFromVariants(db: DB, ctx: AuditContext, listingId: number) {
  const { listingContentHash } = await import('@/db/marketplace');

  const listing = (await db.select().from(s.listings).where(eq(s.listings.id, listingId)).limit(1))[0];
  if (!listing) throw new MarketplaceError('unknown_listing', 'No such listing.');

  const live = await db.select().from(s.listingVariants).where(and(
    eq(s.listingVariants.listingId, listingId),
    ne(s.listingVariants.status, 'discontinued'),
  )).orderBy(asc(s.listingVariants.sortOrder), asc(s.listingVariants.id));

  const prices = live.map((v: any) => v.priceMinor).filter((p: number) => Number.isInteger(p));
  const rollup = {
    priceMinor: prices.length ? Math.min(...prices) : listing.priceMinor,
    stockQty: live.reduce((n: number, v: any) => n + Math.max(0, v.availableQty ?? 0), 0),
    variantCount: live.length,
  };

  const media = await db.select({
    url: s.listingMedia.url, alt: s.listingMedia.alt, sortOrder: s.listingMedia.sortOrder,
  }).from(s.listingMedia).where(eq(s.listingMedia.listingId, listingId))
    .orderBy(asc(s.listingMedia.sortOrder));

  const detail: Record<string, unknown> = {};
  for (const k of ['categoryId', 'brandId', 'specifications', 'materials', 'weightGrams',
    'lengthMm', 'widthMm', 'heightMm', 'countryOfOrigin', 'warranty', 'gtin', 'sport',
    'discipline', 'shotokanRelevant', 'ageMinYears', 'ageMaxYears', 'safetyClassification',
    'certification', 'usageInstructions', 'warning', 'hsnCode', 'taxRateBps', 'shippingClass']) {
    detail[k] = (listing as any)[k] ?? null;
  }

  const hash = listingContentHash({
    title: listing.title,
    description: listing.description ?? null,
    category: listing.category,
    priceMinor: rollup.priceMinor,
    currency: listing.currency ?? 'INR',
    media: media.map((m: any) => ({ url: m.url, alt: m.alt ?? null, sortOrder: m.sortOrder })),
    detail: detail as any,
    variants: live.map((v: any) => ({
      sku: v.sku, label: v.label, priceMinor: v.priceMinor, attributes: v.attributes ?? null,
    })),
  });

  const returnedToReview = listing.status === 'approved' && hash !== listing.approvedContentHash;

  await db.update(s.listings).set({
    ...rollup,
    contentHash: hash,
    status: returnedToReview ? 'submitted' : listing.status,
    submittedAt: returnedToReview ? new Date() : listing.submittedAt,
    revision: listing.revision + 1,
    updatedAt: new Date(),
  }).where(eq(s.listings.id, listingId));

  if (returnedToReview) {
    await db.insert(s.listingRevisions).values({
      listingId, revision: listing.revision + 1, action: 'edited',
      contentHash: hash,
      snapshot: { ...rollup, variants: live.map((v: any) => ({ sku: v.sku, label: v.label, priceMinor: v.priceMinor })) },
      statusAfter: 'submitted',
      byUserId: ctx.principal?.userId ?? null,
      reason: 'Variant set changed — returned to review.',
    });
  }

  return { ...rollup, contentHash: hash, returnedToReview };
}

/**
 * The caller's own listing, or a refusal.
 *
 * The isolation boundary for every seller-side catalogue write. Seller A
 * editing Seller B's variants is one of the brief's named attacks, and this is
 * the single function that prevents it.
 */
async function ownListing(db: DB, principal: Principal, listingId: number) {
  if (principal?.userId == null) throw new MarketplaceError('not_signed_in', 'Sign in to manage a listing.');
  const rows = await db.select({ listing: s.listings, seller: s.sellers })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.listings.sellerId, s.sellers.id))
    .where(and(eq(s.listings.id, listingId), eq(s.sellers.userId, principal.userId)))
    .limit(1);
  if (!rows.length) {
    // The same message whether the listing belongs to somebody else or does not
    // exist. Distinguishing them tells an attacker which ids are real.
    throw new MarketplaceError('not_your_listing', 'No such listing on your seller account.');
  }
  if (rows[0].seller.status !== 'approved') {
    throw new MarketplaceError('seller_not_approved', `A seller that is ${rows[0].seller.status} cannot change a catalogue.`);
  }
  return rows[0];
}

export async function variantsForListing(db: DB, listingId: number) {
  return db.select().from(s.listingVariants)
    .where(eq(s.listingVariants.listingId, listingId))
    .orderBy(asc(s.listingVariants.sortOrder), asc(s.listingVariants.id));
}

/**
 * The variants of MANY listings, in one query, grouped by listing id.
 *
 * WHY THIS EXISTS. /portal/seller/products reads up to two hundred listings and
 * then called variantsForListing() once per listing inside a `for … await` —
 * two hundred sequential round trips to render one page, each waiting on the
 * last. A seller with a real catalogue watched the page take a second per
 * fifty items, and the cost is invisible in testing because a test catalogue
 * has three.
 *
 * The empty-input guard is not defensive padding: `inArray(col, [])` compiles
 * to `in ()`, which is a syntax error in Postgres rather than an empty result.
 *
 * Every listing asked for gets a key, including the ones with no variants, so a
 * caller can tell "none" from "not fetched" without a second lookup.
 */
export async function variantsForListings(
  db: DB,
  listingIds: number[]
): Promise<Map<number, any[]>> {
  const by = new Map<number, any[]>();
  const ids = [...new Set(listingIds.filter((id) => Number.isInteger(id)))];
  for (const id of ids) by.set(id, []);
  if (!ids.length) return by;

  const rows = await db.select().from(s.listingVariants)
    .where(inArray(s.listingVariants.listingId, ids))
    .orderBy(asc(s.listingVariants.sortOrder), asc(s.listingVariants.id));

  for (const r of rows) by.get(r.listingId)?.push(r);
  return by;
}

// ─── Quarantine ─────────────────────────────────────────────────────────────

/**
 * Withdraw an item from every public surface at once, without deleting it.
 *
 * ONE COLUMN, and `publicListingPredicate()` does the rest. That is the whole
 * design: a counterfeit investigation must be able to take an item off the
 * marketplace in the same instant it opens, across the shop, the category
 * pages, the search index and the seller's own storefront, while every order,
 * review and revision attached to it survives untouched for the investigation.
 *
 * A THIRD AXIS, NOT A STATUS. The listing keeps the status it had, because
 * quarantine is lifted as often as it is upheld and there has to be something
 * to restore it to.
 */
export async function quarantineListing(
  db: DB, ctx: AuditContext, listingId: number, reason: string
) {
  const listing = await loadListingForFederation(db, ctx.principal, listingId, 'marketplace:suspend');
  if (!String(reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'Quarantining an item requires a reason — the seller is entitled to know why.');
  }
  if (listing.quarantinedAt) return { listingId, alreadyQuarantined: true };

  await db.update(s.listings).set({
    quarantinedAt: new Date(),
    quarantinedByUserId: ctx.principal?.userId ?? null,
    quarantineReason: reason,
    quarantineLiftedAt: null,
    updatedAt: new Date(),
  }).where(eq(s.listings.id, listingId));

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'listing', entityId: listingId, action: 'suspend',
    oldValue: { quarantined: false }, newValue: { quarantined: true, reason },
  });
  return { listingId, alreadyQuarantined: false };
}

export async function liftQuarantine(db: DB, ctx: AuditContext, listingId: number, reason: string) {
  const listing = await loadListingForFederation(db, ctx.principal, listingId, 'marketplace:suspend');
  if (!listing.quarantinedAt) return { listingId, wasQuarantined: false };
  if (!String(reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'Lifting a quarantine requires a reason — it is a decision, not a cleanup.');
  }

  await db.update(s.listings).set({
    quarantinedAt: null,
    quarantineLiftedAt: new Date(),
    // quarantineReason is KEPT. An item that was once quarantined is a
    // different record from one that never was.
    updatedAt: new Date(),
  }).where(eq(s.listings.id, listingId));

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'listing', entityId: listingId, action: 'reinstate',
    oldValue: { quarantined: true }, newValue: { quarantined: false },
  });
  return { listingId, wasQuarantined: true };
}

async function loadListingForFederation(db: DB, principal: Principal, listingId: number, action: 'marketplace:review' | 'marketplace:suspend') {
  const rows = await db.select({ listing: s.listings, seller: s.sellers })
    .from(s.listings).innerJoin(s.sellers, eq(s.listings.sellerId, s.sellers.id))
    .where(eq(s.listings.id, listingId)).limit(1);
  if (!rows.length) throw new MarketplaceError('unknown_listing', 'No such listing.');
  assertCan(principal, action, {
    stateUnitId: rows[0].seller.stateUnitId ?? null,
    districtUnitId: rows[0].seller.districtUnitId ?? null,
    dojoId: rows[0].seller.dojoId ?? null,
  });
  return rows[0].listing;
}

// ─── Moderation flags ───────────────────────────────────────────────────────

export type FlagKind = (typeof s.listingFlagKind.enumValues)[number];

/**
 * Raise a concern about a listing.
 *
 * OPEN TO AUTOMATED CHECKS AND TO REVIEWERS, and the row says which. A flag is
 * not a decision and carries no power: it exists so that a suspicion can be
 * recorded before anybody is sure, which is the only way the pattern across
 * several sellers is ever visible.
 */
export async function raiseListingFlag(
  db: DB, ctx: AuditContext | null, listingId: number,
  input: { kind: FlagKind; detail: string; evidence?: Record<string, unknown> | null; bySystem?: boolean }
) {
  const listing = (await db.select().from(s.listings).where(eq(s.listings.id, listingId)).limit(1))[0];
  if (!listing) throw new MarketplaceError('unknown_listing', 'No such listing.');
  const detail = String(input?.detail ?? '').trim();
  if (!detail) throw new MarketplaceError('detail_required', 'A flag needs to say what the concern is.');

  const [row] = await db.insert(s.listingFlags).values({
    listingId,
    sellerId: listing.sellerId,
    kind: input.kind,
    detail,
    evidence: input.evidence ?? null,
    raisedByUserId: input.bySystem ? null : (ctx?.principal?.userId ?? null),
    raisedBySystem: !!input.bySystem,
  }).returning({ id: s.listingFlags.id });

  return { flagId: row.id };
}

export async function decideListingFlag(
  db: DB, ctx: AuditContext, flagId: number,
  decision: { status: 'upheld' | 'dismissed'; reason: string; actionTaken?: string | null }
) {
  const flag = (await db.select().from(s.listingFlags).where(eq(s.listingFlags.id, flagId)).limit(1))[0];
  if (!flag) throw new MarketplaceError('unknown_flag', 'No such flag.');
  await loadListingForFederation(db, ctx.principal, flag.listingId, 'marketplace:review');

  if (!String(decision?.reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'A flag decision requires a reason.');
  }
  if (flag.status !== 'open' && flag.status !== 'investigating') {
    throw new MarketplaceError('already_decided', `This flag is already ${flag.status}.`);
  }

  await db.update(s.listingFlags).set({
    status: decision.status,
    decidedByUserId: ctx.principal?.userId ?? null,
    decidedAt: new Date(),
    decisionReason: decision.reason,
    actionTaken: decision.actionTaken ?? null,
  }).where(eq(s.listingFlags.id, flagId));

  await writeAudit(db, { ...ctx, reason: decision.reason }, {
    entityType: 'listing_flag', entityId: flagId,
    action: decision.status === 'upheld' ? 'approve' : 'reject',
    oldValue: { status: flag.status }, newValue: { status: decision.status },
  });
  return { flagId, status: decision.status };
}

export async function openFlags(db: DB, principal: Principal, limit = 200) {
  assertCan(principal, 'marketplace:read', {});
  return db.select({
    flag: s.listingFlags,
    listingTitle: s.listings.title,
    listingRef: s.listings.ref,
    sellerName: s.sellers.tradingName,
  }).from(s.listingFlags)
    .innerJoin(s.listings, eq(s.listingFlags.listingId, s.listings.id))
    .innerJoin(s.sellers, eq(s.listingFlags.sellerId, s.sellers.id))
    .where(inArray(s.listingFlags.status, ['open', 'investigating']))
    .orderBy(desc(s.listingFlags.raisedAt))
    .limit(Math.min(limit, 500));
}

// ─── Authenticity cases ─────────────────────────────────────────────────────

/**
 * Open a counterfeit or authenticity investigation.
 *
 * QUARANTINE IS OFFERED AT THE SAME MOMENT and applied separately, because
 * withdrawing an item while it is investigated is a precaution rather than a
 * finding. Requiring a finding first would mean suspected counterfeits stay on
 * sale for the length of the investigation, which is the opposite of what an
 * investigation is for.
 */
export async function openAuthenticityCase(
  db: DB, ctx: AuditContext,
  input: {
    sellerId: number;
    listingId?: number | null;
    brandId?: number | null;
    complainantKind: 'brand_owner' | 'buyer' | 'federation' | 'seller' | 'automated';
    complainantName?: string | null;
    complainantContact?: string | null;
    orderId?: number | null;
    allegation: string;
    evidence?: Record<string, unknown> | null;
    quarantineListing?: boolean;
  }
) {
  assertCan(ctx.principal, 'marketplace:review', {});
  const allegation = String(input?.allegation ?? '').trim();
  if (!allegation) throw new MarketplaceError('allegation_required', 'A case needs to say what is alleged.');

  const ref = await allocateFederationId(db, 'AUTH');
  const [row] = await db.insert(s.authenticityCases).values({
    ref,
    sellerId: input.sellerId,
    listingId: input.listingId ?? null,
    brandId: input.brandId ?? null,
    complainantKind: input.complainantKind,
    complainantName: input.complainantName ?? null,
    complainantContact: input.complainantContact ?? null,
    orderId: input.orderId ?? null,
    allegation,
    evidence: input.evidence ?? null,
    openedByUserId: ctx.principal?.userId ?? null,
  }).returning({ id: s.authenticityCases.id });

  if (input.quarantineListing && input.listingId) {
    await quarantineListing(db, ctx, input.listingId, `Authenticity case ${ref} opened: ${allegation}`);
  }

  await writeAudit(db, ctx, {
    entityType: 'authenticity_case', entityId: row.id, action: 'create',
    newValue: { ref, sellerId: input.sellerId, listingId: input.listingId ?? null },
  });
  return { caseId: row.id, ref };
}

export async function decideAuthenticityCase(
  db: DB, ctx: AuditContext, caseId: number,
  decision: { status: 'upheld' | 'dismissed'; decision: string; enforcement?: Record<string, unknown> | null }
) {
  assertCan(ctx.principal, 'marketplace:suspend', {});
  const row = (await db.select().from(s.authenticityCases).where(eq(s.authenticityCases.id, caseId)).limit(1))[0];
  if (!row) throw new MarketplaceError('unknown_case', 'No such case.');
  if (!String(decision?.decision ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'A counterfeit finding requires a stated reason.');
  }

  await db.update(s.authenticityCases).set({
    status: decision.status,
    decision: decision.decision,
    enforcement: decision.enforcement ?? null,
    decidedByUserId: ctx.principal?.userId ?? null,
    decidedAt: new Date(),
  }).where(eq(s.authenticityCases.id, caseId));

  // A DISMISSED case lifts the precautionary quarantine it caused. An upheld
  // one does not — the item stays off the marketplace until somebody decides
  // separately what happens to it, and that decision is a different one.
  if (decision.status === 'dismissed' && row.listingId) {
    const listing = (await db.select().from(s.listings).where(eq(s.listings.id, row.listingId)).limit(1))[0];
    if (listing?.quarantinedAt && String(listing.quarantineReason ?? '').includes(row.ref)) {
      await liftQuarantine(db, ctx, row.listingId, `Authenticity case ${row.ref} dismissed.`);
    }
  }

  await writeAudit(db, { ...ctx, reason: decision.decision }, {
    entityType: 'authenticity_case', entityId: caseId,
    action: decision.status === 'upheld' ? 'approve' : 'reject',
    oldValue: { status: row.status }, newValue: { status: decision.status },
  });
  return { caseId, status: decision.status };
}
