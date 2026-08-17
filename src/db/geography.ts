// The location engine — loading the map, and resolving what people type onto it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE THING THIS MODULE WILL NOT DO
// ─────────────────────────────────────────────────────────────────────────────
//
// IT WILL NOT GUESS. `resolveArea()` returns one of three outcomes — resolved,
// AMBIGUOUS, or unknown — and the middle one is the reason this module exists
// in the shape it does.
//
// The tempting design is a resolver that returns the best match. It looks
// helpful and it is how a national register quietly fills with wrong districts:
// somebody types "Kamrup", which is both a district and a city inside that
// district, and a best-match resolver picks whichever row the index happened to
// return first. Nobody sees an error. The member is filed one level off, the
// state report undercounts by however many people did that, and there is no
// signal anywhere that anything went wrong — the field is populated, and a
// populated field looks correct.
//
// So ambiguity is a RETURN VALUE. Callers on an interactive path ask; callers
// on an import path record the row as unresolved and move on with
// `localityText` preserved, which is what makes it re-resolvable later.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE MAP IS NOT THE FEDERATION
// ─────────────────────────────────────────────────────────────────────────────
//
// Nothing here reads or writes `state_units` / `district_units`. Those are the
// register of chartered MMAKF bodies; these are places. A member who lives in a
// state MMAKF has not chartered must still be recordable — they are the person
// the federation is trying to reach — and joining the two ladders would make
// that unrepresentable. See the header of ./geography.schema.ts.
//
// ─────────────────────────────────────────────────────────────────────────────
// SCALE
// ─────────────────────────────────────────────────────────────────────────────
//
// The register is designed for 600M+ people, so nothing below offers OFFSET.
// `descendants()` and `search()` are KEYSET paginated on (path) and (id): the
// caller passes the last row it saw. Deep OFFSET on a national table reads and
// discards every skipped row, and page 900 of an admin list is exactly where an
// unbounded scan is first noticed — by everybody at once.

import { and, asc, eq, gt, inArray, isNull, like, or, sql } from 'drizzle-orm';
import * as g from './geography.schema';
import { writeAudit, type AuditContext } from './federation';
import { isUniqueViolation } from './pgerror';
import { assertCanAnywhere } from '@/lib/rbac';

type DB = any;

export class GeographyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GeographyError';
    this.code = code;
  }
}

/** Shape check, not `instanceof` — see the note in src/lib/workflow.ts. */
export function isGeographyError(err: unknown): err is GeographyError {
  return !!err && typeof err === 'object' && (err as any).name === 'GeographyError'
    && typeof (err as any).code === 'string';
}

// ─── The ladder ─────────────────────────────────────────────────────────────

export type AreaLevel = (typeof g.adminAreaLevel.enumValues)[number];

/**
 * Rank within the ladder. A child must sit STRICTLY BELOW its parent.
 *
 * Not every country uses every rung, which is why the rule is "strictly below"
 * rather than "exactly one below": an Indian city may hang directly off a
 * district with no sub-district in between, and requiring the intermediate rung
 * would force importers to invent one.
 *
 * What it does refuse is a district inside a city, or a state inside a state.
 * Those are not variations in national practice; they are import bugs, and
 * without this check they produce a tree that renders as a plausible hierarchy
 * and aggregates wrongly for ever.
 */
const LEVEL_RANK: Record<AreaLevel, number> = {
  region: 1, state: 2, division: 3, district: 4,
  subdistrict: 5, city: 6, ward: 7, locality: 8,
};

/**
 * The single normalisation used on BOTH sides of every lookup.
 *
 * One function, called on write and on read, because a normaliser that differs
 * between the two is a lookup that silently never matches — and the symptom is
 * "search finds nothing", which reads as missing data rather than as a bug.
 *
 * Diacritics are folded, then everything that is not a letter or digit is
 * dropped: `Guwahāti`, `GUWAHATI` and `guwahati ` all become `guwahati`.
 */
