// Reconciliation, disputes and gateway routing — the tables (migration 0017).
//
// ─────────────────────────────────────────────────────────────────────────────
// THE QUESTION THIS DOMAIN EXISTS TO ANSWER
// ─────────────────────────────────────────────────────────────────────────────
//
// Commerce answers "did we charge for this, and did we issue something for it?"
// It cannot answer "is the money actually there?" Those are different questions
// and only one of them is answered by the federation's own records: a system
// that reconciles its payments against its own orders will agree with itself
// perfectly while the bank balance is short.
//
// So the authority here is the GATEWAY'S record, imported as data with its
// provenance attached, and reconciliation is the act of comparing two
// independent accounts of the same money. Anything that does not match is an
// exception with a name, a task and somebody's initials against it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE IS NOT RE-EXPORTED FROM schema.ts
// ─────────────────────────────────────────────────────────────────────────────
//
// src/db/operations.schema.ts — 27 tables — sets the precedent, and it is the
// right one for a domain this size. `import * as s from './schema'` stays the
// entry point for the federation core and commerce; a module that needs
// reconciliation asks for it by name:
//
//     import * as r from './reconciliation.schema';
//
// which also makes it obvious at every call site whether a query is touching
// the money spine or the reconciliation record of it. drizzle-kit never reads
// this file — every migration since 0004 is hand-written, for the reason set
// out at the top of 0007.

import {
  pgTable, serial, text, integer, bigint, timestamp, date, boolean,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { orders, payments, refunds, settlements } from './commerce.schema';
import { users } from './schema';
import { tasks } from './operations.schema';

// ─── Enums ──────────────────────────────────────────────────────────────────

/**
 * The intent to take a specific amount, once.
 *
 *   open ─▶ succeeded          exactly one attempt succeeded
 *        ├▶ failed             every attempt failed and nobody is retrying
 *        ├▶ cancelled          abandoned deliberately
 *        └▶ expired            the checkout window closed
 */
export const paymentIntentStatus = pgEnum('payment_intent_status', [
  'open', 'succeeded', 'failed', 'cancelled', 'expired',
]);

/**
 * What became of ONE try, on ONE gateway.
 *
 * `abandoned` is deliberately distinct from `failed`. A failure is the
 * gateway's answer; an abandonment is the absence of one — the customer closed
 * the tab. Collapsing them would make the gateway's failure rate look worse
 * than it is, and a routing rule that reads failure rates would then move money
 * away from a gateway that did nothing wrong.
 */
export const paymentAttemptOutcome = pgEnum('payment_attempt_outcome', [
  'initiated', 'pending', 'succeeded', 'failed', 'abandoned', 'cancelled',
]);

/** A taxonomy, not a lifecycle: what KIND of movement the gateway reported. */
export const gatewayTransactionKind = pgEnum('gateway_transaction_kind', [
  'payment', 'refund', 'chargeback', 'chargeback_reversal', 'adjustment', 'fee', 'payout',
]);

export const reconciliationRunStatus = pgEnum('reconciliation_run_status', [
  'pending', 'running', 'completed', 'failed', 'cancelled',
]);

/**
 * The nine classifications, and what each one actually means.
 *
 * Eight of the nine are exceptions. Every one of them raises a task, because a
 * reconciliation difference nobody is told about is indistinguishable from no
 * difference at all — right up to the quarter-end when it is a hole.
 *
 *   matched             both sides agree on identity, amount and currency.
 *   missing_in_mmakf    THE WORST ONE. The gateway took money and MMAKF has no
 *                       payment record for it. Somebody was charged for
 *                       something the federation does not know it sold.
 *   missing_at_gateway  MMAKF recorded a capture the gateway's statement does
 *                       not carry. Either the import is incomplete or a
 *                       payment was marked captured on evidence that was not
 *                       the gateway's.
 *   duplicate           two gateway transactions for one merchant reference —
 *                       a customer charged twice for one purchase.
 *   amount_mismatch     matched by identity, disagreeing on the figure.
 *   currency_mismatch   matched by identity, disagreeing on the currency. Kept
 *                       separate from amount_mismatch because the amounts are
 *                       then not comparable at all, and a variance computed
 *                       across them would be arithmetic on two different units.
 *   unsettled           captured and matched, but the gateway has not paid it
 *                       out beyond the period the federation configured. Never
 *                       raised unless that period was configured — see the note
 *                       on reconciliationRuns.unsettledAfterDays.
 *   refunded            the gateway shows money going back that MMAKF's refund
 *                       records do not account for.
 *   disputed            the money is being claimed back. Carries the dispute.
 */
export const reconciliationStatus = pgEnum('reconciliation_status', [
  'matched', 'missing_in_mmakf', 'missing_at_gateway', 'duplicate',
  'amount_mismatch', 'currency_mismatch', 'unsettled', 'refunded', 'disputed',
]);

export const disputeKind = pgEnum('dispute_kind', [
  'chargeback', 'retrieval_request', 'pre_arbitration', 'arbitration', 'fraud_report', 'complaint',
]);

/**
 * A dispute's lifecycle.
 *
 * `expired` is the one that costs money: the evidence window closed with
 * nothing submitted, so the claim succeeds by default. src/lib/status.ts tones
 * it `bad` under the `dispute` domain for exactly that reason — the dictionary's
 * general meaning ("passed its own deadline without a decision") is far too
 * mild for a defence nobody filed.
 */
export const disputeStatus = pgEnum('dispute_status', [
  'open', 'evidence_required', 'evidence_submitted', 'under_review',
  'won', 'lost', 'accepted', 'expired', 'cancelled',
]);

/**
 * Observed health. There is deliberately no `not_configured` member.
 *
 * Whether a gateway has credentials is read from the environment at the moment
 * of asking (src/lib/payments), never stored: a stored copy goes stale the day
 * somebody sets the key, and a stale "not configured" would route money away
 * from a gateway that works. `gatewayReadiness()` in reconciliation.ts is where
 * the stored observation and the live configuration check are combined.
 */
export const gatewayHealthStatus = pgEnum('gateway_health_status', [
  'unknown', 'healthy', 'degraded', 'down',
]);

// ─── Intents and attempts ───────────────────────────────────────────────────

/**
 * ONE intent per order: "this much money is to be taken, once."
 *
 * The existing `payments` table cannot carry this guarantee, because it means
 * two things at once — its own comment calls a row "a payment ATTEMPT" while
 * src/db/orders.ts treats one row as THE payment for an order. A table that
 * means two things cannot constrain either.
 *
 * The live-order unique index (migration 0017) is what stops a second checkout
 * beginning against an order that is already paid or already has one open.
 */
export const paymentIntents = pgTable('payment_intents', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                       // MMAKF-PIN-2026-000001
  orderId: integer('order_id').notNull().references(() => orders.id),

  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull().default('INR'),
  status: paymentIntentStatus('status').notNull().default('open'),

  /** The one payment this intent produced, once something actually succeeded. */
  paymentId: integer('payment_id').references(() => payments.id),

  // Routing inputs that belong to the buyer rather than to any one attempt, so
  // a retry on a second gateway is routed on the same facts as the first.
  customerType: text('customer_type'),
  country: text('country'),

  idempotencyKey: text('idempotency_key'),
  openedByUserId: integer('opened_by_user_id').references(() => users.id),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedReason: text('closed_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('payment_intents_ref_uk').on(t.ref),
  statusIdx: index('payment_intents_status_idx').on(t.status, t.createdAt),
}));

