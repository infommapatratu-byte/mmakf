-- 0019 — entitlements: the link between a verified payment and the thing bought.
--
-- WHAT WAS MISSING. The commerce spine could take money, reconcile it, post it
-- to the ledger and issue a receipt — and then stop. Nothing turned a captured
-- membership fee into a row in the register, an entry fee into a cleared entry,
-- or a booking fee into a confirmed booking. The payer's card was debited and
-- the federation issued them nothing; the only record that they had bought
-- anything at all was an order line nobody acted on.
--
-- WHAT AN ENTITLEMENT IS. One row per PAID ORDER LINE, naming the thing the
-- payment activated. It is the join nobody could previously make: from a rupee
-- to a credential, and back again from a credential to the rupee that paid for
-- it and the receipt that proves it.
--
-- THE RULE THE SCHEMA ENFORCES, not merely promises:
--
--  · ONE ENTITLEMENT PER ORDER LINE, by a UNIQUE index on order_line_id. This
--    is the replay guard, and it is deliberately in the database rather than in
--    a check-then-insert in application code. A gateway retries its webhooks and
--    the reconcile cron retries them again; two of those arriving together both
--    read "no entitlement yet", and only a constraint can settle which one wins.
--    The loser's whole transaction rolls back, so the membership it was about to
--    issue is never issued.
--
--  · ONE ACTIVE ENTITLEMENT PER SUBJECT, by a PARTIAL unique index over
--    (subject, subject_id) WHERE status = 'active'. A second order must not
--    financially clear an entry that is already cleared. It is partial because a
--    revoked entitlement keeps its subject for ever — that is the history — and
--    a blocked one has no subject at all.
--
--  · payment_id IS NOT NULL. An entitlement cannot exist without the payment
--    that bought it. The whole defect class this table exists to prevent is
--    something being activated on a browser's say-so, and a nullable column
--    would leave the door open for a caller with good intentions and a hurry.
--
-- NOTHING IS EVER DELETED. A refund does not remove the row; it sets
-- status = 'revoked' with revoked_at, the reason and the refund that caused it.
-- A refunded membership is a revoked membership with a history, not an absent
-- one — the person still holds the certificate they were sent, and a register
-- that has forgotten the transaction cannot explain why it is no longer valid.
--
-- 'blocked' IS A REAL OUTCOME, NOT AN ERROR. Money is captured before this
-- system gets to decide whether the thing bought can be activated: the entry
-- may have become ineligible, the person record may be missing, the federation
-- may not have configured the membership term. Refusing to record anything in
-- those cases would leave money taken with no trace of what it was for. The row
-- is written with status 'blocked' and a reason, so the finance desk can see it
-- and refund it. Payment does not override eligibility, and silence is not an
-- answer.

CREATE TYPE "public"."entitlement_subject" AS ENUM('membership', 'event_entry', 'grading', 'booking', 'course', 'certificate', 'document');--> statement-breakpoint
CREATE TYPE "public"."entitlement_status" AS ENUM('active', 'blocked', 'revoked');--> statement-breakpoint

-- ── What a fee entitles the payer to ───────────────────────────────────────
--
-- The fee schedule says what a membership COSTS. It has never said what it
-- BUYS: which category of membership, and for how long. Both are federation
-- policy, and neither is derivable from the fee code without inventing it —
-- parsing 'membership.athlete.annual' into "an athlete membership lasting
-- twelve months" would be this system deciding MMAKF's terms by string match.
--
-- So the term is configured here, and where it is not configured the payment
-- produces a BLOCKED entitlement naming exactly what is missing. That is the
-- same rule the fee schedule already follows: an unpublished fee is reported as
-- unpublished rather than charged as zero. An unconfigured TERM is reported as
-- unconfigured rather than issued as twelve months nobody approved.
--
-- open_ended is a stated decision, not the absence of one. A membership with no
-- recorded expiry is a real thing in this register (see src/db/membership.ts),
-- and it must be distinguishable from a term somebody forgot to fill in.
CREATE TABLE "entitlement_terms" (
	"id" serial PRIMARY KEY NOT NULL,
	"fee_code" text NOT NULL,
	"subject" "entitlement_subject" NOT NULL,
	"membership_category" "membership_category",
	"term_months" integer,
	"open_ended" boolean DEFAULT false NOT NULL,
	"notes" text,
	"approved_by" text,
	"set_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "entitlements" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject" "entitlement_subject" NOT NULL,
	-- Null while blocked: the row records that a payment bought something the
	-- federation could not yet issue, and inventing an id for it would be a lie.
	"subject_id" integer,
	"order_id" integer NOT NULL,
	"order_line_id" integer NOT NULL,
	"payment_id" integer NOT NULL,
	"invoice_id" integer,
	-- WHICH published fee priced this, verbatim. Never derived at read time: a
	-- later fee change must not retell what somebody was charged in 2026.
	"fee_version" text,
	"status" "entitlement_status" DEFAULT 'active' NOT NULL,
	"activated_at" timestamp with time zone,
	-- The label of whoever the system was ACTING AS. For the ordinary path that
	-- is the entitlement service itself, because no human is present when a
	-- webhook arrives at 3am, and recording a person who was not there would be
	-- worse than recording the machine that was.
	"activated_by" text,
	"activated_by_user_id" integer,
	"revoked_at" timestamp with time zone,
	"refund_id" integer,
	-- Why it is blocked, or why it was revoked. Never optional in practice:
	-- both states are refusals, and a refusal nobody can explain is not one.
	"reason" text,
	-- The evidence behind the decision — the eligibility checks that were
	-- re-run, the term that was applied, the standing that was read. Frozen,
	-- because the rules it was judged against can change afterwards.
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- THE REPLAY GUARD. Not a nicety: this is the constraint that makes a webhook
-- retry, a cron retry and a double-clicked button produce one membership.
CREATE UNIQUE INDEX "entitlements_order_line_uk" ON "entitlements" USING btree ("order_line_id");--> statement-breakpoint
-- One live claim on a given subject. Partial, so revoked history and blocked
-- rows with no subject at all do not collide with one another.
CREATE UNIQUE INDEX "entitlements_subject_active_uk" ON "entitlements" USING btree ("subject","subject_id") WHERE "status" = 'active' AND "subject_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "entitlements_order_idx" ON "entitlements" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "entitlements_payment_idx" ON "entitlements" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "entitlements_status_idx" ON "entitlements" USING btree ("status","subject");--> statement-breakpoint
CREATE UNIQUE INDEX "entitlement_terms_fee_code_uk" ON "entitlement_terms" USING btree ("fee_code");
