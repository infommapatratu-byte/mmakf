// THE CHARGE PATH — the second fee register, and the last gate before an invoice.
//
//     A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT.
//
// tests/student-not-a-member.test.ts guards `fee_rules`: what an author may
// write into a fee framework, and what publishFramework() may freeze into
// force. Every one of those tests passed while the hole this file closes was
// wide open, because `fee_rules` IS NOT THE TABLE ANYBODY IS CHARGED FROM.
//
// There are two fee registers:
//
//   fee_frameworks + fee_rules   what a SURFACE SHOWS.  feeFor() -> computeFee()
//   fee_schedule                 what createOrder() CHARGES.
//
// Nothing in src/ writes `fee_schedule`. Its rows therefore arrive only from a
// seed, a migration, a restored backup or an operator's INSERT — precisely the
// four authors src/db/student-rule.ts names at the top of itself as the reason
// deleting MEM-JUNIOR from a data file protects nothing. And a single row
//
//     { code: 'membership.junior.annual', label: 'Junior membership (annual)',
//       kind: 'membership', amountPaise: 50000 }
//
// went from that INSERT, through the ANONYMOUS POST /api/payments/checkout,
// into an order line, a payment, an INVOICE and a membership in the register,
// without touching a fee framework at all.
//
// This file is that path attacked from both ends, plus the four other things
// the brief asks of the same code: an amount nobody published, a price the
// browser chose, a historical record that must not move, and idempotency.
//
// WHAT IS NOT WEAKENED. Every legitimate charge the federation makes is
// asserted to still work: a coach membership, an official membership, a dojo
// affiliation, a grading, and a child's monthly TRAINING fee. A guard that
// blocked those would be the same failure in the opposite direction and a
// quieter one, because nobody files a bug for revenue that never arrived.
//
// FIXTURE HONESTY. Every rupee figure below is a test fixture. MMAKF has
// published no fee, and nothing here is a recommendation, a benchmark borrowed
// from another federation, or a default.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from '../src/db/schema';
import {
  classifyScheduledFee, assertNoStudentFee, isStudentChargeRefused,
  isStudentMembershipCategory, STUDENT_MEMBERSHIP_CATEGORIES,
} from '../src/db/student-rule';
import {
  createOrder, beginPayment, confirmPayment, issueInvoice, OrderError,
} from '../src/db/orders';
import { configureTerm, activateForOrder, entitlementsForOrder } from '../src/db/entitlements';
import { renew, standing } from '../src/db/membership';
import {
  seedFeeCatalogue, publicCatalogue, fullCatalogue, feeFor, isPriced,
  isNotConfigured, requireAmountMinor,
} from '../src/db/fee-catalogue';
import type { Principal } from '../src/lib/rbac';
import type { VerifiedPayment } from '../src/lib/payments';
import type { AuditContext } from '../src/db/federation';

let db: any;
let client: any;
let STATE = 0;
let DOJO = 0;

const admin: Principal = {
  userId: 1, label: 'federation admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const finance: Principal = {
  userId: 2, label: 'treasurer',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
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
    federationId: `MMAKF-MEM-2026-${crypto.randomBytes(4).toString('hex')}`,
    fullName: name, status: 'active', dob: '2015-05-05', gender: 'male',
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
    providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise, feePaise: 1180,
  }));
  return { order, payment, result };
}

