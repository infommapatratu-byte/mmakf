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
  pgTable, serial, text, integer, timestamp, date, boolean,
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

/**
 * What kind of thing an entitlement activates.
 *
 * 'program' was added by migration 0037 — the thing the federation describes in
 * most detail and the only subject here that is a PERIOD rather than an object.
 * A membership is issued and an entry is cleared; a training programme runs from
 * one date to another and carries everything that comes with it for exactly that
 * long. See src/db/activation.ts.
 */
export const entitlementSubject = pgEnum('entitlement_subject', [
  'membership', 'event_entry', 'grading', 'booking', 'course', 'certificate', 'document',
  'program',
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
  /**
   * WHAT ELSE THE FEE INCLUDES — the supporting resources, as records.
   *
   * `[{ kind: 'technical_library' }, { kind: 'course', resourceId: 4 }]`, and
   * nothing else: validated in src/db/activation.ts against a closed
   * vocabulary, at CONFIGURATION time, so a typo is refused rather than
   * silently granting nothing months later.
   *
   * NULL grants NOTHING. That is the safe direction and the honest one: the
   * federation has said which fees include the library, and where it has not
   * said, this system does not decide on its behalf.
   */
  resources: jsonb('resources'),
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

  /**
   * THE PERIOD PAID FOR — both ends of it, on the record (migration 0037).
   *
   * "For that period" is the federation's own phrase for what a programme fee
   * buys, and until 0037 this table had nowhere to put it. Not derived at read
   * time from the fee code: a fee rule edited in 2028 must not re-date what a
   * school bought in 2026.
   *
   * Nullable, and the two nulls mean different things. `valid_from` is null
   * only on rows written before 0037 existed and on blocked rows, where there
   * is no period because nothing was issued. `valid_to` is null there too, and
   * ALSO where the federation has explicitly decided the entitlement does not
   * expire (entitlement_terms.open_ended). Access checks read null valid_to as
   * "no end date recorded", which is why the programme path refuses to activate
   * against an open-ended term at all — see src/db/activation.ts.
   */
  validFrom: date('valid_from'),
  validTo: date('valid_to'),

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
  // Every access check asks "which live entitlements cover today", so the dates
  // are in the index rather than in a filter applied after the rows are read.
  periodIdx: index('entitlements_period_idx').on(t.subject, t.status, t.validFrom, t.validTo),
}));

// ─── What a programme entitlement makes reachable (migration 0037) ──────────

/**
 * The closed vocabulary of supporting resources a fee may include.
 *
 * Every member names something that already exists in this database and that a
 * surface already reads — the technical library (src/db/library.ts), live
 * classes and courses (education.schema.ts). There is deliberately no
 * 'everything' member: a grant this system cannot name is a grant nobody
 * approved, and "all of it" is the direction this class of default always fails
 * in.
 */
export const entitlementResourceKind = pgEnum('entitlement_resource_kind', [
  'technical_library', 'live_classes', 'course', 'course_material',
]);

/**
 * One grant: this entitlement makes this resource reachable, between these
 * dates.
 *
 * A ROW PER GRANT, not a jsonb column on the entitlement. Every access check is
 * a query on (person, resource kind, today) and that has to be an index lookup;
 * a document per row would make the federation's cheapest and most frequent
 * question its most expensive.
 *
 * THE DATES ARE COPIED, not joined from the parent. A grant has to be
 * withdrawable on its own terms — a library licence lapsing part way through a
 * school year ends the library access and not the training the school paid for
 * — and a period that was really the parent's period could not express that.
 *
 * `resourceId` is null exactly for the whole-surface kinds, and the CHECK
 * constraint in migration 0037 enforces the biconditional. A 'course' grant
 * naming no course is not "all courses"; it is a row somebody failed to fill
 * in, and the database refuses it rather than letting it read as generosity.
 */
export const entitlementResources = pgTable('entitlement_resources', {
  id: serial('id').primaryKey(),
  entitlementId: integer('entitlement_id').notNull().references(() => entitlements.id),
  resourceKind: entitlementResourceKind('resource_kind').notNull(),
  resourceId: integer('resource_id'),

  validFrom: date('valid_from').notNull(),
  validTo: date('valid_to'),

  status: entitlementStatus('status').notNull().default('active'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  reason: text('reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // THE REPLAY GUARD FOR GRANTS. coalesce(), because two NULLs are distinct in
  // a unique index and a plain three-column index would happily admit two
  // whole-library grants for the same entitlement.
  grantUk: uniqueIndex('entitlement_resources_uk')
    .on(t.entitlementId, t.resourceKind, sql`coalesce(resource_id, 0)`),
  lookupIdx: index('entitlement_resources_lookup_idx')
    .on(t.resourceKind, t.resourceId, t.status, t.validFrom, t.validTo),
  entitlementIdx: index('entitlement_resources_entitlement_idx').on(t.entitlementId),
}));
