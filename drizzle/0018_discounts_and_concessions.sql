-- 0018 — discount and concession policy.
--
-- Hand-written, like every migration since 0004. drizzle.config.ts points at
-- src/db/schema.ts alone, so `drizzle-kit generate` sees one of the schema
-- files and would emit DROP TABLE for the rest. See the note at the top of
-- 0007 for what happened the last time generated and hand-written statements
-- were mixed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A DISCOUNT AND A CONCESSION ARE TWO SEPARATE MODELS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A DISCOUNT is commercial. Volume, early registration, a renewal, a launch
-- campaign. It is offered to a market, redeemed with a code, counted, capped,
-- and reported on. Nothing about it is private.
--
-- A CONCESSION is a decision about one person's circumstances. A student rate,
-- a hardship award, a sibling reduction. It is applied for, it carries a
-- statement somebody wrote about their own life, it is decided by a named
-- officer, and it must NEVER appear in a marketing report.
--
-- Modelling both as "a reduction with a reason" would be tidier and wrong. They
-- need different approval authority — see 'quote:approve' against
-- 'concession:decide' in src/lib/rbac.ts — and different audit sensitivity, and
-- the moment they share a table somebody writes `SELECT ... GROUP BY reason`
-- for a campaign report and a family's hardship case is in it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FILE DOES NOT CONTAIN
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Not one percentage, not one rupee, not one code. MMAKF has approved no
-- discount policy and no concession policy, so both ship EMPTY — exactly as the
-- fee framework does, and for the same reason. A "reasonable" 10% student
-- discount seeded here would be this project inventing the federation's own
-- commercial policy, which is the one thing it must never do.

-- ─── Vocabulary ─────────────────────────────────────────────────────────────
--
-- The four enums whose names end in `status` are checked by
-- tests/status-dictionary.test.ts against src/lib/status.ts, so every label
-- below is one the dictionary already defines. A new word would render as a
-- bare grey chip beside statuses that carry a tone and a meaning.
--
-- `exhausted` is deliberately NOT a code status. Whether a code has run out is
-- derived from redeemed_count against max_redemptions; storing it as well
-- creates a second version of the same fact that can disagree with the first.