export function normaliseName(input: string | null | undefined): string {
  return String(input ?? '')
    .normalize('NFD')
    // The combining-marks block, written as escapes rather than as the literal
    // characters. Literal combining marks in source are invisible, and an
    // editor or a patch that eats one turns this into a class nobody can read
    // and no test would catch — the normaliser would simply stop folding.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** A path segment: uppercase, spaces to hyphens, nothing exotic. */
export function segmentCode(input: string): string {
  const code = String(input ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!code) throw new GeographyError('bad_code', 'An area code cannot be empty.');
  // The path is dot-separated, so a dot inside a segment would make the path
  // ambiguous and every prefix query wrong. The replace above already removes
  // them; this is the assertion that keeps that true if the replace changes.
  if (code.includes('.')) throw new GeographyError('bad_code', 'An area code may not contain a dot.');
  return code;
}

// ─── Countries ──────────────────────────────────────────────────────────────

export interface CountryInput {
  iso2: string;
  iso3?: string | null;
  name: string;
  phoneCode?: string | null;
  defaultLanguage?: string | null;
  defaultTimezone?: string | null;
  /** Where the row came from. Required — see the note on the column. */
  source: string;
}

/**
 * Insert a country, or update the one already there.
 *
 * Upsert rather than insert-only because loading a reference list is an
 * operation that gets RE-RUN — a corrected ISO file, a second region added — and
 * an importer that fails on the second run is an importer nobody runs twice.
 */
export async function upsertCountry(
  db: DB,
  ctx: AuditContext,
  input: CountryInput
): Promise<{ id: number; created: boolean }> {
  assertCanAnywhere(ctx.principal, 'geo:write');

  const iso2 = String(input.iso2 ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(iso2)) {
    throw new GeographyError('bad_iso2', 'A country code must be two letters (ISO 3166-1 alpha-2).');
  }
  if (!String(input.name ?? '').trim()) {
    throw new GeographyError('bad_name', 'A country needs a name.');
  }
  if (!String(input.source ?? '').trim()) {
    throw new GeographyError('no_source', 'Every geography row must record where it came from.');
  }

  const existing = (await db.select({ id: g.countries.id })
    .from(g.countries).where(eq(g.countries.iso2, iso2)).limit(1))[0];

  if (existing) {
    await db.update(g.countries).set({
      iso3: input.iso3 ?? null,
      name: input.name.trim(),
      phoneCode: input.phoneCode ?? null,
      defaultLanguage: input.defaultLanguage ?? null,
      defaultTimezone: input.defaultTimezone ?? null,
      source: input.source,
      updatedAt: new Date(),
    }).where(eq(g.countries.id, existing.id));
    await writeAudit(db, ctx, {
      entityType: 'country', entityId: existing.id, action: 'update',
      newValue: { iso2, name: input.name, source: input.source },
    });
    return { id: existing.id, created: false };
  }

  const rows = await db.insert(g.countries).values({
    iso2, iso3: input.iso3 ?? null, name: input.name.trim(),
    phoneCode: input.phoneCode ?? null,
    defaultLanguage: input.defaultLanguage ?? null,
    defaultTimezone: input.defaultTimezone ?? null,
    source: input.source,
  }).returning({ id: g.countries.id });

  await writeAudit(db, ctx, {
    entityType: 'country', entityId: rows[0].id, action: 'create',
    newValue: { iso2, name: input.name, source: input.source },
  });
  return { id: rows[0].id, created: true };
}

export async function countryByIso2(db: DB, iso2: string) {
  const rows = await db.select().from(g.countries)
    .where(eq(g.countries.iso2, String(iso2 ?? '').trim().toUpperCase())).limit(1);
  return rows[0] ?? null;
}

// ─── Areas ──────────────────────────────────────────────────────────────────

export interface AreaInput {
  countryId: number;
  /** Null for a top-level area (a state, or whatever the country's top rung is). */
  parentId?: number | null;
  level: AreaLevel;
  /** Segment code. Derived from the name when absent. */
  code?: string | null;
  name: string;
  nativeName?: string | null;
  officialCode?: string | null;
  timezone?: string | null;
  source: string;
}

/**
 * Add an area, deriving its path and depth from its parent.
 *
 * THE CALLER NEVER SUPPLIES THE PATH. It is computed here from the parent's
 * path plus this row's segment, because a caller-supplied path is a caller-
 * supplied lie waiting to happen: one importer writing `AS.KAMRUP` while the
 * parent's real path is `AS.KAMRUP-METRO` produces a subtree that every prefix
 * query silently omits.
 *
 * Idempotent on (country, path): re-running an import returns the existing row
 * rather than failing, and updates the mutable fields.
 */
export async function upsertArea(
  db: DB,
  ctx: AuditContext,
  input: AreaInput
): Promise<{ id: number; path: string; created: boolean }> {
  assertCanAnywhere(ctx.principal, 'geo:write');

  if (!String(input.name ?? '').trim()) throw new GeographyError('bad_name', 'An area needs a name.');
  if (!String(input.source ?? '').trim()) {
    throw new GeographyError('no_source', 'Every geography row must record where it came from.');
  }
  if (!LEVEL_RANK[input.level]) {
    throw new GeographyError('bad_level', `Unknown administrative level: ${String(input.level)}`);
  }

  const country = (await db.select({ id: g.countries.id, tz: g.countries.defaultTimezone })
    .from(g.countries).where(eq(g.countries.id, input.countryId)).limit(1))[0];
  if (!country) throw new GeographyError('unknown_country', 'Unknown country.');

  const code = segmentCode(input.code || input.name);

  let parentPath = '';
  let depth = 1;
  let timezone = input.timezone ?? country.tz ?? null;

  if (input.parentId != null) {
    const parent = (await db.select().from(g.adminAreas)
      .where(eq(g.adminAreas.id, input.parentId)).limit(1))[0];
    if (!parent) throw new GeographyError('unknown_parent', 'Unknown parent area.');
    if (parent.countryId !== input.countryId) {
      // The same class of defect resolvePlacement() guards in federation.ts:
      // two ids that each exist and do not belong together.
      throw new GeographyError('parent_country_mismatch',
        'The parent area belongs to a different country.');
    }
    if (LEVEL_RANK[parent.level as AreaLevel] >= LEVEL_RANK[input.level]) {
      throw new GeographyError('level_inversion',
        `A ${input.level} cannot sit inside a ${parent.level}.`);
    }
    parentPath = parent.path;
    depth = parent.depth + 1;
    if (!input.timezone) timezone = parent.timezone ?? timezone;
  }

  const path = parentPath ? `${parentPath}.${code}` : code;

  const found = (await db.select({ id: g.adminAreas.id }).from(g.adminAreas)
    .where(and(eq(g.adminAreas.countryId, input.countryId), eq(g.adminAreas.path, path)))
    .limit(1))[0];

  if (found) {
    await db.update(g.adminAreas).set({
      name: input.name.trim(),
      nativeName: input.nativeName ?? null,
      officialCode: input.officialCode ?? null,
      timezone,
      source: input.source,
      updatedAt: new Date(),
    }).where(eq(g.adminAreas.id, found.id));
    return { id: found.id, path, created: false };
  }

  let id: number;
  try {
    const rows = await db.insert(g.adminAreas).values({
      countryId: input.countryId,
      parentId: input.parentId ?? null,
      level: input.level,
      code, path, depth,
      name: input.name.trim(),
      nativeName: input.nativeName ?? null,
      officialCode: input.officialCode ?? null,
      timezone,
      source: input.source,
    }).returning({ id: g.adminAreas.id });
    id = rows[0].id;
  } catch (err) {
    // Two importers inserting the same area at once. The loser reads the
    // winner's row — the same resolution createPersonForSource() uses, because
    // failing an import on a benign race is how imports acquire a reputation
    // for being unreliable.
    if (!isUniqueViolation(err)) throw err;
    const raced = (await db.select({ id: g.adminAreas.id }).from(g.adminAreas)
      .where(and(eq(g.adminAreas.countryId, input.countryId), eq(g.adminAreas.path, path)))
      .limit(1))[0];
    if (!raced) throw err;
    return { id: raced.id, path, created: false };
  }

  // The name is itself an alias. Without this, an area loaded with no explicit
  // alias row is invisible to the resolver — which would make the resolver
  // useless on a freshly imported map, and the failure would look like the
  // import having silently done nothing.
  await addAlias(db, ctx, { areaId: id, alias: input.name.trim(), kind: 'official', source: input.source });

  await writeAudit(db, ctx, {
    entityType: 'admin_area', entityId: id, action: 'create',
    newValue: { path, level: input.level, name: input.name, source: input.source },
  });
  return { id, path, created: true };
}

export interface AliasInput {
  areaId: number;
  alias: string;
  kind?: string | null;
  source: string;
}

/** Record an alternate spelling. Repeating one is a no-op, not an error. */
export async function addAlias(db: DB, ctx: AuditContext, input: AliasInput): Promise<void> {
  assertCanAnywhere(ctx.principal, 'geo:write');

  const normalized = normaliseName(input.alias);
  if (!normalized) throw new GeographyError('bad_alias', 'An alias must contain letters or digits.');

  const area = (await db.select({ countryId: g.adminAreas.countryId }).from(g.adminAreas)
    .where(eq(g.adminAreas.id, input.areaId)).limit(1))[0];
  if (!area) throw new GeographyError('unknown_area', 'Unknown area.');

  await db.insert(g.geoAliases).values({
    countryId: area.countryId,
    areaId: input.areaId,
    alias: input.alias.trim(),
    normalized,
    kind: input.kind ?? null,
    source: input.source,
  }).onConflictDoNothing({ target: [g.geoAliases.areaId, g.geoAliases.normalized] });
}

/** Attach a postal code to an area. Many-to-many, so repeating is a no-op. */
export async function linkPostalCode(
  db: DB,
  ctx: AuditContext,
  input: { countryId: number; code: string; areaId: number; source: string }
): Promise<void> {
  assertCanAnywhere(ctx.principal, 'geo:write');

  const code = String(input.code ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!code) throw new GeographyError('bad_postal', 'A postal code cannot be empty.');

  const area = (await db.select({ countryId: g.adminAreas.countryId }).from(g.adminAreas)
    .where(eq(g.adminAreas.id, input.areaId)).limit(1))[0];
  if (!area) throw new GeographyError('unknown_area', 'Unknown area.');
  if (area.countryId !== input.countryId) {
    throw new GeographyError('postal_country_mismatch',
      'The area belongs to a different country from the postal code.');
  }

  await db.insert(g.postalCodes).values({
    countryId: input.countryId, code, areaId: input.areaId, source: input.source,
  }).onConflictDoNothing({
    target: [g.postalCodes.countryId, g.postalCodes.code, g.postalCodes.areaId],
  });
}

// ─── Resolution ─────────────────────────────────────────────────────────────

export interface ResolvedArea {
  id: number;
  path: string;
  level: AreaLevel;
  name: string;
  countryId: number;
}

export type Resolution =
  | { status: 'resolved'; area: ResolvedArea; via: 'alias' | 'postal' }
  /** More than one place answers to that name. The caller must ASK. */
  | { status: 'ambiguous'; candidates: ResolvedArea[] }
  | { status: 'unknown' };

/**
 * Turn what somebody typed into a canonical area, or say honestly that it
 * cannot be done.
 *
 * `within` narrows the search to a subtree — the parameter that resolves most
 * real ambiguity, because a registration form knows the state before it asks
 * for the district. `level` narrows by rung, for an importer that knows it is
 * reading a district column.
 *
 * A postal code, when supplied and when it maps to exactly one area, WINS over
 * the typed name. It is the more precise signal, and the one the person is
 * least likely to have spelled creatively.
 */
export async function resolveArea(
  db: DB,
  input: {
    countryId: number;
    text?: string | null;
    postalCode?: string | null;
    /** Restrict to descendants of this area. */
    within?: number | null;
    level?: AreaLevel | null;
  }
): Promise<Resolution> {
  if (input.postalCode) {
    const byPost = await areasForPostalCode(db, input.countryId, input.postalCode);
    if (byPost.length === 1) return { status: 'resolved', area: byPost[0], via: 'postal' };
    if (byPost.length > 1) {
      // A PIN code spanning several localities is normal. If the caller also
      // named a level, that usually collapses it to one.
      const narrowed = input.level ? byPost.filter((a) => a.level === input.level) : byPost;
      if (narrowed.length === 1) return { status: 'resolved', area: narrowed[0], via: 'postal' };
      if (!input.text) return { status: 'ambiguous', candidates: narrowed };
    }
  }

  const normalized = normaliseName(input.text);
  if (!normalized) return { status: 'unknown' };

  let prefix: string | null = null;
  if (input.within != null) {
    const parent = (await db.select({ path: g.adminAreas.path }).from(g.adminAreas)
      .where(eq(g.adminAreas.id, input.within)).limit(1))[0];
    if (!parent) throw new GeographyError('unknown_area', 'Unknown containing area.');
    prefix = `${parent.path}.`;
  }

  const conditions = [
    eq(g.geoAliases.countryId, input.countryId),
    eq(g.geoAliases.normalized, normalized),
    // A dissolved district must not be handed back as a live answer. It is
    // still reachable through currentArea() when an old address points at it.
    eq(g.adminAreas.status, 'active'),
  ];
  if (input.level) conditions.push(eq(g.adminAreas.level, input.level));
  if (prefix) conditions.push(like(g.adminAreas.path, `${prefix}%`));

  const rows = await db
    .select({
      id: g.adminAreas.id, path: g.adminAreas.path, level: g.adminAreas.level,
      name: g.adminAreas.name, countryId: g.adminAreas.countryId,
    })
    .from(g.geoAliases)
    .innerJoin(g.adminAreas, eq(g.adminAreas.id, g.geoAliases.areaId))
    .where(and(...conditions))
    // Bounded. An alias matching thousands of areas is a corrupt import, and the
    // resolver should return "ambiguous" quickly rather than materialise it.
    .limit(25);

  // The same area can carry several aliases that normalise identically only if
  // a caller inserted them before the unique index existed; dedupe defensively
  // so a data artefact never reads as ambiguity.
  const seen = new Map<number, ResolvedArea>();
  for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r as ResolvedArea);
  const candidates = [...seen.values()];

  if (candidates.length === 1) return { status: 'resolved', area: candidates[0], via: 'alias' };
  if (candidates.length > 1) return { status: 'ambiguous', candidates };
  return { status: 'unknown' };
}

