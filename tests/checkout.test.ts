// The checkout, and the four things it must never be talked into.
//
// A forged price. A price read on a date the buyer chose. A price from a
// framework that has expired, or one that has not started yet. And a total that
// appears when the federation has published nothing — which is today, for
// everything.
//
// Most of this file is adversarial. The honest paths are quick to assert; the
// interesting work is submitting a tampered basket by every route a body can
// carry one, and proving the figure that comes out is byte-identical to the
// figure computed from the same basket with nothing forged in it.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import {
  CHECKOUT_UNPAYABLE,
  MAX_UNITS,
  assertGatewayAmount,
  assertNoServerOwnedFields,
  describeCheckout,
  findServerOwnedFields,
  isCheckoutError,
  isPayable,
  parseCheckoutRequest,
  paymentIntent,
  priceCheckout,
  type CheckoutRequest,
} from '../src/db/checkout';
import { seedFeeCatalogue } from '../src/db/fee-catalogue';
import { addRule, createFramework, publishFramework } from '../src/db/fees';
import {
  addDiscountRule, createDiscountPolicy, issueDiscountCode, publishDiscountPolicy,
} from '../src/db/discounts';
import { configureTerm } from '../src/db/entitlements';
import type { Principal } from '../src/lib/rbac';

let db: any;

const finance: Principal = {
  userId: 1, label: 'finance',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const ctx = { principal: finance };

const daysFromToday = (n: number): string =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** A basket the parse would have produced, without going through a body. */
const basket = (
  items: Array<{ serviceCode: string; quantity?: number; beneficiaryLabel?: string }>,
  extra: Partial<CheckoutRequest> = {}
): CheckoutRequest => ({
  items: items.map((i) => ({
    serviceCode: i.serviceCode,
    quantity: i.quantity ?? 1,
    beneficiaryLabel: i.beneficiaryLabel ?? null,
    selections: {},
  })),
  discountCodes: extra.discountCodes ?? [],
  audience: extra.audience ?? null,
});

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  await db.insert(s.users).values([{ id: 1, email: 'finance@mmakf.in', status: 'active' }]);
  await seedFeeCatalogue(db, ctx);
});

// ─────────────────────────────────────────────────────────────────────────────
// TODAY: NOTHING IS PUBLISHED, SO NOTHING HAS A PRICE
// ─────────────────────────────────────────────────────────────────────────────

