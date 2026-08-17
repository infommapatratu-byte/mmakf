-- 0025 — the location engine and the identity foundation.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS REPOSITORY HAD, AND WHY IT WAS NOT ENOUGH
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Before this migration the federation recorded WHERE somebody is in exactly
-- two ways, and both are the same way:
--
--     persons.state_unit_id    -> state_units
--     persons.district_unit_id -> district_units
--     persons.city             -> free text
--
-- and the identical trio appears on coach_profiles, venues, institutions and
-- routing_rules. That is not geography. `state_units` is the register of
-- CHARTERED MMAKF BODIES: a row exists when the federation has chartered a
-- state unit, and not otherwise. Kerala has people in it whether or not MMAKF
-- has chartered Kerala.
--
-- So the system could not record the residence of anybody living outside the
-- chartered hierarchy — the exact people a national federation is trying to
-- recruit — and for everybody else "where do you live" collapsed to a free-text
-- city with no postal code, no locality, no country and no canonical id. Two
-- members in the same town were 'Guwahati' and 'Gauhati' and the database could
-- not tell that they were neighbours.
--
-- THE SEPARATION THIS MIGRATION MAKES, and it is the whole point: CIVIL
-- GEOGRAPHY (where a place is) is not FEDERATION JURISDICTION (whose authority
-- covers it). They are related by a lookup somebody maintains, never by an
-- equality. Nothing below writes to state_units, and no foreign key joins the
-- two ladders. An address resolves to an admin_area; which unit ADMINISTERS
-- that area stays a federation decision, recorded on the unit register.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY admin_areas IS ONE SELF-REFERENCING TABLE AND NOT FOUR
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The obvious shape is countries -> states -> districts -> cities. It encodes
-- one country's constitution into DDL. India alone breaks it: a district
-- contains sub-districts (tehsil/taluk/circle), a municipal corporation is not
-- inside a district in the same sense a village is, and the census recognises
-- wards below cities. A federation that later admits an affiliate abroad would
-- need a fifth table for prefectures.
--
-- One table with a parent, a level and a MATERIALISED PATH gives arbitrary
-- depth, one join to walk up, and a prefix match to walk down — and the path
-- (IN / AS.KAMRUP-METRO.GUWAHATI) is a stable canonical identifier that
-- survives a renaming, which is what "store canonical geographic IDs" requires.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT SHIPS EMPTY, AND WHY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- EVERY TABLE BELOW SHIPS EMPTY. Not one country, state, district or postal
-- code is seeded. This follows the rule the fee framework, the tax tables and
-- the currency tables already follow in this schema: seeded reference data is
-- indistinguishable six months later from data somebody verified, and a wrong
-- district silently attached to ten thousand members is not a defect anybody
-- finds by reading code. Geography is loaded through the import path in
-- src/db/geography.ts, which records the SOURCE of every row it writes.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE IDENTITY HALF
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Six things the register could not previously express, each of which the
-- federation's own brief names:
--
--  · A VERIFIED contact. persons.email is one column with no notion of whether
--    anybody proved it. person_contacts holds the proof, and holds the
--    alternate numbers a single column could never hold.
--  · WHERE SOMEBODY LIVES, over time. A person moves; overwriting an address
--    destroys the record of where they were when they competed.
--  · WHO MAY ACT FOR A CHILD. There was no relationship model at all — no
--    parent, no guardian, no dependant, nothing. A national federation that
--    teaches five-year-olds could not name a child's guardian.
--  · WHAT A GUARDIAN MAY ACTUALLY SEE. Being a parent is not a permission.
--    guardian_authorizations is deliberately a separate table from the
--    relationship so that "is the parent" and "may read the medical record" can
--    never be the same fact.
--  · CONSENT, as a record rather than a boolean. Policy key, policy VERSION,
--    who gave it, in what capacity, when, and through what channel. Withdrawal
--    is a new row. Nothing in this table is ever updated.
--  · THAT TWO RECORDS MIGHT BE ONE PERSON. duplicate_candidates raises the
--    question and refuses to answer it: no merge happens without a human.
--
-- And profile_change_requests, because a member who changes their own date of
-- birth in a form has changed their competition age category. Governed fields
-- move through evidence and a decision, not through an UPDATE.

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — CIVIL GEOGRAPHY
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "public"."admin_area_level" AS ENUM('region', 'state', 'division', 'district', 'subdistrict', 'city', 'ward', 'locality');--> statement-breakpoint
CREATE TYPE "public"."geo_status" AS ENUM('active', 'merged', 'renamed', 'dissolved');--> statement-breakpoint

