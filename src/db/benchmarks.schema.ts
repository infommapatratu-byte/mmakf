// What OTHER organisations charge — and the wall between that and what MMAKF
// charges.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS, AND WHAT IT IS EMPHATICALLY NOT
// ─────────────────────────────────────────────────────────────────────────────
//
// This schema stores OBSERVATIONS ABOUT THIRD PARTIES. A row here says "USA
// Karate was reported to charge USD 60 a year for individual athlete
// membership". It does not say, and can never be read to say, what MMAKF
// charges. MMAKF's own prices live in `fee_rules` (src/db/engagement.schema.ts)
// and there is still not one of them, because the federation has published no
// fee framework.
//
// The two stores are deliberately unconnected. There is no foreign key from a
// benchmark to a fee rule, no column on a fee rule pointing back at the
// benchmark that "justified" it, and nothing in src/db/fee-recommendation.ts
// that can write to either table. A benchmark becoming an MMAKF price requires
// a human to author a rule in a draft framework and a second human to publish
// it — the path src/db/fees.ts already enforces.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE PROVENANCE COLUMNS ARE NOT OPTIONAL DECORATION
// ─────────────────────────────────────────────────────────────────────────────
//
// A figure attributed to a named federation is a factual claim about somebody
// else's commercial policy. Published without a source it is indistinguishable
// from a rumour, and if it is wrong the party harmed is a third party who never
// agreed to appear in this database. So every row carries where it came from,
// what kind of source that was, when it was retrieved, and how far it has been
// verified — and `source_url` is NULLABLE precisely so nobody is ever tempted
// to type a plausible one to satisfy a NOT NULL constraint.
//
// The thirteen rows this system ships with were supplied by the federation as a
// list, with no URLs, no publication dates and no retrieval record of their
// own. They are therefore stored as `federation_supplied` at confidence
// `reported`: attributed, not verified. That is the honest reading, and it is
// what the store says about them.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY UNITS ARE TWO COLUMNS AND NOT ONE
// ─────────────────────────────────────────────────────────────────────────────
//
// "USD 60 a year" and "USD 185 a month" are not comparable, and neither are
// "EUR 250 a year for a federation" and "GBP 25 a year for an adult". The first
// pair differs in PERIOD, the second in SUBJECT — who or what the fee is levied
// on. A single `frequency` column collapses the second difference and makes an
// average of a national federation's affiliation fee and a teenager's
// membership look like a number.
//
// So a benchmark states both, and src/db/benchmarks.ts refuses to compare
// across either. Where the supplied line did not state one, the column says
// `unstated` rather than guessing — and an `unstated` row is excluded from
// every comparison it would otherwise have joined. Three of the thirteen seed
// rows are in exactly that position.

