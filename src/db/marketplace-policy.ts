// Marketplace policy documents, their versions, and seller acceptance.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS FILE CONTAINS NO POLICY TEXT, AND THAT IS THE POINT
// ═════════════════════════════════════════════════════════════════════════════
//
// Not a seller agreement, not marketplace terms, not a returns policy, not a
// prohibited-products list. MMAKF writes those.
//
// A plausible-looking seeded seller agreement is the single worst thing this
// codebase could produce: it would be quoted back at a real trader as though
// the federation had approved it, in a dispute, by staff who assumed somebody
// had. `registerPolicies()` creates the eight NAMES the schema's enum already
// carries — a name is not content — and even that is an act an administrator
// runs deliberately rather than something that happens on deploy.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY ACCEPTANCE POINTS AT A VERSION, AND CARRIES THE HASH TWICE
// ═════════════════════════════════════════════════════════════════════════════
//
// "The seller accepted the seller agreement" records nothing if the agreement
// is a mutable blob: by the time the dispute arrives, the paragraph in question
// may have been written after they signed.
//
// So an acceptance references a `policy_versions` row. And it ALSO stores that
// version's body hash on the acceptance itself — belt and braces, on exactly
// the reasoning behind the listing content hash. If some future edit alters a
// published version in place, `verifyAcceptance()` notices, because the two
// hashes stop agreeing. The rule survives the refactor that would otherwise
// silently delete it.
//
// A PUBLISHED VERSION IS NEVER EDITED. `draftPolicyVersion()` writes a draft;
// publishing seals it; there is no update path for a published body, and the
// function that would have been one refuses instead.

import crypto from 'node:crypto';
import { and, asc, desc, eq, isNull, lte, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, type Principal } from '@/lib/rbac';
import { MarketplaceError } from '@/db/marketplace';
import { ownSellerRecord } from '@/db/seller-orders';

type DB = any;

export const POLICY_NOT_PUBLISHED =
  'MMAKF has not published this document. There is a place for it and nothing ' +
  'in it — the federation writes the text, and no version of it exists yet.';

export const NO_MANDATORY_POLICIES =
  'MMAKF has not made any marketplace policy mandatory for sellers. Nothing is ' +
  'being required of anybody on this system’s own authority.';

/**
 * The eight documents the schema's `policyKind` enum names.
 *
 * NAMES AND KINDS ONLY. `mandatoryForSellers` is FALSE for every one of them:
 * whether a seller must accept the seller agreement before trading is a
 * federation decision, and defaulting it to true here would block every
 * existing seller the moment the policy row was created, over a document that
 * has no text in it.
 */
export const POLICY_REGISTER = [
  { code: 'marketplace.seller_agreement', kind: 'seller_agreement', title: 'Seller agreement' },
  { code: 'marketplace.terms', kind: 'marketplace_terms', title: 'Marketplace terms' },
  { code: 'marketplace.returns', kind: 'return_policy', title: 'Returns policy' },
  { code: 'marketplace.shipping', kind: 'shipping_policy', title: 'Shipping policy' },
  { code: 'marketplace.privacy', kind: 'privacy_policy', title: 'Privacy policy' },
  { code: 'marketplace.prohibited_products', kind: 'prohibited_products', title: 'Prohibited products policy' },
  { code: 'marketplace.counterfeit', kind: 'counterfeit_policy', title: 'Counterfeit policy' },
  { code: 'marketplace.commission_schedule', kind: 'commission_schedule', title: 'Commission schedule' },
] as const;

/** Same digest shape as listingContentHash(), so one rule for one job. */
export function bodyHash(body: string): string {
  return crypto.createHash('sha256').update(String(body ?? '')).digest('base64url').slice(0, 32);
}

// ─── The register ───────────────────────────────────────────────────────────

/**
 * Create the eight policy records, once, deliberately.
 *
 * IDEMPOTENT BY CODE and never overwrites: a federation that has renamed a
 * document or made one mandatory keeps its decision, because a re-run after a
 * deploy would otherwise silently undo it.
 */
