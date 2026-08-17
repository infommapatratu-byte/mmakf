// Reconciliation, disputes and gateway routing.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE QUESTION
// ─────────────────────────────────────────────────────────────────────────────
//
// Reconciliation answers exactly one question: DOES WHAT THE GATEWAY SAYS MATCH
// WHAT MMAKF RECORDED?
//
// That question cannot be answered from the federation's own tables. A system
// that checks its payments against its own orders will agree with itself
// perfectly while the bank balance is short — the whole point is that the two
// accounts are INDEPENDENT. So the gateway's record is imported as data, with
// the document it came from named against every row, and a run compares the two
// and classifies every difference.
//
// ─────────────────────────────────────────────────────────────────────────────
// AN UNRECONCILED ITEM IS AN ALERT, NOT A LOG LINE
// ─────────────────────────────────────────────────────────────────────────────
//
// Every classification that is not MATCHED creates a task for finance, through
// src/db/tasks.ts — the same queue that carries expiring safeguarding
// clearances and unanswered tickets, because a finance officer should not have
// to remember to open a second screen.
//
// Silent reconciliation failure is how money goes missing without anybody
// noticing for a quarter. A report that has to be run by hand, read carefully
// and acted on is a report that is run in January and again in April.
//
// The task is keyed on the EXCEPTION, not on the run, so a daily run does not
// produce a hundred copies of one problem. That property is what makes
// `runReconciliation` safe to schedule.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE THING THAT MUST NOT HAPPEN
// ─────────────────────────────────────────────────────────────────────────────
//
// Routing implies failover, and failover is where double charges are born: a
// card declined at gateway A, retried at gateway B, and A's authorisation
// settling late. The customer is charged twice by a system that did exactly
// what it was told.
//
// Two defences, and neither is a comment:
//
//   1. A PARTIAL UNIQUE INDEX. `payment_attempts_one_success_uk` permits one
//      succeeded attempt per intent. Two racing webhooks cannot both win,
//      because the loser's INSERT is refused by the engine rather than by a
//      check-then-write that reads before either has written.
//
//   2. FAILOVER IS ONLY LEGAL FROM A TERMINAL FAILURE. `startAttempt` refuses
//      while any attempt on the intent is still `initiated` or `pending`. An
//      attempt whose fate is unknown is not a failed attempt, and moving to a
//      second gateway on an unknown is precisely the double charge.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHAT THIS MODULE WILL NOT DO
// ─────────────────────────────────────────────────────────────────────────────
//
// It invents no gateway rate. Razorpay's, PayU's and Stripe's published rates
// change and MMAKF's negotiated terms may differ from all three, so a rate is a
// row in gateway_cost_rates with the document it was read out of, or the
// estimate honestly answers "not configured".
//
// It never adds a gateway's cut to a customer's price. What the gateway took is
// recorded per transaction; passing it on requires `passToCustomer` AND a named
// approved policy, and `surchargeMinor()` returns zero without both.
//
// It ships with no gateway credentials, and says so plainly. "Not configured"
// is today's honest state of the federation, not a fault in the software.

import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import * as s from './schema';
import * as r from './reconciliation.schema';
import { applyFactor, formatINR } from './fees';
import { allocateFederationId, writeAudit, type AuditContext } from './federation';
import { isUniqueViolation } from './pgerror';
import { createTask } from './tasks';
import { assertCanAnywhere, type Principal } from '@/lib/rbac';
import { providerById, providerHasCredentials } from '@/lib/payments';

type DB = any;

export class ReconciliationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReconciliationError';
    this.code = code;
  }
}

/** Identified by shape, not `instanceof` — see the note in src/lib/calendar.ts. */
export function isReconciliationError(err: unknown): err is ReconciliationError {
  return Boolean(err) && typeof err === 'object'
    && (err as any).name === 'ReconciliationError' && typeof (err as any).code === 'string';
}

// ─── Vocabulary ─────────────────────────────────────────────────────────────

export const RECONCILIATION_STATUSES = [
  'matched', 'missing_in_mmakf', 'missing_at_gateway', 'duplicate',
  'amount_mismatch', 'currency_mismatch', 'unsettled', 'refunded', 'disputed',
] as const;
export type ReconciliationClassification = (typeof RECONCILIATION_STATUSES)[number];

/** The eight that are exceptions. `matched` is the only one that is not. */
export const RECONCILIATION_EXCEPTIONS = RECONCILIATION_STATUSES
  .filter((x) => x !== 'matched') as readonly Exclude<ReconciliationClassification, 'matched'>[];

export function isException(status: string): boolean {
  return status !== 'matched' && (RECONCILIATION_STATUSES as readonly string[]).includes(status);
}

/**
 * A dispute is over when one of these is true, and not before.
 *
 * `expired` is in the list and is the expensive one: the window closed with no
 * defence filed, so the claim succeeded by default.
 */
const DISPUTE_TERMINAL = new Set(['won', 'lost', 'accepted', 'expired', 'cancelled']);

/**
 * An attempt whose fate is settled.
 *
 * Only from one of these may a second attempt begin. An attempt that is still
 * `initiated` or `pending` has an unknown fate, and failing over on an unknown
 * is the double charge this module exists to prevent.
 */
const ATTEMPT_TERMINAL = new Set(['succeeded', 'failed', 'abandoned', 'cancelled']);

/**
 * Which way a gateway movement pushes the balance.
 *
 * `payout` is deliberately ZERO. A payout moves money the gateway has already
 * reported taking into the federation's bank account; counting it again would
 * double every settled rupee, which is the single easiest way to make a
 * reconciliation report look wrong when nothing is.
 */
const KIND_SIGN: Record<string, number> = {
  payment: 1,
  chargeback_reversal: 1,
  adjustment: 1,
  refund: -1,
  chargeback: -1,
  fee: -1,
  payout: 0,
};

// ─── Money helpers ──────────────────────────────────────────────────────────

function assertMinor(value: unknown, what: string): number {
  if (!Number.isInteger(value)) {
    throw new ReconciliationError('bad_amount', `${what} must be an integer in minor units.`);
  }
  return value as number;
}

function normaliseCurrency(value: unknown): string {
  const c = String(value ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) {
    throw new ReconciliationError('bad_currency', `"${value}" is not a three-letter currency code.`);
  }
  return c;
}

// ─── Payment intents and attempts ───────────────────────────────────────────

