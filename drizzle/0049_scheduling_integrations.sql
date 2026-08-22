-- 0049 — closing the five gaps docs/domains/scheduling.md named as unbuilt.
--
-- Migration 0032 built the scheduling engine and its documentation listed, by
-- name, what it deliberately did not do. Four of those five need schema; the
-- fifth (an admin resource view) is a screen over rows that already exist.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 1. A WINDOW MAY NOW CROSS MIDNIGHT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 0032 said this, and meant it:
--
--     "A window that crosses midnight is NOT expressible, and that is
--      deliberate: 22:00–02:00 is two windows on two days, and permitting one
--      row to mean both would make every downstream date calculation
--      ambiguous. No MMAKF facility trains through midnight; if one ever does,
--      it gets two rows."
--
-- THE REASONING STANDS AND THE CONCLUSION IS UNCHANGED: one row still never
-- means two days. What changes is that the ENGINE now performs the split
-- itself, instead of asking an administrator to work out that a Friday night
-- session ending at 02:00 is a Friday row and a Saturday row. An overnight camp
-- or a New Year session is a real thing to want, and "enter it as two rows on
-- two days, and remember to move both" is how a timetable ends up with one half
-- of a window updated.
--
-- To split at midnight, the FIRST half needs a closing time OF midnight, and
-- 24:00 is the only honest spelling of it: 23:59 loses a minute, and 00:00
-- would make `closes_at > opens_at` false. So the closing-time pattern gains
-- exactly one value, and only for closing times — an OPENING time of 24:00 is
-- still unstorable, because a window cannot begin at the end of the day.
--
-- NOTE ON THE ALTER. This is the first migration in the project to replace a
-- CHECK constraint. DROP then ADD, in that order, in one transaction: adding
-- first would fail while the stricter one is still present, and dropping
-- without re-adding would leave the column unguarded if the file were
-- interrupted — which the per-file transaction the runner opens prevents. The
-- new constraint is strictly WIDER than the old one, so no existing row can
-- fail validation and the ADD cannot fail on data.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 2. A PERSONAL CALENDAR FEED THAT CAN BE REVOKED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- src/pages/calendar.ics.ts sets out the trap this closes:
--
--     "reading the session cookie so a signed-in official gets 'their'
--      calendar ... would work in a browser and then quietly do nothing in the
--      calendar app that actually subscribes — except on the day someone shares
--      the URL. A per-user feed needs a per-user secret in the URL and its own
--      revocation story; until the federation asks for that, this is the public
--      calendar and says so."
--
-- `calendar_feed_tokens` is that secret and that revocation story.
--
-- THE TOKEN ITSELF IS NOT IN THIS TABLE. `token_hash` is a SHA-256 of it, the
-- same treatment `users.mfa_recovery_hashes` already gives recovery codes. The
-- secret is shown to its owner once, at creation, and cannot be recovered from
-- the database afterwards — so a leaked backup of this table hands over nobody's
-- calendar. A feed URL is a bearer credential that travels in server logs,
-- proxy logs and the address bar of whatever machine the member subscribed
-- from; storing it in the clear would be storing a password.
--
-- REVOKED IS A STATUS, NOT A DELETE. §78: nothing is deleted. A member who
-- revokes a feed because they think it leaked needs the record that they did,
-- and when.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 3. ATTENDANCE AGAINST A CLASS OCCURRENCE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `session_attendance` already exists, already hangs off `training_sessions`,
-- and is already READ by src/db/grading.ts (to count a candidate's sessions
-- since their last grade) and by src/db/athletes.ts. Nothing writes it.
--
-- So this adds ONE COLUMN — `training_sessions.class_session_id` — rather than a
-- third attendance table. A register taken at a class occurrence becomes a
-- `training_sessions` row linked to that occurrence, and every existing reader
-- counts it without being changed. A `class_session_attendance` table would have
-- meant grading silently ignoring half the federation's attendance, which is a
-- defect that surfaces years later as a candidate refused a grading they had in
-- fact trained for.
--
-- UNIQUE WHEN SET: one occurrence has at most one register. Two registers for
-- one class are two answers to "who was there", and the reader cannot tell which
-- the instructor meant.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- 4. A FEDERATION-WIDE ANNOUNCEMENT THAT CANNOT BE SENT BY ACCIDENT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- src/lib/notifications.ts resolves SCHEDULE_PUBLISHED to NOBODY when the
-- schedule is national, state or district, and the comment says why:
--
--     "'every member of the federation' is a fan-out this system must never
--      perform on the strength of one administrator saving a form."
--
-- That stays true. What was missing is the deliberate act that CAN reach them.
-- `schedule_announcements` is that act, and its shape is the safety:
--
--   · the audience is COUNTED AND FROZEN when the announcement is drafted, so
--     the administrator approves a number rather than a promise;
--   · above a threshold it requires TWO-PERSON CONTROL through
--     src/lib/approvals.ts — the existing mechanism, not a second one — and
--     `approval_request_id` records which request authorised it;
--   · `sent_count` is what actually went out, which is not always the frozen
--     count: somebody may have left the club between drafting and sending, and
--     a system that reported the estimate as the outcome would be lying about
--     its own delivery.
--
-- A draft that is never approved is never sent, and stays on the record as a
-- thing somebody proposed. That is the point of it being a row.

