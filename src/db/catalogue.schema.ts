// The marketplace catalogue: taxonomy, variants, moderation and authenticity.
//
// ─── WHY THE TAXONOMY IS A TABLE ────────────────────────────────────────────
//
// The brief says it twice: "Build configurable taxonomy" and "Do not hardcode
// the taxonomy". Both are right, and the reason is not flexibility for its own
// sake — it is that the category is where product POLICY attaches. Whether an
// item needs a safety certificate, an age statement or a brand authorisation is
// a property of what kind of thing it is, and if the kinds are an enum in a
// TypeScript file then MMAKF cannot add "weapons — kobudo, training grade"
// without a deploy, and will therefore add it to "equipment" instead. The
// policy silently stops applying, and nobody notices because nothing broke.
//
// The existing four-value `listingCategory` enum is NOT removed. It remains the
// coarse axis the public shop filters on and the thing every existing listing
// carries; `marketplace_categories` is the fine, governed tree that hangs
// beneath it. Deleting the enum would have rewritten every existing listing to
// satisfy a refactor, which is the change most likely to lose data.
//
// ─── WHY VARIANTS ARE A TABLE AND NOT A JSONB COLUMN ────────────────────────
//
// Because a variant is the thing that is actually bought. A 170cm gi and a
// 190cm gi have different stock, different weights, different shipping cost and
// — after a price change on one size — different prices. Stock counted on the
// parent product is how two people buy the last 170cm gi within the same
// minute, and a JSONB blob cannot carry a foreign key from an order line, so
// the receipt could not say which one was sold.
//
// ─── AND THE RULE THAT KEEPS REVIEW HONEST ──────────────────────────────────
//
// VARIANT PRICE AND LABEL FEED THE LISTING'S CONTENT HASH; VARIANT STOCK DOES
// NOT. Adding a size, or repricing one, is a change to what MMAKF approved and
// returns the listing to review. Selling three of them is not. The reasoning is
// in src/db/onboarding.schema.ts above `listings` and it is the same reasoning.

import {
  pgTable, serial, text, integer, timestamp, boolean,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './schema';
import { sellers, listings } from './onboarding.schema';
import { brands } from './seller.schema';

// ─── Taxonomy ───────────────────────────────────────────────────────────────

/**
 * What a category permits, which is the whole reason the taxonomy is governed.
 *
 *   allowed         — list it and it goes through the ordinary review queue.
 *   requires_review — the same, but it may never be auto-approved by any future
 *                     bulk or trusted-seller path. A distinct value rather than
 *                     a flag, because "we will add fast-tracking later" is when
 *                     this distinction gets lost.
 *   restricted      — additionally requires something: an authorisation, a
 *                     certificate, an age statement. The requirement columns
 *                     below say which.
 *   prohibited      — may not be listed at all. Kept as a CATEGORY rather than
 *                     as an absence, so that a seller submitting one gets a
 *                     reason instead of a shrug, and so the register can show
 *                     what MMAKF has decided against.
 */
export const categoryPolicy = pgEnum('category_policy', [
  'allowed', 'requires_review', 'restricted', 'prohibited',
]);

/**
 * A node in the configurable product taxonomy.
 *
 * `path` is the materialised ancestry ('equipment/protective/headgear'), stored
 * rather than walked. Reading a tree by recursive query on every catalogue page
 * is the kind of cleverness that is fine at forty categories and pathological
 * at four hundred; and a `path` prefix match is what makes "everything under
 * protective equipment" one index scan.
 *
 * THE POLICY IS INHERITED BUT NOT COPIED. `effectivePolicyFor()` in
 * src/db/catalogue.ts walks the ancestors and takes the STRICTEST value found,
 * so marking a parent prohibited prohibits its children immediately — the
 * brief's requirement that a seller must not evade policy by choosing a
 * different category. Copying the value down on write would leave children
 * stale the moment a parent changed, and the staleness would be invisible.
 */
export const marketplaceCategories = pgTable('marketplace_categories', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  parentId: integer('parent_id'),
  /** Materialised ancestry, slash-separated, including this node's own slug. */
  path: text('path').notNull(),
  depth: integer('depth').notNull().default(0),
  sortOrder: integer('sort_order').notNull().default(0),
  description: text('description'),

  /** Which of the four legacy public axes this node rolls up to. */
  legacyCategory: text('legacy_category'),

  policy: categoryPolicy('policy').notNull().default('requires_review'),
  /** Set when policy is 'prohibited' or 'restricted' — the seller is told why. */
  policyReason: text('policy_reason'),

  // ── What 'restricted' actually requires ───────────────────────────────────
  requiresBrandAuthorisation: boolean('requires_brand_authorisation').notNull().default(false),
  requiresCertification: boolean('requires_certification').notNull().default(false),
  requiresAgeStatement: boolean('requires_age_statement').notNull().default(false),
  requiresSafetyClassification: boolean('requires_safety_classification').notNull().default(false),
  /** A federation grant a seller needs before listing here at all. */
  requiresFederationApproval: boolean('requires_federation_approval').notNull().default(false),

  /** Tax classification defaults. NULLABLE — MMAKF's accountant decides these. */
  hsnCode: text('hsn_code'),
  taxCategoryCode: text('tax_category_code'),
  shippingClass: text('shipping_class'),

  active: boolean('active').notNull().default(true),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugUk: uniqueIndex('marketplace_categories_slug_uk').on(t.slug),
  pathIdx: index('marketplace_categories_path_idx').on(t.path),
  parentIdx: index('marketplace_categories_parent_idx').on(t.parentId, t.sortOrder),
  policyIdx: index('marketplace_categories_policy_idx').on(t.policy),
}));

