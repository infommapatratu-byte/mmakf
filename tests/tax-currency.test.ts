// The tax and currency engines.
//
// The instruction behind this file had two halves, and they are tested in that
// order.
//
// FIRST: build the tax model, ship it EMPTY, and make the empty state say
// plainly that no tax rule is configured so nothing is added. The failure this
// guards against is not a crash — it is a screen that prints "Tax: ₹0.00" and
// thereby tells a reader that MMAKF has determined the supply exempt, when in
// fact nobody has determined anything at all. Those two facts produce the same
// number and mean opposite things, and most of what follows exists to keep them
// apart.
//
// SECOND, AND THE ONE THAT MATTERS MOST: once a quotation or an invoice is
// issued, the commercial amount and the exchange rate used are FROZEN on that
// record. A later FX move must never change what a customer owes. That is
// asserted the only way it can honestly be asserted — issue a document, then
// move the rate underneath it, then look again.
//
// EVERY NUMBER IN THIS FILE IS A TEST FIXTURE. MMAKF has published no tax rate
// and no exchange rate; the tables ship empty and the first two tests prove it.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, sql } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  minorUnitScale, formatMoney, getCurrency, requireCurrency, listCurrencies,
  upsertCurrency, recordRate, rateAsOf, applyRate, convertAsOf, prepareStamp,
  stampInvoice, invoiceRate, stampQuoteVersion, fxStatus, identityRate,
  isCurrencyError, BASE_CURRENCY, IDENTITY_PPM,
} from '../src/db/currency';
import {
  computeTax, taxSnapshot, taxStatus, rateInForce, createJurisdiction,
  createTaxRule, addRateVersion, publishRateVersion, withdrawRateVersion,
  stampInvoiceTax, isTaxError, NO_TAX_RULE_NOTICE,
} from '../src/db/tax';
import { issueInvoice } from '../src/db/orders';
import { applyFactor } from '../src/db/fees';
import type { Principal } from '../src/lib/rbac';

let db: any;
let client: PGlite;

/**
 * Holds finance:write (currencies and FX) AND feeframework:write/publish (tax
 * rules and rate versions).
 *
 * Tax is gated on the fee-framework actions rather than on finance:write
 * deliberately: authoring and freezing a rate is the same kind of authority as
 * authoring and freezing a price, and it is NOT the same authority as recording
 * a payment. FINANCE_OFFICER happens to hold both sets, which is why the
 * adversarial cases below use principals that hold neither.
 */
