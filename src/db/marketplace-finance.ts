// Commission resolution, settlement accrual and seller payouts.
//
// ─── THE REFUSAL AT THE CENTRE OF THIS FILE ─────────────────────────────────
//
// `resolveCommission()` returns EITHER a resolved figure with the rule version
// that produced it, OR a gap saying why it could not. It never returns a rate.
// There is no fallback, no default, no `?? 0` and no `?? 1000`, and every one
// of those would be a decision about other people's money that nobody at MMAKF
// made.
//
// A gap does not block the SALE. The buyer buys, the seller ships, the money is
// captured and reconciled — and the seller order is marked unsettleable until
// the federation publishes a rule. That is the only honest arrangement: refusing
// the sale punishes a seller for an administrative gap, and settling at an
// invented rate takes money that was never agreed.
//
// ─── HOW A RULE IS CHOSEN, AND WHY THE ORDER IS STATED IN SQL ───────────────
//
// Candidate rules are those whose every pinned axis matches the sale. Among
// them the winner is, in order:
//
//   1. highest `priority`;
//   2. then MOST SPECIFIC — the count of axes it pins;
//   3. then lowest id.
//
// All three are in the ORDER BY. A commission that depended on the planner's
// row order would change after a VACUUM, and the seller would have no way to
// know why last month's rate was different.
//
// ─── AND THE FROZEN COPY ────────────────────────────────────────────────────
//
// The resolved rate, the basis and the computed amounts are written onto
// `order_line_commissions` and never recomputed. `ruleVersionId` is provenance
// only. This is the same discipline as `invoices.fxRateId` — a figure that
// points into a table whose purpose is to change is a figure that moves.

import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, allocateFederationId, type AuditContext } from '@/db/federation';
import { assertCan, type Principal } from '@/lib/rbac';
import { MarketplaceError } from '@/db/marketplace';

type DB = any;

export const COMMISSION_NOT_CONFIGURED =
  'MMAKF has published no commission rule covering this sale. The sale stands and ' +
  'the seller keeps their goods sold; settlement is held until the federation sets a rate. ' +
  'Nothing is charged at a rate this system chose.';

export const SLA_NOT_SET =
  'MMAKF has set no service-level window for this. Nothing is overdue against a ' +
  'deadline the federation has not published.';

// ─── Commission rules ───────────────────────────────────────────────────────

export interface CommissionRuleInput {
  code: string;
  label: string;
  description?: string | null;
  sellerId?: number | null;
  sellerTier?: string | null;
  sellerType?: string | null;
  categoryId?: number | null;
  categorySubtree?: boolean;
  listingId?: number | null;
  campaignCode?: string | null;
  contractRef?: string | null;
  priority?: number;
}

export async function createCommissionRule(db: DB, ctx: AuditContext, input: CommissionRuleInput) {
  assertCan(ctx.principal, 'marketplace:commission', {});
  const code = String(input?.code ?? '').trim();
  const label = String(input?.label ?? '').trim();
  if (!code || !label) throw new MarketplaceError('bad_rule', 'A commission rule needs a code and a label.');

  const [row] = await db.insert(s.commissionRules).values({
    code, label,
    description: input.description ?? null,
    sellerId: input.sellerId ?? null,
    sellerTier: input.sellerTier ?? null,
    sellerType: input.sellerType ?? null,
    categoryId: input.categoryId ?? null,
    categorySubtree: input.categorySubtree ?? true,
    listingId: input.listingId ?? null,
    campaignCode: input.campaignCode ?? null,
    contractRef: input.contractRef ?? null,
    priority: Number.isInteger(input.priority) ? input.priority! : 100,
    createdByUserId: ctx.principal?.userId ?? null,
  }).returning({ id: s.commissionRules.id });

  await writeAudit(db, ctx, {
    entityType: 'commission_rule', entityId: row.id, action: 'create', newValue: { code, label },
  });
  return { ruleId: row.id, code };
}

export interface CommissionVersionInput {
  rateBps?: number | null;
  flatMinor?: number | null;
  minMinor?: number | null;
  maxMinor?: number | null;
  chargedOnShipping: boolean;
  chargedOnTax: boolean;
  commissionTaxRateBps?: number | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  authority?: string | null;
  notes?: string | null;
}

/**
 * Draft a rate. NOT published — `publishCommissionVersion()` is a second act.
 *
 * The two-step is the whole segregation-of-duties story for pricing: a rate can
 * be prepared and argued about without any chance of it reaching a live
 * checkout half-finished, because the resolver filters on `published_at IS NOT
 * NULL` in SQL.
 *
 * `chargedOnShipping` and `chargedOnTax` are REQUIRED, with no default. They are
 * the single most common source of dispute between a marketplace and its
 * sellers, they differ by real money on every order, and there is no answer
 * that is right for everyone — so there is no answer here.
 */
