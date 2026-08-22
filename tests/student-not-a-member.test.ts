// A STUDENT IS NOT A MEMBER.
//
//     A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT.
//     They pay for TRAINING.
//
// The federation stated the rule; MEM-JUNIOR and MEM-ATHLETE were deleted from
// src/data/proposed-fees.ts the same day. This file exists because that deletion
// protects nothing on its own. A data file is a suggestion to whoever edits it
// next, and the two rules come back the moment somebody clones the framework and
// "restores" a category that looks conspicuously missing beside MEM-COACH.
//
// So the tests below are in two halves, and the second is the one that matters.
//
//   · WHAT THE ENGINE REFUSES TO CREATE. src/db/student-rule.ts decides whether
//     a rule is a student charge, and addRule() and publishFramework() will not
//     write or freeze one. A rule that cannot exist cannot be displayed,
//     exported, cloned, quoted, invoiced or seeded.
//
//   · WHAT A STUDENT IS ACTUALLY CHARGED. Registration costs nothing. Buying
//     training buys training and only training — asserted on the INVOICE LINES,
//     not on the total, because a total is exactly where a second charge hides.
//
// AND ONE TEST GUARDS HISTORY IN THE OPPOSITE DIRECTION. If a payment taken
// before the rule existed genuinely contained a student membership charge, that
// record STAYS, unchanged and readable, after every guard here has run. The rule
// governs the future. A ledger edited to make a new policy look tidy is a
// falsified ledger, and that is a worse defect than the one being fixed.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from '../src/db/schema';
import {
  createFramework, addRule, publishFramework, computeFee, isFeeError,
} from '../src/db/fees';
import {
  classifyFeeRule, isStudentCharge, assertNoStudentCharge, findStudentCharges,
  isStudentChargeRefused, type RuleCandidate,
} from '../src/db/student-rule';
import { PROPOSED_RULES, MEMBERSHIP } from '../src/data/proposed-fees';
import { createOrder, beginPayment, confirmPayment, issueInvoice } from '../src/db/orders';
import type { Principal } from '../src/lib/rbac';
import type { VerifiedPayment } from '../src/lib/payments';

let db: any;
/** A published framework of LEGITIMATE rules — training, and a coach membership. */
let FW = 0;
/** The service row a "neutral code, membership service" rule can point at. */
let ATHLETE_MEMBERSHIP_SERVICE = 0;

/** feeFrameworks has a unique index on `version`, so every draft needs its own. */
let versionCounter = 10;
const nextVersion = () => (versionCounter += 1);

const finance: Principal = {
  userId: 1, label: 'finance',
  bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
const ctx = { principal: finance };

const captured = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
  providerOrderId: '',
  amountPaise: 0,
  currency: 'INR',
  status: 'captured',
  method: 'upi',
  ...over,
});

/** A fresh DRAFT framework to attempt a refusal against. */
async function draft(title = 'Guard fixture') {
  const fw = await createFramework(db, ctx, { title, version: nextVersion() });
  return fw.id as number;
}

