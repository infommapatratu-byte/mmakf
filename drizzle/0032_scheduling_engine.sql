-- 0032 — the federation scheduling engine.
--
-- WHAT WAS MISSING. The federation could already hold a coach's diary in real
-- intervals (`coach_availability`), take a booking transactionally without two
-- people getting the same hour (`bookings` + src/db/booking.ts), close a room
-- for maintenance (`venue_blackouts`) and record that a class was delivered
-- (`training_sessions`, `program_sessions`). What it could NOT do was say when
-- anything is normally open.
--
-- There was no recurrence. There was no season. There was no inheritance, no
-- exception and no version. The federation's opening hours were two sentences
-- of English in a seed file:
--
--     hours:       'Mon–Sat · 06:00–09:00 & 17:00–20:00 IST'
--     hoursSunday: 'Sun · Summer 06:00–10:00 & 15:00–18:00 ·
--                   Winter 08:00–11:30 & 16:00–18:30 IST'
--
-- Those are the HOMBU DOJO's hours, and /schedule published them as the MMAKF
-- timetable. Every affiliated club in the country was being represented, on the
-- federation's own site, as training at six in the morning. A club that trains
-- Monday to Friday 18:00–21:00 had nowhere to say so, and no administrator
-- could have changed it if they had: the timings were string literals behind a
-- deploy.
--
-- THE FOUR THINGS THIS MIGRATION MAKES IMPOSSIBLE, in the schema rather than in
-- a convention:
--
--   1. ONE SCHEDULE FOR EVERYBODY. `schedules.owner_scope` is the EXISTING
--      `scope_type` enum, so a schedule belongs to the national federation, a
--      state, a district, a dojo or an institution — the same vocabulary the
--      role bindings use. `schedules_target_uk` permits exactly one live
--      schedule per owner, purpose, room and class; two would make resolution a
--      coin toss and the loser would be somebody's Sunday.
--
--   2. A SEASON WITH NO DATES. 'Summer' and 'Winter' are ROWS in `seasons`,
--      with a start and an end an administrator chose. Nothing in this system
--      hard-codes either word. A rule that applies only in a season carries
--      `season_id`; a rule that applies all year carries null.
--
--   3. OVERWRITING HISTORY. Timings live in `schedule_rules`, which hang off
--      `schedule_versions`, which are effective-dated. Publishing new hours
--      creates a version and supersedes the incumbent — it never edits it. An
--      attendance record from March still renders against March's timetable.
--      `schedule_versions_published_needs_publisher_ck` is the "every change
--      must have who and when" requirement made unstorable-otherwise.
--
--   4. A CLASS OUTSIDE ITS ROOM'S HOURS. Facility hours and class times are
--      different objects — a dojo open 06:00–21:00 is not running a class for
--      fifteen hours — and the engine intersects one with the other rather than
--      letting a class widen the building.
--
-- WHAT IS DELIBERATELY NOT HERE. No holiday table beyond `schedule_exceptions`;
-- no second booking table (one column is added to `bookings` instead); no
-- scheduling changelog (that is `audit_events`, which every other consequential
-- act in this system already writes to); no instructor-availability table
-- (`coach_availability` already exists and is already read by the booking
-- engine); and `venue_blackouts` is untouched — it is an instant range against
-- a room, which is not the same object as a calendar-day exception against a
-- schedule that may belong to the whole federation.

