-- Joining the public intake buffer to the authoritative register.
--
-- Membership applications arrive on the public site and are held in a Redis
-- list. Approving one moved a string in that list and wrote nothing to
-- Postgres, so an approved member never entered the register that /verify and
-- /admin/membership read. The applicant was told they were approved and their
-- credential did not verify.
--
-- The fix writes the person and the membership through src/db/membership.ts on
-- approval. That write has to be safe to repeat: a double-clicked button, a
-- retried request, or an approval replayed after the queue write failed must
-- all leave ONE member behind, not two.
--
-- `source_ref` is the intake record's own id, carried onto the register rows it
-- produced. It is the idempotency key, and the uniqueness is enforced HERE
-- rather than by a read-then-write in application code — two concurrent
-- approvals can both read "no membership yet", and only a constraint can decide
-- between them.
--
-- The indexes are PARTIAL. Rows created by any other path — an administrator
-- entering a member directly, a migration from paper records — carry no source
-- and must not collide with one another on NULL.

ALTER TABLE "persons" ADD COLUMN IF NOT EXISTS "source_ref" text;
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN IF NOT EXISTS "source_ref" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "persons_source_ref_uk" ON "persons" ("source_ref") WHERE "source_ref" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_source_ref_uk" ON "memberships" ("source_ref") WHERE "source_ref" IS NOT NULL;