export interface OpenIntentInput {
  orderId: number;
  /** Server-resolved. Compared against the order and never taken on trust. */
  amountMinor: number;
  currency?: string;
  customerType?: string | null;
  country?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Open the intent to take money for an order, once.
 *
 * The amount is COMPARED against the order rather than accepted. A caller that
 * could name its own figure is a client-supplied price with one more function
 * call in front of it, which is the oldest e-commerce attack there is.
 *
 * A second call for an order that already has a live intent does not open a
 * second one — it returns the existing intent. The live-order partial unique
 * index makes that true under concurrency as well as in the happy path.
 */
export async function openIntent(db: DB, input: OpenIntentInput) {
  const order = (await db.select().from(s.orders).where(eq(s.orders.id, input.orderId)).limit(1))[0];
  if (!order) throw new ReconciliationError('unknown_order', `No order ${input.orderId}.`);

  const amount = assertMinor(input.amountMinor, 'The intent amount');
  if (amount !== order.totalPaise) {
    throw new ReconciliationError(
      'amount_mismatch',
      `The intent is for ${formatINR(amount)} and order ${order.orderNo} is for ${formatINR(order.totalPaise)}. ` +
      'The server resolves the amount; it is never taken from the caller.'
    );
  }
  const currency = normaliseCurrency(input.currency ?? order.currency ?? 'INR');
  if (currency !== String(order.currency ?? 'INR').toUpperCase()) {
    throw new ReconciliationError('currency_mismatch',
      `The intent is in ${currency} and order ${order.orderNo} is in ${order.currency}.`);
  }

  const existing = (await db.select().from(r.paymentIntents)
    .where(and(
      eq(r.paymentIntents.orderId, order.id),
      inArray(r.paymentIntents.status, ['open', 'succeeded']),
    )).limit(1))[0];
  if (existing) return existing;

  const ref = await allocateFederationId(db, 'PIN');
  try {
    const [row] = await db.insert(r.paymentIntents).values({
      ref,
      orderId: order.id,
      amountMinor: amount,
      currency,
      status: 'open',
      customerType: input.customerType ?? null,
      country: input.country ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    }).returning();
    return row;
  } catch (err) {
    // The index fired, so somebody else opened one between the read and the
    // write. Adopt theirs: that is the SUCCESS case, not a fault.
    if (isUniqueViolation(err)) {
      const [live] = await db.select().from(r.paymentIntents)
        .where(and(
          eq(r.paymentIntents.orderId, order.id),
          inArray(r.paymentIntents.status, ['open', 'succeeded']),
        )).limit(1);
      if (live) return live;
    }
    throw err;
  }
}

export interface StartAttemptInput {
  intentId: number;
  gateway: string;
  gatewayOrderId?: string | null;
  method?: string | null;
  routingRuleId?: number | null;
  routingReason?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Begin ONE try on ONE gateway.
 *
 * Refused when the intent is not open, and refused while any earlier attempt is
 * still in flight. The second refusal is the failover rule: a payment whose fate
 * is unknown must never be retried elsewhere, because "unknown" resolves to
 * "captured" often enough to matter and the customer is then charged twice.
 */
export async function startAttempt(db: DB, input: StartAttemptInput) {
  const intent = (await db.select().from(r.paymentIntents)
    .where(eq(r.paymentIntents.id, input.intentId)).limit(1))[0];
  if (!intent) throw new ReconciliationError('unknown_intent', `No payment intent ${input.intentId}.`);
  if (intent.status !== 'open') {
    throw new ReconciliationError(
      'intent_closed',
      `Payment intent ${intent.ref} is ${intent.status}. A closed intent takes no further attempts.`
    );
  }

  const gateway = String(input.gateway ?? '').trim();
  if (!gateway) throw new ReconciliationError('no_gateway', 'An attempt must name a gateway.');

  const attempts = await db.select().from(r.paymentAttempts)
    .where(eq(r.paymentAttempts.intentId, intent.id))
    .orderBy(asc(r.paymentAttempts.attemptNo));

  const inFlight = attempts.find((a: any) => !ATTEMPT_TERMINAL.has(a.outcome));
  if (inFlight) {
    throw new ReconciliationError(
      'attempt_in_flight',
      `Attempt ${inFlight.attemptNo} on ${inFlight.gateway} is still ${inFlight.outcome}. ` +
      'A second attempt cannot begin until that one has an answer — failing over from an unknown ' +
      'is how one purchase becomes two charges.'
    );
  }
  if (attempts.some((a: any) => a.outcome === 'succeeded')) {
    throw new ReconciliationError('already_succeeded',
      `Payment intent ${intent.ref} already has a successful attempt.`);
  }

  const [row] = await db.insert(r.paymentAttempts).values({
    intentId: intent.id,
    attemptNo: attempts.length + 1,
    gateway,
    outcome: 'initiated',
    // Copied from the intent, which was itself checked against the order.
    amountMinor: intent.amountMinor,
    currency: intent.currency,
    gatewayOrderId: input.gatewayOrderId ?? null,
    method: input.method ?? null,
    routingRuleId: input.routingRuleId ?? null,
    routingReason: input.routingReason ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  }).returning();
  return row;
}

export interface SettleAttemptInput {
  attemptId: number;
  outcome: 'pending' | 'succeeded' | 'failed' | 'abandoned' | 'cancelled';
  gatewayPaymentId?: string | null;
  /** What the gateway reported taking. Recorded; never added to the price. */
  gatewayFeeMinor?: number | null;
  gatewayTaxMinor?: number | null;
  failureCode?: string | null;
  failureReason?: string | null;
  /** The commerce payment row this attempt produced, if one was created. */
  paymentId?: number | null;
  now?: Date;
}

/**
 * Record what became of an attempt.
 *
 * The success path closes the intent in the same statement chain, and leans on
 * `payment_attempts_one_success_uk` rather than on having checked first. When
 * two workers settle two attempts of one intent as succeeded simultaneously,
 * one of them gets a unique violation from Postgres and is turned into a clear
 * error here. A check-then-write would let both through, and the federation
 * would have taken the money twice with a tidy record saying it had not.
 */
export async function settleAttempt(db: DB, input: SettleAttemptInput) {
  const now = input.now ?? new Date();
  const attempt = (await db.select().from(r.paymentAttempts)
    .where(eq(r.paymentAttempts.id, input.attemptId)).limit(1))[0];
  if (!attempt) throw new ReconciliationError('unknown_attempt', `No payment attempt ${input.attemptId}.`);
  if (ATTEMPT_TERMINAL.has(attempt.outcome)) {
    // Re-delivering the same terminal answer is a replay, and a replay is a
    // success. Contradicting one is not.
    if (attempt.outcome === input.outcome) return attempt;
    throw new ReconciliationError(
      'attempt_settled',
      `Attempt ${attempt.id} is already ${attempt.outcome} and cannot be reported as ${input.outcome}. ` +
      'A settled attempt is evidence, not a draft.'
    );
  }

  const fee = input.gatewayFeeMinor == null ? null : assertMinor(input.gatewayFeeMinor, 'The gateway fee');
  const tax = input.gatewayTaxMinor == null ? null : assertMinor(input.gatewayTaxMinor, 'The gateway tax');

  const patch: Record<string, unknown> = {
    outcome: input.outcome,
    gatewayPaymentId: input.gatewayPaymentId ?? attempt.gatewayPaymentId ?? null,
    gatewayFeeMinor: fee ?? attempt.gatewayFeeMinor ?? null,
    gatewayTaxMinor: tax ?? attempt.gatewayTaxMinor ?? null,
    failureCode: input.failureCode ?? null,
    failureReason: input.failureReason ?? null,
    finishedAt: ATTEMPT_TERMINAL.has(input.outcome) ? now : null,
  };

  try {
    await db.update(r.paymentAttempts).set(patch).where(eq(r.paymentAttempts.id, attempt.id));
  } catch (err) {
    if (isUniqueViolation(err) && input.outcome === 'succeeded') {
      throw new ReconciliationError(
        'double_success',
        `Payment intent ${attempt.intentId} already has a successful attempt, so attempt ` +
        `${attempt.id} on ${attempt.gateway} cannot also succeed. This is the double charge ` +
        'the constraint exists to refuse; the money on this attempt needs refunding, not recording.'
      );
    }
    throw err;
  }

  if (input.outcome === 'succeeded') {
    await db.update(r.paymentIntents).set({
      status: 'succeeded',
      paymentId: input.paymentId ?? null,
      closedAt: now,
      closedReason: `Attempt ${attempt.attemptNo} succeeded on ${attempt.gateway}.`,
      updatedAt: now,
    }).where(eq(r.paymentIntents.id, attempt.intentId));
  }

  return (await db.select().from(r.paymentAttempts)
    .where(eq(r.paymentAttempts.id, attempt.id)).limit(1))[0];
}

/**
 * Close an intent that will not be paid.
 *
 * Deliberately NOT automatic on a failed attempt: a declined card is retried by
 * most people, and an intent closed on the first decline would force a second
 * order to be created for the same purchase.
 */
export async function closeIntent(
  db: DB,
  intentId: number,
  status: 'failed' | 'cancelled' | 'expired',
  reason: string,
  now: Date = new Date()
) {
  const intent = (await db.select().from(r.paymentIntents)
    .where(eq(r.paymentIntents.id, intentId)).limit(1))[0];
  if (!intent) throw new ReconciliationError('unknown_intent', `No payment intent ${intentId}.`);
  if (intent.status === 'succeeded') {
    throw new ReconciliationError('already_succeeded',
      `Payment intent ${intent.ref} succeeded and cannot be closed as ${status}.`);
  }
  if (intent.status !== 'open') return intent;

  const [row] = await db.update(r.paymentIntents)
    .set({ status, closedAt: now, closedReason: reason, updatedAt: now })
    .where(eq(r.paymentIntents.id, intentId)).returning();
  return row;
}

export async function attemptsForIntent(db: DB, intentId: number) {
  return db.select().from(r.paymentAttempts)
    .where(eq(r.paymentAttempts.intentId, intentId))
    .orderBy(asc(r.paymentAttempts.attemptNo));
}

// ─── Importing what the gateway says ────────────────────────────────────────

export interface GatewayTransactionInput {
  gateway: string;
  gatewayTxnId: string;
  kind: 'payment' | 'refund' | 'chargeback' | 'chargeback_reversal' | 'adjustment' | 'fee' | 'payout';
  gatewayStatus?: string | null;
  gatewayOrderId?: string | null;
  gatewayPaymentId?: string | null;
  merchantRef?: string | null;
  amountMinor: number;
  currency: string;
  feeMinor?: number | null;
  taxMinor?: number | null;
  occurredAt: Date;
  settledAt?: Date | null;
  settlementRef?: string | null;
  raw?: unknown;
}

/**
 * Import the gateway's own record.
 *
 * `source` names the document these rows were read out of and is required, not
 * decorative: the first question anybody asks about a reconciliation difference
 * is where the gateway's figure came from, and "the import" is not an answer.
 *
 * Re-importing the same statement is safe and CHANGES NOTHING. A row already
 * present is left exactly as it was — a later import must not rewrite what the
 * gateway said the first time, because that is the evidence.
 */
export async function importGatewayTransactions(
  db: DB,
  ctx: AuditContext,
  input: { gateway: string; source: string; importBatch?: string | null; rows: GatewayTransactionInput[] }
): Promise<{ imported: number; alreadyPresent: number }> {
  assertCanAnywhere(ctx.principal, 'finance:write');

  const source = String(input.source ?? '').trim();
  if (!source) {
    throw new ReconciliationError(
      'no_source',
      'An import must name its source — the settlement report, export or statement these figures ' +
      'were read from. A gateway figure with no stated origin is a number somebody typed.'
    );
  }
  const gateway = String(input.gateway ?? '').trim();
  if (!gateway) throw new ReconciliationError('no_gateway', 'An import must name a gateway.');

  let imported = 0;
  let alreadyPresent = 0;

  for (const row of input.rows ?? []) {
    assertMinor(row.amountMinor, 'A gateway amount');
    const values = {
      gateway,
      gatewayTxnId: String(row.gatewayTxnId),
      kind: row.kind,
      gatewayStatus: row.gatewayStatus ?? null,
      gatewayOrderId: row.gatewayOrderId ?? null,
      gatewayPaymentId: row.gatewayPaymentId ?? null,
      merchantRef: row.merchantRef ?? null,
      amountMinor: row.amountMinor,
      currency: normaliseCurrency(row.currency),
      feeMinor: row.feeMinor ?? null,
      taxMinor: row.taxMinor ?? null,
      occurredAt: row.occurredAt,
      settledAt: row.settledAt ?? null,
      settlementRef: row.settlementRef ?? null,
      source,
      importBatch: input.importBatch ?? null,
      raw: (row.raw ?? null) as any,
    };

    const inserted = await db.insert(r.gatewayTransactions).values(values)
      .onConflictDoNothing({
        target: [r.gatewayTransactions.gateway, r.gatewayTransactions.gatewayTxnId],
      })
      .returning({ id: r.gatewayTransactions.id });

    if (inserted.length) imported++;
    else alreadyPresent++;
  }

  await writeAudit(db, ctx, {
    entityType: 'gateway_import', entityId: null, action: 'create',
    newValue: { gateway, source, imported, alreadyPresent },
  });

  return { imported, alreadyPresent };
}

// ─── Gateway cost, as configuration ─────────────────────────────────────────

export interface CostRateInput {
  gateway: string;
  method?: string | null;
  currency?: string;
  percentagePpm?: number;
  fixedMinor?: number;
  taxPpm?: number;
  /** Required. The rate card, schedule or agreement this was read from. */
  source: string;
  passToCustomer?: boolean;
  approvedPolicyRef?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  notes?: string | null;
}

/**
 * Record what a gateway is expected to take.
 *
 * NOTHING IN THIS CODEBASE SHIPS A GATEWAY RATE. Every published rate card
 * changes, and MMAKF's negotiated terms may differ from the published one, so a
 * figure typed into a source file would be wrong at some unknowable future date
 * with nobody watching. A rate exists because somebody entered it and named
 * where it came from, or it does not exist.
 *
 * Passing the cost to the customer requires BOTH the flag and the reference of
 * the policy that approved it. A flag on its own is somebody clicking a toggle.
 */
export async function upsertCostRate(db: DB, ctx: AuditContext, input: CostRateInput) {
  assertCanAnywhere(ctx.principal, 'finance:write');

  const source = String(input.source ?? '').trim();
  if (!source) {
    throw new ReconciliationError('no_source',
      'A gateway cost rate must name its source — the rate card or signed schedule it came from.');
  }
  const percentagePpm = input.percentagePpm ?? 0;
  const fixedMinor = input.fixedMinor ?? 0;
  const taxPpm = input.taxPpm ?? 0;
  if (!Number.isInteger(percentagePpm) || percentagePpm < 0) {
    throw new ReconciliationError('bad_factor', 'A gateway percentage must be integer parts-per-million.');
  }
  if (!Number.isInteger(taxPpm) || taxPpm < 0) {
    throw new ReconciliationError('bad_factor', 'A gateway tax rate must be integer parts-per-million.');
  }
  assertMinor(fixedMinor, 'The fixed component');

  const passToCustomer = input.passToCustomer === true;
  const approvedPolicyRef = input.approvedPolicyRef?.trim() || null;
  if (passToCustomer && !approvedPolicyRef) {
    throw new ReconciliationError(
      'no_policy',
      'Passing a gateway cost to the payer changes what MMAKF charges, so it needs the reference ' +
      'of the approved policy that permits it. Without one, the cost stays MMAKF\'s.'
    );
  }

  const [row] = await db.insert(r.gatewayCostRates).values({
    gateway: String(input.gateway).trim(),
    method: input.method ?? null,
    currency: normaliseCurrency(input.currency ?? 'INR'),
    percentagePpm,
    fixedMinor,
    taxPpm,
    source,
    passToCustomer,
    approvedPolicyRef,
    effectiveFrom: input.effectiveFrom,
    effectiveTo: input.effectiveTo ?? null,
    notes: input.notes ?? null,
    createdByUserId: ctx.principal.userId ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'gateway_cost_rate', entityId: row.id, action: 'create',
    newValue: { gateway: row.gateway, percentagePpm, fixedMinor, taxPpm, source, passToCustomer },
  });
  return row;
}

export interface GatewayCostEstimate {
  rateId: number;
  source: string;
  feeMinor: number;
  taxMinor: number;
  totalMinor: number;
  passToCustomer: boolean;
  approvedPolicyRef: string | null;
}

/**
 * What this transaction is expected to cost MMAKF.
 *
 * NULL when no rate is configured, which is today's state. Callers render "not
 * configured"; they do not fall back to a plausible figure, because a plausible
 * figure in a finance report is indistinguishable six months later from one
 * somebody verified.
 *
 * The multiply goes through applyFactor() in src/db/fees.ts — the one place in
 * this codebase where a factor is applied to money, in BigInt, rounding half up.
 */
export async function estimateGatewayCost(
  db: DB,
  input: { gateway: string; method?: string | null; currency?: string; amountMinor: number; asAt?: string }
): Promise<GatewayCostEstimate | null> {
  const amount = assertMinor(input.amountMinor, 'The transaction amount');
  const currency = normaliseCurrency(input.currency ?? 'INR');
  const asAt = input.asAt ?? new Date().toISOString().slice(0, 10);

  const rows = await db.select().from(r.gatewayCostRates)
    .where(and(
      eq(r.gatewayCostRates.gateway, input.gateway),
      eq(r.gatewayCostRates.currency, currency),
      lte(r.gatewayCostRates.effectiveFrom, asAt),
      or(isNull(r.gatewayCostRates.effectiveTo), gte(r.gatewayCostRates.effectiveTo, asAt)),
    ))
    .orderBy(desc(r.gatewayCostRates.effectiveFrom), desc(r.gatewayCostRates.id));

  // A method-specific rate beats the catch-all; otherwise the most recent one
  // in force wins. Both orderings are explicit so two reads cannot disagree.
  const rate = rows.find((x: any) => x.method && input.method && x.method === input.method)
    ?? rows.find((x: any) => !x.method)
    ?? null;
  if (!rate) return null;

  const feeMinor = applyFactor(amount, rate.percentagePpm) + rate.fixedMinor;
  const taxMinor = applyFactor(feeMinor, rate.taxPpm);
  return {
    rateId: rate.id,
    source: rate.source,
    feeMinor,
    taxMinor,
    totalMinor: feeMinor + taxMinor,
    passToCustomer: rate.passToCustomer,
    approvedPolicyRef: rate.approvedPolicyRef,
  };
}

/**
 * What may be added to the CUSTOMER's price because of the gateway. Zero,
 * unless an approved policy says otherwise.
 *
 * Written as its own function so no caller has to remember the rule. The
 * default answer to "should the payer cover the gateway's cut?" is no, and it
 * takes a named policy to change it — not a boolean somebody flipped.
 */
export function surchargeMinor(estimate: GatewayCostEstimate | null): number {
  if (!estimate) return 0;
  if (!estimate.passToCustomer || !estimate.approvedPolicyRef) return 0;
  return estimate.totalMinor;
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

export interface ReconcileInput {
  gateway: string;
  /** One run, one currency. A variance across currencies is not a variance. */
  currency?: string;
  periodStart: Date;
  periodEnd: Date;
  /**
   * How long a captured transaction may go unsettled before it is an exception.
   *
   * Null — the default — means SETTLEMENT AGE IS NOT CHECKED, and the run
   * records that. MMAKF has published no settlement expectation, and a default
   * of "T+2" here would be this codebase inventing a commercial term and then
   * raising alerts against it.
   */
  unsettledAfterDays?: number | null;
  now?: Date;
}

interface Classified {
  status: ReconciliationClassification;
  exceptionKey: string | null;
  gatewayTransactionId?: number | null;
  paymentId?: number | null;
  orderId?: number | null;
  refundId?: number | null;
  disputeId?: number | null;
  gatewayAmountMinor?: number | null;
  mmakfAmountMinor?: number | null;
  gatewayCurrency?: string | null;
  mmakfCurrency?: string | null;
  detail: string;
  /** Reuse an existing alert instead of raising a second one for one fact. */
  taskId?: number | null;
}

/**
 * Compare one gateway's record against MMAKF's, for one currency and period.
 *
 * Safe to run on a schedule and safe to run twice. A run is a point-in-time
 * observation and each one is kept, but the TASKS are keyed on the exception
 * rather than on the run — so Tuesday's run adopts Monday's task for the same
 * unresolved difference instead of raising a second one. That is what stops the
 * exceptions queue turning into a thing nobody reads.
 */
export async function runReconciliation(db: DB, ctx: AuditContext, input: ReconcileInput) {
  assertCanAnywhere(ctx.principal, 'finance:write');

  const now = input.now ?? new Date();
  const gateway = String(input.gateway ?? '').trim();
  if (!gateway) throw new ReconciliationError('no_gateway', 'A reconciliation run must name a gateway.');
  const currency = normaliseCurrency(input.currency ?? 'INR');
  if (!(input.periodStart instanceof Date) || !(input.periodEnd instanceof Date)) {
    throw new ReconciliationError('bad_period', 'A reconciliation run needs a start and an end.');
  }
  if (input.periodEnd <= input.periodStart) {
    throw new ReconciliationError('bad_period', 'The period must end after it starts.');
  }
  const unsettledAfterDays = input.unsettledAfterDays ?? null;
  if (unsettledAfterDays != null && (!Number.isInteger(unsettledAfterDays) || unsettledAfterDays < 0)) {
    throw new ReconciliationError('bad_period', 'unsettledAfterDays must be a whole number of days.');
  }

  const ref = await allocateFederationId(db, 'REC', now.getFullYear());
  const [run] = await db.insert(r.reconciliationRuns).values({
    ref,
    gateway,
    currency,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    status: 'running',
    unsettledAfterDays,
    startedAt: now,
    runByUserId: ctx.principal.userId ?? null,
  }).returning();

  try {
    const outcome = await classifyPeriod(db, run, gateway, currency, input, now);

    for (const item of outcome.items) {
      const taskId = item.status === 'matched'
        ? null
        : item.taskId ?? await raiseException(db, ctx, run, item, now);

      await db.insert(r.reconciliationItems).values({
        runId: run.id,
        status: item.status,
        exceptionKey: item.exceptionKey,
        gatewayTransactionId: item.gatewayTransactionId ?? null,
        paymentId: item.paymentId ?? null,
        orderId: item.orderId ?? null,
        refundId: item.refundId ?? null,
        disputeId: item.disputeId ?? null,
        gatewayAmountMinor: item.gatewayAmountMinor ?? null,
        mmakfAmountMinor: item.mmakfAmountMinor ?? null,
        varianceMinor: item.gatewayAmountMinor != null && item.mmakfAmountMinor != null
          ? item.gatewayAmountMinor - item.mmakfAmountMinor
          : null,
        gatewayCurrency: item.gatewayCurrency ?? null,
        mmakfCurrency: item.mmakfCurrency ?? null,
        detail: item.detail,
        taskId,
      });
    }

    const matched = outcome.items.filter((x) => x.status === 'matched').length;
    const [finished] = await db.update(r.reconciliationRuns).set({
      status: 'completed',
      gatewayCount: outcome.gatewayCount,
      mmakfCount: outcome.mmakfCount,
      matchedCount: matched,
      exceptionCount: outcome.items.length - matched,
      gatewayTotalMinor: outcome.gatewayTotalMinor,
      mmakfTotalMinor: outcome.mmakfTotalMinor,
      varianceMinor: outcome.gatewayTotalMinor - outcome.mmakfTotalMinor,
      completedAt: now,
      notes: outcome.notes,
    }).where(eq(r.reconciliationRuns.id, run.id)).returning();

    await writeAudit(db, ctx, {
      entityType: 'reconciliation_run', entityId: run.id, action: 'create',
      newValue: {
        ref, gateway, currency,
        matched, exceptions: outcome.items.length - matched,
        varianceMinor: finished.varianceMinor,
      },
    });
    return finished;
  } catch (err: any) {
    // A run that fell over is recorded as FAILED with the reason, never left
    // sitting at `running` — a run stuck in progress reads as "still working"
    // to every dashboard, forever.
    await db.update(r.reconciliationRuns).set({
      status: 'failed',
      completedAt: now,
      failureReason: String(err?.message ?? err).slice(0, 500),
    }).where(eq(r.reconciliationRuns.id, run.id));
    throw err;
  }
}

/** The comparison itself. Pure classification — it writes nothing. */
async function classifyPeriod(
  db: DB, run: any, gateway: string, currency: string, input: ReconcileInput, now: Date
): Promise<{
  items: Classified[]; gatewayCount: number; mmakfCount: number;
  gatewayTotalMinor: number; mmakfTotalMinor: number; notes: string;
}> {
  const gatewayRows = await db.select().from(r.gatewayTransactions).where(and(
    eq(r.gatewayTransactions.gateway, gateway),
    eq(r.gatewayTransactions.currency, currency),
    gte(r.gatewayTransactions.occurredAt, input.periodStart),
    lt(r.gatewayTransactions.occurredAt, input.periodEnd),
  )).orderBy(asc(r.gatewayTransactions.occurredAt), asc(r.gatewayTransactions.id));

  // NOT filtered by currency, deliberately. Filtering here would hide the very
  // rows CURRENCY_MISMATCH exists to find — a payment MMAKF booked in one
  // currency that the gateway settled in another.
  const paymentRows = await db.select().from(s.payments).where(and(
    eq(s.payments.provider, gateway),
    inArray(s.payments.status, ['captured', 'refunded', 'partially_refunded']),
    gte(s.payments.capturedAt, input.periodStart),
    lt(s.payments.capturedAt, input.periodEnd),
  )).orderBy(asc(s.payments.id));

  const byProviderPaymentId = new Map<string, any>();
  for (const p of paymentRows) {
    if (p.providerPaymentId) byProviderPaymentId.set(String(p.providerPaymentId), p);
  }

  const items: Classified[] = [];
  const consumedPaymentIds = new Set<number>();
  const seenMerchantRefs = new Map<string, number>();
  let gatewayTotalMinor = 0;
  const unsettledCutoff = input.unsettledAfterDays == null
    ? null
    : new Date(now.getTime() - input.unsettledAfterDays * 86_400_000);

  for (const txn of gatewayRows) {
    // The DIRECTION is applied by adding or subtracting, never by multiplying
    // the amount by a sign. ±1 happens to be exact, but "no multiply touches
    // money outside applyFactor()" is the invariant the money-safety suite
    // checks by reading this source, and an exception that is safe today is how
    // a factor that is not ±1 gets written on the same line tomorrow.
    const direction = KIND_SIGN[txn.kind] ?? 0;
    if (direction > 0) gatewayTotalMinor += txn.amountMinor;
    else if (direction < 0) gatewayTotalMinor -= txn.amountMinor;

    const key = (kind: string) => `recon:${gateway}:${kind}:${txn.gatewayTxnId}`;

    // ── Money coming back ──────────────────────────────────────────────────
    if (txn.kind === 'refund') {
      const refund = (await db.select().from(s.refunds)
        .where(eq(s.refunds.providerRefundId, txn.gatewayTxnId)).limit(1))[0];
      items.push(refund
        ? {
          status: 'matched', exceptionKey: null, gatewayTransactionId: txn.id,
          refundId: refund.id, paymentId: refund.paymentId, orderId: refund.orderId,
          gatewayAmountMinor: txn.amountMinor, mmakfAmountMinor: refund.amountPaise,
          gatewayCurrency: txn.currency, mmakfCurrency: currency,
          detail: `Refund ${txn.gatewayTxnId} matches MMAKF refund ${refund.id}.`,
        }
        : {
          status: 'refunded', exceptionKey: key('refunded'), gatewayTransactionId: txn.id,
          gatewayAmountMinor: txn.amountMinor, gatewayCurrency: txn.currency,
          detail:
            `${gateway} returned ${formatINR(txn.amountMinor)} on ${txn.gatewayTxnId} and MMAKF has no ` +
            'refund record accounting for it. Either a refund was issued outside the system or the ' +
            'refund record was never written.',
        });
      continue;
    }

    // ── Money being claimed back ───────────────────────────────────────────
    if (txn.kind === 'chargeback') {
      const dispute = (await db.select().from(r.disputes).where(and(
        eq(r.disputes.gateway, gateway),
        eq(r.disputes.gatewayDisputeId, txn.gatewayTxnId),
      )).limit(1))[0];
      items.push({
        status: 'disputed',
        exceptionKey: key('disputed'),
        gatewayTransactionId: txn.id,
        disputeId: dispute?.id ?? null,
        gatewayAmountMinor: txn.amountMinor,
        gatewayCurrency: txn.currency,
        // Where a dispute case already exists it has its own task and its own
        // deadline. Raising a second alert for the same fact would split the
        // work across two queues and leave neither obviously owned.
        taskId: dispute?.taskId ?? null,
        detail: dispute
          ? `Chargeback ${txn.gatewayTxnId} is being defended as dispute ${dispute.ref} (${dispute.status}).`
          : `${gateway} raised a chargeback of ${formatINR(txn.amountMinor)} on ${txn.gatewayTxnId} ` +
            'and MMAKF has no dispute case open for it. Nobody is defending this.',
      });
      continue;
    }

    // Fees, payouts, adjustments and reversals are movements of money already
    // accounted for elsewhere; they inform the totals and are not matched
    // one-to-one against a payment.
    if (txn.kind !== 'payment') continue;

    // ── Charged twice for one purchase ─────────────────────────────────────
    if (txn.merchantRef) {
      const firstSeen = seenMerchantRefs.get(txn.merchantRef);
      if (firstSeen != null) {
        items.push({
          status: 'duplicate', exceptionKey: key('duplicate'), gatewayTransactionId: txn.id,
          gatewayAmountMinor: txn.amountMinor, gatewayCurrency: txn.currency,
          detail:
            `${gateway} shows a second charge of ${formatINR(txn.amountMinor)} against ${txn.merchantRef} ` +
            `(${txn.gatewayTxnId}); the first was ${firstSeen}. Somebody has been charged twice for one purchase.`,
        });
        continue;
      }
      seenMerchantRefs.set(txn.merchantRef, txn.gatewayTxnId);
    }

    const payment = txn.gatewayPaymentId
      ? byProviderPaymentId.get(String(txn.gatewayPaymentId))
      : undefined;

    if (!payment) {
      items.push({
        status: 'missing_in_mmakf', exceptionKey: key('missing_in_mmakf'), gatewayTransactionId: txn.id,
        gatewayAmountMinor: txn.amountMinor, gatewayCurrency: txn.currency,
        detail:
          `${gateway} took ${formatINR(txn.amountMinor)} on ${txn.gatewayTxnId}` +
          `${txn.merchantRef ? ` for ${txn.merchantRef}` : ''} and MMAKF holds no captured payment for it. ` +
          'Somebody was charged for something the federation does not know it sold.',
      });
      continue;
    }
    consumedPaymentIds.add(payment.id);

    const paymentCurrency = String(payment.currency ?? 'INR').toUpperCase();
    if (paymentCurrency !== txn.currency) {
      items.push({
        status: 'currency_mismatch', exceptionKey: key('currency_mismatch'),
        gatewayTransactionId: txn.id, paymentId: payment.id, orderId: payment.orderId,
        gatewayAmountMinor: txn.amountMinor, mmakfAmountMinor: payment.amountPaise,
        gatewayCurrency: txn.currency, mmakfCurrency: paymentCurrency,
        detail:
          `${gateway} reports ${txn.gatewayTxnId} in ${txn.currency} and MMAKF booked payment ` +
          `${payment.id} in ${paymentCurrency}. The two amounts are not comparable until that is resolved.`,
      });
      continue;
    }

    if (txn.amountMinor !== payment.amountPaise) {
      items.push({
        status: 'amount_mismatch', exceptionKey: key('amount_mismatch'),
        gatewayTransactionId: txn.id, paymentId: payment.id, orderId: payment.orderId,
        gatewayAmountMinor: txn.amountMinor, mmakfAmountMinor: payment.amountPaise,
        gatewayCurrency: txn.currency, mmakfCurrency: paymentCurrency,
        detail:
          `${gateway} reports ${formatINR(txn.amountMinor)} on ${txn.gatewayTxnId} and MMAKF recorded ` +
          `${formatINR(payment.amountPaise)} on payment ${payment.id} — a difference of ` +
          `${formatINR(txn.amountMinor - payment.amountPaise)}.`,
      });
      continue;
    }

    if (unsettledCutoff && !txn.settledAt && txn.occurredAt < unsettledCutoff) {
      items.push({
        status: 'unsettled', exceptionKey: key('unsettled'),
        gatewayTransactionId: txn.id, paymentId: payment.id, orderId: payment.orderId,
        gatewayAmountMinor: txn.amountMinor, mmakfAmountMinor: payment.amountPaise,
        gatewayCurrency: txn.currency, mmakfCurrency: paymentCurrency,
        detail:
          `${formatINR(txn.amountMinor)} was taken on ${txn.gatewayTxnId} more than ` +
          `${input.unsettledAfterDays} days ago and ${gateway} has still not settled it. ` +
          'The charge is correct; the money has not arrived.',
      });
      continue;
    }

    items.push({
      status: 'matched', exceptionKey: null,
      gatewayTransactionId: txn.id, paymentId: payment.id, orderId: payment.orderId,
      gatewayAmountMinor: txn.amountMinor, mmakfAmountMinor: payment.amountPaise,
      gatewayCurrency: txn.currency, mmakfCurrency: paymentCurrency,
      detail: `${txn.gatewayTxnId} matches payment ${payment.id} on identity, amount and currency.`,
    });
  }

  // ── MMAKF says it took money the gateway's statement does not carry ──────
  let outOfScope = 0;
  let mmakfTotalMinor = 0;
  let mmakfCount = 0;

  for (const payment of paymentRows) {
    const paymentCurrency = String(payment.currency ?? 'INR').toUpperCase();
    if (consumedPaymentIds.has(payment.id)) {
      mmakfCount++;
      mmakfTotalMinor += payment.amountPaise;
      continue;
    }
    if (paymentCurrency !== currency) {
      // Belongs to that currency's run, not this one. Counted and reported
      // rather than dropped, so a currency nobody has scheduled a run for is
      // visible instead of silently unreconciled.
      outOfScope++;
      continue;
    }
    mmakfCount++;
    mmakfTotalMinor += payment.amountPaise;
    items.push({
      status: 'missing_at_gateway',
      exceptionKey: `recon:${gateway}:missing_at_gateway:payment:${payment.id}`,
      paymentId: payment.id, orderId: payment.orderId,
      mmakfAmountMinor: payment.amountPaise, mmakfCurrency: paymentCurrency,
      detail:
        `MMAKF recorded ${formatINR(payment.amountPaise)} captured on payment ${payment.id} ` +
        `(${payment.providerPaymentId ?? 'no provider id'}) and ${gateway}'s statement for this period ` +
        'does not carry it. Either the import is incomplete or the capture was recorded on something ' +
        'other than the gateway\'s word.',
    });
  }

  // Refunds MMAKF completed in the period reduce what it says it holds.
  const refundRows = paymentRows.length
    ? await db.select().from(s.refunds).where(and(
      inArray(s.refunds.paymentId, paymentRows.map((p: any) => p.id)),
      eq(s.refunds.status, 'completed'),
    ))
    : [];
  for (const refund of refundRows) mmakfTotalMinor -= refund.amountPaise;

  const notes = [
    `${gatewayRows.length} ${gateway} transactions and ${mmakfCount} MMAKF payments in ${currency}.`,
    input.unsettledAfterDays == null
      ? 'Settlement age was NOT checked: MMAKF has published no settlement expectation, and this run was given none.'
      : `Settlement age checked against ${input.unsettledAfterDays} days.`,
    outOfScope
      ? `${outOfScope} MMAKF payment(s) in another currency were left for that currency's own run.`
      : '',
  ].filter(Boolean).join(' ');

  return {
    items,
    gatewayCount: gatewayRows.length,
    mmakfCount,
    gatewayTotalMinor,
    mmakfTotalMinor,
    notes,
  };
}

/**
 * Turn an exception into work somebody is asked to do.
 *
 * The idempotency key is the EXCEPTION key, not the run's. A difference that
 * persists across four nightly runs is one task with four runs pointing at it,
 * and `createTask` adopts the existing row rather than allocating a second.
 */
async function raiseException(
  db: DB, ctx: AuditContext, run: any, item: Classified, now: Date
): Promise<number | null> {
  const task = await createTask(db, ctx, {
    title: `Reconciliation: ${item.status.replace(/_/g, ' ')} — ${run.gateway} ${run.currency}`,
    detail: `${item.detail}\n\nFound by reconciliation run ${run.ref}.`,
    subjectKind: 'reconciliation_item',
    subjectId: item.gatewayTransactionId ?? item.paymentId ?? run.id,
    assignedRole: 'FINANCE_OFFICER',
    // MISSING_IN_MMAKF and DUPLICATE both mean a real person's money is
    // somewhere it should not be. The rest are accounting differences, which
    // matter and do not need somebody woken up.
    priority: item.status === 'missing_in_mmakf' || item.status === 'duplicate' ? 'urgent' : 'high',
    idempotencyKey: item.exceptionKey ?? undefined,
    now,
  });
  return task?.id ?? null;
}

/** The exceptions queue: everything not matched and not yet dealt with. */
export async function openExceptions(db: DB, principal: Principal, limit = 200) {
  assertCanAnywhere(principal, 'finance:read');
  return db.select().from(r.reconciliationItems)
    .where(and(
      sql`${r.reconciliationItems.status} <> 'matched'`,
      isNull(r.reconciliationItems.resolvedAt),
    ))
    .orderBy(desc(r.reconciliationItems.id))
    .limit(limit);
}

/**
 * Close an exception, with a reason.
 *
 * The reason is not optional. "Resolved" with no sentence behind it is how a
 * difference gets closed because it was inconvenient rather than because it was
 * explained, and the next quarter's run raises it again with nobody knowing why
 * it was dismissed the first time.
 */
export async function resolveException(
  db: DB, ctx: AuditContext, itemId: number, resolution: string, now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, 'finance:write');
  const text = String(resolution ?? '').trim();
  if (!text) {
    throw new ReconciliationError('no_reason',
      'Closing a reconciliation exception requires an explanation of what it turned out to be.');
  }

  const item = (await db.select().from(r.reconciliationItems)
    .where(eq(r.reconciliationItems.id, itemId)).limit(1))[0];
  if (!item) throw new ReconciliationError('unknown_item', `No reconciliation item ${itemId}.`);
  if (item.status === 'matched') {
    throw new ReconciliationError('not_an_exception', 'A matched item is not an exception to resolve.');
  }
  if (item.resolvedAt) return item;

  const [row] = await db.update(r.reconciliationItems).set({
    resolvedAt: now,
    resolvedByUserId: ctx.principal.userId ?? null,
    resolution: text,
  }).where(eq(r.reconciliationItems.id, itemId)).returning();

  await writeAudit(db, { ...ctx, reason: text }, {
    entityType: 'reconciliation_item', entityId: itemId, action: 'update',
    oldValue: { status: item.status, resolved: false },
    newValue: { resolved: true },
  });
  return row;
}

// ─── Disputes ───────────────────────────────────────────────────────────────

export interface OpenDisputeInput {
  gateway: string;
  gatewayDisputeId?: string | null;
  gatewayTransactionId?: number | null;
  paymentId?: number | null;
  orderId?: number | null;
  kind?: 'chargeback' | 'retrieval_request' | 'pre_arbitration' | 'arbitration' | 'fraud_report' | 'complaint';
  amountMinor: number;
  currency?: string;
  gatewayFeeMinor?: number | null;
  reasonCode?: string | null;
  reason: string;
  openedAt: Date;
  /**
   * When the defence must be filed. NEVER defaulted.
   *
   * Card scheme windows differ by scheme, by reason code and by acquirer, and a
   * guessed date is worse than none: an office that trusts a deadline the
   * software invented will file on the wrong day and lose the money believing
   * it was in time. Null means "the gateway has not told us", and the surfaces
   * say exactly that.
   */
  evidenceDueAt?: Date | null;
  ownerUserId?: number | null;
  ownerRole?: string | null;
}

/**
 * Open a dispute case, or return the one already open for this claim.
 *
 * Idempotent on (gateway, gatewayDisputeId): gateways redeliver dispute
 * notifications, and two cases for one claim means two people each assuming the
 * other filed the evidence.
 */
export async function openDispute(db: DB, ctx: AuditContext, input: OpenDisputeInput) {
  assertCanAnywhere(ctx.principal, 'finance:write');

  const gateway = String(input.gateway ?? '').trim();
  if (!gateway) throw new ReconciliationError('no_gateway', 'A dispute must name the gateway it came from.');
  const reason = String(input.reason ?? '').trim();
  if (!reason) {
    throw new ReconciliationError('no_reason',
      'A dispute must record why the money is being claimed back — it is what the defence answers.');
  }
  const amountMinor = assertMinor(input.amountMinor, 'The disputed amount');
  if (amountMinor <= 0) throw new ReconciliationError('bad_amount', 'A disputed amount must be positive.');
  const currency = normaliseCurrency(input.currency ?? 'INR');

  if (input.gatewayDisputeId) {
    const existing = (await db.select().from(r.disputes).where(and(
      eq(r.disputes.gateway, gateway),
      eq(r.disputes.gatewayDisputeId, input.gatewayDisputeId),
    )).limit(1))[0];
    if (existing) return existing;
  }

  const ref = await allocateFederationId(db, 'DSP', input.openedAt.getFullYear());

  // The alert exists before the case is even assigned. A chargeback with nobody
  // watching the clock is the failure this table was built to stop.
  const task = await createTask(db, ctx, {
    title: `Dispute ${ref}: defend ${formatINR(amountMinor)} on ${gateway}`,
    detail:
      `${reason}\n\n` +
      (input.evidenceDueAt
        ? `Evidence is due by ${input.evidenceDueAt.toISOString()}.`
        : 'The gateway has given no evidence deadline. Confirm it before assuming there is time.'),
    subjectKind: 'dispute',
    assignedRole: 'FINANCE_OFFICER',
    assignedUserId: input.ownerUserId ?? null,
    priority: 'urgent',
    // The deadline IS the task deadline. A dispute whose task had no due date
    // would sit in the queue looking like everything else.
    dueAt: input.evidenceDueAt ?? null,
    idempotencyKey: `dispute:${gateway}:${input.gatewayDisputeId ?? ref}`,
    now: input.openedAt,
  });

  let row;
  try {
    [row] = await db.insert(r.disputes).values({
      ref,
      gateway,
      gatewayDisputeId: input.gatewayDisputeId ?? null,
      gatewayTransactionId: input.gatewayTransactionId ?? null,
      paymentId: input.paymentId ?? null,
      orderId: input.orderId ?? null,
      kind: input.kind ?? 'chargeback',
      status: input.evidenceDueAt ? 'evidence_required' : 'open',
      amountMinor,
      currency,
      gatewayFeeMinor: input.gatewayFeeMinor ?? null,
      reasonCode: input.reasonCode ?? null,
      reason,
      openedAt: input.openedAt,
      evidenceDueAt: input.evidenceDueAt ?? null,
      ownerUserId: input.ownerUserId ?? null,
      ownerRole: input.ownerRole ?? 'FINANCE_OFFICER',
      taskId: task?.id ?? null,
    }).returning();
  } catch (err) {
    if (isUniqueViolation(err) && input.gatewayDisputeId) {
      const [live] = await db.select().from(r.disputes).where(and(
        eq(r.disputes.gateway, gateway),
        eq(r.disputes.gatewayDisputeId, input.gatewayDisputeId),
      )).limit(1);
      if (live) return live;
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'dispute', entityId: row.id, action: 'create',
    newValue: { ref, gateway, amountMinor, currency, evidenceDueAt: input.evidenceDueAt ?? null },
  });
  return row;
}

export interface EvidenceItem {
  label: string;
  /** A storage key or a record reference — never the document itself. */
  reference: string;
  note?: string | null;
}

/**
 * Record what was filed in defence, and when.
 *
 * Evidence is APPENDED. Removing what was submitted would make a lost dispute
 * impossible to review afterwards, and reviewing lost disputes is the only way
 * the next one is won.
 */
export async function submitEvidence(
  db: DB, ctx: AuditContext, disputeId: number, evidence: EvidenceItem[], now: Date = new Date()
) {
  assertCanAnywhere(ctx.principal, 'finance:write');
  const dispute = (await db.select().from(r.disputes).where(eq(r.disputes.id, disputeId)).limit(1))[0];
  if (!dispute) throw new ReconciliationError('unknown_dispute', `No dispute ${disputeId}.`);
  if (DISPUTE_TERMINAL.has(dispute.status)) {
    throw new ReconciliationError('dispute_closed',
      `Dispute ${dispute.ref} is ${dispute.status}. Evidence cannot be filed against a closed case.`);
  }
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new ReconciliationError('no_evidence', 'Filing evidence requires at least one item.');
  }