export async function draftCommissionVersion(
  db: DB, ctx: AuditContext, ruleId: number, input: CommissionVersionInput
) {
  assertCan(ctx.principal, 'marketplace:commission', {});
  const rule = (await db.select().from(s.commissionRules).where(eq(s.commissionRules.id, ruleId)).limit(1))[0];
  if (!rule) throw new MarketplaceError('unknown_rule', 'No such commission rule.');

  const hasRate = Number.isInteger(input.rateBps) && (input.rateBps as number) >= 0;
  const hasFlat = Number.isInteger(input.flatMinor) && (input.flatMinor as number) >= 0;
  if (!hasRate && !hasFlat) {
    throw new MarketplaceError('no_rate', 'A commission version must state a rate, a flat amount, or both.');
  }
  if (hasRate && (input.rateBps as number) > 10_000) {
    throw new MarketplaceError('bad_rate', 'A commission rate above 100% is not a rate. Basis points: 1250 is 12.5%.');
  }
  if (typeof input.chargedOnShipping !== 'boolean' || typeof input.chargedOnTax !== 'boolean') {
    throw new MarketplaceError(
      'basis_unstated',
      'A commission version must say whether it is charged on shipping and on tax. ' +
      'There is no safe default: both answers are defensible and they differ by real money.'
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.effectiveFrom ?? ''))) {
    throw new MarketplaceError('bad_date', 'A commission version needs an effective-from date (YYYY-MM-DD).');
  }

  const last = (await db.select({ v: s.commissionRuleVersions.version })
    .from(s.commissionRuleVersions)
    .where(eq(s.commissionRuleVersions.ruleId, ruleId))
    .orderBy(desc(s.commissionRuleVersions.version)).limit(1))[0];

  const [row] = await db.insert(s.commissionRuleVersions).values({
    ruleId,
    version: (last?.v ?? 0) + 1,
    rateBps: input.rateBps ?? null,
    flatMinor: input.flatMinor ?? null,
    minMinor: input.minMinor ?? null,
    maxMinor: input.maxMinor ?? null,
    chargedOnShipping: input.chargedOnShipping,
    chargedOnTax: input.chargedOnTax,
    commissionTaxRateBps: input.commissionTaxRateBps ?? null,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    authority: input.authority ?? null,
    notes: input.notes ?? null,
  }).returning({ id: s.commissionRuleVersions.id, version: s.commissionRuleVersions.version });

  await writeAudit(db, ctx, {
    entityType: 'commission_rule_version', entityId: row.id, action: 'create',
    newValue: { ruleId, version: row.version, rateBps: input.rateBps ?? null, published: false },
  });
  return { versionId: row.id, version: row.version, published: false };
}

/**
 * Publish a drafted rate.
 *
 * REQUIRES AN AUTHORITY — the resolution, meeting or contract behind it. A rate
 * that nobody can point at the decision for is a rate the federation cannot
 * defend when a seller asks, and every seller asks eventually.
 */
export async function publishCommissionVersion(
  db: DB, ctx: AuditContext, versionId: number, authority: string
) {
  assertCan(ctx.principal, 'marketplace:commission', {});
  if (!String(authority ?? '').trim()) {
    throw new MarketplaceError(
      'authority_required',
      'Publishing a commission rate requires the authority behind it — the resolution, meeting or contract.'
    );
  }
  const version = (await db.select().from(s.commissionRuleVersions)
    .where(eq(s.commissionRuleVersions.id, versionId)).limit(1))[0];
  if (!version) throw new MarketplaceError('unknown_version', 'No such commission version.');
  if (version.publishedAt) throw new MarketplaceError('already_published', 'That version is already published.');

  await db.update(s.commissionRuleVersions).set({
    publishedAt: new Date(),
    approvedByUserId: ctx.principal?.userId ?? null,
    authority,
  }).where(eq(s.commissionRuleVersions.id, versionId));

  await writeAudit(db, { ...ctx, authority }, {
    entityType: 'commission_rule_version', entityId: versionId, action: 'approve',
    newValue: { published: true, rateBps: version.rateBps, effectiveFrom: version.effectiveFrom },
  });
  return { versionId, published: true };
}

// ─── Resolution ─────────────────────────────────────────────────────────────

export interface CommissionBasis {
  sellerId: number;
  sellerTier?: string | null;
  sellerType?: string | null;
  listingId?: number | null;
  categoryId?: number | null;
  /** The category's materialised path, for subtree matching. */
  categoryPath?: string | null;
  campaignCode?: string | null;
  goodsMinor: number;
  shippingMinor: number;
  taxMinor: number;
  on: Date;
}

export type CommissionOutcome =
  | {
      resolved: true;
      ruleId: number; ruleVersionId: number;
      rateBps: number | null; flatMinor: number | null;
      basisMinor: number; basisDescription: string;
      commissionMinor: number; commissionTaxMinor: number; sellerPayableMinor: number;
    }
  | { resolved: false; reason: 'no_rule' | 'no_published_version'; detail: string };

/**
 * Find the rate that applies, or say why none does.
 *
 * The candidate query pins every axis IN SQL — a rule naming seller 41 must not
 * be a candidate for seller 42, and filtering that afterwards in JavaScript is
 * how a rate ends up applied to the wrong trader by a refactor that "tidied the
 * loop".
 */
