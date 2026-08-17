// Seller verification, brand authorisation, badges and the admin 360.
//
// ─── THE QUESTION THIS MODULE ANSWERS ───────────────────────────────────────
//
//     On what evidence did MMAKF let this person trade under the federation's
//     name?
//
// Everything here exists to make that answerable a year later, to somebody
// angry, holding a counterfeit gi.
//
// ─── THE THREE RULES ────────────────────────────────────────────────────────
//
//  1. A BADGE IS DERIVED OR GRANTED. NEVER TYPED.
//     `badgesFor()` computes the verified badges from current verification and
//     authorisation rows, and reads the granted ones from `seller_badge_grants`.
//     There is no third source. A seller who writes "Official MMAKF Supplier"
//     into their store tagline gets a store tagline, and no badge — the string
//     and the badge are different things in different tables, and only one of
//     them renders as an endorsement.
//
//  2. VERIFICATION EXPIRES. A GST registration is a fact about a date, and the
//     ordinary failure of every system like this is that it verifies once and
//     never looks again. `badgesFor()` checks expiry every time it runs, and
//     `expiringVerifications()` exists so somebody can chase them before they
//     lapse rather than after.
//
//  3. RAW BANK DETAILS ARE NEVER RETURNED. `sellerDossier()` and
//     `mySellerProfile()` both redact, and the legacy columns on `sellers` are
//     redacted at every read rather than being trusted not to be selected.

import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, allocateFederationId, resolvePlacement, type AuditContext } from '@/db/federation';
import { assertCan, canAnywhere, type Principal } from '@/lib/rbac';
import { MarketplaceError } from '@/db/marketplace';

type DB = any;

export type VerificationCheck = (typeof s.verificationCheck.enumValues)[number];
export type VerificationStatus = (typeof s.verificationStatus.enumValues)[number];
export type MarketplaceBadge = (typeof s.marketplaceBadge.enumValues)[number];

export const VERIFICATION_REQUIREMENTS_NOT_SET =
  'MMAKF has not decided which verifications a seller must hold before trading. ' +
  'What is missing is reported so a reviewer can ask for it; nothing here refuses ' +
  'an applicant on a rule the federation has not made.';

/** The checks a reviewer is shown. Which are REQUIRED is MMAKF's decision. */
export const ALL_CHECKS: readonly VerificationCheck[] = [
  'identity', 'business', 'gst', 'pan', 'bank', 'address',
  'brand_authorisation', 'manufacturer_authorisation', 'product_authorisation',
];

// ─── The application, in full ───────────────────────────────────────────────

export interface SellerRegistrationInput {
  // Person
  firstName?: string | null;
  middleName?: string | null;
  lastName?: string | null;
  dateOfBirth?: string | null;
  email?: string | null;
  phone?: string | null;
  alternatePhone?: string | null;
  photoUrl?: string | null;

  // Business
  sellerType: (typeof s.sellerType.enumValues)[number];
  businessType: (typeof s.sellerBusinessType.enumValues)[number];
  tradingName: string;
  legalName?: string | null;
  brandName?: string | null;
  registrationNumber?: string | null;
  gstin?: string | null;
  pan?: string | null;
  website?: string | null;
  socialProfiles?: { platform: string; url: string }[] | null;
  businessDescription?: string | null;
  yearsOperating?: number | null;
  businessCategory?: string | null;

  // Placement in the federation's geography
  stateUnitId?: number | null;
  districtUnitId?: number | null;
  dojoId?: number | null;

  // Addresses — STRUCTURED, and more than one
  addresses?: {
    kind: (typeof s.sellerAddressKind.enumValues)[number];
    line1?: string | null; line2?: string | null; locality?: string | null;
    city?: string | null; district?: string | null; state?: string | null;
    postcode?: string | null; country?: string | null;
    contactName?: string | null; contactPhone?: string | null;
    isPrimary?: boolean;
  }[];

  // Intent
  requestedCategories?: string[] | null;
  requestedBrands?: string[] | null;
  expectedMonthlyOrders?: number | null;
  hasWarehouse?: boolean | null;
  shipsNationally?: boolean | null;
  motivation?: string | null;
}

/**
 * The full seller application: the seller row, the frozen submission, the
 * addresses and a verification row per check.
 *
 * WHY THE SUBMISSION IS FROZEN SEPARATELY from the seller row it creates: the
 * seller row is mutable and the application is EVIDENCE. When a reviewer
 * approves on the strength of "we have traded since 2011 and hold an Adidas
 * letter", that sentence has to survive the seller editing their profile the
 * following week — otherwise the approval points at a claim that is no longer
 * there, and the file cannot explain itself.
 *
 * Builds on `applyToSell()` in src/db/marketplace.ts rather than replacing it:
 * that function owns the one-seller-per-user rule and the placement check, and
 * two functions creating sellers would eventually disagree about both.
 */