export async function areasForPostalCode(
  db: DB,
  countryId: number,
  code: string
): Promise<ResolvedArea[]> {
  const clean = String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!clean) return [];
  return db
    .select({
      id: g.adminAreas.id, path: g.adminAreas.path, level: g.adminAreas.level,
      name: g.adminAreas.name, countryId: g.adminAreas.countryId,
    })
    .from(g.postalCodes)
    .innerJoin(g.adminAreas, eq(g.adminAreas.id, g.postalCodes.areaId))
    .where(and(
      eq(g.postalCodes.countryId, countryId),
      eq(g.postalCodes.code, clean),
      eq(g.adminAreas.status, 'active'),
    ))
    .limit(25);
}

// ─── Walking the tree ───────────────────────────────────────────────────────

/**
 * Every ancestor, root first, then the area itself.
 *
 * One query, from the materialised path — which is the whole reason the path is
 * materialised. The recursive-CTE alternative is correct and is the query a
 * national register cannot afford on every profile view.
 */
export async function ancestry(db: DB, areaId: number) {
  const area = (await db.select().from(g.adminAreas).where(eq(g.adminAreas.id, areaId)).limit(1))[0];
  if (!area) return [];

  const segments = String(area.path).split('.');
  const paths: string[] = [];
  for (let i = 1; i <= segments.length; i++) paths.push(segments.slice(0, i).join('.'));

  const rows = await db.select().from(g.adminAreas)
    .where(and(eq(g.adminAreas.countryId, area.countryId), inArray(g.adminAreas.path, paths)));

  return rows.sort((a: any, b: any) => a.depth - b.depth);
}

