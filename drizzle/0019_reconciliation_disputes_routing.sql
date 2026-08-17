-- 0017 — reconciliation, disputes and gateway routing.
--
-- Hand-written, like every migration since 0004. drizzle.config.ts points at
-- src/db/schema.ts alone, so `drizzle-kit generate` would emit DROP TABLE for
-- every schema file it cannot see. See the note at the top of 0007.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS ADDS, AND THE QUESTION EACH TABLE ANSWERS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The federation can already take money and issue a receipt for it. It cannot
-- yet answer the three questions that decide whether the money is still there
-- in ninety days:
--
--   1. DOES WHAT THE GATEWAY SAYS MATCH WHAT MMAKF RECORDED?
--      gateway_transactions, reconciliation_runs, reconciliation_items.
--      A run compares one gateway, one currency, one period, and classifies
--      every row. Anything that is not MATCHED becomes a task for finance —
--      silent reconciliation failure is how money goes missing for a quarter
--      without anybody noticing.
--
--   2. WHAT IS BEING CLAIMED BACK, AND BY WHEN MUST WE ANSWER?
--      disputes. The deadline is the whole point: a chargeback window that
--      passes undefended is money lost by default, so evidence_due_at is a
--      first-class, indexed, countable column rather than a note in a field.
--
--   3. WHICH GATEWAY SHOULD TAKE THIS PAYMENT?
--      payment_routing_rules, gateway_health.
--      A rule is keyed on currency, country, method, amount band and customer
--      type, and may require the gateway to be healthy. It returns a preference
--      and NEVER a guarantee: a gateway with no credentials configured is not a
--      candidate, and "nothing is configured" is an honest answer, not an error.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- AND THE THING THAT MUST NOT HAPPEN: TWO CHARGES FOR ONE PURCHASE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Routing implies failover, and failover is where double charges come from. A
-- card declined at gateway A, retried at gateway B, and A's authorisation
-- settling late is a customer charged twice by a system that did exactly what
-- it was told.
--
-- The existing `payments` table conflates the two things that must be counted
-- separately. Its own comment calls a row "a payment ATTEMPT", while
-- src/db/orders.ts treats one row as THE payment for an order. Both readings
-- are reasonable, which is precisely the problem: a table that means two things
-- cannot carry a constraint about either.
--
-- So the intent is separated from the attempt:
--
--     payment_intents   one per order. "This much money is to be taken, once."
--     payment_attempts  many per intent, each on a named gateway.
--
-- and the invariant is enforced BY THE DATABASE, not by a code path somebody
-- can forget to call:
--
--     payment_attempts_one_success_uk
--       UNIQUE (intent_id) WHERE outcome = 'succeeded'
--
-- Two attempts on one intent cannot both succeed. Not "should not" — cannot.
-- Application logic that checks first and writes second loses that race under
-- exactly the conditions that produce it: a webhook and a retry arriving
-- together. tests/reconciliation.test.ts proves it by trying.
--
-- payment_intents_live_order_uk is the same argument one level up: an order may
-- not have two intents that are open or already succeeded, so a second checkout
-- for an order somebody has already paid for cannot even begin.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- MONEY COLUMNS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Per-transaction amounts are `integer` MINOR UNITS, matching commerce.schema
-- (paise for INR). Aggregates over a period are `bigint`, because a sum has no
-- reason to fit where a single row does — ₹21.47 crore is the integer ceiling
-- in paise and a year of settlements passes it long before one payment does.
--
-- Every amount column names its currency's minor unit rather than "paise",
-- because CURRENCY_MISMATCH is one of the nine things a reconciliation run
-- exists to find, and a column called paise cannot hold the row that proves it.
--
-- Gateway cost is stored as WHAT THE GATEWAY TOOK, per transaction, and the
-- RATE it was expected to take lives in gateway_cost_rates as configuration
-- with a recorded source. Nothing in this migration adds a gateway's cut to a
-- customer's price: gateway_cost_rates.pass_to_customer defaults to false and
-- carries the reference of the approved policy that would change it.

-- ── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "public"."payment_intent_status" AS ENUM('open', 'succeeded', 'failed', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."payment_attempt_outcome" AS ENUM('initiated', 'pending', 'succeeded', 'failed', 'abandoned', 'cancelled');--> statement-breakpoint

-- A taxonomy, not a lifecycle: what KIND of movement the gateway is reporting.
CREATE TYPE "public"."gateway_transaction_kind" AS ENUM('payment', 'refund', 'chargeback', 'chargeback_reversal', 'adjustment', 'fee', 'payout');--> statement-breakpoint

CREATE TYPE "public"."reconciliation_run_status" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled');--> statement-breakpoint

-- The nine classifications. Every one of the eight that is not `matched` is an
-- exception with a task behind it.
CREATE TYPE "public"."reconciliation_status" AS ENUM('matched', 'missing_in_mmakf', 'missing_at_gateway', 'duplicate', 'amount_mismatch', 'currency_mismatch', 'unsettled', 'refunded', 'disputed');--> statement-breakpoint

CREATE TYPE "public"."dispute_kind" AS ENUM('chargeback', 'retrieval_request', 'pre_arbitration', 'arbitration', 'fraud_report', 'complaint');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'evidence_required', 'evidence_submitted', 'under_review', 'won', 'lost', 'accepted', 'expired', 'cancelled');--> statement-breakpoint

-- `not_configured` is deliberately absent. Whether a gateway has credentials is
-- read from the environment at the moment of asking (src/lib/payments), never
-- stored: a stored copy goes stale the day somebody sets the key, and a stale
-- "not configured" would route money away from a working gateway.
CREATE TYPE "public"."gateway_health_status" AS ENUM('unknown', 'healthy', 'degraded', 'down');--> statement-breakpoint

-- ── Payment intents and attempts ────────────────────────────────────────────

CREATE TABLE "payment_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"order_id" integer NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" "payment_intent_status" DEFAULT 'open' NOT NULL,
	-- The one payment this intent produced, if it produced one. Nullable for the
	-- whole of an intent's life until something actually succeeds.
	"payment_id" integer,
	"customer_type" text,
	"country" text,
	"idempotency_key" text,
	"opened_by_user_id" integer,
	"closed_at" timestamp with time zone,
	"closed_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_intents_amount_positive" CHECK ("amount_minor" > 0)
);
--> statement-breakpoint

CREATE TABLE "payment_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"intent_id" integer NOT NULL,
	"attempt_no" integer NOT NULL,
	"gateway" text NOT NULL,
	"outcome" "payment_attempt_outcome" DEFAULT 'initiated' NOT NULL,

	-- Copied from the intent at creation and CHECKed against it in application
	-- code. An attempt that could carry its own amount would be a client-supplied
	-- price with extra steps.
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,

	"gateway_order_id" text,
	"gateway_payment_id" text,
	"method" text,

	-- What the gateway TOOK from this attempt. Recorded, never added to the
	-- customer's price. Null means "not reported yet", which is not zero.
	"gateway_fee_minor" integer,
	"gateway_tax_minor" integer,

	-- Which routing rule sent it here, and the sentence explaining why. Kept so
	-- "why did this go to gateway B?" is answered from the record.
	"routing_rule_id" integer,
	"routing_reason" text,

	"failure_code" text,
	"failure_reason" text,
	"idempotency_key" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "payment_attempts_amount_positive" CHECK ("amount_minor" > 0)
);
--> statement-breakpoint

-- ── What the gateway says happened ──────────────────────────────────────────

CREATE TABLE "gateway_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"gateway" text NOT NULL,
	"gateway_txn_id" text NOT NULL,
	"kind" "gateway_transaction_kind" NOT NULL,

	-- The gateway's own words for its own state. NOT an enum: every gateway has
	-- a different vocabulary, and mapping it on import loses the evidence. The
	-- classification MMAKF draws from it lives on reconciliation_items.
	"gateway_status" text,

	"gateway_order_id" text,
	"gateway_payment_id" text,
	-- Our reference as the gateway holds it — usually the order number, which is
	-- what makes a statement line reconcilable at all.
	"merchant_ref" text,

	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"fee_minor" integer,
	"tax_minor" integer,

	"occurred_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"settlement_ref" text,

	-- PROVENANCE. Where this row came from — a named settlement report, an API
	-- export, a manual entry — so a disputed figure can be traced back to the
	-- document it was read out of. Not optional: a gateway figure with no source
	-- is a number somebody typed.
	"source" text NOT NULL,
	"import_batch" text,
	-- The source row, frozen. A later re-import must not rewrite what the
	-- gateway said the first time.
	"raw" jsonb,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Gateway cost, as configuration ──────────────────────────────────────────
