// THE THREE REGISTERS THAT CAN CHARGE SOMEBODY, AND THE ONE THAT MINTS THE CARD.
//
// tests/student-not-a-member.test.ts proves that `fee_rules` cannot hold a
// student membership. `fee_rules` is not the table anybody is charged from.
// Three other tables can take money or issue a credential, and each of them is
// reachable without passing through a fee framework at all:
//
//   fee_schedule       what createOrder() actually prices a `feeCode` line from.
//                      Nothing in src/ writes it, so every row in it arrived
//                      from a seed, a migration, a restored backup or an
//                      operator's INSERT.
//   products/variants  the shop. A product row is a price with a name on it.
//   entitlement_terms  what a paid fee BUYS. configureTerm() guards the front
//                      door; the table takes an INSERT like any other.
//
// Every test below is an attack, and each one is run through the same public
// path a buyer would use: create the order, capture the payment, read what came
// out. The two properties being defended are opposites and both matter —
//
//   a student membership must not reach an invoice, AND
//   a COACH membership must still be charged for and still be issued.
//
// A guard that only satisfies the first is not a fix; it is the federation's
// actual revenue switched off quietly.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from '../src/db/schema';
import {
  createOrder, beginPayment, confirmPayment, issueInvoice, OrderError,
} from '../src/db/orders';
import { configureTerm, blockedEntitlements, EntitlementError } from '../src/db/entitlements';
import { renew, revoke, standing } from '../src/db/membership';
import type { Principal } from '../src/lib/rbac';
import type { VerifiedPayment } from '../src/lib/payments';
import type { AuditContext } from '../src/db/federation';

let db: any;
let STATE: number, DOJO: number;

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
    fullName: name, status: 'active', dob: '1990-05-05', gender: 'male',
    stateUnitId: STATE, dojoId: DOJO,
  }).returning({ id: s.persons.id });
  return p.id as number;
}

/** Order -> payment attempt -> verified capture. The whole money path. */
async function payFor(lines: any[], personId: number | null = null) {
  const order = await createOrder(db, null, { personId, email: 'payer@example.in', lines });
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

/** Insert a fee_schedule row the way a seed or an operator would — no guard. */
const scheduleFee = (row: Record<string, unknown>) =>
  db.insert(s.feeSchedule).values({
    scopeType: 'national', effectiveFrom: '2026-01-01', active: true, ...row,
  } as any);

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
  await db.insert(s.users).values([{ id: 1, email: 'admin@mmakf.in', status: 'active' }]);

  const [st] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand unit', status: 'active',
  }).returning({ id: s.stateUnits.id });
  STATE = st.id;
  const [dj] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-JH-001', name: 'Ranchi Dojo', stateUnitId: STATE, status: 'active',
  }).returning({ id: s.dojos.id });
  DOJO = dj.id;
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE FEE SCHEDULE — the table createOrder() actually charges from
// ─────────────────────────────────────────────────────────────────────────────

