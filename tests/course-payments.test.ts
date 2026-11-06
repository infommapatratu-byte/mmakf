// Pay for a course -> enrolment active. The path that did not exist:
// activateEnrolment() had no caller, and nothing created an order for a course.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { importFeeMaster } from '../src/db/fee-register';
import { startCoursePayment, activatePaidCourseEnrolments, feeInForce } from '../src/db/course-payments';
import { legacyAdminPrincipal } from '../src/lib/rbac';

const ctx = { principal: legacyAdminPrincipal(), reason: 'test', authority: 'test' } as any;

describe('the wiring is reachable from what runs in production', () => {
  it('the webhook activates after confirming, and the five-minute cron sweeps', () => {
    expect(readFileSync('src/pages/api/payments/razorpay/webhook.ts', 'utf8')).toContain('activatePaidCourseEnrolmentsSafely(');
    expect(readFileSync('src/pages/api/cron/notify.ts', 'utf8')).toContain('activatePaidCourseEnrolments(');
  });
  it('the academy API has a pay action that opens a payment against the order', () => {
    const api = readFileSync('src/pages/api/academy/[...action].ts', 'utf8');
    expect(api).toContain("case 'pay':");
    expect(api).toContain('startCoursePayment(');
    expect(api).toContain('beginPayment(');
  });
  it('the learner page offers payment for a fee-bearing course', () => {
    const page = readFileSync('src/pages/my/courses.astro', 'utf8');
    expect(page).toContain('course-pay');
    expect(page).toContain("post('pay'");
  });
});

describe('paying for a course, against a real schema', () => {
  let db: any;
  let personId: number;
  let paidCourseId: number;
  let proposedCourseId: number;
  const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

  beforeAll(async () => {
    const client = new PGlite();
    db = drizzle(client, { schema: s });
    for (const f of MIGRATIONS) {
      for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (st.trim()) await client.exec(st.trim());
      }
    }
    await importFeeMaster(db, ctx);
    const [p] = await db.insert(s.persons).values({ federationId: 'MMAKF-A-2026-90011', fullName: 'Paying Learner', email: 'payer@example.com' }).returning();
    personId = p.id;
    const [c1] = await db.insert(s.courses).values({
      slug: 'taste-the-discipline', title: 'Course 01 – Taste the Discipline', status: 'published',
      feeCode: 'course.shotokan.01-taste-the-discipline',
    }).returning();
    paidCourseId = c1.id;
    const [c2] = await db.insert(s.courses).values({
      slug: 'dan-preparation', title: 'Dan Preparation', status: 'published', feeCode: 'programme.dan-preparation',
    }).returning();
    proposedCourseId = c2.id;
  }, 120_000);

  it('reads the price from the fee register, as checkout does', async () => {
    expect(await feeInForce(db, 'course.shotokan.01-taste-the-discipline')).toMatchObject({ amountPaise: 800000 });
    expect(await feeInForce(db, 'programme.dan-preparation')).toBeNull();   // proposed
  });

  it('a course whose fee is only PROPOSED cannot be paid, and leaves no orphan enrolment', async () => {
    await expect(startCoursePayment(db, ctx, { courseId: proposedCourseId, personId }))
      .rejects.toMatchObject({ code: 'fee_not_approved' });
    const rows = await db.select().from(s.enrolments).where(eq(s.enrolments.courseId, proposedCourseId));
    expect(rows).toHaveLength(0);
  });

  let orderId: number;
  it('creates a pending enrolment and an order at the office figure, with the line activation needs', async () => {
    const started = await startCoursePayment(db, ctx, { courseId: paidCourseId, personId, buyerName: 'Paying Learner', email: 'payer@example.com' });
    expect(started).toMatchObject({ totalPaise: 800000, reused: false });
    orderId = started.orderId;
    const [enrolment] = await db.select().from(s.enrolments).where(eq(s.enrolments.id, started.enrolmentId));
    expect(enrolment).toMatchObject({ status: 'pending_payment', orderId });
    const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, orderId));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ kind: 'course', refType: 'course', refId: paidCourseId });
  });

  it('a second attempt resumes the same open order — a closed window is never a dead end', async () => {
    const again = await startCoursePayment(db, ctx, { courseId: paidCourseId, personId });
    expect(again).toMatchObject({ orderId, reused: true });
    const orders = await db.select().from(s.orders).where(eq(s.orders.personId, personId));
    expect(orders).toHaveLength(1);
  });

  it('nothing activates while the order is unpaid', async () => {
    expect(await activatePaidCourseEnrolments(db)).toMatchObject({ considered: 0, activated: 0 });
  });

  it('once the payment is captured, the sweep activates the enrolment exactly once', async () => {
    // What confirmPayment() does to the order on a verified capture.
    await db.update(s.orders).set({ status: 'paid', paidAt: new Date() }).where(eq(s.orders.id, orderId));
    expect(await activatePaidCourseEnrolments(db, { orderId })).toMatchObject({ considered: 1, activated: 1, failed: 0 });
    const [enrolment] = await db.select().from(s.enrolments)
      .where(and(eq(s.enrolments.courseId, paidCourseId), eq(s.enrolments.personId, personId)));
    expect(enrolment.status).toBe('active');
    expect(await activatePaidCourseEnrolments(db)).toMatchObject({ considered: 0 });
    await expect(startCoursePayment(db, ctx, { courseId: paidCourseId, personId }))
      .rejects.toMatchObject({ code: 'already_active' });
  });
});
