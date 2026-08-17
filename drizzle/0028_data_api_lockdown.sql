-- Supabase Data API lockdown, fifth pass — for the tables added by 0027.
--
-- 0010_data_api_lockdown.sql states the rule this file obeys:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0027 adds eight tables. Most of a regulatory register is meant to be public —
-- a federation that hides its own rules is not governing anybody — but two of
-- the eight are not, and the fact that six are harmless is exactly why this file
-- is easy to forget:
--
--   · policy_determinations names a PERSON and the decision a rule produced
--     about them. A refusal is a personal adverse outcome. The join from
--     person_id to `persons` to `person_contacts` is precisely the one an
--     attacker would most like, and "MMAKF refused this named person under this
--     rule" is not a public fact.
--
--   · source_provisions and policy_instrument_versions carry DRAFT material.
--     An unapproved draft that leaks reads as federation policy to anybody who
--     finds it, which is the same defect this whole subsystem exists to prevent,
--     arriving through the database rather than through a paste.
--
-- tests/data-api-lockdown.test.ts is the thing that insists on it, by name:
-- "has no migration creating a table behind the lockdown".
--
-- The loop is written against the catalogue rather than a list of eight names,
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
-- The second half, and the reason it cannot be left out of a file that carries
-- the `_data_api_lockdown` name.
--
-- RLS alone is one of two layers. The other is the GRANT layer, and the eight
-- tables 0027 created were handed to anon/authenticated/service_role at the
-- moment of their CREATE by the pre-cutover project's ALTER DEFAULT PRIVILEGES
-- — an act that reaches forward to every new table and that nothing but an
-- explicit revoke undoes. Without this block those eight keep their grants, so
-- anon can still read the shape of the data model out of information_schema
-- even where RLS hides the rows, and service_role — which carries BYPASSRLS, so
-- RLS is no control against it at all — keeps full access to them.
--
-- A later lockdown would eventually revoke them, which is precisely what made
-- this omission survivable and therefore easy to miss. The invariant is not
-- "the schema ends up locked down"; it is that EVERY file bearing this name
-- does the whole job, because the next person to add a table will copy the
-- nearest one as the template.
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