export async function registerAsSeller(db: DB, ctx: AuditContext, input: SellerRegistrationInput) {
  const { applyToSell } = await import('@/db/marketplace');

  const applied = await applyToSell(db, ctx, {
    tradingName: input.tradingName,
    contactEmail: input.email ?? null,
    contactPhone: input.phone ?? null,
    stateUnitId: input.stateUnitId ?? null,
    districtUnitId: input.districtUnitId ?? null,
    dojoId: input.dojoId ?? null,
    gstin: input.gstin ?? null,
    pan: input.pan ?? null,
    evidence: { submittedVia: 'seller/apply' },
  });

  await db.update(s.sellers).set({
    sellerType: input.sellerType,
    businessType: input.businessType,
    legalName: input.legalName ?? null,
    brandName: input.brandName ?? null,
    registrationNumber: input.registrationNumber ?? null,
    website: input.website ?? null,
    socialProfiles: input.socialProfiles ?? null,
    businessDescription: input.businessDescription ?? null,
    yearsOperating: input.yearsOperating ?? null,
    businessCategory: input.businessCategory ?? null,
    updatedAt: new Date(),
  }).where(eq(s.sellers.id, applied.sellerId));

  for (const a of input.addresses ?? []) {
    await db.insert(s.sellerAddresses).values({
      sellerId: applied.sellerId,
      kind: a.kind,
      line1: a.line1 ?? null, line2: a.line2 ?? null, locality: a.locality ?? null,
      city: a.city ?? null, district: a.district ?? null, state: a.state ?? null,
      postcode: a.postcode ?? null, country: a.country ?? 'IN',
      contactName: a.contactName ?? null, contactPhone: a.contactPhone ?? null,
      stateUnitId: input.stateUnitId ?? null,
      districtUnitId: input.districtUnitId ?? null,
      isPrimary: !!a.isPrimary,
    });
  }

  // A verification row per check, all `not_started`. Created up front so the
  // reviewer's screen shows the full set of questions rather than an empty list
  // that grows as somebody remembers to ask.
  for (const check of ALL_CHECKS) {
    await db.insert(s.sellerVerifications)
      .values({ sellerId: applied.sellerId, check, status: 'not_started' })
      .onConflictDoNothing();
  }

  const riskFlags = await detectRisk(db, applied.sellerId, input);
  const ref = await allocateFederationId(db, 'SAP');

  await db.insert(s.sellerApplications).values({
    sellerId: applied.sellerId,
    ref,
    dojoId: input.dojoId ?? null,
    // FROZEN. Note the redaction: a submission blob is read by every reviewer
    // and must not carry a date of birth around with it.
    submission: redactSubmission(input) as any,
    requestedCategories: input.requestedCategories ?? null,
    requestedBrands: input.requestedBrands ?? null,
    expectedMonthlyOrders: input.expectedMonthlyOrders ?? null,
    hasWarehouse: input.hasWarehouse ?? null,
    shipsNationally: input.shipsNationally ?? null,
    motivation: input.motivation ?? null,
    riskFlags: riskFlags as any,
  });

  return { ...applied, applicationRef: ref, riskFlags };
}

function redactSubmission(input: SellerRegistrationInput) {
  const { dateOfBirth, pan, gstin, ...rest } = input;
  return {
    ...rest,
    // Presence, not value. A reviewer needs to know a PAN was given; they read
    // the number from the verification record, under `marketplace:verify`.
    dateOfBirthProvided: !!dateOfBirth,
    panProvided: !!pan,
    gstinProvided: !!gstin,
  };
}

/**
 * Automatic risk flags. FLAGS, NEVER DECISIONS.
 *
 * The brief asks for duplicate-account and impersonation detection. It does not
 * ask for automatic refusal, and automatic refusal on a name match is how a
 * legitimate applicant with a common name is locked out with no appeal. Every
 * finding here is a note for a human.
 */
async function detectRisk(db: DB, sellerId: number, input: SellerRegistrationInput) {
  const flags: { kind: string; detail: string }[] = [];

  const email = String(input.email ?? '').trim().toLowerCase();
  const phone = String(input.phone ?? '').trim();

  if (email || phone) {
    const shared = await db.select({
      id: s.sellers.id, ref: s.sellers.ref, status: s.sellers.status,
    }).from(s.sellers).where(and(
      sql`${s.sellers.id} <> ${sellerId}`,
      or(
        email ? eq(s.sellers.contactEmail, email) : sql`false`,
        phone ? eq(s.sellers.contactPhone, phone) : sql`false`,
      ),
    )).limit(5);

    for (const other of shared) {
      flags.push({
        kind: 'shared_contact_details',
        detail: `Contact details match seller ${other.ref} (${other.status}).` +
          (other.status === 'suspended' || other.status === 'rejected'
            ? ' That seller is not in good standing — check whether this is the same trader re-applying.'
            : ''),
      });
    }
  }

  if (input.gstin) {
    const sameGst = await db.select({ ref: s.sellers.ref }).from(s.sellers).where(and(
      sql`${s.sellers.id} <> ${sellerId}`, eq(s.sellers.gstin, input.gstin),
    )).limit(3);
    for (const o of sameGst) {
      flags.push({ kind: 'duplicate_seller_account', detail: `GSTIN already registered to ${o.ref}.` });
    }
  }

  // A claim of federation status in free text. Not blocked — recorded, because
  // it is exactly the thing a reviewer needs to look at before approving.
  const claimText = `${input.tradingName} ${input.brandName ?? ''} ${input.businessDescription ?? ''}`.toLowerCase();
  if (/\b(official|authorised|authorized)\b[\s\S]{0,20}\bmmakf\b|\bmmakf\b[\s\S]{0,20}\b(official|approved)\b/.test(claimText)) {
    flags.push({
      kind: 'federation_impersonation',
      detail: 'The application text claims MMAKF status. A badge comes only from a federation grant; ' +
        'confirm what the applicant believes they have been promised.',
    });
  }

  for (const f of flags) {
    await db.insert(s.fraudSignals).values({
      subjectType: 'seller', subjectId: sellerId, sellerId,
      kind: f.kind as any, severity: 2, detail: f.detail, detector: 'seller_registration',
    }).onConflictDoNothing();
  }

  return flags;
}