-- ISO 3166-1. `iso2` is the key everything else quotes.
CREATE TABLE "countries" (
	"id" serial PRIMARY KEY NOT NULL,
	"iso2" text NOT NULL,
	"iso3" text,
	"name" text NOT NULL,
	"phone_code" text,
	"default_language" text,
	"default_timezone" text,
	"status" "geo_status" DEFAULT 'active' NOT NULL,
	-- Where this row came from. A country loaded from an ISO list and one typed
	-- in by an administrator are not equally trustworthy, and six months later
	-- nothing else can tell them apart.
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "countries_iso2_uk" ON "countries" ("iso2");--> statement-breakpoint

-- The ladder. Depth is not fixed; `level` says what a row IS and `path` says
-- where it sits. See the header for why this is one table.
CREATE TABLE "admin_areas" (
	"id" serial PRIMARY KEY NOT NULL,
	"country_id" integer NOT NULL REFERENCES "countries"("id"),
	"parent_id" integer REFERENCES "admin_areas"("id"),
	"level" "admin_area_level" NOT NULL,
	-- Segment code, unique among siblings: AS, KAMRUP-METRO, GUWAHATI.
	"code" text NOT NULL,
	-- Full dotted path from the country root: AS.KAMRUP-METRO.GUWAHATI.
	-- Materialised because the alternative — a recursive CTE on every read — is
	-- the query a 600-million-row register cannot afford to run per request.
	"path" text NOT NULL,
	"depth" integer NOT NULL,
	"name" text NOT NULL,
	"native_name" text,
	-- Official statistical codes where they exist (LGD, census). Nullable
	-- because MMAKF has adopted no particular register and a NOT NULL here would
	-- be this migration choosing one.
	"official_code" text,
	"timezone" text,
	"status" "geo_status" DEFAULT 'active' NOT NULL,
	-- A district that is split or renamed is NOT deleted; it points at what it
	-- became, so an address recorded in 2019 still resolves.
	"superseded_by_area_id" integer,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
-- The canonical identity of a place: one path per country.
CREATE UNIQUE INDEX "admin_areas_path_uk" ON "admin_areas" ("country_id","path");--> statement-breakpoint
CREATE INDEX "admin_areas_parent_idx" ON "admin_areas" ("parent_id");--> statement-breakpoint
CREATE INDEX "admin_areas_level_idx" ON "admin_areas" ("country_id","level");--> statement-breakpoint
-- Prefix search — "everything under Assam" — uses this, and it must carry
-- text_pattern_ops or LIKE 'AS.%' will not use it under non-C collations.
CREATE INDEX "admin_areas_path_prefix_idx" ON "admin_areas" ("path" text_pattern_ops);--> statement-breakpoint

-- Alternate spellings, historical names and transliterations.
--
-- NOT UNIQUE ON THE NORMALISED FORM, deliberately. 'Kamrup' is both a district
-- and a city; 'Hyderabad' is in two countries. A unique index would force this
-- migration to pick a winner, and the resolver in src/db/geography.ts would
-- then return a confident wrong answer. Instead ambiguity is representable, and
-- the resolver returns AMBIGUOUS and asks — see resolveArea().
CREATE TABLE "geo_aliases" (
	"id" serial PRIMARY KEY NOT NULL,
	"country_id" integer NOT NULL REFERENCES "countries"("id"),
	"area_id" integer NOT NULL REFERENCES "admin_areas"("id"),
	"alias" text NOT NULL,
	-- Lowercased, punctuation and spacing stripped. Computed once on write by
	-- normaliseName() so that every lookup uses the same transformation.
	"normalized" text NOT NULL,
	"kind" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "geo_aliases_lookup_idx" ON "geo_aliases" ("country_id","normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "geo_aliases_area_uk" ON "geo_aliases" ("area_id","normalized");--> statement-breakpoint

-- One postal code covers several areas and one area holds several codes, so
-- this is a link table and not a column on either side.
CREATE TABLE "postal_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"country_id" integer NOT NULL REFERENCES "countries"("id"),
	"code" text NOT NULL,
	"area_id" integer NOT NULL REFERENCES "admin_areas"("id"),
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "postal_codes_uk" ON "postal_codes" ("country_id","code","area_id");--> statement-breakpoint
CREATE INDEX "postal_codes_code_idx" ON "postal_codes" ("country_id","code");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — ADDRESSES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "public"."address_precision" AS ENUM('exact', 'locality', 'area', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."address_kind" AS ENUM('home', 'postal', 'training', 'work', 'billing');--> statement-breakpoint

-- An address is IMMUTABLE CONTENT. Correcting one writes a new row and re-links
-- the subject; the old row stays because a certificate posted in 2024 was
-- posted somewhere, and an address that has been edited cannot say where.
--
-- `locality_text` keeps what the applicant actually typed, beside the area the
-- system resolved it to. When the two disagree later — a district is split, an
-- alias is corrected — the original words are still there to re-resolve from.
CREATE TABLE "addresses" (
	"id" serial PRIMARY KEY NOT NULL,
	"country_id" integer NOT NULL REFERENCES "countries"("id"),
	-- The LOWEST area confidently known. Null is honest: an address with a
	-- country and a pincode nobody has loaded yet is still an address.
	"area_id" integer REFERENCES "admin_areas"("id"),
	"line1" text,
	"line2" text,
	"landmark" text,
	"locality_text" text,
	"postal_code" text,
	-- numeric, not double precision: a coordinate that drifts in the last
	-- decimal place on every round-trip is a coordinate nobody can compare.
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"precision" "address_precision" DEFAULT 'unknown' NOT NULL,
	"timezone" text,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "addresses_area_idx" ON "addresses" ("area_id");--> statement-breakpoint
CREATE INDEX "addresses_postal_idx" ON "addresses" ("country_id","postal_code");--> statement-breakpoint

-- Which address is whose, for what purpose, and WHEN.
CREATE TABLE "person_addresses" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL REFERENCES "persons"("id"),
	"address_id" integer NOT NULL REFERENCES "addresses"("id"),
	"kind" "address_kind" NOT NULL,
	"valid_from" date NOT NULL,
	-- NULL means current. Superseding an address sets this, never deletes.
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "person_addresses_person_idx" ON "person_addresses" ("person_id");--> statement-breakpoint
-- ONE CURRENT ADDRESS PER PERSON PER KIND, in the database rather than in a
-- read-then-write. Two intake paths recording a home address at the same moment
-- both see none current and both insert, and "which of these two is where they
-- live" is a question no later query can answer.
CREATE UNIQUE INDEX "person_addresses_current_uk" ON "person_addresses" ("person_id","kind") WHERE "valid_to" IS NULL;--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 3 — CONTACTS AND THEIR VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "public"."contact_kind" AS ENUM('email', 'phone', 'whatsapp');--> statement-breakpoint
CREATE TYPE "public"."contact_status" AS ENUM('active', 'superseded', 'revoked', 'bounced');--> statement-breakpoint

-- persons.email and persons.phone remain the PRIMARY strings, and this table is
-- the only place that says whether anybody proved one. That split is on
-- purpose: an `email_verified` boolean beside `email` on persons would be a
-- second answer to the same question the day somebody updates one and not the
-- other.
--
-- `normalized` exists for duplicate detection: '+91 98765 43210' and
-- '919876543210' are one phone, and only a normalised column can index that.
CREATE TABLE "person_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL REFERENCES "persons"("id"),
	"kind" "contact_kind" NOT NULL,
	"value" text NOT NULL,
	"normalized" text NOT NULL,
	"label" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	-- NULL = NOT VERIFIED. There is no third state and no default of "assumed
	-- good": every path that treats an unverified address as verified starts
	-- with a column that made it easy.
	"verified_at" timestamp with time zone,
	"verification_method" text,
	"verification_ref" text,
	"status" "contact_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "person_contacts_person_idx" ON "person_contacts" ("person_id");--> statement-breakpoint
-- The duplicate-detection index. Not unique: two siblings legitimately share a
-- parent's phone number, and refusing the second child at the database level
-- would be this migration deciding a family policy nobody asked for.
CREATE INDEX "person_contacts_normalized_idx" ON "person_contacts" ("kind","normalized");--> statement-breakpoint
CREATE UNIQUE INDEX "person_contacts_primary_uk" ON "person_contacts" ("person_id","kind") WHERE "is_primary" AND "status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "person_contacts_value_uk" ON "person_contacts" ("person_id","kind","normalized") WHERE "status" = 'active';--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 4 — RELATIONSHIPS, AND WHAT THEY DO NOT CONFER
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "public"."relationship_type" AS ENUM('parent', 'legal_guardian', 'authorized_guardian', 'institutional_guardian', 'spouse', 'sibling', 'emergency_contact');--> statement-breakpoint
CREATE TYPE "public"."relationship_status" AS ENUM('asserted', 'verified', 'rejected', 'revoked', 'expired');--> statement-breakpoint

-- HOLDER is the <type> OF SUBJECT. A mother and her child: holder = mother,
-- type = 'parent', subject = child.
--
-- 'asserted' IS THE DEFAULT AND IT CONFERS NOTHING. Anybody can type a claim to
-- be somebody's parent into a form; the register records the claim, marks who
-- made it, and waits. This mirrors the rule the onboarding schema already
-- states for role applications: a request is not authority.
CREATE TABLE "person_relationships" (
	"id" serial PRIMARY KEY NOT NULL,
	"holder_person_id" integer NOT NULL REFERENCES "persons"("id"),
	"subject_person_id" integer NOT NULL REFERENCES "persons"("id"),
	"type" "relationship_type" NOT NULL,
	"status" "relationship_status" DEFAULT 'asserted' NOT NULL,
	"evidence" jsonb,
	"asserted_by_user_id" integer REFERENCES "users"("id"),
	"verified_by_user_id" integer REFERENCES "users"("id"),
	"verified_at" timestamp with time zone,
	"decision_reason" text,
	"valid_from" date,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	-- Nobody is their own guardian. Cheap to state, impossible to violate.
	CONSTRAINT "person_relationships_not_self" CHECK ("holder_person_id" <> "subject_person_id")
);--> statement-breakpoint
CREATE INDEX "person_relationships_holder_idx" ON "person_relationships" ("holder_person_id");--> statement-breakpoint
CREATE INDEX "person_relationships_subject_idx" ON "person_relationships" ("subject_person_id");--> statement-breakpoint
-- One LIVE relationship per pair per type. A revoked one may sit beside it, and
-- must: a guardianship that ended is the record of why somebody had access.
CREATE UNIQUE INDEX "person_relationships_live_uk" ON "person_relationships" ("holder_person_id","subject_person_id","type") WHERE "status" IN ('asserted', 'verified');--> statement-breakpoint

-- WHAT A GUARDIAN MAY ACTUALLY DO, granted one capability at a time.
--
-- This table exists because of one sentence in the federation's brief:
-- "Sensitive information must not become visible simply because a user has
-- 'parent' status." If access were derived from the relationship row, then
-- every parent would hold every capability the day a developer wrote
-- `if (isParent)`. Here there is nothing to write: an ungranted capability has
-- no row, and no row is no access.
CREATE TABLE "guardian_authorizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"relationship_id" integer NOT NULL REFERENCES "person_relationships"("id"),
	-- See GUARDIAN_CAPABILITIES in src/db/identity.ts. Text rather than an enum
	-- for the reason role_bindings.role is text: the list lives in one module
	-- and a database enum would be a second copy of it.
	"capability" text NOT NULL,
	"granted_by_user_id" integer REFERENCES "users"("id"),
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"status" "credential_status" DEFAULT 'active' NOT NULL,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "guardian_authorizations_rel_idx" ON "guardian_authorizations" ("relationship_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guardian_authorizations_active_uk" ON "guardian_authorizations" ("relationship_id","capability") WHERE "status" = 'active';--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 5 — CONSENT
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "public"."consent_decision" AS ENUM('granted', 'refused', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."consent_capacity" AS ENUM('self', 'guardian', 'institution', 'staff');--> statement-breakpoint

-- APPEND-ONLY. There is no status column and nothing here is ever UPDATEd.
-- Current consent is the LATEST row for (subject, policy_key) — which means a
-- withdrawal is a new row, and the fact that consent once existed survives it.
-- That is the difference between a consent record and a consent flag: only one
-- of them can answer "was this photograph taken while consent was in force?"
--
-- policy_version IS NOT NULL. Consent to version 1 of a photo policy is not
-- consent to version 4, and a record that does not say which one it agreed to
-- cannot be relied on by anybody.
CREATE TABLE "consent_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_person_id" integer NOT NULL REFERENCES "persons"("id"),
	"policy_key" text NOT NULL,
	"policy_version" text NOT NULL,
	"decision" "consent_decision" NOT NULL,
	"capacity" "consent_capacity" NOT NULL,
	-- Who actually gave it. For a minor this is the guardian, and the
	-- relationship they acted under is named so the authority is checkable years
	-- later rather than assumed.
	"given_by_person_id" integer REFERENCES "persons"("id"),
	"given_by_user_id" integer REFERENCES "users"("id"),
	"relationship_id" integer REFERENCES "person_relationships"("id"),
	"channel" text,
	-- Hashed, never raw — the same rule audit_events.actor_ip_hash follows.
	"ip_hash" text,
	"user_agent_hash" text,
	"evidence" jsonb,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "consent_records_current_idx" ON "consent_records" ("subject_person_id","policy_key","recorded_at");--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 6 — DUPLICATES, RAISED AND NEVER SILENTLY RESOLVED
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "public"."duplicate_subject" AS ENUM('person', 'institution');--> statement-breakpoint
CREATE TYPE "public"."duplicate_status" AS ENUM('open', 'same', 'distinct', 'merged');--> statement-breakpoint

-- The pair is stored with left_id < right_id so that (A,B) and (B,A) are ONE
-- candidate. Without the check a detector run from either side produces two
-- rows, two reviewers decide them independently, and they can disagree.
CREATE TABLE "duplicate_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_type" "duplicate_subject" NOT NULL,
	"left_id" integer NOT NULL,
	"right_id" integer NOT NULL,
	-- Per mille, 0..1000. Integer for the reason money is integer paise here:
	-- a float score that sorts differently on two machines is not a queue order.
	"score" integer NOT NULL,
	-- WHICH signals fired, not just how many. A reviewer deciding "same person"
	-- needs to see that it was a verified phone and a date of birth, not two
	-- common names.
	"signals" jsonb NOT NULL,
	"status" "duplicate_status" DEFAULT 'open' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by_user_id" integer REFERENCES "users"("id"),
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"merged_into_id" integer,
	CONSTRAINT "duplicate_candidates_ordered" CHECK ("left_id" < "right_id")
);--> statement-breakpoint
CREATE INDEX "duplicate_candidates_queue_idx" ON "duplicate_candidates" ("subject_type","status","score");--> statement-breakpoint
CREATE UNIQUE INDEX "duplicate_candidates_open_uk" ON "duplicate_candidates" ("subject_type","left_id","right_id") WHERE "status" = 'open';--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 7 — GOVERNED PROFILE CHANGES
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE "public"."change_request_status" AS ENUM('submitted', 'under_review', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint

-- Not every field needs this. A member correcting their landline should not
-- wait for a committee. GOVERNED_FIELDS in src/db/identity.ts names the ones
-- that do — the ones an unreviewed edit would silently change an outcome for:
-- a date of birth is a competition age category, a name is what a certificate
-- already says, a nationality is eligibility for a national squad.
CREATE TABLE "profile_change_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"person_id" integer NOT NULL REFERENCES "persons"("id"),
	"requested_by_user_id" integer REFERENCES "users"("id"),
	"field" text NOT NULL,
	-- The value AT THE MOMENT OF REQUEST. Kept so that a decision taken a
	-- fortnight later can see whether the record moved underneath it.
	"old_value" text,
	"new_value" text,
	"evidence" jsonb,
	"status" "change_request_status" DEFAULT 'submitted' NOT NULL,
	"reviewed_by_user_id" integer REFERENCES "users"("id"),
	"reviewed_at" timestamp with time zone,
	"decision_reason" text,
	-- Set when the approved change was actually written to persons. Approval and
	-- application are two facts: an approved request that failed to apply is a
	-- row a queue can find, rather than a change everybody believes happened.
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "profile_change_requests_ref_uk" ON "profile_change_requests" ("ref");--> statement-breakpoint
CREATE INDEX "profile_change_requests_person_idx" ON "profile_change_requests" ("person_id");--> statement-breakpoint
CREATE INDEX "profile_change_requests_queue_idx" ON "profile_change_requests" ("status","created_at");--> statement-breakpoint
-- One open request per person per field, or two reviewers approve two different
-- dates of birth and the second silently wins.
CREATE UNIQUE INDEX "profile_change_requests_open_uk" ON "profile_change_requests" ("person_id","field") WHERE "status" IN ('submitted', 'under_review');--> statement-breakpoint

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 8 — PERSONS, EXTENDED
-- ═══════════════════════════════════════════════════════════════════════════
--
-- full_name STAYS, and stays NOT NULL. It is the display name, it is what the
-- certificates say, and the rest of this repository reads it. The parts below
-- are ADDITIONAL and nullable: they are for matching, for official forms and
-- for addressing somebody correctly, and they are populated where they are
-- known rather than back-derived by splitting existing names on spaces — which
-- for 'Shihan Pramod Kumar Pathak' would produce a family name of 'Kumar' and a
-- title as a given name.
--
-- residence_area_id is the CIVIL area a person lives in. It sits beside
-- state_unit_id, which is the FEDERATION unit that administers them, because
-- the two answer different questions and a member can legitimately have one
-- without the other.

ALTER TABLE "persons" ADD COLUMN "given_name" text;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "middle_name" text;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "family_name" text;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "preferred_name" text;--> statement-breakpoint
-- ISO 3166-1 alpha-2. Text and not a foreign key to countries: a nationality is
-- a fact about a person that must be recordable before anybody has loaded the
-- country table, and a hard reference would make identity intake depend on
-- reference data having been imported first.
ALTER TABLE "persons" ADD COLUMN "nationality" text;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "preferred_language" text;--> statement-breakpoint
ALTER TABLE "persons" ADD COLUMN "residence_area_id" integer REFERENCES "admin_areas"("id");--> statement-breakpoint
CREATE INDEX "persons_residence_idx" ON "persons" ("residence_area_id");--> statement-breakpoint
-- Duplicate detection reads this. A normalised, order-independent form of the
-- name, written by the identity service; indexed so the matcher is a lookup
-- rather than a scan of a national register.
ALTER TABLE "persons" ADD COLUMN "match_key" text;--> statement-breakpoint
CREATE INDEX "persons_match_key_idx" ON "persons" ("match_key");
