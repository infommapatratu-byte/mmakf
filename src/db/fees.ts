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
import { classifyFeeRule, findStudentCharges, type RuleCandidate } from '@/db/student-rule';
import { isUniqueViolation } from '@/db/pgerror';

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

/** Basis points. 1800 bps = 18%. */
export const BPS = 10_000;

/**
 * Tax on an amount, at a rate in basis points. Integer-exact, half up.
 *
 * WHY THIS EXISTS RATHER THAN `Math.round((amount * bps) / 10_000)`.
 *
 * That expression lived inline in createOrder() and was allow-listed in
 * tests/money-safety.test.ts as "FINDING 4 — a SECOND rounding implementation,
 * outside applyFactor()". The allow-list entry carried its own justification:
 * exact over the reachable domain, and proved so by a test. Both halves of that
 * were true and neither is a reason to keep it.
 *
 * BE PRECISE ABOUT WHY IT WENT. It was NOT producing wrong money. The worst
 * order createOrder() can build is an int32 unit price times the 99-item
 * quantity cap times the highest GST rate, and that product is comfortably
 * inside safe-integer range — tests/money-safety.test.ts pins exactly that, and
 * overstating the danger here would be the same kind of untruth this codebase
 * refuses everywhere else.
 *
 * The reason is DRIFT. Two implementations of one rounding rule is one edit
 * away from an invoice that disagrees with the quotation it came from, with
 * nothing failing in between: change half-up to half-even in applyFactor() and
 * the inline expression keeps the old behaviour, silently, on the tax line
 * only. One implementation cannot drift from itself.
 *
 * BigInt because this is a general money primitive and a later caller is not
 * bound by createOrder()'s caps — past 2^53 the float product stops being an
 * exact integer and Math.round() then rounds the wrong value. Half UP and away
 * from zero, to agree with applyFactor() above: two identical line items must
 * produce two identical amounts.
 */
export function taxOnMinor(amountMinor: number, rateBps: number): number {
  if (!Number.isInteger(amountMinor)) throw new FeeError('bad_amount', 'Amounts must be integer paise.');
  if (!Number.isInteger(rateBps)) throw new FeeError('bad_rate', 'Tax rates must be integer basis points.');
  // A negative rate is a refund dressed as a tax. Refused rather than netted
  // off, because a rate is a published figure and a credit is a decision.
  if (rateBps < 0) throw new FeeError('bad_rate', 'A tax rate cannot be negative.');
  const negative = amountMinor < 0;
  const a = BigInt(Math.abs(amountMinor));
  const r = BigInt(rateBps);
  const half = BigInt(BPS) / 2n;
  const out = Number((a * r + half) / BigInt(BPS));
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

// ─── Reductions ─────────────────────────────────────────────────────────────
//
// A REDUCTION is a discount or a concession, resolved by src/db/discounts.ts
// and applied HERE so it becomes an explained line on the quote rather than a
// mysterious subtraction from a total. "Why is this ₹4,20,000 and not
// ₹4,80,000?" has to be answerable from the record, and a total that arrives
// pre-discounted from somewhere else cannot answer it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SECURITY PROPERTY, AND WHY IT IS A SYMBOL
// ─────────────────────────────────────────────────────────────────────────────
//
// A CLIENT MAY SUPPLY A DISCOUNT CODE. A CLIENT MAY NEVER SUPPLY AN AMOUNT.
//
// The obvious way to enforce that is discipline: only ever build a Reduction
// from database rows. Discipline is a promise. So a resolved Reduction must
// carry RESOLVED_BY_SERVER — a module-private symbol — and computeFee() refuses
// any that does not. JSON cannot carry a symbol, `structuredClone` does not
// copy one and no request body can forge one, so a reduction that reached this
// function from outside the process is rejected by construction rather than by
// remembering to check. src/db/discounts.ts stamps them in exactly one place.
//
// Refused rather than ignored, deliberately: a caller that assembled a
// reduction by hand has a bug, and silently dropping it would show them a full
// price with no explanation of the discount that vanished.

export const RESOLVED_BY_SERVER = Symbol.for('mmakf.fee.reduction.resolved');

export type ReductionStage = 'before_tax' | 'after_tax';
export type ReductionBasis = 'fixed_amount' | 'percentage';
export type ReductionSource = 'discount' | 'concession';

export interface Reduction {
  /** Set by src/db/discounts.ts and nothing else. See the note above. */
  readonly [RESOLVED_BY_SERVER]?: true;
  source: ReductionSource;
  /** The RULE or POLICY code — never the redeemed token, which is a secret. */
  sourceCode: string;
  label: string;
  stage: ReductionStage;
  basis: ReductionBasis;
  /** A POSITIVE magnitude in paise, for `fixed_amount`. */
  amountMinor?: number | null;
  /** Parts-per-million of the running total, for `percentage`. */
  percentPpm?: number | null;
  maxReductionMinor?: number | null;
  /**
   * A floor. Below this running subtotal the reduction does not apply.
   *
   * Checked HERE rather than in the resolver because the resolver has no
   * subtotal: it runs before the framework has priced anything. A reduction
   * held back this way is recorded in `Computation.skipped`, so the quotation
   * can still say why the code the customer typed produced nothing.
   */
  minSubtotalMinor?: number | null;
  /** The rule that matched, in words, for the "why this amount?" screen. */
  because: string;
  requiresApproval?: boolean;
  discountCodeId?: number | null;
  concessionApplicationId?: number | null;
}

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
  /** Which model produced this line, so a marketing report can exclude hardship. */
  source: 'fee_rule' | 'discount' | 'concession';
  reductionStage: ReductionStage | null;
  discountCodeId: number | null;
  concessionApplicationId: number | null;
}

