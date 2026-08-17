-- Supabase Data API lockdown, seventh pass — for the tables added by 0032.
--
-- 0010_data_api_lockdown.sql states the rule this file obeys:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0032_scheduling_engine.sql adds SEVEN tables, and `ENABLE ROW LEVEL SECURITY`
-- can only secure tables that exist when it runs. Without this file every one of
-- them would sit outside the lockdown with RLS off.
--
-- WHAT IS BEHIND THIS DOOR. A timetable reads as the least sensitive thing the
-- federation owns, and most of it is genuinely publishable — the point of the
-- engine is that a club's hours reach the public site. Three of these tables
-- are not:
--
--   · `class_sessions` joins a NAMED COACH to a ROOM at an EXACT TIME, week
--     after week, for the whole forward calendar. Published in bulk that is a
--     movement pattern for every instructor in the federation, including the
--     ones who teach the children's batches. The public timetable shows the
--     class; it does not need to publish a year of one person's whereabouts to
--     anybody holding an anon key.
--
--   · `schedule_exceptions.reason` is free text an administrator typed, and the
--     honest reasons are the sensitive ones: "closed — Sensei's bereavement",
--     "closed — police enquiry", "closed — safeguarding review". The engine
--     redacts it on public reads. That redaction is application code, and
--     application code is not what the Data API asks permission from.
--
--   · `dojo_classes.online_url` is a joining link. A meeting link for a
--     children's class, readable by anyone on the internet, is a safeguarding
--     failure with a URL attached.
--
-- The remaining four — `seasons`, `schedules`, `schedule_versions`,
-- `schedule_rules` — are covered for the same reason as everything else: the
-- rule is every table, so that adding one and forgetting is not a state this
-- schema can be in.
--
-- tests/data-api-lockdown.test.ts is the thing that insists on this file, by
-- name: "has no migration creating a table behind the lockdown".
--
-- The loop is written against the catalogue rather than a list of seven names,
-- so it also secures anything an earlier migration added and forgot.

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
