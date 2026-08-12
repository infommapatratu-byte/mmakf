// THE VERSIONED PUBLIC API — /api/v1/*
//
// One surface, for people outside the federation: a state association's own
// website, a tournament organiser's software, a school checking a certificate,
// a journalist building a medal table. Everything it serves is already visible
// to anyone on the public pages; this route exists so that reading it does not
// require scraping HTML that is free to change.
//
// ── IT IS READ-ONLY, AND THAT IS A DECISION, NOT AN OMISSION ────────────────
//
// A public WRITE API needs four things MMAKF does not have: an API-key scheme
// with per-key identity, quotas per key, a revocation path when a key leaks,
// and an abuse story for what happens when one is used to spray entries at a
// championship. Building the endpoints first and the key scheme "later" would
// mean shipping unauthenticated writes into the federation's system of record,
// or authenticating them with the session cookie — which would make every
// consumer a CSRF vector and every integration a browser.
//
// So there is no POST, PUT, PATCH or DELETE here, and the 405 below says why
// rather than pretending the method is merely unsupported. Entries, grading
// applications and content edits go through the session-authenticated
// endpoints documented in docs/api/OPENAPI.md, from a browser, by a person.
//
// ── WHAT IS PUBLIC, AND WHO DECIDES ────────────────────────────────────────
//
// Not this file. Every visibility rule is imported from the module that already
// owns it, so this API cannot become a second, more generous definition of
// "public":
//
//   events / results   publicEventDetail() in the competition route — an event
//                      the federation has not published is not here, an
//                      unpublished draw is not here, and a PROVISIONAL result
//                      is not here. Only `final` and `corrected` placings, which
//                      are locked, ever appear.
//   dojos              publicDirectory() in src/db/affiliation.ts — no address,
//                      no telephone, no email, and no unit that never reached
//                      at least provisional affiliation.
//   officials          publicOfficialsDirectory() in src/db/officials.ts —
//                      active, unexpired licences only, and no contact details.
//   verification       the existing /api/verify handler, called directly, so
//                      the provenance labelling ("examined" vs "legacy") cannot
//                      drift between the two surfaces.
//
// Two reads have no module to call: the published-events LIST and the
// published-rankings LIST. Both are plain selects over rows the federation has
// published, filtered on nothing else, and both are flagged below with the
// shared-file change that would remove them.
//
// ── WHAT IS DELIBERATELY NARROWER THAN THE PAGE ────────────────────────────
//
// The per-competitor ENTRY ROSTER. /competitions publishes it once entries
// close, and this API could too without disclosing anything new — but a JSON
// roster of names, dojos and (for junior categories) implied ages is a bulk
// export in a way an HTML table is not, and no consumer has asked for one.
// `entryCount` is served instead. If the federation wants the roster published
// here, that is a decision for the federation, not a default.

import type { APIRoute } from 'astro';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { isConfigured, db, schema as s } from '@/db';
import { rateLimit } from '@/lib/ratelimit';
// The competition route owns the definition of a publicly visible event. This
// is the same list it filters on; src/lib/search.ts already carries a second
// copy with a note saying so. A third copy here would be one too many, so the
// existing export is imported rather than restated — see sharedFileEdits for
// the request to give this list a single home.
import { PUBLIC_EVENT_STATUSES } from '@/lib/search';
import { publicEventDetail } from '@/pages/api/competition/[...action]';
import { publicDirectory, type UnitKind } from '@/db/affiliation';
import { publicOfficialsDirectory, type Registry } from '@/db/officials';
// Verification is CALLED, not copied. Its three provenances and its refusal to
// fall back to the legacy register when a database is present are the whole
// value of the service, and a second implementation of them would be a second
// thing to keep honest.
import { GET as verifyEndpoint } from '@/pages/api/verify';

export const prerender = false;

const API_VERSION = '1';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ─── Wire ───────────────────────────────────────────────────────────────────

/**
 * CORS is wide open BECAUSE the API is anonymous and read-only.
 *
 * `Allow-Origin: *` is safe here precisely because credentials are never
 * accepted: this route does not call identify(), does not read a cookie, and
 * `Access-Control-Allow-Credentials` is deliberately absent — with it, a
 * wildcard origin would be rejected by browsers anyway, and without the
 * wildcard a signed-in visitor's session could be replayed by any site they
 * visit. Every response is therefore identical for every caller, which is also
 * what makes it cacheable at the edge.
 */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

