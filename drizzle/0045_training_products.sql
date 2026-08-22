-- 0045 — the training product, the training plan, and the right to train.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT WAS MISSING, AND WHY IT IS THE MOST IMPORTANT GAP IN THE SCHEMA
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT. They pay for
-- TRAINING. The federation withdrew student membership, and until this migration
-- there was nowhere for the thing that replaces it to live.
--
-- 0023 built the entitlement spine: a verified capture becomes a membership, a
-- cleared competition entry or a confirmed booking. 0039 added the institutional
-- training PROGRAMME — a school or a company buying a block of delivery. Neither
-- can express what a child's parent buys on a Tuesday: `entitlements` has no
-- person, no club, no discipline and no price version, and `entitlement_subject`
-- has no term for training.
--
-- The consequence, before this migration, was that the only object in the
-- database a student could be attached to was a MEMBERSHIP — which is exactly
-- the object the federation said they must not have to buy. A system with
-- nowhere else to put them puts them there, and then somebody writes "if
-- membership unpaid then deny training" because it is the only join available.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FOUR TABLES, AND WHAT EACH ONE IS FOR
-- ─────────────────────────────────────────────────────────────────────────────
--
--   training_products      what is on offer. Discipline, programme, age group,
--                          skill level, club, location, coach category,
--                          frequency, duration, capacity, validity. NO PRICE.
--   training_plans         what a person committed to. The commercial object,
--                          and it exists before any money moves.
--   training_entitlements  the right to train, for an explicit period, bought
--                          with an identified payment at an identified PRICE
--                          VERSION. THE ONLY THING THAT DECIDES ACCESS.
--   training_enrolments    who is on which club's roll. A person may be on
--                          several, and a transfer moves the enrolment without
--                          ever duplicating the person.
--
-- NONE OF THEM IS CALLED A SUBSCRIPTION, deliberately and at the federation's
-- explicit instruction. A person has to be able to read their own invoice and
-- know what they bought.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE SEPARATION THIS MIGRATION IS BUILT TO GUARANTEE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- THERE IS NO FOREIGN KEY BETWEEN ANY TABLE HERE AND `memberships`, in either
-- direction. Not a nullable one, not a "for convenience" one. Membership remains
-- a real domain for coaches, officials, examiners and clubs; it simply has no
-- edge to training. The check that must never be written has nothing to be
-- written against, which is a stronger guarantee than a code review.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- AND THE ONE THING THIS MIGRATION WILL NOT DO
-- ─────────────────────────────────────────────────────────────────────────────
--
-- IT SEEDS NOTHING AND IT CONTAINS NO AMOUNT. Not a rupee figure, not a
-- validity in days for a camp nobody has scheduled, not a starter product.
-- MMAKF has published no fee framework, so a product created here would be
-- unsellable, and a product with a plausible fee code would be this system
-- inventing the federation's own commercial catalogue. The tables ship EMPTY and
-- every surface reports that the federation has not published a fee for this —
-- which is true.

-- ── The vocabulary ─────────────────────────────────────────────────────────
--
-- Nine periods, and the federation named all nine. `per_session`, `camp`,
-- `course`, `intensive` and `custom_institutional` are the five whose LENGTH
-- only MMAKF can state — a month is arithmetic, a camp is a decision — and the
-- CHECK on `training_products` below is what stops one being sold without it.
CREATE TYPE "public"."training_period" AS ENUM(
  'monthly', 'quarterly', 'half_yearly', 'annual',
  'per_session', 'camp', 'course', 'intensive', 'custom_institutional'
);--> statement-breakpoint

-- `lapsed` is not `cancelled`. A plan whose term ran out is somebody a club may
-- reasonably invite back; a plan somebody cancelled is not. Collapsing them
-- would destroy the difference at exactly the moment a club wants it.
CREATE TYPE "public"."training_plan_status" AS ENUM(
  'proposed', 'active', 'lapsed', 'cancelled', 'completed'
);--> statement-breakpoint

-- NOT an auto-charge flag. Nothing in this system takes money without a fresh
-- server-verified capture, and MMAKF holds no mandate. This records the person's
-- stated intention, which is what a renewal notice is addressed on.
CREATE TYPE "public"."training_renewal_mode" AS ENUM('one_off', 'renewing');--> statement-breakpoint

