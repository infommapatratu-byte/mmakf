// The fee catalogue — every service MMAKF can charge for, and not one price.
//
// WHAT WAS MISSING. src/db/engagement.schema.ts gave the federation a fee
// ENGINE: versioned frameworks, priced rules, reproducible quotations. It could
// not answer the prior question — what is MMAKF entitled to charge for at all?
// A referee licence, a Dan grading certificate, a kumite entry, a late entry, a
// protest, a replacement membership card. Fifty-one distinct chargeable
// services exist in the federation's own documents and none of them existed as
// a record, which is why the site could publish a monthly training figure and
// had no way to say what a grading costs.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE RULE THIS FILE ENFORCES BY SHAPE
// ─────────────────────────────────────────────────────────────────────────────
//
// A CATALOGUE ENTRY CARRIES NO AMOUNT.
//
// There is no amount column below, no priceMinor, no "from" figure, no
// indicative range. The amount lives in feeRules inside a versioned
// feeFrameworks row, and it lives there for a reason that is not tidiness: a
// catalogue entry is ONE ROW, and one row holds ONE value. Put the price here
// and a 2027 change silently rewrites what a 2026 invoice says it charged.
// The separation is the only thing that makes a historical quotation
// defensible four years later, which is the property the federation asked for
// first.
//
// tests/fee-catalogue.test.ts reads information_schema and fails if a column
// that could hold money ever appears on this table. A comment is not an
// enforcement mechanism; that test is.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHY THE DISPLAY POLICY IS A COLUMN
// ─────────────────────────────────────────────────────────────────────────────
//
// Not every fee is public information. An institutional contract is negotiated
// in writing, a member rate is not shown to strangers, and some internal
// charges are not published at all. Left to each page to decide, the first
// listing template somebody adds publishes a fee that should have been quoted
// privately. Recorded here, every surface asks one column and gets one answer.

import {
  pgTable, serial, text, integer, timestamp, pgEnum, index, uniqueIndex,
} from 'drizzle-orm/pg-core';
import { services, serviceStatus } from './engagement.schema';

// ─── Taxonomies ─────────────────────────────────────────────────────────────

/**
 * What MMAKF charges for.
 *
 * Deliberately NOT `serviceCategory` from engagement.schema.ts. That enum
 * describes what the federation DELIVERS — training, education, competition,
 * consultancy. This one describes what it CHARGES FOR, and the two lists
 * genuinely differ: 'documents' and 'affiliation' are chargeable and are not
 * deliveries, while one delivery can carry several chargeable services at once
 * (a championship charges entry, category, team, coach and official fees).
 * Collapsing them would force one of the two meanings to be wrong.
 */
export const feeServiceCategory = pgEnum('fee_service_category', [
  'membership', 'affiliation', 'grading', 'competition', 'education',
  'training', 'documents',
]);

/**
 * Who is charged.
 *
 * Wider than `audienceKind`, which lists the kinds of CLIENT the federation
 * trains — school, corporate, government. A referee licence fee is charged to a
 * referee, and 'referee' is not a kind of client. Reusing the narrower enum
 * would have meant recording half this catalogue as 'other'.
 */
export const feeAudience = pgEnum('fee_audience', [
  'athlete', 'junior', 'parent', 'coach', 'instructor', 'referee', 'judge',
  'official', 'examiner', 'member', 'dojo', 'club', 'school', 'university',
  'corporate', 'government', 'organisation', 'institution', 'state_unit',
  'district_unit', 'any',
]);

/**
 * What ONE unit of the charge is.
 *
 * A fee rule multiplies by a quantity; the unit is what tells a human WHICH
 * quantity. "Per entry" and "per category" produce very different totals for
 * the same competition, and the difference between them is the single most
 * common dispute at an entry desk.
 */
export const feeUnit = pgEnum('fee_unit', [
  'per_person', 'per_application', 'per_registration', 'per_entry',
  'per_category', 'per_team', 'per_session', 'per_seat', 'per_month',
  'per_year', 'per_document', 'per_card', 'per_certificate', 'per_dojo',
  'per_club', 'per_institution', 'per_campus', 'per_hour', 'per_case',
]);

/**
 * How often it recurs. `on_request` is not a hedge — a protest fee genuinely
 * has no cadence until somebody lodges a protest.
 */
export const feeFrequency = pgEnum('fee_frequency', [
  'one_time', 'annual', 'biennial', 'triennial', 'monthly', 'per_term',
  'per_event', 'per_session', 'on_request',
]);

/**
 * What a surface may say about this fee.
 *
 * There is no 'unset' value and the column is NOT NULL, on purpose. An entry
 * whose policy nobody had decided would be read by whichever page forgot to
 * check as the most permissive option available, and the failure — a privately
 * negotiated institutional figure appearing on the public site — is silent and
 * not recoverable once it has been seen.
 */
export const feeDisplayPolicy = pgEnum('fee_display_policy', [
  'public',         // may be shown to anybody, once the federation publishes it
  'request_quote',  // never a figure; the office prepares a quotation
  'member_only',    // shown to a signed-in member, not to the public
  'institutional',  // agreed in writing with the institution, never listed
  'private',        // internal to the federation office
  'hidden',         // not listed at all, on any surface
]);

// ─── The catalogue ──────────────────────────────────────────────────────────

/**
 * One chargeable service.
 *
 * `status` reuses `serviceStatus` (draft / published / withdrawn) rather than
 * minting a fourth private vocabulary meaning the same three things — the
 * status dictionary in src/lib/status.ts already knows those labels, and an
 * unknown label renders as an unstyled grey chip on every screen that shows it.
 *
 * `serviceId` is NULLABLE and is a link, not an owner. Most chargeable services
 * — a grading certificate, a protest, a replacement card — correspond to no
 * delivery record at all, and NOT NULL here would have forced fifty-one
 * placeholder rows into the delivery catalogue purely to satisfy a constraint.
 *
 * `statutoryBasis` records WHERE the federation's authority to charge comes
 * from — a bye-law clause, a general-body resolution, a competition regulation.
 * Nullable because most entries are seeded from the federation's service list
 * before anybody has cited the clause, and a fabricated citation would be worse
 * than an empty one.
 */
export const feeCatalogueEntries = pgTable('fee_catalogue_entries', {
  id: serial('id').primaryKey(),
  code: text('code').notNull(),                    // MMAKF-FEE-MEM-ATHLETE
  slug: text('slug').notNull(),                    // membership-athlete
  name: text('name').notNull(),
  category: feeServiceCategory('category').notNull(),
  audience: feeAudience('audience').notNull(),
  unit: feeUnit('unit').notNull(),
  frequency: feeFrequency('frequency').notNull(),
  displayPolicy: feeDisplayPolicy('display_policy').notNull(),
  status: serviceStatus('status').notNull().default('draft'),

  serviceId: integer('service_id').references(() => services.id),
  description: text('description'),
  statutoryBasis: text('statutory_basis'),

  sortOrder: integer('sort_order').notNull().default(100),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('fee_catalogue_entries_code_uk').on(t.code),
  slugUk: uniqueIndex('fee_catalogue_entries_slug_uk').on(t.slug),
  categoryIdx: index('fee_catalogue_entries_category_idx').on(t.category),
  displayIdx: index('fee_catalogue_entries_display_idx').on(t.displayPolicy),
  statusIdx: index('fee_catalogue_entries_status_idx').on(t.status),
}));
