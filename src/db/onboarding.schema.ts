// Onboarding, seller standing and the marketplace review spine.
//
// WHAT THE FEDERATION ASKED FOR, AND WHAT IT MEANS FOR A SCHEMA.
//
// "make sure all should be able to create and access their authorised section
//  only — like coach, referee, seller. If onboarded they can list their items
//  after approval by our people in admin."
//
// Read carefully, that sentence contains the whole security model:
//
//   · anyone may CREATE an account;
//   · creating one confers NOTHING;
//   · a person APPLIES to be a coach, a referee, an official or a seller;
//   · MMAKF staff review, and only then does authority exist;
//   · a seller who has been approved as a seller still cannot put an item in
//     front of the public until THAT ITEM has been approved.
//
// So there are two independent gates on the commerce path, not one, and this
// schema is built so that neither can be satisfied by accident.
//
// SIX RULES SHAPE THE TABLES.
//
//  1. AUTHORITY IS A ROLE BINDING, AND A ROLE BINDING IS THE OUTPUT OF A HUMAN
//     DECISION. `role_applications` is a REQUEST. It is not authority, it never
//     becomes authority on its own, and nothing reads it to answer `can()`. The
//     only thing an approval does is call the existing grant path in
//     src/db/users.ts, which is itself gated by canGrantRole() in
//     src/lib/rbac.ts. There is deliberately no second way to mint a binding —
//     an application queue that could write role_bindings directly would be a
//     privilege-escalation vector wearing an admin screen.
//
//  2. AN APPLICATION CARRIES ITS OWN SCOPE. A coach applies to be a coach IN A
//     PLACE. The scope travels on the application row and the binding is made
//     at THAT scope, never at a scope the reviewer types in afterwards. This is
//     what stops a Jharkhand administrator approving a coach nationally: the
//     scope is not theirs to choose.
//
//  3. EVIDENCE IS CAPTURED, NEVER JUDGED BY THE SCHEMA. What grade, licence or
//     experience qualifies somebody as a coach or a referee is a FEDERATION
//     decision and MMAKF has not published one. `evidence` is free-form jsonb
//     precisely so that no column here quietly becomes a requirement nobody
//     set. A NOT NULL on `licence_number` would be this file inventing policy.
//
//  4. THE COMMERCIAL DETAILS OF A SELLER ARE RECORDED, NOT REQUIRED. GST, PAN
//     and bank details are all nullable. Whether MMAKF requires them before
//     someone may sell is a federation decision that has not been made, and a
//     NOT NULL would make it silently, in a migration, forever.
//
//  5. A LISTING CARRIES THE HASH OF WHAT WAS APPROVED. See `listings` below —
//     this is the mechanism behind the rule that gets forgotten, that editing
//     an approved listing returns it to review.
//
//  6. MONEY IS INTEGER PAISE. `price_minor`, integer, as in src/db/orders.ts
//     and src/db/fees.ts. A rupee expressed as a float is a rounding error
//     waiting for a large enough basket.
//
// AND THE THINGS THIS FILE REFUSES TO DECIDE, because every one of them belongs
// to MMAKF and not to an engineer: what qualifies a coach or a referee; any
// commission, platform fee or payout split; whether GST/PAN/bank details are
// mandatory; any listing category beyond the four the site already uses; and
// how long a review takes. Each has a place to arrive and no default.