CREATE TYPE "public"."training_enrolment_status" AS ENUM(
  'active', 'transferred', 'ended'
);--> statement-breakpoint

-- An order line that pays for a student's training.
--
-- ADD VALUE rather than a new enum: `order_line_kind` is what
-- entitlements.activationBacklog() filters on to find paid lines nothing was
-- issued against, and what postLedger() posts income under. Training billed as
-- 'other' would be invisible in the one query built to make an undelivered
-- purchase visible, and would land in the wrong income account.
--
-- Postgres 12 and later permit this inside a transaction provided the new value
-- is not USED in the same transaction. Nothing below inserts a row, so it is not.
ALTER TYPE "public"."order_line_kind" ADD VALUE IF NOT EXISTS 'training';--> statement-breakpoint

-- ── What is on offer ───────────────────────────────────────────────────────
--
-- READ THE COLUMN LIST FOR WHAT IS ABSENT. There is no `price_minor`, no
-- `monthly_fee`, no `from_amount` and no indicative range, and there never will
-- be: a product row is ONE ROW and one row holds ONE value, so a price here
-- would be rewritten by every future change and would take every historical
-- invoice with it. The amount lives in `fee_rules`, inside a versioned and
-- immutable `fee_frameworks` row, and is reached through `fee_code`.
--
-- tests/training-products.test.ts reads information_schema and fails if a column
-- that could hold money ever appears on this table, exactly as
-- tests/fee-catalogue.test.ts does for the catalogue. A comment is not an
-- enforcement mechanism; that test is.
CREATE TABLE "training_products" (
  "id" serial PRIMARY KEY NOT NULL,
  "code" text NOT NULL,
  "slug" text NOT NULL,
  "title" text NOT NULL,
  -- Stored normalised (lower case, single-spaced) by src/db/training-products.ts,
  -- so an access check comparing "Shotokan " to "shotokan" cannot turn a child
  -- away from a class their parent paid for.
  "discipline" text NOT NULL,
  "programme" text NOT NULL,
  "service_id" integer,
  "age_group_label" text,
  "age_min_years" integer,
  "age_max_years" integer,
  "skill_level" text,
  -- NULL means offered federation-wide rather than at one club.
  "club_id" integer,
  -- The FOREIGN KEY onto `venues` is declared at the foot of this file rather
  -- than in src/db/training-products.schema.ts. `venues` lives in
  -- operations.schema.ts, which schema.ts does not re-export, and importing it
  -- into the single schema entry point would drag the whole operations graph in
  -- behind it. The key is real; it is simply not declared twice.
  "venue_id" integer,
  "coach_category" text,
  "period" "training_period" NOT NULL,
  "sessions_per_period" integer,
  "session_duration_minutes" integer,
  -- Required for the five periods whose length MMAKF must state, forbidden for
  -- the four that are arithmetic. Both halves enforced below.
  "validity_days" integer,
  "capacity" integer,
  -- THE ONLY COLUMN HERE THAT TOUCHES MONEY, AND IT IS NOT AN AMOUNT. It says
  -- WHICH rule prices this. It cannot say what the rule costs.
  "fee_code" text NOT NULL,
  "status" "service_status" DEFAULT 'draft' NOT NULL,
  "summary" text,
  "description" text,
  "notes" text,
  "sort_order" integer DEFAULT 100 NOT NULL,
  "created_by_user_id" integer,
  "published_at" timestamp with time zone,
  "published_by_user_id" integer,
  "withdrawn_at" timestamp with time zone,
  "withdrawn_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "training_products_age_band_ck" CHECK (
    "age_min_years" IS NULL OR "age_max_years" IS NULL OR "age_max_years" >= "age_min_years"
  ),
  -- THE VALIDITY BICONDITIONAL, and it is the most important constraint in this
  -- file after the entitlement one.
  --
  -- A calendar period derives exactly: monthly is one month, annual is twelve.
  -- Stating days as well would be two lengths for one period, an ambiguity
  -- somebody would eventually resolve in the federation's favour or the
  -- student's, and neither is this system's to choose.
  --
  -- Everything else has a length only MMAKF can state. A camp with no validity
  -- is a product that can be SOLD and cannot be DELIVERED, and a default of
  -- thirty days would be federation policy set by a constant.
  CONSTRAINT "training_products_validity_ck" CHECK (
    (
      "period" IN ('monthly', 'quarterly', 'half_yearly', 'annual')
      AND "validity_days" IS NULL
    ) OR (
      "period" NOT IN ('monthly', 'quarterly', 'half_yearly', 'annual')
      AND "validity_days" IS NOT NULL AND "validity_days" >= 1
    )
  ),
  CONSTRAINT "training_products_counts_ck" CHECK (
    ("sessions_per_period" IS NULL OR "sessions_per_period" >= 1)
    AND ("session_duration_minutes" IS NULL OR "session_duration_minutes" >= 1)
    AND ("capacity" IS NULL OR "capacity" >= 1)
  )
);--> statement-breakpoint

