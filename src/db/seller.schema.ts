// Seller identity, verification, brand authorisation and policy acceptance.
//
// THE QUESTION THIS FILE EXISTS TO ANSWER: on what evidence did MMAKF let this
// person trade under the federation's name?
//
// Before 0025 the answer was a trading name, five nullable commercial fields
// and one approval by one reviewer. That is enough to open a shop and nowhere
// near enough to defend the decision afterwards — which is the moment it
// matters, when a buyer has been sent a counterfeit gi and asks who checked.
//
// ─── THE FOUR RULES THE SCHEMA ENFORCES RATHER THAN PROMISES ────────────────
//
//  1. VERIFICATION IS PER-CHECK, NOT PER-SELLER. `seller_verifications` holds
//     one row per (seller, check): identity, business, GST, PAN, bank, address,
//     brand. A single verified/unverified flag on the seller cannot express the
//     ordinary real state of affairs — identity confirmed, GST outstanding —
//     and a reviewer forced to choose between "verified" and "not" will choose
//     "verified" and write the caveat in a note nobody reads.
//
//  2. A BADGE IS A ROW, NEVER A STRING. Nothing a seller types can produce
//     "MMAKF Official". `seller_badge_grants` is written only by an
//     administrator holding `marketplace:review`, and every badge shown to the
//     public is derived from a grant or from a verification row that is
//     currently valid. The brief is explicit about this and it is the single
//     most forgeable thing in a marketplace.
//
//  3. RAW BANK CREDENTIALS ARE NOT KEPT HERE. `payout_accounts` stores the
//     PROVIDER'S handle for an account plus the last four digits and nothing
//     else. The federation does not need the number to pay somebody — the
//     provider does — and a table that never held it cannot leak it.
//
//  4. POLICY ACCEPTANCE POINTS AT A VERSION. `seller_policy_acceptances`
//     references a `policy_versions` row, not a policy. "The seller accepted
//     the seller agreement" is not a record of anything if the agreement has
//     been edited since; what was accepted has to be recoverable verbatim.
//
// NOTHING IS DELETED (§78). A revoked brand authorisation, a rejected
// verification and a superseded policy version all remain, because the question
// asked after an incident is always what was true in March.

import {
  pgTable, serial, text, integer, timestamp, date, boolean,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users, persons, stateUnits, districtUnits, dojos } from './schema';
import { sellers } from './onboarding.schema';

// ─── Addresses ──────────────────────────────────────────────────────────────

/**
 * WHY A SELLER HAS SEVERAL ADDRESSES AND THEY ARE NOT INTERCHANGEABLE.
 *
 * The registered address is what appears on the GST certificate and is a legal
 * fact. The operating address is where the people are. The warehouse is where
 * the stock is, and there may be more than one — that is what makes fulfilment
 * routing possible at all. The return address is where a buyer sends a gi back
 * to, and it is astonishingly often none of the other three.
 *
 * A single free-text address field, which is what the seller row had, cannot
 * hold any of this. It also cannot be searched, cannot drive a serviceability
 * check, and cannot tell a reviewer whether the warehouse is in the state the
 * seller claims to operate in.
 */
export const sellerAddressKind = pgEnum('seller_address_kind', [
  'registered', 'operating', 'warehouse', 'return', 'pickup',
]);