import {
  pgTable, serial, text, integer, timestamp, jsonb, pgEnum,
  index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { and, eq, sql } from 'drizzle-orm';
import { persons, stateUnits, districtUnits, dojos, users } from './schema';

// ─── Role applications ──────────────────────────────────────────────────────

/**
 * The life of a request for authority.
 *
 * `superseded` exists because a rejected applicant may reapply with better
 * evidence, and the federation must be able to see the earlier attempt and the
 * reason it failed. Overwriting the first application would destroy exactly the
 * history a reviewer needs to make the second decision.
 */
export const applicationStatus = pgEnum('role_application_status', [
  'submitted', 'under_review', 'approved', 'rejected', 'withdrawn', 'superseded',
]);

/**
 * Applications may only be OPEN in these states. Declared once, here, beside
 * the enum it constrains — the public-event visibility rule taught this project
 * what four private copies of a status list cost (see tests/single-source.test.ts).
 */
export const OPEN_APPLICATION_STATUSES = ['submitted', 'under_review'] as const;

/**
 * A request to be bound to a role, at a scope.
 *
 * `requested_role` is TEXT and not a pgEnum, deliberately, for the same reason
 * `role_bindings.role` is text: the role list lives in src/lib/rbac.ts and a
 * database enum would be a second copy of it. Two copies of a role list is two
 * answers to "what roles exist" the day one is edited.
 */
export const roleApplications = pgTable('role_applications', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                       // MMAKF-APP-2026-000001

  // WHO IS ASKING. A user, not a person: a brand-new account has no `persons`
  // row and must still be able to apply. `personId` is filled in when the
  // account is already attached to a federation record, so a reviewer can see
  // the applicant's rank and membership rather than a bare email address.
  applicantUserId: integer('applicant_user_id').notNull().references(() => users.id),
  personId: integer('person_id').references(() => persons.id),

  requestedRole: text('requested_role').notNull(),  // see ROLES in src/lib/rbac.ts

  // WHERE. The binding is made at this scope and no other — see rule 2 above.
  //
  // TEXT, not the `scope_type` pgEnum, matching commerce.schema.ts and
  // governance.schema.ts which made the same choice for the same reason: the
  // enum is declared in schema.ts, and schema.ts re-exports this file. A
  // `.references(() => …)` callback survives that cycle because it is lazy; a
  // column TYPE is dereferenced while the module is still initialising, and
  // drizzle-kit dies with "Cannot access 'scopeType' before initialization".
  // The ScopeType union in src/lib/rbac.ts is what actually constrains callers.
  scopeType: text('scope_type').notNull(),
  scopeId: integer('scope_id'),                     // null == national

  /**
   * WHATEVER THE APPLICANT SUPPLIED. Grades, licences, years of experience,
   * referees, certificate numbers, a link to a video — all of it, unvalidated,
   * because the federation has not published what qualifies anybody and a
   * schema that enforced a guess would refuse the applicants MMAKF wanted.
   */
  evidence: jsonb('evidence'),

  status: applicationStatus('status').notNull().default('submitted'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),

  reviewedByUserId: integer('reviewed_by_user_id').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  /** Why it was refused, or the note recorded with an approval. Never null on a decision. */
  decisionReason: text('decision_reason'),

  /** Set when a later application replaces this one, so the chain is walkable. */
  supersededByApplicationId: integer('superseded_by_application_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('role_applications_ref_uk').on(t.ref),
  applicantIdx: index('role_applications_applicant_idx').on(t.applicantUserId),
  statusIdx: index('role_applications_status_idx').on(t.status),
  scopeIdx: index('role_applications_scope_idx').on(t.scopeType, t.scopeId),

  // ONE OPEN APPLICATION PER PERSON, PER ROLE, PER SCOPE — enforced by the
  // database rather than by a SELECT-then-INSERT in application code, because
  // two submissions landing in the same millisecond both read "none open" and
  // both insert. Two open applications for the same thing is not merely untidy:
  // both can be approved, and the second approval is a decision made about a
  // request the reviewer believed was the only one.
  //
  // Two indexes, not one, because Postgres treats NULLs as distinct in a unique
  // index — so a single index on (…, scope_id) would let a user file unlimited
  // NATIONAL applications for the same role, which is precisely the scope an
  // attacker would choose.
  oneOpenScoped: uniqueIndex('role_applications_one_open_scoped_uk')
    .on(t.applicantUserId, t.requestedRole, t.scopeType, t.scopeId)
    .where(sql`status IN ('submitted', 'under_review') AND scope_id IS NOT NULL`),
  oneOpenNational: uniqueIndex('role_applications_one_open_national_uk')
    .on(t.applicantUserId, t.requestedRole, t.scopeType)
    .where(sql`status IN ('submitted', 'under_review') AND scope_id IS NULL`),
}));