/** Cache lifetimes chosen from how often the data behind them actually moves. */
const CACHE = {
  /** The fixture list gains an event occasionally; a status flips on match day. */
  events: 'public, max-age=60, s-maxage=300',
  /** One event's page changes through the day it is run. */
  event: 'public, max-age=30, s-maxage=60',
  /** A locked result never changes. A correction is a NEW row, so this is safe. */
  results: 'public, max-age=300, s-maxage=3600',
  /** A published ranking table is a snapshot and is never edited in place. */
  rankings: 'public, max-age=300, s-maxage=3600',
  /**
   * A charter or a licence can be SUSPENDED, and a directory that keeps saying
   * otherwise for an hour is the failure mode that matters here. Short.
   */
  directory: 'public, max-age=60, s-maxage=300',
  /** Revocation must be visible immediately. A verification is never cached. */
  verification: 'no-store',
  /** The service description, which changes when this file does. */
  index: 'public, max-age=300, s-maxage=3600',
} as const;

type Json = Record<string, unknown>;

function respond(status: number, body: Json, cacheControl: string, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl,
      ...CORS,
      ...(extraHeaders ?? {}),
    },
  });
}

/**
 * The success envelope. Every 200 from this API has exactly these keys.
 *
 * `generatedAt` is when the ORIGIN built the body, not when the caller received
 * it: a response served from an edge cache carries the timestamp of the
 * generation it came from, which is the honest reading of a cached document.
 */
function ok(data: unknown, opts: { cache: string; page?: Json; meta?: Json }): Response {
  const body: Json = {
    apiVersion: API_VERSION,
    data,
    meta: {
      generatedAt: new Date().toISOString(),
      ...(Array.isArray(data) ? { count: data.length } : {}),
      ...(opts.meta ?? {}),
    },
  };
  if (opts.page) body.page = opts.page;
  return respond(200, body, opts.cache, undefined);
}

/**
 * The error envelope: `error` is the sentence to show a person, `code` is the
 * token to branch on. Same two keys as the rest of the site's endpoints, so a
 * client written against one is not surprised by the other.
 */
function fail(status: number, code: string, error: string, extra?: Json): Response {
  return respond(status, { apiVersion: API_VERSION, error, code, ...(extra ?? {}) }, 'no-store');
}

/** Raised by the parsers below; caught once and turned into a 400. */
class BadInput extends Error {
  constructor(readonly code: string, message: string, readonly extra?: Json) {
    super(message);
  }
}

function requireDatabase(): Response | null {
  if (isConfigured()) return null;
  return fail(
    503,
    'database_not_configured',
    'The federation database is not configured on this deployment, so federation records cannot be read. This is not a statement about the record you asked for.'
  );
}

// ─── Pagination ─────────────────────────────────────────────────────────────
//
// CURSOR, not offset. An offset page re-reads the table from the top: a row
// inserted between two requests shifts everything after it, so a consumer
// walking a list silently skips or repeats records. Every cursor here is a
// keyset — the sort key of the last row returned — so an insertion elsewhere
// cannot move the boundary a caller already crossed.
//
// The cursor is base64url only to discourage clients from constructing one by
// hand. It is not a secret and it is not signed; it encodes nothing that is not
// already in the response body.

function encodeCursor(key: string): string {
  return Buffer.from(key, 'utf8').toString('base64url');
}

function decodeCursor(url: URL): string | null {
  const raw = url.searchParams.get('cursor');
  if (!raw) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    decoded = '';
  }
  // A cursor we cannot read is refused rather than ignored. Ignoring it would
  // silently restart the walk, and the caller would receive page 1 believing it
  // was page 4 — duplicated records, with nothing to indicate it happened.
  if (!decoded) throw new BadInput('invalid_cursor', 'That cursor is not one this API issued.');
  return decoded;
}

function parseLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new BadInput('invalid_limit', `"limit" must be a whole number between 1 and ${MAX_LIMIT}.`);
  }
  return n;
}

/** The page block, including a ready-made link so a client need not build one. */
function pageBlock(url: URL, limit: number, nextCursor: string | null): Json {
  let next: string | null = null;
  if (nextCursor) {
    const link = new URL(url.toString());
    link.searchParams.set('limit', String(limit));
    link.searchParams.set('cursor', nextCursor);
    next = `${link.pathname}${link.search}`;
  }
  return { limit, nextCursor, next };
}

/** Take `limit + 1` rows, and let the extra one answer "is there more?". */
function cut<T>(rows: T[], limit: number): { page: T[]; more: boolean } {
  return rows.length > limit ? { page: rows.slice(0, limit), more: true } : { page: rows, more: false };
}

function requireId(raw: string, what: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new BadInput('invalid_id', `"${raw}" is not a ${what} reference.`);
  }
  return n;
}

// ─── /api/v1 — the service description ──────────────────────────────────────

