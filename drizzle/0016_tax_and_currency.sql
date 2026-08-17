-- 0015 — versioned tax, and currency with a FROZEN exchange rate.
--
-- Hand-written, like every migration since 0004. drizzle.config.ts points at
-- src/db/schema.ts alone and `drizzle-kit generate` would emit DROP TABLE for
-- everything it cannot see; see the note at the top of 0007.
--
-- Adds 5 tables, 2 enums, and freeze columns on the two records that must never
-- move once issued: invoices and quote_versions.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CONTAIN
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Not one tax rate. Not one exchange rate.
--
-- Whether an MMAKF federation membership, a grading fee, a dan examination or
-- an institutional training contract attracts GST — and at what rate, under
-- which HSN/SAC classification, and whether it is CGST+SGST or IGST — is a
-- legal and accounting determination that MMAKF has to make and record. It is
-- not a thing software may assume on the federation's behalf, and a plausible
-- 18% seeded here would be indistinguishable, six months later, from a rate an
-- accountant had actually signed off.
--
-- So `tax_rules` and `tax_rate_versions` are created EMPTY, and src/db/tax.ts
-- reports "no tax rule is configured for this supply, so nothing has been
-- added" rather than a zero that reads as a determination of exemption. That is
-- the same discipline 0007 applied to the fee framework, for the same reason.
--
-- `fx_rates` is likewise EMPTY. An exchange rate is somebody's published
-- number on a particular day, and the table demands to be told whose and when
-- before it will hold one.
--
-- `currencies` IS seeded, and that is not an exception to the rule above. A
-- currency's ISO 4217 alphabetic code and its minor-unit exponent are a
-- published international standard, not a commercial decision: JPY has no minor
-- unit and KWD has three, and a system that assumed 100 everywhere would be
-- wrong about both by construction. Only INR is seeded ACTIVE — the others are
-- reference rows, and switching one on is a decision a person makes.

-- ── Tax vocabulary ──────────────────────────────────────────────────────────
--
-- `tax_treatment` is the MODEL, not a rate. "Standard-rated", "exempt" and
-- "out of scope" are how any tax system in the world classifies a supply; the
-- number attached to "standard" is what MMAKF must supply. Naming it
-- `*_treatment` rather than `*_status` is deliberate: it is a taxonomy, not a
-- lifecycle, and tests/status-dictionary.test.ts correctly excludes it.
CREATE TYPE "public"."tax_treatment" AS ENUM('standard', 'zero_rated', 'exempt', 'out_of_scope', 'reverse_charge');--> statement-breakpoint

-- The rate version lifecycle mirrors fee_framework_status exactly, because the
-- discipline is identical: a rate is drafted, published (and thereby frozen),
-- and eventually superseded by a later version rather than edited.
CREATE TYPE "public"."tax_rate_version_status" AS ENUM('draft', 'published', 'superseded', 'withdrawn');--> statement-breakpoint

-- ── Currency ────────────────────────────────────────────────────────────────
--
-- `minor_unit` is the ISO 4217 exponent, and it has no default. A default of 2
-- is the exact assumption this table exists to prevent: it would be silently
-- wrong for JPY, KRW and ISK (0) and for BHD, KWD, OMR and TND (3), and the
-- error would surface as an invoice off by a factor of a hundred.
CREATE TABLE "currencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"numeric_code" text,
	"name" text NOT NULL,
	"symbol" text,
	"minor_unit" integer NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'ISO 4217' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "currencies_minor_unit_ck" CHECK ("minor_unit" >= 0 AND "minor_unit" <= 4)
);--> statement-breakpoint
CREATE UNIQUE INDEX "currencies_code_uk" ON "currencies" USING btree ("code");--> statement-breakpoint

