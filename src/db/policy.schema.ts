// The regulatory engine — source material, instruments, rules and determinations.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS EXISTS TO PREVENT
// ═══════════════════════════════════════════════════════════════════════════
//
// A federation acquires its first rules by copying them from somewhere. Karate
// Academy Bharat publishes a dojo code, a grade ladder, a fee schedule and an
// instructor assessment weighted 40/40/20. Every one of those is useful, and
// NOT ONE OF THEM IS AN MMAKF REGULATION until MMAKF's governing body adopts it.
//
// The failure this schema is built against is not dramatic. It is a paste. An
// administrator moves a paragraph from an academy page into a federation screen
// and, six months later, nobody in the organisation can say whether the rule a
// member was refused under was ever approved, by whom, or on what date it took
// effect. The paragraph reads identically either way.
//
// So provenance is a COLUMN, not a convention:
//
//   · `policy_layer` distinguishes academy_source / mmakf_regulation /
//     external_reference. A query that renders academy material on a federation
//     surface has to ask for it by name. Omission fails closed.
//
//   · A source provision reaches an instrument ONLY through `policy_provisions`,
//     which records the approver, the approval date and the instrument version
//     that carried it. There is no other route: `source_provisions` has no
//     `published` flag and no effective date, because a source excerpt is
//     evidence and evidence never becomes binding by sitting still.
//
//   · A rule cannot be EVALUATED before it is approved. `policy_rule_versions`
//     carries a state and an effective window, and src/db/policy.ts refuses to
//     produce an eligibility answer from a version that has not reached
//     `approved`. A half-built policy fails visibly instead of quietly deciding.
//
// ═══════════════════════════════════════════════════════════════════════════
// HISTORY IS ANSWERED BY DATE, NEVER BY STATUS
// ═══════════════════════════════════════════════════════════════════════════
//
// The same discipline governance.schema.ts applies to office holders applies
// here, for the same reason. "What rule applied to this person?" is a question
// about a date in the past. A status column only knows what is true now.
//
// Rule resolution is therefore `effective_from <= on AND (effective_to IS NULL
// OR on < effective_to)`, half-open at the top so that the day a version ends is
// the day its successor begins with no gap and no overlap. Superseded versions
// are never deleted, and `policy_determinations` freezes the rule VERSION id
// that decided each case — so amending a rule in 2027 cannot retroactively
// change what a 2026 refusal was based on.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY RULES ARE DATA AND NOT CODE
// ═══════════════════════════════════════════════════════════════════════════
//
// `minimum_grade = 4th Kyu` written into an Astro page is a federation
// regulation with no approver, no effective date, no version and no audit — and
// it changes when somebody edits a component. Conditions and actions are JSON on
// a versioned row precisely so that changing a rule is a governance act with a
// name attached to it, and so that a past decision can be replayed against the
// text that actually applied at the time.
//
// See docs/governance/KARATE-ACADEMY-SOURCE-REGISTER.md for the material this
// schema was designed around, and MMAKF-REGULATORY-GAP-ANALYSIS.md for what the
// source does NOT contain.

import {
  pgTable, serial, text, integer, timestamp, date, boolean,
  uniqueIndex, index, jsonb, pgEnum,
} from 'drizzle-orm/pg-core';
import { persons } from './schema';
import { committees, resolutions, dataClass } from './governance.schema';

// ─── Enums ──────────────────────────────────────────────────────────────────

/**
 * Whose rule it is. THE most important column in this file.
 *
 * Three values and no fourth, because a rule with mixed provenance is a rule
 * nobody can defend. An academy rule that MMAKF adopts does not change layer —
 * the SOURCE provision stays `academy_source` for ever, and a NEW provision at
 * `mmakf_regulation` is created that cites it. Both rows survive, and the
 * question "did MMAKF write this or inherit it?" stays answerable.
 */
export const policyLayer = pgEnum('policy_layer', [
  'academy_source',
  'mmakf_regulation',
  'external_reference',
]);

/** What kind of thing the source material is. */
export const policySourceKind = pgEnum('policy_source_kind', [
  'web_page', 'pdf', 'form', 'circular', 'email', 'meeting_minute',
  'statute', 'rulebook', 'other',
]);

/**
 * How faithfully the extraction reproduces the source.
 *
 * `absent` is a value, not a missing row: "we retrieved this page and it says
 * nothing about safeguarding" is a FINDING, and recording it is what stops a
 * later reader mistaking an unchecked topic for a checked-and-empty one.
 */