// ─── Verification ───────────────────────────────────────────────────────────

/**
 * Record a verification decision.
 *
 * REQUIRES `marketplace:verify`, which is deliberately not `marketplace:review`
 * — see src/lib/rbac.ts. Reviewing whether a gi may be advertised is editorial
 * judgement; this is reading somebody's tax registration.
 *
 * A REFUSING STATUS REQUIRES A REASON. `rejected`, `documents_required` and
 * `suspended` are all refusals, and a refusal the applicant cannot act on is an
 * obstruction — they have no way to fix it and no way to argue.
 */
export async function decideVerification(
  db: DB, ctx: AuditContext,
  input: {
    sellerId: number;
    check: VerificationCheck;
    status: VerificationStatus;
    reason?: string | null;
    evidence?: Record<string, unknown> | null;
    expiresAt?: Date | null;
  }
) {
  const seller = await loadSeller(db, input.sellerId);
  assertCan(ctx.principal, 'marketplace:verify', placementOf(seller));

  const refusing: VerificationStatus[] = ['rejected', 'documents_required', 'suspended'];
  if (refusing.includes(input.status) && !String(input.reason ?? '').trim()) {
    throw new MarketplaceError(
      'reason_required',
      `A ${input.status.replace('_', ' ')} decision requires a reason the applicant can act on.`
    );
  }
  if (ctx.principal?.userId != null && ctx.principal.userId === seller.userId) {
    throw new MarketplaceError('self_review', 'A seller cannot verify their own record, whatever authority they hold.');
  }

  const existing = (await db.select().from(s.sellerVerifications).where(and(
    eq(s.sellerVerifications.sellerId, input.sellerId),
    eq(s.sellerVerifications.check, input.check),
  )).limit(1))[0];

  const patch = {
    status: input.status,
    reason: input.reason ?? null,
    evidence: input.evidence ?? existing?.evidence ?? null,
    expiresAt: input.expiresAt ?? existing?.expiresAt ?? null,
    decidedByUserId: ctx.principal?.userId ?? null,
    decidedAt: new Date(),
    updatedAt: new Date(),
  };

  if (existing) {
    await db.update(s.sellerVerifications).set(patch).where(eq(s.sellerVerifications.id, existing.id));
  } else {
    await db.insert(s.sellerVerifications)
      .values({ sellerId: input.sellerId, check: input.check, ...patch });
  }

  await refreshCompliance(db, input.sellerId);

  await writeAudit(db, { ...ctx, reason: input.reason ?? undefined }, {
    entityType: 'seller_verification', entityId: input.sellerId,
    action: input.status === 'verified' ? 'approve' : input.status === 'rejected' ? 'reject' : 'update',
    oldValue: { check: input.check, status: existing?.status ?? 'not_started' },
    newValue: { check: input.check, status: input.status },
  });

  return { sellerId: input.sellerId, check: input.check, status: input.status };
}

/**
 * Recompute the seller's compliance standing from their verification rows.
 *
 * `lapsed` is the one that earns the enum: an expired GST verification is not a
 * suspension — nobody suspended anybody — and recording it as one would leave
 * the register unable to say whether a shop was closed for misconduct or for a
 * certificate that ran out.
 */
export async function refreshCompliance(db: DB, sellerId: number) {
  const rows = await db.select().from(s.sellerVerifications)
    .where(eq(s.sellerVerifications.sellerId, sellerId));

  const now = new Date();
  const lapsed = rows.some((r: any) => r.status === 'verified' && r.expiresAt && new Date(r.expiresAt) < now);
  const rejected = rows.some((r: any) => r.status === 'rejected' || r.status === 'suspended');
  const pending = rows.some((r: any) => ['documents_required', 'submitted', 'under_review'].includes(r.status));
  const anyVerified = rows.some((r: any) => r.status === 'verified');

  const status: (typeof s.sellerComplianceStatus.enumValues)[number] =
    rejected ? 'breach'
    : lapsed ? 'lapsed'
    : pending ? 'action_required'
    : anyVerified ? 'compliant'
    // NOT 'compliant'. A seller nobody has checked is not compliant; they are
    // unassessed, and the difference is the whole point of the column.
    : 'not_assessed';

  await db.update(s.sellers).set({ complianceStatus: status, updatedAt: now })
    .where(eq(s.sellers.id, sellerId));
  return status;
}

/** Verifications about to lapse, so somebody can chase them before they do. */
export async function expiringVerifications(db: DB, principal: Principal, withinDays = 30) {
  assertCan(principal, 'marketplace:read', {});
  const cutoff = new Date(Date.now() + withinDays * 86_400_000);
  return db.select({
    verification: s.sellerVerifications,
    sellerRef: s.sellers.ref,
    tradingName: s.sellers.tradingName,
  }).from(s.sellerVerifications)
    .innerJoin(s.sellers, eq(s.sellerVerifications.sellerId, s.sellers.id))
    .where(and(
      eq(s.sellerVerifications.status, 'verified'),
      sql`${s.sellerVerifications.expiresAt} is not null`,
      lte(s.sellerVerifications.expiresAt, cutoff),
    ))
    .orderBy(asc(s.sellerVerifications.expiresAt))
    .limit(200);
}