/** THE WITHDRAWN RULES, reconstructed exactly as they were proposed. */
const MEM_ATHLETE: RuleCandidate = {
  code: 'MEM-ATHLETE', label: 'Athlete membership, annual', kind: 'base',
  amountMinor: 50000, audience: 'individual', conditions: { category: 'athlete' },
};
const MEM_JUNIOR: RuleCandidate = {
  code: 'MEM-JUNIOR', label: 'Junior athlete membership, annual', kind: 'base',
  amountMinor: 30000, audience: 'individual', conditions: { category: 'athlete', ageBand: 'junior' },
};

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  // published_by_user_id is a real foreign key.
  await db.insert(s.users).values([{ id: 1, email: 'finance@mmakf.in', status: 'active' }]);

  const [svc] = await db.insert(s.services).values({
    code: 'MMAKF-FEE-MEM-ATHLETE', slug: 'membership-athlete',
    title: 'Athlete membership', category: 'training', status: 'published',
  }).returning({ id: s.services.id });
  ATHLETE_MEMBERSHIP_SERVICE = svc.id;

  // ── The published framework used by the "what is a student charged?" half ──
  //
  // TEST FIXTURES, not MMAKF's fees. The federation has published no framework
  // and the engine ships empty; these figures exist so the assertions have
  // something to assert ON.
  FW = await draft('Legitimate framework');
  await addRule(db, ctx, FW, {
    code: 'TRN-MONTHLY', label: 'Monthly training at an MMAKF centre', kind: 'base',
    audience: 'individual', conditions: { mode: 'at_dojo' }, amountMinor: 80000, sortOrder: 10,
  });
  await addRule(db, ctx, FW, {
    code: 'MEM-COACH', label: 'Coach or instructor membership, annual', kind: 'base',
    audience: 'individual', conditions: { category: 'instructor' }, amountMinor: 100000, sortOrder: 20,
  });
  await addRule(db, ctx, FW, {
    code: 'INST-BASE', label: 'Programme base fee', kind: 'base',
    audience: 'school', amountMinor: 1500000, sortOrder: 30,
  });
  await addRule(db, ctx, FW, {
    code: 'INST-PER-PARTICIPANT', label: 'Per participant', kind: 'per_participant',
    audience: 'school', amountMinor: 45000, sortOrder: 31,
  });
  await addRule(db, ctx, FW, {
    code: 'CORP-BASE', label: 'Corporate programme base fee', kind: 'base',
    audience: 'corporate', amountMinor: 2000000, sortOrder: 40,
  });
  await addRule(db, ctx, FW, {
    code: 'CORP-PER-PARTICIPANT', label: 'Per participant', kind: 'per_participant',
    audience: 'corporate', amountMinor: 60000, sortOrder: 41,
  });
  await publishFramework(db, ctx, FW);

  // A published training fee for the order/invoice half.
  await db.insert(s.feeSchedule).values({
    code: 'training.monthly', label: 'Monthly training at an MMAKF centre',
    kind: 'program', amountPaise: 80000, effectiveFrom: '2026-01-01', active: true,
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE PREDICATE — who pays, and why
// ═══════════════════════════════════════════════════════════════════════════

describe('the predicate turns on WHO PAYS, not on the word "membership"', () => {
  it('permits every membership the federation actually charges', () => {
    // MEM-COACH, MEM-OFFICIAL, MEM-EXAMINER, MEM-DOJO, MEM-INSTITUTION. Getting
    // this wrong in the strict direction blocks the federation's real revenue,
    // which is how a guard gets deleted rather than fixed.
    for (const rule of MEMBERSHIP) {
      const verdict = classifyFeeRule(rule as RuleCandidate);
      expect(verdict.studentCharge, `${rule.code} was refused: ${verdict.refusal}`).toBe(false);
    }
    // And they really are STANDING charges — the predicate permitted them on the
    // payer, not by failing to notice they were memberships.
    const coach = classifyFeeRule(MEMBERSHIP.find((r) => r.code === 'MEM-COACH') as RuleCandidate);
    expect(coach.shape).toBe('standing');
    expect(coach.payer).toBe('acts_for_federation');
  });

  it('permits every rule in the proposed framework as it now stands', () => {
    const refused = findStudentCharges(PROPOSED_RULES as RuleCandidate[]);
    expect(refused.map((r) => r.rule.code)).toEqual([]);
  });

  it('refuses the two rules the federation withdrew', () => {
    for (const rule of [MEM_ATHLETE, MEM_JUNIOR]) {
      const verdict = classifyFeeRule(rule);
      expect(verdict.studentCharge, `${rule.code} was permitted`).toBe(true);
      expect(verdict.shape).toBe('standing');
      expect(verdict.payer).toBe('receives_training');
      expect(verdict.refusalCode).toBe('student_standing_charge');
    }
  });

  it('refuses every shape of the charge, not only the word "membership"', () => {
    // The rule names five: membership, subscription, registration, account,
    // platform. None of them may be levied on somebody receiving training.
    const shapes: RuleCandidate[] = [
      { code: 'STU-MEMBERSHIP', label: 'Student membership', kind: 'base', audience: 'individual' },
      { code: 'STU-SUBSCRIPTION', label: 'Student subscription', kind: 'base', audience: 'individual' },
      { code: 'STU-REGISTRATION', label: 'Student registration fee', kind: 'base', audience: 'individual' },
      { code: 'STU-ACCOUNT', label: 'Student account fee', kind: 'base', audience: 'individual' },
      { code: 'STU-PLATFORM', label: 'Platform fee', kind: 'base', audience: 'individual', conditions: { category: 'athlete' } },
      { code: 'JR-JOINING', label: 'Junior joining fee', kind: 'base', audience: 'individual' },
      { code: 'KID-DUES', label: 'Annual dues, children', kind: 'base', audience: 'family' },
      { code: 'ATH-ENROL', label: 'Athlete enrolment fee', kind: 'base', audience: 'individual' },
    ];
    for (const rule of shapes) {
      expect(isStudentCharge(rule), `${rule.code} was permitted`).toBe(true);
    }
  });

  it('sees through an abbreviated code and a neutral label', () => {
    // 'MEM-ATH' tokenises to ['mem','ath'] — the guard reads codes, not prose.
    expect(isStudentCharge({ code: 'MEM-ATH', label: 'Annual', kind: 'base', audience: 'individual' })).toBe(true);
    // A code nobody can read at all, whose CONDITION says who it charges.
    expect(isStudentCharge({
      code: 'RULE-17', label: 'Annual membership', kind: 'base',
      audience: 'individual', conditions: { category: 'athlete' },
    })).toBe(true);
    // The same rule, named for the payer the federation does charge.
    expect(isStudentCharge({
      code: 'RULE-18', label: 'Annual membership', kind: 'base',
      audience: 'individual', conditions: { category: 'instructor' },
    })).toBe(false);
  });

  it('does not mistake a competition entry for a membership', () => {
    // "Registration" and "entry" beside a delivered event mean the event. The
    // federation charges athletes to compete, and always has.
    const permitted: RuleCandidate[] = [
      { code: 'CMP-ENTRY-FIRST', label: 'Athlete entry, first category', kind: 'base' },
      { code: 'CMP-REG', label: 'Championship registration fee', kind: 'base', conditions: { category: 'athlete' } },
      { code: 'CMP-LATE', label: 'Late entry surcharge', kind: 'fixed_add', conditions: { lateEntry: true } },
      { code: 'GRD-KYU', label: 'Kyu examination', kind: 'base', conditions: { examination: 'kyu' } },
      { code: 'EDU-CAMP-DAY', label: 'Training camp, per day', kind: 'per_session', conditions: { event: 'camp' } },
      { code: 'CRS-ENROL', label: 'Course enrolment, per student', kind: 'per_participant', conditions: { course: 'kata' } },
    ];
    for (const rule of permitted) {
      const verdict = classifyFeeRule(rule);
      expect(verdict.studentCharge, `${rule.code} was refused: ${verdict.refusal}`).toBe(false);
    }
  });

  it('does not mistake paying for training for paying to be a student', () => {
    const permitted: RuleCandidate[] = [
      { code: 'TRN-MONTHLY-CENTRE', label: 'Monthly training at an MMAKF centre', kind: 'base', audience: 'individual', conditions: { mode: 'at_dojo' } },
      { code: 'TRN-MONTHLY-SUB', label: 'Monthly training subscription', kind: 'base', audience: 'individual', conditions: { ageBand: 'junior' } },
      { code: 'TRN-PERSONAL', label: 'Personal coaching, per session', kind: 'per_session', audience: 'individual' },
      { code: 'TRN-JUNIOR-DISCOUNT', label: 'Junior rate', kind: 'discount', amountMinor: -20000, audience: 'individual', conditions: { ageBand: 'junior' } },
    ];
    for (const rule of permitted) {
      const verdict = classifyFeeRule(rule);
      expect(verdict.studentCharge, `${rule.code} was refused: ${verdict.refusal}`).toBe(false);
      expect(verdict.shape).toBe('delivery');
    }
  });

  it('refuses a standing charge that never says who it is for', () => {
    // The fail-closed reading, and the one most likely to be argued with. An
    // "annual membership" for `individual` with no category charges the child in
    // Patratu exactly as surely as one that says so.
    for (const audience of ['individual', 'family', null]) {
      const verdict = classifyFeeRule({
        code: 'MEM-ANNUAL', label: 'Annual membership', kind: 'base', audience,
      });
      expect(verdict.studentCharge, `audience ${String(audience)} was permitted`).toBe(true);
      expect(verdict.payer).toBe('unstated');
      expect(verdict.refusalCode).toBe('unattributed_standing_charge');
      // The cure is named in the refusal, so the author is not left guessing.
      expect(verdict.refusal).toMatch(/category/i);
    }
  });

  it('permits an organisation paying for its own standing', () => {
    for (const rule of [
      { code: 'MEM-DOJO', label: 'Dojo or club affiliation, annual', kind: 'base', audience: 'club' },
      { code: 'MEM-INSTITUTION', label: 'Institutional affiliation, annual', kind: 'base', audience: 'school' },
      // A threshold on a condition KEY is a size test on the institution, not a
      // statement that participants are the payer.
      { code: 'AFF-LARGE', label: 'Institutional affiliation, large body', kind: 'base', audience: 'school', conditions: { participants: { min: 50 } } },
    ] as RuleCandidate[]) {
      const verdict = classifyFeeRule(rule);
      expect(verdict.studentCharge, `${rule.code} was refused: ${verdict.refusal}`).toBe(false);
      expect(verdict.payer).toBe('organisation');
    }
  });

  it('refuses a per-head standing charge hidden inside an institutional line', () => {
    // Billing the school does not change who the charge is levied on.
    const school = classifyFeeRule({
      code: 'INST-PER-CHILD-MEM', label: 'Membership, per child',
      kind: 'per_participant', audience: 'school', amountMinor: 30000,
    });
    expect(school.studentCharge).toBe(true);

    const corporate = classifyFeeRule({
      code: 'CORP-PER-EMPLOYEE-MEM', label: 'Membership, per participant',
      kind: 'per_participant', audience: 'corporate', amountMinor: 30000,
    });
    expect(corporate.studentCharge).toBe(true);

    // The branch that catches the version naming NOBODY — the charge reads as
    // the institution's own membership and is still levied once per head, and
    // the head belongs to somebody receiving training.
    const anonymous = classifyFeeRule({
      code: 'INST-MEM-HEAD', label: 'Institutional membership', kind: 'per_participant',
      audience: 'school', amountMinor: 30000,
    });
    expect(anonymous.payer).toBe('organisation');
    expect(anonymous.refusalCode).toBe('per_trainee_standing_charge');
    expect(anonymous.refusal).toMatch(/no per-child membership/i);

    // While the ordinary per-participant TRAINING line stays legitimate — this
    // is the distinction the whole predicate exists to make.
    expect(isStudentCharge({
      code: 'INST-PER-PARTICIPANT', label: 'Per participant',
      kind: 'per_participant', audience: 'school', amountMinor: 45000,
    })).toBe(false);
  });

  it('names the rule and the reason, so the refusal can be argued with', () => {
    const verdict = classifyFeeRule(MEM_JUNIOR);
    expect(verdict.refusal).toContain('MEM-JUNIOR');
    expect(verdict.refusal).toContain('Junior athlete membership, annual');
    expect(verdict.refusal).toMatch(/receives training/i);
    expect(verdict.refusal).toMatch(/does not pay a membership fee for being a student/i);
    // The evidence says which words decided it, and where they were found.
    expect(verdict.evidence.some((e) => e.signal === 'standing')).toBe(true);
    expect(verdict.evidence.some((e) => e.signal === 'student')).toBe(true);
    expect(verdict.evidence.some((e) => e.field === 'conditions.category')).toBe(true);
  });

  it('assertNoStudentCharge throws for a seed and returns for a legitimate rule', () => {
    expect(() => assertNoStudentCharge(MEM_ATHLETE)).toThrow(/MEM-ATHLETE/);
    try {
      assertNoStudentCharge(MEM_ATHLETE);
      throw new Error('should not reach');
    } catch (err) {
      expect(isStudentChargeRefused(err)).toBe(true);
      expect((err as any).code).toBe('student_standing_charge');
    }
    expect(assertNoStudentCharge(MEMBERSHIP[0] as RuleCandidate).studentCharge).toBe(false);
  });

  it('never throws, whatever it is handed', () => {
    // A guard that can crash is a guard somebody wraps in a try/catch that
    // swallows it. Every one of these must produce a verdict.
    const junk: RuleCandidate[] = [
      {},
      { code: null, label: null, kind: null, audience: null, conditions: null },
      { code: '', label: '', conditions: { a: { b: { c: [1, 2, { d: 'membership' }] } } } },
      { code: 'X', conditions: [] as unknown as Record<string, unknown> },
    ];
    for (const rule of junk) expect(() => classifyFeeRule(rule)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE DOMAIN — the engine will not create one, and will not freeze one
// ═══════════════════════════════════════════════════════════════════════════

describe('addRule() refuses a student membership', () => {
  async function refuse(rule: any) {
    const fw = await draft();
    let error: any = null;
    try {
      await addRule(db, ctx, fw, rule);
    } catch (err) { error = err; }
    expect(error, 'addRule accepted the rule').toBeTruthy();
    expect(isFeeError(error)).toBe(true);
    expect(error.code).toBe('student_charge_refused');
    // AND NOTHING WAS WRITTEN. A refusal that leaves the row behind is not one.
    const rows = await db.select().from(s.feeRules).where(eq(s.feeRules.frameworkId, fw));
    expect(rows).toEqual([]);
    return error;
  }

  it('refuses MEM-ATHLETE, naming the rule', async () => {
    const err = await refuse({ ...MEM_ATHLETE });
    expect(err.message).toContain('MEM-ATHLETE');
  });

  it('refuses MEM-JUNIOR, naming the rule', async () => {
    const err = await refuse({ ...MEM_JUNIOR });
    expect(err.message).toContain('MEM-JUNIOR');
  });

  it('refuses a student registration fee — registration is not a product either', async () => {
    await refuse({
      code: 'REG-STUDENT', label: 'Student registration fee', kind: 'base',
      audience: 'individual', amountMinor: 20000,
    });
  });

  it('refuses a neutral code that points at the athlete-membership service', async () => {
    // The rule carries no incriminating word of its own. The service it prices
    // does, and addRule() resolves it before judging.
    await refuse({
      code: 'R-042', label: 'Annual charge', kind: 'base',
      serviceId: ATHLETE_MEMBERSHIP_SERVICE, audience: 'individual', amountMinor: 50000,
    });
  });

  it('still creates the memberships the federation does charge', async () => {
    const fw = await draft();
    for (const rule of MEMBERSHIP) {
      const row = await addRule(db, ctx, fw, {
        code: rule.code, label: rule.label, kind: rule.kind,
        audience: rule.audience ?? null, conditions: rule.conditions,
        amountMinor: rule.amountMinor ?? null, factorPpm: rule.factorPpm ?? null,
        sortOrder: rule.sortOrder,
      });
      expect(row.code).toBe(rule.code);
    }
    const rows = await db.select().from(s.feeRules).where(eq(s.feeRules.frameworkId, fw));
    expect(rows.length).toBe(MEMBERSHIP.length);
  });

  it('cannot be evaded by CLONING a framework — the clone copies through addRule()', async () => {
    // /admin/fees clones by re-adding every rule through addRule(). This is that
    // path: whatever the source framework holds, the copy is judged again.
    const source = await draft('Source with a smuggled rule');
    await db.insert(s.feeRules).values({
      frameworkId: source, code: 'MEM-ATHLETE', label: 'Athlete membership, annual',
      kind: 'base', audience: 'individual', conditions: { category: 'athlete' },
      amountMinor: 50000, sortOrder: 12,
    });
    const rows = await db.select().from(s.feeRules).where(eq(s.feeRules.frameworkId, source));
    expect(rows.length).toBe(1);

    const clone = await draft('The clone');
    await expect(addRule(db, ctx, clone, {
      code: rows[0].code, label: rows[0].label, kind: rows[0].kind,
      audience: rows[0].audience, conditions: rows[0].conditions,
      amountMinor: rows[0].amountMinor, sortOrder: rows[0].sortOrder,
    })).rejects.toThrow(/MEM-ATHLETE/);
  });
});

describe('publishFramework() refuses to give one the power to charge', () => {
  it('refuses a framework whose student rule was inserted by a seed or a migration', async () => {
    // The vector addRule() cannot see: a row that never passed through it. This
    // is the gate that makes the rule structural rather than procedural.
    const fw = await draft('Seeded framework');
    await addRule(db, ctx, fw, {
      code: 'TRN-MONTHLY', label: 'Monthly training', kind: 'base',
      audience: 'individual', amountMinor: 80000, sortOrder: 10,
    });
    await db.insert(s.feeRules).values({
      frameworkId: fw, code: 'MEM-JUNIOR', label: 'Junior athlete membership, annual',
      kind: 'base', audience: 'individual', conditions: { category: 'athlete', ageBand: 'junior' },
      amountMinor: 30000, sortOrder: 11,
    });

    let error: any = null;
    try { await publishFramework(db, ctx, fw); } catch (err) { error = err; }
    expect(error, 'the framework was published').toBeTruthy();
    expect(error.code).toBe('student_charge_refused');
    expect(error.message).toContain('MEM-JUNIOR');

    // IT STAYS A DRAFT. A draft framework prices nothing: activeFramework() will
    // not return it and computeFee() refuses it outright.
    const [after] = await db.select().from(s.feeFrameworks).where(eq(s.feeFrameworks.id, fw));
    expect(after.status).toBe('draft');
    expect(after.publishedAt).toBeNull();
    await expect(computeFee(db, fw, { audience: 'individual' }))
      .rejects.toThrow(/only a PUBLISHED framework/i);
  });

  it('names EVERY offending rule, not just the first', async () => {
    const fw = await draft('Several offenders');
    await addRule(db, ctx, fw, {
      code: 'TRN-MONTHLY', label: 'Monthly training', kind: 'base',
      audience: 'individual', amountMinor: 80000, sortOrder: 10,
    });
    await db.insert(s.feeRules).values([
      { frameworkId: fw, code: 'MEM-ATHLETE', label: 'Athlete membership', kind: 'base', audience: 'individual', amountMinor: 50000, sortOrder: 11 },
      { frameworkId: fw, code: 'MEM-JUNIOR', label: 'Junior membership', kind: 'base', audience: 'individual', amountMinor: 30000, sortOrder: 12 },
      { frameworkId: fw, code: 'PLATFORM', label: 'Platform fee', kind: 'base', audience: 'individual', amountMinor: 5000, sortOrder: 13 },
    ]);

    let error: any = null;
    try { await publishFramework(db, ctx, fw); } catch (err) { error = err; }
    expect(error).toBeTruthy();
    for (const code of ['MEM-ATHLETE', 'MEM-JUNIOR', 'PLATFORM']) {
      expect(error.message, `${code} was not named`).toContain(code);
    }
    expect(error.message).toContain('3 of its 4 rules');
  });

  it('publishes a framework of legitimate rules — training and a coach membership', async () => {
    const fw = await draft('Legitimate, second copy');
    await addRule(db, ctx, fw, {
      code: 'TRN-MONTHLY', label: 'Monthly training at an MMAKF centre', kind: 'base',
      audience: 'individual', conditions: { mode: 'at_dojo' }, amountMinor: 80000, sortOrder: 10,
    });
    await addRule(db, ctx, fw, {
      code: 'MEM-COACH', label: 'Coach or instructor membership, annual', kind: 'base',
      audience: 'individual', conditions: { category: 'instructor' }, amountMinor: 100000, sortOrder: 20,
    });
    const result = await publishFramework(db, ctx, fw);
    expect(result.status).toBe('published');
    expect(result.rules).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// WHAT A STUDENT IS ACTUALLY CHARGED
// ═══════════════════════════════════════════════════════════════════════════

describe('registering as a student costs nothing', () => {
  it('student registration requires no fee of any kind', async () => {
    const [person] = await db.insert(s.persons).values({
      federationId: 'MMAKF-MEM-2026-000101', fullName: 'Anjali Kumari', status: 'active',
    }).returning();

    // The register holds them. No order, no line, no invoice, no entitlement was
    // created by the act of existing.
    const orders = await db.select().from(s.orders).where(eq(s.orders.personId, person.id));
    expect(orders).toEqual([]);

    // And the published framework prices nothing for a bare student. Not zero —
    // NO FIGURE, which is what "the federation charges nothing for this" looks
    // like in an engine that must never invent an amount.
    const c = await computeFee(db, FW, { audience: 'individual', category: 'student' });
    expect(c.lines).toEqual([]);
    expect(c.requiresManualQuote).toBe(true);
    expect(c.totalMinor).toBe(0);
  });

  it('junior registration requires no fee of any kind', async () => {
    const c = await computeFee(db, FW, {
      audience: 'individual', category: 'student', ageBand: 'junior',
    });
    expect(c.lines).toEqual([]);
    expect(c.requiresManualQuote).toBe(true);
    // Not one rule was even a candidate for a junior — the framework holds none.
    expect(c.skipped.some((k) => /MEM-JUNIOR|MEM-ATHLETE/.test(k.ruleCode))).toBe(false);
  });
});

describe('buying training buys training, and nothing else', () => {
  it('the quotation carries ONE line and it is the training charge', async () => {
    const c = await computeFee(db, FW, { audience: 'individual', mode: 'at_dojo' });
    // Asserted on the LINES, not the total. A total is exactly where a second
    // charge hides: ₹800 + ₹500 and ₹1,300 look identical from the outside.
    expect(c.lines.map((l) => l.ruleCode)).toEqual(['TRN-MONTHLY']);
    expect(c.lines.every((l) => l.kind !== 'membership')).toBe(true);
    expect(findStudentCharges(c.lines.map((l) => ({ code: l.ruleCode, label: l.label, kind: l.kind })))).toEqual([]);
    expect(c.totalMinor).toBe(80000);
  });

  it('checkout never injects a membership line', async () => {
    const order = await createOrder(db, null, {
      email: 'student@example.in',
      lines: [{ kind: 'program' as any, description: 'Monthly training', feeCode: 'training.monthly' }],
    });
    const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
    expect(lines.length).toBe(1);
    expect(lines[0].kind).toBe('program');
    expect(lines.some((l: any) => l.kind === 'membership')).toBe(false);
    expect(lines.some((l: any) => /member|subscription|platform|account fee/i.test(l.description))).toBe(false);
    expect(order.totalPaise).toBe(80000);
  });

  it('the invoice never injects a membership line', async () => {
    const order = await createOrder(db, null, {
      email: 'student2@example.in',
      lines: [{ kind: 'program' as any, description: 'Monthly training', feeCode: 'training.monthly' }],
    });
    const invoice = await issueInvoice(db, order.id);
    const snapshot = invoice.snapshot as any;
    expect(snapshot.lines.length).toBe(1);
    expect(snapshot.lines[0].description).toBe('Monthly training at an MMAKF centre');
    expect(snapshot.lines.some((l: any) => /member|subscription/i.test(l.description))).toBe(false);
    // The frozen document adds up to the training charge and no more.
    expect(snapshot.totalPaise).toBe(80000);
    expect(snapshot.subtotalPaise).toBe(80000);
  });

  it('training revenue classifies as TRAINING, never MEMBERSHIP', async () => {
    const order = await createOrder(db, null, {
      email: 'student3@example.in',
      lines: [{ kind: 'program' as any, description: 'Monthly training', feeCode: 'training.monthly' }],
    });
    const payment = await beginPayment(db, order.id, {
      provider: 'razorpay', providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, idempotencyKey: crypto.randomUUID(),
    });
    await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalPaise,
    }));

    const entries = await db.select().from(s.ledgerEntries).where(eq(s.ledgerEntries.orderId, order.id));
    const accounts = entries.map((e: any) => e.account);
    // The account is derived from the LINE KIND, so a training purchase can only
    // land in a training account.
    expect(accounts).toContain('income.program');
    expect(accounts.some((a: string) => /membership/i.test(a))).toBe(false);
  });
});

describe('an institutional programme creates no per-head membership', () => {
  it('a school programme charges the programme and the participants, never their standing', async () => {
    const c = await computeFee(db, FW, { audience: 'school', participants: 400 });
    expect(c.lines.map((l) => l.ruleCode)).toEqual(['INST-BASE', 'INST-PER-PARTICIPANT']);
    // 400 children, and not one membership among them.
    expect(c.lines.every((l) => !/mem/i.test(l.ruleCode ?? ''))).toBe(true);
    expect(findStudentCharges(c.lines.map((l) => ({ code: l.ruleCode, label: l.label, kind: l.kind })))).toEqual([]);
    const perHead = c.lines.find((l) => l.ruleCode === 'INST-PER-PARTICIPANT')!;
    expect(perHead.quantity).toBe(400);
    // No membership row exists for any of them either.
    const memberships = await db.select().from(s.memberships);
    expect(memberships).toEqual([]);
  });

  it('a corporate programme creates no per-employee membership', async () => {
    const c = await computeFee(db, FW, { audience: 'corporate', participants: 120 });
    expect(c.lines.map((l) => l.ruleCode)).toEqual(['CORP-BASE', 'CORP-PER-PARTICIPANT']);
    expect(c.lines.every((l) => l.kind !== 'membership')).toBe(true);
    expect(findStudentCharges(c.lines.map((l) => ({ code: l.ruleCode, label: l.label, kind: l.kind })))).toEqual([]);
  });
});

describe('a student account is not a membership, so it does not lapse with one', () => {
  it('attendance, grades and certificates stay readable after the entitlement expires', async () => {
    // ACCESS IS DECIDED BY A TRAINING ENTITLEMENT. When one expires, the training
    // stops — the RECORD does not. What somebody attended, what they were graded
    // and what they were awarded are facts about the past, and no lapse revises
    // a fact.
    const [person] = await db.insert(s.persons).values({
      federationId: 'MMAKF-MEM-2026-000102', fullName: 'Rohit Mahto', status: 'active',
    }).returning();

    const [session] = await db.insert(s.trainingSessions).values({
      title: 'Evening class', heldOn: '2026-03-04',
    }).returning();
    await db.insert(s.sessionAttendance).values({
      sessionId: session.id, personId: person.id, present: true,
    });
    await db.insert(s.rankRecords).values({
      personId: person.id, kind: 'kyu', gradeLabel: '8th Kyu',
      gradeOrdinal: 8, awardedOn: '2026-04-10', status: 'active',
    });
    await db.insert(s.certificates).values({
      certificateNo: 'MMAKF-CERT-2026-000101', kind: 'kyu_grade', personId: person.id,
      title: '8th Kyu', issuedOn: '2026-04-10', issuingAuthority: 'MMAKF',
      verifyToken: crypto.randomBytes(18).toString('base64url'), snapshot: { grade: '8th Kyu' },
    });

    // A training purchase, and an entitlement for it that has run out.
    const order = await createOrder(db, null, {
      personId: person.id, email: 'rohit@example.in',
      lines: [{ kind: 'program' as any, description: 'Monthly training', feeCode: 'training.monthly' }],
    });
    const [line] = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
    const [payment] = await db.insert(s.payments).values({
      orderId: order.id, provider: 'manual_upi', providerPaymentId: `pay_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalPaise, status: 'captured', capturedAt: new Date('2026-03-01'),
    }).returning();
    await db.insert(s.entitlements).values({
      subject: 'program', orderId: order.id, orderLineId: line.id, paymentId: payment.id,
      status: 'active', validFrom: '2026-03-01', validTo: '2026-03-31',
    });

    // The entitlement is over.
    const [ent] = await db.select().from(s.entitlements).where(eq(s.entitlements.orderId, order.id));
    expect(ent.validTo < '2026-08-17').toBe(true);

    // And every record survives it, in full.
    const [after] = await db.select().from(s.persons).where(eq(s.persons.id, person.id));
    expect(after.status).toBe('active');
    expect(after.fullName).toBe('Rohit Mahto');

    const attendance = await db.select().from(s.sessionAttendance)
      .where(eq(s.sessionAttendance.personId, person.id));
    expect(attendance.length).toBe(1);
    expect(attendance[0].present).toBe(true);

    const ranks = await db.select().from(s.rankRecords)
      .where(and(eq(s.rankRecords.personId, person.id), eq(s.rankRecords.status, 'active')));
    expect(ranks.map((r: any) => r.gradeLabel)).toEqual(['8th Kyu']);

    const certs = await db.select().from(s.certificates)
      .where(eq(s.certificates.personId, person.id));
    expect(certs.length).toBe(1);
    expect(certs[0].status).toBe('issued');

    // AND NOTHING ANYWHERE ISSUED THEM A MEMBERSHIP to hang the account on.
    const memberships = await db.select().from(s.memberships)
      .where(eq(s.memberships.personId, person.id));
    expect(memberships).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AND THE RULE GOVERNS THE FUTURE, NOT THE LEDGER
// ═══════════════════════════════════════════════════════════════════════════

describe('a historical record containing a student membership charge is untouched', () => {
  it('stays readable, and stays exactly as it was', async () => {
    // Suppose a payment taken in 2019 genuinely did contain one. Correcting the
    // accounting to match a 2026 policy would be falsifying it, and a falsified
    // ledger is a worse defect than the fee it was meant to hide.
    const [order] = await db.insert(s.orders).values({
      orderNo: 'MMAKF-ORD-2019-000001', buyerName: 'Sunita Devi',
      email: 'sunita@example.in', status: 'paid',
      subtotalPaise: 130000, taxPaise: 0, shippingPaise: 0, totalPaise: 130000,
      paidAt: new Date('2019-06-01T00:00:00Z'),
    }).returning();
    await db.insert(s.orderLines).values([
      {
        orderId: order.id, kind: 'membership',
        feeCode: 'membership.junior.annual',
        description: 'Junior athlete membership 2019-20',
        quantity: 1, unitPricePaise: 50000, taxPaise: 0, totalPaise: 50000,
      },
      {
        orderId: order.id, kind: 'other',
        description: 'Monthly training, June 2019',
        quantity: 1, unitPricePaise: 80000, taxPaise: 0, totalPaise: 80000,
      },
    ]);
    const invoice = await issueInvoice(db, order.id);

    const before = await db.select().from(s.orderLines)
      .where(eq(s.orderLines.orderId, order.id)).orderBy(s.orderLines.id);
    const invoiceBefore = JSON.stringify((invoice.snapshot as any).lines);

    // Now run every guard this track added, hard, against the same database.
    await expect(addRule(db, ctx, await draft(), { ...MEM_ATHLETE } as any))
      .rejects.toThrow(/MEM-ATHLETE/);
    const seeded = await draft('Another seeded framework');
    await db.insert(s.feeRules).values({
      frameworkId: seeded, code: 'MEM-JUNIOR', label: 'Junior athlete membership',
      kind: 'base', audience: 'individual', amountMinor: 30000, sortOrder: 10,
    });
    await expect(publishFramework(db, ctx, seeded)).rejects.toThrow(/MEM-JUNIOR/);
    findStudentCharges(before.map((l: any) => ({ code: l.feeCode, label: l.description, kind: 'base' })));

    // THE RECORD IS UNCHANGED. Same lines, same words, same amounts, same order.
    const after = await db.select().from(s.orderLines)
      .where(eq(s.orderLines.orderId, order.id)).orderBy(s.orderLines.id);
    expect(after).toEqual(before);
    expect(after.map((l: any) => l.description)).toEqual([
      'Junior athlete membership 2019-20',
      'Monthly training, June 2019',
    ]);
    expect(after.find((l: any) => l.kind === 'membership')!.totalPaise).toBe(50000);

    const [orderAfter] = await db.select().from(s.orders).where(eq(s.orders.id, order.id));
    expect(orderAfter.totalPaise).toBe(130000);
    expect(orderAfter.status).toBe('paid');

    const [invoiceAfter] = await db.select().from(s.invoices).where(eq(s.invoices.orderId, order.id));
    expect(JSON.stringify((invoiceAfter.snapshot as any).lines)).toBe(invoiceBefore);
  });

  it('the guard reads no ledger, no order and no invoice — it cannot rewrite one', () => {
    // Structural, not a promise. src/db/student-rule.ts takes no database handle
    // and imports nothing that could give it one, for the same reason
    // src/db/fee-recommendation.ts takes none: there is nothing to write with.
    const source = readFileSync('src/db/student-rule.ts', 'utf8');
    // No import at all, of anything. It cannot name a table or form a statement.
    expect(source).not.toMatch(/^\s*import\s/m);
    // And no call that could read or write one, however it were obtained.
    expect(source).not.toMatch(/\.(select|insert|update|delete)\s*\(/);
    expect(source).not.toMatch(/orderLines|ledgerEntries|invoices|quoteLines/);
  });
});