// ─── Variants ───────────────────────────────────────────────────────────────

export const variantStatus = pgEnum('listing_variant_status', [
  'active', 'out_of_stock', 'discontinued',
]);

/**
 * What is actually bought.
 *
 * `attributes` holds the axes the brief names — size, colour, weight, model,
 * pack size, configuration — as { size: '170cm', colour: 'white' }. JSONB and
 * not columns, because the axes differ by category: a gi has a size, a mitt has
 * a hand, a book has neither. Columns for all of them would be a table that is
 * mostly null and still missing the next one.
 *
 * `sku` is the MARKETPLACE's identifier and is unique across the marketplace;
 * `sellerSku` is whatever the seller calls it in their own system and is unique
 * only within that seller. Both are needed: the first is what an order line
 * points at for ever, the second is what makes a bulk import match rows to
 * existing products instead of duplicating them.
 */
export const listingVariants = pgTable('listing_variants', {
  id: serial('id').primaryKey(),
  listingId: integer('listing_id').notNull().references(() => listings.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),

  sku: text('sku').notNull(),
  sellerSku: text('seller_sku'),
  barcode: text('barcode'),
  gtin: text('gtin'),

  label: text('label').notNull(),                  // "Size 170cm, white"
  attributes: jsonb('attributes'),                 // { size: '170cm', colour: 'white' }

  /** INTEGER MINOR UNITS. ₹1,799 is 179900. Never a float, never rupees. */
  priceMinor: integer('price_minor').notNull(),
  compareAtMinor: integer('compare_at_minor'),
  currency: text('currency').notNull().default('INR'),

  weightGrams: integer('weight_grams'),
  lengthMm: integer('length_mm'),
  widthMm: integer('width_mm'),
  heightMm: integer('height_mm'),

  status: variantStatus('status').notNull().default('active'),
  sortOrder: integer('sort_order').notNull().default(0),

  /**
   * The roll-up of this variant's stock across every location, cached for
   * listing pages. THE AUTHORITATIVE COUNT IS stock_items — nothing sells
   * against this column, and src/db/inventory.ts recomputes it inside the same
   * transaction that moves the real stock.
   */
  availableQty: integer('available_qty').notNull().default(0),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  skuUk: uniqueIndex('listing_variants_sku_uk').on(t.sku),
  listingIdx: index('listing_variants_listing_idx').on(t.listingId, t.sortOrder),
  // A seller's own SKU is unique WITHIN that seller. Partial, because it is
  // optional, and a unique index over nulls constrains nothing in Postgres.
  sellerSkuUk: uniqueIndex('listing_variants_seller_sku_uk').on(t.sellerId, t.sellerSku)
    .where(sql`seller_sku is not null`),
  sellerIdx: index('listing_variants_seller_idx').on(t.sellerId),
}));