export async function resolveCommission(db: DB, basis: CommissionBasis): Promise<CommissionOutcome> {
  const on = basis.on.toISOString().slice(0, 10);

  const candidates = await db.select({
    rule: s.commissionRules,
    version: s.commissionRuleVersions,
    specificity: sql<number>`(
      (case when ${s.commissionRules.sellerId} is not null then 1 else 0 end) +
      (case when ${s.commissionRules.listingId} is not null then 1 else 0 end) +
      (case when ${s.commissionRules.categoryId} is not null then 1 else 0 end) +
      (case when ${s.commissionRules.sellerTier} is not null then 1 else 0 end) +
      (case when ${s.commissionRules.sellerType} is not null then 1 else 0 end) +
      (case when ${s.commissionRules.campaignCode} is not null then 1 else 0 end)
    )::int`,
  }).from(s.commissionRules)
    .innerJoin(s.commissionRuleVersions, eq(s.commissionRuleVersions.ruleId, s.commissionRules.id))
    .where(and(
      eq(s.commissionRules.active, true),
      // DRAFTS ARE NOT CANDIDATES. Filtered in SQL, so no caller can reach one.
      sql`${s.commissionRuleVersions.publishedAt} is not null`,
      lte(s.commissionRuleVersions.effectiveFrom, on),
      or(isNull(s.commissionRuleVersions.effectiveTo), gte(s.commissionRuleVersions.effectiveTo, on)),
      // Every pinned axis must match. A NULL axis does not constrain.
      //
      // WRITTEN AS AN EXPLICIT CONDITIONAL PER AXIS, and not as a sentinel
      // comparison. The tempting shorthand is `eq(col, value ?? '')`, which
      // reads well and is wrong twice: it makes a rule pinned to the empty
      // string match a sale with no tier at all, and it compares NULL to a
      // value in SQL — which is neither true nor false but NULL, so the rule
      // silently drops out of the candidate set rather than being excluded for
      // a stated reason. When the SALE has no value on an axis, a rule that
      // pins that axis simply cannot apply, and that is what is written here.
      or(isNull(s.commissionRules.sellerId), eq(s.commissionRules.sellerId, basis.sellerId)),
      basis.sellerTier == null
        ? isNull(s.commissionRules.sellerTier)
        : or(isNull(s.commissionRules.sellerTier), eq(s.commissionRules.sellerTier, basis.sellerTier)),
      basis.sellerType == null
        ? isNull(s.commissionRules.sellerType)
        : or(isNull(s.commissionRules.sellerType), eq(s.commissionRules.sellerType, basis.sellerType)),
      basis.listingId == null
        ? isNull(s.commissionRules.listingId)
        : or(isNull(s.commissionRules.listingId), eq(s.commissionRules.listingId, basis.listingId)),
      basis.campaignCode == null
        ? isNull(s.commissionRules.campaignCode)
        : or(isNull(s.commissionRules.campaignCode), eq(s.commissionRules.campaignCode, basis.campaignCode)),
      or(
        isNull(s.commissionRules.categoryId),
        eq(s.commissionRules.categoryId, basis.categoryId ?? -1),
        // Subtree matching by materialised path prefix, which is what makes
        // "12% on everything under protective equipment" one rule and not nine.
        and(
          eq(s.commissionRules.categorySubtree, true),
          sql`exists (
            select 1 from marketplace_categories mc
            where mc.id = ${s.commissionRules.categoryId}
              and ${basis.categoryPath ?? ''} <> ''
              and (${basis.categoryPath ?? ''} = mc.path or ${basis.categoryPath ?? ''} like mc.path || '/%')
          )`,
        ),
      ),
    ))
    .orderBy(
      desc(s.commissionRules.priority),
      sql`(
        (case when ${s.commissionRules.sellerId} is not null then 1 else 0 end) +
        (case when ${s.commissionRules.listingId} is not null then 1 else 0 end) +
        (case when ${s.commissionRules.categoryId} is not null then 1 else 0 end) +
        (case when ${s.commissionRules.sellerTier} is not null then 1 else 0 end) +
        (case when ${s.commissionRules.sellerType} is not null then 1 else 0 end) +
        (case when ${s.commissionRules.campaignCode} is not null then 1 else 0 end)
      ) desc`,
      asc(s.commissionRules.id),
      desc(s.commissionRuleVersions.effectiveFrom),
    )
    .limit(1);

  if (!candidates.length) {
    return { resolved: false, reason: 'no_rule', detail: COMMISSION_NOT_CONFIGURED };
  }

  const { rule, version } = candidates[0];

  // The basis. Goods always; carriage and tax only if the version says so.
  let basisMinor = basis.goodsMinor;
  const parts = ['goods'];
  if (version.chargedOnShipping) { basisMinor += basis.shippingMinor; parts.push('shipping'); }
  if (version.chargedOnTax) { basisMinor += basis.taxMinor; parts.push('tax'); }

  // INTEGER ARITHMETIC THROUGHOUT. Math.round on a basis-point product is exact
  // for every value this system can hold; a float percentage is not.
  let commission = 0;
  if (Number.isInteger(version.rateBps)) commission += Math.round((basisMinor * version.rateBps) / 10_000);
  if (Number.isInteger(version.flatMinor)) commission += version.flatMinor;

  if (Number.isInteger(version.minMinor)) commission = Math.max(commission, version.minMinor);
  if (Number.isInteger(version.maxMinor)) commission = Math.min(commission, version.maxMinor);

  // A commission cannot exceed what the seller was paid. Not a policy choice —
  // the alternative is a negative payable, which is the federation invoicing a
  // seller for having made a sale.
  commission = Math.max(0, Math.min(commission, basis.goodsMinor + basis.shippingMinor));

  const commissionTax = Number.isInteger(version.commissionTaxRateBps)
    ? Math.round((commission * version.commissionTaxRateBps) / 10_000)
    : 0;

  return {
    resolved: true,
    ruleId: rule.id,
    ruleVersionId: version.id,
    rateBps: version.rateBps ?? null,
    flatMinor: version.flatMinor ?? null,
    basisMinor,
    basisDescription: parts.join(' + '),
    commissionMinor: commission,
    commissionTaxMinor: commissionTax,
    sellerPayableMinor: basis.goodsMinor + basis.shippingMinor - commission - commissionTax,
  };
}

/**
 * Resolve and FREEZE the commission for one order line.
 *
 * Writes `order_line_commissions` on success and `commission_gaps` on failure.
 * Both are idempotent against a retried checkout: the first is guarded by a
 * unique index on the line, the second by a partial unique index on the open
 * gap.
 */
