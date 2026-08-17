-- Supabase Data API lockdown, for the three tables added by 0014.
--
-- Numbered 0014b rather than 0015 because parallel finance tracks are landing
-- their own migrations in the same range; 0017b sets the precedent. It sorts
-- immediately after the file it secures, which is the only ordering that
-- matters.
--
-- 0010 stated the rule and 0012 obeyed it:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0014_fee_benchmarks.sql adds fee_benchmark_sources, fee_benchmarks and
-- fee_benchmark_snapshots. `ENABLE ROW LEVEL SECURITY` is a per-table act that
-- can only secure tables which exist when it runs, so all three arrived outside
-- the lockdown with RLS off. tests/data-api-lockdown.test.ts asserts by name
-- that no migration after the last lockdown creates a table; this file is what
-- makes that true again.
--
-- The content is unchanged from 0012 and is written against the catalogue
-- rather than a list of names, so it also secures anything a later migration
-- adds and forgets. The test still insists on a fresh lockdown file, because
-- ALTER DEFAULT PRIVILEGES covers grants and not RLS.
--
-- It matters more here than it looks. A benchmark row is a factual claim about
-- a third party's commercial terms, carrying an explicit confidence rating that
-- says how far it has been checked. Exposed through an unauthenticated data API
-- it would read as MMAKF publishing other federations' price lists — including
-- the three rows whose period is 'unstated' and which are therefore not safe to
-- quote at all.

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
