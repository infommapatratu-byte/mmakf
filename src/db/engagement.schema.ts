// Training, engagement and the unified fee architecture.
//
// WHAT THIS LAYER EXISTS TO CORRECT.
//
// The public site presented MMAKF as a dojo selling nine independent monthly
// subscriptions — ₹800 for the women's programme, ₹900 for kids, ₹1,000 for
// kata, ₹1,100 for kumite, ₹1,200 for Shotokan, ₹1,500 for the competitive
// track, ₹1,800 for Dan preparation. Each was a number typed into a content
// file. None of them could answer the question a school actually asks: *what
// does it cost to run karate for 400 children across two campuses for a year?*
//
// A national federation does not have nine prices. It has ONE fee framework
// whose output depends on the circumstances of the person or institution
// asking. That is what this schema models.
//
// FIVE RULES SHAPE IT.
//
//  1. NO PRICE IS EVER HARDCODED IN A COMPONENT OR A ROUTE. A fee comes from a
//     rule, in a framework, at a version. If no rule matches, the answer is
//     "this requires a quote" — never a plausible number.
//
//  2. A FRAMEWORK VERSION IS IMMUTABLE ONCE PUBLISHED. Rules are edited by
//     publishing a NEW version. A quote issued in March 2026 must still compute
//     to the same figure in 2030, and it cannot do that if the rules underneath
//     it can be edited in place.
//
//  3. A QUOTE STORES ITS OWN INPUTS. Not a reference to a form that may be
//     edited afterwards — the actual values, frozen. Reproducibility means
//     re-running the same framework version against the same stored inputs and
//     getting the same number, and that is a test, not an aspiration.
//
//  4. EVERY LINE OF A QUOTE SAYS WHICH RULE PRODUCED IT. An administrator asked
//     "why is this ₹4,80,000?" must be able to answer from the record. A total
//     nobody can explain is a total nobody can defend.
//
//  5. MONEY IS INTEGER PAISE. Everywhere, without exception, as it already is
//     in src/db/orders.ts. A rupee expressed as a float is a rounding error
//     waiting for a large enough invoice.
//
// AND ONE THING THIS SCHEMA REFUSES TO DECIDE: what MMAKF actually charges.
// Not one rupee figure appears in this file or in the migration that creates
// it. The framework ships EMPTY, every surface reports "the federation has not
// published a fee for this", and the numbers arrive when MMAKF supplies them.

import {
  pgTable, serial, text, integer, bigint, boolean, timestamp, date, jsonb, pgEnum,
  index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { persons, stateUnits, districtUnits, dojos, users } from './schema';

// ─── Who MMAKF delivers to ──────────────────────────────────────────────────

/**
 * The audiences the federation serves. `individual` sits in the same list as
 * `school` deliberately: personal coaching is a SERVICE MMAKF offers, not the
 * identity of MMAKF, and modelling it as a peer of the institutional audiences
 * is what stops it drifting back to the centre of the site.
 */
export const audienceKind = pgEnum('audience_kind', [
  'individual', 'family', 'school', 'university', 'corporate',
  'government', 'ngo', 'club', 'community', 'other',
]);

export const institutionStatus = pgEnum('institution_status', [
  'prospect', 'qualified', 'contracted', 'active', 'dormant', 'former', 'declined',
]);

/**
 * A school, company, university, department or community body MMAKF trains.
 *
 * SEPARATE FROM `dojos` ON PURPOSE. A dojo is part of the federation and holds
 * a charter; a school that buys a term of karate is a client. Collapsing them
 * would put a customer inside the federation's own hierarchy, which is how a
 * client ends up appearing on the affiliation register.
 */
export const institutions = pgTable('institutions', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                 // MMAKF-INST-2026-000001
  name: text('name').notNull(),
  kind: audienceKind('kind').notNull(),
  status: institutionStatus('status').notNull().default('prospect'),

  // Where, in the federation's own geography, so a request routes to the unit
  // that will actually deliver it.
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),
  city: text('city'),
  addressLine: text('address_line'),
  postcode: text('postcode'),

  // Scale, as the institution reported it. Nullable because an enquiry often
  // arrives without it, and a default of 0 would read as "no students".
  campusCount: integer('campus_count'),
  populationCount: integer('population_count'),

  website: text('website'),
  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('institutions_code_uk').on(t.code),
  kindIdx: index('institutions_kind_idx').on(t.kind),
  stateIdx: index('institutions_state_idx').on(t.stateUnitId),
}));

/**
 * A named person at an institution.
 *
 * `personId` links to the federation's canonical person record ONLY where the
 * contact is genuinely also a member. A principal who books karate for their
 * school is not thereby an MMAKF member, and creating a person record for
 * every enquiry is how a member register fills with people who never trained.
 */
