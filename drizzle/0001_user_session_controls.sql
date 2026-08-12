ALTER TABLE "users" ADD COLUMN "session_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" text DEFAULT 'no' NOT NULL;