// ─── Brand authorisation ────────────────────────────────────────────────────

/** A seller CLAIMING a brand relationship. A claim, and nothing more. */
export async function claimBrandAuthorisation(
  db: DB, ctx: AuditContext,
  input: {
    brandId: number;
    relationship: 'manufacturer' | 'distributor' | 'reseller' | 'licensee';
    scope?: string | null;
    issuer?: string | null;
    issuerContact?: string | null;
    referenceNumber?: string | null;
    validFrom?: string | null;
    validTo?: string | null;
    documentId?: number | null;
  }
) {
  const seller = await ownSeller(db, ctx.principal);
  const brand = (await db.select().from(s.brands).where(eq(s.brands.id, input.brandId)).limit(1))[0];
  if (!brand) throw new MarketplaceError('unknown_brand', 'That brand is not in the marketplace register.');

  const [row] = await db.insert(s.brandAuthorisations).values({
    brandId: input.brandId,
    sellerId: seller.id,
    relationship: input.relationship,
    scope: input.scope ?? null,
    issuer: input.issuer ?? null,
    issuerContact: input.issuerContact ?? null,
    referenceNumber: input.referenceNumber ?? null,
    validFrom: input.validFrom ?? null,
    validTo: input.validTo ?? null,
    documentId: input.documentId ?? null,
    // 'claimed', ALWAYS. A seller cannot write 'verified' because this is the
    // only insert path they can reach and it does not take a status.
    status: 'claimed',
  }).returning({ id: s.brandAuthorisations.id });

  await writeAudit(db, ctx, {
    entityType: 'brand_authorisation', entityId: row.id, action: 'create',
    newValue: { brandId: input.brandId, sellerId: seller.id, status: 'claimed' },
  });
  return { authorisationId: row.id, status: 'claimed' as const };
}

/**
 * THE ANSWER TO "AUTHORIZED ADIDAS DISTRIBUTOR".
 *
 * A reviewer holding `marketplace:brand` looks at the document and decides.
 * NATIONAL ONLY, because a letter from a manufacturer is not a Jharkhand fact
 * and a counterfeit regime in which twelve state offices recognise twelve
 * different sets of authorisations is not a regime.
 */
export async function decideBrandAuthorisation(
  db: DB, ctx: AuditContext, authorisationId: number,
  decision: { status: 'verified' | 'rejected' | 'revoked'; reason: string }
) {
  assertCan(ctx.principal, 'marketplace:brand', {});
  if (!String(decision?.reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'A brand authorisation decision requires a reason.');
  }

  const row = (await db.select().from(s.brandAuthorisations)
    .where(eq(s.brandAuthorisations.id, authorisationId)).limit(1))[0];
  if (!row) throw new MarketplaceError('unknown_authorisation', 'No such authorisation.');

  const now = new Date();
  await db.update(s.brandAuthorisations).set({
    status: decision.status,
    decisionReason: decision.reason,
    verifiedByUserId: decision.status === 'verified' ? (ctx.principal?.userId ?? null) : row.verifiedByUserId,
    verifiedAt: decision.status === 'verified' ? now : row.verifiedAt,
    revokedAt: decision.status === 'revoked' ? now : null,
    revokedReason: decision.status === 'revoked' ? decision.reason : null,
    updatedAt: now,
  }).where(eq(s.brandAuthorisations.id, authorisationId));

  // Revoking an authorisation does NOT delist the seller's items automatically.
  // The listings become policy-blocked for FUTURE edits, and a human decides
  // what happens to the ones already live — because pulling a hundred listings
  // on an administrative expiry is an action MMAKF should take deliberately.
  await writeAudit(db, { ...ctx, reason: decision.reason }, {
    entityType: 'brand_authorisation', entityId: authorisationId,
    action: decision.status === 'verified' ? 'approve' : decision.status === 'revoked' ? 'revoke' : 'reject',
    oldValue: { status: row.status }, newValue: { status: decision.status },
  });
  return { authorisationId, status: decision.status };
}

// ─── Badges ─────────────────────────────────────────────────────────────────

export interface Badge {
  badge: MarketplaceBadge;
  label: string;
  /** How this badge came to be true. Rendered as the badge's tooltip. */
  basis: string;
  grantedAt?: Date | null;
  expiresAt?: Date | null;
}

const BADGE_LABELS: Record<MarketplaceBadge, string> = {
  mmakf_official: 'MMAKF Official',
  mmakf_authorised: 'MMAKF Authorised',
  verified_seller: 'Verified Seller',
  verified_brand: 'Verified Brand',
  verified_product: 'Verified Product',
};

/**
 * Every badge this seller currently holds, and why.
 *
 * TWO SOURCES AND NO THIRD:
 *
 *   · DERIVED — `verified_seller` requires a current `identity` AND `business`
 *     verification. Computed here every time, so it disappears the moment
 *     either lapses, without anybody having to remember to remove it.
 *   · GRANTED — `mmakf_official` and `mmakf_authorised` come from
 *     `seller_badge_grants`, which only `marketplace:review` can write.
 *
 * Nothing reads a seller-editable field. That is the entire defence against the
 * brief's hardest requirement — "never let a seller type these claims and
 * receive official-looking presentation" — and it is a defence by construction
 * rather than by validation, because there is no string to validate.
 */