export const institutionContacts = pgTable('institution_contacts', {
  id: serial('id').primaryKey(),
  institutionId: integer('institution_id').notNull().references(() => institutions.id),
  personId: integer('person_id').references(() => persons.id),
  fullName: text('full_name').notNull(),
  role: text('role'),                            // Principal, HR Manager, Sports Head
  email: text('email'),
  phone: text('phone'),
  isDecisionMaker: boolean('is_decision_maker').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  instIdx: index('institution_contacts_inst_idx').on(t.institutionId),
}));

// ─── The service catalogue ──────────────────────────────────────────────────

export const serviceCategory = pgEnum('service_category', [
  'training', 'education', 'competition', 'grading',
  'consultancy', 'event', 'certification',
]);

export const serviceStatus = pgEnum('service_status', ['draft', 'published', 'withdrawn']);

export const deliveryMode = pgEnum('delivery_mode', ['on_site', 'at_dojo', 'online', 'hybrid']);

/**
 * Something the federation delivers.
 *
 * Kihon, kata, kumite, bunkai, self-defence, women's training, children's
 * training, competitive development and Dan preparation are TRAINING
 * COMPONENTS, not nine separate products with nine separate monthly prices.
 * They are recorded here as services so a programme can be assembled from
 * them, and the fee framework decides how a given combination is priced.
 *
 * A service carries NO PRICE. That is the whole point of the separation.
 */
export const services = pgTable('services', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                  // MMAKF-SVC-SHOTOKAN-CORE
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  category: serviceCategory('category').notNull(),
  status: serviceStatus('status').notNull().default('draft'),
  summary: text('summary'),
  description: text('description'),

  /**
   * Whether this service can be self-served at a published price, or always
   * needs a quote. NULL means the federation has not decided, and an undecided
   * service is quotable rather than priced — the fail-closed reading.
   */
  publiclyPriced: boolean('publicly_priced'),

  sortOrder: integer('sort_order').notNull().default(100),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('services_code_uk').on(t.code),
  slugUk: uniqueIndex('services_slug_uk').on(t.slug),
  catIdx: index('services_category_idx').on(t.category),
}));

/** Which audiences a service is offered to. Absent means NOT offered to them. */
export const serviceAudiences = pgTable('service_audiences', {
  id: serial('id').primaryKey(),
  serviceId: integer('service_id').notNull().references(() => services.id),
  audience: audienceKind('audience').notNull(),
}, (t) => ({
  uk: uniqueIndex('service_audiences_uk').on(t.serviceId, t.audience),
}));

// ─── The fee framework ──────────────────────────────────────────────────────

export const frameworkStatus = pgEnum('fee_framework_status', [
  'draft', 'published', 'superseded', 'withdrawn',
]);

/**
 * A versioned set of pricing rules — MMAKF-FEE-2026-V1.
 *
 * PUBLISHED IS IMMUTABLE. `publishedAt` being set means no rule belonging to
 * this framework may be altered again, enforced in src/db/fees.ts rather than
 * only promised here. Changing a published rule would silently rewrite every
 * quotation ever issued under it, and a federation that cannot stand behind a
 * quotation it sent a school has no institutional business at all.
 */
export const feeFrameworks = pgTable('fee_frameworks', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                  // MMAKF-FEE-2026-V1
  title: text('title').notNull(),
  version: integer('version').notNull(),
  status: frameworkStatus('status').notNull().default('draft'),

  effectiveFrom: date('effective_from'),
  effectiveTo: date('effective_to'),

  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedByUserId: integer('published_by_user_id').references(() => users.id),
  supersededById: integer('superseded_by_id'),

  /** The currency every amount in this framework is expressed in, as minor units. */
  currency: text('currency').notNull().default('INR'),
  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('fee_frameworks_code_uk').on(t.code),
  versionUk: uniqueIndex('fee_frameworks_version_uk').on(t.version),
  statusIdx: index('fee_frameworks_status_idx').on(t.status),
}));

export const feeRuleKind = pgEnum('fee_rule_kind', [
  'base',          // the starting amount for a service
  'per_participant',
  'per_session',
  'per_batch',
  'per_campus',
  'per_instructor',
  'per_km',
  'multiplier',    // a factor applied to the running subtotal
  'fixed_add',     // a flat addition (equipment, assessment, certification)
  'discount',      // a negative adjustment, authorised
  'tax',
]);

/**
 * One priced rule inside a framework version.
 *
 * `conditions` is JSON because the federation's criteria are genuinely open —
 * location, participant category, age band, frequency, delivery mode,
 * institution type, contract length and a dozen more, in combinations nobody
 * can enumerate in advance. It is matched by src/db/fees.ts against the quote's
 * stored inputs, and every match is recorded on the resulting line so the
 * calculation stays explainable.
 *
 * `amountMinor` is INTEGER PAISE. `factorPpm` is parts-per-million for
 * multipliers — 1_000_000 is ×1.0, 1_250_000 is ×1.25 — because a float
 * multiplier reintroduces exactly the rounding this schema avoids elsewhere.
 */
