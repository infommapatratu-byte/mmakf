// Sellers, listings, and the two gates between a seller and the public.
//
// THE RULE THAT SHAPES THE MODULE: BEING APPROVED TO SELL IS NOT PERMISSION TO
// PUT SOMETHING IN FRONT OF THE PUBLIC.
//
// The federation asked for two decisions and it is worth being exact about why
// they are two and not one. Approving a SELLER says: we know who this is, we
// are content for them to trade under the federation's name. Approving a
// LISTING says: we have seen THIS item, at THIS price, with THESE photographs.
// The first cannot stand in for the second, because an approved seller with an
// unreviewed listing is precisely the shop MMAKF has not seen.
//
// AND THE RULE THAT GETS FORGOTTEN: EDITING AN APPROVED LISTING RETURNS IT TO
// REVIEW. Otherwise the second gate is theatre — a plain karate-gi is approved
// on Monday and the title, photographs and price become something else on
// Tuesday, under an approval MMAKF gave to a different item. The mechanism is a
// content hash; the justification for that choice over listing versions is in
// src/db/onboarding.schema.ts above `listings`.
//
// HOW THE PUBLIC QUERY IS PROTECTED, in three layers, because one is not enough:
//
//   · publicListingPredicate() is the ONLY definition of public visibility and
//     it is SQL. Nothing filters after the fetch; by the time rows are in
//     memory, an unapproved item is one forgotten line away from a template.
//   · That predicate requires the SELLER to be approved as well as the listing,
//     which is what makes suspending a seller withdraw every listing they have
//     in the same instant, without deleting a row the federation may need.
//   · It also requires the approved content hash to still match the current
//     one, so an edited listing leaves public view even if some later refactor
//     drops the status change. The rule survives the refactor that would
//     otherwise silently delete it.
//
// WHAT THIS MODULE REFUSES TO INVENT — every one of these belongs to MMAKF:
// any commission, platform fee or payout split; whether GST, PAN or bank
// details are mandatory before somebody may sell; any listing category beyond
// the four the site already uses; and how long a review takes. Each is captured
// or reported as unset, and none has a plausible default, because a plausible
// default is the worst possible bug in this codebase.
//
// MONEY IS INTEGER PAISE, as in src/db/orders.ts and src/db/fees.ts.

import crypto from 'node:crypto';
import { and, asc, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import * as s from '@/db/schema';
import { publicListingPredicate } from '@/db/onboarding.schema';
import { allocateFederationId, writeAudit, resolvePlacement, type AuditContext } from '@/db/federation';
import { assertCan, canAnywhere, visibleScopes, type Principal } from '@/lib/rbac';

type DB = any;

export class MarketplaceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MarketplaceError';
    this.code = code;
  }
}

/** See calendar.ts for why identity is checked by shape and not `instanceof`. */
export function isMarketplaceError(err: unknown): err is MarketplaceError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'MarketplaceError';
}

// ─── What the federation has not decided ────────────────────────────────────

export const COMMISSION_NOT_SET =
  'The federation has not set a commission, platform fee or payout split for sellers.';

export const SELLER_REQUIREMENTS_NOT_SET =
  'The federation has not published whether GST, PAN or bank details are required in order to sell. ' +
  'They are recorded when supplied, and their absence is recorded when they are not.';

export const LISTING_REVIEW_TURNAROUND_NOT_SET =
  'The federation has not set a review turnaround time for listings.';

/**
 * The four categories the site already uses (src/data/seed.ts). Anything beyond
 * them is a taxonomy MMAKF has not decided, and inventing one is the failure
 * this project treats as unforgivable.
 */
export type ListingCategory = 'uniform' | 'accessories' | 'equipment' | 'merch';
export const LISTING_CATEGORIES: readonly ListingCategory[] = ['uniform', 'accessories', 'equipment', 'merch'];

export type SellerStatus = 'applied' | 'approved' | 'rejected' | 'suspended' | 'withdrawn';
export type ListingStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'withdrawn' | 'delisted';

// ─── Money ──────────────────────────────────────────────────────────────────

/** One crore rupees in paise. A sanity ceiling, not a federation price cap. */
const MAX_PRICE_MINOR = 100_000_000;

/**
 * A price must be an integer number of paise.
 *
 * `1799.99` is not a price in this system, it is a bug: a float that survived
 * as far as the database becomes a rounding error the moment it is multiplied
 * by a quantity or a tax rate. Refusing it here is cheaper than reconciling it
 * later.
 */
function assertPriceMinor(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new MarketplaceError(
      'bad_price',
      'A price must be an integer number of paise. ₹1,799 is 179900, never 1799.00.'
    );
  }
  if (value < 0) throw new MarketplaceError('bad_price', 'A price cannot be negative.');
  if (value > MAX_PRICE_MINOR) throw new MarketplaceError('bad_price', 'That price is implausibly large; check the units are paise.');
  return value;
}

function assertStock(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new MarketplaceError('bad_stock', 'Stock must be a whole number, zero or more.');
  }
  return value;
}

function requireReason(reason: unknown, what: string): string {
  const text = String(reason ?? '').trim();
  if (!text) {
    throw new MarketplaceError(
      'reason_required',
      `${what} requires a recorded reason. Without one the record cannot answer "why was this refused?" ` +
      'a year later, and the answer leaves with whoever decided it.'
    );
  }
  return text.slice(0, 2000);
}

// ─── Sellers ────────────────────────────────────────────────────────────────

export interface SellerApplicationInput {
  tradingName: string;
  contactEmail?: string | null;
  contactPhone?: string | null;
  addressLine?: string | null;
  city?: string | null;
  postcode?: string | null;
  stateUnitId?: number | null;
  districtUnitId?: number | null;
  dojoId?: number | null;
  /** Captured, never required. See SELLER_REQUIREMENTS_NOT_SET. */
  gstin?: string | null;
  pan?: string | null;
  bankAccountName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  evidence?: Record<string, unknown> | null;
}

/**
 * Which commercial details are absent.
 *
 * REPORTS, NEVER REFUSES. Whether MMAKF requires a GSTIN before somebody may
 * sell is a federation decision that has not been made, so this hands a
 * reviewer the list of what is missing and lets a human decide whether it
 * matters. A hard requirement here would encode a policy nobody set, and it
 * would turn away the sellers the federation wanted.
 */
