// The unified MMAKF fee engine.
//
// WHAT IT REPLACES. Nine numbers typed into a content file — ₹800, ₹900, ₹900,
// ₹999, ₹1,000, ₹1,100, ₹1,200, ₹1,500, ₹1,800 — presented on the public site
// as independent monthly subscriptions. They could not answer what a school
// pays to run karate for 400 children across two campuses for a year, because
// nothing in the system knew that such a question existed.
//
// A national federation has ONE fee framework. What somebody pays depends on
// their circumstances and what they asked for. This module is where that is
// decided, and it is the ONLY place: no price is computed in a component, a
// route handler or a template anywhere in this codebase.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR PROPERTIES THAT MATTER, AND WHY EACH IS LOAD-BEARING
// ─────────────────────────────────────────────────────────────────────────────
//
// REPRODUCIBLE. The same inputs against the same framework version produce the
// same figure, today and in four years. That is why a quote version stores its
// inputs rather than pointing at a request somebody may edit afterwards, and
// why a published framework can never be altered. A federation that cannot
// reproduce a quotation it sent a school cannot defend it either.
//
// EXPLAINABLE. Every line records the rule that produced it, the quantity, the
// unit amount, the factor, the running total after it, and a sentence saying
// which condition matched. "Why is this ₹4,80,000?" is answered from the
// record, without re-running anything. A total nobody can explain is a total
// nobody can stand behind.
//
// HONEST WHEN IT CANNOT ANSWER. If no rule prices the request, the result
// carries NO NUMBER and says a quote is required. It never falls back to a
// plausible figure and it never returns zero — zero reads as "free", which is
// the most expensive misunderstanding available here.
//
// INTEGER THROUGHOUT. Paise, as integers, as everywhere else in this codebase.
// Multipliers are parts-per-million (1_000_000 = ×1.0) and the multiplication
// runs in BigInt before rounding, because a large institutional contract in
// paise times a factor overflows the exactly-representable range of a double
// long before anybody notices the last rupee is wrong.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND THE ONE THING THIS MODULE WILL NOT DO
// ─────────────────────────────────────────────────────────────────────────────
//
// It contains no prices. Not one rupee figure appears in this file, in the
// schema, or in the migration. MMAKF has not published a fee framework, so the
// engine ships EMPTY and every surface reports "the federation has not
// published a fee for this" — which is true — until the federation supplies
// its rules. Seeding a "reasonable" starting framework would be inventing the
// federation's own commercial policy, which is the one thing this project
// forbids above all others.

import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { allocateFederationId, writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, canAnywhere, type Principal } from '@/lib/rbac';

type DB = any;

export class FeeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'FeeError';
    this.code = code;
  }
}

/** Identified by shape, not by `instanceof` — see src/lib/calendar.ts for why. */
export function isFeeError(err: unknown): err is FeeError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'FeeError';
}

// ─── Money ──────────────────────────────────────────────────────────────────

export const PPM = 1_000_000;

/**
 * Multiply an amount in paise by a parts-per-million factor, rounding half up.
 *
 * BigInt for the multiply, deliberately. ₹10 crore is 10^9 paise; times a
 * 1.25 factor expressed as 1_250_000 that is 1.25 × 10^15, which is inside
 * Number.MAX_SAFE_INTEGER by a factor of nine — but only just, and the next
 * multiplier in the chain would not be. Doing it exactly costs nothing and
 * removes an entire class of "the total is off by a rupee" bug that only
 * appears on the largest contracts, which are the ones under most scrutiny.
 *
 * HALF UP, not banker's rounding. Banker's rounding is better statistics and
 * worse invoicing: two identical line items must produce two identical amounts,
 * and half-even makes that depend on whether the digit before is odd.
 */
export function applyFactor(amountMinor: number, factorPpm: number): number {
  if (!Number.isInteger(amountMinor)) throw new FeeError('bad_amount', 'Amounts must be integer paise.');
  if (!Number.isInteger(factorPpm)) throw new FeeError('bad_factor', 'Factors must be integer parts-per-million.');
  const negative = amountMinor < 0;
  const a = BigInt(Math.abs(amountMinor));
  const f = BigInt(factorPpm);
  const half = BigInt(PPM) / 2n;
  const scaled = (a * f + half) / BigInt(PPM);
  const out = Number(scaled);
  return negative ? -out : out;
}

