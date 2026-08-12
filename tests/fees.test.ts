// The unified fee engine.
//
// The federation's instruction was explicit: same inputs must give the same
// result, changed inputs must give a correspondingly changed result, and a
// HISTORICAL QUOTE MUST NEVER CHANGE. Those are not properties you assert in a
// comment. This file is where they become facts.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  applyFactor, formatINR, matchConditions, computeFee, createFramework, addRule,
  publishFramework, issueQuote, reproduce, explainQuote, activeFramework,
  isFeeError, FeeError, PPM,
} from '../src/db/fees';
import type { Principal } from '../src/lib/rbac';

let db: any;
let FW: number;          // a published framework
let SVC: number;

const finance: Principal = {
  userId: 1, label: 'finance', bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 2, label: 'athlete', bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};
const ctx = { principal: finance };

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  // The principals below carry userId 1 and 2, and published_by_user_id is a
  // real foreign key. Creating the rows is the fixture; the FK firing was
  // correct behaviour, not a bug.
  await db.insert(s.users).values([
    { id: 1, email: 'finance@mmakf.in', status: 'active' },
    { id: 2, email: 'athlete@mmakf.in', status: 'active' },
  ]);

  const [svc] = await db.insert(s.services).values({
    code: 'MMAKF-SVC-SCHOOL-KARATE', slug: 'school-karate',
    title: 'School karate programme', category: 'training', status: 'published',
  }).returning({ id: s.services.id });
  SVC = svc.id;

  // A framework built for the tests. NOTE: these figures are TEST FIXTURES and
  // are not MMAKF's fees — the federation has published none, and the engine
  // ships empty for exactly that reason.
  const fw = await createFramework(db, ctx, { title: 'Test framework', version: 1 });
  FW = fw.id;
  await addRule(db, ctx, FW, {
    code: 'BASE-SCHOOL', label: 'School programme base', kind: 'base',
    audience: 'school', amountMinor: 5000000, sortOrder: 10,          // ₹50,000
  });
  await addRule(db, ctx, FW, {
    code: 'PER-CHILD', label: 'Per participant', kind: 'per_participant',
    audience: 'school', amountMinor: 45000, sortOrder: 20,            // ₹450
  });
  await addRule(db, ctx, FW, {
    code: 'ONSITE-UPLIFT', label: 'On-campus delivery', kind: 'multiplier',
    audience: 'school', conditions: { mode: 'on_site' }, factorPpm: 1_250_000, sortOrder: 30,
  });
  await addRule(db, ctx, FW, {
    code: 'LARGE-COHORT', label: 'Large cohort adjustment', kind: 'discount',
    audience: 'school', conditions: { participants: { min: 300 } },
    amountMinor: -2000000, sortOrder: 40, requiresApproval: true,     // −₹20,000
  });
  await addRule(db, ctx, FW, {
    code: 'GST', label: 'Tax', kind: 'tax',
    audience: 'school', factorPpm: 1_180_000, sortOrder: 90,
  });
  await publishFramework(db, ctx, FW);
});

describe('money is integer paise, and the arithmetic is exact', () => {
  it('rounds a factor half UP, in both directions', () => {
    expect(applyFactor(100, PPM)).toBe(100);
    expect(applyFactor(100, 1_250_000)).toBe(125);
    // 101 × 1.005 = 101.505 → 102, not 101.
    expect(applyFactor(101, 1_005_000)).toBe(102);
    expect(applyFactor(-100, 1_250_000)).toBe(-125);
    expect(applyFactor(0, 1_250_000)).toBe(0);
  });

  it('stays exact at contract sizes a double would round', () => {
    // ₹10 crore in paise, times 1.25. A float multiply here is representable,
    // but the next factor in a chain is not — the BigInt path removes the whole
    // class rather than the first instance of it.
    const tenCrore = 1_000_000_000;
    expect(applyFactor(tenCrore, 1_250_000)).toBe(1_250_000_000);
    // And a value where naive float arithmetic drifts.
    expect(applyFactor(999_999_999, 1_180_000)).toBe(1_179_999_999);
  });

  it('refuses a non-integer amount or factor rather than silently truncating', () => {
    expect(() => applyFactor(100.5, PPM)).toThrow(/integer paise/);
    expect(() => applyFactor(100, 1.25)).toThrow(/parts-per-million/);
  });

  it('formats with INDIAN digit grouping, not thousands', () => {
    expect(formatINR(0)).toBe('₹0.00');
    expect(formatINR(45000)).toBe('₹450.00');
    expect(formatINR(100000)).toBe('₹1,000.00');
    // One lakh: ₹1,00,000 — the grouping a Western formatter gets wrong.
    expect(formatINR(10000000)).toBe('₹1,00,000.00');
    expect(formatINR(1234567890)).toBe('₹1,23,45,678.90');
    expect(formatINR(-45050)).toBe('-₹450.50');
  });
});