export async function freezeCommissionForLine(
  db: DB,
  args: {
    orderLineId: number; sellerOrderId: number; sellerId: number;
    basis: CommissionBasis;
  }
): Promise<CommissionOutcome> {
  const existing = (await db.select().from(s.orderLineCommissions)
    .where(eq(s.orderLineCommissions.orderLineId, args.orderLineId)).limit(1))[0];
  if (existing) {
    return {
      resolved: true,
      ruleId: existing.ruleId, ruleVersionId: existing.ruleVersionId,
      rateBps: existing.rateBps, flatMinor: existing.flatMinor,
      basisMinor: existing.basisMinor, basisDescription: existing.basisDescription ?? '',
      commissionMinor: existing.commissionMinor,
      commissionTaxMinor: existing.commissionTaxMinor,
      sellerPayableMinor: existing.sellerPayableMinor,
    };
  }

  const outcome = await resolveCommission(db, args.basis);

  if (!outcome.resolved) {
    await db.insert(s.commissionGaps).values({
      sellerOrderId: args.sellerOrderId,
      orderLineId: args.orderLineId,
      sellerId: args.sellerId,
      categoryId: args.basis.categoryId ?? null,
      reason: outcome.reason,
      detail: outcome.detail,
      amountAtRiskMinor: args.basis.goodsMinor + args.basis.shippingMinor,
    }).onConflictDoNothing();
    return outcome;
  }

  await db.insert(s.orderLineCommissions).values({
    orderLineId: args.orderLineId,
    sellerOrderId: args.sellerOrderId,
    sellerId: args.sellerId,
    ruleId: outcome.ruleId,
    ruleVersionId: outcome.ruleVersionId,
    rateBps: outcome.rateBps,
    flatMinor: outcome.flatMinor,
    basisMinor: outcome.basisMinor,
    basisDescription: outcome.basisDescription,
    commissionMinor: outcome.commissionMinor,
    commissionTaxMinor: outcome.commissionTaxMinor,
    sellerPayableMinor: outcome.sellerPayableMinor,
  }).onConflictDoNothing();

  return outcome;
}

/** Roll the line commissions up onto the seller order. */
export async function refreshSellerOrderCommission(db: DB, sellerOrderId: number) {
  const lines = await db.select({ n: sql<number>`count(*)::int` })
    .from(s.orderLines).where(eq(s.orderLines.sellerOrderId, sellerOrderId));
  const priced = await db.select({
    n: sql<number>`count(*)::int`,
    commission: sql<number>`coalesce(sum(${s.orderLineCommissions.commissionMinor}), 0)::int`,
    commissionTax: sql<number>`coalesce(sum(${s.orderLineCommissions.commissionTaxMinor}), 0)::int`,
    payable: sql<number>`coalesce(sum(${s.orderLineCommissions.sellerPayableMinor}), 0)::int`,
  }).from(s.orderLineCommissions).where(eq(s.orderLineCommissions.sellerOrderId, sellerOrderId));

  const total = lines[0]?.n ?? 0;
  const covered = priced[0]?.n ?? 0;
  const resolved = total > 0 && covered === total;

  await db.update(s.sellerOrders).set({
    // NULL, not zero, when unresolved. Zero would be a statement that the
    // federation takes nothing, which is a decision nobody made.
    commissionMinor: resolved ? priced[0].commission : null,
    commissionTaxMinor: resolved ? priced[0].commissionTax : null,
    sellerPayableMinor: resolved ? priced[0].payable : null,
    commissionResolved: resolved,
    updatedAt: new Date(),
  }).where(eq(s.sellerOrders.id, sellerOrderId));

  return { resolved, lines: total, covered };
}

/** Seller orders held because nobody has told the system what to charge. */
export async function heldForCommission(db: DB, principal: Principal, limit = 200) {
  assertCan(principal, 'marketplace:read', {});
  return db.select({
    gap: s.commissionGaps,
    sellerOrderNo: s.sellerOrders.sellerOrderNo,
    sellerName: s.sellers.tradingName,
    totalMinor: s.sellerOrders.totalMinor,
  }).from(s.commissionGaps)
    .innerJoin(s.sellerOrders, eq(s.commissionGaps.sellerOrderId, s.sellerOrders.id))
    .innerJoin(s.sellers, eq(s.commissionGaps.sellerId, s.sellers.id))
    .where(isNull(s.commissionGaps.resolvedAt))
    .orderBy(desc(s.commissionGaps.raisedAt))
    .limit(Math.min(limit, 500));
}

/**
 * Re-run resolution for every open gap. Called after a rule is published.
 *
 * This is what turns "we forgot to set a rate for headgear" from a permanent
 * hole into a five-minute administrative correction.
 */
export async function reresolveCommissionGaps(db: DB, ctx: AuditContext) {
  assertCan(ctx.principal, 'marketplace:commission', {});
  const gaps = await db.select().from(s.commissionGaps).where(isNull(s.commissionGaps.resolvedAt)).limit(1000);

  let fixed = 0;
  const touched = new Set<number>();
  for (const gap of gaps) {
    if (gap.orderLineId == null) continue;
    const basis = await basisForLine(db, gap.orderLineId);
    if (!basis) continue;
    const outcome = await freezeCommissionForLine(db, {
      orderLineId: gap.orderLineId, sellerOrderId: gap.sellerOrderId, sellerId: gap.sellerId, basis,
    });
    if (outcome.resolved) {
      await db.update(s.commissionGaps).set({
        resolvedAt: new Date(), resolvedByRuleVersionId: outcome.ruleVersionId,
      }).where(eq(s.commissionGaps.id, gap.id));
      touched.add(gap.sellerOrderId);
      fixed++;
    }
  }
  for (const soId of touched) await refreshSellerOrderCommission(db, soId);
  return { examined: gaps.length, resolved: fixed };
}

/** Rebuild a commission basis from a stored order line. */
export async function basisForLine(db: DB, orderLineId: number): Promise<CommissionBasis | null> {
  const rows = await db.select({
    line: s.orderLines,
    sellerOrder: s.sellerOrders,
    seller: s.sellers,
    listing: s.listings,
    category: s.marketplaceCategories,
  }).from(s.orderLines)
    .innerJoin(s.sellerOrders, eq(s.orderLines.sellerOrderId, s.sellerOrders.id))
    .innerJoin(s.sellers, eq(s.sellerOrders.sellerId, s.sellers.id))
    .leftJoin(s.listings, eq(s.orderLines.listingId, s.listings.id))
    .leftJoin(s.marketplaceCategories, eq(s.listings.categoryId, s.marketplaceCategories.id))
    .where(eq(s.orderLines.id, orderLineId)).limit(1);
  if (!rows.length) return null;
  const { line, sellerOrder, seller, listing, category } = rows[0];

  return {
    sellerId: seller.id,
    sellerTier: seller.tier ?? null,
    sellerType: seller.sellerType ?? null,
    listingId: listing?.id ?? null,
    categoryId: category?.id ?? null,
    categoryPath: category?.path ?? null,
    goodsMinor: line.totalPaise - line.taxPaise,
    // Carriage sits on the seller order, not the line; apportioning it per line
    // would invent a split the invoice does not contain.
    shippingMinor: 0,
    taxMinor: line.taxPaise,
    on: sellerOrder.createdAt ?? new Date(),
  };
}

