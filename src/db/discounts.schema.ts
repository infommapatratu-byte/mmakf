// Discount and concession policy — the schema.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SEPARATION THIS FILE EXISTS TO HOLD
// ─────────────────────────────────────────────────────────────────────────────
//
// A DISCOUNT is commercial. Volume, early registration, renewal, a campaign.
// It is offered to a market, redeemed with a code, counted against a cap, and
// reported on. Nothing about it is private, and the interesting questions are
// "how many redeemed it" and "what did it cost us".
//
// A CONCESSION is a decision about one person's circumstances. A student rate,
// a hardship award, a sibling reduction. It is applied for rather than
// redeemed, it carries a statement somebody wrote about their own life, it is
// decided by a named officer against a named policy, and it must NEVER appear
// in a marketing report.
//
// One table with a `reason` column would model both, and would be wrong. They
// need different approval authority — 'quote:approve' against
// 'concession:decide' in src/lib/rbac.ts — and different audit sensitivity, and
// the day they share a table is the day a campaign report groups by reason and
// a family's hardship case is in the output.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE PROPERTY EVERY TABLE HERE SERVES
// ─────────────────────────────────────────────────────────────────────────────
//
// A CLIENT MAY SUPPLY A CODE. A CLIENT MAY NEVER SUPPLY AN AMOUNT.
//
// Which is why there is no column anywhere below that a request body could fill
// with a number. The token is `discount_codes.code`; everything that decides how
// much it is worth — the basis, the percentage, the cap, the eligibility, the
// usage limit — lives in rows only a `feeframework:write` holder can write. The
// server resolves the code and computes the reduction; see resolveDiscountCodes()
// in src/db/discounts.ts, and the forged-amount test in tests/discounts.test.ts.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHAT IS NOT HERE
// ─────────────────────────────────────────────────────────────────────────────
//
// Not one percentage. Not one rupee. Not one code. MMAKF has approved no
// discount policy and no concession policy, so both ship EMPTY — exactly as the
// fee framework does in src/db/engagement.schema.ts, and for exactly the same
// reason. Seeding a "reasonable" 10% student rate would be this project
// inventing the federation's commercial policy on its behalf.

import {
  pgTable, serial, text, integer, boolean, timestamp, date, jsonb, pgEnum,
  index, uniqueIndex, check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { persons, users } from './schema';
import {
  audienceKind, institutions, services, trainingRequests, quoteVersions,
  // The vocabulary of a reduction is declared beside quote_lines, which has to
  // name it. See the note there for why it is not declared in this file.
  reductionBasis, reductionStage,
} from './engagement.schema';

// ─── Vocabulary ─────────────────────────────────────────────────────────────
//
// Every enum below whose name ends in `status` is checked by
// tests/status-dictionary.test.ts against src/lib/status.ts, so each label is
// one the dictionary already defines. A new word here would render as a bare
// grey chip beside statuses that carry a tone and a meaning, and nothing would
// break to say so.

export const discountPolicyStatus = pgEnum('discount_policy_status', [
  'draft', 'published', 'superseded', 'withdrawn',
]);

/**
 * NOTE WHAT IS ABSENT: `exhausted`.
 *
 * Whether a code has run out is derived from `redeemedCount` against
 * `maxRedemptions`. Storing it as a status too creates a second copy of the
 * same fact, and the two disagree the first time a redemption is recorded
 * without the status being updated — at which point a spent code is still
 * `active` and the cap is decorative.
 */
export const discountCodeStatus = pgEnum('discount_code_status', [
  'draft', 'active', 'suspended', 'expired', 'withdrawn',
]);

export const discountApprovalStatus = pgEnum('discount_approval_status', [
  'pending', 'approved', 'rejected', 'withdrawn',
]);

export const concessionPolicyStatus = pgEnum('concession_policy_status', [
  'draft', 'published', 'superseded', 'withdrawn',
]);

export const concessionApplicationStatus = pgEnum('concession_application_status', [
  'draft', 'submitted', 'under_review', 'information_requested',
  'approved', 'rejected', 'withdrawn', 'expired', 'revoked',
]);

// Taxonomies, not lifecycles. None of the names below ends in `status`, which
// is why the dictionary correctly ignores them: a basis is not a state a thing
// is in, and forcing it through a status chip would be the opposite of what
// that dictionary is for.
//
// `reduction_basis`, `reduction_stage` and `reduction_source` belong to this
// family but are declared in src/db/engagement.schema.ts — quote_lines has to
// name them, and that file cannot import this one without a cycle.

export const discountSubjectKind = pgEnum('discount_subject_kind', [
  'institution', 'person', 'audience', 'state_unit', 'district_unit', 'dojo', 'service',
]);

export const discountApprovalAction = pgEnum('discount_approval_action', [
  'publish_policy', 'issue_code', 'apply_to_quote',
]);

export const concessionCategory = pgEnum('concession_category', [
  'student', 'hardship', 'sibling', 'disability', 'service_family', 'bereavement', 'other',
]);

export const concessionDecision = pgEnum('concession_decision', [
  'approved', 'rejected', 'information_requested', 'revoked',
]);

// ─── Commercial discounts ───────────────────────────────────────────────────

/**
 * A versioned, publishable set of commercial discount rules.
 *
 * PUBLISHED IS IMMUTABLE, exactly as a fee framework is. A quotation issued
 * with a 2026 volume discount must still compute to the same figure in 2030,
 * and it cannot if the rule underneath can be edited in place. Changing a
 * discount means publishing a new version.
 */
export const discountPolicies = pgTable('discount_policies', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                  // MMAKF-DISCOUNT-V1
  title: text('title').notNull(),
  version: integer('version').notNull(),
  status: discountPolicyStatus('status').notNull().default('draft'),

  effectiveFrom: date('effective_from'),
  effectiveTo: date('effective_to'),

  currency: text('currency').notNull().default('INR'),
  notes: text('notes'),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedByUserId: integer('published_by_user_id').references(() => users.id),
  supersededById: integer('superseded_by_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('discount_policies_code_uk').on(t.code),
  statusIdx: index('discount_policies_status_idx').on(t.status),
}));

