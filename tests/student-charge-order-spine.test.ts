// THE ORDER SPINE, ATTACKED.
//
//     A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT.
//
// src/db/student-rule.ts guards the fee FRAMEWORK — fee_rules, at addRule() and
// at publishFramework(). That is the register that produces QUOTATIONS. It is
// not the register that produces INVOICES.
//
// createOrder() prices from two entirely different tables:
//
//   · `fee_schedule`     — a flat published-fee register, read by `feeCode`
//   · `product_variants` — the merchandise catalogue, read by `variantId`
//
// Nothing in src/ writes to either one, which sounds reassuring and is the
// opposite: it means every row in them arrives from a seed, a migration, a
// restored backup or an operator's INSERT — the four authors src/db/student-rule.ts
// names at the top of its own file as the reason deletion was not enough.
//
// Both are reachable by an ANONYMOUS, UNAUTHENTICATED POST to
// /api/payments/checkout, which whitelists `kind`, `feeCode` and `variantId`
// straight through to createOrder(). So a single row of
//
//   { code: 'MEM-JUNIOR', label: 'Junior student membership (annual)',
//     kind: 'membership', amountPaise: 50000 }
//
// was a ₹500 charge on a child, on an invoice, with a payment behind it, having
// touched no fee framework at all. That is MEM-JUNIOR — the exact rule the
// federation withdrew on 17 August 2026 — alive one table across.
//
// Every test below is either that attack or the thing that must keep working
// while it is refused. The second half matters as much as the first: a guard
// that also blocks the COACH membership the federation genuinely charges is
// wrong in the quieter direction, and gets deleted by the first person it
// inconveniences.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from '../src/db/schema';
import {
  createOrder, beginPayment, confirmPayment, issueInvoice, OrderError,
} from '../src/db/orders';
import { activateForOrder, configureTerm, EntitlementError } from '../src/db/entitlements';
import type { Principal } from '../src/lib/rbac';
import type { VerifiedPayment } from '../src/lib/payments';
import type { AuditContext } from '../src/db/federation';

let db: any;
let STATE: number;
let DOJO: number;
let GI_VARIANT: number;
let MEMBERSHIP_VARIANT: number;
let HANDBOOK_VARIANT: number;

const admin: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const ctx = (p: Principal = admin): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

const captured = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
  providerOrderId: '',
  amountPaise: 0,
  currency: 'INR',
  status: 'captured',
  method: 'upi',
  ...over,
});

