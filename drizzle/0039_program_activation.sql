-- 0039 — a paid programme becomes training, and everything that comes with it.
--
-- WHAT WAS MISSING. 0023 built the entitlement spine: a verified capture turns
-- an order line into a membership, a cleared entry or a confirmed booking. The
-- federation's own description of what it sells is none of those. It sells a
-- TRAINING PROGRAMME to a school or a company, and a programme is not a flag —
-- it is a period during which people may be enrolled onto it, sessions may be
-- scheduled against it, coaches may be assigned to it, and the supporting
-- material (the technical library, live classes, course content) is reachable
-- by the people on its roll. When the period ends, all of that stops.
--
-- Three things this migration adds, and why each is a column rather than an
-- assumption in code:
--
--  1. entitlements.valid_from / valid_to — THE PERIOD, ON THE RECORD.
--
--     "For the period paid for" is the federation's phrase, and until now the
--     entitlements table had nowhere to put it. A membership's dates lived on
--     `memberships`; an entry's on the event. A programme has no such home, and
--     deriving the period at read time from the fee code would mean a fee rule
--     edited in 2028 silently re-dating what a school bought in 2026.
--
--     BOTH DATES, and neither invented. Where the federation has stated no
--     period the activation is BLOCKED with a reason, exactly as an
--     unconfigured membership term already is. A programme that quietly ran
--     "for a year" because this system picked twelve months would be MMAKF
--     policy set by a default value.
--
--     Nullable, because the rows written before this migration existed have no
--     period and must not be given a fabricated one. `valid_to` stays nullable
--     after it too: an open-ended entitlement is a real federation decision
--     (see entitlement_terms.open_ended) and is distinguishable from silence
--     only because the column can hold null.
--
--  2. entitlement_terms.resources — WHAT ELSE THE FEE INCLUDES.
--
--     The federation says a programme includes access to the technical library
--     and to live classes. Which resources a fee includes is a federation
--     decision and belongs beside the term that already records what the fee
--     buys and for how long. Absent, it grants NOTHING — not "everything",
--     which is the direction this class of default always fails in.
--
--  3. entitlement_resources — ONE ROW PER GRANT, WITH ITS OWN DATES.
--
--     Not a jsonb blob on the entitlement: every access check is a query on
--     (person, resource kind, today), and that has to be an index lookup rather
--     than a scan that deserialises a document per row. The dates are COPIED
--     onto the grant rather than joined from the parent, so a grant can be
--     withdrawn on its own — a library licence lapsing mid-programme does not
--     end the training the school paid for.
--
-- THE RULE THE PERIOD ENFORCES. Access is decided by comparing today against
-- these columns at the moment of the request, in SQL. There is no "active"
-- boolean to fall out of date, no nightly sweep to expire anything, and
-- therefore no window in which an expired entitlement still opens a door
-- because nobody has run the job yet. Expiry happens because the date passed.
--
-- NOTHING IS DELETED HERE EITHER. A refund revokes the grants with a timestamp
-- and a reason, and the rows stay. A school that stops paying keeps the record
-- of what it had, which is the only way to answer why the login stopped working.

-- ── The subject vocabulary gains the thing the federation actually sells ────
--
-- ADD VALUE rather than a new enum: `entitlement_subject` is referenced by
-- entitlements.subject and entitlement_terms.subject, and a parallel type would
-- mean two vocabularies for one question. Postgres 12 and later permit this
-- inside a transaction provided the new value is not USED in the same
-- transaction — nothing below inserts a 'program' row, so it is not.
ALTER TYPE "public"."entitlement_subject" ADD VALUE IF NOT EXISTS 'program';--> statement-breakpoint

-- An order line that pays for a programme. Without this the line has to be
-- billed as 'other', which would keep it out of entitlements.activationBacklog()
-- — the query that finds paid lines nothing was issued against. A programme
-- somebody paid for and nobody delivered would be invisible in the one place
-- built to make that visible.
ALTER TYPE "public"."order_line_kind" ADD VALUE IF NOT EXISTS 'program';--> statement-breakpoint

-- ── The period, on the entitlement itself ──────────────────────────────────
ALTER TABLE "entitlements" ADD COLUMN "valid_from" date;--> statement-breakpoint
ALTER TABLE "entitlements" ADD COLUMN "valid_to" date;--> statement-breakpoint
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_period_ck"
  CHECK ("valid_from" IS NULL OR "valid_to" IS NULL OR "valid_to" >= "valid_from");--> statement-breakpoint
-- The access check's index: every question it asks is "which live entitlements
-- cover today", and that has to be answerable without reading the table.
CREATE INDEX "entitlements_period_idx" ON "entitlements" USING btree ("subject","status","valid_from","valid_to");--> statement-breakpoint

