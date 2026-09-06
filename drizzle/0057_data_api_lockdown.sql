-- Supabase Data API lockdown, for the three tables added by 0056.
--
-- 0010_data_api_lockdown.sql states the rule this file obeys:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0056 adds `departments`, `team_appointments` and `team_appointment_history`.
--
-- The first two are written to be published, so it would be easy to argue they
-- need no lockdown. That argument is wrong twice over.
--
-- READABLE IS NOT THE SAME AS WRITABLE. An open Data API over
-- `team_appointments` is a way to set `published = true` on a draft, or to
-- change the title beside a real person name on the federation public site.
-- The authority to say who speaks for MMAKF is exactly the authority this
-- migration exists to keep inside the application.
--
-- AND PUBLISHED IS A COLUMN, NOT A TABLE. Every unpublished draft, every ended
-- appointment and every suspended officer lives in the same table as the public
-- rows. A reader that reached the table directly would read all of them —
-- including that a named person was suspended, which is precisely the
-- disciplinary information 0056 header promises never to expose.
--
-- `team_appointment_history` needs no argument at all: it is the before-image
-- of every change, so it holds every value ever corrected.
--
-- tests/data-api-lockdown.test.ts insists on this file by name: "has no
-- migration creating a table behind the lockdown".

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