/** Nothing was written. The refusal has to be BEFORE the record, not after it. */
async function moneySpine() {
  return {
    orders: (await db.select().from(s.orders)).length,
    lines: (await db.select().from(s.orderLines)).length,
    payments: (await db.select().from(s.payments)).length,
    invoices: (await db.select().from(s.invoices)).length,
    entitlements: (await db.select().from(s.entitlements)).length,
    ledger: (await db.select().from(s.ledgerEntries)).length,
    memberships: (await db.select().from(s.memberships)).length,
  };
}

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  await db.insert(s.users).values([
    { id: 1, email: 'admin@mmakf.in', status: 'active' },
    { id: 2, email: 'finance@mmakf.in', status: 'active' },
  ]);
  const [st] = await db.insert(s.stateUnits).values({
    code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand unit', status: 'active',
  }).returning({ id: s.stateUnits.id });
  STATE = st.id;
  const [dj] = await db.insert(s.dojos).values({
    code: 'MMAKF-DOJO-JH-001', name: 'Ranchi Dojo', stateUnitId: STATE, status: 'active',
  }).returning({ id: s.dojos.id });
  DOJO = dj.id;

  // ── THE ATTACK, SEEDED EXACTLY AS IT WOULD ARRIVE ──
  //
  // These rows go in with a raw INSERT because that is the only way rows get
  // into this table. There is no addRule() to refuse them, no framework to
  // publish and no reviewer: a seed script, a migration or an operator's SQL
  // puts them there, and the next checkout prices from them.
  await db.insert(s.feeSchedule).values([
    // The withdrawn charge, spelt out.
    { code: 'membership.junior.annual', label: 'Junior membership (annual)',
      kind: 'membership', amountPaise: 50000, effectiveFrom: '2026-01-01', active: true },
    { code: 'membership.athlete.annual', label: 'Athlete membership (annual)',
      kind: 'membership', amountPaise: 50000, effectiveFrom: '2026-01-01', active: true },
    // The same charge with every telling word removed. Only `kind` gives it away.
    { code: 'annual.dues', label: 'Annual dues',
      kind: 'membership', amountPaise: 50000, effectiveFrom: '2026-01-01', active: true },
    // A registration fee for existing, which is the rule's other named form.
    { code: 'student.registration', label: 'Student registration fee',
      kind: 'other', amountPaise: 20000, effectiveFrom: '2026-01-01', active: true },
    // A membership billed to a CLUB, which is legitimate — used below to show
    // that the entitlement term, not the fee's name, is what decides the
    // category, and that the term is guarded separately.
    { code: 'membership.club.annual', label: 'Club membership (annual)',
      kind: 'membership', amountPaise: 40000, effectiveFrom: '2026-01-01', active: true },

    // ── AND EVERYTHING THE FEDERATION LEGITIMATELY CHARGES ──
    { code: 'membership.coach.annual', label: 'Coach membership (annual)',
      kind: 'membership', amountPaise: 100000, effectiveFrom: '2026-01-01', active: true },
    { code: 'membership.official.annual', label: 'Technical official membership (annual)',
      kind: 'membership', amountPaise: 90000, effectiveFrom: '2026-01-01', active: true },
    { code: 'affiliation.dojo', label: 'Dojo affiliation (annual)',
      kind: 'affiliation', amountPaise: 200000, effectiveFrom: '2026-01-01', active: true },
    { code: 'grading.kyu', label: 'Kyu grading examination',
      kind: 'grading', amountPaise: 30000, effectiveFrom: '2026-01-01', active: true },
    // THE POSITIVE HALF OF THE RULE: a child paying for training, by name.
    { code: 'training.monthly.junior', label: 'Monthly training for juniors',
      kind: 'course', amountPaise: 80000, effectiveFrom: '2026-01-01', active: true },
    { code: 'training.parent.child', label: 'Parent-and-child class, one term',
      kind: 'course', amountPaise: 120000, effectiveFrom: '2026-01-01', active: true },
  ]);

  await seedFeeCatalogue(db, ctx(finance));
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. CAN A STUDENT MEMBERSHIP CHARGE STILL BE GENERATED?
// ═══════════════════════════════════════════════════════════════════════════

