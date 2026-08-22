-- 0040 — an application becomes a quotation without anybody typing.
--
-- WHAT WAS MISSING. A school completed the twenty-step wizard. The system
-- derived an institution, a lead, a training request, an owner, a score and a
-- review task — and then stopped. Somebody had to open /admin/quotes, re-read
-- the participant count, the batch count, the campus count, the sessions and
-- the weeks the school had ALREADY TYPED, and key them in again to produce a
-- quotation. That is the "administrator copying data between systems" the
-- federation asked to be rid of, surviving in the one step where the copying
-- involves money.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE HARD PART IS NOT THE ARITHMETIC. IT IS THAT THERE IS NONE YET.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- MMAKF HAS PUBLISHED NO FEE FRAMEWORK. `activeFramework()` returns null today
-- and will keep returning null until the federation decides its fees. So the
-- automation's answer today is, and must be, "no figure exists" — and the one
-- thing it must never do is round that down to zero, because a school reading
-- ₹0 reads FREE, and that is the most expensive misunderstanding available
-- here.
--
-- `application_quotations` is where that answer is RECORDED rather than
-- implied, and the check constraint at the bottom is what makes the honest
-- answer the only storable one:
--
--   · outcome 'manual_quote_required'  → quote_id NULL and total_minor NULL.
--     There is no quotation and there is no number. Not zero. NULL.
--   · outcome 'quoted' / 'awaiting_approval' → quote_id NOT NULL and
--     total_minor NOT NULL, under a named framework. A figure exists exactly
--     when a quotation exists to carry it and a published rule produced it.
--
-- Neither half can be written without the other. A future edit that decides to
-- "default the total to 0 for now" is refused by the database rather than by a
-- code review.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ONE ROW PER APPLICATION, AND THE UNIQUE INDEX IS THE REASON
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `application_quotations_application_uk` is not a tidiness constraint. It is
-- the idempotency of the whole first hop. A retried workflow, a re-fired
-- trigger and a double-clicked button all attempt this insert; one wins and the
-- others are refused by Postgres. The alternative — SELECT, then INSERT if
-- absent — is a race two concurrent callers both pass, and what they would both
-- go on to produce is a second quotation with a second reference number sent to
-- the same school.
--
-- THE WRITE ORDER MATTERS AND IS DELIBERATE. src/db/auto-quote.ts issues the
-- quotation FIRST and inserts this row LAST, inside ONE transaction. The check
-- constraint above cannot be deferred — Postgres defers unique, foreign key and
-- exclusion constraints, never a CHECK — so a row cannot be claimed empty and
-- filled in afterwards without inventing a fourth, meaningless outcome to hold
-- the gap. Ordering it this way keeps the vocabulary honest and loses nothing:
-- the loser of a race is refused by this index and its whole transaction rolls
-- back, taking the quotation, the quote version, the lines and even the spent
-- QUO reference with it. Correctness comes from the rollback, not from who got
-- there first.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY THIS IS A TABLE AND NOT TWO COLUMNS ON institution_applications
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Because `quotes` cannot hold the link. A quote points at a training REQUEST,
-- and a request is only built when the applicant stated a participant count —
-- so the applications most likely to need a hand-prepared quotation are exactly
-- the ones with nothing to hang the link on. And because the interesting fact
-- is not "which quote" but "what did the machine decide, from which inputs,
-- under which framework, and why" — four facts an administrator has to be able
-- to read back when a school asks how a figure was arrived at, or why one never
-- came.
--
-- `inputs` is frozen here as well as on the quote version, deliberately: on the
-- manual path there IS no quote version, and the training office still needs to
-- see what the engine was given before it decided it could not price it.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 'awaiting_quotation' — a state the applicant can be told about
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The application lifecycle went ... program_design → quoted ... with nothing
-- between "we are looking at it" and "here is your price". An application that
-- could not be priced automatically had nowhere to sit, so it would have stayed
-- in 'acknowledged' looking exactly like one nobody had reached yet.
--
-- It is placed BEFORE 'quoted' so the enum reads in lifecycle order. It covers
-- both cases in which a person must act before there is a price — no published
-- rule covered the request, and a rule that fired demands approval — because to
-- the school those are the same sentence: MMAKF is preparing your quotation.
-- Which of the two it was is on `application_quotations.outcome`, where the
-- training office reads it.

ALTER TYPE "public"."institution_application_status" ADD VALUE IF NOT EXISTS 'awaiting_quotation' BEFORE 'quoted';--> statement-breakpoint

CREATE TYPE "public"."application_quote_outcome" AS ENUM('quoted', 'awaiting_approval', 'manual_quote_required');--> statement-breakpoint

CREATE TABLE "application_quotations" (
	"id" serial PRIMARY KEY NOT NULL,
	"application_id" integer NOT NULL REFERENCES "institution_applications"("id"),
	"outcome" "application_quote_outcome" NOT NULL,
	-- The sentence a human reads. On the manual path it is the fee engine's own
	-- explanation of why nothing priced the request, kept verbatim rather than
	-- summarised, because "why is there no price?" is answered from this column.
	"reason" text NOT NULL,
	-- What the engine was given, frozen. See the note above.
	"inputs" jsonb NOT NULL,
	"framework_id" integer REFERENCES "fee_frameworks"("id"),
	"framework_code" text,
	"quote_id" integer REFERENCES "quotes"("id"),
	"quote_version_id" integer REFERENCES "quote_versions"("id"),
	"quote_version" integer,
	"currency" text,
	-- INTEGER PAISE, and NULL when the federation has not priced this. Nullable
	-- is the whole point: a NOT NULL DEFAULT 0 here would be the fabricated
	-- amount this project exists to refuse.
	"total_minor" integer,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_quotations_figure_needs_quote_ck" CHECK (
		("outcome" = 'manual_quote_required'
			AND "quote_id" IS NULL AND "quote_version_id" IS NULL AND "total_minor" IS NULL)
		OR
		("outcome" <> 'manual_quote_required'
			AND "quote_id" IS NOT NULL AND "quote_version_id" IS NOT NULL
			AND "total_minor" IS NOT NULL AND "framework_id" IS NOT NULL)
	)
);--> statement-breakpoint

CREATE UNIQUE INDEX "application_quotations_application_uk" ON "application_quotations" ("application_id");--> statement-breakpoint
CREATE INDEX "application_quotations_outcome_idx" ON "application_quotations" ("outcome","decided_at");