const finance: Principal = {
  userId: 1, label: 'finance', bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
/** Holds quote:issue and feeframework:READ — and no write or publish anywhere. */
const ops: Principal = {
  userId: 2, label: 'ops', bindings: [{ role: 'TRAINING_OPERATIONS', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 3, label: 'athlete', bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};

const ctx = { principal: finance };
const opsCtx = { principal: ops };
const athleteCtx = { principal: athlete };

/** A test fixture jurisdiction and rule, created per-describe where needed. */
let JUR = 0;
let SVC = 0;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  await db.insert(s.users).values([
    { id: 1, email: 'finance@mmakf.in', status: 'active' },
    { id: 2, email: 'ops@mmakf.in', status: 'active' },
    { id: 3, email: 'athlete@mmakf.in', status: 'active' },
  ]);

  const [svc] = await db.insert(s.services).values({
    code: 'MMAKF-SVC-SCHOOL-KARATE', slug: 'school-karate',
    title: 'School karate programme', category: 'training', status: 'published',
  }).returning({ id: s.services.id });
  SVC = svc.id;
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the engines ship EMPTY, and that is the point', () => {
  it('has no tax rule and no rate version, because MMAKF has determined neither', async () => {
    const [{ rules }] = await db.select({ rules: sql<number>`count(*)::int` }).from(s.taxRules);
    const [{ versions }] = await db.select({ versions: sql<number>`count(*)::int` }).from(s.taxRateVersions);
    expect(Number(rules)).toBe(0);
    expect(Number(versions)).toBe(0);
  });

  it('has no exchange rate, because a rate is somebody\'s published number and nobody has published one here', async () => {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(s.fxRates);
    expect(Number(n)).toBe(0);
  });

  it('says so in a sentence, rather than showing an empty table', async () => {
    const tax = await taxStatus(db);
    expect(tax.configured).toBe(false);
    expect(tax.ruleCount).toBe(0);
    expect(tax.notice).toBe(NO_TAX_RULE_NOTICE);
    // The wording carries the whole distinction: nothing was ADDED, and the
    // reason is that nothing was DECIDED.
    expect(tax.notice).toMatch(/no tax has been added/i);
    expect(tax.notice).toMatch(/MMAKF has not recorded/i);

    const fx = await fxStatus(db);
    expect(fx.configured).toBe(false);
    expect(fx.notice).toMatch(/nothing is being converted/i);
  });

  it('adds nothing to an amount, and never presents that as a rate of nought', async () => {
    const c = await computeTax(db, { baseMinor: 5_000_000, asAt: '2026-04-01' });
    expect(c.taxMinor).toBe(0);
    expect(c.totalMinor).toBe(5_000_000);
    expect(c.lines).toEqual([]);
    // THE ASSERTION THIS SUITE EXISTS FOR. `configured: false` is what lets a
    // surface print the sentence instead of a zero. Without it, "no rule" and
    // "exempt" are the same screen.
    expect(c.configured).toBe(false);
    expect(c.notice).toBe(NO_TAX_RULE_NOTICE);
  });

  it('the migration seeds no tax rate and no exchange rate — only the ISO standard', () => {
    // The strongest form this guard can take. Rather than grepping for the
    // number somebody would reach for while guessing at India's GST treatment
    // of a federation membership, assert that the migration INSERTS nothing
    // into the three tables that would constitute such a guess.
    // Located by name rather than by number. Migrations are numbered in the
    // order they are added, and several tracks add them at once — pinning
    // "0015" here would make this guard fail for a reason that has nothing to
    // do with what it is guarding.
    const [file] = readdirSync('drizzle').filter((f) => /_tax_and_currency\.sql$/.test(f));
    expect(file, 'the tax and currency migration is missing').toBeTruthy();
    const sqlText = readFileSync(`drizzle/${file}`, 'utf8');
    const inserts = [...sqlText.matchAll(/INSERT\s+INTO\s+"?(\w+)"?/gi)].map((m) => m[1]);

    expect(inserts).not.toContain('tax_rules');
    expect(inserts).not.toContain('tax_rate_versions');
    expect(inserts).not.toContain('tax_jurisdictions');
    expect(inserts).not.toContain('fx_rates');
    // Currencies ARE seeded, and that is not an exception: an ISO 4217 code and
    // exponent is a published international standard, not a commercial decision.
    expect(inserts).toEqual(['currencies']);
    expect(sqlText).toMatch(/ISO 4217/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('a currency is not assumed to have 100 minor units', () => {
  it('seeds INR active, in paise, as the authoritative domestic currency', async () => {
    const inr = await getCurrency(db, 'INR');
    expect(inr).not.toBeNull();
    expect(inr.minorUnit).toBe(2);
    expect(inr.isActive).toBe(true);
    expect(BASE_CURRENCY).toBe('INR');
  });

  it('knows the currencies that do NOT have two decimal places', async () => {
    // The whole reason minor_unit is a column with no default. A system that
    // divided by 100 would be wrong about every one of these, by a factor of a
    // hundred or a thousand.
    const jpy = await getCurrency(db, 'JPY');
    const kwd = await getCurrency(db, 'KWD');
    const krw = await getCurrency(db, 'KRW');
    expect(jpy.minorUnit).toBe(0);
    expect(krw.minorUnit).toBe(0);
    expect(kwd.minorUnit).toBe(3);
  });

  it('seeds every non-INR currency INACTIVE, because trading in one is a decision', async () => {
    const active = await listCurrencies(db, { activeOnly: true });
    expect(active.map((c: any) => c.code)).toEqual(['INR']);
  });

  it('scales by the exponent, never by 100', () => {
    expect(minorUnitScale(0)).toBe(1);
    expect(minorUnitScale(2)).toBe(100);
    expect(minorUnitScale(3)).toBe(1000);
    expect(() => minorUnitScale(7)).toThrow(/ISO 4217/);
  });

  it('renders each currency in its own minor unit', () => {
    // INR keeps the lakh/crore grouping, from the fee engine's one implementation.
    expect(formatMoney(1_234_567_89, { code: 'INR', minorUnit: 2, symbol: '₹' })).toBe('₹12,34,567.89');
    // A yen amount has no decimal point at all — "¥1,200.00" is not a price.
    expect(formatMoney(1200, { code: 'JPY', minorUnit: 0, symbol: '¥' })).toBe('¥1,200');
    // A dinar has three.
    expect(formatMoney(1_234_567, { code: 'KWD', minorUnit: 3, symbol: 'KD ' })).toBe('KD 1,234.567');
  });

  it('REFUSES a currency it does not know rather than assuming two decimals', async () => {
    await expect(requireCurrency(db, 'ZZZ')).rejects.toThrow(/minor unit is unknown/);
    try {
      await requireCurrency(db, 'ZZZ');
    } catch (e) {
      expect(isCurrencyError(e)).toBe(true);
      expect((e as any).code).toBe('unknown_currency');
    }
  });

  it('needs finance authority to add or activate one', async () => {
    await expect(
      upsertCurrency(db, athleteCtx, { code: 'NZD', name: 'New Zealand dollar', minorUnit: 2 })
    ).rejects.toThrow();
  });

  it('will not accept a currency without an explicit minor unit that is valid', async () => {
    await expect(
      upsertCurrency(db, ctx, { code: 'XXX', name: 'Nonsense', minorUnit: 9 })
    ).rejects.toThrow(/ISO 4217/);
    await expect(
      upsertCurrency(db, ctx, { code: 'TOOLONG', name: 'Nonsense', minorUnit: 2 })
    ).rejects.toThrow(/three letters/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('an exchange rate must say whose it is and when', () => {
  it('refuses a rate with no source', async () => {
    await expect(recordRate(db, ctx, {
      baseCode: 'USD', quoteCode: 'INR', ratePpm: 83_250_000,
      source: '', retrievedAt: new Date('2026-04-01T09:00:00Z'), effectiveOn: '2026-04-01',
    })).rejects.toThrow(/who published it/);
  });

  it('refuses a non-integer, zero or negative rate', async () => {
    for (const bad of [0, -1, 83.25]) {
      await expect(recordRate(db, ctx, {
        baseCode: 'USD', quoteCode: 'INR', ratePpm: bad,
        source: 'test', retrievedAt: new Date(), effectiveOn: '2026-04-01',
      })).rejects.toThrow(/parts-per-million/);
    }
  });

  it('refuses a pair whose currencies are not on record', async () => {
    await expect(recordRate(db, ctx, {
      baseCode: 'USD', quoteCode: 'ZZZ', ratePpm: 1_000_000,
      source: 'test', retrievedAt: new Date(), effectiveOn: '2026-04-01',
    })).rejects.toThrow(/minor unit is unknown/);
  });

  it('refuses a rate of a currency against itself', async () => {
    await expect(recordRate(db, ctx, {
      baseCode: 'INR', quoteCode: 'INR', ratePpm: 1_000_000,
      source: 'test', retrievedAt: new Date(), effectiveOn: '2026-04-01',
    })).rejects.toThrow(/against itself/);
  });

  it('needs finance authority to record one', async () => {
    await expect(recordRate(db, athleteCtx, {
      baseCode: 'USD', quoteCode: 'INR', ratePpm: 83_250_000,
      source: 'test', retrievedAt: new Date(), effectiveOn: '2026-04-01',
    })).rejects.toThrow();
  });

  it('returns NULL for a pair nobody has recorded — it never estimates', async () => {
    expect(await rateAsOf(db, 'EUR', 'INR', '2026-04-01')).toBeNull();
    await expect(convertAsOf(db, { amountMinor: 100, from: 'EUR', to: 'INR', asOf: '2026-04-01' }))
      .rejects.toThrow(/Nothing here estimates one/);
  });

  it('treats a currency against itself as an identity, not as a missing rate', async () => {
    const r = await rateAsOf(db, 'INR', 'INR', '2026-04-01');
    expect(r!.ratePpm).toBe(IDENTITY_PPM);
    expect(r!.source).toBe('identity');
    expect(applyRate(123_456, identityRate('INR', '2026-04-01'))).toBe(123_456);
  });

  it('versions a pair monotonically, so a correction never overwrites a rate that was used', async () => {
    const a = await recordRate(db, ctx, {
      baseCode: 'USD', quoteCode: 'INR', ratePpm: 83_250_000, rateText: '83.25',
      source: 'rbi_reference', sourceRef: 'RBI/2026-04-01',
      retrievedAt: new Date('2026-04-01T09:00:00Z'), effectiveOn: '2026-04-01',
    });
    const b = await recordRate(db, ctx, {
      baseCode: 'USD', quoteCode: 'INR', ratePpm: 83_400_000, rateText: '83.40',
      source: 'rbi_reference', sourceRef: 'RBI/2026-04-02',
      retrievedAt: new Date('2026-04-02T09:00:00Z'), effectiveOn: '2026-04-02',
    });
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    // Version 1 is untouched and still says what it said.
    const [reread] = await db.select().from(s.fxRates).where(eq(s.fxRates.id, a.id)).limit(1);
    expect(Number(reread.ratePpm)).toBe(83_250_000);
    expect(reread.rateText).toBe('83.25');
  });

  it('resolves the rate in force ON A DATE, not the newest one', async () => {
    const onFirst = await rateAsOf(db, 'USD', 'INR', '2026-04-01');
    const onSecond = await rateAsOf(db, 'USD', 'INR', '2026-04-02');
    expect(onFirst!.ratePpm).toBe(83_250_000);
    expect(onSecond!.ratePpm).toBe(83_400_000);
    // And nothing at all before the first rate was published.
    expect(await rateAsOf(db, 'USD', 'INR', '2026-03-31')).toBeNull();
  });

  it('applies a rate through applyFactor, exactly, in integer minor units', async () => {
    const rate = (await rateAsOf(db, 'USD', 'INR', '2026-04-01'))!;
    // $100.00 is 10000 cents; the rate is paise-per-cent × 1e6. So the answer
    // is 10000 × 83.25 = 832500 paise — ₹8,325.00, which is what $100 is worth
    // at 83.25, and the minor-unit definition of the rate got us there without
    // anybody rescaling by 100 at the call site.
    expect(applyRate(10_000, rate)).toBe(applyFactor(10_000, 83_250_000));
    expect(applyRate(10_000, rate)).toBe(832_500);
    // Half-up, and never a float creeping in.
    expect(Number.isInteger(applyRate(1, rate))).toBe(true);
  });

  it('records the provenance the invoice will carry', async () => {
    const rate = (await rateAsOf(db, 'USD', 'INR', '2026-04-02'))!;
    expect(rate.source).toBe('rbi_reference');
    expect(rate.sourceRef).toBe('RBI/2026-04-02');
    expect(rate.effectiveOn).toBe('2026-04-02');
    expect(rate.retrievedAt).toContain('2026-04-02');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('THE RULE THAT MATTERS: an issued invoice keeps its rate and its amount', () => {
  let invoiceId = 0;
  let frozenAtIssue = 0;

  beforeAll(async () => {
    const [order] = await db.insert(s.orders).values({
      orderNo: 'MMAKF-ORD-2026-000001', buyerName: 'Test Institution',
      email: 'bursar@example.test', status: 'paid',
      subtotalPaise: 5_000_000, totalPaise: 5_000_000, currency: 'INR',
    }).returning();
    const invoice = await issueInvoice(db, order.id);
    invoiceId = invoice.id;

    // The rate the treasury had on the day the invoice was issued. INR→USD, so
    // 1 paise buys 0.012 cents: 12000 in minor-per-minor parts-per-million.
    await recordRate(db, ctx, {
      baseCode: 'INR', quoteCode: 'USD', ratePpm: 12_000, rateText: '0.0120',
      source: 'bank_advice', sourceRef: 'ADV/2026-04-01',
      retrievedAt: new Date('2026-04-01T09:00:00Z'), effectiveOn: '2026-04-01',
    });
  });

  it('cannot present in a currency whose rate has not been recorded', async () => {
    // EUR is a known currency with a known minor unit and NO recorded rate. The
    // engine refuses rather than inverting the USD rate or reaching for a
    // near-enough one: an inverted rate is not a rate anybody published.
    await expect(prepareStamp(db, {
      baseTotalMinor: 5_000_000, presentmentCurrency: 'EUR', asOf: '2026-04-05',
    })).rejects.toThrow(/No exchange rate has been recorded/);
  });

  it('freezes the rate ONTO the invoice at issue', async () => {
    const stamp = await prepareStamp(db, {
      baseTotalMinor: 5_000_000, baseCurrency: 'INR',
      presentmentCurrency: 'USD', asOf: '2026-04-05',
    });
    const stamped = await stampInvoice(db, invoiceId, stamp);
    frozenAtIssue = Number(stamped.presentmentTotalMinor);

    expect(stamped.presentmentCurrency).toBe('USD');
    expect(stamped.presentmentMinorUnit).toBe(2);
    expect(Number(stamped.fxRatePpm)).toBe(12_000);
    expect(stamped.fxSource).toBe('bank_advice');
    // The rate's OWN effective date, not the day it was applied.
    expect(stamped.fxEffectiveOn).toBe('2026-04-01');
    expect(frozenAtIssue).toBe(applyFactor(5_000_000, 12_000));
  });

  it('KEEPS THAT AMOUNT AFTER THE RATE CHANGES — the property the federation asked for', async () => {
    // The rupee moves. A new rate is recorded, correctly, with its own source
    // and date. This is normal treasury work and must be safe to do.
    await recordRate(db, ctx, {
      baseCode: 'INR', quoteCode: 'USD', ratePpm: 9_000, rateText: '0.0090',
      source: 'bank_advice', sourceRef: 'ADV/2026-09-01',
      retrievedAt: new Date('2026-09-01T09:00:00Z'), effectiveOn: '2026-09-01',
    });

    // The live rate has genuinely moved.
    const live = await rateAsOf(db, 'INR', 'USD', '2026-09-02');
    expect(live!.ratePpm).toBe(9_000);
    expect(live!.ratePpm).not.toBe(12_000);

    // The invoice has not.
    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId)).limit(1);
    expect(Number(invoice.fxRatePpm)).toBe(12_000);
    expect(Number(invoice.presentmentTotalMinor)).toBe(frozenAtIssue);
    expect(invoice.fxEffectiveOn).toBe('2026-04-01');

    // And the accessor reads the frozen columns, not the rate table.
    const frozen = await invoiceRate(db, invoiceId);
    expect(frozen!.ratePpm).toBe(12_000);
    expect(frozen!.baseCode).toBe('INR');
    expect(frozen!.quoteCode).toBe('USD');
  });

  it('REFUSES to re-rate an issued invoice, loudly rather than silently', async () => {
    const stamp = await prepareStamp(db, {
      baseTotalMinor: 5_000_000, presentmentCurrency: 'USD', asOf: '2026-09-02',
    });
    await expect(stampInvoice(db, invoiceId, stamp)).rejects.toThrow(/never re-rates/);
    try {
      await stampInvoice(db, invoiceId, stamp);
    } catch (e) {
      expect(isCurrencyError(e)).toBe(true);
      expect((e as any).code).toBe('already_frozen');
    }
    // And it is still the original figure afterwards.
    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId)).limit(1);
    expect(Number(invoice.presentmentTotalMinor)).toBe(frozenAtIssue);
  });

  it('freezes a quote version the same way, one step earlier in the story', async () => {
    const [fw] = await db.insert(s.feeFrameworks).values({
      code: 'MMAKF-FEE-VTEST', title: 'Fixture', version: 9001, status: 'published', currency: 'INR',
    }).returning();
    const [quote] = await db.insert(s.quotes).values({ ref: 'MMAKF-QUO-TEST-0001' }).returning();
    const [qv] = await db.insert(s.quoteVersions).values({
      quoteId: quote.id, version: 1, status: 'issued',
      frameworkId: fw.id, frameworkCode: fw.code, inputs: {},
      subtotalMinor: 5_000_000, totalMinor: 5_000_000, currency: 'INR',
    }).returning();

    const stamp = await prepareStamp(db, {
      baseTotalMinor: 5_000_000, presentmentCurrency: 'USD', asOf: '2026-04-05',
    });
    const stamped = await stampQuoteVersion(db, qv.id, stamp);
    expect(Number(stamped.fxRatePpm)).toBe(12_000);
    expect(stamped.currencyMinorUnit).toBe(2);

    // Re-quoting is a NEW version; the issued one never re-rates.
    await expect(stampQuoteVersion(db, qv.id, stamp)).rejects.toThrow(/NEW version/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('tax is versioned, and a published rate is frozen', () => {
  let RULE = 0;
  let V1 = 0;

  beforeAll(async () => {
    const jur = await createJurisdiction(db, ctx, {
      code: 'TEST-JUR', name: 'Test jurisdiction', countryCode: 'ZZ',
    });
    JUR = jur.id;
    const rule = await createTaxRule(db, ctx, {
      code: 'TEST-STANDARD', label: 'Standard-rated fixture supply',
      jurisdictionId: JUR, treatment: 'standard', audience: 'school',
    });
    RULE = rule.id;
  });

  it('needs feeframework authority to author a rule, and payments authority is not it', async () => {
    // TRAINING_OPERATIONS issues quotations and reads frameworks. It must not be
    // able to decide what tax the federation charges.
    await expect(createTaxRule(db, opsCtx, {
      code: 'SNEAK', label: 'Sneaky', jurisdictionId: JUR, treatment: 'standard',
    })).rejects.toThrow();
    await expect(createJurisdiction(db, athleteCtx, {
      code: 'SNEAK-JUR', name: 'Sneaky', countryCode: 'ZZ',
    })).rejects.toThrow();
  });

  it('refuses a standard-rated version with no rate — that is a treatment, not a number', async () => {
    await expect(addRateVersion(db, ctx, RULE, { effectiveFrom: '2026-04-01' }))
      .rejects.toThrow(/exempt or zero_rated, not a rate of zero/);
  });

  it('does NOT apply a DRAFT rate — an unapproved rate never reaches a customer', async () => {
    const v1 = await addRateVersion(db, ctx, RULE, {
      ratePpm: 100_000, effectiveFrom: '2026-04-01', authorityRef: 'FIXTURE/1',
    });
    V1 = v1.id;
    expect(v1.status).toBe('draft');

    const c = await computeTax(db, {
      baseMinor: 5_000_000, asAt: '2026-06-01',
      jurisdictionCode: 'TEST-JUR', audience: 'school',
    });
    // Not taxed at zero — the rule matched but its rate is unpublished, so it
    // goes to `skipped` where an administrator will see it.
    expect(c.taxMinor).toBe(0);
    expect(c.configured).toBe(false);
    expect(c.skipped.map((x) => x.ruleCode)).toContain('TEST-STANDARD');
    expect(c.skipped[0].because).toMatch(/no published rate version/);
  });

  it('applies it once published, and shows the working', async () => {
    await publishRateVersion(db, ctx, V1);
    const c = await computeTax(db, {
      baseMinor: 5_000_000, asAt: '2026-06-01',
      jurisdictionCode: 'TEST-JUR', audience: 'school',
    });
    expect(c.configured).toBe(true);
    expect(c.taxMinor).toBe(applyFactor(5_000_000, 100_000));
    expect(c.totalMinor).toBe(5_000_000 + c.taxMinor);
    expect(c.notice).toBeNull();

    const [line] = c.lines;
    expect(line.ruleCode).toBe('TEST-STANDARD');
    expect(line.ratePpm).toBe(100_000);
    expect(line.rateVersion).toBe(1);
    expect(line.authorityRef).toBe('FIXTURE/1');
    expect(line.taxableMinor).toBe(5_000_000);
    expect(line.jurisdictionCode).toBe('TEST-JUR');
  });

  it('needs the publish authority separately from the write authority', async () => {
    const draft = await addRateVersion(db, ctx, RULE, {
      ratePpm: 120_000, effectiveFrom: '2027-04-01', authorityRef: 'FIXTURE/2',
    });
    await expect(publishRateVersion(db, opsCtx, draft.id)).rejects.toThrow();
    await expect(publishRateVersion(db, athleteCtx, draft.id)).rejects.toThrow();
    // Publish it properly for the tests below.
    await publishRateVersion(db, ctx, draft.id);
  });

  it('cannot publish the same version twice', async () => {
    await expect(publishRateVersion(db, ctx, V1)).rejects.toThrow(/cannot be published again/);
    try {
      await publishRateVersion(db, ctx, V1);
    } catch (e) {
      expect(isTaxError(e)).toBe(true);
      expect((e as any).code).toBe('already_published');
    }
  });

  it('A HISTORICAL COMPUTATION IS UNCHANGED BY A NEW RATE VERSION', async () => {
    // Version 2 is published and effective from 2027-04-01. The 2026 answer
    // must be untouched — this is the tax counterpart of the fee engine's
    // "a historical quote is unchanged by a new framework version".
    const before = await computeTax(db, {
      baseMinor: 5_000_000, asAt: '2026-06-01',
      jurisdictionCode: 'TEST-JUR', audience: 'school',
    });
    const after = await computeTax(db, {
      baseMinor: 5_000_000, asAt: '2027-06-01',
      jurisdictionCode: 'TEST-JUR', audience: 'school',
    });
    expect(before.lines[0].rateVersion).toBe(1);
    expect(before.lines[0].ratePpm).toBe(100_000);
    expect(after.lines[0].rateVersion).toBe(2);
    expect(after.lines[0].ratePpm).toBe(120_000);
    expect(after.taxMinor).toBeGreaterThan(before.taxMinor);
  });

  it('marks the old version SUPERSEDED, not withdrawn, so an old invoice can still be reconstructed', async () => {
    const [v1] = await db.select().from(s.taxRateVersions).where(eq(s.taxRateVersions.id, V1)).limit(1);
    expect(v1.status).toBe('superseded');
    expect(v1.supersededById).toBeTruthy();
    // And it is still the version in force for a 2026 date.
    const inForce = await rateInForce(db, RULE, '2026-06-01');
    expect(inForce.id).toBe(V1);
  });

  it('a WITHDRAWN version applies to nothing, including history', async () => {
    const rule = await createTaxRule(db, ctx, {
      code: 'TEST-WITHDRAWN', label: 'Published in error',
      jurisdictionId: JUR, treatment: 'standard', audience: 'university',
    });
    const v = await addRateVersion(db, ctx, rule.id, { ratePpm: 500_000, effectiveFrom: '2026-01-01' });
    await publishRateVersion(db, ctx, v.id);
    expect((await rateInForce(db, rule.id, '2026-06-01')).id).toBe(v.id);

    await expect(withdrawRateVersion(db, ctx, v.id, '')).rejects.toThrow(/needs a reason/);
    await withdrawRateVersion(db, ctx, v.id, 'Published against the wrong jurisdiction.');

    expect(await rateInForce(db, rule.id, '2026-06-01')).toBeNull();
    const c = await computeTax(db, {
      baseMinor: 1_000_000, asAt: '2026-06-01',
      jurisdictionCode: 'TEST-JUR', audience: 'university',
    });
    expect(c.taxMinor).toBe(0);
    expect(c.configured).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('exempt is a DECISION, and having no rule is not', () => {
  let EXEMPT_JUR = 0;

  beforeAll(async () => {
    const j = await createJurisdiction(db, ctx, {
      code: 'TEST-EXEMPT-JUR', name: 'Exempt fixture jurisdiction', countryCode: 'ZZ',
    });
    EXEMPT_JUR = j.id;
    await createTaxRule(db, ctx, {
      code: 'TEST-EXEMPT', label: 'Determined exempt',
      jurisdictionId: EXEMPT_JUR, treatment: 'exempt', audience: 'ngo',
      taxCode: 'FIXTURE-SAC',
    });
  });

  it('adds nothing — and reports that somebody DECIDED it adds nothing', async () => {
    const c = await computeTax(db, {
      baseMinor: 5_000_000, asAt: '2026-06-01',
      jurisdictionCode: 'TEST-EXEMPT-JUR', audience: 'ngo',
    });
    expect(c.taxMinor).toBe(0);
    expect(c.totalMinor).toBe(5_000_000);
    // THE DISTINCTION. Same number as the unconfigured case above, opposite
    // meaning, and the two are told apart by `configured` and `notice` — never
    // by the amount, which cannot tell them apart and never could.
    expect(c.configured).toBe(true);
    expect(c.notice).toBeNull();
    expect(c.lines[0].treatment).toBe('exempt');
    expect(c.lines[0].taxCode).toBe('FIXTURE-SAC');
    expect(c.lines[0].ratePpm).toBeNull();
  });

  it('an exempt rule needs no rate version at all', async () => {
    const v = await addRateVersion(db, ctx, (await db.select().from(s.taxRules)
      .where(eq(s.taxRules.code, 'TEST-EXEMPT')).limit(1))[0].id, {
      effectiveFrom: '2026-04-01', authorityRef: 'FIXTURE/EXEMPT',
    });
    expect(v.ratePpm).toBeNull();
    await publishRateVersion(db, ctx, v.id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('tax is computed server-side, from circumstances, never from a client amount', () => {
  it('resolves as at a DATE, and refuses "now"', async () => {
    await expect(computeTax(db, { baseMinor: 100, asAt: 'today' } as any))
      .rejects.toThrow(/never "now"/);
  });

  it('refuses a non-integer base', async () => {
    await expect(computeTax(db, { baseMinor: 100.5, asAt: '2026-06-01' }))
      .rejects.toThrow(/integer minor units/);
  });

  it('refuses an unknown jurisdiction rather than quietly charging nothing', async () => {
    // The important half: an unanswerable question must not look like "no tax".
    await expect(computeTax(db, {
      baseMinor: 100, asAt: '2026-06-01', jurisdictionCode: 'NOWHERE',
    })).rejects.toThrow(/No tax jurisdiction is recorded/);
  });

  it('records why every rule it rejected was rejected', async () => {
    const c = await computeTax(db, {
      baseMinor: 5_000_000, asAt: '2026-06-01',
      jurisdictionCode: 'TEST-JUR', audience: 'corporate',
    });
    expect(c.configured).toBe(false);
    expect(c.skipped.length).toBeGreaterThan(0);
    expect(c.skipped[0].because).toMatch(/audience is corporate/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the tax working is frozen onto the invoice too', () => {
  let invoiceId = 0;

  beforeAll(async () => {
    const [order] = await db.insert(s.orders).values({
      orderNo: 'MMAKF-ORD-2026-000002', buyerName: 'Second Institution',
      status: 'paid', subtotalPaise: 5_000_000, totalPaise: 5_000_000, currency: 'INR',
    }).returning();
    const invoice = await issueInvoice(db, order.id);
    invoiceId = invoice.id;
  });

  it('writes a self-contained snapshot an auditor can read without the tables', async () => {
    const c = await computeTax(db, {
      baseMinor: 5_000_000, asAt: '2026-06-01',
      jurisdictionCode: 'TEST-JUR', audience: 'school',
    });
    const stamped = await stampInvoiceTax(db, invoiceId, c);
    const snap: any = stamped.taxSnapshot;

    expect(snap.configured).toBe(true);
    expect(snap.asAt).toBe('2026-06-01');
    expect(snap.taxMinor).toBe(c.taxMinor);
    // Rule CODES and version NUMBERS as text, not row ids to chase.
    expect(snap.lines[0].ruleCode).toBe('TEST-STANDARD');
    expect(snap.lines[0].rateVersion).toBe(1);
    expect(snap.lines[0].ratePpm).toBe(100_000);
    expect(snap.lines[0].authorityRef).toBe('FIXTURE/1');
    // Compared as objects, not as strings: Postgres does not preserve jsonb key
    // order, and asserting on the serialisation would test libpq rather than
    // the snapshot.
    expect(snap).toEqual(taxSnapshot(c));
  });

  it('refuses to restate the tax on an issued invoice', async () => {
    const c = await computeTax(db, {
      baseMinor: 5_000_000, asAt: '2027-06-01',
      jurisdictionCode: 'TEST-JUR', audience: 'school',
    });
    await expect(stampInvoiceTax(db, invoiceId, c)).rejects.toThrow(/credit note/);
  });

  it('leaves the 2026 snapshot saying 2026 things after the 2027 rate exists', async () => {
    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId)).limit(1);
    expect((invoice.taxSnapshot as any).lines[0].ratePpm).toBe(100_000);
    expect((invoice.taxSnapshot as any).lines[0].rateVersion).toBe(1);
  });
});