describe('conditions fail CLOSED', () => {
  it('matches equality, set membership, ranges and negation', () => {
    expect(matchConditions({ mode: 'on_site' }, { mode: 'on_site' }).matched).toBe(true);
    expect(matchConditions({ mode: 'on_site' }, { mode: 'online' }).matched).toBe(false);
    expect(matchConditions({ audience: ['school', 'university'] }, { audience: 'school' }).matched).toBe(true);
    expect(matchConditions({ audience: ['school', 'university'] }, { audience: 'corporate' }).matched).toBe(false);
    expect(matchConditions({ participants: { min: 50, max: 200 } }, { participants: 120 }).matched).toBe(true);
    expect(matchConditions({ participants: { min: 50 } }, { participants: 20 }).matched).toBe(false);
    expect(matchConditions({ mode: { not: 'online' } }, { mode: 'on_site' }).matched).toBe(true);
    expect(matchConditions({ mode: { not: 'online' } }, { mode: 'online' }).matched).toBe(false);
  });

  it('an unrecognised condition form does NOT match', () => {
    // Treating what the engine cannot understand as satisfied would let a typo
    // in one rule silently widen it to every request in the country.
    expect(matchConditions({ participants: { between: [1, 2] } }, { participants: 1 }).matched).toBe(false);
    expect(matchConditions({ participants: {} }, { participants: 1 }).matched).toBe(false);
    expect(matchConditions([1, 2], {}).matched).toBe(false);
  });

  it('a missing input does not satisfy a range', () => {
    expect(matchConditions({ participants: { min: 1 } }, {}).matched).toBe(false);
  });

  it('an empty condition set matches everything, and says nothing', () => {
    const m = matchConditions({}, { anything: 1 });
    expect(m.matched).toBe(true);
    expect(m.because).toBe('');
  });

  it('records WHY it matched, for the explanation screen', () => {
    const m = matchConditions({ mode: 'on_site', participants: { min: 50 } }, { mode: 'on_site', participants: 80 });
    expect(m.because).toMatch(/mode is on_site/);
    expect(m.because).toMatch(/participants 80 is within 50/);
  });
});

describe('a published framework is IMMUTABLE', () => {
  it('refuses a new rule once published', async () => {
    // Editing it would silently rewrite every quotation issued under it — a
    // school that accepted a figure in March would find its own quote saying
    // something else in June.
    await expect(
      addRule(db, ctx, FW, { code: 'SNEAK', label: 'Sneaky', kind: 'base', amountMinor: 1 })
    ).rejects.toThrow(/cannot be changed/);
  });

  it('refuses to publish a framework with no rules', async () => {
    const empty = await createFramework(db, ctx, { title: 'Empty', version: 99 });
    await expect(publishFramework(db, ctx, empty.id)).rejects.toThrow(/no rules/);
  });

  it('refuses to price from a DRAFT framework', async () => {
    const draft = await createFramework(db, ctx, { title: 'Draft', version: 98 });
    await addRule(db, ctx, draft.id, { code: 'B', label: 'Base', kind: 'base', amountMinor: 100 });
    await expect(computeFee(db, draft.id, { audience: 'school' }))
      .rejects.toThrow(/Only a PUBLISHED framework/);
  });

  it('requires finance authority to author or publish', async () => {
    await expect(createFramework(db, { principal: athlete }, { title: 'X', version: 97 }))
      .rejects.toThrow(/Forbidden/);
  });
});