CREATE TYPE "public"."schedule_purpose" AS ENUM('operating', 'training', 'office', 'administrative', 'class');--> statement-breakpoint
CREATE TYPE "public"."schedule_status" AS ENUM('draft', 'active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."schedule_version_status" AS ENUM('draft', 'published', 'superseded', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."schedule_rule_kind" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "public"."schedule_exception_kind" AS ENUM('holiday', 'closure', 'extended_hours', 'reduced_hours', 'competition', 'seminar', 'camp', 'maintenance', 'private_booking', 'examination', 'grading', 'special_training');--> statement-breakpoint
CREATE TYPE "public"."schedule_exception_effect" AS ENUM('closed', 'replace', 'add', 'remove');--> statement-breakpoint
CREATE TYPE "public"."season_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."dojo_class_status" AS ENUM('draft', 'active', 'paused', 'retired');--> statement-breakpoint

-- ─── Seasons ────────────────────────────────────────────────────────────────
--
-- Owned by a level of the federation. `owner_id` is null exactly when
-- `owner_scope` is 'national' — the federation is the one level with no row of
-- its own to point at. A club may inherit the federation's definitions or write
-- local ones; `inheritable` is what lets a club keep a season to itself.
CREATE TABLE "seasons" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"owner_scope" "scope_type" NOT NULL,
	"owner_id" integer,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"status" "season_status" DEFAULT 'draft' NOT NULL,
	"inheritable" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by_user_id" integer REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- ─── Classes ────────────────────────────────────────────────────────────────
--
-- Created before `schedules` so the class schedule's foreign key can be inline.
-- A class is not a room and not a programme: `live_classes` is a Master Teacher
-- broadcast with a channel and a rights position, `program_sessions` is a
-- delivery to a client institution under a contract, and this is the class a
-- club runs week after week.
CREATE TABLE "dojo_classes" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"summary" text,
	"owner_scope" "scope_type" NOT NULL,
	"owner_id" integer,
	"venue_id" integer REFERENCES "venues"("id"),
	"mode" "delivery_mode" DEFAULT 'at_dojo' NOT NULL,
	"discipline" text,
	"style" text,
	"level" text,
	"audience" text,
	"age_min" integer,
	"age_max" integer,
	"capacity" integer,
	"default_coach_person_id" integer REFERENCES "persons"("id"),
	"requires_booking" boolean DEFAULT true NOT NULL,
	"online_platform" text,
	"online_url" text,
	"status" "dojo_class_status" DEFAULT 'draft' NOT NULL,
	"public_visible" boolean DEFAULT true NOT NULL,
	"created_by_user_id" integer REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- ─── Schedules ──────────────────────────────────────────────────────────────
--
-- Identity only. What a schedule SAYS lives in its versions, which is what makes
-- "do not overwrite historical schedules" mechanical instead of a discipline.
CREATE TABLE "schedules" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"purpose" "schedule_purpose" NOT NULL,
	"owner_scope" "scope_type" NOT NULL,
	"owner_id" integer,
	"venue_id" integer REFERENCES "venues"("id"),
	"class_id" integer REFERENCES "dojo_classes"("id"),
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"inherits_from_schedule_id" integer REFERENCES "schedules"("id"),
	"status" "schedule_status" DEFAULT 'draft' NOT NULL,
	"public_visible" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_by_user_id" integer REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE "schedule_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"schedule_id" integer NOT NULL REFERENCES "schedules"("id"),
	"version_no" integer NOT NULL,
	"status" "schedule_version_status" DEFAULT 'draft' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"reason" text,
	"supersedes_version_id" integer REFERENCES "schedule_versions"("id"),
	"published_at" timestamp with time zone,
	"published_by_user_id" integer REFERENCES "users"("id"),
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"created_by_user_id" integer REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- `day_of_week` is ISO-8601: 1 = Monday … 7 = Sunday. Written down because
-- JavaScript's getDay() is 0 = Sunday and the two are mixed up constantly. The
-- engine converts once, at the boundary; every row here is ISO.
CREATE TABLE "schedule_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"version_id" integer NOT NULL REFERENCES "schedule_versions"("id"),
	"season_id" integer REFERENCES "seasons"("id"),
	"day_of_week" integer NOT NULL,
	"kind" "schedule_rule_kind" DEFAULT 'open' NOT NULL,
	"opens_at" text,
	"closes_at" text,
	"label" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"notes" text
);--> statement-breakpoint

-- Attached to the SCHEDULE, not to a version: a public holiday is a fact about
-- the calendar and must not evaporate because somebody published new hours.
CREATE TABLE "schedule_exceptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"schedule_id" integer NOT NULL REFERENCES "schedules"("id"),
	"on_date" date NOT NULL,
	"kind" "schedule_exception_kind" NOT NULL,
	"effect" "schedule_exception_effect" NOT NULL,
	"opens_at" text,
	"closes_at" text,
	"reason" text NOT NULL,
	"source_kind" text,
	"source_id" integer,
	"created_by_user_id" integer REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- One occurrence. Materialised rather than derived because a booking needs
-- something to point at, attendance needs something to hang off, and a
-- cancellation needs somewhere to record itself.
CREATE TABLE "class_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"class_id" integer NOT NULL REFERENCES "dojo_classes"("id"),
	"schedule_version_id" integer REFERENCES "schedule_versions"("id"),
	"venue_id" integer REFERENCES "venues"("id"),
	"coach_person_id" integer REFERENCES "persons"("id"),
	"mode" "delivery_mode" DEFAULT 'at_dojo' NOT NULL,
	"online_url" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"local_start" text NOT NULL,
	"local_end" text NOT NULL,
	"timezone" text NOT NULL,
	"capacity" integer,
	"booked_count" integer DEFAULT 0 NOT NULL,
	"status" "program_session_status" DEFAULT 'scheduled' NOT NULL,
	"cancelled_reason" text,
	"rescheduled_to_session_id" integer REFERENCES "class_sessions"("id"),
	"notes" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" integer REFERENCES "users"("id")
);--> statement-breakpoint

