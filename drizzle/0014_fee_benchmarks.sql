-- 0014 — the benchmark store: what OTHER organisations charge.
--
-- Hand-written, like every migration since 0004, for the reason 0011 gives:
-- drizzle.config.ts points at src/db/schema.ts alone and `drizzle-kit generate`
-- would emit DROP TABLE for everything it cannot see.
--
-- Adds three tables and five enums. Nothing here touches fee_frameworks or
-- fee_rules, and nothing here is an MMAKF price.
--
-- ── WHY THE SEED IS IN THIS FILE ────────────────────────────────────────────
--
-- The thirteen observations below are the ONLY benchmarks the federation
-- supplied, and they are reference data of the same kind as a country list:
-- fixed, attributed, and required by every environment that runs migrations.
-- Keeping them here rather than in a TypeScript constant means there is one
-- copy, in one place, and no possibility of a seed script drifting from the
-- schema it seeds. The uniqueness of `code` plus ON CONFLICT DO NOTHING makes
-- re-application harmless.
--
-- ── WHAT IS NOT IN THE SEED, AND WHY ────────────────────────────────────────
--
-- No URL. No publication date. No country for WUKF or for Japan Karate-Do. No
-- frequency for the three WUKF lines that were given without one. Those columns
-- are NULL or 'unstated' because the supplied list did not contain them, and a
-- figure attributed to a real federation with a plausible URL bolted on is a
-- fabricated claim about a third party — the one kind of invention that harms
-- somebody who never agreed to be in this database.
--
-- Every row is therefore source_type 'federation_supplied' at confidence
-- 'reported': attributed to a named body, not independently verified. Anyone
-- who later reads a fee schedule at its own source updates the row to
-- 'official_publication' / 'verified' and fills in the URL. The store is built
-- to be extended that way; see recordBenchmark() in src/db/benchmarks.ts.
--
-- `retrieved_at` is now() — the moment the figure entered THIS system. It is
-- not the date the federation compiled its list, which was not supplied either,
-- and which `source_date` therefore leaves null.