export const feeRules = pgTable('fee_rules', {
  id: serial('id').primaryKey(),
  frameworkId: integer('framework_id').notNull().references(() => feeFrameworks.id),
  code: text('code').notNull(),
  label: text('label').notNull(),
  kind: feeRuleKind('kind').notNull(),

  serviceId: integer('service_id').references(() => services.id),
  audience: audienceKind('audience'),

  conditions: jsonb('conditions').notNull().default(sql`'{}'::jsonb`),

  amountMinor: integer('amount_minor'),
  factorPpm: integer('factor_ppm'),

  /** Bounds, so a per-participant rule cannot run away on a bad input. */
  minQuantity: integer('min_quantity'),
  maxQuantity: integer('max_quantity'),

  /** Lower runs first. Ordering is explicit because multipliers are not commutative. */
  sortOrder: integer('sort_order').notNull().default(100),

  /** A discount nobody may apply without authority. */
  requiresApproval: boolean('requires_approval').notNull().default(false),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  frameworkIdx: index('fee_rules_framework_idx').on(t.frameworkId),
  codeUk: uniqueIndex('fee_rules_code_uk').on(t.frameworkId, t.code),
  orderIdx: index('fee_rules_order_idx').on(t.frameworkId, t.sortOrder),
}));

// ─── The vocabulary of a reduction (the discount migration) ─────────────────────────
//
// Declared HERE, beside quote_lines, rather than in src/db/discounts.schema.ts
// where the discount tables live. quote_lines has to name these types, and
// discounts.schema.ts already imports this file for `institutions`, `services`
// and `quoteVersions` — putting them the other way round would make the two
// schema files import each other, and a circular import between modules that
// build Drizzle table objects at load time fails in ways that are hard to read.
//
// They belong to the FEE ENGINE'S vocabulary in any case. A reduction is
// something computeFee() applies; a discount policy and a concession policy are
// two of the things that can ask for one.

export const reductionBasis = pgEnum('reduction_basis', ['fixed_amount', 'percentage']);

/**
 * WHERE in the computation a reduction lands.
 *
 * `before_tax` reduces the taxable amount; `after_tax` reduces the
 * tax-inclusive total. Those are genuinely different numbers, and which one the
 * federation means is a policy decision rather than an implementation detail.
 *
 * A STAGE RATHER THAN A SORT NUMBER, deliberately. A discount policy is
 * separate from a fee framework and outlives its versions, so whoever writes
 * the discount cannot know what sort_order the framework's tax rule will carry
 * — and a discount that landed on the wrong side of the tax line would be wrong
 * by exactly the tax rate, quietly.
 */
export const reductionStage = pgEnum('reduction_stage', ['before_tax', 'after_tax']);

/**
 * What produced a quote line.
 *
 * The column that lets a marketing report exclude hardship. Without it a
 * concession and a campaign discount are the same row — kind = 'discount', a
 * label, a negative amount — and the only way to tell them apart is to match on
 * the label text, which is not a way at all.
 */
export const reductionSource = pgEnum('reduction_source', ['fee_rule', 'discount', 'concession']);

// ─── Leads ──────────────────────────────────────────────────────────────────

export const leadSourceKind = pgEnum('lead_source_kind', [
  'organic_search', 'paid_search', 'social', 'youtube', 'referral',
  'event', 'qr', 'campaign', 'direct', 'partner', 'unknown',
]);

export const leadStatus = pgEnum('lead_status', [
  'new', 'qualifying', 'qualified', 'quoted', 'proposed',
  'won', 'lost', 'dormant', 'disqualified',
]);

/**
 * An enquiry, before it is anybody.
 *
 * A lead attaches to a canonical Institution or Person ONLY once identified.
 * Creating a customer record for every enquiry is how a CRM ends up with four
 * copies of the same school, and then four different quotes.
 */
export const leads = pgTable('leads', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                    // MMAKF-LEAD-2026-000001
  audience: audienceKind('audience').notNull(),
  status: leadStatus('status').notNull().default('new'),

  institutionId: integer('institution_id').references(() => institutions.id),
  personId: integer('person_id').references(() => persons.id),

  contactName: text('contact_name'),
  contactEmail: text('contact_email'),
  contactPhone: text('contact_phone'),

  // Attribution. First touch and last touch are both kept: the campaign that
  // introduced somebody and the one that brought them back are different facts,
  // and overwriting the first with the second loses the one that did the work.
  firstSource: leadSourceKind('first_source').notNull().default('unknown'),
  lastSource: leadSourceKind('last_source').notNull().default('unknown'),
  firstLandingPath: text('first_landing_path'),
  utm: jsonb('utm'),

  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),
  city: text('city'),

  ownerUserId: integer('owner_user_id').references(() => users.id),
  lostReason: text('lost_reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('leads_ref_uk').on(t.ref),
  statusIdx: index('leads_status_idx').on(t.status),
  audienceIdx: index('leads_audience_idx').on(t.audience),
  instIdx: index('leads_institution_idx').on(t.institutionId),
}));