export interface Computation {
  frameworkId: number;
  frameworkCode: string;
  currency: string;
  inputs: FeeInputs;
  lines: ComputedLine[];
  subtotalMinor: number;
  adjustmentMinor: number;
  /**
   * The two halves of `adjustmentMinor`, kept apart. Both NEGATIVE.
   *
   * A campaign report needs to know what discounts cost the federation, and it
   * must not be able to find that number by reading a figure that has hardship
   * concessions inside it.
   */
  discountMinor: number;
  concessionMinor: number;
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
 * WHAT ONE RESOLVED REDUCTION IS WORTH AGAINST A RUNNING TOTAL.
 *
 * Lifted out of computeFee()'s inner `applyReduction` and exported, because
 * src/db/checkout.ts applies reductions across a BASKET of separately-priced
 * services and had nowhere to get this arithmetic from. The alternative was a
 * second implementation, and the day the two drifted a school would be shown
 * one figure on a quotation and a different one at checkout for the same code.
 *
 * PURE. A running total in, a magnitude out — no database, no clock, no line
 * records. Every clamp it applies is reported in `notes` so the reason survives
 * onto the line the buyer reads.
 *
 * THE STAMP IS RE-CHECKED HERE. computeFee() already refuses an unstamped
 * reduction as a group before any rule runs; this function is exported, so it
 * checks for itself rather than trusting that every future caller remembered.
 */
export type ReductionOutcome =
  | { applied: false; because: string }
  | { applied: true; reductionMinor: number; notes: string[] };

export function computeReduction(runningMinor: number, r: Reduction): ReductionOutcome {
  if (r?.[RESOLVED_BY_SERVER] !== true) {
    throw new FeeError(
      'unresolved_reduction',
      `Reduction ${r?.sourceCode ?? '(unnamed)'} did not come from the server's own resolver. ` +
      'A discount CODE may be supplied by a client; a discount AMOUNT never may. ' +
      'Resolve it through src/db/discounts.ts.'
    );
  }

  if (r.minSubtotalMinor != null && runningMinor < r.minSubtotalMinor) {
    // Not silently dropped. The customer typed a code and is owed a reason.
    return {
      applied: false,
      because: `the amount is ${formatINR(runningMinor)}, below the ${formatINR(r.minSubtotalMinor)} this reduction requires`,
    };
  }

  let reduction: number;
  if (r.basis === 'fixed_amount') {
    // Zero is permitted here and forbidden by the CHECK on discount_rules.
    // The difference is deliberate: a RULE worth nothing is a configuration
    // mistake, while a reduction of zero is a real outcome — it is what a
    // reduction clamped to the amount outstanding looks like when replayed by
    // reproduce(), and refusing it would make a frozen quotation
    // unreproducible for having been fully clamped.
    if (r.amountMinor == null || !Number.isInteger(r.amountMinor) || r.amountMinor < 0) {
      throw new FeeError('reduction_incomplete', `Reduction ${r.sourceCode} is a fixed amount with no whole, non-negative amount in paise.`);
    }
    reduction = r.amountMinor;
  } else {
    if (r.percentPpm == null || !Number.isInteger(r.percentPpm) || r.percentPpm <= 0 || r.percentPpm > PPM) {
      throw new FeeError(
        'reduction_incomplete',
        `Reduction ${r.sourceCode} is a percentage and its rate is not between 1 and ${PPM} parts-per-million.`
      );
    }
    // applyFactor(), not a re-implementation. It is the only multiplier in
    // this codebase and it is where the BigInt and the half-up rounding live.
    reduction = applyFactor(runningMinor, r.percentPpm);
  }

  const notes: string[] = [r.because].filter(Boolean);
  if (r.maxReductionMinor != null && reduction > r.maxReductionMinor) {
    reduction = r.maxReductionMinor;
    notes.push(`capped at ${formatINR(r.maxReductionMinor)} by the policy`);
  }
  const outstanding = Math.max(runningMinor, 0);
  if (reduction > outstanding) {
    reduction = outstanding;
    notes.push('limited to the amount outstanding, so the total cannot fall below zero');
  }

  return { applied: true, reductionMinor: reduction, notes };
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
  inputs: FeeInputs,
  opts: { reductions?: Reduction[] } = {}
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
  let discountTotal = 0;
  let concessionTotal = 0;
  let tax = 0;
  let needsApproval = false;

  // ── Reductions, validated before a single rule runs ──
  //
  // Rejected as a group if any one is unstamped: a caller who hand-built one
  // has a bug, and applying the rest would quietly produce a total that is
  // right by arithmetic and wrong by authority.
  const reductions = opts.reductions ?? [];
  for (const r of reductions) {
    if (r[RESOLVED_BY_SERVER] !== true) {
      throw new FeeError(
        'unresolved_reduction',
        `Reduction ${r?.sourceCode ?? '(unnamed)'} did not come from the server's own resolver. ` +
        'A discount CODE may be supplied by a client; a discount AMOUNT never may. ' +
        'Resolve it through src/db/discounts.ts.'
      );
    }
  }

  /**
   * Turn one resolved reduction into a line.
   *
   * Two clamps, in this order, and both recorded on the line:
   *  1. the policy's own cap, if it set one;
   *  2. the amount outstanding — a reduction can take a total to zero and no
   *     further. A negative total is a refund the federation never agreed to,
   *     and it would flow straight into an invoice.
   */
  const applyReduction = (r: Reduction) => {
    // The arithmetic, and every clamp it applies, lives in computeReduction()
    // above — one implementation, shared with src/db/checkout.ts.
    const outcome = computeReduction(running, r);
    if (!outcome.applied) {
      skipped.push({ ruleCode: r.sourceCode, because: outcome.because });
      return;
    }
    const notes = outcome.notes;
    const amount = -outcome.reductionMinor;
    running += amount;
    adjustment += amount;
    if (r.source === 'discount') discountTotal += amount;
    else concessionTotal += amount;
    if (r.requiresApproval) needsApproval = true;

    lines.push({
      ruleId: null,
      ruleCode: r.sourceCode,
      // The existing fee_rule_kind vocabulary. A reduction IS a discount line
      // on the quote; `source` below is what says which model authorised it.
      kind: 'discount',
      label: r.label,
      quantity: null,
      unitAmountMinor: null,
      factorPpm: r.basis === 'percentage' ? (r.percentPpm ?? null) : null,
      amountMinor: amount,
      runningTotalMinor: running,
      because: notes.join('; ') || null,
      requiresApproval: Boolean(r.requiresApproval),
      source: r.source,
      reductionStage: r.stage,
      discountCodeId: r.discountCodeId ?? null,
      concessionApplicationId: r.concessionApplicationId ?? null,
    });
  };

  /**
   * A reduction only applies to something that was priced.
   *
   * `feeLines` counts lines produced by the framework's own rules. If none did,
   * the request needs a manual quotation and a discount on nothing is not a
   * discount — it is a negative total waiting to be shown to a school.
   */
  let feeLines = 0;
  let flushedBeforeTax = false;
  const flush = (stage: ReductionStage) => {
    if (!feeLines) return;
    for (const r of reductions) if (r.stage === stage) applyReduction(r);
  };

  for (const rule of rules) {
    // The before-tax reductions land immediately before the framework's FIRST
    // tax rule, which is what makes `before_tax` mean what it says: the tax is
    // then computed on the reduced amount. Sorting by number instead would
    // require whoever writes a discount policy to know a fee framework's
    // internal sort orders, which they cannot — the two are versioned apart.
    if (rule.kind === 'tax' && !flushedBeforeTax) {
      flushedBeforeTax = true;
      flush('before_tax');
    }
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

      // A NEGATIVE QUANTITY IS A CLIENT-SUPPLIED DISCOUNT WEARING A COUNT'S
      // CLOTHES. `participants: -400` against a per-participant rule produced a
      // negative line and took money OFF the total — a price the client chose,
      // through the one field a client is supposed to be allowed to choose.
      // Every caller today happens to sanitise (admin/quotes.astro requires
      // /^\d+$/, applications.ts passes a literal 1), so this was safe by
      // accident rather than by construction. It is refused here because this
      // is the module that claims to be the only place a price is decided, and
      // a guarantee that depends on all six callers remembering is not one.
      //
      // A rule whose own minQuantity is negative is a rule-authoring fault and
      // is named as such, so it cannot be mistaken for bad input.
      if (qty < 0) {
        throw new FeeError(
          'bad_quantity',
          `Rule ${rule.code} was given a quantity of ${qty} for ${String(key)}. ` +
          'A quantity is a count and cannot be negative — a negative one would reduce the total, ' +
          'which is a discount, and a discount is never something an input supplies.'
        );
      }

      quantity = qty;
      amount = rule.amountMinor * quantity;

      // Past 2^53 the product is no longer the number it claims to be, and the
      // engine's first promise is REPRODUCIBLE. Returning a silently-inexact
      // figure is worse than refusing: the integer column would reject it on the
      // way to a quote_version, but nothing stops a preview screen from printing
      // it to a school first.
      if (!Number.isSafeInteger(amount)) {
        throw new FeeError(
          'amount_out_of_range',
          `Rule ${rule.code} × ${quantity} exceeds the range this engine computes exactly. ` +
          'Set a maxQuantity on the rule, or price this request as a manual quotation.'
        );
      }
    }

    running += amount;
    if (rule.requiresApproval) needsApproval = true;
    feeLines += 1;

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
      source: 'fee_rule',
      reductionStage: null,
      discountCodeId: null,
      concessionApplicationId: null,
    });
  }

  // A framework with no tax rule never reached the flush inside the loop, so
  // `before_tax` lands at the end — which is the same place, there being no tax
  // to be before.
  if (!flushedBeforeTax) {
    flushedBeforeTax = true;
    flush('before_tax');
  }
  flush('after_tax');

  const priced = feeLines > 0;
  const subtotal = running - tax;

  return {
    frameworkId: framework.id,
    frameworkCode: framework.code,
    currency: framework.currency,
    inputs,
    lines,
    subtotalMinor: priced ? subtotal - adjustment : 0,
    adjustmentMinor: priced ? adjustment : 0,
    discountMinor: priced ? discountTotal : 0,
    concessionMinor: priced ? concessionTotal : 0,
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

/**
 * Attach the service's own words to a candidate rule before it is judged.
 *
 * A rule may be called RULE-17 and point at the 'MMAKF-FEE-MEM-ATHLETE' service,
 * and judging it on its own code alone would let the most obvious student
 * membership in the catalogue through under a neutral name. One small read, on
 * a path that runs when somebody authors or publishes a framework — never in
 * computeFee(), which prices thousands of times more often.
 */
async function withServiceNames(
  db: DB,
  candidate: RuleCandidate,
  serviceId: number | null
): Promise<RuleCandidate> {
  if (serviceId == null) return candidate;
  const [svc] = await db.select({
    code: s.services.code, title: s.services.title, category: s.services.category,
  }).from(s.services).where(eq(s.services.id, serviceId)).limit(1);
  if (!svc) return candidate;
  return {
    ...candidate,
    serviceCode: svc.code ?? null,
    serviceTitle: svc.title ?? null,
    serviceCategory: (svc.category as string | null) ?? null,
  };
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

  // ── A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT ──
  //
  // Enforced HERE, at the domain layer, and not in the admin form. A rule that
  // cannot be created cannot be displayed, exported, cloned, quoted, invoiced or
  // seeded — every one of those reads rows this refusal prevents from existing.
  // /admin/fees clones a framework by copying its rules back through THIS
  // function, so a clone cannot smuggle one across either.
  //
  // The service is resolved first because a rule may carry a bland code and
  // point at 'MMAKF-FEE-MEM-ATHLETE'. See src/db/student-rule.ts for why the
  // predicate turns on who pays rather than on the word "membership" — a coach
  // membership is legitimate and must stay creatable.
  const verdict = classifyFeeRule(await withServiceNames(db, {
    code: rule.code,
    label: rule.label,
    kind: rule.kind,
    audience: rule.audience ?? null,
    conditions: rule.conditions ?? {},
    amountMinor: rule.amountMinor ?? null,
  }, rule.serviceId ?? null));
  if (verdict.studentCharge) {
    throw new FeeError('student_charge_refused', verdict.refusal as string);
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

  // The WHOLE rule, not just its id. Publishing is the moment a framework
  // starts pricing real requests, and the scan below needs something to read.
  const rules = await db.select().from(s.feeRules)
    .where(eq(s.feeRules.frameworkId, frameworkId));
  if (!rules.length) {
    // An empty published framework prices nothing and would silently send every
    // request to "requires a quote" while appearing to be configured.
    throw new FeeError(
      'framework_empty',
      `Framework ${framework.code} has no rules. Publishing it would price nothing while appearing configured.`
    );
  }

  // ── THE SECOND GATE, AND THE MORE IMPORTANT ONE ──
  //
  // addRule() catches an author. THIS catches a seed script, a migration, a
  // restored backup or a hand-written INSERT — anything that put a row in
  // `fee_rules` without passing through this module at all. Publishing is the
  // only moment at which every rule in a framework is necessarily read, and it
  // is the moment a framework acquires the power to charge somebody, so it is
  // the right place to insist.
  //
  // EVERY offender is named, not just the first. An author who fixes one rule,
  // re-publishes, and is told about the next one learns to distrust the tool.
  const candidates: RuleCandidate[] = [];
  for (const r of rules) {
    candidates.push(await withServiceNames(db, {
      code: r.code, label: r.label, kind: r.kind,
      audience: r.audience ?? null, conditions: r.conditions ?? {},
      amountMinor: r.amountMinor ?? null,
    }, r.serviceId ?? null));
  }
  const refused = findStudentCharges(candidates);
  if (refused.length) {
    throw new FeeError(
      'student_charge_refused',
      `Framework ${framework.code} cannot be published: ${refused.length} of its ${rules.length} rules ` +
      'would charge somebody for being a student, and publishing is what would give them the power to do it. ' +
      'A student does not pay a membership fee for being a student.\n\n' +
      refused.map((x, i) => `${i + 1}. ${x.verdict.refusal}`).join('\n\n')
    );
  }

  // THE DRAFT CONDITION IS PART OF THE STATEMENT, not just of the read above.
  //
  // The check at the top of this function is a SELECT, and two concurrent
  // publishes both pass a SELECT. Publishing twice would move publishedAt and
  // publishedByUserId to the second caller — rewriting who froze the
  // federation's prices and when — and would write two audit rows for one
  // event. Correlating the condition into the UPDATE closes the window: exactly
  // one caller changes a row, and the other is told so.
  const [published] = await db.update(s.feeFrameworks)
    .set({
      status: 'published',
      publishedAt: new Date(),
      publishedByUserId: ctx.principal.userId ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(s.feeFrameworks.id, frameworkId), eq(s.feeFrameworks.status, 'draft')))
    .returning({ id: s.feeFrameworks.id });

  if (!published) {
    throw new FeeError(
      'already_published',
      `Framework ${framework.code} is no longer a draft — somebody else published it. ` +
      'It is published once, by one person, and that record stands.'
    );
  }

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
    /**
     * Reductions already resolved by src/db/discounts.ts.
     *
     * Passed through untouched. This function does not resolve a code and does
     * not read a discount table — if it did, there would be two places that
     * decide what a discount is worth, and the second one would drift.
     */
    reductions?: Reduction[];
  }
): Promise<IssuedQuote> {
  // Issuing a quotation is not editing the rules it is computed from, and it is
  // not recording a payment. TRAINING_OPERATIONS holds this and neither of the
  // other two — which is the separation that stops one person discounting
  // unobserved.
  assertCan(ctx.principal, 'quote:issue', {});
  const computation = await computeFee(db, input.frameworkId, input.inputs, {
    reductions: input.reductions,
  });

  // ── ONE QUOTATION PER REQUEST ────────────────────────────────────────────
  //
  // Re-version an existing quotation for the same request rather than opening a
  // second one, so a request has ONE quotation with a history.
  //
  // The read below is a courtesy, not the guarantee. It used to be the whole of
  // it — a SELECT, and an INSERT when it found nothing — and two concurrent
  // callers both pass a SELECT. Two administrators pressing "issue" on the same
  // request, or a retried workflow step, therefore opened two quotations, each
  // numbering its versions from 1, and the supersede below (scoped to one
  // quote_id) left BOTH carrying a live `issued` version. The federation would
  // have been quoting two prices at once with nothing in the schema saying which
  // one the school was given.
  //
  // `quotes_request_uk` (migration 0048) is the guarantee. The loser of the race
  // is refused by Postgres, reads the winner's row and re-versions THAT — so two
  // concurrent callers produce one quotation with two versions, which is the
  // true history of what happened.
  const findQuoteByRequest = async () => {
    if (input.requestId == null) return null;
    const rows = await db.select().from(s.quotes)
      .where(eq(s.quotes.requestId, input.requestId)).limit(1);
    return rows[0] ?? null;
  };

  let quote: any = await findQuoteByRequest();
  if (!quote) {
    const ref = await allocateFederationId(db, 'QUO', new Date().getUTCFullYear());
    let created: any = null;
    try {
      // ON CONFLICT DO NOTHING rather than catching the violation, because
      // issueQuote() is called INSIDE A TRANSACTION by autoQuoteApplication().
      // A raised unique violation aborts the whole transaction in Postgres, and
      // the recovery read below would then fail too — the conflict has to be
      // absorbed by the statement, not by the caller.
      const rows = await db.insert(s.quotes).values({
        ref,
        requestId: input.requestId ?? null,
        institutionId: input.institutionId ?? null,
        personId: input.personId ?? null,
        createdByUserId: ctx.principal.userId ?? null,
      }).onConflictDoNothing().returning();
      created = rows[0] ?? null;
    } catch (err) {
      // A driver that raises anyway. Outside a transaction the read below still
      // recovers; inside one this rethrows, which is the safe direction.
      if (!isUniqueViolation(err)) throw err;
    }

    // Somebody else opened the quotation for this request between the read and
    // the write. Join theirs. Re-reading rather than keeping the loser's own
    // view is the point: the winner's reference is the one the school sees.
    quote = created ?? await findQuoteByRequest();

    if (!quote) {
      // Not the request index, then — the conflict was on the reference, which
      // means the federation id allocator handed the same number out twice.
      // That is not a race to absorb; it is a fault to stop on, and stopping
      // here means nothing was issued.
      throw new FeeError(
        'quote_not_opened',
        'A quotation could not be opened for this request and no existing one could be read. ' +
        'Nothing has been issued and nothing has been charged. This needs a person.'
      );
    }
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
    discountMinor: computation.discountMinor,
    concessionMinor: computation.concessionMinor,
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
        sourceKind: l.source,
        reductionStage: l.reductionStage,
        discountCodeId: l.discountCodeId,
        concessionApplicationId: l.concessionApplicationId,
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

  return rows.map((r: (typeof rows)[number]) => ({
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

  // ── The reductions are read back from the quote, NOT re-resolved ──
  //
  // Re-running resolveDiscountCodes() here would find the code expired, the
  // campaign cap reached or the concession revoked, and would report the
  // quotation as unreproducible when nothing about it had changed. A reduction
  // is a DECISION taken at issue time and frozen with the inputs, exactly like
  // the framework version — so it is replayed at the magnitude that was
  // granted, and what this function actually re-tests is the fee arithmetic
  // underneath it.
  const storedLines = await db.select().from(s.quoteLines)
    .where(eq(s.quoteLines.quoteVersionId, quoteVersionId))
    .orderBy(asc(s.quoteLines.sortOrder));

  const frozen: Reduction[] = storedLines
    .filter((l: any) => l.sourceKind === 'discount' || l.sourceKind === 'concession')
    .map((l: any) => ({
      [RESOLVED_BY_SERVER]: true as const,
      source: l.sourceKind as ReductionSource,
      sourceCode: l.ruleCode ?? '(frozen)',
      label: l.label,
      stage: (l.reductionStage ?? 'before_tax') as ReductionStage,
      // Replayed as the fixed magnitude that was granted, whatever basis
      // produced it. A percentage recomputed against a subtotal that has since
      // been recalculated is a different number, and the figure the federation
      // stands behind is the one it sent.
      basis: 'fixed_amount' as const,
      amountMinor: Math.abs(l.amountMinor),
      because: l.because,
      discountCodeId: l.discountCodeId ?? null,
      concessionApplicationId: l.concessionApplicationId ?? null,
    }));

  const recomputed = await computeFee(db, qv.frameworkId, qv.inputs as FeeInputs, {
    reductions: frozen,
  });
  return {
    stored: {
      subtotalMinor: qv.subtotalMinor,
      adjustmentMinor: qv.adjustmentMinor,
      discountMinor: qv.discountMinor,
      concessionMinor: qv.concessionMinor,
      taxMinor: qv.taxMinor,
      totalMinor: qv.totalMinor,
      requiresManualQuote: qv.requiresManualQuote,
    },
    recomputed,
    matches:
      recomputed.totalMinor === qv.totalMinor &&
      recomputed.subtotalMinor === qv.subtotalMinor &&
      recomputed.taxMinor === qv.taxMinor &&
      recomputed.discountMinor === qv.discountMinor &&
      recomputed.concessionMinor === qv.concessionMinor &&
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
      // BOTH figures, or neither. `formatINR(l.unitAmountMinor ?? 0)` printed
      // '3 × ₹0.00 = ₹1,200.00' for a stored line that carries a quantity but no
      // unit amount — arithmetic that does not hold, with a fabricated zero in the
      // middle of it. A narrative nobody can check is worse than a shorter one.
      if (l.quantity != null && l.unitAmountMinor != null) {
        return `${l.label}: ${l.quantity} × ${formatINR(l.unitAmountMinor)} = ${formatINR(l.amountMinor)}`;
      }
      return `${l.label}: ${formatINR(l.amountMinor)}`;
    }),
  };
}
