-- 0031 — the Shotokan technical knowledge library.
--
-- WHAT WAS MISSING. The federation could already examine a candidate, issue a
-- certificate and verify it years later; and it could already ingest video from
-- an authorised YouTube channel, classify it and mark whether the rights were
-- cleared. What it could not do was say anything STRUCTURED about the technique
-- itself. `kata.sequence` was a jsonb blob, `kata.bunkai` was another, and a
-- blob cannot be joined, cited, timecoded or searched. "Which kata contain
-- gyaku-zuki?" had no answer. "Where did we learn that Heian Nidan has that
-- many movements?" had no answer either — which is worse, because the number
-- was already on screen.
--
-- THE THREE AXES THIS MIGRATION KEEPS APART, permanently and in the schema:
--
--   CLASSIFICATION — what a record or video is about.
--   RIGHTS         — whether MMAKF may host, embed, or merely link to it.
--   ENDORSEMENT    — whether a NAMED MMAKF reviewer has approved it.
--
-- Every real failure in this domain comes from collapsing two of these. A
-- federation that merges classification with endorsement publishes a stranger's
-- interpretation as doctrine. One that merges rights with classification
-- rehosts other people's instructional video because it happened to be
-- relevant. The CHECK constraints at the foot of this file are what stop the
-- third collapse — endorsement without an endorser — from being expressible.
--
-- WHY REFERENCE CURRICULA ARE NOT SYLLABUS VERSIONS. The JKA publishes a
-- kyu/dan grading guideline. It is real, citable and useful, and it is NOT
-- MMAKF's curriculum. Loading it into `syllabus_versions` would make it
-- examinable — the grading engine reads `grade_requirements` and would not know
-- the difference. So it lands in `reference_curricula`, which nothing in the
-- grading path can reach. `adopted_by_mmakf` exists so that adoption, if it
-- ever happens, is a recorded decision rather than a quiet UPDATE.
--
-- WHY 'unverified' IS A DEFAULT AND NOT AN EMBARRASSMENT. Movement-level kata
-- data is populated only where a source documents it, and the citation lands in
-- `technical_citations` alongside. Research for this migration confirmed the
-- JKA's own instructor manual requires an examiner to "verify that there is an
-- accurate number of movements" but does not itself publish per-kata counts, so
-- `kata.movement_count` stays null for the Heian series and the rows say
-- 'unverified' rather than carrying a number nobody can trace.

-- Rights vocabulary. ADDITIVE ONLY: the existing six values are used by
-- education.schema.ts and by another agent's in-flight work, so they are left
-- exactly as they are. The four added here are the distinctions the technical
-- directive requires and the original enum could not express — above all
-- 'embed_allowed' versus 'link_only', which is the difference between a legal
-- embed and an infringement, and 'unknown' versus 'not_cleared', which is the
-- difference between "nobody has checked" and "we checked, and no".
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PostgreSQL 12
-- and later provided the new value is not USED in the same transaction. Nothing
-- below writes one, so this is safe under the per-file transaction the runner
-- opens. Precedent: 0006 and 0011.
ALTER TYPE "public"."rights_status" ADD VALUE IF NOT EXISTS 'embed_allowed';--> statement-breakpoint
ALTER TYPE "public"."rights_status" ADD VALUE IF NOT EXISTS 'link_only';--> statement-breakpoint
ALTER TYPE "public"."rights_status" ADD VALUE IF NOT EXISTS 'unknown';--> statement-breakpoint
ALTER TYPE "public"."rights_status" ADD VALUE IF NOT EXISTS 'do_not_use';--> statement-breakpoint