export async function badgesFor(db: DB, sellerId: number, listingId?: number | null): Promise<Badge[]> {
  const badges: Badge[] = [];
  const now = new Date();

  // ── Derived ──────────────────────────────────────────────────────────────
  const verifications = await db.select().from(s.sellerVerifications)
    .where(eq(s.sellerVerifications.sellerId, sellerId));

  const current = (check: VerificationCheck) => {
    const v = verifications.find((x: any) => x.check === check);
    if (!v || v.status !== 'verified') return null;
    if (v.expiresAt && new Date(v.expiresAt) < now) return null;   // EXPIRY IS CHECKED
    return v;
  };

  const identity = current('identity');
  const business = current('business');
  if (identity && business) {
    badges.push({
      badge: 'verified_seller',
      label: BADGE_LABELS.verified_seller,
      basis: 'Identity and business registration verified by MMAKF and currently valid.',
      grantedAt: identity.decidedAt,
    });
  }

  const today = now.toISOString().slice(0, 10);
  const brandAuths = await db.select({ auth: s.brandAuthorisations, brand: s.brands })
    .from(s.brandAuthorisations)
    .innerJoin(s.brands, eq(s.brandAuthorisations.brandId, s.brands.id))
    .where(and(
      eq(s.brandAuthorisations.sellerId, sellerId),
      eq(s.brandAuthorisations.status, 'verified'),
      isNull(s.brandAuthorisations.revokedAt),
      or(isNull(s.brandAuthorisations.validTo), sql`${s.brandAuthorisations.validTo} >= ${today}`),
    ));

  for (const { auth, brand } of brandAuths) {
    badges.push({
      badge: 'verified_brand',
      label: `${BADGE_LABELS.verified_brand}: ${brand.name}`,
      basis: `MMAKF has seen a ${auth.relationship} authorisation from ${auth.issuer ?? 'the brand owner'}` +
        (auth.scope ? `, scoped to ${auth.scope}` : '') +
        (auth.validTo ? `, valid to ${auth.validTo}` : '') + '.',
      grantedAt: auth.verifiedAt,
      expiresAt: auth.validTo ? new Date(auth.validTo) : null,
    });
  }

  // ── Granted ──────────────────────────────────────────────────────────────
  const grants = await db.select().from(s.sellerBadgeGrants).where(and(
    isNull(s.sellerBadgeGrants.revokedAt),
    listingId != null
      ? or(eq(s.sellerBadgeGrants.sellerId, sellerId), eq(s.sellerBadgeGrants.listingId, listingId))
      : eq(s.sellerBadgeGrants.sellerId, sellerId),
    or(isNull(s.sellerBadgeGrants.expiresAt), sql`${s.sellerBadgeGrants.expiresAt} > now()`),
  ));

  for (const g of grants) {
    badges.push({
      badge: g.badge,
      label: BADGE_LABELS[g.badge as MarketplaceBadge],
      basis: g.authority
        ? `Granted by MMAKF under ${g.authority}: ${g.reason}`
        : `Granted by MMAKF: ${g.reason}`,
      grantedAt: g.grantedAt,
      expiresAt: g.expiresAt,
    });
  }

  return badges;
}

/**
 * MMAKF endorsing a seller or an item.
 *
 * The ONLY write path to `seller_badge_grants`, and it asserts
 * `marketplace:review`. There is no seller-facing route to this function, and
 * that is the structural guarantee the brief asks for.
 */
export async function grantBadge(
  db: DB, ctx: AuditContext,
  input: {
    badge: MarketplaceBadge;
    sellerId?: number | null;
    listingId?: number | null;
    reason: string;
    authority?: string | null;
    expiresAt?: Date | null;
  }
) {
  assertCan(ctx.principal, 'marketplace:review', {});
  if (!String(input?.reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'A federation endorsement requires a stated reason.');
  }
  if ((input.sellerId == null) === (input.listingId == null)) {
    throw new MarketplaceError(
      'bad_subject',
      'A badge names either a seller or a listing. Neither endorses nothing; both is a claim nobody can render.'
    );
  }
  // The two granted badges are federation endorsements. The three derived ones
  // are computed from evidence and must not be grantable by hand — granting
  // 'verified_seller' would create a badge that says a verification happened
  // when none did, which is the exact forgery this module exists to prevent.
  if (input.badge === 'verified_seller' || input.badge === 'verified_brand') {
    throw new MarketplaceError(
      'derived_badge',
      `"${BADGE_LABELS[input.badge]}" is derived from verification records and cannot be granted by hand. ` +
      'Record the verification instead — the badge follows from it, and disappears with it.'
    );
  }

  const [row] = await db.insert(s.sellerBadgeGrants).values({
    badge: input.badge,
    sellerId: input.sellerId ?? null,
    listingId: input.listingId ?? null,
    grantedByUserId: ctx.principal?.userId ?? null,
    authority: input.authority ?? null,
    reason: input.reason,
    expiresAt: input.expiresAt ?? null,
  }).returning({ id: s.sellerBadgeGrants.id });

  await writeAudit(db, { ...ctx, reason: input.reason, authority: input.authority ?? undefined }, {
    entityType: 'seller_badge_grant', entityId: row.id, action: 'approve',
    newValue: { badge: input.badge, sellerId: input.sellerId ?? null, listingId: input.listingId ?? null },
  });
  return { grantId: row.id, badge: input.badge };
}