export function missingCommercialDetails(seller: {
  gstin?: string | null; pan?: string | null;
  bankAccountName?: string | null; bankAccountNumber?: string | null; bankIfsc?: string | null;
}): { missing: string[]; note: string } {
  const missing: string[] = [];
  if (!seller.gstin?.trim()) missing.push('gstin');
  if (!seller.pan?.trim()) missing.push('pan');
  if (!seller.bankAccountName?.trim()) missing.push('bankAccountName');
  if (!seller.bankAccountNumber?.trim()) missing.push('bankAccountNumber');
  if (!seller.bankIfsc?.trim()) missing.push('bankIfsc');
  return { missing, note: SELLER_REQUIREMENTS_NOT_SET };
}

/**
 * Apply to sell.
 *
 * TAKES NO userId. The applicant is whoever is signed in — the structural way
 * to make applying on somebody else's behalf impossible.
 */
export async function applyToSell(
  db: DB, ctx: AuditContext, input: SellerApplicationInput
): Promise<{ sellerId: number; ref: string; status: 'applied'; missingCommercialDetails: string[] }> {
  const userId = ctx.principal?.userId ?? null;
  if (userId == null) throw new MarketplaceError('not_signed_in', 'Applying to sell requires a signed-in account.');

  const tradingName = String(input?.tradingName ?? '').trim();
  if (!tradingName) throw new MarketplaceError('bad_trading_name', 'A trading name is required — it is what the public will see.');

  // One seller row per user, checked here for a readable error and enforced by
  // a unique index for the case where two requests race. Without the index a
  // suspended seller could simply apply again and trade under the new row,
  // which would make suspension meaningless.
  const existing = (await db.select().from(s.sellers).where(eq(s.sellers.userId, userId)).limit(1))[0];
  if (existing) {
    throw new MarketplaceError(
      'already_applied',
      `This account already has a seller record (${existing.ref}, ${existing.status}). ` +
      'A second one would let a suspension be escaped by re-registering.'
    );
  }

  // Prove the declared placement agrees with itself before storing it. A
  // mismatched state/district pair would land the seller in a queue no reviewer
  // with authority over them can see.
  let placement;
  try {
    placement = await resolvePlacement(db, {
      stateUnitId: input.stateUnitId ?? null,
      districtUnitId: input.districtUnitId ?? null,
      dojoId: input.dojoId ?? null,
    });
  } catch (err: any) {
    throw new MarketplaceError('bad_placement', String(err?.message ?? 'Unknown unit.'));
  }

  const user = (await db.select().from(s.users).where(eq(s.users.id, userId)).limit(1))[0];
  const ref = await allocateFederationId(db, 'SEL');

  const [row] = await db.insert(s.sellers).values({
    ref,
    userId,
    personId: user?.personId ?? null,
    tradingName,
    contactEmail: input.contactEmail ?? null,
    contactPhone: input.contactPhone ?? null,
    addressLine: input.addressLine ?? null,
    city: input.city ?? null,
    postcode: input.postcode ?? null,
    stateUnitId: placement.stateUnitId,
    districtUnitId: placement.districtUnitId,
    dojoId: placement.dojoId,
    status: 'applied',
    gstin: input.gstin ?? null,
    pan: input.pan ?? null,
    bankAccountName: input.bankAccountName ?? null,
    bankAccountNumber: input.bankAccountNumber ?? null,
    bankIfsc: input.bankIfsc ?? null,
    evidence: input.evidence ?? null,
  }).returning({ id: s.sellers.id });

  await writeAudit(db, ctx, {
    entityType: 'seller',
    entityId: row.id,
    action: 'create',
    newValue: { ref, tradingName, status: 'applied', ...placement },
  });

  return {
    sellerId: row.id,
    ref,
    status: 'applied',
    missingCommercialDetails: missingCommercialDetails(input).missing,
  };
}

/**
 * The caller's own seller record, or null.
 *
 * NO sellerId PARAMETER, deliberately — the same construction as
 * myNotifications(). A function that cannot be asked about another seller
 * cannot be tricked into answering about one.
 */
export async function mySellerAccount(db: DB, principal: Principal) {
  if (principal?.userId == null) return null;
  const row = (await db.select().from(s.sellers).where(eq(s.sellers.userId, principal.userId)).limit(1))[0];
  if (!row) return null;
  return {
    ...row,
    // Never echo the bank account number back, even to its owner. It has no use
    // on a screen, and a value that is never rendered cannot leak through a
    // cached page, a screenshot or an error report.
    bankAccountNumber: row.bankAccountNumber ? `••••${String(row.bankAccountNumber).slice(-4)}` : null,
    commercialDetails: missingCommercialDetails(row),
    commission: COMMISSION_NOT_SET,
    /** The gate that matters to the seller: may they list anything at all yet? */
    mayCreateListings: row.status === 'approved',
  };
}

async function loadSeller(db: DB, sellerId: number) {
  const row = (await db.select().from(s.sellers).where(eq(s.sellers.id, sellerId)).limit(1))[0];
  if (!row) throw new MarketplaceError('unknown_seller', 'No such seller.');
  return row;
}

/** Where a seller sits, so scope can be checked against the same shape as a person. */
function sellerResource(seller: any) {
  return {
    stateUnitId: seller.stateUnitId ?? null,
    districtUnitId: seller.districtUnitId ?? null,
    dojoId: seller.dojoId ?? null,
  };
}

