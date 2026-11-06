// Paying for a course, and the enrolment that payment activates.
//
// THE GAP THIS CLOSES. The academy could enrol a learner on a fee-bearing course
// (status pending_payment) and could activate that enrolment once a captured
// payment covered it — activateEnrolment() proves the payment from the order —
// but nothing connected the two. No code created an order for a course, and
// activateEnrolment() had no caller, so a paid course could never become active.
//
// THE PATH, END TO END:
//   1. startCoursePayment(): find or create the learner's own enrolment, then
//      find its open order or create one with createOrder(). The price comes
//      from the fee register (fee_schedule, via the course's fee_code) — never
//      from the page — so a PROPOSED fee is refused here exactly as at checkout.
//      The order line carries refType 'course' / refId <course id>, which is what
//      activateEnrolment() looks for.
//   2. The caller opens a Razorpay payment against that order.
//   3. The signature-verified webhook confirms the payment (confirmPayment), and
//      activatePaidCourseEnrolments() activates the enrolment. The five-minute
//      notification cron runs the same sweep, so an activation interrupted
//      between the two steps is completed within minutes, never lost.
//
// activateEnrolment() stays the only thing that activates a paid enrolment, and
// it still demands the evidence: a CAPTURED order, the same person, a line for
// this course. This module only calls it at the right moment.

import { and, desc, eq, gte, isNotNull, isNull, lte, or } from 'drizzle-orm';
import * as s from '@/db/schema';
import type { AuditContext } from '@/db/federation';
import { enrol, activateEnrolment } from '@/db/academy';
import { createOrder, federationToday } from '@/db/orders';
import { legacyAdminPrincipal } from '@/lib/rbac';
import { log } from '@/lib/observability';

type DB = any;

export class CoursePaymentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'CoursePaymentError';
  }
}

export function isCoursePaymentError(err: unknown): err is CoursePaymentError {
  return err instanceof CoursePaymentError;
}

/** The fee in force today for a code, exactly as createOrder() would price it; null if none. */
export async function feeInForce(db: DB, feeCode: string, now: Date = new Date()) {
  const today = federationToday(now);
  const row = (await db.select().from(s.feeSchedule)
    .where(and(
      eq(s.feeSchedule.code, feeCode),
      eq(s.feeSchedule.active, true),
      lte(s.feeSchedule.effectiveFrom, today),
      or(isNull(s.feeSchedule.effectiveTo), gte(s.feeSchedule.effectiveTo, today)),
    ))
    .orderBy(desc(s.feeSchedule.effectiveFrom)).limit(1))[0];
  return row ? { amountPaise: Number(row.amountPaise), label: String(row.label) } : null;
}

export interface StartedCoursePayment {
  enrolmentId: number;
  orderId: number;
  orderNo: string;
  totalPaise: number;
  currency: string;
  buyerName: string | null;
  email: string | null;
  phone: string | null;
  reused: boolean;
}

const OPEN = (o: any) => o && !o.paidAt && o.status !== 'cancelled' && o.status !== 'expired';

/**
 * Prepare a learner's payment for a course: their enrolment and an open order.
 * Idempotent per learner and course: a second call reuses the open order, so a
 * closed payment window can always be resumed and never opens a second order.
 */