function serviceIndex(): Response {
  return ok(
    {
      name: 'MMAKF public API',
      version: API_VERSION,
      readOnly: true,
      // Stated in the payload, not only in prose: a consumer discovering this
      // API should not have to read a document to learn there is no write path.
      writeSupport:
        'None. A public write API requires an API-key scheme, per-key quotas and a revocation path, none of which exist. Writes go through the session-authenticated endpoints, from a browser, by a person.',
      authentication:
        'None. Everything served here is already public. Session cookies are ignored, and sending one changes nothing.',
      resources: [
        { path: '/api/v1/events', description: 'Competition events the federation has published.' },
        { path: '/api/v1/events/{id}', description: 'One published event, its categories and its final results.' },
        { path: '/api/v1/events/{id}/results', description: 'Locked results for one published event.' },
        { path: '/api/v1/rankings', description: 'Ranking tables the federation has published.' },
        { path: '/api/v1/rankings/{id}', description: 'One published ranking table.' },
        { path: '/api/v1/dojos', description: 'The affiliated units directory: dojos, districts, states.' },
        { path: '/api/v1/officials', description: 'The licensed officials, examiners and instructors register.' },
        { path: '/api/v1/verify/{number}', description: 'Credential verification by member id or certificate number.' },
      ],
      pagination: { style: 'cursor', parameters: ['limit', 'cursor'], defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT },
      // NOT a URL. `docs/` lives in the repository and is not copied into the
      // deployed output — `/docs/api/OPENAPI.md` resolves only because the dev
      // server serves the project root, and 404s on the deployment. Advertising
      // a link that is dead everywhere it matters is worse than admitting the
      // document is not published, so it is named as a repository path.
      documentation: 'docs/api/OPENAPI.md in the MMAKF repository. It is not served over HTTP.',
      methods: ['GET', 'HEAD', 'OPTIONS'],
    },
    { cache: CACHE.index }
  );
}

// ─── /api/v1/events ─────────────────────────────────────────────────────────

/** Exactly the columns the /competitions page already publishes. */
const EVENT_COLUMNS = {
  id: s.competitionEvents.id,
  code: s.competitionEvents.code,
  title: s.competitionEvents.title,
  kind: s.competitionEvents.kind,
  status: s.competitionEvents.status,
  startsOn: s.competitionEvents.startsOn,
  endsOn: s.competitionEvents.endsOn,
  venue: s.competitionEvents.venue,
  city: s.competitionEvents.city,
  registrationOpensAt: s.competitionEvents.registrationOpensAt,
  registrationClosesAt: s.competitionEvents.registrationClosesAt,
  sanctionReference: s.competitionEvents.sanctionReference,
  sanctionedAt: s.competitionEvents.sanctionedAt,
  rulesetVersion: s.competitionEvents.rulesetVersion,
  contactEmail: s.competitionEvents.contactEmail,
  contactPhone: s.competitionEvents.contactPhone,
  description: s.competitionEvents.description,
  resultsFinalisedAt: s.competitionEvents.resultsFinalisedAt,
};

/**
 * An event with no start date sorts last rather than first.
 *
 * `starts_on` is nullable — an event can be created before its dates are fixed —
 * and NULL sorts inconsistently between "ORDER BY" and a keyset comparison
 * unless it is given a value in both. The sentinel is used identically in the
 * ordering and in the cursor predicate, which is what keeps the walk stable.
 */
const EVENT_SORT_DATE = sql`coalesce(${s.competitionEvents.startsOn}, '9999-12-31'::date)`;

async function eventsList(url: URL): Promise<Response> {
  const limit = parseLimit(url);
  const cursor = decodeCursor(url);

  const conds: any[] = [];

  const statusParam = url.searchParams.get('status');
  if (statusParam) {
    const wanted = statusParam.split(',').map((x) => x.trim()).filter(Boolean);
    const bad = wanted.filter((x) => !(PUBLIC_EVENT_STATUSES as readonly string[]).includes(x));
    if (bad.length) {
      // Naming the permitted values matters more than naming the rejected one:
      // a status that exists but is not public (draft, sanction_review) must not
      // be reported differently from one that does not exist at all, or the
      // filter becomes an oracle for the unpublished calendar.
      throw new BadInput('invalid_status', 'That status is not one this API serves.', {
        allowed: [...PUBLIC_EVENT_STATUSES],
      });
    }
    conds.push(inArray(s.competitionEvents.status, wanted as any));
  } else {
    conds.push(inArray(s.competitionEvents.status, [...PUBLIC_EVENT_STATUSES] as any));
  }

  if (cursor) {
    const [date, id] = cursor.split('|');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d+$/.test(id ?? '')) {
      throw new BadInput('invalid_cursor', 'That cursor is not one this API issued.');
    }
    // A row-value comparison, so the two sort keys are compared as one tuple.
    // Written as `(a, b) > (x, y)` rather than the expanded OR form because the
    // expansion is where off-by-one page boundaries come from.
    conds.push(sql`(${EVENT_SORT_DATE}, ${s.competitionEvents.id}) > (${date}::date, ${Number(id)})`);
  }

  const rows = await db()
    .select(EVENT_COLUMNS)
    .from(s.competitionEvents)
    .where(and(...conds))
    .orderBy(sql`${EVENT_SORT_DATE} asc`, asc(s.competitionEvents.id))
    .limit(limit + 1);

  const { page, more } = cut(rows as any[], limit);
  const last = page[page.length - 1];
  const nextCursor = more && last ? encodeCursor(`${last.startsOn ?? '9999-12-31'}|${last.id}`) : null;

  return ok(page, { cache: CACHE.events, page: pageBlock(url, limit, nextCursor) });
}

