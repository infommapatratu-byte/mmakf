-- Supabase Data API lockdown, sixth pass — for the tables added by 0029.
--
-- 0010_data_api_lockdown.sql states the rule this file obeys:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0029_marketplace_platform.sql adds FIFTY-FOUR tables, and `ENABLE ROW LEVEL
-- SECURITY` can only secure tables that exist when it runs. Without this file
-- every one of them would sit outside the lockdown with RLS off.
--
-- WHAT IS BEHIND THIS DOOR IS WORSE THAN USUAL. The marketplace tables hold, in
-- one schema:
--
--   · `seller_orders.ship_to` — a delivery address, a name and a phone number
--     for every buyer on the marketplace, including children buying a gi.
--   · `payout_accounts` and `seller_payouts` — where a seller's money goes.
--   · `seller_documents` and `seller_verifications` — the evidence trail from
--     identity and tax verification.
--   · `marketplace_disputes` and `buyer_reports` — complaints naming a buyer, a
--     seller and what went wrong between them.
--   · `fraud_signals` — an accusation, unreviewed, attached to a named seller.
--
-- The last is the one that would do the most harm if published: an open,
-- undecided fraud signal is a suspicion the federation has not stood behind,
-- and it names a real trader.
--
-- tests/data-api-lockdown.test.ts is the thing that insists on this file, by
-- name: "has no migration creating a table behind the lockdown".
--
-- The loop is written against the catalogue rather than a list of fifty-four
-- names, so it also secures anything an earlier migration added and forgot.

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