/**
 * The arithmetic of one discount.
 *
 * `amountMinor` is a POSITIVE magnitude — the size of the reduction, not a
 * negative price. Storing it negative reads naturally right up until somebody
 * writes `amount_minor > 0` in a report and silently excludes every discount
 * there is. The sign is applied once, in computeFee(), where the line is built.
 *
 * `percentPpm` is parts-per-million of the running total, matching the fee
 * engine throughout: 100_000 is 10%. A float percentage would reintroduce
 * precisely the rounding src/db/fees.ts exists to avoid, and applyFactor() is
 * the only multiplier in this codebase.
 *
 * `conditions` is matched by matchConditions() from src/db/fees.ts against the
 * same inputs the fee rules see — the same matcher, so a discount cannot
 * quietly acquire a second, looser idea of what "school" means.
 */
export const discountRules = pgTable('discount_rules', {
  id: serial('id').primaryKey(),
  policyId: integer('policy_id').notNull().references(() => discountPolicies.id),
  code: text('code').notNull(),
  label: text('label').notNull(),

  basis: reductionBasis('basis').notNull(),
  stage: reductionStage('stage').notNull().default('before_tax'),

  amountMinor: integer('amount_minor'),
  percentPpm: integer('percent_ppm'),

  /** A ceiling on what a percentage may take off. Nullable means uncapped. */
  maxReductionMinor: integer('max_reduction_minor'),
  /** A floor: the discount does not apply below this running subtotal. */
  minSubtotalMinor: integer('min_subtotal_minor'),

  audience: audienceKind('audience'),
  serviceId: integer('service_id').references(() => services.id),
  conditions: jsonb('conditions').notNull().default(sql`'{}'::jsonb`),

  /**
   * Whether this discount may sit alongside another on the same quotation.
   *
   * Defaults FALSE. Two discounts stacking is a decision somebody should take
   * deliberately; the alternative default lets a school combine a launch offer,
   * a volume band and a renewal rate into a total nobody intended.
   */
  stackable: boolean('stackable').notNull().default(false),

  /** Lower resolves first. Order decides which non-stackable discount wins. */
  priority: integer('priority').notNull().default(100),

  requiresApproval: boolean('requires_approval').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('discount_rules_code_uk').on(t.policyId, t.code),
  policyIdx: index('discount_rules_policy_idx').on(t.policyId, t.priority),
  // A rule is one basis or the other, never both and never neither. In the
  // database as well as in the code, because a rule with no amount and no
  // percentage prices nothing while looking configured.
  basisCk: check('discount_rules_basis_ck', sql`
		(${t.basis} = 'fixed_amount' AND ${t.amountMinor} IS NOT NULL AND ${t.percentPpm} IS NULL)
		OR (${t.basis} = 'percentage' AND ${t.percentPpm} IS NOT NULL AND ${t.amountMinor} IS NULL)
	`),
  amountCk: check('discount_rules_amount_ck', sql`${t.amountMinor} IS NULL OR ${t.amountMinor} > 0`),
  // Above 1_000_000 ppm a "discount" exceeds the whole amount, which is not a
  // discount but a payment to the customer.
  percentCk: check('discount_rules_percent_ck', sql`${t.percentPpm} IS NULL OR (${t.percentPpm} > 0 AND ${t.percentPpm} <= 1000000)`),
  capCk: check('discount_rules_cap_ck', sql`${t.maxReductionMinor} IS NULL OR ${t.maxReductionMinor} > 0`),
}));

