-- 0042 — delivery, certification and renewal: the last hop of a programme.
--
-- The engagement chain already ended at "sessions were delivered". Two facts
-- had nowhere to live after that, and both are facts the federation has to
-- defend to somebody:
--
--   (1) THIS PARTICIPANT MAY BE CERTIFIED, on this evidence, as at this moment.
--   (2) THIS ENTITLEMENT IS ABOUT TO EXPIRE AND THE HOLDER WAS TOLD, on this
--       date, with this much notice.
--
-- Both are recorded rather than derived, and the reason is the same in each
-- case: the query that would derive them reads the register AS IT IS NOW, and
-- the question being asked is about how it stood WHEN SOMEBODY ACTED. A
-- correction, a late mark or a renewal changes the answer afterwards.
--
-- WHY NO ATTENDANCE THRESHOLD APPEARS IN THIS FILE. MMAKF has published no
-- minimum attendance requirement for certification. The counts are stored; the
-- verdict above the floor is a named human's. A CHECK constraint encoding
-- "present >= 80% of delivered" would be this migration writing federation
-- policy, and it would be invisible to everyone who later wondered where the
-- rule came from. See src/db/programme-lifecycle.schema.ts.

CREATE TYPE "programme_certification_status" AS ENUM (
	'eligible', 'ineligible', 'issued', 'declined', 'blocked'
);--> statement-breakpoint

CREATE TABLE "programme_certifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"program_id" integer NOT NULL,
	"participant_id" integer NOT NULL,
	-- Nullable on purpose: a school cohort child the federation holds no person
	-- record for. certificates.person_id is NOT NULL, so such a participant can
	-- be assessed and approved and still not be issuable — recorded as
	-- 'blocked' with the reason, never silently skipped.
	"person_id" integer,

	"status" "programme_certification_status" DEFAULT 'eligible' NOT NULL,

	-- The register, frozen at assessment. `sessions_unrecorded` is deliberately
	-- its own number and is NOT folded into absences: the register is silent
	-- about those sessions, and turning silence into an absence would be this
	-- system inventing attendance in the direction that harms the participant.
	"sessions_delivered" integer NOT NULL,
	"marks_recorded" integer NOT NULL,
	"sessions_present" integer NOT NULL,
	"sessions_absent" integer NOT NULL,
	"sessions_unrecorded" integer NOT NULL,
	"assessed_at" timestamp with time zone DEFAULT now() NOT NULL,

	"task_id" integer,
	"certificate_id" integer,

	"approved_by_user_id" integer,
	"approved_at" timestamp with time zone,
	"reason" text,
	"detail" jsonb,

	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

ALTER TABLE "programme_certifications" ADD CONSTRAINT "programme_certifications_program_id_training_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."training_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programme_certifications" ADD CONSTRAINT "programme_certifications_participant_id_program_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."program_participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programme_certifications" ADD CONSTRAINT "programme_certifications_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programme_certifications" ADD CONSTRAINT "programme_certifications_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programme_certifications" ADD CONSTRAINT "programme_certifications_certificate_id_certificates_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programme_certifications" ADD CONSTRAINT "programme_certifications_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- THE IDEMPOTENCY GUARANTEE, and the whole reason two concurrent completions
-- cannot issue two certificates to one child. One assessment per participant
-- per programme, decided by the database and not by a SELECT that both callers
-- pass.
CREATE UNIQUE INDEX "programme_certifications_participant_uk" ON "programme_certifications" USING btree ("program_id","participant_id");--> statement-breakpoint

-- A certificate belongs to exactly one certification row. NULLs are distinct in
-- a Postgres unique index, so the many rows that carry no certificate yet sit
-- here without colliding.
CREATE UNIQUE INDEX "programme_certifications_certificate_uk" ON "programme_certifications" USING btree ("certificate_id");--> statement-breakpoint

CREATE INDEX "programme_certifications_program_status_idx" ON "programme_certifications" USING btree ("program_id","status");--> statement-breakpoint
CREATE INDEX "programme_certifications_person_idx" ON "programme_certifications" USING btree ("person_id");--> statement-breakpoint

-- Counts are counts. A negative one means the assessment arithmetic is wrong,
-- and it would otherwise reach a certificate snapshot and be printed.
ALTER TABLE "programme_certifications" ADD CONSTRAINT "programme_certifications_counts_ck"
	CHECK (
		"sessions_delivered" >= 0 AND "marks_recorded" >= 0 AND
		"sessions_present" >= 0 AND "sessions_absent" >= 0 AND
		"sessions_unrecorded" >= 0 AND
		"sessions_present" + "sessions_absent" = "marks_recorded" AND
		"marks_recorded" + "sessions_unrecorded" = "sessions_delivered"
	);--> statement-breakpoint

-- An issued certification names its certificate. Without this the 'issued'
-- status could drift away from the document it claims exists, which is exactly
-- the state a verification endpoint cannot explain.
ALTER TABLE "programme_certifications" ADD CONSTRAINT "programme_certifications_issued_ck"
	CHECK ("status" <> 'issued' OR "certificate_id" IS NOT NULL);--> statement-breakpoint

CREATE TABLE "renewal_notices" (
	"id" serial PRIMARY KEY NOT NULL,
	"entitlement_id" integer NOT NULL,
	"subject" "entitlement_subject" NOT NULL,
	"subject_id" integer,
	"person_id" integer,

	"expires_on" date NOT NULL,
	-- The warning actually given, in days. Unreconstructible later: the sweep's
	-- window is an argument the federation passes in, because MMAKF has
	-- published no renewal window for anyone to look up.
	"notice_days" integer NOT NULL,
	-- Where the expiry date came from, in words — 'memberships.valid_to', and
	-- so on. Never a guess, and never a term this system derived on its own.
	"basis" text NOT NULL,

	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"domain_event_id" integer
);--> statement-breakpoint

ALTER TABLE "renewal_notices" ADD CONSTRAINT "renewal_notices_entitlement_id_entitlements_id_fk" FOREIGN KEY ("entitlement_id") REFERENCES "public"."entitlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "renewal_notices" ADD CONSTRAINT "renewal_notices_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ONCE, AND ONCE PER TERM. A sweep run every morning writes one notice for a
-- given expiry and no more; an entitlement that is renewed acquires a new
-- expiry date and therefore earns a new notice when its next window opens. No
-- scheduling state is kept anywhere, and none has to be.
CREATE UNIQUE INDEX "renewal_notices_term_uk" ON "renewal_notices" USING btree ("entitlement_id","expires_on");--> statement-breakpoint
CREATE INDEX "renewal_notices_expiry_idx" ON "renewal_notices" USING btree ("expires_on");--> statement-breakpoint
CREATE INDEX "renewal_notices_person_idx" ON "renewal_notices" USING btree ("person_id");--> statement-breakpoint

ALTER TABLE "renewal_notices" ADD CONSTRAINT "renewal_notices_notice_days_ck"
	CHECK ("notice_days" >= 0);
