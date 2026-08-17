// The Shotokan technical knowledge library — provenance, movement-level kata,
// bunkai, sport-kumite rules, terminology and the media↔technique graph.
//
// WHY THIS FILE EXISTS SEPARATELY FROM technical.schema.ts. That file is the
// federation's GRADING AUTHORITY: syllabus versions, grade definitions,
// examinations, certificates. What is examined, by whom, under which syllabus.
// It deliberately ships no content, because inventing a syllabus is fraud.
//
// This file is the LIBRARY: what is known about Shotokan technique, where that
// knowledge came from, and whether MMAKF has endorsed it. The two must not be
// merged. A movement-level description of Heian Nidan taken from a published
// reference is useful teaching material; it is not, by virtue of being in the
// database, an MMAKF grading requirement. Keeping the library in its own tables
// means nothing here can be mistaken for the syllabus.
//
// THREE INDEPENDENT AXES, and the whole design turns on their independence:
//
//   CLASSIFICATION — what is this about? (kata? which kata? which movement?)
//   RIGHTS         — may MMAKF host, embed or merely link to it?
//   ENDORSEMENT    — has a named MMAKF reviewer approved it as instruction?
//
// A video can be perfectly classified, entirely correct, and still not ours to
// publish. A source can be rights-cleared and technically wrong. Collapsing any
// two of these into one column is how a federation ends up either committing
// copyright infringement or presenting a stranger's interpretation as doctrine.
//
// WHAT AI MAY AND MAY NOT DO. Classification may be proposed by a model — that
// is what `proposedBy` and `confidence` are for. Endorsement may not. Every
// approval column is a nullable reference to a PERSON, and the CHECK constraints
// in the migration refuse an approved row that names no approver. The database,
// not a code path somebody can forget, is what makes "AI cannot declare MMAKF
// approval" true.
//
// UNVERIFIED IS A FIRST-CLASS STATE. Movement counts, embusen and per-movement
// detail are populated only where a real source documents them, and the source
// is recorded alongside. Where research did not establish a fact, the column
// stays null and `verification` stays 'unverified'. An empty field is honest; a
// plausible number nobody can trace is not.

import {
  pgTable, serial, text, integer, timestamp, date, boolean,
  uniqueIndex, index, pgEnum,
} from 'drizzle-orm/pg-core';
import { persons } from './schema';
import { kata, techniques, kumiteForms } from './technical.schema';
import { mediaAssets } from './education.schema';

// ─── Enums ──────────────────────────────────────────────────────────────────

/**
 * Source authority tiers, as set by the technical directive.
 *
 * The tier describes WHERE something came from, never whether it is right.
 * A Tier B reference can still be rejected by the technical committee, and a
 * Tier E discovery can still be excellent — it simply cannot become federation
 * instruction on its own authority.
 */
export const sourceTier = pgEnum('source_tier', [
  'mmakf_official',        // Tier A — MMAKF's own production and instructors
  'primary_reference',     // Tier B — JKA, recognised Shotokan technical bodies
  'competition_authority', // Tier C — WKF, Olympic and national competition bodies
  'educational',           // Tier D — established instructors and teaching channels
  'discovery',             // Tier E — found, not yet trusted; never authoritative alone
]);

/**
 * How well established a stored fact is.
 *
 * 'source_documented' means a named source states it and the citation is on
 * file. 'committee_verified' means an MMAKF technical reviewer has checked it.
 * 'disputed' means two credible sources disagree and the record says so rather
 * than silently picking a winner.
 */
export const technicalVerification = pgEnum('verification_status', [
  'unverified', 'source_documented', 'committee_verified', 'disputed',
]);

/**
 * Whose interpretation an application represents.
 *
 * Bunkai is where federations most often blur authorship. A traditional reading,
 * a particular instructor's reading, and an MMAKF-endorsed reading are three
 * different claims, and a learner is entitled to know which one they are being
 * shown.
 */
export const interpretationKind = pgEnum('interpretation_kind', [
  'traditional',    // long-established reading, attributable to the tradition
  'instructor',     // a named instructor's interpretation, presented as theirs
  'mmakf_approved', // endorsed by MMAKF technical review — requires an approver
  'historical',     // of documentary interest; not taught as current practice
  'self_defence',   // civilian application framing
]);