describe('computing a fee', () => {
  const school = { audience: 'school', mode: 'on_site', participants: 80 };

  it('walks the rules in order and shows the running total after each', async () => {
    const c = await computeFee(db, FW, school);
    expect(c.requiresManualQuote).toBe(false);

    // ₹50,000 base + 80 × ₹450 = ₹36,000 → ₹86,000
    expect(c.lines[0].amountMinor).toBe(5000000);
    expect(c.lines[1].quantity).toBe(80);
    expect(c.lines[1].amountMinor).toBe(80 * 45000);
    expect(c.lines[1].runningTotalMinor).toBe(5000000 + 3600000);

    // ×1.25 on-campus → ₹1,07,500
    expect(c.lines[2].kind).toBe('multiplier');
    expect(c.lines[2].runningTotalMinor).toBe(10750000);

    // 80 is below the 300 threshold, so no large-cohort adjustment.
    expect(c.lines.some((l) => l.ruleCode === 'LARGE-COHORT')).toBe(false);
    expect(c.skipped.some((x) => x.ruleCode === 'LARGE-COHORT')).toBe(true);

    // Tax last, on the running total.
    const tax = c.lines.find((l) => l.kind === 'tax')!;
    expect(tax.amountMinor).toBe(applyFactor(10750000, 1_180_000) - 10750000);
    expect(c.taxMinor).toBe(tax.amountMinor);
    expect(c.totalMinor).toBe(10750000 + tax.amountMinor);
  });

  it('every line says which rule produced it and why', async () => {
    const c = await computeFee(db, FW, school);
    for (const l of c.lines) {
      expect(l.ruleCode, 'a line has no rule').toBeTruthy();
      expect(l.label).toBeTruthy();
    }
    const uplift = c.lines.find((l) => l.ruleCode === 'ONSITE-UPLIFT')!;
    expect(uplift.because).toMatch(/mode is on_site/);
  });

  it('records every rule it REJECTED, with the condition that rejected it', async () => {
    // An unexplained absence is indistinguishable from a bug in the engine.
    const c = await computeFee(db, FW, school);
    const why = c.skipped.find((x) => x.ruleCode === 'LARGE-COHORT')!;
    expect(why.because).toMatch(/participants 80 is below 300/);
  });

  it('applies the authorised discount only above its threshold, and flags approval', async () => {
    const big = await computeFee(db, FW, { ...school, participants: 400 });
    const disc = big.lines.find((l) => l.ruleCode === 'LARGE-COHORT');
    expect(disc).toBeTruthy();
    expect(disc!.amountMinor).toBe(-2000000);
    expect(big.needsApproval).toBe(true);
    expect(big.adjustmentMinor).toBe(-2000000);
  });

  it('SKIPS a per-unit rule with no quantity rather than pricing it at zero', async () => {
    // Zero would silently drop a real cost out of the total.
    const c = await computeFee(db, FW, { audience: 'school', mode: 'on_site' });
    expect(c.lines.some((l) => l.ruleCode === 'PER-CHILD')).toBe(false);
    expect(c.skipped.some((x) => x.ruleCode === 'PER-CHILD' && /participants was not supplied/.test(x.because))).toBe(true);
  });
});

describe('when nothing prices it, there is NO NUMBER', () => {
  it('reports requiresManualQuote rather than a plausible figure', async () => {
    // A corporate request against a framework that only prices schools.
    const c = await computeFee(db, FW, { audience: 'corporate', participants: 40 });
    expect(c.requiresManualQuote).toBe(true);
    expect(c.lines).toEqual([]);
    expect(c.manualReason).toMatch(/No published fee rule covers this/);
  });

  it('a zero total is NEVER presented as a price', async () => {
    // Zero reads as "free", which is the most expensive misunderstanding
    // available here. The flag is what a surface must branch on, not the total.
    const c = await computeFee(db, FW, { audience: 'corporate' });
    expect(c.totalMinor).toBe(0);
    expect(c.requiresManualQuote).toBe(true);
  });

  it('an empty framework says so in as many words', async () => {
    const bare = await createFramework(db, ctx, { title: 'Bare', version: 96 });
    await addRule(db, ctx, bare.id, { code: 'X', label: 'X', kind: 'base', audience: 'ngo', amountMinor: 1 });
    await publishFramework(db, ctx, bare.id);
    const c = await computeFee(db, bare.id, { audience: 'school' });
    expect(c.requiresManualQuote).toBe(true);
  });
});

