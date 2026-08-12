-- The two ALTER TYPE "audit_action" ADD VALUE statements drizzle-kit emitted
-- here were removed: 0006_membership_lifecycle.sql already applied them, and
-- drizzle-kit regenerated them because that migration is hand-written and not
-- in its journal. Re-adding an existing enum label is an error, and it rolled
-- this entire file back until they were taken out.
CREATE TYPE "public"."audience_kind" AS ENUM('individual', 'family', 'school', 'university', 'corporate', 'government', 'ngo', 'club', 'community', 'other');--> statement-breakpoint
CREATE TYPE "public"."availability_kind" AS ENUM('available', 'unavailable', 'leave', 'travel', 'tentative');--> statement-breakpoint
CREATE TYPE "public"."booking_kind" AS ENUM('consultation', 'class', 'personal_coaching', 'institutional_session', 'seminar', 'assessment', 'other');--> statement-breakpoint
CREATE TYPE "public"."booking_status" AS ENUM('requested', 'qualification_required', 'proposed', 'confirmed', 'rescheduled', 'cancelled', 'completed', 'no_show', 'expired');--> statement-breakpoint
CREATE TYPE "public"."calendar_connection_status" AS ENUM('connected', 'expired', 'revoked', 'error');--> statement-breakpoint
CREATE TYPE "public"."calendar_provider" AS ENUM('google', 'microsoft', 'ics');--> statement-breakpoint
CREATE TYPE "public"."calendar_sync_status" AS ENUM('pending', 'synced', 'failed', 'deleted_remotely', 'conflict');--> statement-breakpoint
CREATE TYPE "public"."delivery_mode" AS ENUM('on_site', 'at_dojo', 'online', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."push_delivery_outcome" AS ENUM('queued', 'sent', 'failed', 'expired', 'suppressed_quiet_hours', 'suppressed_preference', 'suppressed_duplicate');--> statement-breakpoint
CREATE TYPE "public"."fee_rule_kind" AS ENUM('base', 'per_participant', 'per_session', 'per_batch', 'per_campus', 'per_instructor', 'per_km', 'multiplier', 'fixed_add', 'discount', 'tax');--> statement-breakpoint
CREATE TYPE "public"."fee_framework_status" AS ENUM('draft', 'published', 'superseded', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."institution_status" AS ENUM('prospect', 'qualified', 'contracted', 'active', 'dormant', 'former', 'declined');--> statement-breakpoint
CREATE TYPE "public"."lead_source_kind" AS ENUM('organic_search', 'paid_search', 'social', 'youtube', 'referral', 'event', 'qr', 'campaign', 'direct', 'partner', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'qualifying', 'qualified', 'quoted', 'proposed', 'won', 'lost', 'dormant', 'disqualified');--> statement-breakpoint
CREATE TYPE "public"."training_program_status" AS ENUM('planned', 'scheduled', 'running', 'paused', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."proposal_status" AS ENUM('draft', 'issued', 'accepted', 'rejected', 'expired', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."push_device_status" AS ENUM('active', 'expired', 'unsubscribed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."quote_status" AS ENUM('draft', 'awaiting_approval', 'issued', 'accepted', 'rejected', 'expired', 'withdrawn', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."training_request_status" AS ENUM('submitted', 'qualifying', 'quoted', 'proposed', 'accepted', 'declined', 'withdrawn', 'expired');--> statement-breakpoint
CREATE TYPE "public"."service_category" AS ENUM('training', 'education', 'competition', 'grading', 'consultancy', 'event', 'certification');--> statement-breakpoint
CREATE TYPE "public"."service_status" AS ENUM('draft', 'published', 'withdrawn');--> statement-breakpoint
CREATE TABLE "booking_resources" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_id" integer NOT NULL,
	"resource_kind" text NOT NULL,
	"person_id" integer,
	"dojo_id" integer,
	"label" text
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"kind" "booking_kind" NOT NULL,
	"status" "booking_status" DEFAULT 'requested' NOT NULL,
	"program_id" integer,
	"request_id" integer,
	"institution_id" integer,
	"person_id" integer,
	"coach_person_id" integer,
	"dojo_id" integer,
	"venue" text,
	"mode" "delivery_mode",
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"buffer_before_minutes" integer DEFAULT 0 NOT NULL,
	"buffer_after_minutes" integer DEFAULT 0 NOT NULL,
	"capacity" integer,
	"notes" text,
	"cancelled_reason" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_connections" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"user_id" integer,
	"provider" "calendar_provider" NOT NULL,
	"status" "calendar_connection_status" DEFAULT 'connected' NOT NULL,
	"external_account" text,
	"external_calendar_id" text,
	"refresh_token_ciphertext" text,
	"scopes" text,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_id" integer,
	"connection_id" integer,
	"provider" "calendar_provider" NOT NULL,
	"external_event_id" text,
	"sync_status" "calendar_sync_status" DEFAULT 'pending' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_sync_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"connection_id" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"direction" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "coach_availability" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"kind" "availability_kind" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consultations" (
	"id" serial PRIMARY KEY NOT NULL,
	"booking_id" integer NOT NULL,
	"lead_id" integer,
	"request_id" integer,
	"topic" text,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_frameworks" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"version" integer NOT NULL,
	"status" "fee_framework_status" DEFAULT 'draft' NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"published_at" timestamp with time zone,
	"published_by_user_id" integer,
	"superseded_by_id" integer,
	"currency" text DEFAULT 'INR' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fee_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"framework_id" integer NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"kind" "fee_rule_kind" NOT NULL,
	"service_id" integer,
	"audience" "audience_kind",
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"amount_minor" integer,
	"factor_ppm" integer,
	"min_quantity" integer,
	"max_quantity" integer,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institution_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"institution_id" integer NOT NULL,
	"person_id" integer,
	"full_name" text NOT NULL,
	"role" text,
	"email" text,
	"phone" text,
	"is_decision_maker" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "institutions" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "audience_kind" NOT NULL,
	"status" "institution_status" DEFAULT 'prospect' NOT NULL,
	"state_unit_id" integer,
	"district_unit_id" integer,
	"city" text,
	"address_line" text,
	"postcode" text,
	"campus_count" integer,
	"population_count" integer,
	"website" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"lead_id" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"by_user_id" integer,
	"summary" text NOT NULL,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"audience" "audience_kind" NOT NULL,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"institution_id" integer,
	"person_id" integer,
	"contact_name" text,
	"contact_email" text,
	"contact_phone" text,
	"first_source" "lead_source_kind" DEFAULT 'unknown' NOT NULL,
	"last_source" "lead_source_kind" DEFAULT 'unknown' NOT NULL,
	"first_landing_path" text,
	"utm" jsonb,
	"state_unit_id" integer,
	"district_unit_id" integer,
	"city" text,
	"owner_user_id" integer,
	"lost_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"notification_id" integer,
	"push_device_id" integer,
	"user_id" integer,
	"topic" text,
	"channel" text NOT NULL,
	"outcome" "push_delivery_outcome" DEFAULT 'queued' NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"topic" text NOT NULL,
	"channel_in_app" boolean DEFAULT true NOT NULL,
	"channel_email" boolean DEFAULT true NOT NULL,
	"channel_push" boolean DEFAULT false NOT NULL,
	"channel_sms" boolean DEFAULT false NOT NULL,
	"quiet_from_hour" integer,
	"quiet_to_hour" integer,
	"timezone" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "program_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"program_id" integer NOT NULL,
	"person_id" integer,
	"display_name" text,
	"age_band" text,
	"joined_on" date,
	"left_on" date
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"quote_version_id" integer NOT NULL,
	"institution_id" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"status" "proposal_status" DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"valid_until" date,
	"issued_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"person_id" integer,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"status" "push_device_status" DEFAULT 'active' NOT NULL,
	"user_agent" text,
	"region_country" text,
	"region_name" text,
	"timezone" text,
	"last_seen_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"quote_version_id" integer NOT NULL,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"rule_id" integer,
	"rule_code" text,
	"kind" "fee_rule_kind" NOT NULL,
	"label" text NOT NULL,
	"quantity" integer,
	"unit_amount_minor" integer,
	"factor_ppm" integer,
	"amount_minor" integer NOT NULL,
	"running_total_minor" integer NOT NULL,
	"because" text
);
--> statement-breakpoint
CREATE TABLE "quote_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"quote_id" integer NOT NULL,
	"version" integer NOT NULL,
	"status" "quote_status" DEFAULT 'draft' NOT NULL,
	"framework_id" integer NOT NULL,
	"framework_code" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"subtotal_minor" integer DEFAULT 0 NOT NULL,
	"adjustment_minor" integer DEFAULT 0 NOT NULL,
	"tax_minor" integer DEFAULT 0 NOT NULL,
	"total_minor" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"requires_manual_quote" boolean DEFAULT false NOT NULL,
	"manual_reason" text,
	"valid_until" date,
	"issued_at" timestamp with time zone,
	"approved_by_user_id" integer,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"request_id" integer,
	"institution_id" integer,
	"person_id" integer,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_audiences" (
	"id" serial PRIMARY KEY NOT NULL,
	"service_id" integer NOT NULL,
	"audience" "audience_kind" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"category" "service_category" NOT NULL,
	"status" "service_status" DEFAULT 'draft' NOT NULL,
	"summary" text,
	"description" text,
	"publicly_priced" boolean,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_programs" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"proposal_id" integer,
	"institution_id" integer,
	"service_id" integer,
	"status" "training_program_status" DEFAULT 'planned' NOT NULL,
	"mode" "delivery_mode",
	"starts_on" date,
	"ends_on" date,
	"sessions_planned" integer,
	"lead_coach_person_id" integer,
	"state_unit_id" integer,
	"district_unit_id" integer,
	"venue" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"lead_id" integer,
	"institution_id" integer,
	"person_id" integer,
	"audience" "audience_kind" NOT NULL,
	"status" "training_request_status" DEFAULT 'submitted' NOT NULL,
	"service_id" integer,
	"mode" "delivery_mode",
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"preferred_start_on" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quizzes" ALTER COLUMN "pass_mark_percent" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "quizzes" ALTER COLUMN "pass_mark_percent" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_resources" ADD CONSTRAINT "booking_resources_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resources" ADD CONSTRAINT "booking_resources_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_resources" ADD CONSTRAINT "booking_resources_dojo_id_dojos_id_fk" FOREIGN KEY ("dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_program_id_training_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."training_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_request_id_training_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."training_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_coach_person_id_persons_id_fk" FOREIGN KEY ("coach_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_dojo_id_dojos_id_fk" FOREIGN KEY ("dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_connection_id_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_sync_log" ADD CONSTRAINT "calendar_sync_log_connection_id_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_availability" ADD CONSTRAINT "coach_availability_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_availability" ADD CONSTRAINT "coach_availability_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_request_id_training_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."training_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_frameworks" ADD CONSTRAINT "fee_frameworks_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_rules" ADD CONSTRAINT "fee_rules_framework_id_fee_frameworks_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."fee_frameworks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fee_rules" ADD CONSTRAINT "fee_rules_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_contacts" ADD CONSTRAINT "institution_contacts_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institution_contacts" ADD CONSTRAINT "institution_contacts_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_push_device_id_push_devices_id_fk" FOREIGN KEY ("push_device_id") REFERENCES "public"."push_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_participants" ADD CONSTRAINT "program_participants_program_id_training_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."training_programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_participants" ADD CONSTRAINT "program_participants_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_quote_version_id_quote_versions_id_fk" FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_quote_version_id_quote_versions_id_fk" FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD CONSTRAINT "quote_lines_rule_id_fee_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."fee_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_framework_id_fee_frameworks_id_fk" FOREIGN KEY ("framework_id") REFERENCES "public"."fee_frameworks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_request_id_training_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."training_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_audiences" ADD CONSTRAINT "service_audiences_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_programs" ADD CONSTRAINT "training_programs_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_programs" ADD CONSTRAINT "training_programs_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_programs" ADD CONSTRAINT "training_programs_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_programs" ADD CONSTRAINT "training_programs_lead_coach_person_id_persons_id_fk" FOREIGN KEY ("lead_coach_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_programs" ADD CONSTRAINT "training_programs_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_programs" ADD CONSTRAINT "training_programs_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_requests" ADD CONSTRAINT "training_requests_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_requests" ADD CONSTRAINT "training_requests_institution_id_institutions_id_fk" FOREIGN KEY ("institution_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_requests" ADD CONSTRAINT "training_requests_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_requests" ADD CONSTRAINT "training_requests_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "booking_resources_booking_idx" ON "booking_resources" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "booking_resources_person_idx" ON "booking_resources" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_ref_uk" ON "bookings" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "bookings_coach_idx" ON "bookings" USING btree ("coach_person_id","starts_at");--> statement-breakpoint
CREATE INDEX "bookings_status_idx" ON "bookings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "bookings_window_idx" ON "bookings" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "calendar_connections_person_idx" ON "calendar_connections" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connections_uk" ON "calendar_connections" USING btree ("person_id","provider","external_calendar_id");--> statement-breakpoint
CREATE INDEX "calendar_events_booking_idx" ON "calendar_events" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_external_uk" ON "calendar_events" USING btree ("connection_id","external_event_id");--> statement-breakpoint
CREATE INDEX "calendar_sync_log_conn_idx" ON "calendar_sync_log" USING btree ("connection_id","at");--> statement-breakpoint
CREATE INDEX "coach_availability_person_idx" ON "coach_availability" USING btree ("person_id","starts_at");--> statement-breakpoint
CREATE INDEX "consultations_booking_idx" ON "consultations" USING btree ("booking_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_frameworks_code_uk" ON "fee_frameworks" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_frameworks_version_uk" ON "fee_frameworks" USING btree ("version");--> statement-breakpoint
CREATE INDEX "fee_frameworks_status_idx" ON "fee_frameworks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "fee_rules_framework_idx" ON "fee_rules" USING btree ("framework_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fee_rules_code_uk" ON "fee_rules" USING btree ("framework_id","code");--> statement-breakpoint
CREATE INDEX "fee_rules_order_idx" ON "fee_rules" USING btree ("framework_id","sort_order");--> statement-breakpoint
CREATE INDEX "institution_contacts_inst_idx" ON "institution_contacts" USING btree ("institution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "institutions_code_uk" ON "institutions" USING btree ("code");--> statement-breakpoint
CREATE INDEX "institutions_kind_idx" ON "institutions" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "institutions_state_idx" ON "institutions" USING btree ("state_unit_id");--> statement-breakpoint
CREATE INDEX "lead_activities_lead_idx" ON "lead_activities" USING btree ("lead_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_ref_uk" ON "leads" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leads_audience_idx" ON "leads" USING btree ("audience");--> statement-breakpoint
CREATE INDEX "leads_institution_idx" ON "leads" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_device_idx" ON "notification_deliveries" USING btree ("push_device_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_notification_idx" ON "notification_deliveries" USING btree ("notification_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_outcome_idx" ON "notification_deliveries" USING btree ("outcome");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_preferences_uk" ON "notification_preferences" USING btree ("user_id","topic");--> statement-breakpoint
CREATE INDEX "program_participants_program_idx" ON "program_participants" USING btree ("program_id");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_ref_uk" ON "proposals" USING btree ("ref","version");--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_endpoint_uk" ON "push_devices" USING btree ("endpoint");--> statement-breakpoint
CREATE INDEX "push_devices_user_idx" ON "push_devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "push_devices_status_idx" ON "push_devices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "quote_lines_version_idx" ON "quote_lines" USING btree ("quote_version_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "quote_versions_uk" ON "quote_versions" USING btree ("quote_id","version");--> statement-breakpoint
CREATE INDEX "quote_versions_status_idx" ON "quote_versions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_ref_uk" ON "quotes" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "quotes_request_idx" ON "quotes" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "service_audiences_uk" ON "service_audiences" USING btree ("service_id","audience");--> statement-breakpoint
CREATE UNIQUE INDEX "services_code_uk" ON "services" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "services_slug_uk" ON "services" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "services_category_idx" ON "services" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "training_programs_code_uk" ON "training_programs" USING btree ("code");--> statement-breakpoint
CREATE INDEX "training_programs_inst_idx" ON "training_programs" USING btree ("institution_id");--> statement-breakpoint
CREATE INDEX "training_programs_status_idx" ON "training_programs" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "training_requests_ref_uk" ON "training_requests" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "training_requests_status_idx" ON "training_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "training_requests_lead_idx" ON "training_requests" USING btree ("lead_id");