/** The admin review pipeline, shared by every library subject. */
export const libraryReviewState = pgEnum('library_review_state', [
  'new', 'classified', 'rights_review', 'technical_review',
  'approved', 'published', 'rejected', 'archived',
]);

/** What a record, video or term is about. */
export const technicalDomain = pgEnum('technical_domain', [
  'kihon', 'kata', 'kumite', 'bunkai', 'self_defence', 'competition',
  'conditioning', 'lecture', 'seminar', 'philosophy', 'history', 'other',
]);

/** Who proposed a classification — kept so a model's guess never looks human. */
export const proposedBy = pgEnum('proposed_by', ['ai', 'human', 'import']);

// ─── Source registry ────────────────────────────────────────────────────────

/**
 * An organisation, channel, publication or document MMAKF has assessed.
 *
 * The registry exists so a trusted source is evaluated ONCE. Without it every
 * new video from the same channel restarts the same argument about whether the
 * channel is credible and what its licensing allows.
 *
 * `rightsPolicy` is the source's general position in words, and it is context,
 * not a verdict: an individual video on an otherwise permissive channel can
 * still be restricted, so media rights stay a per-asset decision on
 * `media_assets.rights`.
 */
export const technicalSources = pgTable('technical_sources', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  organisation: text('organisation').notNull(),
  sourceType: text('source_type').notNull(),      // organisation | channel | publication | document | person
  authorityTier: sourceTier('authority_tier').notNull(),
  websiteUrl: text('website_url'),
  channelUrl: text('channel_url'),
  // Links to an authorised media channel where one exists, so the ingestion
  // pipeline and the source registry describe the same thing rather than
  // drifting apart. Deliberately not a foreign key: a source may be assessed
  // long before anybody authorises its channel for sync.
  mediaChannelId: integer('media_channel_id'),
  style: text('style'),                           // shotokan | mixed | sport | n/a
  language: text('language'),
  rightsPolicy: text('rights_policy'),
  active: boolean('active').notNull().default(true),
  lastReviewedOn: date('last_reviewed_on'),
  reviewedByPersonId: integer('reviewed_by_person_id').references(() => persons.id),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugIdx: uniqueIndex('technical_sources_slug_uk').on(t.slug),
  tierIdx: index('technical_sources_tier_idx').on(t.authorityTier, t.active),
}));

/**
 * Provenance for a single content record. One row per (record, source).
 *
 * The directive requires every content record to carry provenance. Repeating
 * fifteen provenance columns on a dozen tables would guarantee they drift, so
 * provenance is a table and the subject is named polymorphically. A record with
 * no citation is, by construction, unsourced — and the admin queue can find
 * every such record with one query.
 *
 * `quote` holds the specific wording relied upon. When a later reviewer asks
 * "where does it say that?", the answer is in the row rather than in somebody's
 * memory of a PDF.
 */
export const technicalCitations = pgTable('technical_citations', {
  id: serial('id').primaryKey(),
  subjectKind: text('subject_kind').notNull(),    // kata | kata_movement | kata_application | technique | ...
  subjectId: integer('subject_id').notNull(),
  sourceId: integer('source_id').references(() => technicalSources.id),
  sourceUrl: text('source_url'),
  sourceTitle: text('source_title'),
  sourceAuthor: text('source_author'),
  sourceOrganisation: text('source_organisation'),
  sourceType: text('source_type'),
  publicationDate: date('publication_date'),
  retrievedOn: date('retrieved_on'),
  quote: text('quote'),
  page: text('page'),
  domain: technicalDomain('domain'),
  language: text('language'),
  verification: technicalVerification('verification').notNull().default('source_documented'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  subjectIdx: index('technical_citations_subject_idx').on(t.subjectKind, t.subjectId),
  sourceIdx: index('technical_citations_source_idx').on(t.sourceId),
}));

// ─── Movement-level kata ────────────────────────────────────────────────────