describe('a student membership inserted straight into fee_schedule cannot be charged', () => {
  it('refuses the row the schema comment itself gives as an example', async () => {
    // 'membership.athlete.annual' is the literal example beside fee_schedule.code
    // in src/db/commerce.schema.ts. If any row was ever going to be written by
    // somebody reading the code, it is this one.
    await scheduleFee({
      code: 'membership.athlete.annual', label: 'Athlete membership (annual)',
      kind: 'membership', amountPaise: 50000,
    });
    await expect(createOrder(db, null, {
      lines: [{ kind: 'membership', description: '', feeCode: 'membership.athlete.annual' }],
    })).rejects.toThrow(/student/i);

    try {
      await createOrder(db, null, {
        lines: [{ kind: 'membership', description: '', feeCode: 'membership.athlete.annual' }],
      });
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(OrderError);
      expect((err as OrderError).code).toBe('student_charge_refused');
    }
  });

  it('refuses a junior membership however blandly it is coded', async () => {
    await scheduleFee({
      code: 'MMAKF-2026-A', label: 'Junior membership (annual)',
      kind: 'membership', amountPaise: 50000,
    });
    await expect(createOrder(db, null, {
      lines: [{ kind: 'membership', description: '', feeCode: 'MMAKF-2026-A' }],
    })).rejects.toThrow(/student/i);
  });

  it('refuses a row whose NAME says nothing and whose kind column says membership', async () => {
    // The interesting one. Neither the code nor the label carries the word; the
    // `kind` column is the only place the row admits what it is.
    await scheduleFee({
      code: 'annual.junior.2026', label: 'Junior 2026',
      kind: 'membership', amountPaise: 30000,
    });
    await expect(createOrder(db, null, {
      lines: [{ kind: 'membership', description: '', feeCode: 'annual.junior.2026' }],
    })).rejects.toThrow(/student/i);
  });

  it('refuses a student REGISTRATION fee — registration is not a product either', async () => {
    await scheduleFee({
      code: 'reg.student.2026', label: 'Student registration fee',
      kind: 'membership', amountPaise: 20000,
    });
    await expect(createOrder(db, null, {
      lines: [{ kind: 'membership', description: '', feeCode: 'reg.student.2026' }],
    })).rejects.toThrow(/student/i);
  });

  it('is not evaded by the caller relabelling the line as something else', async () => {
    // `line.kind` is whatever the browser said. The guard reads the ROW.
    await scheduleFee({
      code: 'athlete.dues.2026', label: 'Athlete dues',
      kind: 'membership', amountPaise: 25000,
    });
    for (const kind of ['course', 'product', 'donation', 'other', 'grading']) {
      await expect(createOrder(db, null, {
        lines: [{ kind, description: 'a course, honest', feeCode: 'athlete.dues.2026' }],
      } as any)).rejects.toThrow(/student/i);
    }
  });

  it('refuses it inside a basket, so nothing else on the order is charged either', async () => {
    await scheduleFee({
      code: 'grading.kyu', label: 'Kyu grading fee', kind: 'grading', amountPaise: 60000,
    });
    const before = (await db.select().from(s.orders)).length;
    await expect(createOrder(db, null, {
      lines: [
        { kind: 'grading', description: '', feeCode: 'grading.kyu' },
        { kind: 'membership', description: '', feeCode: 'membership.athlete.annual' },
      ],
    })).rejects.toThrow(/student/i);
    // No order number consumed, no line written, nothing reserved.
    expect((await db.select().from(s.orders)).length).toBe(before);
  });

  it('reaches no invoice, because it reaches no order', async () => {
    const invoicesBefore = (await db.select().from(s.invoices)).length;
    await expect(createOrder(db, null, {
      lines: [{ kind: 'membership', description: '', feeCode: 'membership.athlete.annual' }],
    })).rejects.toThrow();
    expect((await db.select().from(s.invoices)).length).toBe(invoicesBefore);
    const lines = await db.select().from(s.orderLines)
      .where(eq(s.orderLines.feeCode, 'membership.athlete.annual'));
    expect(lines).toHaveLength(0);
  });

  it('refuses identically the second time — a retry is not a way in', async () => {
    const attempt = () => createOrder(db, null, {
      lines: [{ kind: 'membership', description: '', feeCode: 'membership.athlete.annual' }],
    });
    const first: any = await attempt().catch((e) => e);
    const second: any = await attempt().catch((e) => e);
    expect(first.code).toBe('student_charge_refused');
    expect(second.code).toBe('student_charge_refused');
    expect(second.message).toBe(first.message);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. AND THE HALF THAT MATTERS JUST AS MUCH — the memberships MMAKF DOES charge
// ─────────────────────────────────────────────────────────────────────────────

describe('the memberships the federation actually charges are untouched', () => {
  beforeAll(async () => {
    await scheduleFee({ code: 'membership.coach.annual', label: 'Coach membership (annual)', kind: 'membership', amountPaise: 150000 });
    await scheduleFee({ code: 'membership.official.annual', label: 'Official membership (annual)', kind: 'membership', amountPaise: 120000 });
    await scheduleFee({ code: 'membership.examiner.annual', label: 'Examiner membership (annual)', kind: 'membership', amountPaise: 200000 });
    await scheduleFee({ code: 'affiliation.dojo.annual', label: 'Dojo affiliation (annual)', kind: 'affiliation', amountPaise: 500000 });
    await scheduleFee({ code: 'affiliation.school', label: 'School affiliation', kind: 'affiliation', amountPaise: 800000 });
    await scheduleFee({ code: 'entry.national', label: 'National championship entry', kind: 'event_entry', amountPaise: 80000 });
    await scheduleFee({ code: 'course.coach.l1', label: 'Coach Level 1 course', kind: 'course', amountPaise: 350000 });
    await scheduleFee({ code: 'cert.replacement', label: 'Replacement certificate', kind: 'certificate', amountPaise: 15000 });
  });

  it.each([
    ['membership.coach.annual', 150000],
    ['membership.official.annual', 120000],
    ['membership.examiner.annual', 200000],
    ['affiliation.dojo.annual', 500000],
    ['affiliation.school', 800000],
    ['entry.national', 80000],
    ['course.coach.l1', 350000],
    ['cert.replacement', 15000],
  ])('%s still prices at the figure the federation set', async (code, paise) => {
    const order = await createOrder(db, null, {
      lines: [{ kind: 'membership', description: '', feeCode: code as string }],
    });
    expect(order.totalPaise).toBe(paise);
  });

  it('a coach membership goes all the way to an invoice', async () => {
    const personId = await makePerson('Coach Sensei');
    await configureTerm(db, ctx(), {
      feeCode: 'membership.coach.annual', subject: 'membership',
      membershipCategory: 'instructor', termMonths: 12, approvedBy: 'Executive Committee',
    });
    const { order } = await payFor(
      [{ kind: 'membership', description: '', feeCode: 'membership.coach.annual', refType: 'person', refId: personId }],
      personId
    );
    const invoice = await issueInvoice(db, order.id);
    expect(invoice.invoiceNo).toBeTruthy();
    expect((invoice.snapshot as any).totalPaise).toBe(150000);

    // And the register really has the coach in it.
    const answer = await standing(db, admin, personId, 'instructor');
    expect(answer.covered).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE TERM TABLE — a legitimate NAME configured to mint a student card
// ─────────────────────────────────────────────────────────────────────────────

describe('a fee named for a coach cannot be configured to issue a student membership', () => {
  it('configureTerm() refuses the category outright', async () => {
    await expect(configureTerm(db, ctx(), {
      feeCode: 'membership.coach.annual', subject: 'membership',
      membershipCategory: 'athlete', termMonths: 12,
    })).rejects.toThrow(/student/i);

    try {
      await configureTerm(db, ctx(), {
        feeCode: 'membership.coach.annual', subject: 'membership',
        membershipCategory: 'athlete', termMonths: 12,
      });
      throw new Error('unreachable');
    } catch (err) {
      expect(err).toBeInstanceOf(EntitlementError);
      expect((err as EntitlementError).code).toBe('student_membership_refused');
    }
  });

  it('leaves the coach term it refused to overwrite exactly as it was', async () => {
    const [term] = await db.select().from(s.entitlementTerms)
      .where(eq(s.entitlementTerms.feeCode, 'membership.coach.annual'));
    expect(term.membershipCategory).toBe('instructor');
    expect(term.termMonths).toBe(12);
  });

  it('ATTACK: a term row INSERTED DIRECTLY still mints no membership', async () => {
    // The bypass configureTerm() cannot see. A seed, a migration, a restored
    // backup or an operator writes the row; the fee it names is a legitimate
    // coach membership that prices and charges cleanly.
    await scheduleFee({
      code: 'membership.coach.regional', label: 'Coach membership (regional)',
      kind: 'membership', amountPaise: 90000,
    });
    await db.insert(s.entitlementTerms).values({
      feeCode: 'membership.coach.regional', subject: 'membership',
      membershipCategory: 'athlete', termMonths: 12,
      approvedBy: 'inserted by hand', setByUserId: null,
    } as any);

    const personId = await makePerson('Smuggled Junior');
    const { order } = await payFor(
      [{ kind: 'membership', description: '', feeCode: 'membership.coach.regional', refType: 'person', refId: personId }],
      personId
    );

    // NO MEMBERSHIP OF ANY CATEGORY.
    const memberships = await db.select().from(s.memberships)
      .where(eq(s.memberships.personId, personId));
    expect(memberships).toHaveLength(0);

    // The entitlement is BLOCKED and says why, in words a desk can act on.
    const ents = await db.select().from(s.entitlements).where(eq(s.entitlements.orderId, order.id));
    expect(ents).toHaveLength(1);
    expect(ents[0].status).toBe('blocked');
    expect(ents[0].reason).toMatch(/student does not pay a membership fee/i);
    // The detail names the row that has to be corrected, so the refusal is
    // actionable rather than merely correct.
    expect((ents[0].detail as any).feeCode).toBe('membership.coach.regional');
  });

  it('and the money is still recorded, so it can be refunded rather than lost', async () => {
    const [row] = await db.select().from(s.orders)
      .innerJoin(s.orderLines, eq(s.orderLines.orderId, s.orders.id))
      .where(eq(s.orderLines.feeCode, 'membership.coach.regional'));
    expect(row.orders.status).toBe('paid');
    expect(row.orders.totalPaise).toBe(90000);
    const [payment] = await db.select().from(s.payments)
      .where(eq(s.payments.orderId, row.orders.id));
    expect(payment.status).toBe('captured');
    expect(payment.amountPaise).toBe(90000);
  });

  it('the blocked entitlement is visible to whoever has to clear it', async () => {
    const blocked = await blockedEntitlements(db, admin);
    expect(blocked.some((b: any) => /student does not pay a membership fee/i.test(String(b.reason)))).toBe(true);
  });

  it('a replayed capture blocks once, not twice', async () => {
    const personId = await makePerson('Replayed Junior');
    await scheduleFee({
      code: 'membership.coach.district', label: 'Coach membership (district)',
      kind: 'membership', amountPaise: 70000,
    });
    await db.insert(s.entitlementTerms).values({
      feeCode: 'membership.coach.district', subject: 'membership',
      membershipCategory: 'athlete', termMonths: 12,
    } as any);

    const order = await createOrder(db, null, {
      personId,
      lines: [{ kind: 'membership', description: '', feeCode: 'membership.coach.district', refType: 'person', refId: personId }],
    });
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    const v = captured({ providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise });
    await confirmPayment(db, null, v);
    await confirmPayment(db, null, v);   // the webhook's retry
    await confirmPayment(db, null, v);   // and the reconcile cron

    const ents = await db.select().from(s.entitlements).where(eq(s.entitlements.orderId, order.id));
    expect(ents).toHaveLength(1);
    expect(ents[0].status).toBe('blocked');
    expect(await db.select().from(s.memberships).where(eq(s.memberships.personId, personId))).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE SHOP — a fee wearing a barcode
// ─────────────────────────────────────────────────────────────────────────────

describe('the shop catalogue is a third register, and it is guarded too', () => {
  let juniorVariant = 0;
  let frameVariant = 0;
  let giVariant = 0;

  beforeAll(async () => {
    const mk = async (name: string, label: string, paise: number) => {
      const [p] = await db.insert(s.products).values({
        sku: `SKU-${crypto.randomBytes(4).toString('hex')}`, name, status: 'active', taxRateBps: 0,
      }).returning({ id: s.products.id });
      const [v] = await db.insert(s.productVariants).values({
        productId: p.id, sku: `V-${crypto.randomBytes(4).toString('hex')}`,
        label, pricePaise: paise, stockQty: 100, reservedQty: 0, status: 'active',
      }).returning({ id: s.productVariants.id });
      return v.id as number;
    };
    juniorVariant = await mk('Junior Membership 2026', 'Annual', 50000);
    frameVariant = await mk('Membership certificate frame', 'A4', 45000);
    giVariant = await mk('MMAKF karate gi', '160cm', 180000);
  });

  it('refuses a product that is a junior membership with a barcode on it', async () => {
    await expect(createOrder(db, null, {
      lines: [{ kind: 'product', description: '', variantId: juniorVariant, quantity: 1 }],
    })).rejects.toThrow(/student/i);
  });

  it('still sells the merchandise whose name merely mentions membership', async () => {
    // The over-blocking failure, tested for directly. A frame is a frame.
    const order = await createOrder(db, null, {
      lines: [{ kind: 'product', description: '', variantId: frameVariant, quantity: 1 }],
    });
    expect(order.totalPaise).toBe(45000);
  });

  it('still sells a gi', async () => {
    const order = await createOrder(db, null, {
      lines: [{ kind: 'product', description: '', variantId: giVariant, quantity: 2 }],
    });
    expect(order.totalPaise).toBe(360000);
  });

  it('reserves no stock for the line it refused', async () => {
    const [v] = await db.select().from(s.productVariants).where(eq(s.productVariants.id, juniorVariant));
    expect(v.reservedQty).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. NO FABRICATED AMOUNT, AND NO CLIENT-SUPPLIED ONE
// ─────────────────────────────────────────────────────────────────────────────

describe('an unpublished fee is refused, never rendered as nothing', () => {
  it('refuses rather than charging zero', async () => {
    await expect(createOrder(db, null, {
      lines: [{ kind: 'grading', description: '', feeCode: 'fee.nobody.published' }],
    })).rejects.toThrow(/No published fee/i);
    // Not a zero-rupee order sitting in the table.
    const zeroes = (await db.select().from(s.orders)).filter((o: any) => o.totalPaise === 0);
    expect(zeroes).toHaveLength(0);
  });

  it('refuses an inactive fee rather than falling back to a figure', async () => {
    await scheduleFee({
      code: 'grading.retired', label: 'Retired grading fee', kind: 'grading',
      amountPaise: 99900, active: false,
    });
    await expect(createOrder(db, null, {
      lines: [{ kind: 'grading', description: '', feeCode: 'grading.retired' }],
    })).rejects.toThrow(/No published fee/i);
  });
});

describe('a forged price on a fee line changes nothing', () => {
  it('the server charges its own figure, whatever the body said', async () => {
    const honest = await createOrder(db, null, {
      lines: [{ kind: 'grading', description: '', feeCode: 'grading.kyu' }],
    });
    const forged = await createOrder(db, null, {
      lines: [{
        kind: 'grading', description: '', feeCode: 'grading.kyu',
        // Every spelling a hostile client would try, at once.
        unitPricePaise: 1, amountPaise: 1, pricePaise: 1, totalPaise: 1,
        taxRateBps: 0, discountPaise: 59900,
      } as any],
      subtotalPaise: 1, taxPaise: 0, totalPaise: 1,
    } as any);
    expect(forged.totalPaise).toBe(honest.totalPaise);
    expect(forged.totalPaise).toBe(60000);
  });

  it('a negative shipping charge is refused rather than netted off', async () => {
    await expect(createOrder(db, null, {
      lines: [{ kind: 'grading', description: '', feeCode: 'grading.kyu' }],
      shippingPaise: -59900,
    } as any)).rejects.toThrow(/Shipping cannot be negative/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. HISTORY
// ─────────────────────────────────────────────────────────────────────────────

describe('a record that already contains a student membership charge is not rewritten', () => {
  it('stays byte-identical after every guard above has run', async () => {
    // A 2019 order, written the way the ledger has it. It is history, and the
    // federation's new rule governs what may be charged from now on.
    const [order] = await db.insert(s.orders).values({
      orderNo: 'MMAKF-ORD-2019-000001', buyerName: 'A parent', email: 'parent@example.in',
      status: 'paid', subtotalPaise: 50000, taxPaise: 0, shippingPaise: 0, totalPaise: 50000,
      fulfilment: 'not_required',
    }).returning();
    await db.insert(s.orderLines).values({
      orderId: order.id, kind: 'membership', feeCode: 'membership.athlete.annual',
      description: 'Athlete membership (annual)', quantity: 1,
      unitPricePaise: 50000, taxRateBps: 0, taxPaise: 0, totalPaise: 50000,
    });
    const invoice = await issueInvoice(db, order.id);
    const before = JSON.stringify({ order, invoice });

    // Now run every refusal this file is about, against the live system.
    await expect(createOrder(db, null, {
      lines: [{ kind: 'membership', description: '', feeCode: 'membership.athlete.annual' }],
    })).rejects.toThrow();
    await expect(configureTerm(db, ctx(), {
      feeCode: 'membership.athlete.annual', subject: 'membership',
      membershipCategory: 'athlete', termMonths: 12,
    })).rejects.toThrow();

    const [orderAfter] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    const [invoiceAfter] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoice.id));
    expect(JSON.stringify({ order: orderAfter, invoice: invoiceAfter })).toBe(before);

    // And the line is still there, still saying what it said.
    const [line] = await db.select().from(s.orderLines)
      .where(and(eq(s.orderLines.orderId, order.id), eq(s.orderLines.kind, 'membership')));
    expect(line.description).toBe('Athlete membership (annual)');
    expect(line.totalPaise).toBe(50000);
  });

  it('an athlete membership issued before today is still readable', async () => {
    const personId = await makePerson('An athlete from 2019');
    await db.insert(s.memberships).values({
      personId, category: 'athlete', validFrom: '2019-01-01', validTo: '2019-12-31',
      status: 'expired',
    });
    const rows = await db.select().from(s.memberships).where(eq(s.memberships.personId, personId));
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('athlete');
    // standing() answers about it honestly rather than pretending it never was.
    const answer = await standing(db, admin, personId, 'athlete');
    expect(answer.membership?.validFrom).toBe('2019-01-01');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. THE REGISTER ITSELF — the one creation point with no money in front of it
// ─────────────────────────────────────────────────────────────────────────────

describe('the register will not issue another student membership', () => {
  it('refuses renew() for the withdrawn category, with no fee anywhere in sight', async () => {
    // Every guard above is on the money path. This one is not: no order, no fee
    // code, no payment — just an administrator with 'membership:issue'.
    const personId = await makePerson('A child in Patratu');
    await expect(renew(db, ctx(), {
      personId, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31',
    })).rejects.toThrow(/student does not pay a membership fee/i);

    expect(await db.select().from(s.memberships)
      .where(eq(s.memberships.personId, personId))).toHaveLength(0);
  });

  it.each(['instructor', 'official', 'dojo'] as const)(
    'still issues a %s membership — the register MMAKF actually keeps',
    async (category) => {
      const personId = await makePerson(`A ${category}`);
      const r = await renew(db, ctx(), {
        personId, category, validFrom: '2026-01-01', validTo: '2026-12-31',
      });
      expect(r.membershipId).toBeGreaterThan(0);
      expect((await standing(db, admin, personId, category, { asAt: '2026-06-01' })).covered).toBe(true);
    }
  );

  it('an athlete membership already issued can still be revoked', async () => {
    // The over-blocking failure in its most damaging form. A federation that
    // cannot withdraw a credential it issued is worse off than one that never
    // issued it.
    const personId = await makePerson('An athlete under sanction');
    const [row] = await db.insert(s.memberships).values({
      personId, category: 'athlete', validFrom: '2019-01-01', validTo: null, status: 'active',
    }).returning({ id: s.memberships.id });
    await revoke(db, ctx(), row.id, 'Disciplinary outcome, 2026');
    const [after] = await db.select().from(s.memberships).where(eq(s.memberships.id, row.id));
    expect(after.status).toBe('revoked');
  });

  it('refuses the same way twice', async () => {
    const personId = await makePerson('Retried child');
    const attempt = () => renew(db, ctx(), {
      personId, category: 'athlete', validFrom: '2026-01-01', validTo: '2026-12-31',
    });
    const a: any = await attempt().catch((e) => e);
    const b: any = await attempt().catch((e) => e);
    expect(a.code).toBe('student_membership_refused');
    expect(b.message).toBe(a.message);
    expect(await db.select().from(s.memberships)
      .where(eq(s.memberships.personId, personId))).toHaveLength(0);
  });
});