export const leadActivities = pgTable('lead_activities', {
  id: serial('id').primaryKey(),
  leadId: integer('lead_id').notNull().references(() => leads.id),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  kind: text('kind').notNull(),                  // note | call | email | meeting | status_change
  byUserId: integer('by_user_id').references(() => users.id),
  summary: text('summary').notNull(),
  detail: jsonb('detail'),
}, (t) => ({
  leadIdx: index('lead_activities_lead_idx').on(t.leadId, t.at),
}));

// ─── The training request ───────────────────────────────────────────────────

export const requestStatus = pgEnum('training_request_status', [
  'submitted', 'qualifying', 'quoted', 'proposed',
  'accepted', 'declined', 'withdrawn', 'expired',
]);

/**
 * A structured enquiry — what somebody actually wants MMAKF to deliver.
 *
 * `parameters` holds the answers to the multi-step form: participants, age
 * bands, frequency, duration, campuses, delivery mode, facility, instructor
 * requirements, assessment, certification and so on. It is JSON because the
 * question set differs per audience and hardcoding twenty nullable columns for
 * the union of them produces a table where most cells are meaningless.
 *
 * It is FROZEN onto the quote when one is produced, so editing a request
 * afterwards cannot retrospectively change what was quoted.
 */
export const trainingRequests = pgTable('training_requests', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                    // MMAKF-REQ-2026-000001
  leadId: integer('lead_id').references(() => leads.id),
  institutionId: integer('institution_id').references(() => institutions.id),
  personId: integer('person_id').references(() => persons.id),

  audience: audienceKind('audience').notNull(),
  status: requestStatus('status').notNull().default('submitted'),

  serviceId: integer('service_id').references(() => services.id),
  mode: deliveryMode('mode'),

  parameters: jsonb('parameters').notNull().default(sql`'{}'::jsonb`),

  preferredStartOn: date('preferred_start_on'),
  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('training_requests_ref_uk').on(t.ref),
  statusIdx: index('training_requests_status_idx').on(t.status),
  leadIdx: index('training_requests_lead_idx').on(t.leadId),
}));

// ─── Quotation ──────────────────────────────────────────────────────────────

export const quoteStatus = pgEnum('quote_status', [
  'draft', 'awaiting_approval', 'issued', 'accepted',
  'rejected', 'expired', 'withdrawn', 'superseded',
]);

export const quotes = pgTable('quotes', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                    // MMAKF-QUO-2026-000001
  requestId: integer('request_id').references(() => trainingRequests.id),
  institutionId: integer('institution_id').references(() => institutions.id),
  personId: integer('person_id').references(() => persons.id),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('quotes_ref_uk').on(t.ref),
  reqIdx: index('quotes_request_idx').on(t.requestId),
  /**
   * ONE QUOTATION PER REQUEST (migration 0048).
   *
   * issueQuote() re-versions rather than opening a second quotation, and it used
   * to decide that with a SELECT followed by an INSERT — which two concurrent
   * callers both pass. The result was two quotations for one request, each
   * numbering its versions from 1, and neither superseding the other's issued
   * version: the federation quoting two prices at once with nothing in the
   * schema to say which one the school was given.
   *
   * PARTIAL, because a null request_id is not a conflict. A quotation raised
   * directly against a person or an institution has no training request, and two
   * of those are two different quotations.
   */
  requestUk: uniqueIndex('quotes_request_uk')
    .on(t.requestId)
    .where(sql`request_id is not null`),
}));

/**
 * One computation of a quote. Quotes are never edited — they are re-versioned.
 *
 * A version stores the FRAMEWORK VERSION and the INPUTS it was computed from,
 * not references to things that may change. Reproducibility is then a property
 * that can be TESTED: re-run this framework against these inputs and assert the
 * same total. tests/fees.test.ts does exactly that.
 */
