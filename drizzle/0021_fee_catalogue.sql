-- 0021 — the fee catalogue: every service MMAKF can charge for, and not one price.
--
-- WHAT THIS IS FOR.
--
-- The fee engine in 0007 can price a request, and it is empty because the
-- federation has published no rules. That leaves a question nobody could
-- answer from the database: what is the federation ENTITLED to charge for at
-- all? A referee licence, a Dan grading certificate, a kumite entry, a late
-- entry, a protest, a replacement membership card — fifty-one distinct
-- chargeable services live in the federation's own documents and none of them
-- existed as a record. Each one was a paragraph on a page or a line in a PDF,
-- which is why the site could show a monthly training price and no way at all
-- to say what a grading costs.
--
-- THE SEPARATION THIS FILE EXISTS TO CREATE, AND IT IS THE WHOLE POINT.
--
-- A catalogue entry is a SERVICE THAT CAN BE CHARGED FOR. It carries a code, a
-- name, a category, an audience, a unit, a frequency and a display policy.
--
-- IT CARRIES NO AMOUNT. There is no amount column below, and there is a test
-- that reads information_schema and fails if one ever appears. The amount
-- lives in fee_rules, inside a versioned fee_frameworks row, because that is
-- the thing that can be published, frozen and superseded. If the price sat on
-- the catalogue entry, changing it in 2027 would rewrite what a 2026 invoice
-- says it charged — the entry is one row, and one row has one value. The
-- separation is what makes a historical invoice defensible.
--
-- WHY A DISPLAY POLICY IS A COLUMN AND NOT A CONVENTION.
--
-- Not every fee is public information. An institutional contract is negotiated,
-- a member-only rate is not shown to strangers, and some internal charges are
-- not published at all. Left to each page to decide, a fee that should have been
-- quoted privately appears on the public site the first time somebody adds a
-- listing template. Recorded here, every surface asks the same column and gets
-- the same answer.
--
-- AND WHAT NO SURFACE MAY EVER DO: render ₹0 because no rule matched. Zero
-- reads as "free". src/db/fee-catalogue.ts returns a symbol instead of a
-- number, and the type system refuses the coercion.
--
-- Seeded with CODES ONLY, by src/db/fee-catalogue.ts. Not one rupee figure
-- appears in this file, because MMAKF has published none and inventing one
-- would be this project writing the federation's commercial policy for it.

-- ── The taxonomies ──────────────────────────────────────────────────────────
-- Deliberately NOT reusing service_category from 0007. That enum describes what
-- MMAKF DELIVERS (training, education, competition…); this one describes what
-- MMAKF CHARGES FOR, and the two lists genuinely differ — 'documents' and
-- 'affiliation' are chargeable and are not deliveries, while a delivery may
-- carry several chargeable services at once.
CREATE TYPE "public"."fee_service_category" AS ENUM('membership', 'affiliation', 'grading', 'competition', 'education', 'training', 'documents');--> statement-breakpoint

-- Who is charged. Wider than audience_kind from 0007, which lists the KINDS OF
-- CLIENT the federation trains (school, corporate, government). A referee
-- licence fee is charged to a referee, and 'referee' is not a kind of client.
CREATE TYPE "public"."fee_audience" AS ENUM('athlete', 'junior', 'parent', 'coach', 'instructor', 'referee', 'judge', 'official', 'examiner', 'member', 'dojo', 'club', 'school', 'university', 'corporate', 'government', 'organisation', 'institution', 'state_unit', 'district_unit', 'any');--> statement-breakpoint

-- What one unit of the charge is. A fee rule multiplies by a quantity, and the
-- unit is what tells a human WHICH quantity — "per entry" and "per category"
-- produce very different totals for the same competition.
CREATE TYPE "public"."fee_unit" AS ENUM('per_person', 'per_application', 'per_registration', 'per_entry', 'per_category', 'per_team', 'per_session', 'per_seat', 'per_month', 'per_year', 'per_document', 'per_card', 'per_certificate', 'per_dojo', 'per_club', 'per_institution', 'per_campus', 'per_hour', 'per_case');--> statement-breakpoint

-- How often it recurs. 'on_request' is not a hedge: some charges genuinely have
-- no cadence until somebody asks for the thing.
CREATE TYPE "public"."fee_frequency" AS ENUM('one_time', 'annual', 'biennial', 'triennial', 'monthly', 'per_term', 'per_event', 'per_session', 'on_request');--> statement-breakpoint

-- What a surface may say. There is no 'unset': an entry whose policy nobody has
-- decided would default to the most permissive reading on whichever page
-- forgot to check, so the column is NOT NULL and the seed states a policy for
-- every one of the fifty-one entries.
CREATE TYPE "public"."fee_display_policy" AS ENUM('public', 'request_quote', 'member_only', 'institutional', 'private', 'hidden');--> statement-breakpoint

-- ── The catalogue ───────────────────────────────────────────────────────────
-- `status` reuses service_status from 0007 (draft / published / withdrawn) on
-- purpose: the status dictionary in src/lib/status.ts already knows those three
-- labels, and a fourth private vocabulary meaning the same three things is how
-- one screen shows a chip nobody styled.
--
-- `service_id` is NULLABLE and is a link, not an owner. Most chargeable
-- services — a grading certificate, a protest — correspond to no delivery
-- record at all, and a NOT NULL here would have forced fifty-one placeholder
-- rows into the delivery catalogue to satisfy a constraint.
CREATE TABLE "fee_catalogue_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"category" "fee_service_category" NOT NULL,
	"audience" "fee_audience" NOT NULL,
	"unit" "fee_unit" NOT NULL,
	"frequency" "fee_frequency" NOT NULL,
	"display_policy" "fee_display_policy" NOT NULL,
	"status" "service_status" DEFAULT 'draft' NOT NULL,
	"service_id" integer,
	"description" text,
	"statutory_basis" text,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fee_catalogue_entries" ADD CONSTRAINT "fee_catalogue_entries_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_catalogue_entries_code_uk" ON "fee_catalogue_entries" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_catalogue_entries_slug_uk" ON "fee_catalogue_entries" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "fee_catalogue_entries_category_idx" ON "fee_catalogue_entries" USING btree ("category");--> statement-breakpoint
CREATE INDEX "fee_catalogue_entries_display_idx" ON "fee_catalogue_entries" USING btree ("display_policy");--> statement-breakpoint
CREATE INDEX "fee_catalogue_entries_status_idx" ON "fee_catalogue_entries" USING btree ("status");