export async function registerPolicies(db: DB, ctx: AuditContext) {
  assertCan(ctx.principal, 'marketplace:review', {});

  const existing = await db.select({ code: s.marketplacePolicies.code }).from(s.marketplacePolicies);
  const have = new Set(existing.map((r: any) => r.code));

  const added: string[] = [];
  for (const p of POLICY_REGISTER) {
    if (have.has(p.code)) continue;
    await db.insert(s.marketplacePolicies).values({
      code: p.code,
      kind: p.kind as any,
      title: p.title,
      // NO SUMMARY AND NO BODY. A summary is content too.
      mandatoryForSellers: false,
      active: true,
    });
    added.push(p.code);
  }

  if (added.length) {
    await writeAudit(db, ctx, {
      entityType: 'marketplace_policy', entityId: null, action: 'create', newValue: { registered: added },
    });
  }
  return { added, alreadyPresent: POLICY_REGISTER.length - added.length };
}

export async function policyRegister(db: DB, principal: Principal) {
  assertCan(principal, 'marketplace:read', {});
  const policies = await db.select().from(s.marketplacePolicies)
    .orderBy(asc(s.marketplacePolicies.code));
  if (!policies.length) return [];

  const versions = await db.select().from(s.policyVersions)
    .orderBy(desc(s.policyVersions.version));

  return policies.map((p: any) => {
    const mine = versions.filter((v: any) => v.policyId === p.id);
    return {
      ...p,
      versions: mine,
      current: mine.find((v: any) => v.publishedAt) ?? null,
      published: mine.some((v: any) => v.publishedAt),
      note: mine.some((v: any) => v.publishedAt) ? null : POLICY_NOT_PUBLISHED,
    };
  });
}

// ─── Versions ───────────────────────────────────────────────────────────────

export async function draftPolicyVersion(
  db: DB, ctx: AuditContext,
  input: { policyId: number; body: string; effectiveFrom: string }
) {
  assertCan(ctx.principal, 'marketplace:review', {});
  const policy = (await db.select().from(s.marketplacePolicies)
    .where(eq(s.marketplacePolicies.id, input.policyId)).limit(1))[0];
  if (!policy) throw new MarketplaceError('unknown_policy', 'No such policy.');

  const body = String(input?.body ?? '');
  if (!body.trim()) {
    throw new MarketplaceError(
      'empty_body',
      'A policy version needs its text. An empty document that looks like a document is worse than a ' +
      'stated absence — somebody will quote it.'
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.effectiveFrom ?? ''))) {
    throw new MarketplaceError('bad_date', 'A policy version needs an effective-from date (YYYY-MM-DD).');
  }

  const last = (await db.select({ v: s.policyVersions.version }).from(s.policyVersions)
    .where(eq(s.policyVersions.policyId, input.policyId))
    .orderBy(desc(s.policyVersions.version)).limit(1))[0];

  const [row] = await db.insert(s.policyVersions).values({
    policyId: input.policyId,
    version: (last?.v ?? 0) + 1,
    body,
    bodyHash: bodyHash(body),
    effectiveFrom: input.effectiveFrom,
    // publishedAt NULL — a draft. Nothing reads a draft as current.
  }).returning({ id: s.policyVersions.id, version: s.policyVersions.version });

  await writeAudit(db, ctx, {
    entityType: 'policy_version', entityId: row.id, action: 'create',
    newValue: { policyCode: policy.code, version: row.version, published: false },
  });
  return { versionId: row.id, version: row.version, published: false };
}

/**
 * Publish a drafted version, and close the previous one.
 *
 * SEALS THE TEXT. There is no function that edits a published body, and adding
 * one would break every acceptance recorded against it — the acceptance carries
 * the hash, and the hash would stop matching. A correction is a NEW VERSION,
 * which is also the only honest way to correct a document people have agreed to.
 */
export async function publishPolicyVersion(db: DB, ctx: AuditContext, versionId: number) {
  assertCan(ctx.principal, 'marketplace:review', {});
  const version = (await db.select().from(s.policyVersions)
    .where(eq(s.policyVersions.id, versionId)).limit(1))[0];
  if (!version) throw new MarketplaceError('unknown_version', 'No such policy version.');
  if (version.publishedAt) throw new MarketplaceError('already_published', 'That version is already published.');

  const now = new Date();

  // Close the outgoing version the day before this one takes effect, so the two
  // do not both read as current on the same date.
  await db.update(s.policyVersions).set({ effectiveTo: version.effectiveFrom })
    .where(and(
      eq(s.policyVersions.policyId, version.policyId),
      sql`${s.policyVersions.publishedAt} is not null`,
      isNull(s.policyVersions.effectiveTo),
      sql`${s.policyVersions.id} <> ${versionId}`,
    ));

  await db.update(s.policyVersions).set({
    publishedAt: now,
    publishedByUserId: ctx.principal?.userId ?? null,
  }).where(eq(s.policyVersions.id, versionId));

  await writeAudit(db, ctx, {
    entityType: 'policy_version', entityId: versionId, action: 'approve',
    newValue: { published: true, effectiveFrom: version.effectiveFrom, bodyHash: version.bodyHash },
  });
  return { versionId, published: true };
}

