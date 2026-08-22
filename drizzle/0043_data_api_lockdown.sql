-- Supabase Data API lockdown, over 0042's two tables.
--
-- 0010_data_api_lockdown.sql states the rule this file obeys:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0042_programme_lifecycle.sql creates `programme_certifications` and
-- `renewal_notices`, and it sorts AFTER every lockdown pass written so far.
-- `ENABLE ROW LEVEL SECURITY` can only secure tables that exist at the moment
-- its loop runs, so each earlier pass had finished before either of these
-- existed. Without this file both sit outside the lockdown with RLS off.
--
-- Off is not the whole of it. A pre-cutover Supabase project still carries
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON TABLES TO anon`, which attaches to
-- every table created after it — so both are granted to the anon role at the
-- instant they are created. Open AND granted is the full breach, not half of
-- one, and the anon key is published as non-secret on the assumption that RLS
-- is what stands behind it.
--
-- AND THESE TWO ARE NOT BORDERLINE. `programme_certifications` names, per row,
-- a child on a school programme and how many sessions they attended and missed;
-- joined to `program_participants` it yields the child's name, and joined to
-- `training_programs` it yields the school. `renewal_notices` is a list of
-- members whose cover is about to lapse — which is, read the other way, a list
-- of who to approach and when. Neither is a table anyone would want to explain
-- having left open.
--
-- Both blocks below are idempotent and schema-wide rather than naming the two
-- tables: written this way the file is a verified no-op if some other pass has
-- already covered them, and it still closes the gap if another table lands
-- alongside them before this migration is applied.

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