async function eventDetail(rawId: string): Promise<Response> {
  const detail = await publicEventDetail(requireId(rawId, 'competition event'));
  // Null covers both "no such event" and "not published". Distinguishing them
  // would confirm the existence of an event the federation has not announced.
  if (!detail) return fail(404, 'not_found', 'No published event with that reference.');

  return ok(
    {
      event: detail.event,
      categories: detail.categories.map((c: any) => ({
        id: c.id,
        code: c.code,
        label: c.label,
        discipline: c.discipline,
        gender: c.gender,
        ageGroup: c.ageGroup,
        drawFormat: c.drawFormat,
        maxEntries: c.maxEntries,
        entryCount: c.entryCount,
        results: c.results,
      })),
    },
    {
      cache: CACHE.event,
      meta: {
        // Said in the payload so a consumer building a medal table knows the
        // absence of a placing means "not yet locked", not "nobody placed".
        resultsIncluded: 'final and corrected placings only; provisional placings are never served',
        entryRosterIncluded: false,
      },
    }
  );
}

async function eventResults(rawId: string): Promise<Response> {
  const detail = await publicEventDetail(requireId(rawId, 'competition event'));
  if (!detail) return fail(404, 'not_found', 'No published event with that reference.');

  const categories = detail.categories
    .map((c: any) => ({
      categoryId: c.id,
      code: c.code,
      label: c.label,
      discipline: c.discipline,
      gender: c.gender,
      ageGroup: c.ageGroup,
      placings: c.results,
    }))
    // A category with nothing locked is omitted rather than served as an empty
    // list, so "no placings" cannot be misread as "no medals were awarded".
    .filter((c: any) => c.placings.length > 0);

  return ok(
    {
      event: {
        id: detail.event.id,
        code: detail.event.code,
        title: detail.event.title,
        status: detail.event.status,
        resultsFinalisedAt: detail.event.resultsFinalisedAt,
      },
      categories,
    },
    {
      // Not paginated: one event's locked results are bounded by its category
      // list, and splitting a medal table across pages would invite a consumer
      // to publish half of one.
      cache: CACHE.results,
      meta: {
        resultsIncluded: 'final and corrected placings only; provisional placings are never served',
        categoriesWithoutLockedResults: detail.categories.length - categories.length,
      },
    }
  );
}

// ─── /api/v1/rankings ───────────────────────────────────────────────────────
//
// src/db/rankings.ts exposes compute, publish and explain, but nothing that
// LISTS published periods or reads a published table — /rankings does the same
// two selects in its own page loader for the same reason. Both are filtered on
// `published_at IS NOT NULL` and nothing else: computing a table is arithmetic,
// publishing it is a statement, and only the statement is public. See
// sharedFileEdits for the request to give this a home in the module.

async function rankingsList(url: URL): Promise<Response> {
  const limit = parseLimit(url);
  const cursor = decodeCursor(url);

  const conds: any[] = [isNotNull(s.rankingPeriods.publishedAt)];
  if (cursor) {
    const [ts, id] = cursor.split('|');
    const when = new Date(ts ?? '');
    if (Number.isNaN(when.getTime()) || !/^\d+$/.test(id ?? '')) {
      throw new BadInput('invalid_cursor', 'That cursor is not one this API issued.');
    }
    // Newest first, so the walk moves DOWN the ordering: `<`, not `>`.
    conds.push(
      sql`(${s.rankingPeriods.publishedAt}, ${s.rankingPeriods.id}) < (${when.toISOString()}::timestamptz, ${Number(id)})`
    );
  }

  const rows = await db()
    .select({
      id: s.rankingPeriods.id,
      label: s.rankingPeriods.label,
      categoryKey: s.rankingPeriods.categoryKey,
      computedAt: s.rankingPeriods.computedAt,
      publishedAt: s.rankingPeriods.publishedAt,
      athleteCount: s.rankingPeriods.athleteCount,
      eventCount: s.rankingPeriods.eventCount,
      rulesetCode: s.rankingRulesets.code,
      rulesetTitle: s.rankingRulesets.title,
    })
    .from(s.rankingPeriods)
    .innerJoin(s.rankingRulesets, eq(s.rankingPeriods.rulesetId, s.rankingRulesets.id))
    .where(and(...conds))
    .orderBy(desc(s.rankingPeriods.publishedAt), desc(s.rankingPeriods.id))
    .limit(limit + 1);

  const { page, more } = cut(rows as any[], limit);
  const last = page[page.length - 1];
  const nextCursor =
    more && last ? encodeCursor(`${new Date(last.publishedAt).toISOString()}|${last.id}`) : null;

  return ok(page, {
    cache: CACHE.rankings,
    page: pageBlock(url, limit, nextCursor),
    meta: {
      // `categoryKey` is `discipline|gender|ageGroup|weight`, weight in grams.
      // Documented here because a raw key with no legend is unusable.
      categoryKeyFormat: 'discipline|gender|ageGroup|weightGrams, with * meaning "any"',
    },
  });
}