/**
 * Whether a document is mandatory for sellers.
 *
 * A SEPARATE ACT from publishing it, because they are separate decisions:
 * MMAKF may publish a shipping policy for information and require acceptance of
 * only the seller agreement. Requiring acceptance of an unpublished document is
 * refused — there would be nothing for a seller to accept.
 */
export async function setPolicyMandatory(
  db: DB, ctx: AuditContext, policyId: number, mandatory: boolean, reason: string
) {
  assertCan(ctx.principal, 'marketplace:review', {});
  if (!String(reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'Requiring a document of every seller is a decision. Say why.');
  }
  const policy = (await db.select().from(s.marketplacePolicies)
    .where(eq(s.marketplacePolicies.id, policyId)).limit(1))[0];
  if (!policy) throw new MarketplaceError('unknown_policy', 'No such policy.');

  if (mandatory) {
    const published = (await db.select({ id: s.policyVersions.id }).from(s.policyVersions)
      .where(and(eq(s.policyVersions.policyId, policyId), sql`${s.policyVersions.publishedAt} is not null`))
      .limit(1))[0];
    if (!published) {
      throw new MarketplaceError(
        'nothing_to_accept',
        'This document has no published version, so there is nothing for a seller to accept. Publish it first.'
      );
    }
  }

  await db.update(s.marketplacePolicies).set({ mandatoryForSellers: mandatory })
    .where(eq(s.marketplacePolicies.id, policyId));

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'marketplace_policy', entityId: policyId, action: 'update',
    oldValue: { mandatoryForSellers: policy.mandatoryForSellers },
    newValue: { mandatoryForSellers: mandatory },
  });
  return { policyId, mandatoryForSellers: mandatory };
}

/** The version in force for a policy code today, or null. */
export async function currentVersion(db: DB, policyCode: string) {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db.select({ policy: s.marketplacePolicies, version: s.policyVersions })
    .from(s.policyVersions)
    .innerJoin(s.marketplacePolicies, eq(s.policyVersions.policyId, s.marketplacePolicies.id))
    .where(and(
      eq(s.marketplacePolicies.code, policyCode),
      sql`${s.policyVersions.publishedAt} is not null`,
      lte(s.policyVersions.effectiveFrom, today),
      or(isNull(s.policyVersions.effectiveTo), sql`${s.policyVersions.effectiveTo} > ${today}`),
    ))
    .orderBy(desc(s.policyVersions.effectiveFrom), desc(s.policyVersions.version))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Acceptance ─────────────────────────────────────────────────────────────

function hashIp(ip?: string | null): string | null {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip).digest('base64url').slice(0, 22);
}

/**
 * A seller accepting a specific version.
 *
 * TAKES A VERSION ID, not a policy code. Accepting "the seller agreement" is
 * not a fact; accepting version 3 of it, whose text hashes to this value, is.
 *
 * The IP is HASHED, matching writeAudit()'s treatment: it is evidence that two
 * acceptances came from the same place, which is all it is ever needed for, and
 * a stored address is a stored address.
 */
export async function acceptPolicy(db: DB, ctx: AuditContext, policyVersionId: number, ip?: string | null) {
  const seller = await ownSellerRecord(db, ctx.principal);

  const version = (await db.select().from(s.policyVersions)
    .where(eq(s.policyVersions.id, policyVersionId)).limit(1))[0];
  if (!version) throw new MarketplaceError('unknown_version', 'No such policy version.');
  if (!version.publishedAt) {
    throw new MarketplaceError(
      'not_published',
      'That version is a draft. A seller cannot agree to a document MMAKF has not published.'
    );
  }

  try {
    const [row] = await db.insert(s.sellerPolicyAcceptances).values({
      sellerId: seller.id,
      policyVersionId,
      acceptedByUserId: ctx.principal?.userId ?? null,
      ipHash: hashIp(ip ?? ctx.ip ?? null),
      userAgent: null,
      // THE HASH, STORED AGAIN. See the file header: this is what lets an
      // acceptance be verified even if somebody later edits the version row it
      // points at.
      bodyHash: version.bodyHash,
    }).returning({ id: s.sellerPolicyAcceptances.id });

    await writeAudit(db, ctx, {
      entityType: 'seller_policy_acceptance', entityId: row.id, action: 'create',
      newValue: { sellerId: seller.id, policyVersionId, bodyHash: version.bodyHash },
    });
    return { acceptanceId: row.id, alreadyAccepted: false };
  } catch (err: any) {
    if (String(err?.cause?.message ?? err?.message ?? '').includes('seller_policy_acceptances_uk')) {
      // Accepting twice is not an error to show anybody — it is a double click.
      return { acceptanceId: null, alreadyAccepted: true };
    }
    throw err;
  }
}