-- ─── 1. Midnight ────────────────────────────────────────────────────────────

ALTER TABLE "schedule_rules" DROP CONSTRAINT IF EXISTS "schedule_rules_window_ck";--> statement-breakpoint
ALTER TABLE "schedule_rules" ADD CONSTRAINT "schedule_rules_window_ck"
	CHECK (
		("kind" = 'closed' AND "opens_at" IS NULL AND "closes_at" IS NULL)
		OR (
			"kind" = 'open'
			-- An OPENING time of 24:00 stays unstorable: a window cannot begin
			-- at the end of the day.
			AND "opens_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
			-- A CLOSING time of 24:00 is midnight at the end of this day. It is
			-- the second half of a crossing window's split, written by
			-- setRules(); it is never the whole story on its own, because the
			-- engine writes the 00:00 row on the following day in the same call.
			AND "closes_at" ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
			AND "closes_at" > "opens_at"
		)
	);--> statement-breakpoint

ALTER TABLE "schedule_exceptions" DROP CONSTRAINT IF EXISTS "schedule_exceptions_window_ck";--> statement-breakpoint
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_window_ck"
	CHECK (
		("effect" = 'closed' AND "opens_at" IS NULL AND "closes_at" IS NULL)
		OR (
			"effect" <> 'closed'
			AND "opens_at" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
			AND "closes_at" ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
			AND "closes_at" > "opens_at"
		)
	);--> statement-breakpoint

-- `class_sessions.local_end` is the wall clock the timetable said, and a session
-- generated from a 22:00–24:00 rule genuinely ends at 24:00 on its own date.
-- `starts_at`/`ends_at` remain real instants, so `ends_at > starts_at` is
-- untouched and the ordering of two consecutive halves is exact.
ALTER TABLE "class_sessions" DROP CONSTRAINT IF EXISTS "class_sessions_local_window_ck";--> statement-breakpoint
ALTER TABLE "class_sessions" ADD CONSTRAINT "class_sessions_local_window_ck"
	CHECK (
		"local_start" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
		AND "local_end" ~ '^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$'
	);--> statement-breakpoint

-- ─── 2. Personal calendar feeds ─────────────────────────────────────────────

CREATE TYPE "public"."calendar_feed_scope" AS ENUM('own_classes', 'coach_diary');--> statement-breakpoint
CREATE TYPE "public"."calendar_feed_status" AS ENUM('active', 'revoked');--> statement-breakpoint

CREATE TABLE "calendar_feed_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL REFERENCES "persons"("id"),
	-- SHA-256 of the secret, base64url, 43 characters. NEVER the secret.
	"token_hash" text NOT NULL,
	-- What the holder of this URL may read. 'own_classes' is the member's own
	-- bookings; 'coach_diary' is BUSY/FREE blocks for an instructor's own
	-- teaching, with no class name, no venue and no student — see the module.
	"scope" "calendar_feed_scope" NOT NULL DEFAULT 'own_classes',
	-- What the member called it: 'iPhone', 'work Outlook'. Theirs, so they can
	-- revoke the right one.
	"label" text,
	"status" "calendar_feed_status" NOT NULL DEFAULT 'active',
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" integer REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text
);--> statement-breakpoint