/**
 * MANY attempts per intent, at most ONE of them successful.
 *
 * That last clause is a partial unique index in migration 0017
 * (`payment_attempts_one_success_uk`), not a check in application code. The
 * scenario it defends against is precisely the one that beats a check: a
 * gateway-A webhook and a gateway-B webhook arriving in the same instant, each
 * reading "no successful attempt yet" before either writes.
 *
 * Gateway cost is recorded here and goes no further. What Razorpay or PayU took
 * from a transaction is MMAKF's cost of doing business; adding it to the
 * customer's price is a decision the federation makes in writing, which is what
 * gatewayCostRates.passToCustomer is for.
 */
export const paymentAttempts = pgTable('payment_attempts', {
  id: serial('id').primaryKey(),
  intentId: integer('intent_id').notNull().references(() => paymentIntents.id),
  attemptNo: integer('attempt_no').notNull(),
  gateway: text('gateway').notNull(),
  outcome: paymentAttemptOutcome('outcome').notNull().default('initiated'),

  // Copied from the intent and re-checked against it on every write. An attempt
  // that could carry its own amount is a client-supplied price with extra steps.
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull(),

  gatewayOrderId: text('gateway_order_id'),
  gatewayPaymentId: text('gateway_payment_id'),
  method: text('method'),

  // What the gateway TOOK. Null means "not reported yet", which is not zero —
  // and the difference matters when reconciling a settlement.
  gatewayFeeMinor: integer('gateway_fee_minor'),
  gatewayTaxMinor: integer('gateway_tax_minor'),

  // Why this attempt went where it went, kept so the question is answered from
  // the record rather than by re-running the router against today's rules.
  routingRuleId: integer('routing_rule_id').references(() => paymentRoutingRules.id),
  routingReason: text('routing_reason'),

  failureCode: text('failure_code'),
  failureReason: text('failure_reason'),
  idempotencyKey: text('idempotency_key'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => ({
  intentIdx: index('payment_attempts_intent_idx').on(t.intentId, t.attemptNo),
  gatewayIdx: index('payment_attempts_gateway_idx').on(t.gateway, t.outcome, t.startedAt),
}));

// ─── What the gateway says happened ─────────────────────────────────────────

/**
 * The gateway's own account of the money, imported rather than derived.
 *
 * `source` is required. A gateway figure with no stated origin is a number
 * somebody typed, and the first thing anybody asks about a reconciliation
 * difference is "where did that number come from?".
 *
 * `gatewayStatus` is the gateway's own word, kept verbatim and deliberately not
 * an enum: every provider has a different vocabulary and mapping it on import
 * destroys the evidence. MMAKF's reading of it is a reconciliation item, which
 * is a separate row that can be argued with.
 */
export const gatewayTransactions = pgTable('gateway_transactions', {
  id: serial('id').primaryKey(),
  gateway: text('gateway').notNull(),
  gatewayTxnId: text('gateway_txn_id').notNull(),
  kind: gatewayTransactionKind('kind').notNull(),
  gatewayStatus: text('gateway_status'),

  gatewayOrderId: text('gateway_order_id'),
  gatewayPaymentId: text('gateway_payment_id'),
  /** Our reference as the gateway holds it — usually the order number. */
  merchantRef: text('merchant_ref'),

  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull(),
  feeMinor: integer('fee_minor'),
  taxMinor: integer('tax_minor'),

  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  settledAt: timestamp('settled_at', { withTimezone: true }),
  settlementRef: text('settlement_ref'),

  source: text('source').notNull(),
  importBatch: text('import_batch'),
  /** The source row, frozen. A re-import must not rewrite the first answer. */
  raw: jsonb('raw'),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uk: uniqueIndex('gateway_transactions_uk').on(t.gateway, t.gatewayTxnId),
  paymentIdx: index('gateway_transactions_payment_idx').on(t.gateway, t.gatewayPaymentId),
  refIdx: index('gateway_transactions_ref_idx').on(t.merchantRef),
  periodIdx: index('gateway_transactions_period_idx').on(t.gateway, t.currency, t.occurredAt),
  settledIdx: index('gateway_transactions_settled_idx').on(t.gateway, t.settledAt),
}));

// ─── Gateway cost, as configuration ─────────────────────────────────────────

/**
 * What a gateway is EXPECTED to take, as configuration with a stated source.
 *
 * No published rate is hard-coded anywhere in this codebase, and this table
 * ships empty. Razorpay's, PayU's and Stripe's rate cards change, and MMAKF's
 * negotiated terms may differ from all three — so an estimate is either
 * computed from a row somebody entered, with the document it came from beside
 * it, or it honestly answers "not configured".
 *
 * `passToCustomer` is off and stays off until `approvedPolicyRef` names the
 * decision that turned it on. Rule 6 of this project's money rules and §18 both
 * land in that one boolean: what the gateway takes is a cost, not a price.
 */
export const gatewayCostRates = pgTable('gateway_cost_rates', {
  id: serial('id').primaryKey(),
  gateway: text('gateway').notNull(),
  /** Null means "any method" — one row, not six, for a flat rate card. */
  method: text('method'),
  currency: text('currency').notNull().default('INR'),

  // Parts-per-million, applied through applyFactor() in src/db/fees.ts, which
  // is the only place in this codebase where a factor multiplies money.
  percentagePpm: integer('percentage_ppm').notNull().default(0),
  fixedMinor: integer('fixed_minor').notNull().default(0),
  taxPpm: integer('tax_ppm').notNull().default(0),

  /** Where the number came from. Required, for the same reason as above. */
  source: text('source').notNull(),

  passToCustomer: boolean('pass_to_customer').notNull().default(false),
  approvedPolicyRef: text('approved_policy_ref'),

  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),
  notes: text('notes'),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  lookupIdx: index('gateway_cost_rates_lookup_idx').on(t.gateway, t.currency, t.effectiveFrom),
}));