/**
 * Mandatory policies the caller has not accepted the CURRENT version of.
 *
 * Note "current version": a seller who accepted version 2 of an agreement that
 * is now on version 3 appears here, which is the entire reason acceptance is
 * versioned. Silently treating an old acceptance as covering a new document is
 * how a seller ends up bound by terms they never saw.
 */
export async function outstandingAcceptances(db: DB, principal: Principal) {
  const seller = await ownSellerRecord(db, principal);

  const mandatory = await db.select().from(s.marketplacePolicies).where(and(
    eq(s.marketplacePolicies.mandatoryForSellers, true),
    eq(s.marketplacePolicies.active, true),
  ));
  if (!mandatory.length) return { outstanding: [], note: NO_MANDATORY_POLICIES };

  const accepted = await db.select({ policyVersionId: s.sellerPolicyAcceptances.policyVersionId })
    .from(s.sellerPolicyAcceptances)
    .where(eq(s.sellerPolicyAcceptances.sellerId, seller.id));
  const acceptedIds = new Set(accepted.map((a: any) => a.policyVersionId));

  const outstanding: any[] = [];
  for (const p of mandatory) {
    const current = await currentVersion(db, p.code);
    if (!current) continue;                       // mandatory but unpublished
    if (acceptedIds.has(current.version.id)) continue;
    outstanding.push({
      policyId: p.id, code: p.code, title: p.title,
      versionId: current.version.id, version: current.version.version,
      effectiveFrom: current.version.effectiveFrom,
    });
  }
  return { outstanding, note: null };
}

/** What a seller is being asked to read, with the text. */
export async function policiesForSeller(db: DB, principal: Principal) {
  const seller = await ownSellerRecord(db, principal);

  const policies = await db.select().from(s.marketplacePolicies)
    .where(eq(s.marketplacePolicies.active, true))
    .orderBy(asc(s.marketplacePolicies.code));

  const accepted = await db.select().from(s.sellerPolicyAcceptances)
    .where(eq(s.sellerPolicyAcceptances.sellerId, seller.id));

  const out = [];
  for (const p of policies) {
    const current = await currentVersion(db, p.code);
    const mine = current
      ? accepted.find((a: any) => a.policyVersionId === current.version.id) ?? null
      : null;
    out.push({
      policyId: p.id,
      code: p.code,
      title: p.title,
      mandatory: p.mandatoryForSellers,
      version: current?.version ?? null,
      accepted: mine,
      // Belt and braces, surfaced: if a published body were ever edited in
      // place, the acceptance's frozen hash would stop agreeing with it and
      // this flag would say so rather than the discrepancy going unnoticed.
      acceptanceStillValid: mine && current ? mine.bodyHash === current.version.bodyHash : null,
      note: current ? null : POLICY_NOT_PUBLISHED,
    });
  }
  return out;
}

/** Who accepted what, for the federation. */
export async function acceptanceRegister(db: DB, principal: Principal, policyId: number, limit = 500) {
  assertCan(principal, 'marketplace:read', {});
  return db.select({
    acceptance: s.sellerPolicyAcceptances,
    version: s.policyVersions.version,
    versionHash: s.policyVersions.bodyHash,
    sellerRef: s.sellers.ref,
    tradingName: s.sellers.tradingName,
  }).from(s.sellerPolicyAcceptances)
    .innerJoin(s.policyVersions, eq(s.sellerPolicyAcceptances.policyVersionId, s.policyVersions.id))
    .innerJoin(s.sellers, eq(s.sellerPolicyAcceptances.sellerId, s.sellers.id))
    .where(eq(s.policyVersions.policyId, policyId))
    .orderBy(desc(s.sellerPolicyAcceptances.acceptedAt))
    .limit(Math.min(limit, 2000));
}