export const sellerAddresses = pgTable('seller_addresses', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  kind: sellerAddressKind('kind').notNull(),
  label: text('label'),

  // STRUCTURED, NOT ONE FREE-TEXT FIELD. The brief says so in capitals and it
  // is right: a district that only exists inside a string cannot be matched
  // against the federation's own district units, so a reviewer in Ramgarh
  // cannot be shown the sellers in Ramgarh.
  line1: text('line1'),
  line2: text('line2'),
  locality: text('locality'),
  city: text('city'),
  district: text('district'),
  state: text('state'),
  postcode: text('postcode'),
  country: text('country').notNull().default('IN'),

  /** Resolved against the federation's own geography where it can be. */
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),

  contactName: text('contact_name'),
  contactPhone: text('contact_phone'),

  isPrimary: boolean('is_primary').notNull().default(false),
  active: boolean('active').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sellerIdx: index('seller_addresses_seller_idx').on(t.sellerId, t.kind),
  // ONE PRIMARY PER KIND. Partial, so a seller may keep five warehouses and
  // exactly one of them is the default source. Without it, fulfilment routing
  // picks whichever row the planner returned first, which is a bug that
  // reproduces once a month and never in a test.
  primaryUk: uniqueIndex('seller_addresses_primary_uk').on(t.sellerId, t.kind)
    .where(sql`is_primary and active`),
}));

// ─── Verification ───────────────────────────────────────────────────────────

/**
 * The distinct things that can be verified about a seller.
 *
 * `manufacturer_authorisation` and `product_authorisation` are separate from
 * `brand_authorisation` because they are different documents from different
 * issuers: a distributor holds a letter from a manufacturer, a manufacturer
 * holds its own registration, and a reseller holds neither and is entitled to
 * sell anyway — just not to claim either.
 */
export const verificationCheck = pgEnum('seller_verification_check', [
  'identity',
  'business',
  'gst',
  'pan',
  'bank',
  'address',
  'brand_authorisation',
  'manufacturer_authorisation',
  'product_authorisation',
]);

/**
 * The lifecycle of one check. The brief names these eight exactly.
 *
 * `documents_required` is the one that earns its place: it is the difference
 * between "we are still looking at it" and "we are waiting for you", and a
 * queue that cannot tell those apart is a queue where every stalled application
 * looks like the reviewer's fault.
 *
 * `expired` is the other: a GST verification is a fact about a date. Recording
 * expiry as `rejected` would say MMAKF refused the seller, which it did not.
 */
export const verificationStatus = pgEnum('seller_verification_status', [
  'not_started', 'submitted', 'under_review', 'documents_required',
  'verified', 'rejected', 'suspended', 'expired',
]);

export const sellerVerifications = pgTable('seller_verifications', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  check: verificationCheck('check').notNull(),
  status: verificationStatus('status').notNull().default('not_started'),

  /**
   * What was actually looked at. Frozen — the reference numbers, the document
   * ids, the name the register returned. NOT the document itself, which lives
   * in seller_documents behind the storage layer.
   *
   * NEVER the full bank account number or a scan of an identity document.
   * See the file header, rule 3.
   */
  evidence: jsonb('evidence'),

  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  decidedByUserId: integer('decided_by_user_id').references(() => users.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  /**
   * Why. NOT NULL in practice for every refusing status: a rejection nobody can
   * explain is not a decision, it is an obstruction, and the seller has no way
   * to fix it.
   */
  reason: text('reason'),

  /** A verification of a document that expires, expires with it. */
  expiresAt: timestamp('expires_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // ONE ROW PER CHECK PER SELLER. The state of "is the GST verified?" must have
  // exactly one answer; two rows means two answers and the code picks one.
  sellerCheckUk: uniqueIndex('seller_verifications_seller_check_uk').on(t.sellerId, t.check),
  statusIdx: index('seller_verifications_status_idx').on(t.status, t.check),
  expiryIdx: index('seller_verifications_expiry_idx').on(t.expiresAt)
    .where(sql`status = 'verified' and expires_at is not null`),
}));

/**
 * Documents a seller submitted, by reference.
 *
 * `storageKey` is a key into src/lib/storage.ts, never a public URL. A
 * PAN card at a guessable URL is a PAN card that has been published; the
 * storage layer is what mediates every read, and it is the only thing that can
 * refuse one.
 */
