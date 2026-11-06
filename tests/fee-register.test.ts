// The fee register: the office's fee master, its governance, and checkout.
//
// The rule under test is the office's own: "The payment system should never
// charge a proposed fee until an authorised administrator approves it." These
// tests drive the REAL createOrder() — the function checkout calls — so a pass
// means a price is chargeable or refused where it matters, not merely flagged.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createOrder } from '../src/db/orders';
import { importFeeMaster, approveFee, archiveFee, feeRegister, studentRefusal } from '../src/db/fee-register';
import { FEE_MASTER, FEE_MASTER_EXCLUSIONS } from '../src/data/fee-master-2026';
import { legacyAdminPrincipal, ForbiddenError } from '../src/lib/rbac';

const ctx = { principal: legacyAdminPrincipal(), reason: 'test', authority: 'test' } as any;
const nobody = { principal: null, reason: 'test', authority: 'test' } as any;

function courseOrder(feeCode: string) {
  return { email: 'learner@example.com', buyerName: 'Learner', lines: [{ kind: 'course' as const, description: 'Course', feeCode }] };
}
function lineOrder(kind: any, feeCode: string) {
  return { email: 'learner@example.com', buyerName: 'Learner', lines: [{ kind, description: feeCode, feeCode }] };
}

describe('the fee master as transcribed', () => {
  it('every amount is a positive whole number of paise and every code is unique', () => {
    const codes = new Set<string>();
    for (const r of FEE_MASTER) {
      expect(Number.isInteger(r.amountPaise) && r.amountPaise > 0, r.code).toBe(true);
      expect(codes.has(r.code), `duplicate ${r.code}`).toBe(false);
      codes.add(r.code);
    }
  });

  it('carries the office figures exactly (spot checks across every group)', () => {
    const by = Object.fromEntries(FEE_MASTER.map((r) => [r.code, r]));
    expect(by['training.online.standard.month'].amountPaise).toBe(150000);
    expect(by['course.shotokan.02-the-black-belt'].amountPaise).toBe(14380000);
    expect(by['wkf.onsite.premium.student-month'].amountPaise).toBe(3000000);
    expect(by['programme.womens-self-defence.12-week'].amountPaise).toBe(2000000);
    expect(by['grading.dan.godan'].amountPaise).toBe(2500000);
    expect(by['affiliation.state-association.annual'].amountPaise).toBe(3000000);
    expect(by['delivery.online-belt'].amountPaise).toBe(15000);
  });

  it('every affiliation and tournament fee, and everything marked proposed, is proposed', () => {
    for (const r of FEE_MASTER) {
      if (r.group === '07 Affiliation' || r.group === '08 Tournaments & Events') expect(r.status, r.code).toBe('proposed');
    }
    for (const code of ['programme.dan-preparation', 'membership.individual.annual', 'certificate.duplicate', 'document.student-identity-card']) {
      expect(FEE_MASTER.find((r) => r.code === code)!.status, code).toBe('proposed');
    }
  });

  it('products and figure-less lines are listed as exclusions, not silently dropped', () => {
    const text = FEE_MASTER_EXCLUSIONS.map((x) => x.item).join(' | ');
    for (const word of ['Physical belt', 'Student kit', 'Karate Gi', 'National-level']) expect(text).toContain(word);
  });
});

describe('the register against a real schema and the real checkout', () => {
  let db: any;
  const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

  beforeAll(async () => {
    const client = new PGlite();
    db = drizzle(client, { schema: s });
    for (const f of MIGRATIONS) {
      for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (st.trim()) await client.exec(st.trim());
      }
    }
  }, 120_000);

  it('nothing fee-coded can be bought before the register is loaded', async () => {
    await expect(createOrder(db, null, courseOrder('course.shotokan.01-taste-the-discipline')))
      .rejects.toMatchObject({ code: 'fee_not_published' });
  });

  it('refuses to load without permission', async () => {
    await expect(importFeeMaster(db, nobody)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('loads every row with the governance the office stated', async () => {
    const report = await importFeeMaster(db, ctx);
    expect(report.inserted).toBe(FEE_MASTER.length);
    expect(report.approved + report.proposed + report.refused).toBe(FEE_MASTER.length);
    const rows = await feeRegister(db);
    for (const r of rows) {
      const src = FEE_MASTER.find((m) => m.code === r.code)!;
      if (studentRefusal(src)) {
        expect(r.active, `${r.code} is refused by the student rule and must not be chargeable`).toBe(false);
        expect(r.state).toBe('refused');
      } else if (src.status === 'approved') {
        expect(r.active, r.code).toBe(true);
        expect(r.state).toBe('approved');
        expect(r.approvedBy).toBeTruthy();
      } else {
        expect(r.active, r.code).toBe(false);
        expect(r.state).toBe('proposed');
        expect(r.approvedBy).toBeNull();
      }
    }
  });

  it('is idempotent: a second load changes nothing', async () => {
    const before = (await db.select().from(s.feeSchedule)).length;
    const report = await importFeeMaster(db, ctx);
    expect(report).toMatchObject({ inserted: 0, skippedExisting: FEE_MASTER.length });
    expect((await db.select().from(s.feeSchedule)).length).toBe(before);
  });

  it('an APPROVED course fee is charged at exactly the office figure', async () => {
    const order = await createOrder(db, null, courseOrder('course.shotokan.01-taste-the-discipline'));
    expect(Number(order.totalPaise ?? order.order?.totalPaise)).toBe(800000);
  });

  it('a PROPOSED fee is never charged — checkout refuses it', async () => {
    await expect(createOrder(db, null, courseOrder('programme.dan-preparation')))
      .rejects.toMatchObject({ code: 'fee_not_published' });
  });

  it('approval needs feeframework:publish, then the fee becomes chargeable', async () => {
    const [row] = await db.select().from(s.feeSchedule).where(eq(s.feeSchedule.code, 'programme.dan-preparation'));
    await expect(approveFee(db, nobody, row.id)).rejects.toBeInstanceOf(ForbiddenError);
    const approved = await approveFee(db, ctx, row.id);
    expect(approved.active).toBe(true);
    expect(approved.approvedBy).toContain('legacy-admin');
    const order = await createOrder(db, null, courseOrder('programme.dan-preparation'));
    expect(Number(order.totalPaise ?? order.order?.totalPaise)).toBe(1500000);
    await expect(approveFee(db, ctx, row.id)).rejects.toMatchObject({ code: 'already_approved' });
  });

  it('a fee the student rule refuses can never be approved here', async () => {
    const refused = (await feeRegister(db)).filter((r) => r.state === 'refused');
    for (const r of refused) {
      await expect(approveFee(db, ctx, r.id)).rejects.toMatchObject({ code: 'student_rule' });
    }
  });

  it('archiving stops the charge and keeps the record', async () => {
    const [row] = await db.select().from(s.feeSchedule).where(eq(s.feeSchedule.code, 'grading.kyu.yellow'));
    const ok = await createOrder(db, null, lineOrder('grading', 'grading.kyu.yellow'));
    expect(Number(ok.totalPaise ?? ok.order?.totalPaise)).toBe(100000);
    await archiveFee(db, ctx, row.id);
    await expect(createOrder(db, null, lineOrder('grading', 'grading.kyu.yellow')))
      .rejects.toMatchObject({ code: 'fee_not_published' });
    const after = (await feeRegister(db)).find((r) => r.id === row.id)!;
    expect(after.state).toBe('archived');
    await expect(archiveFee(db, ctx, row.id)).rejects.toMatchObject({ code: 'archived' });
  });
});
