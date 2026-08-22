// Revenue classification — src/db/revenue.ts.
//
// The suite is built around one sentence from the federation:
//
//     A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT.
//
// The commercial engine already obeys it. This file is about the REPORT, where
// the same rule fails differently and more quietly: a student's training
// payment counted under "membership revenue" un-corrects the correction in the
// only numbers the federation actually reads, and nobody notices because the
// source tree still looks right.
//
// So the spine here is:
//
//   · a student's training payment lands on TRAINING, never on membership;
//   · a coach's membership lands on MEMBERSHIP, because a coach acts for the
//     federation rather than receiving training from it;
//   · a HISTORICAL student membership charge is neither hidden nor filed under
//     membership — it appears on its own line, labelled with the rule change,
//     because the ledger is not rewritten;
//   · nothing in the vocabulary can express "student membership revenue".
//
// The rest are the refusals: money whose join runs out is reported as
// unattributable WITH THE REASON rather than being folded into a category, and
// an empty system reads as an honest empty system that says what would fill it.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from '../src/db/schema';
import { createOrder, beginPayment, confirmPayment, requestRefund, completeRefund } from '../src/db/orders';
import {
  REVENUE_CATEGORIES, NON_CATEGORY_LINES, HISTORICAL_WITHDRAWN, UNATTRIBUTED,
  assertNoStudentMembershipCategory, allocate, revenueReport, financeState,
  whatWouldPopulateIt, historicalWithdrawnCharges, kindFromAccount, financialYear,
  isRevenueError, type RevenueKey, type RevenueLine, type RevenueReport,
} from '../src/db/revenue';
import { ForbiddenError, type Principal } from '../src/lib/rbac';
import type { VerifiedPayment } from '../src/lib/payments';
import type { AuditContext } from '../src/db/federation';

let db: any;
let client: PGlite;
let STATE: number, DOJO: number;

const treasurer: Principal = {
  userId: 1, label: 'treasurer',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const athlete: Principal = {
  userId: 2, label: 'an athlete',
  bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
};

const ctx = (p: Principal = treasurer): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });

const captured = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
  providerOrderId: '',
  amountPaise: 0,
  currency: 'INR',
  status: 'captured',
  method: 'upi',
  ...over,
});

const ALL = { from: '2000-01-01', to: '2099-12-31' };

/**
 * One line of the report, by key.
 *
 * Typed against RevenueReport itself rather than a hand-written
 * `{ lines: Array<{ key: RevenueKey }> }`. That stand-in NARROWED the element
 * type to its own single property, so every `.grossPaise` and `.label` read
 * through this helper was a compile error — thirty-seven of them — while the
 * assertions themselves were correct and passing at runtime. A structural type
 * written out by hand beside the real one drifts the moment the real one grows
 * a field.
 */
const lineFor = (report: RevenueReport, key: RevenueKey): RevenueLine =>
  report.lines.find((l) => l.key === key)!;

/** Order → payment attempt → verified capture. The whole money path, honestly. */
async function payFor(lines: any[], opts: { personId?: number | null } = {}) {
  const order = await createOrder(db, null, {
    personId: opts.personId ?? null,
    email: 'payer@example.in',
    lines,
  });
  const payment = await beginPayment(db, order.id, {
    provider: 'razorpay',
    providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
    amountPaise: order.totalPaise,
    idempotencyKey: crypto.randomUUID(),
  });
  await confirmPayment(db, null, captured({
    providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise, feePaise: 1180,
  }));
  return { order, payment };
}