// ─── Sellers ────────────────────────────────────────────────────────────────

/**
 * `rejected` is in this list although the brief named only four states.
 *
 * Without it the only way to refuse a seller application is to leave it in
 * `applied` forever, and an applicant who is never told no is worse served than
 * one who is told no with a reason. A refusal is a decision somebody made and
 * it belongs in the record with the reason attached.
 *
 * `withdrawn` is the SELLER's own decision; `suspended` and `rejected` are the
 * federation's. Collapsing them would make the register unable to say whether a
 * shop closed or was closed.
 */
export const sellerStatus = pgEnum('seller_status', [
  'applied', 'approved', 'rejected', 'suspended', 'withdrawn',
]);

/**
 * A person or dojo approved to sell through MMAKF.
 *
 * SEPARATE FROM A ROLE BINDING ON PURPOSE. Selling is not authority over other
 * people's records — it confers no read of anybody's data — so making it a
 * role would put a shopkeeper inside the authorisation hierarchy. It is
 * standing in a marketplace, and standing lives in its own table with its own
 * lifecycle.
 */
export const sellers = pgTable('sellers', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                       // MMAKF-SEL-2026-000001

  // ONE SELLER ACCOUNT PER USER, enforced below. Without the constraint a user
  // whose shop was suspended simply applies again and trades under the new row,
  // and the suspension means nothing.
  userId: integer('user_id').notNull().references(() => users.id),
  personId: integer('person_id').references(() => persons.id),

  tradingName: text('trading_name').notNull(),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),
  addressLine: text('address_line'),
  city: text('city'),
  postcode: text('postcode'),

  // WHERE THE SELLER SITS IN THE FEDERATION'S GEOGRAPHY. This is what makes a
  // scoped reviewer possible at all: without it every seller is unlocated, and
  // an unlocated row is reachable only from a national binding — the fail-closed
  // reading, and the one a null here produces.
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),
  dojoId: integer('dojo_id').references(() => dojos.id),

  status: sellerStatus('status').notNull().default('applied'),

  // ── Tax and payout: CAPTURED, NEVER REQUIRED ──────────────────────────────
  //
  // Every one of these is nullable and no code path refuses an application for
  // their absence. Whether MMAKF requires a GSTIN before someone may sell is a
  // federation decision that has not been made; `missingCommercialDetails()` in
  // src/db/marketplace.ts reports which are absent so a reviewer can ask, and
  // that is the whole of the enforcement this system is entitled to apply.
  gstin: text('gstin'),
  pan: text('pan'),
  bankAccountName: text('bank_account_name'),
  bankAccountNumber: text('bank_account_number'),
  bankIfsc: text('bank_ifsc'),

  /** Free-form supporting material, on the same terms as an application's evidence. */
  evidence: jsonb('evidence'),

  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  approvedByUserId: integer('approved_by_user_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),

  suspendedByUserId: integer('suspended_by_user_id').references(() => users.id),
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),
  suspendedReason: text('suspended_reason'),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('sellers_ref_uk').on(t.ref),
  userUk: uniqueIndex('sellers_user_uk').on(t.userId),
  statusIdx: index('sellers_status_idx').on(t.status),
  stateIdx: index('sellers_state_idx').on(t.stateUnitId),
}));

// ─── Listings ───────────────────────────────────────────────────────────────

/**
 * The four categories the site already uses (src/data/seed.ts).
 *
 * A pgEnum and not free text, because an invented taxonomy is exactly the kind
 * of plausible-looking fabrication this project treats as its worst bug. The
 * federation extends this list by deciding to; a seller cannot extend it by
 * typing.
 */