export const policySourceConfidence = pgEnum('policy_source_confidence', [
  'verbatim', 'verbatim_partial', 'paraphrased', 'inferred', 'absent',
]);

/**
 * What MMAKF has done about a source provision.
 *
 * `flagged_not_adoptable` exists because some published academy material must be
 * recorded and must never be adopted — the four regulative principles addressed
 * to parents (KAB-003) being the case that forced the value. Deleting it would
 * falsify the register; leaving it at `not_adopted` would understate the
 * finding. A flag with a reason is the honest state.
 */
export const policyAdoptionStatus = pgEnum('policy_adoption_status', [
  'not_adopted', 'under_review', 'cited', 'adopted', 'rejected',
  'flagged_not_adoptable',
]);

export const policyInstrumentType = pgEnum('policy_instrument_type', [
  'constitution', 'regulation', 'policy', 'code', 'guideline', 'circular',
  'framework', 'standard',
]);

/**
 * The lifecycle of an instrument version, and of a rule version.
 *
 * `approved` and `published` and `effective` are three different facts and are
 * deliberately not collapsed. A version can be approved on 1 March, published on
 * 10 March and take effect on 1 April; a member refused on 20 March was refused
 * under the PREVIOUS version, and only separate states make that provable.
 */
export const policyState = pgEnum('policy_state', [
  'draft',
  'technical_review',
  'legal_review',
  'governance_review',
  'approved',
  'published',
  'effective',
  'superseded',
  'withdrawn',
  'archived',
]);

/**
 * Where a clause in an MMAKF instrument came from.
 *
 * `proposed` is the value the gap analysis produces: a provision MMAKF needs and
 * no source supports. It is rendered with its own label on every surface, so a
 * reader can never mistake drafting for inheritance.
 */
export const policyDerivation = pgEnum('policy_derivation', [
  'source_derived', 'proposed', 'external_reference', 'statutory',
]);

/**
 * What an evaluation concluded.
 *
 * The refusals are typed and distinct on purpose. `no_rule_in_force` (nobody has
 * approved a rule for this yet) and `ineligible` (a rule exists and the subject
 * fails it) are opposite facts, and a system that returned the same value for
 * both would be reporting an unwritten policy as a refusal.
 */
export const policyOutcome = pgEnum('policy_outcome', [
  'eligible', 'ineligible', 'requires_review',
  'no_rule_in_force', 'not_approved', 'insufficient_facts',
]);

// ─── Layer 1 / Layer 3: source material ─────────────────────────────────────

/**
 * A document that was retrieved, with the evidence of retrieval.
 *
 * `contentSha256` hashes what was actually read. A source page changes without
 * telling anyone; a federation that adopted a rule from it must be able to show
 * WHICH text it adopted, not merely which URL. Without the hash, "the website
 * says X" degrades into an unfalsifiable claim within a year.
 *
 * There is no `layer = 'mmakf_regulation'` row in this table by design. MMAKF's
 * own instruments live in `policy_instruments`; this table is for material the
 * federation did not write.
 */
export const sourceDocuments = pgTable('source_documents', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                    // KAB-DOC-RULES
  layer: policyLayer('layer').notNull(),
  sourceOrg: text('source_org').notNull(),         // "Karate Academy Bharat", "WKF"
  sourceTitle: text('source_title').notNull(),
  sourceUrl: text('source_url').notNull(),
  sourceSection: text('source_section'),
  /** The date the SOURCE gives for itself, where it gives one. Usually null. */
  sourceDate: date('source_date'),
  sourceType: policySourceKind('source_type').notNull().default('web_page'),

  /** When WE read it. Never defaulted to now() by a surface — see policy.ts. */
  retrievedOn: date('retrieved_on').notNull(),
  retrievedByUserId: integer('retrieved_by_user_id'),
  retrievedByLabel: text('retrieved_by_label'),
  /** Of the text actually read, so a later edit at source is detectable. */
  contentSha256: text('content_sha256'),
  /** HTTP status / content type / size, as the fetch reported them. */
  fetchEvidence: text('fetch_evidence'),

  notes: text('notes'),
  classification: dataClass('classification').notNull().default('public'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('source_documents_code_uk').on(t.code),
  layerIdx: index('source_documents_layer_idx').on(t.layer, t.sourceOrg),
}));