/**
 * The token a client may supply.
 *
 * SEPARATE FROM THE RULE IT GRANTS, so one commercial rule can be issued to
 * three campaigns with three caps and three expiry dates, and one campaign can
 * be suspended without touching the other two or the rule they share.
 *
 * `code` is stored NORMALISED (trimmed, upper case). The unique index is on the
 * stored form, so SCHOOL26 and school26 cannot both exist and then behave
 * differently depending on which one somebody typed into a form.
 */
export const discountCodes = pgTable('discount_codes', {
  id: serial('id').primaryKey(),
  ruleId: integer('rule_id').notNull().references(() => discountRules.id),
  code: text('code').notNull(),
  status: discountCodeStatus('status').notNull().default('draft'),

  validFrom: timestamp('valid_from', { withTimezone: true }),
  validTo: timestamp('valid_to', { withTimezone: true }),

  /** Total redemptions permitted. Null is uncapped, which is a real choice. */
  maxRedemptions: integer('max_redemptions'),
  /** Redemptions permitted per institution or person. Null is uncapped. */
  maxPerSubject: integer('max_per_subject'),
  redeemedCount: integer('redeemed_count').notNull().default(0),

  issuedByUserId: integer('issued_by_user_id').references(() => users.id),
  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('discount_codes_code_uk').on(t.code),
  ruleIdx: index('discount_codes_rule_idx').on(t.ruleId, t.status),
  countCk: check('discount_codes_count_ck', sql`${t.redeemedCount} >= 0`),
  capCk: check('discount_codes_cap_ck', sql`${t.maxRedemptions} IS NULL OR ${t.maxRedemptions} > 0`),
  subjectCapCk: check('discount_codes_subject_cap_ck', sql`${t.maxPerSubject} IS NULL OR ${t.maxPerSubject} > 0`),
}));

/**
 * Who a code is for.
 *
 * NO ROWS MEANS NO RESTRICTION BEYOND THE CODE ITSELF — the honest reading of a
 * marketing code, where the code is the gate. Any row present narrows it, and
 * the subject must then match at least one of them.
 *
 * `subjectId` names a row (an institution, a person, a unit, a service);
 * `subjectValue` names a label (an audience). Exactly one is set, enforced by a
 * CHECK, because a row naming neither matches nothing and a row naming both is
 * ambiguous — and both present to an operator as "the code does not work".
 */
export const discountEligibility = pgTable('discount_eligibility', {
  id: serial('id').primaryKey(),
  codeId: integer('code_id').notNull().references(() => discountCodes.id),
  subjectKind: discountSubjectKind('subject_kind').notNull(),
  subjectId: integer('subject_id'),
  subjectValue: text('subject_value'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: index('discount_eligibility_code_idx').on(t.codeId, t.subjectKind),
  subjectCk: check('discount_eligibility_subject_ck', sql`
		(${t.subjectId} IS NOT NULL AND ${t.subjectValue} IS NULL)
		OR (${t.subjectId} IS NULL AND ${t.subjectValue} IS NOT NULL)
	`),
}));

/**
 * A redemption that actually happened.
 *
 * Not folded into the counter on discount_codes, although the counter is kept
 * there too for the cap check. A counter cannot answer "who used it", cannot
 * enforce a per-subject cap, and cannot be made idempotent: a retried request
 * that increments it twice has overcounted a campaign with no way to find the
 * duplicate. The partial unique index below is what makes recording a
 * redemption safe to repeat.
 */
