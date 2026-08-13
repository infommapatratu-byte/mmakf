-- 0011 — the federation's operations platform.
--
-- Hand-written, like every migration since 0004. drizzle.config.ts points at
-- src/db/schema.ts alone, so `drizzle-kit generate` sees one of the ten schema
-- files and would emit DROP TABLE for the other hundred and seventeen. See the
-- note at the top of 0007 for what happened the last time generated and
-- hand-written statements were mixed.
--
-- Adds 27 tables and one enum value. Nothing here duplicates an existing table;
-- where something came close, src/db/operations.schema.ts says why it is not
-- the same thing.

-- ── An institution is a tenant, not a rung of the federation ────────────────
-- Adding a label is transactional from PostgreSQL 12 onward provided the new
-- label is not USED in the same transaction. Nothing below defaults to it, so
-- this is safe inside the per-file transaction scripts/migrate.mjs opens.
ALTER TYPE "public"."scope_type" ADD VALUE IF NOT EXISTS 'institution';--> statement-breakpoint

CREATE TYPE "public"."program_template_status" AS ENUM('draft', 'under_review', 'approved', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."institution_application_status" AS ENUM('draft', 'submitted', 'acknowledged', 'under_review', 'information_requested', 'program_design', 'quoted', 'proposed', 'approved', 'contracted', 'declined', 'withdrawn', 'expired');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'in_progress', 'blocked', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."workflow_run_status" AS ENUM('pending', 'running', 'succeeded', 'partially_failed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."coach_status" AS ENUM('candidate', 'screening', 'interview', 'technical_review', 'document_check', 'approved', 'active', 'suspended', 'inactive', 'withdrawn', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."coach_assignment_status" AS ENUM('recommended', 'proposed', 'accepted', 'declined', 'confirmed', 'withdrawn', 'completed');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('draft', 'issued', 'signed', 'active', 'completed', 'terminated', 'expired');--> statement-breakpoint
CREATE TYPE "public"."client_document_kind" AS ENUM('quote', 'proposal', 'contract', 'invoice', 'report', 'certificate', 'program_document', 'correspondence', 'other');--> statement-breakpoint
CREATE TYPE "public"."program_session_status" AS ENUM('scheduled', 'delivered', 'cancelled', 'rescheduled', 'no_show');--> statement-breakpoint

CREATE TABLE "program_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"audience" "audience_kind" NOT NULL,
	"service_id" integer,
	"status" "program_template_status" DEFAULT 'draft' NOT NULL,
	"summary" text,
	"curriculum_outline" text,
	"age_bands" jsonb,
	"min_participants" integer,
	"max_participants" integer,
	"sessions_per_week" integer,
	"duration_weeks" integer,
	"session_minutes" integer,
	"min_instructor_grade" text,
	"instructors_required" integer,
	"facility_requirement" text,
	"equipment_requirement" text,
	"includes_assessment" boolean,
	"includes_grading" boolean,
	"includes_certification" boolean,
	"includes_competition" boolean,
	"includes_reporting" boolean,
	"modes" jsonb,
	"created_by_user_id" integer,
	"reviewed_by_user_id" integer,
	"approved_by_user_id" integer,
	"approved_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institution_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"audience" "audience_kind" NOT NULL,
	"status" "institution_application_status" DEFAULT 'draft' NOT NULL,
	"institution_id" integer,
	"lead_id" integer,
	"request_id" integer,
	"institution_name" text NOT NULL,
	"campus_name" text,
	"address_line" text,
	"city" text,
	"postcode" text,
	"state_unit_id" integer,
	"district_unit_id" integer,
	"state_name" text,
	"population_count" integer,
	"participant_count" integer,
	"batch_count" integer,
	"campus_count" integer,
	"age_bands" jsonb,
	"requirements" text,
	"program_template_id" integer,
	"service_id" integer,
	"frequency_per_week" integer,
	"duration_weeks" integer,
	"mode" "delivery_mode",
	"infrastructure" jsonb,
	"instructor_requirement" text,
	"instructors_required" integer,
	"wants_assessment" boolean,
	"wants_grading" boolean,
	"wants_certification" boolean,
	"wants_competition" boolean,
	"special_requirements" text,
	"contact_name" text,
	"contact_role" text,
	"contact_email" text,
	"contact_phone" text,
	"decision_maker_name" text,
	"decision_maker_role" text,
	"decision_maker_email" text,
	"preferred_start" date,
	"payload" jsonb,
	"source" jsonb,
	"access_token" text,
	"step_reached" integer DEFAULT 1 NOT NULL,
	"lead_score" integer,
	"owner_user_id" integer,
	"owner_role" text,
	"sla_due_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"first_contact_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" integer,
	"decision_reason" text,
	"superseded_by_application_id" integer,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"detail" jsonb,
	"actor_user_id" integer,
	"visible_to_applicant" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "routing_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"audience" "audience_kind",
	"state_unit_id" integer,
	"district_unit_id" integer,
	"service_id" integer,
	"min_participants" integer,
	"max_participants" integer,
	"target_role" text,
	"target_user_id" integer,
	"department" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"default_role" text,
	"default_priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"due_in_hours" integer,
	"escalate_after_hours" integer,
	"escalate_to_role" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"template_code" text,
	"title" text NOT NULL,
	"detail" text,
	"subject_kind" text,
	"subject_id" integer,
	"institution_id" integer,
	"assigned_role" text,
	"assigned_user_id" integer,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"due_at" timestamp with time zone,
	"escalate_at" timestamp with time zone,
	"escalated_at" timestamp with time zone,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by_user_id" integer,
	"outcome" text,
	"idempotency_key" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"depends_on_task_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"note" text,
	"actor_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"trigger" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"definition" jsonb NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"workflow_code" text NOT NULL,
	"workflow_version" integer DEFAULT 1 NOT NULL,
	"trigger" text NOT NULL,
	"subject_kind" text,
	"subject_id" integer,
	"idempotency_key" text NOT NULL,
	"status" "workflow_run_status" DEFAULT 'pending' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"context" jsonb,
	"result" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_steps" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" integer NOT NULL,
	"seq" integer NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"params" jsonb,
	"result" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "coach_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"status" "coach_status" DEFAULT 'candidate' NOT NULL,
	"headline" text,
	"bio" text,
	"dan_grade" text,
	"teaching_since" date,
	"languages" jsonb,
	"age_bands" jsonb,
	"program_codes" jsonb,
	"state_unit_id" integer,
	"district_unit_id" integer,
	"home_dojo_id" integer,
	"base_city" text,
	"travel_radius_km" integer,
	"max_sessions_per_week" integer,
	"safeguarding_cleared_on" date,
	"safeguarding_expires_on" date,
	"approved_at" timestamp with time zone,
	"approved_by_user_id" integer,
	"suspended_at" timestamp with time zone,
	"suspended_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"coach_profile_id" integer,
	"person_id" integer,
	"user_id" integer,
	"full_name" text NOT NULL,
	"email" text,
	"phone" text,
	"city" text,
	"state_unit_id" integer,
	"district_unit_id" integer,
	"dan_grade" text,
	"grade_awarded_by" text,
	"teaching_years" integer,
	"competition_experience" text,
	"qualifications_summary" text,
	"preferred_programs" jsonb,
	"preferred_locations" jsonb,
	"availability_note" text,
	"languages" jsonb,
	"referees" jsonb,
	"status" "coach_status" DEFAULT 'candidate' NOT NULL,
	"payload" jsonb,
	"source" jsonb,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" integer,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_stage_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_status" "coach_status",
	"to_status" "coach_status" NOT NULL,
	"outcome" text,
	"note" text,
	"actor_user_id" integer
);
--> statement-breakpoint
CREATE TABLE "coach_qualifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"coach_profile_id" integer NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"issued_by" text,
	"issued_on" date,
	"expires_on" date,
	"reference_no" text,
	"verified_at" timestamp with time zone,
	"verified_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"coach_profile_id" integer,
	"application_id" integer,
	"kind" text NOT NULL,
	"title" text,
	"filename" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text,
	"size_bytes" integer,
	"confidential" boolean DEFAULT true NOT NULL,
	"uploaded_by_user_id" integer,
	"verified_at" timestamp with time zone,
	"verified_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"program_id" integer,
	"booking_id" integer,
	"coach_person_id" integer NOT NULL,
	"coach_profile_id" integer,
	"role" text DEFAULT 'lead' NOT NULL,
	"status" "coach_assignment_status" DEFAULT 'recommended' NOT NULL,
	"score" integer,
	"rationale" jsonb,
	"recommended_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by_user_id" integer,
	"notified_at" timestamp with time zone,
	"decline_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_cpd" (
	"id" serial PRIMARY KEY NOT NULL,
	"coach_profile_id" integer NOT NULL,
	"title" text NOT NULL,
	"provider" text,
	"hours" integer,
	"completed_on" date,
	"evidence_url" text,
	"verified_at" timestamp with time zone,
	"verified_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coach_performance" (
	"id" serial PRIMARY KEY NOT NULL,
	"coach_profile_id" integer NOT NULL,
	"period_from" date NOT NULL,
	"period_to" date NOT NULL,
	"sessions_scheduled" integer,
	"sessions_delivered" integer,
	"sessions_cancelled_by_coach" integer,
	"participants_attended" integer,
	"participants_expected" integer,
	"institution_feedback_count" integer,
	"note" text,
	"recorded_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'other' NOT NULL,
	"dojo_id" integer,
	"institution_id" integer,
	"address_line" text,
	"city" text,
	"postcode" text,
	"state_unit_id" integer,
	"district_unit_id" integer,
	"capacity" integer,
	"mat_area_sqm" integer,
	"facilities" jsonb,
	"accessibility" jsonb,
	"equipment" jsonb,
	"contact_name" text,
	"contact_phone" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venue_blackouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"venue_id" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contracts" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"institution_id" integer NOT NULL,
	"application_id" integer,
	"proposal_id" integer,
	"quote_version_id" integer,
	"program_id" integer,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"value_minor" integer,
	"currency" text DEFAULT 'INR' NOT NULL,
	"terms_summary" text,
	"signed_by_name" text,
	"signed_by_role" text,
	"signed_at" timestamp with time zone,
	"signature_method" text,
	"countersigned_by_user_id" integer,
	"renewal_of_contract_id" integer,
	"terminated_at" timestamp with time zone,
	"termination_reason" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"institution_id" integer NOT NULL,
	"kind" "client_document_kind" NOT NULL,
	"title" text NOT NULL,
	"subject_kind" text,
	"subject_id" integer,
	"filename" text,
	"storage_key" text,
	"content_type" text,
	"size_bytes" integer,
	"checksum" text,
	"visible_to_client" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"superseded_by_document_id" integer,
	"uploaded_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institution_users" (
	"id" serial PRIMARY KEY NOT NULL,
	"institution_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" text DEFAULT 'INSTITUTION_COORDINATOR' NOT NULL,
	"title" text,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_by_user_id" integer,
	"invited_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"program_id" integer NOT NULL,
	"booking_id" integer,
	"seq" integer NOT NULL,
	"title" text,
	"topic" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"venue_id" integer,
	"coach_person_id" integer,
	"status" "program_session_status" DEFAULT 'scheduled' NOT NULL,
	"delivered_at" timestamp with time zone,
	"cancelled_reason" text,
	"rescheduled_to_session_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_attendance" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"participant_id" integer NOT NULL,
	"present" boolean DEFAULT true NOT NULL,
	"note" text,
	"corrected_from_present" boolean,
	"corrected_at" timestamp with time zone,
	"corrected_by_user_id" integer,
	"recorded_by_user_id" integer,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"author_kind" text NOT NULL,
	"author_user_id" integer,
	"author_name" text,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"attachments" jsonb
);
--> statement-breakpoint

-- ── The existing ticket table gains a tenant and an escalation clock ────────
-- Extended rather than replaced: support_tickets already carries the number,
-- category, SLA and resolution, and a second ticket table would mean two places
-- to look for the same complaint.
ALTER TABLE "support_tickets" ADD COLUMN "institution_id" integer;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "escalation_level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "reopened_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint

-- ── Notifications learn to address someone who has no account ──────────────
ALTER TABLE "notifications" ADD COLUMN "recipient_email" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "recipient_name" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "template" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "topic" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "priority" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "institution_id" integer;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_uk" ON "notifications" USING btree ("dedupe_key");--> statement-breakpoint

-- ── Foreign keys ───────────────────────────────────────────────────────────
ALTER TABLE "program_templates" ADD CONSTRAINT "program_templates_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_templates" ADD CONSTRAINT "program_templates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_templates" ADD CONSTRAINT "program_templates_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_templates" ADD CONSTRAINT "program_templates_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_applications" ADD CONSTRAINT "institution_applications_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_applications" ADD CONSTRAINT "institution_applications_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_applications" ADD CONSTRAINT "institution_applications_request_id_training_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."training_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_applications" ADD CONSTRAINT "institution_applications_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_applications" ADD CONSTRAINT "institution_applications_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_applications" ADD CONSTRAINT "institution_applications_program_template_id_program_templates_id_fk" FOREIGN KEY ("program_template_id") REFERENCES "public"."program_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_applications" ADD CONSTRAINT "institution_applications_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_applications" ADD CONSTRAINT "institution_applications_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_applications" ADD CONSTRAINT "institution_applications_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_applications" ADD CONSTRAINT "institution_applications_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_institution_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."institution_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routing_rules" ADD CONSTRAINT "routing_rules_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_user_id_users_id_fk" FOREIGN KEY ("assigned_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_user_id_users_id_fk" FOREIGN KEY ("completed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_depends_on_task_id_tasks_id_fk" FOREIGN KEY ("depends_on_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_definitions" ADD CONSTRAINT "workflow_definitions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_profiles" ADD CONSTRAINT "coach_profiles_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_profiles" ADD CONSTRAINT "coach_profiles_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_profiles" ADD CONSTRAINT "coach_profiles_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_profiles" ADD CONSTRAINT "coach_profiles_home_dojo_id_dojos_id_fk" FOREIGN KEY ("home_dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_profiles" ADD CONSTRAINT "coach_profiles_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_applications" ADD CONSTRAINT "coach_applications_coach_profile_id_coach_profiles_id_fk" FOREIGN KEY ("coach_profile_id") REFERENCES "public"."coach_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_applications" ADD CONSTRAINT "coach_applications_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_applications" ADD CONSTRAINT "coach_applications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_applications" ADD CONSTRAINT "coach_applications_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_applications" ADD CONSTRAINT "coach_applications_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_applications" ADD CONSTRAINT "coach_applications_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_stage_events" ADD CONSTRAINT "coach_stage_events_application_id_coach_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."coach_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_stage_events" ADD CONSTRAINT "coach_stage_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_qualifications" ADD CONSTRAINT "coach_qualifications_coach_profile_id_coach_profiles_id_fk" FOREIGN KEY ("coach_profile_id") REFERENCES "public"."coach_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_qualifications" ADD CONSTRAINT "coach_qualifications_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_documents" ADD CONSTRAINT "coach_documents_coach_profile_id_coach_profiles_id_fk" FOREIGN KEY ("coach_profile_id") REFERENCES "public"."coach_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_documents" ADD CONSTRAINT "coach_documents_application_id_coach_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."coach_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_documents" ADD CONSTRAINT "coach_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_documents" ADD CONSTRAINT "coach_documents_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_assignments" ADD CONSTRAINT "coach_assignments_program_id_training_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."training_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_assignments" ADD CONSTRAINT "coach_assignments_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_assignments" ADD CONSTRAINT "coach_assignments_coach_person_id_persons_id_fk" FOREIGN KEY ("coach_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_assignments" ADD CONSTRAINT "coach_assignments_coach_profile_id_coach_profiles_id_fk" FOREIGN KEY ("coach_profile_id") REFERENCES "public"."coach_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_assignments" ADD CONSTRAINT "coach_assignments_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_cpd" ADD CONSTRAINT "coach_cpd_coach_profile_id_coach_profiles_id_fk" FOREIGN KEY ("coach_profile_id") REFERENCES "public"."coach_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_cpd" ADD CONSTRAINT "coach_cpd_verified_by_user_id_users_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_performance" ADD CONSTRAINT "coach_performance_coach_profile_id_coach_profiles_id_fk" FOREIGN KEY ("coach_profile_id") REFERENCES "public"."coach_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_performance" ADD CONSTRAINT "coach_performance_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_dojo_id_dojos_id_fk" FOREIGN KEY ("dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venues" ADD CONSTRAINT "venues_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_blackouts" ADD CONSTRAINT "venue_blackouts_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_blackouts" ADD CONSTRAINT "venue_blackouts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_application_id_institution_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."institution_applications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_quote_version_id_quote_versions_id_fk" FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_program_id_training_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."training_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_countersigned_by_user_id_users_id_fk" FOREIGN KEY ("countersigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "client_documents" ADD CONSTRAINT "client_documents_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_users" ADD CONSTRAINT "institution_users_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_users" ADD CONSTRAINT "institution_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_users" ADD CONSTRAINT "institution_users_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_sessions" ADD CONSTRAINT "program_sessions_program_id_training_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."training_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_sessions" ADD CONSTRAINT "program_sessions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_sessions" ADD CONSTRAINT "program_sessions_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_sessions" ADD CONSTRAINT "program_sessions_coach_person_id_persons_id_fk" FOREIGN KEY ("coach_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_attendance" ADD CONSTRAINT "program_attendance_session_id_program_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."program_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_attendance" ADD CONSTRAINT "program_attendance_participant_id_program_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."program_participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_attendance" ADD CONSTRAINT "program_attendance_corrected_by_user_id_users_id_fk" FOREIGN KEY ("corrected_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_attendance" ADD CONSTRAINT "program_attendance_recorded_by_user_id_users_id_fk" FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_ticket_id_support_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_messages" ADD CONSTRAINT "ticket_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ── Indexes ────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX "program_templates_code_uk" ON "program_templates" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "program_templates_slug_uk" ON "program_templates" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "program_templates_audience_idx" ON "program_templates" USING btree ("audience","status");--> statement-breakpoint
CREATE UNIQUE INDEX "institution_applications_ref_uk" ON "institution_applications" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "institution_applications_status_idx" ON "institution_applications" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "institution_applications_inst_idx" ON "institution_applications" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "institution_applications_owner_idx" ON "institution_applications" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "institution_applications_sla_idx" ON "institution_applications" USING btree ("sla_due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "institution_applications_token_uk" ON "institution_applications" USING btree ("access_token");--> statement-breakpoint
CREATE INDEX "application_events_app_idx" ON "application_events" USING btree ("application_id","at");--> statement-breakpoint
CREATE INDEX "routing_rules_active_idx" ON "routing_rules" USING btree ("active","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "task_templates_code_uk" ON "task_templates" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_ref_uk" ON "tasks" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_idempotency_uk" ON "tasks" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "tasks_queue_idx" ON "tasks" USING btree ("status","due_at");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assigned_user_id","status");--> statement-breakpoint
CREATE INDEX "tasks_role_idx" ON "tasks" USING btree ("assigned_role","status");--> statement-breakpoint
CREATE INDEX "tasks_subject_idx" ON "tasks" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "tasks_escalation_idx" ON "tasks" USING btree ("escalate_at","escalated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "task_dependencies_uk" ON "task_dependencies" USING btree ("task_id","depends_on_task_id");--> statement-breakpoint
CREATE INDEX "task_events_task_idx" ON "task_events" USING btree ("task_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_code_version_uk" ON "workflow_definitions" USING btree ("code","version");--> statement-breakpoint
CREATE INDEX "workflow_definitions_trigger_idx" ON "workflow_definitions" USING btree ("trigger","active");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_idempotency_uk" ON "workflow_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "workflow_runs_status_idx" ON "workflow_runs" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "workflow_runs_subject_idx" ON "workflow_runs" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "workflow_steps_run_idx" ON "workflow_steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "coach_profiles_person_uk" ON "coach_profiles" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "coach_profiles_status_idx" ON "coach_profiles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "coach_profiles_geo_idx" ON "coach_profiles" USING btree ("state_unit_id","district_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "coach_applications_ref_uk" ON "coach_applications" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "coach_applications_status_idx" ON "coach_applications" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "coach_stage_events_app_idx" ON "coach_stage_events" USING btree ("application_id","at");--> statement-breakpoint
CREATE INDEX "coach_qualifications_coach_idx" ON "coach_qualifications" USING btree ("coach_profile_id","kind");--> statement-breakpoint
CREATE INDEX "coach_qualifications_expiry_idx" ON "coach_qualifications" USING btree ("expires_on");--> statement-breakpoint
CREATE INDEX "coach_documents_coach_idx" ON "coach_documents" USING btree ("coach_profile_id");--> statement-breakpoint
CREATE INDEX "coach_assignments_program_idx" ON "coach_assignments" USING btree ("program_id","status");--> statement-breakpoint
CREATE INDEX "coach_assignments_coach_idx" ON "coach_assignments" USING btree ("coach_person_id","status");--> statement-breakpoint
CREATE INDEX "coach_cpd_coach_idx" ON "coach_cpd" USING btree ("coach_profile_id");--> statement-breakpoint
CREATE INDEX "coach_performance_coach_idx" ON "coach_performance" USING btree ("coach_profile_id","period_from");--> statement-breakpoint
CREATE UNIQUE INDEX "venues_code_uk" ON "venues" USING btree ("code");--> statement-breakpoint
CREATE INDEX "venues_geo_idx" ON "venues" USING btree ("state_unit_id","district_unit_id");--> statement-breakpoint
CREATE INDEX "venues_institution_idx" ON "venues" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "venue_blackouts_venue_idx" ON "venue_blackouts" USING btree ("venue_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contracts_ref_uk" ON "contracts" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "contracts_institution_idx" ON "contracts" USING btree ("institution_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "client_documents_ref_uk" ON "client_documents" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "client_documents_institution_idx" ON "client_documents" USING btree ("institution_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "institution_users_uk" ON "institution_users" USING btree ("institution_id","user_id");--> statement-breakpoint
CREATE INDEX "institution_users_user_idx" ON "institution_users" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "program_sessions_seq_uk" ON "program_sessions" USING btree ("program_id","seq");--> statement-breakpoint
CREATE INDEX "program_sessions_program_idx" ON "program_sessions" USING btree ("program_id","starts_at");--> statement-breakpoint
CREATE INDEX "program_sessions_coach_idx" ON "program_sessions" USING btree ("coach_person_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "program_attendance_uk" ON "program_attendance" USING btree ("session_id","participant_id");--> statement-breakpoint
CREATE INDEX "program_attendance_session_idx" ON "program_attendance" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ticket_messages_ticket_idx" ON "ticket_messages" USING btree ("ticket_id","at");--> statement-breakpoint
CREATE INDEX "support_tickets_institution_idx" ON "support_tickets" USING btree ("institution_id","status");
