-- 0027 — the regulatory engine: source material, instruments, rules, decisions.
--
-- WHAT WAS MISSING. The federation could register a member, grade them, charge
-- them, sanction them and issue them a certificate — and could not say, for any
-- one of those acts, WHICH RULE IT WAS DONE UNDER. `official_documents` holds
-- files. `disciplinary_cases` holds a column called `alleged_breach_of` that is
-- free text. Nothing anywhere in the schema connected a decision to an approved,
-- dated, versioned rule, which means nothing could answer the only question that
-- matters when a decision is challenged: what applied to this person, on that
-- day, and who approved it.
--
-- AND THE SPECIFIC WAY IT WOULD HAVE GONE WRONG. MMAKF's first rules come from
-- Karate Academy Bharat's public site — a dojo code, a kyu ladder with durations
-- and fees, an instructor assessment weighted 40/40/20. Useful material, and
-- NOT ONE LINE OF IT IS AN MMAKF REGULATION. Without a provenance column the
-- migration path is a paste: an administrator moves a paragraph onto a
-- federation screen, and a year later nobody can say whether the rule a member
-- was refused under was ever adopted. The paragraph reads the same either way.
--
-- SO THREE THINGS ARE STRUCTURAL HERE, NOT COSMETIC.
--
--  1. PROVENANCE IS A COLUMN. `policy_layer` is academy_source /
--     mmakf_regulation / external_reference on both the source tables and the
--     instrument table. A query that puts academy material on a federation
--     surface has to name the layer; omission fails closed. Adoption does NOT
--     change a source row's layer — a new MMAKF provision is created that CITES
--     it, and both rows survive, so "did MMAKF write this or inherit it?" stays
--     answerable for ever.
--
--  2. EFFECTIVE RANGES ARE HALF-OPEN. `effective_from <= d AND (effective_to IS
--     NULL OR d < effective_to)`. Inclusive upper bounds are why superseding a
--     rule produces either a one-day gap in which no rule exists or a one-day
--     overlap in which two do, and both are indefensible when the day in
--     question is the day somebody was refused.
--
--  3. A DETERMINATION PINS THE RULE VERSION, NOT THE RULE. Amending a rule in
--     2027 must not restate what was decided in 2026.
--     `policy_determinations.rule_version_id` freezes the exact text that
--     decided the case, and the row is append-only — a changed mind creates a
--     new determination and supersedes the old one rather than editing it.
--
-- NOTHING IS SEEDED BY THIS MIGRATION. Every table ships EMPTY, for the same
-- reason the fee framework does: a plausible seeded rule is indistinguishable
-- six months later from one somebody actually approved. See
-- docs/governance/KARATE-ACADEMY-SOURCE-REGISTER.md for the material this was
-- designed around and MMAKF-REGULATORY-GAP-ANALYSIS.md for the thirty-four
-- instruments MMAKF has yet to author.

-- ── Enums ───────────────────────────────────────────────────────────────────

-- Whose rule it is. Three values and no fourth: a rule with mixed provenance is
-- a rule nobody can defend.
CREATE TYPE "public"."policy_layer" AS ENUM('academy_source', 'mmakf_regulation', 'external_reference');--> statement-breakpoint

CREATE TYPE "public"."policy_source_kind" AS ENUM('web_page', 'pdf', 'form', 'circular', 'email', 'meeting_minute', 'statute', 'rulebook', 'other');--> statement-breakpoint

-- How faithfully the extraction reproduces the source. 'absent' is a VALUE, not
-- a missing row: "we read this page and it says nothing about safeguarding" is a
-- finding, and recording it is what stops a later reader mistaking an unchecked
-- topic for a checked-and-empty one.
CREATE TYPE "public"."policy_source_confidence" AS ENUM('verbatim', 'verbatim_partial', 'paraphrased', 'inferred', 'absent');--> statement-breakpoint