-- ── What a person committed to ─────────────────────────────────────────────
CREATE TABLE "training_plans" (
  "id" serial PRIMARY KEY NOT NULL,
  "ref" text NOT NULL,
  "person_id" integer NOT NULL,
  "product_id" integer NOT NULL,
  "club_id" integer,
  "status" "training_plan_status" DEFAULT 'proposed' NOT NULL,
  -- FROZEN from the product when the plan is opened. A product edited in 2027
  -- must not re-describe what somebody agreed to in 2026.
  "period" "training_period" NOT NULL,
  "renewal_mode" "training_renewal_mode" DEFAULT 'one_off' NOT NULL,
  "starts_on" date NOT NULL,
  "ends_on" date,
  "ended_reason" text,
  "opened_by_user_id" integer,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "training_plans_period_ck" CHECK (
    "ends_on" IS NULL OR "ends_on" >= "starts_on"
  )
);--> statement-breakpoint

-- ── THE RIGHT TO TRAIN ─────────────────────────────────────────────────────
--
-- Nine facts, and every one of them is here so that somebody can answer a
-- question from this row alone years later:
--
--   person, programme, club, location, discipline   what was bought
--   valid_from / valid_until                        for how long
--   order, line, payment, invoice                   with what money
--   price framework id / code / version             under which rulebook edition
--
-- THE LAST ONE IS WHAT MAKES A HISTORICAL CHARGE DEFENSIBLE. A published fee
-- framework can never be altered, so naming the version is a permanent,
-- reproducible description of how the amount was arrived at. Without it, "why
-- was this school charged ₹4,80,000 in 2026?" is answerable only by guessing
-- which rules were in force, and the guess gets worse every year.
--
-- MOST COLUMNS ARE NULLABLE AND THE CHECK IS WHY. 'blocked' is an outcome, not
-- an exception: money arrives before this system can confirm that the federation
-- stated a period and published a price version, and where it has not, the row
-- is written with a REASON, grants nothing, and gives the finance desk something
-- to refund. Recording nothing would lose the fact that money was taken.
-- `training_entitlements_active_ck` is what stops that nullability leaking into
-- a live grant: an ACTIVE row must carry every one of them.
CREATE TABLE "training_entitlements" (
  "id" serial PRIMARY KEY NOT NULL,
  "plan_id" integer,
  "person_id" integer,
  "product_id" integer,
  -- Frozen copies, taken at grant time rather than joined at read time.
  "discipline" text,
  "programme" text,
  -- WHERE IT WAS BOUGHT. Never rewritten, not even by a transfer.
  "club_id" integer,
  -- Where it is currently delivered, set only by a transfer. NULL means: at
  -- `club_id`. Access reads coalesce(serviced_by_club_id, club_id), so a
  -- transferred student trains at the new club WITHOUT the record of the
  -- original purchase being edited. Correcting future delivery and editing an
  -- accounting record are different acts and this schema only permits the first.
  "serviced_by_club_id" integer,
  "venue_id" integer,
  "valid_from" date,
  -- The INCLUSIVE last day. There is no open-ended right to train: the federation
  -- sells training "for the period paid for", and a NULL here on an active row
  -- would grant the mat for ever on the strength of one payment.
  "valid_until" date,
  "status" "entitlement_status" DEFAULT 'active' NOT NULL,

  "order_id" integer NOT NULL,
  "order_line_id" integer NOT NULL,
  -- NOT NULL BY DESIGN. No server-verified payment, no right to train, ever.
  -- A browser posting "payment succeeded" cannot reach a code path that would.
  "payment_id" integer NOT NULL,
  "invoice_id" integer,

  "price_framework_id" integer,
  "price_framework_code" text,
  "price_framework_version" integer,
  "quote_version_id" integer,
  -- WHAT WAS ACTUALLY CHARGED, in integer paise. A HISTORICAL FACT, not a price:
  -- nothing reads it to decide what anything costs. It is here so the record can
  -- be reconciled against the ledger and defended without re-running anything,
  -- and so a future correction to pricing provably did not touch it.
  "amount_paid_minor" integer NOT NULL,
  "currency" text DEFAULT 'INR' NOT NULL,

  -- Renewal as a CHAIN rather than a flag, so the whole history of a person's
  -- training reads as a sequence of terms with their own dates and their own
  -- price versions.
  "renewed_from_entitlement_id" integer,
  "renewal_sequence" integer DEFAULT 1 NOT NULL,

  "granted_at" timestamp with time zone DEFAULT now() NOT NULL,
  "granted_by" text,
  "revoked_at" timestamp with time zone,
  "refund_id" integer,
  "reason" text,
  "detail" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "training_entitlements_period_ck" CHECK (
    "valid_from" IS NULL OR "valid_until" IS NULL OR "valid_until" >= "valid_from"
  ),
  -- THE CONSTRAINT THIS WHOLE TABLE IS BUILT AROUND.
  --
  -- An ACTIVE right to train must name who holds it, what they bought, when it
  -- starts, when it ENDS, and the rulebook edition it was priced under. Every
  -- one of those is a question somebody asks later, and a row that could not
  -- answer one of them would be a grant nobody can defend and nobody can expire.
  CONSTRAINT "training_entitlements_active_ck" CHECK (
    "status" <> 'active' OR (
      "person_id" IS NOT NULL
      AND "product_id" IS NOT NULL
      AND "discipline" IS NOT NULL
      AND "programme" IS NOT NULL
      AND "valid_from" IS NOT NULL
      AND "valid_until" IS NOT NULL
      AND "price_framework_id" IS NOT NULL
      AND "price_framework_code" IS NOT NULL
      AND "price_framework_version" IS NOT NULL
    )
  ),
  -- A revocation is a refusal and every refusal in this codebase carries a
  -- reason. "Why did my child's training stop?" is asked by a person, not a
  -- report.
  CONSTRAINT "training_entitlements_reason_ck" CHECK (
    "status" = 'active' OR "reason" IS NOT NULL
  ),
  CONSTRAINT "training_entitlements_amount_ck" CHECK ("amount_paid_minor" >= 0),
  CONSTRAINT "training_entitlements_sequence_ck" CHECK ("renewal_sequence" >= 1)
);--> statement-breakpoint