async function rankingTable(rawId: string, url: URL): Promise<Response> {
  const periodId = requireId(rawId, 'ranking period');
  const limit = parseLimit(url);
  const cursor = decodeCursor(url);

  const period = (
    await db()
      .select({
        id: s.rankingPeriods.id,
        label: s.rankingPeriods.label,
        categoryKey: s.rankingPeriods.categoryKey,
        computedAt: s.rankingPeriods.computedAt,
        publishedAt: s.rankingPeriods.publishedAt,
        athleteCount: s.rankingPeriods.athleteCount,
        eventCount: s.rankingPeriods.eventCount,
        rulesetCode: s.rankingRulesets.code,
        rulesetTitle: s.rankingRulesets.title,
      })
      .from(s.rankingPeriods)
      .innerJoin(s.rankingRulesets, eq(s.rankingPeriods.rulesetId, s.rankingRulesets.id))
      // The publication filter is part of the LOOKUP, not applied afterwards, so
      // an unpublished table is indistinguishable from one that does not exist.
      .where(and(eq(s.rankingPeriods.id, periodId), isNotNull(s.rankingPeriods.publishedAt)))
      .limit(1)
  )[0] as any;

  if (!period) return fail(404, 'not_found', 'No published ranking table with that reference.');

  const conds: any[] = [eq(s.rankingEntries.periodId, periodId)];
  if (cursor) {
    const [rank, personId] = cursor.split('|');
    if (!/^\d+$/.test(rank ?? '') || !/^\d+$/.test(personId ?? '')) {
      throw new BadInput('invalid_cursor', 'That cursor is not one this API issued.');
    }
    // `rank` ties, so the person id breaks the tie and makes the walk total.
    conds.push(
      sql`(${s.rankingEntries.rank}, ${s.rankingEntries.personId}) > (${Number(rank)}, ${Number(personId)})`
    );
  }

  const rows = await db()
    .select({
      rank: s.rankingEntries.rank,
      points: s.rankingEntries.points,
      previousRank: s.rankingEntries.previousRank,
      personId: s.rankingEntries.personId,
      name: s.persons.fullName,
      federationId: s.persons.federationId,
    })
    .from(s.rankingEntries)
    .innerJoin(s.persons, eq(s.rankingEntries.personId, s.persons.id))
    .where(and(...conds))
    .orderBy(asc(s.rankingEntries.rank), asc(s.rankingEntries.personId))
    .limit(limit + 1);

  const { page, more } = cut(rows as any[], limit);
  const last = page[page.length - 1];
  const nextCursor = more && last ? encodeCursor(`${last.rank}|${last.personId}`) : null;

  return ok(
    {
      period,
      // `personId` is the cursor key and an internal row id; the federation id is
      // the identifier a consumer should quote, so only that is published.
      entries: page.map((e: any) => ({
        rank: e.rank,
        points: e.points,
        previousRank: e.previousRank,
        name: e.name,
        federationId: e.federationId,
      })),
    },
    {
      cache: CACHE.rankings,
      page: pageBlock(url, limit, nextCursor),
      meta: {
        count: page.length,
        // The working behind a ranking (`explainRanking`) requires `result:read`
        // and is offered on /rankings to callers who hold it. It is not public,
        // and saying so is better than leaving a consumer to wonder.
        workingAvailable: false,
        workingNote:
          'The contributions behind each total are held for every entry and are shown on /rankings to a caller holding result:read. They are not public and are not served here.',
      },
    }
  );
}

// ─── /api/v1/dojos ──────────────────────────────────────────────────────────

const UNIT_KINDS: readonly UnitKind[] = ['dojo', 'district', 'state'];

/**
 * How many units one page request is willing to read before it stops.
 *
 * publicDirectory() takes a CAP, not a cursor, so every page of /api/v1/dojos
 * re-reads the register from the top. The cap bounds that work; `scanTruncated`
 * in the response says when it bit, because a directory that quietly ends at
 * the cap is how the 5001st affiliated dojo stops existing.
 */
