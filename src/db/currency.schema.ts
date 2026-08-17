// Currency, and the exchange rate an issued document keeps for ever.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO ASSUMPTIONS THIS FILE EXISTS TO DELETE
// ─────────────────────────────────────────────────────────────────────────────
//
// "A currency has 100 minor units." It does not. JPY, KRW and ISK have none —
// an amount is a whole yen. BHD, KWD, OMR and TND have a thousand. A codebase
// that divides by 100 to render money is wrong about seven currencies by
// construction, and wrong by a factor of ten or a hundred, which is the kind of
// wrong that reaches a customer. `minor_unit` is therefore NOT NULL with NO
// DEFAULT: the schema refuses to guess.
//
// "An exchange rate is a lookup." It is not. A rate is somebody's published
// number on a particular day, and by the time a customer queries an invoice it
// will have moved. If the invoice held a POINTER into this table, the amount
// owed would change every time the treasurer recorded Tuesday's rate. So it
// does not: src/db/currency.ts copies the rate ONTO the invoice at issue, and
// this table is only ever read to decide what to copy. The FK from invoices is
// provenance — "it came from that row" — never a recomputation path.
//
// INR is authoritative for domestic transactions and is stored in paise. Every
// other currency stores its own minor unit, which is what `minor_unit` is for.

import {
  pgTable, serial, text, integer, bigint, boolean, timestamp, date,
  uniqueIndex, index,
} from 'drizzle-orm/pg-core';
import { users } from './schema';

/**
 * ISO 4217 reference data.
 *
 * Seeded in migration 0015 with the standard's own codes and exponents, which
 * are a published international standard rather than a commercial decision —
 * the distinction that lets this table be populated while fee_rules,
 * tax_rate_versions and fx_rates all ship empty.
 *
 * `is_active` defaults to FALSE and only INR is seeded true. A row here means
 * "the standard defines this currency", not "MMAKF trades in it"; the second is
 * a decision a person makes.
 */
export const currencies = pgTable('currencies', {
  id: serial('id').primaryKey(),
  /** ISO 4217 alphabetic: INR, USD, JPY. Upper case, three letters. */
  code: text('code').notNull(),
  /** ISO 4217 numeric, as text so leading zeros survive: '036' is AUD. */
  numericCode: text('numeric_code'),
  name: text('name').notNull(),
  /** Conventional and advisory. Nothing computes with a symbol. */
  symbol: text('symbol'),
  /**
   * The ISO 4217 exponent. 2 for INR, 0 for JPY, 3 for KWD.
   *
   * No default, deliberately. See the header: a default of 2 is precisely the
   * assumption this column was added to remove.
   */
  minorUnit: integer('minor_unit').notNull(),
  isActive: boolean('is_active').notNull().default(false),
  /** Where the row's facts came from. 'ISO 4217' for everything seeded. */
  source: text('source').notNull().default('ISO 4217'),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeUk: uniqueIndex('currencies_code_uk').on(t.code),
}));

/**
 * One recorded exchange rate, versioned and attributed.
 *
 * `ratePpm` is MINOR UNITS OF THE QUOTE CURRENCY PER ONE MINOR UNIT OF THE
 * BASE, times 1,000,000.
 *
 * Defining it per MINOR unit rather than per major unit puts the two
 * currencies' differing exponents inside the stored number, so converting an
 * amount is exactly one call to applyFactor() in src/db/fees.ts — the only
 * place in this codebase a factor is applied — with no per-call-site rescaling
 * to get wrong. USD→INR at 83.25 is 83_250_000; JPY→INR at 0.55 rupees per yen
 * is 55_000_000, because one yen is one minor unit and 0.55 rupees is 55 paise.
 *
 * bigint, not integer. A rate between a high-value and a low-value currency
 * exceeds int4 — 1 KWD ≈ 50,000 IDR is 5 × 10^9 in these units against a
 * 2.1 × 10^9 ceiling — and the wrap would be silent.
 *
 * `rateText` keeps the source's own decimal string. Parts-per-million is a
 * lossy representation of a very small rate, and an auditor asking what the
 * bulletin actually said deserves the bulletin's answer rather than ours.
 *
 * `source` and `retrievedAt` are NOT NULL. A rate with no provenance is a
 * number somebody typed, and it will be challenged eventually.
 */
export const fxRates = pgTable('fx_rates', {
  id: serial('id').primaryKey(),
  baseCode: text('base_code').notNull(),
  quoteCode: text('quote_code').notNull(),
  /** Monotonic per pair. A correction is a new version, never an edit. */
  version: integer('version').notNull(),
  ratePpm: bigint('rate_ppm', { mode: 'number' }).notNull(),
  rateText: text('rate_text'),
  /** Who published it: 'rbi_reference', 'ecb', 'bank_advice', 'manual_entry'. */
  source: text('source').notNull(),
  /** The bulletin, URL or reference number the figure was taken from. */
  sourceRef: text('source_ref'),
  retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull(),
  /** The day the rate applies from. Distinct from when we fetched it. */
  effectiveOn: date('effective_on').notNull(),
  recordedByUserId: integer('recorded_by_user_id').references(() => users.id),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pairVersionUk: uniqueIndex('fx_rates_pair_version_uk').on(t.baseCode, t.quoteCode, t.version),
  pairEffectiveIdx: index('fx_rates_pair_effective_idx').on(t.baseCode, t.quoteCode, t.effectiveOn),
}));