CREATE TYPE "public"."discount_policy_status" AS ENUM('draft', 'published', 'superseded', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."discount_code_status" AS ENUM('draft', 'active', 'suspended', 'expired', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."discount_approval_status" AS ENUM('pending', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."concession_policy_status" AS ENUM('draft', 'published', 'superseded', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."concession_application_status" AS ENUM('draft', 'submitted', 'under_review', 'information_requested', 'approved', 'rejected', 'withdrawn', 'expired', 'revoked');--> statement-breakpoint

-- Taxonomies, not lifecycles. None of these names ends in `status`, so the
-- dictionary correctly ignores them — a basis is not a state a thing is in.
CREATE TYPE "public"."reduction_basis" AS ENUM('fixed_amount', 'percentage');--> statement-breakpoint
CREATE TYPE "public"."reduction_stage" AS ENUM('before_tax', 'after_tax');--> statement-breakpoint
CREATE TYPE "public"."reduction_source" AS ENUM('fee_rule', 'discount', 'concession');--> statement-breakpoint
CREATE TYPE "public"."discount_subject_kind" AS ENUM('institution', 'person', 'audience', 'state_unit', 'district_unit', 'dojo', 'service');--> statement-breakpoint
CREATE TYPE "public"."discount_approval_action" AS ENUM('publish_policy', 'issue_code', 'apply_to_quote');--> statement-breakpoint
CREATE TYPE "public"."concession_category" AS ENUM('student', 'hardship', 'sibling', 'disability', 'service_family', 'bereavement', 'other');--> statement-breakpoint
CREATE TYPE "public"."concession_decision" AS ENUM('approved', 'rejected', 'information_requested', 'revoked');--> statement-breakpoint

-- ─── Commercial discounts ───────────────────────────────────────────────────

CREATE TABLE "discount_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"version" integer NOT NULL,
	"status" "discount_policy_status" DEFAULT 'draft' NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"currency" text DEFAULT 'INR' NOT NULL,
	"notes" text,
	"created_by_user_id" integer,
	"published_at" timestamp with time zone,
	"published_by_user_id" integer,
	"superseded_by_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- The arithmetic of one discount.
--
-- amount_minor is a POSITIVE magnitude — the size of the reduction, not a
-- negative price. Storing it negative works right up until somebody writes
-- `amount_minor > 0` in a report and silently excludes every discount there is.
-- The sign is applied once, in computeFee(), where the line is built.
--
-- percent_ppm is parts-per-million of the running total, matching the fee
-- engine: 100000 is 10%. A float percentage reintroduces exactly the rounding
-- src/db/fees.ts exists to avoid, and applyFactor() is the only multiplier in
-- this codebase.
CREATE TABLE "discount_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"policy_id" integer NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"basis" "reduction_basis" NOT NULL,
	"stage" "reduction_stage" DEFAULT 'before_tax' NOT NULL,
	"amount_minor" integer,
	"percent_ppm" integer,
	"max_reduction_minor" integer,
	"min_subtotal_minor" integer,
	"audience" "audience_kind",
	"service_id" integer,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stackable" boolean DEFAULT false NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- A rule is one basis or the other, never both and never neither. Enforced
	-- here rather than only in application code because a rule with no amount
	-- and no percentage prices nothing while looking configured.
	CONSTRAINT "discount_rules_basis_ck" CHECK (
		("basis" = 'fixed_amount' AND "amount_minor" IS NOT NULL AND "percent_ppm" IS NULL)
		OR ("basis" = 'percentage' AND "percent_ppm" IS NOT NULL AND "amount_minor" IS NULL)
	),
	CONSTRAINT "discount_rules_amount_ck" CHECK ("amount_minor" IS NULL OR "amount_minor" > 0),
	-- Above 1000000 ppm a "discount" would exceed the whole amount, which is not
	-- a discount but a payment to the customer.
	CONSTRAINT "discount_rules_percent_ck" CHECK ("percent_ppm" IS NULL OR ("percent_ppm" > 0 AND "percent_ppm" <= 1000000)),
	CONSTRAINT "discount_rules_cap_ck" CHECK ("max_reduction_minor" IS NULL OR "max_reduction_minor" > 0)
);
--> statement-breakpoint

-- The token a client may supply.
--
-- A code is SEPARATE from the rule it grants, so the same commercial rule can
-- be issued to three campaigns with three caps and three expiry dates, and one
-- campaign can be suspended without touching the other two or the rule.
CREATE TABLE "discount_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"code" text NOT NULL,
	"status" "discount_code_status" DEFAULT 'draft' NOT NULL,
	"valid_from" timestamp with time zone,
	"valid_to" timestamp with time zone,
	"max_redemptions" integer,
	"max_per_subject" integer,
	"redeemed_count" integer DEFAULT 0 NOT NULL,
	"issued_by_user_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_codes_count_ck" CHECK ("redeemed_count" >= 0),
	CONSTRAINT "discount_codes_cap_ck" CHECK ("max_redemptions" IS NULL OR "max_redemptions" > 0),
	CONSTRAINT "discount_codes_subject_cap_ck" CHECK ("max_per_subject" IS NULL OR "max_per_subject" > 0)
);
--> statement-breakpoint

-- Who a code is for.
--
-- NO ROWS MEANS NO RESTRICTION BEYOND THE CODE ITSELF, which is the honest
-- reading of a marketing code: the code is the gate. Any row present narrows
-- it, and the subject must then match at least one.
CREATE TABLE "discount_eligibility" (
	"id" serial PRIMARY KEY NOT NULL,
	"code_id" integer NOT NULL,
	"subject_kind" "discount_subject_kind" NOT NULL,
	"subject_id" integer,
	"subject_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Exactly one of the two. An eligibility row that names neither matches
	-- nothing and one that names both is ambiguous; both are configuration
	-- mistakes that would present as "the code does not work".
	CONSTRAINT "discount_eligibility_subject_ck" CHECK (
		("subject_id" IS NOT NULL AND "subject_value" IS NULL)
		OR ("subject_id" IS NULL AND "subject_value" IS NOT NULL)
	)
);
--> statement-breakpoint

-- A redemption that actually happened.
--
-- Not folded into a counter on discount_codes, although the counter is kept
-- there too. A counter cannot answer "who used it", cannot enforce a per-subject
-- cap, and cannot be made idempotent — and a webhook or a retried request that
-- increments it twice has overcounted a campaign with no way to find the
-- duplicate. The unique index below is what makes recording a redemption safe
-- to repeat.
CREATE TABLE "discount_redemptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"code_id" integer NOT NULL,
	"quote_version_id" integer,
	"institution_id" integer,
	"person_id" integer,
	"amount_minor" integer NOT NULL,
	"recorded_by_user_id" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "discount_redemptions_amount_ck" CHECK ("amount_minor" >= 0)
);
--> statement-breakpoint

-- The second pair of eyes, recorded.
--
-- decided_by <> requested_by is a database CHECK rather than only an
-- application rule, because the whole value of an approval is that it was
-- somebody else. A row asserting a person approved their own discount is not a
-- weaker approval, it is a false record, and the database should refuse to hold
-- one.
CREATE TABLE "discount_approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"policy_id" integer NOT NULL,
	"rule_id" integer,
	"code_id" integer,
	"quote_version_id" integer,
	"action" "discount_approval_action" NOT NULL,
	"status" "discount_approval_status" DEFAULT 'pending' NOT NULL,
	"requested_by_user_id" integer,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text,
	"decided_by_user_id" integer,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	CONSTRAINT "discount_approvals_self_ck" CHECK (
		"decided_by_user_id" IS NULL
		OR "requested_by_user_id" IS NULL
		OR "decided_by_user_id" <> "requested_by_user_id"
	)
);
--> statement-breakpoint