describe('REPRODUCIBILITY — the property the federation asked for by name', () => {
  const inputs = { audience: 'school', mode: 'on_site', participants: 120, serviceCode: 'MMAKF-SVC-SCHOOL-KARATE' };

  it('the same inputs give the same result, every time', async () => {
    const a = await computeFee(db, FW, inputs);
    const b = await computeFee(db, FW, inputs);
    const c = await computeFee(db, FW, { ...inputs });
    expect(b.totalMinor).toBe(a.totalMinor);
    expect(c.totalMinor).toBe(a.totalMinor);
    expect(b.lines.map((l) => l.amountMinor)).toEqual(a.lines.map((l) => l.amountMinor));
  });

  it('changed inputs give a correspondingly changed result', async () => {
    const at80 = await computeFee(db, FW, { ...inputs, participants: 80 });
    const at120 = await computeFee(db, FW, inputs);
    expect(at120.totalMinor).toBeGreaterThan(at80.totalMinor);
    // And by exactly the right amount: 40 more children at ₹450, then ×1.25, then tax.
    const delta = applyFactor(40 * 45000, 1_250_000);
    expect(at120.totalMinor - at80.totalMinor).toBe(applyFactor(delta, 1_180_000));
  });

  it('delivery mode changes the answer, because a rule says so', async () => {
    const online = await computeFee(db, FW, { ...inputs, mode: 'online' });
    const onsite = await computeFee(db, FW, inputs);
    expect(online.lines.some((l) => l.ruleCode === 'ONSITE-UPLIFT')).toBe(false);
    expect(onsite.totalMinor).toBeGreaterThan(online.totalMinor);
  });

  it('a STORED quote recomputes to the figure it was issued at', async () => {
    const issued = await issueQuote(db, ctx, { frameworkId: FW, inputs });
    const [qv] = await db.select().from(s.quoteVersions).where(eq(s.quoteVersions.quoteId, issued.quoteId));
    const check = await reproduce(db, qv.id);
    expect(check.matches).toBe(true);
    expect(check.recomputed.totalMinor).toBe(check.stored.totalMinor);
  });

  it('A HISTORICAL QUOTE IS UNCHANGED BY A NEW FRAMEWORK VERSION', async () => {
    // The single most important test in this file. Publishing new fees must
    // never retrospectively alter what a school was told it would pay.
    const req = await db.insert(s.trainingRequests).values({
      ref: 'MMAKF-REQ-TEST-1', audience: 'school', parameters: {},
    }).returning({ id: s.trainingRequests.id });

    const before = await issueQuote(db, ctx, { requestId: req[0].id, frameworkId: FW, inputs });
    const storedTotal = before.computation.totalMinor;

    // A completely different set of fees is published.
    const v2 = await createFramework(db, ctx, { title: 'Framework two', version: 2 });
    await addRule(db, ctx, v2.id, {
      code: 'BASE-SCHOOL', label: 'School base', kind: 'base',
      audience: 'school', amountMinor: 99999999, sortOrder: 10,
    });
    await publishFramework(db, ctx, v2.id);

    const [qv] = await db.select().from(s.quoteVersions)
      .where(eq(s.quoteVersions.quoteId, before.quoteId));
    const check = await reproduce(db, qv.id);

    expect(check.stored.totalMinor).toBe(storedTotal);
    expect(check.matches).toBe(true);
    // Because the version pins its framework, not "whatever is current".
    expect(qv.frameworkCode).toBe('MMAKF-FEE-V1');
  });
});