export const sellerDocuments = pgTable('seller_documents', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  verificationId: integer('verification_id').references(() => sellerVerifications.id),
  kind: text('kind').notNull(),                 // gst_certificate | pan_card | brand_letter | ...
  label: text('label'),
  storageKey: text('storage_key').notNull(),
  mimeType: text('mime_type'),
  sizeBytes: integer('size_bytes'),
  uploadedByUserId: integer('uploaded_by_user_id').references(() => users.id),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  /** Set when superseded by a re-upload. The old one is never deleted. */
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
}, (t) => ({
  sellerIdx: index('seller_documents_seller_idx').on(t.sellerId, t.kind),
  verificationIdx: index('seller_documents_verification_idx').on(t.verificationId),
}));

// ─── Payout accounts ────────────────────────────────────────────────────────

export const payoutAccountStatus = pgEnum('payout_account_status', [
  'pending', 'verifying', 'verified', 'failed', 'disabled',
]);

/**
 * WHERE THE MONEY GOES, WITHOUT HOLDING WHAT WOULD LET SOMEBODY ELSE SEND IT
 * SOMEWHERE ELSE.
 *
 * The brief: "NEVER expose sensitive bank details to ordinary admins. Do not
 * store raw banking credentials unnecessarily. Use payment-provider onboarding
 * where possible." All three are the same instruction read at three depths, and
 * this table is the answer to it:
 *
 *   · `providerAccountId` is the provider's handle for a bank account the
 *     provider holds. That is what a payout call needs, and it is useless to
 *     anybody without the provider's own credentials.
 *   · `last4` and `bankName` exist so a human can confirm they are looking at
 *     the right account. Four digits identify; they do not enable.
 *   · THERE IS NO COLUMN FOR THE ACCOUNT NUMBER, and that is not an oversight
 *     to be corrected by a later migration. The legacy columns on `sellers`
 *     are the ones being retired; src/db/seller-registry.ts redacts them on
 *     every read and migration 0025 stops writing them.
 *
 * A seller may have more than one over time — accounts change — so the row is
 * never overwritten, only disabled.
 */
export const payoutAccounts = pgTable('payout_accounts', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),

  provider: text('provider').notNull(),           // razorpay | cashfree | manual
  /** The provider's own identifier. Meaningless without the provider's keys. */
  providerAccountId: text('provider_account_id'),
  providerContactId: text('provider_contact_id'),

  holderName: text('holder_name'),
  bankName: text('bank_name'),
  /** Four digits. Enough to recognise, not enough to use. */
  last4: text('last4'),
  /** Present so a human can spot a wrong-branch payout. Not a credential. */
  ifscPrefix: text('ifsc_prefix'),

  status: payoutAccountStatus('status').notNull().default('pending'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  failureReason: text('failure_reason'),

  isDefault: boolean('is_default').notNull().default(false),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  sellerIdx: index('payout_accounts_seller_idx').on(t.sellerId),
  // ONE DEFAULT, and only among live accounts. A payout that had to choose
  // between two "default" accounts would choose silently.
  defaultUk: uniqueIndex('payout_accounts_default_uk').on(t.sellerId)
    .where(sql`is_default and disabled_at is null`),
}));

// ─── Brands and authorisation ───────────────────────────────────────────────

export const brandStatus = pgEnum('brand_status', ['active', 'restricted', 'blocked']);

/**
 * A brand as a RECORD, so that "Adidas" is one thing on the marketplace rather
 * than eleven spellings across eleven sellers.
 *
 * `restricted` means: this brand may be listed only by a seller holding a
 * verified authorisation. That is the enforcement point for counterfeit
 * protection, and it is per-brand because MMAKF cannot reasonably demand a
 * letter of authorisation for a generic white gi.
 */