-- ─── Concessions ────────────────────────────────────────────────────────────
--
-- Everything below this line is about a person's circumstances. It is a
-- separate model with separate authority and it is not joined to anything
-- above.

-- A concession policy carries its own arithmetic rather than pointing at a
-- discount rule.
--
-- That is not duplication for its own sake: a concession has no code, no usage
-- cap, no campaign and no market. It has a category, an evidence requirement
-- and a confidentiality flag, none of which a commercial rule has. Sharing the
-- table would mean every one of those columns sat null on every marketing rule
-- and every marketing column sat null here.
CREATE TABLE "concession_policies" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"version" integer NOT NULL,
	"status" "concession_policy_status" DEFAULT 'draft' NOT NULL,
	"category" "concession_category" NOT NULL,
	"basis" "reduction_basis" NOT NULL,
	"stage" "reduction_stage" DEFAULT 'before_tax' NOT NULL,
	"amount_minor" integer,
	"percent_ppm" integer,
	"max_reduction_minor" integer,
	"requires_evidence" boolean DEFAULT true NOT NULL,
	"evidence_guidance" text,
	-- Defaults TRUE. A concession is confidential unless the federation decides
	-- a particular one is not, rather than public unless somebody remembers to
	-- tick a box.
	"confidential" boolean DEFAULT true NOT NULL,
	"max_awards" integer,
	"effective_from" date,
	"effective_to" date,
	"currency" text DEFAULT 'INR' NOT NULL,
	"notes" text,
	"created_by_user_id" integer,
	"published_at" timestamp with time zone,
	"published_by_user_id" integer,
	"superseded_by_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concession_policies_basis_ck" CHECK (
		("basis" = 'fixed_amount' AND "amount_minor" IS NOT NULL AND "percent_ppm" IS NULL)
		OR ("basis" = 'percentage' AND "percent_ppm" IS NOT NULL AND "amount_minor" IS NULL)
	),
	CONSTRAINT "concession_policies_amount_ck" CHECK ("amount_minor" IS NULL OR "amount_minor" > 0),
	CONSTRAINT "concession_policies_percent_ck" CHECK ("percent_ppm" IS NULL OR ("percent_ppm" > 0 AND "percent_ppm" <= 1000000)),
	CONSTRAINT "concession_policies_cap_ck" CHECK ("max_reduction_minor" IS NULL OR "max_reduction_minor" > 0)
);
--> statement-breakpoint