/** Immediate children, alphabetically. */
export async function childrenOf(db: DB, areaId: number | null, countryId?: number) {
  const where = areaId == null
    ? and(isNull(g.adminAreas.parentId), countryId ? eq(g.adminAreas.countryId, countryId) : undefined)
    : eq(g.adminAreas.parentId, areaId);
  return db.select().from(g.adminAreas).where(where).orderBy(asc(g.adminAreas.name));
}

/**
 * Everything beneath an area, KEYSET paginated on path.
 *
 * `afterPath` is the last path the caller saw, not a page number. Offset
 * pagination on a table sized for a national register reads and discards every
 * skipped row; at page 900 that is the whole table, and the cost lands on
 * whoever happened to scroll furthest.
 */
export async function descendants(
  db: DB,
  areaId: number,
  opts: { level?: AreaLevel | null; limit?: number; afterPath?: string | null } = {}
) {
  const area = (await db.select({ path: g.adminAreas.path, countryId: g.adminAreas.countryId })
    .from(g.adminAreas).where(eq(g.adminAreas.id, areaId)).limit(1))[0];
  if (!area) throw new GeographyError('unknown_area', 'Unknown area.');

  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const conditions = [
    eq(g.adminAreas.countryId, area.countryId),
    like(g.adminAreas.path, `${area.path}.%`),
  ];
  if (opts.level) conditions.push(eq(g.adminAreas.level, opts.level));
  if (opts.afterPath) conditions.push(gt(g.adminAreas.path, opts.afterPath));

  return db.select().from(g.adminAreas)
    .where(and(...conditions))
    .orderBy(asc(g.adminAreas.path))
    .limit(limit);
}

