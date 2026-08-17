// Entitlements — what a verified payment actually bought (migration 0019).
//
// The commerce tables answer "was this paid for?". These answer the question
// the payer cares about: "so what did I get?" Until this table existed the
// answer was nothing at all — money was captured, reconciled, posted to the
// ledger and receipted, and no membership, entry or booking followed it.
//
// Design rules enforced here and in drizzle/0019_entitlements.sql:
//  · ONE ROW PER PAID ORDER LINE, unique in the database. That index IS the
//    replay guard; a webhook retry and the reconcile cron arriving together
//    cannot both issue a membership because only one of them can hold the row.
//  · payment_id IS NOT NULL. An entitlement without a server-verified payment
//    behind it is precisely the thing this module exists to make impossible.
//  · NOTHING IS DELETED. A refund revokes, with a timestamp, a reason and the
//    refund that caused it. The history is the point.
//  · 'blocked' IS AN OUTCOME. Money arrives before eligibility is re-checked,
//    so an entitlement that cannot be activated is RECORDED as unactivated with
//    a reason, never silently dropped and never forced through.

import {
  pgTable, serial, text, integer, timestamp, boolean,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orders, orderLines, payments, invoices, refunds } from './commerce.schema';

// The membership_category enum is DECLARED in schema.ts, which re-exports this
// file — importing the value back out of it would close a module cycle around a
// non-lazy binding. Table references (`() => orders.id`) survive a cycle because
// they are closures; a bare enum value does not. This names the SAME Postgres
// type, created once by migration 0000 and never a second time: nothing here
// creates it, and the column below simply says which type it is.
const membershipCategory = pgEnum('membership_category', ['athlete', 'instructor', 'dojo', 'official']);

/** What kind of thing an entitlement activates. */
export const entitlementSubject = pgEnum('entitlement_subject', [
  'membership', 'event_entry', 'grading', 'booking', 'course', 'certificate', 'document',
]);

/**
 * Three states, and the middle one is the reason this is not a boolean.
 *
 *   active  — the thing was issued, and `subject_id` names it.
 *   blocked — money was taken and the thing could NOT be issued. The row says
 *             why, so the finance desk can refund it rather than discovering it
 *             when the payer writes in.
 *   revoked — it was issued and has since been reversed, with the refund that
 *             reversed it. The record stays; a credential that merely vanished
 *             would be indistinguishable from one that never existed.
 */
export const entitlementStatus = pgEnum('entitlement_status', ['active', 'blocked', 'revoked']);

/**
 * What a fee entitles the payer to — the federation's decision, not this
 * system's inference.
 *
 * The fee schedule says what a membership COSTS. It has never said what it
 * BUYS. Reading a category and a term out of the fee CODE would be this system
 * setting MMAKF's membership policy by string match, and it would do it
 * silently. Where no row here matches the fee code, a captured payment produces
 * a BLOCKED entitlement naming exactly what is unconfigured — the same rule the
 * fee schedule itself follows when a fee is unpublished.
 */
export const entitlementTerms = pgTable('entitlement_terms', {
  id: serial('id').primaryKey(),
  /** The fee_schedule code this rule speaks for — membership.athlete.annual. */
  feeCode: text('fee_code').notNull(),
  subject: entitlementSubject('subject').notNull(),
  /** Required for membership subjects: which register the payer joins. */
  membershipCategory: membershipCategory('membership_category'),
  /** Length of the term in whole months. Null means not configured. */
  termMonths: integer('term_months'),
  /**
   * TRUE means the federation has decided this entitlement has no expiry.
   * Distinct from `termMonths` being null, which means nobody has decided yet —
   * see src/db/membership.ts on why "no expiry recorded" is not "forgotten".
   */
  openEnded: boolean('open_ended').notNull().default(false),
  notes: text('notes'),
  /** The authority that set it, in the federation's own words. */
  approvedBy: text('approved_by'),
  setByUserId: integer('set_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  feeCodeUk: uniqueIndex('entitlement_terms_fee_code_uk').on(t.feeCode),
}));

export const entitlements = pgTable('entitlements', {
  id: serial('id').primaryKey(),
  subject: entitlementSubject('subject').notNull(),
  /** Null while blocked — no thing was issued, and inventing an id would lie. */
  subjectId: integer('subject_id'),

  orderId: integer('order_id').notNull().references(() => orders.id),
  /** The line that was paid for. UNIQUE — this is the idempotency guarantee. */
  orderLineId: integer('order_line_id').notNull().references(() => orderLines.id),
  /** NOT NULL by design: no verified payment, no entitlement. Ever. */
  paymentId: integer('payment_id').notNull().references(() => payments.id),
  invoiceId: integer('invoice_id').references(() => invoices.id),

  /** Which published fee priced this, recorded verbatim at activation. */
  feeVersion: text('fee_version'),

  status: entitlementStatus('status').notNull().default('active'),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  /** Who the system was acting AS. A webhook at 3am has no human behind it. */
  activatedBy: text('activated_by'),
  activatedByUserId: integer('activated_by_user_id'),

  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  refundId: integer('refund_id').references(() => refunds.id),
  /** Why it is blocked, or why it was revoked. Both are refusals; both need one. */
  reason: text('reason'),
  /** Frozen evidence — the checks that were run and what they saw. */
  detail: jsonb('detail'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orderLineUk: uniqueIndex('entitlements_order_line_uk').on(t.orderLineId),
  // One LIVE claim per subject: a second order cannot clear an entry that is
  // already cleared. Partial, so revoked history and blocked rows (which have
  // no subject at all) never collide.
  subjectActiveUk: uniqueIndex('entitlements_subject_active_uk')
    .on(t.subject, t.subjectId)
    .where(sql`status = 'active' and subject_id is not null`),
  orderIdx: index('entitlements_order_idx').on(t.orderId),
  paymentIdx: index('entitlements_payment_idx').on(t.paymentId),
  statusIdx: index('entitlements_status_idx').on(t.status, t.subject),
}));