export const brands = pgTable('brands', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  name: text('name').notNull(),
  legalOwner: text('legal_owner'),
  website: text('website'),
  logoUrl: text('logo_url'),
  description: text('description'),
  status: brandStatus('status').notNull().default('active'),
  /**
   * TRUE means a listing naming this brand requires a verified authorisation
   * from its seller. Defaults to FALSE, because turning it on for every brand
   * would block the ordinary unbranded stock the federation's dojos actually
   * sell, and a control that blocks everything is turned off within a week.
   */
  requiresAuthorisation: boolean('requires_authorisation').notNull().default(false),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugUk: uniqueIndex('brands_slug_uk').on(t.slug),
  nameIdx: index('brands_name_idx').on(t.name),
}));

export const brandAuthorisationStatus = pgEnum('brand_authorisation_status', [
  'claimed', 'under_review', 'verified', 'rejected', 'expired', 'revoked',
]);

/**
 * THE ANSWER TO "AUTHORIZED ADIDAS DISTRIBUTOR".
 *
 * The brief's example is exact: a seller typing that phrase must not receive an
 * authorised-brand badge. So the badge comes from here and from nowhere else,
 * and this row is written by a reviewer looking at a document.
 *
 * `scope` is text and free-form because the real letters are: "protective
 * equipment only", "Jharkhand and Bihar", "until the 2027 season". Forcing
 * those into an enum would either lose the restriction or invent one.
 *
 * `validTo` matters more than it looks: an authorisation is a dated permission,
 * and the ordinary failure of every system like this is that it verifies once
 * and never looks again. src/db/seller-registry.ts:expiredAuthorisations()
 * exists so somebody can.
 */
export const brandAuthorisations = pgTable('brand_authorisations', {
  id: serial('id').primaryKey(),
  brandId: integer('brand_id').notNull().references(() => brands.id),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),

  /** manufacturer | distributor | reseller | licensee — as the letter says. */
  relationship: text('relationship').notNull(),
  scope: text('scope'),

  documentId: integer('document_id').references(() => sellerDocuments.id),
  issuer: text('issuer'),
  issuerContact: text('issuer_contact'),
  referenceNumber: text('reference_number'),
  validFrom: date('valid_from'),
  validTo: date('valid_to'),

  status: brandAuthorisationStatus('status').notNull().default('claimed'),
  verifiedByUserId: integer('verified_by_user_id').references(() => users.id),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),

  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  brandSellerIdx: index('brand_authorisations_brand_seller_idx').on(t.brandId, t.sellerId),
  sellerIdx: index('brand_authorisations_seller_idx').on(t.sellerId),
  // ONE LIVE AUTHORISATION per (brand, seller). Partial, so the history of
  // rejected and expired claims stays and does not collide.
  liveUk: uniqueIndex('brand_authorisations_live_uk').on(t.brandId, t.sellerId)
    .where(sql`status in ('claimed', 'under_review', 'verified')`),
}));

// ─── Badges ─────────────────────────────────────────────────────────────────

/**
 * The five controlled badges the brief names.
 *
 * Two are GRANTED by MMAKF and three are DERIVED from verification rows —
 * src/db/seller-registry.ts:badgesFor() computes them, and the split is the
 * point. A derived badge cannot drift from the evidence, because it IS the
 * evidence; a granted badge is a federation endorsement that must have a name
 * and a date attached to it.
 */
export const marketplaceBadge = pgEnum('marketplace_badge', [
  'mmakf_official',      // granted: this is the federation's own product line
  'mmakf_authorised',    // granted: MMAKF has endorsed this seller's goods
  'verified_seller',     // derived: identity + business verifications current
  'verified_brand',      // derived: a current brand_authorisations row
  'verified_product',    // granted per listing: MMAKF has inspected this item
]);

/**
 * An explicit federation endorsement, with a name and a date on it.
 *
 * WRITTEN ONLY BY `marketplace:review`. There is no code path from seller input
 * to this table, and that is the whole design: the brief's hard requirement is
 * that a seller must never be able to make "Official MMAKF Product" appear, and
 * the structural way to guarantee that is for the string to exist only as an
 * enum value in a table sellers cannot write.
 *
 * Either `sellerId` or `listingId` is set — a badge on a shop and a badge on an
 * item are different claims and the public presentation says which.
 */
