-- Supabase Data API lockdown — over 0045_training_products.sql's four tables.
--
-- 0010_data_api_lockdown.sql states the rule this file obeys:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0045_training_products.sql adds FOUR tables — `training_products`,
-- `training_plans`, `training_entitlements` and `training_enrolments` — and
-- `ENABLE ROW LEVEL SECURITY` can only secure tables that exist when it runs. It
-- sorts after every lockdown already in this directory, so all of those loops
-- had finished before these tables existed. Left uncovered they would sit
-- outside the lockdown with RLS off — and worse than merely unprotected: a
-- pre-cutover Supabase project carries `ALTER DEFAULT PRIVILEGES ... GRANT ALL
-- ON TABLES TO anon`, which attaches to everything created AFTER it, so a table
-- is granted to the anon role at the moment it is created. Open and granted is
-- the full breach, not half of one.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT IS ACTUALLY BEHIND THIS DOOR, SAID PLAINLY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- THESE ARE CHILDREN. `training_enrolments` is the roll: which named person
-- trains at which named club, from when, and where they moved to when they left.
-- Published to `anon`, that is a searchable index of where a child is on a
-- Tuesday evening, complete with the date they changed venue. There is no
-- version of this schema in which that is acceptable, and the fact that it
-- contains no name of its own is no protection at all — `person_id` joins
-- straight to `persons`.
--
-- `training_entitlements` is worse in a different direction, because it is
-- financial as well as personal:
--
--   · `amount_paid_minor` is what a named individual paid, in paise, term by
--     term. Every family's spending on their child's karate, in one table.
--   · `price_framework_code` and `price_framework_version` are live join paths
--     into `fee_frameworks` and `fee_rules` — MMAKF's own pricing rules, which
--     src/lib/rbac.ts withholds from clients by name.
--   · `status` and `reason` carry the refusals: whose payment was taken and
--     granted nothing, and whose right to train was revoked and why. A reason
--     column is written for a finance desk, not for the internet.
--   · `valid_from` / `valid_until` are, in aggregate, the federation's entire
--     revenue book and churn curve, readable by any competitor.
--
-- `training_plans` carries `renewal_mode`, which is a statement of intent about
-- a named family, and `training_products` carries the club, venue, age band and
-- capacity of every class MMAKF runs — a plan of where children gather, sorted.
--
-- The loop is written against the catalogue rather than four table names, so it
-- also secures anything an earlier migration added and forgot.
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
