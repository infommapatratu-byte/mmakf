-- Practice records and multi-angle recordings. §28, §43, §44.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- FOUR TABLES, AND ONE RULE THEY EXIST TO MAKE STRUCTURALLY TRUE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- §44 of the technical directive is one sentence long and decides this whole
-- migration:
--
--     Watching Bassai Dai does NOT make Bassai Dai "completed".
--
-- Physical competence is established by examination — a grading, a panel, a
-- syllabus version, a certificate — and every one of those already exists in
-- 0000/0031. What did not exist was anywhere for a student to say "I am working
-- on this", which is a genuinely useful thing to record and a catastrophic thing
-- to confuse with attainment.
--
-- So the separation is enforced by what is ABSENT here:
--
--   · practice_marks and practice_assignments have NO foreign key to
--     grading_events, grading_candidates, grade_definitions, certificates or any
--     rank record, in either direction. The only foreign keys are to `persons`.
--   · There is no `completed` value in practice_mark, no `mastered`, no
--     `passed`, and no score column anywhere. The vocabulary is progressive and
--     never terminal.
--   · practice_assignments has no completed_at and no sign-off column. An
--     instructor confirming that a student can now do something is an
--     assessment, and assessments have exactly one home in this schema.
--   · practice_marks.self_reported is NOT NULL DEFAULT TRUE and nothing writes
--     FALSE. It is there so that anything joining these rows to something
--     official has to look at it, and so an export of this table cannot be read
--     as an attainment record by whoever opens the spreadsheet.
--
-- tests/practice.test.ts asserts the first of those against information_schema
-- rather than against this comment, because the day somebody adds
-- `grading_candidate_id` "just to link them" is the day a tick a member gave
-- themselves becomes examination evidence.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THE SUBJECT IS (kind, slug) AND NOT A FOREIGN KEY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A student marks a TECHNIQUE, a KATA, a KUMITE concept or a VIDEO. The first
-- three live in static source — they are public martial-arts knowledge that must
-- render with no database at all — and only the fourth is a table. A foreign key
-- could therefore be written for one of the four, and writing it for one and not
-- the others would make the most and least important subjects behave
-- differently.
--
-- The honest cost is that Postgres cannot refuse a slug that does not exist.
-- src/db/practice.ts refuses it on the way in, and the test suite resolves every
-- stored slug against the library and fails on an orphan.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- AND THE MULTI-ANGLE TABLES ARE A RELATIONSHIP, NOT COLUMNS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- §28 asks for FRONT / REAR / LEFT / RIGHT / 45 / OVERHEAD and for views to be
-- synchronised. Synchronising is a fact about the PAIR: two cameras rolling on
-- one performance did not start at the same instant, and playing them together
-- needs the offset between them. An offset has no home on a single asset row, so
-- `camera_angle` and `angle_group_id` columns on media_assets would have stored
-- the angle and lost the only number that makes the feature work.
--
-- Both tables ship EMPTY. MMAKF has filmed no multi-angle material, and the
-- surfaces say so rather than rendering a switcher with one angle in it.

CREATE TYPE "practice_mark" AS ENUM ('watched', 'practising', 'needs_work', 'bookmarked');
--> statement-breakpoint
CREATE TYPE "practice_subject" AS ENUM ('technique', 'kata', 'kumite', 'video', 'drill');
--> statement-breakpoint
CREATE TYPE "assignment_state" AS ENUM ('assigned', 'acknowledged', 'withdrawn');
--> statement-breakpoint
CREATE TYPE "camera_angle" AS ENUM ('front', 'rear', 'left', 'right', 'forty_five', 'overhead', 'unknown');
--> statement-breakpoint
CREATE TYPE "capture_speed" AS ENUM ('normal', 'slow_motion');
--> statement-breakpoint

