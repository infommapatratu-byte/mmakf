-- Onboarding, seller standing and the marketplace review spine.
--
-- RENUMBERED from 0007 to 0009. drizzle-kit numbers from its own journal,
-- which runs one behind the directory because 0006_membership_lifecycle.sql is
-- hand-written and was never added to it. 0008 is reserved for a concurrent
-- workflow. scripts/migrate.mjs applies files in FILENAME order and checksums
-- each one, so the gap is harmless and a later 0008 still applies.
--
-- CHECKED FOR THE REGENERATION TRAP recorded in the header of
-- 0007_engagement_and_fees.sql: drizzle-kit does not know about the
-- hand-written migrations (0005_mfa, 0006_membership_lifecycle) and will
-- re-emit statements they already applied. Re-adding an existing enum label is
-- an error and it rolls the whole file back. Verified clean here — this file
-- contains no ALTER TYPE at all, because drizzle/meta/0006_snapshot.json
-- already carries the MFA columns on users and the suspend/reinstate labels on
-- audit_action. Nothing was stripped by hand, and nothing needed to be.
--
-- Five tables: role_applications, sellers, listings, listing_media,
-- listing_revisions. No rupee figure, no fee, no commission and no
-- eligibility rule appears in the DDL below. Every such value is a federation
-- decision that has not been made, and the columns that will hold them are
-- nullable so their absence stays visible.
CREATE TYPE "public"."role_application_status" AS ENUM('submitted', 'under_review', 'approved', 'rejected', 'withdrawn', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."listing_category" AS ENUM('uniform', 'accessories', 'equipment', 'merch');--> statement-breakpoint
CREATE TYPE "public"."listing_revision_action" AS ENUM('created', 'edited', 'submitted', 'approved', 'rejected', 'withdrawn', 'delisted', 'relisted');--> statement-breakpoint
CREATE TYPE "public"."listing_status" AS ENUM('draft', 'submitted', 'approved', 'rejected', 'withdrawn', 'delisted');--> statement-breakpoint
CREATE TYPE "public"."seller_status" AS ENUM('applied', 'approved', 'rejected', 'suspended', 'withdrawn');--> statement-breakpoint
CREATE TABLE "listing_media" (
	"id" serial PRIMARY KEY NOT NULL,
	"listing_id" integer NOT NULL,
	"url" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"alt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listing_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"listing_id" integer NOT NULL,
	"revision" integer NOT NULL,
	"action" "listing_revision_action" NOT NULL,
	"content_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"status_after" "listing_status" NOT NULL,
	"by_user_id" integer,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "listings" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"seller_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"category" "listing_category" NOT NULL,
	"price_minor" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"stock_qty" integer DEFAULT 0 NOT NULL,
	"status" "listing_status" DEFAULT 'draft' NOT NULL,
	"content_hash" text NOT NULL,
	"approved_content_hash" text,
	"submitted_at" timestamp with time zone,
	"reviewed_by_user_id" integer,
	"reviewed_at" timestamp with time zone,
	"decision_reason" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"applicant_user_id" integer NOT NULL,
	"person_id" integer,
	"requested_role" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" integer,
	"evidence" jsonb,
	"status" "role_application_status" DEFAULT 'submitted' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by_user_id" integer,
	"reviewed_at" timestamp with time zone,
	"decision_reason" text,
	"superseded_by_application_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sellers" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"user_id" integer NOT NULL,
	"person_id" integer,
	"trading_name" text NOT NULL,
	"contact_email" text,
	"contact_phone" text,
	"address_line" text,
	"city" text,
	"postcode" text,
	"state_unit_id" integer,
	"district_unit_id" integer,
	"dojo_id" integer,
	"status" "seller_status" DEFAULT 'applied' NOT NULL,
	"gstin" text,
	"pan" text,
	"bank_account_name" text,
	"bank_account_number" text,
	"bank_ifsc" text,
	"evidence" jsonb,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by_user_id" integer,
	"approved_at" timestamp with time zone,
	"decision_reason" text,
	"suspended_by_user_id" integer,
	"suspended_at" timestamp with time zone,
	"suspended_reason" text,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "listing_media" ADD CONSTRAINT "listing_media_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_revisions" ADD CONSTRAINT "listing_revisions_listing_id_listings_id_fk" FOREIGN KEY ("listing_id") REFERENCES "public"."listings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listing_revisions" ADD CONSTRAINT "listing_revisions_by_user_id_users_id_fk" FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_seller_id_sellers_id_fk" FOREIGN KEY ("seller_id") REFERENCES "public"."sellers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "listings" ADD CONSTRAINT "listings_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_applications" ADD CONSTRAINT "role_applications_applicant_user_id_users_id_fk" FOREIGN KEY ("applicant_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_applications" ADD CONSTRAINT "role_applications_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_applications" ADD CONSTRAINT "role_applications_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_state_unit_id_state_units_id_fk" FOREIGN KEY ("state_unit_id") REFERENCES "public"."state_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_district_unit_id_district_units_id_fk" FOREIGN KEY ("district_unit_id") REFERENCES "public"."district_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_dojo_id_dojos_id_fk" FOREIGN KEY ("dojo_id") REFERENCES "public"."dojos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sellers" ADD CONSTRAINT "sellers_suspended_by_user_id_users_id_fk" FOREIGN KEY ("suspended_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "listing_media_listing_idx" ON "listing_media" USING btree ("listing_id");--> statement-breakpoint
CREATE UNIQUE INDEX "listing_media_order_uk" ON "listing_media" USING btree ("listing_id","sort_order");--> statement-breakpoint
CREATE INDEX "listing_revisions_listing_idx" ON "listing_revisions" USING btree ("listing_id");--> statement-breakpoint
CREATE INDEX "listing_revisions_revision_idx" ON "listing_revisions" USING btree ("listing_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "listings_ref_uk" ON "listings" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "listings_seller_idx" ON "listings" USING btree ("seller_id");--> statement-breakpoint
CREATE INDEX "listings_status_idx" ON "listings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "listings_category_idx" ON "listings" USING btree ("category");--> statement-breakpoint
CREATE INDEX "listings_public_idx" ON "listings" USING btree ("category","id") WHERE status = 'approved';--> statement-breakpoint
CREATE UNIQUE INDEX "role_applications_ref_uk" ON "role_applications" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "role_applications_applicant_idx" ON "role_applications" USING btree ("applicant_user_id");--> statement-breakpoint
CREATE INDEX "role_applications_status_idx" ON "role_applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "role_applications_scope_idx" ON "role_applications" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE UNIQUE INDEX "role_applications_one_open_scoped_uk" ON "role_applications" USING btree ("applicant_user_id","requested_role","scope_type","scope_id") WHERE status IN ('submitted', 'under_review') AND scope_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "role_applications_one_open_national_uk" ON "role_applications" USING btree ("applicant_user_id","requested_role","scope_type") WHERE status IN ('submitted', 'under_review') AND scope_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "sellers_ref_uk" ON "sellers" USING btree ("ref");--> statement-breakpoint
CREATE UNIQUE INDEX "sellers_user_uk" ON "sellers" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sellers_status_idx" ON "sellers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sellers_state_idx" ON "sellers" USING btree ("state_unit_id");