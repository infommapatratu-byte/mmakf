CREATE TYPE "public"."audit_action" AS ENUM('create', 'update', 'delete', 'approve', 'reject', 'revoke', 'finalize', 'login', 'logout', 'export');--> statement-breakpoint
CREATE TYPE "public"."credential_status" AS ENUM('active', 'expired', 'suspended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."membership_category" AS ENUM('athlete', 'instructor', 'dojo', 'official');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('pending', 'active', 'expired', 'suspended', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."person_status" AS ENUM('pending', 'active', 'inactive', 'suspended', 'deceased');--> statement-breakpoint
CREATE TYPE "public"."rank_kind" AS ENUM('kyu', 'dan');--> statement-breakpoint
CREATE TYPE "public"."rank_status" AS ENUM('active', 'superseded', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."scope_type" AS ENUM('national', 'state', 'district', 'dojo');--> statement-breakpoint
CREATE TYPE "public"."unit_status" AS ENUM('draft', 'provisional', 'active', 'suspended', 'expired', 'revoked');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" integer,
	"actor_label" text,
	"actor_role" text,
	"actor_ip_hash" text,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"action" "audit_action" NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"reason" text,
	"authority" text,
	"request_id" text
);
--> statement-breakpoint
CREATE TABLE "district_units" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"state_unit_id" integer NOT NULL,
	"district" text NOT NULL,
	"name" text NOT NULL,
	"status" "unit_status" DEFAULT 'draft' NOT NULL,
	"chartered_on" date,
	"charter_expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dojos" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"state_unit_id" integer NOT NULL,
	"district_unit_id" integer,
	"chief_instructor_person_id" integer,
	"address_line" text,
	"city" text,
	"status" "unit_status" DEFAULT 'draft' NOT NULL,
	"affiliated_on" date,
	"affiliation_expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "examiner_quals" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"level" text NOT NULL,
	"scope" text NOT NULL,
	"granted_on" date NOT NULL,
	"expires_on" date,
	"status" "credential_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "governance_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"office" text NOT NULL,
	"body" text NOT NULL,
	"scope_type" "scope_type" DEFAULT 'national' NOT NULL,
	"scope_id" integer,
	"term_from" date NOT NULL,
	"term_to" date,
	"status" "credential_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "id_sequences" (
	"id" serial PRIMARY KEY NOT NULL,
	"prefix" text NOT NULL,
	"year" integer NOT NULL,
	"next" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instructor_quals" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"level" text NOT NULL,
	"granted_on" date NOT NULL,
	"expires_on" date,
	"status" "credential_status" DEFAULT 'active' NOT NULL,
	"authority_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"category" "membership_category" NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"status" "membership_status" DEFAULT 'pending' NOT NULL,
	"issued_by_user_id" integer,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "official_quals" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"kind" text NOT NULL,
	"level" text,
	"granted_on" date NOT NULL,
	"expires_on" date,
	"cpd_due_on" date,
	"status" "credential_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" serial PRIMARY KEY NOT NULL,
	"federation_id" text NOT NULL,
	"full_name" text NOT NULL,
	"dob" date,
	"gender" text,
	"photo_url" text,
	"email" text,
	"phone" text,
	"city" text,
	"state_unit_id" integer,
	"district_unit_id" integer,
	"dojo_id" integer,
	"status" "person_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rank_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"kind" "rank_kind" NOT NULL,
	"grade_label" text NOT NULL,
	"grade_ordinal" integer NOT NULL,
	"awarded_on" date NOT NULL,
	"grading_event_id" integer,
	"certificate_id" integer,
	"syllabus_version" text,
	"score" integer,
	"status" "rank_status" DEFAULT 'active' NOT NULL,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_bindings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"role" text NOT NULL,
	"scope_type" "scope_type" NOT NULL,
	"scope_id" integer,
	"granted_by_user_id" integer,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"status" "credential_status" DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "state_units" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"state" text NOT NULL,
	"name" text NOT NULL,
	"hq_city" text,
	"status" "unit_status" DEFAULT 'draft' NOT NULL,
	"chartered_on" date,
	"charter_expires_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer,
	"email" text NOT NULL,
	"password_hash" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "district_units" ADD CONSTRAINT "district_units_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dojos" ADD CONSTRAINT "dojos_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dojos" ADD CONSTRAINT "dojos_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "examiner_quals" ADD CONSTRAINT "examiner_quals_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "governance_posts" ADD CONSTRAINT "governance_posts_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instructor_quals" ADD CONSTRAINT "instructor_quals_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "official_quals" ADD CONSTRAINT "official_quals_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "persons" ADD CONSTRAINT "persons_dojo_id_dojos_id_fk" FOREIGN KEY ("dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_records" ADD CONSTRAINT "rank_records_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_at_idx" ON "audit_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "district_units_code_uk" ON "district_units" USING btree ("code");--> statement-breakpoint
CREATE INDEX "district_units_state_idx" ON "district_units" USING btree ("state_unit_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dojos_code_uk" ON "dojos" USING btree ("code");--> statement-breakpoint
CREATE INDEX "dojos_state_idx" ON "dojos" USING btree ("state_unit_id");--> statement-breakpoint
CREATE INDEX "dojos_district_idx" ON "dojos" USING btree ("district_unit_id");--> statement-breakpoint
CREATE INDEX "examiner_quals_person_idx" ON "examiner_quals" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "governance_posts_person_idx" ON "governance_posts" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "id_sequences_uk" ON "id_sequences" USING btree ("prefix","year");--> statement-breakpoint
CREATE INDEX "instructor_quals_person_idx" ON "instructor_quals" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "memberships_person_idx" ON "memberships" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "memberships_status_idx" ON "memberships" USING btree ("status");--> statement-breakpoint
CREATE INDEX "official_quals_person_idx" ON "official_quals" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "persons_federation_id_uk" ON "persons" USING btree ("federation_id");--> statement-breakpoint
CREATE INDEX "persons_state_idx" ON "persons" USING btree ("state_unit_id");--> statement-breakpoint
CREATE INDEX "persons_dojo_idx" ON "persons" USING btree ("dojo_id");--> statement-breakpoint
CREATE INDEX "persons_name_idx" ON "persons" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "rank_records_person_idx" ON "rank_records" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "rank_records_active_idx" ON "rank_records" USING btree ("person_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "rank_records_one_active_uk" ON "rank_records" USING btree ("person_id","kind") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "role_bindings_user_idx" ON "role_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_bindings_uk" ON "role_bindings" USING btree ("user_id","role","scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "state_units_code_uk" ON "state_units" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "state_units_state_uk" ON "state_units" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uk" ON "users" USING btree ("email");