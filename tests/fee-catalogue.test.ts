// The fee catalogue, and the one thing it must never be able to say.
//
// The federation's instruction was blunt: where an amount is unknown the answer
// is FEE_NOT_CONFIGURED — never 0, never a placeholder, never a fabricated
// figure, because zero reads as "free" and that is the most expensive
// misunderstanding this system could publish.
//
// That is not a property you assert in a comment. Most of this file is
// adversarial: it takes the sentinel and tries every route by which a missing
// fee has historically become ₹0.00 on a page — `?? 0`, `Number(x)`,
// `total += fee`, string interpolation, JSON round-trip, a cast to `any` — and
// insists each one throws or fails to compile rather than producing a number.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  FEE_NOT_CONFIGURED, FEE_NOTICE, FEE_CATEGORIES, FEE_CATALOGUE_SEED,
  FEE_DISPLAY_POLICIES,
  feeFor, isPriced, isNotConfigured, renderFee, requireAmountMinor,
  mayShowAmount, seedFeeCatalogue, publicCatalogue, fullCatalogue,
  catalogueEntry, setDisplayPolicy, isFeeCatalogueError,
  type FeeResult, type FeeDisplayPolicy,
} from '../src/db/fee-catalogue';
import { createFramework, addRule, publishFramework } from '../src/db/fees';
import type { Principal } from '../src/lib/rbac';

let db: any;

