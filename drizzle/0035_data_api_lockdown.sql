-- Supabase Data API lockdown, ninth pass — over 0034's table.
--
-- 0010_data_api_lockdown.sql states the rule this file obeys:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0034_technique_kata_appearances.sql creates `technique_kata_appearances`,
-- and it sorts AFTER 0033_data_api_lockdown.sql and 0033b. `ENABLE ROW LEVEL
-- SECURITY` can only secure tables that exist at the moment its loop runs, so
-- both earlier passes had finished before this table existed. Without this
-- file it sits outside the lockdown with RLS off.
--
-- Off is not the whole of it. A pre-cutover Supabase project still carries
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon`, which attaches
-- to every table created after it — so this table is granted to the anon role
-- at the instant it is created. Open AND granted is the full breach, not half
-- of one, and the anon key is published as non-secret on the assumption that
-- RLS is what stands behind it.
--
-- The subject matter looks harmless — which kata a technique appears in is not
-- a child's medical record. That is exactly the reasoning this lockdown does
-- not accept. The rule is every table, without the schema's author having to
-- be right about which ones matter, because the cost of being wrong once is
-- paid in records that cannot be un-published.
--
-- Both blocks below are idempotent and schema-wide rather than naming the one
-- table: written this way the file is a verified no-op if some other pass has
-- already covered it, and it still closes the gap if another table lands
-- alongside it before this migration is applied.

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