-- ── The roll ───────────────────────────────────────────────────────────────
--
-- ONE STUDENT IS NOT ONE CLUB FOR EVER. A child trains at their school's club
-- and at a weekend dojo; an adult moves city and keeps a link to the old club
-- for grading. `persons.dojo_id` can hold exactly one of those, and a transfer
-- implemented by overwriting it erases the fact that they were ever anywhere
-- else — which is the question a grading panel actually asks.
--
-- A TRANSFER MOVES THE ENROLMENT AND NEVER DUPLICATES THE PERSON. Both rows
-- carry the same `person_id`; src/db/training-products.ts contains no insert
-- into `persons` at all.
CREATE TABLE "training_enrolments" (
  "id" serial PRIMARY KEY NOT NULL,
  "person_id" integer NOT NULL,
  "club_id" integer NOT NULL,
  "status" "training_enrolment_status" DEFAULT 'active' NOT NULL,
  "joined_on" date NOT NULL,
  -- Set when they leave or transfer away. The row is never deleted.
  "ended_on" date,
  "transferred_from_id" integer,
  "transferred_to_id" integer,
  "transfer_reason" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "training_enrolments_period_ck" CHECK (
    "ended_on" IS NULL OR "ended_on" >= "joined_on"
  ),
  -- A closed enrolment has an end date and a live one does not. Without this a
  -- row could read 'transferred' with no end date, which is a student who is
  -- simultaneously at two clubs and at neither.
  CONSTRAINT "training_enrolments_closure_ck" CHECK (
    ("status" = 'active' AND "ended_on" IS NULL)
    OR ("status" <> 'active' AND "ended_on" IS NOT NULL)
  )
);--> statement-breakpoint