import {
  pgTable, serial, text, integer, timestamp, date, jsonb, pgEnum,
  index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './schema';

// ─── Vocabularies ───────────────────────────────────────────────────────────

/**
 * Where a figure came from, as a kind rather than a free-text excuse.
 *
 * `federation_supplied` is its own kind and is NOT the same as
 * `official_publication`. MMAKF handing over a list of what it believes other
 * bodies charge is second-hand information, however reliable the hand; a fee
 * schedule read off the other body's own site is first-hand. Collapsing them
 * would make the thirteen seed rows look like primary sources, which they are
 * not.
 */
export const benchmarkSourceType = pgEnum('fee_benchmark_source_type', [
  'federation_supplied',
  'official_publication',
  'operator_entered',
  'press_report',
  'third_party',
  'unknown',
]);

/**
 * How far the figure has been checked. Distinct from source type: an official
 * publication that nobody has re-read in three years is still only `reported`.
 *
 * `estimated` exists so a derived or bracketed figure can be stored WITHOUT
 * pretending to be an observation. It is never treated as evidence of the same
 * weight — see confidenceWeight() in src/db/fee-recommendation.ts.
 */
export const benchmarkConfidence = pgEnum('fee_benchmark_confidence', [
  'verified',    // seen at the stated source, by a named person, on the stated date
  'reported',    // attributed to a named organisation, not independently checked
  'estimated',   // derived or approximate, and marked as such
  'unverified',  // recorded, provenance incomplete
]);

/**
 * The PERIOD a benchmark is levied over.
 *
 * `unstated` is a first-class member. Three of the federation's own supplied
 * lines — the WUKF coach fee, the protest fee and the dan homologation fee —
 * gave an amount and no frequency. Recording them as `one_off` because that
 * "seems right" would be inventing a term of a third party's fee schedule.
 */
export const benchmarkFrequency = pgEnum('fee_benchmark_frequency', [
  'per_year',
  'per_month',
  'per_week',
  'per_session',
  'per_event',
  'one_off',
  'unstated',
]);

/**
 * WHO OR WHAT the fee is levied on.
 *
 * The dimension that a plain `frequency` column loses. A club affiliation and
 * an athlete membership can both be "per year" and averaging them is
 * meaningless; this column is what lets normalise() say so instead of
 * producing a number.
 */
export const benchmarkSubject = pgEnum('fee_benchmark_subject', [
  'person',
  'club',
  'team',
  'federation',
  'application',   // a protest, a homologation — levied per submission
  'unstated',
]);

/**
 * The standing of an observation in the store.
 *
 * `excluded` and `flagged` are separate on purpose. Excluded means a human
 * decided this row must not inform a recommendation — superseded, wrong,
 * out of scope. Flagged means somebody wants it looked at and has NOT yet
 * decided; a flagged row still counts, and the recommendation says so, because
 * silently dropping evidence somebody merely doubted is how a sample gets
 * curated into the answer that was wanted.
 */
export const benchmarkStatus = pgEnum('fee_benchmark_status', [
  'included',
  'excluded',
  'flagged',
  'archived',
]);

// ─── The citation register ──────────────────────────────────────────────────

/**
 * One row per source document, so a citation can be re-checked as a unit.
 *
 * Benchmarks ALSO carry their own copy of the attribution fields. That is
 * deliberate duplication of exactly the kind an invoice makes when it stores
 * the exchange rate it was issued at: the source register is the living record
 * of where to go and look again, and the copy on the observation is what the
 * observation was recorded against and must never change underneath it. If
 * somebody corrects a URL here in 2029, the 2026 observation still says what it
 * was captured from.
 */
export const feeBenchmarkSources = pgTable('fee_benchmark_sources', {
  id: serial('id').primaryKey(),
  /** Stable, human-readable, and the idempotency key for seeding. */
  code: text('code').notNull(),
  organisation: text('organisation').notNull(),
  title: text('title').notNull(),
  /** Null when there is no document to point at — see the header note. */
  url: text('url'),
  /** When the SOURCE was published, not when we read it. Null when unknown. */
  publishedOn: date('published_on'),
  /** When this system captured it. Never null: something always happened. */
  retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull().defaultNow(),
  sourceType: benchmarkSourceType('source_type').notNull(),
  confidence: benchmarkConfidence('confidence').notNull(),
  /** Who entered it, when a person did. Null for a migration seed. */
  recordedByUserId: integer('recorded_by_user_id').references(() => users.id),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('fee_benchmark_sources_code_uk').on(t.code),
  orgIdx: index('fee_benchmark_sources_org_idx').on(t.organisation),
}));

// ─── The observations ───────────────────────────────────────────────────────

/**
 * One observed fee, charged by an organisation that is not MMAKF.
 *
 * `amount_minor` is an integer in the MINOR UNIT OF ITS OWN CURRENCY — cents
 * for USD, pence for GBP, cents for EUR — and `currency_exponent` says how many
 * minor units make one major, because not every currency has two (JPY has
 * none). It is NOT paise and it is NOT converted to INR. Converting needs an FX
 * rate with a timestamp attached, which is a different concern with a different
 * owner; a benchmark silently carrying last-year's rate is worse than one that
 * refuses to convert.
 *
 * `amount_text` is the figure exactly as it was supplied — "USD 60/year". It is
 * the audit trail against every parse and every unit decision below it, and the
 * thing to read when the structured columns and the source disagree.
 */