export const discountRedemptions = pgTable('discount_redemptions', {
  id: serial('id').primaryKey(),
  codeId: integer('code_id').notNull().references(() => discountCodes.id),
  quoteVersionId: integer('quote_version_id').references(() => quoteVersions.id),
  institutionId: integer('institution_id').references(() => institutions.id),
  personId: integer('person_id').references(() => persons.id),
  /** The reduction actually granted, as a POSITIVE magnitude in paise. */
  amountMinor: integer('amount_minor').notNull(),
  recordedByUserId: integer('recorded_by_user_id'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  quoteUk: uniqueIndex('discount_redemptions_quote_uk')
    .on(t.codeId, t.quoteVersionId)
    .where(sql`quote_version_id is not null`),
  codeIdx: index('discount_redemptions_code_idx').on(t.codeId, t.at),
  subjectIdx: index('discount_redemptions_subject_idx').on(t.institutionId, t.personId),
  amountCk: check('discount_redemptions_amount_ck', sql`${t.amountMinor} >= 0`),
}));

/**
 * The second pair of eyes, recorded.
 *
 * `decidedByUserId <> requestedByUserId` is a database CHECK, not only an
 * application rule, because the entire value of an approval is that it was
 * somebody else. A row asserting that a person approved their own discount is
 * not a weaker approval — it is a false record, and the database should refuse
 * to hold one.
 */