  const existing = Array.isArray(dispute.evidence) ? dispute.evidence : [];
  const appended = [
    ...existing,
    ...evidence.map((e) => ({
      label: String(e.label).slice(0, 200),
      reference: String(e.reference).slice(0, 500),
      note: e.note ?? null,
      addedAt: now.toISOString(),
      addedByUserId: ctx.principal.userId ?? null,
    })),
  ];

  const [row] = await db.update(r.disputes).set({
    evidence: appended as any,
    evidenceSubmittedAt: dispute.evidenceSubmittedAt ?? now,
    status: 'evidence_submitted',
    updatedAt: now,
  }).where(eq(r.disputes.id, disputeId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'dispute', entityId: disputeId, action: 'update',
    oldValue: { status: dispute.status, items: existing.length },
    newValue: { status: 'evidence_submitted', items: appended.length },
  });
  return row;
}

/**
 * Close a dispute with what actually happened.
 *
 * `outcomeAmountMinor` is what MMAKF KEPT, and it is recorded separately from
 * the amount at risk because the two differ far more often than people expect:
 * a partially upheld claim returns some of it, and a win with the gateway's
 * dispute fee deducted is not a whole win.
 */
export async function resolveDispute(
  db: DB,
  ctx: AuditContext,
  input: {
    disputeId: number;
    status: 'won' | 'lost' | 'accepted' | 'expired' | 'cancelled';
    resolution: string;
    outcomeAmountMinor?: number | null;
    gatewayFeeMinor?: number | null;
    now?: Date;
  }
) {
  assertCanAnywhere(ctx.principal, 'finance:write');
  const now = input.now ?? new Date();
  const resolution = String(input.resolution ?? '').trim();
  if (!resolution) {
    throw new ReconciliationError('no_reason', 'Closing a dispute requires a record of how it ended.');
  }

  const dispute = (await db.select().from(r.disputes).where(eq(r.disputes.id, input.disputeId)).limit(1))[0];
  if (!dispute) throw new ReconciliationError('unknown_dispute', `No dispute ${input.disputeId}.`);
  if (DISPUTE_TERMINAL.has(dispute.status)) {
    throw new ReconciliationError('dispute_closed', `Dispute ${dispute.ref} is already ${dispute.status}.`);
  }
  if (input.outcomeAmountMinor != null) {
    const kept = assertMinor(input.outcomeAmountMinor, 'The amount retained');
    if (kept < 0 || kept > dispute.amountMinor) {
      throw new ReconciliationError('bad_amount',
        `MMAKF cannot retain ${formatINR(kept)} out of a ${formatINR(dispute.amountMinor)} claim.`);
    }
  }

  const [row] = await db.update(r.disputes).set({
    status: input.status,
    resolution,
    resolvedAt: now,
    outcomeAmountMinor: input.outcomeAmountMinor ?? (input.status === 'won' ? dispute.amountMinor : 0),
    gatewayFeeMinor: input.gatewayFeeMinor ?? dispute.gatewayFeeMinor ?? null,
    updatedAt: now,
  }).where(eq(r.disputes.id, input.disputeId)).returning();

  await writeAudit(db, { ...ctx, reason: resolution }, {
    entityType: 'dispute', entityId: input.disputeId, action: 'update',
    oldValue: { status: dispute.status },
    newValue: { status: input.status, outcomeAmountMinor: row.outcomeAmountMinor },
  });
  return row;
}

/** Disputes whose evidence deadline falls inside the next `hours`. */
export async function disputesDueWithin(db: DB, principal: Principal, hours: number, now: Date = new Date()) {
  assertCanAnywhere(principal, 'finance:read');
  const until = new Date(now.getTime() + hours * 3_600_000);
  return db.select().from(r.disputes).where(and(
    inArray(r.disputes.status, ['open', 'evidence_required', 'under_review']),
    sql`${r.disputes.evidenceDueAt} is not null`,
    lte(r.disputes.evidenceDueAt, until),
  )).orderBy(asc(r.disputes.evidenceDueAt));
}

/**
 * Disputes whose window has already closed with nothing filed.
 *
 * This list should always be empty. Every row on it is money the federation
 * gave up without answering, and it is countable precisely so that "how much
 * did we lose by not looking?" has a figure rather than a shrug.
 */
export async function undefendedDisputes(db: DB, principal: Principal, now: Date = new Date()) {
  assertCanAnywhere(principal, 'finance:read');
  return db.select().from(r.disputes).where(and(
    inArray(r.disputes.status, ['open', 'evidence_required']),
    sql`${r.disputes.evidenceDueAt} is not null`,
    lt(r.disputes.evidenceDueAt, now),
    isNull(r.disputes.evidenceSubmittedAt),
  )).orderBy(asc(r.disputes.evidenceDueAt));
}

export interface DisputeExposure {
  openCount: number;
  /** Money currently being claimed back, by currency. */
  atRiskMinor: Record<string, number>;
  dueWithin72h: number;
  overdueUndefended: number;
  lostMinor: Record<string, number>;
}

/**
 * The one figure a treasurer asks for: how much is being claimed back, and how
 * much of it is about to be lost by default.
 */
export async function disputeExposure(
  db: DB, principal: Principal, now: Date = new Date()
): Promise<DisputeExposure> {
  assertCanAnywhere(principal, 'finance:read');
  const rows = await db.select().from(r.disputes);

  const atRiskMinor: Record<string, number> = {};
  const lostMinor: Record<string, number> = {};
  let openCount = 0;

  for (const d of rows) {
    if (!DISPUTE_TERMINAL.has(d.status)) {
      openCount++;
      atRiskMinor[d.currency] = (atRiskMinor[d.currency] ?? 0) + d.amountMinor;
      continue;
    }
    // What was actually given up: the claim less whatever was retained.
    if (d.status === 'lost' || d.status === 'accepted' || d.status === 'expired') {
      const kept = d.outcomeAmountMinor ?? 0;
      lostMinor[d.currency] = (lostMinor[d.currency] ?? 0) + (d.amountMinor - kept);
    }
  }

  const soon = await disputesDueWithin(db, principal, 72, now);
  const overdue = await undefendedDisputes(db, principal, now);

  return {
    openCount,
    atRiskMinor,
    dueWithin72h: soon.length,
    overdueUndefended: overdue.length,
    lostMinor,
  };
}

/**
 * Mark disputes whose window closed undefended, so the loss is on the record.
 *
 * It does NOT quietly tidy them away. Each one keeps its task open and is
 * marked `expired`, which src/lib/status.ts tones as a failure under the
 * `dispute` domain — because a defence nobody filed is not a neutral timeout.
 */
export async function lapseUndefendedDisputes(
  db: DB, ctx: AuditContext, now: Date = new Date()
): Promise<number> {
  assertCanAnywhere(ctx.principal, 'finance:write');
  const lapsed = await undefendedDisputes(db, ctx.principal, now);

  for (const d of lapsed) {
    await db.update(r.disputes).set({
      status: 'expired',
      resolution:
        `The evidence window closed at ${d.evidenceDueAt?.toISOString()} with nothing filed. ` +
        'The claim succeeds by default.',
      resolvedAt: now,
      outcomeAmountMinor: 0,
      updatedAt: now,
    }).where(eq(r.disputes.id, d.id));

    await writeAudit(db, ctx, {
      entityType: 'dispute', entityId: d.id, action: 'update',
      oldValue: { status: d.status },
      newValue: { status: 'expired', undefended: true, amountMinor: d.amountMinor },
    });
  }
  return lapsed.length;
}

// ─── Gateway health ─────────────────────────────────────────────────────────

/**
 * Record what happened when MMAKF last spoke to a gateway.
 *
 * Three consecutive failures is `down`; one or two is `degraded`. The numbers
 * are here rather than in configuration because they describe THIS function's
 * own sensitivity, not a commercial term — but they are named constants so the
 * next person can see what they are agreeing to.
 */
const DOWN_AFTER_CONSECUTIVE_FAILURES = 3;

export async function recordGatewayProbe(
  db: DB,
  input: { gateway: string; ok: boolean; error?: string | null; note?: string | null; now?: Date }
) {
  const now = input.now ?? new Date();
  const gateway = String(input.gateway ?? '').trim();
  if (!gateway) throw new ReconciliationError('no_gateway', 'A health probe must name a gateway.');

  await db.insert(r.gatewayHealth).values({ gateway, status: 'unknown' })
    .onConflictDoNothing({ target: r.gatewayHealth.gateway });

  const current = (await db.select().from(r.gatewayHealth)
    .where(eq(r.gatewayHealth.gateway, gateway)).limit(1))[0];

  const consecutiveFailures = input.ok ? 0 : (current?.consecutiveFailures ?? 0) + 1;
  const status = input.ok
    ? 'healthy'
    : consecutiveFailures >= DOWN_AFTER_CONSECUTIVE_FAILURES ? 'down' : 'degraded';

  const [row] = await db.update(r.gatewayHealth).set({
    status,
    consecutiveFailures,
    successCount: (current?.successCount ?? 0) + (input.ok ? 1 : 0),
    failureCount: (current?.failureCount ?? 0) + (input.ok ? 0 : 1),
    lastSuccessAt: input.ok ? now : current?.lastSuccessAt ?? null,
    lastFailureAt: input.ok ? current?.lastFailureAt ?? null : now,
    lastCheckedAt: now,
    // Scrubbed by the caller. The adapters never hand a credential to this
    // function, and this column must never become the place one leaks.
    lastError: input.ok ? null : (input.error ?? null),
    degradedSince: status === 'healthy' ? null : current?.degradedSince ?? now,
    note: input.note ?? current?.note ?? null,
    updatedAt: now,
  }).where(eq(r.gatewayHealth.gateway, gateway)).returning();

  return row;
}

export interface GatewayStanding {
  gateway: string;
  /**
   * The credentials are present. Read from the environment NOW, never from a
   * stored copy.
   *
   * Deliberately NOT the same question as `ready`. "No keys at all" and "keys
   * present but the gateway still cannot take money" send an operator to two
   * different places, and one boolean covering both told somebody with a
   * half-finished gateway to go and enter credentials they had already entered
   * correctly.
   */
  configured: boolean;
  /**
   * Configured AND able to take money end to end, which is what a provider's
   * own isConfigured() means.
   *
   * This is the one selection may act on. A gateway that could take a payment
   * and never confirm it is not a degraded service; it is a debit with nothing
   * on the other side of it — see src/lib/payments/razorpay.ts.
   */
  ready: boolean;
  /** The last observation, or 'unknown' if MMAKF has never spoken to it. */
  health: 'unknown' | 'healthy' | 'degraded' | 'down';
  /** True only when it is ready and not observed down. */
  usable: boolean;
  /** Plain English, safe to render verbatim. */
  note: string;
}

/**
 * Whether a gateway can take money at all, and what MMAKF last saw.
 *
 * "Not configured" is reported as a FACT, not an error. MMAKF has no gateway
 * credentials today; a screen that renders that as a red failure is telling the
 * office something is broken when nothing is. The deeper test-versus-live guard
 * lives in src/lib/payments/mode.ts and is a separate question from this one.
 *
 * The credential question and the readiness question are answered SEPARATELY.
 * Folding them into one boolean did more than mislabel a field: it hid the
 * health signal behind the credential check, so a gateway skipped for being
 * observed DOWN was recorded as having been skipped for having no credentials.
 * A routing decision that misstates why it failed over is worse than one that
 * does not explain itself at all, because it is believed.
 */
export async function gatewayStanding(db: DB, gateway: string): Promise<GatewayStanding> {
  const provider = providerById(gateway);
  const configured = Boolean(provider && providerHasCredentials(provider));
  const ready = Boolean(provider?.isConfigured());
  const row = (await db.select().from(r.gatewayHealth)
    .where(eq(r.gatewayHealth.gateway, gateway)).limit(1))[0];
  const health = (row?.status ?? 'unknown') as GatewayStanding['health'];

  return {
    gateway,
    configured,
    ready,
    health,
    // Readiness, never merely credentials. `usable` is what callers act on, and
    // a gateway that cannot confirm a payment must not be one of them.
    usable: ready && health !== 'down',
    note: !provider
      ? `${gateway} is not a payment provider this system knows about.`
      : !configured
        ? `${provider.label} has no credentials configured, so it cannot take money. That is a ` +
          'configuration state, not a fault.'
        // The provider states its own reason where it has one. This module must
        // not guess at a particular gateway's readiness rules on its behalf.
        : !ready
          ? provider.readinessNote?.()
            ?? `${provider.label} has credentials configured but is not ready to take money.`
          : health === 'unknown'
            ? `${provider.label} is configured. MMAKF has not checked it yet.`
            : health === 'down'
              ? `${provider.label} failed its last ${row?.consecutiveFailures ?? 0} checks and is being skipped.`
              : `${provider.label} is configured and last checked ${health}.`,
  };
}

// ─── Routing ────────────────────────────────────────────────────────────────

export interface RoutingRuleInput {
  code: string;
  label: string;
  priority?: number;
  currency?: string | null;
  country?: string | null;
  method?: string | null;
  customerType?: string | null;
  minAmountMinor?: number | null;
  maxAmountMinor?: number | null;
  gateway: string;
  fallbackGateway?: string | null;
  requireHealthy?: boolean;
  active?: boolean;
  notes?: string | null;
}

export async function upsertRoutingRule(db: DB, ctx: AuditContext, input: RoutingRuleInput) {
  assertCanAnywhere(ctx.principal, 'finance:write');

  const min = input.minAmountMinor ?? null;
  const max = input.maxAmountMinor ?? null;
  if (min != null) assertMinor(min, 'The band lower bound');
  if (max != null) assertMinor(max, 'The band upper bound');
  if (min != null && max != null && min >= max) {
    throw new ReconciliationError('bad_band',
      `The band ${min}–${max} does not describe a range. The lower bound is inclusive and the upper exclusive.`);
  }
  if (!String(input.gateway ?? '').trim()) {
    throw new ReconciliationError('no_gateway', 'A routing rule must name the gateway it prefers.');
  }

  const values = {
    code: input.code,
    label: input.label,
    priority: input.priority ?? 100,
    active: input.active !== false,
    currency: input.currency ? normaliseCurrency(input.currency) : null,
    country: input.country ?? null,
    method: input.method ?? null,
    customerType: input.customerType ?? null,
    minAmountMinor: min,
    maxAmountMinor: max,
    gateway: String(input.gateway).trim(),
    fallbackGateway: input.fallbackGateway ?? null,
    requireHealthy: input.requireHealthy !== false,
    notes: input.notes ?? null,
    createdByUserId: ctx.principal.userId ?? null,
    updatedAt: new Date(),
  };

  const [row] = await db.insert(r.paymentRoutingRules).values(values)
    .onConflictDoUpdate({ target: r.paymentRoutingRules.code, set: values })
    .returning();

  await writeAudit(db, ctx, {
    entityType: 'payment_routing_rule', entityId: row.id, action: 'update',
    newValue: { code: row.code, gateway: row.gateway, priority: row.priority, active: row.active },
  });
  return row;
}

export interface RoutingRequest {
  currency?: string;
  country?: string | null;
  method?: string | null;
  customerType?: string | null;
  amountMinor: number;
}

export interface RoutingDecision {
  /** The gateway to use, or null when none can take this payment. */
  gateway: string | null;
  ruleId: number | null;
  ruleCode: string | null;
  /** Plain English. Stored on the attempt so the choice stays explainable. */
  reason: string;
  /** Every gateway considered, and why each was or was not chosen. */
  considered: Array<{ gateway: string; ruleCode: string | null; usable: boolean; note: string }>;
}

/**
 * Choose a gateway. Never throws, and never names one that cannot take money.
 *
 * Evaluation is by priority then id, so the order is TOTAL — the same inputs
 * against the same rules cannot route two ways, which is what makes the choice
 * defensible after the fact rather than merely reproducible in principle.
 *
 * A rule's gateway must be CONFIGURED to be chosen. Health only removes a
 * gateway; it never promotes one. And when nothing is configured — MMAKF's
 * state today — the answer is a null gateway with a sentence saying so, not an
 * exception, because an unconfigured federation is not a broken one.
 */
export async function chooseGateway(db: DB, request: RoutingRequest): Promise<RoutingDecision> {
  const amountMinor = assertMinor(request.amountMinor, 'The amount to route');
  const currency = normaliseCurrency(request.currency ?? 'INR');

  const rules = await db.select().from(r.paymentRoutingRules)
    .where(eq(r.paymentRoutingRules.active, true))
    .orderBy(asc(r.paymentRoutingRules.priority), asc(r.paymentRoutingRules.id));

  const considered: RoutingDecision['considered'] = [];
  const standings = new Map<string, GatewayStanding>();
  const standingOf = async (g: string) => {
    if (!standings.has(g)) standings.set(g, await gatewayStanding(db, g));
    return standings.get(g)!;
  };

  const matches = (rule: any): boolean => {
    if (rule.currency && rule.currency !== currency) return false;
    if (rule.country && rule.country !== (request.country ?? null)) return false;
    if (rule.method && rule.method !== (request.method ?? null)) return false;
    if (rule.customerType && rule.customerType !== (request.customerType ?? null)) return false;
    if (rule.minAmountMinor != null && amountMinor < rule.minAmountMinor) return false;
    // Exclusive upper bound, so adjacent bands cannot both claim one amount.
    if (rule.maxAmountMinor != null && amountMinor >= rule.maxAmountMinor) return false;
    return true;
  };

  for (const rule of rules) {
    if (!matches(rule)) continue;

    for (const candidate of [rule.gateway, rule.fallbackGateway].filter(Boolean) as string[]) {
      const standing = await standingOf(candidate);
      const blockedByHealth = rule.requireHealthy && standing.health === 'down';
      // READY, not merely configured. Choosing a gateway that has credentials
      // but could never confirm what it took hands the payer a checkout that
      // debits them into silence — and the fallback exists precisely so that
      // does not have to happen.
      const usable = standing.ready && !blockedByHealth;

      considered.push({
        gateway: candidate,
        ruleCode: rule.code,
        usable,
        // Readiness first, health second. A gateway that could not have taken
        // this payment anyway was not skipped BECAUSE it is down, and recording
        // it that way sends somebody to restore a service that was never wired
        // up in the first place.
        note: !standing.ready
          ? standing.note
          : blockedByHealth
            ? `${candidate} is observed down and this rule requires a healthy gateway.`
            : standing.note,
      });

      if (usable) {
        const viaFallback = candidate !== rule.gateway;
        return {
          gateway: candidate,
          ruleId: rule.id,
          ruleCode: rule.code,
          reason: viaFallback
            ? `Rule "${rule.code}" prefers ${rule.gateway}, which is unavailable, so its fallback ` +
              `${candidate} takes this ${formatINR(amountMinor)} ${currency} payment.`
            : `Rule "${rule.code}" routes this ${formatINR(amountMinor)} ${currency} payment to ${candidate}.`,
          considered,
        };
      }
    }
  }

  return {
    gateway: null,
    ruleId: null,
    ruleCode: null,
    reason: rules.length === 0
      ? 'No payment routing rules are configured, so there is no gateway to route to.'
      : considered.length === 0
        ? `No routing rule matches a ${formatINR(amountMinor)} ${currency} payment with these details.`
        : 'Every gateway a matching rule named is either unconfigured or observed down.',
    considered,
  };
}