async function decideSeller(
  db: DB, ctx: AuditContext, sellerId: number,
  next: SellerStatus, reason: string,
  action: 'approve' | 'reject' | 'suspend' | 'reinstate',
  requiredAction: 'marketplace:review' | 'marketplace:suspend',
  allowedFrom: readonly SellerStatus[]
) {
  const seller = await loadSeller(db, sellerId);
  assertCan(ctx.principal, requiredAction, sellerResource(seller));

  // A reviewer deciding their own shop is the same failure as an applicant
  // approving their own application, and it is refused on the same terms.
  if (ctx.principal?.userId != null && ctx.principal.userId === seller.userId) {
    throw new MarketplaceError(
      'self_review',
      'A seller cannot decide their own seller record, whatever authority they hold.'
    );
  }

  if (!allowedFrom.includes(seller.status)) {
    throw new MarketplaceError(
      'bad_transition',
      `A seller that is ${seller.status} cannot be ${action}d. Allowed from: ${allowedFrom.join(', ')}.`
    );
  }

  const now = new Date();
  const patch: Record<string, unknown> = { status: next, updatedAt: now };
  if (action === 'approve') {
    patch.approvedByUserId = ctx.principal?.userId ?? null;
    patch.approvedAt = now;
    patch.decisionReason = reason;
    // Clearing the suspension fields on approval would erase the fact that a
    // suspension happened, so they are left exactly where they are.
  } else if (action === 'reject') {
    patch.decisionReason = reason;
  } else if (action === 'suspend') {
    patch.suspendedByUserId = ctx.principal?.userId ?? null;
    patch.suspendedAt = now;
    patch.suspendedReason = reason;
  } else if (action === 'reinstate') {
    patch.decisionReason = reason;
    // suspendedReason is KEPT. A reinstated seller who was once suspended is a
    // different record from one who never was, and the federation may need to
    // know which it is looking at.
  }

  await db.update(s.sellers).set(patch).where(eq(s.sellers.id, sellerId));

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'seller',
    entityId: sellerId,
    action: action === 'reinstate' ? 'reinstate' : action === 'suspend' ? 'suspend' : action,
    oldValue: { status: seller.status },
    newValue: { status: next },
  });

  return { sellerId, status: next };
}

export async function approveSeller(db: DB, ctx: AuditContext, sellerId: number, reason: string) {
  return decideSeller(
    db, ctx, sellerId, 'approved', requireReason(reason, 'Approving a seller'),
    'approve', 'marketplace:review', ['applied', 'rejected']
  );
}

export async function rejectSeller(db: DB, ctx: AuditContext, sellerId: number, reason: string) {
  return decideSeller(
    db, ctx, sellerId, 'rejected', requireReason(reason, 'Rejecting a seller application'),
    'reject', 'marketplace:review', ['applied']
  );
}

/**
 * Suspend a seller.
 *
 * NOTHING IS DELETED AND NO LISTING ROW IS TOUCHED. Every listing leaves public
 * view in the same instant because publicListingPredicate() requires the seller
 * to be approved — one status change, applied in SQL, to an unbounded number of
 * listings. A suspension is reversible; deletion is not, and the federation may
 * need the record. Reinstating the seller brings exactly the listings that were
 * approved back, and no others.
 */
export async function suspendSeller(db: DB, ctx: AuditContext, sellerId: number, reason: string) {
  return decideSeller(
    db, ctx, sellerId, 'suspended', requireReason(reason, 'Suspending a seller'),
    'suspend', 'marketplace:suspend', ['approved']
  );
}

export async function reinstateSeller(db: DB, ctx: AuditContext, sellerId: number, reason: string) {
  return decideSeller(
    db, ctx, sellerId, 'approved', requireReason(reason, 'Reinstating a seller'),
    'reinstate', 'marketplace:suspend', ['suspended']
  );
}

/**
 * The seller's own decision to stop trading. Takes no sellerId: it acts on the
 * caller's record and no other.
 */
export async function withdrawFromSelling(db: DB, ctx: AuditContext, reason?: string | null) {
  const userId = ctx.principal?.userId ?? null;
  if (userId == null) throw new MarketplaceError('not_signed_in', 'Withdrawing requires a signed-in account.');

  const updated = await db.update(s.sellers)
    .set({
      status: 'withdrawn',
      withdrawnAt: new Date(),
      decisionReason: String(reason ?? '').trim() || 'Withdrawn by the seller.',
      updatedAt: new Date(),
    })
    .where(and(
      eq(s.sellers.userId, userId),
      inArray(s.sellers.status, ['applied', 'approved']),
    ))
    .returning({ id: s.sellers.id });

  if (!updated.length) throw new MarketplaceError('not_withdrawable', 'You have no active seller record to withdraw.');

  await writeAudit(db, { ...ctx, reason: String(reason ?? '').trim() || null }, {
    entityType: 'seller',
    entityId: updated[0].id,
    action: 'update',
    newValue: { status: 'withdrawn', byTheSeller: true },
  });
  return { sellerId: updated[0].id, status: 'withdrawn' as const };
}

// ─── Scope filters for the review queues ────────────────────────────────────

/**
 * Restrict seller rows to the caller's scope, in SQL.
 *
 * Returns null for national reach and `sql\`false\`` for none, so "no predicate"
 * can never stand in for "every seller in the country".
 */
function sellerScopeCondition(principal: Principal): SQL | null {
  const scopes = visibleScopes(principal, 'marketplace:read');
  if (scopes.kind === 'all') return null;
  if (scopes.kind === 'none') return sql`false`;

  const parts: SQL[] = [];
  if (scopes.states.length) parts.push(inArray(s.sellers.stateUnitId, scopes.states) as SQL);
  if (scopes.districts.length) parts.push(inArray(s.sellers.districtUnitId, scopes.districts) as SQL);
  if (scopes.dojos.length) parts.push(inArray(s.sellers.dojoId, scopes.dojos) as SQL);
  if (!parts.length) return sql`false`;
  return (parts.length === 1 ? parts[0] : or(...parts)) as SQL;
}

export const MAX_QUEUE_ROWS = 200;