const DIRECTORY_SCAN_CAP = 5000;

/**
 * The directory module returns a whole sorted list rather than a page, so the
 * cursor is applied here, over its own unique `code`. That means each page
 * re-reads the register — acceptable at a national federation's scale, and
 * stated rather than hidden. A keyed page in the module would remove it.
 */
async function dojosList(url: URL): Promise<Response> {
  const limit = parseLimit(url);
  const cursor = decodeCursor(url);

  const requested = (url.searchParams.get('kind') || 'dojo').toLowerCase();
  if (!(UNIT_KINDS as readonly string[]).includes(requested)) {
    throw new BadInput('invalid_kind', '"kind" must be one of: dojo, district, state.', {
      allowed: [...UNIT_KINDS],
    });
  }

  // Defaults to true, matching /dojos: a parent whose child trains at a club
  // whose charter has lapsed must be told that, not shown an empty result they
  // will read as a typing mistake.
  const includeFormer = url.searchParams.get('includeFormer') !== 'false';

  const all = await publicDirectory(db(), {
    kind: requested as UnitKind,
    includeFormer,
    limit: DIRECTORY_SCAN_CAP,
  });

  const sorted = [...all].sort((a, b) => a.code.localeCompare(b.code));
  const start = cursor ? sorted.findIndex((u) => u.code > cursor) : 0;
  const slice = start < 0 ? [] : sorted.slice(start, start + limit + 1);
  const { page, more } = cut(slice, limit);
  const nextCursor = more && page.length ? encodeCursor(page[page.length - 1].code) : null;

  return ok(page, {
    cache: CACHE.directory,
    page: pageBlock(url, limit, nextCursor),
    meta: {
      kind: requested,
      includeFormer,
      // `matched` is what this scan saw, and `scanTruncated` says whether that
      // is the whole register. publicDirectory() takes a cap, not a page, so a
      // register larger than DIRECTORY_SCAN_CAP is cut off — reporting the cut
      // figure as `total` would be a count the federation cannot stand behind.
      matched: sorted.length,
      scanTruncated: all.length >= DIRECTORY_SCAN_CAP,
      contactDetailsIncluded: false,
    },
  });
}

// ─── /api/v1/officials ──────────────────────────────────────────────────────

const REGISTRIES: readonly Registry[] = ['official', 'examiner', 'instructor'];

/**
 * UNBOUNDED READ, STATED RATHER THAN HIDDEN.
 *
 * publicOfficialsDirectory() takes neither a limit nor a cursor: it joins the
 * whole register and filters expiry in JavaScript. So every page of this
 * collection materialises the entire licensed register, sorts it, and returns
 * fifty rows — at up to 120 requests a minute per client. No cap is imposed
 * here because a silent cut would drop a licensed official out of the public
 * register, which is the worse failure of the two; the fix belongs in the
 * module and is reported as a shared-file need. /officials does the same read.
 */