/**
 * One counted movement of a kata.
 *
 * The existing `kata.sequence` jsonb column can hold an ordered list, and that
 * is exactly the shape the directive rules out: a blob cannot be joined to a
 * technique, cited to a source, linked to a video segment, or queried for
 * "every kata in which gyaku-zuki appears". This table can.
 *
 * EVERY DESCRIPTIVE COLUMN IS NULLABLE, deliberately. A movement whose stance
 * is documented but whose breathing is not stores the stance and leaves
 * breathing null. Nothing here forces a researcher to fill a field by guessing.
 *
 * `countLabel` exists because kata counting is not always 1:1 with movements:
 * a single count can carry two actions, and different reference texts split
 * them differently. `ordinal` is our stable ordering; `countLabel` is what a
 * source actually calls it ("3", "3a", "5-6").
 */
export const kataMovements = pgTable('kata_movements', {
  id: serial('id').primaryKey(),
  kataId: integer('kata_id').notNull().references(() => kata.id),
  ordinal: integer('ordinal').notNull(),
  countLabel: text('count_label'),

  directionLabel: text('direction_label'),        // "north", "45 degrees left", "along the embusen"
  directionDegrees: integer('direction_degrees'),
  turnDegrees: integer('turn_degrees'),
  embusenPoint: text('embusen_point'),

  stanceTechniqueId: integer('stance_technique_id').references(() => techniques.id),
  stanceLabel: text('stance_label'),              // free text where no catalogue row exists yet
  techniqueId: integer('technique_id').references(() => techniques.id),
  techniqueLabel: text('technique_label'),

  side: text('side'),                             // left | right | both
  limb: text('limb'),                             // hand | leg | both
  target: text('target'),
  height: text('height'),                         // jodan | chudan | gedan

  transition: text('transition'),
  breathing: text('breathing'),
  timing: text('timing'),
  rhythm: text('rhythm'),
  kime: text('kime'),
  hikite: text('hikite'),
  bodyMechanics: text('body_mechanics'),
  kiai: boolean('kiai').notNull().default(false),

  commonErrors: text('common_errors'),
  teachingNote: text('teaching_note'),

  verification: technicalVerification('verification').notNull().default('unverified'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kataOrdinalIdx: uniqueIndex('kata_movements_kata_ordinal_uk').on(t.kataId, t.ordinal),
  techniqueIdx: index('kata_movements_technique_idx').on(t.techniqueId),
  stanceIdx: index('kata_movements_stance_idx').on(t.stanceTechniqueId),
}));

// ─── Bunkai / application ───────────────────────────────────────────────────

/**
 * An application of a kata movement, or of a short run of movements.
 *
 * `kind` carries the claim about authorship, and it is the field that keeps the
 * federation honest. The migration adds a CHECK: a row may only be
 * 'mmakf_approved' if it names an approving person and an approval date.
 * Without that constraint, "MMAKF approved" is a string anybody — or any
 * classifier — can write.
 *
 * `movementFrom`/`movementTo` are ordinals rather than foreign keys because an
 * application often spans a run of movements, and because an application can be
 * documented for a kata whose movement rows are not yet researched.
 */
export const kataApplications = pgTable('kata_applications', {
  id: serial('id').primaryKey(),
  kataId: integer('kata_id').notNull().references(() => kata.id),
  movementFrom: integer('movement_from'),
  movementTo: integer('movement_to'),

  title: text('title').notNull(),
  kind: interpretationKind('kind').notNull(),
  scenario: text('scenario'),
  attackerRole: text('attacker_role'),
  defenderRole: text('defender_role'),
  attack: text('attack'),
  defence: text('defence'),
  counter: text('counter'),
  control: text('control'),

  principle: text('principle'),
  distance: text('distance'),                     // maai
  timing: text('timing'),
  level: text('level'),                           // beginner | intermediate | advanced
  safetyNotes: text('safety_notes'),

  attributedTo: text('attributed_to'),            // whose interpretation, when not MMAKF's
  approvedByPersonId: integer('approved_by_person_id').references(() => persons.id),
  approvedOn: date('approved_on'),
  verification: technicalVerification('verification').notNull().default('unverified'),
  published: boolean('published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  kataIdx: index('kata_applications_kata_idx').on(t.kataId, t.movementFrom),
  kindIdx: index('kata_applications_kind_idx').on(t.kind, t.published),
}));

// ─── Sport kumite — deliberately NOT merged with traditional kumite ─────────