--
-- No published rate is hard-coded anywhere in this codebase. Razorpay's,
-- PayU's and Stripe's rate cards change, and MMAKF's negotiated terms may
-- differ from all three. A rate is a row here, with the source it was taken
-- from and the date it took effect, or it does not exist and the estimate
-- honestly answers "not configured".
CREATE TABLE "gateway_cost_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"gateway" text NOT NULL,
	-- Null means "any". A gateway that charges the same for every method needs
	-- one row, not six.
	"method" text,
	"currency" text DEFAULT 'INR' NOT NULL,

	-- Parts-per-million, applied through applyFactor() in src/db/fees.ts — the
	-- only place in the codebase where a factor multiplies money.
	"percentage_ppm" integer DEFAULT 0 NOT NULL,
	"fixed_minor" integer DEFAULT 0 NOT NULL,
	"tax_ppm" integer DEFAULT 0 NOT NULL,

	-- WHERE THIS NUMBER CAME FROM. A rate card page, a signed schedule, an
	-- email from the account manager. Required, for the same reason
	-- gateway_transactions.source is.
	"source" text NOT NULL,

	-- Off by default and stays off until a named policy says otherwise. What the
	-- gateway takes is MMAKF's cost of doing business; passing it to the payer is
	-- a decision the federation makes in writing, not a default in a schema.
	"pass_to_customer" boolean DEFAULT false NOT NULL,
	"approved_policy_ref" text,

	"effective_from" date NOT NULL,
	"effective_to" date,
	"notes" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Reconciliation ──────────────────────────────────────────────────────────

CREATE TABLE "reconciliation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"gateway" text NOT NULL,
	-- One currency per run. Totals across mixed currencies are not a total, and
	-- a variance figure that added paise to cents would be worse than none.
	"currency" text DEFAULT 'INR' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"status" "reconciliation_run_status" DEFAULT 'pending' NOT NULL,

	-- Null means SETTLEMENT AGE WAS NOT CHECKED, and the run says so rather than
	-- inventing a threshold. MMAKF has published no settlement expectation; a
	-- default of "T+2" here would be this codebase deciding a commercial term.
	"unsettled_after_days" integer,

	"gateway_count" integer DEFAULT 0 NOT NULL,
	"mmakf_count" integer DEFAULT 0 NOT NULL,
	"matched_count" integer DEFAULT 0 NOT NULL,
	"exception_count" integer DEFAULT 0 NOT NULL,

	"gateway_total_minor" bigint DEFAULT 0 NOT NULL,
	"mmakf_total_minor" bigint DEFAULT 0 NOT NULL,
	"variance_minor" bigint DEFAULT 0 NOT NULL,

	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"failure_reason" text,
	"run_by_user_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "reconciliation_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"status" "reconciliation_status" NOT NULL,

	-- The identity of the EXCEPTION rather than of the run, so the same problem
	-- seen by two runs is recognised as one problem and does not raise a second
	-- task for finance. Stable across runs by construction.
	"exception_key" text,

	"gateway_transaction_id" integer,
	"payment_id" integer,
	"order_id" integer,
	"settlement_id" integer,
	"refund_id" integer,
	"dispute_id" integer,

	"gateway_amount_minor" integer,
	"mmakf_amount_minor" integer,
	"variance_minor" integer,
	"gateway_currency" text,
	"mmakf_currency" text,

	-- The sentence a finance officer reads. Written when the item is classified,
	-- so the explanation cannot drift from the classification.
	"detail" text NOT NULL,

	-- The alert. Every non-matched item has one; a matched item has none.
	"task_id" integer,

	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" integer,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Disputes ────────────────────────────────────────────────────────────────

