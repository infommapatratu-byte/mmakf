// The versioned tax engine.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS MODULE DOES NOT KNOW, AND WILL NOT GUESS
// ─────────────────────────────────────────────────────────────────────────────
//
// Whether an MMAKF federation membership attracts GST. Whether a grading fee
// does. Whether an institutional training contract does, at what rate, under
// which SAC, and whether it splits CGST/SGST or falls to IGST because the
// school is in another state.
//
// Every one of those is a legal and accounting determination that MMAKF must
// make and record. None of them is a thing software may assume on the
// federation's behalf, and a plausible 18% seeded into the schema would be
// indistinguishable six months from now from a rate an accountant had actually
// signed off on. So the tables ship EMPTY, and computeTax() says so in as many
// words.
//
// ─────────────────────────────────────────────────────────────────────────────
// THREE STATES THAT LOOK THE SAME AND ARE NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the distinction the whole module is built around, because collapsing
// it is how a federation ends up under-collecting for two years without
// noticing:
//
//   NO RULE CONFIGURED   Nobody has decided. Nothing is added, and every
//                        surface must SAY that nothing is configured. This is
//                        where MMAKF stands today. `configured: false`.
//
//   EXEMPT / ZERO-RATED  Somebody decided, and the answer is nothing. A
//                        positive determination with an authority reference
//                        behind it. `configured: true`, `taxMinor: 0`.
//
//   STANDARD-RATED       Somebody decided, and there is a rate.
//
// The first two produce the same number and mean opposite things. A bare `0` on
// a screen cannot tell them apart, so this module never returns a bare 0: it
// returns `configured`, and it returns a `notice` that reads as a sentence.
//
// ─────────────────────────────────────────────────────────────────────────────
// VERSIONED, LIKE FEES, FOR THE SAME REASON
// ─────────────────────────────────────────────────────────────────────────────
//
// Tax is computed SERVER-SIDE — never from a figure a client sent — and a
// published rate version is IMMUTABLE. Changing a rate means publishing version
// n+1 with its own effective window; version n stays exactly as it was, because
// an invoice issued under it must keep computing to the amount it was issued
// at. `computeTax()` takes an `asAt` date and resolves the version that was in
// force THEN, and `taxSnapshot()` produces the frozen working that gets written
// onto the invoice so that even the lookup is unnecessary afterwards.

import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { applyFactor, matchConditions, type FeeInputs } from '@/db/fees';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCan } from '@/lib/rbac';

type DB = any;

export class TaxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TaxError';
    this.code = code;
  }
}

/** Identified by shape, not by `instanceof` — see src/lib/calendar.ts for why. */
export function isTaxError(err: unknown): err is TaxError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'TaxError';
}

/**
 * The empty state, in one sentence, defined once.
 *
 * Every surface that shows a total shows this when nothing is configured. It is
 * deliberately not "Tax: ₹0.00" and not "Tax not applicable": the first implies
 * a determination of nil, the second implies a determination of exemption, and
 * MMAKF has made neither.
 */
export const NO_TAX_RULE_NOTICE =
  'No tax rule is configured for this supply, so no tax has been added. ' +
  'Whether it is taxable, and at what rate, is a determination MMAKF has not recorded.';

/** The treatments that produce an amount. The rest are positive nils. */
const RATED_TREATMENTS = new Set(['standard', 'reverse_charge']);

// ─── Reading and computing ──────────────────────────────────────────────────

export interface TaxLine {
  ruleId: number;
  ruleCode: string;
  label: string;
  jurisdictionCode: string;
  treatment: string;
  taxCode: string | null;
  rateVersionId: number | null;
  rateVersion: number | null;
  ratePpm: number | null;
  authorityRef: string | null;
  taxableMinor: number;
  amountMinor: number;
  components: unknown;
  /** Which condition matched, in words, for the "why this amount?" screen. */
  because: string | null;
}

export interface TaxComputation {
  /**
   * TRUE when at least one rule matched — including one that determined the
   * supply exempt. FALSE means nobody has decided anything, which is a
   * different fact and must be rendered as one.
   */
  configured: boolean;
  jurisdictionCode: string | null;
  asAt: string;
  currency: string;
  taxableMinor: number;
  taxMinor: number;
  totalMinor: number;
  lines: TaxLine[];
  /** Rules considered and rejected, with the reason. Mirrors computeFee(). */
  skipped: Array<{ ruleCode: string; because: string }>;
  /** The sentence a surface prints. Null once tax is genuinely configured. */
  notice: string | null;
}

