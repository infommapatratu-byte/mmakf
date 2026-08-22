-- Supabase Data API lockdown — over 0040_application_auto_quote.sql's table.
--
-- 0010_data_api_lockdown.sql states the rule this file obeys:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0040_application_auto_quote.sql adds ONE table, `application_quotations`, and
-- `ENABLE ROW LEVEL SECURITY` can only secure tables that exist when it runs.
-- It sorts after the lockdowns that preceded it, so every loop already in the
-- directory had finished before that table existed. Left uncovered it would sit
-- outside the lockdown with RLS off — and worse than merely unprotected: a
-- pre-cutover Supabase project carries `ALTER DEFAULT PRIVILEGES ... GRANT ALL
-- ON TABLES TO anon`, which attaches to everything created AFTER it, so the
-- table is granted to the anon role at the moment it is created. Open and
-- granted is the full breach, not half of one.
--
-- WHAT IS ACTUALLY BEHIND THIS DOOR, said plainly. One row per institutional
-- application, and it is a commercial record about a named school:
--
--   · `total_minor` is what MMAKF quoted that institution, in paise. A
--     competitor reading the register learns the federation's pricing for every
--     school in the country, and every school learns what every other school
--     was charged. Neither is the federation's to disclose.
--   · `inputs` is the school's own submission in frozen form — participant
--     counts, campuses, batches, age bands, the town it is in. It is the same
--     material `institution_applications.payload` holds and it is protected for
--     the same reason.
--   · `reason` on the manual path quotes the fee engine's explanation of why no
--     published rule covered the request, which is a description of where the
--     federation's own rulebook has holes.
--   · `framework_id` and `quote_id` are live join paths into `fee_frameworks`,
--     `fee_rules`, `quotes` and `quote_versions` — the pricing rules
--     themselves, which src/lib/rbac.ts withholds from clients by name.
--
-- The loop is written against the catalogue rather than one table name, so it
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