/** Seller applications the caller may act on. SQL-filtered by scope. */
export async function sellerQueue(
  db: DB, principal: Principal, opts: { statuses?: readonly SellerStatus[]; limit?: number } = {}
) {
  if (!canAnywhere(principal, 'marketplace:read')) {
    throw new MarketplaceError('forbidden', 'Reading the seller queue requires marketplace:read.');
  }
  const limit = Math.max(1, Math.min(MAX_QUEUE_ROWS, Math.floor(opts.limit ?? 100)));
  const statuses = (opts.statuses?.length ? opts.statuses : ['applied']) as string[];

  const where: SQL[] = [inArray(s.sellers.status, statuses as any)];
  const scoped = sellerScopeCondition(principal);
  if (scoped) where.push(scoped);

  const rows = await db.select({
    id: s.sellers.id,
    ref: s.sellers.ref,
    tradingName: s.sellers.tradingName,
    status: s.sellers.status,
    userId: s.sellers.userId,
    contactEmail: s.sellers.contactEmail,
    contactPhone: s.sellers.contactPhone,
    city: s.sellers.city,
    stateUnitId: s.sellers.stateUnitId,
    districtUnitId: s.sellers.districtUnitId,
    dojoId: s.sellers.dojoId,
    gstin: s.sellers.gstin,
    pan: s.sellers.pan,
    bankAccountName: s.sellers.bankAccountName,
    bankIfsc: s.sellers.bankIfsc,
    evidence: s.sellers.evidence,
    appliedAt: s.sellers.appliedAt,
  })
    .from(s.sellers)
    .where(and(...where))
    .orderBy(asc(s.sellers.appliedAt), asc(s.sellers.id))
    .limit(limit + 1);

  return {
    rows: rows.slice(0, limit).map((r: any) => ({
      ...r,
      commercialDetails: missingCommercialDetails({ ...r, bankAccountNumber: null }),
    })),
    truncated: rows.length > limit,
    commission: COMMISSION_NOT_SET,
    turnaround: LISTING_REVIEW_TURNAROUND_NOT_SET,
  };
}

// ─── Listings: the content hash ─────────────────────────────────────────────

export interface ListingMediaInput {
  url: string;
  alt?: string | null;
  sortOrder?: number;
}

export interface ReviewableContent {
  title: string;
  description: string | null;
  category: ListingCategory;
  priceMinor: number;
  currency: string;
  media: { url: string; alt: string | null; sortOrder: number }[];
}

/**
 * The fingerprint of everything a reviewer actually looked at.
 *
 * CANONICAL ORDER MATTERS. The media list is sorted before hashing and every
 * field is written in a fixed order, because otherwise re-saving an unchanged
 * listing produces a different hash, the listing drops out of public view for
 * no reason, and a seller learns that saving is dangerous.
 *
 * STOCK IS ABSENT ON PURPOSE. A seller who sells three gis would otherwise push
 * their listing back into the review queue three times in a day; the queue
 * would become unreadable, and an unread queue approves everything. A stock
 * count also cannot mislead anybody about what the item IS, which is the whole
 * question review answers.
 */
export function listingContentHash(content: ReviewableContent): string {
  const canonical = JSON.stringify([
    'v1',
    content.title.trim(),
    (content.description ?? '').trim(),
    content.category,
    content.priceMinor,
    content.currency,
    [...content.media]
      .map((m) => [m.url.trim(), (m.alt ?? '').trim()])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)),
  ]);
  return crypto.createHash('sha256').update(canonical).digest('base64url').slice(0, 32);
}

function normaliseMedia(media: ListingMediaInput[] | null | undefined) {
  if (!media) return [];
  if (!Array.isArray(media)) throw new MarketplaceError('bad_media', 'Media must be a list.');
  if (media.length > 12) throw new MarketplaceError('bad_media', 'A listing may carry at most 12 images.');
  return media.map((m, i) => {
    const url = String(m?.url ?? '').trim();
    if (!url) throw new MarketplaceError('bad_media', 'Every image needs a URL.');
    return { url, alt: m.alt?.trim() || null, sortOrder: Number.isInteger(m.sortOrder) ? m.sortOrder! : i };
  });
}

async function readContent(db: DB, listing: any): Promise<ReviewableContent> {
  const media = await db.select({
    url: s.listingMedia.url, alt: s.listingMedia.alt, sortOrder: s.listingMedia.sortOrder,
  }).from(s.listingMedia).where(eq(s.listingMedia.listingId, listing.id)).orderBy(asc(s.listingMedia.sortOrder));

  return {
    title: listing.title,
    description: listing.description ?? null,
    category: listing.category,
    priceMinor: listing.priceMinor,
    currency: listing.currency ?? 'INR',
    media: media.map((m: any) => ({ url: m.url, alt: m.alt ?? null, sortOrder: m.sortOrder })),
  };
}

/** Append a frozen snapshot. Never updated, never deleted — see the schema. */
async function recordRevision(
  db: DB, listingId: number, revision: number,
  action: 'created' | 'edited' | 'submitted' | 'approved' | 'rejected' | 'withdrawn' | 'delisted' | 'relisted',
  content: ReviewableContent, contentHash: string, statusAfter: ListingStatus,
  byUserId: number | null, reason: string | null
) {
  await db.insert(s.listingRevisions).values({
    listingId, revision, action, contentHash,
    snapshot: content as any, statusAfter, byUserId, reason,
  });
}

// ─── Listings: the seller's side ────────────────────────────────────────────

export interface CreateListingInput {
  title: string;
  description?: string | null;
  category: ListingCategory;
  /** INTEGER PAISE. ₹1,799 is 179900. */
  priceMinor: number;
  stockQty?: number;
  media?: ListingMediaInput[];
}

/**
 * Resolve the caller's own seller record and prove it may list.
 *
 * GATE ONE OF TWO. A seller who has applied but not been approved cannot create
 * a listing at all — not a draft, not a hidden one — because a listing that
 * exists is a listing that can be submitted, and the queue is not a waiting
 * room for people the federation has not accepted.
 */
async function requireApprovedSeller(db: DB, principal: Principal) {
  if (principal?.userId == null) throw new MarketplaceError('not_signed_in', 'Listing requires a signed-in account.');
  const seller = (await db.select().from(s.sellers).where(eq(s.sellers.userId, principal.userId)).limit(1))[0];
  if (!seller) {
    throw new MarketplaceError('not_a_seller', 'This account has no seller record. Apply to sell first.');
  }
  if (seller.status !== 'approved') {
    throw new MarketplaceError(
      'seller_not_approved',
      `A seller must be approved by MMAKF before listing anything. This account is ${seller.status}.`
    );
  }
  return seller;
}