describe('with no published framework, which is the state of this system', () => {
  it('refuses to price a grading, and says why without a figure', async () => {
    const q = await priceCheckout(db, basket([{ serviceCode: 'MMAKF-FEE-GRD-KYU' }]));
    expect(isPayable(q)).toBe(false);
    expect(q.outcome).toBe(CHECKOUT_UNPAYABLE);
    if (isPayable(q)) throw new Error('unreachable');
    expect(q.reason).toBe('no_framework');
    expect(q.notice).toMatch(/Pricing unavailable/);
    expect(q.notice).toMatch(/quotation/i);
    expect(q.notice).not.toMatch(/free|₹|0\.00/i);
  });

  it('carries no totalMinor property at all — not zero', async () => {
    const q = await priceCheckout(db, basket([{ serviceCode: 'MMAKF-FEE-GRD-KYU' }]));
    expect('totalMinor' in q).toBe(false);
    expect((q as any).totalMinor).toBeUndefined();
  });

  it('throws rather than coercing to a number, a string, or an accumulator', async () => {
    const q: any = await priceCheckout(db, basket([{ serviceCode: 'MMAKF-FEE-GRD-KYU' }]));
    expect(() => Number(q)).toThrow(/no total/i);
    expect(() => `${q}`).toThrow(/no total/i);
    expect(() => 0 + q).toThrow(/no total/i);
    // The route a real bug takes: a running total in a loop.
    expect(() => { let t = 0; t += q; return t; }).toThrow(/no total/i);
  });

  it('refuses to open a payment for it', async () => {
    const q = await priceCheckout(db, basket([{ serviceCode: 'MMAKF-FEE-GRD-KYU' }]));
    expect(() => paymentIntent(q)).toThrow(/no published price/i);
    try {
      paymentIntent(q);
    } catch (err) {
      expect(isCheckoutError(err)).toBe(true);
      expect((err as any).code).toBe('checkout_not_payable');
    }
  });

  it('still shows the buyer every line, with the federation’s own sentence', async () => {
    const q = await priceCheckout(db, basket([
      { serviceCode: 'MMAKF-FEE-GRD-KYU', beneficiaryLabel: 'Aarav' },
      { serviceCode: 'MMAKF-FEE-DOC-CERTIFICATE', beneficiaryLabel: 'Aarav' },
    ]));
    expect(q.lines).toHaveLength(2);
    expect(q.lines.every((l) => l.grossMinor === null)).toBe(true);
    const words = describeCheckout(q).join('\n');
    expect(words).toMatch(/Aarav/);
    expect(words).not.toMatch(/₹0/);
  });

  it('will not price a training service to a public viewer at all — it is quotable', async () => {
    const q = await priceCheckout(db, basket([{ serviceCode: 'MMAKF-FEE-TRN-INDIVIDUAL' }]));
    expect(isPayable(q)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BROWSER MAY NOT SEND A PRICE
// ─────────────────────────────────────────────────────────────────────────────

describe('a client may name what it is buying and nothing about what it costs', () => {
  it('finds a forged amount at any depth, under any spelling', () => {
    const found = findServerOwnedFields({
      items: [{ serviceCode: 'MMAKF-FEE-GRD-KYU', amountPaise: 1 }],
      totalMinor: 999,
      meta: { nested: { deeper: { discount_amount: 50 } } },
      shipTo: { tax_rate: 18 },
    });
    expect(found).toContain('items[0].amountPaise');
    expect(found).toContain('totalMinor');
    expect(found).toContain('meta.nested.deeper.discount_amount');
    expect(found).toContain('shipTo.tax_rate');
  });

  it('does not mistake a discount CODE for a discount AMOUNT', () => {
    expect(findServerOwnedFields({ discountCodes: ['FAMILY'] })).toEqual([]);
    expect(findServerOwnedFields({ discount_codes: ['FAMILY'] })).toEqual([]);
  });

  it('treats the PRICING DATE as the federation’s to choose', () => {
    // The attack that does not look like one: a valid basket, priced under a
    // framework that was in force when it was cheaper.
    const found = findServerOwnedFields({ items: [], asAt: '2019-01-01' });
    expect(found).toContain('asAt');
    expect(findServerOwnedFields({ as_at: 'x' })).toContain('as_at');
    expect(findServerOwnedFields({ priceDate: 'x' })).toContain('priceDate');
    expect(findServerOwnedFields({ frameworkId: 3 })).toContain('frameworkId');
  });

  it('treats WHO IS BUYING as the session’s to decide', () => {
    expect(findServerOwnedFields({ personId: 7 })).toContain('personId');
    expect(findServerOwnedFields({ quoteVersionId: 12 })).toContain('quoteVersionId');
  });

  it('has nowhere to put a forged field even when it is not detected', () => {
    const parsed = parseCheckoutRequest({
      items: [{
        serviceCode: 'MMAKF-FEE-GRD-KYU',
        quantity: 1,
        // Every one of these is a price by another name.
        amountPaise: 1, unitPricePaise: 1, sneaky_total: 1,
      }],
      totalPaise: 1,
    });
    const line: any = parsed.request.items[0];
    expect(Object.keys(line).sort()).toEqual(
      ['beneficiaryLabel', 'quantity', 'selections', 'serviceCode']
    );
    expect(line.amountPaise).toBeUndefined();
    expect((parsed.request as any).totalPaise).toBeUndefined();
    expect(parsed.refusedFields.length).toBeGreaterThan(0);
  });

  it('strips the engine’s own quantity keys out of a buyer’s selections', () => {
    // `sessions: 1` against a per-session rule is a term of training bought at
    // the price of a lesson — a price the buyer chose, through a count.
    const parsed = parseCheckoutRequest({
      items: [{
        serviceCode: 'MMAKF-FEE-EDU-CAMP',
        selections: { sessions: 1, travelKm: 0, participants: 99, ageBand: 'junior' },
      }],
    });
    expect(parsed.request.items[0].selections).toEqual({ ageBand: 'junior' });
  });

  it('refuses loudly when asked to', () => {
    expect(() => assertNoServerOwnedFields({ items: [], totalMinor: 5 }))
      .toThrow(/decides for itself/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A PUBLISHED FRAMEWORK — AND THE FORGED TOTAL THAT CHANGES NOTHING
// ─────────────────────────────────────────────────────────────────────────────

describe('once the federation publishes a fee', () => {
  const KYU = 'MMAKF-FEE-GRD-KYU';
  let frameworkId = 0;

  beforeAll(async () => {
    const fw = await createFramework(db, ctx, {
      title: 'Test framework', version: 1, effectiveFrom: daysFromToday(-30),
    });
    frameworkId = fw.id;
    await addRule(db, ctx, frameworkId, {
      code: 'GRD-KYU-BASE',
      label: 'Kyu grading examination',
      kind: 'per_participant',
      // ₹1,200.00. A TEST figure, in a test database, never seeded anywhere.
      amountMinor: 120_000,
      conditions: { serviceCode: KYU },
      sortOrder: 10,
    });
    await publishFramework(db, ctx, frameworkId);
  });

  it('prices the line, and explains which rule and which condition did it', async () => {
    const q = await priceCheckout(db, basket([{ serviceCode: KYU, beneficiaryLabel: 'Aarav' }]));
    expect(isPayable(q)).toBe(true);
    if (!isPayable(q)) throw new Error('unreachable');

    expect(q.lines).toHaveLength(1);
    const line = q.lines[0];
    expect(line.grossMinor).toBe(120_000);
    expect(line.beneficiaryLabel).toBe('Aarav');
    expect(line.unitOfSale).toBe('per_person');
    expect(line.frequency).toBe('per_event');
    expect(line.detail).toHaveLength(1);
    expect(line.detail[0].because).toMatch(/serviceCode is MMAKF-FEE-GRD-KYU/);
    expect(q.totalMinor).toBe(120_000);
    expect(q.subtotalMinor + q.discountMinor + q.concessionMinor + q.taxMinor).toBe(q.totalMinor);
  });

  it('IGNORES A FORGED TOTAL — the computed figure is identical either way', async () => {
    const honest = parseCheckoutRequest({ items: [{ serviceCode: KYU }] });
    const forged = parseCheckoutRequest({
      items: [{ serviceCode: KYU, amountPaise: 1, unitPricePaise: 1, quantity: 1 }],
      totalMinor: 1,
      totalPaise: 1,
      subtotal: 1,
      tax: 0,
      discountMinor: -119_900,
      currency: 'USD',
    });

    const a = await priceCheckout(db, honest.request);
    const b = await priceCheckout(db, forged.request);
    if (!isPayable(a) || !isPayable(b)) throw new Error('both should price');

    // ₹1 was asked for. ₹1,200 is what the federation charges.
    expect(b.totalMinor).toBe(120_000);
    expect(b.totalMinor).toBe(a.totalMinor);
    expect(b.currency).toBe('INR');
    expect(b.discountMinor).toBe(0);
    expect(b.reductions).toHaveLength(0);
    // And the forgery was seen, not merely survived.
    expect(forged.refusedFields).toEqual(expect.arrayContaining(['totalMinor', 'items[0].amountPaise']));
  });

  it('refuses a gateway that comes back with a different figure', async () => {
    const q = await priceCheckout(db, basket([{ serviceCode: KYU }]));
    expect(() => assertGatewayAmount(q, { amountMinor: 120_000, currency: 'INR' })).not.toThrow();
    expect(() => assertGatewayAmount(q, { amountMinor: 100, currency: 'INR' }))
      .toThrow(/must be the same figure/);
    expect(() => assertGatewayAmount(q, { amountMinor: 120_000, currency: 'USD' }))
      .toThrow(/must be the same figure/);
    expect(() => assertGatewayAmount(q, { amountMinor: '120000' as any, currency: 'INR' }))
      .toThrow(/must be the same figure/);
  });

  it('creates the payment intent from its own figure and nothing else', async () => {
    const q = await priceCheckout(db, basket([{ serviceCode: KYU }]));
    const intent = paymentIntent(q);
    expect(intent.amountMinor).toBe(120_000);
    expect(intent.currency).toBe('INR');
    expect(intent.frameworkVersion).toBe(1);
  });

  // ── The family case ──

  it('prices two children as TWO lines, never as one multiplied figure', async () => {
    const q = await priceCheckout(db, basket([
      { serviceCode: KYU, beneficiaryLabel: 'Aarav' },
      { serviceCode: KYU, beneficiaryLabel: 'Diya' },
    ]));
    if (!isPayable(q)) throw new Error('should price');
    expect(q.lines).toHaveLength(2);
    expect(q.lines.map((l) => l.beneficiaryLabel)).toEqual(['Aarav', 'Diya']);
    expect(q.lines.every((l) => l.grossMinor === 120_000)).toBe(true);
    expect(q.totalMinor).toBe(240_000);

    const words = describeCheckout(q);
    expect(words.filter((w) => w.includes('Aarav'))).toHaveLength(1);
    expect(words.filter((w) => w.includes('Diya'))).toHaveLength(1);
  });

  it('a quantity of two is two lines, not one line times two', async () => {
    const q = await priceCheckout(db, basket([{ serviceCode: KYU, quantity: 2 }]));
    if (!isPayable(q)) throw new Error('should price');
    expect(q.lines).toHaveLength(2);
    expect(q.lines.map((l) => l.unitIndex)).toEqual([1, 2]);
    expect(q.lines.map((l) => l.unitCount)).toEqual([2, 2]);
  });

  it('shows a family discount as ITS OWN LINE, with its reason, once', async () => {
    const policy = await createDiscountPolicy(db, ctx, {
      title: 'Family rates', version: 1, effectiveFrom: daysFromToday(-10),
    });
    const rule = await addDiscountRule(db, ctx, policy.id, {
      code: 'FAMILY-SIBLING',
      label: 'Sibling rate',
      basis: 'percentage',
      // The stage matters: with no tax rule in this framework, before_tax and
      // after_tax are the same point. See the note in src/db/checkout.ts.
      stage: 'after_tax',
      percentPpm: 100_000,                       // 10%
      conditions: { beneficiaries: { min: 2 } },
    });
    await publishDiscountPolicy(db, ctx, policy.id);
    // Codes are minted inactive; activation is a second, deliberate act.
    await issueDiscountCode(db, ctx, rule.id, { code: 'SIBLING10', activate: true });

    const q = await priceCheckout(
      db,
      basket(
        [
          { serviceCode: KYU, beneficiaryLabel: 'Aarav' },
          { serviceCode: KYU, beneficiaryLabel: 'Diya' },
        ],
        { discountCodes: ['SIBLING10'] }
      ),
      { subject: { personId: null } }
    );
    if (!isPayable(q)) throw new Error(`should price: ${(q as any).reason}`);

    expect(q.lines).toHaveLength(2);
    expect(q.reductions).toHaveLength(1);
    const r = q.reductions[0];
    // The RULE code, never the token the parent typed.
    expect(r.code).toBe('FAMILY-SIBLING');
    expect(r.label).toBe('Sibling rate');
    expect(r.amountMinor).toBe(-24_000);          // 10% of ₹2,400
    expect(r.because).toMatch(/beneficiaries 2 is within 2/);
    expect(q.discountMinor).toBe(-24_000);
    expect(q.totalMinor).toBe(216_000);
    expect(q.subtotalMinor + q.discountMinor + q.concessionMinor + q.taxMinor).toBe(q.totalMinor);

    // Applied ONCE to the basket, not once per child.
    expect(q.reductions.filter((x) => x.code === 'FAMILY-SIBLING')).toHaveLength(1);
  });

  it('tells a lone parent why the sibling code did nothing', async () => {
    const q = await priceCheckout(
      db,
      basket([{ serviceCode: KYU, beneficiaryLabel: 'Aarav' }], { discountCodes: ['SIBLING10'] })
    );
    if (!isPayable(q)) throw new Error('should price');
    expect(q.reductions).toHaveLength(0);
    expect(q.totalMinor).toBe(120_000);
    expect(q.refusedCodes[0].reason).toMatch(/does not apply here/i);
  });

  it('refuses a discount AMOUNT even when it is dressed as a code', async () => {
    // The only thing a client may send about a discount is the string. There is
    // no field on the request for a magnitude, and a forged one is reported.
    const parsed = parseCheckoutRequest({
      items: [{ serviceCode: KYU }],
      discountCodes: ['SIBLING10'],
      discountMinor: -1_000_000,
    });
    expect(parsed.refusedFields).toContain('discountMinor');
    const q = await priceCheckout(db, parsed.request);
    if (!isPayable(q)) throw new Error('should price');
    expect(q.discountMinor).toBe(0);
    expect(q.totalMinor).toBe(120_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AN EXPIRED FEE, AND ONE THAT HAS NOT STARTED
// ─────────────────────────────────────────────────────────────────────────────

describe('a fee framework is only usable while it is in force', () => {
  let expiredDb: any;
  const KYU = 'MMAKF-FEE-GRD-KYU';

  beforeAll(async () => {
    // Its own database. A framework's effective window is global, and the
    // suite above needs one that is in force today.
    const client = new PGlite();
    expiredDb = drizzle(client, { schema: s });
    for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
      for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (st.trim()) await client.exec(st.trim());
      }
    }
    await expiredDb.insert(s.users).values([{ id: 1, email: 'finance@mmakf.in', status: 'active' }]);
    await seedFeeCatalogue(expiredDb, ctx);
  });

  it('will not price a purchase made today from a framework that expired yesterday', async () => {
    const fw = await createFramework(expiredDb, ctx, {
      title: 'Last year', version: 1, effectiveFrom: daysFromToday(-400),
    });
    await addRule(expiredDb, ctx, fw.id, {
      code: 'OLD-KYU', label: 'Kyu grading (last year)', kind: 'per_participant',
      amountMinor: 50_000, conditions: { serviceCode: KYU }, sortOrder: 10,
    });
    await publishFramework(expiredDb, ctx, fw.id);
    await expiredDb.update(s.feeFrameworks)
      .set({ effectiveTo: daysFromToday(-1) })
      .where(eq(s.feeFrameworks.id, fw.id));

    const q = await priceCheckout(expiredDb, basket([{ serviceCode: KYU }]));
    expect(isPayable(q)).toBe(false);
    if (isPayable(q)) throw new Error('unreachable');
    // Never the ₹500 the expired framework said.
    expect((q as any).totalMinor).toBeUndefined();
    expect(q.notice).toMatch(/Pricing unavailable/);

    // And it PRICED while it was in force — the guard is the date, not the row.
    const then = await priceCheckout(expiredDb, basket([{ serviceCode: KYU }]), {
      asAt: daysFromToday(-30),
    });
    expect(isPayable(then)).toBe(true);
    if (isPayable(then)) expect(then.totalMinor).toBe(50_000);
  });

  it('a framework dated to start next month does not price a purchase made today', async () => {
    const future = await createFramework(expiredDb, ctx, {
      title: 'Next year', version: 2, effectiveFrom: daysFromToday(30),
    });
    await addRule(expiredDb, ctx, future.id, {
      code: 'NEW-KYU', label: 'Kyu grading (next year)', kind: 'per_participant',
      amountMinor: 90_000, conditions: { serviceCode: KYU }, sortOrder: 10,
    });
    await publishFramework(expiredDb, ctx, future.id);

    const today = await priceCheckout(expiredDb, basket([{ serviceCode: KYU }]));
    expect(isPayable(today)).toBe(false);
    if (isPayable(today)) throw new Error('unreachable');
    expect(today.reason).toBe('no_framework');

    // It applies on the day it comes into force, and not one day earlier.
    const eve = await priceCheckout(expiredDb, basket([{ serviceCode: KYU }]), {
      asAt: daysFromToday(29),
    });
    expect(isPayable(eve)).toBe(false);

    const dayOne = await priceCheckout(expiredDb, basket([{ serviceCode: KYU }]), {
      asAt: daysFromToday(30),
    });
    expect(isPayable(dayOne)).toBe(true);
    if (isPayable(dayOne)) expect(dayOne.totalMinor).toBe(90_000);
  });

  it('a buyer cannot reach the pricing date, so cannot reach the cheaper framework', () => {
    // priceCheckout() takes asAt from its OPTIONS, which only server code fills
    // in. Nothing a body can say survives the parse.
    const parsed = parseCheckoutRequest({
      items: [{ serviceCode: KYU }],
      asAt: daysFromToday(-30),
      as_at: daysFromToday(-30),
      priceDate: daysFromToday(-30),
    });
    expect((parsed.request as any).asAt).toBeUndefined();
    expect(parsed.refusedFields).toEqual(
      expect.arrayContaining(['asAt', 'as_at', 'priceDate'])
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WHAT A PAYMENT BUYS, AND FOR HOW LONG
// ─────────────────────────────────────────────────────────────────────────────

describe('a period of cover has to say how long it covers', () => {
  let termDb: any;
  const MONTHLY = 'MMAKF-FEE-TRN-INDIVIDUAL';

  beforeAll(async () => {
    const client = new PGlite();
    termDb = drizzle(client, { schema: s });
    for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
      for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (st.trim()) await client.exec(st.trim());
      }
    }
    await termDb.insert(s.users).values([{ id: 1, email: 'finance@mmakf.in', status: 'active' }]);
    await seedFeeCatalogue(termDb, ctx);
    const fw = await createFramework(termDb, ctx, {
      title: 'Training', version: 1, effectiveFrom: daysFromToday(-30),
    });
    await addRule(termDb, ctx, fw.id, {
      code: 'TRN-IND', label: 'Individual training', kind: 'per_participant',
      amountMinor: 80_000, conditions: { serviceCode: MONTHLY }, sortOrder: 10,
    });
    await publishFramework(termDb, ctx, fw.id);
  });

  it('will not sell a monthly service with no recorded term', async () => {
    // Staff viewer, because individual training is quotable to the public.
    const q = await priceCheckout(termDb, basket([{ serviceCode: MONTHLY }]), { viewer: 'staff' });
    expect(isPayable(q)).toBe(false);
    if (isPayable(q)) throw new Error('unreachable');
    expect(q.reason).toBe('term_not_stated');
    expect(q.blocking[0].detail).toMatch(/No entitlement term is configured/);
  });

  it('sells it once the federation records what a month buys', async () => {
    await configureTerm(termDb, ctx, {
      feeCode: MONTHLY, subject: 'program', termMonths: 1,
    });
    const q = await priceCheckout(termDb, basket([{ serviceCode: MONTHLY }]), { viewer: 'staff' });
    expect(isPayable(q)).toBe(true);
    if (!isPayable(q)) throw new Error('unreachable');
    expect(q.lines[0].termMonths).toBe(1);
    expect(q.lines[0].termLabel).toMatch(/1 month — cover to \d{4}-\d{2}-\d{2}\./);
  });

  it('and there is no membership line on any of it', async () => {
    const q = await priceCheckout(termDb, basket([{ serviceCode: MONTHLY }]), { viewer: 'staff' });
    const words = describeCheckout(q).join('\n').toLowerCase();
    expect(words).not.toMatch(/membership/);
    expect(words).not.toMatch(/registration fee/);
    expect(words).not.toMatch(/platform fee/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE OF A REQUEST
// ─────────────────────────────────────────────────────────────────────────────

describe('the request parser', () => {
  it('insists on at least one item', () => {
    expect(() => parseCheckoutRequest({ items: [] })).toThrow(/at least one service/);
    expect(() => parseCheckoutRequest({})).toThrow(/at least one service/);
    expect(() => parseCheckoutRequest([])).toThrow(/object naming/);
    expect(() => parseCheckoutRequest(null)).toThrow(/object naming/);
  });

  it('bounds the basket', () => {
    expect(() => parseCheckoutRequest({
      items: [{ serviceCode: 'MMAKF-FEE-GRD-KYU', quantity: MAX_UNITS + 1 }],
    })).toThrow(/between 1 and/);
    expect(() => parseCheckoutRequest({
      items: [
        { serviceCode: 'MMAKF-FEE-GRD-KYU', quantity: MAX_UNITS },
        { serviceCode: 'MMAKF-FEE-GRD-DAN', quantity: 1 },
      ],
    })).toThrow(/at most 20 units/);
  });

  it('refuses a negative or fractional quantity rather than defaulting it to 1', () => {
    expect(() => parseCheckoutRequest({
      items: [{ serviceCode: 'MMAKF-FEE-GRD-KYU', quantity: -5 }],
    })).toThrow(/between 1 and/);
    // A fraction is not an integer, so it is not accepted as a count.
    const parsed = parseCheckoutRequest({
      items: [{ serviceCode: 'MMAKF-FEE-GRD-KYU', quantity: 1.5 }],
    });
    expect(parsed.request.items[0].quantity).toBe(1);
  });

  it('caps the discount codes and reports what it dropped', () => {
    const parsed = parseCheckoutRequest({
      items: [{ serviceCode: 'MMAKF-FEE-GRD-KYU' }],
      discountCodes: ['A1', 'B2', 'C3', 'D4', 'E5', 'F6', 'G7'],
    });
    expect(parsed.request.discountCodes.length).toBeLessThanOrEqual(5);
    expect(parsed.rejectedCodes.length).toBeGreaterThan(0);
  });

  it('accepts nothing but a plain value as a selection', () => {
    expect(() => parseCheckoutRequest({
      items: [{ serviceCode: 'MMAKF-FEE-GRD-KYU', selections: ['school'] }],
    })).toThrow(/flat object/);
    const parsed = parseCheckoutRequest({
      items: [{
        serviceCode: 'MMAKF-FEE-GRD-KYU',
        selections: { ageBand: 'junior', nested: { min: 1 }, ok: true },
      }],
    });
    expect(parsed.request.items[0].selections).toEqual({ ageBand: 'junior', ok: true });
  });
});
