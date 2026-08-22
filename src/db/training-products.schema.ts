// The training product — what a student actually buys (migration 0045).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THIS FILE EXISTS TO MAKE STRUCTURAL
// ─────────────────────────────────────────────────────────────────────────────
//
// A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT. They pay for
// TRAINING. There is no student subscription in this schema, no junior
// membership, no registration fee, no platform fee and no account fee — and
// there is no column anywhere below that could hold one.
//
// The federation's registers (`memberships`) remain a SEPARATE DOMAIN for
// coaches, officials, examiners and clubs. Not one table here carries a foreign
// key to `memberships`, and not one query in src/db/training-products.ts reads
// it. That absence is the enforcement: a future author cannot write "if
// membership unpaid then deny training" against a join that does not exist.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A PRODUCT CARRIES NO PRICE, AND AN ENTITLEMENT CARRIES A PRICE VERSION
// ─────────────────────────────────────────────────────────────────────────────
//
// `training_products` has no amount column. Not `price_minor`, not `from_minor`,
// not an indicative range. A product row is ONE ROW and one row holds ONE value,
// so a 2027 price change on it would silently rewrite what a 2026 invoice says
// it charged. The amount lives where amounts live in this codebase: in
// `fee_rules` inside a versioned, immutable `fee_frameworks` row, reached
// through `training_products.fee_code`.
//
// The mirror of that is `training_entitlements`, which records the FRAMEWORK
// VERSION it was bought under — id, code and version number, frozen at grant
// time, alongside the amount actually taken. That is what makes a charge
// defensible four years later: the entitlement names the rulebook edition that
// produced it, and that edition can never change.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHY THE COMMERCIAL OBJECT IS NOT CALLED A SUBSCRIPTION
// ─────────────────────────────────────────────────────────────────────────────
//
// The federation was explicit. A person buys a TRAINING PLAN; the plan produces
// a TRAINING ENTITLEMENT for a stated period; a recurring plan produces the
// next one as a TRAINING RENEWAL. The words matter because a person has to be
// able to read their own invoice and know what they bought — "MMAKF
// subscription" tells them nothing and, worse, reads as a membership fee, which
// is the exact thing the federation withdrew.
//
// ─────────────────────────────────────────────────────────────────────────────
// EXPIRY DELETES NOTHING
// ─────────────────────────────────────────────────────────────────────────────
//
// There is no delete path in this schema and no `ON DELETE CASCADE` in its
// migration. An entitlement that lapses keeps its row, its dates, its payment
// and its price version. Attendance, grades and certificates hang off `persons`
// and are untouched by any of it. THE RECORD OF HAVING TRAINED OUTLIVES THE
// RIGHT TO TRAIN, and the only way to guarantee that is for the expiry path to
// have nothing to delete with.