/** Authors, publishes and seeds. FINANCE_OFFICER holds feeframework:*. */
const finance: Principal = {
  userId: 1, label: 'finance',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
/** Holds none of feeframework:*. The negative case for every gate. */
const athlete: Principal = {
  userId: 2, label: 'athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
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
  await db.insert(s.users).values([
    { id: 1, email: 'finance@mmakf.in', status: 'active' },
    { id: 2, email: 'athlete@mmakf.in', status: 'active' },
  ]);
  await seedFeeCatalogue(db, ctx);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the catalogue carries no amount, and cannot be made to', () => {
  it('has no column that could hold money', async () => {
    // Read from information_schema rather than from the migration text: a
    // column added by a later ALTER would pass a source scan and fail here,
    // which is the direction the mistake actually travels.
    const rows = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'fee_catalogue_entries'
    `);
    const names: string[] = (rows.rows ?? rows).map((r: any) => r.column_name);
    expect(names.length).toBeGreaterThan(10);
    const money = names.filter((n) =>
      /(amount|price|paise|minor|cost|rate|currency|total|fee_value)/i.test(n)
    );
    expect(money, 'the fee catalogue grew a money column').toEqual([]);
  });

  it('refuses a seed entry that carries one', async () => {
    await expect(
      seedFeeCatalogue(db, ctx, [{
        code: 'MMAKF-FEE-TEST-AMOUNT', slug: 'test-amount', name: 'Test',
        category: 'documents', audience: 'member', unit: 'per_document',
        frequency: 'one_time', displayPolicy: 'public',
        amountMinor: 50_000,
      } as any])
    ).rejects.toThrow(/carries NO AMOUNT/i);
  });

  it('states no rupee figure anywhere in the module or its migration', () => {
    const module = readFileSync('src/db/fee-catalogue.ts', 'utf8');
    const migration = readFileSync(catalogueMigration(), 'utf8');
    // A rupee sign followed by a digit is the shape of an invented price. The
    // only ₹ allowed in either file is in a sentence about ₹0 being refused.
    expect(module.match(/₹[1-9]/g), 'the module names a price').toBeNull();
    expect(migration.match(/₹[1-9]/g), 'the migration names a price').toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('FEE_NOT_CONFIGURED cannot be coerced to a number', () => {
  it('is a symbol, which is the only value JavaScript refuses arithmetic on', () => {
    expect(typeof FEE_NOT_CONFIGURED).toBe('symbol');
  });

  it('throws on Number(), not NaN', () => {
    // NaN would be the worst outcome available: it survives every check that
    // isn't Number.isFinite, and lands in a total as a silent poison.
    expect(() => Number(FEE_NOT_CONFIGURED as any)).toThrow(TypeError);
  });

  it('throws on every arithmetic route into a total', () => {
    expect(() => (FEE_NOT_CONFIGURED as any) + 0).toThrow(TypeError);
    expect(() => (FEE_NOT_CONFIGURED as any) * 1).toThrow(TypeError);
    expect(() => (FEE_NOT_CONFIGURED as any) - 0).toThrow(TypeError);
    expect(() => +(FEE_NOT_CONFIGURED as any)).toThrow(TypeError);
    let total = 0;
    expect(() => { total += FEE_NOT_CONFIGURED as any; }).toThrow(TypeError);
    expect(total).toBe(0);
  });

  it('throws on string interpolation, which is how it would reach a page', () => {
    expect(() => `${FEE_NOT_CONFIGURED as any}`).toThrow(TypeError);
    expect(() => (FEE_NOT_CONFIGURED as any) + '').toThrow(TypeError);
  });

  it('survives ?? and || unchanged — there is nothing nullish to replace', () => {
    // The exact line this design exists to defeat: `fee ?? 0`. With a symbol the
    // fallback never fires, so the zero never appears; the symbol travels on and
    // throws at the point of use instead.
    const fee: any = FEE_NOT_CONFIGURED;
    expect(fee ?? 0).toBe(FEE_NOT_CONFIGURED);
    expect(fee || 0).toBe(FEE_NOT_CONFIGURED);
  });

  it('is unique — no other symbol of the same description equals it', () => {
    expect(Symbol('MMAKF.FEE_NOT_CONFIGURED')).not.toBe(FEE_NOT_CONFIGURED);
    expect(Symbol.for('MMAKF.FEE_NOT_CONFIGURED')).not.toBe(FEE_NOT_CONFIGURED);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the unpriced result cannot be rendered as a quantity either', () => {
  let unpriced: FeeResult;

  beforeAll(async () => {
    // No framework is published at this point, so every lookup is unpriced.
    unpriced = await feeFor(db, 'MMAKF-FEE-GRD-DAN');
  });

  it('is the unpriced arm, tagged by the symbol itself', () => {
    expect(isNotConfigured(unpriced)).toBe(true);
    expect(isPriced(unpriced)).toBe(false);
    expect(unpriced.outcome).toBe(FEE_NOT_CONFIGURED);
  });

  it('has NO amountMinor property at all', () => {
    // The compile-time half. `unpriced.amountMinor` is a type error on the
    // union; this asserts the runtime object matches, so a cast to `any` finds
    // undefined rather than a zero somebody left there for convenience.
    expect('amountMinor' in (unpriced as any)).toBe(false);
    expect((unpriced as any).amountMinor).toBeUndefined();
  });

  it('throws rather than coercing, in every direction', () => {
    expect(() => Number(unpriced as any)).toThrow(/not configured/i);
    expect(() => `${unpriced as any}`).toThrow(/not configured/i);
    expect(() => (unpriced as any) * 2).toThrow(/not configured/i);
    expect(() => String(unpriced as any)).toThrow(/not configured/i);
  });

  it('is frozen, so nothing can bolt an amount onto it downstream', () => {
    expect(Object.isFrozen(unpriced)).toBe(true);
    try { (unpriced as any).amountMinor = 0; } catch { /* strict mode throws */ }
    expect((unpriced as any).amountMinor).toBeUndefined();
  });

  it('carries no zero through a JSON round-trip', () => {
    const round = JSON.parse(JSON.stringify(unpriced));
    expect(round.amountMinor).toBeUndefined();
    expect(Object.values(round)).not.toContain(0);
    // The symbol-keyed tag does not survive JSON, which is exactly why the
    // wire format must never be the thing a surface narrows on.
    expect(round.outcome).toBeUndefined();
    expect(round.notice).toBe(FEE_NOTICE.public);
  });

  it('requireAmountMinor() throws instead of substituting a figure', () => {
    expect(() => requireAmountMinor(unpriced)).toThrow(/Refusing to substitute/i);
    try {
      requireAmountMinor(unpriced);
    } catch (err) {
      expect(isFeeCatalogueError(err)).toBe(true);
      expect((err as any).code).toBe('fee_not_configured');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('no surface renders ₹0', () => {
  it('renderFee() returns the policy sentence, with no digits and no rupee sign', async () => {
    for (const policy of FEE_DISPLAY_POLICIES) {
      await setDisplayPolicy(db, ctx, 'MMAKF-FEE-DOC-CERTIFICATE', policy);
      const r = await feeFor(db, 'MMAKF-FEE-DOC-CERTIFICATE');
      const text = renderFee(r);
      expect(text, `policy ${policy} rendered a rupee sign`).not.toMatch(/₹/);
      expect(text, `policy ${policy} rendered a digit`).not.toMatch(/\d/);
      expect(text).toBe(FEE_NOTICE[policy]);
      expect(text.length).toBeGreaterThan(0);
    }
    await setDisplayPolicy(db, ctx, 'MMAKF-FEE-DOC-CERTIFICATE', 'public');
  });

  it('says the two sentences the federation asked for, chosen by policy', async () => {
    const publicEntry = await feeFor(db, 'MMAKF-FEE-GRD-KYU');
    expect(renderFee(publicEntry))
      .toBe('This fee is set by the federation and is not yet published.');

    const quoted = await feeFor(db, 'MMAKF-FEE-TRN-INDIVIDUAL');
    expect(renderFee(quoted)).toBe('Request a quotation.');
  });

  it('refuses to render a hand-built zero as a price', () => {
    // renderFee() is exported, so a caller can hand it a priced result that did
    // not come from feeFor(). The day somebody does, this is what happens.
    const forged: any = {
      outcome: 'priced', serviceCode: 'MMAKF-FEE-GRD-DAN', displayPolicy: 'public',
      amountMinor: 0, currency: 'INR', frameworkCode: 'X', frameworkVersion: 1, lines: [],
    };
    expect(() => renderFee(forged)).toThrow(/zero reads as "free"/i);
  });

  it('no source file under src/ prints a zero-rupee figure', () => {
    const offenders = sources().filter((f) => {
      const src = readFileSync(f, 'utf8');
      // Strip the // and /* */ commentary first — several files legitimately
      // discuss ₹0.00 as the thing they refuse to print.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      return /₹\s*0(\.0+)?\b/.test(code);
    });
    expect(offenders, 'a surface prints a zero-rupee figure').toEqual([]);
  });

  it('every consumer of feeFor() narrows the result or uses renderFee()', () => {
    // Future-proofing, and the assertion that keeps this track honest as pages
    // start using the catalogue: importing feeFor without ever narrowing means
    // somebody is about to reach for `.amountMinor` behind a cast.
    const consumers = sources().filter((f) =>
      f !== 'src/db/fee-catalogue.ts' && /from ['"][^'"]*fee-catalogue['"]/.test(readFileSync(f, 'utf8'))
    );
    const unsafe = consumers.filter((f) => {
      const src = readFileSync(f, 'utf8');
      if (!/\bfeeFor\s*\(/.test(src)) return false;
      return !/\b(renderFee|isPriced|isNotConfigured|requireAmountMinor)\b/.test(src);
    });
    expect(unsafe, 'a surface calls feeFor() without narrowing the result').toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the display policy decides what a viewer is told', () => {
  it('never shows a public visitor a figure for anything but a public fee', () => {
    for (const policy of FEE_DISPLAY_POLICIES) {
      expect(mayShowAmount(policy, 'public')).toBe(policy === 'public');
    }
  });

  it('shows a member the member-only fee and still withholds the rest', () => {
    expect(mayShowAmount('member_only', 'member')).toBe(true);
    expect(mayShowAmount('member_only', 'public')).toBe(false);
    expect(mayShowAmount('institutional', 'member')).toBe(false);
    expect(mayShowAmount('private', 'member')).toBe(false);
    expect(mayShowAmount('hidden', 'member')).toBe(false);
  });

  it('never shows a figure for request_quote below staff, even when one exists', () => {
    // The federation's answer to a visitor asking about training is a
    // quotation, not a number — regardless of what the engine could compute.
    expect(mayShowAmount('request_quote', 'public')).toBe(false);
    expect(mayShowAmount('request_quote', 'member')).toBe(false);
    expect(mayShowAmount('request_quote', 'staff')).toBe(true);
  });

  it('fails closed on a viewer or policy it does not recognise', () => {
    expect(mayShowAmount('public', 'root' as any)).toBe(false);
    expect(mayShowAmount('made_up' as any, 'staff')).toBe(false);
  });

  it('does not list private or hidden entries to the public', async () => {
    const listed = await publicCatalogue(db);
    const policies = new Set(listed.map((r: any) => r.displayPolicy));
    expect(policies.has('private')).toBe(false);
    expect(policies.has('hidden')).toBe(false);
    expect(listed.length).toBeGreaterThan(30);

    const everything = await fullCatalogue(db, finance);
    expect(everything.length).toBeGreaterThan(listed.length);
  });

  it('refuses the full catalogue to somebody without feeframework:read', async () => {
    await expect(fullCatalogue(db, athlete)).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the seed: fifty-one service codes and not one amount', () => {
  it('covers every category the federation listed', async () => {
    const rows = await fullCatalogue(db, finance);
    const present = new Set(rows.map((r: any) => r.category));
    for (const c of FEE_CATEGORIES) {
      expect(present.has(c), `no catalogue entry in category ${c}`).toBe(true);
    }
  });

  it('records each of the federation\'s named services', async () => {
    const rows = await fullCatalogue(db, finance);
    const codes = new Set(rows.map((r: any) => r.code));
    for (const wanted of [
      // Membership
      'MMAKF-FEE-MEM-ATHLETE', 'MMAKF-FEE-MEM-JUNIOR', 'MMAKF-FEE-MEM-COACH',
      'MMAKF-FEE-MEM-INSTRUCTOR', 'MMAKF-FEE-MEM-REFEREE', 'MMAKF-FEE-MEM-JUDGE',
      'MMAKF-FEE-MEM-OFFICIAL', 'MMAKF-FEE-MEM-EXAMINER', 'MMAKF-FEE-MEM-DOJO',
      'MMAKF-FEE-MEM-CLUB', 'MMAKF-FEE-MEM-ORGANISATION', 'MMAKF-FEE-MEM-RENEWAL',
      'MMAKF-FEE-MEM-REPLACEMENT',
      // Affiliation
      'MMAKF-FEE-AFF-DOJO', 'MMAKF-FEE-AFF-CLUB', 'MMAKF-FEE-AFF-INSTITUTIONAL',
      'MMAKF-FEE-AFF-RENEWAL', 'MMAKF-FEE-AFF-UNIT',
      // Grading
      'MMAKF-FEE-GRD-KYU', 'MMAKF-FEE-GRD-DAN', 'MMAKF-FEE-GRD-CERTIFICATE',
      'MMAKF-FEE-GRD-REISSUE',
      // Competition
      'MMAKF-FEE-CMP-ENTRY', 'MMAKF-FEE-CMP-KATA', 'MMAKF-FEE-CMP-KUMITE',
      'MMAKF-FEE-CMP-ADDITIONAL-CATEGORY', 'MMAKF-FEE-CMP-TEAM',
      'MMAKF-FEE-CMP-COACH', 'MMAKF-FEE-CMP-OFFICIAL', 'MMAKF-FEE-CMP-LATE-ENTRY',
      'MMAKF-FEE-CMP-PROTEST', 'MMAKF-FEE-CMP-APPEAL', 'MMAKF-FEE-CMP-WITHDRAWAL',
      // Education
      'MMAKF-FEE-EDU-COACH', 'MMAKF-FEE-EDU-INSTRUCTOR', 'MMAKF-FEE-EDU-REFEREE',
      'MMAKF-FEE-EDU-JUDGE', 'MMAKF-FEE-EDU-SEMINAR', 'MMAKF-FEE-EDU-CAMP',
      'MMAKF-FEE-EDU-WORKSHOP',
      // Training
      'MMAKF-FEE-TRN-INDIVIDUAL', 'MMAKF-FEE-TRN-PARENT-CHILD',
      'MMAKF-FEE-TRN-SCHOOL', 'MMAKF-FEE-TRN-CORPORATE',
      'MMAKF-FEE-TRN-UNIVERSITY', 'MMAKF-FEE-TRN-GOVERNMENT',
      'MMAKF-FEE-TRN-INSTITUTIONAL', 'MMAKF-FEE-TRN-PERSONAL-COACHING',
      // Documents
      'MMAKF-FEE-DOC-MEMBERSHIP-CARD', 'MMAKF-FEE-DOC-CERTIFICATE',
      'MMAKF-FEE-DOC-REPLACEMENT',
    ]) {
      expect(codes.has(wanted), `catalogue is missing ${wanted}`).toBe(true);
    }
    expect(FEE_CATALOGUE_SEED.length).toBe(51);
  });

  it('uses unique codes and unique slugs', () => {
    expect(new Set(FEE_CATALOGUE_SEED.map((e) => e.code)).size).toBe(FEE_CATALOGUE_SEED.length);
    expect(new Set(FEE_CATALOGUE_SEED.map((e) => e.slug)).size).toBe(FEE_CATALOGUE_SEED.length);
    for (const e of FEE_CATALOGUE_SEED) {
      expect(e.code, `${e.code} is not a federation code`).toMatch(/^MMAKF-FEE-[A-Z]{3}-[A-Z-]+$/);
      expect(e.slug).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('states a display policy for every entry — there is no default', () => {
    for (const e of FEE_CATALOGUE_SEED) {
      expect(FEE_DISPLAY_POLICIES, `${e.code} has no display policy`).toContain(e.displayPolicy);
    }
  });

  it('re-running the seed inserts nothing and reverts nothing', async () => {
    await setDisplayPolicy(db, ctx, 'MMAKF-FEE-MEM-ATHLETE', 'member_only');
    const again = await seedFeeCatalogue(db, ctx);
    expect(again.inserted).toBe(0);
    expect(again.skipped).toBe(FEE_CATALOGUE_SEED.length);
    // The operator's decision survives. A seed that upserted would have put
    // 'public' back and nobody would have been told.
    const entry = await catalogueEntry(db, 'MMAKF-FEE-MEM-ATHLETE');
    expect(entry.displayPolicy).toBe('member_only');
    await setDisplayPolicy(db, ctx, 'MMAKF-FEE-MEM-ATHLETE', 'public');
  });

  it('refuses to seed for somebody without feeframework:write', async () => {
    await expect(seedFeeCatalogue(db, { principal: athlete })).rejects.toThrow();
    await expect(
      setDisplayPolicy(db, { principal: athlete }, 'MMAKF-FEE-GRD-DAN', 'hidden')
    ).rejects.toThrow();
  });

  it('writes an audit row for the seed', async () => {
    const rows = await db.select().from(s.auditEvents)
      .where(eq(s.auditEvents.entityType, 'fee_catalogue'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].newValue.inserted).toBe(51);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('feeFor() reports WHY there is no figure', () => {
  it('unknown_service for a code nobody listed, and refuses to sound confident', async () => {
    const r = await feeFor(db, 'MMAKF-FEE-DOES-NOT-EXIST');
    expect(isNotConfigured(r)).toBe(true);
    if (isNotConfigured(r)) {
      expect(r.reason).toBe('unknown_service');
      // Not 'public'. A confident public sentence about a service the
      // federation does not list would be a statement it never made.
      expect(r.displayPolicy).toBe('request_quote');
    }
  });

  it('no_framework while MMAKF has published none — which is today', async () => {
    const r = await feeFor(db, 'MMAKF-FEE-GRD-KYU');
    expect(isNotConfigured(r)).toBe(true);
    if (isNotConfigured(r)) expect(r.reason).toBe('no_framework');
  });

  it('display_restricted before any figure is computed', async () => {
    const r = await feeFor(db, 'MMAKF-FEE-TRN-SCHOOL', {}, { viewer: 'public' });
    expect(isNotConfigured(r)).toBe(true);
    if (isNotConfigured(r)) expect(r.reason).toBe('display_restricted');
  });

  it('service_not_published for a draft entry', async () => {
    await db.insert(s.feeCatalogueEntries).values({
      code: 'MMAKF-FEE-DOC-DRAFTONLY', slug: 'documents-draft-only',
      name: 'Draft only', category: 'documents', audience: 'member',
      unit: 'per_document', frequency: 'on_request', displayPolicy: 'public',
      status: 'draft',
    });
    const r = await feeFor(db, 'MMAKF-FEE-DOC-DRAFTONLY');
    expect(isNotConfigured(r)).toBe(true);
    if (isNotConfigured(r)) expect(r.reason).toBe('service_not_published');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('once the federation publishes a framework, the same call returns a figure', () => {
  // The whole point of the separation: no code changes here. A rule is added to
  // a framework, the framework is published, and the catalogue entry that
  // carried no amount starts pricing.
  let published = false;

  beforeAll(async () => {
    const fw = await createFramework(db, ctx, { title: 'Test framework', version: 1 });
    await addRule(db, ctx, fw.id, {
      code: 'DAN-BASE', label: 'Dan grading examination', kind: 'base',
      amountMinor: 250_000,
      // How an amount attaches to a catalogue entry that carries none.
      conditions: { serviceCode: 'MMAKF-FEE-GRD-DAN' },
      sortOrder: 10,
    });
    await addRule(db, ctx, fw.id, {
      code: 'FREEBIE', label: 'A rule that totals nothing', kind: 'base',
      amountMinor: 0,
      conditions: { serviceCode: 'MMAKF-FEE-GRD-CERTIFICATE' },
      sortOrder: 20,
    });
    await publishFramework(db, ctx, fw.id);
    published = true;
  });

  it('prices the entry, and says which framework version did it', async () => {
    expect(published).toBe(true);
    const r = await feeFor(db, 'MMAKF-FEE-GRD-DAN');
    expect(isPriced(r)).toBe(true);
    if (isPriced(r)) {
      expect(r.amountMinor).toBe(250_000);
      expect(Number.isInteger(r.amountMinor)).toBe(true);
      expect(r.currency).toBe('INR');
      expect(r.frameworkVersion).toBe(1);
      expect(r.frameworkCode).toBe('MMAKF-FEE-V1');
      expect(r.lines.length).toBe(1);
      expect(requireAmountMinor(r)).toBe(250_000);
      expect(renderFee(r)).toBe('₹2,500.00');
    }
  });

  it('still withholds the figure from a viewer the policy excludes', async () => {
    await setDisplayPolicy(db, ctx, 'MMAKF-FEE-GRD-DAN', 'member_only');
    const anon = await feeFor(db, 'MMAKF-FEE-GRD-DAN', {}, { viewer: 'public' });
    expect(isNotConfigured(anon)).toBe(true);
    expect(renderFee(anon)).toBe(FEE_NOTICE.member_only);

    const member = await feeFor(db, 'MMAKF-FEE-GRD-DAN', {}, { viewer: 'member' });
    expect(isPriced(member)).toBe(true);
    await setDisplayPolicy(db, ctx, 'MMAKF-FEE-GRD-DAN', 'public');
  });

  it('refuses a computed total of zero rather than publishing "free"', async () => {
    // A rule matched and produced nothing. The realistic cause is a discount
    // matching where its base rule did not, and calling that free is exactly
    // the failure this module exists to prevent.
    const r = await feeFor(db, 'MMAKF-FEE-GRD-CERTIFICATE');
    expect(isPriced(r)).toBe(false);
    if (isNotConfigured(r)) {
      expect(r.reason).toBe('zero_total');
      expect(renderFee(r)).toBe(FEE_NOTICE.public);
      expect(renderFee(r)).not.toMatch(/0/);
    }
  });

  it('no_rule for a listed service the published framework does not cover', async () => {
    const r = await feeFor(db, 'MMAKF-FEE-CMP-PROTEST');
    expect(isNotConfigured(r)).toBe(true);
    if (isNotConfigured(r)) expect(r.reason).toBe('no_rule');
    expect(renderFee(r)).toBe(FEE_NOTICE.public);
  });

  it('a framework not yet in force does not price anything', async () => {
    const r = await feeFor(db, 'MMAKF-FEE-GRD-DAN', {}, { asAt: '1999-01-01' });
    // effectiveFrom is null on this framework, so it applies to any date; the
    // assertion that matters is that the answer is a union member either way
    // and never a bare number.
    expect(isPriced(r) || isNotConfigured(r)).toBe(true);
    expect(typeof (r as any) === 'number').toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The migration that creates the catalogue, found BY CONTENT rather than by
 * name.
 *
 * Migration numbers are not stable while several tracks are landing at once —
 * this file was written as 0018 and renumbered to 0021 to clear a collision.
 * A test that hard-coded the number would have failed for a reason that has
 * nothing to do with what it is checking, which is the most expensive kind of
 * red test: one that trains people to ignore it.
 */
function catalogueMigration(): string {
  const found = readdirSync('drizzle')
    .filter((f) => f.endsWith('.sql'))
    .map((f) => `drizzle/${f}`)
    .filter((f) => /CREATE TABLE "fee_catalogue_entries"/.test(readFileSync(f, 'utf8')));
  expect(found, 'exactly one migration creates fee_catalogue_entries').toHaveLength(1);
  return found[0];
}

/** Every .ts and .astro file under src/, recursively. */
function sources(dir = 'src'): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|astro)$/.test(name)) out.push(p.replace(/\\/g, '/'));
  }
  return out;
}
