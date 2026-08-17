-- 0034 — "this technique appears in this kata", where the movement is unknown.
--
-- WHY A SECOND TABLE AND NOT A ROW IN kata_movements. The knowledge graph the
-- technical directive asks for wants one question answered above all others:
-- show me every kata in which gyaku-zuki appears. `kata_movements` can answer it
-- precisely — movement 17, front stance, chudan — but only for kata whose
-- movements have been researched movement by movement, and 0031 deliberately
-- shipped none of those because no primary source was verified for them.
--
-- Meanwhile the repository's own Shotokan corpus (src/data/shotokan/) already
-- records, for each technique, the kata in which it appears "uncontroversially".
-- That is a real, useful, well-sourced fact of a DIFFERENT SHAPE: it names the
-- kata without naming the count.
--
-- Forcing it into `kata_movements` would mean inventing an `ordinal`, because
-- that column is NOT NULL and unique per kata — which is exactly right for a
-- counted movement and exactly wrong for "appears somewhere in". One made-up
-- ordinal per row would then be indistinguishable, to every later reader and
-- every later query, from a researched one. The whole discipline of 0031 would
-- be undone by a convenience.
--
-- So: two tables, two strengths of claim, and a query that can use either.
-- `movement_ordinal` here is NULLABLE and is populated only if someone later
-- establishes it, at which point the row can be promoted into `kata_movements`
-- proper.

CREATE TABLE "technique_kata_appearances" (
	"id" serial PRIMARY KEY NOT NULL,
	"technique_id" integer NOT NULL,
	"kata_id" integer NOT NULL,
	-- Null means: it appears, and nobody has established where. That is the
	-- normal case for this table and is not a defect.
	"movement_ordinal" integer,
	"note" text,
	"verification" "verification_status" DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

ALTER TABLE "technique_kata_appearances" ADD CONSTRAINT "technique_kata_appearances_technique_id_techniques_id_fk" FOREIGN KEY ("technique_id") REFERENCES "public"."techniques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technique_kata_appearances" ADD CONSTRAINT "technique_kata_appearances_kata_id_kata_id_fk" FOREIGN KEY ("kata_id") REFERENCES "public"."kata"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- One row per (technique, kata). A technique appearing four times in a kata is
-- still one fact at this strength of claim; the four occurrences are what
-- `kata_movements` is for.
CREATE UNIQUE INDEX "technique_kata_appearances_uk" ON "technique_kata_appearances" USING btree ("technique_id","kata_id");--> statement-breakpoint
CREATE INDEX "technique_kata_appearances_kata_idx" ON "technique_kata_appearances" USING btree ("kata_id");--> statement-breakpoint

-- An ordinal, if one is ever recorded, counts from 1 like every other movement
-- number in the system.
ALTER TABLE "technique_kata_appearances" ADD CONSTRAINT "technique_kata_appearances_ordinal_ck"
	CHECK ("movement_ordinal" IS NULL OR "movement_ordinal" > 0);