export const discountApprovals = pgTable('discount_approvals', {
  id: serial('id').primaryKey(),
  policyId: integer('policy_id').notNull().references(() => discountPolicies.id),
  ruleId: integer('rule_id').references(() => discountRules.id),
  codeId: integer('code_id').references(() => discountCodes.id),
  quoteVersionId: integer('quote_version_id').references(() => quoteVersions.id),

  action: discountApprovalAction('action').notNull(),
  status: discountApprovalStatus('status').notNull().default('pending'),

  requestedByUserId: integer('requested_by_user_id'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  reason: text('reason'),

  decidedByUserId: integer('decided_by_user_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
}, (t) => ({
  policyIdx: index('discount_approvals_policy_idx').on(t.policyId, t.status),
  pendingIdx: index('discount_approvals_pending_idx').on(t.status, t.requestedAt),
  selfCk: check('discount_approvals_self_ck', sql`
		${t.decidedByUserId} IS NULL
		OR ${t.requestedByUserId} IS NULL
		OR ${t.decidedByUserId} <> ${t.requestedByUserId}
	`),
}));

// ─── Concessions ────────────────────────────────────────────────────────────
//
// Everything below this line is about a person's circumstances. It is a
// separate model with separate authority, and it is joined to nothing above.

/**
 * A concession the federation offers, with its own arithmetic.
 *
 * NOT a discount rule with a flag. A concession has no code, no usage cap, no
 * campaign and no market; it has a category, an evidence requirement and a
 * confidentiality flag, none of which a commercial rule has. Sharing one table
 * would leave every concession column null on every marketing rule and every
 * marketing column null here — and would put a hardship policy one WHERE clause
 * away from a campaign report.
 *
 * `confidential` defaults TRUE. A concession is private unless the federation
 * decides a particular one is not, rather than public unless somebody remembers
 * to tick a box.
 */
export const concessionPolicies = pgTable('concession_policies', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                  // MMAKF-CONCESSION-V1
  title: text('title').notNull(),
  version: integer('version').notNull(),
  status: concessionPolicyStatus('status').notNull().default('draft'),
  category: concessionCategory('category').notNull(),

  basis: reductionBasis('basis').notNull(),
  stage: reductionStage('stage').notNull().default('before_tax'),
  amountMinor: integer('amount_minor'),
  percentPpm: integer('percent_ppm'),
  maxReductionMinor: integer('max_reduction_minor'),

  requiresEvidence: boolean('requires_evidence').notNull().default(true),
  evidenceGuidance: text('evidence_guidance'),
  confidential: boolean('confidential').notNull().default(true),
  maxAwards: integer('max_awards'),

  effectiveFrom: date('effective_from'),
  effectiveTo: date('effective_to'),
  currency: text('currency').notNull().default('INR'),
  notes: text('notes'),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedByUserId: integer('published_by_user_id').references(() => users.id),
  supersededById: integer('superseded_by_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('concession_policies_code_uk').on(t.code),
  statusIdx: index('concession_policies_status_idx').on(t.status, t.category),
  basisCk: check('concession_policies_basis_ck', sql`
		(${t.basis} = 'fixed_amount' AND ${t.amountMinor} IS NOT NULL AND ${t.percentPpm} IS NULL)
		OR (${t.basis} = 'percentage' AND ${t.percentPpm} IS NOT NULL AND ${t.amountMinor} IS NULL)
	`),
  amountCk: check('concession_policies_amount_ck', sql`${t.amountMinor} IS NULL OR ${t.amountMinor} > 0`),
  percentCk: check('concession_policies_percent_ck', sql`${t.percentPpm} IS NULL OR (${t.percentPpm} > 0 AND ${t.percentPpm} <= 1000000)`),
  capCk: check('concession_policies_cap_ck', sql`${t.maxReductionMinor} IS NULL OR ${t.maxReductionMinor} > 0`),
}));

/**
 * One person asking for one concession.
 *
 * `statedCircumstance` is the most sensitive column this wave adds: it is where
 * somebody writes that they cannot afford the fee. `evidenceRef` is a REFERENCE
 * to a document held elsewhere and never the document — a hardship letter does
 * not belong in a row that a reporting query might one day widen onto.
 *
 * THE AWARD IS FROZEN onto the application when it is decided. A concession
 * granted under the 2026 policy keeps its 2026 terms after that policy is
 * superseded, for exactly the reason a quote version keeps its framework: the
 * family was told a figure and the federation has to stand behind it.
 */
export const concessionApplications = pgTable('concession_applications', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                    // MMAKF-CON-2026-000001
  policyId: integer('policy_id').notNull().references(() => concessionPolicies.id),
  personId: integer('person_id').references(() => persons.id),
  institutionId: integer('institution_id').references(() => institutions.id),
  requestId: integer('request_id').references(() => trainingRequests.id),

  status: concessionApplicationStatus('status').notNull().default('draft'),

  statedCircumstance: text('stated_circumstance'),
  evidenceRef: text('evidence_ref'),

  submittedByUserId: integer('submitted_by_user_id').references(() => users.id),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),

  validFrom: date('valid_from'),
  validTo: date('valid_to'),

  awardedBasis: reductionBasis('awarded_basis'),
  awardedAmountMinor: integer('awarded_amount_minor'),
  awardedPercentPpm: integer('awarded_percent_ppm'),
  awardedMaxReductionMinor: integer('awarded_max_reduction_minor'),
  awardedStage: reductionStage('awarded_stage'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),

  confidential: boolean('confidential').notNull().default(true),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('concession_applications_ref_uk').on(t.ref),
  statusIdx: index('concession_applications_status_idx').on(t.status, t.createdAt),
  personIdx: index('concession_applications_person_idx').on(t.personId),
  awardCk: check('concession_applications_award_ck', sql`
		${t.awardedBasis} IS NULL
		OR (${t.awardedBasis} = 'fixed_amount' AND ${t.awardedAmountMinor} IS NOT NULL AND ${t.awardedPercentPpm} IS NULL)
		OR (${t.awardedBasis} = 'percentage' AND ${t.awardedPercentPpm} IS NOT NULL AND ${t.awardedAmountMinor} IS NULL)
	`),
  amountCk: check('concession_applications_amount_ck', sql`${t.awardedAmountMinor} IS NULL OR ${t.awardedAmountMinor} > 0`),
  percentCk: check('concession_applications_percent_ck', sql`${t.awardedPercentPpm} IS NULL OR (${t.awardedPercentPpm} > 0 AND ${t.awardedPercentPpm} <= 1000000)`),
}));

/**
 * The decision log. APPEND-ONLY, as rank_records is.
 *
 * A concession that was granted and later revoked is TWO ROWS, not one row
 * edited — because "was this ever awarded, and on what basis?" is a question
 * somebody asks after it has been withdrawn, and an edited row cannot answer it.
 *
 * `reason` is NOT NULL. A refusal nobody can explain to the applicant is worse
 * than having no process at all.
 */
export const concessionApprovals = pgTable('concession_approvals', {
  id: serial('id').primaryKey(),
  applicationId: integer('application_id').notNull().references(() => concessionApplications.id),
  decision: concessionDecision('decision').notNull(),
  decidedByUserId: integer('decided_by_user_id').notNull().references(() => users.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
  reason: text('reason').notNull(),
  authority: text('authority'),
}, (t) => ({
  applicationIdx: index('concession_approvals_application_idx').on(t.applicationId, t.decidedAt),
}));