-- One recorded exchange rate, versioned and attributed.
--
-- `rate_ppm` is MINOR UNITS OF THE QUOTE CURRENCY PER ONE MINOR UNIT OF THE
-- BASE, times 1,000,000. Stating it that way — rather than "units per unit" —
-- means converting an amount is exactly one call to applyFactor() in
-- src/db/fees.ts, which is the only place in this codebase a factor is applied,
-- and the minor-unit difference between the two currencies is already inside
-- the number rather than being re-derived at every call site.
--
-- bigint, not integer. A rate between a high-value and a low-value currency
-- overflows int4: 1 KWD ≈ 50,000 IDR is 5 × 10^9 in these units, and int4 stops
-- at 2.1 × 10^9. The wrap would be silent.
--
-- `rate_text` keeps the source's own decimal string verbatim, because ppm is a
-- lossy representation of a very small rate and an auditor asking "what did the
-- bulletin actually say?" deserves the bulletin's answer, not ours.
--
-- `source` and `retrieved_at` are NOT NULL on purpose. An exchange rate with no
-- provenance is a number somebody typed, and it will be challenged eventually.
CREATE TABLE "fx_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"base_code" text NOT NULL,
	"quote_code" text NOT NULL,
	"version" integer NOT NULL,
	"rate_ppm" bigint NOT NULL,
	"rate_text" text,
	"source" text NOT NULL,
	"source_ref" text,
	"retrieved_at" timestamp with time zone NOT NULL,
	"effective_on" date NOT NULL,
	"recorded_by_user_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fx_rates_rate_positive_ck" CHECK ("rate_ppm" > 0),
	CONSTRAINT "fx_rates_pair_ck" CHECK ("base_code" <> "quote_code")
);--> statement-breakpoint
ALTER TABLE "fx_rates" ADD CONSTRAINT "fx_rates_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fx_rates_pair_version_uk" ON "fx_rates" USING btree ("base_code","quote_code","version");--> statement-breakpoint
CREATE INDEX "fx_rates_pair_effective_idx" ON "fx_rates" USING btree ("base_code","quote_code","effective_on");--> statement-breakpoint

-- ── Tax ─────────────────────────────────────────────────────────────────────
--
-- A jurisdiction is WHO levies the tax. It nests — a state sits inside a
-- country — because the same supply can attract a national and a sub-national
-- component, and a flat list cannot say which is which.
--
-- `parent_id` carries no foreign key, matching fee_frameworks.superseded_by_id:
-- a self-reference declared in drizzle forces a circular type annotation for no
-- integrity gain the application does not already enforce.
CREATE TABLE "tax_jurisdictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"country_code" text NOT NULL,
	"region_code" text,
	"parent_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "tax_jurisdictions_code_uk" ON "tax_jurisdictions" USING btree ("code");--> statement-breakpoint

-- A tax rule identifies a TAXABLE SUPPLY. It carries no rate.
--
-- The split is the whole point of the model. "An institutional training
-- contract delivered in Jharkhand is a standard-rated supply" is a lasting
-- classification; "the standard rate is X%" is a number that changes on a
-- budget day. Holding them in one row would mean a rate change rewrote the
-- classification's history, which is precisely what tax_rate_versions prevents.
--
-- `conditions` is jsonb and is matched by the SAME matcher as fee rules
-- (matchConditions in src/db/fees.ts), so there is one condition language in
-- this system rather than two that drift.
CREATE TABLE "tax_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"jurisdiction_id" integer NOT NULL,
	"service_id" integer,
	"audience" "audience_kind",
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"treatment" "tax_treatment" NOT NULL,
	"tax_code" text,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_jurisdiction_id_tax_jurisdictions_id_fk" FOREIGN KEY ("jurisdiction_id") REFERENCES "public"."tax_jurisdictions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rules" ADD CONSTRAINT "tax_rules_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rules_code_uk" ON "tax_rules" USING btree ("code");--> statement-breakpoint
CREATE INDEX "tax_rules_order_idx" ON "tax_rules" USING btree ("jurisdiction_id","sort_order");--> statement-breakpoint

-- The rate, versioned, with the window it was in force for.
--
-- `rate_ppm` is parts-per-million of the taxable base, matching fee_rules.
-- 18% is 180000. It is nullable because a zero-rated or exempt supply has no
-- rate at all, and storing 0 there would make "the legislature set this to
-- nought" indistinguishable from "nobody has told us".
--
-- `components` is for a jurisdiction that splits one headline rate into named
-- parts. India's CGST/SGST/IGST split is the obvious candidate; the column
-- exists so that recording it later is configuration rather than a migration,
-- and it ships empty because MMAKF has not made that determination either.
CREATE TABLE "tax_rate_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"tax_rule_id" integer NOT NULL,
	"version" integer NOT NULL,
	"status" "tax_rate_version_status" DEFAULT 'draft' NOT NULL,
	"rate_ppm" integer,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"authority_ref" text,
	"published_at" timestamp with time zone,
	"published_by_user_id" integer,
	"superseded_by_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rate_versions_rate_ck" CHECK ("rate_ppm" IS NULL OR "rate_ppm" >= 0)
);--> statement-breakpoint
ALTER TABLE "tax_rate_versions" ADD CONSTRAINT "tax_rate_versions_tax_rule_id_tax_rules_id_fk" FOREIGN KEY ("tax_rule_id") REFERENCES "public"."tax_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rate_versions" ADD CONSTRAINT "tax_rate_versions_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rate_versions_rule_version_uk" ON "tax_rate_versions" USING btree ("tax_rule_id","version");--> statement-breakpoint
CREATE INDEX "tax_rate_versions_effective_idx" ON "tax_rate_versions" USING btree ("tax_rule_id","effective_from");--> statement-breakpoint

