-- Multi-factor authentication (TOTP, RFC 6238).
--
-- A national admin account can approve a Dan grade, revoke a certificate and
-- finalise a competition result. A password alone is not enough for that, and
-- the accounts most worth attacking are held by the fewest, busiest people.
--
-- The secret is stored ENCRYPTED (AES-256-GCM, same key handling as the YouTube
-- refresh tokens) and never leaves the server. Recovery codes are stored HASHED
-- so a database leak does not hand over ten working bypasses, and each is
-- removed from the array as it is consumed.
--
-- Every column is NULLABLE. Whether MFA is required, and for whom, is federation
-- policy read from MFA_REQUIRED_SCOPE — enforcing a requirement nobody wrote
-- would lock administrators out of their own federation on the day it shipped.
ALTER TABLE "users" ADD COLUMN "mfa_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enrolled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_recovery_hashes" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_last_used_at" timestamp with time zone;