export async function revokeBadge(db: DB, ctx: AuditContext, grantId: number, reason: string) {
  assertCan(ctx.principal, 'marketplace:review', {});
  if (!String(reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'Withdrawing an endorsement requires a reason.');
  }
  await db.update(s.sellerBadgeGrants).set({
    revokedAt: new Date(), revokedByUserId: ctx.principal?.userId ?? null, revokedReason: reason,
  }).where(eq(s.sellerBadgeGrants.id, grantId));

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'seller_badge_grant', entityId: grantId, action: 'revoke', newValue: { revoked: true },
  });
  return { grantId, revoked: true };
}

// ─── The storefront ─────────────────────────────────────────────────────────

export async function updateStore(
  db: DB, ctx: AuditContext,
  input: {
    storeSlug?: string | null;
    storeTagline?: string | null;
    storeAbout?: string | null;
    storeLogoUrl?: string | null;
    storeSpecialisms?: string[] | null;
  }
) {
  const seller = await ownSeller(db, ctx.principal);
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (input.storeSlug !== undefined) {
    const slug = String(input.storeSlug ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
    if (!slug || slug.length < 3) {
      throw new MarketplaceError('bad_slug', 'A store address needs at least three usable characters.');
    }
    const clash = (await db.select({ id: s.sellers.id }).from(s.sellers)
      .where(and(eq(s.sellers.storeSlug, slug), sql`${s.sellers.id} <> ${seller.id}`)).limit(1))[0];
    if (clash) throw new MarketplaceError('slug_taken', 'Another shop already uses that address.');
    patch.storeSlug = slug;
  }

  for (const k of ['storeTagline', 'storeAbout', 'storeLogoUrl', 'storeSpecialisms'] as const) {
    if (input[k] !== undefined) patch[k] = input[k] as any;
  }

  await db.update(s.sellers).set(patch).where(eq(s.sellers.id, seller.id));
  return { sellerId: seller.id, storeSlug: patch.storeSlug ?? seller.storeSlug };
}

/**
 * A seller closing or reopening their own shop.
 *
 * NOT A SUSPENSION, and that is the point of the separate axis. A seller going
 * away for a fortnight must not have to be suspended in order to stop taking
 * orders, because a suspension is a governance record that will follow them.
 */
export async function setStoreOpen(db: DB, ctx: AuditContext, open: boolean, reason?: string | null) {
  const seller = await ownSeller(db, ctx.principal);
  if (seller.storeStatus === 'closed_by_federation') {
    throw new MarketplaceError(
      'closed_by_federation',
      'This store was closed by MMAKF and cannot be reopened by the seller. Contact the federation.'
    );
  }
  await db.update(s.sellers).set({
    storeStatus: open ? 'open' : 'closed_by_seller',
    storeOpenedAt: open ? new Date() : seller.storeOpenedAt,
    storeClosedAt: open ? null : new Date(),
    storeClosedReason: open ? null : (reason ?? null),
    updatedAt: new Date(),
  }).where(eq(s.sellers.id, seller.id));
  return { sellerId: seller.id, storeStatus: open ? 'open' : 'closed_by_seller' };
}

/** The public storefront. Public data only, and badges that are data-backed. */
export async function publicStorefront(db: DB, slug: string) {
  const seller = (await db.select().from(s.sellers).where(and(
    eq(s.sellers.storeSlug, String(slug ?? '').trim().toLowerCase()),
    eq(s.sellers.status, 'approved'),
    eq(s.sellers.storeStatus, 'open'),
  )).limit(1))[0];
  if (!seller) return null;

  const badges = await badgesFor(db, seller.id);
  const returnPolicy = await (await import('@/db/returns')).effectiveReturnPolicy(db, seller.id);

  return {
    // A DELIBERATE ALLOW-LIST, not a redaction of the row. Adding a column to
    // `sellers` must not publish it, and a spread with deletions would do
    // exactly that the next time somebody adds `bank_account_number_2`.
    tradingName: seller.tradingName,
    storeSlug: seller.storeSlug,
    storeTagline: seller.storeTagline,
    storeAbout: seller.storeAbout,
    storeLogoUrl: seller.storeLogoUrl,
    storeSpecialisms: seller.storeSpecialisms,
    sellerType: seller.sellerType,
    // LOCATION AT THE APPROPRIATE GRANULARITY — the brief's own words. City and
    // state; never the street, and never the warehouse.
    city: seller.city,
    stateUnitId: seller.stateUnitId,
    ratingAvgBps: seller.ratingAvgBps,
    ratingCount: seller.ratingCount,
    memberSince: seller.approvedAt,
    badges,
    returnPolicy: {
      windowDays: returnPolicy.windowDays,
      source: returnPolicy.source,
      returnShippingPaidBy: returnPolicy.returnShippingPaidBy,
      notes: returnPolicy.notes,
    },
  };
}

// ─── Seller 360 ─────────────────────────────────────────────────────────────

/**
 * The admin's whole view of one seller — the seller equivalent of PERSON 360.
 *
 * BANK DETAILS ARE REDACTED HERE, not at the template. A function that returns
 * an account number and trusts every caller not to render it is one page away
 * from publishing it, and the page that does so will be written by somebody who
 * never read this comment.
 */
export async function sellerDossier(db: DB, principal: Principal, sellerId: number) {
  const seller = await loadSeller(db, sellerId);
  assertCan(principal, 'marketplace:read', placementOf(seller));

  const mayReadEvidence = canAnywhere(principal, 'marketplace:verify');

  const [verifications, addresses, documents, authorisations, application,
    listings, orders, settlements, disputes, returns, flags, signals, badges] = await Promise.all([
    db.select().from(s.sellerVerifications).where(eq(s.sellerVerifications.sellerId, sellerId)),
    db.select().from(s.sellerAddresses).where(eq(s.sellerAddresses.sellerId, sellerId)),
    db.select({
      id: s.sellerDocuments.id, kind: s.sellerDocuments.kind, label: s.sellerDocuments.label,
      uploadedAt: s.sellerDocuments.uploadedAt, supersededAt: s.sellerDocuments.supersededAt,
      // storageKey is NOT selected. A document is fetched through the storage
      // layer, which is the only thing that can refuse the request.
    }).from(s.sellerDocuments).where(eq(s.sellerDocuments.sellerId, sellerId)),
    db.select({ auth: s.brandAuthorisations, brand: s.brands })
      .from(s.brandAuthorisations).innerJoin(s.brands, eq(s.brandAuthorisations.brandId, s.brands.id))
      .where(eq(s.brandAuthorisations.sellerId, sellerId)),
    db.select().from(s.sellerApplications).where(eq(s.sellerApplications.sellerId, sellerId)).limit(1),
    db.select({
      id: s.listings.id, ref: s.listings.ref, title: s.listings.title,
      status: s.listings.status, quarantinedAt: s.listings.quarantinedAt,
      priceMinor: s.listings.priceMinor, variantCount: s.listings.variantCount,
    }).from(s.listings).where(eq(s.listings.sellerId, sellerId)).limit(200),
    db.select().from(s.sellerOrders).where(eq(s.sellerOrders.sellerId, sellerId))
      .orderBy(desc(s.sellerOrders.createdAt)).limit(100),
    db.select().from(s.sellerSettlements).where(eq(s.sellerSettlements.sellerId, sellerId))
      .orderBy(desc(s.sellerSettlements.periodStart)).limit(12),
    db.select().from(s.marketplaceDisputes).where(eq(s.marketplaceDisputes.sellerId, sellerId))
      .orderBy(desc(s.marketplaceDisputes.raisedAt)).limit(50),
    db.select().from(s.returnRequests).where(eq(s.returnRequests.sellerId, sellerId))
      .orderBy(desc(s.returnRequests.requestedAt)).limit(50),
    db.select().from(s.listingFlags).where(eq(s.listingFlags.sellerId, sellerId))
      .orderBy(desc(s.listingFlags.raisedAt)).limit(50),
    db.select().from(s.fraudSignals).where(eq(s.fraudSignals.sellerId, sellerId))
      .orderBy(desc(s.fraudSignals.raisedAt)).limit(50),
    badgesFor(db, sellerId),
  ]);

  const performance = (await db.select().from(s.sellerPerformanceSnapshots)
    .where(eq(s.sellerPerformanceSnapshots.sellerId, sellerId))
    .orderBy(desc(s.sellerPerformanceSnapshots.periodEnd)).limit(6));

  const payoutAccounts = await db.select({
    id: s.payoutAccounts.id, provider: s.payoutAccounts.provider,
    holderName: s.payoutAccounts.holderName, bankName: s.payoutAccounts.bankName,
    last4: s.payoutAccounts.last4, status: s.payoutAccounts.status,
    verifiedAt: s.payoutAccounts.verifiedAt, isDefault: s.payoutAccounts.isDefault,
    // providerAccountId is NOT selected either: it is a credential-adjacent
    // handle and an ordinary administrator has no use for it.
  }).from(s.payoutAccounts).where(eq(s.payoutAccounts.sellerId, sellerId));

  const gaps = await db.select({ n: sql<number>`count(*)::int` }).from(s.commissionGaps)
    .where(and(eq(s.commissionGaps.sellerId, sellerId), isNull(s.commissionGaps.resolvedAt)));

  return {
    seller: redactSeller(seller),
    badges,
    verifications: verifications.map((v: any) => ({
      ...v,
      // Evidence can hold reference numbers from a tax register. Only
      // `marketplace:verify` sees it; everybody else sees that it exists.
      evidence: mayReadEvidence ? v.evidence : (v.evidence ? '[withheld]' : null),
      expired: !!(v.status === 'verified' && v.expiresAt && new Date(v.expiresAt) < new Date()),
    })),
    addresses,
    documents,
    authorisations,
    application: application[0] ?? null,
    listings,
    orders,
    settlements,
    payoutAccounts,
    disputes,
    returns,
    flags,
    fraudSignals: signals,
    performance,
    commissionGaps: gaps[0]?.n ?? 0,
    notes: {
      verification: VERIFICATION_REQUIREMENTS_NOT_SET,
    },
  };
}

/**
 * A seller's own view of their record.
 *
 * NO sellerId PARAMETER. The same construction as `mySellerAccount()` — a
 * function that cannot be asked about another seller cannot be tricked into
 * answering about one.
 */
export async function mySellerProfile(db: DB, principal: Principal) {
  if (principal?.userId == null) return null;
  const seller = (await db.select().from(s.sellers)
    .where(eq(s.sellers.userId, principal.userId)).limit(1))[0];
  if (!seller) return null;

  const [verifications, addresses, badges, authorisations] = await Promise.all([
    db.select({
      check: s.sellerVerifications.check, status: s.sellerVerifications.status,
      reason: s.sellerVerifications.reason, expiresAt: s.sellerVerifications.expiresAt,
      decidedAt: s.sellerVerifications.decidedAt,
    }).from(s.sellerVerifications).where(eq(s.sellerVerifications.sellerId, seller.id)),
    db.select().from(s.sellerAddresses).where(eq(s.sellerAddresses.sellerId, seller.id)),
    badgesFor(db, seller.id),
    db.select({ auth: s.brandAuthorisations, brand: s.brands })
      .from(s.brandAuthorisations).innerJoin(s.brands, eq(s.brandAuthorisations.brandId, s.brands.id))
      .where(eq(s.brandAuthorisations.sellerId, seller.id)),
  ]);

  return {
    seller: redactSeller(seller),
    verifications,
    addresses,
    badges,
    authorisations,
    outstanding: verifications
      .filter((v: any) => v.status === 'documents_required')
      .map((v: any) => ({ check: v.check, reason: v.reason })),
    notes: { verification: VERIFICATION_REQUIREMENTS_NOT_SET },
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Redact the legacy bank columns on every read.
 *
 * Applied at the source rather than at the template, because a template is
 * where a redaction gets forgotten. The columns themselves are retired —
 * `payout_accounts` is where a payout destination lives now, and it never held
 * an account number at all.
 */
function redactSeller(seller: any) {
  return {
    ...seller,
    bankAccountNumber: seller.bankAccountNumber ? `••••${String(seller.bankAccountNumber).slice(-4)}` : null,
    bankIfsc: seller.bankIfsc ? `${String(seller.bankIfsc).slice(0, 4)}••••` : null,
  };
}

function placementOf(seller: any) {
  return {
    stateUnitId: seller.stateUnitId ?? null,
    districtUnitId: seller.districtUnitId ?? null,
    dojoId: seller.dojoId ?? null,
  };
}

async function loadSeller(db: DB, sellerId: number) {
  const row = (await db.select().from(s.sellers).where(eq(s.sellers.id, sellerId)).limit(1))[0];
  if (!row) throw new MarketplaceError('unknown_seller', 'No such seller.');
  return row;
}

async function ownSeller(db: DB, principal: Principal) {
  if (principal?.userId == null) throw new MarketplaceError('not_signed_in', 'Sign in to manage your shop.');
  const seller = (await db.select().from(s.sellers)
    .where(eq(s.sellers.userId, principal.userId)).limit(1))[0];
  if (!seller) throw new MarketplaceError('not_a_seller', 'This account has no seller record.');
  if (seller.status !== 'approved') {
    throw new MarketplaceError('seller_not_approved', `A seller that is ${seller.status} cannot manage a shop.`);
  }
  return seller;
}

/**
 * Restrict a seller to a subset of the catalogue.
 *
 * RESTRICTED IS NOT SUSPENDED. The brief names both, and collapsing them would
 * force MMAKF to close a whole shop over one product line — which in practice
 * means it closes nothing, and the restriction is never applied at all.
 */
export async function restrictSeller(
  db: DB, ctx: AuditContext, sellerId: number,
  input: { categories: string[]; reason: string }
) {
  const seller = await loadSeller(db, sellerId);
  assertCan(ctx.principal, 'marketplace:suspend', placementOf(seller));
  if (!String(input?.reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'A restriction requires a reason the seller can read.');
  }
  if (!Array.isArray(input.categories) || !input.categories.length) {
    throw new MarketplaceError('no_categories', 'A restriction must name the categories it applies to. Use suspension for the whole shop.');
  }

  await db.update(s.sellers).set({
    restrictedAt: new Date(),
    restrictedReason: input.reason,
    restrictedCategories: input.categories,
    updatedAt: new Date(),
  }).where(eq(s.sellers.id, sellerId));

  await writeAudit(db, { ...ctx, reason: input.reason }, {
    entityType: 'seller', entityId: sellerId, action: 'suspend',
    newValue: { restricted: true, categories: input.categories },
  });
  return { sellerId, restrictedCategories: input.categories };
}

export async function liftRestriction(db: DB, ctx: AuditContext, sellerId: number, reason: string) {
  const seller = await loadSeller(db, sellerId);
  assertCan(ctx.principal, 'marketplace:suspend', placementOf(seller));
  await db.update(s.sellers).set({
    restrictedAt: null, restrictedCategories: null, updatedAt: new Date(),
    // restrictedReason is KEPT. A seller who was once restricted is a different
    // record from one who never was.
  }).where(eq(s.sellers.id, sellerId));

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'seller', entityId: sellerId, action: 'reinstate', newValue: { restricted: false },
  });
  return { sellerId, restricted: false };
}