export const listingCategory = pgEnum('listing_category', [
  'uniform', 'accessories', 'equipment', 'merch',
]);

/**
 * `delisted` is the federation removing an approved item from public view;
 * `withdrawn` is the seller doing so. Both are reversible and neither deletes,
 * because the federation may need to show what was on sale in March.
 */
export const listingStatus = pgEnum('listing_status', [
  'draft', 'submitted', 'approved', 'rejected', 'withdrawn', 'delisted',
]);

/**
 * An item a seller offers.
 *
 * ─── THE RULE THAT GETS FORGOTTEN ────────────────────────────────────────────
 *
 * EDITING AN APPROVED LISTING RETURNS IT TO REVIEW. Without it, listing
 * approval is theatre: a seller gets a plain karate-gi approved on Monday, and
 * on Tuesday edits the title, the photographs and the price into something
 * MMAKF never saw, under an approval MMAKF gave to something else.
 *
 * IMPLEMENTED AS A STATUS CHANGE DRIVEN BY A CONTENT HASH, and not as a new
 * listing version. The reasons, since the brief asked for the justification:
 *
 *   · The requirement is that the public query STOPS RETURNING THE ITEM the
 *     moment it is edited. A version model does the opposite by construction —
 *     the public keeps seeing the last approved version while the edit is
 *     pending, so the item never leaves the shop. That may be a defensible
 *     product decision; it is not the decision that was asked for.
 *
 *   · `content_hash` is recomputed from the reviewable fields on the ONE write
 *     path that may change them. `approved_content_hash` records what a human
 *     actually approved. The public predicate below then requires the two to be
 *     EQUAL — so even if some future refactor forgets to move the status, an
 *     edited listing still drops out of public view. The rule survives the
 *     refactor that would otherwise silently delete it.
 *
 *   · What was approved is not lost: `listing_revisions` keeps an append-only
 *     snapshot of every reviewed state, which is what lets the federation
 *     answer "what exactly did we approve?" a year later.
 *
 * STOCK IS NOT PART OF THE HASH. If it were, a seller who sold three gis would
 * push their listing back into the queue three times in a day, the queue would
 * become unreadable, and an unread queue approves everything. A stock count
 * also cannot mislead anybody about what the item IS, which is what review is
 * for.
 */
export const listings = pgTable('listings', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                       // MMAKF-LST-2026-000001
  sellerId: integer('seller_id').notNull().references(() => sellers.id),

  // ── Reviewable content: every field here feeds content_hash ───────────────
  title: text('title').notNull(),
  description: text('description'),
  category: listingCategory('category').notNull(),
  /** INTEGER PAISE. Never a float, never rupees. See src/db/orders.ts. */
  priceMinor: integer('price_minor').notNull(),
  currency: text('currency').notNull().default('INR'),

  // ── Not reviewable ────────────────────────────────────────────────────────
  stockQty: integer('stock_qty').notNull().default(0),

  status: listingStatus('status').notNull().default('draft'),

  /** Hash of the current reviewable content. Recomputed on every content write. */
  contentHash: text('content_hash').notNull(),
  /**
   * Hash of the content a human approved. Null until an approval happens.
   * Public visibility requires `content_hash = approved_content_hash`, which is
   * what makes rule 6 hold in SQL and not merely in a code path.
   */
  approvedContentHash: text('approved_content_hash'),

  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  reviewedByUserId: integer('reviewed_by_user_id').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  decisionReason: text('decision_reason'),

  /** Monotonic, and the primary key of the revision history with the listing id. */
  revision: integer('revision').notNull().default(1),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('listings_ref_uk').on(t.ref),
  sellerIdx: index('listings_seller_idx').on(t.sellerId),
  statusIdx: index('listings_status_idx').on(t.status),
  categoryIdx: index('listings_category_idx').on(t.category),
  // The public query's own index: only approved rows, which is the overwhelming
  // majority of reads and the smallest possible slice of the table.
  publicIdx: index('listings_public_idx')
    .on(t.category, t.id)
    .where(sql`status = 'approved'`),
}));

