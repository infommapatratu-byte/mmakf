// Tax — versioned, server-side, and EMPTY until MMAKF says otherwise.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE THING THIS SCHEMA REFUSES TO DECIDE
// ─────────────────────────────────────────────────────────────────────────────
//
// Whether an MMAKF federation membership, a grading fee, a dan examination or
// an institutional training contract attracts GST — and at what rate, under
// which SAC classification, and whether it is CGST+SGST or IGST — is a legal
// and accounting determination the federation has to make and record. It is not
// a thing software may assume on its behalf.
//
// So not one rate appears in this file or in migration 0015. `tax_rules` and
// `tax_rate_versions` are created empty, and src/db/tax.ts reports "no tax rule
// is configured for this supply, so nothing has been added" — which is true —
// rather than a zero. A zero would read as a determination of exemption, and
// six months from now a seeded-but-plausible 18% would be indistinguishable
// from a rate an accountant had actually signed off. This is the same
// discipline the fee engine already follows, for the same reason.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE RATE IS NOT ON THE RULE
// ─────────────────────────────────────────────────────────────────────────────
//
// "An institutional training contract delivered in Jharkhand is a
// standard-rated supply" is a lasting classification. "The standard rate is X%"
// is a number that changes on a budget day. Holding both in one row means a
// rate change rewrites the classification's history — and an invoice issued in
// 2026 starts claiming it was taxed at the 2027 rate.
//
// tax_rules holds the classification. tax_rate_versions holds the number and
// the window it was in force for, published-then-frozen exactly as a fee
// framework is. An invoice keeps the rate that applied when it was issued
// because src/db/tax.ts writes the computation ONTO the invoice, not a pointer
// to a version somebody may supersede.

import {
  pgTable, serial, text, integer, timestamp, date, jsonb, pgEnum,
  uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './schema';
import { audienceKind, services } from './engagement.schema';

/**
 * How a jurisdiction treats a supply. A MODEL, not a rate.
 *
 * These five are how any tax system in the world classifies a supply, so
 * naming them commits MMAKF to nothing. The number attached to `standard` is
 * what the federation must supply, and it lives in tax_rate_versions.
 *
 * The distinction that earns this enum its place: `exempt` and `zero_rated`
 * both add nothing, and they are not the same fact. Zero-rated is taxable at a
 * rate of nought and carries input-credit consequences; exempt is outside the
 * charge. Both differ again from HAVING NO RULE AT ALL, which is where this
 * system currently stands and which src/db/tax.ts refuses to disguise as
 * either.
 *
 * Named `*_treatment` rather than `*_status` on purpose: it is a taxonomy, not
 * a lifecycle, and tests/status-dictionary.test.ts correctly excludes it from
 * the status chip vocabulary.
 */
export const taxTreatment = pgEnum('tax_treatment', [
  'standard', 'zero_rated', 'exempt', 'out_of_scope', 'reverse_charge',
]);

/**
 * The rate version lifecycle, mirroring fee_framework_status exactly.
 *
 * PUBLISHED IS IMMUTABLE, enforced in src/db/tax.ts. `superseded` is not
 * `withdrawn`: a superseded version was correct for its window and must still
 * be findable when reconstructing an old invoice, while a withdrawn one should
 * never have applied at all and is excluded from historical lookups too.
 */
export const taxRateVersionStatus = pgEnum('tax_rate_version_status', [
  'draft', 'published', 'superseded', 'withdrawn',
]);

/**
 * Who levies the tax.
 *
 * Nests, because a state sits inside a country and the same supply can attract
 * a national and a sub-national component. A flat list cannot say which is
 * which, and "place of supply" questions are exactly the ones that turn on it.
 *
 * `parentId` carries no drizzle foreign key, matching
 * fee_frameworks.supersededById: a self-reference forces a circular type
 * annotation for no integrity gain the application does not already enforce.
 */
export const taxJurisdictions = pgTable('tax_jurisdictions', {
  id: serial('id').primaryKey(),
  /** 'IN' for the union, 'IN-JH' for Jharkhand. ISO 3166 where one exists. */
  code: text('code').notNull(),
  name: text('name').notNull(),
  countryCode: text('country_code').notNull(),
  regionCode: text('region_code'),
  parentId: integer('parent_id'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('tax_jurisdictions_code_uk').on(t.code),
}));

/**
 * A taxable supply, identified. Carries NO rate — see the file header.
 *
 * `conditions` is jsonb and is matched by the SAME matcher as fee rules
 * (matchConditions in src/db/fees.ts), so this system has one condition
 * language rather than two that drift apart. A rule with no service, no
 * audience and empty conditions applies to everything, which is a decision
 * somebody has to make explicitly rather than reach by accident.
 */
export const taxRules = pgTable('tax_rules', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),
  label: text('label').notNull(),
  jurisdictionId: integer('jurisdiction_id').notNull().references(() => taxJurisdictions.id),

  serviceId: integer('service_id').references(() => services.id),
  audience: audienceKind('audience'),
  conditions: jsonb('conditions').notNull().default(sql`'{}'::jsonb`),

  treatment: taxTreatment('treatment').notNull(),
  /** The jurisdiction's own classification code — an SAC, an HSN, a schedule entry. */
  taxCode: text('tax_code'),

  /** Lower runs first. Explicit because tax on tax is not commutative. */
  sortOrder: integer('sort_order').notNull().default(100),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('tax_rules_code_uk').on(t.code),
  orderIdx: index('tax_rules_order_idx').on(t.jurisdictionId, t.sortOrder),
}));

/**
 * The rate, and the window it was in force for.
 *
 * `ratePpm` is parts-per-million of the taxable base, matching fee_rules.
 * 18% is 180000. It is NULLABLE because a zero-rated or exempt supply has no
 * rate at all: storing 0 there would make "the legislature set this to nought"
 * indistinguishable from "nobody has told us", which is the confusion this
 * whole module is built to prevent.
 *
 * `components` is for a jurisdiction that splits one headline rate into named
 * parts — India's CGST/SGST/IGST split being the obvious candidate. It exists
 * so recording that split later is configuration rather than a migration, and
 * it ships empty because MMAKF has not made that determination either.
 */
export const taxRateVersions = pgTable('tax_rate_versions', {
  id: serial('id').primaryKey(),
  taxRuleId: integer('tax_rule_id').notNull().references(() => taxRules.id),
  version: integer('version').notNull(),
  status: taxRateVersionStatus('status').notNull().default('draft'),

  ratePpm: integer('rate_ppm'),
  components: jsonb('components').notNull().default(sql`'[]'::jsonb`),

  effectiveFrom: date('effective_from').notNull(),
  effectiveTo: date('effective_to'),

  /** The notification, circular or Act section this rate comes from. */
  authorityRef: text('authority_ref'),

  publishedAt: timestamp('published_at', { withTimezone: true }),
  publishedByUserId: integer('published_by_user_id').references(() => users.id),
  supersededById: integer('superseded_by_id'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  ruleVersionUk: uniqueIndex('tax_rate_versions_rule_version_uk').on(t.taxRuleId, t.version),
  effectiveIdx: index('tax_rate_versions_effective_idx').on(t.taxRuleId, t.effectiveFrom),
}));