-- What MMAKF has done about a source provision. 'flagged_not_adoptable' exists
-- because some published academy material must be RECORDED and must NEVER be
-- adopted; deleting it would falsify the register and leaving it at
-- 'not_adopted' would understate the finding.
CREATE TYPE "public"."policy_adoption_status" AS ENUM('not_adopted', 'under_review', 'cited', 'adopted', 'rejected', 'flagged_not_adoptable');--> statement-breakpoint

CREATE TYPE "public"."policy_instrument_type" AS ENUM('constitution', 'regulation', 'policy', 'code', 'guideline', 'circular', 'framework', 'standard');--> statement-breakpoint

-- approved / published / effective are three different facts and are not
-- collapsed. A version approved on 1 March, published on 10 March and effective
-- from 1 April did not govern a refusal issued on 20 March.
CREATE TYPE "public"."policy_state" AS ENUM('draft', 'technical_review', 'legal_review', 'governance_review', 'approved', 'published', 'effective', 'superseded', 'withdrawn', 'archived');--> statement-breakpoint

-- Where a clause came from. 'proposed' is what the gap analysis produces: a
-- provision MMAKF needs and no source supports. It renders with its own label,
-- so drafting is never mistaken for inheritance.
CREATE TYPE "public"."policy_derivation" AS ENUM('source_derived', 'proposed', 'external_reference', 'statutory');--> statement-breakpoint

-- The refusals are typed and distinct. 'no_rule_in_force' (nobody has approved a
-- rule for this) and 'ineligible' (a rule exists and the subject fails it) are
-- OPPOSITE facts; returning one value for both would report an unwritten policy
-- as a refusal.
CREATE TYPE "public"."policy_outcome" AS ENUM('eligible', 'ineligible', 'requires_review', 'no_rule_in_force', 'not_approved', 'insufficient_facts');--> statement-breakpoint

-- ── Layer 1 / Layer 3: source material ──────────────────────────────────────

-- A document that was retrieved, with the evidence of retrieval.
--
-- content_sha256 hashes what was actually read. A source page changes without
-- telling anyone, and a federation that adopted a rule from it must be able to
-- show WHICH text it adopted — not merely which URL. Without the hash, "the
-- website says X" degrades into an unfalsifiable claim inside a year.
--
-- There is deliberately no mmakf_regulation row in this table: MMAKF's own
-- instruments live in policy_instruments. This is for material MMAKF did not
-- write.
CREATE TABLE "source_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"layer" "policy_layer" NOT NULL,
	"source_org" text NOT NULL,
	"source_title" text NOT NULL,
	"source_url" text NOT NULL,
	"source_section" text,
	"source_date" date,
	"source_type" "policy_source_kind" DEFAULT 'web_page' NOT NULL,
	"retrieved_on" date NOT NULL,
	"retrieved_by_user_id" integer,
	"retrieved_by_label" text,
	"content_sha256" text,
	"fetch_evidence" text,
	"notes" text,
	"classification" "data_class" DEFAULT 'public' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- One extracted rule, with the words it was extracted from beside it.
--
-- source_excerpt and normalized_rule are BOTH NOT NULL and are never merged. The
-- excerpt is what the source says; the normalisation is what MMAKF understood it
-- to mean. Keeping only the normalisation loses the ability to check the
-- reading; keeping only the excerpt makes it unusable as a rule.
--
-- adoption_status defaults to 'not_adopted' and no code path sets it to
-- 'adopted' without an instrument version and a named approver.
CREATE TABLE "source_provisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"source_document_id" integer NOT NULL,
	"layer" "policy_layer" NOT NULL,
	"topic" text NOT NULL,
	"category" text,
	"source_excerpt" text NOT NULL,
	"normalized_rule" text NOT NULL,
	"confidence" "policy_source_confidence" NOT NULL,
	"adoption_status" "policy_adoption_status" DEFAULT 'not_adopted' NOT NULL,
	"adoption_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- ── Layer 2: MMAKF's own instruments ────────────────────────────────────────

