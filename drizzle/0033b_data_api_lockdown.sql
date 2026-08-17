-- Supabase Data API lockdown, seventh pass — for the tables added by 0031.
--
-- 0010_data_api_lockdown.sql states the rule this file obeys:
--
--     "A future migration that adds tables must be followed by a NEW lockdown
--      migration — never by editing this one."
--
-- 0031_technical_library.sql adds FOURTEEN tables, and `ENABLE ROW LEVEL
-- SECURITY` can only secure tables that exist when it runs. 0031 sorts after
-- 0030_data_api_lockdown.sql, so the loop in 0030 had already finished before a
-- single one of these tables existed. Without this file all fourteen sit
-- outside the lockdown with RLS off — and worse than merely unprotected: a
-- pre-cutover Supabase project carries `ALTER DEFAULT PRIVILEGES ... GRANT ALL
-- ON TABLES TO anon`, which attaches to everything created AFTER it, so 0031's
-- tables are granted to the anon role at the moment they are created. Open and
-- granted is the full breach, not half of one.
--
-- BE HONEST ABOUT WHAT IS BEHIND THIS PARTICULAR DOOR. Most of the technical
-- library is public material and is meant to be. The movement list of Heian
-- Nidan, the kanji and romaji for gyaku-zuki, a citation to a rulebook anyone
-- can download from the authority that published it — none of that is a secret,
-- and MMAKF intends to publish most of it through its own pages. This file is
-- not a claim that the syllabus is confidential. It is protecting two things
-- that are real:
--
-- (1) THE ANON KEY MUST NOT REACH THE SCHEMA AT ALL. Supabase publishes that
--     key as non-secret on the assumption that every table in `public` carries
--     RLS. "Every table except fourteen" does not satisfy that assumption. The
--     value of this invariant is that it is total: the moment it becomes
--     partial, somebody has to judge table by table whether this one matters,
--     that judgement gets made once in a hurry, and every table added
--     afterwards inherits it. Fourteen open tables are also fourteen live join
--     paths into the rest of the federation — `technical_reviews`,
--     `technical_translations`, `technical_sources`, `kata_applications` and
--     `media_technical_links` all carry foreign keys into `persons`, so an open
--     table here is a foothold in the person graph even where its own subject
--     matter is harmless.
--
-- (2) THE MATERIAL IN HERE THAT IS GENUINELY NOT PUBLIC, of which there is
--     more than the phrase "technical syllabus" suggests:
--
--       · `technical_reviews` is the internal deliberation, not its outcome: a
--         named reviewer, the state they moved a record to — including
--         'rejected' — and a free-text `note` saying why. "Reviewer X rejected
--         this instructor's bunkai for this reason" is an unpublished judgement
--         about a named third party.
--
--       · `kata_applications` and `technical_terms` both default `published` to
--         false and `verification` to 'unverified'. Those rows are DRAFTS. A
--         draft interpretation that leaks reads as federation doctrine to
--         whoever finds it, which is precisely the collapse of classification
--         into endorsement that 0031's CHECK constraints exist to make
--         inexpressible — arriving through the database instead of through the
--         application, where the constraints cannot see it.
--
--       · `media_technical_links` holds the AI classification pipeline's
--         output: rows at state 'new' with `proposed_by = 'ai'` and a
--         `confidence` score. They are machine guesses about somebody else's
--         video that no human has yet stood behind, and they are attached to a
--         named channel.
--
--       · `technical_sources` is MMAKF's assessment OF OTHER ORGANISATIONS — an
--         `authority_tier`, a `rights_policy`, an `active` flag and free-text
--         `notes`. Publishing "we file this body under 'discovery' and here is
--         what we think of their rights posture" is a statement about a named
--         organisation that the federation has never made.
--
--       · `sport_kumite_provisions.source_quote` and
--         `reference_curriculum_items` are verbatim transcriptions of other
--         people's rulebooks and grading guidelines, kept so that MMAKF can cite
--         them. Citing a provision is one thing; serving the whole transcribed
--         corpus from an open, unauthenticated API is republication. And
--         `reference_curricula.adopted_by_mmakf` defaults to false for a
--         reason — an open endpoint would hand out another federation's
--         syllabus from an mmakf.in host, which is the confusion 0031 built a
--         separate table to prevent.
--
-- tests/data-api-lockdown.test.ts is the thing that insists on this file, by
-- name: "has no migration creating a table behind the lockdown".
--
-- The loop is written against the catalogue rather than a list of fourteen
-- names, so it also secures anything an earlier migration added and forgot.
--
-- ORDERING NOTE, because the 0032 prefix is shared. A sibling migration —
-- 0032_scheduling_engine.sql — was written in parallel with this one and landed
-- on the same number. That is survivable and the order is right, but it is
-- right by an implicit rule rather than an obvious one: scripts/migrate.mjs and
-- the test both apply files in plain filename order, and 'd' sorts before 's',
-- so this lockdown runs after 0031's tables exist and before the scheduling
-- engine creates its own. The scheduling engine is followed by its own lockdown
-- in turn, which is the discipline working as intended. If anyone renumbers
-- either file, the thing to preserve is the sequence — tables, then a lockdown,
-- then tables, then a lockdown — not the digits.

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
    --
    -- This block has to be repeated here rather than left to 0030. REVOKE acts
    -- on the tables that exist when it runs, and ALTER DEFAULT PRIVILEGES never
    -- reaches back over objects already created — so 0030's revoke did nothing
    -- for the fourteen tables 0031 went on to create, which took their grants
    -- from the legacy default privilege at creation time.
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
