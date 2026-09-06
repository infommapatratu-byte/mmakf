-- Supabase Data API lockdown, for the sixteen tables added by 0058.
--
-- 0010_data_api_lockdown.sql states the rule this file obeys:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0058 adds the workforce: positions, employments, employment_events,
-- leave_types, leave_entitlements, leave_requests, work_records,
-- expense_claims, expense_claim_lines, vacancies, job_applications,
-- job_application_events, interviews, interview_panellists,
-- interview_feedback and job_offers.
--
-- THIS IS THE MOST SENSITIVE SET OF TABLES IN THE REPOSITORY, and the argument
-- for locking it down needs no construction. It holds who the federation
-- employs, who reports to whom, who was suspended, who was dismissed and for
-- what reason, who took sick leave and when, what every unsuccessful candidate
-- wrote about themselves, and what an interview panel said about them in
-- private.
--
-- PART X of the directive is explicit that HR data must not reach ordinary
-- administrators. `hr:read` sits outside NATIONAL_FULL and HR_OFFICER is in
-- RESTRICTED_ROLES precisely so a federation administrator cannot mint the role
-- and read through it. An open Data API over these tables would make every one
-- of those controls decorative, because the reader would never pass through
-- rbac.ts at all.
--
-- Two tables here are PARTLY public — `vacancies` carries a `published` flag
-- and the careers page renders it — and that changes nothing. Published is a
-- COLUMN, not a table: every draft vacancy, every withdrawn one and every
-- candidate who applied to them lives in the same tables as the advertised
-- rows, and a reader that reached them directly would read all of it.
--
-- tests/data-api-lockdown.test.ts insists on this file by name: "has no
-- migration creating a table behind the lockdown".

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