/**
 * One extracted rule, with the words it was extracted from beside it.
 *
 * `sourceExcerpt` and `normalizedRule` are BOTH required and are never merged.
 * The excerpt is what the source says; the normalisation is what MMAKF
 * understood it to mean. Keeping only the normalisation loses the ability to
 * check the reading; keeping only the excerpt makes it unusable as a rule.
 *
 * `adoptionStatus` defaults to `not_adopted`, and there is no code path that
 * sets it to `adopted` without an instrument version and an approver — see
 * adoptSourceProvision() in src/db/policy.ts.
 */
export const sourceProvisions = pgTable('source_provisions', {
  id: serial('id').primaryKey(),
  /** Register reference — KAB-001.3. Stable across re-crawls. */
  ref: text('ref').notNull(),
  sourceDocumentId: integer('source_document_id').notNull().references(() => sourceDocuments.id),
  layer: policyLayer('layer').notNull(),

  topic: text('topic').notNull(),                  // discipline | uniform | fees | …
  category: text('category'),                      // finer classification, free text
  sourceExcerpt: text('source_excerpt').notNull(),
  normalizedRule: text('normalized_rule').notNull(),
  confidence: policySourceConfidence('confidence').notNull(),

  adoptionStatus: policyAdoptionStatus('adoption_status').notNull().default('not_adopted'),
  /** Why it was rejected or flagged. Required for those two states in policy.ts. */
  adoptionNote: text('adoption_note'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refIdx: uniqueIndex('source_provisions_ref_uk').on(t.ref),
  documentIdx: index('source_provisions_document_idx').on(t.sourceDocumentId),
  statusIdx: index('source_provisions_status_idx').on(t.adoptionStatus, t.layer),
  topicIdx: index('source_provisions_topic_idx').on(t.topic),
}));

// ─── Layer 2: MMAKF's own instruments ───────────────────────────────────────

/**
 * A regulation, policy, code, guideline or circular that MMAKF issues.
 *
 * Deliberately separate from `official_documents` in governance.schema.ts, which
 * is a REGISTER OF FILES — a constitution PDF with a checksum and an approval.
 * This table is the register of RULES: an instrument here can carry clause-level
 * provisions and machine-evaluable rules, and its versions drive decisions.
 * A federation needs both, and conflating them would mean either that every
 * uploaded PDF pretends to be executable or that every executable rule needs a
 * file to exist.
 */
export const policyInstruments = pgTable('policy_instruments', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                    // MMAKF-REG-GRADING
  title: text('title').notNull(),
  instrumentType: policyInstrumentType('instrument_type').notNull(),
  layer: policyLayer('layer').notNull().default('mmakf_regulation'),

  subjectArea: text('subject_area').notNull(),     // grading | safeguarding | fees | …
  summary: text('summary'),
  /** Where it applies: national, or a named state/district/dojo scope. */
  jurisdiction: text('jurisdiction').notNull().default('national'),
  jurisdictionScopeType: text('jurisdiction_scope_type').notNull().default('national'),
  jurisdictionScopeId: integer('jurisdiction_scope_id'),

  issuer: text('issuer').notNull().default('MMAKF'),
  ownerCommitteeId: integer('owner_committee_id').references(() => committees.id),
  classification: dataClass('classification').notNull().default('public'),

  currentVersionId: integer('current_version_id'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('policy_instruments_code_uk').on(t.code),
  areaIdx: index('policy_instruments_area_idx').on(t.subjectArea, t.instrumentType),
}));

/**
 * One version of an instrument. A published version is NEVER edited.
 *
 * `bodySha256` is taken over the exact text at publication, for the reason
 * documentVersions gives: a document swapped after approval must be DETECTABLE
 * rather than merely deniable.
 *
 * `effectiveTo` is EXCLUSIVE. A version effective 2026-04-01 to 2027-04-01 does
 * not apply on 2027-04-01; its successor does. Half-open ranges are the only
 * arrangement in which "supersede on this date" cannot produce either a
 * one-day gap where no rule exists or a one-day overlap where two do.
 */