/** Indian digit grouping. ₹12,34,567.89 — not ₹1,234,567.89. */
export function formatINR(minor: number): string {
  const negative = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const rupees = Math.floor(abs / 100);
  const paise = String(abs % 100).padStart(2, '0');
  const str = String(rupees);
  // The last three digits, then pairs — the lakh/crore grouping.
  const head = str.slice(0, -3);
  const tail = str.slice(-3);
  const grouped = head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail : tail;
  return `${negative ? '-' : ''}₹${grouped}.${paise}`;
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

/**
 * What the person or institution told us.
 *
 * Open-ended on purpose. The federation's criteria genuinely include location,
 * participant category, age band, frequency, duration, delivery mode,
 * institution type, campus count, instructor requirement, travel, equipment,
 * assessment, certification and contract length — in combinations nobody can
 * enumerate ahead of time. Fixing them as columns would produce a table of
 * mostly-meaningless nulls and a form that cannot grow.
 *
 * The KNOWN keys below are the ones rules may match on numerically; anything
 * else is matched by equality or set membership.
 */
export interface FeeInputs {
  audience?: string;
  serviceCode?: string;
  mode?: string;
  participants?: number;
  sessions?: number;
  batches?: number;
  campuses?: number;
  instructors?: number;
  weeks?: number;
  travelKm?: number;
  stateCode?: string;
  districtCode?: string;
  [key: string]: unknown;
}

/** The quantity a per-unit rule multiplies by. */
const QUANTITY_KEY: Record<string, keyof FeeInputs> = {
  per_participant: 'participants',
  per_session: 'sessions',
  per_batch: 'batches',
  per_campus: 'campuses',
  per_instructor: 'instructors',
  per_km: 'travelKm',
};

// ─── Condition matching ─────────────────────────────────────────────────────

export interface ConditionMatch {
  matched: boolean;
  /** Human-readable, for the "why this amount?" screen. Empty when unconditional. */
  because: string;
  /** The first condition that failed, when it did. */
  failedOn?: string;
}

/**
 * Does a rule's `conditions` object match these inputs?
 *
 * Supported forms, chosen because they cover what the federation actually
 * discriminates on without becoming a query language nobody can audit:
 *
 *   { "audience": "school" }             equality
 *   { "audience": ["school","college"] } one of
 *   { "participants": { "min": 50 } }    numeric range, inclusive
 *   { "participants": { "max": 200 } }
 *   { "mode": { "not": "online" } }      negation
 *
 * AN UNRECOGNISED CONDITION FORM DOES NOT MATCH. Treating something the engine
 * cannot understand as satisfied is the fail-open reading, and it would let a
 * typo in a rule silently widen that rule to every request in the country.
 */
export function matchConditions(conditions: unknown, inputs: FeeInputs): ConditionMatch {
  if (conditions == null) return { matched: true, because: '' };
  if (typeof conditions !== 'object' || Array.isArray(conditions)) {
    return { matched: false, because: '', failedOn: 'conditions must be an object' };
  }
  const entries = Object.entries(conditions as Record<string, unknown>);
  if (!entries.length) return { matched: true, because: '' };

  const reasons: string[] = [];
  for (const [key, want] of entries) {
    const got = inputs[key];

    if (Array.isArray(want)) {
      if (!want.some((w) => w === got)) {
        return { matched: false, because: '', failedOn: `${key} is not one of ${want.join(', ')}` };
      }
      reasons.push(`${key} is ${String(got)}`);
      continue;
    }

    if (want !== null && typeof want === 'object') {
      const spec = want as Record<string, unknown>;
      const keys = Object.keys(spec);
      const known = keys.every((k) => ['min', 'max', 'not'].includes(k));
      if (!known || !keys.length) {
        return { matched: false, because: '', failedOn: `${key} uses a condition form this engine does not understand` };
      }
      if ('not' in spec) {
        if (spec.not === got) return { matched: false, because: '', failedOn: `${key} is ${String(got)}` };
        reasons.push(`${key} is not ${String(spec.not)}`);
      }
      if ('min' in spec || 'max' in spec) {
        const n = typeof got === 'number' ? got : Number(got);
        if (!Number.isFinite(n)) {
          return { matched: false, because: '', failedOn: `${key} was not supplied as a number` };
        }
        if ('min' in spec && n < Number(spec.min)) {
          return { matched: false, because: '', failedOn: `${key} ${n} is below ${String(spec.min)}` };
        }
        if ('max' in spec && n > Number(spec.max)) {
          return { matched: false, because: '', failedOn: `${key} ${n} is above ${String(spec.max)}` };
        }
        const lo = 'min' in spec ? String(spec.min) : '';
        const hi = 'max' in spec ? String(spec.max) : '';
        reasons.push(`${key} ${n} is within ${lo || '−'}–${hi || '+'}`);
      }
      continue;
    }

    if (want !== got) {
      return { matched: false, because: '', failedOn: `${key} is ${String(got)}, not ${String(want)}` };
    }
    reasons.push(`${key} is ${String(got)}`);
  }

  return { matched: true, because: reasons.join('; ') };
}

// ─── Computation ────────────────────────────────────────────────────────────

export interface ComputedLine {
  ruleId: number | null;
  ruleCode: string | null;
  kind: string;
  label: string;
  quantity: number | null;
  unitAmountMinor: number | null;
  factorPpm: number | null;
  amountMinor: number;
  runningTotalMinor: number;
  because: string | null;
  requiresApproval: boolean;
}

export interface Computation {
  frameworkId: number;
  frameworkCode: string;
  currency: string;
  inputs: FeeInputs;
  lines: ComputedLine[];
  subtotalMinor: number;
  adjustmentMinor: number;
  taxMinor: number;
  totalMinor: number;
  /** True when nothing priced it. The caller must then show no figure at all. */
  requiresManualQuote: boolean;
  manualReason: string | null;
  /** Rules considered and rejected, with the condition that rejected them. */
  skipped: Array<{ ruleCode: string; because: string }>;
  needsApproval: boolean;
}

/**
 * Price a request against a framework, WITHOUT writing anything.
 *
 * Pure with respect to the database: it reads the framework's rules and
 * returns the arithmetic. `issueQuote()` is what persists it. Splitting them
 * means the public estimator can show somebody a figure without creating a
 * quotation record for every idle click, and it means the calculation can be
 * tested exhaustively without a write path.
 */
export async function computeFee(
  db: DB,
  frameworkId: number,
  inputs: FeeInputs
): Promise<Computation> {
  const [framework] = await db.select().from(s.feeFrameworks)
    .where(eq(s.feeFrameworks.id, frameworkId)).limit(1);
  if (!framework) throw new FeeError('unknown_framework', 'No such fee framework.');
  if (framework.status !== 'published') {
    throw new FeeError(
      'framework_not_published',
      `Fee framework ${framework.code} is ${framework.status}. Only a PUBLISHED framework may price a request — ` +
      'quoting from a draft would produce a figure the federation has not approved.'
    );
  }

  const rules = await db.select().from(s.feeRules)
    .where(eq(s.feeRules.frameworkId, frameworkId))
    .orderBy(asc(s.feeRules.sortOrder), asc(s.feeRules.id));

  const lines: ComputedLine[] = [];
  const skipped: Computation['skipped'] = [];
  let running = 0;
  let adjustment = 0;
  let tax = 0;
  let needsApproval = false;

  for (const rule of rules) {
    // Service and audience are matched before the JSON conditions because they
    // are the two the federation always discriminates on, and a null means
    // "applies to all" rather than "applies to none".
    if (rule.serviceId != null && inputs.serviceId !== rule.serviceId && inputs.serviceCode !== undefined) {
      const [svc] = await db.select({ code: s.services.code }).from(s.services)
        .where(eq(s.services.id, rule.serviceId)).limit(1);
      if (svc && svc.code !== inputs.serviceCode) {
        skipped.push({ ruleCode: rule.code, because: `service is ${inputs.serviceCode}, not ${svc.code}` });
        continue;
      }
    }
    if (rule.audience != null && inputs.audience !== rule.audience) {
      skipped.push({ ruleCode: rule.code, because: `audience is ${String(inputs.audience)}, not ${rule.audience}` });
      continue;
    }

    const cond = matchConditions(rule.conditions, inputs);
    if (!cond.matched) {
      skipped.push({ ruleCode: rule.code, because: cond.failedOn || 'a condition did not match' });
      continue;
    }

    let quantity: number | null = null;
    let amount = 0;

    if (rule.kind === 'multiplier') {
      if (rule.factorPpm == null) {
        throw new FeeError('rule_incomplete', `Rule ${rule.code} is a multiplier with no factor.`);
      }
      const after = applyFactor(running, rule.factorPpm);
      amount = after - running;
    } else if (rule.kind === 'tax') {
      if (rule.factorPpm == null) {
        throw new FeeError('rule_incomplete', `Rule ${rule.code} is a tax with no rate.`);
      }
      amount = applyFactor(running, rule.factorPpm) - running;
      tax += amount;
    } else if (rule.kind === 'base' || rule.kind === 'fixed_add' || rule.kind === 'discount') {
      if (rule.amountMinor == null) {
        throw new FeeError('rule_incomplete', `Rule ${rule.code} is a ${rule.kind} with no amount.`);
      }
      amount = rule.amountMinor;
      if (rule.kind === 'discount') adjustment += amount;
    } else {
      const key = QUANTITY_KEY[rule.kind];
      if (!key) throw new FeeError('unknown_rule_kind', `Rule ${rule.code} has kind ${rule.kind}, which this engine does not implement.`);
      const raw = inputs[key];
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n)) {
        // A per-unit rule with no quantity is NOT priced at zero — zero would
        // silently drop a real cost out of the total.
        skipped.push({ ruleCode: rule.code, because: `${String(key)} was not supplied` });
        continue;
      }
      if (rule.amountMinor == null) {
        throw new FeeError('rule_incomplete', `Rule ${rule.code} is ${rule.kind} with no unit amount.`);
      }
      // Truncated, then clamped. `quantity` is definitely a number from here
      // on, which the local below makes explicit for the type checker as well
      // as the reader.
      let qty = Math.trunc(n);
      if (rule.minQuantity != null && qty < rule.minQuantity) qty = rule.minQuantity;
      if (rule.maxQuantity != null && qty > rule.maxQuantity) qty = rule.maxQuantity;
      quantity = qty;
      amount = rule.amountMinor * quantity;
    }

    running += amount;
    if (rule.requiresApproval) needsApproval = true;

    lines.push({
      ruleId: rule.id,
      ruleCode: rule.code,
      kind: rule.kind,
      label: rule.label,
      quantity,
      unitAmountMinor: quantity != null ? rule.amountMinor : (rule.kind === 'multiplier' || rule.kind === 'tax' ? null : rule.amountMinor),
      factorPpm: rule.factorPpm ?? null,
      amountMinor: amount,
      runningTotalMinor: running,
      because: cond.because || null,
      requiresApproval: Boolean(rule.requiresApproval),
    });
  }

  const priced = lines.length > 0;
  const subtotal = running - tax;

  return {
    frameworkId: framework.id,
    frameworkCode: framework.code,
    currency: framework.currency,
    inputs,
    lines,
    subtotalMinor: priced ? subtotal - adjustment : 0,
    adjustmentMinor: priced ? adjustment : 0,
    taxMinor: priced ? tax : 0,
    totalMinor: priced ? running : 0,
    requiresManualQuote: !priced,
    manualReason: priced
      ? null
      : rules.length === 0
        ? `Fee framework ${framework.code} has no rules. The federation has not published a fee for this, so no figure can be shown.`
        : 'No published fee rule covers this combination of requirements. The federation office prepares a quotation for it.',
    skipped,
    needsApproval,
  };
}

