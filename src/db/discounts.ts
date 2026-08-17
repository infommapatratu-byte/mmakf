// Discount and concession policy.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE PROPERTY THIS MODULE EXISTS TO GUARANTEE
// ─────────────────────────────────────────────────────────────────────────────
//
//   A CLIENT MAY SUPPLY A DISCOUNT CODE.
//   A CLIENT MAY NEVER SUPPLY A DISCOUNT AMOUNT.
//
// Everything else here is arrangement. parseDiscountRequest() is the ONLY door
// a request body comes through, and it lets exactly one thing past: a list of
// strings. It does not read `amountMinor`, `discountMinor`, `reductionMinor` or
// any other number, because it does not look at them at all — it constructs its
// output rather than filtering its input, which is the difference between a
// whitelist and a hope.
//
// The server then resolves each code against rows only a `feeframework:write`
// holder can have written: is it a code we issued, is it active, is it inside
// its validity window, is it under its usage cap and its per-customer cap, is
// this customer eligible, do the rule's conditions match what they told us. Then
// IT computes the reduction. tests/discounts.test.ts submits a forged amount and
// proves the total is identical to the same request without one.
//
// A second, structural lock sits behind that. computeFee() refuses any reduction
// not carrying RESOLVED_BY_SERVER — a symbol stamped in exactly one place in
// this file. JSON cannot carry a symbol, so a reduction that arrived from
// outside this process is rejected by construction and not by vigilance.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY DISCOUNTS AND CONCESSIONS ARE TWO MODELS
// ─────────────────────────────────────────────────────────────────────────────
//
// A DISCOUNT is commercial: volume, early registration, renewal, a campaign.
// It is offered to a market, redeemed with a code, counted against a cap, and
// reported on. Authority: 'feeframework:write' to author, 'feeframework:publish'
// to freeze, 'quote:approve' when a rule wants a second pair of eyes.
//
// A CONCESSION is a decision about one person's circumstances: a student rate,
// a hardship award, a sibling reduction. It is applied for rather than
// redeemed, it carries a statement somebody wrote about their own life, and it
// is decided by a named officer. Authority: 'concession:read' to see a case,
// 'concession:decide' to decide one — and NOT 'quote:approve', because the
// whole point of separating them is that the people who sign off pricing are
// not thereby entitled to read why a family cannot pay.
//
// The practical consequence is enforced below: marketingDiscountReport() reads
// discount rows and cannot reach a concession, and resolveConcession() never
// selects `statedCircumstance` — so the operator quoting a school learns that a
// concession of ₹X applies and never learns why.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHAT IS NOT HERE
// ─────────────────────────────────────────────────────────────────────────────
//
// NO HARDCODED PERCENTAGE. Not one. Every discount is a stored rule with
// conditions, an approver and an audit trail; every concession is a stored
// policy and a decided application. There is no "student rate" constant in this
// file, no 10%, no ₹500 off. MMAKF has approved no discount policy and no
// concession policy, so both ship EMPTY and every surface can say so honestly.
// Seeding a plausible one would be this project inventing the federation's
// commercial and welfare policy on its behalf.

import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { allocateFederationId, writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, canAnywhere, visibleScopes, type Principal } from '@/lib/rbac';
import {
  matchConditions, formatINR, RESOLVED_BY_SERVER,
  issueQuote,
  type FeeInputs, type Reduction, type ReductionStage, type IssuedQuote,
} from '@/db/fees';

type DB = any;

export class DiscountError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DiscountError';
    this.code = code;
  }
}

/** Identified by shape, not by `instanceof` — see src/lib/calendar.ts for why. */
export function isDiscountError(err: unknown): err is DiscountError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'DiscountError';
}

// ─── The client-facing door ─────────────────────────────────────────────────

/**
 * How many codes one request may carry.
 *
 * A count, not a rate — there is no money in this constant. It exists because a
 * request listing four hundred codes is either a stacking attempt or an attempt
 * to make the server do four hundred lookups, and neither is a use the
 * federation has.
 */
export const MAX_CODES_PER_REQUEST = 5;

/** Longer than any code the federation would print on a poster. */
const MAX_CODE_LENGTH = 40;

/**
 * Normalise a code to the form it is stored in.
 *
 * Trimmed and upper-cased, so SCHOOL26, school26 and " School26 " are one code
 * rather than three that behave differently depending on what somebody typed.
 * Returns null for anything that is not usable, which the caller reports rather
 * than silently dropping.
 */
