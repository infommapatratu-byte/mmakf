-- Supabase Data API lockdown, third pass — for the tables added by 0017.
--
-- WHY THIS FILE EXISTS. 0010_data_api_lockdown.sql says it plainly:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- and 0012 repeated the exercise for the 27 tables 0011 added. `ENABLE ROW
-- LEVEL SECURITY` is a per-table act that can only secure tables which exist
-- when it runs, so every table 0017 creates — payment_intents,
-- payment_attempts, gateway_transactions, gateway_cost_rates,
-- reconciliation_runs, reconciliation_items, disputes, payment_routing_rules,
-- gateway_health — arrives outside the lockdown with RLS off.
--
-- These are not incidental tables. disputes carries the reason a customer
-- claimed their money back and the evidence MMAKF assembled to answer it;
-- gateway_transactions is every rupee the federation has ever taken, with the
-- merchant reference beside it. Both would be one stray GRANT away from the
-- public internet.
--
-- WHY 0017b AND NOT 0018. The migration numbers 0014 to 0016 are being written
-- against this same schema by other work in flight, and 0018 may already be
-- spoken for. `0017b` sorts after `0017_reconciliation_disputes_routing.sql`
-- and before `0018` under the plain filename sort that scripts/migrate.mjs and
-- every test in tests/ use, which is the only ordering property that matters
-- here. The alternative — guessing at a free number — is how two files end up
-- claiming one.
--
-- The loop is written against the catalogue rather than a list of names, for
-- the reason 0012 gives: it also secures anything an earlier migration in this
-- batch added and forgot. tests/data-api-lockdown.test.ts still insists on a
-- fresh lockdown file after any migration that creates a table, because default
-- privileges cover grants and not RLS.

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
    -- `npm run dev:db` and any other Postgres host has none of them. The
    -- migration must still apply there, or the invariant is untestable exactly
    -- where it is cheapest to test.
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