export const quoteVersions = pgTable('quote_versions', {
  id: serial('id').primaryKey(),
  quoteId: integer('quote_id').notNull().references(() => quotes.id),
  version: integer('version').notNull(),
  status: quoteStatus('status').notNull().default('draft'),

  frameworkId: integer('framework_id').notNull().references(() => feeFrameworks.id),
  /** The framework code AS TEXT, so the figure stays explainable even if a row is ever archived. */
  frameworkCode: text('framework_code').notNull(),

  /** The exact inputs, frozen. Not a pointer to a form somebody may edit later. */
  inputs: jsonb('inputs').notNull(),

  subtotalMinor: integer('subtotal_minor').notNull().default(0),
  adjustmentMinor: integer('adjustment_minor').notNull().default(0),
  taxMinor: integer('tax_minor').notNull().default(0),
  totalMinor: integer('total_minor').notNull().default(0),
  currency: text('currency').notNull().default('INR'),

  /**
   * The two halves of `adjustmentMinor`, kept apart (the discount migration).
   *
   * `adjustmentMinor` holds every reduction added together, which is right for
   * the arithmetic and useless for the question "what did our campaigns cost
   * us?" — because a hardship concession is in that sum too. Splitting them
   * here means a marketing report never has to touch a concession row to
   * produce its own number.
   *
   * Both are stored NEGATIVE, matching `adjustmentMinor`, so
   * subtotal + adjustment + tax = total continues to hold.
   */
  discountMinor: integer('discount_minor').notNull().default(0),
  concessionMinor: integer('concession_minor').notNull().default(0),

  /**
   * True when no rule in the framework could price the request. The quote then
   * carries NO NUMBER and the surface says so. A zero here would be read as
   * "free", which is the most expensive possible misunderstanding.
   */
  requiresManualQuote: boolean('requires_manual_quote').notNull().default(false),
  manualReason: text('manual_reason'),

  validUntil: date('valid_until'),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  approvedByUserId: integer('approved_by_user_id').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),

  // ── FROZEN AT ISSUE (migration 0015) ──────────────────────────────────────
  //
  // The same rule the invoice carries, one step earlier in the story: once a
  // quotation is issued, its amount and the exchange rate behind it are frozen
  // on THIS version. The school that accepted a figure in March must find that
  // figure unchanged in June, whatever the rupee did in between — and a quote
  // is already never edited, only re-versioned, so freezing here costs nothing.
  //
  // `fxRateId` is provenance only. Nothing recomputes from it.

  /** `currency` above is the base. This is its ISO 4217 exponent, frozen. */
  currencyMinorUnit: integer('currency_minor_unit').notNull().default(2),

  presentmentCurrency: text('presentment_currency'),
  presentmentMinorUnit: integer('presentment_minor_unit'),
  presentmentTotalMinor: bigint('presentment_total_minor', { mode: 'number' }),

  fxRatePpm: bigint('fx_rate_ppm', { mode: 'number' }),
  fxRateId: integer('fx_rate_id'),
  fxSource: text('fx_source'),
  fxRetrievedAt: timestamp('fx_retrieved_at', { withTimezone: true }),
  fxEffectiveOn: date('fx_effective_on'),

  /**
   * The tax computation at issue. Null means none was recorded — NOT exempt.
   * `taxMinor` above stays the fee engine's own tax line; this is the versioned
   * tax engine's full working, kept so the figure remains explainable.
   */
  taxSnapshot: jsonb('tax_snapshot'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  versionUk: uniqueIndex('quote_versions_uk').on(t.quoteId, t.version),
  statusIdx: index('quote_versions_status_idx').on(t.status),
}));

/**
 * One line of a computed quote, WITH THE RULE THAT PRODUCED IT.
 *
 * `ruleCode`, `quantity` and `unitAmountMinor` together let an administrator
 * reconstruct the arithmetic without re-running anything: 80 participants ×
 * ₹450 = ₹36,000, then ×1.25 for on-campus delivery. A line that cannot say
 * where its number came from is the thing this whole schema exists to prevent.
 */
export const quoteLines = pgTable('quote_lines', {
  id: serial('id').primaryKey(),
  quoteVersionId: integer('quote_version_id').notNull().references(() => quoteVersions.id),
  sortOrder: integer('sort_order').notNull().default(100),

  ruleId: integer('rule_id').references(() => feeRules.id),
  ruleCode: text('rule_code'),
  kind: feeRuleKind('kind').notNull(),
  label: text('label').notNull(),

  quantity: integer('quantity'),
  unitAmountMinor: integer('unit_amount_minor'),
  factorPpm: integer('factor_ppm'),
  amountMinor: integer('amount_minor').notNull(),

  /** The running total AFTER this line, so the sequence is auditable step by step. */
  runningTotalMinor: integer('running_total_minor').notNull(),

  /** Which condition matched, in words, for the "why this amount?" screen. */
  because: text('because'),

  /**
   * Where this line came from (the discount migration).
   *
   * A commercial discount and a hardship concession both arrive as kind
   * 'discount' with a negative amount and a label. Without this column the only
   * way to tell them apart in a report is to match on the label text — so a
   * marketing summary either includes hardship cases or excludes them by
   * accident, and neither is acceptable.
   *
   * `reductionStage` is stored so reproduce() can rebuild the exact reduction
   * that was applied. A reduction is a decision taken at issue time and frozen
   * with the quote, exactly like the inputs: re-resolving a code four years
   * later would find it expired and quietly produce a different total.
   */
  sourceKind: reductionSource('source_kind').notNull().default('fee_rule'),
  reductionStage: reductionStage('reduction_stage'),
  /**
   * Deliberately untyped references rather than Drizzle `.references()`.
   *
   * The foreign keys are real and are declared in the discount migration; naming the
   * tables here would mean this file importing src/db/discounts.schema.ts,
   * which already imports this one.
   */
  discountCodeId: integer('discount_code_id'),
  concessionApplicationId: integer('concession_application_id'),
}, (t) => ({
  versionIdx: index('quote_lines_version_idx').on(t.quoteVersionId, t.sortOrder),
  sourceIdx: index('quote_lines_source_idx').on(t.sourceKind),
}));

// ─── Proposal and delivery ──────────────────────────────────────────────────