export async function createListing(
  db: DB, ctx: AuditContext, input: CreateListingInput
): Promise<{ listingId: number; ref: string; status: 'draft' }> {
  const seller = await requireApprovedSeller(db, ctx.principal);

  const title = String(input?.title ?? '').trim();
  if (!title) throw new MarketplaceError('bad_title', 'A listing needs a title.');
  if (!LISTING_CATEGORIES.includes(input.category)) {
    throw new MarketplaceError(
      'bad_category',
      `Unknown category: ${String(input.category)}. The federation's categories are: ${LISTING_CATEGORIES.join(', ')}.`
    );
  }
  const priceMinor = assertPriceMinor(input.priceMinor);
  const stockQty = assertStock(input.stockQty ?? 0);
  const media = normaliseMedia(input.media);

  const content: ReviewableContent = {
    title, description: input.description?.trim() || null,
    category: input.category, priceMinor, currency: 'INR', media,
  };
  const contentHash = listingContentHash(content);
  const ref = await allocateFederationId(db, 'LST');

  return db.transaction(async (tx: DB) => {
    const [row] = await tx.insert(s.listings).values({
      ref, sellerId: seller.id,
      title, description: content.description, category: input.category,
      priceMinor, currency: 'INR', stockQty,
      // DRAFT, never submitted. Submitting is a separate act by the seller, so
      // "I was still writing it" cannot become "MMAKF approved it".
      status: 'draft',
      contentHash, approvedContentHash: null, revision: 1,
    }).returning({ id: s.listings.id });

    if (media.length) {
      await tx.insert(s.listingMedia).values(media.map((m) => ({
        listingId: row.id, url: m.url, alt: m.alt, sortOrder: m.sortOrder,
      })));
    }

    await recordRevision(tx, row.id, 1, 'created', content, contentHash, 'draft', ctx.principal?.userId ?? null, null);
    await writeAudit(tx, ctx, {
      entityType: 'listing', entityId: row.id, action: 'create',
      newValue: { ref, sellerId: seller.id, title, category: input.category, priceMinor, status: 'draft' },
    });

    return { listingId: row.id, ref, status: 'draft' as const };
  });
}

async function loadOwnListing(db: DB, principal: Principal, listingId: number) {
  if (principal?.userId == null) throw new MarketplaceError('not_signed_in', 'This requires a signed-in account.');
  const row = (await db
    .select({ listing: s.listings, seller: s.sellers })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.sellers.id, s.listings.sellerId))
    .where(and(eq(s.listings.id, listingId), eq(s.sellers.userId, principal.userId)))
    .limit(1))[0];
  // The seller id is part of the WHERE, so another seller's listing is not
  // "forbidden" — it simply does not match, and there is nothing to leak.
  if (!row) throw new MarketplaceError('unknown_listing', 'No listing of yours with that id.');
  return row;
}

export interface UpdateListingInput {
  title?: string;
  description?: string | null;
  category?: ListingCategory;
  priceMinor?: number;
  /** Supplying this REPLACES the whole media set. Omit it to leave media alone. */
  media?: ListingMediaInput[];
}

export interface UpdateListingResult {
  listingId: number;
  status: ListingStatus;
  /** True when the edit changed reviewable content. */
  contentChanged: boolean;
  /**
   * True when this edit pulled an already-approved listing back out of public
   * view. Surfaced so the seller is TOLD, rather than discovering it when the
   * item vanishes from the shop.
   */
  returnedToReview: boolean;
}

/**
 * Edit a listing.
 *
 * ─── RULE 6, THE ONE THAT GETS FORGOTTEN ─────────────────────────────────────
 *
 * If the edit changes reviewable content and the listing was APPROVED, the
 * listing goes back to `submitted` and its approved hash is cleared. It leaves
 * public view immediately, and a human looks at it again before it returns.
 *
 * Without this, listing approval means nothing: a seller gets a plain gi
 * approved, then edits the title, photographs and price into something MMAKF
 * never saw, and the federation's approval is attached to an item that no
 * longer exists.
 *
 * THIS IS THE ONLY WRITE PATH TO REVIEWABLE CONTENT. Media changes come through
 * here too, and not through a separate setter, because a second path is a
 * second place to forget the hash — and one forgotten hash is the whole hole
 * reopened.
 *
 * A NO-OP SAVE DOES NOT DISTURB AN APPROVAL. Pressing Save without changing
 * anything produces the same hash, so an approved listing stays approved. If it
 * did not, sellers would learn that touching the form costs them their place in
 * the shop, and they would stop correcting mistakes.
 */
export async function updateListing(
  db: DB, ctx: AuditContext, listingId: number, patch: UpdateListingInput
): Promise<UpdateListingResult> {
  const { listing, seller } = await loadOwnListing(db, ctx.principal, listingId);

  if (seller.status !== 'approved') {
    throw new MarketplaceError(
      'seller_not_approved',
      `A seller that is ${seller.status} cannot edit listings. The listings themselves are untouched.`
    );
  }

  const before = await readContent(db, listing);

  if (patch.category !== undefined && !LISTING_CATEGORIES.includes(patch.category)) {
    throw new MarketplaceError('bad_category', `Unknown category: ${String(patch.category)}.`);
  }
  const after: ReviewableContent = {
    title: patch.title !== undefined ? String(patch.title).trim() : before.title,
    description: patch.description !== undefined ? (patch.description?.trim() || null) : before.description,
    category: patch.category !== undefined ? patch.category : before.category,
    priceMinor: patch.priceMinor !== undefined ? assertPriceMinor(patch.priceMinor) : before.priceMinor,
    currency: before.currency,
    media: patch.media !== undefined ? normaliseMedia(patch.media) : before.media,
  };
  if (!after.title) throw new MarketplaceError('bad_title', 'A listing needs a title.');

  const nextHash = listingContentHash(after);
  const contentChanged = nextHash !== listing.contentHash;

  // An approval belongs to the content it was given for. The moment that
  // content moves, the approval no longer describes anything on the page.
  const wasPublic = listing.status === 'approved';
  const returnedToReview = contentChanged && wasPublic;
  const nextStatus: ListingStatus = returnedToReview ? 'submitted' : (listing.status as ListingStatus);
  const nextRevision = contentChanged ? listing.revision + 1 : listing.revision;

  if (!contentChanged) {
    return { listingId, status: listing.status as ListingStatus, contentChanged: false, returnedToReview: false };
  }

  return db.transaction(async (tx: DB) => {
    await tx.update(s.listings).set({
      title: after.title,
      description: after.description,
      category: after.category,
      priceMinor: after.priceMinor,
      contentHash: nextHash,
      // Cleared, not kept. Leaving the old approved hash in place would make
      // the public predicate's hash comparison meaningless the moment somebody
      // reverted an edit by hand.
      approvedContentHash: returnedToReview ? null : listing.approvedContentHash,
      status: nextStatus,
      submittedAt: returnedToReview ? new Date() : listing.submittedAt,
      // The previous decision is cleared with the status it belonged to: a
      // listing back in the queue must not display last week's approval.
      reviewedByUserId: returnedToReview ? null : listing.reviewedByUserId,
      reviewedAt: returnedToReview ? null : listing.reviewedAt,
      decisionReason: returnedToReview ? null : listing.decisionReason,
      revision: nextRevision,
      updatedAt: new Date(),
    }).where(eq(s.listings.id, listingId));

    if (patch.media !== undefined) {
      // The outgoing media set is not lost — the previous revision's snapshot
      // holds it, which is what makes "what were the photographs in March"
      // answerable after the seller replaces them.
      await tx.delete(s.listingMedia).where(eq(s.listingMedia.listingId, listingId));
      if (after.media.length) {
        await tx.insert(s.listingMedia).values(after.media.map((m) => ({
          listingId, url: m.url, alt: m.alt, sortOrder: m.sortOrder,
        })));
      }
    }

    await recordRevision(tx, listingId, nextRevision, 'edited', after, nextHash, nextStatus, ctx.principal?.userId ?? null, null);
    await writeAudit(tx, ctx, {
      entityType: 'listing', entityId: listingId, action: 'update',
      oldValue: { status: listing.status, contentHash: listing.contentHash },
      newValue: { status: nextStatus, contentHash: nextHash, returnedToReview },
    });

    return { listingId, status: nextStatus, contentChanged: true, returnedToReview };
  });
}