import {
  pgTable, serial, text, integer, timestamp, date, jsonb, pgEnum,
  uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { persons, dojos, users } from './schema';
// Enum VALUES are imported from the modules that declare them, never from
// './schema'. A table reference is a closure and survives the import cycle that
// re-export creates; a bare enum value does not. See the same note in
// entitlement.schema.ts, which learned it the hard way.
import { services, serviceStatus, quoteVersions, feeFrameworks } from './engagement.schema';
import { orders, orderLines, payments, invoices, refunds } from './commerce.schema';
import { entitlementStatus } from './entitlement.schema';

// ─── Vocabularies ───────────────────────────────────────────────────────────

/**
 * The periods a training plan may run for — the federation's own list.
 *
 * Nine values, and none of them is "subscription". `per_session` is a genuine
 * period of one occurrence, and `custom_institutional` is the negotiated block a
 * school or company agrees in writing, which is why it is the only member whose
 * length this system cannot derive: `validity_days` must be stated on the
 * product for it, and the product cannot be published without one.
 */
export const trainingPeriod = pgEnum('training_period', [
  'monthly', 'quarterly', 'half_yearly', 'annual',
  'per_session', 'camp', 'course', 'intensive', 'custom_institutional',
]);

/**
 * Where a plan stands. `lapsed` is not `cancelled`: a plan whose entitlement ran
 * out is a person the club may reasonably invite back, and a plan somebody
 * cancelled is not. Collapsing them would lose the difference at exactly the
 * moment a club wants it.
 */
export const trainingPlanStatus = pgEnum('training_plan_status', [
  'proposed', 'active', 'lapsed', 'cancelled', 'completed',
]);

/**
 * Whether the plan is expected to produce another entitlement when this one
 * ends. NOT an auto-charge flag — nothing in this system takes money without a
 * fresh server-verified payment. It records the person's stated intention, which
 * is what a renewal notice is addressed on.
 */
export const trainingRenewalMode = pgEnum('training_renewal_mode', ['one_off', 'renewing']);

/**
 * A person's standing on a club's roll.
 *
 * `transferred` exists so a move can be read in both directions years later: the
 * old row says where they went, the new row says where they came from, and
 * NEITHER row is deleted. A transfer that overwrote the club id would answer
 * "which club is this student at" and destroy "which club were they at in 2026",
 * which is the question a grading panel actually asks.
 */
export const trainingEnrolmentStatus = pgEnum('training_enrolment_status', [
  'active', 'transferred', 'ended',
]);

// ─── The product ────────────────────────────────────────────────────────────

/**
 * One thing a student can buy: training, of a stated kind, for a stated period.
 *
 * Every discriminator the federation actually uses is a column, because every
 * one of them changes what is delivered and therefore what the fee engine has to
 * be told: discipline, programme, age group, skill level, club, location, coach
 * category, frequency, duration, capacity, validity.
 *
 * `discipline`, `programme`, `skill_level` and `coach_category` are TEXT and not
 * enums, deliberately. MMAKF has published no closed ladder for any of the four
 * — the clubs directory already records discipline and level as the federation's
 * own words — and minting an enum here would be this system inventing the
 * federation's taxonomy, which is the same class of mistake as inventing a fee.
 * `discipline` is stored normalised (lower case, single-spaced) by
 * src/db/training-products.ts so that an access check comparing it is comparing
 * a value and not a typist's spacing.
 *
 * `venue_id` is an integer with its foreign key declared ONLY IN SQL. `venues`
 * lives in operations.schema.ts, which is not re-exported from schema.ts, and
 * importing it here would drag the whole operations graph into the single
 * schema entry point. commerce.schema.ts already uses this device for
 * order_lines → seller_orders and names it there.
 */
export const trainingProducts = pgTable('training_products', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                   // MMAKF-TRN-SHOTOKAN-JUNIOR-MONTHLY
  slug: text('slug').notNull(),                   // shotokan-junior-monthly
  title: text('title').notNull(),

  /** Normalised. Karate-do, Shotokan, kobudo — the federation's own words. */
  discipline: text('discipline').notNull(),
  /** The programme this product belongs to, in the federation's own words. */
  programme: text('programme').notNull(),
  /** The delivery record, where one exists. Most products have none. */
  serviceId: integer('service_id').references(() => services.id),

  /** The federation's label, e.g. "Juniors (7–12)". Free text on purpose. */
  ageGroupLabel: text('age_group_label'),
  /** The numeric band, for eligibility. Null means the product states none. */
  ageMinYears: integer('age_min_years'),
  ageMaxYears: integer('age_max_years'),
  skillLevel: text('skill_level'),

  /** Null means offered federation-wide rather than at one club. */
  clubId: integer('club_id').references(() => dojos.id),
  /** FK to `venues` declared in SQL only — see the note above. */
  venueId: integer('venue_id'),
  coachCategory: text('coach_category'),

  period: trainingPeriod('period').notNull(),
  /** How often training happens. Null means the product does not state it. */
  sessionsPerPeriod: integer('sessions_per_period'),
  /** One session's length. Null means the product does not state it. */
  sessionDurationMinutes: integer('session_duration_minutes'),
  /**
   * How long the entitlement lasts, in days.
   *
   * REQUIRED for the periods this system cannot derive — per_session, camp,
   * course, intensive and custom_institutional — and refused for the calendar
   * periods, which derive exactly (monthly = 1 month, annual = 12). Both halves
   * are enforced by a CHECK in migration 0045 rather than only in code, because
   * a camp with no validity is a product that can be sold and cannot be
   * delivered, and a default of thirty days would be MMAKF policy set by a
   * constant.
   */
  validityDays: integer('validity_days'),
  /** Places available. Null means the product does not cap it. */
  capacity: integer('capacity'),

  /**
   * THE ONLY THING ON THIS ROW THAT TOUCHES MONEY, AND IT IS NOT AN AMOUNT.
   *
   * A code the fee engine prices — the same string `fee_catalogue_entries.code`
   * carries and `fee_rules` matches on. It says WHICH rule applies. It never
   * says what the rule costs, and it cannot: the amount is in a versioned
   * framework that this row has no column for.
   */
  feeCode: text('fee_code').notNull(),

  status: serviceStatus('status').notNull().default('draft'),
  summary: text('summary'),
  description: text('description'),
  notes: text('notes'),

  sortOrder: integer('sort_order').notNull().default(100),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedByUserId: integer('published_by_user_id').references(() => users.id),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  withdrawnReason: text('withdrawn_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('training_products_code_uk').on(t.code),
  slugUk: uniqueIndex('training_products_slug_uk').on(t.slug),
  statusIdx: index('training_products_status_idx').on(t.status, t.discipline),
  clubIdx: index('training_products_club_idx').on(t.clubId, t.status),
  feeCodeIdx: index('training_products_fee_code_idx').on(t.feeCode),
}));