export const proposalStatus = pgEnum('proposal_status', [
  'draft', 'issued', 'accepted', 'rejected', 'expired', 'superseded',
]);

export const proposals = pgTable('proposals', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                    // MMAKF-PRO-2026-000001
  quoteVersionId: integer('quote_version_id').notNull().references(() => quoteVersions.id),
  institutionId: integer('institution_id').references(() => institutions.id),
  version: integer('version').notNull().default(1),
  status: proposalStatus('status').notNull().default('draft'),
  title: text('title').notNull(),
  body: text('body'),
  validUntil: date('valid_until'),
  issuedAt: timestamp('issued_at', { withTimezone: true }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decidedBy: text('decided_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('proposals_ref_uk').on(t.ref, t.version),
}));

export const programStatus = pgEnum('training_program_status', [
  'planned', 'scheduled', 'running', 'paused', 'completed', 'cancelled',
]);

/** An accepted proposal, being delivered. */
export const trainingPrograms = pgTable('training_programs', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                  // MMAKF-PRG-2026-000001
  title: text('title').notNull(),
  proposalId: integer('proposal_id').references(() => proposals.id),
  institutionId: integer('institution_id').references(() => institutions.id),
  serviceId: integer('service_id').references(() => services.id),
  status: programStatus('status').notNull().default('planned'),
  mode: deliveryMode('mode'),

  startsOn: date('starts_on'),
  endsOn: date('ends_on'),
  sessionsPlanned: integer('sessions_planned'),

  leadCoachPersonId: integer('lead_coach_person_id').references(() => persons.id),
  stateUnitId: integer('state_unit_id').references(() => stateUnits.id),
  districtUnitId: integer('district_unit_id').references(() => districtUnits.id),
  venue: text('venue'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('training_programs_code_uk').on(t.code),
  instIdx: index('training_programs_inst_idx').on(t.institutionId),
  statusIdx: index('training_programs_status_idx').on(t.status),
}));

export const programParticipants = pgTable('program_participants', {
  id: serial('id').primaryKey(),
  programId: integer('program_id').notNull().references(() => trainingPrograms.id),
  personId: integer('person_id').references(() => persons.id),
  /** For a school cohort where the federation holds no person record per child. */
  displayName: text('display_name'),
  ageBand: text('age_band'),
  joinedOn: date('joined_on'),
  leftOn: date('left_on'),
}, (t) => ({
  programIdx: index('program_participants_program_idx').on(t.programId),
  // ── Added by migration 0039 (programme activation) ───────────────────────
  //
  // "Which programmes is this person on" is the other half of every access
  // check in src/db/activation.ts, and the index above answers only "who is on
  // this programme". Without this one the check is a sequential scan of every
  // participant in the federation, per request.
  personIdx: index('program_participants_person_idx').on(t.personId, t.leftOn),
  // One roll entry per person per programme — the replay guard for
  // registerParticipant(). Partial, because a school cohort held only as a
  // display name has a null person_id and NULLs do not collide.
  personUk: uniqueIndex('program_participants_person_uk')
    .on(t.programId, t.personId)
    .where(sql`person_id is not null`),
}));

// ─── Availability, booking and consultation ─────────────────────────────────

export const availabilityKind = pgEnum('availability_kind', [
  'available', 'unavailable', 'leave', 'travel', 'tentative',
]);

/**
 * When a coach can work.
 *
 * Stored as intervals rather than a weekly pattern plus exceptions: a pattern
 * is compact and answers "is he free on the 14th?" only by reconstructing the
 * exception list, which is the query this table exists to serve.
 *
 * PRIVATE. `reason` is never exposed on a public or cross-coach surface — the
 * federation's scheduling system does not need to tell anyone that a coach is
 * away for a funeral.
 */
export const coachAvailability = pgTable('coach_availability', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  kind: availabilityKind('kind').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  reason: text('reason'),
  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  personIdx: index('coach_availability_person_idx').on(t.personId, t.startsAt),
}));

export const bookingStatus = pgEnum('booking_status', [
  'requested', 'qualification_required', 'proposed', 'confirmed',
  'rescheduled', 'cancelled', 'completed', 'no_show', 'expired',
]);

export const bookingKind = pgEnum('booking_kind', [
  'consultation', 'class', 'personal_coaching', 'institutional_session',
  'seminar', 'assessment', 'other',
]);