-- ── Foreign keys ───────────────────────────────────────────────────────────
--
-- NOT ONE OF THEM POINTS AT `memberships`. See the header.
-- NOT ONE OF THEM IS `ON DELETE CASCADE`. Expiry deletes nothing here, and a
-- cascade is a delete path somebody else can trigger from another table.
ALTER TABLE "training_products" ADD CONSTRAINT "training_products_service_id_fk"
  FOREIGN KEY ("service_id") REFERENCES "public"."services"("id");--> statement-breakpoint
ALTER TABLE "training_products" ADD CONSTRAINT "training_products_club_id_fk"
  FOREIGN KEY ("club_id") REFERENCES "public"."dojos"("id");--> statement-breakpoint
ALTER TABLE "training_products" ADD CONSTRAINT "training_products_venue_id_fk"
  FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id");--> statement-breakpoint
ALTER TABLE "training_products" ADD CONSTRAINT "training_products_created_by_fk"
  FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id");--> statement-breakpoint
ALTER TABLE "training_products" ADD CONSTRAINT "training_products_published_by_fk"
  FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id");--> statement-breakpoint

ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_person_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id");--> statement-breakpoint
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_product_id_fk"
  FOREIGN KEY ("product_id") REFERENCES "public"."training_products"("id");--> statement-breakpoint
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_club_id_fk"
  FOREIGN KEY ("club_id") REFERENCES "public"."dojos"("id");--> statement-breakpoint
ALTER TABLE "training_plans" ADD CONSTRAINT "training_plans_opened_by_fk"
  FOREIGN KEY ("opened_by_user_id") REFERENCES "public"."users"("id");--> statement-breakpoint

ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_plan_id_fk"
  FOREIGN KEY ("plan_id") REFERENCES "public"."training_plans"("id");--> statement-breakpoint
ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_person_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id");--> statement-breakpoint
ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_product_id_fk"
  FOREIGN KEY ("product_id") REFERENCES "public"."training_products"("id");--> statement-breakpoint
ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_club_id_fk"
  FOREIGN KEY ("club_id") REFERENCES "public"."dojos"("id");--> statement-breakpoint
ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_serviced_club_fk"
  FOREIGN KEY ("serviced_by_club_id") REFERENCES "public"."dojos"("id");--> statement-breakpoint
ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_venue_id_fk"
  FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id");--> statement-breakpoint
ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_order_id_fk"
  FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id");--> statement-breakpoint
ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_order_line_id_fk"
  FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id");--> statement-breakpoint
ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_payment_id_fk"
  FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id");--> statement-breakpoint
ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_invoice_id_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id");--> statement-breakpoint
ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_framework_fk"
  FOREIGN KEY ("price_framework_id") REFERENCES "public"."fee_frameworks"("id");--> statement-breakpoint
ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_quote_version_fk"
  FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id");--> statement-breakpoint
ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_refund_id_fk"
  FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id");--> statement-breakpoint
-- The renewal chain, self-referencing.
ALTER TABLE "training_entitlements" ADD CONSTRAINT "training_entitlements_renewed_from_fk"
  FOREIGN KEY ("renewed_from_entitlement_id") REFERENCES "public"."training_entitlements"("id");--> statement-breakpoint

ALTER TABLE "training_enrolments" ADD CONSTRAINT "training_enrolments_person_id_fk"
  FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id");--> statement-breakpoint
ALTER TABLE "training_enrolments" ADD CONSTRAINT "training_enrolments_club_id_fk"
  FOREIGN KEY ("club_id") REFERENCES "public"."dojos"("id");--> statement-breakpoint
ALTER TABLE "training_enrolments" ADD CONSTRAINT "training_enrolments_from_fk"
  FOREIGN KEY ("transferred_from_id") REFERENCES "public"."training_enrolments"("id");--> statement-breakpoint
ALTER TABLE "training_enrolments" ADD CONSTRAINT "training_enrolments_to_fk"
  FOREIGN KEY ("transferred_to_id") REFERENCES "public"."training_enrolments"("id");--> statement-breakpoint