CREATE TYPE "public"."fee_benchmark_source_type" AS ENUM('federation_supplied', 'official_publication', 'operator_entered', 'press_report', 'third_party', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."fee_benchmark_confidence" AS ENUM('verified', 'reported', 'estimated', 'unverified');--> statement-breakpoint
CREATE TYPE "public"."fee_benchmark_frequency" AS ENUM('per_year', 'per_month', 'per_week', 'per_session', 'per_event', 'one_off', 'unstated');--> statement-breakpoint
CREATE TYPE "public"."fee_benchmark_subject" AS ENUM('person', 'club', 'team', 'federation', 'application', 'unstated');--> statement-breakpoint
CREATE TYPE "public"."fee_benchmark_status" AS ENUM('included', 'excluded', 'flagged', 'archived');--> statement-breakpoint

CREATE TABLE "fee_benchmark_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"organisation" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"published_on" date,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_type" "fee_benchmark_source_type" NOT NULL,
	"confidence" "fee_benchmark_confidence" NOT NULL,
	"recorded_by_user_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_benchmarks" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"source_id" integer NOT NULL,
	"organisation" text NOT NULL,
	"country" text,
	"region" text,
	"service" text NOT NULL,
	"service_label" text NOT NULL,
	"audience" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"currency" text NOT NULL,
	"currency_exponent" integer DEFAULT 2 NOT NULL,
	"amount_text" text NOT NULL,
	"frequency" "fee_benchmark_frequency" NOT NULL,
	"subject" "fee_benchmark_subject" NOT NULL,
	"effective_from" date,
	"effective_until" date,
	"source_url" text,
	"source_title" text NOT NULL,
	"source_date" date,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_type" "fee_benchmark_source_type" NOT NULL,
	"confidence" "fee_benchmark_confidence" NOT NULL,
	"notes" text,
	"status" "fee_benchmark_status" DEFAULT 'included' NOT NULL,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_benchmark_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"taken_by_user_id" integer,
	"query" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"recommendation" jsonb,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "fee_benchmark_sources" ADD CONSTRAINT "fee_benchmark_sources_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_benchmarks" ADD CONSTRAINT "fee_benchmarks_source_id_fee_benchmark_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."fee_benchmark_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_benchmark_snapshots" ADD CONSTRAINT "fee_benchmark_snapshots_taken_by_user_id_users_id_fk" FOREIGN KEY ("taken_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

CREATE UNIQUE INDEX "fee_benchmark_sources_code_uk" ON "fee_benchmark_sources" USING btree ("code");--> statement-breakpoint
CREATE INDEX "fee_benchmark_sources_org_idx" ON "fee_benchmark_sources" USING btree ("organisation");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_benchmarks_code_uk" ON "fee_benchmarks" USING btree ("code");--> statement-breakpoint
CREATE INDEX "fee_benchmarks_source_idx" ON "fee_benchmarks" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "fee_benchmarks_lookup_idx" ON "fee_benchmarks" USING btree ("service","status","currency");--> statement-breakpoint
CREATE INDEX "fee_benchmarks_org_idx" ON "fee_benchmarks" USING btree ("organisation");--> statement-breakpoint
CREATE INDEX "fee_benchmarks_unit_idx" ON "fee_benchmarks" USING btree ("subject","frequency");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_benchmark_snapshots_code_uk" ON "fee_benchmark_snapshots" USING btree ("code");--> statement-breakpoint
CREATE INDEX "fee_benchmark_snapshots_taken_idx" ON "fee_benchmark_snapshots" USING btree ("taken_at");--> statement-breakpoint

-- ── The four citations ──────────────────────────────────────────────────────
-- One per organisation named in the supplied list. The title states what the
-- source actually is, rather than dressing a hand-over up as a fee schedule.

INSERT INTO "fee_benchmark_sources"
	("code", "organisation", "title", "url", "published_on", "source_type", "confidence", "notes")
VALUES
	('SRC-FED-USA-KARATE', 'USA Karate',
	 'MMAKF-supplied benchmark list — figures attributed to USA Karate',
	 NULL, NULL, 'federation_supplied', 'reported',
	 'Supplied to MMAKF as a list of amounts. No source document, URL or publication date accompanied it, and none has been invented.'),
	('SRC-FED-IBF-GB', 'IBF Great Britain',
	 'MMAKF-supplied benchmark list — figures attributed to IBF Great Britain',
	 NULL, NULL, 'federation_supplied', 'reported',
	 'Supplied to MMAKF as a list of amounts. No source document, URL or publication date accompanied it, and none has been invented.'),
	('SRC-FED-WUKF', 'WUKF',
	 'MMAKF-supplied benchmark list — figures attributed to WUKF',
	 NULL, NULL, 'federation_supplied', 'reported',
	 'Supplied to MMAKF as a list of amounts. Three of the six lines gave no period; those are stored as frequency ''unstated''.'),
	('SRC-FED-JAPAN-KARATE-DO', 'Japan Karate-Do',
	 'MMAKF-supplied benchmark list — figures attributed to Japan Karate-Do',
	 NULL, NULL, 'federation_supplied', 'reported',
	 'Supplied to MMAKF as a list of amounts. The supplier named no country; the figures being quoted in USD does not establish one, so country is left null.')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint

-- ── The thirteen observations ───────────────────────────────────────────────
-- Amounts are integers in the MINOR UNIT OF THEIR OWN CURRENCY. USD 60 is 6000
-- cents. Nothing here is paise and nothing here is converted to INR: that needs
-- an FX rate carrying a timestamp, which this store does not own.

INSERT INTO "fee_benchmarks"
	("code", "source_id", "organisation", "country", "region",
	 "service", "service_label", "audience",
	 "amount_minor", "currency", "currency_exponent", "amount_text",
	 "frequency", "subject",
	 "source_url", "source_title", "source_date", "source_type", "confidence", "notes", "status")
SELECT v."code", s."id", v."organisation", v."country", v."region",
       v."service", v."service_label", v."audience",
       v."amount_minor", v."currency", 2, v."amount_text",
       v."frequency"::"fee_benchmark_frequency", v."subject"::"fee_benchmark_subject",
       NULL, s."title", NULL::date,
       'federation_supplied'::"fee_benchmark_source_type",
       'reported'::"fee_benchmark_confidence",
       v."notes", 'included'::"fee_benchmark_status"
FROM (VALUES
	-- USA Karate
	('BMK-USA-KARATE-MEMBERSHIP-ATHLETE', 'SRC-FED-USA-KARATE', 'USA Karate', 'US', 'national',
	 'membership', 'Individual athlete membership', 'individual_athlete',
	 6000, 'USD', 'USD 60/year', 'per_year', 'person', NULL),
	('BMK-USA-KARATE-MEMBERSHIP-COACH-OFFICIAL', 'SRC-FED-USA-KARATE', 'USA Karate', 'US', 'national',
	 'membership', 'Coach and official membership', 'coach_official',
	 7500, 'USD', 'USD 75/year', 'per_year', 'person', NULL),
	('BMK-USA-KARATE-CLUB', 'SRC-FED-USA-KARATE', 'USA Karate', 'US', 'national',
	 'club_affiliation', 'Club membership', 'club',
	 20000, 'USD', 'USD 200/year', 'per_year', 'club',
	 'Levied on a club, not a person. Never averaged with the individual figures above; see normalise() in src/db/benchmarks.ts.'),

	-- IBF Great Britain
	('BMK-IBF-GB-MEMBERSHIP-ADULT', 'SRC-FED-IBF-GB', 'IBF Great Britain', 'GB', 'national',
	 'membership', 'Adult membership', 'adult',
	 2500, 'GBP', 'GBP 25/year', 'per_year', 'person', NULL),
	('BMK-IBF-GB-MEMBERSHIP-JUNIOR', 'SRC-FED-IBF-GB', 'IBF Great Britain', 'GB', 'national',
	 'membership', 'Junior membership', 'junior',
	 1500, 'GBP', 'GBP 15/year', 'per_year', 'person', NULL),

	-- WUKF. Country is null: a world union has no single one, and picking the
	-- country of its registered office would misdescribe the body.
	('BMK-WUKF-FEDERATION-ANNUAL', 'SRC-FED-WUKF', 'WUKF', NULL, 'international',
	 'federation_affiliation', 'Federation annual fee', 'federation',
	 25000, 'EUR', 'EUR 250/year', 'per_year', 'federation', NULL),
	('BMK-WUKF-COMPETITION-INDIVIDUAL', 'SRC-FED-WUKF', 'WUKF', NULL, 'international',
	 'competition_entry', 'Individual competition entry', 'individual_athlete',
	 4500, 'EUR', 'EUR 45/event', 'per_event', 'person', NULL),
	('BMK-WUKF-COMPETITION-TEAM', 'SRC-FED-WUKF', 'WUKF', NULL, 'international',
	 'competition_entry', 'Team competition entry', 'team',
	 8000, 'EUR', 'EUR 80/event', 'per_event', 'team',
	 'Levied on a team. Not comparable with the individual entry fee above without knowing a team size, which was not supplied.'),
	('BMK-WUKF-COACH', 'SRC-FED-WUKF', 'WUKF', NULL, 'international',
	 'coach_registration', 'Coach fee', 'coach_official',
	 5000, 'EUR', 'EUR 50', 'unstated', 'person',
	 'The supplied line gave an amount and no period. Whether this is annual, per event or once has NOT been inferred, so the row cannot join a per-year or per-event comparison.'),
	('BMK-WUKF-PROTEST', 'SRC-FED-WUKF', 'WUKF', NULL, 'international',
	 'protest_fee', 'Protest fee', 'unstated',
	 20000, 'EUR', 'EUR 200', 'unstated', 'application',
	 'The supplied line gave an amount and no period. Levied per protest by the name of the thing; the frequency is still recorded as unstated because the supplier did not state it.'),
	('BMK-WUKF-DAN-HOMOLOGATION', 'SRC-FED-WUKF', 'WUKF', NULL, 'international',
	 'dan_homologation', 'Dan homologation fee', 'unstated',
	 10000, 'EUR', 'EUR 100', 'unstated', 'application',
	 'The supplied line gave an amount and no period. Recorded as unstated rather than inferred from what a homologation fee usually is.'),

	-- Japan Karate-Do. Country null, region null: the supplier stated neither.
	('BMK-JAPAN-KARATE-DO-TRAINING-TWICE-WEEKLY', 'SRC-FED-JAPAN-KARATE-DO', 'Japan Karate-Do', NULL, NULL,
	 'training', 'Training, twice weekly', 'individual_athlete',
	 18500, 'USD', 'USD 185/month', 'per_month', 'person',
	 'A recurring training fee, not a membership. It is normalised to a yearly cost only within the training service, never alongside a membership subscription.'),
	('BMK-JAPAN-KARATE-DO-TRAINING-UNLIMITED', 'SRC-FED-JAPAN-KARATE-DO', 'Japan Karate-Do', NULL, NULL,
	 'training', 'Training, unlimited attendance', 'individual_athlete',
	 19500, 'USD', 'USD 195/month', 'per_month', 'person', NULL)
) AS v("code", "source_code", "organisation", "country", "region",
       "service", "service_label", "audience",
       "amount_minor", "currency", "amount_text", "frequency", "subject", "notes")
JOIN "fee_benchmark_sources" s ON s."code" = v."source_code"
ON CONFLICT ("code") DO NOTHING;