export const bookings = pgTable('bookings', {
  id: serial('id').primaryKey(),
  ref: text('ref').notNull(),                    // MMAKF-BKG-2026-000001
  kind: bookingKind('kind').notNull(),
  status: bookingStatus('status').notNull().default('requested'),

  programId: integer('program_id').references(() => trainingPrograms.id),
  requestId: integer('request_id').references(() => trainingRequests.id),
  institutionId: integer('institution_id').references(() => institutions.id),
  personId: integer('person_id').references(() => persons.id),

  coachPersonId: integer('coach_person_id').references(() => persons.id),
  dojoId: integer('dojo_id').references(() => dojos.id),
  venue: text('venue'),
  mode: deliveryMode('mode'),

  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  /** Travel and setup either side, so two bookings cannot be booked back to back across a city. */
  bufferBeforeMinutes: integer('buffer_before_minutes').notNull().default(0),
  bufferAfterMinutes: integer('buffer_after_minutes').notNull().default(0),

  capacity: integer('capacity'),
  notes: text('notes'),
  cancelledReason: text('cancelled_reason'),

  /**
   * The class occurrence this booking holds a place in (migration 0032).
   *
   * ONE COLUMN, NOT A SECOND BOOKING TABLE. This row already allocates a
   * federation reference, records who created it, holds travel buffers either
   * side and is cancelled through an audited path. A class seat is one of those
   * with a session attached — a separate table would mean two cancellation
   * paths, and the second one would be the one that forgets the audit row.
   *
   * No drizzle `.references()`: `class_sessions` lives in scheduling.schema.ts,
   * which imports THIS file, and a type-level reference back would be a cycle.
   * The foreign key is real and is created by migration 0032.
   */
  classSessionId: integer('class_session_id'),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  refUk: uniqueIndex('bookings_ref_uk').on(t.ref),
  coachIdx: index('bookings_coach_idx').on(t.coachPersonId, t.startsAt),
  statusIdx: index('bookings_status_idx').on(t.status),
  windowIdx: index('bookings_window_idx').on(t.startsAt, t.endsAt),
  classSessionIdx: index('bookings_class_session_idx').on(t.classSessionId),
}));

/**
 * A resource a booking consumes — the coach, the hall, the equipment.
 *
 * Modelled separately from the booking's own `coachPersonId` because a session
 * can need two instructors and a venue, and double-booking must be detectable
 * per resource. The uniqueness that prevents it is enforced in src/db/booking.ts
 * inside a transaction; a database constraint cannot express "overlapping
 * interval" without an exclusion constraint over a range type, which would tie
 * this schema to a Postgres extension the deployment target may not carry.
 */
export const bookingResources = pgTable('booking_resources', {
  id: serial('id').primaryKey(),
  bookingId: integer('booking_id').notNull().references(() => bookings.id),
  resourceKind: text('resource_kind').notNull(),  // coach | venue | equipment
  personId: integer('person_id').references(() => persons.id),
  dojoId: integer('dojo_id').references(() => dojos.id),
  label: text('label'),
}, (t) => ({
  bookingIdx: index('booking_resources_booking_idx').on(t.bookingId),
  personIdx: index('booking_resources_person_idx').on(t.personId),
}));

export const consultations = pgTable('consultations', {
  id: serial('id').primaryKey(),
  bookingId: integer('booking_id').notNull().references(() => bookings.id),
  leadId: integer('lead_id').references(() => leads.id),
  requestId: integer('request_id').references(() => trainingRequests.id),
  topic: text('topic'),
  outcome: text('outcome'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bookingIdx: index('consultations_booking_idx').on(t.bookingId),
}));

// ─── External calendars ─────────────────────────────────────────────────────

export const calendarProvider = pgEnum('calendar_provider', ['google', 'microsoft', 'ics']);

export const calendarConnectionStatus = pgEnum('calendar_connection_status', [
  'connected', 'expired', 'revoked', 'error',
]);

/**
 * A person's link to an external calendar.
 *
 * MMAKF REMAINS THE SYSTEM OF RECORD for MMAKF bookings. An external calendar
 * is a mirror and an availability source, never the authority — if Google and
 * this database disagree about whether a session exists, this database is
 * right. That is stated here because the opposite assumption is the natural one
 * and it silently makes a third party the owner of the federation's schedule.
 *
 * Refresh tokens are stored ENCRYPTED (AES-256-GCM, as OAuth tokens already are
 * elsewhere in this codebase); the column holds ciphertext, never a token.
 */
export const calendarConnections = pgTable('calendar_connections', {
  id: serial('id').primaryKey(),
  personId: integer('person_id').notNull().references(() => persons.id),
  userId: integer('user_id').references(() => users.id),
  provider: calendarProvider('provider').notNull(),
  status: calendarConnectionStatus('status').notNull().default('connected'),

  externalAccount: text('external_account'),
  externalCalendarId: text('external_calendar_id'),
  refreshTokenCiphertext: text('refresh_token_ciphertext'),
  scopes: text('scopes'),

  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastError: text('last_error'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  personIdx: index('calendar_connections_person_idx').on(t.personId),
  uk: uniqueIndex('calendar_connections_uk').on(t.personId, t.provider, t.externalCalendarId),
}));

export const calendarSyncStatus = pgEnum('calendar_sync_status', [
  'pending', 'synced', 'failed', 'deleted_remotely', 'conflict',
]);