export interface TaxRequest {
  baseMinor: number;
  currency?: string;
  asAt: string;
  jurisdictionCode?: string | null;
  serviceCode?: string | null;
  audience?: string | null;
  inputs?: FeeInputs;
}

/**
 * The rate version in force for a rule on a date.
 *
 * Accepts `superseded` as well as `published`, because a superseded version was
 * correct for its own window and reconstructing a 2026 invoice in 2028 must
 * find it. `draft` is excluded — an unpublished rate has not been approved and
 * must never reach a customer — and so is `withdrawn`, which means the version
 * should never have applied at all.
 */
export async function rateInForce(db: DB, taxRuleId: number, asAt: string) {
  const [row] = await db.select().from(s.taxRateVersions)
    .where(and(
      eq(s.taxRateVersions.taxRuleId, taxRuleId),
      or(
        eq(s.taxRateVersions.status, 'published'),
        eq(s.taxRateVersions.status, 'superseded')
      ),
      sql`${s.taxRateVersions.effectiveFrom} <= ${asAt}`,
      or(isNull(s.taxRateVersions.effectiveTo), sql`${s.taxRateVersions.effectiveTo} >= ${asAt}`)
    ))
    .orderBy(desc(s.taxRateVersions.effectiveFrom), desc(s.taxRateVersions.version))
    .limit(1);
  return row ?? null;
}

/**
 * Compute tax on a base amount, SERVER-SIDE, WITHOUT writing anything.
 *
 * Pure with respect to the database, like computeFee(): it reads the rules and
 * returns the arithmetic, and the caller decides whether to freeze it onto a
 * document. The amount never comes from a client — a request supplies the
 * circumstances (what, for whom, where, when) and the server resolves the rate.
 *
 * Each matched rule is applied to the SAME taxable base rather than to the
 * running total. Compounding one tax onto another is a jurisdiction-specific
 * behaviour nobody has told this system MMAKF is subject to, and inventing it
 * would be inventing tax law.
 */
export async function computeTax(db: DB, req: TaxRequest): Promise<TaxComputation> {
  if (!Number.isInteger(req.baseMinor)) {
    throw new TaxError('bad_amount', 'The taxable base is integer minor units.');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.asAt)) {
    throw new TaxError('bad_date', 'asAt is a YYYY-MM-DD date. Tax is resolved as at a date, never "now".');
  }

  const currency = req.currency ?? 'INR';
  const jurisdictionCode = req.jurisdictionCode ? String(req.jurisdictionCode) : null;

  // Jurisdiction filter as a SQL predicate rather than a post-filter, so a
  // federation with a rule per state does not read every rule to price one.
  let jurisdictionId: number | null = null;
  if (jurisdictionCode) {
    const [j] = await db.select({ id: s.taxJurisdictions.id }).from(s.taxJurisdictions)
      .where(eq(s.taxJurisdictions.code, jurisdictionCode)).limit(1);
    if (!j) {
      // An unknown jurisdiction is NOT "no tax". It is a question this system
      // cannot answer, and saying "nothing configured" would quietly bill the
      // customer as though somebody had checked.
      throw new TaxError(
        'unknown_jurisdiction',
        `No tax jurisdiction is recorded with the code ${jurisdictionCode}.`
      );
    }
    jurisdictionId = j.id;
  }

  const rules = await db.select().from(s.taxRules)
    .where(jurisdictionId == null ? sql`true` : eq(s.taxRules.jurisdictionId, jurisdictionId))
    .orderBy(asc(s.taxRules.sortOrder), asc(s.taxRules.id));

  const lines: TaxLine[] = [];
  const skipped: TaxComputation['skipped'] = [];
  let taxMinor = 0;

  for (const rule of rules) {
    if (rule.audience != null && req.audience !== rule.audience) {
      skipped.push({ ruleCode: rule.code, because: `audience is ${String(req.audience)}, not ${rule.audience}` });
      continue;
    }
    if (rule.serviceId != null) {
      const [svc] = await db.select({ code: s.services.code }).from(s.services)
        .where(eq(s.services.id, rule.serviceId)).limit(1);
      if (svc && svc.code !== req.serviceCode) {
        skipped.push({ ruleCode: rule.code, because: `service is ${String(req.serviceCode)}, not ${svc.code}` });
        continue;
      }
    }

    const cond = matchConditions(rule.conditions, req.inputs ?? {});
    if (!cond.matched) {
      skipped.push({ ruleCode: rule.code, because: cond.failedOn || 'a condition did not match' });
      continue;
    }

    const version = await rateInForce(db, rule.id, req.asAt);

    // A matched rule whose rate is unpublished is NOT taxed at zero. Zero would
    // be a determination; this is an unfinished one, and it belongs in `skipped`
    // where an administrator will see it rather than in the total where they
    // will not.
    if (RATED_TREATMENTS.has(rule.treatment) && (!version || version.ratePpm == null)) {
      skipped.push({
        ruleCode: rule.code,
        because: version
          ? `rate version ${version.version} carries no rate`
          : `no published rate version is in force on ${req.asAt}`,
      });
      continue;
    }

    const [jur] = await db.select({ code: s.taxJurisdictions.code }).from(s.taxJurisdictions)
      .where(eq(s.taxJurisdictions.id, rule.jurisdictionId)).limit(1);

    // applyFactor() is the ONLY place a factor touches money in this codebase:
    // BigInt multiply, half up, integer minor units in and out. The rate is a
    // PROPORTION of the taxable base, so applying it directly yields the tax
    // itself — 180000 ppm of ₹50,000 is ₹9,000 — rather than a gross-up that
    // then has to be subtracted back.
    const ratePpm = version?.ratePpm ?? null;
    const amountMinor = RATED_TREATMENTS.has(rule.treatment) && ratePpm != null
      ? applyFactor(req.baseMinor, ratePpm)
      : 0;

    taxMinor += amountMinor;
    lines.push({
      ruleId: rule.id,
      ruleCode: rule.code,
      label: rule.label,
      jurisdictionCode: jur?.code ?? '',
      treatment: rule.treatment,
      taxCode: rule.taxCode ?? null,
      rateVersionId: version?.id ?? null,
      rateVersion: version?.version ?? null,
      ratePpm,
      authorityRef: version?.authorityRef ?? null,
      taxableMinor: req.baseMinor,
      amountMinor,
      components: version?.components ?? [],
      because: cond.because || null,
    });
  }

  const configured = lines.length > 0;
  return {
    configured,
    jurisdictionCode,
    asAt: req.asAt,
    currency,
    taxableMinor: req.baseMinor,
    taxMinor,
    totalMinor: req.baseMinor + taxMinor,
    lines,
    skipped,
    notice: configured ? null : NO_TAX_RULE_NOTICE,
  };
}