CREATE TYPE "public"."source_tier" AS ENUM('mmakf_official', 'primary_reference', 'competition_authority', 'educational', 'discovery');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('unverified', 'source_documented', 'committee_verified', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."interpretation_kind" AS ENUM('traditional', 'instructor', 'mmakf_approved', 'historical', 'self_defence');--> statement-breakpoint
CREATE TYPE "public"."library_review_state" AS ENUM('new', 'classified', 'rights_review', 'technical_review', 'approved', 'published', 'rejected', 'archived');--> statement-breakpoint
CREATE TYPE "public"."technical_domain" AS ENUM('kihon', 'kata', 'kumite', 'bunkai', 'self_defence', 'competition', 'conditioning', 'lecture', 'seminar', 'philosophy', 'history', 'other');--> statement-breakpoint
CREATE TYPE "public"."proposed_by" AS ENUM('ai', 'human', 'import');--> statement-breakpoint

CREATE TABLE "technical_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"organisation" text NOT NULL,
	"source_type" text NOT NULL,
	"authority_tier" "source_tier" NOT NULL,
	"website_url" text,
	"channel_url" text,
	"media_channel_id" integer,
	"style" text,
	"language" text,
	"rights_policy" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_reviewed_on" date,
	"reviewed_by_person_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "technical_citations" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" integer NOT NULL,
	"source_id" integer,
	"source_url" text,
	"source_title" text,
	"source_author" text,
	"source_organisation" text,
	"source_type" text,
	"publication_date" date,
	"retrieved_on" date,
	"quote" text,
	"page" text,
	"domain" "technical_domain",
	"language" text,
	"verification" "verification_status" DEFAULT 'source_documented' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "kata_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"kata_id" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"count_label" text,
	"direction_label" text,
	"direction_degrees" integer,
	"turn_degrees" integer,
	"embusen_point" text,
	"stance_technique_id" integer,
	"stance_label" text,
	"technique_id" integer,
	"technique_label" text,
	"side" text,
	"limb" text,
	"target" text,
	"height" text,
	"transition" text,
	"breathing" text,
	"timing" text,
	"rhythm" text,
	"kime" text,
	"hikite" text,
	"body_mechanics" text,
	"kiai" boolean DEFAULT false NOT NULL,
	"common_errors" text,
	"teaching_note" text,
	"verification" "verification_status" DEFAULT 'unverified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "kata_applications" (
	"id" serial PRIMARY KEY NOT NULL,
	"kata_id" integer NOT NULL,
	"movement_from" integer,
	"movement_to" integer,
	"title" text NOT NULL,
	"kind" "interpretation_kind" NOT NULL,
	"scenario" text,
	"attacker_role" text,
	"defender_role" text,
	"attack" text,
	"defence" text,
	"counter" text,
	"control" text,
	"principle" text,
	"distance" text,
	"timing" text,
	"level" text,
	"safety_notes" text,
	"attributed_to" text,
	"approved_by_person_id" integer,
	"approved_on" date,
	"verification" "verification_status" DEFAULT 'unverified' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "sport_kumite_rulesets" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"authority" text NOT NULL,
	"version" text,
	"title" text NOT NULL,
	"effective_from" date,
	"effective_to" date,
	"status" text DEFAULT 'reference' NOT NULL,
	"document_url" text,
	"source_id" integer,
	"retrieved_on" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "sport_kumite_provisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"ruleset_id" integer NOT NULL,
	"article" text,
	"clause" text,
	"topic" text NOT NULL,
	"heading" text,
	"summary" text,
	"source_quote" text,
	"applies_to" text,
	"display_order" integer DEFAULT 0 NOT NULL,
	"verification" "verification_status" DEFAULT 'unverified' NOT NULL
);
--> statement-breakpoint

CREATE TABLE "technical_terms" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"kanji" text,
	"romaji" text NOT NULL,
	"english" text,
	"domain" "technical_domain" NOT NULL,
	"definition" text,
	"technique_id" integer,
	"kata_id" integer,
	"kumite_form_id" integer,
	"verification" "verification_status" DEFAULT 'unverified' NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "technical_term_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"term_id" integer NOT NULL,
	"alias" text NOT NULL,
	"kind" text DEFAULT 'romanisation' NOT NULL,
	"language" text
);
--> statement-breakpoint

