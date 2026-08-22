// Two ways a figure acquires no authority, and one way a figure becomes
// unopenable — all three found by attacking the money spine.
//
// ─────────────────────────────────────────────────────────────────────────────
// 1. THE FEE THAT IS NOT IN FORCE
// ─────────────────────────────────────────────────────────────────────────────
//
// `fee_schedule` is a DATED register: `effective_from` is how the federation
// approves next year's fee before it applies, and `effective_to` is how it
// closes one that has been superseded. createOrder() read neither — it took
// `order by effective_from desc limit 1` among the rows marked `active` — so
// the moment next April's fee was entered it became the price charged in
// August, and a fee closed in 2022 went on charging until somebody remembered
// that `active` is a switch and `effective_to` is a date.
//
// Neither amount is one the federation is charging on the day it is taken,
// which makes it the same defect as inventing one. Rule 1 of this project is
// that no amount is ever fabricated; an amount with no authority behind it is
// fabricated by a slower route.
//
// ─────────────────────────────────────────────────────────────────────────────
// 2. THE LEDGER DATED IN THE WRONG TIMEZONE
// ─────────────────────────────────────────────────────────────────────────────
//
// postLedger() stamped `occurred_on` from `new Date().toISOString()` — the UTC
// date — while /admin/revenue sums between two dates computed in Asia/Kolkata.
// India runs 5½ hours ahead, so every capture between midnight and 05:30 IST
// posted to the PREVIOUS DAY, and one taken in the small hours of 1 April
// posted to the previous FINANCIAL YEAR. The revenue page carries a comment
// congratulating itself on avoiding exactly that.
//
// ─────────────────────────────────────────────────────────────────────────────
// 3. THE WITHDRAWN CHARGE THAT COULD BE SUMMED BUT NOT LISTED
// ─────────────────────────────────────────────────────────────────────────────
//
// revenueReport() counts a historical student-membership charge wherever it
// finds one; historicalWithdrawnCharges() only looked at `income.membership`
// entries on lines of kind 'membership'. A charge recorded on any other kind
// therefore appeared as a FIGURE on the withdrawn line with an EMPTY LIST under
// it — the one state that section exists to prevent, since a number nobody can
// open is a number somebody is eventually told to make go away, and making it
// go away in the ledger is the falsification rule 3 forbids.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import crypto from 'node:crypto';
import * as s from '../src/db/schema';
import {
  createOrder, beginPayment, confirmPayment, federationToday, OrderError,
} from '../src/db/orders';
import {
  revenueReport, historicalWithdrawnCharges, todayInIndia, financialYear,
} from '../src/db/revenue';
import type { Principal } from '../src/lib/rbac';
import type { VerifiedPayment } from '../src/lib/payments';

let db: any;
let client: PGlite;
let STATE: number;

const treasurer: Principal = {
  userId: 1,
  label: 'treasurer',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};

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

/** Order → payment attempt → verified capture, the whole way through. */
async function pay(lines: any[]) {
  const order = await createOrder(db, null, { email: 'payer@example.in', lines });
  const payment = await beginPayment(db, order.id, {
    provider: 'razorpay',
    providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
    amountPaise: order.totalPaise,
    idempotencyKey: crypto.randomUUID(),
  });
  await confirmPayment(db, null, captured({
    providerOrderId: payment.providerOrderId,
    amountPaise: order.totalPaise,
  }));
  return order;
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
});

beforeEach(async () => {
  await client.exec(`
    DELETE FROM ledger_entries;
    DELETE FROM entitlements;
    DELETE FROM invoices;
    DELETE FROM payments;
    DELETE FROM order_lines;
    DELETE FROM orders;
    DELETE FROM entitlement_terms;
    DELETE FROM fee_schedule;
  `);
});

// ───────────────────────────────────────────────────────────────────────────
// 1. Only a fee in force may price anything
// ───────────────────────────────────────────────────────────────────────────