describe('quotes are versioned, never edited', () => {
  it('re-quoting a request produces version 2 and supersedes version 1 INTACT', async () => {
    const [req] = await db.insert(s.trainingRequests).values({
      ref: 'MMAKF-REQ-TEST-2', audience: 'school', parameters: {},
    }).returning({ id: s.trainingRequests.id });

    const v1 = await issueQuote(db, ctx, {
      requestId: req.id, frameworkId: FW,
      inputs: { audience: 'school', mode: 'on_site', participants: 50 },
    });
    const v2 = await issueQuote(db, ctx, {
      requestId: req.id, frameworkId: FW,
      inputs: { audience: 'school', mode: 'on_site', participants: 90 },
    });

    expect(v1.quoteId).toBe(v2.quoteId);     // one quotation, two versions
    expect(v2.version).toBe(2);

    const versions = await db.select().from(s.quoteVersions)
      .where(eq(s.quoteVersions.quoteId, v1.quoteId));
    expect(versions.length).toBe(2);

    const one = versions.find((x: any) => x.version === 1)!;
    expect(one.status).toBe('superseded');
    // Superseded, and still exactly what it said.
    expect(one.totalMinor).toBe(v1.computation.totalMinor);
    expect((one.inputs as any).participants).toBe(50);
  });

  it('a quote needing approval is NOT issued until somebody approves it', async () => {
    const q = await issueQuote(db, ctx, {
      frameworkId: FW, inputs: { audience: 'school', mode: 'on_site', participants: 400 },
    });
    const [qv] = await db.select().from(s.quoteVersions).where(eq(s.quoteVersions.quoteId, q.quoteId));
    expect(qv.status).toBe('awaiting_approval');
    expect(qv.issuedAt).toBeNull();
  });

  it('stores the inputs it was computed from, not a pointer to them', async () => {
    const [req] = await db.insert(s.trainingRequests).values({
      ref: 'MMAKF-REQ-TEST-3', audience: 'school', parameters: { participants: 60 },
    }).returning({ id: s.trainingRequests.id });
    const q = await issueQuote(db, ctx, {
      requestId: req.id, frameworkId: FW,
      inputs: { audience: 'school', mode: 'on_site', participants: 60 },
    });

    // Editing the REQUEST afterwards must not change the quote.
    await db.update(s.trainingRequests)
      .set({ parameters: { participants: 9999 } })
      .where(eq(s.trainingRequests.id, req.id));

    const [qv] = await db.select().from(s.quoteVersions).where(eq(s.quoteVersions.quoteId, q.quoteId));
    expect((qv.inputs as any).participants).toBe(60);
    expect((await reproduce(db, qv.id)).matches).toBe(true);
  });
});

describe('the explanation', () => {
  it('reconstructs the arithmetic from the stored rows alone', async () => {
    const q = await issueQuote(db, ctx, {
      frameworkId: FW, inputs: { audience: 'school', mode: 'on_site', participants: 80 },
    });
    const [qv] = await db.select().from(s.quoteVersions).where(eq(s.quoteVersions.quoteId, q.quoteId));
    const e = await explainQuote(db, finance, qv.id);

    expect(e.narrative.some((n: string) => /Per participant: 80 × ₹450\.00 = ₹36,000\.00/.test(n))).toBe(true);
    expect(e.narrative.some((n: string) => /On-campus delivery: ×1\.2500/.test(n))).toBe(true);
    // Every line carries its running total, so the sequence is auditable.
    expect(e.lines.every((l: any) => typeof l.runningTotalMinor === 'number')).toBe(true);
  });

  it('requires finance:read', async () => {
    const q = await issueQuote(db, ctx, { frameworkId: FW, inputs: { audience: 'school', participants: 10 } });
    const [qv] = await db.select().from(s.quoteVersions).where(eq(s.quoteVersions.quoteId, q.quoteId));
    await expect(explainQuote(db, athlete, qv.id)).rejects.toThrow(/finance:read/);
  });
});

describe('the framework in force', () => {
  it('returns the highest published version covering the date', async () => {
    const fw = await activeFramework(db, '2026-06-01');
    expect(fw).toBeTruthy();
    expect(fw.status).toBe('published');
  });

  it('errors are identified by shape, not constructor identity', () => {
    expect(isFeeError(new FeeError('x', 'y'))).toBe(true);
    expect(isFeeError(new Error('y'))).toBe(false);
    expect(isFeeError(null)).toBe(false);
  });
});

describe('no price is hardcoded anywhere outside the engine', () => {
  it('no component, page or route computes a fee', () => {
    // The nine monthly prices that used to live in src/data/seed.ts were the
    // reason this engine exists. Nothing may quietly reintroduce one.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${name.name}`;
        if (name.isDirectory()) walk(full);
        else if (/\.(astro|ts)$/.test(name.name)) files.push(full);
      }
    };
    walk('src/pages');
    walk('src/components');

    const offenders = files.filter((f) => {
      const src = readFileSync(f, 'utf8');
      // A multiplication or division against a rupee/paise-looking literal.
      return /(amountMinor|totalMinor|priceMinor)\s*[*/]/.test(src);
    });
    expect(offenders, 'a surface is doing fee arithmetic').toEqual([]);
  });
});