-- Separate from official_documents (0000) on purpose. That table is a register
-- of FILES — a constitution PDF with a checksum and an approval. This is a
-- register of RULES: it carries clause-level provisions and machine-evaluable
-- conditions, and its versions drive decisions. A federation needs both, and
-- conflating them would mean either that every uploaded PDF pretends to be
-- executable or that every executable rule needs a file before it can exist.
CREATE TABLE "policy_instruments" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"instrument_type" "policy_instrument_type" NOT NULL,
	"layer" "policy_layer" DEFAULT 'mmakf_regulation' NOT NULL,
	"subject_area" text NOT NULL,
	"summary" text,
	"jurisdiction" text DEFAULT 'national' NOT NULL,
	"jurisdiction_scope_type" text DEFAULT 'national' NOT NULL,
	"jurisdiction_scope_id" integer,
	"issuer" text DEFAULT 'MMAKF' NOT NULL,
	"owner_committee_id" integer,
	"classification" "data_class" DEFAULT 'public' NOT NULL,
	"current_version_id" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- One version. A published version is NEVER edited.
--
-- effective_to is EXCLUSIVE. A version effective 2026-04-01 to 2027-04-01 does
-- not apply on 2027-04-01; its successor does.
CREATE TABLE "policy_instrument_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"instrument_id" integer NOT NULL,
	"version" text NOT NULL,
	"state" "policy_state" DEFAULT 'draft' NOT NULL,
	"body_markdown" text,
	"file_url" text,
	"body_sha256" text,
	"effective_from" date,
	"effective_to" date,
	"review_due_on" date,
	"approved_by_committee_id" integer,
	"approved_by_person_id" integer,
	"approved_on" date,
	"approved_under_resolution_id" integer,
	"approved_under" text,
	"supersedes_version_id" integer,
	"published_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- A clause inside a version, and the ONLY route from source material to policy.
--
-- source_provision_id is nullable because most federation clauses have no source
-- at all — the gap analysis lists thirty-four instruments MMAKF must author from
-- scratch. But where it IS set, derivation must read 'source_derived' and the
-- approver and date must be present: that triple is what turns "MMAKF adopted
-- the academy's 4th Kyu requirement" from a recollection into a record.
CREATE TABLE "policy_provisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"instrument_version_id" integer NOT NULL,
	"clause_ref" text NOT NULL,
	"heading" text,
	"text" text NOT NULL,
	"category" text,
	"derivation" "policy_derivation" NOT NULL,
	"source_provision_id" integer,
	"external_body" text,
	"external_citation" text,
	"adopted_by_person_id" integer,
	"adopted_on" date,
	"adoption_note" text,
	"ordinal" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- ── The rule engine ─────────────────────────────────────────────────────────

-- instrument_id is NOT NULL and that is the point: a rule with no instrument is
-- a policy nobody approved, which is exactly the hard-coded condition buried in
-- a component that this table exists to replace.
CREATE TABLE "policy_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"instrument_id" integer NOT NULL,
	"subject_kind" text NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- conditions is [{fact, op, value, label}] — a deliberately small language. It
-- is not a scripting engine, and that is a safety property rather than a
-- limitation: a rule that could execute arbitrary logic is a rule a governance
-- committee cannot read, and an approval given to something unreadable is not an
-- approval.
--
-- outcome_met and outcome_unmet are both explicit because some rules exist to
-- FLAG rather than to refuse. A maturity assessment must be able to reach
-- 'requires_review' and never an automatic rejection — nobody is sanctioned on
-- an automatic flag.
CREATE TABLE "policy_rule_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"version" text NOT NULL,
	"state" "policy_state" DEFAULT 'draft' NOT NULL,
	"instrument_version_id" integer,
	"provision_id" integer,
	"conditions" jsonb NOT NULL,
	"outcome_met" "policy_outcome" DEFAULT 'eligible' NOT NULL,
	"outcome_unmet" "policy_outcome" DEFAULT 'ineligible' NOT NULL,
	"actions" jsonb,
	"refusal_reason" text,
	"effective_from" date,
	"effective_to" date,
	"approved_by_committee_id" integer,
	"approved_by_person_id" integer,
	"approved_on" date,
	"approved_under_resolution_id" integer,
	"supersedes_version_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- What the engine decided, about whom, under which version, on what facts.
