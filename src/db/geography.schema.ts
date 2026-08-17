// Civil geography — the location engine.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DISTINCTION THIS FILE EXISTS TO MAKE
// ─────────────────────────────────────────────────────────────────────────────
//
// `state_units` and `district_units` in ./schema.ts are the register of
// CHARTERED MMAKF BODIES. A row exists there when the federation has chartered
// a unit. They are not a map.
//
// The tables here are the map. They say where places ARE — independently of
// whether MMAKF has any presence there — and they carry no foreign key to the
// unit register in either direction. That absence is deliberate and load-
// bearing: the moment a district row points at a state unit, "where does this
// person live" and "whose authority covers this person" become the same
// column, and the federation loses the ability to record a member in a state it
// has not yet chartered. Which is every state it is trying to expand into.
//
// The join between the two ladders is a lookup somebody MAINTAINS, and it is a
// federation decision each time. It is not modelled as an equality here because
// it is not one.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE TABLE, NOT FOUR
// ─────────────────────────────────────────────────────────────────────────────
//
// countries → states → districts → cities is the obvious shape and it hard-
// codes one country's constitution. India breaks it immediately: districts
// contain sub-districts (tehsil, taluk, circle), a municipal corporation is not
// inside a district the way a village is, and wards sit below cities. An
// affiliate abroad would want prefectures or counties.
//
// `admin_areas` is self-referencing with a `level`, a `depth` and a MATERIALISED
// `path`. Arbitrary depth, one lookup to walk up, one prefix match to walk down,
// and the path is a canonical identifier that survives a rename.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY TABLE HERE SHIPS EMPTY
// ─────────────────────────────────────────────────────────────────────────────
//
// No country, state, district or postal code is seeded, for exactly the reason
// the fee framework, the tax tables and the currency tables ship empty: a
// plausible seeded row is indistinguishable six months later from one somebody
// verified, and a wrong district attached to ten thousand members is not a
// defect that any test finds. Rows arrive through the import path in
// src/db/geography.ts, which records the SOURCE of each one.

import {
  pgTable, serial, text, integer, timestamp, numeric,
  pgEnum, index, uniqueIndex,
} from 'drizzle-orm/pg-core';

// ─── Enums ──────────────────────────────────────────────────────────────────

/**
 * What a row IS. The ladder is not a fixed sequence — a country may use some of
 * these and not others — so nothing enforces that a district's parent is a
 * state. What IS enforced, in src/db/geography.ts, is that a child sits STRICTLY
 * BELOW its parent in this order. See LEVEL_RANK there.
 */
export const adminAreaLevel = pgEnum('admin_area_level', [
  'region', 'state', 'division', 'district', 'subdistrict', 'city', 'ward', 'locality',
]);

/**
 * Places change. A district is split, a city is renamed, a municipality is
 * dissolved into its neighbour. None of those is a DELETE: an address recorded
 * in 2019 has to keep resolving, so the old row stays and points at what it
 * became through `supersededByAreaId`.
 */
export const geoStatus = pgEnum('geo_status', ['active', 'merged', 'renamed', 'dissolved']);

// ─── Countries ──────────────────────────────────────────────────────────────

export const countries = pgTable('countries', {
  id: serial('id').primaryKey(),
  /** ISO 3166-1 alpha-2, uppercase. The key every other table quotes. */
  iso2: text('iso2').notNull(),
  iso3: text('iso3'),
  name: text('name').notNull(),
  phoneCode: text('phone_code'),
  defaultLanguage: text('default_language'),
  defaultTimezone: text('default_timezone'),
  status: geoStatus('status').notNull().default('active'),
  /**
   * Where the row came from — an ISO list, a government register, an
   * administrator's keyboard. Six months later nothing else can tell them
   * apart, and the difference decides whether the data can be trusted.
   */
  source: text('source'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  iso2Uk: uniqueIndex('countries_iso2_uk').on(t.iso2),
}));

// ─── Administrative areas ───────────────────────────────────────────────────