// ─── Reconciliation ─────────────────────────────────────────────────────────

/**
 * One run: one gateway, one currency, one period.
 *
 * Scoped to a single currency on purpose. A variance figure that added paise to
 * cents would be arithmetic on two different units, and worse than no figure at
 * all because it looks like one.
 *
 * The totals are `bigint`. A single payment fits in an integer (₹21.47 crore is
 * the ceiling in paise); a year of them does not, and a total that silently
 * wrapped would be the most damaging possible bug in this file.
 */
export const reconciliationRuns = pgTable('reconciliation_runs', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                       // MMAKF-REC-2026-000001
  gateway: text('gateway').notNull(),
  currency: text('currency').notNull().default('INR'),
  periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
  periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
  status: reconciliationRunStatus('status').notNull().default('pending'),

  /**
   * Null means SETTLEMENT AGE WAS NOT CHECKED, and the run says so.
   *
   * MMAKF has published no settlement expectation. A default of "T+2" here
   * would be this codebase deciding a commercial term on the federation's
   * behalf — and then raising exceptions against a deadline nobody agreed to,
   * which is how an exceptions queue becomes noise nobody reads.
   */
  unsettledAfterDays: integer('unsettled_after_days'),

  gatewayCount: integer('gateway_count').notNull().default(0),
  mmakfCount: integer('mmakf_count').notNull().default(0),
  matchedCount: integer('matched_count').notNull().default(0),
  exceptionCount: integer('exception_count').notNull().default(0),

  gatewayTotalMinor: bigint('gateway_total_minor', { mode: 'number' }).notNull().default(0),
  mmakfTotalMinor: bigint('mmakf_total_minor', { mode: 'number' }).notNull().default(0),
  varianceMinor: bigint('variance_minor', { mode: 'number' }).notNull().default(0),

  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  failureReason: text('failure_reason'),
  runByUserId: integer('run_by_user_id').references(() => users.id),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('reconciliation_runs_ref_uk').on(t.ref),
  periodIdx: index('reconciliation_runs_period_idx').on(t.gateway, t.periodStart, t.periodEnd),
}));