--
-- APPEND-ONLY. A decision that can be edited is not a decision anybody can rely
-- on; a changed mind produces a NEW row and supersedes the old one.
--
-- appealable is NOT NULL with NO DEFAULT: every determination has to state its
-- appeal position, because "we never said" is how a decision becomes
-- unchallengeable by accident.
CREATE TABLE "policy_determinations" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"rule_code" text NOT NULL,
	"rule_version_id" integer,
	"instrument_version_id" integer,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"person_id" integer,
	"facts" jsonb NOT NULL,
	"outcome" "policy_outcome" NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb,
	"determined_on" date NOT NULL,
	"determined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" integer,
	"actor_label" text,
	"appealable" boolean NOT NULL,
	"appeal_case_id" integer,
	"superseded_by_determination_id" integer,
	"classification" "data_class" DEFAULT 'member' NOT NULL
);--> statement-breakpoint

-- ── Foreign keys ────────────────────────────────────────────────────────────
--
-- current_version_id and every supersedes_version_id are plain integers with no
-- constraint, exactly as official_documents.current_version_id is: the reference
-- points back into a table that references this one, and a real FK in both
-- directions cannot be satisfied by any single insert order.

ALTER TABLE "source_provisions" ADD CONSTRAINT "source_provisions_source_document_id_source_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."source_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_instruments" ADD CONSTRAINT "policy_instruments_owner_committee_id_committees_id_fk" FOREIGN KEY ("owner_committee_id") REFERENCES "public"."committees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_instrument_versions" ADD CONSTRAINT "policy_instrument_versions_instrument_id_policy_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."policy_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_instrument_versions" ADD CONSTRAINT "policy_instrument_versions_approved_by_committee_id_committees_id_fk" FOREIGN KEY ("approved_by_committee_id") REFERENCES "public"."committees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_instrument_versions" ADD CONSTRAINT "policy_instrument_versions_approved_by_person_id_persons_id_fk" FOREIGN KEY ("approved_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_instrument_versions" ADD CONSTRAINT "policy_instrument_versions_approved_under_resolution_id_resolutions_id_fk" FOREIGN KEY ("approved_under_resolution_id") REFERENCES "public"."resolutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_provisions" ADD CONSTRAINT "policy_provisions_instrument_version_id_policy_instrument_versions_id_fk" FOREIGN KEY ("instrument_version_id") REFERENCES "public"."policy_instrument_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_provisions" ADD CONSTRAINT "policy_provisions_source_provision_id_source_provisions_id_fk" FOREIGN KEY ("source_provision_id") REFERENCES "public"."source_provisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_provisions" ADD CONSTRAINT "policy_provisions_adopted_by_person_id_persons_id_fk" FOREIGN KEY ("adopted_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rules" ADD CONSTRAINT "policy_rules_instrument_id_policy_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."policy_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rule_versions" ADD CONSTRAINT "policy_rule_versions_rule_id_policy_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."policy_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rule_versions" ADD CONSTRAINT "policy_rule_versions_instrument_version_id_policy_instrument_versions_id_fk" FOREIGN KEY ("instrument_version_id") REFERENCES "public"."policy_instrument_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rule_versions" ADD CONSTRAINT "policy_rule_versions_provision_id_policy_provisions_id_fk" FOREIGN KEY ("provision_id") REFERENCES "public"."policy_provisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rule_versions" ADD CONSTRAINT "policy_rule_versions_approved_by_committee_id_committees_id_fk" FOREIGN KEY ("approved_by_committee_id") REFERENCES "public"."committees"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rule_versions" ADD CONSTRAINT "policy_rule_versions_approved_by_person_id_persons_id_fk" FOREIGN KEY ("approved_by_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_rule_versions" ADD CONSTRAINT "policy_rule_versions_approved_under_resolution_id_resolutions_id_fk" FOREIGN KEY ("approved_under_resolution_id") REFERENCES "public"."resolutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_determinations" ADD CONSTRAINT "policy_determinations_rule_version_id_policy_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."policy_rule_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_determinations" ADD CONSTRAINT "policy_determinations_instrument_version_id_policy_instrument_versions_id_fk" FOREIGN KEY ("instrument_version_id") REFERENCES "public"."policy_instrument_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policy_determinations" ADD CONSTRAINT "policy_determinations_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ── Indexes ─────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "source_documents_code_uk" ON "source_documents" USING btree ("code");--> statement-breakpoint
CREATE INDEX "source_documents_layer_idx" ON "source_documents" USING btree ("layer","source_org");--> statement-breakpoint
CREATE UNIQUE INDEX "source_provisions_ref_uk" ON "source_provisions" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "source_provisions_document_idx" ON "source_provisions" USING btree ("source_document_id");--> statement-breakpoint
CREATE INDEX "source_provisions_status_idx" ON "source_provisions" USING btree ("adoption_status","layer");--> statement-breakpoint
CREATE INDEX "source_provisions_topic_idx" ON "source_provisions" USING btree ("topic");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_instruments_code_uk" ON "policy_instruments" USING btree ("code");--> statement-breakpoint
CREATE INDEX "policy_instruments_area_idx" ON "policy_instruments" USING btree ("subject_area","instrument_type");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_instrument_versions_uk" ON "policy_instrument_versions" USING btree ("instrument_id","version");--> statement-breakpoint
CREATE INDEX "policy_instrument_versions_instrument_idx" ON "policy_instrument_versions" USING btree ("instrument_id","state");--> statement-breakpoint
-- The index the temporal resolver actually uses: "which version of instrument N
-- was in force on date D".
CREATE INDEX "policy_instrument_versions_effective_idx" ON "policy_instrument_versions" USING btree ("instrument_id","effective_from","effective_to");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_provisions_clause_uk" ON "policy_provisions" USING btree ("instrument_version_id","clause_ref");--> statement-breakpoint
CREATE INDEX "policy_provisions_version_idx" ON "policy_provisions" USING btree ("instrument_version_id","ordinal");--> statement-breakpoint
-- Answers the direction that matters for source integrity: "what did MMAKF do
-- with this academy provision?"
CREATE INDEX "policy_provisions_source_idx" ON "policy_provisions" USING btree ("source_provision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_rules_code_uk" ON "policy_rules" USING btree ("code");--> statement-breakpoint
CREATE INDEX "policy_rules_subject_idx" ON "policy_rules" USING btree ("subject_kind","active");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_rule_versions_uk" ON "policy_rule_versions" USING btree ("rule_id","version");--> statement-breakpoint
CREATE INDEX "policy_rule_versions_rule_idx" ON "policy_rule_versions" USING btree ("rule_id","state");--> statement-breakpoint
CREATE INDEX "policy_rule_versions_effective_idx" ON "policy_rule_versions" USING btree ("rule_id","effective_from","effective_to");--> statement-breakpoint
CREATE UNIQUE INDEX "policy_determinations_ref_uk" ON "policy_determinations" USING btree ("ref");--> statement-breakpoint
CREATE INDEX "policy_determinations_subject_idx" ON "policy_determinations" USING btree ("subject_type","subject_id");--> statement-breakpoint
-- "What rule applied to this person, and when?" — the definition-of-done query.
CREATE INDEX "policy_determinations_person_idx" ON "policy_determinations" USING btree ("person_id","determined_on");--> statement-breakpoint
CREATE INDEX "policy_determinations_rule_idx" ON "policy_determinations" USING btree ("rule_code","determined_on");