// ─── Moderation ─────────────────────────────────────────────────────────────

/**
 * The quality problems the brief enumerates, as an enum so they can be counted.
 *
 * `false_official_claim` is the one that must never be folded into
 * `misleading_claim`: a seller implying MMAKF endorsement is an attack on the
 * federation's own authority, not a marketing exaggeration, and it needs to be
 * separately reportable to the people who decide about badges.
 */
export const listingFlagKind = pgEnum('listing_flag_kind', [
  'duplicate',
  'wrong_image',
  'wrong_category',
  'misleading_claim',
  'incorrect_brand',
  'unsupported_affiliation',
  'false_certification',
  'false_official_claim',
  'prohibited_item',
  'unsafe_item',
  'price_manipulation',
  'other',
]);

export const listingFlagStatus = pgEnum('listing_flag_status', [
  'open', 'investigating', 'upheld', 'dismissed', 'withdrawn',
]);

/**
 * A concern raised about a listing — by a reviewer, an automated check, a buyer
 * or a brand.
 *
 * SEPARATE FROM THE REVIEW DECISION, deliberately. A rejection is a decision
 * about a submission; a flag is a concern about an item that may already be
 * live and may turn out to be nothing. Folding them together would mean the
 * only way to record a suspicion is to reject the listing, so suspicions go
 * unrecorded until somebody is sure — which is exactly when the pattern across
 * several sellers stops being visible.
 *
 * `raisedBySystem` marks the automated ones. AI may flag; only a human upholds.
 */
export const listingFlags = pgTable('listing_flags', {
  id: serial('id').primaryKey(),
  listingId: integer('listing_id').notNull().references(() => listings.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  kind: listingFlagKind('kind').notNull(),
  detail: text('detail').notNull(),
  evidence: jsonb('evidence'),

  raisedByUserId: integer('raised_by_user_id').references(() => users.id),
  /** True for automated checks. The reviewer needs to know which it is. */
  raisedBySystem: boolean('raised_by_system').notNull().default(false),
  raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),

  status: listingFlagStatus('status').notNull().default('open'),
  decidedByUserId: integer('decided_by_user_id').references(() => users.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),
  /** What was done: quarantined, delisted, edited, nothing. */
  actionTaken: text('action_taken'),
}, (t) => ({
  listingIdx: index('listing_flags_listing_idx').on(t.listingId),
  sellerIdx: index('listing_flags_seller_idx').on(t.sellerId),
  openIdx: index('listing_flags_open_idx').on(t.status, t.raisedAt),
}));

// ─── Counterfeit and authenticity ───────────────────────────────────────────

export const authenticityCaseStatus = pgEnum('authenticity_case_status', [
  'opened', 'evidence_requested', 'seller_responded', 'under_review',
  'upheld', 'dismissed', 'withdrawn',
]);

/**
 * A formal counterfeit or authenticity investigation.
 *
 * NOT a listing flag with a longer name. A flag is about one item; a case is
 * about a claim of counterfeiting, which reaches the SELLER, may reach several
 * of their listings at once, involves a brand owner as a third party, and ends
 * in an enforcement decision that has to be defensible. The evidence trail and
 * the seller's right to respond are what make it a separate record.
 *
 * QUARANTINE IS APPLIED SEPARATELY, on the listing, and can happen the moment a
 * case opens — before any finding. That is deliberate: withdrawing an item
 * while it is investigated is a precaution, and requiring a finding first would
 * mean suspected counterfeits stay on sale for the length of the investigation.
 */