export async function startCoursePayment(
  db: DB,
  ctx: AuditContext,
  input: { courseId: number; personId: number; buyerName?: string | null; email?: string | null; phone?: string | null },
): Promise<StartedCoursePayment> {
  const course = (await db.select().from(s.courses).where(eq(s.courses.id, input.courseId)).limit(1))[0];
  if (!course || course.status !== 'published') {
    throw new CoursePaymentError('course_not_available', 'This course is not open for enrolment.');
  }
  if (!course.feeCode) {
    throw new CoursePaymentError('free_course', 'This course carries no fee. Enrol directly.');
  }
  // Checked BEFORE enrolling, so a course whose fee is still proposed (or
  // archived, or never entered) leaves no orphan "awaiting payment" enrolment.
  if (!(await feeInForce(db, course.feeCode))) {
    throw new CoursePaymentError('fee_not_approved', 'The fee for this course has not been approved yet, so it cannot be paid online. Nothing has been charged.');
  }

  let enrolment = (await db.select().from(s.enrolments)
    .where(and(eq(s.enrolments.courseId, course.id), eq(s.enrolments.personId, input.personId)))
    .limit(1))[0];
  if (!enrolment) {
    // enrol() checks the caller may act for this person and derives the status
    // from the fee: a fee-bearing course always starts pending_payment.
    enrolment = await enrol(db, ctx, { courseId: course.id, personId: input.personId });
  }
  if (enrolment.status === 'active') {
    throw new CoursePaymentError('already_active', 'You are already enrolled on this course.');
  }
  if (enrolment.status !== 'pending_payment') {
    throw new CoursePaymentError('not_payable', `This enrolment is ${String(enrolment.status).replace(/_/g, ' ')}.`);
  }

  if (enrolment.orderId != null) {
    const existing = (await db.select().from(s.orders).where(eq(s.orders.id, enrolment.orderId)).limit(1))[0];
    if (existing?.paidAt) {
      // Paid, but the activation has not run yet (it runs within minutes).
      await activatePaidCourseEnrolments(db, { orderId: existing.id });
      throw new CoursePaymentError('already_paid', 'Your payment for this course is recorded. Your enrolment is being activated — refresh in a minute.');
    }
    if (OPEN(existing)) {
      return {
        enrolmentId: enrolment.id, orderId: existing.id, orderNo: existing.orderNo,
        totalPaise: Number(existing.totalPaise), currency: existing.currency,
        buyerName: existing.buyerName ?? null, email: existing.email ?? null, phone: existing.phone ?? null,
        reused: true,
      };
    }
  }

  // Priced by createOrder() from the fee register; a proposed or unpublished
  // fee throws OrderError('fee_not_published') and nothing is created.
  const order = await createOrder(db, ctx, {
    personId: input.personId,
    buyerName: input.buyerName ?? undefined,
    email: input.email ?? undefined,
    phone: input.phone ?? undefined,
    lines: [{ kind: 'course', description: course.title, feeCode: course.feeCode, refType: 'course', refId: course.id }],
  });
  await db.update(s.enrolments).set({ orderId: order.id })
    .where(and(eq(s.enrolments.id, enrolment.id), eq(s.enrolments.status, 'pending_payment')));

  return {
    enrolmentId: enrolment.id, orderId: order.id, orderNo: order.orderNo,
    totalPaise: Number(order.totalPaise), currency: order.currency,
    buyerName: order.buyerName ?? null, email: order.email ?? null, phone: order.phone ?? null,
    reused: false,
  };
}

export interface ActivationReport {
  considered: number;
  activated: number;
  failed: number;
  errors: string[];
}

/**
 * Activate every pending enrolment whose order carries a captured payment.
 * activateEnrolment() re-proves each one; a row that fails its proof is
 * reported, never forced. Safe to run any number of times.
 */
export async function activatePaidCourseEnrolments(
  db: DB,
  opts: { orderId?: number; limit?: number } = {},
): Promise<ActivationReport> {
  const ctx: AuditContext = {
    principal: legacyAdminPrincipal(),
    reason: 'A captured payment covers this course enrolment.',
    authority: 'MMAKF payments',
  } as AuditContext;
  const conds = [
    eq(s.enrolments.status, 'pending_payment'),
    isNotNull(s.enrolments.orderId),
    isNotNull(s.orders.paidAt),
  ];
  if (opts.orderId != null) conds.push(eq(s.enrolments.orderId, opts.orderId));
  const rows = await db.select({ id: s.enrolments.id })
    .from(s.enrolments)
    .innerJoin(s.orders, eq(s.enrolments.orderId, s.orders.id))
    .where(and(...conds))
    .limit(opts.limit ?? 100);

  const report: ActivationReport = { considered: rows.length, activated: 0, failed: 0, errors: [] };
  for (const r of rows) {
    try {
      await activateEnrolment(db, ctx, r.id);
      report.activated++;
    } catch (err: any) {
      report.failed++;
      report.errors.push(`#${r.id}: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
  return report;
}

/** The webhook's entry point: never throws into the payment path. */
export async function activatePaidCourseEnrolmentsSafely(db: DB, orderId: number): Promise<void> {
  try {
    const r = await activatePaidCourseEnrolments(db, { orderId });
    if (r.considered) log.info('course_payments.activated', { orderId, ...r });
  } catch (err: any) {
    log.warn('course_payments.activation_failed', { orderId, error: String(err?.message ?? err).slice(0, 300) });
  }
}