/**
 * One row per thing the run looked at.
 *
 * `exceptionKey` identifies the PROBLEM rather than the run, so the same
 * difference seen by Monday's run and Tuesday's run is one problem with one
 * task against it — not two tasks, then three, until finance stops reading the
 * queue. It is the reason a run is safe to repeat.
 */
export const reconciliationItems = pgTable('reconciliation_items', {
  id: serial('id').primaryKey(),
  runId: integer('run_id').notNull().references(() => reconciliationRuns.id),
  status: reconciliationStatus('status').notNull(),
  exceptionKey: text('exception_key'),

  gatewayTransactionId: integer('gateway_transaction_id').references(() => gatewayTransactions.id),
  paymentId: integer('payment_id').references(() => payments.id),
  orderId: integer('order_id').references(() => orders.id),
  settlementId: integer('settlement_id').references(() => settlements.id),
  refundId: integer('refund_id').references(() => refunds.id),
  disputeId: integer('dispute_id').references(() => disputes.id),

  gatewayAmountMinor: integer('gateway_amount_minor'),
  mmakfAmountMinor: integer('mmakf_amount_minor'),
  varianceMinor: integer('variance_minor'),
  gatewayCurrency: text('gateway_currency'),
  mmakfCurrency: text('mmakf_currency'),

  /** The sentence a finance officer reads, written when it is classified. */
  detail: text('detail').notNull(),

  /** The alert. Every non-matched item has one; a matched item has none. */
  taskId: integer('task_id').references(() => tasks.id),

  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedByUserId: integer('resolved_by_user_id'),
  resolution: text('resolution'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runIdx: index('reconciliation_items_run_idx').on(t.runId, t.status),
  openIdx: index('reconciliation_items_open_idx').on(t.status, t.resolvedAt),
  keyIdx: index('reconciliation_items_key_idx').on(t.exceptionKey),
}));

// ─── Disputes ───────────────────────────────────────────────────────────────

/**
 * Money being claimed back, and the clock running on the answer.
 *
 * `evidenceDueAt` is the column this table is built around. A chargeback window
 * that passes undefended is money lost by default — not lost after a decision,
 * lost because nobody looked — so the deadline is indexed with the status and
 * is countable in one query. `dueSoon()` and `undefended()` in
 * reconciliation.ts are that query.
 *
 * `evidence` holds REFERENCES to what was submitted, never the documents. File
 * bytes belong in storage; what belongs here is what was sent, when, and by
 * whom, so a lost dispute can be reviewed on the record.
 */