export const authenticityCases = pgTable('authenticity_cases', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                     // MMAKF-AUTH-2026-000001
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  listingId: integer('listing_id').references(() => listings.id),
  brandId: integer('brand_id').references(() => brands.id),

  /** brand_owner | buyer | federation | seller | automated */
  complainantKind: text('complainant_kind').notNull(),
  complainantName: text('complainant_name'),
  complainantContact: text('complainant_contact'),
  /** Set when the complaint came from a buyer, so the order is reachable. */
  orderId: integer('order_id'),

  allegation: text('allegation').notNull(),
  evidence: jsonb('evidence'),

  status: authenticityCaseStatus('status').notNull().default('opened'),
  sellerResponse: text('seller_response'),
  sellerRespondedAt: timestamp('seller_responded_at', { withTimezone: true }),
  sellerEvidence: jsonb('seller_evidence'),
  responseDueAt: timestamp('response_due_at', { withTimezone: true }),

  decidedByUserId: integer('decided_by_user_id').references(() => users.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decision: text('decision'),
  /** listings quarantined, seller restricted, seller suspended, nothing. */
  enforcement: jsonb('enforcement'),

  openedByUserId: integer('opened_by_user_id').references(() => users.id),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('authenticity_cases_ref_uk').on(t.ref),
  sellerIdx: index('authenticity_cases_seller_idx').on(t.sellerId),
  statusIdx: index('authenticity_cases_status_idx').on(t.status),
  brandIdx: index('authenticity_cases_brand_idx').on(t.brandId),
}));

// ─── Bulk import ────────────────────────────────────────────────────────────

export const importStatus = pgEnum('product_import_status', [
  'uploaded', 'validating', 'preview', 'failed',
  'submitted', 'partially_published', 'published', 'cancelled',
]);

/**
 * A bulk product upload, as a staged pipeline.
 *
 * "NEVER DIRECTLY IMPORT INTO PRODUCTION CATALOGUE" is the brief's instruction
 * and this table is how it is kept. Rows land in `product_import_rows` and are
 * validated, deduplicated and category-mapped THERE; a listing is created only
 * when the import is submitted, and it is created as a DRAFT that goes through
 * the same moderation queue as a hand-typed one.
 *
 * The alternative — writing listings and marking them pending — looks
 * equivalent and is not: it puts five hundred unreviewed rows into the table
 * the public query reads from, and leaves the whole marketplace one forgotten
 * predicate away from publishing them.
 */
export const productImports = pgTable('product_imports', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  ref: text('ref').notNull(),
  filename: text('filename'),
  storageKey: text('storage_key'),
  status: importStatus('status').notNull().default('uploaded'),

  rowCount: integer('row_count').notNull().default(0),
  validCount: integer('valid_count').notNull().default(0),
  errorCount: integer('error_count').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  publishedCount: integer('published_count').notNull().default(0),

  /** Aggregate findings, for the seller's preview screen. */
  report: jsonb('report'),
  failureReason: text('failure_reason'),

  uploadedByUserId: integer('uploaded_by_user_id').references(() => users.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => ({
  refUk: uniqueIndex('product_imports_ref_uk').on(t.ref),
  sellerIdx: index('product_imports_seller_idx').on(t.sellerId, t.uploadedAt),
}));

export const importRowStatus = pgEnum('product_import_row_status', [
  'pending', 'valid', 'invalid', 'duplicate', 'created', 'skipped',
]);

export const productImportRows = pgTable('product_import_rows', {
  id: serial('id').primaryKey(),
  importId: integer('import_id').notNull().references(() => productImports.id),
  rowNo: integer('row_no').notNull(),
  /** The row exactly as uploaded. Never normalised in place. */
  raw: jsonb('raw').notNull(),
  /** What validation made of it — resolved category, parsed price, mapped SKU. */
  resolved: jsonb('resolved'),
  status: importRowStatus('status').notNull().default('pending'),
  errors: jsonb('errors'),
  /** The listing this row became, once the import was submitted and approved. */
  listingId: integer('listing_id').references(() => listings.id),
  variantId: integer('variant_id').references(() => listingVariants.id),
  /** The existing listing this row was found to duplicate. */
  duplicateOfListingId: integer('duplicate_of_listing_id').references(() => listings.id),
}, (t) => ({
  rowUk: uniqueIndex('product_import_rows_row_uk').on(t.importId, t.rowNo),
  statusIdx: index('product_import_rows_status_idx').on(t.importId, t.status),
}));