/**
 * The frozen working, for writing onto an invoice or a quote version.
 *
 * Plain JSON with no database references that need resolving. An auditor in
 * 2029 reading a 2026 invoice gets the rule codes, the version numbers, the
 * rates and the authority references as text, and needs none of the tables to
 * still say what they said.
 */
export function taxSnapshot(c: TaxComputation): Record<string, unknown> {
  return {
    configured: c.configured,
    asAt: c.asAt,
    currency: c.currency,
    jurisdictionCode: c.jurisdictionCode,
    taxableMinor: c.taxableMinor,
    taxMinor: c.taxMinor,
    totalMinor: c.totalMinor,
    notice: c.notice,
    lines: c.lines.map((l) => ({
      ruleCode: l.ruleCode,
      label: l.label,
      jurisdictionCode: l.jurisdictionCode,
      treatment: l.treatment,
      taxCode: l.taxCode,
      rateVersion: l.rateVersion,
      ratePpm: l.ratePpm,
      authorityRef: l.authorityRef,
      taxableMinor: l.taxableMinor,
      amountMinor: l.amountMinor,
      components: l.components,
      because: l.because,
    })),
  };
}

/**
 * Freeze a tax computation onto an issued invoice.
 *
 * Refuses to overwrite, for the same reason stampInvoice() in
 * src/db/currency.ts refuses: the document has already told a customer what
 * they owe.
 */
export async function stampInvoiceTax(db: DB, invoiceId: number, c: TaxComputation) {
  const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId)).limit(1);
  if (!invoice) throw new TaxError('unknown_invoice', 'No such invoice.');
  if (invoice.taxSnapshot != null) {
    throw new TaxError(
      'already_frozen',
      `Invoice ${invoice.invoiceNo} already carries its tax working and keeps it. ` +
      'A tax correction is a credit note and a new invoice, not an edit.'
    );
  }
  await db.update(s.invoices).set({ taxSnapshot: taxSnapshot(c) })
    .where(eq(s.invoices.id, invoiceId));
  return (await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId)).limit(1))[0];
}

/**
 * What an administrator sees on the tax screen.
 *
 * Reports the true current state — no rule configured, therefore nothing added
 * — instead of an empty table that reads as a configuration problem.
 */
