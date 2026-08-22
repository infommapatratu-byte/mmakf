-- Supabase Data API lockdown — over 0039's table.
--
-- 0010_data_api_lockdown.sql states the rule this file obeys:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0039_program_activation.sql creates `entitlement_resources`, and it sorts
-- AFTER 0038_data_api_lockdown.sql — so every loop already in this directory
-- had finished before that table existed. `ENABLE ROW LEVEL SECURITY` can only
-- secure tables that are there when it runs.
--
-- Without this file the table would sit outside the lockdown with RLS off, and
-- worse than merely unprotected: a pre-cutover Supabase project carries
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon`, which attaches to
-- everything created AFTER it, so the table is granted to the anon role at the
-- moment it is created. Open and granted is the full breach, not half of one.
--
-- WHAT IS BEHIND THIS DOOR, said plainly. One row per grant of access: which
-- resource, held under which entitlement, from which date until which date.
-- Joined one hop to `entitlements` and one more to `program_participants` it
-- names the children on a school's roll and says exactly when their access
-- began and ends. That is a register of minors and a commercial record about a
-- named institution in the same query.
--
-- The loop is written against the catalogue rather than one table name, so it
-- also secures anything an earlier migration added and forgot. It is idempotent
-- — tables that already have RLS on are skipped — and the revokes are guarded
-- on role existence so the schema stays applicable to any Postgres, not only
-- Supabase's.
--
-- tests/data-api-lockdown.test.ts is the thing that insists on this file, by
-- name: "has no migration creating a table behind the lockdown".

DO $$
DECLARE
  t regclass;
BEGIN
  FOR t IN
    SELECT c.oid::regclass
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relkind IN ('r', 'p')
      AND NOT c.relrowsecurity
    ORDER BY c.relname
  LOOP
    -- ENABLE, never FORCE. Forcing applies the (empty) policy set to the table
    -- owner as well, and the application connects as the owner — every query in
    -- the federation would return zero rows, silently, because a policy denial
    -- is not an error.
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
--> statement-breakpoint
DO $$
DECLARE
  s text := current_schema();
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    -- Guarded on role existence: these three are a Supabase construct, and CI,
    -- `npm run dev:db` and every other Postgres provider have none of them. A
    -- migration that errored there would make the schema unapplicable outside
    -- one vendor, which is the opposite of this project's neutrality.
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', s, r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', s, r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM %I', s, r);
      EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', s, r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', s, r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I', s, r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM %I', s, r);
    END IF;
  END LOOP;
END
$$;