export const disputes = pgTable('disputes', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                       // MMAKF-DSP-2026-000001
  gateway: text('gateway').notNull(),
  gatewayDisputeId: text('gateway_dispute_id'),

  gatewayTransactionId: integer('gateway_transaction_id').references(() => gatewayTransactions.id),
  paymentId: integer('payment_id').references(() => payments.id),
  orderId: integer('order_id').references(() => orders.id),

  kind: disputeKind('kind').notNull().default('chargeback'),
  status: disputeStatus('status').notNull().default('open'),

  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull().default('INR'),
  /** Charged whether or not the dispute is won — hence separate from the risk. */
  gatewayFeeMinor: integer('gateway_fee_minor'),

  reasonCode: text('reason_code'),
  reason: text('reason').notNull(),

  openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
  evidenceDueAt: timestamp('evidence_due_at', { withTimezone: true }),
  evidenceSubmittedAt: timestamp('evidence_submitted_at', { withTimezone: true }),
  evidence: jsonb('evidence'),

  ownerUserId: integer('owner_user_id').references(() => users.id),
  ownerRole: text('owner_role'),

  resolution: text('resolution'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  /**
   * What MMAKF actually kept. Distinct from amountMinor because a partially
   * upheld dispute returns some of it, and a "win" with the gateway's dispute
   * fee deducted is not a whole win.
   */
  outcomeAmountMinor: integer('outcome_amount_minor'),

  taskId: integer('task_id').references(() => tasks.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('disputes_ref_uk').on(t.ref),
  deadlineIdx: index('disputes_deadline_idx').on(t.status, t.evidenceDueAt),
  paymentIdx: index('disputes_payment_idx').on(t.paymentId),
  ownerIdx: index('disputes_owner_idx').on(t.ownerUserId, t.status),
}));

// ─── Routing ────────────────────────────────────────────────────────────────

/**
 * Which gateway should take this payment.
 *
 * Every criterion is NULL-MEANS-ANY, so a rule states only what it cares
 * about. Rules are evaluated by `priority` ascending and `id` ascending, which
 * makes the order TOTAL — two evaluations of the same inputs against the same
 * rule set cannot disagree, and a routing decision that is not reproducible
 * cannot be defended when somebody asks why a payment went where it did.
 *
 * A rule expresses a PREFERENCE and never a guarantee. A gateway with no
 * credentials configured is not a candidate whatever the rules say, and the
 * router answers "nothing configured" rather than naming a gateway that cannot
 * take the money.
 */
export const paymentRoutingRules = pgTable('payment_routing_rules', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),
  label: text('label').notNull(),
  priority: integer('priority').notNull().default(100),
  active: boolean('active').notNull().default(true),

  currency: text('currency'),
  country: text('country'),
  method: text('method'),
  customerType: text('customer_type'),
  /** Inclusive lower bound, EXCLUSIVE upper bound — so bands cannot overlap. */
  minAmountMinor: integer('min_amount_minor'),
  maxAmountMinor: integer('max_amount_minor'),

  gateway: text('gateway').notNull(),
  fallbackGateway: text('fallback_gateway'),
  /** When true, a gateway observed `down` is skipped for the fallback. */
  requireHealthy: boolean('require_healthy').notNull().default(true),

  notes: text('notes'),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('payment_routing_rules_code_uk').on(t.code),
  orderIdx: index('payment_routing_rules_order_idx').on(t.active, t.priority, t.id),
}));

/**
 * Observed gateway behaviour. One row per gateway.
 *
 * These are OBSERVATIONS, not configuration: they record what happened when
 * MMAKF last spoke to the gateway. Whether the gateway is usable at all is a
 * separate question answered from the environment, and `gatewayReadiness()`
 * combines the two.
 */
export const gatewayHealth = pgTable('gateway_health', {
  id: serial('id').primaryKey(),
  gateway: text('gateway').notNull(),
  status: gatewayHealthStatus('status').notNull().default('unknown'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  successCount: integer('success_count').notNull().default(0),
  failureCount: integer('failure_count').notNull().default(0),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  /** Scrubbed by the caller. A credential must never reach this column. */
  lastError: text('last_error'),
  degradedSince: timestamp('degraded_since', { withTimezone: true }),
  note: text('note'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  gatewayUk: uniqueIndex('gateway_health_gateway_uk').on(t.gateway),
}));