export const adminAreas = pgTable('admin_areas', {
  id: serial('id').primaryKey(),
  countryId: integer('country_id').notNull().references(() => countries.id),
  parentId: integer('parent_id'),
  level: adminAreaLevel('level').notNull(),
  /** Segment code, unique among siblings: `AS`, `KAMRUP-METRO`, `GUWAHATI`. */
  code: text('code').notNull(),
  /**
   * Dotted path from the country root: `AS.KAMRUP-METRO.GUWAHATI`.
   *
   * Materialised rather than computed. A recursive CTE per read is the one
   * query a register sized for 600 million people cannot afford to run on every
   * profile view, and the path doubles as the stable public identifier of a
   * place — it does not change when the display name does.
   */
  path: text('path').notNull(),
  depth: integer('depth').notNull(),
  name: text('name').notNull(),
  nativeName: text('native_name'),
  /**
   * The official statistical code where one exists (LGD, census). Nullable
   * because MMAKF has adopted no particular register; a NOT NULL would be this
   * file choosing one on the federation's behalf.
   */
  officialCode: text('official_code'),
  timezone: text('timezone'),
  status: geoStatus('status').notNull().default('active'),
  supersededByAreaId: integer('superseded_by_area_id'),
  source: text('source'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pathUk: uniqueIndex('admin_areas_path_uk').on(t.countryId, t.path),
  parentIdx: index('admin_areas_parent_idx').on(t.parentId),
  levelIdx: index('admin_areas_level_idx').on(t.countryId, t.level),
  // Declared in SQL with text_pattern_ops; drizzle has no expression for that
  // and it matters — without the operator class, `LIKE 'AS.%'` will not use the
  // index under any non-C collation, which is every real deployment.
  pathPrefixIdx: index('admin_areas_path_prefix_idx').on(t.path),
}));

// ─── Aliases ────────────────────────────────────────────────────────────────

/**
 * Alternate spellings, historical names and transliterations.
 *
 * NOT unique on the normalised form. `Kamrup` is a district AND a city;
 * `Hyderabad` is in two countries. Making it unique would force this file to
 * pick a winner and would make `resolveArea()` return a confident wrong answer
 * instead of asking. Ambiguity is representable here on purpose.
 */
export const geoAliases = pgTable('geo_aliases', {
  id: serial('id').primaryKey(),
  countryId: integer('country_id').notNull().references(() => countries.id),
  areaId: integer('area_id').notNull().references(() => adminAreas.id),
  alias: text('alias').notNull(),
  /** Written by normaliseName() so every lookup uses the same transformation. */
  normalized: text('normalized').notNull(),
  /** `official` | `historical` | `transliteration` | `colloquial`. */
  kind: text('kind'),
  source: text('source'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  lookupIdx: index('geo_aliases_lookup_idx').on(t.countryId, t.normalized),
  areaUk: uniqueIndex('geo_aliases_area_uk').on(t.areaId, t.normalized),
}));

// ─── Postal codes ───────────────────────────────────────────────────────────

/**
 * A link table, because the relationship is many-to-many in both directions: an
 * Indian PIN code routinely spans several localities, and a city holds hundreds
 * of codes. A `postal_code` column on `admin_areas` would be able to record
 * only one of them.
 */
export const postalCodes = pgTable('postal_codes', {
  id: serial('id').primaryKey(),
  countryId: integer('country_id').notNull().references(() => countries.id),
  code: text('code').notNull(),
  areaId: integer('area_id').notNull().references(() => adminAreas.id),
  source: text('source'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uk: uniqueIndex('postal_codes_uk').on(t.countryId, t.code, t.areaId),
  codeIdx: index('postal_codes_code_idx').on(t.countryId, t.code),
}));

// ─── Addresses ──────────────────────────────────────────────────────────────

export const addressPrecision = pgEnum('address_precision', [
  'exact', 'locality', 'area', 'unknown',
]);

export const addressKind = pgEnum('address_kind', [
  'home', 'postal', 'training', 'work', 'billing',
]);

/**
 * An address is IMMUTABLE CONTENT.
 *
 * Correcting one writes a NEW row and re-links the subject; the old row stays.
 * A certificate posted in 2024 was posted somewhere, and an address that has
 * been edited in place can no longer say where.
 *
 * `localityText` keeps what the applicant actually typed, beside the area it
 * resolved to. When the two later disagree — a district is split, an alias is
 * corrected — the original words are still there to re-resolve from, which is
 * the difference between fixing the data and guessing at it.
 */
export const addresses = pgTable('addresses', {
  id: serial('id').primaryKey(),
  countryId: integer('country_id').notNull().references(() => countries.id),
  /** The LOWEST area confidently known. Null is honest, not missing. */
  areaId: integer('area_id').references(() => adminAreas.id),
  line1: text('line1'),
  line2: text('line2'),
  landmark: text('landmark'),
  localityText: text('locality_text'),
  postalCode: text('postal_code'),
  // numeric, not double precision. A coordinate that drifts in its last decimal
  // place on every round-trip is a coordinate nothing can compare for equality.
  latitude: numeric('latitude', { precision: 9, scale: 6 }),
  longitude: numeric('longitude', { precision: 9, scale: 6 }),
  precision: addressPrecision('precision').notNull().default('unknown'),
  timezone: text('timezone'),
  source: text('source'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  areaIdx: index('addresses_area_idx').on(t.areaId),
  postalIdx: index('addresses_postal_idx').on(t.countryId, t.postalCode),
}));