/**
 * The framework in force on a date.
 *
 * Returns null rather than throwing when none is: "MMAKF has not published a
 * fee framework" is the CURRENT, TRUE state of this system, and it is a state
 * every surface must be able to render calmly.
 */
export async function activeFramework(db: DB, asAt: string): Promise<any | null> {
  const rows = await db.select().from(s.feeFrameworks)
    .where(
      and(
        eq(s.feeFrameworks.status, 'published'),
        or(isNull(s.feeFrameworks.effectiveFrom), sql`${s.feeFrameworks.effectiveFrom} <= ${asAt}`),
        or(isNull(s.feeFrameworks.effectiveTo), sql`${s.feeFrameworks.effectiveTo} >= ${asAt}`)
      )
    )
    .orderBy(asc(s.feeFrameworks.version));
  return rows.length ? rows[rows.length - 1] : null;
}

// ─── Authoring a framework ──────────────────────────────────────────────────

export async function createFramework(
  db: DB, ctx: AuditContext,
  input: { title: string; version: number; effectiveFrom?: string | null; notes?: string }
) {
  // WAS 'finance:write'. Gating the fee framework on a payments action meant
  // the three authorities this module actually distinguishes — read the rules,
  // change the rules, freeze the rules — were one, and that whoever could
  // record a payment could rewrite every future quotation.
  assertCan(ctx.principal, 'feeframework:write', {});
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new FeeError('bad_version', 'A framework version must be a positive whole number.');
  }
  const code = `MMAKF-FEE-V${input.version}`;
  const [row] = await db.insert(s.feeFrameworks).values({
    code, title: input.title, version: input.version, status: 'draft',
    effectiveFrom: input.effectiveFrom ?? null, notes: input.notes ?? null,
  }).returning();
  await writeAudit(db, ctx, {
    entityType: 'fee_framework', entityId: row.id, action: 'create',
    newValue: { code, version: input.version },
  });
  return row;
}