export async function taxStatus(db: DB) {
  const [{ rules }] = await db.select({ rules: sql<number>`count(*)::int` }).from(s.taxRules);
  const [{ published }] = await db.select({ published: sql<number>`count(*)::int` })
    .from(s.taxRateVersions).where(eq(s.taxRateVersions.status, 'published'));
  const n = Number(rules);
  return {
    configured: n > 0,
    ruleCount: n,
    publishedRateVersions: Number(published),
    notice: n > 0 ? null : NO_TAX_RULE_NOTICE,
  };
}

// ─── Authoring ──────────────────────────────────────────────────────────────
//
// The authority split matches the fee framework's, deliberately: the person who
// drafts a rate and the person who freezes it can be different people, and
// neither of them is the person who issues quotations. Publishing is
// irreversible, so it is its own action.

export async function createJurisdiction(
  db: DB, ctx: AuditContext,
  input: { code: string; name: string; countryCode: string; regionCode?: string | null; parentId?: number | null; notes?: string | null }
) {
  assertCan(ctx.principal, 'feeframework:write', {});
  const [row] = await db.insert(s.taxJurisdictions).values({
    code: input.code,
    name: input.name,
    countryCode: input.countryCode,
    regionCode: input.regionCode ?? null,
    parentId: input.parentId ?? null,
    notes: input.notes ?? null,
  }).returning();
  await writeAudit(db, ctx, {
    entityType: 'tax_jurisdiction', entityId: row.id, action: 'create',
    newValue: { code: input.code },
  });
  return row;
}

export async function listJurisdictions(db: DB) {
  return db.select().from(s.taxJurisdictions).orderBy(asc(s.taxJurisdictions.code));
}

/**
 * Classify a supply. Carries no rate — see the file header for why the two are
 * separate records.
 */
export async function createTaxRule(
  db: DB, ctx: AuditContext,
  input: {
    code: string; label: string; jurisdictionId: number;
    treatment: 'standard' | 'zero_rated' | 'exempt' | 'out_of_scope' | 'reverse_charge';
    serviceId?: number | null; audience?: string | null;
    conditions?: Record<string, unknown>;
    taxCode?: string | null; sortOrder?: number; notes?: string | null;
  }
) {
  assertCan(ctx.principal, 'feeframework:write', {});
  const [jur] = await db.select({ id: s.taxJurisdictions.id }).from(s.taxJurisdictions)
    .where(eq(s.taxJurisdictions.id, input.jurisdictionId)).limit(1);
  if (!jur) throw new TaxError('unknown_jurisdiction', 'No such tax jurisdiction.');

  const [row] = await db.insert(s.taxRules).values({
    code: input.code,
    label: input.label,
    jurisdictionId: input.jurisdictionId,
    treatment: input.treatment as any,
    serviceId: input.serviceId ?? null,
    audience: (input.audience ?? null) as any,
    conditions: input.conditions ?? {},
    taxCode: input.taxCode ?? null,
    sortOrder: input.sortOrder ?? 100,
    notes: input.notes ?? null,
  }).returning();
  await writeAudit(db, ctx, {
    entityType: 'tax_rule', entityId: row.id, action: 'create',
    newValue: { code: input.code, treatment: input.treatment },
  });
  return row;
}

/**
 * Draft a rate version. Always a NEW version — never an edit of an existing one.
 *
 * There is deliberately no updateRateVersion() in this module. A rate that has
 * been published and used is part of an issued invoice's arithmetic, and the
 * only safe way to change a rate is to publish the next version with its own
 * effective window.
 */
export async function addRateVersion(
  db: DB, ctx: AuditContext, taxRuleId: number,
  input: {
    ratePpm?: number | null;
    effectiveFrom: string; effectiveTo?: string | null;
    components?: unknown[]; authorityRef?: string | null; notes?: string | null;
  }
) {
  assertCan(ctx.principal, 'feeframework:write', {});
  const [rule] = await db.select().from(s.taxRules).where(eq(s.taxRules.id, taxRuleId)).limit(1);
  if (!rule) throw new TaxError('unknown_rule', 'No such tax rule.');

  if (input.ratePpm != null && (!Number.isInteger(input.ratePpm) || input.ratePpm < 0)) {
    throw new TaxError(
      'bad_rate',
      'A tax rate is a non-negative integer in parts-per-million of the taxable base. 18% is 180000.'
    );
  }
  // A standard-rated supply with no rate cannot be published, and drafting it
  // that way is a mistake worth catching at the point it is made.
  if (RATED_TREATMENTS.has(rule.treatment) && input.ratePpm == null) {
    throw new TaxError(
      'rate_required',
      `Rule ${rule.code} is ${rule.treatment}, so a version of it must carry a rate. ` +
      'If the determination is that nothing is charged, the rule\'s treatment is exempt or zero_rated, not a rate of zero.'
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom)) {
    throw new TaxError('bad_date', 'effectiveFrom is a YYYY-MM-DD date.');
  }

  const [{ top }] = await db.select({
    top: sql<number>`COALESCE(MAX(${s.taxRateVersions.version}), 0)`,
  }).from(s.taxRateVersions).where(eq(s.taxRateVersions.taxRuleId, taxRuleId));

  const [row] = await db.insert(s.taxRateVersions).values({
    taxRuleId,
    version: Number(top) + 1,
    status: 'draft',
    ratePpm: input.ratePpm ?? null,
    components: (input.components ?? []) as any,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    authorityRef: input.authorityRef ?? null,
    notes: input.notes ?? null,
  }).returning();
  return row;
}

