-- Supabase Data API lockdown, third pass — for the 5 tables added by 0015.
--
-- WHY THIS FILE EXISTS AT ALL. 0010_data_api_lockdown.sql says it plainly, and
-- 0012 repeated it:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0015_tax_and_currency.sql added currencies, fx_rates, tax_jurisdictions,
-- tax_rules and tax_rate_versions. `ENABLE ROW LEVEL SECURITY` is a per-table
-- act that can only secure tables which exist when it runs, so all five arrived
-- outside the lockdown with RLS off.
--
-- Two of them matter more than the count suggests. `fx_rates` and
-- `tax_rate_versions` are the inputs to what a customer is charged: a party who
-- could write to them could not change an issued invoice — those are frozen on
-- the record by 0015 — but could change what the NEXT invoice says, silently
-- and without an audit event. They belong behind the same floor as everything
-- else.
--
-- The loop is written against the catalogue rather than a list of five names,
-- so it also secures anything a future migration adds and forgets — while
-- tests/data-api-lockdown.test.ts still insists on a fresh lockdown file after
-- any migration that creates a table, because ALTER DEFAULT PRIVILEGES covers
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