/**
 * Follow a superseded area to whatever it became.
 *
 * An address recorded in 2019 points at a district that may since have been
 * split. The old row is not deleted, so the address still resolves; this is how
 * a caller gets from it to the current one. Bounded, because a cycle in the
 * chain — which is an import bug, not an impossibility — would otherwise hang
 * the request rather than fail it.
 */
export async function currentArea(db: DB, areaId: number, hops = 8) {
  let current = (await db.select().from(g.adminAreas).where(eq(g.adminAreas.id, areaId)).limit(1))[0];
  const seen = new Set<number>();
  let n = 0;
  while (current && current.supersededByAreaId != null && n++ < hops) {
    if (seen.has(current.id)) {
      throw new GeographyError('supersession_cycle',
        `Area ${current.id} is part of a supersession cycle.`);
    }
    seen.add(current.id);
    const next = (await db.select().from(g.adminAreas)
      .where(eq(g.adminAreas.id, current.supersededByAreaId)).limit(1))[0];
    if (!next) break;
    current = next;
  }
  return current ?? null;
}

/**
 * Mark an area as having become another — split, merged or renamed.
 *
 * Never a DELETE and never an edit of the old row's name: both would rewrite
 * history, and an address filed under the old district would then describe a
 * place that, as far as the database is concerned, was always called something
 * else.
 */