/**
 * Change stock without disturbing an approval.
 *
 * Separate from updateListing() because stock is not reviewable content — see
 * listingContentHash() for why folding it in would make the review queue
 * unreadable, and an unread queue approves everything.
 */
export async function setListingStock(
  db: DB, ctx: AuditContext, listingId: number, stockQty: number
): Promise<{ listingId: number; stockQty: number; status: ListingStatus }> {
  const { listing, seller } = await loadOwnListing(db, ctx.principal, listingId);
  if (seller.status !== 'approved') {
    throw new MarketplaceError('seller_not_approved', `A seller that is ${seller.status} cannot change stock.`);
  }
  const qty = assertStock(stockQty);
  await db.update(s.listings).set({ stockQty: qty, updatedAt: new Date() }).where(eq(s.listings.id, listingId));
  return { listingId, stockQty: qty, status: listing.status as ListingStatus };
}

/**
 * Put a listing in front of MMAKF for review.
 *
 * Allowed from `draft`, `rejected`, `withdrawn` and `delisted`. Including
 * `delisted` is deliberate: a listing the federation removed can be corrected
 * and resubmitted, and a human looks at it again. It cannot go back on sale
 * without that second look, which is what makes delisting worth doing.
 */
export async function submitListing(
  db: DB, ctx: AuditContext, listingId: number
): Promise<{ listingId: number; status: 'submitted' }> {
  const { listing, seller } = await loadOwnListing(db, ctx.principal, listingId);
  if (seller.status !== 'approved') {
    throw new MarketplaceError(
      'seller_not_approved',
      `A seller must be approved by MMAKF before submitting a listing. This account is ${seller.status}.`
    );
  }
  const from: ListingStatus[] = ['draft', 'rejected', 'withdrawn', 'delisted'];
  if (!from.includes(listing.status)) {
    throw new MarketplaceError('bad_transition', `A listing that is ${listing.status} cannot be submitted.`);
  }

  const content = await readContent(db, listing);
  await db.update(s.listings).set({
    status: 'submitted', submittedAt: new Date(),
    reviewedByUserId: null, reviewedAt: null, decisionReason: null,
    updatedAt: new Date(),
  }).where(eq(s.listings.id, listingId));

  await recordRevision(db, listingId, listing.revision, 'submitted', content, listing.contentHash, 'submitted', ctx.principal?.userId ?? null, null);
  await writeAudit(db, ctx, {
    entityType: 'listing', entityId: listingId, action: 'update',
    oldValue: { status: listing.status }, newValue: { status: 'submitted' },
  });

  return { listingId, status: 'submitted' };
}

/** The seller taking their own item off sale. Reversible; deletes nothing. */
export async function withdrawListing(
  db: DB, ctx: AuditContext, listingId: number, reason?: string | null
): Promise<{ listingId: number; status: 'withdrawn' }> {
  const { listing } = await loadOwnListing(db, ctx.principal, listingId);
  if (listing.status === 'withdrawn') {
    throw new MarketplaceError('bad_transition', 'That listing is already withdrawn.');
  }
  const content = await readContent(db, listing);
  const note = String(reason ?? '').trim() || 'Withdrawn by the seller.';

  await db.update(s.listings).set({
    status: 'withdrawn',
    // The approval is surrendered with the listing. Coming back means being
    // reviewed again — otherwise "withdraw and re-list" is a way to skip the
    // queue with content nobody re-read.
    approvedContentHash: null,
    updatedAt: new Date(),
  }).where(eq(s.listings.id, listingId));

  await recordRevision(db, listingId, listing.revision, 'withdrawn', content, listing.contentHash, 'withdrawn', ctx.principal?.userId ?? null, note);
  await writeAudit(db, { ...ctx, reason: note }, {
    entityType: 'listing', entityId: listingId, action: 'update',
    oldValue: { status: listing.status }, newValue: { status: 'withdrawn' },
  });
  return { listingId, status: 'withdrawn' };
}

/**
 * The caller's own listings.
 *
 * TAKES NO SELLER ID. The caller's user id resolves the seller inside the
 * query, which is the structural way to make reading somebody else's listings
 * impossible — the same construction as myNotifications() in
 * src/lib/notifications.ts. A `sellerId` parameter with an ownership check
 * beside it is one careless refactor from being an IDOR.
 */