export async function addRule(
  db: DB, ctx: AuditContext, frameworkId: number,
  rule: {
    code: string; label: string; kind: string;
    serviceId?: number | null; audience?: string | null;
    conditions?: Record<string, unknown>;
    amountMinor?: number | null; factorPpm?: number | null;
    minQuantity?: number | null; maxQuantity?: number | null;
    sortOrder?: number; requiresApproval?: boolean;
  }
) {
  assertCan(ctx.principal, 'feeframework:write', {});
  const [framework] = await db.select().from(s.feeFrameworks)
    .where(eq(s.feeFrameworks.id, frameworkId)).limit(1);
  if (!framework) throw new FeeError('unknown_framework', 'No such fee framework.');

  // THE IMMUTABILITY RULE. Editing a published framework silently rewrites
  // every quotation ever issued under it — a school that accepted ₹4,80,000 in
  // March would find its own quote saying something else in June.
  if (framework.status !== 'draft') {
    throw new FeeError(
      'framework_locked',
      `Framework ${framework.code} is ${framework.status} and cannot be changed. ` +
      'Publish a NEW version instead — every quotation issued under this one must keep computing to the figure it was issued at.'
    );
  }

  if (rule.amountMinor != null && !Number.isInteger(rule.amountMinor)) {
    throw new FeeError('bad_amount', 'Amounts are integer paise. ₹450.50 is 45050, not 450.5.');
  }
  if (rule.factorPpm != null && !Number.isInteger(rule.factorPpm)) {
    throw new FeeError('bad_factor', 'Factors are integer parts-per-million. ×1.25 is 1250000.');
  }

  const [row] = await db.insert(s.feeRules).values({
    frameworkId,
    code: rule.code,
    label: rule.label,
    kind: rule.kind as any,
    serviceId: rule.serviceId ?? null,
    audience: (rule.audience ?? null) as any,
    conditions: rule.conditions ?? {},
    amountMinor: rule.amountMinor ?? null,
    factorPpm: rule.factorPpm ?? null,
    minQuantity: rule.minQuantity ?? null,
    maxQuantity: rule.maxQuantity ?? null,
    sortOrder: rule.sortOrder ?? 100,
    requiresApproval: rule.requiresApproval ?? false,
  }).returning();
  return row;
}