export async function supersedeArea(
  db: DB,
  ctx: AuditContext,
  input: { areaId: number; becameAreaId: number; status: 'merged' | 'renamed' | 'dissolved'; reason: string }
): Promise<void> {
  assertCanAnywhere(ctx.principal, 'geo:write');
  if (input.areaId === input.becameAreaId) {
    throw new GeographyError('self_supersession', 'An area cannot supersede itself.');
  }

  const [from, to] = await Promise.all([
    db.select().from(g.adminAreas).where(eq(g.adminAreas.id, input.areaId)).limit(1),
    db.select().from(g.adminAreas).where(eq(g.adminAreas.id, input.becameAreaId)).limit(1),
  ]);
  if (!from[0]) throw new GeographyError('unknown_area', 'Unknown area.');
  if (!to[0]) throw new GeographyError('unknown_area', 'Unknown successor area.');

  await db.update(g.adminAreas)
    .set({ status: input.status, supersededByAreaId: input.becameAreaId, updatedAt: new Date() })
    .where(eq(g.adminAreas.id, input.areaId));

  await writeAudit(db, ctx, {
    entityType: 'admin_area', entityId: input.areaId, action: 'update',
    oldValue: { status: from[0].status, path: from[0].path },
    newValue: { status: input.status, becamePath: to[0].path, reason: input.reason },
  });
}

// ─── Addresses ──────────────────────────────────────────────────────────────

export interface AddressInput {
  countryId: number;
  line1?: string | null;
  line2?: string | null;
  landmark?: string | null;
  /** What the person typed for their locality. Kept verbatim, always. */
  localityText?: string | null;
  postalCode?: string | null;
  /** Supply when already known; otherwise resolution is attempted. */
  areaId?: number | null;
  /** Narrow resolution to a subtree — the state a form already collected. */
  within?: number | null;
  latitude?: string | number | null;
  longitude?: string | number | null;
  source?: string | null;
}