/**
 * Photographs, in order.
 *
 * `alt` is here rather than derived at render time because a screen-reader user
 * deserves the seller's own description of the item, and a generated
 * "Product image 2" is the accessibility failure docs/ACCESSIBILITY.md exists
 * to stop. It is nullable — an absent alt is recorded as absent rather than
 * filled with something invented — and the media set is part of the reviewable
 * content hash, so swapping the photographs on an approved listing returns it
 * to review exactly as changing the title does.
 */
export const listingMedia = pgTable('listing_media', {
  id: serial('id').primaryKey(),
  listingId: integer('listing_id').notNull().references(() => listings.id),
  url: text('url').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  alt: text('alt'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  listingIdx: index('listing_media_listing_idx').on(t.listingId),
  orderUk: uniqueIndex('listing_media_order_uk').on(t.listingId, t.sortOrder),
}));

export const listingRevisionAction = pgEnum('listing_revision_action', [
  'created', 'edited', 'submitted', 'approved', 'rejected', 'withdrawn', 'delisted', 'relisted',
]);

/**
 * Append-only history of what a listing looked like at each decision.
 *
 * A decision that points at a mutable row is not a record of a decision. When a
 * reviewer approves a listing, the thing they approved has to survive the next
 * edit, or the federation cannot answer the only question that matters after a
 * complaint: *what was actually on the site?* Nothing here is ever updated or
 * deleted.
 */
export const listingRevisions = pgTable('listing_revisions', {
  id: serial('id').primaryKey(),
  listingId: integer('listing_id').notNull().references(() => listings.id),
  revision: integer('revision').notNull(),
  action: listingRevisionAction('action').notNull(),
  contentHash: text('content_hash').notNull(),
  /** The reviewable content, frozen. Not a pointer to it. */
  snapshot: jsonb('snapshot').notNull(),
  statusAfter: listingStatus('status_after').notNull(),
  byUserId: integer('by_user_id').references(() => users.id),
  reason: text('reason'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  listingIdx: index('listing_revisions_listing_idx').on(t.listingId),
  // A PLAIN index, and emphatically NOT unique on (listing, revision, action).
  //
  // Uniqueness looked tidy and was wrong: the ordinary correction loop is
  // submit → reject → submit again with the content unchanged, which is two
  // 'submitted' rows at the same revision. A unique constraint turns the
  // second submission into a duplicate-key error, and the seller is locked out
  // of their own listing by the table that exists to record its history.
  // Same for withdraw-then-resubmit. A history that refuses to record a
  // repeated event is not a history.
  revisionIdx: index('listing_revisions_revision_idx').on(t.listingId, t.revision),
}));

// ─── The public visibility rule: ONE definition ─────────────────────────────

/**
 * What the public may see, expressed once, as SQL.
 *
 * THREE CONDITIONS, ALL IN THE QUERY, NEVER AFTER IT:
 *
 *   1. the LISTING has been approved;
 *   2. the SELLER is currently approved — which is what makes suspending a
 *      seller withdraw every one of their listings from public view in the same
 *      instant, without deleting a single row;
 *   3. the approved content is still the current content — the belt-and-braces
 *      half of rule 6, so an edit removes the item from the shop even if a
 *      future refactor drops the status change.
 *
 * A post-query `.filter()` doing this work would be one refactor away from
 * being deleted, and by the time it was, the unapproved rows would already be
 * in memory on their way to a template. Same rule as src/lib/search.ts.
 *
 * Callers MUST join `listings` to `sellers` for this predicate to mean anything;
 * `publicListings()` in src/db/marketplace.ts is the intended caller and the
 * only one that should need to build it by hand.
 */
export function publicListingPredicate() {
  return and(
    eq(listings.status, 'approved'),
    eq(sellers.status, 'approved'),
    eq(listings.contentHash, listings.approvedContentHash),
  );
}