/**
 * A competition rules edition, e.g. WKF Kumite Competition Rules.
 *
 * Traditional Shotokan kumite lives in `kumiteForms` and is a TEACHING
 * progression. This is a REGULATORY document with an effective date and a
 * successor. They answer different questions ("how is this practised?" versus
 * "what scores under these rules this season?"), they change on different
 * clocks, and a learner reading one must never be shown the other as the same
 * kind of fact. Two tables is the cheapest way to make that impossible.
 */
export const sportKumiteRulesets = pgTable('sport_kumite_rulesets', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  authority: text('authority').notNull(),         // WKF | national body
  version: text('version'),
  title: text('title').notNull(),
  effectiveFrom: date('effective_from'),
  effectiveTo: date('effective_to'),
  status: text('status').notNull().default('reference'), // reference | in_force | superseded
  documentUrl: text('document_url'),
  sourceId: integer('source_id').references(() => technicalSources.id),
  retrievedOn: date('retrieved_on'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugIdx: uniqueIndex('sport_kumite_rulesets_slug_uk').on(t.slug),
  authorityIdx: index('sport_kumite_rulesets_authority_idx').on(t.authority, t.status),
}));

/**
 * A single provision of a competition ruleset, kept article by article.
 *
 * `sourceQuote` is the rule as published; `summary` is MMAKF's plain-language
 * gloss for learners. Separating them means the gloss can be improved, or
 * translated, without anybody losing track of what the rule actually says.
 */
export const sportKumiteProvisions = pgTable('sport_kumite_provisions', {
  id: serial('id').primaryKey(),
  rulesetId: integer('ruleset_id').notNull().references(() => sportKumiteRulesets.id),
  article: text('article'),                       // "Article 6"
  clause: text('clause'),
  topic: text('topic').notNull(),                 // scoring | prohibited | category | time | penalty | protest
  heading: text('heading'),
  summary: text('summary'),
  sourceQuote: text('source_quote'),
  appliesTo: text('applies_to'),                  // cadet | junior | senior | all
  displayOrder: integer('display_order').notNull().default(0),
  verification: technicalVerification('verification').notNull().default('unverified'),
}, (t) => ({
  rulesetIdx: index('sport_kumite_provisions_ruleset_idx').on(t.rulesetId, t.displayOrder),
  topicIdx: index('sport_kumite_provisions_topic_idx').on(t.topic),
}));

// ─── Terminology, search and translation ────────────────────────────────────

/**
 * A canonical technical term.
 *
 * One concept, one row. "Oi-zuki", "oi tsuki", "oizuki" and "lunge punch" are
 * not four concepts; they are one concept and three ways of reaching it, which
 * is what `technicalTermAliases` is for. Without this, search quality depends on
 * a learner guessing the same romanisation the data entry clerk used.
 */
export const technicalTerms = pgTable('technical_terms', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  kanji: text('kanji'),
  romaji: text('romaji').notNull(),
  english: text('english'),
  domain: technicalDomain('domain').notNull(),
  definition: text('definition'),
  techniqueId: integer('technique_id').references(() => techniques.id),
  kataId: integer('kata_id').references(() => kata.id),
  kumiteFormId: integer('kumite_form_id').references(() => kumiteForms.id),
  verification: technicalVerification('verification').notNull().default('unverified'),
  published: boolean('published').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugIdx: uniqueIndex('technical_terms_slug_uk').on(t.slug),
  romajiIdx: index('technical_terms_romaji_idx').on(t.romaji),
  domainIdx: index('technical_terms_domain_idx').on(t.domain, t.published),
}));

/**
 * An alternative way of writing a term — including known misspellings.
 *
 * Storing misspellings is not sloppiness; it is the difference between a
 * beginner typing "gyaku tsuki" and finding the lesson, or finding nothing and
 * concluding the library is empty.
 */
export const technicalTermAliases = pgTable('technical_term_aliases', {
  id: serial('id').primaryKey(),
  termId: integer('term_id').notNull().references(() => technicalTerms.id),
  alias: text('alias').notNull(),
  kind: text('kind').notNull().default('romanisation'), // romanisation | spelling | misspelling | translation | abbreviation
  language: text('language'),
}, (t) => ({
  aliasIdx: index('technical_term_aliases_alias_idx').on(t.alias),
  termIdx: index('technical_term_aliases_term_idx').on(t.termId),
}));