export interface AddressResult {
  id: number;
  areaId: number | null;
  resolution: Resolution | null;
}

/**
 * Record an address, resolving its area where it can and SAYING SO when it
 * cannot.
 *
 * An unresolved address is stored, not rejected. Somebody living in a district
 * nobody has imported yet still has an address, and refusing it would make the
 * completeness of a reference table a precondition for registering a member.
 * `localityText` keeps their words, so the row can be re-resolved the day the
 * district is loaded — which is the whole reason that column exists.
 *
 * The caller gets the `Resolution` back, so an interactive form can ask about
 * an ambiguity that an importer will simply record and move past.
 */
export async function recordAddress(
  db: DB,
  input: AddressInput
): Promise<AddressResult> {
  const country = (await db.select({ id: g.countries.id, tz: g.countries.defaultTimezone })
    .from(g.countries).where(eq(g.countries.id, input.countryId)).limit(1))[0];
  if (!country) throw new GeographyError('unknown_country', 'Unknown country.');

  let areaId = input.areaId ?? null;
  let resolution: Resolution | null = null;

  if (areaId == null && (input.localityText || input.postalCode)) {
    resolution = await resolveArea(db, {
      countryId: input.countryId,
      text: input.localityText ?? null,
      postalCode: input.postalCode ?? null,
      within: input.within ?? null,
    });
    if (resolution.status === 'resolved') areaId = resolution.area.id;
  }

  let timezone: string | null = country.tz ?? null;
  let precision: (typeof g.addressPrecision.enumValues)[number] = 'unknown';
  if (areaId != null) {
    const area = (await db.select({ timezone: g.adminAreas.timezone, level: g.adminAreas.level })
      .from(g.adminAreas).where(eq(g.adminAreas.id, areaId)).limit(1))[0];
    if (area) {
      timezone = area.timezone ?? timezone;
      // Precision describes HOW WELL THE PLACE IS PINNED, and it is derived
      // rather than accepted from the caller: a caller asserting 'exact' about a
      // district-level match is the misinformation this column exists to avoid.
      const rank = LEVEL_RANK[area.level as AreaLevel];
      precision = rank >= LEVEL_RANK.locality ? 'exact'
        : rank >= LEVEL_RANK.city ? 'locality'
        : 'area';
    }
  }

  const rows = await db.insert(g.addresses).values({
    countryId: input.countryId,
    areaId,
    line1: input.line1 ?? null,
    line2: input.line2 ?? null,
    landmark: input.landmark ?? null,
    localityText: input.localityText ?? null,
    postalCode: input.postalCode
      ? String(input.postalCode).trim().toUpperCase().replace(/\s+/g, '')
      : null,
    latitude: input.latitude == null ? null : String(input.latitude),
    longitude: input.longitude == null ? null : String(input.longitude),
    precision,
    timezone,
    source: input.source ?? 'self_declared',
  }).returning({ id: g.addresses.id });

  return { id: rows[0].id, areaId, resolution };
}

/**
 * Addresses whose area never resolved — the re-resolution queue.
 *
 * This is the reason an unresolved address is stored rather than refused: the
 * backlog is VISIBLE and finite, and loading a missing district turns rows in
 * it into resolved ones. An import path that silently dropped the locality
 * would leave nothing to come back to.
 */
export async function unresolvedAddresses(
  db: DB,
  opts: { countryId?: number | null; limit?: number; afterId?: number | null } = {}
) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const conditions = [isNull(g.addresses.areaId)];
  if (opts.countryId) conditions.push(eq(g.addresses.countryId, opts.countryId));
  if (opts.afterId) conditions.push(gt(g.addresses.id, opts.afterId));
  conditions.push(or(
    sql`${g.addresses.localityText} IS NOT NULL`,
    sql`${g.addresses.postalCode} IS NOT NULL`,
  ) as any);

  return db.select().from(g.addresses)
    .where(and(...conditions))
    .orderBy(asc(g.addresses.id))
    .limit(limit);
}