async function makePerson(name: string) {
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(Math.floor(Math.random() * 899999) + 100000)}`,
    fullName: name, status: 'active', dob: '2010-05-05', gender: 'male',
    stateUnitId: STATE, dojoId: DOJO,
  }).returning({ id: s.persons.id });
  return p.id as number;
}

/** Wipe the money spine between cases so each report measures only its own case. */
async function clearMoney() {
  await client.exec(`
    DELETE FROM ledger_entries;
    DELETE FROM entitlements;
    DELETE FROM invoices;
    DELETE FROM refunds;
    DELETE FROM payments;
    DELETE FROM order_lines;
    DELETE FROM orders;
  `);
}

beforeAll(async () => {
  client = new PGlite();
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
    code: 'MMAKF-DOJO-JH-001', name: 'Ranchi Dojo', stateUnitId: STATE, status: 'active',
  }).returning({ id: s.dojos.id });
  DOJO = dj.id;
});

// ───────────────────────────────────────────────────────────────────────────
// The vocabulary
// ───────────────────────────────────────────────────────────────────────────

describe('the category list cannot express a student membership', () => {
  it('holds the twelve the federation named, and nothing else', () => {
    expect(REVENUE_CATEGORIES.map((c) => c.key).sort()).toEqual([
      'affiliation', 'competition', 'corporate', 'course', 'event', 'facility',
      'grading', 'marketplace', 'membership', 'merchandise', 'school', 'training',
    ]);
  });

  it('has no student, junior or athlete membership category, and says so if one appears', () => {
    expect(() => assertNoStudentMembershipCategory()).not.toThrow();
  });

  it('does not offer an "other" bucket for a misclassification to hide in', () => {
    expect(REVENUE_CATEGORIES.map((c) => c.key)).not.toContain('other');
  });

  it('describes training as where a student’s payments land', () => {
    const training = REVENUE_CATEGORIES.find((c) => c.key === 'training')!;
    expect(training.sells).toMatch(/student/i);
    expect(training.sells).toMatch(/never membership/i);
  });

  it('describes membership as the people who ACT for the federation', () => {
    const membership = REVENUE_CATEGORIES.find((c) => c.key === 'membership')!;
    expect(membership.sells).toMatch(/coach|instructor|official/i);
    expect(membership.sells).toMatch(/no student|there is no student membership/i);
  });

  it('labels the historical line as a RULE THAT CHANGED, not a category that exists', () => {
    const historical = NON_CATEGORY_LINES.find((c) => c.key === HISTORICAL_WITHDRAWN)!;
    // "Student membership revenue" would read as a live line that happens to be
    // empty this quarter. "withdrawn" says nothing can produce another.
    expect(historical.label).toMatch(/withdrawn/i);
    expect(historical.label).not.toMatch(/revenue/i);
    expect(historical.sells).toMatch(/ledger is not rewritten/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Arithmetic
// ───────────────────────────────────────────────────────────────────────────

describe('allocation loses nothing', () => {
  it('splits a figure whose parts do not divide evenly, and the parts still sum to it', () => {
    const parts = allocate(1000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(parts).toEqual([334, 333, 333]);
  });

  it('is deterministic — a report re-run produces the same figures', () => {
    expect(allocate(9_99_999, [7, 11, 13])).toEqual(allocate(9_99_999, [7, 11, 13]));
  });

  it('allocates NOTHING across weights that sum to zero rather than spreading money evenly', () => {
    expect(allocate(50_000, [0, 0])).toEqual([0, 0]);
  });

  it('carries a sign through, so a reversal allocates as a reversal', () => {
    const parts = allocate(-1000, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(-1000);
  });
});

describe('the ledger vocabulary', () => {
  it('reads the line kind out of an income account', () => {
    expect(kindFromAccount('income.membership')).toBe('membership');
    expect(kindFromAccount('income.other')).toBe('other');
  });

  it('does not mistake the refund account for a sale', () => {
    expect(kindFromAccount('income.refunds')).toBeNull();
    expect(kindFromAccount('expense.gateway_fees')).toBeNull();
    expect(kindFromAccount('assets.gateway_receivable')).toBeNull();
  });

  it('dates a financial year the way India does — April to March', () => {
    expect(financialYear('2026-08-17')).toMatchObject({ from: '2026-04-01', to: '2027-03-31' });
    expect(financialYear('2026-02-17')).toMatchObject({ from: '2025-04-01', to: '2026-03-31' });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Authority
// ───────────────────────────────────────────────────────────────────────────

describe('finance:read, and nothing less', () => {
  it('refuses an athlete the federation’s turnover by category', async () => {
    await expect(revenueReport(db, athlete, ALL)).rejects.toThrow(ForbiddenError);
    await expect(financeState(db, athlete)).rejects.toThrow(ForbiddenError);
    await expect(historicalWithdrawnCharges(db, athlete, ALL)).rejects.toThrow(ForbiddenError);
  });

  it('refuses a signed-out visitor', async () => {
    await expect(revenueReport(db, null, ALL)).rejects.toThrow(ForbiddenError);
  });

  it('names the action it needed, so whoever grants roles knows what to grant', async () => {
    await expect(revenueReport(db, athlete, ALL)).rejects.toMatchObject({ action: 'finance:read' });
  });

  it('refuses a period that is not two ISO dates rather than reporting on a guess', async () => {
    await expect(revenueReport(db, treasurer, { from: 'last quarter', to: 'now' } as any))
      .rejects.toSatisfy(isRevenueError);
    await expect(revenueReport(db, treasurer, { from: '2026-12-31', to: '2026-01-01' }))
      .rejects.toSatisfy(isRevenueError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The empty system, honestly
// ───────────────────────────────────────────────────────────────────────────

describe('a page of zeros reads as an honest empty system', () => {
  beforeEach(clearMoney);

  it('reports zero for every category, and says the ledger is empty', async () => {
    const report = await revenueReport(db, treasurer, ALL);
    expect(report.empty).toBe(true);
    expect(report.totals.grossPaise).toBe(0);
    expect(report.totals.netPaise).toBe(0);
    for (const line of report.lines) expect(line.grossPaise).toBe(0);
  });

  it('shows EVERY category even at zero, so nothing is invisible for being empty', async () => {
    const report = await revenueReport(db, treasurer, ALL);
    expect(report.lines).toHaveLength(REVENUE_CATEGORIES.length + NON_CATEGORY_LINES.length);
  });

  it('says WHAT WOULD POPULATE IT, from counts rather than from a hard-coded sentence', async () => {
    const report = await revenueReport(db, treasurer, ALL);
    expect(report.state.publishedFrameworks).toBe(0);
    expect(report.state.capturedPayments).toBe(0);
    expect(report.state.ledgerEntries).toBe(0);
    expect(report.whyEmpty.join(' ')).toMatch(/no fee framework is published/i);
    expect(report.whyEmpty.join(' ')).toMatch(/no payment has ever been captured/i);
  });

  it('changes what it says when the counts change', () => {
    const populated = whatWouldPopulateIt({
      publishedFrameworks: 1, publishedFees: 4, capturedPayments: 9, paidOrders: 9, ledgerEntries: 40,
    });
    expect(populated.join(' ')).toMatch(/none falls in the period selected/i);
    expect(populated.join(' ')).not.toMatch(/no fee framework/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE RULE, in the numbers
// ───────────────────────────────────────────────────────────────────────────

describe('a student pays for TRAINING, and it is reported as training', () => {
  beforeEach(async () => {
    await clearMoney();
    await client.exec(`DELETE FROM fee_catalogue_entries; DELETE FROM entitlement_terms; DELETE FROM fee_schedule;`);
  });

  it('puts a student’s monthly training payment under training and NOTHING under membership', async () => {
    // The federation's own records: a training charge, to a student.
    await db.insert(s.feeSchedule).values({
      code: 'training.monthly.junior', label: 'Monthly training — junior',
      kind: 'other', amountPaise: 80000, effectiveFrom: '2026-01-01', active: true,
    });
    await db.insert(s.feeCatalogueEntries).values({
      code: 'MMAKF-FEE-TRN-MONTHLY', slug: 'training-monthly', name: 'Monthly training',
      category: 'training', audience: 'junior', unit: 'per_month', frequency: 'monthly',
      displayPolicy: 'public', status: 'published',
    });
    // The catalogue is keyed by CODE, and the order line carries the fee code.
    await db.update(s.feeCatalogueEntries)
      .set({ code: 'training.monthly.junior' })
      .where(eq(s.feeCatalogueEntries.slug, 'training-monthly'));

    const student = await makePerson('A student');
    // Kind 'other' deliberately: the vaguest label an order line can carry.
    // The catalogue, not the label, decides.
    await payFor([{ kind: 'other', description: 'Monthly training', feeCode: 'training.monthly.junior' }], { personId: student });

    const report = await revenueReport(db, treasurer, ALL);
    expect(lineFor(report, 'training').grossPaise).toBe(80000);
    expect(lineFor(report, 'membership').grossPaise).toBe(0);
    expect(lineFor(report, HISTORICAL_WITHDRAWN).grossPaise).toBe(0);
    expect(lineFor(report, UNATTRIBUTED).grossPaise).toBe(0);
  });

  it('puts a COACH’s membership under membership — a coach acts for the federation', async () => {
    await db.insert(s.feeSchedule).values({
      code: 'membership.coach.annual', label: 'Coach membership (annual)',
      kind: 'membership', amountPaise: 100000, effectiveFrom: '2026-01-01', active: true,
    });
    // What the fee entitles the payer to — the federation's decision, recorded.
    await db.insert(s.entitlementTerms).values({
      feeCode: 'membership.coach.annual', subject: 'membership',
      membershipCategory: 'instructor', termMonths: 12, approvedBy: 'Executive Committee',
    });

    const coach = await makePerson('A coach');
    await payFor([{ kind: 'membership', description: 'Coach membership', feeCode: 'membership.coach.annual' }], { personId: coach });

    const report = await revenueReport(db, treasurer, ALL);
    expect(lineFor(report, 'membership').grossPaise).toBe(100000);
    expect(lineFor(report, 'training').grossPaise).toBe(0);
    expect(lineFor(report, HISTORICAL_WITHDRAWN).grossPaise).toBe(0);
  });

  it('never reports a membership line as a student charge on no evidence', async () => {
    // A membership fee nobody recorded an audience for. The safe reading is
    // "membership" — calling it a student charge would move a coach's fee onto
    // a line that says the rule changed.
    //
    // SUCH A FEE CAN NO LONGER BE CHARGED. createOrder() refuses to price a
    // fee_schedule row that charges for standing and never says which people it
    // is for, because a rule like that is reachable by a student. That refusal
    // is about the future; this test is about a line already in the ledger, so
    // the paid line is stamped with the unattributed code the way an older
    // database already carries it. See the historical suite below for the same
    // reasoning spelt out at length.
    await db.insert(s.feeSchedule).values([
      { code: 'membership.unrecorded', label: 'Membership, audience unrecorded',
        kind: 'membership', amountPaise: 60000, effectiveFrom: '2026-01-01', active: true },
      { code: 'membership.instructor.annual', label: 'Instructor membership (annual)',
        kind: 'membership', amountPaise: 60000, effectiveFrom: '2026-01-01', active: true },
    ]);
    const p = await makePerson('Somebody');
    const { order } = await payFor(
      [{ kind: 'membership', description: 'Membership', feeCode: 'membership.instructor.annual' }],
      { personId: p }
    );
    await db.update(s.orderLines)
      .set({ feeCode: 'membership.unrecorded', description: 'Membership' })
      .where(eq(s.orderLines.orderId, order.id));

    const report = await revenueReport(db, treasurer, ALL);
    expect(lineFor(report, 'membership').grossPaise).toBe(60000);
    expect(lineFor(report, HISTORICAL_WITHDRAWN).grossPaise).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The historical record, kept and labelled
// ───────────────────────────────────────────────────────────────────────────

describe('a historical student membership charge is kept, shown, and never called a category', () => {
  beforeEach(async () => {
    await clearMoney();
    await client.exec(`DELETE FROM fee_catalogue_entries; DELETE FROM entitlement_terms; DELETE FROM fee_schedule;`);

    // A charge as it stood BEFORE 17 August 2026: a membership issued to an
    // athlete. NOTHING IN THE SYSTEM CAN CREATE ONE NOW, and that is no longer
    // a claim about deleted rules — it is enforced in three places:
    //
    //   · fees.addRule()/publishFramework() refuse the pricing rule;
    //   · orders.createOrder() refuses to price the fee_schedule row, so the
    //     charge cannot reach an order line, a payment or an invoice;
    //   · entitlements.configureTerm() refuses to record that a fee buys an
    //     athlete membership.
    //
    // So this fixture cannot walk the front door, and it must not: a test that
    // could still mint one would mean the guard did not hold. The rows are
    // written DIRECTLY instead — a fee_schedule row and an entitlement_terms row
    // as an old database carries them, an order paid through the ordinary path
    // against a legitimate instructor fee, and then the LINE restamped with the
    // withdrawn code it was actually raised under. What is under test is that
    // revenueReport() keeps such a line, shows it and labels it — never that one
    // can be created today.
    await db.insert(s.feeSchedule).values([
      { code: 'membership.athlete.annual', label: 'Athlete membership (annual)',
        kind: 'membership', amountPaise: 50000, effectiveFrom: '2026-01-01', active: true },
      { code: 'membership.instructor.annual', label: 'Instructor membership (annual)',
        kind: 'membership', amountPaise: 50000, effectiveFrom: '2026-01-01', active: true },
    ]);
    await db.insert(s.entitlementTerms).values({
      feeCode: 'membership.athlete.annual', subject: 'membership',
      membershipCategory: 'athlete', termMonths: 12, approvedBy: 'Withdrawn 17 August 2026',
    });
    const p = await makePerson('A student charged before the rule changed');
    const { order } = await payFor(
      [{ kind: 'membership', description: 'Membership 2026', feeCode: 'membership.instructor.annual' }],
      { personId: p }
    );
    await db.update(s.orderLines)
      .set({ feeCode: 'membership.athlete.annual', description: 'Athlete membership 2026' })
      .where(eq(s.orderLines.orderId, order.id));
  });

  it('does NOT delete it — the money was received and the accounts must add up', async () => {
    const report = await revenueReport(db, treasurer, ALL);
    expect(report.totals.grossPaise).toBe(50000);
  });

  it('does NOT file it under membership, which would un-correct the rule', async () => {
    const report = await revenueReport(db, treasurer, ALL);
    expect(lineFor(report, 'membership').grossPaise).toBe(0);
  });

  it('shows it on its own line, labelled with the rule change', async () => {
    const report = await revenueReport(db, treasurer, ALL);
    const historical = lineFor(report, HISTORICAL_WITHDRAWN);
    expect(historical.grossPaise).toBe(50000);
    expect(historical.label).toMatch(/withdrawn 17 August 2026/i);
  });

  it('itemises it, so the figure can be opened rather than argued with', async () => {
    const rows = await historicalWithdrawnCharges(db, treasurer, ALL);
    expect(rows).toHaveLength(1);
    expect(rows[0].amountPaise).toBe(50000);
    expect(rows[0].feeCode).toBe('membership.athlete.annual');
    expect(rows[0].basis).toMatch(/withdrawn/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// What was sold, from the record that says so
// ───────────────────────────────────────────────────────────────────────────

describe('the category comes from the record, not from a label on the order', () => {
  beforeEach(async () => {
    await clearMoney();
    await client.exec(`DELETE FROM fee_catalogue_entries; DELETE FROM entitlement_terms; DELETE FROM fee_schedule;`);
  });

  it('reports a school’s training contract as SCHOOL revenue, from the institution’s own kind', async () => {
    const [svc] = await db.insert(s.services).values({
      code: 'MMAKF-SVC-SCHOOL-TRAINING', slug: 'school-training',
      title: 'School training programme', category: 'training', status: 'published',
    }).returning({ id: s.services.id });
    const [fw] = await db.insert(s.feeFrameworks).values({
      code: 'MMAKF-FEE-V1', title: 'Framework', version: 1, status: 'published',
      publishedAt: new Date(), effectiveFrom: '2026-01-01',
    }).returning({ id: s.feeFrameworks.id });
    const [rule] = await db.insert(s.feeRules).values({
      frameworkId: fw.id, code: 'TRN-SCHOOL', label: 'School training',
      kind: 'per_participant', serviceId: svc.id, amountMinor: 45000,
    }).returning({ id: s.feeRules.id });
    const [inst] = await db.insert(s.institutions).values({
      code: 'MMAKF-INST-2026-000001', name: 'St Xavier’s', kind: 'school', status: 'contracted',
    }).returning({ id: s.institutions.id });
    const [quote] = await db.insert(s.quotes).values({
      ref: 'MMAKF-QUO-2026-000001', institutionId: inst.id,
    }).returning({ id: s.quotes.id });
    const [qv] = await db.insert(s.quoteVersions).values({
      quoteId: quote.id, version: 1, status: 'accepted', frameworkId: fw.id,
      frameworkCode: 'MMAKF-FEE-V1', inputs: {},
      subtotalMinor: 480000, adjustmentMinor: 0, taxMinor: 0, totalMinor: 480000,
    }).returning({ id: s.quoteVersions.id });
    await db.insert(s.quoteLines).values({
      quoteVersionId: qv.id, ruleId: rule.id, ruleCode: 'TRN-SCHOOL', kind: 'per_participant',
      label: 'School training', amountMinor: 480000, runningTotalMinor: 480000, sourceKind: 'fee_rule',
    });

    await payFor([{ kind: 'other', description: 'Quotation', quoteVersionId: qv.id }]);

    const report = await revenueReport(db, treasurer, ALL);
    expect(lineFor(report, 'school').grossPaise).toBe(480000);
    // NOT membership, NOT "other", and not lumped into general training either:
    // the buyer is a school and the report says so.
    expect(lineFor(report, 'membership').grossPaise).toBe(0);
    expect(lineFor(report, 'training').grossPaise).toBe(0);
    expect(lineFor(report, UNATTRIBUTED).grossPaise).toBe(0);
  });

  it('reports a marketplace sale as marketplace, not as the federation’s own merchandise', async () => {
    const [product] = await db.insert(s.products).values({
      sku: 'GI-STD', name: 'Karate gi', status: 'active',
    }).returning({ id: s.products.id });
    const [variant] = await db.insert(s.productVariants).values({
      productId: product.id, sku: 'GI-STD-150', label: '150cm', pricePaise: 250000, stockQty: 5,
    }).returning({ id: s.productVariants.id });

    const [user] = await db.insert(s.users).values({
      email: `seller-${crypto.randomBytes(4).toString('hex')}@example.in`,
      passwordHash: 'x', status: 'active',
    }).returning({ id: s.users.id });
    const [seller] = await db.insert(s.sellers).values({
      ref: `MMAKF-SEL-${crypto.randomBytes(3).toString('hex')}`, userId: user.id,
      tradingName: 'Ranchi Budo Supplies', status: 'approved',
    }).returning({ id: s.sellers.id });

    const { order } = await payFor([{ kind: 'product', description: 'Gi', variantId: variant.id }]);
    // The seller attribution a marketplace order carries.
    await db.update(s.orderLines).set({ sellerId: seller.id }).where(eq(s.orderLines.orderId, order.id));

    const report = await revenueReport(db, treasurer, ALL);
    expect(lineFor(report, 'marketplace').grossPaise).toBe(250000);
    expect(lineFor(report, 'merchandise').grossPaise).toBe(0);
  });

  it('reports the federation’s own shop sale as merchandise', async () => {
    const [product] = await db.insert(s.products).values({
      sku: 'BELT-BLK', name: 'Black belt', status: 'active',
    }).returning({ id: s.products.id });
    const [variant] = await db.insert(s.productVariants).values({
      productId: product.id, sku: 'BELT-BLK-280', label: '280cm', pricePaise: 90000, stockQty: 9,
    }).returning({ id: s.productVariants.id });

    await payFor([{ kind: 'product', description: 'Belt', variantId: variant.id }]);

    const report = await revenueReport(db, treasurer, ALL);
    expect(lineFor(report, 'merchandise').grossPaise).toBe(90000);
    expect(lineFor(report, 'marketplace').grossPaise).toBe(0);
  });

  it('splits one order across the categories its lines belong to', async () => {
    await db.insert(s.feeSchedule).values([
      { code: 'grading.kyu', label: 'Kyu grading', kind: 'grading', amountPaise: 30000, effectiveFrom: '2026-01-01', active: true },
      { code: 'affiliation.dojo', label: 'Dojo affiliation', kind: 'affiliation', amountPaise: 200000, effectiveFrom: '2026-01-01', active: true },
    ]);
    const p = await makePerson('A candidate');
    await payFor([
      { kind: 'grading', description: 'Kyu grading', feeCode: 'grading.kyu' },
      { kind: 'affiliation', description: 'Dojo affiliation', feeCode: 'affiliation.dojo' },
    ], { personId: p });

    const report = await revenueReport(db, treasurer, ALL);
    expect(lineFor(report, 'grading').grossPaise).toBe(30000);
    expect(lineFor(report, 'affiliation').grossPaise).toBe(200000);
    expect(report.totals.grossPaise).toBe(230000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The refusals
// ───────────────────────────────────────────────────────────────────────────

describe('money the records cannot explain is reported, not filed', () => {
  beforeEach(async () => {
    await clearMoney();
    await client.exec(`DELETE FROM fee_catalogue_entries; DELETE FROM entitlement_terms; DELETE FROM fee_schedule;`);
  });

  it('reports a donation as not attributable, with the reason, rather than as revenue from a service', async () => {
    await payFor([{ kind: 'donation', description: 'A donation', unitPricePaise: 500000 }]);

    const report = await revenueReport(db, treasurer, ALL);
    expect(lineFor(report, UNATTRIBUTED).grossPaise).toBe(500000);
    expect(report.unattributedReasons[0].reason).toMatch(/donation/i);
    // And it is not quietly counted as any of the twelve.
    for (const c of REVENUE_CATEGORIES) expect(lineFor(report, c.key).grossPaise).toBe(0);
  });

  it('REFUSES TO GUESS which of two identical-kind lines a pre-0044 ledger entry belonged to', async () => {
    await db.insert(s.feeSchedule).values([
      { code: 'thing.a', label: 'Thing A', kind: 'other', amountPaise: 10000, effectiveFrom: '2026-01-01', active: true },
      { code: 'thing.b', label: 'Thing B', kind: 'other', amountPaise: 20000, effectiveFrom: '2026-01-01', active: true },
    ]);
    const { order } = await payFor([
      { kind: 'other', description: 'A', feeCode: 'thing.a' },
      { kind: 'other', description: 'B', feeCode: 'thing.b' },
    ]);
    // A ledger as it stood before migration 0044: the order is recorded, the
    // LINE is not.
    await client.exec(`UPDATE ledger_entries SET order_line_id = NULL WHERE order_id = ${order.id}`);

    const report = await revenueReport(db, treasurer, ALL);
    expect(lineFor(report, UNATTRIBUTED).grossPaise).toBe(30000);
    expect(report.unattributedReasons[0].reason).toMatch(/not recorded|would be a guess/i);
  });

  it('recovers a pre-0044 entry when the order has exactly one line of that kind', async () => {
    await db.insert(s.feeSchedule).values({
      code: 'grading.dan', label: 'Dan grading', kind: 'grading', amountPaise: 500000, effectiveFrom: '2026-01-01', active: true,
    });
    const p = await makePerson('A Dan candidate');
    const { order } = await payFor([{ kind: 'grading', description: 'Dan grading', feeCode: 'grading.dan' }], { personId: p });
    await client.exec(`UPDATE ledger_entries SET order_line_id = NULL WHERE order_id = ${order.id}`);

    const report = await revenueReport(db, treasurer, ALL);
    expect(lineFor(report, 'grading').grossPaise).toBe(500000);
    expect(lineFor(report, UNATTRIBUTED).grossPaise).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Refunds
// ───────────────────────────────────────────────────────────────────────────

describe('a refund reduces the category it was taken from', () => {
  beforeEach(async () => {
    await clearMoney();
    await client.exec(`DELETE FROM fee_catalogue_entries; DELETE FROM entitlement_terms; DELETE FROM fee_schedule;`);
  });

  it('nets off against grading, and never appears as revenue from anything', async () => {
    await db.insert(s.feeSchedule).values({
      code: 'grading.kyu', label: 'Kyu grading', kind: 'grading', amountPaise: 30000, effectiveFrom: '2026-01-01', active: true,
    });
    const p = await makePerson('A candidate who withdrew');
    const { order, payment } = await payFor([{ kind: 'grading', description: 'Kyu grading', feeCode: 'grading.kyu' }], { personId: p });

    const refund = await requestRefund(db, ctx(), {
      paymentId: payment.id, amountPaise: 30000, reason: 'The candidate withdrew before the panel sat.',
    });
    await completeRefund(db, ctx(), { refundId: refund.id, providerRefundId: 'rfnd_1' });

    const report = await revenueReport(db, treasurer, ALL);
    const grading = lineFor(report, 'grading');
    expect(grading.grossPaise).toBe(30000);
    expect(grading.refundedPaise).toBe(30000);
    expect(grading.netPaise).toBe(0);
    expect(report.totals.netPaise).toBe(0);
    expect(report.unallocatedRefundsPaise).toBe(0);
    expect(order.id).toBeGreaterThan(0);
  });

  it('splits a partial refund across a mixed order without losing a paisa', async () => {
    await db.insert(s.feeSchedule).values([
      { code: 'grading.kyu', label: 'Kyu grading', kind: 'grading', amountPaise: 30000, effectiveFrom: '2026-01-01', active: true },
      { code: 'affiliation.dojo', label: 'Dojo affiliation', kind: 'affiliation', amountPaise: 200000, effectiveFrom: '2026-01-01', active: true },
    ]);
    const p = await makePerson('A payer');
    const { payment } = await payFor([
      { kind: 'grading', description: 'Kyu grading', feeCode: 'grading.kyu' },
      { kind: 'affiliation', description: 'Dojo affiliation', feeCode: 'affiliation.dojo' },
    ], { personId: p });

    const refund = await requestRefund(db, ctx(), {
      paymentId: payment.id, amountPaise: 100001, reason: 'Partial refund agreed with the dojo.',
    });
    await completeRefund(db, ctx(), { refundId: refund.id, providerRefundId: 'rfnd_2' });

    const report = await revenueReport(db, treasurer, ALL);
    const allocated = report.lines.reduce((a, l) => a + l.refundedPaise, 0);
    expect(allocated).toBe(100001);
    expect(report.unallocatedRefundsPaise).toBe(0);
    expect(report.totals.netPaise).toBe(230000 - 100001);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The report adds up
// ───────────────────────────────────────────────────────────────────────────

describe('the figures on the page add up to the figures at the bottom of it', () => {
  beforeEach(async () => {
    await clearMoney();
    await client.exec(`DELETE FROM fee_catalogue_entries; DELETE FROM entitlement_terms; DELETE FROM fee_schedule;`);
  });

  it('totals what the lines say, so a reader can check the page against itself', async () => {
    await db.insert(s.feeSchedule).values([
      { code: 'grading.kyu', label: 'Kyu grading', kind: 'grading', amountPaise: 30000, effectiveFrom: '2026-01-01', active: true },
      { code: 'entry.national', label: 'National entry', kind: 'event_entry', amountPaise: 80000, effectiveFrom: '2026-01-01', active: true },
    ]);
    const p = await makePerson('A competitor');
    await payFor([{ kind: 'grading', description: 'Kyu grading', feeCode: 'grading.kyu' }], { personId: p });
    await payFor([{ kind: 'event_entry', description: 'National entry', feeCode: 'entry.national' }], { personId: p });

    const report = await revenueReport(db, treasurer, ALL);
    expect(report.lines.reduce((a, l) => a + l.grossPaise, 0)).toBe(report.totals.grossPaise);
    expect(report.lines.reduce((a, l) => a + l.netPaise, 0)).toBe(report.totals.netPaise);
    expect(report.totals.grossPaise).toBe(110000);
    expect(report.empty).toBe(false);
  });

  it('excludes what fell outside the period, rather than reporting the whole ledger', async () => {
    await db.insert(s.feeSchedule).values({
      code: 'grading.kyu', label: 'Kyu grading', kind: 'grading', amountPaise: 30000, effectiveFrom: '2026-01-01', active: true,
    });
    const p = await makePerson('A candidate');
    await payFor([{ kind: 'grading', description: 'Kyu grading', feeCode: 'grading.kyu' }], { personId: p });
    await client.exec(`UPDATE ledger_entries SET occurred_on = DATE '2019-06-01'`);

    const inWindow = await revenueReport(db, treasurer, { from: '2026-01-01', to: '2026-12-31' });
    expect(inWindow.totals.grossPaise).toBe(0);
    expect(inWindow.empty).toBe(true);
    // …and the reason given is not "nothing was ever sold", because something was.
    expect(inWindow.state.ledgerEntries).toBeGreaterThan(0);
    expect(inWindow.whyEmpty.join(' ')).toMatch(/none falls in the period selected/i);

    const wide = await revenueReport(db, treasurer, { from: '2019-01-01', to: '2019-12-31' });
    expect(wide.totals.grossPaise).toBe(30000);
  });

  it('counts the gateway’s fee as an expense, never as a deduction from revenue', async () => {
    await db.insert(s.feeSchedule).values({
      code: 'grading.kyu', label: 'Kyu grading', kind: 'grading', amountPaise: 30000, effectiveFrom: '2026-01-01', active: true,
    });
    const p = await makePerson('A candidate');
    await payFor([{ kind: 'grading', description: 'Kyu grading', feeCode: 'grading.kyu' }], { personId: p });

    // payFor() posts a ₹11.80 gateway fee. Revenue is what was SOLD; what it
    // cost to collect is a different question and a different account.
    const report = await revenueReport(db, treasurer, ALL);
    expect(report.totals.grossPaise).toBe(30000);
  });
});
