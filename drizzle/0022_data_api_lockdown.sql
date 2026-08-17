-- Supabase Data API lockdown — for the table added by 0021.
--
-- WHY THIS FILE EXISTS. 0010_data_api_lockdown.sql set the rule and 0012
-- followed it once already:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0021_fee_catalogue.sql adds fee_catalogue_entries, and `ENABLE ROW LEVEL
-- SECURITY` is a per-table act that can only secure tables which exist when it
-- runs. Without this file that table sits outside the lockdown with RLS off,
-- and tests/data-api-lockdown.test.ts fails with the two assertions 0010
-- predicted would catch exactly this — a table count that no longer matches,
-- and a non-empty list of migrations creating a table behind the lockdown.
--
-- The grant half is already covered by 0010's ALTER DEFAULT PRIVILEGES, which
-- is recorded against the creating role and therefore applies to anything
-- created afterwards. It is repeated anyway, for the reason 0010 and 0012 both
-- give: the revokes are idempotent, they cost one catalogue scan, and a
-- security floor that only holds while another file is present is not a floor.
--
-- The loop reads the catalogue rather than naming the table, so it also secures
-- anything a future migration adds and forgets — while the test still insists
-- on a fresh lockdown file, because default privileges cover grants and not RLS.

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