// ─── Settlement ─────────────────────────────────────────────────────────────

/** The seller's currently-open settlement, opened if there is none. */
export async function openSettlementFor(db: DB, sellerId: number, on = new Date()) {
  const existing = (await db.select().from(s.sellerSettlements).where(and(
    eq(s.sellerSettlements.sellerId, sellerId), eq(s.sellerSettlements.status, 'open'),
  )).limit(1))[0];
  if (existing) return existing;

  const ref = await allocateFederationId(db, 'STL');
  const periodStart = on.toISOString().slice(0, 10);
  const [row] = await db.insert(s.sellerSettlements).values({
    ref, sellerId, periodStart, periodEnd: periodStart, status: 'open',
  }).returning();
  return row;
}

/**
 * Post a delivered seller order onto its seller's open settlement.
 *
 * ONE ROW PER (SELLER ORDER, KIND, LINE), guarded by a partial unique index, so
 * the accrual job can be run twice — and it will be, by a cron that overlaps
 * itself — without paying a seller twice.
 *
 * WHY DELIVERY AND NOT PAYMENT. Accruing at payment would put money on a
 * seller's statement for goods still in a warehouse, and every cancellation
 * would then be a reversal. Accruing at delivery means a settlement line
 * corresponds to a completed transaction. MMAKF may prefer otherwise; the
 * function takes the seller order and does not decide when it is called.
 */
export async function accrueSellerOrder(db: DB, sellerOrderId: number) {
  const so = (await db.select().from(s.sellerOrders).where(eq(s.sellerOrders.id, sellerOrderId)).limit(1))[0];
  if (!so) throw new MarketplaceError('unknown_seller_order', 'No such seller order.');

  if (!so.commissionResolved) {
    // The refusal. Not an error — a state.
    return { accrued: false, reason: 'commission_unresolved', detail: COMMISSION_NOT_CONFIGURED };
  }

  const settlement = await openSettlementFor(db, so.sellerId);
  const occurredOn = (so.deliveredAt ?? so.paidAt ?? new Date()).toISOString().slice(0, 10);
  const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.sellerOrderId, sellerOrderId));

  for (const line of lines) {
    const commission = (await db.select().from(s.orderLineCommissions)
      .where(eq(s.orderLineCommissions.orderLineId, line.id)).limit(1))[0];
    if (!commission) continue;

    await db.insert(s.settlementLines).values({
      settlementId: settlement.id, sellerId: so.sellerId, kind: 'sale',
      amountMinor: line.totalPaise - line.taxPaise,
      sellerOrderId, orderId: so.orderId, orderLineId: line.id,
      description: line.description, occurredOn,
    }).onConflictDoNothing();

    if (commission.commissionMinor > 0) {
      await db.insert(s.settlementLines).values({
        settlementId: settlement.id, sellerId: so.sellerId, kind: 'commission',
        // NEGATIVE. The sign is the meaning; a magnitude with a kind would let
        // a total be computed with the wrong sign by any caller that forgot.
        amountMinor: -commission.commissionMinor,
        sellerOrderId, orderId: so.orderId, orderLineId: line.id,
        description: `Commission on ${line.description}`, occurredOn,
      }).onConflictDoNothing();
    }
    if (commission.commissionTaxMinor > 0) {
      await db.insert(s.settlementLines).values({
        settlementId: settlement.id, sellerId: so.sellerId, kind: 'commission_tax',
        amountMinor: -commission.commissionTaxMinor,
        sellerOrderId, orderId: so.orderId, orderLineId: line.id,
        description: `Tax on commission for ${line.description}`, occurredOn,
      }).onConflictDoNothing();
    }
  }

  if (so.shippingMinor > 0) {
    await db.insert(s.settlementLines).values({
      settlementId: settlement.id, sellerId: so.sellerId, kind: 'shipping',
      amountMinor: so.shippingMinor,
      sellerOrderId, orderId: so.orderId, orderLineId: null,
      description: `Carriage on ${so.sellerOrderNo}`, occurredOn,
    }).onConflictDoNothing();
  }

  await recomputeSettlement(db, settlement.id);
  return { accrued: true, settlementId: settlement.id, ref: settlement.ref };
}

/**
 * Post a refund against the seller's settlement — and REVERSE THE COMMISSION
 * TAKEN ON IT.
 *
 * A marketplace that keeps its commission on refunded goods is one a seller
 * stops trusting the first time they notice, and they always notice.
 */