-- ─── Indexes ────────────────────────────────────────────────────────────────
--
-- COALESCE appears in the two uniqueness indexes because Postgres treats NULLs
-- as distinct: a plain unique index over a nullable owner_id would happily let
-- the federation define 'summer-2026' twice, and let one dojo hold two live
-- operating schedules that disagree.
CREATE UNIQUE INDEX "seasons_code_uk" ON "seasons" USING btree ("owner_scope", coalesce("owner_id", 0), "code");--> statement-breakpoint
CREATE INDEX "seasons_owner_idx" ON "seasons" USING btree ("owner_scope", "owner_id", "starts_on");--> statement-breakpoint
CREATE INDEX "seasons_window_idx" ON "seasons" USING btree ("starts_on", "ends_on");--> statement-breakpoint
CREATE UNIQUE INDEX "dojo_classes_code_uk" ON "dojo_classes" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "dojo_classes_slug_uk" ON "dojo_classes" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "dojo_classes_owner_idx" ON "dojo_classes" USING btree ("owner_scope", "owner_id", "status");--> statement-breakpoint
CREATE INDEX "dojo_classes_venue_idx" ON "dojo_classes" USING btree ("venue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_code_uk" ON "schedules" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "schedules_target_uk" ON "schedules" USING btree ("owner_scope", coalesce("owner_id", 0), "purpose", coalesce("venue_id", 0), coalesce("class_id", 0)) WHERE "status" <> 'retired';--> statement-breakpoint
CREATE INDEX "schedules_owner_idx" ON "schedules" USING btree ("owner_scope", "owner_id", "purpose");--> statement-breakpoint
CREATE INDEX "schedules_venue_idx" ON "schedules" USING btree ("venue_id");--> statement-breakpoint
CREATE INDEX "schedules_class_idx" ON "schedules" USING btree ("class_id");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_versions_no_uk" ON "schedule_versions" USING btree ("schedule_id", "version_no");--> statement-breakpoint
CREATE INDEX "schedule_versions_schedule_idx" ON "schedule_versions" USING btree ("schedule_id", "effective_from");--> statement-breakpoint
CREATE INDEX "schedule_versions_status_idx" ON "schedule_versions" USING btree ("status", "effective_from");--> statement-breakpoint
CREATE INDEX "schedule_rules_version_day_idx" ON "schedule_rules" USING btree ("version_id", "day_of_week");--> statement-breakpoint
CREATE INDEX "schedule_rules_season_idx" ON "schedule_rules" USING btree ("season_id");--> statement-breakpoint
CREATE INDEX "schedule_exceptions_date_idx" ON "schedule_exceptions" USING btree ("schedule_id", "on_date");--> statement-breakpoint
CREATE INDEX "schedule_exceptions_on_date_idx" ON "schedule_exceptions" USING btree ("on_date");--> statement-breakpoint
CREATE UNIQUE INDEX "class_sessions_ref_uk" ON "class_sessions" USING btree ("ref");--> statement-breakpoint
-- Regenerating a timetable must not duplicate an occurrence. Idempotent
-- generation is enforced here rather than by the generator remembering to check.
CREATE UNIQUE INDEX "class_sessions_occurrence_uk" ON "class_sessions" USING btree ("class_id", "starts_at");--> statement-breakpoint
CREATE INDEX "class_sessions_venue_idx" ON "class_sessions" USING btree ("venue_id", "starts_at");--> statement-breakpoint
CREATE INDEX "class_sessions_coach_idx" ON "class_sessions" USING btree ("coach_person_id", "starts_at");--> statement-breakpoint
CREATE INDEX "class_sessions_window_idx" ON "class_sessions" USING btree ("starts_at", "ends_at");--> statement-breakpoint
CREATE INDEX "class_sessions_class_idx" ON "class_sessions" USING btree ("class_id", "local_date");--> statement-breakpoint

-- ─── The constraints that make the directive true rather than aspirational ──

-- A season that ends before it starts is not a season. Ends are INCLUSIVE:
-- 'Summer 2026' runs 01-Apr to 30-Sep and the 30th of September is in it.
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_window_ck"
	CHECK ("ends_on" >= "starts_on");--> statement-breakpoint

-- 'national' is the only level with no row of its own to point at, and it is
-- the only level permitted a null owner. Without this, a schedule owned by
-- "some dojo, unspecified" is expressible, and it would resolve for every dojo.
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_owner_ck"
	CHECK (("owner_scope" = 'national' AND "owner_id" IS NULL) OR ("owner_scope" <> 'national' AND "owner_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_owner_ck"
	CHECK (("owner_scope" = 'national' AND "owner_id" IS NULL) OR ("owner_scope" <> 'national' AND "owner_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "dojo_classes" ADD CONSTRAINT "dojo_classes_owner_ck"
	CHECK (("owner_scope" = 'national' AND "owner_id" IS NULL) OR ("owner_scope" <> 'national' AND "owner_id" IS NOT NULL));--> statement-breakpoint

-- A class schedule names its class; every other purpose names none. Otherwise
-- 'the operating hours of a class' is storable, and it means nothing.
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_class_purpose_ck"
	CHECK (("purpose" = 'class' AND "class_id" IS NOT NULL) OR ("purpose" <> 'class' AND "class_id" IS NULL));--> statement-breakpoint

-- A schedule cannot be its own parent. Longer cycles are refused by the
-- service, which can walk the chain; a CHECK can only see one row.
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_no_self_parent_ck"
	CHECK ("inherits_from_schedule_id" IS NULL OR "inherits_from_schedule_id" <> "id");--> statement-breakpoint

-- WHO CHANGED IT AND WHEN, enforced rather than requested. A version cannot
-- REACH 'published' without a named publisher and a publication timestamp, so
-- there is no path by which a timetable takes effect anonymously. The reason
-- travels beside it in `audit_events`, where every other consequential act in
-- this system already records one.
ALTER TABLE "schedule_versions" ADD CONSTRAINT "schedule_versions_published_needs_publisher_ck"
	CHECK ("status" <> 'published' OR ("published_at" IS NOT NULL AND "published_by_user_id" IS NOT NULL));--> statement-breakpoint

-- A withdrawal is a statement somebody has to answer for, so it carries its
-- reason. 'superseded' does not need one: the successor version IS the reason.
ALTER TABLE "schedule_versions" ADD CONSTRAINT "schedule_versions_withdrawn_needs_reason_ck"
	CHECK ("status" <> 'withdrawn' OR ("withdrawn_at" IS NOT NULL AND "withdrawn_reason" IS NOT NULL));--> statement-breakpoint

ALTER TABLE "schedule_versions" ADD CONSTRAINT "schedule_versions_window_ck"
	CHECK ("effective_to" IS NULL OR "effective_to" >= "effective_from");--> statement-breakpoint

-- ISO-8601 day numbering, and nothing else. A 0 here would be Sunday to
-- JavaScript and nothing at all to the rest of the world.
ALTER TABLE "schedule_rules" ADD CONSTRAINT "schedule_rules_dow_ck"
	CHECK ("day_of_week" BETWEEN 1 AND 7);--> statement-breakpoint

-- Wall-clock HH:MM, 24 hour, and a window that ends after it starts. Because
-- the format is fixed, '>' on text is a real time comparison — which is why
-- these are stored as text rather than as an interval nobody can read.
--
-- A window that crosses midnight is NOT expressible, and that is deliberate:
-- 22:00–02:00 is two windows on two days, and permitting one row to mean both
-- would make every downstream date calculation ambiguous. No MMAKF facility
-- trains through midnight; if one ever does, it gets two rows.
ALTER TABLE "schedule_rules" ADD CONSTRAINT "schedule_rules_window_ck"
	CHECK (
		("kind" = 'closed' AND "opens_at" IS NULL AND "closes_at" IS NULL)
		OR (
			"kind" = 'open'
			AND "opens_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
			AND "closes_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
			AND "closes_at" > "opens_at"
		)
	);--> statement-breakpoint

-- 'closed' shuts the whole day and carries no times. Every other effect edits
-- specific windows and must state which. The pair is what lets "15 September:
-- closed for grading" and "15 September: mornings only, grading afterwards"
-- live in one table without a switch nobody can audit.
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_window_ck"
	CHECK (
		("effect" = 'closed' AND "opens_at" IS NULL AND "closes_at" IS NULL)
		OR (
			"effect" <> 'closed'
			AND "opens_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
			AND "closes_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
			AND "closes_at" > "opens_at"
		)
	);--> statement-breakpoint

-- AN ONLINE CLASS DOES NOT CONSUME A DOJO. Every other mode occupies a room and
-- must name it — including 'hybrid', which genuinely does occupy one. This is
-- the rule stated in the directive, put where it cannot be forgotten.
ALTER TABLE "dojo_classes" ADD CONSTRAINT "dojo_classes_venue_required_ck"
	CHECK ("mode" = 'online' OR "venue_id" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "dojo_classes" ADD CONSTRAINT "dojo_classes_age_ck"
	CHECK ("age_min" IS NULL OR "age_max" IS NULL OR "age_max" >= "age_min");--> statement-breakpoint

ALTER TABLE "dojo_classes" ADD CONSTRAINT "dojo_classes_capacity_ck"
	CHECK ("capacity" IS NULL OR "capacity" > 0);--> statement-breakpoint

ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_window_ck"
	CHECK ("ends_at" > "starts_at");--> statement-breakpoint

ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_local_window_ck"
	CHECK (
		"local_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
		AND "local_end" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
	);--> statement-breakpoint

-- Overbooking is a data-integrity failure, not a business decision, so the
-- database refuses it as well as the engine. `booked_count` is maintained
-- inside the same transaction that inserts the booking.
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_capacity_ck"
	CHECK ("booked_count" >= 0 AND ("capacity" IS NULL OR "booked_count" <= "capacity"));--> statement-breakpoint

ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_cancel_needs_reason_ck"
	CHECK ("status" <> 'cancelled' OR "cancelled_reason" IS NOT NULL);--> statement-breakpoint

ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_online_ck"
	CHECK ("mode" = 'online' OR "venue_id" IS NOT NULL);--> statement-breakpoint

-- ─── Additions to what already exists ───────────────────────────────────────
--
-- A ROOM NEEDS A CLOCK. `venues` had an address and no timezone, which is fine
-- while every venue is in one country and wrong the moment one is not. The
-- default is Asia/Kolkata because MMAKF is in India today — a default nobody
-- has to type is worth more than a null nobody notices — and it is a COLUMN so
-- that "assume IST" is never again a line of code.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "timezone" text DEFAULT 'Asia/Kolkata' NOT NULL;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "slug" text;--> statement-breakpoint
-- Coordinates for "find a club near me". numeric, not float: a rounded
-- coordinate is a different building.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "latitude" numeric(9, 6);--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "longitude" numeric(9, 6);--> statement-breakpoint
-- Civil geography, beside `state_unit_id` rather than instead of it: that column
-- says which chartered MMAKF body administers this room, this one says where on
-- the map it is. Same distinction migration 0025 drew for `persons`.
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "area_id" integer REFERENCES "admin_areas"("id");--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "parking" text;--> statement-breakpoint
ALTER TABLE "venues" ADD COLUMN IF NOT EXISTS "transport" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "venues_slug_uk" ON "venues" USING btree ("slug") WHERE "slug" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "venues_area_idx" ON "venues" USING btree ("area_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "venues_geo_point_idx" ON "venues" USING btree ("latitude", "longitude");--> statement-breakpoint

-- A club needs a stable public address of its own. Nullable and unique-when-set:
-- a club without one is not published, rather than published under a guessed
-- slug that changes the next time somebody corrects its name.
ALTER TABLE "dojos" ADD COLUMN IF NOT EXISTS "slug" text;--> statement-breakpoint
ALTER TABLE "dojos" ADD COLUMN IF NOT EXISTS "timezone" text DEFAULT 'Asia/Kolkata' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dojos_slug_uk" ON "dojos" USING btree ("slug") WHERE "slug" IS NOT NULL;--> statement-breakpoint

-- ONE COLUMN, NOT A SECOND BOOKING TABLE. `bookings` already allocates a
-- federation reference, records who created it, holds buffers either side and
-- is cancelled through an audited path. A class booking is one of those with a
-- session attached — modelling it separately would mean two cancellation paths,
-- and the second one would be the one that forgets to write the audit row.
ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "class_session_id" integer REFERENCES "class_sessions"("id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bookings_class_session_idx" ON "bookings" USING btree ("class_session_id");--> statement-breakpoint

-- A person may hold ONE live seat in a class session. Without this, the second
-- click of a double-tapped "Book" button is a second seat, the session fills
-- with one person, and `booked_count` is right about a number that is wrong.
CREATE UNIQUE INDEX IF NOT EXISTS "bookings_session_person_uk"
	ON "bookings" USING btree ("class_session_id", "person_id")
	WHERE "class_session_id" IS NOT NULL
		AND "person_id" IS NOT NULL
		AND "status" NOT IN ('cancelled', 'expired', 'no_show');