describe('a fee prices an order only on the days it is in force', () => {
  it('charges the fee in force today, not next year’s approved in advance', async () => {
    // Exactly how a federation enters a fee change: this year's row stays, next
    // year's is added early so the approval and the application are separate
    // events. Sorted by effective_from the new one is first, and it used to win.
    await db.insert(s.feeSchedule).values([
      {
        code: 'grading.kyu', label: 'Kyu grading', kind: 'grading',
        amountPaise: 50_000, effectiveFrom: '2020-04-01', active: true,
      },
      {
        code: 'grading.kyu', label: 'Kyu grading — from 2099', kind: 'grading',
        amountPaise: 99_900, effectiveFrom: '2099-04-01', active: true,
      },
    ]);

    const order = await createOrder(db, null, {
      email: 'payer@example.in',
      lines: [{ kind: 'grading', description: 'Kyu grading', feeCode: 'grading.kyu' }],
    });

    expect(order.totalPaise).toBe(50_000);
    expect(order.lines[0].unitPricePaise).toBe(50_000);
  });

  it('refuses rather than charging a fee whose effective_to has passed', async () => {
    await db.insert(s.feeSchedule).values({
      code: 'course.withdrawn', label: 'Course fee, closed in 2022', kind: 'course',
      amountPaise: 12_345, effectiveFrom: '2021-04-01', effectiveTo: '2022-03-31', active: true,
    });

    let thrown: any = null;
    try {
      await createOrder(db, null, {
        email: 'payer@example.in',
        lines: [{ kind: 'course', description: 'Course', feeCode: 'course.withdrawn' }],
      });
    } catch (err) { thrown = err; }

    expect(thrown).not.toBeNull();
    expect(thrown).toBeInstanceOf(OrderError);
    expect(thrown.code).toBe('fee_not_published');
    // And it says WHY, so an operator looking straight at the row is told it is
    // outside its own dates rather than sent hunting for a row that is there.
    expect(thrown.message).toMatch(/in force/i);
  });

  it('falls back to an older row that is STILL in force, and never to one that is not', async () => {
    await db.insert(s.feeSchedule).values([
      {
        code: 'entry.national', label: 'National entry — open-ended', kind: 'event_entry',
        amountPaise: 80_000, effectiveFrom: '2019-04-01', active: true,
      },
      {
        code: 'entry.national', label: 'National entry — 2021 only', kind: 'event_entry',
        amountPaise: 95_000, effectiveFrom: '2021-04-01', effectiveTo: '2022-03-31', active: true,
      },
    ]);

    const order = await createOrder(db, null, {
      email: 'payer@example.in',
      lines: [{ kind: 'event_entry', description: 'Entry', feeCode: 'entry.national' }],
    });

    expect(order.totalPaise).toBe(80_000);
  });

  it('still refuses a fee code the federation never published, in the old words', async () => {
    let thrown: any = null;
    try {
      await createOrder(db, null, {
        email: 'payer@example.in',
        lines: [{ kind: 'grading', description: 'Grading', feeCode: 'nobody.published.this' }],
      });
    } catch (err) { thrown = err; }

    expect(thrown?.code).toBe('fee_not_published');
    expect(thrown.message).toMatch(/No published fee/);
    // NEVER a zero and never a default: no order exists at all.
    const orders = await db.select().from(s.orders);
    expect(orders).toHaveLength(0);
  });

  it('has not made a COACH membership harder to charge for — the legitimate case still prices', async () => {
    // The guard that must not go too far. A coach acts for the federation and
    // a coach membership is a fee the federation deliberately charges.
    await db.insert(s.feeSchedule).values({
      code: 'membership.coach.annual', label: 'Coach membership (annual)', kind: 'membership',
      amountPaise: 1_00_000, effectiveFrom: '2020-04-01', active: true,
    });

    const order = await createOrder(db, null, {
      email: 'coach@example.in',
      lines: [{ kind: 'membership', description: 'Coach membership', feeCode: 'membership.coach.annual' }],
    });

    expect(order.totalPaise).toBe(1_00_000);
  });

  it('records the fee that ACTUALLY priced the line, not one entered for a later period', async () => {
    await db.insert(s.feeSchedule).values([
      {
        code: 'membership.instructor.annual', label: 'Instructor membership', kind: 'membership',
        amountPaise: 50_000, effectiveFrom: '2020-04-01', active: true,
      },
      {
        code: 'membership.instructor.annual', label: 'Instructor membership — from 2099', kind: 'membership',
        amountPaise: 90_000, effectiveFrom: '2099-04-01', active: true,
      },
    ]);
    await db.insert(s.entitlementTerms).values({
      feeCode: 'membership.instructor.annual', subject: 'membership',
      membershipCategory: 'instructor', termMonths: 12, openEnded: false,
    });
    const [person] = await db.insert(s.persons).values({
      federationId: 'MMAKF-MEM-2026-424242', fullName: 'An instructor', status: 'active',
      dob: '1990-01-01', gender: 'male', stateUnitId: STATE,
    }).returning({ id: s.persons.id });

    const order = await createOrder(db, null, {
      personId: person.id, email: 'i@example.in',
      lines: [{ kind: 'membership', description: 'Instructor', feeCode: 'membership.instructor.annual' }],
    });
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay',
      providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise,
      idempotencyKey: crypto.randomUUID(),
    });
    await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise,
    }));

    const [ent] = await db.select().from(s.entitlements);
    expect(order.totalPaise).toBe(50_000);
    // The 2099 row is not what anybody was charged under, so it is not what the
    // entitlement says they were charged under.
    expect(ent.feeVersion).toMatch(/@2020-04-01/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. The ledger is dated in the federation's own timezone
// ───────────────────────────────────────────────────────────────────────────

describe('the day a payment happened is the day it happened in India', () => {
  it('names the Indian date for an instant that is still yesterday in UTC', () => {
    // 20:30 UTC on 31 March 2027 is 02:00 IST on 1 April 2027 — the first
    // moments of a new financial year.
    const instant = new Date('2027-03-31T20:30:00.000Z');
    expect(instant.toISOString().slice(0, 10)).toBe('2027-03-31');
    expect(federationToday(instant)).toBe('2027-04-01');
  });

  it('puts that instant in the financial year it belongs to', () => {
    const fy = financialYear(federationToday(new Date('2027-03-31T20:30:00.000Z')));
    expect(fy.from).toBe('2027-04-01');
    expect(fy.label).toBe('2027–28');
    // The UTC reading would have filed it in the year that had just ended.
    expect(financialYear('2027-03-31').label).toBe('2026–27');
  });

  it('dates a ledger entry with the same function the report reads between', async () => {
    await db.insert(s.feeSchedule).values({
      code: 'membership.coach.annual', label: 'Coach membership', kind: 'membership',
      amountPaise: 1_00_000, effectiveFrom: '2020-04-01', active: true,
    });
    const order = await pay([
      { kind: 'membership', description: 'Coach membership', feeCode: 'membership.coach.annual' },
    ]);

    const entries = await db.select().from(s.ledgerEntries);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(String(e.occurredOn).slice(0, 10)).toBe(todayInIndia());
    }
    expect(order.totalPaise).toBe(1_00_000);
  });

  it('reports the money inside a period bounded by the federation’s own today', async () => {
    await db.insert(s.feeSchedule).values({
      code: 'membership.coach.annual', label: 'Coach membership', kind: 'membership',
      amountPaise: 1_00_000, effectiveFrom: '2020-04-01', active: true,
    });
    await pay([{ kind: 'membership', description: 'Coach membership', feeCode: 'membership.coach.annual' }]);

    const fy = financialYear(todayInIndia());
    const report = await revenueReport(db, treasurer, { from: fy.from, to: fy.to });
    expect(report.totals.grossPaise).toBe(1_00_000);
    expect(report.lines.find((l) => l.key === 'membership')!.grossPaise).toBe(1_00_000);
    expect(report.empty).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. A withdrawn charge that is counted can be listed
// ───────────────────────────────────────────────────────────────────────────

describe('the withdrawn student-membership line can always be opened', () => {
  /**
   * A HISTORICAL record, written the only way one can be: straight into the
   * register, as a restored backup or a pre-withdrawal row would be. The engine
   * refuses to configure a term that issues an athlete membership — see
   * configureTerm() — which is exactly why the report has to be able to read one
   * it did not create.
   *
   * The charge is billed on a line of kind 'other', so the ledger account is
   * `income.other` and not `income.membership`. That is the case the itemisation
   * used to miss.
   */
  async function historicalAthleteCharge() {
    await db.insert(s.entitlementTerms).values({
      feeCode: 'legacy.athlete.annual', subject: 'membership',
      membershipCategory: 'athlete', termMonths: 12, openEnded: false,
    });
    await db.insert(s.feeSchedule).values({
      code: 'legacy.athlete.annual', label: 'Legacy annual charge', kind: 'other',
      amountPaise: 60_000, effectiveFrom: '2020-04-01', active: true,
    });
    return pay([{ kind: 'other', description: 'Legacy annual charge', feeCode: 'legacy.athlete.annual' }]);
  }

  it('itemises every entry the summary counts on that line', async () => {
    await historicalAthleteCharge();

    const report = await revenueReport(db, treasurer, ALL);
    const line = report.lines.find((l) => l.key === 'historical_withdrawn')!;
    const items = await historicalWithdrawnCharges(db, treasurer, ALL);

    expect(line.grossPaise).toBe(60_000);
    expect(items).toHaveLength(1);
    expect(items.reduce((a, i) => a + i.amountPaise, 0)).toBe(line.grossPaise);
    expect(items[0].feeCode).toBe('legacy.athlete.annual');
    expect(items[0].basis).toMatch(/withdrawn/i);
  });

  it('keeps it OFF the membership line, which is coaches and officials', async () => {
    await historicalAthleteCharge();
    const report = await revenueReport(db, treasurer, ALL);
    expect(report.lines.find((l) => l.key === 'membership')!.grossPaise).toBe(0);
    expect(report.lines.find((l) => l.key === 'training')!.grossPaise).toBe(0);
  });

  it('lists nothing when there is nothing — an empty system is not a hidden one', async () => {
    const items = await historicalWithdrawnCharges(db, treasurer, ALL);
    const report = await revenueReport(db, treasurer, ALL);
    expect(items).toEqual([]);
    expect(report.lines.find((l) => l.key === 'historical_withdrawn')!.grossPaise).toBe(0);
  });

  it('does not count an ordinary coach membership as a withdrawn charge', async () => {
    await db.insert(s.entitlementTerms).values({
      feeCode: 'membership.coach.annual', subject: 'membership',
      membershipCategory: 'instructor', termMonths: 12, openEnded: false,
    });
    await db.insert(s.feeSchedule).values({
      code: 'membership.coach.annual', label: 'Coach membership', kind: 'membership',
      amountPaise: 1_00_000, effectiveFrom: '2020-04-01', active: true,
    });
    await pay([{ kind: 'membership', description: 'Coach membership', feeCode: 'membership.coach.annual' }]);

    const report = await revenueReport(db, treasurer, ALL);
    expect(report.lines.find((l) => l.key === 'membership')!.grossPaise).toBe(1_00_000);
    expect(report.lines.find((l) => l.key === 'historical_withdrawn')!.grossPaise).toBe(0);
    expect(await historicalWithdrawnCharges(db, treasurer, ALL)).toEqual([]);
  });

  it('refuses a period that ends before it starts rather than reading it backwards', async () => {
    await expect(
      historicalWithdrawnCharges(db, treasurer, { from: '2026-12-31', to: '2026-01-01' })
    ).rejects.toThrow(/starts after it ends/i);
  });
});