export async function accrueRefund(
  db: DB,
  args: {
    sellerOrderId: number; refundId?: number | null; returnRequestId?: number | null;
    amountMinor: number; description: string; fundedBy: 'seller' | 'platform';
  }
) {
  const so = (await db.select().from(s.sellerOrders).where(eq(s.sellerOrders.id, args.sellerOrderId)).limit(1))[0];
  if (!so) throw new MarketplaceError('unknown_seller_order', 'No such seller order.');
  const settlement = await openSettlementFor(db, so.sellerId);
  const occurredOn = new Date().toISOString().slice(0, 10);

  // A PLATFORM-FUNDED refund costs the seller nothing. MMAKF absorbs it, and
  // the seller's statement must not show a deduction they did not incur.
  if (args.fundedBy === 'seller') {
    await db.insert(s.settlementLines).values({
      settlementId: settlement.id, sellerId: so.sellerId, kind: 'refund',
      amountMinor: -Math.abs(args.amountMinor),
      sellerOrderId: args.sellerOrderId, orderId: so.orderId,
      refundId: args.refundId ?? null, returnRequestId: args.returnRequestId ?? null,
      description: args.description, occurredOn,
    });

    // Proportional reversal of the commission on the refunded value.
    const totalGoods = Math.max(1, so.subtotalMinor);
    const share = Math.min(1, Math.abs(args.amountMinor) / totalGoods);
    const reversal = Math.round((so.commissionMinor ?? 0) * share);
    if (reversal > 0) {
      await db.insert(s.settlementLines).values({
        settlementId: settlement.id, sellerId: so.sellerId, kind: 'refund_commission_reversal',
        amountMinor: reversal,          // POSITIVE — giving commission back.
        sellerOrderId: args.sellerOrderId, orderId: so.orderId,
        refundId: args.refundId ?? null,
        description: `Commission returned on ${args.description}`, occurredOn,
      });
    }
  }

  await db.update(s.sellerOrders).set({
    refundedMinor: sql`${s.sellerOrders.refundedMinor} + ${Math.abs(args.amountMinor)}`,
    updatedAt: new Date(),
  }).where(eq(s.sellerOrders.id, args.sellerOrderId));

  await recomputeSettlement(db, settlement.id);
  return { settlementId: settlement.id };
}

/** Recompute a settlement's totals from its lines. The lines are the truth. */
export async function recomputeSettlement(db: DB, settlementId: number) {
  const rows = await db.select({
    kind: s.settlementLines.kind,
    total: sql<number>`coalesce(sum(${s.settlementLines.amountMinor}), 0)::int`,
  }).from(s.settlementLines)
    .where(eq(s.settlementLines.settlementId, settlementId))
    .groupBy(s.settlementLines.kind);

  const by = (k: string) => rows.find((r: any) => r.kind === k)?.total ?? 0;
  const net = rows.reduce((n: number, r: any) => n + r.total, 0);

  const orders = await db.select({ n: sql<number>`count(distinct ${s.settlementLines.sellerOrderId})::int` })
    .from(s.settlementLines).where(eq(s.settlementLines.settlementId, settlementId));

  const unresolved = await db.select({ n: sql<number>`count(*)::int` })
    .from(s.settlementLines)
    .innerJoin(s.sellerOrders, eq(s.settlementLines.sellerOrderId, s.sellerOrders.id))
    .where(and(eq(s.settlementLines.settlementId, settlementId), eq(s.sellerOrders.commissionResolved, false)));

  await db.update(s.sellerSettlements).set({
    grossMinor: by('sale'),
    shippingMinor: by('shipping'),
    commissionMinor: -by('commission'),
    commissionTaxMinor: -by('commission_tax'),
    refundMinor: -by('refund') - by('refund_commission_reversal'),
    adjustmentMinor: by('adjustment') + by('penalty') + by('hold') + by('release'),
    gatewayFeeMinor: -by('gateway_fee'),
    netPayableMinor: net,
    orderCount: orders[0]?.n ?? 0,
    hasUnresolvedCommission: (unresolved[0]?.n ?? 0) > 0,
    updatedAt: new Date(),
  }).where(eq(s.sellerSettlements.id, settlementId));

  return { netPayableMinor: net };
}

/**
 * Seal a settlement period. Nothing may be added afterwards.
 *
 * REFUSES WHILE ANY COMMISSION IS UNRESOLVED. That is the constraint the whole
 * commission-gap apparatus exists to serve: a statement containing a sale whose
 * commission nobody has set is a statement that cannot be right, and closing it
 * would make a wrong figure final.
 */
export async function closeSettlement(db: DB, ctx: AuditContext, settlementId: number) {
  assertCan(ctx.principal, 'marketplace:settle', {});
  const st = (await db.select().from(s.sellerSettlements)
    .where(eq(s.sellerSettlements.id, settlementId)).limit(1))[0];
  if (!st) throw new MarketplaceError('unknown_settlement', 'No such settlement.');
  if (st.status !== 'open') throw new MarketplaceError('not_open', `That settlement is ${st.status}.`);

  await recomputeSettlement(db, settlementId);
  const fresh = (await db.select().from(s.sellerSettlements)
    .where(eq(s.sellerSettlements.id, settlementId)).limit(1))[0];

  if (fresh.hasUnresolvedCommission) {
    throw new MarketplaceError(
      'unresolved_commission',
      'This period contains a sale whose commission MMAKF has not set. Publish a rule ' +
      'covering it and re-resolve the gaps; a statement closed over an unknown rate is a ' +
      'wrong figure made final.'
    );
  }

  await db.update(s.sellerSettlements).set({
    status: 'closed',
    periodEnd: new Date().toISOString().slice(0, 10),
    closedAt: new Date(),
    closedByUserId: ctx.principal?.userId ?? null,
    updatedAt: new Date(),
  }).where(eq(s.sellerSettlements.id, settlementId));

  await writeAudit(db, ctx, {
    entityType: 'seller_settlement', entityId: settlementId, action: 'finalize',
    newValue: { ref: fresh.ref, netPayableMinor: fresh.netPayableMinor },
  });
  return { settlementId, netPayableMinor: fresh.netPayableMinor };
}

/**
 * Release a closed settlement for payment.
 *
 * A SECOND PERSON, deliberately: `closeSettlement` seals the figures and this
 * approves paying them. Both require `marketplace:settle`, so the split is
 * available to MMAKF but not imposed — whether one officer may do both is the
 * federation's staffing decision, and the audit trail records which of them did
 * which either way.
 */