async function makePerson(name: string) {
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(Math.floor(Math.random() * 899999) + 100000)}`,
    fullName: name, status: 'active', dob: '2012-05-05', gender: 'male',
    stateUnitId: STATE, dojoId: DOJO,
  }).returning({ id: s.persons.id });
  return p.id as number;
}

/** Order, payment attempt, verified capture. The whole money path. */
async function payFor(lines: any[], personId?: number | null) {
  const order = await createOrder(db, null, {
    personId: personId ?? null, email: 'payer@example.in', lines,
  });
  const payment = await beginPayment(db, order.id, {
    provider: 'razorpay',
    providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
    amountPaise: order.totalPaise,
    idempotencyKey: crypto.randomUUID(),
  });
  const result = await confirmPayment(db, null, captured({
    providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise,
  }));
  return { order, payment, result };
}

const countOrders = async () => (await db.select().from(s.orders)).length;
const countInvoices = async () => (await db.select().from(s.invoices)).length;

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [st] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand unit', status: 'active',
  }).returning({ id: s.stateUnits.id });
  STATE = st.id;
  const [dj] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-JH-001', name: 'Patratu Dojo', stateUnitId: STATE, status: 'active',
  }).returning({ id: s.dojos.id });
  DOJO = dj.id;

  // ── The fee_schedule register, seeded exactly as an operator would ──
  //
  // Both rows are inserted directly, because that is the whole threat model:
  // no function in src/ writes this table, so a guard that lived at an INSERT
  // it never passes through would guard nothing.
  await db.insert(s.feeSchedule).values([
    // The withdrawn charge, in the two spellings it comes back as.
    { code: 'MEM-JUNIOR', label: 'Junior student membership (annual)', kind: 'membership', amountPaise: 50000, effectiveFrom: '2026-01-01', active: true },
    { code: 'annual.junior', label: 'Junior annual', kind: 'membership', amountPaise: 30000, effectiveFrom: '2026-01-01', active: true },
    // The membership the federation DOES charge, and must keep charging.
    { code: 'membership.coach.annual', label: 'Coach membership (annual)', kind: 'membership', amountPaise: 200000, effectiveFrom: '2026-01-01', active: true },
    // Standing for a body. Always permitted — a club is not a person in a class.
    { code: 'affiliation.dojo.annual', label: 'Dojo affiliation (annual)', kind: 'affiliation', amountPaise: 500000, effectiveFrom: '2026-01-01', active: true },
    // What a student DOES pay for: things the federation delivers.
    { code: 'grading.kyu', label: 'Kyu grading examination', kind: 'grading', amountPaise: 40000, effectiveFrom: '2026-01-01', active: true },
    { code: 'training.monthly', label: 'Monthly training subscription', kind: 'training', amountPaise: 80000, effectiveFrom: '2026-01-01', active: true },
    { code: 'entry.national', label: 'National championship registration', kind: 'event_entry', amountPaise: 90000, effectiveFrom: '2026-01-01', active: true },
  ]);

  // ── The merchandise catalogue ──
  const [gi] = await db.insert(s.products).values({
    sku: 'GI-STD', name: 'Shotokan Gi', category: 'Uniform', status: 'active', taxRateBps: 500,
  }).returning({ id: s.products.id });
  const [giV] = await db.insert(s.productVariants).values({
    productId: gi.id, sku: 'GI-STD-150', label: 'Size 150cm', pricePaise: 250000, stockQty: 40, status: 'active',
  }).returning({ id: s.productVariants.id });
  GI_VARIANT = giV.id;

  // The same withdrawn charge, wearing the merchandise catalogue's clothes. A
  // membership does not have stock; this row says it has forty.
  const [memProduct] = await db.insert(s.products).values({
    sku: 'MEM-JUNIOR-2026', name: 'Junior membership (annual)', category: 'Membership', status: 'active',
  }).returning({ id: s.products.id });
  const [memV] = await db.insert(s.productVariants).values({
    productId: memProduct.id, sku: 'MEM-JUNIOR-2026-1Y', label: '1 year', pricePaise: 50000, stockQty: 40, status: 'active',
  }).returning({ id: s.productVariants.id });
  MEMBERSHIP_VARIANT = memV.id;

  // AND THE THING THE GUARD MUST NOT BLOCK. A handbook is a book. Its name
  // carries a standing word and names no payer, and the shop must still sell it
  // — refusing merchandise on the strength of a word in its title is the
  // over-blocking failure, and it is the quieter of the two.
  const [book] = await db.insert(s.products).values({
    sku: 'BOOK-MEM-HANDBOOK', name: 'Member handbook', category: 'Books', status: 'active',
  }).returning({ id: s.products.id });
  const [bookV] = await db.insert(s.productVariants).values({
    productId: book.id, sku: 'BOOK-MEM-HANDBOOK-PB', label: 'Paperback', pricePaise: 30000, stockQty: 100, status: 'active',
  }).returning({ id: s.productVariants.id });
  HANDBOOK_VARIANT = bookV.id;

  await configureTerm(db, ctx(), {
    feeCode: 'membership.coach.annual', subject: 'membership',
    membershipCategory: 'instructor', termMonths: 12,
    approvedBy: 'Executive Committee',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE ATTACK: the fee_schedule register
// ─────────────────────────────────────────────────────────────────────────────

describe('a published fee cannot charge a student for being one', () => {
  it('refuses MEM-JUNIOR before an order number is even consumed', async () => {
    const before = await countOrders();
    await expect(createOrder(db, null, {
      email: 'parent@example.in',
      lines: [{ kind: 'membership', description: '', feeCode: 'MEM-JUNIOR' }],
    })).rejects.toThrow(/student/i);
    // NOTHING WRITTEN. Not a cancelled order, not a burnt order number, not a
    // reserved stock row — the refusal happens while the transaction is empty.
    expect(await countOrders()).toBe(before);
    expect(await countInvoices()).toBe(0);
  });

  it('carries the refusal code, so a surface can say why', async () => {
    const err = await createOrder(db, null, {
      email: 'parent@example.in',
      lines: [{ kind: 'membership', description: '', feeCode: 'MEM-JUNIOR' }],
    }).catch((e: any) => e);
    expect(err).toBeInstanceOf(OrderError);
    expect(err.code).toBe('student_charge_refused');
  });

  it('refuses the row whose NAME says nothing, on the column that does', async () => {
    // 'annual.junior' / 'Junior annual' contains no standing word anywhere. The
    // only thing saying it is a membership is `fee_schedule.kind`, which is why
    // the guard reads the row rather than the wording somebody chose.
    await expect(createOrder(db, null, {
      email: 'parent@example.in',
      lines: [{ kind: 'course', description: '', feeCode: 'annual.junior' }],
    })).rejects.toThrow(/student/i);
  });

  it('is not fooled by the browser relabelling the line', async () => {
    // /api/payments/checkout passes `kind` through from the request body. A
    // client calling its junior membership a 'grading' must not thereby buy one.
    // `as const` keeps these as the literal union DraftLine.kind requires; a
    // plain array widens every element to `string`.
    for (const kind of ['grading', 'course', 'event_entry', 'product', 'other'] as const) {
      await expect(createOrder(db, null, {
        email: 'parent@example.in',
        lines: [{ kind, description: 'Grading', feeCode: 'MEM-JUNIOR' }],
      })).rejects.toThrow(/student/i);
    }
  });

  it('cannot be smuggled in beside a legitimate line', async () => {
    const before = await countOrders();
    await expect(createOrder(db, null, {
      email: 'parent@example.in',
      lines: [
        { kind: 'grading', description: '', feeCode: 'grading.kyu' },
        { kind: 'membership', description: '', feeCode: 'MEM-JUNIOR' },
      ],
    })).rejects.toThrow(/student/i);
    // The whole order fails. A partial order — the grading kept, the membership
    // dropped — would charge a family a figure nobody quoted them.
    expect(await countOrders()).toBe(before);
  });

  it('refuses identically the second time, and the tenth', async () => {
    // Idempotent in the only sense a refusal can be: no accumulated state, no
    // row that makes attempt two behave differently from attempt one.
    const before = await countOrders();
    for (let i = 0; i < 10; i += 1) {
      await expect(createOrder(db, null, {
        email: 'parent@example.in',
        lines: [{ kind: 'membership', description: '', feeCode: 'MEM-JUNIOR' }],
      })).rejects.toThrow(/student/i);
    }
    expect(await countOrders()).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE ATTACK: the merchandise catalogue
// ─────────────────────────────────────────────────────────────────────────────

describe('a membership cannot be sold as an item with stock', () => {
  it('refuses a membership line priced from product_variants', async () => {
    const before = await countOrders();
    const err = await createOrder(db, null, {
      email: 'parent@example.in',
      lines: [{ kind: 'membership', description: '', variantId: MEMBERSHIP_VARIANT }],
    }).catch((e: any) => e);
    expect(err).toBeInstanceOf(OrderError);
    expect(err.code).toBe('standing_is_not_stock');
    expect(await countOrders()).toBe(before);
  });

  it('refuses it again when the line calls itself a product', async () => {
    // The structural refusal above is escaped by one word. This one reads the
    // CATALOGUE's name for the item, which the caller does not control.
    const err = await createOrder(db, null, {
      email: 'parent@example.in',
      lines: [{ kind: 'product', description: 'Gi', variantId: MEMBERSHIP_VARIANT }],
    }).catch((e: any) => e);
    expect(err).toBeInstanceOf(OrderError);
    expect(err.code).toBe('student_charge_refused');
  });

  it('reserves no stock on the way out', async () => {
    // The refusal must happen before the reservation, or an abandoned attack
    // holds forty memberships nobody can buy for forty-five minutes.
    const [v] = await db.select().from(s.productVariants)
      .where(eq(s.productVariants.id, MEMBERSHIP_VARIANT));
    expect(v.reservedQty).toBe(0);
  });

  it('still sells a member handbook', async () => {
    // The over-blocking test with teeth. 'Member handbook' is a standing word
    // and no payer at all — the verdict the FEE register refuses outright. On a
    // shelf it is a book, and the shop keeps selling it.
    const order = await createOrder(db, null, {
      email: 'buyer@example.in', shipTo: { line1: 'Patratu' },
      lines: [{ kind: 'product', description: '', variantId: HANDBOOK_VARIANT }],
    });
    expect(order.totalPaise).toBe(30000);
  });

  it('still sells a gi', async () => {
    // THE OVER-BLOCKING TEST. Merchandise is merchandise.
    const order = await createOrder(db, null, {
      email: 'buyer@example.in', shipTo: { line1: 'Patratu' },
      lines: [{ kind: 'product', description: '', variantId: GI_VARIANT, quantity: 2 }],
    });
    expect(order.totalPaise).toBe(250000 * 2 + Math.round((250000 * 2 * 500) / 10_000));
    expect(order.lines[0].description).toBe('Shotokan Gi — Size 150cm');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2b. THE ATTACK: a quotation nobody's framework agreed to
// ─────────────────────────────────────────────────────────────────────────────

describe('the third price source', () => {
  it('refuses a quote-priced line that calls itself a junior membership', async () => {
    // `quote_versions` stores a TOTAL and no line detail, so what the invoice
    // ends up SAYING comes from the caller. On the sanctioned path the caller is
    // src/db/quote-to-order.ts, which composes its own text — but the row itself
    // arrives from issueQuote(), or from a seed, and the line that pays for it
    // is a caller's object either way.
    const [fw] = await db.insert(s.feeFrameworks).values({
      code: 'MMAKF-FEE-V1', title: 'Framework 1', version: 1, status: 'published',
    }).returning({ id: s.feeFrameworks.id });
    const [q] = await db.insert(s.quotes).values({ ref: 'MMAKF-QUO-2026-000001' })
      .returning({ id: s.quotes.id });
    const [qv] = await db.insert(s.quoteVersions).values({
      quoteId: q.id, version: 1, status: 'accepted',
      frameworkId: fw.id, frameworkCode: 'MMAKF-FEE-V1', inputs: {},
      subtotalMinor: 50000, adjustmentMinor: 0, taxMinor: 0, totalMinor: 50000,
      currency: 'INR',
    }).returning({ id: s.quoteVersions.id });

    await expect(createOrder(db, null, {
      email: 'parent@example.in',
      lines: [{ kind: 'membership', description: 'Junior membership 2026-27', quoteVersionId: qv.id }],
    })).rejects.toThrow(/student/i);

    // And the honest quotation line the office actually raises still prices.
    const order = await createOrder(db, null, {
      email: 'school@example.in',
      lines: [{ kind: 'other', description: 'Quotation MMAKF-QUO-2026-000001 version 1', quoteVersionId: qv.id }],
    });
    expect(order.totalPaise).toBe(50000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE OTHER DIRECTION: what must keep working
// ─────────────────────────────────────────────────────────────────────────────

describe('the memberships the federation does charge are untouched', () => {
  it('prices, invoices and activates a COACH membership', async () => {
    const personId = await makePerson('Sensei Kumar');
    const { order } = await payFor(
      [{ kind: 'membership', description: '', feeCode: 'membership.coach.annual' }],
      personId
    );
    expect(order.totalPaise).toBe(200000);

    const invoice = await issueInvoice(db, order.id);
    expect(invoice.invoiceNo).toMatch(/^MMAKF\//);
    expect((invoice.snapshot as any).lines[0].description).toBe('Coach membership (annual)');

    const ents = await db.select().from(s.entitlements).where(eq(s.entitlements.orderId, order.id));
    expect(ents).toHaveLength(1);
    expect(ents[0].status).toBe('active');

    const mem = await db.select().from(s.memberships)
      .where(and(eq(s.memberships.personId, personId), eq(s.memberships.category, 'instructor')));
    expect(mem).toHaveLength(1);
  });

  it('prices a dojo affiliation', async () => {
    const order = await createOrder(db, null, {
      email: 'dojo@example.in',
      lines: [{ kind: 'affiliation', description: '', feeCode: 'affiliation.dojo.annual' }],
    });
    expect(order.totalPaise).toBe(500000);
  });

  it('prices everything a student legitimately buys', async () => {
    // A grading, a month of training and a championship entry. All three are
    // charges ON a student, and all three are for something DELIVERED — which
    // is the distinction the whole rule turns on. 'Monthly training
    // subscription' and 'National championship registration' both carry a
    // standing word beside a delivered service, and both must price.
    for (const [feeCode, kind, amount] of [
      ['grading.kyu', 'grading', 40000],
      ['training.monthly', 'training', 80000],
      ['entry.national', 'event_entry', 90000],
    ] as const) {
      const order = await createOrder(db, null, {
        email: 'student@example.in', lines: [{ kind, description: '', feeCode }],
      });
      expect(order.totalPaise).toBe(amount);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE ATTACK: the row that says what a fee BUYS
// ─────────────────────────────────────────────────────────────────────────────

describe('a legitimate fee cannot be configured to buy a student membership', () => {
  it('refuses at configuration', async () => {
    await expect(configureTerm(db, ctx(), {
      feeCode: 'membership.coach.annual', subject: 'membership',
      membershipCategory: 'athlete' as any, termMonths: 12,
    })).rejects.toThrow(EntitlementError);
  });

  it('refuses to ACT on one that was inserted around configureTerm()', async () => {
    // THE ROW THAT WAS ALREADY THERE. configureTerm() guards an author.
    // entitlement_terms rows arrive from seeds, migrations and restored
    // backups, and rows written before the refusal existed are still in the
    // table. This is the same argument publishFramework() makes about
    // fee_rules, applied to the register one table down.
    await db.insert(s.feeSchedule).values({
      code: 'membership.coach.premium', label: 'Coach membership (premium)',
      kind: 'membership', amountPaise: 300000, effectiveFrom: '2026-01-01', active: true,
    });
    await db.insert(s.entitlementTerms).values({
      feeCode: 'membership.coach.premium', subject: 'membership',
      membershipCategory: 'athlete', termMonths: 12,
    });

    const personId = await makePerson('A child in Patratu');
    const { order } = await payFor(
      [{ kind: 'membership', description: '', feeCode: 'membership.coach.premium' }],
      personId
    );

    // THE PAYMENT IS RECORDED. It happened; a ledger edited to make a new rule
    // look tidy is a falsified ledger.
    const paid = (await db.select().from(s.orders).where(eq(s.orders.id, order.id)))[0];
    expect(paid.status).toBe('paid');
    expect(paid.totalPaise).toBe(300000);

    // AND NOTHING WAS GRANTED.
    const ents = await db.select().from(s.entitlements).where(eq(s.entitlements.orderId, order.id));
    expect(ents).toHaveLength(1);
    expect(ents[0].status).toBe('blocked');
    expect(ents[0].reason).toMatch(/student does not pay a membership fee/i);

    const mem = await db.select().from(s.memberships)
      .where(and(eq(s.memberships.personId, personId), eq(s.memberships.category, 'athlete')));
    expect(mem).toHaveLength(0);
  });

  it('is still blocked when activation is re-run', async () => {
    // Idempotency at the last hop: a reconcile sweep, a webhook retry and a
    // manual re-run all reach activateForOrder(). None of them may turn a
    // blocked entitlement into an issued membership, and none may make a second
    // row for the same line.
    const order = (await db.select().from(s.orders)
      .where(eq(s.orders.totalPaise, 300000)))[0];
    await activateForOrder(db, null, order.id);
    await activateForOrder(db, null, order.id);
    const ents = await db.select().from(s.entitlements).where(eq(s.entitlements.orderId, order.id));
    expect(ents).toHaveLength(1);
    expect(ents[0].status).toBe('blocked');
    expect(await db.select().from(s.memberships)
      .where(eq(s.memberships.category, 'athlete'))).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. NEVER A FABRICATED AMOUNT, NEVER A CLIENT-SUPPLIED ONE
// ─────────────────────────────────────────────────────────────────────────────

describe('the amount', () => {
  it('is never invented when no fee is published', async () => {
    // Not zero. Zero reads as FREE, and free is a price the federation did not
    // set any more than ₹500 is.
    const err = await createOrder(db, null, {
      email: 'x@example.in',
      lines: [{ kind: 'grading', description: '', feeCode: 'grading.dan' }],
    }).catch((e: any) => e);
    expect(err.code).toBe('fee_not_published');
  });

  it('ignores a forged total on the line', async () => {
    // The oldest attack there is, submitted in the shape /api/payments/checkout
    // would let through if it forwarded the field.
    const order = await createOrder(db, null, {
      email: 'x@example.in',
      lines: [{ kind: 'grading', description: '', feeCode: 'grading.kyu', unitPricePaise: 1 } as any],
    });
    expect(order.totalPaise).toBe(40000);
  });

  it('ignores a forged price on a merchandise line', async () => {
    const order = await createOrder(db, null, {
      email: 'x@example.in', shipTo: { line1: 'Patratu' },
      lines: [{ kind: 'product', description: '', variantId: GI_VARIANT, unitPricePaise: 100 } as any],
    });
    expect(order.lines[0].unitPricePaise).toBe(250000);
  });

  it('refuses a negative carriage charge', async () => {
    await expect(createOrder(db, null, {
      email: 'x@example.in', shippingPaise: -400000,
      lines: [{ kind: 'product', description: '', variantId: GI_VARIANT }],
    })).rejects.toThrow(/negative/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. HISTORY IS NOT REWRITTEN
// ─────────────────────────────────────────────────────────────────────────────

describe('a charge that was genuinely taken stays exactly as it was', () => {
  it('leaves a 2019 junior membership order, line and invoice byte-identical', async () => {
    // The federation's rule governs what may be charged FROM NOW ON. If a
    // payment taken in 2019 contained a junior membership charge, that record
    // stays — and stays readable, and stays saying what it said.
    const [old] = await db.insert(s.orders).values({
      orderNo: 'MMAKF-ORD-2019-000001', status: 'paid',
      buyerName: 'A parent', email: 'archive@example.in',
      subtotalPaise: 30000, taxPaise: 0, shippingPaise: 0, totalPaise: 30000,
    }).returning();
    const [oldLine] = await db.insert(s.orderLines).values({
      orderId: old.id, kind: 'membership', feeCode: 'MEM-JUNIOR',
      description: 'Junior athlete membership 2019-20',
      quantity: 1, unitPricePaise: 30000, taxRateBps: 0, taxPaise: 0, totalPaise: 30000,
    }).returning();
    const oldInvoice = await issueInvoice(db, old.id);

    const snapshot = JSON.stringify({ old, oldLine, invoice: oldInvoice });

    // Now run every guard in the system, several times over.
    for (let i = 0; i < 3; i += 1) {
      await createOrder(db, null, {
        email: 'x@example.in',
        lines: [{ kind: 'membership', description: '', feeCode: 'MEM-JUNIOR' }],
      }).catch(() => null);
      await createOrder(db, null, {
        email: 'x@example.in',
        lines: [{ kind: 'membership', description: '', variantId: MEMBERSHIP_VARIANT }],
      }).catch(() => null);
      await activateForOrder(db, null, old.id).catch(() => null);
    }

    const after = {
      old: (await db.select().from(s.orders).where(eq(s.orders.id, old.id)))[0],
      oldLine: (await db.select().from(s.orderLines).where(eq(s.orderLines.id, oldLine.id)))[0],
      invoice: (await db.select().from(s.invoices).where(eq(s.invoices.id, oldInvoice.id)))[0],
    };
    expect(JSON.stringify(after)).toBe(snapshot);
    expect(after.oldLine.description).toBe('Junior athlete membership 2019-20');
    expect(after.oldLine.totalPaise).toBe(30000);
  });

  it('issues the same invoice twice, not two invoices', async () => {
    const one = (await db.select().from(s.orders)
      .where(eq(s.orders.orderNo, 'MMAKF-ORD-2019-000001')))[0];
    const a = await issueInvoice(db, one.id);
    const b = await issueInvoice(db, one.id);
    expect(b.id).toBe(a.id);
    expect(b.invoiceNo).toBe(a.invoiceNo);
  });
});