CREATE TABLE "practice_marks" (
  "id" serial PRIMARY KEY NOT NULL,
  "person_id" integer NOT NULL REFERENCES "persons"("id"),
  "subject_kind" "practice_subject" NOT NULL,
  "subject_slug" text NOT NULL,
  "mark" "practice_mark" NOT NULL,
  "note" text,
  "self_reported" boolean DEFAULT true NOT NULL,
  "marked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- One current relationship per subject, not a log of every page visit. Re-marking
-- updates the row. A visit history is a different feature with a different
-- privacy question attached, and this is deliberately not it.
CREATE UNIQUE INDEX "practice_marks_uk" ON "practice_marks" ("person_id", "subject_kind", "subject_slug");
--> statement-breakpoint
CREATE INDEX "practice_marks_person_idx" ON "practice_marks" ("person_id", "marked_at");
--> statement-breakpoint
-- "Who has flagged this technique as difficult" — an instructor's view of a
-- cohort, and the only legitimate cross-person read of this table.
CREATE INDEX "practice_marks_subject_idx" ON "practice_marks" ("subject_kind", "subject_slug", "mark");
--> statement-breakpoint

CREATE TABLE "practice_assignments" (
  "id" serial PRIMARY KEY NOT NULL,
  "person_id" integer NOT NULL REFERENCES "persons"("id"),
  "assigned_by_person_id" integer NOT NULL REFERENCES "persons"("id"),
  "subject_kind" "practice_subject" NOT NULL,
  "subject_slug" text NOT NULL,
  "instruction" text NOT NULL,
  "due_on" timestamp with time zone,
  "state" "assignment_state" DEFAULT 'assigned' NOT NULL,
  "acknowledged_at" timestamp with time zone,
  "withdrawn_reason" text,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "practice_assignments_person_idx" ON "practice_assignments" ("person_id", "state");
--> statement-breakpoint
CREATE INDEX "practice_assignments_assigner_idx" ON "practice_assignments" ("assigned_by_person_id");
--> statement-breakpoint

-- Withdrawing requires a reason, as every refusal in this codebase does. Enforced
-- here as well as in the module, because a module check is a promise and a CHECK
-- constraint is a guarantee.
ALTER TABLE "practice_assignments" ADD CONSTRAINT "practice_assignments_withdrawn_needs_reason"
  CHECK ("state" <> 'withdrawn' OR ("withdrawn_reason" IS NOT NULL AND length(btrim("withdrawn_reason")) > 0));
--> statement-breakpoint

CREATE TABLE "media_angle_groups" (
  "id" serial PRIMARY KEY NOT NULL,
  "slug" text NOT NULL,
  "title" text NOT NULL,
  "subject_kind" text,
  "subject_slug" text,
  -- Deliberately NOT a foreign key to media_angle_members: that would make the
  -- two tables mutually dependent and neither insertable first.
  "reference_member_id" integer,
  "recorded_on" timestamp with time zone,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_by_person_id" integer REFERENCES "persons"("id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "media_angle_groups_slug_uk" ON "media_angle_groups" ("slug");
--> statement-breakpoint
CREATE INDEX "media_angle_groups_subject_idx" ON "media_angle_groups" ("subject_kind", "subject_slug");
--> statement-breakpoint

CREATE TABLE "media_angle_members" (
  "id" serial PRIMARY KEY NOT NULL,
  "group_id" integer NOT NULL REFERENCES "media_angle_groups"("id"),
  "media_asset_id" integer NOT NULL REFERENCES "media_assets"("id"),
  "angle" "camera_angle" DEFAULT 'unknown' NOT NULL,
  "speed" "capture_speed" DEFAULT 'normal' NOT NULL,
  -- Signed milliseconds from the group's reference recording. NULL means NOT
  -- MEASURED, which is different from zero — zero asserts they are already
  -- aligned. A player must not synchronise on an unmeasured offset.
  "offset_ms" integer,
  "offset_method" text,
  "is_primary" boolean DEFAULT false NOT NULL,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "media_angle_members_uk" ON "media_angle_members" ("group_id", "media_asset_id");
--> statement-breakpoint

-- One camera position of each kind per group, at each speed — but PARTIAL,
-- excluding 'unknown', and the exclusion is the point.
--
-- Several recordings whose camera position was never written down is the NORMAL
-- state; it is the state of every recording currently on file. A plain unique
-- index would make the second one unstorable and push whoever hit it into
-- inventing an angle to satisfy the constraint. That is exactly the fabricated
-- technical fact this library exists to prevent, arrived at through a database
-- error rather than through carelessness.
CREATE UNIQUE INDEX "media_angle_members_angle_uk" ON "media_angle_members" ("group_id", "angle", "speed")
  WHERE "angle" <> 'unknown';
--> statement-breakpoint

-- At most one primary per group. Partial, so the many false rows do not collide.
CREATE UNIQUE INDEX "media_angle_members_primary_uk" ON "media_angle_members" ("group_id")
  WHERE "is_primary";
--> statement-breakpoint
CREATE INDEX "media_angle_members_group_idx" ON "media_angle_members" ("group_id");