/**
 * A localised rendering of one field of one record.
 *
 * Translations attach to the canonical entity rather than cloning it. Cloning a
 * kata per language produces five kata that drift apart; this produces one kata
 * with five labels. Japanese technical terminology is NOT translated away — the
 * romaji stays canonical and the translation explains it.
 */
export const technicalTranslations = pgTable('technical_translations', {
  id: serial('id').primaryKey(),
  subjectKind: text('subject_kind').notNull(),
  subjectId: integer('subject_id').notNull(),
  field: text('field').notNull(),                 // title | definition | teaching_note | ...
  language: text('language').notNull(),           // en | hi | as | bn | ta | te | mr
  value: text('value').notNull(),
  translatedByPersonId: integer('translated_by_person_id').references(() => persons.id),
  reviewedByPersonId: integer('reviewed_by_person_id').references(() => persons.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  subjectIdx: uniqueIndex('technical_translations_uk').on(t.subjectKind, t.subjectId, t.field, t.language),
  langIdx: index('technical_translations_lang_idx').on(t.language),
}));

// ─── Media ↔ technique graph ────────────────────────────────────────────────

/**
 * A link from an ingested video to the thing it teaches, optionally timecoded.
 *
 * This is the edge that turns a media library into a knowledge graph: it is why
 * a learner on the gyaku-zuki page can be shown the kihon demonstration, the
 * kata movements where it appears, and the competition example, without anyone
 * hand-curating a playlist.
 *
 * `role` is the instructional view — front, slow, breakdown, bunkai, coach
 * explanation — because one video of a kata is not enough and the directive is
 * explicit about that.
 *
 * `proposedBy`/`confidence` record that a model suggested the link. The link is
 * not shown to learners until `state` reaches 'approved', and the migration's
 * CHECK refuses an approved link with no reviewer.
 */
export const mediaTechnicalLinks = pgTable('media_technical_links', {
  id: serial('id').primaryKey(),
  mediaAssetId: integer('media_asset_id').notNull().references(() => mediaAssets.id),
  subjectKind: text('subject_kind').notNull(),    // kata | kata_movement | technique | kumite_form | kata_application | ruleset
  subjectId: integer('subject_id').notNull(),
  role: text('role').notNull().default('reference'),
  startSeconds: integer('start_seconds'),
  endSeconds: integer('end_seconds'),
  label: text('label'),
  domain: technicalDomain('domain'),
  difficulty: text('difficulty'),
  audience: text('audience'),                     // beginner | coach | examiner | competitor
  proposedBy: proposedBy('proposed_by').notNull().default('human'),
  confidence: integer('confidence'),              // 0-100 when a model proposed it
  state: libraryReviewState('state').notNull().default('new'),
  reviewedByPersonId: integer('reviewed_by_person_id').references(() => persons.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  assetIdx: index('media_technical_links_asset_idx').on(t.mediaAssetId),
  subjectIdx: index('media_technical_links_subject_idx').on(t.subjectKind, t.subjectId, t.state),
  stateIdx: index('media_technical_links_state_idx').on(t.state),
}));

/**
 * A chapter within a video. Stored independently of the link graph because a
 * chapter is a fact about the VIDEO ("hip rotation starts at 15:12"), whereas a
 * link is a fact about the CURRICULUM ("this segment teaches gyaku-zuki").
 */
export const mediaChapters = pgTable('media_chapters', {
  id: serial('id').primaryKey(),
  mediaAssetId: integer('media_asset_id').notNull().references(() => mediaAssets.id),
  ordinal: integer('ordinal').notNull(),
  startSeconds: integer('start_seconds').notNull(),
  endSeconds: integer('end_seconds'),
  title: text('title').notNull(),
  source: text('source').notNull().default('manual'), // manual | description | transcript | ai
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  assetOrdinalIdx: uniqueIndex('media_chapters_asset_ordinal_uk').on(t.mediaAssetId, t.ordinal),
}));

// ─── Review trail ───────────────────────────────────────────────────────────

/**
 * One recorded review decision on one library subject.
 *
 * Append-only by convention: a later decision adds a row rather than editing an
 * earlier one, so "who approved this, when, on what evidence" survives even
 * after the subject is revised. `dimension` is separate from the decision
 * because rights clearance and technical correctness are reviewed by different
 * people with different authority, and a system that cannot tell them apart
 * will eventually let one stand in for the other.
 */
