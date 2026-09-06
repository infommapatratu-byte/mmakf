-- THE OPERATIONAL FEDERATION TEAM.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS NOT `committee_appointments`, AND NOT A SECOND `persons`
-- ─────────────────────────────────────────────────────────────────────────────
--
-- MMAKF already records two kinds of standing:
--
--   `committee_appointments`  GOVERNANCE. Who sits on the Executive Committee,
--                             the Technical Committee, the Disciplinary Panel.
--                             An office held under the constitution.
--   `role_bindings`           AUTHORITY. What a login may DO in this software.
--
-- Neither answers "who runs the media desk". A content editor is not a
-- committee member, and their `role_bindings` row says `MEDIA_OFFICER` — a
-- permission set, not a job. Putting them in `committees` to get them onto a
-- public page would state that the federation appointed them to a governing
-- body, which is a false claim about a real person's standing.
--
-- So: governance is governance, authority is authority, and this is the
-- operational organisation. THERE IS NO FOREIGN KEY BETWEEN THIS TABLE AND
-- `committees` IN EITHER DIRECTION, and that absence is the guarantee.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ONE PERSON, MANY RELATIONSHIPS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `team_appointments.person_id` REFERENCES `persons`. There is no
-- `team_members` table carrying a name, because the same human being is
-- routinely an employee, a Sensei, a Black Belt and a competition official at
-- once. A second name column is a second spelling waiting to happen, and a
-- certificate issued to one row while the register shows the other.
--
-- The person is the person. This table says what they DO.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS TABLE DELIBERATELY CANNOT HOLD
-- ─────────────────────────────────────────────────────────────────────────────
--
-- No salary. No private telephone. No private email. No government identifier.
-- No bank details. No HR note. No disciplinary finding. Not as a nullable
-- column, not as a jsonb blob "for later".
--
-- This is a PUBLICLY PUBLISHABLE table, and the strongest way to guarantee a
-- public page never leaks an employee's home number is for the number to have
-- nowhere to sit. `public_contact` is an OFFICE ROUTE — a desk address the
-- federation publishes on purpose — and the column comment says so.
--
-- HR data belongs in the HR module, which has no tables yet
-- (IMPLEMENTATION-STATUS.md, NOT STARTED). When it arrives it gets its own
-- migration and its own lockdown, and `hr:*` gates it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- IT SEEDS NOTHING
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Not one department, not one appointment. MMAKF's organisational structure is
-- MMAKF's to state, and a plausible seeded department — "Media & Communications"
-- — is indistinguishable six months later from one an officer confirmed. The
-- public page reports that the federation has not published its team, which is
-- true, rather than showing an invented org chart.

-- ── Vocabulary ──────────────────────────────────────────────────────────────
--
-- The organisational level, kept separate from the free-text `title`. A title
-- is what a person's card says ("Head of Competition Operations"); the level is
-- what the federation can SORT and FILTER by without parsing English.
CREATE TYPE "public"."org_level" AS ENUM(
  'executive', 'director', 'head', 'manager',
  'officer', 'coordinator', 'staff', 'volunteer'
);--> statement-breakpoint

-- An appointment's own lifecycle. NOT the person's status (`persons.status`)
-- and NOT the login's (`role_bindings`): a person may leave the media desk and
-- remain an active member with an active black belt, and closing this row must
-- not touch either.
CREATE TYPE "public"."team_appointment_status" AS ENUM(
  'draft', 'active', 'suspended', 'ended'
);--> statement-breakpoint

-- ── Departments ─────────────────────────────────────────────────────────────
CREATE TABLE "departments" (
  "id" serial PRIMARY KEY NOT NULL,
  -- Stable, typed by an administrator, never derived from the name. Renaming
  -- "Media" to "Media and Communications" must not orphan every appointment.
  "code" text NOT NULL,
  "name" text NOT NULL,
  -- Null until somebody sets one. A department is NOT published under a slug
  -- guessed from its name, for the reason clubs are not: a public URL that
  -- moves when a spelling is corrected is a link somebody had bookmarked.
  "slug" text,
  "description" text,
  -- Self-referencing, so a directorate may contain desks. No depth is fixed by
  -- DDL — the federation decides how deep its own structure goes.
  "parent_id" integer REFERENCES "departments"("id"),
  "sort_order" integer DEFAULT 0 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  -- A department may not be its own parent. Deeper cycles are refused in the
  -- domain module, which can walk the chain; this catches the one case a CHECK
  -- can see.
  CONSTRAINT "departments_not_self_parent_ck" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);--> statement-breakpoint

CREATE UNIQUE INDEX "departments_code_uk" ON "departments" ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "departments_slug_uk" ON "departments" ("slug") WHERE "slug" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "departments_parent_idx" ON "departments" ("parent_id");--> statement-breakpoint

