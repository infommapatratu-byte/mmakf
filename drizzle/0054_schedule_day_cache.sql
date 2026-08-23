-- A materialised day, per club.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY A TABLE AND NOT A MEMORY CACHE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- /dojos resolves every listed club's timings through `directoryDay()`, which
-- costs a fixed twelve queries however many clubs are listed. That is correct
-- and bounded, and it is paid on EVERY render — the register is one of the most
-- requested pages on the site and its answer changes perhaps twice a year.
--
-- An in-process cache would not do: this deploys to serverless functions, so a
-- process cache is per-instance, cold on most requests, and impossible to
-- invalidate across instances. The cache has to live where every instance can
-- see it, which is here.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- HOW A ROW IS KNOWN TO BE STALE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `fingerprint` is a digest of the whole scheduling configuration — the counts
-- and newest timestamps of schedules, versions, seasons and exceptions, taken in
-- one query. A row is usable only while its fingerprint equals the current one.
--
-- COARSE ON PURPOSE. Any change anywhere in the federation's scheduling
-- configuration invalidates every cached day, not merely the club that changed.
-- That is the right trade twice over: schedule changes are rare and register
-- reads are constant, and a targeted invalidation is a second model of "what
-- affects what" which would eventually disagree with the resolver and serve a
-- club's old hours to a parent. A cache that can be wrong is worse than no
-- cache; this one can only be EMPTY.
--
-- The counts are in the digest as well as the timestamps because a DELETE moves
-- no timestamp: removing an exception that was not the newest would otherwise
-- leave every cached day intact and wrong.
--
-- Nothing reads this table except src/db/schedule-cache.ts. It holds no
-- personal data — opening hours are public and are printed in HTML on four
-- pages — and it is secured by 0055 anyway, because a table outside the
-- lockdown is a table nobody notices until it matters.

CREATE TABLE IF NOT EXISTS "schedule_day_cache" (
  "id" serial PRIMARY KEY NOT NULL,
  "dojo_id" integer NOT NULL,
  "on_date" date NOT NULL,
  -- The configuration this answer was computed from. Not a version id: a day
  -- can resolve through an inherited schedule, a season and an exception at
  -- once, and no single row identifies the whole input.
  "fingerprint" text NOT NULL,
  -- The DirectoryDay, exactly as the resolver returned it.
  "payload" jsonb NOT NULL,
  "computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- ONE ROW PER CLUB PER DAY. The upsert on read depends on this; two rows for one
-- day would make which answer you get a coin toss.
CREATE UNIQUE INDEX IF NOT EXISTS "schedule_day_cache_target_uk"
  ON "schedule_day_cache" ("dojo_id", "on_date");
--> statement-breakpoint
-- The read is always "these clubs, this date", so the date leads.
CREATE INDEX IF NOT EXISTS "schedule_day_cache_date_idx"
  ON "schedule_day_cache" ("on_date");
--> statement-breakpoint
-- Sweeping rows whose configuration has moved on, and rows for days now past.
CREATE INDEX IF NOT EXISTS "schedule_day_cache_fingerprint_idx"
  ON "schedule_day_cache" ("fingerprint");
