-- Supabase Data API lockdown, second pass — for the 27 tables added by 0011.
--
-- WHY THIS FILE EXISTS AT ALL. 0010_data_api_lockdown.sql says it plainly:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0011_operations_platform.sql added 27 tables, and `ENABLE ROW LEVEL SECURITY`
-- is a per-table act that can only secure tables which exist when it runs. So
-- every one of those 27 — institution_applications with a school's named
-- contacts and telephone numbers, coach_documents with candidates' identity
-- papers, coach_performance, client_documents, ticket_messages — was sitting
-- outside the lockdown with RLS off.
--
-- This was not noticed by reading the code. tests/data-api-lockdown.test.ts
-- failed with "expected 117 to be 144" and "expected
-- ['0011_operations_platform.sql'] to deeply equal []", which is the assertion
-- 0010 predicted would be the thing that catches this, doing exactly that.
--
-- The grant half of 0010 already covers these tables: ALTER DEFAULT PRIVILEGES
-- is recorded against the role that creates tables, so 0011's tables arrived
-- with no grant to anon, authenticated or service_role. It is repeated below
-- anyway, for the reason 0010 gives for repeating 0009: the revokes are
-- idempotent, they cost one catalogue scan, and a security floor that only
-- holds while another file is present is not a floor.
--
-- The loop is written against the catalogue rather than a list of 27 names, so
-- it also secures anything a future migration adds and forgets — while the test
-- still insists on a fresh lockdown file, because default privileges cover
-- grants and not RLS.

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