CREATE TABLE "disputes" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"gateway" text NOT NULL,
	"gateway_dispute_id" text,

	"gateway_transaction_id" integer,
	"payment_id" integer,
	"order_id" integer,

	"kind" "dispute_kind" DEFAULT 'chargeback' NOT NULL,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,

	"amount_minor" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	-- The gateway's own fee for handling the dispute. Charged whether or not the
	-- dispute is won, which is why it is separate from the amount at risk.
	"gateway_fee_minor" integer,

	"reason_code" text,
	"reason" text NOT NULL,

	"opened_at" timestamp with time zone NOT NULL,
	-- THE DEADLINE. Indexed with the status below, because "which defences are
	-- about to lapse" must be one query and not a scan somebody remembers to run.
	"evidence_due_at" timestamp with time zone,
	"evidence_submitted_at" timestamp with time zone,
	-- References to what was submitted — never the documents themselves.
	"evidence" jsonb,

	"owner_user_id" integer,
	"owner_role" text,

	"resolution" text,
	"resolved_at" timestamp with time zone,
	-- What MMAKF actually kept. Distinct from amount_minor: a partially upheld
	-- dispute returns some of it, and "won" with a fee deducted is not a full win.
	"outcome_amount_minor" integer,

	"task_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "disputes_amount_positive" CHECK ("amount_minor" > 0)
);
--> statement-breakpoint

-- ── Routing ─────────────────────────────────────────────────────────────────

CREATE TABLE "payment_routing_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	-- Lowest first. Ties broken by id, so the order is total and a rule set
	-- cannot route differently on two evaluations of the same inputs.
	"priority" integer DEFAULT 100 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,

	-- Every criterion is NULL-means-any. A rule with all of them null is the
	-- catch-all, and is the only kind of rule that should carry a high priority
	-- number.
	"currency" text,
	"country" text,
	"method" text,
	"customer_type" text,
	"min_amount_minor" integer,
	"max_amount_minor" integer,

	"gateway" text NOT NULL,
	"fallback_gateway" text,
	-- When true, a gateway observed `down` is skipped and the fallback is used.
	-- Health NEVER promotes a gateway that has no credentials.
	"require_healthy" boolean DEFAULT true NOT NULL,

	"notes" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_routing_rules_band" CHECK (
		"min_amount_minor" IS NULL OR "max_amount_minor" IS NULL
		OR "min_amount_minor" < "max_amount_minor"
	)
);
--> statement-breakpoint