-- One person asking for one concession.
--
-- `stated_circumstance` is the sensitive column in this whole migration: it is
-- where somebody writes that they cannot afford the fee. `evidence_ref` is a
-- REFERENCE to a document held elsewhere, never the document — a hardship
-- letter does not belong in a row that a reporting query might widen onto.
--
-- The AWARD is frozen onto the application at decision time. A concession
-- granted under the 2026 policy keeps its 2026 terms even after the policy is
-- superseded, for the same reason a quote keeps its framework version.
CREATE TABLE "concession_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"policy_id" integer NOT NULL,
	"person_id" integer,
	"institution_id" integer,
	"request_id" integer,
	"status" "concession_application_status" DEFAULT 'draft' NOT NULL,
	"stated_circumstance" text,
	"evidence_ref" text,
	"submitted_by_user_id" integer,
	"submitted_at" timestamp with time zone,
	"valid_from" date,
	"valid_to" date,
	"awarded_basis" "reduction_basis",
	"awarded_amount_minor" integer,
	"awarded_percent_ppm" integer,
	"awarded_max_reduction_minor" integer,
	"awarded_stage" "reduction_stage",
	"decided_at" timestamp with time zone,
	"confidential" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concession_applications_award_ck" CHECK (
		"awarded_basis" IS NULL
		OR ("awarded_basis" = 'fixed_amount' AND "awarded_amount_minor" IS NOT NULL AND "awarded_percent_ppm" IS NULL)
		OR ("awarded_basis" = 'percentage' AND "awarded_percent_ppm" IS NOT NULL AND "awarded_amount_minor" IS NULL)
	),
	CONSTRAINT "concession_applications_amount_ck" CHECK ("awarded_amount_minor" IS NULL OR "awarded_amount_minor" > 0),
	CONSTRAINT "concession_applications_percent_ck" CHECK ("awarded_percent_ppm" IS NULL OR ("awarded_percent_ppm" > 0 AND "awarded_percent_ppm" <= 1000000))
);
--> statement-breakpoint

-- The decision log. APPEND-ONLY, like rank_records: a concession that was
-- granted and later revoked is two rows, not one row edited, because "was this
-- ever awarded?" is a question somebody will ask after it has been withdrawn.
--
-- `reason` is NOT NULL. A refusal nobody can explain to the applicant is worse
-- than no process at all.
CREATE TABLE "concession_approvals" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL,
	"decision" "concession_decision" NOT NULL,
	"decided_by_user_id" integer NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reason" text NOT NULL,
	"authority" text
);
--> statement-breakpoint

-- ─── Foreign keys ───────────────────────────────────────────────────────────