export const policyInstrumentVersions = pgTable('policy_instrument_versions', {
  id: serial('id').primaryKey(),
  instrumentId: integer('instrument_id').notNull().references(() => policyInstruments.id),
  version: text('version').notNull(),              // "1.0", "2026-01"
  state: policyState('state').notNull().default('draft'),

  bodyMarkdown: text('body_markdown'),
  fileUrl: text('file_url'),
  bodySha256: text('body_sha256'),

  effectiveFrom: date('effective_from'),
  /** Exclusive upper bound. NULL means "still in force". */
  effectiveTo: date('effective_to'),
  reviewDueOn: date('review_due_on'),

  approvedByCommitteeId: integer('approved_by_committee_id').references(() => committees.id),
  approvedByPersonId: integer('approved_by_person_id').references(() => persons.id),
  approvedOn: date('approved_on'),
  /** The resolution that adopted it — the chain back to a quorate meeting. */
  approvedUnderResolutionId: integer('approved_under_resolution_id').references(() => resolutions.id),
  approvedUnder: text('approved_under'),

  supersedesVersionId: integer('supersedes_version_id'),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
  withdrawnReason: text('withdrawn_reason'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  versionUk: uniqueIndex('policy_instrument_versions_uk').on(t.instrumentId, t.version),
  instrumentIdx: index('policy_instrument_versions_instrument_idx').on(t.instrumentId, t.state),
  effectiveIdx: index('policy_instrument_versions_effective_idx')
    .on(t.instrumentId, t.effectiveFrom, t.effectiveTo),
}));

/**
 * A clause inside a version, and the ONLY route from source material to policy.
 *
 * `sourceProvisionId` is nullable because most federation clauses have no
 * source — the gap analysis lists thirty-four instruments MMAKF must author. But
 * when it IS set, `derivation` must read `source_derived`, and `adoptedByPersonId`
 * and `adoptedOn` must be present: that triple is what makes "MMAKF adopted the
 * academy's 4th Kyu requirement, approved by X on date Y under version Z" a
 * record rather than a recollection.
 */
export const policyProvisions = pgTable('policy_provisions', {
  id: serial('id').primaryKey(),
  instrumentVersionId: integer('instrument_version_id').notNull()
    .references(() => policyInstrumentVersions.id),
  clauseRef: text('clause_ref').notNull(),         // "4.2(a)"
  heading: text('heading'),
  text: text('text').notNull(),
  category: text('category'),

  derivation: policyDerivation('derivation').notNull(),
  /** The source provision this clause was adopted from, where there is one. */
  sourceProvisionId: integer('source_provision_id').references(() => sourceProvisions.id),
  /** For `external_reference`: whose rule it is and where it is published. */
  externalBody: text('external_body'),
  externalCitation: text('external_citation'),

  adoptedByPersonId: integer('adopted_by_person_id').references(() => persons.id),
  adoptedOn: date('adopted_on'),
  adoptionNote: text('adoption_note'),

  ordinal: integer('ordinal').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  clauseUk: uniqueIndex('policy_provisions_clause_uk').on(t.instrumentVersionId, t.clauseRef),
  versionIdx: index('policy_provisions_version_idx').on(t.instrumentVersionId, t.ordinal),
  sourceIdx: index('policy_provisions_source_idx').on(t.sourceProvisionId),
}));

// ─── The rule engine ────────────────────────────────────────────────────────

/**
 * A machine-evaluable rule, owned by an instrument.
 *
 * `instrumentId` is NOT NULL and that is the point: a rule with no instrument is
 * a policy nobody approved, which is exactly the hard-coded condition in a
 * component that this table exists to replace.
 *
 * `subjectKind` names what the rule decides about — `instructor_application`,
 * `grading_entry`, `event_entry` — so a caller asks for "the rules that decide
 * instructor applications" rather than knowing rule codes by heart.
 */
export const policyRules = pgTable('policy_rules', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                    // RULE-INSTRUCTOR-MIN-GRADE
  title: text('title').notNull(),
  instrumentId: integer('instrument_id').notNull().references(() => policyInstruments.id),
  subjectKind: text('subject_kind').notNull(),
  description: text('description'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex('policy_rules_code_uk').on(t.code),
  subjectIdx: index('policy_rules_subject_idx').on(t.subjectKind, t.active),
}));

/**
 * The conditions and the outcome, versioned and dated.
 *
 * `conditions` is an array of `{ fact, op, value }` — a deliberately small
 * language. It is not a scripting engine, and that is a safety property rather
 * than a limitation: a rule that could execute arbitrary logic would be a rule
 * whose behaviour a governance committee cannot read, and an approval given to
 * something unreadable is not an approval.
 *
 * An unmet condition produces `outcomeUnmet` (normally `ineligible`); all
 * conditions met produce `outcomeMet`. Both are explicit because some rules
 * exist to FLAG rather than to refuse — a maturity assessment should reach
 * `requires_review`, never an automatic rejection. The brief's rule stands:
 * nobody is punished on an automatic flag.
 *
 * `instrumentVersionId` binds the rule version to the text that authorises it,
 * so "which clause does this refusal come from" has an answer.
 */