CREATE TABLE "gateway_health" (
	"id" serial PRIMARY KEY NOT NULL,
	"gateway" text NOT NULL,
	"status" "gateway_health_status" DEFAULT 'unknown' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"degraded_since" timestamp with time zone,
	"note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- ── Keys and indexes ────────────────────────────────────────────────────────

ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_payment_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_intents" ADD CONSTRAINT "payment_intents_user_fk" FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "payment_intents_ref_uk" ON "payment_intents" ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_intents_idempotency_uk" ON "payment_intents" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
-- One live intent per order. A second checkout for an order that is already
-- paid, or already has a checkout open, cannot begin.
CREATE UNIQUE INDEX "payment_intents_live_order_uk" ON "payment_intents" ("order_id") WHERE "status" IN ('open', 'succeeded');--> statement-breakpoint
CREATE INDEX "payment_intents_status_idx" ON "payment_intents" ("status", "created_at");--> statement-breakpoint

ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_intent_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."payment_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_rule_fk" FOREIGN KEY ("routing_rule_id") REFERENCES "public"."payment_routing_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- THE CONSTRAINT THE FAILOVER STORY RESTS ON. At most one succeeded attempt per
-- intent, enforced by the engine rather than by a check-then-write that loses
-- the race it exists to win.
CREATE UNIQUE INDEX "payment_attempts_one_success_uk" ON "payment_attempts" ("intent_id") WHERE "outcome" = 'succeeded';--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_no_uk" ON "payment_attempts" ("intent_id", "attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_attempts_idempotency_uk" ON "payment_attempts" ("idempotency_key") WHERE "idempotency_key" IS NOT NULL;--> statement-breakpoint
-- One gateway payment id belongs to one attempt. Recording the same gateway
-- payment against two attempts would double-count it in every report after.
CREATE UNIQUE INDEX "payment_attempts_gateway_payment_uk" ON "payment_attempts" ("gateway", "gateway_payment_id") WHERE "gateway_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payment_attempts_intent_idx" ON "payment_attempts" ("intent_id", "attempt_no");--> statement-breakpoint
CREATE INDEX "payment_attempts_gateway_idx" ON "payment_attempts" ("gateway", "outcome", "started_at");--> statement-breakpoint

CREATE UNIQUE INDEX "gateway_transactions_uk" ON "gateway_transactions" ("gateway", "gateway_txn_id");--> statement-breakpoint
CREATE INDEX "gateway_transactions_payment_idx" ON "gateway_transactions" ("gateway", "gateway_payment_id");--> statement-breakpoint
CREATE INDEX "gateway_transactions_ref_idx" ON "gateway_transactions" ("merchant_ref");--> statement-breakpoint
CREATE INDEX "gateway_transactions_period_idx" ON "gateway_transactions" ("gateway", "currency", "occurred_at");--> statement-breakpoint
CREATE INDEX "gateway_transactions_settled_idx" ON "gateway_transactions" ("gateway", "settled_at");--> statement-breakpoint

ALTER TABLE "gateway_cost_rates" ADD CONSTRAINT "gateway_cost_rates_user_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gateway_cost_rates_lookup_idx" ON "gateway_cost_rates" ("gateway", "currency", "effective_from");--> statement-breakpoint

ALTER TABLE "reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_user_fk" FOREIGN KEY ("run_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_runs_ref_uk" ON "reconciliation_runs" ("ref");--> statement-breakpoint
CREATE INDEX "reconciliation_runs_period_idx" ON "reconciliation_runs" ("gateway", "period_start", "period_end");--> statement-breakpoint

ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_run_fk" FOREIGN KEY ("run_id") REFERENCES "public"."reconciliation_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_gwtxn_fk" FOREIGN KEY ("gateway_transaction_id") REFERENCES "public"."gateway_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_payment_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_settlement_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_refund_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_dispute_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."disputes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_items" ADD CONSTRAINT "reconciliation_items_task_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_items_run_idx" ON "reconciliation_items" ("run_id", "status");--> statement-breakpoint
-- The open-exceptions queue, which is the only view of this table anybody
-- should be working from.
CREATE INDEX "reconciliation_items_open_idx" ON "reconciliation_items" ("status", "resolved_at");--> statement-breakpoint
CREATE INDEX "reconciliation_items_key_idx" ON "reconciliation_items" ("exception_key");--> statement-breakpoint

ALTER TABLE "disputes" ADD CONSTRAINT "disputes_gwtxn_fk" FOREIGN KEY ("gateway_transaction_id") REFERENCES "public"."gateway_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_order_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_owner_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_task_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "disputes_ref_uk" ON "disputes" ("ref");--> statement-breakpoint
-- A gateway that redelivers a dispute notification must not open a second case
-- against the same claim.
CREATE UNIQUE INDEX "disputes_gateway_uk" ON "disputes" ("gateway", "gateway_dispute_id") WHERE "gateway_dispute_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "disputes_deadline_idx" ON "disputes" ("status", "evidence_due_at");--> statement-breakpoint
CREATE INDEX "disputes_payment_idx" ON "disputes" ("payment_id");--> statement-breakpoint
CREATE INDEX "disputes_owner_idx" ON "disputes" ("owner_user_id", "status");--> statement-breakpoint

ALTER TABLE "payment_routing_rules" ADD CONSTRAINT "payment_routing_rules_user_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_routing_rules_code_uk" ON "payment_routing_rules" ("code");--> statement-breakpoint
CREATE INDEX "payment_routing_rules_order_idx" ON "payment_routing_rules" ("active", "priority", "id");--> statement-breakpoint

CREATE UNIQUE INDEX "gateway_health_gateway_uk" ON "gateway_health" ("gateway");