/**
 * Publish a rate version. After this it is FROZEN.
 *
 * A separate action from drafting one, exactly as publishFramework() is: after
 * publication the version starts appearing on invoices, and a change means the
 * next version. Publishing also supersedes whatever was published before for
 * the same rule — `superseded`, not `withdrawn`, because the old version was
 * correct for its window and reconstructing an old invoice must still find it.
 */
export async function publishRateVersion(db: DB, ctx: AuditContext, rateVersionId: number) {
  assertCan(ctx.principal, 'feeframework:publish', {});
  const [version] = await db.select().from(s.taxRateVersions)
    .where(eq(s.taxRateVersions.id, rateVersionId)).limit(1);
  if (!version) throw new TaxError('unknown_rate_version', 'No such tax rate version.');
  if (version.status !== 'draft') {
    throw new TaxError(
      'already_published',
      `This rate version is ${version.status} and cannot be published again. ` +
      'Every invoice issued under it must keep computing to the amount it was issued at, so a change is a NEW version.'
    );
  }

  const [rule] = await db.select().from(s.taxRules)
    .where(eq(s.taxRules.id, version.taxRuleId)).limit(1);
  if (RATED_TREATMENTS.has(rule.treatment) && version.ratePpm == null) {
    throw new TaxError('rate_required', `Rule ${rule.code} is ${rule.treatment} and this version carries no rate.`);
  }

  const previous = await db.select().from(s.taxRateVersions)
    .where(and(
      eq(s.taxRateVersions.taxRuleId, version.taxRuleId),
      eq(s.taxRateVersions.status, 'published')
    ));

  await db.update(s.taxRateVersions).set({
    status: 'published',
    publishedAt: new Date(),
    publishedByUserId: ctx.principal.userId ?? null,
  }).where(eq(s.taxRateVersions.id, rateVersionId));

  for (const p of previous) {
    await db.update(s.taxRateVersions)
      .set({ status: 'superseded', supersededById: rateVersionId })
      .where(eq(s.taxRateVersions.id, p.id));
  }

  await writeAudit(db, ctx, {
    entityType: 'tax_rate_version', entityId: rateVersionId, action: 'approve',
    oldValue: { status: 'draft' },
    newValue: { status: 'published', ratePpm: version.ratePpm, supersededCount: previous.length },
  });
  return { id: rateVersionId, status: 'published', superseded: previous.map((p: any) => p.id) };
}

/**
 * Withdraw a version that should never have applied.
 *
 * Distinct from superseding. A withdrawn version is excluded from historical
 * lookups too, which is right when a rate was published in error and wrong for
 * one that simply expired — which is why the two are different words here.
 */
export async function withdrawRateVersion(db: DB, ctx: AuditContext, rateVersionId: number, reason: string) {
  assertCan(ctx.principal, 'feeframework:publish', {});
  if (!reason || !reason.trim()) {
    throw new TaxError('reason_required', 'Withdrawing a published rate needs a reason on the record.');
  }
  const [version] = await db.select().from(s.taxRateVersions)
    .where(eq(s.taxRateVersions.id, rateVersionId)).limit(1);
  if (!version) throw new TaxError('unknown_rate_version', 'No such tax rate version.');

  await db.update(s.taxRateVersions).set({ status: 'withdrawn', notes: reason })
    .where(eq(s.taxRateVersions.id, rateVersionId));
  await writeAudit(db, ctx, {
    entityType: 'tax_rate_version', entityId: rateVersionId, action: 'revoke',
    oldValue: { status: version.status }, newValue: { status: 'withdrawn', reason },
  });
  return { id: rateVersionId, status: 'withdrawn' };
}