// ─── The plan ───────────────────────────────────────────────────────────────

/**
 * What a person committed to — the commercial object, and NOT a subscription.
 *
 * It exists before any money moves, which is why it is a table and not a derived
 * view over entitlements: a club enrols a student, agrees a plan, and the
 * quotation and payment follow. A model that only had entitlements could not
 * represent the fortnight in between, and would have to invent an entitlement
 * with no payment behind it to do so.
 *
 * `period` and `discipline` are COPIED from the product at the moment the plan
 * is opened. A product edited in 2027 must not re-describe what somebody agreed
 * to in 2026.
 */
export const trainingPlans = pgTable('training_plans', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                     // MMAKF-TPL-2026-000001
  personId: integer('person_id').notNull().references(() => persons.id),
  productId: integer('product_id').notNull().references(() => trainingProducts.id),
  /**
   * Where this plan is trained. Null where the product is federation-wide and
   * no club has been chosen yet — never a placeholder club id.
   */
  clubId: integer('club_id').references(() => dojos.id),

  status: trainingPlanStatus('status').notNull().default('proposed'),
  /** Frozen from the product. See the note above. */
  period: trainingPeriod('period').notNull(),
  renewalMode: trainingRenewalMode('renewal_mode').notNull().default('one_off'),

  startsOn: date('starts_on').notNull(),
  /** Set when the plan stops producing entitlements. Null while it is live. */
  endsOn: date('ends_on'),
  endedReason: text('ended_reason'),

  openedByUserId: integer('opened_by_user_id').references(() => users.id),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('training_plans_ref_uk').on(t.ref),
  // ONE LIVE PLAN PER PERSON PER PRODUCT PER CLUB. Partial, so the history of
  // lapsed and cancelled plans sits under the same index without colliding, and
  // so a person may hold live plans at SEVERAL clubs at once — which they may,
  // and which a unique key on (person, product) alone would have forbidden.
  livePlanUk: uniqueIndex('training_plans_live_uk')
    .on(t.personId, t.productId, sql`coalesce(club_id, 0)`)
    .where(sql`status in ('proposed', 'active')`),
  personIdx: index('training_plans_person_idx').on(t.personId, t.status),
  productIdx: index('training_plans_product_idx').on(t.productId, t.status),
}));

// ─── The entitlement — the only thing that decides access ───────────────────

/**
 * THE RIGHT TO TRAIN, for an explicit period, bought with an identified payment
 * at an identified price version.
 *
 * Nine facts, and every one of them is here because somebody has to be able to
 * answer a question from this row alone years later:
 *
 *   person, programme, club, location, discipline   what was bought
 *   valid_from / valid_until                        for how long
 *   payment (order, line, payment, invoice)         with what money
 *   price framework id / code / version             under which rulebook
 *
 * `valid_until` is NOT NULL. An open-ended right to train is not a period, and
 * "the period paid for" is the federation's own phrase for what it sells. The
 * programme path in src/db/activation.ts refuses open-ended terms for the same
 * reason; this schema makes the refusal unrepresentable instead.
 *
 * `club_id` is where the training was BOUGHT and is never rewritten.
 * `serviced_by_club_id` is where it is currently being delivered, and only a
 * transfer sets it. Access reads whichever is in force; the record of the
 * original purchase survives untouched, because correcting future delivery is
 * not the same act as editing an accounting record.
 */