-- ── What else the fee includes ─────────────────────────────────────────────
--
-- jsonb, and an ARRAY of objects rather than a set of boolean columns, because
-- a grant of a named course carries an id and a grant of the library does not.
-- Validated in src/db/activation.ts against a closed vocabulary; anything the
-- vocabulary does not recognise is REFUSED at configuration time rather than
-- ignored at activation time, so a typo cannot silently grant nothing.
ALTER TABLE "entitlement_terms" ADD COLUMN "resources" jsonb;--> statement-breakpoint

-- ── The grants ─────────────────────────────────────────────────────────────
--
-- A CLOSED vocabulary. Every value here names something that already exists in
-- this database and that a surface already reads:
--
--   technical_library  src/db/library.ts — kata, movements, terms, media
--   live_classes       education.schema.ts `live_classes`
--   course             education.schema.ts `courses` — the course itself
--   course_material    the lessons and downloads inside one course
--
-- There is no 'everything' member, deliberately. A grant this system could not
-- name is a grant nobody approved.
CREATE TYPE "public"."entitlement_resource_kind" AS ENUM('technical_library', 'live_classes', 'course', 'course_material');--> statement-breakpoint

CREATE TABLE "entitlement_resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"entitlement_id" integer NOT NULL,
	"resource_kind" "entitlement_resource_kind" NOT NULL,
	-- Which one, where the kind names a particular thing. NULL for the
	-- whole-surface grants, and the CHECK below makes the two states impossible
	-- to confuse: a 'course' grant with no course is not "all courses", it is a
	-- row somebody failed to fill in, and it is refused.
	"resource_id" integer,
	-- Copied from the entitlement at activation, never joined at read time. A
	-- grant is withdrawable on its own terms, and a period that is really the
	-- parent's period would make that impossible to express.
	"valid_from" date NOT NULL,
	"valid_to" date,
	"status" "entitlement_status" DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_resources_target_ck" CHECK (
		("resource_kind" IN ('course', 'course_material')) = ("resource_id" IS NOT NULL)
	),
	CONSTRAINT "entitlement_resources_period_ck" CHECK ("valid_to" IS NULL OR "valid_to" >= "valid_from")
);
--> statement-breakpoint

ALTER TABLE "entitlement_resources" ADD CONSTRAINT "entitlement_resources_entitlement_id_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."entitlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- THE REPLAY GUARD FOR GRANTS. A webhook retry that gets past the entitlement
-- claim — it cannot, but the claim is one index and this is the other — must
-- not double the grants. coalesce(), because NULLs are distinct from one
-- another in a unique index and two whole-library grants would both be allowed.
CREATE UNIQUE INDEX "entitlement_resources_uk" ON "entitlement_resources"
  USING btree ("entitlement_id","resource_kind",(coalesce("resource_id", 0)));--> statement-breakpoint

-- The access check, in one index: kind, target, status, then the dates it
-- compares today against.
CREATE INDEX "entitlement_resources_lookup_idx" ON "entitlement_resources"
  USING btree ("resource_kind","resource_id","status","valid_from","valid_to");--> statement-breakpoint
CREATE INDEX "entitlement_resources_entitlement_idx" ON "entitlement_resources" USING btree ("entitlement_id");--> statement-breakpoint

-- The other half of the access check: from a person to the programmes they are
-- on the roll for. `program_participants` was created by 0011 with an index on
-- program_id alone, which answers "who is on this programme" and not "which
-- programmes is this person on" — and the second is the one every access check
-- asks. Without it the check is a sequential scan of every participant in the
-- federation, per request.
CREATE INDEX "program_participants_person_idx" ON "program_participants" USING btree ("person_id","left_on");--> statement-breakpoint

-- ONE ROLL ENTRY PER PERSON PER PROGRAMME. This is the replay guard for
-- registration, and it is here rather than in application code for the reason
-- every other guard in this system is: two administrators submitting the same
-- child at the same moment both read "not on the roll yet", and only the
-- database can settle which of them wins.
--
-- PARTIAL, because a school cohort the federation holds no person record for is
-- stored with a display name and a null person_id, and NULLs are distinct from
-- one another in a unique index — a whole class of thirty would otherwise be
-- thirty collisions or, worse, would appear to be permitted and then not be.
--
-- If this statement fails on an existing database it is because a programme
-- already has the same person on its roll twice, which is a data fault worth
-- stopping for rather than indexing around.
CREATE UNIQUE INDEX "program_participants_person_uk" ON "program_participants"
  USING btree ("program_id","person_id") WHERE "person_id" IS NOT NULL;