export const technicalReviews = pgTable('technical_reviews', {
  id: serial('id').primaryKey(),
  subjectKind: text('subject_kind').notNull(),
  subjectId: integer('subject_id').notNull(),
  dimension: text('dimension').notNull(),         // classification | rights | technical | curriculum
  fromState: libraryReviewState('from_state'),
  toState: libraryReviewState('to_state').notNull(),
  reviewerPersonId: integer('reviewer_person_id').references(() => persons.id),
  note: text('note'),
  evidenceUrl: text('evidence_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  subjectIdx: index('technical_reviews_subject_idx').on(t.subjectKind, t.subjectId),
  reviewerIdx: index('technical_reviews_reviewer_idx').on(t.reviewerPersonId),
}));

// ─── External reference curricula ───────────────────────────────────────────

/**
 * Another organisation's published curriculum, stored as REFERENCE.
 *
 * The JKA kyu/dan grading guideline is a real, citable document and it is
 * genuinely useful to instructors. It is also not MMAKF's curriculum, and the
 * directive is emphatic that it must not become MMAKF's curriculum by being
 * loaded into the database. Storing it here — not in `syllabusVersions` — makes
 * that structurally true: MMAKF's grading engine reads `gradeRequirements` and
 * has no path to these tables, so a JKA requirement can never be examined as
 * though the federation had adopted it. `adoptedByMmakf` exists so that if the
 * technical committee ever DOES adopt something, that is a recorded decision
 * rather than a silent data migration.
 */
export const referenceCurricula = pgTable('reference_curricula', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull(),
  sourceId: integer('source_id').references(() => technicalSources.id),
  organisation: text('organisation').notNull(),
  title: text('title').notNull(),
  documentUrl: text('document_url'),
  publishedOn: date('published_on'),
  retrievedOn: date('retrieved_on'),
  adoptedByMmakf: boolean('adopted_by_mmakf').notNull().default(false),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ slugIdx: uniqueIndex('reference_curricula_slug_uk').on(t.slug) }));

export const referenceCurriculumItems = pgTable('reference_curriculum_items', {
  id: serial('id').primaryKey(),
  curriculumId: integer('curriculum_id').notNull().references(() => referenceCurricula.id),
  gradeLabel: text('grade_label').notNull(),      // "7 Kyu", "1st Dan" — verbatim from the source
  gradeOrdinal: integer('grade_ordinal'),
  component: text('component').notNull(),         // kihon | kata | kumite
  requirement: text('requirement').notNull(),     // verbatim
  detail: text('detail'),
  displayOrder: integer('display_order').notNull().default(0),
}, (t) => ({
  curriculumIdx: index('reference_curriculum_items_curriculum_idx').on(t.curriculumId, t.displayOrder),
  gradeIdx: index('reference_curriculum_items_grade_idx').on(t.curriculumId, t.gradeLabel),
}));

/**
 * "This technique appears in this kata", where the movement number is unknown.
 *
 * A WEAKER CLAIM THAN kata_movements, DELIBERATELY. `kataMovements` says
 * "movement 17 of Heian Nidan is a chudan gyaku-zuki in zenkutsu-dachi" and
 * requires a source that counted. This says only "gyaku-zuki appears in Heian
 * Nidan", which the repository's Shotokan corpus records for every technique and
 * which is enough to answer the question the knowledge graph exists for.
 *
 * Keeping the two apart is what stops the weaker claim from being read as the
 * stronger one. `kata_movements.ordinal` is NOT NULL; putting an appearance
 * there would mean inventing a count, and an invented count is indistinguishable
 * from a researched one the moment it is stored.
 */
export const techniqueKataAppearances = pgTable('technique_kata_appearances', {
  id: serial('id').primaryKey(),
  techniqueId: integer('technique_id').notNull().references(() => techniques.id),
  kataId: integer('kata_id').notNull().references(() => kata.id),
  movementOrdinal: integer('movement_ordinal'),
  note: text('note'),
  verification: technicalVerification('verification').notNull().default('unverified'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pairIdx: uniqueIndex('technique_kata_appearances_uk').on(t.techniqueId, t.kataId),
  kataIdx: index('technique_kata_appearances_kata_idx').on(t.kataId),
}));