export const sellerBadgeGrants = pgTable('seller_badge_grants', {
  id: serial('id').primaryKey(),
  badge: marketplaceBadge('badge').notNull(),
  sellerId: integer('seller_id').references(() => sellers.id),
  listingId: integer('listing_id'),

  grantedByUserId: integer('granted_by_user_id').references(() => users.id),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  /** The authority for the endorsement — a resolution, a meeting, a contract. */
  authority: text('authority'),
  reason: text('reason').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),

  revokedByUserId: integer('revoked_by_user_id').references(() => users.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason'),
}, (t) => ({
  sellerIdx: index('seller_badge_grants_seller_idx').on(t.sellerId)
    .where(sql`revoked_at is null`),
  listingIdx: index('seller_badge_grants_listing_idx').on(t.listingId)
    .where(sql`revoked_at is null`),
}));

// ─── Policy and agreement ───────────────────────────────────────────────────

export const policyKind = pgEnum('marketplace_policy_kind', [
  'seller_agreement', 'marketplace_terms', 'return_policy', 'shipping_policy',
  'privacy_policy', 'prohibited_products', 'counterfeit_policy', 'commission_schedule',
]);

/**
 * A policy is a NAME. Its text lives in versions, and only in versions.
 *
 * The distinction is what makes acceptance meaningful. "The seller accepted the
 * seller agreement" records nothing if the agreement is a mutable blob: by the
 * time the dispute arrives, the paragraph in question may have been written
 * after they signed.
 *
 * SHIPS EMPTY. MMAKF has not written these documents, and a plausible-looking
 * seeded seller agreement is exactly the fabrication this codebase treats as
 * its worst defect — it would be quoted back at a seller as though the
 * federation had approved it.
 */
export const marketplacePolicies = pgTable('marketplace_policies', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                  // marketplace.seller_agreement
  kind: policyKind('kind').notNull(),
  title: text('title').notNull(),
  summary: text('summary'),
  /** Whether a seller must accept the current version before trading. */
  mandatoryForSellers: boolean('mandatory_for_sellers').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('marketplace_policies_code_uk').on(t.code),
}));

export const policyVersions = pgTable('policy_versions', {
  id: serial('id').primaryKey(),
  policyId: integer('policy_id').notNull().references(() => marketplacePolicies.id),
  version: integer('version').notNull(),
  /** The document, verbatim. Never edited after publication. */
  body: text('body').notNull(),
  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  publishedByUserId: integer('published_by_user_id').references(() => users.id),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  /** A hash of the body, so a stored acceptance can be checked against it. */
  bodyHash: text('body_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  versionUk: uniqueIndex('policy_versions_version_uk').on(t.policyId, t.version),
  effectiveIdx: index('policy_versions_effective_idx').on(t.policyId, t.effectiveFrom),
}));

/**
 * Who accepted what, and when.
 *
 * POINTS AT A VERSION, and carries the body hash again so the acceptance can be
 * verified even if somebody later edits the version row it points at. Belt and
 * braces, on the same reasoning as the listing content hash: the rule survives
 * the refactor that would otherwise silently delete it.
 */
export const sellerPolicyAcceptances = pgTable('seller_policy_acceptances', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  policyVersionId: integer('policy_version_id').notNull().references(() => policyVersions.id),
  acceptedByUserId: integer('accepted_by_user_id').references(() => users.id),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
  /** Hashed, never raw — same treatment as audit_events.actorIpHash. */
  ipHash: text('ip_hash'),
  userAgent: text('user_agent'),
  bodyHash: text('body_hash').notNull(),
}, (t) => ({
  acceptanceUk: uniqueIndex('seller_policy_acceptances_uk').on(t.sellerId, t.policyVersionId),
  sellerIdx: index('seller_policy_acceptances_seller_idx').on(t.sellerId),
}));

