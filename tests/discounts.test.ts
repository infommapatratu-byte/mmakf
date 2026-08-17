// Discount and concession policy.
//
// Three properties are asserted here and everything else is supporting work.
//
//   1. A CLIENT CAN SUPPLY A CODE AND CAN NEVER SUPPLY AN AMOUNT. The forged
//      request is submitted for real, against a real framework, and the total
//      is compared with the same request carrying no forgery at all.
//
//   2. A DISCOUNT IS AN EXPLAINED LINE, not a subtraction from a total. Every
//      reduction carries the rule that produced it, the running total after it
//      and a sentence, and subtotal + adjustment + tax still equals total.
//
//   3. A HARDSHIP CASE NEVER REACHES A MARKETING REPORT. Asserted against the
//      report function itself, with a concession sitting in the same quotation.
//
// And the one that is easiest to lose: BOTH SHIP EMPTY. MMAKF has approved no
// discount policy and no concession policy, and the migration seeds neither.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  createFramework, addRule, publishFramework, computeFee, reproduce,
  explainQuote, PPM, isFeeError,
} from '../src/db/fees';
import {
  parseDiscountRequest, normaliseCode, MAX_CODES_PER_REQUEST,
  createDiscountPolicy, addDiscountRule, publishDiscountPolicy,
  issueDiscountCode, addDiscountEligibility, setDiscountCodeStatus,
  resolveDiscountCodes, quoteWithReductions, redeemForQuoteVersion,
  submitConcessionApplication, decideConcessionApplication, resolveConcession,
  marketingDiscountReport, concessionCaseload, policyState, isDiscountError,
} from '../src/db/discounts';
import type { Principal } from '../src/lib/rbac';

let db: any;
let FW: number;
let SVC: number;
let SCHOOL: number;

// ─── Principals ─────────────────────────────────────────────────────────────
//
// Chosen so the SEPARATIONS are exercised rather than assumed. If one principal
// held everything, every access check below would pass vacuously.

/** Authors and publishes the fee framework AND the discount policy. */
const finance: Principal = {
  userId: 1, label: 'finance',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
/** Issues quotations. Holds neither approval action. */
const ops: Principal = {
  userId: 2, label: 'ops',
  bindings: [{ role: 'TRAINING_OPERATIONS', scopeType: 'national', scopeId: null }],
};
/** Holds quote:approve — and, deliberately, NOT concession:decide. */
const director: Principal = {
  userId: 3, label: 'director',
  bindings: [{ role: 'TRAINING_DIRECTOR', scopeType: 'national', scopeId: null }],
};
/** Holds concession:read and concession:decide. */
const safeguarding: Principal = {
  userId: 4, label: 'safeguarding',
  bindings: [{ role: 'SAFEGUARDING_OFFICER', scopeType: 'national', scopeId: null }],
};
/** A second concession decider, so the self-decision bar can be cleared. */
const superAdmin: Principal = {
  userId: 5, label: 'super',
  bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
};

const financeCtx = { principal: finance };
const opsCtx = { principal: ops };
const safeguardingCtx = { principal: safeguarding };
const superCtx = { principal: superAdmin };

// Every figure below is a TEST FIXTURE. None of it is an MMAKF fee, an MMAKF
// discount or an MMAKF concession — the federation has published none, which is
// why the tables ship empty and this file has to build its own.
const BASE_MINOR = 5_000_000;        // ₹50,000
const PER_CHILD_MINOR = 45_000;      // ₹450
const TAX_PPM = 1_180_000;           // ×1.18

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  await db.insert(s.users).values([
    { id: 1, email: 'finance@mmakf.in', status: 'active' },
    { id: 2, email: 'ops@mmakf.in', status: 'active' },
    { id: 3, email: 'director@mmakf.in', status: 'active' },
    { id: 4, email: 'safeguarding@mmakf.in', status: 'active' },
    { id: 5, email: 'super@mmakf.in', status: 'active' },
  ]);

  const [svc] = await db.insert(s.services).values({
    code: 'MMAKF-SVC-SCHOOL-KARATE', slug: 'school-karate',
    title: 'School karate programme', category: 'training', status: 'published',
  }).returning({ id: s.services.id });
  SVC = svc.id;

  const [inst] = await db.insert(s.institutions).values({
    code: 'MMAKF-INST-2026-000001', name: 'Test School', kind: 'school', status: 'active',
  }).returning({ id: s.institutions.id });
  SCHOOL = inst.id;

  const fw = await createFramework(db, financeCtx, { title: 'Test framework', version: 1 });
  FW = fw.id;
  await addRule(db, financeCtx, FW, {
    code: 'BASE-SCHOOL', label: 'School programme base', kind: 'base',
    audience: 'school', amountMinor: BASE_MINOR, sortOrder: 10,
  });
  await addRule(db, financeCtx, FW, {
    code: 'PER-CHILD', label: 'Per participant', kind: 'per_participant',
    audience: 'school', amountMinor: PER_CHILD_MINOR, sortOrder: 20,
  });
  await addRule(db, financeCtx, FW, {
    code: 'GST', label: 'Tax', kind: 'tax',
    audience: 'school', factorPpm: TAX_PPM, sortOrder: 90,
  });
  await publishFramework(db, financeCtx, FW);
}, 180_000);