export async function approveSettlement(db: DB, ctx: AuditContext, settlementId: number, note?: string | null) {
  assertCan(ctx.principal, 'marketplace:settle', {});
  const st = (await db.select().from(s.sellerSettlements)
    .where(eq(s.sellerSettlements.id, settlementId)).limit(1))[0];
  if (!st) throw new MarketplaceError('unknown_settlement', 'No such settlement.');
  if (st.status !== 'closed') throw new MarketplaceError('not_closed', `A settlement must be closed before approval; this one is ${st.status}.`);
  if (st.netPayableMinor <= 0) {
    throw new MarketplaceError(
      'nothing_payable',
      'This settlement has nothing to pay. Carry the balance forward rather than approving a zero payout.'
    );
  }

  await db.update(s.sellerSettlements).set({
    status: 'approved',
    approvedByUserId: ctx.principal?.userId ?? null,
    approvedAt: new Date(),
    notes: note ?? st.notes,
    updatedAt: new Date(),
  }).where(eq(s.sellerSettlements.id, settlementId));

  await writeAudit(db, ctx, {
    entityType: 'seller_settlement', entityId: settlementId, action: 'approve',
    newValue: { netPayableMinor: st.netPayableMinor },
  });
  return { settlementId, netPayableMinor: st.netPayableMinor };
}

/**
 * Create the payout record for an approved settlement.
 *
 * DOES NOT MOVE MONEY. It creates the instruction, with an idempotency key the
 * database enforces, and a provider adapter marks it paid. Separating the two
 * is what makes a retry safe: the second attempt collides on the unique index
 * rather than sending a second transfer.
 */
export async function createPayout(db: DB, ctx: AuditContext, settlementId: number) {
  assertCan(ctx.principal, 'marketplace:settle', {});
  const st = (await db.select().from(s.sellerSettlements)
    .where(eq(s.sellerSettlements.id, settlementId)).limit(1))[0];
  if (!st) throw new MarketplaceError('unknown_settlement', 'No such settlement.');
  if (st.status !== 'approved') {
    throw new MarketplaceError('not_approved', `A payout needs an approved settlement; this one is ${st.status}.`);
  }

  const account = (await db.select().from(s.payoutAccounts).where(and(
    eq(s.payoutAccounts.sellerId, st.sellerId),
    eq(s.payoutAccounts.status, 'verified'),
    isNull(s.payoutAccounts.disabledAt),
  )).orderBy(desc(s.payoutAccounts.isDefault)).limit(1))[0];

  if (!account) {
    throw new MarketplaceError(
      'no_verified_account',
      'This seller has no verified payout account. Money is not sent to an account nobody has checked.'
    );
  }

  // Deterministic: the same settlement always produces the same key, so a
  // retried request collides instead of paying twice.
  const idempotencyKey = `settlement:${settlementId}`;
  const ref = await allocateFederationId(db, 'PAY');

  try {
    const [row] = await db.insert(s.sellerPayouts).values({
      ref, settlementId, sellerId: st.sellerId,
      payoutAccountId: account.id,
      amountMinor: st.netPayableMinor,
      currency: st.currency,
      provider: account.provider,
      status: 'pending',
      initiatedByUserId: ctx.principal?.userId ?? null,
      idempotencyKey,
    }).returning({ id: s.sellerPayouts.id });

    await db.update(s.sellerSettlements).set({ status: 'paying', updatedAt: new Date() })
      .where(eq(s.sellerSettlements.id, settlementId));

    await writeAudit(db, ctx, {
      entityType: 'seller_payout', entityId: row.id, action: 'create',
      newValue: { ref, settlementId, amountMinor: st.netPayableMinor },
    });
    return { payoutId: row.id, ref, amountMinor: st.netPayableMinor };
  } catch (err: any) {
    if (String(err?.message ?? '').includes('seller_payouts_idempotency_uk')) {
      const existing = (await db.select().from(s.sellerPayouts)
        .where(eq(s.sellerPayouts.idempotencyKey, idempotencyKey)).limit(1))[0];
      // The retry path, and the whole reason the key exists.
      return { payoutId: existing.id, ref: existing.ref, amountMinor: existing.amountMinor, alreadyExisted: true };
    }
    throw err;
  }
}

export async function markPayoutPaid(
  db: DB, ctx: AuditContext, payoutId: number,
  detail: { providerPayoutId?: string | null; utr?: string | null }
) {
  assertCan(ctx.principal, 'marketplace:settle', {});
  const p = (await db.select().from(s.sellerPayouts).where(eq(s.sellerPayouts.id, payoutId)).limit(1))[0];
  if (!p) throw new MarketplaceError('unknown_payout', 'No such payout.');
  if (p.status === 'paid') return { payoutId, alreadyPaid: true };

  await db.update(s.sellerPayouts).set({
    status: 'paid', paidAt: new Date(),
    providerPayoutId: detail.providerPayoutId ?? p.providerPayoutId,
    utr: detail.utr ?? p.utr,
    updatedAt: new Date(),
  }).where(eq(s.sellerPayouts.id, payoutId));

  if (p.settlementId) {
    await db.update(s.sellerSettlements).set({ status: 'paid', updatedAt: new Date() })
      .where(eq(s.sellerSettlements.id, p.settlementId));
  }

  await writeAudit(db, ctx, {
    entityType: 'seller_payout', entityId: payoutId, action: 'update',
    oldValue: { status: p.status }, newValue: { status: 'paid', utr: detail.utr ?? null },
  });
  return { payoutId, alreadyPaid: false };
}

// ─── Adjustments ────────────────────────────────────────────────────────────

/**
 * Change what a seller is owed, outside the ordinary sales arithmetic.
 *
 * REQUIRES A REASON AND AN APPROVER. This is the function through which a
 * person's income is reduced; an unattributed row here is indistinguishable
 * from an error and from theft, and the seller is entitled to know who decided.
 */