describe('1. a student membership charge cannot reach an order, let alone an invoice', () => {
  it('ATTACK: a seeded fee_schedule row + the anonymous checkout — refused before anything is written', async () => {
    const before = await moneySpine();

    // Exactly what POST /api/payments/checkout forwards: a kind, a description,
    // a quantity and a FEE CODE. It sends no price — the route drops one. This
    // is the whole of a stranger's power over the pricing code.
    try {
      await createOrder(db, null, {
        email: 'parent@example.in',
        lines: [{ kind: 'membership', description: 'Junior membership', feeCode: 'membership.junior.annual' }],
      });
      throw new Error('THE CHARGE WAS CREATED');
    } catch (err: any) {
      expect(err).toBeInstanceOf(OrderError);
      expect(err.code).toBe('student_charge_refused');
      // It says WHY, in the federation's own words, so it can be argued with.
      expect(err.message).toMatch(/does not pay a membership fee for being a student/i);
      expect(err.message).toMatch(/junior/i);
    }

    // NOT ONE ROW. The refusal lands before the order number is consumed.
    expect(await moneySpine()).toEqual(before);
  });

  it('ATTACK: relabelling the line does not help — the ROW is read, never the caller', async () => {
    const before = await moneySpine();
    // The browser calls it a course, a grading, an entry and a certificate in
    // turn. `line.kind` is whatever it says; the price comes from the row.
    for (const kind of ['course', 'grading', 'event_entry', 'certificate', 'other'] as const) {
      await expect(createOrder(db, null, {
        lines: [{ kind, description: 'Monthly training', feeCode: 'membership.athlete.annual' }],
      })).rejects.toThrow(/student/i);
    }
    expect(await moneySpine()).toEqual(before);
  });

  it('ATTACK: renaming the fee so no word gives it away — refused for saying nothing', async () => {
    // 'Annual dues', charged to nobody in particular. This is the rule's
    // hardest case and the one it is fail-closed on: a standing charge that
    // never says who it is for is reachable by a child.
    const verdict = classifyScheduledFee({ code: 'annual.dues', label: 'Annual dues', kind: 'membership' });
    expect(verdict.studentCharge).toBe(true);
    expect(verdict.refusalCode).toBe('unattributed_standing_charge');
    expect(verdict.refusal).toMatch(/say who pays/i);

    await expect(createOrder(db, null, {
      lines: [{ kind: 'membership', description: 'Dues', feeCode: 'annual.dues' }],
    })).rejects.toThrow(/never says which people it is for/i);
  });

  it('ATTACK: a registration fee for existing, which is the same charge by another name', async () => {
    await expect(createOrder(db, null, {
      lines: [{ kind: 'other', description: 'Registration', feeCode: 'student.registration' }],
    })).rejects.toThrow(/student/i);
  });

  it('ATTACK: a mixed basket — one bad line refuses the WHOLE order, not just itself', async () => {
    const before = await moneySpine();
    await expect(createOrder(db, null, {
      lines: [
        { kind: 'course', description: 'Monthly training', feeCode: 'training.monthly.junior' },
        { kind: 'grading', description: 'Kyu grading', feeCode: 'grading.kyu' },
        { kind: 'membership', description: 'Junior membership', feeCode: 'membership.junior.annual' },
      ],
    })).rejects.toThrow(/student/i);
    // The two legitimate lines are not quietly kept and billed either.
    expect(await moneySpine()).toEqual(before);
  });

  it('the withdrawn charge is no longer ADVERTISED, and is still ATTRIBUTABLE', async () => {
    // The seed shipped MMAKF-FEE-MEM-ATHLETE and MMAKF-FEE-MEM-JUNIOR as
    // status 'published', displayPolicy 'public' — the public fee page offering
    // an annual membership for children. No amount was ever attached, so nobody
    // could be charged through them; they were being OFFERED, which is its own
    // kind of wrong.
    const listed = await publicCatalogue(db);
    const listedCodes = new Set(listed.map((r: any) => r.code));
    expect(listedCodes.has('MMAKF-FEE-MEM-ATHLETE')).toBe(false);
    expect(listedCodes.has('MMAKF-FEE-MEM-JUNIOR')).toBe(false);
    // And every legitimate membership is still on the page.
    expect(listedCodes.has('MMAKF-FEE-MEM-COACH')).toBe(true);
    expect(listedCodes.has('MMAKF-FEE-MEM-OFFICIAL')).toBe(true);
    expect(listedCodes.has('MMAKF-FEE-MEM-DOJO')).toBe(true);

    // NOT DELETED. src/db/revenue.ts reads this table by code to attribute paid
    // lines, and a receipt already naming the code has to keep resolving.
    const everything = await fullCatalogue(db, finance);
    const athlete = everything.find((r: any) => r.code === 'MMAKF-FEE-MEM-ATHLETE');
    expect(athlete).toBeTruthy();
    expect(athlete.status).toBe('withdrawn');
    expect(athlete.description).toMatch(/withdrawn on 17 August 2026/i);

    // And it cannot be priced, at any display policy, for anybody.
    for (const viewer of ['public', 'member', 'staff'] as const) {
      const fee = await feeFor(db, 'MMAKF-FEE-MEM-ATHLETE', {}, { viewer });
      expect(isPriced(fee)).toBe(false);
      expect(isNotConfigured(fee)).toBe(true);
    }
  });

  it('a fee cannot be CONFIGURED to buy a student membership, however it is named', async () => {
    // THE SMUGGLING ROUTE. createOrder() reads the FEE; this table is where the
    // fee's MEANING lives. A row called 'membership.coach.annual' prices and
    // charges perfectly — and then hands renew() whatever category is recorded
    // here. The name is not the decision; this row is.
    await expect(configureTerm(db, ctx(finance), {
      feeCode: 'membership.coach.annual', subject: 'membership',
      membershipCategory: 'athlete', termMonths: 12,
    })).rejects.toThrow(/does not pay a membership fee for being a student/i);

    expect(await db.select().from(s.entitlementTerms)
      .where(eq(s.entitlementTerms.feeCode, 'membership.coach.annual'))).toHaveLength(0);
  });

  it('a term already in the table does not mint a membership either — it blocks', async () => {
    // The row configureTerm() would refuse to write today, written directly: an
    // old configuration, a seed, a restored backup. The money is taken before
    // this is read, so the refusal is a BLOCKED entitlement rather than an
    // exception — throwing would roll back the record of a real capture.
    await db.insert(s.entitlementTerms).values({
      feeCode: 'membership.club.annual', subject: 'membership',
      membershipCategory: 'athlete', termMonths: 12, approvedBy: 'seeded before the rule',
    });

    const person = await makePerson('Charged under an old configuration');
    const membershipsBefore = (await db.select().from(s.memberships)).length;

    const { order } = await payFor(
      [{ kind: 'membership', description: 'Club membership', feeCode: 'membership.club.annual' }],
      person
    );
    await activateForOrder(db, null, order.id);

    const [ent] = await entitlementsForOrder(db, finance, order.id);
    expect(ent.status).toBe('blocked');
    expect(ent.reason).toMatch(/does not pay a membership fee for being a student/i);
    expect(ent.subjectId).toBeNull();

    // NO MEMBERSHIP WAS ISSUED, and the payment record stands so it can be
    // refunded rather than quietly kept.
    expect((await db.select().from(s.memberships)).length).toBe(membershipsBefore);
    const [after] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    expect(after.status).toBe('paid');
  });

  it('ATTACK: approving a registration no longer mints one for free', () => {
    // NO MONEY, WHICH IS WHY NO FEE GUARD WAS EVER GOING TO SEE IT.
    // POST /api/queue/decide, approving a registration, read
    //
    //     const category = String(record?.category ?? 'athlete');
    //
    // with 'athlete' repeated as the fallback for anything unrecognised — so an
    // application that named no category at all issued the withdrawn student
    // membership, through a live route, silently, as the DEFAULT. Registering
    // is free and registering is not joining.
    //
    // Asserted on the source because the alternative is booting the route with
    // a session, a queue and a Redis, and what is under test is a one-word
    // default rather than the plumbing around it. The list is READ from the
    // file and judged, so renaming or extending it cannot slip a student
    // category back in behind a passing test.
    const source = readFileSync('src/pages/api/queue/decide.ts', 'utf8');
    // Comment lines are stripped first: the note above the fix quotes the line
    // it replaced, and a test that read the explanation as the code would fail
    // for describing itself.
    const code = source.split(/\r?\n/).filter((l) => !l.trimStart().startsWith('//')).join(' ');
    expect(code).not.toMatch(/category\s*\?\?\s*'athlete'/);
    expect(code).not.toMatch(/:\s*'athlete'/);

    const declared = code.match(/const ISSUABLE = \[([^\]]*)\]/);
    expect(declared, 'decide.ts no longer declares which registers it admits to').toBeTruthy();
    const issuable = [...declared![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(issuable.length).toBeGreaterThan(0);
    for (const category of issuable) {
      expect(isStudentMembershipCategory(category), `${category} is issuable`).toBe(false);
    }
    // The three that act for the federation are still issuable — a coach whose
    // application is approved still becomes a member.
    expect(issuable).toContain('instructor');
    expect(issuable).toContain('official');
    expect(issuable).toContain('dojo');
  });

  it('the classifier refuses every spelling of it, and assertNoStudentFee throws', () => {
    const attempts = [
      { code: 'membership.junior.annual', label: 'Junior membership (annual)', kind: 'membership' },
      { code: 'mem.ath.2026', label: 'MEM ATH 2026', kind: 'membership' },
      { code: 'memAthlete', label: 'Athlete standing', kind: 'membership' },
      { code: 'MEM_KIDS', label: 'Kids annual', kind: 'membership' },
      { code: 'student.subscription', label: 'Student subscription', kind: 'other' },
      { code: 'platform.fee.child', label: 'Platform fee per child', kind: 'other' },
      { code: 'account.fee', label: 'Account fee', kind: 'other' },
      { code: 'joining.fee.beginner', label: 'Joining fee, beginners', kind: 'other' },
      { code: 'annual.dues', label: 'Annual dues', kind: 'membership' },
    ];
    for (const a of attempts) {
      expect(classifyScheduledFee(a).studentCharge, `${a.code} was permitted`).toBe(true);
      expect(() => assertNoStudentFee(a)).toThrow();
      try {
        assertNoStudentFee(a);
      } catch (err) {
        expect(isStudentChargeRefused(err)).toBe(true);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. DID THE GUARD GO TOO FAR?
// ═══════════════════════════════════════════════════════════════════════════

describe('2. every membership the federation actually charges is still chargeable', () => {
  it('a COACH membership prices, charges, invoices and reaches the register', async () => {
    await configureTerm(db, ctx(finance), {
      feeCode: 'membership.coach.annual', subject: 'membership',
      membershipCategory: 'instructor', termMonths: 12, approvedBy: 'Executive Committee',
    });

    const coach = await makePerson('A coach');
    const { order } = await payFor(
      [{ kind: 'membership', description: 'x', feeCode: 'membership.coach.annual' }],
      coach
    );
    expect(order.totalPaise).toBe(100000);

    const invoice = await issueInvoice(db, order.id);
    expect(invoice.invoiceNo).toBeTruthy();

    await activateForOrder(db, null, order.id);
    const [ent] = await entitlementsForOrder(db, finance, order.id);
    expect(ent.status).toBe('active');
    expect(ent.subject).toBe('membership');

    const answer = await standing(db, admin, coach, 'instructor');
    expect(answer.standing).toBe('in_good_standing');
  });

  it('a dojo affiliation, an official membership and a grading all still charge', async () => {
    for (const [feeCode, kind, expected] of [
      ['affiliation.dojo', 'affiliation', 200000],
      ['membership.official.annual', 'membership', 90000],
      ['grading.kyu', 'grading', 30000],
    ] as const) {
      const order = await createOrder(db, null, { lines: [{ kind, description: 'x', feeCode }] });
      expect(order.totalPaise, `${feeCode} was refused`).toBe(expected);
    }
  });

  it('A CHILD PAYS FOR TRAINING, and nothing anywhere objects', async () => {
    // The positive half of the rule, and the one it exists for. The word
    // 'junior' is in the code AND in the label, and it is still fine, because
    // what is being charged for is a thing the federation DELIVERS.
    const child = await makePerson('A nine-year-old');
    const { order } = await payFor([
      { kind: 'course', description: 'Monthly training', feeCode: 'training.monthly.junior' },
      { kind: 'course', description: 'Parent and child', feeCode: 'training.parent.child' },
    ], child);
    expect(order.totalPaise).toBe(200000);

    const invoice = await issueInvoice(db, order.id);
    const lines = (invoice.snapshot as any).lines;
    expect(lines).toHaveLength(2);
    // NOT ONE WORD OF MEMBERSHIP ON THE RECEIPT.
    for (const l of lines) {
      expect(JSON.stringify(l))
        .not.toMatch(/membership|subscription|registration fee|joining fee|platform fee|account fee/i);
    }

    // And no membership was created as a side effect of paying for training.
    expect(await db.select().from(s.memberships).where(eq(s.memberships.personId, child)))
      .toHaveLength(0);
  });

  it('the membership register still admits instructors, officials and dojos', async () => {
    for (const category of ['instructor', 'official', 'dojo'] as const) {
      expect(isStudentMembershipCategory(category)).toBe(false);
      const person = await makePerson(`A ${category}`);
      const result = await renew(db, ctx(), {
        personId: person, category, validFrom: '2026-01-01', validTo: '2026-12-31',
      });
      expect(result.membershipId).toBeTruthy();
    }
    // Exactly one category is refused, and the set says which.
    expect([...STUDENT_MEMBERSHIP_CATEGORIES]).toEqual(['athlete']);
  });

  it('configureTerm accepts every category that is not the withdrawn one', async () => {
    for (const category of ['instructor', 'official', 'dojo'] as const) {
      const row = await configureTerm(db, ctx(finance), {
        feeCode: `membership.${category}.term`, subject: 'membership',
        membershipCategory: category, termMonths: 12,
      });
      expect(row.membershipCategory).toBe(category);
    }
  });

  it('the classifier permits every legitimate row, so the guard is not a word filter', () => {
    const legitimate = [
      { code: 'membership.coach.annual', label: 'Coach membership (annual)', kind: 'membership' },
      { code: 'membership.examiner.annual', label: 'Examiner membership', kind: 'membership' },
      { code: 'affiliation.dojo', label: 'Dojo affiliation (annual)', kind: 'affiliation' },
      { code: 'affiliation.school', label: 'School affiliation', kind: 'affiliation' },
      { code: 'grading.kyu', label: 'Kyu grading examination', kind: 'grading' },
      { code: 'entry.national', label: 'National championship entry', kind: 'event_entry' },
      { code: 'training.monthly.junior', label: 'Monthly training for juniors', kind: 'course' },
      { code: 'training.parent.child', label: 'Parent-and-child class, one term', kind: 'course' },
      { code: 'program.school.term', label: 'School programme (one term)', kind: 'program' },
      { code: 'course.kids.camp', label: 'Kids summer camp', kind: 'course' },
      { code: 'competition.registration.junior', label: 'Junior competition registration', kind: 'event_entry' },
      { code: 'certificate.replacement', label: 'Replacement certificate', kind: 'certificate' },
    ];
    for (const l of legitimate) {
      const v = classifyScheduledFee(l);
      expect(v.studentCharge, `${l.code} was WRONGLY refused: ${v.refusal}`).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. A FABRICATED AMOUNT
// ═══════════════════════════════════════════════════════════════════════════

describe('3. a missing fee never becomes a number', () => {
  it('an unpublished fee code refuses; it does not price at zero', async () => {
    const before = await moneySpine();
    await expect(createOrder(db, null, {
      lines: [{ kind: 'course', description: 'x', feeCode: 'training.nobody.published' }],
    })).rejects.toThrow(/No published fee for training.nobody.published/);
    expect(await moneySpine()).toEqual(before);
  });

  it('the refusal for a student charge quotes no figure at all', () => {
    const v = classifyScheduledFee({
      code: 'membership.junior.annual', label: 'Junior membership (annual)', kind: 'membership',
    });
    expect(v.refusal).not.toMatch(/[0-9]/);
  });

  it('a withdrawn catalogue entry answers with a SYMBOL, not a zero', async () => {
    const fee = await feeFor(db, 'MMAKF-FEE-MEM-JUNIOR', {}, { viewer: 'staff' });
    expect(isPriced(fee)).toBe(false);
    expect(isNotConfigured(fee)).toBe(true);
    if (isNotConfigured(fee)) expect(fee.reason).toBe('service_not_published');
    // The three ways a null would have leaked onto a page as ₹0.00. Each one
    // throws, and the message names the mistake rather than a value.
    for (const attempt of [
      () => Number(fee as any),
      () => `${fee as any}`,
      () => (fee as any) + 0,
    ]) {
      expect(attempt).toThrow(/no number here on purpose/i);
    }
    expect(() => requireAmountMinor(fee)).toThrow();
  });

  it('no order in this database was ever created with a zero or negative total', async () => {
    const orders = await db.select().from(s.orders);
    expect(orders.length).toBeGreaterThan(0);
    for (const o of orders) expect(o.totalPaise).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. A CLIENT-SUPPLIED PRICE
// ═══════════════════════════════════════════════════════════════════════════

describe('4. the server calculates; the browser only names', () => {
  it('ATTACK: a forged unit price on a fee line is discarded', async () => {
    const order = await createOrder(db, null, {
      lines: [{
        kind: 'membership', description: 'Coach membership for one rupee',
        feeCode: 'membership.coach.annual',
        unitPricePaise: 100, amountPaise: 100, totalPaise: 100, taxPaise: 0,
      } as any],
    });
    expect(order.totalPaise).toBe(100000);
    expect(order.lines[0].unitPricePaise).toBe(100000);
    // The description on the record is the FEE'S, not the caller's.
    expect(order.lines[0].description).toBe('Coach membership (annual)');
  });

  it('ATTACK: dressing a membership as a donation buys a donation and entitles nothing', async () => {
    // A donation is the one line whose amount the payer chooses. Calling it a
    // junior membership does not make it one: the line that results is a
    // donation, and a donation entitles the payer to nothing at all.
    const person = await makePerson('A creative payer');
    const { order } = await payFor([{
      kind: 'donation', description: 'Junior membership', unitPricePaise: 100,
    }], person);
    expect(order.totalPaise).toBe(100);

    await activateForOrder(db, null, order.id);
    expect(await entitlementsForOrder(db, finance, order.id)).toHaveLength(0);
    expect(await db.select().from(s.memberships).where(eq(s.memberships.personId, person)))
      .toHaveLength(0);
  });

  it('ATTACK: a negative shipping charge is a discount nobody authorised', async () => {
    await expect(createOrder(db, null, {
      shippingPaise: -500000,
      lines: [{ kind: 'grading', description: 'x', feeCode: 'grading.kyu' }],
    })).rejects.toThrow(/Shipping cannot be negative/);
  });

  it('ATTACK: a line naming no fee, no variant and no permitted amount is refused', async () => {
    await expect(createOrder(db, null, {
      lines: [{ kind: 'membership', description: 'Junior membership', unitPricePaise: 1 } as any],
    })).rejects.toThrow(/names no variant, fee code, or permitted amount/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. HISTORICAL MUTATION
// ═══════════════════════════════════════════════════════════════════════════

describe('5. a record that already exists is never rewritten to fit the new rule', () => {
  it('a 2019 order carrying a junior membership charge survives every guard, unchanged', async () => {
    const [order] = await db.insert(s.orders).values({
      orderNo: `MMAKF-ORD-2019-${crypto.randomBytes(3).toString('hex')}`,
      buyerName: 'Sunita Devi', email: 'sunita@example.in', status: 'paid',
      subtotalPaise: 130000, taxPaise: 0, shippingPaise: 0, totalPaise: 130000,
      paidAt: new Date('2019-06-01T00:00:00Z'),
    }).returning();
    await db.insert(s.orderLines).values([
      { orderId: order.id, kind: 'membership', feeCode: 'membership.junior.annual',
        description: 'Junior athlete membership 2019-20',
        quantity: 1, unitPricePaise: 50000, taxPaise: 0, totalPaise: 50000 },
      { orderId: order.id, kind: 'other',
        description: 'Monthly training, June 2019',
        quantity: 1, unitPricePaise: 80000, taxPaise: 0, totalPaise: 80000 },
    ]);
    const invoice = await issueInvoice(db, order.id);
    const invoiceBefore = JSON.stringify((invoice.snapshot as any).lines);
    const before = await db.select().from(s.orderLines)
      .where(eq(s.orderLines.orderId, order.id)).orderBy(s.orderLines.id);

    // Now run every guard this track added, hard, against the same database.
    await expect(createOrder(db, null, {
      lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.junior.annual' }],
    })).rejects.toThrow();
    await expect(configureTerm(db, ctx(finance), {
      feeCode: 'membership.junior.annual', subject: 'membership',
      membershipCategory: 'athlete', termMonths: 12,
    })).rejects.toThrow();
    classifyScheduledFee({ code: 'membership.junior.annual', label: 'Junior membership', kind: 'membership' });

    // THE RECORD IS UNCHANGED. Same lines, same words, same amounts, same order.
    const after = await db.select().from(s.orderLines)
      .where(eq(s.orderLines.orderId, order.id)).orderBy(s.orderLines.id);
    expect(after).toEqual(before);
    expect(after.map((l: any) => l.description)).toEqual([
      'Junior athlete membership 2019-20',
      'Monthly training, June 2019',
    ]);

    const [orderAfter] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    expect(orderAfter.totalPaise).toBe(130000);
    expect(orderAfter.status).toBe('paid');

    const [invoiceAfter] = await db.select().from(s.invoices).where(eq(s.invoices.orderId, order.id));
    expect(JSON.stringify((invoiceAfter.snapshot as any).lines)).toBe(invoiceBefore);
  });

  it('the fee_schedule row itself is refused, not deleted', async () => {
    // The guard reads. It does not tidy up after itself: a row an operator put
    // there is the record of a decision somebody made, and the right response
    // is to refuse to charge from it, visibly.
    const [row] = await db.select().from(s.feeSchedule)
      .where(eq(s.feeSchedule.code, 'membership.junior.annual'));
    expect(row).toBeTruthy();
    expect(row.active).toBe(true);
    expect(row.amountPaise).toBe(50000);
  });

  it('a membership issued before the withdrawal is still readable and still valid', async () => {
    // The enum keeps 'athlete' for exactly this reason. Refusing to create
    // another is a different thing from erasing the last one.
    const person = await makePerson('A member from before the rule changed');
    await db.insert(s.memberships).values({
      personId: person, category: 'athlete',
      validFrom: '2026-01-01', validTo: '2026-12-31', status: 'active',
    });
    const answer = await standing(db, admin, person, 'athlete');
    expect(answer.membership).toBeTruthy();
    expect(answer.membership!.validTo).toBe('2026-12-31');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. ACCESS, AND WHAT DECIDES IT
// ═══════════════════════════════════════════════════════════════════════════

describe('6. training access is decided by an entitlement, never by membership', () => {
  it('no training module reads the membership register at all', () => {
    // Structural, and it is the only honest way to assert an absence: a test
    // that exercised the paths would only prove the ones it thought of.
    for (const file of [
      'src/db/activation.ts', 'src/db/training-products.ts',
      'src/db/booking.ts', 'src/db/academy.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      const code = source.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
      expect(code, `${file} reads the membership register`).not.toMatch(/s\.memberships/);
    }
  });

  it('the refusal for a student charge is about a PRICE, never about membership standing', () => {
    // The rule failing in the other direction: a wall that says "you are not a
    // member" is the withdrawn charge coming back as a gate.
    const v = classifyScheduledFee({
      code: 'membership.junior.annual', label: 'Junior membership (annual)', kind: 'membership',
    });
    expect(v.refusal).not.toMatch(/not a member|membership required|renew your membership|unpaid/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. IDEMPOTENCY
// ═══════════════════════════════════════════════════════════════════════════

describe('7. every hop, run twice', () => {
  it('the refusal is idempotent — twice refused, nothing written either time', async () => {
    const before = await moneySpine();
    for (let i = 0; i < 2; i += 1) {
      await expect(createOrder(db, null, {
        lines: [{ kind: 'membership', description: 'x', feeCode: 'membership.junior.annual' }],
      })).rejects.toThrow();
      await expect(configureTerm(db, ctx(finance), {
        feeCode: 'membership.junior.annual', subject: 'membership',
        membershipCategory: 'athlete', termMonths: 12,
      })).rejects.toThrow();
    }
    expect(await moneySpine()).toEqual(before);
  });

  it('a legitimate purchase, confirmed twice, produces one of everything', async () => {
    await configureTerm(db, ctx(finance), {
      feeCode: 'membership.official.annual', subject: 'membership',
      membershipCategory: 'official', termMonths: 12, approvedBy: 'Executive Committee',
    });
    const person = await makePerson('An official');
    const { order, payment } = await payFor(
      [{ kind: 'membership', description: 'x', feeCode: 'membership.official.annual' }],
      person
    );

    const replay = await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise, feePaise: 1180,
    }));
    expect(replay!.alreadyProcessed).toBe(true);

    await issueInvoice(db, order.id);
    await issueInvoice(db, order.id);
    await activateForOrder(db, null, order.id);
    await activateForOrder(db, null, order.id);

    expect(await db.select().from(s.payments)
      .where(and(eq(s.payments.orderId, order.id), eq(s.payments.status, 'captured')))).toHaveLength(1);
    expect(await db.select().from(s.invoices).where(eq(s.invoices.orderId, order.id))).toHaveLength(1);
    expect(await entitlementsForOrder(db, finance, order.id)).toHaveLength(1);
    expect(await db.select().from(s.memberships).where(eq(s.memberships.personId, person)))
      .toHaveLength(1);
  });

  it('re-seeding the catalogue does not un-withdraw the student memberships', async () => {
    const again = await seedFeeCatalogue(db, ctx(finance));
    expect(again.inserted).toBe(0);
    const everything = await fullCatalogue(db, finance);
    for (const code of ['MMAKF-FEE-MEM-ATHLETE', 'MMAKF-FEE-MEM-JUNIOR']) {
      expect(everything.find((r: any) => r.code === code).status).toBe('withdrawn');
    }
  });
});
