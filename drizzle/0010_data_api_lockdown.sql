-- Supabase Data API lockdown.
--
-- WHAT THIS PREVENTS. The federation's Postgres is a Supabase project, and
-- Supabase publishes the project's `anon` key as non-secret ON THE ASSUMPTION
-- that every table in `public` carries row-level security. This schema carried
-- none. The only barrier between that key and the whole federation — persons,
-- users, safeguarding_cases, medical_records, case_notes, audit_events, all of
-- it children's records — was the GRANT layer, and a grant is one statement
-- wide:
--
--     grant select on all tables in schema public to anon;
--
-- typed into the SQL editor to make a single public listing work, emitted by a
-- dashboard "expose this table" toggle, restored with a backup, or copied from
-- a quickstart. That one statement takes a fully denied database to a fully
-- readable one: no error, no failing test, no build break, no log line, the
-- site working exactly as before. Reproduced on a real Postgres, and now held
-- shut, by tests/data-api-lockdown.test.ts.
--
-- The two layers are independent by design — Supabase changelog 45329: "RLS
-- behaviour remains unchanged. Grants are a separate layer." The same changelog
-- records that tables which already exist keep the grants they already have, so
-- no future platform change repairs this on its own. Both layers are therefore
-- installed here:
--
--   (1) RLS ON, WITH NO POLICY, on every table. That is deny-by-default for
--       every role except the table owner. The application connects as the
--       owner and is exempt, so nothing in the app changes — the same suite
--       proves an owner read, write and join still work after this migration.
--       Deliberately NOT `FORCE ROW LEVEL SECURITY`: forcing it would apply the
--       (empty) policy set to the owner too, which means locking out the
--       application itself. And deliberately no policy: authorisation for this
--       federation is decided in src/lib/rbac.ts over an owner connection, and
--       a policy here would be a second, unreviewed authorisation engine.
--
--   (2) THE GRANTS REVOKED, present and future. RLS hides the rows but not the
--       shape: with grants still in place, `anon` reads information_schema and
--       enumerates every table and every column, and the Data API answers 200
--       with [] rather than refusing. Measured, in the same suite. Neither
--       layer alone is enough.
--
-- Turn the project-level Data API switch OFF in the Supabase dashboard as well.
-- This app never uses PostgREST or GraphQL — the only data path is postgres.js
-- over TCP via DATABASE_URL — so that switch costs nothing and removes the
-- endpoint entirely. It is not a substitute for this file: a dashboard setting
-- is mutable, unreviewable, invisible to CI, and not carried into a restored or
-- rebuilt project. The migration is the durable half.
--
-- WHY 0011 AND NOT 0008. Filename order is apply order, and `ENABLE ROW LEVEL
-- SECURITY` is a per-table act: it can only secure tables that exist when it
-- runs. This must sort after every migration that creates a table. A future
-- migration that adds tables must be followed by a NEW lockdown migration —
-- never by editing this one, which the runner refuses anyway. The test that
-- fails when that is forgotten is the "EVERY table" assertion in
-- tests/data-api-lockdown.test.ts, which runs in CI where the Supabase roles do
-- not exist and the grant half cannot be checked.
--
-- OVERLAP WITH 0010_revoke_data_api_exposure.sql. That migration revokes the
-- anon and authenticated grants from another workstream. The revokes below are
-- deliberately kept anyway: they are idempotent, they cost one catalogue scan
-- once, and a security floor that only holds while a second file is present is
-- not a floor. They also go further — see the note on service_role.

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
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;
--> statement-breakpoint
-- The grant half. Guarded on role existence because these roles are a Supabase
-- construct: CI, `npm run dev:db` and any other Postgres provider have no
-- `anon`, `authenticated` or `service_role`, and a migration that errored there
-- would make the whole schema unapplicable outside one vendor — the opposite of
-- the provider-neutrality this project is built on.
--
-- `service_role` is revoked TOO, and it is the one that most needs it: Supabase
-- documents that role as bypassing row-level security, so layer (1) is not a
-- control against it at all and the grant is the only barrier there is. Nothing
-- legitimate speaks as any of the three — this app uses no Supabase SDK, no
-- PostgREST and no Edge Function; its only data path is postgres.js as the table
-- owner. If the federation ever adopts Storage or Edge Functions, the grant
-- those need must be re-issued deliberately, in a migration, table by table.
--
-- ALTER DEFAULT PRIVILEGES is what covers tables created LATER: it is recorded
-- against the role running this migration, which is the role that creates the
-- tables, so the next migration's tables arrive with no grant at all. Note the
-- limit honestly — default privileges cover the grants, not RLS. RLS on a new
-- table still needs a new lockdown migration.
DO $$
DECLARE
  s text := current_schema();
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
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