CREATE UNIQUE INDEX "calendar_feed_tokens_hash_uk" ON "calendar_feed_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "calendar_feed_tokens_person_idx" ON "calendar_feed_tokens" USING btree ("person_id", "status");--> statement-breakpoint

-- A revocation is a statement somebody made, so it carries when.
ALTER TABLE "calendar_feed_tokens" ADD CONSTRAINT "calendar_feed_tokens_revoked_ck"
	CHECK ("status" <> 'revoked' OR "revoked_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "calendar_feed_tokens" ADD CONSTRAINT "calendar_feed_tokens_use_count_ck"
	CHECK ("use_count" >= 0);--> statement-breakpoint

-- ─── 3. Attendance against an occurrence ────────────────────────────────────

ALTER TABLE "training_sessions" ADD COLUMN IF NOT EXISTS "class_session_id" integer REFERENCES "class_sessions"("id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "training_sessions_class_session_uk"
	ON "training_sessions" USING btree ("class_session_id")
	WHERE "class_session_id" IS NOT NULL;--> statement-breakpoint

-- ─── 4. Announcements ───────────────────────────────────────────────────────

CREATE TYPE "public"."schedule_announcement_status" AS ENUM('draft', 'awaiting_approval', 'approved', 'sent', 'cancelled');--> statement-breakpoint

CREATE TABLE "schedule_announcements" (
	"id" serial PRIMARY KEY NOT NULL,
	"schedule_id" integer NOT NULL REFERENCES "schedules"("id"),
	"version_id" integer REFERENCES "schedule_versions"("id"),
	"owner_scope" "scope_type" NOT NULL,
	"owner_id" integer,
	"status" "schedule_announcement_status" NOT NULL DEFAULT 'draft',
	-- COUNTED AND FROZEN when drafted. The administrator authorises a number.
	"audience_count" integer NOT NULL,
	-- What actually went out. Not the same thing, and the difference matters:
	-- somebody may have left the club between drafting and sending.
	"sent_count" integer DEFAULT 0 NOT NULL,
	"reason" text NOT NULL,
	-- The src/lib/approvals.ts request that authorised it, where the audience
	-- was large enough to require two-person control.
	"approval_request_id" text,
	"created_by_user_id" integer REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_by_user_id" integer REFERENCES "users"("id"),
	"cancelled_at" timestamp with time zone,
	"cancelled_reason" text
);--> statement-breakpoint

CREATE INDEX "schedule_announcements_schedule_idx" ON "schedule_announcements" USING btree ("schedule_id", "created_at");--> statement-breakpoint
CREATE INDEX "schedule_announcements_status_idx" ON "schedule_announcements" USING btree ("status", "created_at");--> statement-breakpoint

-- WHO SENT IT AND WHEN, enforced rather than requested. An announcement cannot
-- REACH 'sent' anonymously, exactly as a schedule version cannot reach
-- 'published' anonymously.
ALTER TABLE "schedule_announcements" ADD CONSTRAINT "schedule_announcements_sent_needs_sender_ck"
	CHECK ("status" <> 'sent' OR ("sent_at" IS NOT NULL AND "sent_by_user_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "schedule_announcements" ADD CONSTRAINT "schedule_announcements_cancelled_needs_reason_ck"
	CHECK ("status" <> 'cancelled' OR ("cancelled_at" IS NOT NULL AND "cancelled_reason" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "schedule_announcements" ADD CONSTRAINT "schedule_announcements_counts_ck"
	CHECK ("audience_count" >= 0 AND "sent_count" >= 0 AND "sent_count" <= "audience_count");--> statement-breakpoint
ALTER TABLE "schedule_announcements" ADD CONSTRAINT "schedule_announcements_owner_ck"
	CHECK (("owner_scope" = 'national' AND "owner_id" IS NULL) OR ("owner_scope" <> 'national' AND "owner_id" IS NOT NULL));