/** The mirror of one MMAKF booking in one external calendar. */
export const calendarEvents = pgTable('calendar_events', {
  id: serial('id').primaryKey(),
  bookingId: integer('booking_id').references(() => bookings.id),
  connectionId: integer('connection_id').references(() => calendarConnections.id),
  provider: calendarProvider('provider').notNull(),
  externalEventId: text('external_event_id'),
  syncStatus: calendarSyncStatus('sync_status').notNull().default('pending'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastError: text('last_error'),
  /** Detects a remote edit without re-reading the whole event. */
  contentHash: text('content_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bookingIdx: index('calendar_events_booking_idx').on(t.bookingId),
  externalUk: uniqueIndex('calendar_events_external_uk').on(t.connectionId, t.externalEventId),
}));

export const calendarSyncLog = pgTable('calendar_sync_log', {
  id: serial('id').primaryKey(),
  connectionId: integer('connection_id').references(() => calendarConnections.id),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  direction: text('direction').notNull(),        // push | pull
  outcome: text('outcome').notNull(),            // ok | failed | skipped
  detail: text('detail'),
}, (t) => ({
  connIdx: index('calendar_sync_log_conn_idx').on(t.connectionId, t.at),
}));

// ─── Web push ───────────────────────────────────────────────────────────────

export const pushDeviceStatus = pgEnum('push_device_status', [
  'active', 'expired', 'unsubscribed', 'failed',
]);

/**
 * A browser push subscription.
 *
 * `endpoint` is the natural key — the push service allocates it and it is
 * unique per browser per site. A person on a phone and a laptop has two rows,
 * which is correct: they are two devices and either may be revoked alone.
 *
 * WHAT IS DELIBERATELY NOT STORED: precise location. The federation asked to
 * see "who is subscribing and from where", and the honest form of that is the
 * COARSE region a request arrived from — the country and, where the platform
 * supplies it, the region. This system does not ask a browser for GPS, does not
 * store an IP address (the audit spine already hashes those), and will not
 * start: a martial arts federation holding the home locations of children is a
 * safeguarding liability with no operational benefit whatever.
 */
export const pushDevices = pgTable('push_devices', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').references(() => users.id),
  personId: integer('person_id').references(() => persons.id),

  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),

  status: pushDeviceStatus('status').notNull().default('active'),
  userAgent: text('user_agent'),
  /** Coarse only — country, and region where the edge supplies it. Never a coordinate. */
  regionCountry: text('region_country'),
  regionName: text('region_name'),
  timezone: text('timezone'),

  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  failureCount: integer('failure_count').notNull().default(0),
  lastError: text('last_error'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  endpointUk: uniqueIndex('push_devices_endpoint_uk').on(t.endpoint),
  userIdx: index('push_devices_user_idx').on(t.userId),
  statusIdx: index('push_devices_status_idx').on(t.status),
}));

/**
 * What a person wants to be told about, and when.
 *
 * A row per topic. NO ROW means the federation's default for that topic
 * applies, and an ESSENTIAL topic cannot be switched off — nobody may opt out
 * of being told their credential was withdrawn. That rule already governs
 * src/lib/notifications.ts and this table does not get to contradict it.
 */
export const notificationPreferences = pgTable('notification_preferences', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id),
  topic: text('topic').notNull(),
  channelInApp: boolean('channel_in_app').notNull().default(true),
  channelEmail: boolean('channel_email').notNull().default(true),
  channelPush: boolean('channel_push').notNull().default(false),
  channelSms: boolean('channel_sms').notNull().default(false),

  /** Local quiet hours, inclusive of start and exclusive of end, in the user's timezone. */
  quietFromHour: integer('quiet_from_hour'),
  quietToHour: integer('quiet_to_hour'),
  timezone: text('timezone'),

  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uk: uniqueIndex('notification_preferences_uk').on(t.userId, t.topic),
}));

export const deliveryOutcome = pgEnum('push_delivery_outcome', [
  'queued', 'sent', 'failed', 'expired', 'suppressed_quiet_hours',
  'suppressed_preference', 'suppressed_duplicate',
]);

/**
 * One attempt to deliver one notification to one device.
 *
 * SUPPRESSION IS RECORDED, NOT SILENT. "We did not send this because the member
 * turned that topic off" and "we tried and it failed" are different facts, and
 * an operator asking why somebody was not told needs to see which. A row that
 * simply does not exist answers neither question.
 */
export const notificationDeliveries = pgTable('notification_deliveries', {
  id: serial('id').primaryKey(),
  notificationId: integer('notification_id'),
  pushDeviceId: integer('push_device_id').references(() => pushDevices.id),
  userId: integer('user_id').references(() => users.id),
  topic: text('topic'),
  channel: text('channel').notNull(),            // in_app | email | push | sms
  outcome: deliveryOutcome('outcome').notNull().default('queued'),
  attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull().defaultNow(),
  detail: text('detail'),
}, (t) => ({
  deviceIdx: index('notification_deliveries_device_idx').on(t.pushDeviceId),
  notifIdx: index('notification_deliveries_notification_idx').on(t.notificationId),
  outcomeIdx: index('notification_deliveries_outcome_idx').on(t.outcome),
}));