export const trainingEntitlements = pgTable('training_entitlements', {
  id: serial('id').primaryKey(),

  planId: integer('plan_id').references(() => trainingPlans.id),
  /**
   * WHO MAY TRAIN. Null only on a `blocked` row where the payment named nobody
   * — an order with no person and no plan behind it, which is a real thing a
   * gateway can deliver and a real thing the finance desk has to see.
   * `training_entitlements_active_ck` requires it on every ACTIVE row, because a
   * right to train that belongs to no named individual is unenforceable at the
   * door and meaningless on a certificate.
   */
  personId: integer('person_id').references(() => persons.id),
  /** Null only on a `blocked` row whose order line named no product this system knows. */
  productId: integer('product_id').references(() => trainingProducts.id),

  /**
   * Frozen copies, taken at grant time. A product edited later must not
   * re-describe this purchase — that is rule 3 of this codebase, and a join to
   * `training_products` at read time would break it silently.
   */
  discipline: text('discipline'),
  programme: text('programme'),

  /** Where it was bought. Immutable. */
  clubId: integer('club_id').references(() => dojos.id),
  /** Where it is currently delivered, after a transfer. Null means: at `club_id`. */
  servicedByClubId: integer('serviced_by_club_id').references(() => dojos.id),
  /** FK to `venues` declared in SQL only, as on the product. */
  venueId: integer('venue_id'),

  /**
   * The period paid for. Null ONLY on a `blocked` row, where nothing was
   * granted and inventing a period would be a lie about what the money bought.
   *
   * `training_entitlements_active_ck` in migration 0045 enforces the other
   * direction: an ACTIVE row must hold both dates and a price version. So an
   * open-ended right to train is not merely discouraged here — it cannot be
   * stored. "The period paid for" is the federation's own phrase, and a
   * training entitlement with no end date grants the mat for ever on the
   * strength of one payment.
   */
  validFrom: date('valid_from'),
  /** Inclusive last day. See the note above. */
  validUntil: date('valid_until'),

  /**
   * 'blocked' is an outcome, not an exception.
   *
   * Money arrives before this system can check that the federation has stated a
   * period and published a price version. Where it has not, the row is written
   * with a REASON and grants nothing, the money stays taken, and the finance
   * desk sees it in `blockedTraining()`. The two unacceptable answers are
   * granting anyway and recording nothing.
   */
  status: entitlementStatus('status').notNull().default('active'),

  // ── The money that bought it ────────────────────────────────────────────
  orderId: integer('order_id').notNull().references(() => orders.id),
  /** UNIQUE. This index IS the idempotency guarantee — see the module header. */
  orderLineId: integer('order_line_id').notNull().references(() => orderLines.id),
  /** NOT NULL by design: no server-verified payment, no right to train. */
  paymentId: integer('payment_id').notNull().references(() => payments.id),
  invoiceId: integer('invoice_id').references(() => invoices.id),

  // ── The price version ───────────────────────────────────────────────────
  //
  // All three, and all three frozen. The id joins, the code reads, and the
  // version number is the one a person recognises on a document. A published
  // framework can never be altered, so this triple is a permanent, reproducible
  // description of how the amount below was arrived at — THE COLUMN THAT MAKES
  // A HISTORICAL CHARGE DEFENSIBLE YEARS LATER.
  //
  // Nullable for the same reason the dates are: a `blocked` row records that
  // money arrived and nothing was granted, and the commonest cause of that is
  // precisely that MMAKF has published no framework to record. Required on an
  // ACTIVE row by `training_entitlements_active_ck`.
  priceFrameworkId: integer('price_framework_id').references(() => feeFrameworks.id),
  priceFrameworkCode: text('price_framework_code'),
  priceFrameworkVersion: integer('price_framework_version'),
  /** The quotation this was sold from, where it was sold from one. */
  quoteVersionId: integer('quote_version_id').references(() => quoteVersions.id),
  /**
   * WHAT WAS ACTUALLY CHARGED, in integer paise. A HISTORICAL FACT, not a price.
   *
   * It is not a price list and it is never read to decide what anything costs —
   * `computeFee()` does that, from the framework. It is here so the record can
   * be reconciled against the ledger and defended without re-running anything,
   * and so a future correction to pricing provably did not touch it.
   */
  amountPaidMinor: integer('amount_paid_minor').notNull(),
  currency: text('currency').notNull().default('INR'),

  // ── Renewal, as a chain rather than a flag ──────────────────────────────
  renewedFromEntitlementId: integer('renewed_from_entitlement_id'),
  /** 1 for the first term, 2 for its first renewal, and so on. */
  renewalSequence: integer('renewal_sequence').notNull().default(1),

  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  /** Who the system was acting AS. A webhook at 3am has no human behind it. */
  grantedBy: text('granted_by'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  refundId: integer('refund_id').references(() => refunds.id),
  /** Why it is blocked, or why it was revoked. Both are refusals; both need one. */
  reason: text('reason'),
  /** Frozen evidence — what was checked and what it saw. */
  detail: jsonb('detail'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // THE REPLAY GUARD. One entitlement per paid order line, enforced by the
  // database and not by SELECT-then-INSERT: two webhooks arriving in the same
  // millisecond both read "no entitlement yet", and only one can hold this row.
  orderLineUk: uniqueIndex('training_entitlements_order_line_uk').on(t.orderLineId),
  // A renewal is claimed by exactly one successor. NULLs are distinct in a
  // unique index, so every first term sits under it without colliding.
  renewalChainUk: uniqueIndex('training_entitlements_renewal_chain_uk')
    .on(t.renewedFromEntitlementId),
  // THE ACCESS QUERY'S INDEX. Every check asks "which live entitlements cover
  // this person today", and that has to be an index lookup rather than a scan —
  // it is the cheapest and by far the most frequent question this system asks.
  accessIdx: index('training_entitlements_access_idx')
    .on(t.personId, t.status, t.validFrom, t.validUntil),
  clubIdx: index('training_entitlements_club_idx').on(t.clubId, t.status),
  servicedIdx: index('training_entitlements_serviced_idx').on(t.servicedByClubId, t.status),
  productIdx: index('training_entitlements_product_idx').on(t.productId, t.status),
  planIdx: index('training_entitlements_plan_idx').on(t.planId),
  paymentIdx: index('training_entitlements_payment_idx').on(t.paymentId),
}));

// ─── The roll ───────────────────────────────────────────────────────────────

/**
 * A person on a club's roll — and a person may be on several.
 *
 * ONE STUDENT IS NOT ONE CLUB FOR EVER. A child trains at their school's club
 * and at a weekend dojo; an adult moves city and keeps a link to the old club
 * for grading. A single `persons.dojo_id` cannot express any of that, and a
 * transfer implemented by overwriting it would erase the fact that they were
 * ever anywhere else.
 *
 * A TRANSFER MOVES THE ENROLMENT AND NEVER DUPLICATES THE PERSON. It closes
 * this row as `transferred`, opens a new one at the receiving club, and links
 * them in both directions. `person_id` is the same integer on both rows — there
 * is no path in src/db/training-products.ts that inserts into `persons`.
 */
export const trainingEnrolments = pgTable('training_enrolments', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  clubId: integer('club_id').notNull().references(() => dojos.id),

  status: trainingEnrolmentStatus('status').notNull().default('active'),
  joinedOn: date('joined_on').notNull(),
  /** Set when the person leaves or transfers away. The row is never deleted. */
  endedOn: date('ended_on'),

  /** The enrolment this one continues, and the one that continues it. */
  transferredFromId: integer('transferred_from_id'),
  transferredToId: integer('transferred_to_id'),
  transferReason: text('transfer_reason'),

  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // One LIVE enrolment per person per club. Partial, so a person who left and
  // came back has two rows and a history, rather than one row and an argument.
  liveUk: uniqueIndex('training_enrolments_live_uk')
    .on(t.personId, t.clubId)
    .where(sql`status = 'active'`),
  // A transfer is claimed by exactly one successor, so two administrators
  // transferring the same student at once cannot both succeed.
  chainUk: uniqueIndex('training_enrolments_chain_uk').on(t.transferredFromId),
  personIdx: index('training_enrolments_person_idx').on(t.personId, t.status),
  clubIdx: index('training_enrolments_club_idx').on(t.clubId, t.status),
}));