async function officialsList(url: URL): Promise<Response> {
  const limit = parseLimit(url);
  const cursor = decodeCursor(url);

  const requested = (url.searchParams.get('registry') || 'official').toLowerCase();
  if (!(REGISTRIES as readonly string[]).includes(requested)) {
    throw new BadInput('invalid_registry', '"registry" must be one of: official, examiner, instructor.', {
      allowed: [...REGISTRIES],
    });
  }

  // The module answers "valid AS AT a date" and never defaults the date away.
  // This API can only answer for today, and says which day it answered for —
  // a licence shown here may have lapsed by the date of a future championship.
  const asAt = new Date().toISOString().slice(0, 10);
  const rows = (await publicOfficialsDirectory(db(), requested as Registry, asAt)) as any[];

  // One person may hold more than one active licence in a registry, so the
  // federation id alone is not a unique sort key and cannot be the cursor.
  const keyed = rows
    .map((r) => ({
      row: r,
      key: `${r.federationId}|${r.grantedOn ?? ''}|${r.level ?? ''}`,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

  const start = cursor ? keyed.findIndex((r) => r.key > cursor) : 0;
  const slice = start < 0 ? [] : keyed.slice(start, start + limit + 1);
  const { page, more } = cut(slice, limit);
  const nextCursor = more && page.length ? encodeCursor(page[page.length - 1].key) : null;

  // A state name, so a row reads as a place rather than a foreign key — the
  // same lookup /officials does. The raw unit id is not published: it means
  // nothing outside this database and would invite a consumer to key on it.
  const stateIds = [...new Set(page.map((r) => r.row.stateUnitId).filter((v): v is number => v != null))];
  const stateNames = new Map<number, string>();
  if (stateIds.length) {
    const units = await db()
      .select({ id: s.stateUnits.id, stateName: s.stateUnits.state })
      .from(s.stateUnits)
      .where(inArray(s.stateUnits.id, stateIds));
    for (const u of units as any[]) stateNames.set(u.id, u.stateName);
  }

  return ok(
    page.map(({ row }) => ({
      name: row.fullName,
      federationId: row.federationId,
      registry: row.registry,
      level: row.level,
      state: row.stateUnitId != null ? stateNames.get(row.stateUnitId) ?? null : null,
      grantedOn: row.grantedOn,
      expiresOn: row.expiresOn,
      // Surfaced rather than rendered as an unqualified tick: no expiry may be
      // deliberate or may be an omission in the register, and only the office
      // can tell. /officials makes the same distinction.
      openEnded: row.expiresOn == null,
    })),
    {
      cache: CACHE.directory,
      page: pageBlock(url, limit, nextCursor),
      meta: {
        registry: requested,
        validAsAt: asAt,
        total: keyed.length,
        contactDetailsIncluded: false,
        note: 'Validity is answered for the date shown. A licence current today may have lapsed by the date of a future event.',
      },
    }
  );
}

// ─── /api/v1/verify/{number} ────────────────────────────────────────────────

/**
 * Verification is delegated to the existing /api/verify handler.
 *
 * That endpoint decides the three provenances — `examined`, `unverified_legacy`,
 * `legacy_register` — refuses to fall back to the hand-typed register when a
 * database is present, reports a database fault as a fault rather than as "no
 * such member", and logs the lookup. Reimplementing any of that here would give
 * the federation two verification services that could disagree, which is the
 * one failure a verification service cannot survive.
 *
 * The handler reads only `url` and `request` from its context, which is why the
 * partial context below is safe today — and why the shared-file request is to
 * lift the lookup into src/db/grading.ts as a plain function, so no cast is
 * needed at all.
 */
async function verifyNumber(number: string, request: Request, url: URL): Promise<Response> {
  const id = number.trim();
  if (!id || id.length > 60) {
    return fail(400, 'invalid_request', 'Give a member id or a certificate number.');
  }

  const delegateUrl = new URL(url.toString());
  delegateUrl.pathname = '/api/verify';
  delegateUrl.search = `?id=${encodeURIComponent(id)}`;

  const upstream = await verifyEndpoint({ request, url: delegateUrl } as any);
  const status = upstream.status;
  const payload: any = await upstream.json().catch(() => null);

  // 429 from the shared `verify` bucket. The v1 caller is subject to BOTH
  // limiters, deliberately: this route must not be a way around the one that
  // protects the register.
  if (status === 429) {
    return fail(429, 'rate_limited', 'Too many requests. Please try again shortly.', {
      retryAfterSeconds: Number(upstream.headers.get('Retry-After') ?? 60),
    });
  }
  if (status === 503) {
    return fail(
      503,
      'service_unavailable',
      payload?.error ?? 'The verification service is temporarily unavailable. This is not a result about that credential.'
    );
  }
  if (status === 400) {
    return fail(400, 'invalid_request', payload?.error ?? 'Give a member id or a certificate number.');
  }
  if (status !== 200 || !payload) {
    return fail(502, 'upstream_error', 'The verification service could not be read.');
  }

  // "No such credential" is a 404 here, so a client can branch on the status
  // line. The upstream answers it as 200 { found: false }; both are honest, and
  // the divergence is recorded in docs/API-ARCHITECTURE.md rather than papered
  // over by changing an endpoint this workflow does not own.
  if (!payload.found) {
    return fail(404, 'credential_not_found', 'No credential matches that number.');
  }

  return ok(
    {
      found: true,
      kind: payload.kind ?? null,
      provenance: payload.provenance ?? null,
      note: payload.note ?? null,
      credential: payload.credential ?? null,
      member: payload.member ?? null,
    },
    {
      cache: CACHE.verification,
      meta: {
        // The single most important field in the response, and the one a naive
        // consumer will skip. Named in the metadata as well as the body.
        provenanceNote:
          '`provenance` states how the federation knows: "examined" is traced to a recorded examination, "unverified_legacy" predates digital examination records, "legacy_register" comes from the hand-maintained register. They are not equivalent claims.',
      },
    }
  );
}

// ─── The route ──────────────────────────────────────────────────────────────

function unknownRoute(path: string): Response {
  return fail(404, 'unknown_route', `No such resource in version ${API_VERSION} of this API.`, {
    requested: path,
    resources: ['events', 'rankings', 'dojos', 'officials', 'verify'],
  });
}

export const GET: APIRoute = async ({ params, request, url }) => {
  const rl = await rateLimit(request, 'api-v1', 120, 60);
  if (!rl.ok) {
    return respond(
      429,
      { apiVersion: API_VERSION, error: 'Too many requests. Please try again shortly.', code: 'rate_limited' },
      'no-store',
      { 'Retry-After': String(Math.max(1, rl.retryAfterSeconds)) }
    );
  }

  const raw = String(params.route ?? '');
  let segments: string[];
  try {
    segments = raw.split('/').map((x) => decodeURIComponent(x.trim())).filter(Boolean);
  } catch {
    return unknownRoute(raw);
  }

  try {
    if (segments.length === 0) return serviceIndex();

    const [resource, first, second] = segments;

    // ROUTING FIRST, CONFIGURATION SECOND. A path that does not exist does not
    // exist whether or not a database is attached, and answering an unknown
    // route with 503 would tell a consumer their URL was right and the service
    // was down — which, on a deployment with no DATABASE_URL, would be the
    // answer to every typo.
    let handler: (() => Promise<Response>) | null = null;

    switch (resource) {
      case 'events':
        if (segments.length === 1) handler = () => eventsList(url);
        else if (segments.length === 2) handler = () => eventDetail(first);
        else if (segments.length === 3 && second === 'results') handler = () => eventResults(first);
        break;

      case 'rankings':
        if (segments.length === 1) handler = () => rankingsList(url);
        else if (segments.length === 2) handler = () => rankingTable(first, url);
        break;

      case 'dojos':
        if (segments.length === 1) handler = () => dojosList(url);
        break;

      case 'officials':
        if (segments.length === 1) handler = () => officialsList(url);
        break;

      case 'verify':
        if (segments.length === 2) handler = () => verifyNumber(first, request, url);
        break;
    }

    if (!handler) return unknownRoute(segments.join('/'));

    // Verification answers from the legacy register when no database is
    // configured, so it is reachable either way.
    if (resource !== 'verify') {
      const unavailable = requireDatabase();
      if (unavailable) return unavailable;
    }

    return await handler();
  } catch (err: any) {
    if (err instanceof BadInput) return fail(400, err.code, err.message, err.extra);
    // Never a stack trace on the wire. The server log keeps the detail, and the
    // caller is told the request failed without being handed the shape of the
    // schema behind it.
    console.error('[api/v1] unexpected', segments.join('/'), err);
    return fail(500, 'internal_error', 'The request could not be completed.');
  }
};

/**
 * HEAD, answered as a GET with the body discarded.
 *
 * Astro maps HEAD onto GET automatically ONLY while a route exports no `ALL`
 * handler. This route exports one to explain the absence of a write path, and
 * that handler swallowed HEAD too: `curl -I /api/v1` answered
 * `405 read_only` — a refusal telling a caller the API cannot be WRITTEN to, in
 * answer to the safest read there is. Every other endpoint on the site answers
 * HEAD 200, and a monitor or a link checker pointed at this one would have
 * reported the API down.
 */
export const HEAD: APIRoute = async (ctx) => {
  const res = await (GET as (c: typeof ctx) => Promise<Response>)(ctx);
  // Headers are kept — Content-Type, Cache-Control and CORS are exactly what a
  // HEAD is asked for. Only the body is dropped.
  return new Response(null, { status: res.status, headers: res.headers });
};

/** Preflight, for browser clients on other origins. */
export const OPTIONS: APIRoute = async () =>
  new Response(null, { status: 204, headers: { ...CORS, 'Cache-Control': CACHE.index } });

/**
 * Everything that is not a GET, HEAD or OPTIONS.
 *
 * 405 with the reason, not a bare method-not-allowed: a developer who POSTs
 * here has made a reasonable assumption about what an API is, and the useful
 * answer is why this one is different and where the write path actually is.
 *
 * MEASURED CAVEAT — most callers never reach this handler. `src/middleware.ts`
 * refuses every state-changing request that carries no `Origin`, `Referer` or
 * `Sec-Fetch-Site`, which is precisely what a plain `curl -X POST` sends: that
 * request is answered `403 {"error":"Request refused"}` by the middleware and
 * this explanation is never reached. Verified against a running dev server:
 * header-less POST → 403, same-origin POST → 405 read_only. The explanation
 * below is therefore a courtesy to a same-origin caller, not the answer an
 * outside integrator will see; docs/API-ARCHITECTURE.md §12.5 records it.
 */
export const ALL: APIRoute = async ({ request }) =>
  respond(
    405,
    {
      apiVersion: API_VERSION,
      error:
        'This API is read-only. A public write API needs an API-key scheme, per-key quotas and a revocation path for a leaked key, and MMAKF has none of those — so no write endpoint is offered rather than half of one. Writes are made from a browser, by a signed-in person, through the endpoints documented in docs/api/OPENAPI.md.',
      code: 'read_only',
      method: request.method,
    },
    'no-store',
    { Allow: 'GET, HEAD, OPTIONS' }
  );