export function normaliseCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toUpperCase();
  if (!trimmed || trimmed.length > MAX_CODE_LENGTH) return null;
  // Codes are printed on posters and read down telephones. Restricting the
  // alphabet keeps a code from carrying anything that has to be escaped later.
  if (!/^[A-Z0-9][A-Z0-9._-]*$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * THE SECURITY BOUNDARY. Everything a client may say about a discount.
 *
 * Note what this returns: `{ codes: string[] }`. Not a partially-trusted copy
 * of the request with the dangerous fields deleted — a NEW object built from
 * one field. A body carrying `amountMinor`, `discountMinor`, `totalMinor`,
 * `percentPpm` or `reduction` produces exactly the same result as one carrying
 * none of them, because none of them is ever read.
 *
 * Deleting fields is the version of this that fails: it works until somebody
 * adds a field to the model, and then the new one is trusted by default.
 */
export function parseDiscountRequest(body: unknown): { codes: string[]; rejected: string[] } {
  const source = (body ?? {}) as Record<string, unknown>;
  const raw = source.codes ?? source.discountCodes ?? source.code ?? source.discountCode;
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];

  const codes: string[] = [];
  const rejected: string[] = [];
  for (const item of list) {
    if (codes.length >= MAX_CODES_PER_REQUEST) break;
    const code = normaliseCode(item);
    if (!code) {
      // Echoed back only as a type, never as the value: reflecting arbitrary
      // client text into a response is how a rejection message becomes an
      // injection surface.
      rejected.push(typeof item === 'string' ? 'not a usable code' : `not a code (${typeof item})`);
      continue;
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return { codes, rejected };
}

// ─── Authoring a discount policy ────────────────────────────────────────────

export async function createDiscountPolicy(
  db: DB, ctx: AuditContext,
  input: { title: string; version: number; effectiveFrom?: string | null; effectiveTo?: string | null; notes?: string }
) {
  // The pricing RULES action, not 'finance:write' and not 'quote:issue'. A
  // discount rule changes every future quotation that matches it, which is the
  // same kind of act as changing a fee rule and is gated the same way.
  assertCan(ctx.principal, 'feeframework:write', {});
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new DiscountError('bad_version', 'A discount policy version must be a positive whole number.');
  }
  const code = `MMAKF-DISCOUNT-V${input.version}`;
  const [row] = await db.insert(s.discountPolicies).values({
    code,
    title: input.title,
    version: input.version,
    status: 'draft',
    effectiveFrom: input.effectiveFrom ?? null,
    effectiveTo: input.effectiveTo ?? null,
    notes: input.notes ?? null,
    createdByUserId: ctx.principal.userId ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'discount_policy', entityId: row.id, action: 'create',
    newValue: { code, version: input.version },
  });
  return row;
}

export interface DiscountRuleInput {
  code: string;
  label: string;
  basis: 'fixed_amount' | 'percentage';
  stage?: ReductionStage;
  /** POSITIVE paise for `fixed_amount` — the size of the reduction. */
  amountMinor?: number | null;
  /** Parts-per-million of the running total for `percentage`. 100000 is 10%. */
  percentPpm?: number | null;
  maxReductionMinor?: number | null;
  minSubtotalMinor?: number | null;
  audience?: string | null;
  serviceId?: number | null;
  conditions?: Record<string, unknown>;
  stackable?: boolean;
  priority?: number;
  requiresApproval?: boolean;
}

export async function addDiscountRule(
  db: DB, ctx: AuditContext, policyId: number, rule: DiscountRuleInput
) {
  assertCan(ctx.principal, 'feeframework:write', {});
  const [policy] = await db.select().from(s.discountPolicies)
    .where(eq(s.discountPolicies.id, policyId)).limit(1);
  if (!policy) throw new DiscountError('unknown_policy', 'No such discount policy.');

  // THE IMMUTABILITY RULE, as for a fee framework. Editing a published discount
  // rule silently rewrites every quotation issued under it — a school that
  // accepted a figure in March would find its own quotation saying something
  // else in June.
  if (policy.status !== 'draft') {
    throw new DiscountError(
      'policy_locked',
      `Discount policy ${policy.code} is ${policy.status} and cannot be changed. ` +
      'Publish a NEW version instead — every quotation issued under this one must keep computing to the figure it was issued at.'
    );
  }

  // The database has the same CHECKs. Both, deliberately: the constraint is
  // what makes the state unrepresentable, and the message here is what tells
  // the person who typed it what they got wrong.
  if (rule.basis === 'fixed_amount') {
    if (!Number.isInteger(rule.amountMinor ?? NaN) || (rule.amountMinor as number) <= 0) {
      throw new DiscountError('bad_amount', 'A fixed discount is a POSITIVE amount in integer paise — ₹450.50 off is 45050, not -450.5.');
    }
    if (rule.percentPpm != null) {
      throw new DiscountError('bad_basis', 'A fixed discount carries an amount OR a percentage, never both.');
    }
  } else if (rule.basis === 'percentage') {
    if (!Number.isInteger(rule.percentPpm ?? NaN) || (rule.percentPpm as number) <= 0 || (rule.percentPpm as number) > 1_000_000) {
      throw new DiscountError(
        'bad_percent',
        'A percentage discount is integer parts-per-million between 1 and 1000000 — 10% is 100000. ' +
        'Above 1000000 it is not a discount but a payment to the customer.'
      );
    }
    if (rule.amountMinor != null) {
      throw new DiscountError('bad_basis', 'A percentage discount carries a percentage OR an amount, never both.');
    }
  } else {
    throw new DiscountError('bad_basis', 'A discount is either a fixed_amount or a percentage.');
  }
  if (rule.maxReductionMinor != null && (!Number.isInteger(rule.maxReductionMinor) || rule.maxReductionMinor <= 0)) {
    throw new DiscountError('bad_cap', 'A discount cap is a positive whole number of paise.');
  }

  const [row] = await db.insert(s.discountRules).values({
    policyId,
    code: rule.code,
    label: rule.label,
    basis: rule.basis as any,
    stage: (rule.stage ?? 'before_tax') as any,
    amountMinor: rule.amountMinor ?? null,
    percentPpm: rule.percentPpm ?? null,
    maxReductionMinor: rule.maxReductionMinor ?? null,
    minSubtotalMinor: rule.minSubtotalMinor ?? null,
    audience: (rule.audience ?? null) as any,
    serviceId: rule.serviceId ?? null,
    conditions: rule.conditions ?? {},
    stackable: rule.stackable ?? false,
    priority: rule.priority ?? 100,
    requiresApproval: rule.requiresApproval ?? false,
  }).returning();
  return row;
}

/** Freeze a discount policy. After this a change means a new version. */
export async function publishDiscountPolicy(db: DB, ctx: AuditContext, policyId: number) {
  // A SEPARATE ACTION from writing one, for the reason publishFramework() gives:
  // publishing is irreversible, so the person who drafts and the person who
  // freezes can be different people.
  assertCan(ctx.principal, 'feeframework:publish', {});
  const [policy] = await db.select().from(s.discountPolicies)
    .where(eq(s.discountPolicies.id, policyId)).limit(1);
  if (!policy) throw new DiscountError('unknown_policy', 'No such discount policy.');
  if (policy.status !== 'draft') {
    throw new DiscountError('already_published', `Discount policy ${policy.code} is already ${policy.status}.`);
  }

  const rules = await db.select({ id: s.discountRules.id }).from(s.discountRules)
    .where(eq(s.discountRules.policyId, policyId));
  if (!rules.length) {
    throw new DiscountError(
      'policy_empty',
      `Discount policy ${policy.code} has no rules. Publishing it would discount nothing while appearing configured.`
    );
  }

  await db.update(s.discountPolicies)
    .set({
      status: 'published',
      publishedAt: new Date(),
      publishedByUserId: ctx.principal.userId ?? null,
      updatedAt: new Date(),
    })
    .where(eq(s.discountPolicies.id, policyId));

  await writeAudit(db, ctx, {
    entityType: 'discount_policy', entityId: policyId, action: 'approve',
    oldValue: { status: 'draft' },
    newValue: { status: 'published', rules: rules.length },
  });
  return { id: policyId, status: 'published', rules: rules.length };
}

/**
 * Mint a redeemable code for a published rule.
 *
 * A code may only be issued against a PUBLISHED policy. Issuing one against a
 * draft would put a redeemable token in a customer's hands whose value the
 * federation could still edit — which is the immutability rule read from the
 * other end.
 */
export async function issueDiscountCode(
  db: DB, ctx: AuditContext, ruleId: number,
  input: {
    code: string;
    validFrom?: Date | string | null;
    validTo?: Date | string | null;
    maxRedemptions?: number | null;
    maxPerSubject?: number | null;
    notes?: string | null;
    /** Codes are minted inactive. Activation is a second, deliberate act. */
    activate?: boolean;
  }
) {
  assertCan(ctx.principal, 'feeframework:write', {});
  const [rule] = await db.select().from(s.discountRules)
    .where(eq(s.discountRules.id, ruleId)).limit(1);
  if (!rule) throw new DiscountError('unknown_rule', 'No such discount rule.');

  const [policy] = await db.select().from(s.discountPolicies)
    .where(eq(s.discountPolicies.id, rule.policyId)).limit(1);
  if (!policy || policy.status !== 'published') {
    throw new DiscountError(
      'policy_not_published',
      'A discount code can only be issued against a PUBLISHED policy. A code minted from a draft is a redeemable ' +
      'token whose value the federation can still edit.'
    );
  }

  const code = normaliseCode(input.code);
  if (!code) {
    throw new DiscountError('bad_code', 'A discount code is letters, digits, dots, dashes and underscores, and is stored upper case.');
  }
  if (input.maxRedemptions != null && (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1)) {
    throw new DiscountError('bad_cap', 'A usage cap is a positive whole number, or null for uncapped.');
  }
  if (input.maxPerSubject != null && (!Number.isInteger(input.maxPerSubject) || input.maxPerSubject < 1)) {
    throw new DiscountError('bad_cap', 'A per-customer cap is a positive whole number, or null for uncapped.');
  }

  const [row] = await db.insert(s.discountCodes).values({
    ruleId,
    code,
    status: input.activate ? 'active' : 'draft',
    validFrom: input.validFrom ? new Date(input.validFrom) : null,
    validTo: input.validTo ? new Date(input.validTo) : null,
    maxRedemptions: input.maxRedemptions ?? null,
    maxPerSubject: input.maxPerSubject ?? null,
    issuedByUserId: ctx.principal.userId ?? null,
    notes: input.notes ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'discount_code', entityId: row.id, action: 'create',
    newValue: { code, ruleId, status: row.status, maxRedemptions: input.maxRedemptions ?? null },
  });
  return row;
}

/** Narrow a code to a named institution, person, unit, service or audience. */
export async function addDiscountEligibility(
  db: DB, ctx: AuditContext, codeId: number,
  subject: { kind: string; id?: number | null; value?: string | null }
) {
  assertCan(ctx.principal, 'feeframework:write', {});
  const named = subject.id != null;
  const valued = subject.value != null && subject.value !== '';
  if (named === valued) {
    throw new DiscountError(
      'bad_subject',
      'An eligibility row names a row (subject id) or a label (subject value), and exactly one of them. ' +
      'A row naming neither matches nothing; a row naming both is ambiguous.'
    );
  }
  const [row] = await db.insert(s.discountEligibility).values({
    codeId,
    subjectKind: subject.kind as any,
    subjectId: subject.id ?? null,
    subjectValue: valued ? String(subject.value) : null,
  }).returning();
  return row;
}

/** Activate, suspend, expire or withdraw a code. Never deletes one. */
export async function setDiscountCodeStatus(
  db: DB, ctx: AuditContext, codeId: number, status: string, reason: string
) {
  assertCan(ctx.principal, 'feeframework:write', {});
  const why = String(reason ?? '').trim();
  if (why.length < 4) {
    throw new DiscountError('reason_required', 'Changing a code’s standing must say why — somebody will ask later.');
  }
  const [existing] = await db.select().from(s.discountCodes)
    .where(eq(s.discountCodes.id, codeId)).limit(1);
  if (!existing) throw new DiscountError('unknown_code', 'No such discount code.');

  const [row] = await db.update(s.discountCodes)
    .set({ status: status as any, updatedAt: new Date() })
    .where(eq(s.discountCodes.id, codeId))
    .returning();

  await writeAudit(db, { ...ctx, reason: why }, {
    entityType: 'discount_code', entityId: codeId, action: 'update',
    oldValue: { status: existing.status },
    newValue: { status: row.status },
  });
  return row;
}

// ─── Resolving a code into a reduction ──────────────────────────────────────

export interface DiscountSubject {
  institutionId?: number | null;
  personId?: number | null;
  stateUnitId?: number | null;
  districtUnitId?: number | null;
  dojoId?: number | null;
  serviceId?: number | null;
}

export interface ResolvedDiscounts {
  applied: Reduction[];
  /** Every code that did not apply, and the plain reason. */
  refused: Array<{ code: string; reason: string }>;
}

function withinWindow(now: Date, from: Date | null, to: Date | null): boolean {
  if (from && now.getTime() < new Date(from).getTime()) return false;
  if (to && now.getTime() > new Date(to).getTime()) return false;
  return true;
}

function dateWithin(asAt: string, from: string | null, to: string | null): boolean {
  if (from && asAt < from) return false;
  if (to && asAt > to) return false;
  return true;
}

/**
 * Turn client-supplied CODES into server-computed REDUCTIONS.
 *
 * This is the function the security property lives in, and it is deliberately
 * the only place in the codebase that stamps RESOLVED_BY_SERVER. It takes
 * strings and rows; it never takes an amount from anywhere but the database.
 *
 * It reads, and writes nothing. A customer trying a code on the public
 * estimator must not create a record, and the cap must not be consumed by
 * somebody who never bought anything — see redeemForQuoteVersion() for where
 * the count actually moves.
 */
export async function resolveDiscountCodes(
  db: DB,
  input: {
    codes: string[];
    inputs: FeeInputs;
    subject?: DiscountSubject;
    asAt?: Date;
  }
): Promise<ResolvedDiscounts> {
  const now = input.asAt ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const subject = input.subject ?? {};
  const refused: ResolvedDiscounts['refused'] = [];

  const wanted = input.codes.map((c) => normaliseCode(c)).filter((c): c is string => Boolean(c));
  if (!wanted.length) return { applied: [], refused };

  const codeRows = await db.select().from(s.discountCodes)
    .where(inArray(s.discountCodes.code, wanted));
  const byCode = new Map<string, any>(codeRows.map((r: any) => [r.code, r]));

  type Candidate = { code: any; rule: any; policy: any };
  const candidates: Candidate[] = [];

  for (const code of wanted) {
    const row = byCode.get(code);
    if (!row) {
      refused.push({ code, reason: 'That is not a code the federation has issued.' });
      continue;
    }
    if (row.status !== 'active') {
      refused.push({ code, reason: `That code is ${row.status}, so it cannot be used.` });
      continue;
    }
    if (!withinWindow(now, row.validFrom, row.validTo)) {
      refused.push({ code, reason: 'That code is outside its validity dates.' });
      continue;
    }
    if (row.maxRedemptions != null && row.redeemedCount >= row.maxRedemptions) {
      refused.push({ code, reason: 'That code has reached the number of times it may be used.' });
      continue;
    }

    // Per-customer cap, counted from the redemption ROWS rather than a second
    // counter — a per-subject total cannot be maintained on the code at all.
    if (row.maxPerSubject != null) {
      const who = subject.institutionId != null
        ? eq(s.discountRedemptions.institutionId, subject.institutionId)
        : subject.personId != null
          ? eq(s.discountRedemptions.personId, subject.personId)
          : null;
      if (who) {
        const used = await db.select({ n: sql<number>`count(*)::int` })
          .from(s.discountRedemptions)
          .where(and(eq(s.discountRedemptions.codeId, row.id), who));
        if ((used[0]?.n ?? 0) >= row.maxPerSubject) {
          refused.push({ code, reason: 'That code has already been used the maximum number of times by this customer.' });
          continue;
        }
      }
      // No identified subject means the per-customer cap cannot be checked. The
      // code is still refused rather than allowed: a cap that silently does not
      // apply to anonymous requests is not a cap.
      else {
        refused.push({ code, reason: 'That code is limited per customer and this request does not identify one.' });
        continue;
      }
    }

    const [rule] = await db.select().from(s.discountRules)
      .where(eq(s.discountRules.id, row.ruleId)).limit(1);
    if (!rule) {
      refused.push({ code, reason: 'That code is not attached to a discount rule.' });
      continue;
    }
    const [policy] = await db.select().from(s.discountPolicies)
      .where(eq(s.discountPolicies.id, rule.policyId)).limit(1);
    if (!policy || policy.status !== 'published') {
      refused.push({ code, reason: 'The discount policy behind that code is not published.' });
      continue;
    }
    if (!dateWithin(today, policy.effectiveFrom, policy.effectiveTo)) {
      refused.push({ code, reason: 'The discount policy behind that code is not in force today.' });
      continue;
    }

    // Eligibility. NO ROWS MEANS NO RESTRICTION beyond the code itself, which
    // is the honest reading of a marketing code: the code is the gate.
    const eligibility = await db.select().from(s.discountEligibility)
      .where(eq(s.discountEligibility.codeId, row.id));
    if (eligibility.length) {
      const matched = eligibility.some((e: any) => {
        switch (e.subjectKind) {
          case 'institution': return subject.institutionId != null && subject.institutionId === e.subjectId;
          case 'person': return subject.personId != null && subject.personId === e.subjectId;
          case 'state_unit': return subject.stateUnitId != null && subject.stateUnitId === e.subjectId;
          case 'district_unit': return subject.districtUnitId != null && subject.districtUnitId === e.subjectId;
          case 'dojo': return subject.dojoId != null && subject.dojoId === e.subjectId;
          case 'service': return subject.serviceId != null && subject.serviceId === e.subjectId;
          case 'audience': return input.inputs.audience != null && input.inputs.audience === e.subjectValue;
          // An eligibility kind this code does not implement does NOT match.
          // Fail-open here would let a typo widen a code to the whole country.
          default: return false;
        }
      });
      if (!matched) {
        refused.push({ code, reason: 'This customer is not eligible for that code.' });
        continue;
      }
    }

    if (rule.audience != null && input.inputs.audience !== rule.audience) {
      refused.push({ code, reason: 'That code does not apply to this kind of customer.' });
      continue;
    }
    if (rule.serviceId != null && subject.serviceId != null && rule.serviceId !== subject.serviceId) {
      refused.push({ code, reason: 'That code does not apply to this service.' });
      continue;
    }

    // The SAME matcher the fee rules use, imported rather than reimplemented,
    // so a discount cannot quietly acquire a looser idea of what "school" means
    // than the rule that priced the request.
    const cond = matchConditions(rule.conditions, input.inputs);
    if (!cond.matched) {
      refused.push({ code, reason: `That code does not apply here: ${cond.failedOn ?? 'a condition did not match'}.` });
      continue;
    }

    candidates.push({ code: row, rule, policy });
  }

  // ── Stacking ──
  //
  // Deterministic order: priority, then id. Whether two discounts may sit on
  // one quotation is a decision the federation takes per rule, and the default
  // is that they may not — the alternative lets a school combine a launch
  // offer, a volume band and a renewal rate into a total nobody intended.
  candidates.sort((a, b) => (a.rule.priority - b.rule.priority) || (a.rule.id - b.rule.id));

  const applied: Reduction[] = [];
  const acceptedRules: any[] = [];
  for (const c of candidates) {
    if (acceptedRules.length && (!c.rule.stackable || acceptedRules.some((r) => !r.stackable))) {
      refused.push({
        code: c.code.code,
        reason: `That code cannot be combined with ${acceptedRules[0].label}, which is already applied.`,
      });
      continue;
    }
    acceptedRules.push(c.rule);

    const cond = matchConditions(c.rule.conditions, input.inputs);
    applied.push({
      // THE STAMP. The only place in the codebase it is applied.
      [RESOLVED_BY_SERVER]: true,
      source: 'discount',
      // The RULE code, not the redeemed token. The token may be a secret shared
      // with one school, and it should not end up on a stored quote line that a
      // different reader can see.
      sourceCode: c.rule.code,
      label: c.rule.label,
      stage: c.rule.stage as ReductionStage,
      basis: c.rule.basis,
      amountMinor: c.rule.amountMinor,
      percentPpm: c.rule.percentPpm,
      maxReductionMinor: c.rule.maxReductionMinor,
      minSubtotalMinor: c.rule.minSubtotalMinor,
      because: cond.because ? `discount applied; ${cond.because}` : 'discount applied',
      requiresApproval: Boolean(c.rule.requiresApproval),
      discountCodeId: c.code.id,
      concessionApplicationId: null,
    });
  }

  return { applied, refused };
}

// ─── Concessions ────────────────────────────────────────────────────────────

/**
 * Take a concession application.
 *
 * Gated on 'concession:read' rather than 'engagement:write', which looks odd
 * until you read `statedCircumstance`: taking this application means writing
 * down why somebody cannot afford a fee, and whoever does that has to be one of
 * the people trusted to hold it. An intake queue that anybody can write into is
 * an intake queue anybody can read out of by writing to it first.
 */
export async function submitConcessionApplication(
  db: DB, ctx: AuditContext,
  input: {
    policyId: number;
    personId?: number | null;
    institutionId?: number | null;
    requestId?: number | null;
    statedCircumstance?: string | null;
    evidenceRef?: string | null;
  }
) {
  assertCan(ctx.principal, 'concession:read', {});

  const [policy] = await db.select().from(s.concessionPolicies)
    .where(eq(s.concessionPolicies.id, input.policyId)).limit(1);
  if (!policy) throw new DiscountError('unknown_policy', 'No such concession policy.');
  if (policy.status !== 'published') {
    throw new DiscountError(
      'policy_not_published',
      `Concession policy ${policy.code} is ${policy.status}. Taking an application against an unpublished policy ` +
      'would promise somebody terms the federation has not agreed.'
    );
  }
  if (policy.requiresEvidence && !String(input.evidenceRef ?? '').trim()) {
    throw new DiscountError(
      'evidence_required',
      `Concession policy ${policy.code} requires supporting evidence. Record the reference to the document, not the document.`
    );
  }

  const ref = await allocateFederationId(db, 'CON', new Date().getUTCFullYear());
  const [row] = await db.insert(s.concessionApplications).values({
    ref,
    policyId: input.policyId,
    personId: input.personId ?? null,
    institutionId: input.institutionId ?? null,
    requestId: input.requestId ?? null,
    status: 'submitted',
    statedCircumstance: input.statedCircumstance ?? null,
    evidenceRef: input.evidenceRef ?? null,
    submittedByUserId: ctx.principal.userId ?? null,
    submittedAt: new Date(),
    confidential: policy.confidential,
  }).returning();

  // NOTE WHAT IS NOT IN THE AUDIT RECORD: the stated circumstance. An audit row
  // is read by more people than the case is, and copying a family's account of
  // their finances into it would defeat the whole separation.
  await writeAudit(db, ctx, {
    entityType: 'concession_application', entityId: row.id, action: 'create',
    newValue: { ref, policy: policy.code, category: policy.category, status: 'submitted' },
  });
  return row;
}

/**
 * Decide a concession application.
 *
 * Three controls, all required:
 *  1. 'concession:decide' — an action nobody holds by holding 'quote:approve';
 *  2. an attributable decider — an approval nobody can name is not an approval;
 *  3. the decider is not the person who took the application.
 *
 * The third is the one that costs somebody thirty seconds and is worth it. A
 * SAFEGUARDING_OFFICER can legitimately both take and decide these, so holding
 * the action cannot be sufficient.
 */
export async function decideConcessionApplication(
  db: DB, ctx: AuditContext, applicationId: number,
  input: { decision: 'approved' | 'rejected' | 'information_requested' | 'revoked'; reason: string; authority?: string | null; validFrom?: string | null; validTo?: string | null }
) {
  assertCan(ctx.principal, 'concession:decide', {});

  const why = String(input.reason ?? '').trim();
  if (why.length < 4) {
    throw new DiscountError('reason_required', 'A concession decision must say why. The applicant is owed an answer.');
  }

  const decider = ctx.principal.userId;
  if (decider == null) {
    throw new DiscountError(
      'unattributable_decision',
      'A concession decision must be attributable to a named account, and this session has none.'
    );
  }

  const [app] = await db.select().from(s.concessionApplications)
    .where(eq(s.concessionApplications.id, applicationId)).limit(1);
  if (!app) throw new DiscountError('unknown_application', 'No such concession application.');
  if (app.submittedByUserId != null && app.submittedByUserId === decider) {
    throw new DiscountError(
      'self_decision',
      'A concession cannot be decided by the person who took the application. Ask someone else who holds concession:decide.'
    );
  }
  if (app.status === 'approved' && input.decision === 'approved') {
    throw new DiscountError('already_decided', 'That concession is already approved.');
  }

  const [policy] = await db.select().from(s.concessionPolicies)
    .where(eq(s.concessionPolicies.id, app.policyId)).limit(1);

  // The award is FROZEN onto the application from the policy as it stands now.
  // A concession granted under the 2026 policy keeps its 2026 terms after that
  // policy is superseded — the family was told a figure, and the federation has
  // to stand behind it.
  const award = input.decision === 'approved' && policy
    ? {
        awardedBasis: policy.basis,
        awardedAmountMinor: policy.amountMinor,
        awardedPercentPpm: policy.percentPpm,
        awardedMaxReductionMinor: policy.maxReductionMinor,
        awardedStage: policy.stage,
        validFrom: input.validFrom ?? policy.effectiveFrom ?? null,
        validTo: input.validTo ?? policy.effectiveTo ?? null,
      }
    : {};

  const [updated] = await db.update(s.concessionApplications)
    .set({
      status: input.decision as any,
      decidedAt: new Date(),
      updatedAt: new Date(),
      ...award,
    })
    .where(eq(s.concessionApplications.id, applicationId))
    .returning();

  // APPEND-ONLY. A concession granted and later revoked is two rows, because
  // "was this ever awarded?" is a question somebody asks after it is withdrawn.
  await db.insert(s.concessionApprovals).values({
    applicationId,
    decision: input.decision as any,
    decidedByUserId: decider,
    reason: why,
    authority: input.authority ?? null,
  });

  await writeAudit(db, { ...ctx, reason: why }, {
    entityType: 'concession_application', entityId: applicationId,
    action: input.decision === 'approved' ? 'approve' : input.decision === 'revoked' ? 'revoke' : 'reject',
    oldValue: { status: app.status },
    newValue: { status: input.decision, ref: app.ref, decidedBy: decider, takenBy: app.submittedByUserId ?? null },
  });

  return updated;
}

/**
 * Turn an APPROVED concession into a reduction.
 *
 * READ WHAT THIS SELECTS. It never reads `statedCircumstance` and never reads
 * `evidenceRef`, so the operator preparing a quotation learns that a concession
 * of a certain size applies and does NOT learn why. That is the separation
 * doing real work rather than being asserted in a comment: the column is not in
 * the query, so it cannot reach the quotation surface however that surface is
 * written later.
 *
 * Which is also why this needs no 'concession:read'. The caller already holds
 * 'quote:issue'; what they receive here is an amount, not a case.
 */
export async function resolveConcession(
  db: DB, applicationId: number, opts: { asAt?: string } = {}
): Promise<{ reduction: Reduction | null; refused: string | null }> {
  const asAt = opts.asAt ?? new Date().toISOString().slice(0, 10);

  const rows = await db.select({
    id: s.concessionApplications.id,
    ref: s.concessionApplications.ref,
    status: s.concessionApplications.status,
    policyId: s.concessionApplications.policyId,
    validFrom: s.concessionApplications.validFrom,
    validTo: s.concessionApplications.validTo,
    awardedBasis: s.concessionApplications.awardedBasis,
    awardedAmountMinor: s.concessionApplications.awardedAmountMinor,
    awardedPercentPpm: s.concessionApplications.awardedPercentPpm,
    awardedMaxReductionMinor: s.concessionApplications.awardedMaxReductionMinor,
    awardedStage: s.concessionApplications.awardedStage,
  })
    .from(s.concessionApplications)
    .where(eq(s.concessionApplications.id, applicationId))
    .limit(1);

  const app = rows[0];
  if (!app) return { reduction: null, refused: 'No such concession application.' };
  if (app.status !== 'approved') {
    return { reduction: null, refused: `That concession is ${app.status}, not approved.` };
  }
  if (!dateWithin(asAt, app.validFrom, app.validTo)) {
    return { reduction: null, refused: 'That concession is outside its validity dates.' };
  }
  if (!app.awardedBasis) {
    return { reduction: null, refused: 'That concession carries no award.' };
  }

  const [policy] = await db.select({
    code: s.concessionPolicies.code,
    title: s.concessionPolicies.title,
    category: s.concessionPolicies.category,
  }).from(s.concessionPolicies).where(eq(s.concessionPolicies.id, app.policyId)).limit(1);

  return {
    reduction: {
      // THE STAMP, second and last site. Both are in this file, both build the
      // amount from a database row.
      [RESOLVED_BY_SERVER]: true,
      source: 'concession',
      sourceCode: policy?.code ?? 'CONCESSION',
      // The policy TITLE, not the category and not the circumstance. A quote a
      // school's bursar reads should not announce "hardship" beside a child's
      // name.
      label: policy?.title ?? 'Concession',
      stage: (app.awardedStage ?? 'before_tax') as ReductionStage,
      basis: app.awardedBasis as any,
      amountMinor: app.awardedAmountMinor,
      percentPpm: app.awardedPercentPpm,
      maxReductionMinor: app.awardedMaxReductionMinor,
      because: `concession ${app.ref} approved by the federation`,
      requiresApproval: false,
      discountCodeId: null,
      concessionApplicationId: app.id,
    },
    refused: null,
  };
}

// ─── Quoting with reductions ────────────────────────────────────────────────

export interface ReducedQuote extends IssuedQuote {
  /** Codes that did not apply, and why — so the customer is told, not ignored. */
  refused: Array<{ code: string; reason: string }>;
  /** Malformed entries in the request, described by type and never echoed. */
  rejected: string[];
  concessionRefused: string | null;
}

/**
 * Issue a quotation with any discounts and concessions applied as LINES.
 *
 * `discountRequest` is the RAW request body. It is handed to
 * parseDiscountRequest() here rather than being pre-parsed by a route, so there
 * is exactly one place where client input becomes codes and no route can skip
 * it by accident.
 */
export async function quoteWithReductions(
  db: DB, ctx: AuditContext,
  input: {
    frameworkId: number;
    inputs: FeeInputs;
    requestId?: number | null;
    institutionId?: number | null;
    personId?: number | null;
    validUntil?: string | null;
    /** Whatever arrived from the client. Trusted for CODES and nothing else. */
    discountRequest?: unknown;
    concessionApplicationId?: number | null;
    subject?: DiscountSubject;
  }
): Promise<ReducedQuote> {
  const { codes, rejected } = parseDiscountRequest(input.discountRequest);

  const subject: DiscountSubject = {
    institutionId: input.institutionId ?? null,
    personId: input.personId ?? null,
    ...(input.subject ?? {}),
  };

  const { applied, refused } = codes.length
    ? await resolveDiscountCodes(db, { codes, inputs: input.inputs, subject })
    : { applied: [] as Reduction[], refused: [] as ResolvedDiscounts['refused'] };

  let concessionRefused: string | null = null;
  if (input.concessionApplicationId != null) {
    const c = await resolveConcession(db, input.concessionApplicationId);
    if (c.reduction) applied.push(c.reduction);
    else concessionRefused = c.refused;
  }

  const quote = await issueQuote(db, ctx, {
    requestId: input.requestId ?? null,
    institutionId: input.institutionId ?? null,
    personId: input.personId ?? null,
    frameworkId: input.frameworkId,
    inputs: input.inputs,
    validUntil: input.validUntil ?? null,
    reductions: applied,
  });

  return { ...quote, refused, rejected, concessionRefused };
}

// ─── Redemption ─────────────────────────────────────────────────────────────

/**
 * Record that the discounts on a quotation were actually taken up.
 *
 * SEPARATE FROM QUOTING, deliberately. Somebody trying a code on the estimator
 * must not consume a campaign's cap, and a quotation that is re-versioned four
 * times is one redemption, not four.
 *
 * IDEMPOTENT. The partial unique index on (code_id, quote_version_id) makes the
 * insert a no-op on repeat, and the counter is bumped only for the rows that
 * were actually inserted — so calling this twice for one quotation leaves ONE
 * redemption and ONE increment. tests/discounts.test.ts calls it twice and
 * asserts exactly that.
 */
export async function redeemForQuoteVersion(
  db: DB, ctx: AuditContext, quoteVersionId: number
): Promise<{ recorded: number; alreadyRecorded: number }> {
  assertCan(ctx.principal, 'quote:issue', {});

  const [qv] = await db.select().from(s.quoteVersions)
    .where(eq(s.quoteVersions.id, quoteVersionId)).limit(1);
  if (!qv) throw new DiscountError('unknown_quote_version', 'No such quotation version.');

  const [quote] = await db.select().from(s.quotes)
    .where(eq(s.quotes.id, qv.quoteId)).limit(1);

  const lines = await db.select().from(s.quoteLines)
    .where(and(
      eq(s.quoteLines.quoteVersionId, quoteVersionId),
      eq(s.quoteLines.sourceKind, 'discount'),
    ));

  let recorded = 0;
  let alreadyRecorded = 0;
  for (const line of lines) {
    if (line.discountCodeId == null) continue;
    const inserted = await db.insert(s.discountRedemptions).values({
      codeId: line.discountCodeId,
      quoteVersionId,
      institutionId: quote?.institutionId ?? null,
      personId: quote?.personId ?? null,
      amountMinor: Math.abs(line.amountMinor),
      recordedByUserId: ctx.principal.userId ?? null,
    })
      .onConflictDoNothing()
      .returning({ id: s.discountRedemptions.id });

    if (inserted.length) {
      recorded += 1;
      // Bumped only when a row was actually inserted. Incrementing outside that
      // branch is exactly how a retried request overcounts a campaign.
      await db.update(s.discountCodes)
        .set({ redeemedCount: sql`${s.discountCodes.redeemedCount} + 1`, updatedAt: new Date() })
        .where(eq(s.discountCodes.id, line.discountCodeId));
    } else {
      alreadyRecorded += 1;
    }
  }

  if (recorded) {
    await writeAudit(db, ctx, {
      entityType: 'quote', entityId: qv.quoteId, action: 'update',
      newValue: { quoteVersionId, redemptionsRecorded: recorded },
    });
  }
  return { recorded, alreadyRecorded };
}

// ─── Reporting ──────────────────────────────────────────────────────────────

/**
 * What the federation's discount campaigns cost it.
 *
 * READ THE WHERE CLAUSE. `sourceKind = 'discount'` is the whole point of that
 * column existing: this query CANNOT return a concession, because a concession
 * line is not a discount line and no widening of this function reaches one. A
 * marketing report that had to remember to exclude hardship would eventually
 * forget.
 *
 * It also returns rule codes and not redeemed tokens: a campaign report is
 * circulated more widely than the codes are.
 */
export async function marketingDiscountReport(
  db: DB, principal: Principal
): Promise<Array<{ ruleCode: string | null; label: string; lines: number; totalMinor: number; formatted: string }>> {
  if (!canAnywhere(principal, 'report:read') && !canAnywhere(principal, 'finance:read')) {
    throw new DiscountError('forbidden', 'Reading the discount report requires report:read or finance:read.');
  }

  const rows = await db.select({
    ruleCode: s.quoteLines.ruleCode,
    label: s.quoteLines.label,
    lines: sql<number>`count(*)::int`,
    totalMinor: sql<number>`coalesce(sum(${s.quoteLines.amountMinor}), 0)::int`,
  })
    .from(s.quoteLines)
    .where(eq(s.quoteLines.sourceKind, 'discount'))
    .groupBy(s.quoteLines.ruleCode, s.quoteLines.label);

  return rows.map((r: any) => ({ ...r, formatted: formatINR(r.totalMinor) }));
}

/**
 * The concession caseload, for the people entitled to see it.
 *
 * Gated on 'concession:read' and scope-filtered as a SQL PREDICATE through
 * visibleScopes(), not by fetching everything and filtering afterwards — a
 * district officer must not have the national caseload in memory on the way to
 * being shown their own.
 *
 * `statedCircumstance` is returned only when the caller asks for it explicitly.
 * A list screen does not need it, and a list that carries it by default is a
 * list that ends up in an export.
 */
export async function concessionCaseload(
  db: DB, principal: Principal, opts: { includeCircumstance?: boolean } = {}
) {
  if (!canAnywhere(principal, 'concession:read')) {
    throw new DiscountError('forbidden', 'Reading concession applications requires concession:read.');
  }

  const scopes = visibleScopes(principal, 'concession:read');
  if (scopes.kind === 'none') return [];

  const columns: Record<string, unknown> = {
    id: s.concessionApplications.id,
    ref: s.concessionApplications.ref,
    status: s.concessionApplications.status,
    policyId: s.concessionApplications.policyId,
    personId: s.concessionApplications.personId,
    institutionId: s.concessionApplications.institutionId,
    submittedAt: s.concessionApplications.submittedAt,
    submittedByUserId: s.concessionApplications.submittedByUserId,
    decidedAt: s.concessionApplications.decidedAt,
    awardedAmountMinor: s.concessionApplications.awardedAmountMinor,
    awardedPercentPpm: s.concessionApplications.awardedPercentPpm,
    confidential: s.concessionApplications.confidential,
    stateUnitId: s.persons.stateUnitId,
    districtUnitId: s.persons.districtUnitId,
    dojoId: s.persons.dojoId,
  };
  if (opts.includeCircumstance) {
    columns.statedCircumstance = s.concessionApplications.statedCircumstance;
  }

  let query = db.select(columns as any)
    .from(s.concessionApplications)
    .leftJoin(s.persons, eq(s.concessionApplications.personId, s.persons.id));

  if (scopes.kind === 'scoped') {
    const predicates = [];
    if (scopes.states.length) predicates.push(inArray(s.persons.stateUnitId, scopes.states));
    if (scopes.districts.length) predicates.push(inArray(s.persons.districtUnitId, scopes.districts));
    if (scopes.dojos.length) predicates.push(inArray(s.persons.dojoId, scopes.dojos));
    if (scopes.institutions.length) {
      predicates.push(inArray(s.concessionApplications.institutionId, scopes.institutions));
    }
    // A scoped caller with no matching predicate sees nothing, not everything.
    if (!predicates.length) return [];
    query = query.where(or(...predicates));
  }

  return query.orderBy(asc(s.concessionApplications.createdAt));
}

/**
 * Is anything configured at all?
 *
 * The honest answer today is no, and every surface needs to be able to say so
 * calmly rather than rendering an empty table that looks like a fault.
 */
export async function policyState(db: DB) {
  const [discounts] = await db.select({ n: sql<number>`count(*)::int` })
    .from(s.discountPolicies).where(eq(s.discountPolicies.status, 'published'));
  const [concessions] = await db.select({ n: sql<number>`count(*)::int` })
    .from(s.concessionPolicies).where(eq(s.concessionPolicies.status, 'published'));

  const publishedDiscounts = discounts?.n ?? 0;
  const publishedConcessions = concessions?.n ?? 0;
  return {
    publishedDiscounts,
    publishedConcessions,
    summary: publishedDiscounts || publishedConcessions
      ? `${publishedDiscounts} discount and ${publishedConcessions} concession policies are in force.`
      : 'The federation has published no discount policy and no concession policy, so no reduction can be applied to any quotation.',
  };
}