/** Publish a framework. After this it is frozen; a change means a new version. */
export async function publishFramework(db: DB, ctx: AuditContext, frameworkId: number) {
  // A SEPARATE ACTION FROM WRITING ONE, deliberately. Publishing is
  // irreversible — after it, a change means a new version — so the person who
  // drafts a framework and the person who freezes it can be different people.
  // Under 'finance:write' they could not be.
  assertCan(ctx.principal, 'feeframework:publish', {});
  const [framework] = await db.select().from(s.feeFrameworks)
    .where(eq(s.feeFrameworks.id, frameworkId)).limit(1);
  if (!framework) throw new FeeError('unknown_framework', 'No such fee framework.');
  if (framework.status !== 'draft') {
    throw new FeeError('already_published', `Framework ${framework.code} is already ${framework.status}.`);
  }

  const rules = await db.select({ id: s.feeRules.id }).from(s.feeRules)
    .where(eq(s.feeRules.frameworkId, frameworkId));
  if (!rules.length) {
    // An empty published framework prices nothing and would silently send every
    // request to "requires a quote" while appearing to be configured.
    throw new FeeError(
      'framework_empty',
      `Framework ${framework.code} has no rules. Publishing it would price nothing while appearing configured.`
    );
  }

  await db.update(s.feeFrameworks)
    .set({
      status: 'published',
      publishedAt: new Date(),
      publishedByUserId: ctx.principal.userId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(s.feeFrameworks.id, frameworkId));

  await writeAudit(db, ctx, {
    entityType: 'fee_framework', entityId: frameworkId, action: 'approve',
    oldValue: { status: 'draft' },
    newValue: { status: 'published', rules: rules.length },
  });
  return { id: frameworkId, status: 'published', rules: rules.length };
}

// ─── Issuing a quote ────────────────────────────────────────────────────────

export interface IssuedQuote {
  quoteId: number;
  ref: string;
  version: number;
  computation: Computation;
}

/**
 * Persist a computation as a new quote version.
 *
 * A quote is never edited. Re-quoting the same request produces version 2, and
 * version 1 keeps its own framework, its own inputs and its own lines — so the
 * figure somebody was given in March is still reconstructible in June, which is
 * the entire point of versioning it.
 */
export async function issueQuote(
  db: DB, ctx: AuditContext,
  input: {
    requestId?: number | null;
    institutionId?: number | null;
    personId?: number | null;
    frameworkId: number;
    inputs: FeeInputs;
    validUntil?: string | null;
  }
): Promise<IssuedQuote> {
  // Issuing a quotation is not editing the rules it is computed from, and it is
  // not recording a payment. TRAINING_OPERATIONS holds this and neither of the
  // other two — which is the separation that stops one person discounting
  // unobserved.
  assertCan(ctx.principal, 'quote:issue', {});
  const computation = await computeFee(db, input.frameworkId, input.inputs);

  // Re-version an existing quote for the same request rather than creating a
  // second quote, so a request has one quotation with a history.
  let quote: any = null;
  if (input.requestId != null) {
    const rows = await db.select().from(s.quotes)
      .where(eq(s.quotes.requestId, input.requestId)).limit(1);
    quote = rows[0] ?? null;
  }
  if (!quote) {
    const ref = await allocateFederationId(db, 'QUO', new Date().getUTCFullYear());
    const [created] = await db.insert(s.quotes).values({
      ref,
      requestId: input.requestId ?? null,
      institutionId: input.institutionId ?? null,
      personId: input.personId ?? null,
      createdByUserId: ctx.principal.userId ?? null,
    }).returning();
    quote = created;
  }

  const existing = await db.select({ v: s.quoteVersions.version }).from(s.quoteVersions)
    .where(eq(s.quoteVersions.quoteId, quote.id));
  const version = existing.reduce((m: number, r: any) => Math.max(m, r.v), 0) + 1;

  // Everything already issued is superseded — but keeps its rows.
  await db.update(s.quoteVersions)
    .set({ status: 'superseded' })
    .where(and(eq(s.quoteVersions.quoteId, quote.id), eq(s.quoteVersions.status, 'issued')));

  const [qv] = await db.insert(s.quoteVersions).values({
    quoteId: quote.id,
    version,
    status: computation.needsApproval ? 'awaiting_approval' : 'issued',
    frameworkId: computation.frameworkId,
    frameworkCode: computation.frameworkCode,
    inputs: computation.inputs as any,
    subtotalMinor: computation.subtotalMinor,
    adjustmentMinor: computation.adjustmentMinor,
    taxMinor: computation.taxMinor,
    totalMinor: computation.totalMinor,
    currency: computation.currency,
    requiresManualQuote: computation.requiresManualQuote,
    manualReason: computation.manualReason,
    validUntil: input.validUntil ?? null,
    issuedAt: computation.needsApproval ? null : new Date(),
  }).returning();

  if (computation.lines.length) {
    await db.insert(s.quoteLines).values(
      computation.lines.map((l, i) => ({
        quoteVersionId: qv.id,
        sortOrder: (i + 1) * 10,
        ruleId: l.ruleId,
        ruleCode: l.ruleCode,
        kind: l.kind as any,
        label: l.label,
        quantity: l.quantity,
        unitAmountMinor: l.unitAmountMinor,
        factorPpm: l.factorPpm,
        amountMinor: l.amountMinor,
        runningTotalMinor: l.runningTotalMinor,
        because: l.because,
      }))
    );
  }

  await writeAudit(db, ctx, {
    entityType: 'quote', entityId: quote.id, action: 'create',
    newValue: {
      ref: quote.ref, version, framework: computation.frameworkCode,
      total: computation.totalMinor, manual: computation.requiresManualQuote,
    },
  });

  return { quoteId: quote.id, ref: quote.ref, version, computation };
}

/**
 * Approve a quotation that a rule held back, and issue it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * issueQuote() sets `awaiting_approval` whenever any rule that fired carries
 * `requiresApproval` — a large discount, an unusual multiplier, whatever the
 * federation decides needs a second pair of eyes. Nothing could then move it.
 * A quotation entering that state stayed there for ever, and /admin/quotes had
 * to tell the reader so.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SEPARATION IS THE WHOLE POINT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `quote:issue` and `quote:approve` are different actions held by different
 * roles: TRAINING_OPERATIONS issues and cannot approve; TRAINING_DIRECTOR can
 * do both. Which means a director could issue a discounted quotation and then
 * approve their own — and the control that exists to put a second person in the
 * room would have been satisfied by one person twice.
 *
 * So holding the action is not sufficient. THE APPROVER MUST NOT BE THE ISSUER,
 * enforced here rather than hoped for in a procedure. Refusing costs a director
 * thirty seconds of asking a colleague; permitting it costs the federation the
 * only check on its own pricing.
 */
export async function approveQuoteVersion(
  db: DB,
  ctx: AuditContext,
  quoteVersionId: number,
  opts: { note?: string } = {}
) {
  assertCan(ctx.principal, 'quote:approve', {});

  const [qv] = await db.select().from(s.quoteVersions)
    .where(eq(s.quoteVersions.id, quoteVersionId)).limit(1);
  if (!qv) throw new FeeError('unknown_quote_version', 'No such quotation version.');

  if (qv.status !== 'awaiting_approval') {
    // Not a silent no-op. An operator who clicks Approve on something already
    // issued has misread the screen, and telling them what state it is actually
    // in is the only useful answer.
    throw new FeeError(
      'not_awaiting_approval',
      `This quotation is ${qv.status}, not awaiting approval, so there is nothing to approve.`
    );
  }

  const [quote] = await db.select().from(s.quotes)
    .where(eq(s.quotes.id, qv.quoteId)).limit(1);
  if (!quote) throw new FeeError('unknown_quote', 'The quotation this version belongs to is missing.');

  // ── The separation of duties, enforced ──
  //
  // Compared on userId. A principal with no userId (a script, a legacy session)
  // cannot be shown to be a different person from the issuer, so it is refused
  // too — the fail-closed reading. An approval nobody can attribute is not an
  // approval.
  const approver = ctx.principal.userId;
  if (approver == null) {
    throw new FeeError(
      'unattributable_approval',
      'An approval must be attributable to a named account, and this session has none.'
    );
  }
  if (quote.createdByUserId != null && quote.createdByUserId === approver) {
    throw new FeeError(
      'self_approval',
      'A quotation cannot be approved by the person who issued it. ' +
      'Ask someone else who holds quote:approve.'
    );
  }

  const now = new Date();

  // Anything already issued on this quote is superseded, exactly as issueQuote()
  // does — otherwise approving an older held version would leave two live
  // quotations for one request.
  await db.update(s.quoteVersions)
    .set({ status: 'superseded' })
    .where(and(
      eq(s.quoteVersions.quoteId, qv.quoteId),
      eq(s.quoteVersions.status, 'issued'),
    ));

  const [updated] = await db.update(s.quoteVersions)
    .set({
      status: 'issued',
      approvedByUserId: approver,
      approvedAt: now,
      issuedAt: now,
    })
    .where(and(
      eq(s.quoteVersions.id, quoteVersionId),
      // Re-asserted in the WHERE so two approvers racing cannot both win: the
      // second UPDATE matches no row and returns nothing.
      eq(s.quoteVersions.status, 'awaiting_approval'),
    ))
    .returning();

  if (!updated) {
    throw new FeeError(
      'already_decided',
      'This quotation was approved by somebody else a moment ago.'
    );
  }

  await writeAudit(db, { ...ctx, reason: opts.note ?? null }, {
    entityType: 'quote', entityId: qv.quoteId, action: 'approve',
    oldValue: { version: qv.version, status: 'awaiting_approval' },
    newValue: {
      ref: quote.ref,
      version: qv.version,
      status: 'issued',
      total: qv.totalMinor,
      approvedBy: approver,
      issuedBy: quote.createdByUserId ?? null,
    },
  });

  return {
    quoteId: qv.quoteId,
    ref: quote.ref,
    version: qv.version,
    totalMinor: qv.totalMinor,
    approvedAt: now,
  };
}

/**
 * Refuse a quotation that was held for approval.
 *
 * Rejecting is not deleting. The version keeps its rows, its inputs and its
 * arithmetic, and gains a reason — because "why was that discount refused?" is
 * a question somebody will ask months later, and the answer must survive.
 */
export async function rejectQuoteVersion(
  db: DB,
  ctx: AuditContext,
  quoteVersionId: number,
  reason: string
) {
  assertCan(ctx.principal, 'quote:approve', {});

  const why = String(reason ?? '').trim();
  if (why.length < 4) {
    // A rejection with no reason is indistinguishable from a mistake, and the
    // person who has to re-quote cannot act on it.
    throw new FeeError('reason_required', 'A refusal must say why.');
  }

  const [qv] = await db.select().from(s.quoteVersions)
    .where(eq(s.quoteVersions.id, quoteVersionId)).limit(1);
  if (!qv) throw new FeeError('unknown_quote_version', 'No such quotation version.');
  if (qv.status !== 'awaiting_approval') {
    throw new FeeError(
      'not_awaiting_approval',
      `This quotation is ${qv.status}, not awaiting approval.`
    );
  }

  const [updated] = await db.update(s.quoteVersions)
    .set({ status: 'rejected' })
    .where(and(
      eq(s.quoteVersions.id, quoteVersionId),
      eq(s.quoteVersions.status, 'awaiting_approval'),
    ))
    .returning();
  if (!updated) throw new FeeError('already_decided', 'This quotation was already decided.');

  await writeAudit(db, { ...ctx, reason: why }, {
    entityType: 'quote', entityId: qv.quoteId, action: 'reject',
    oldValue: { version: qv.version, status: 'awaiting_approval' },
    newValue: { version: qv.version, status: 'rejected' },
  });

  return { quoteId: qv.quoteId, version: qv.version };
}

/**
 * Quotations waiting on somebody.
 *
 * §19 asks "what needs my attention?" — this is the fee engine's answer, and it
 * deliberately EXCLUDES versions the caller issued themselves, because those
 * are precisely the ones they may not approve. A queue that lists work you are
 * forbidden to do is a queue you learn to ignore.
 */
export async function awaitingApproval(db: DB, principal: Principal) {
  if (!canAnywhere(principal, 'quote:approve')) {
    throw new FeeError('forbidden', 'Reviewing held quotations requires quote:approve.');
  }

  const rows = await db.select({
    quoteVersionId: s.quoteVersions.id,
    quoteId: s.quotes.id,
    ref: s.quotes.ref,
    version: s.quoteVersions.version,
    totalMinor: s.quoteVersions.totalMinor,
    currency: s.quoteVersions.currency,
    frameworkCode: s.quoteVersions.frameworkCode,
    requiresManualQuote: s.quoteVersions.requiresManualQuote,
    createdAt: s.quoteVersions.createdAt,
    issuedByUserId: s.quotes.createdByUserId,
    institutionId: s.quotes.institutionId,
  })
    .from(s.quoteVersions)
    .innerJoin(s.quotes, eq(s.quoteVersions.quoteId, s.quotes.id))
    .where(eq(s.quoteVersions.status, 'awaiting_approval'))
    .orderBy(s.quoteVersions.createdAt);

  return rows.map((r) => ({
    ...r,
    // Surfaced rather than filtered out, so the reader can see the whole queue
    // and understand why one row has no button. Silently omitting them would
    // make the count disagree with what finance can see.
    approvableByCaller: r.issuedByUserId == null || r.issuedByUserId !== principal.userId,
  }));
}

/**
 * Re-run a stored quote version against the framework it was issued under.
 *
 * This is what makes "reproducible" a fact rather than a claim: it reads the
 * FROZEN inputs and the recorded framework and recomputes. If the answer has
 * drifted, something edited a published framework, and that is a defect worth
 * failing loudly over.
 */
export async function reproduce(db: DB, quoteVersionId: number) {
  const [qv] = await db.select().from(s.quoteVersions)
    .where(eq(s.quoteVersions.id, quoteVersionId)).limit(1);
  if (!qv) throw new FeeError('unknown_quote_version', 'No such quote version.');

  const recomputed = await computeFee(db, qv.frameworkId, qv.inputs as FeeInputs);
  return {
    stored: {
      subtotalMinor: qv.subtotalMinor,
      adjustmentMinor: qv.adjustmentMinor,
      taxMinor: qv.taxMinor,
      totalMinor: qv.totalMinor,
      requiresManualQuote: qv.requiresManualQuote,
    },
    recomputed,
    matches:
      recomputed.totalMinor === qv.totalMinor &&
      recomputed.subtotalMinor === qv.subtotalMinor &&
      recomputed.taxMinor === qv.taxMinor &&
      recomputed.requiresManualQuote === qv.requiresManualQuote,
  };
}

/** A stored quote version with its lines, for the "why this amount?" screen. */
export async function explainQuote(db: DB, principal: Principal, quoteVersionId: number) {
  if (!canAnywhere(principal, 'quote:read')) {
    throw new FeeError('forbidden', 'Reading a quotation requires quote:read.');
  }
  const [qv] = await db.select().from(s.quoteVersions)
    .where(eq(s.quoteVersions.id, quoteVersionId)).limit(1);
  if (!qv) throw new FeeError('unknown_quote_version', 'No such quote version.');

  const lines = await db.select().from(s.quoteLines)
    .where(eq(s.quoteLines.quoteVersionId, quoteVersionId))
    .orderBy(asc(s.quoteLines.sortOrder));

  return {
    version: qv,
    lines,
    /** The arithmetic in words, reconstructed from the stored rows alone. */
    narrative: lines.map((l: any) => {
      if (l.kind === 'multiplier' || l.kind === 'tax') {
        return `${l.label}: ×${(l.factorPpm / PPM).toFixed(4)} → ${formatINR(l.runningTotalMinor)}`;
      }
      if (l.quantity != null) {
        return `${l.label}: ${l.quantity} × ${formatINR(l.unitAmountMinor ?? 0)} = ${formatINR(l.amountMinor)}`;
      }
      return `${l.label}: ${formatINR(l.amountMinor)}`;
    }),
  };
}