// ─── Service-level expectations ─────────────────────────────────────────────

/**
 * How long a seller has, for each thing they owe.
 *
 * SHIPS EMPTY AND HAS NO DEFAULTS. Every column is nullable, and
 * src/db/seller-orders.ts reports "not set" rather than computing a due date
 * from a number this file invented. An SLA is a commercial commitment MMAKF
 * makes to buyers and imposes on sellers; a 48-hour dispatch window that an
 * engineer chose would be enforced against real people who never agreed to it.
 *
 * A row with sellerId NULL is the marketplace-wide default; a row with a
 * sellerId overrides it for that seller, which is how a contract with a large
 * distributor gets represented without a second mechanism.
 */
export const sellerSlaConfigs = pgTable('seller_sla_configs', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').references(() => sellers.id),
  acceptanceHours: integer('acceptance_hours'),
  dispatchHours: integer('dispatch_hours'),
  returnResponseHours: integer('return_response_hours'),
  supportResponseHours: integer('support_response_hours'),
  disputeResponseHours: integer('dispute_response_hours'),
  setByUserId: integer('set_by_user_id').references(() => users.id),
  authority: text('authority'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // One live default and one live override per seller. The uniqueness is over
  // `coalesce(seller_id, 0)` so the marketplace-wide row (seller_id NULL)
  // participates — a plain unique index would let a hundred "defaults" coexist,
  // because Postgres treats every NULL as distinct. The expression form lives
  // in drizzle/0025_marketplace_platform.sql; this is the read-side index.
  scopeIdx: index('seller_sla_configs_scope_idx').on(t.sellerId, t.active),
}));

// ─── The seller application, as a reviewable submission ─────────────────────

/**
 * WHAT THE APPLICANT DECLARED, frozen at the moment they declared it.
 *
 * Separate from the `sellers` row for the same reason `listing_revisions` is
 * separate from `listings`: the seller row is mutable and the application is
 * evidence. When a reviewer approves on the strength of "we have been trading
 * since 2011 and hold an Adidas letter", that sentence has to survive the
 * seller editing their profile the following week.
 */
export const sellerApplications = pgTable('seller_applications', {
  id: serial('id').primaryKey(),
  sellerId: integer('seller_id').notNull().references(() => sellers.id),
  ref: text('ref').notNull(),
  personId: integer('person_id').references(() => persons.id),
  dojoId: integer('dojo_id').references(() => dojos.id),

  /** Everything the form collected, frozen. */
  submission: jsonb('submission').notNull(),
  /** Which product categories they asked to sell in. Slugs, not free text. */
  requestedCategories: jsonb('requested_categories'),
  requestedBrands: jsonb('requested_brands'),
  expectedMonthlyOrders: integer('expected_monthly_orders'),
  hasWarehouse: boolean('has_warehouse'),
  shipsNationally: boolean('ships_nationally'),
  motivation: text('motivation'),

  /**
   * Risk flags raised automatically at submission — duplicate contact details,
   * a previously terminated seller at the same address, an implausible claim.
   *
   * FLAGS, NEVER DECISIONS. src/db/seller-registry.ts raises them and refuses
   * nobody; a human reads them. Automated refusal on a name match is how a
   * legitimate applicant with a common name is locked out with no appeal.
   */
  riskFlags: jsonb('risk_flags'),

  assignedReviewerUserId: integer('assigned_reviewer_user_id').references(() => users.id),
  slaDueAt: timestamp('sla_due_at', { withTimezone: true }),

  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('seller_applications_ref_uk').on(t.ref),
  sellerIdx: index('seller_applications_seller_idx').on(t.sellerId),
  reviewerIdx: index('seller_applications_reviewer_idx').on(t.assignedReviewerUserId),
}));