export async function myListings(db: DB, principal: Principal, opts: { limit?: number } = {}) {
  if (principal?.userId == null) return [];
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 200)));

  return db.select({
    id: s.listings.id,
    ref: s.listings.ref,
    title: s.listings.title,
    category: s.listings.category,
    priceMinor: s.listings.priceMinor,
    currency: s.listings.currency,
    stockQty: s.listings.stockQty,
    status: s.listings.status,
    submittedAt: s.listings.submittedAt,
    reviewedAt: s.listings.reviewedAt,
    decisionReason: s.listings.decisionReason,
    revision: s.listings.revision,
    // Answers "is this actually on the site right now?" from the same three
    // conditions the public query uses, so the seller's screen and the shop
    // cannot disagree.
    publiclyVisible: sql<boolean>`(
      ${s.listings.status} = 'approved'
      AND ${s.sellers.status} = 'approved'
      AND ${s.listings.contentHash} = ${s.listings.approvedContentHash}
    )`,
  })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.sellers.id, s.listings.sellerId))
    .where(eq(s.sellers.userId, principal.userId))
    .orderBy(desc(s.listings.id))
    .limit(limit);
}

// ─── Listings: the federation's side ────────────────────────────────────────

/** Listings awaiting review, restricted in SQL to the caller's scope. */
export async function listingQueue(
  db: DB, principal: Principal, opts: { statuses?: readonly ListingStatus[]; limit?: number } = {}
) {
  if (!canAnywhere(principal, 'marketplace:read')) {
    throw new MarketplaceError('forbidden', 'Reading the listing queue requires marketplace:read.');
  }
  const limit = Math.max(1, Math.min(MAX_QUEUE_ROWS, Math.floor(opts.limit ?? 100)));
  const statuses = (opts.statuses?.length ? opts.statuses : ['submitted']) as string[];

  const where: SQL[] = [inArray(s.listings.status, statuses as any)];
  const scoped = sellerScopeCondition(principal);
  if (scoped) where.push(scoped);

  const rows = await db.select({
    id: s.listings.id,
    ref: s.listings.ref,
    title: s.listings.title,
    description: s.listings.description,
    category: s.listings.category,
    priceMinor: s.listings.priceMinor,
    currency: s.listings.currency,
    stockQty: s.listings.stockQty,
    status: s.listings.status,
    revision: s.listings.revision,
    submittedAt: s.listings.submittedAt,
    sellerId: s.sellers.id,
    sellerRef: s.sellers.ref,
    tradingName: s.sellers.tradingName,
    sellerStatus: s.sellers.status,
    stateUnitId: s.sellers.stateUnitId,
  })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.sellers.id, s.listings.sellerId))
    .where(and(...where))
    .orderBy(asc(s.listings.submittedAt), asc(s.listings.id))
    .limit(limit + 1);

  return {
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
    turnaround: LISTING_REVIEW_TURNAROUND_NOT_SET,
  };
}

export type ListingDecision =
  | { decision: 'approve'; reason: string }
  | { decision: 'reject'; reason: string };

/**
 * GATE TWO OF TWO. Approve or reject one item.
 *
 * The approval is recorded as a HASH of what was in front of the reviewer, not
 * as a flag on a row that can then change underneath it. That is what makes
 * "what did we approve?" answerable, and what makes an edit take the item off
 * the site without any further code being run.
 *
 * A reviewer cannot decide their own listing, for the same reason an applicant
 * cannot decide their own application.
 */
export async function reviewListing(
  db: DB, ctx: AuditContext, listingId: number, decision: ListingDecision
): Promise<{ listingId: number; status: 'approved' | 'rejected'; approvedContentHash: string | null }> {
  if (decision?.decision !== 'approve' && decision?.decision !== 'reject') {
    throw new MarketplaceError('bad_decision', 'A decision must be "approve" or "reject".');
  }
  const reason = requireReason((decision as any).reason, 'Deciding a listing');

  const row = (await db
    .select({ listing: s.listings, seller: s.sellers })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.sellers.id, s.listings.sellerId))
    .where(eq(s.listings.id, listingId))
    .limit(1))[0];
  if (!row) throw new MarketplaceError('unknown_listing', 'No such listing.');
  const { listing, seller } = row;

  assertCan(ctx.principal, 'marketplace:review', sellerResource(seller));

  if (ctx.principal?.userId != null && ctx.principal.userId === seller.userId) {
    throw new MarketplaceError('self_review', 'A seller cannot review their own listing, whatever authority they hold.');
  }
  if (listing.status !== 'submitted') {
    throw new MarketplaceError('bad_transition', `Only a submitted listing can be reviewed; this one is ${listing.status}.`);
  }
  // An approved listing belonging to a seller who is not approved would sit in
  // the database looking publishable, and would appear the instant the seller
  // was reinstated without anybody deciding that it should.
  if (decision.decision === 'approve' && seller.status !== 'approved') {
    throw new MarketplaceError(
      'seller_not_approved',
      `The seller is ${seller.status}. A listing cannot be approved for a seller the federation has not approved.`
    );
  }

  const content = await readContent(db, listing);
  const approve = decision.decision === 'approve';

  return db.transaction(async (tx: DB) => {
    // Claimed conditionally, so two reviewers pressing the button at the same
    // moment produce one decision and one loser who is told so.
    const claimed = await tx.update(s.listings).set({
      status: approve ? 'approved' : 'rejected',
      // The hash of exactly what was reviewed. If the content moves afterwards,
      // the public predicate stops matching and the item leaves the shop.
      approvedContentHash: approve ? listing.contentHash : null,
      reviewedByUserId: ctx.principal?.userId ?? null,
      reviewedAt: new Date(),
      decisionReason: reason,
      updatedAt: new Date(),
    })
      .where(and(eq(s.listings.id, listingId), eq(s.listings.status, 'submitted')))
      .returning({ id: s.listings.id });

    if (!claimed.length) throw new MarketplaceError('already_decided', 'That listing was decided by somebody else first.');

    await recordRevision(
      tx, listingId, listing.revision, approve ? 'approved' : 'rejected',
      content, listing.contentHash, approve ? 'approved' : 'rejected',
      ctx.principal?.userId ?? null, reason
    );
    await writeAudit(tx, { ...ctx, reason }, {
      entityType: 'listing', entityId: listingId,
      action: approve ? 'approve' : 'reject',
      oldValue: { status: 'submitted' },
      newValue: { status: approve ? 'approved' : 'rejected', approvedContentHash: approve ? listing.contentHash : null },
    });

    return {
      listingId,
      status: (approve ? 'approved' : 'rejected') as 'approved' | 'rejected',
      approvedContentHash: approve ? listing.contentHash : null,
    };
  });
}