-- ── Freezing what has been issued ───────────────────────────────────────────
--
-- THE RULE THIS SECTION EXISTS FOR: once a quotation or an invoice is issued,
-- the amount and the exchange rate used are FROZEN ON THAT RECORD.
--
-- The columns hold the rate ITSELF, not a pointer to fx_rates. A foreign key
-- would be a pointer into a table whose whole purpose is to change, and the
-- customer's liability would then move every time somebody recorded Tuesday's
-- rate. `fx_rate_id` is kept alongside for PROVENANCE only — "this came from
-- that recorded row" — and is never read back to recompute an amount.
--
-- `tax_snapshot` does the same job for tax: the rules, the rate versions, the
-- rates and the resulting amounts as they stood at issue. Publishing a new rate
-- version tomorrow leaves every issued document saying exactly what it said.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "base_currency" text DEFAULT 'INR' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "base_minor_unit" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "presentment_currency" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "presentment_minor_unit" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "presentment_total_minor" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "fx_rate_ppm" bigint;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "fx_rate_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "fx_source" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "fx_retrieved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "fx_effective_on" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "tax_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_fx_rate_id_fx_rates_id_fk" FOREIGN KEY ("fx_rate_id") REFERENCES "public"."fx_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "quote_versions" ADD COLUMN IF NOT EXISTS "currency_minor_unit" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN IF NOT EXISTS "presentment_currency" text;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN IF NOT EXISTS "presentment_minor_unit" integer;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN IF NOT EXISTS "presentment_total_minor" bigint;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN IF NOT EXISTS "fx_rate_ppm" bigint;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN IF NOT EXISTS "fx_rate_id" integer;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN IF NOT EXISTS "fx_source" text;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN IF NOT EXISTS "fx_retrieved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN IF NOT EXISTS "fx_effective_on" date;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD COLUMN IF NOT EXISTS "tax_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_fx_rate_id_fx_rates_id_fk" FOREIGN KEY ("fx_rate_id") REFERENCES "public"."fx_rates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ── ISO 4217 reference data ─────────────────────────────────────────────────
--
-- Codes, numeric codes and minor-unit exponents are the published standard.
-- Symbols are conventional and advisory; nothing computes with them.
--
-- INR alone is ACTIVE. The rest are reference rows so that a currency can be
-- switched on without a migration — and so that the non-100 minor units are
-- present in the table rather than being a comment somebody has to believe.
-- Marking one active is a decision about who MMAKF trades with, which is not
-- a decision this migration is entitled to make.
INSERT INTO "currencies" ("code", "numeric_code", "name", "symbol", "minor_unit", "is_active", "notes") VALUES
	('INR', '356', 'Indian rupee', '₹', 2, true, 'Authoritative for domestic transactions. Amounts are stored in paise.'),
	('USD', '840', 'United States dollar', '$', 2, false, NULL),
	('EUR', '978', 'Euro', '€', 2, false, NULL),
	('GBP', '826', 'Pound sterling', '£', 2, false, NULL),
	('AED', '784', 'UAE dirham', 'د.إ', 2, false, NULL),
	('SGD', '702', 'Singapore dollar', 'S$', 2, false, NULL),
	('AUD', '036', 'Australian dollar', 'A$', 2, false, NULL),
	('CAD', '124', 'Canadian dollar', 'C$', 2, false, NULL),
	('CHF', '756', 'Swiss franc', 'CHF', 2, false, NULL),
	('NPR', '524', 'Nepalese rupee', 'रू', 2, false, NULL),
	('LKR', '144', 'Sri Lankan rupee', 'Rs', 2, false, NULL),
	('BDT', '050', 'Bangladeshi taka', '৳', 2, false, NULL),
	('MYR', '458', 'Malaysian ringgit', 'RM', 2, false, NULL),
	('JPY', '392', 'Japanese yen', '¥', 0, false, 'Minor unit 0. An amount is a whole yen; there are no sen.'),
	('KRW', '410', 'South Korean won', '₩', 0, false, 'Minor unit 0.'),
	('KWD', '414', 'Kuwaiti dinar', 'د.ك', 3, false, 'Minor unit 3. One dinar is 1000 fils, not 100.'),
	('BHD', '048', 'Bahraini dinar', '.د.ب', 3, false, 'Minor unit 3.'),
	('OMR', '512', 'Omani rial', 'ر.ع.', 3, false, 'Minor unit 3.')
ON CONFLICT DO NOTHING;