export async function adjustPayable(
  db: DB, ctx: AuditContext,
  input: {
    sellerId: number;
    kind: (typeof s.adjustmentKind.enumValues)[number];
    amountMinor: number;
    reason: string;
    authority?: string | null;
    disputeId?: number | null;
  }
) {
  assertCan(ctx.principal, 'marketplace:settle', {});
  if (!String(input?.reason ?? '').trim()) {
    throw new MarketplaceError('reason_required', 'An adjustment to a seller’s payable requires a stated reason.');
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor === 0) {
    throw new MarketplaceError('bad_amount', 'An adjustment must be a non-zero whole number of minor units.');
  }

  const settlement = await openSettlementFor(db, input.sellerId);

  const [adj] = await db.insert(s.payoutAdjustments).values({
    sellerId: input.sellerId,
    settlementId: settlement.id,
    kind: input.kind,
    amountMinor: input.amountMinor,
    reason: input.reason,
    authority: input.authority ?? null,
    disputeId: input.disputeId ?? null,
    requestedByUserId: ctx.principal?.userId ?? null,
    approvedByUserId: ctx.principal?.userId ?? null,
    approvedAt: new Date(),
  }).returning({ id: s.payoutAdjustments.id });

  const [line] = await db.insert(s.settlementLines).values({
    settlementId: settlement.id, sellerId: input.sellerId,
    kind: input.kind === 'penalty' ? 'penalty' : 'adjustment',
    amountMinor: input.amountMinor,
    disputeId: input.disputeId ?? null,
    description: `${input.kind}: ${input.reason}`,
    occurredOn: new Date().toISOString().slice(0, 10),
  }).returning({ id: s.settlementLines.id });

  await db.update(s.payoutAdjustments)
    .set({ appliedAt: new Date(), appliedLineId: line.id })
    .where(eq(s.payoutAdjustments.id, adj.id));

  await recomputeSettlement(db, settlement.id);

  await writeAudit(db, { ...ctx, reason: input.reason }, {
    entityType: 'payout_adjustment', entityId: adj.id, action: 'create',
    newValue: { sellerId: input.sellerId, kind: input.kind, amountMinor: input.amountMinor },
  });
  return { adjustmentId: adj.id, settlementId: settlement.id };
}

// ─── Statements ─────────────────────────────────────────────────────────────

/**
 * Freeze a statement for a period.
 *
 * SNAPSHOTS THE LINES, so the March statement does not change in April when a
 * refund posts. A statement is a document; a query result is not.
 */
export async function generateStatement(
  db: DB, ctx: AuditContext,
  input: { sellerId: number; settlementId: number; cadence: 'daily' | 'weekly' | 'monthly' }
) {
  assertCan(ctx.principal, 'marketplace:settle', {});
  const st = (await db.select().from(s.sellerSettlements)
    .where(eq(s.sellerSettlements.id, input.settlementId)).limit(1))[0];
  if (!st) throw new MarketplaceError('unknown_settlement', 'No such settlement.');

  const lines = await db.select().from(s.settlementLines)
    .where(eq(s.settlementLines.settlementId, input.settlementId))
    .orderBy(asc(s.settlementLines.occurredOn), asc(s.settlementLines.id));

  const ref = await allocateFederationId(db, 'STM');
  const [row] = await db.insert(s.sellerStatements).values({
    ref, sellerId: input.sellerId, settlementId: input.settlementId,
    periodStart: st.periodStart, periodEnd: st.periodEnd, cadence: input.cadence,
    grossMinor: st.grossMinor,
    commissionMinor: st.commissionMinor,
    refundMinor: st.refundMinor,
    adjustmentMinor: st.adjustmentMinor,
    netMinor: st.netPayableMinor,
    currency: st.currency,
    snapshot: { settlementRef: st.ref, lines } as any,
  }).onConflictDoNothing().returning({ id: s.sellerStatements.id });

  return { statementId: row?.id ?? null, ref };
}

/** A seller reading their own statements. No sellerId parameter, by design. */
export async function myStatements(db: DB, principal: Principal, limit = 24) {
  if (principal?.userId == null) return [];
  const seller = (await db.select({ id: s.sellers.id }).from(s.sellers)
    .where(eq(s.sellers.userId, principal.userId)).limit(1))[0];
  if (!seller) return [];
  return db.select().from(s.sellerStatements)
    .where(eq(s.sellerStatements.sellerId, seller.id))
    .orderBy(desc(s.sellerStatements.periodStart))
    .limit(Math.min(limit, 120));
}

/**
 * A seller's own account: the arithmetic the brief asks them to be able to
 * follow — order → revenue → commission → deductions → net → payout.
 */
export async function myAccount(db: DB, principal: Principal) {
  if (principal?.userId == null) return null;
  const seller = (await db.select().from(s.sellers)
    .where(eq(s.sellers.userId, principal.userId)).limit(1))[0];
  if (!seller) return null;

  const settlements = await db.select().from(s.sellerSettlements)
    .where(eq(s.sellerSettlements.sellerId, seller.id))
    .orderBy(desc(s.sellerSettlements.periodStart)).limit(12);

  const open = settlements.find((x: any) => x.status === 'open') ?? null;
  const lines = open
    ? await db.select().from(s.settlementLines)
        .where(eq(s.settlementLines.settlementId, open.id))
        .orderBy(desc(s.settlementLines.occurredOn)).limit(200)
    : [];

  const payouts = await db.select().from(s.sellerPayouts)
    .where(eq(s.sellerPayouts.sellerId, seller.id))
    .orderBy(desc(s.sellerPayouts.createdAt)).limit(12);

  const held = await db.select({ n: sql<number>`count(*)::int` })
    .from(s.commissionGaps)
    .where(and(eq(s.commissionGaps.sellerId, seller.id), isNull(s.commissionGaps.resolvedAt)));

  return {
    sellerId: seller.id,
    settlements,
    open,
    openLines: lines,
    payouts,
    /** Sales the federation has not yet told the system how to charge for. */
    heldForCommission: held[0]?.n ?? 0,
    heldNote: (held[0]?.n ?? 0) > 0 ? COMMISSION_NOT_CONFIGURED : null,
  };
}