const schoolInputs = { audience: 'school', participants: 100, serviceCode: 'MMAKF-SVC-SCHOOL-KARATE' };

/** The undiscounted figure, recomputed rather than written down. */
async function plainTotal() {
  return (await computeFee(db, FW, schoolInputs)).totalMinor;
}

// ════════════════════════════════════════════════════════════════════════════
describe('the federation has approved no discount and no concession', () => {
  it('ships both tables EMPTY', async () => {
    for (const table of [
      s.discountPolicies, s.discountRules, s.discountCodes, s.discountEligibility,
      s.discountApprovals, s.discountRedemptions,
      s.concessionPolicies, s.concessionApplications, s.concessionApprovals,
    ]) {
      const rows = await db.select().from(table);
      expect(rows.length, 'the migration seeded a policy MMAKF has not approved').toBe(0);
    }
  });

  it('seeds nothing from the migration itself', () => {
    // Structural, not a spot check. A future edit that adds a "sensible"
    // starter policy fails here rather than quietly becoming the federation's
    // commercial position.
    //
    // The file is FOUND rather than named. Migration numbers are renumbered
    // when parallel work lands, and a test that hardcodes one fails for a
    // reason that has nothing to do with what it is checking.
    const files = readdirSync('drizzle').filter((f) => f.endsWith('.sql'));
    const mine = files.filter((f) => /CREATE TABLE "discount_policies"/.test(readFileSync(`drizzle/${f}`, 'utf8')));
    expect(mine.length, 'the discount migration is missing, or there are two of it').toBe(1);
    expect(readFileSync(`drizzle/${mine[0]}`, 'utf8')).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it('says so plainly rather than rendering an empty table', async () => {
    const state = await policyState(db);
    expect(state.publishedDiscounts).toBe(0);
    expect(state.publishedConcessions).toBe(0);
    expect(state.summary).toMatch(/published no discount policy/i);
  });

  it('hardcodes no percentage anywhere in the module', () => {
    // Every discount is a stored rule. If a rate is ever assigned from a
    // literal, this is where it stops.
    const src = readFileSync('src/db/discounts.ts', 'utf8');
    expect(src, 'a percentage was assigned from a literal').not.toMatch(/(percentPpm|percent_ppm|factorPpm)\s*[:=]\s*[0-9]/);
    expect(src, 'a float rate appeared').not.toMatch(/\b0\.\d+/);
    expect(src, 'a divide-by-a-hundred appeared').not.toMatch(/\/\s*100\b/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('THE SECURITY PROPERTY: a code may be supplied, an amount may not', () => {
  let CODE_ID: number;

  beforeAll(async () => {
    const policy = await createDiscountPolicy(db, financeCtx, { title: 'Test discounts', version: 1 });
    await addDiscountRule(db, financeCtx, policy.id, {
      code: 'VOLUME-100', label: 'Volume band', basis: 'percentage',
      percentPpm: 100_000,                         // 10% — A TEST FIXTURE
      conditions: { participants: { min: 50 } },
      audience: 'school', stage: 'before_tax',
    });
    await publishDiscountPolicy(db, financeCtx, policy.id);
    const [rule] = await db.select().from(s.discountRules).where(eq(s.discountRules.code, 'VOLUME-100'));
    const code = await issueDiscountCode(db, financeCtx, rule.id, { code: 'volume100', activate: true });
    CODE_ID = code.id;
  });

  it('parses a body carrying a forged amount into codes and nothing else', () => {
    const forged = {
      codes: ['VOLUME100'],
      amountMinor: -99_999_999,
      discountMinor: -12_345,
      reductionMinor: -1,
      percentPpm: 900_000,
      totalMinor: 1,
    };
    const parsed = parseDiscountRequest(forged);
    expect(parsed.codes).toEqual(['VOLUME100']);
    // Not "the forged keys were deleted" — the result has no shape they could
    // occupy, because the output is constructed rather than filtered.
    expect(Object.keys(parsed).sort()).toEqual(['codes', 'rejected']);
  });

  it('IGNORES the forged amount end to end, and the totals are identical', async () => {
    const honest = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['VOLUME100'] },
    });
    const forged = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: {
        codes: ['VOLUME100'],
        amountMinor: -99_999_999,
        discountMinor: -99_999_999,
        totalMinor: 1,
        reductions: [{ source: 'discount', basis: 'fixed_amount', amountMinor: 99_999_999 }],
      },
    });

    expect(forged.computation.totalMinor).toBe(honest.computation.totalMinor);
    expect(forged.computation.discountMinor).toBe(honest.computation.discountMinor);
    // And the reduction is the one the SERVER computed from the stored rule,
    // not anything resembling the forged figure.
    expect(forged.computation.discountMinor).toBeLessThan(0);
    expect(Math.abs(forged.computation.discountMinor)).not.toBe(99_999_999);
    expect(forged.computation.totalMinor).toBeGreaterThan(0);
  });

  it('refuses a reduction that did not come from the resolver at all', async () => {
    // The structural lock behind the parsing. A hand-built reduction — which is
    // exactly what a deserialised request body is — is rejected by
    // construction, because it cannot carry the symbol.
    const handBuilt: any = {
      source: 'discount', sourceCode: 'FORGED', label: 'Forged',
      stage: 'before_tax', basis: 'fixed_amount', amountMinor: 4_000_000,
      because: 'because I said so',
    };
    await expect(
      computeFee(db, FW, schoolInputs, { reductions: [handBuilt] })
    ).rejects.toThrow(/did not come from the server/i);

    try {
      await computeFee(db, FW, schoolInputs, { reductions: [handBuilt] });
    } catch (err) {
      expect(isFeeError(err)).toBe(true);
      expect((err as any).code).toBe('unresolved_reduction');
    }
  });

  it('normalises what it accepts and refuses what it cannot use', () => {
    expect(normaliseCode(' volume100 ')).toBe('VOLUME100');
    expect(normaliseCode('a b')).toBeNull();
    expect(normaliseCode('drop; table')).toBeNull();
    expect(normaliseCode(42)).toBeNull();
    expect(normaliseCode('x'.repeat(400))).toBeNull();

    const parsed = parseDiscountRequest({ codes: ['VOLUME100', 'volume100', 'nope!!', 7] });
    expect(parsed.codes).toEqual(['VOLUME100']);          // deduplicated
    expect(parsed.rejected.length).toBe(2);
    // The rejection never echoes the client's own text back at them.
    expect(parsed.rejected.join(' ')).not.toContain('nope');
  });

  it('caps how many codes one request may carry', () => {
    const many = Array.from({ length: 40 }, (_, i) => `CODE${i}`);
    expect(parseDiscountRequest({ codes: many }).codes.length).toBe(MAX_CODES_PER_REQUEST);
  });

  it('resolves an unknown code to a refusal, never to a reduction', async () => {
    const r = await resolveDiscountCodes(db, { codes: ['NOT-A-REAL-CODE'], inputs: schoolInputs });
    expect(r.applied).toEqual([]);
    expect(r.refused[0].reason).toMatch(/not a code the federation has issued/i);
  });

  it('keeps the redeemed token off the stored quote line', async () => {
    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['VOLUME100'] },
    });
    const line = q.computation.lines.find((l) => l.source === 'discount')!;
    // The RULE code, which is internal vocabulary, not the token that may have
    // been given to one school in confidence.
    expect(line.ruleCode).toBe('VOLUME-100');
    expect(line.ruleCode).not.toBe('VOLUME100');
    expect(line.discountCodeId).toBe(CODE_ID);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a discount is an explained LINE, not a subtraction from a total', () => {
  it('records the rule, the running total and a sentence', async () => {
    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['VOLUME100'] },
    });
    const line = q.computation.lines.find((l) => l.source === 'discount')!;
    expect(line).toBeTruthy();
    expect(line.kind).toBe('discount');
    expect(line.label).toBe('Volume band');
    expect(line.amountMinor).toBeLessThan(0);
    expect(line.because).toMatch(/discount applied/);
    expect(line.runningTotalMinor).toBe(
      q.computation.lines[q.computation.lines.indexOf(line) - 1].runningTotalMinor + line.amountMinor
    );
  });

  it('keeps subtotal + adjustment + tax = total', async () => {
    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['VOLUME100'] },
    });
    const c = q.computation;
    expect(c.subtotalMinor + c.adjustmentMinor + c.taxMinor).toBe(c.totalMinor);
    expect(c.discountMinor + c.concessionMinor).toBe(c.adjustmentMinor);
  });

  it('survives the round trip to the database and back', async () => {
    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['VOLUME100'] },
    });
    const explained = await explainQuote(db, ops, q.quoteId ? await latestVersionId(q.quoteId) : 0);
    const stored = explained.lines.find((l: any) => l.sourceKind === 'discount');
    expect(stored, 'the discount line was not persisted').toBeTruthy();
    expect(stored.ruleCode).toBe('VOLUME-100');
    expect(stored.reductionStage).toBe('before_tax');
    expect(explained.narrative.some((n: string) => /Volume band/.test(n))).toBe(true);
  });

  it('reproduces a discounted quotation exactly', async () => {
    // The reduction is REPLAYED from the frozen line, not re-resolved. A code
    // that expires tomorrow must not make a quotation issued today
    // unreproducible.
    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['VOLUME100'] },
    });
    const vId = await latestVersionId(q.quoteId);
    const again = await reproduce(db, vId);
    expect(again.matches).toBe(true);
    expect(again.recomputed.totalMinor).toBe(again.stored.totalMinor);
    expect(again.recomputed.discountMinor).toBe(again.stored.discountMinor);
  });

  it('still reproduces after the code has been suspended', async () => {
    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['VOLUME100'] },
    });
    const vId = await latestVersionId(q.quoteId);

    const [code] = await db.select().from(s.discountCodes).where(eq(s.discountCodes.code, 'VOLUME100'));
    await setDiscountCodeStatus(db, financeCtx, code.id, 'suspended', 'campaign closed for the test');
    try {
      const again = await reproduce(db, vId);
      expect(again.matches, 'a suspended code broke a quotation already issued').toBe(true);
    } finally {
      await setDiscountCodeStatus(db, financeCtx, code.id, 'active', 'restoring the fixture');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('the arithmetic the money rules demand', () => {
  it('computes a percentage through applyFactor, in integer paise', async () => {
    const plain = await computeFee(db, FW, schoolInputs);
    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['VOLUME100'] },
    });

    // The pre-tax subtotal, times the rate, as integers. Written out here so
    // the assertion is arithmetic rather than a restatement of the code.
    const preTax = BASE_MINOR + PER_CHILD_MINOR * 100;
    const expectedReduction = Math.round((preTax * 100_000) / PPM);
    expect(q.computation.discountMinor).toBe(-expectedReduction);
    expect(Number.isInteger(q.computation.totalMinor)).toBe(true);
    expect(q.computation.totalMinor).toBeLessThan(plain.totalMinor);
  });

  it('applies a before_tax discount BEFORE the tax, so the tax falls too', async () => {
    const plain = await computeFee(db, FW, schoolInputs);
    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['VOLUME100'] },
    });
    expect(q.computation.taxMinor).toBeLessThan(plain.taxMinor);
  });

  it('applies an after_tax discount to the tax-inclusive total, leaving the tax alone', async () => {
    const policy = await createDiscountPolicy(db, financeCtx, { title: 'After-tax discounts', version: 2 });
    await addDiscountRule(db, financeCtx, policy.id, {
      code: 'GOODWILL', label: 'Goodwill reduction', basis: 'fixed_amount',
      amountMinor: 100_000, stage: 'after_tax', audience: 'school',
    });
    await publishDiscountPolicy(db, financeCtx, policy.id);
    const [rule] = await db.select().from(s.discountRules).where(eq(s.discountRules.code, 'GOODWILL'));
    await issueDiscountCode(db, financeCtx, rule.id, { code: 'GOODWILL1', activate: true });

    const plain = await computeFee(db, FW, schoolInputs);
    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['GOODWILL1'] },
    });
    expect(q.computation.taxMinor).toBe(plain.taxMinor);
    expect(q.computation.totalMinor).toBe(plain.totalMinor - 100_000);
    const line = q.computation.lines.find((l) => l.source === 'discount')!;
    expect(line.reductionStage).toBe('after_tax');
  });

  it('NEVER lets a reduction take a total below zero', async () => {
    const policy = await createDiscountPolicy(db, financeCtx, { title: 'Absurd discounts', version: 3 });
    await addDiscountRule(db, financeCtx, policy.id, {
      code: 'ABSURD', label: 'Larger than the fee', basis: 'fixed_amount',
      amountMinor: 999_999_999, stage: 'after_tax', audience: 'school',
    });
    await publishDiscountPolicy(db, financeCtx, policy.id);
    const [rule] = await db.select().from(s.discountRules).where(eq(s.discountRules.code, 'ABSURD'));
    await issueDiscountCode(db, financeCtx, rule.id, { code: 'ABSURD1', activate: true });

    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['ABSURD1'] },
    });
    expect(q.computation.totalMinor).toBe(0);
    const line = q.computation.lines.find((l) => l.source === 'discount')!;
    expect(line.because).toMatch(/cannot fall below zero/i);
  });

  it('honours a cap on a percentage, and says it capped it', async () => {
    const policy = await createDiscountPolicy(db, financeCtx, { title: 'Capped discounts', version: 4 });
    await addDiscountRule(db, financeCtx, policy.id, {
      code: 'CAPPED', label: 'Capped band', basis: 'percentage',
      percentPpm: 500_000, maxReductionMinor: 50_000, audience: 'school',
    });
    await publishDiscountPolicy(db, financeCtx, policy.id);
    const [rule] = await db.select().from(s.discountRules).where(eq(s.discountRules.code, 'CAPPED'));
    await issueDiscountCode(db, financeCtx, rule.id, { code: 'CAPPED1', activate: true });

    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['CAPPED1'] },
    });
    expect(q.computation.discountMinor).toBe(-50_000);
    expect(q.computation.lines.find((l) => l.source === 'discount')!.because).toMatch(/capped at/i);
  });

  it('applies NO discount when nothing was priced', async () => {
    // A discount on a request that requires a manual quotation would produce a
    // negative total on a quotation carrying no figure at all.
    const c = await computeFee(db, FW, { audience: 'corporate', participants: 100 });
    expect(c.requiresManualQuote).toBe(true);

    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: { audience: 'corporate', participants: 100 },
      discountRequest: { codes: ['GOODWILL1'] },
    });
    expect(q.computation.requiresManualQuote).toBe(true);
    expect(q.computation.totalMinor).toBe(0);
    expect(q.computation.lines.length).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a code has to still be usable', () => {
  it('refuses a suspended code with a reason and applies nothing', async () => {
    const [code] = await db.select().from(s.discountCodes).where(eq(s.discountCodes.code, 'CAPPED1'));
    await setDiscountCodeStatus(db, financeCtx, code.id, 'suspended', 'campaign paused');

    const r = await resolveDiscountCodes(db, { codes: ['CAPPED1'], inputs: schoolInputs });
    expect(r.applied).toEqual([]);
    expect(r.refused[0].reason).toMatch(/suspended/i);
  });

  it('refuses a code outside its validity window', async () => {
    const [rule] = await db.select().from(s.discountRules).where(eq(s.discountRules.code, 'GOODWILL'));
    await issueDiscountCode(db, financeCtx, rule.id, {
      code: 'LAPSED1', activate: true,
      validTo: new Date(Date.now() - 86_400_000),
    });
    const r = await resolveDiscountCodes(db, { codes: ['LAPSED1'], inputs: schoolInputs });
    expect(r.applied).toEqual([]);
    expect(r.refused[0].reason).toMatch(/validity dates/i);
  });

  it('refuses a code that has reached its usage cap', async () => {
    const [rule] = await db.select().from(s.discountRules).where(eq(s.discountRules.code, 'GOODWILL'));
    const code = await issueDiscountCode(db, financeCtx, rule.id, {
      code: 'ONESHOT', activate: true, maxRedemptions: 1,
    });
    await db.update(s.discountCodes).set({ redeemedCount: 1 }).where(eq(s.discountCodes.id, code.id));

    const r = await resolveDiscountCodes(db, { codes: ['ONESHOT'], inputs: schoolInputs });
    expect(r.applied).toEqual([]);
    expect(r.refused[0].reason).toMatch(/number of times/i);
  });

  it('refuses a customer the code was not issued to', async () => {
    const [rule] = await db.select().from(s.discountRules).where(eq(s.discountRules.code, 'GOODWILL'));
    const code = await issueDiscountCode(db, financeCtx, rule.id, { code: 'ONESCHOOL', activate: true });
    await addDiscountEligibility(db, financeCtx, code.id, { kind: 'institution', id: SCHOOL + 999 });

    const mine = await resolveDiscountCodes(db, {
      codes: ['ONESCHOOL'], inputs: schoolInputs, subject: { institutionId: SCHOOL },
    });
    expect(mine.applied).toEqual([]);
    expect(mine.refused[0].reason).toMatch(/not eligible/i);

    // And the school it WAS issued to still gets it.
    const theirs = await resolveDiscountCodes(db, {
      codes: ['ONESCHOOL'], inputs: schoolInputs, subject: { institutionId: SCHOOL + 999 },
    });
    expect(theirs.applied.length).toBe(1);
  });

  it('refuses a per-customer capped code when the customer is anonymous', async () => {
    // Fail closed. A cap that silently does not apply to unidentified requests
    // is not a cap.
    const [rule] = await db.select().from(s.discountRules).where(eq(s.discountRules.code, 'GOODWILL'));
    await issueDiscountCode(db, financeCtx, rule.id, { code: 'ONEPER', activate: true, maxPerSubject: 1 });
    const r = await resolveDiscountCodes(db, { codes: ['ONEPER'], inputs: schoolInputs });
    expect(r.applied).toEqual([]);
    expect(r.refused[0].reason).toMatch(/does not identify/i);
  });

  it('refuses to stack two discounts that are not stackable', async () => {
    const both = await resolveDiscountCodes(db, {
      codes: ['VOLUME100', 'GOODWILL1'], inputs: schoolInputs, subject: { institutionId: SCHOOL },
    });
    expect(both.applied.length).toBe(1);
    expect(both.refused.length).toBe(1);
    expect(both.refused[0].reason).toMatch(/cannot be combined/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a redemption happens once, however many times it is recorded', () => {
  it('is IDEMPOTENT — recording twice leaves one row and one increment', async () => {
    const [rule] = await db.select().from(s.discountRules).where(eq(s.discountRules.code, 'GOODWILL'));
    const code = await issueDiscountCode(db, financeCtx, rule.id, { code: 'COUNTME', activate: true });

    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['COUNTME'] },
    });
    const vId = await latestVersionId(q.quoteId);

    const first = await redeemForQuoteVersion(db, opsCtx, vId);
    const second = await redeemForQuoteVersion(db, opsCtx, vId);

    expect(first.recorded).toBe(1);
    expect(second.recorded).toBe(0);
    expect(second.alreadyRecorded).toBe(1);

    const rows = await db.select().from(s.discountRedemptions)
      .where(eq(s.discountRedemptions.codeId, code.id));
    expect(rows.length).toBe(1);

    const [after] = await db.select().from(s.discountCodes).where(eq(s.discountCodes.id, code.id));
    expect(after.redeemedCount, 'the counter moved twice for one redemption').toBe(1);
  });

  it('does not consume a cap merely because somebody tried the code', async () => {
    const [rule] = await db.select().from(s.discountRules).where(eq(s.discountRules.code, 'GOODWILL'));
    const code = await issueDiscountCode(db, financeCtx, rule.id, { code: 'JUSTLOOKING', activate: true });
    await resolveDiscountCodes(db, { codes: ['JUSTLOOKING'], inputs: schoolInputs });
    const [after] = await db.select().from(s.discountCodes).where(eq(s.discountCodes.id, code.id));
    expect(after.redeemedCount).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a published discount policy is frozen', () => {
  it('refuses a new rule on a published policy, and names the remedy', async () => {
    const [policy] = await db.select().from(s.discountPolicies)
      .where(eq(s.discountPolicies.code, 'MMAKF-DISCOUNT-V1'));
    await expect(
      addDiscountRule(db, financeCtx, policy.id, {
        code: 'SNEAKY', label: 'Added later', basis: 'fixed_amount', amountMinor: 1_000,
      })
    ).rejects.toThrow(/Publish a NEW version/);
  });

  it('refuses to publish a policy with no rules', async () => {
    const empty = await createDiscountPolicy(db, financeCtx, { title: 'Empty', version: 99 });
    await expect(publishDiscountPolicy(db, financeCtx, empty.id))
      .rejects.toThrow(/discount nothing while appearing configured/);
  });

  it('refuses a code minted from a draft policy', async () => {
    const draft = await createDiscountPolicy(db, financeCtx, { title: 'Draft', version: 98 });
    const rule = await addDiscountRule(db, financeCtx, draft.id, {
      code: 'DRAFTY', label: 'Draft rule', basis: 'fixed_amount', amountMinor: 1_000,
    });
    await expect(issueDiscountCode(db, financeCtx, rule.id, { code: 'DRAFTY1' }))
      .rejects.toThrow(/PUBLISHED policy/);
  });

  it('refuses authoring to anyone without feeframework:write', async () => {
    await expect(
      createDiscountPolicy(db, opsCtx, { title: 'Ops policy', version: 97 })
    ).rejects.toThrow(/Forbidden/);
  });

  it('refuses a rule that is neither an amount nor a percentage', async () => {
    const p = await createDiscountPolicy(db, financeCtx, { title: 'Malformed', version: 96 });
    await expect(
      addDiscountRule(db, financeCtx, p.id, { code: 'X', label: 'X', basis: 'percentage' })
    ).rejects.toThrow(/parts-per-million/);
    await expect(
      addDiscountRule(db, financeCtx, p.id, { code: 'Y', label: 'Y', basis: 'fixed_amount', amountMinor: -5_000 })
    ).rejects.toThrow(/POSITIVE amount in integer paise/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('a concession is not a discount', () => {
  let APP_ID: number;
  let PERSON_ID: number;

  beforeAll(async () => {
    const [person] = await db.insert(s.persons).values({
      federationId: 'MMAKF-MEM-2026-000001', fullName: 'Test Member', status: 'active',
    }).returning({ id: s.persons.id });
    PERSON_ID = person.id;

    const [policy] = await db.insert(s.concessionPolicies).values({
      code: 'MMAKF-CONCESSION-V1', title: 'Assisted place', version: 1,
      status: 'published', category: 'hardship',
      basis: 'percentage', percentPpm: 250_000, stage: 'before_tax',
      requiresEvidence: false, confidential: true,
    }).returning({ id: s.concessionPolicies.id });

    const app = await submitConcessionApplication(db, { principal: finance }, {
      policyId: policy.id,
      personId: PERSON_ID,
      institutionId: SCHOOL,
      statedCircumstance: 'The family cannot meet the fee this year following a bereavement.',
    });
    APP_ID = app.id;
  });

  it('needs a DIFFERENT action from a discount approval', async () => {
    // A training director approves quotations all day and holds no concession
    // authority at all. That is the separation, stated as a test rather than as
    // an intention.
    await expect(
      decideConcessionApplication(db, { principal: director }, APP_ID, {
        decision: 'approved', reason: 'looks fine to me',
      })
    ).rejects.toThrow(/Forbidden/);
  });

  it('cannot be decided by the person who took the application', async () => {
    // The application was taken by `finance`, who also holds concession:read.
    // Give that same user the deciding action and it still refuses.
    const financeDecider: Principal = {
      userId: finance.userId, label: 'finance-as-decider',
      bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
    };
    await expect(
      decideConcessionApplication(db, { principal: financeDecider }, APP_ID, {
        decision: 'approved', reason: 'approving my own intake',
      })
    ).rejects.toThrow(/cannot be decided by the person who took the application/);
  });

  it('refuses a decision nobody can be named for', async () => {
    const ghost: Principal = {
      userId: null, label: 'script',
      bindings: [{ role: 'SUPER_ADMIN', scopeType: 'national', scopeId: null }],
    };
    await expect(
      decideConcessionApplication(db, { principal: ghost }, APP_ID, {
        decision: 'approved', reason: 'automated approval',
      })
    ).rejects.toThrow(/attributable/i);
  });

  it('refuses a decision with no reason', async () => {
    await expect(
      decideConcessionApplication(db, safeguardingCtx, APP_ID, { decision: 'rejected', reason: '' })
    ).rejects.toThrow(/must say why/i);
  });

  it('is decided by the safeguarding officer, and the award is FROZEN', async () => {
    const decided = await decideConcessionApplication(db, safeguardingCtx, APP_ID, {
      decision: 'approved', reason: 'Evidence reviewed and accepted by the office.',
      authority: 'Safeguarding office',
    });
    expect(decided.status).toBe('approved');
    expect(decided.awardedPercentPpm).toBe(250_000);

    // Append-only: the decision is a row, not a mutation of the application.
    const log = await db.select().from(s.concessionApprovals)
      .where(eq(s.concessionApprovals.applicationId, APP_ID));
    expect(log.length).toBe(1);
    expect(log[0].decidedByUserId).toBe(safeguarding.userId);
    expect(log[0].reason).toMatch(/Evidence reviewed/);
  });

  it('applies to a quotation WITHOUT disclosing why it was granted', async () => {
    const resolved = await resolveConcession(db, APP_ID);
    expect(resolved.reduction).toBeTruthy();
    const asText = JSON.stringify(resolved.reduction);
    expect(asText, 'the circumstance leaked into the reduction').not.toMatch(/bereavement/i);
    expect(asText).not.toMatch(/cannot meet the fee/i);
    // Nor does the category — a bursar reading the quotation should not be told
    // "hardship" beside a child's name.
    expect(resolved.reduction!.label).toBe('Assisted place');

    const q = await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      concessionApplicationId: APP_ID,
    });
    const line = q.computation.lines.find((l) => l.source === 'concession')!;
    expect(line).toBeTruthy();
    expect(q.computation.concessionMinor).toBeLessThan(0);
    expect(q.computation.discountMinor).toBe(0);
    expect(JSON.stringify(q.computation.lines)).not.toMatch(/bereavement/i);
  });

  it('refuses to apply a concession that was not approved', async () => {
    const [policy] = await db.select().from(s.concessionPolicies).limit(1);
    const pending = await submitConcessionApplication(db, { principal: finance }, {
      policyId: policy.id, personId: PERSON_ID, statedCircumstance: 'Pending review.',
    });
    const r = await resolveConcession(db, pending.id);
    expect(r.reduction).toBeNull();
    expect(r.refused).toMatch(/not approved/i);
  });

  it('KEEPS HARDSHIP OUT OF THE MARKETING REPORT', async () => {
    // The assertion the whole separation exists for. A quotation carrying both
    // a campaign discount and a hardship concession is in the database; the
    // marketing report sees the campaign and cannot see the concession.
    await quoteWithReductions(db, opsCtx, {
      frameworkId: FW, inputs: schoolInputs, institutionId: SCHOOL,
      discountRequest: { codes: ['VOLUME100'] },
      concessionApplicationId: APP_ID,
    });

    const report = await marketingDiscountReport(db, finance);
    expect(report.length).toBeGreaterThan(0);
    expect(report.some((r) => r.ruleCode === 'VOLUME-100')).toBe(true);
    expect(
      report.some((r) => r.ruleCode === 'MMAKF-CONCESSION-V1' || /assisted place/i.test(r.label)),
      'a concession appeared in a marketing report'
    ).toBe(false);

    // And structurally: every row it returns is a discount line.
    const codes = report.map((r) => r.ruleCode);
    const concessionLines = await db.select().from(s.quoteLines)
      .where(eq(s.quoteLines.sourceKind, 'concession'));
    expect(concessionLines.length, 'the fixture never produced a concession line to exclude').toBeGreaterThan(0);
    for (const l of concessionLines) expect(codes).not.toContain(l.ruleCode);
  });

  it('withholds the caseload from anyone without concession:read', async () => {
    await expect(concessionCaseload(db, ops)).rejects.toThrow(/concession:read/);
    await expect(concessionCaseload(db, director)).rejects.toThrow(/concession:read/);
  });

  it('does not put the stated circumstance in a list by default', async () => {
    const list = await concessionCaseload(db, safeguarding);
    expect(list.length).toBeGreaterThan(0);
    expect(Object.keys(list[0])).not.toContain('statedCircumstance');
    expect(JSON.stringify(list)).not.toMatch(/bereavement/i);

    const full = await concessionCaseload(db, safeguarding, { includeCircumstance: true });
    expect(JSON.stringify(full)).toMatch(/bereavement/i);
  });

  it('keeps the circumstance out of the audit spine', async () => {
    const events = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'concession_application'));
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events), 'a circumstance was copied into the audit record').not.toMatch(/bereavement/i);
  });
});

/** The newest version of a quote, which is what quoteWithReductions just wrote. */
async function latestVersionId(quoteId: number): Promise<number> {
  const rows = await db.select().from(s.quoteVersions).where(eq(s.quoteVersions.quoteId, quoteId));
  return rows.reduce((best: any, r: any) => (!best || r.version > best.version ? r : best), null).id;
}