export const policyRuleVersions = pgTable('policy_rule_versions', {
  id: serial('id').primaryKey(),
  ruleId: integer('rule_id').notNull().references(() => policyRules.id),
  version: text('version').notNull(),
  state: policyState('state').notNull().default('draft'),

  instrumentVersionId: integer('instrument_version_id')
    .references(() => policyInstrumentVersions.id),
  provisionId: integer('provision_id').references(() => policyProvisions.id),

  /** [{ fact, op, value, label }] — see evaluate() in src/db/policy.ts. */
  conditions: jsonb('conditions').notNull(),
  outcomeMet: policyOutcome('outcome_met').notNull().default('eligible'),
  outcomeUnmet: policyOutcome('outcome_unmet').notNull().default('ineligible'),
  /** Optional side effects for a workflow: {"require_documents": [...]}. */
  actions: jsonb('actions'),
  /** Sentence shown to the subject when the rule refuses. */
  refusalReason: text('refusal_reason'),

  effectiveFrom: date('effective_from'),
  /** Exclusive, as on instrument versions. */
  effectiveTo: date('effective_to'),

  approvedByCommitteeId: integer('approved_by_committee_id').references(() => committees.id),
  approvedByPersonId: integer('approved_by_person_id').references(() => persons.id),
  approvedOn: date('approved_on'),
  approvedUnderResolutionId: integer('approved_under_resolution_id').references(() => resolutions.id),
  supersedesVersionId: integer('supersedes_version_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  versionUk: uniqueIndex('policy_rule_versions_uk').on(t.ruleId, t.version),
  ruleIdx: index('policy_rule_versions_rule_idx').on(t.ruleId, t.state),
  effectiveIdx: index('policy_rule_versions_effective_idx')
    .on(t.ruleId, t.effectiveFrom, t.effectiveTo),
}));

/**
 * What the engine decided, about whom, under which version, on what facts.
 *
 * This is the table that answers the federation's own definition of done. It is
 * APPEND-ONLY: a determination is never updated, because a decision that can be
 * edited is not a decision anybody can rely on. A changed mind produces a NEW
 * determination that supersedes the old one, and both stay readable.
 *
 * `ruleVersionId` — not `ruleId` — is what is stored. Amending a rule next year
 * must not silently restate what was decided this year, and only pinning the
 * VERSION makes a past decision replayable against the text that produced it.
 *
 * `facts` is the input as it stood at the moment of decision, so a determination
 * can be re-checked without depending on records that have since moved on.
 */
export const policyDeterminations = pgTable('policy_determinations', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                      // DET-2026-000123

  ruleCode: text('rule_code').notNull(),
  ruleVersionId: integer('rule_version_id').references(() => policyRuleVersions.id),
  instrumentVersionId: integer('instrument_version_id')
    .references(() => policyInstrumentVersions.id),

  subjectType: text('subject_type').notNull(),     // person | application | entry | dojo
  subjectId: text('subject_id').notNull(),
  personId: integer('person_id').references(() => persons.id),

  facts: jsonb('facts').notNull(),
  outcome: policyOutcome('outcome').notNull(),
  reason: text('reason').notNull(),
  /** Per-condition results, so a refusal can name which limb failed. */
  detail: jsonb('detail'),

  /** The date the rule was resolved AS OF — not necessarily today. */
  determinedOn: date('determined_on').notNull(),
  determinedAt: timestamp('determined_at', { withTimezone: true }).notNull().defaultNow(),
  actorUserId: integer('actor_user_id'),
  actorLabel: text('actor_label'),

  /**
   * Whether the subject may challenge it.
   *
   * NOT NULL with no default: every determination has to state its appeal
   * position, because "we never said" is how a decision becomes unchallengeable
   * by accident. See MMAKF-REGULATORY-GAP-ANALYSIS.md §2.1 — the Appeals
   * Regulation this points at does not exist yet, and that is recorded rather
   * than papered over.
   */
  appealable: boolean('appealable').notNull(),
  appealCaseId: integer('appeal_case_id'),
  supersededByDeterminationId: integer('superseded_by_determination_id'),

  classification: dataClass('classification').notNull().default('member'),
}, (t) => ({
  refIdx: uniqueIndex('policy_determinations_ref_uk').on(t.ref),
  subjectIdx: index('policy_determinations_subject_idx').on(t.subjectType, t.subjectId),
  personIdx: index('policy_determinations_person_idx').on(t.personId, t.determinedOn),
  ruleIdx: index('policy_determinations_rule_idx').on(t.ruleCode, t.determinedOn),
}));