ALTER TABLE "discount_policies" ADD CONSTRAINT "discount_policies_published_by_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_policies" ADD CONSTRAINT "discount_policies_created_by_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_rules" ADD CONSTRAINT "discount_rules_policy_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."discount_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_rules" ADD CONSTRAINT "discount_rules_service_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_rule_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."discount_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_codes" ADD CONSTRAINT "discount_codes_issued_by_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_eligibility" ADD CONSTRAINT "discount_eligibility_code_fk" FOREIGN KEY ("code_id") REFERENCES "public"."discount_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_code_fk" FOREIGN KEY ("code_id") REFERENCES "public"."discount_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_quote_version_fk" FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_redemptions" ADD CONSTRAINT "discount_redemptions_person_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_policy_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."discount_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_rule_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."discount_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_code_fk" FOREIGN KEY ("code_id") REFERENCES "public"."discount_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discount_approvals" ADD CONSTRAINT "discount_approvals_quote_version_fk" FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concession_policies" ADD CONSTRAINT "concession_policies_published_by_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concession_policies" ADD CONSTRAINT "concession_policies_created_by_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concession_applications" ADD CONSTRAINT "concession_applications_policy_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."concession_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concession_applications" ADD CONSTRAINT "concession_applications_person_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concession_applications" ADD CONSTRAINT "concession_applications_institution_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concession_applications" ADD CONSTRAINT "concession_applications_request_fk" FOREIGN KEY ("request_id") REFERENCES "public"."training_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concession_applications" ADD CONSTRAINT "concession_applications_submitted_by_fk" FOREIGN KEY ("submitted_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concession_approvals" ADD CONSTRAINT "concession_approvals_application_fk" FOREIGN KEY ("application_id") REFERENCES "public"."concession_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "concession_approvals" ADD CONSTRAINT "concession_approvals_decided_by_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ─── Indexes ────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "discount_policies_code_uk" ON "discount_policies" USING btree ("code");--> statement-breakpoint
CREATE INDEX "discount_policies_status_idx" ON "discount_policies" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "discount_rules_code_uk" ON "discount_rules" USING btree ("policy_id","code");--> statement-breakpoint
CREATE INDEX "discount_rules_policy_idx" ON "discount_rules" USING btree ("policy_id","priority");--> statement-breakpoint
-- Codes are compared case-insensitively by storing them normalised. The unique
-- index is on the stored form, so SCHOOL26 and school26 cannot both exist and
-- then behave differently depending on which one somebody typed.
CREATE UNIQUE INDEX "discount_codes_code_uk" ON "discount_codes" USING btree ("code");--> statement-breakpoint
CREATE INDEX "discount_codes_rule_idx" ON "discount_codes" USING btree ("rule_id","status");--> statement-breakpoint
CREATE INDEX "discount_eligibility_code_idx" ON "discount_eligibility" USING btree ("code_id","subject_kind");--> statement-breakpoint
-- At most ONE redemption of a code against a quote version. This is what makes
-- recordRedemption() safe to call twice — the second insert conflicts and is
-- discarded rather than inflating the campaign count.
CREATE UNIQUE INDEX "discount_redemptions_quote_uk" ON "discount_redemptions" USING btree ("code_id","quote_version_id") WHERE "quote_version_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "discount_redemptions_code_idx" ON "discount_redemptions" USING btree ("code_id","at");--> statement-breakpoint
CREATE INDEX "discount_redemptions_subject_idx" ON "discount_redemptions" USING btree ("institution_id","person_id");--> statement-breakpoint
CREATE INDEX "discount_approvals_policy_idx" ON "discount_approvals" USING btree ("policy_id","status");--> statement-breakpoint
CREATE INDEX "discount_approvals_pending_idx" ON "discount_approvals" USING btree ("status","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "concession_policies_code_uk" ON "concession_policies" USING btree ("code");--> statement-breakpoint
CREATE INDEX "concession_policies_status_idx" ON "concession_policies" USING btree ("status","category");--> statement-breakpoint
CREATE UNIQUE INDEX "concession_applications_ref_uk" ON "concession_applications" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "concession_applications_status_idx" ON "concession_applications" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "concession_applications_person_idx" ON "concession_applications" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "concession_approvals_application_idx" ON "concession_approvals" USING btree ("application_id","decided_at");--> statement-breakpoint

-- ─── The quote line learns where its reduction came from ────────────────────
--
-- Without these columns a concession and a campaign discount are the same row:
-- kind = 'discount', a label, a negative amount. A marketing report would then
-- have no way to exclude hardship cases except by matching on the label text,
-- which is not a way at all.
--
-- `reduction_stage` is stored so reproduce() can rebuild the exact reduction it
-- applied. A reduction is a decision taken at issue time and frozen with the
-- quote, exactly like the inputs — re-resolving a code four years later would
-- find it expired and quietly produce a different total.
ALTER TABLE "quote_lines" ADD COLUMN IF NOT EXISTS "source_kind" "reduction_source" DEFAULT 'fee_rule' NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN IF NOT EXISTS "reduction_stage" "reduction_stage";--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN IF NOT EXISTS "discount_code_id" integer;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN IF NOT EXISTS "concession_application_id" integer;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_discount_code_fk" FOREIGN KEY ("discount_code_id") REFERENCES "public"."discount_codes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_concession_application_fk" FOREIGN KEY ("concession_application_id") REFERENCES "public"."concession_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quote_lines_source_idx" ON "quote_lines" USING btree ("source_kind");--> statement-breakpoint

-- The two totals a report needs kept apart.
--
-- adjustment_minor already holds every reduction added together, which is right
-- for the arithmetic and useless for the question "what did our campaigns cost
-- us?". Splitting them here means a marketing report never has to touch a
-- concession row to work out its own number.
--
-- Both are stored NEGATIVE, matching adjustment_minor, so subtotal + adjustment
-- + tax = total continues to hold.
ALTER TABLE "quote_versions" ADD COLUMN IF NOT EXISTS "discount_minor" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN IF NOT EXISTS "concession_minor" integer DEFAULT 0 NOT NULL;