CREATE TABLE "technical_translations" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" integer NOT NULL,
	"field" text NOT NULL,
	"language" text NOT NULL,
	"value" text NOT NULL,
	"translated_by_person_id" integer,
	"reviewed_by_person_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "media_technical_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"media_asset_id" integer NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" integer NOT NULL,
	"role" text DEFAULT 'reference' NOT NULL,
	"start_seconds" integer,
	"end_seconds" integer,
	"label" text,
	"domain" "technical_domain",
	"difficulty" text,
	"audience" text,
	"proposed_by" "proposed_by" DEFAULT 'human' NOT NULL,
	"confidence" integer,
	"state" "library_review_state" DEFAULT 'new' NOT NULL,
	"reviewed_by_person_id" integer,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "media_chapters" (
	"id" serial PRIMARY KEY NOT NULL,
	"media_asset_id" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"start_seconds" integer NOT NULL,
	"end_seconds" integer,
	"title" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "technical_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" integer NOT NULL,
	"dimension" text NOT NULL,
	"from_state" "library_review_state",
	"to_state" "library_review_state" NOT NULL,
	"reviewer_person_id" integer,
	"note" text,
	"evidence_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "reference_curricula" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"source_id" integer,
	"organisation" text NOT NULL,
	"title" text NOT NULL,
	"document_url" text,
	"published_on" date,
	"retrieved_on" date,
	"adopted_by_mmakf" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "reference_curriculum_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"curriculum_id" integer NOT NULL,
	"grade_label" text NOT NULL,
	"grade_ordinal" integer,
	"component" text NOT NULL,
	"requirement" text NOT NULL,
	"detail" text,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint

-- ─── Foreign keys ───────────────────────────────────────────────────────────

ALTER TABLE "technical_sources" ADD CONSTRAINT "technical_sources_reviewed_by_person_id_persons_id_fk" FOREIGN KEY ("reviewed_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_citations" ADD CONSTRAINT "technical_citations_source_id_technical_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."technical_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kata_movements" ADD CONSTRAINT "kata_movements_kata_id_kata_id_fk" FOREIGN KEY ("kata_id") REFERENCES "public"."kata"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kata_movements" ADD CONSTRAINT "kata_movements_stance_technique_id_techniques_id_fk" FOREIGN KEY ("stance_technique_id") REFERENCES "public"."techniques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kata_movements" ADD CONSTRAINT "kata_movements_technique_id_techniques_id_fk" FOREIGN KEY ("technique_id") REFERENCES "public"."techniques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kata_applications" ADD CONSTRAINT "kata_applications_kata_id_kata_id_fk" FOREIGN KEY ("kata_id") REFERENCES "public"."kata"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kata_applications" ADD CONSTRAINT "kata_applications_approved_by_person_id_persons_id_fk" FOREIGN KEY ("approved_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sport_kumite_rulesets" ADD CONSTRAINT "sport_kumite_rulesets_source_id_technical_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."technical_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sport_kumite_provisions" ADD CONSTRAINT "sport_kumite_provisions_ruleset_id_sport_kumite_rulesets_id_fk" FOREIGN KEY ("ruleset_id") REFERENCES "public"."sport_kumite_rulesets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_terms" ADD CONSTRAINT "technical_terms_technique_id_techniques_id_fk" FOREIGN KEY ("technique_id") REFERENCES "public"."techniques"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_terms" ADD CONSTRAINT "technical_terms_kata_id_kata_id_fk" FOREIGN KEY ("kata_id") REFERENCES "public"."kata"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_terms" ADD CONSTRAINT "technical_terms_kumite_form_id_kumite_forms_id_fk" FOREIGN KEY ("kumite_form_id") REFERENCES "public"."kumite_forms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_term_aliases" ADD CONSTRAINT "technical_term_aliases_term_id_technical_terms_id_fk" FOREIGN KEY ("term_id") REFERENCES "public"."technical_terms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_translations" ADD CONSTRAINT "technical_translations_translated_by_person_id_persons_id_fk" FOREIGN KEY ("translated_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_translations" ADD CONSTRAINT "technical_translations_reviewed_by_person_id_persons_id_fk" FOREIGN KEY ("reviewed_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_technical_links" ADD CONSTRAINT "media_technical_links_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_technical_links" ADD CONSTRAINT "media_technical_links_reviewed_by_person_id_persons_id_fk" FOREIGN KEY ("reviewed_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_chapters" ADD CONSTRAINT "media_chapters_media_asset_id_media_assets_id_fk" FOREIGN KEY ("media_asset_id") REFERENCES "public"."media_assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technical_reviews" ADD CONSTRAINT "technical_reviews_reviewer_person_id_persons_id_fk" FOREIGN KEY ("reviewer_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_curricula" ADD CONSTRAINT "reference_curricula_source_id_technical_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."technical_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_curriculum_items" ADD CONSTRAINT "reference_curriculum_items_curriculum_id_reference_curricula_id_fk" FOREIGN KEY ("curriculum_id") REFERENCES "public"."reference_curricula"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ─── Indexes ────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "technical_sources_slug_uk" ON "technical_sources" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "technical_sources_tier_idx" ON "technical_sources" USING btree ("authority_tier","active");--> statement-breakpoint
CREATE INDEX "technical_citations_subject_idx" ON "technical_citations" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "technical_citations_source_idx" ON "technical_citations" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "kata_movements_kata_ordinal_uk" ON "kata_movements" USING btree ("kata_id","ordinal");--> statement-breakpoint
CREATE INDEX "kata_movements_technique_idx" ON "kata_movements" USING btree ("technique_id");--> statement-breakpoint
CREATE INDEX "kata_movements_stance_idx" ON "kata_movements" USING btree ("stance_technique_id");--> statement-breakpoint
CREATE INDEX "kata_applications_kata_idx" ON "kata_applications" USING btree ("kata_id","movement_from");--> statement-breakpoint
CREATE INDEX "kata_applications_kind_idx" ON "kata_applications" USING btree ("kind","published");--> statement-breakpoint
CREATE UNIQUE INDEX "sport_kumite_rulesets_slug_uk" ON "sport_kumite_rulesets" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "sport_kumite_rulesets_authority_idx" ON "sport_kumite_rulesets" USING btree ("authority","status");--> statement-breakpoint
CREATE INDEX "sport_kumite_provisions_ruleset_idx" ON "sport_kumite_provisions" USING btree ("ruleset_id","display_order");--> statement-breakpoint
CREATE INDEX "sport_kumite_provisions_topic_idx" ON "sport_kumite_provisions" USING btree ("topic");--> statement-breakpoint
CREATE UNIQUE INDEX "technical_terms_slug_uk" ON "technical_terms" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "technical_terms_romaji_idx" ON "technical_terms" USING btree ("romaji");--> statement-breakpoint
CREATE INDEX "technical_terms_domain_idx" ON "technical_terms" USING btree ("domain","published");--> statement-breakpoint
CREATE INDEX "technical_term_aliases_alias_idx" ON "technical_term_aliases" USING btree ("alias");--> statement-breakpoint
CREATE INDEX "technical_term_aliases_term_idx" ON "technical_term_aliases" USING btree ("term_id");--> statement-breakpoint
CREATE UNIQUE INDEX "technical_translations_uk" ON "technical_translations" USING btree ("subject_kind","subject_id","field","language");--> statement-breakpoint
CREATE INDEX "technical_translations_lang_idx" ON "technical_translations" USING btree ("language");--> statement-breakpoint
CREATE INDEX "media_technical_links_asset_idx" ON "media_technical_links" USING btree ("media_asset_id");--> statement-breakpoint
CREATE INDEX "media_technical_links_subject_idx" ON "media_technical_links" USING btree ("subject_kind","subject_id","state");--> statement-breakpoint
CREATE INDEX "media_technical_links_state_idx" ON "media_technical_links" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "media_chapters_asset_ordinal_uk" ON "media_chapters" USING btree ("media_asset_id","ordinal");--> statement-breakpoint
CREATE INDEX "technical_reviews_subject_idx" ON "technical_reviews" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "technical_reviews_reviewer_idx" ON "technical_reviews" USING btree ("reviewer_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reference_curricula_slug_uk" ON "reference_curricula" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "reference_curriculum_items_curriculum_idx" ON "reference_curriculum_items" USING btree ("curriculum_id","display_order");--> statement-breakpoint
CREATE INDEX "reference_curriculum_items_grade_idx" ON "reference_curriculum_items" USING btree ("curriculum_id","grade_label");--> statement-breakpoint

-- ─── The constraints that make the directive true rather than aspirational ──

-- "AI CANNOT declare MMAKF approval." An application may only claim the
-- 'mmakf_approved' reading if it names the person who approved it and the date
-- they did. A classifier has no person id, so it cannot write this row — not
-- because the code declines to, but because the database rejects it.
ALTER TABLE "kata_applications" ADD CONSTRAINT "kata_applications_approval_needs_approver_ck"
	CHECK ("kind" <> 'mmakf_approved' OR ("approved_by_person_id" IS NOT NULL AND "approved_on" IS NOT NULL));--> statement-breakpoint

-- The same rule for the media graph: a link cannot reach 'approved' or
-- 'published' without a named reviewer. This is the guard on the AI
-- classification pipeline, which writes rows at 'new' and may go no further.
ALTER TABLE "media_technical_links" ADD CONSTRAINT "media_technical_links_approval_needs_reviewer_ck"
	CHECK ("state" NOT IN ('approved', 'published') OR ("reviewed_by_person_id" IS NOT NULL AND "reviewed_at" IS NOT NULL));--> statement-breakpoint

-- A citation that cites nothing is not provenance. At least one of a registry
-- source or a URL must be present.
ALTER TABLE "technical_citations" ADD CONSTRAINT "technical_citations_has_a_source_ck"
	CHECK ("source_id" IS NOT NULL OR "source_url" IS NOT NULL);--> statement-breakpoint

-- Ordering and interval sanity: movements count from 1, a movement range runs
-- forwards, and a video segment ends after it starts.
ALTER TABLE "kata_movements" ADD CONSTRAINT "kata_movements_ordinal_positive_ck"
	CHECK ("ordinal" > 0);--> statement-breakpoint
ALTER TABLE "kata_applications" ADD CONSTRAINT "kata_applications_movement_range_ck"
	CHECK ("movement_from" IS NULL OR "movement_to" IS NULL OR "movement_to" >= "movement_from");--> statement-breakpoint
ALTER TABLE "media_technical_links" ADD CONSTRAINT "media_technical_links_segment_ck"
	CHECK ("start_seconds" IS NULL OR "end_seconds" IS NULL OR "end_seconds" > "start_seconds");--> statement-breakpoint
ALTER TABLE "media_chapters" ADD CONSTRAINT "media_chapters_segment_ck"
	CHECK ("start_seconds" >= 0 AND ("end_seconds" IS NULL OR "end_seconds" > "start_seconds"));