export const feeBenchmarks = pgTable('fee_benchmarks', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),
  sourceId: integer('source_id').notNull().references(() => feeBenchmarkSources.id),

  // ── Who charges it, and where ──
  organisation: text('organisation').notNull(),
  /**
   * ISO 3166-1 alpha-2, or null.
   *
   * NULL IS A REAL ANSWER HERE. WUKF is a world union with no single country,
   * and the supplied line for Japan Karate-Do named no country at all — its
   * prices being quoted in USD does not settle one. Writing 'JP' because the
   * name contains "Japan" would be a fabricated fact about a third party.
   */
  country: text('country'),
  /** 'national', 'international', a state, a city — or null when unstated. */
  region: text('region'),

  // ── What is being charged for ──
  /** A controlled code, so like is compared with like. See BENCHMARK_SERVICES. */
  service: text('service').notNull(),
  /** The wording the source used, unaltered. */
  serviceLabel: text('service_label').notNull(),
  /** Who it applies to, as the source described them. */
  audience: text('audience').notNull(),

  // ── The money ──
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull(),           // ISO 4217
  currencyExponent: integer('currency_exponent').notNull().default(2),
  amountText: text('amount_text').notNull(),

  // ── The two unit dimensions ──
  frequency: benchmarkFrequency('frequency').notNull(),
  subject: benchmarkSubject('subject').notNull(),

  // ── When it applied ──
  // Both nullable. A fee schedule with no stated start is common, and defaulting
  // to the day we recorded it would assert a fact about when the other body
  // changed its prices.
  effectiveFrom: date('effective_from'),
  effectiveUntil: date('effective_until'),

  // ── Provenance, frozen onto the observation ──
  sourceUrl: text('source_url'),
  sourceTitle: text('source_title').notNull(),
  sourceDate: date('source_date'),
  retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull().defaultNow(),
  sourceType: benchmarkSourceType('source_type').notNull(),
  confidence: benchmarkConfidence('confidence').notNull(),

  notes: text('notes'),
  status: benchmarkStatus('status').notNull().default('included'),
  /** Why it is not `included`. Required by setBenchmarkStatus(), not by the DDL. */
  statusReason: text('status_reason'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('fee_benchmarks_code_uk').on(t.code),
  sourceIdx: index('fee_benchmarks_source_idx').on(t.sourceId),
  // The recommendation engine's only query shape: service, then market, then
  // the unit dimensions it must group by.
  lookupIdx: index('fee_benchmarks_lookup_idx').on(t.service, t.status, t.currency),
  orgIdx: index('fee_benchmarks_org_idx').on(t.organisation),
  subjectIdx: index('fee_benchmarks_unit_idx').on(t.subject, t.frequency),
}));

// ─── Snapshots ──────────────────────────────────────────────────────────────

/**
 * A frozen copy of the evidence a recommendation was made from.
 *
 * Without this, "the office recommended a figure in the region of X in March"
 * cannot be re-examined in September, because the benchmark table has moved:
 * rows excluded, a source corrected, two more organisations added. Re-running
 * the engine then produces a different number and nobody can tell whether the
 * recommendation was wrong or the evidence changed.
 *
 * So the observations are copied INTO the snapshot as JSON, not referenced.
 * A reference would be undone by the very edits this exists to survive.
 *
 * NOTHING HERE APPROVES ANYTHING. There is no approved_at, no decision column
 * and no link to a fee rule, because a snapshot is evidence and an MMAKF price
 * is a decision. The decision is made by authoring a rule in a draft framework
 * and publishing it, under src/db/fees.ts, by two different people.
 */
export const feeBenchmarkSnapshots = pgTable('fee_benchmark_snapshots', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                    // MMAKF-BMS-2026-000001
  title: text('title').notNull(),

  takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
  takenByUserId: integer('taken_by_user_id').references(() => users.id),

  /** The question that was asked, exactly as asked. */
  query: jsonb('query').notNull().default(sql`'{}'::jsonb`),
  /** The observations as they stood, copied whole. */
  observations: jsonb('observations').notNull().default(sql`'[]'::jsonb`),
  observationCount: integer('observation_count').notNull().default(0),
  /**
   * The DRAFT the engine returned. Stored so the recommendation and the
   * evidence for it are one record rather than two that can drift apart.
   */
  recommendation: jsonb('recommendation'),
  notes: text('notes'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('fee_benchmark_snapshots_code_uk').on(t.code),
  takenIdx: index('fee_benchmark_snapshots_taken_idx').on(t.takenAt),
}));

// ─── The controlled service vocabulary ──────────────────────────────────────

/**
 * The service codes a benchmark may carry.
 *
 * Deliberately short and deliberately NOT MMAKF's service catalogue
 * (`services` in engagement.schema.ts). These are categories of thing other
 * bodies were observed to charge for; mapping them onto MMAKF's own offer is a
 * judgement a person makes, not a join.
 *
 * `as const` so the recommendation engine's request type is checked at compile
 * time and a typo cannot quietly match nothing.
 */
export const BENCHMARK_SERVICES = [
  'membership',
  'club_affiliation',
  'federation_affiliation',
  'competition_entry',
  'coach_registration',
  'protest_fee',
  'dan_homologation',
  'training',
] as const;

export type BenchmarkService = (typeof BENCHMARK_SERVICES)[number];

export function isBenchmarkService(x: unknown): x is BenchmarkService {
  return typeof x === 'string' && (BENCHMARK_SERVICES as readonly string[]).includes(x);
}