-- ── Appointments ────────────────────────────────────────────────────────────
CREATE TABLE "team_appointments" (
  "id" serial PRIMARY KEY NOT NULL,
  "person_id" integer NOT NULL REFERENCES "persons"("id"),
  "department_id" integer REFERENCES "departments"("id"),

  -- What the card says. Free text because job titles are, and constraining them
  -- to an enum would mean inventing MMAKF's establishment list.
  "title" text NOT NULL,
  "org_level" "org_level" NOT NULL,
  "responsibility" text,

  -- WHERE they operate. Reuses the federation's existing scope vocabulary
  -- rather than minting a second one, so a state coordinator's appointment is
  -- scoped the same way their authority is.
  "scope_type" "scope_type" DEFAULT 'national' NOT NULL,
  "scope_state_unit_id" integer REFERENCES "state_units"("id"),
  "scope_district_unit_id" integer REFERENCES "district_units"("id"),
  "scope_dojo_id" integer REFERENCES "dojos"("id"),

  "started_on" date NOT NULL,
  "ended_on" date,
  "status" "team_appointment_status" DEFAULT 'draft' NOT NULL,

  -- PUBLICATION IS AN ACT, NOT A DEFAULT.
  --
  -- Creating an appointment does not put a person's face on the public
  -- internet. Somebody holding `team:publish` decides that, separately, and the
  -- CHECK below refuses to publish anything that is not currently active.
  "published" boolean DEFAULT false NOT NULL,
  "published_at" timestamp with time zone,
  "sort_order" integer DEFAULT 0 NOT NULL,

  -- The public profile. Every column here is written to be READ BY ANYONE.
  "public_bio" text,
  -- AN OFFICE ROUTE. 'competition@mmakf.in', 'Media desk, +91 ...' — a channel
  -- the federation publishes deliberately. NEVER an employee's own number.
  -- No code can tell a desk number from a personal one, so this is a policy the
  -- admin screen states in words beside the field rather than a check that
  -- pretends to enforce it.
  "public_contact" text,
  -- [{ "label": "...", "url": "https://..." }]. Validated in the domain module:
  -- https only, so no javascript: or data: URL can reach an anchor on a public
  -- page.
  "public_links" jsonb,

  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,

  CONSTRAINT "team_appointments_period_ck" CHECK (
    "ended_on" IS NULL OR "ended_on" >= "started_on"
  ),

  -- An ended appointment has an end date; a live one does not. Without this a
  -- row could read 'ended' with no date, which is a person the federation
  -- cannot say when it stopped employing.
  CONSTRAINT "team_appointments_ended_ck" CHECK (
    ("status" = 'ended') = ("ended_on" IS NOT NULL)
  ),

  -- NOTHING BUT AN ACTIVE APPOINTMENT MAY BE PUBLIC.
  --
  -- A draft is unfinished, a suspended officer is under review, and an ended one
  -- has left. All three rendering on /team would each be a different false
  -- statement about a real person, and the last is the one that gets noticed:
  -- a public page naming somebody as the federation's Finance Officer months
  -- after they left.
  CONSTRAINT "team_appointments_publish_ck" CHECK (
    NOT "published" OR "status" = 'active'
  ),

  -- The scope columns must agree with the scope type. A row claiming to be
  -- district-scoped with no district is a filter that silently matches nothing.
  CONSTRAINT "team_appointments_scope_ck" CHECK (
    ("scope_type" = 'national'
       AND "scope_state_unit_id" IS NULL
       AND "scope_district_unit_id" IS NULL
       AND "scope_dojo_id" IS NULL)
    OR ("scope_type" = 'state'
       AND "scope_state_unit_id" IS NOT NULL
       AND "scope_district_unit_id" IS NULL
       AND "scope_dojo_id" IS NULL)
    OR ("scope_type" = 'district'
       AND "scope_district_unit_id" IS NOT NULL
       AND "scope_dojo_id" IS NULL)
    OR ("scope_type" = 'dojo'
       AND "scope_dojo_id" IS NOT NULL)
  )
);--> statement-breakpoint

CREATE INDEX "team_appointments_person_idx" ON "team_appointments" ("person_id");--> statement-breakpoint
CREATE INDEX "team_appointments_dept_idx" ON "team_appointments" ("department_id");--> statement-breakpoint
CREATE INDEX "team_appointments_status_idx" ON "team_appointments" ("status");--> statement-breakpoint
-- The public page's only query: published rows, in order.
CREATE INDEX "team_appointments_public_idx"
  ON "team_appointments" ("sort_order", "id") WHERE "published";--> statement-breakpoint

-- The same person may not hold the same title in the same department twice
-- concurrently. Two live rows would render two identical cards on /team and
-- make "end this appointment" ambiguous.
--
-- NOTE the NULL caveat, stated rather than left to be discovered: in Postgres
-- two rows with a NULL `department_id` do NOT collide under this index, so an
-- unfiled appointment can be duplicated. `createAppointment()` closes that with
-- an explicit lookup, because the alternative — COALESCE(department_id, 0) in
-- the index — would silently treat "no department" as department zero.
CREATE UNIQUE INDEX "team_appointments_one_live_uk"
  ON "team_appointments" ("person_id", "department_id", "title")
  WHERE "status" IN ('draft', 'active', 'suspended');--> statement-breakpoint

-- ── The version trail ───────────────────────────────────────────────────────
--
-- `audit_events` already records WHO did WHAT to WHICH entity, and every
-- function in `src/db/team.ts` writes one. This table is the other half: WHAT
-- THE ROW SAID BEFORE.
--
-- Both are needed and they are not the same. The audit register answers "who
-- unpublished the Finance Officer on 3 March"; this answers "what did the page
-- say about her that morning" — which is the question asked when somebody
-- produces a screenshot.
--
-- APPEND-ONLY. `src/db/team.ts` contains no UPDATE and no DELETE against it,
-- and a test asserts that by reading the module's source.
CREATE TABLE "team_appointment_history" (
  "id" serial PRIMARY KEY NOT NULL,
  "appointment_id" integer NOT NULL REFERENCES "team_appointments"("id"),
  -- 'created' | 'updated' | 'published' | 'unpublished' | 'suspended'
  -- | 'reinstated' | 'ended'
  "change" text NOT NULL,
  -- The complete row as it stood BEFORE this change. Null on 'created'.
  "before" jsonb,
  -- The complete row as it stood AFTER.
  "after" jsonb NOT NULL,
  "reason" text,
  -- Who. Nullable because a system process has no user, and recording 0 or a
  -- sentinel id would make an unattributable change look attributed.
  "actor_user_id" integer,
  "actor_label" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE INDEX "team_appointment_history_appt_idx"
  ON "team_appointment_history" ("appointment_id", "id");