-- ── Indexes ────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "training_products_code_uk" ON "training_products" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "training_products_slug_uk" ON "training_products" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "training_products_status_idx" ON "training_products" USING btree ("status","discipline");--> statement-breakpoint
CREATE INDEX "training_products_club_idx" ON "training_products" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "training_products_fee_code_idx" ON "training_products" USING btree ("fee_code");--> statement-breakpoint

CREATE UNIQUE INDEX "training_plans_ref_uk" ON "training_plans" USING btree ("ref");--> statement-breakpoint
-- ONE LIVE PLAN PER PERSON PER PRODUCT PER CLUB, and no more than that.
--
-- PARTIAL, so lapsed and cancelled plans keep their rows under the same index
-- without colliding — and, the half that matters more, so a person may hold LIVE
-- plans at several clubs at once. A unique key on (person, product) alone would
-- have forbidden the weekend dojo, quietly, and the first person to hit it would
-- have been told to choose.
--
-- coalesce() because two NULLs are distinct in a unique index, and a
-- federation-wide product with no club would otherwise admit unlimited duplicates.
CREATE UNIQUE INDEX "training_plans_live_uk" ON "training_plans"
  USING btree ("person_id","product_id",coalesce("club_id", 0))
  WHERE status IN ('proposed', 'active');--> statement-breakpoint
CREATE INDEX "training_plans_person_idx" ON "training_plans" USING btree ("person_id","status");--> statement-breakpoint
CREATE INDEX "training_plans_product_idx" ON "training_plans" USING btree ("product_id","status");--> statement-breakpoint

-- THE REPLAY GUARD, and it is a database constraint rather than a code path.
--
-- Every gateway retries its webhooks and the reconcile cron retries them again.
-- src/db/training-products.ts inserts this row FIRST and does everything else
-- afterwards, inside the same transaction, so a loser's whole transaction rolls
-- back. A check-then-insert could not do this: two confirmations arriving in the
-- same millisecond both read "no entitlement yet", and the student ends up
-- paying twice for one term.
CREATE UNIQUE INDEX "training_entitlements_order_line_uk" ON "training_entitlements"
  USING btree ("order_line_id");--> statement-breakpoint
-- One successor per term, so two renewal runs cannot both extend it. NULLs are
-- distinct in a unique index, so every first term sits under this without
-- colliding.
CREATE UNIQUE INDEX "training_entitlements_renewal_chain_uk" ON "training_entitlements"
  USING btree ("renewed_from_entitlement_id");--> statement-breakpoint
-- THE ACCESS QUERY'S INDEX. "Which live entitlements cover this person today" is
-- the cheapest and by far the most frequent question this system asks, and it
-- has to be an index lookup rather than a scan of every entitlement in the
-- country per request.
CREATE INDEX "training_entitlements_access_idx" ON "training_entitlements"
  USING btree ("person_id","status","valid_from","valid_until");--> statement-breakpoint
CREATE INDEX "training_entitlements_club_idx" ON "training_entitlements" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "training_entitlements_serviced_idx" ON "training_entitlements" USING btree ("serviced_by_club_id","status");--> statement-breakpoint
CREATE INDEX "training_entitlements_product_idx" ON "training_entitlements" USING btree ("product_id","status");--> statement-breakpoint
CREATE INDEX "training_entitlements_plan_idx" ON "training_entitlements" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "training_entitlements_payment_idx" ON "training_entitlements" USING btree ("payment_id");--> statement-breakpoint

-- One LIVE enrolment per person per club. Partial, so a student who left and
-- came back has two rows and a history rather than one row and an argument.
CREATE UNIQUE INDEX "training_enrolments_live_uk" ON "training_enrolments"
  USING btree ("person_id","club_id") WHERE status = 'active';--> statement-breakpoint
-- A transfer is CLAIMED, so two administrators moving the same student at once
-- cannot both open a receiving row.
CREATE UNIQUE INDEX "training_enrolments_chain_uk" ON "training_enrolments"
  USING btree ("transferred_from_id");--> statement-breakpoint
CREATE INDEX "training_enrolments_person_idx" ON "training_enrolments" USING btree ("person_id","status");--> statement-breakpoint
CREATE INDEX "training_enrolments_club_idx" ON "training_enrolments" USING btree ("club_id","status");