/**
 * The federation removing an approved listing from public view.
 *
 * Distinct from the seller withdrawing it, and the distinction is the point: a
 * register that shows both as "not on sale" cannot say whether a shop took an
 * item down or was told to. Nothing is deleted.
 */
export async function delistListing(
  db: DB, ctx: AuditContext, listingId: number, reason: string
): Promise<{ listingId: number; status: 'delisted' }> {
  const note = requireReason(reason, 'Delisting an item');

  const row = (await db
    .select({ listing: s.listings, seller: s.sellers })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.sellers.id, s.listings.sellerId))
    .where(eq(s.listings.id, listingId))
    .limit(1))[0];
  if (!row) throw new MarketplaceError('unknown_listing', 'No such listing.');

  assertCan(ctx.principal, 'marketplace:suspend', sellerResource(row.seller));

  if (row.listing.status !== 'approved') {
    throw new MarketplaceError('bad_transition', `Only an approved listing can be delisted; this one is ${row.listing.status}.`);
  }

  const content = await readContent(db, row.listing);
  await db.update(s.listings).set({
    status: 'delisted',
    approvedContentHash: null,
    decisionReason: note,
    reviewedByUserId: ctx.principal?.userId ?? null,
    reviewedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(s.listings.id, listingId));

  await recordRevision(db, listingId, row.listing.revision, 'delisted', content, row.listing.contentHash, 'delisted', ctx.principal?.userId ?? null, note);
  await writeAudit(db, { ...ctx, reason: note }, {
    entityType: 'listing', entityId: listingId, action: 'update',
    oldValue: { status: 'approved' }, newValue: { status: 'delisted' },
  });
  return { listingId, status: 'delisted' };
}

/** Every reviewed state a listing has been in. The payoff of the revision table. */
export async function listingHistory(db: DB, principal: Principal, listingId: number) {
  const row = (await db
    .select({ listing: s.listings, seller: s.sellers })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.sellers.id, s.listings.sellerId))
    .where(eq(s.listings.id, listingId))
    .limit(1))[0];
  if (!row) throw new MarketplaceError('unknown_listing', 'No such listing.');

  // Its own seller, or somebody with authority over that seller's scope.
  const isOwner = principal?.userId != null && principal.userId === row.seller.userId;
  if (!isOwner) assertCan(principal, 'marketplace:read', sellerResource(row.seller));

  return db.select().from(s.listingRevisions)
    .where(eq(s.listingRevisions.listingId, listingId))
    .orderBy(asc(s.listingRevisions.id));
}

// ─── The public shop ────────────────────────────────────────────────────────

export interface PublicListingsOptions {
  category?: ListingCategory;
  limit?: number;
  offset?: number;
}

/**
 * What the public may see.
 *
 * NO PRINCIPAL, because there is no such thing as a listing that is public for
 * one anonymous visitor and not another — and because a principal parameter
 * invites a caller to pass one and quietly widen the result.
 *
 * FILTERED IN SQL, ENTIRELY. publicListingPredicate() in
 * src/db/onboarding.schema.ts is the single definition of visibility; nothing
 * here re-states it and nothing filters after the fetch. A post-query filter is
 * one refactor away from being dropped, and by then the unapproved rows are in
 * memory on their way to a template.
 */
export async function publicListings(db: DB, opts: PublicListingsOptions = {}) {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 48)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));

  const where: SQL[] = [publicListingPredicate() as SQL];
  if (opts.category) {
    if (!LISTING_CATEGORIES.includes(opts.category)) {
      throw new MarketplaceError('bad_category', `Unknown category: ${String(opts.category)}.`);
    }
    where.push(eq(s.listings.category, opts.category));
  }

  const rows = await db.select({
    id: s.listings.id,
    ref: s.listings.ref,
    title: s.listings.title,
    description: s.listings.description,
    category: s.listings.category,
    priceMinor: s.listings.priceMinor,
    currency: s.listings.currency,
    stockQty: s.listings.stockQty,
    sellerRef: s.sellers.ref,
    tradingName: s.sellers.tradingName,
    city: s.sellers.city,
  })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.sellers.id, s.listings.sellerId))
    .where(and(...where))
    .orderBy(desc(s.listings.id))
    .limit(limit)
    .offset(offset);

  if (!rows.length) return [];

  const media = await db.select({
    listingId: s.listingMedia.listingId,
    url: s.listingMedia.url,
    alt: s.listingMedia.alt,
    sortOrder: s.listingMedia.sortOrder,
  })
    .from(s.listingMedia)
    .where(inArray(s.listingMedia.listingId, rows.map((r: any) => r.id)))
    .orderBy(asc(s.listingMedia.sortOrder));

  return rows.map((r: any) => ({
    ...r,
    media: media.filter((m: any) => m.listingId === r.id).map((m: any) => ({ url: m.url, alt: m.alt })),
  }));
}

/**
 * One public listing by its reference.
 *
 * Built from the same predicate rather than by loading the row and checking it
 * afterwards, so a listing that is not public is NOT FOUND rather than
 * forbidden — there is nothing to leak, not even its existence.
 */
export async function publicListing(db: DB, ref: string) {
  const row = (await db.select({
    id: s.listings.id,
    ref: s.listings.ref,
    title: s.listings.title,
    description: s.listings.description,
    category: s.listings.category,
    priceMinor: s.listings.priceMinor,
    currency: s.listings.currency,
    stockQty: s.listings.stockQty,
    sellerRef: s.sellers.ref,
    tradingName: s.sellers.tradingName,
    city: s.sellers.city,
  })
    .from(s.listings)
    .innerJoin(s.sellers, eq(s.sellers.id, s.listings.sellerId))
    .where(and(publicListingPredicate() as SQL, eq(s.listings.ref, String(ref ?? ''))))
    .limit(1))[0];

  if (!row) return null;

  const media = await db.select({ url: s.listingMedia.url, alt: s.listingMedia.alt })
    .from(s.listingMedia)
    .where(eq(s.listingMedia.listingId, row.id))
    .orderBy(asc(s.listingMedia.sortOrder));

  return { ...row, media };
}
