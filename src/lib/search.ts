// Federation-wide search (Q-20).
//
// SEARCH IS WHERE PERMISSION MODELS DIE. Every other read asks for ONE record,
// so it can be gated by id. A search asks "what exists like this", and a single
// missing scope filter turns the box into a bulk export of the membership
// register. This module is built so that outcome is structurally hard rather
// than merely avoided:
//
//  1. A domain is only searched if it appears in DOMAINS, and every entry there
//     names the Action that gates it. There is no "just query this table" path.
//  2. Scope is applied as a SQL predicate built from visibleScopes(). Nothing is
//     fetched and then filtered — a post-query filter is one refactor away from
//     being dropped, and by then the rows are already in memory.
//  3. Anonymous callers are restricted twice: once by PUBLIC_KINDS before any
//     searcher runs, and again inside each searcher, which requires either the
//     Action or an explicit published/active predicate.
//  4. Safeguarding, medical and disciplinary casework is not reachable from
//     here at any permission level, including SUPER_ADMIN. There is no SearchKind
//     for it, so a hit is not even representable, and NEVER_SEARCHABLE records
//     the intent for the test that greps this file.
//
// Two deliberate narrowings, both from the brief and both load-bearing:
//
//  · CERTIFICATES ARE FOUND BY EXACT NUMBER ONLY. A search that lists everyone
//    called "Kumar" with their grades is a bulk export of the grading register
//    wearing a search box. Holder name is not a certificate match field.
//  · A HIT WITHOUT AN EXPLANATION IS DROPPED. `matchedOn` is not decoration:
//    a search that cannot say why it returned a row cannot be debugged, audited
//    or trusted (invariant 4). If the SQL matched but the same rules re-applied
//    in JS cannot name a field, the row does not survive.
//
// AND ONE RULE THIS MODULE REFUSES TO WRITE. Which document classification is
// readable by whom is a FEDERATION decision, not a guess derivable from the
// action list — `official` means whoever the federation says it means. It lives
// in SearchPolicy; unconfigured, only `public` is searched, for everyone
// including SUPER_ADMIN, and `response.notices` says the rule was never set
// (invariant 1). The same applies to anything added to the classification enum
// later: absent from the map, absent from the results.

import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { canAnywhere, visibleScopes, type Action, type Principal } from '@/lib/rbac';
import { get as storageGet } from '@/lib/storage';

type DB = any;

export class SearchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SearchError';
    this.code = code;
  }
}

// ─── Result shape ───────────────────────────────────────────────────────────

export type SearchKind =
  | 'person'
  | 'dojo'
  | 'state_unit'
  | 'district_unit'
  | 'competition_event'
  | 'certificate'
  | 'course'
  | 'document'
  | 'technique'
  | 'kata'
  | 'news';

/**
 * Tie-break order across domains for equally-ranked hits. Fixed, so two runs of
 * the same query against the same data produce the same list in the same order.
 */
export const KIND_ORDER: readonly SearchKind[] = [
  'person', 'certificate', 'dojo', 'state_unit', 'district_unit',
  'competition_event', 'course', 'document', 'technique', 'kata', 'news',
];

/**
 * Domains an unauthenticated caller may reach — genuinely published material,
 * nothing more. Not people, not certificates by name, not casework.
 */
export const PUBLIC_KINDS: readonly SearchKind[] = ['dojo', 'course', 'document', 'news'];

/**
 * Tables that must never be reachable from this function, for anyone, at any
 * permission level. They have their own access path with its own authorisation,
 * retention and lawful basis. Exported so a test can assert this file does not
 * reference them — a comment saying "don't" is not an enforcement mechanism.
 */
export const NEVER_SEARCHABLE: readonly string[] = [
  'safeguardingCases',
  'medicalRecords',
  'disciplinaryCases',
  'caseNotes',
  'interestDeclarations',
];

export type MatchHow = 'exact' | 'prefix' | 'substring';

/** Why a row came back. Reconstructible from stored data alone (invariant 4). */
export interface MatchExplanation {
  /** The field that matched, named as it appears in the record. */
  field: string;
  /** The stored value, windowed around the match when the field is long. */
  value: string;
  how: MatchHow;
  /** Relevance tier; lower sorts first. See TIERS. */
  rank: number;
}

export interface SearchHit {
  kind: SearchKind;
  id: string;
  /** The record's natural key — federation id, code, slug, certificate number. */
  ref: string | null;
  title: string;
  subtitle: string | null;
  url: string | null;
  matchedOn: MatchExplanation;
}

/** Why a domain contributed nothing. A silent empty domain is unexplainable. */
export type SkipReason =
  | 'not_requested'
  | 'not_public'
  | 'not_authorised'
  | 'no_visible_scope'
  | 'not_a_certificate_number'
  | 'store_unavailable';

/**
 * A federation rule this search DID NOT apply, because the federation has not
 * supplied it. Invariant 1: an unset rule is not applied AND the result says so
 * — a caller must never read an empty or narrow result as "there is nothing
 * here" when the true answer is "nobody has told this system what the rule is".
 */
export type NoticeCode = 'document_classification_audience_not_configured';

export interface SearchNotice {
  code: NoticeCode;
  detail: string;
}

export interface SearchResponse {
  /** The normalised query actually executed, not the raw input. */
  query: string;
  kinds: SearchKind[];
  skipped: Array<{ kind: SearchKind; reason: SkipReason }>;
  /** Rules that were not applied because they are not configured. */
  notices: SearchNotice[];
  hits: SearchHit[];
  /**
   * True when more matched than `limit` allowed through, so a caller can say
   * "showing 20 of more" instead of implying the list is complete.
   */
  truncated: boolean;
}

/**
 * Turns a hit into a link. Defaults to DEFAULT_URL, which resolves a URL only
 * where a route genuinely serves that record today; callers that have built
 * record surfaces pass their own.
 */
export type UrlResolver = (hit: {
  kind: SearchKind;
  id: string;
  ref: string | null;
}) => string | null;

export interface NewsItem {
  id?: number | string;
  title?: string;
  date?: string;
  type?: string;
  body?: string;
}

export type DataClassification = (typeof s.dataClass.enumValues)[number];

/**
 * Federation-supplied configuration. Nothing here has a default that grants
 * anything: every unset rule narrows the search and is reported in `notices`.
 */
export interface SearchPolicy {
  /**
   * The action a caller must hold for search to return a document of each
   * classification.
   *
   * THIS MODULE MUST NOT GUESS THIS MAP. `public` is the one classification
   * whose audience is settled by its own name. `member`, `official`,
   * `confidential`, `restricted` and `highly_restricted` name groups whose
   * membership is a federation decision — "official" does not mean "holds
   * content:write", it means whoever the federation says it means. Deriving the
   * map from the action list is the tempting mistake and the wrong one. A
   * classification absent from this map is NOT SEARCHED, whoever is asking,
   * including SUPER_ADMIN.
   */
  documentClassificationRequires?: Partial<Record<DataClassification, Action>>;
}

export interface SearchOptions {
  /**
   * Restrict to these domains. OMITTED means every domain the caller may reach;
   * an EMPTY ARRAY means none of them. The difference matters: a caller that
   * computes this list and comes up empty is asking for nothing, and treating
   * that as "everything" is the fail-open reading.
   */
  kinds?: SearchKind[];
  policy?: SearchPolicy;
  /** Total hits returned, clamped to 1..MAX_LIMIT. A non-finite value is refused. */
  limit?: number;
  url?: UrlResolver;
  /**
   * News is editorial CMS content in Redis, not a federation record in
   * Postgres (FEDERATION-ARCHITECTURE §1). Injectable so tests are deterministic
   * and so a caller that already loaded the news list does not fetch it twice.
   */
  newsProvider?: () => Promise<NewsItem[]>;
  /**
   * When supplied, one audit row is written recording what was asked and how
   * much came back. Searching the register is the shape a bulk export takes, so
   * a caller that exposes this to staff should pass a context; a public site
   * search should not, or the audit table fills with keystrokes.
   */
  audit?: AuditContext;
}

// ─── Query hygiene ──────────────────────────────────────────────────────────

export const MIN_QUERY_LENGTH = 2;
export const MAX_QUERY_LENGTH = 128;
export const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
/** Longest value echoed back in `matchedOn.value`, so a body field is a snippet. */
const SNIPPET_LENGTH = 160;

/**
 * Normalise and bound the query.
 *
 * Control characters are stripped rather than escaped: they cannot be typed
 * deliberately by a member and they corrupt the audit record and any log line
 * the query lands in.
 */
function normalise(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new SearchError('query_invalid', 'Search query must be a string.');
  }
  // eslint-disable-next-line no-control-regex
  const q = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < MIN_QUERY_LENGTH) {
    throw new SearchError(
      'query_too_short',
      `Search query must be at least ${MIN_QUERY_LENGTH} characters.`
    );
  }
  if (q.length > MAX_QUERY_LENGTH) {
    throw new SearchError(
      'query_too_long',
      `Search query must be at most ${MAX_QUERY_LENGTH} characters.`
    );
  }
  return q;
}

/**
 * Neutralise LIKE wildcards in user input.
 *
 * This is NOT injection defence — every value below is a bound parameter, so no
 * query text is ever built from input. It stops a query containing `%` from
 * silently becoming a match-everything pattern, which is how a search box turns
 * into an enumeration tool. Backslash is Postgres's default LIKE escape
 * character, and escaping backslash itself first means a trailing `\` can never
 * be left dangling.
 */
function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Bound the page size.
 *
 * A non-finite limit is REFUSED, not clamped. `Math.min(Math.max(1, NaN), 50)`
 * is NaN, `.limit(NaN)` fetches whatever the driver feels like, and
 * `hits.slice(0, NaN)` is `[]` — so an accidental NaN used to return "no
 * results, and that is all of them" over a register that was full of matches.
 * Silence that looks like an answer is the worst failure mode this module has.
 */
function boundLimit(raw: unknown): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new SearchError('limit_invalid', 'Search limit must be a finite number.');
  }
  return Math.min(Math.max(1, Math.trunc(raw)), MAX_LIMIT);
}

/**
 * Resolve the requested domain list.
 *
 * An unknown kind is refused rather than ignored. Silently dropping it would
 * mean a caller asking for a domain this module does not have gets an empty
 * result that reads as "nothing matched" instead of "you asked for something
 * that does not exist".
 */
function requestedKinds(kinds: SearchKind[] | undefined): readonly SearchKind[] {
  if (kinds === undefined) return KIND_ORDER;
  if (!Array.isArray(kinds)) {
    throw new SearchError('kinds_invalid', 'Search kinds must be an array when supplied.');
  }
  for (const k of kinds) {
    if (!KIND_ORDER.includes(k)) {
      throw new SearchError('unknown_kind', `Unknown search domain: ${String(k)}`);
    }
  }
  return kinds;
}

// ─── Relevance ──────────────────────────────────────────────────────────────

/**
 * What a field is, which decides how it may be matched:
 *  · identifier — a federation id, code, slug or certificate number. Matched
 *    exactly or by prefix ONLY. Substring matching an identifier is enumeration
 *    with extra steps and returns noise.
 *  · name — a human-facing name or title. Exact, prefix or substring.
 *  · text — prose (summary, description, body). Substring only, ranked last,
 *    because a word appearing mid-paragraph is the weakest evidence of intent.
 */
type FieldRole = 'identifier' | 'name' | 'text';

/**
 * Relevance tiers. Exact identifier first, then prefix, then substring — as
 * required, with identifier beating name inside each band so that typing a
 * federation id never buries the record under people whose name contains it.
 */
const TIERS = {
  identifier_exact: 0,
  name_exact: 1,
  identifier_prefix: 2,
  name_prefix: 3,
  name_substring: 4,
  text_substring: 5,
} as const;

const NO_MATCH_RANK = 99;

function tierFor(role: FieldRole, how: MatchHow): number | null {
  if (role === 'identifier') {
    if (how === 'exact') return TIERS.identifier_exact;
    if (how === 'prefix') return TIERS.identifier_prefix;
    return null;
  }
  if (role === 'name') {
    if (how === 'exact') return TIERS.name_exact;
    if (how === 'prefix') return TIERS.name_prefix;
    return TIERS.name_substring;
  }
  return how === 'substring' ? TIERS.text_substring : null;
}

interface MatchField {
  field: string;
  column: any;
  role: FieldRole;
}

/** The (tier, condition) pairs a field contributes, in tier order. */
function conditionsFor(q: string, f: MatchField): Array<{ tier: number; cond: SQL }> {
  const like = escapeLike(q);
  const out: Array<{ tier: number; cond: SQL }> = [];
  if (f.role !== 'text') {
    out.push({ tier: tierFor(f.role, 'exact')!, cond: sql`lower(${f.column}) = lower(${q})` });
    out.push({ tier: tierFor(f.role, 'prefix')!, cond: sql`${f.column} ILIKE ${`${like}%`}` });
  }
  if (f.role !== 'identifier') {
    out.push({ tier: tierFor(f.role, 'substring')!, cond: sql`${f.column} ILIKE ${`%${like}%`}` });
  }
  return out;
}

/** WHERE predicate: the row matched at least one field. */
function matchPredicate(q: string, fields: MatchField[]): SQL {
  const conds = fields.flatMap((f) => conditionsFor(q, f)).map((c) => c.cond);
  // Unreachable with a non-empty field list, but a searcher whose fields were
  // accidentally emptied must return nothing rather than everything.
  if (!conds.length) return sql`false`;
  return or(...conds) as SQL;
}

/**
 * ORDER BY expression giving each row its best tier.
 *
 * This has to happen in SQL, not after the fetch: with a LIMIT, ordering in JS
 * would rank only whichever arbitrary page Postgres happened to return, so an
 * exact identifier match could be discarded in favour of a substring hit.
 * Tier numbers are compile-time constants, never input, hence sql.raw.
 */
function rankExpression(q: string, fields: MatchField[]): SQL {
  const ordered = fields.flatMap((f) => conditionsFor(q, f)).sort((a, b) => a.tier - b.tier);
  const parts: SQL[] = [sql`CASE`];
  for (const c of ordered) parts.push(sql`WHEN ${c.cond} THEN ${sql.raw(String(c.tier))}`);
  parts.push(sql`ELSE ${sql.raw(String(NO_MATCH_RANK))} END`);
  return sql.join(parts, sql` `);
}

function snippet(value: string, at: number): string {
  if (value.length <= SNIPPET_LENGTH) return value;
  const start = Math.max(0, at - Math.floor(SNIPPET_LENGTH / 3));
  const end = Math.min(value.length, start + SNIPPET_LENGTH);
  return `${start > 0 ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`;
}

/**
 * Re-derive the match in JS, using the same rules the SQL used.
 *
 * Returns null when no field can be shown to match. That happens when Postgres
 * and JS disagree about case folding for some scripts, and the correct response
 * is to drop the row: a hit whose explanation we cannot produce is a hit we
 * cannot stand behind.
 */
function explainMatch(
  q: string,
  fields: Array<{ field: string; role: FieldRole; value: unknown }>
): MatchExplanation | null {
  const needle = q.toLowerCase();
  let best: MatchExplanation | null = null;

  for (const f of fields) {
    if (typeof f.value !== 'string' || f.value.length === 0) continue;
    const hay = f.value.toLowerCase();

    let how: MatchHow | null = null;
    let at = 0;
    if (f.role === 'text') {
      at = hay.indexOf(needle);
      if (at >= 0) how = 'substring';
    } else if (hay === needle) {
      how = 'exact';
    } else if (hay.startsWith(needle)) {
      how = 'prefix';
    } else if (f.role === 'name') {
      at = hay.indexOf(needle);
      if (at >= 0) how = 'substring';
    }
    if (!how) continue;

    const tier = tierFor(f.role, how);
    if (tier == null) continue;
    if (best && tier >= best.rank) continue;
    best = { field: f.field, value: snippet(f.value, Math.max(0, at)), how, rank: tier };
  }
  return best;
}

// ─── Scope predicates ───────────────────────────────────────────────────────

/**
 * Restrict rows to the scopes the principal may see for an action.
 *
 * The three outcomes are distinct on purpose. `all` means no predicate is
 * needed; `scoped` carries the predicate; `none` is NOT the same as an empty
 * predicate, because a searcher that gets `none` should report
 * `no_visible_scope` rather than run a query that can only return nothing.
 *
 * `columns` names the columns carrying each scope level on the table being
 * searched. A level with no column here cannot be satisfied at all, and a
 * principal holding only that level resolves to `none` — an unresolvable scope
 * grants nothing (invariant 3), it does not fall through to unfiltered.
 */
type ScopeFilter =
  | { reach: 'all' }
  | { reach: 'none' }
  | { reach: 'scoped'; predicate: SQL };

function scopeFilter(
  principal: Principal | null,
  action: Action,
  columns: { state?: any; district?: any; dojo?: any }
): ScopeFilter {
  const scopes = visibleScopes(principal, action);
  if (scopes.kind === 'all') return { reach: 'all' };
  if (scopes.kind === 'none') return { reach: 'none' };

  const clauses: SQL[] = [];
  if (scopes.states.length && columns.state) clauses.push(inArray(columns.state, scopes.states) as SQL);
  if (scopes.districts.length && columns.district) {
    clauses.push(inArray(columns.district, scopes.districts) as SQL);
  }
  if (scopes.dojos.length && columns.dojo) clauses.push(inArray(columns.dojo, scopes.dojos) as SQL);
  if (!clauses.length) return { reach: 'none' };
  return {
    reach: 'scoped',
    predicate: (clauses.length === 1 ? clauses[0] : or(...clauses)) as SQL,
  };
}

/**
 * May this principal see content that has not been published?
 *
 * Deliberately `content:write` at national scope, not `content:read`. Every
 * signed-in MEMBER holds `content:read`, so gating drafts on it would publish
 * every unreleased course, unadopted bye-law and unfinished technique entry to
 * the whole membership. The people who may see a draft are the people who may
 * edit it, and courses, documents, techniques and kata carry no unit columns, so
 * a state-scoped grant has nothing to resolve against and correctly yields
 * false.
 */
function mayReadUnpublished(principal: Principal | null): boolean {
  return visibleScopes(principal, 'content:write').kind === 'all';
}

// ─── URLs ───────────────────────────────────────────────────────────────────

/**
 * The default link resolver.
 *
 * It returns a URL only for certificates, because `/api/verify` is the one route
 * in this repository that today resolves to an individual record. Per-record
 * pages for people, dojos, units, events, courses, documents, techniques and
 * kata have not been built; emitting `/dojos/17` would be a link to a 404
 * dressed up as a feature. `SearchOptions.url` is the injection point for a
 * surface that has built those routes.
 */
export const DEFAULT_URL: UrlResolver = (hit) => {
  if (hit.kind === 'certificate' && hit.ref) {
    return `/api/verify?id=${encodeURIComponent(hit.ref)}`;
  }
  return null;
};

// ─── Searchers ──────────────────────────────────────────────────────────────
//
// Each returns either its hits or the reason it contributed none. They share one
// shape so the dispatcher cannot treat any domain specially.

/**
 * `saturated` means the domain filled its fetch window, so rows it could have
 * returned were left behind. It is tracked SEPARATELY from the hit count
 * because a row can be dropped after the fetch (an unexplainable match), and
 * counting only survivors would let a page that is genuinely incomplete report
 * `truncated: false` — a claim of completeness the query never established
 * (invariant 2).
 */
type DomainResult = { hits: SearchHit[]; saturated: boolean } | { skip: SkipReason };

interface DomainContext {
  db: DB;
  principal: Principal | null;
  q: string;
  /**
   * Rows to pull PER DOMAIN — one more than the page size.
   *
   * It has to exceed the page size for two reasons. A single domain must be able
   * to fill the page on its own, and the extra row is how overflow is detected:
   * without it, a page that exactly fills is indistinguishable from one with
   * nothing behind it, and `truncated` would always be false.
   */
  fetch: number;
  url: UrlResolver;
  newsProvider: () => Promise<NewsItem[]>;
  policy: SearchPolicy;
  /** Shared sink: a searcher records here any rule it could not apply. */
  notices: SearchNotice[];
}

/** Assemble a hit, dropping rows whose match cannot be explained. */
function toHit(
  kind: SearchKind,
  url: UrlResolver,
  row: {
    id: number | string;
    ref: string | null;
    title: string;
    subtitle: string | null;
  },
  match: MatchExplanation | null
): SearchHit | null {
  if (!match) return null;
  const id = String(row.id);
  return {
    kind,
    id,
    ref: row.ref,
    title: row.title,
    subtitle: row.subtitle,
    url: url({ kind, id, ref: row.ref }),
    matchedOn: match,
  };
}

// — People ——————————————————————————————————————————————————————————————
//
// Never public. The projection carries no dob, email or phone regardless of who
// asks: `person:read_pii` is a different action, and a list surface is the wrong
// place to spend it.

async function searchPeople(c: DomainContext): Promise<DomainResult> {
  if (!canAnywhere(c.principal, 'person:read')) return { skip: 'not_authorised' };

  const scope = scopeFilter(c.principal, 'person:read', {
    state: s.persons.stateUnitId,
    district: s.persons.districtUnitId,
    dojo: s.persons.dojoId,
  });
  if (scope.reach === 'none') return { skip: 'no_visible_scope' };

  const fields: MatchField[] = [
    { field: 'federationId', column: s.persons.federationId, role: 'identifier' },
    { field: 'fullName', column: s.persons.fullName, role: 'name' },
  ];
  const conds: SQL[] = [matchPredicate(c.q, fields)];
  if (scope.reach === 'scoped') conds.push(scope.predicate);

  const rows = await c.db
    .select({
      id: s.persons.id,
      federationId: s.persons.federationId,
      fullName: s.persons.fullName,
      city: s.persons.city,
      status: s.persons.status,
    })
    .from(s.persons)
    .where(and(...conds))
    .orderBy(rankExpression(c.q, fields), asc(s.persons.fullName), asc(s.persons.id))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        toHit(
          'person',
          c.url,
          {
            id: r.id,
            ref: r.federationId,
            title: r.fullName,
            subtitle: [r.federationId, r.city, r.status].filter(Boolean).join(' · ') || null,
          },
          explainMatch(c.q, [
            { field: 'federationId', role: 'identifier', value: r.federationId },
            { field: 'fullName', role: 'name', value: r.fullName },
          ])
        )
      )
      .filter(Boolean) as SearchHit[],
  };
}

// — Dojos ————————————————————————————————————————————————————————————————
//
// The one people-adjacent domain with a genuinely public face: the affiliated
// dojo directory. Only ACTIVE dojos are public; drafts, provisional and
// suspended affiliations are visible solely inside a `dojo:read` scope, because
// "this club's affiliation is suspended" is not the federation's news to break.

async function searchDojos(c: DomainContext): Promise<DomainResult> {
  const fields: MatchField[] = [
    { field: 'code', column: s.dojos.code, role: 'identifier' },
    { field: 'name', column: s.dojos.name, role: 'name' },
    { field: 'city', column: s.dojos.city, role: 'name' },
  ];

  // The public directory clause. It stands on its own for an anonymous caller
  // and is UNIONed with the caller's scope for an administrator, so holding
  // dojo:read in one state never costs sight of the public directory elsewhere.
  const visibility: SQL[] = [eq(s.dojos.status, 'active') as SQL];
  const scope = scopeFilter(c.principal, 'dojo:read', {
    state: s.dojos.stateUnitId,
    district: s.dojos.districtUnitId,
    dojo: s.dojos.id,
  });
  // National reach makes every clause redundant, so the filter drops away
  // entirely rather than being expressed as a tautology.
  if (scope.reach === 'all') visibility.length = 0;
  else if (scope.reach === 'scoped') visibility.push(scope.predicate);

  const conds: SQL[] = [matchPredicate(c.q, fields)];
  if (visibility.length) conds.push(or(...visibility) as SQL);

  const rows = await c.db
    .select({
      id: s.dojos.id,
      code: s.dojos.code,
      name: s.dojos.name,
      city: s.dojos.city,
      status: s.dojos.status,
    })
    .from(s.dojos)
    .where(and(...conds))
    .orderBy(rankExpression(c.q, fields), asc(s.dojos.name), asc(s.dojos.id))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        toHit(
          'dojo',
          c.url,
          {
            id: r.id,
            ref: r.code,
            title: r.name,
            subtitle: [r.city, r.status].filter(Boolean).join(' · ') || null,
          },
          explainMatch(c.q, [
            { field: 'code', role: 'identifier', value: r.code },
            { field: 'name', role: 'name', value: r.name },
            { field: 'city', role: 'name', value: r.city },
          ])
        )
      )
      .filter(Boolean) as SearchHit[],
  };
}

// — Units ————————————————————————————————————————————————————————————————
//
// A district binding does not reach its parent state unit here. Resolving the
// hierarchy upward would need a join this module deliberately does not own, and
// fail-closed is the correct default for an unresolvable scope (invariant 3).

async function searchStateUnits(c: DomainContext): Promise<DomainResult> {
  if (!canAnywhere(c.principal, 'unit:read')) return { skip: 'not_authorised' };
  const scope = scopeFilter(c.principal, 'unit:read', { state: s.stateUnits.id });
  if (scope.reach === 'none') return { skip: 'no_visible_scope' };

  const fields: MatchField[] = [
    { field: 'code', column: s.stateUnits.code, role: 'identifier' },
    { field: 'name', column: s.stateUnits.name, role: 'name' },
    { field: 'state', column: s.stateUnits.state, role: 'name' },
  ];
  const conds: SQL[] = [matchPredicate(c.q, fields)];
  if (scope.reach === 'scoped') conds.push(scope.predicate);

  const rows = await c.db
    .select()
    .from(s.stateUnits)
    .where(and(...conds))
    .orderBy(rankExpression(c.q, fields), asc(s.stateUnits.name), asc(s.stateUnits.id))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        toHit(
          'state_unit',
          c.url,
          {
            id: r.id,
            ref: r.code,
            title: r.name,
            subtitle: [r.state, r.status].filter(Boolean).join(' · ') || null,
          },
          explainMatch(c.q, [
            { field: 'code', role: 'identifier', value: r.code },
            { field: 'name', role: 'name', value: r.name },
            { field: 'state', role: 'name', value: r.state },
          ])
        )
      )
      .filter(Boolean) as SearchHit[],
  };
}

async function searchDistrictUnits(c: DomainContext): Promise<DomainResult> {
  if (!canAnywhere(c.principal, 'unit:read')) return { skip: 'not_authorised' };
  const scope = scopeFilter(c.principal, 'unit:read', {
    state: s.districtUnits.stateUnitId,
    district: s.districtUnits.id,
  });
  if (scope.reach === 'none') return { skip: 'no_visible_scope' };

  const fields: MatchField[] = [
    { field: 'code', column: s.districtUnits.code, role: 'identifier' },
    { field: 'name', column: s.districtUnits.name, role: 'name' },
    { field: 'district', column: s.districtUnits.district, role: 'name' },
  ];
  const conds: SQL[] = [matchPredicate(c.q, fields)];
  if (scope.reach === 'scoped') conds.push(scope.predicate);

  const rows = await c.db
    .select()
    .from(s.districtUnits)
    .where(and(...conds))
    .orderBy(rankExpression(c.q, fields), asc(s.districtUnits.name), asc(s.districtUnits.id))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        toHit(
          'district_unit',
          c.url,
          {
            id: r.id,
            ref: r.code,
            title: r.name,
            subtitle: [r.district, r.status].filter(Boolean).join(' · ') || null,
          },
          explainMatch(c.q, [
            { field: 'code', role: 'identifier', value: r.code },
            { field: 'name', role: 'name', value: r.name },
            { field: 'district', role: 'name', value: r.district },
          ])
        )
      )
      .filter(Boolean) as SearchHit[],
  };
}

// — Competition events ————————————————————————————————————————————————————
//
// The status list below is duplicated from src/db/competition.ts rather than
// imported: that module is owned elsewhere and importing it would couple search
// to a domain module's evolution. If the federation changes which statuses are
// public, both lists must move together — hence this note.

export const PUBLIC_EVENT_STATUSES = [
  'published', 'registration_open', 'registration_closed',
  'check_in', 'live', 'results_pending', 'results_final', 'archived',
] as const;

async function searchCompetitionEvents(c: DomainContext): Promise<DomainResult> {
  if (!canAnywhere(c.principal, 'competition:read')) return { skip: 'not_authorised' };

  const scopes = visibleScopes(c.principal, 'competition:read');
  const visibility: SQL[] = [];
  if (scopes.kind !== 'all') {
    if (scopes.kind === 'scoped') {
      if (scopes.states.length) {
        visibility.push(inArray(s.competitionEvents.stateUnitId, scopes.states) as SQL);
      }
      if (scopes.districts.length) {
        visibility.push(inArray(s.competitionEvents.districtUnitId, scopes.districts) as SQL);
      }
      if (scopes.dojos.length) {
        visibility.push(inArray(s.competitionEvents.organiserDojoId, scopes.dojos) as SQL);
      }
    }
    // A national event that has been published belongs to the whole federation;
    // a state administrator does not lose sight of the national championship.
    visibility.push(
      and(
        isNull(s.competitionEvents.stateUnitId),
        isNull(s.competitionEvents.districtUnitId),
        inArray(s.competitionEvents.status, [...PUBLIC_EVENT_STATUSES])
      ) as SQL
    );
  }

  const fields: MatchField[] = [
    { field: 'code', column: s.competitionEvents.code, role: 'identifier' },
    { field: 'title', column: s.competitionEvents.title, role: 'name' },
    { field: 'venue', column: s.competitionEvents.venue, role: 'name' },
    { field: 'city', column: s.competitionEvents.city, role: 'name' },
    { field: 'description', column: s.competitionEvents.description, role: 'text' },
  ];
  const conds: SQL[] = [matchPredicate(c.q, fields)];
  if (visibility.length) conds.push(or(...visibility) as SQL);

  const rows = await c.db
    .select()
    .from(s.competitionEvents)
    .where(and(...conds))
    .orderBy(rankExpression(c.q, fields), asc(s.competitionEvents.title), asc(s.competitionEvents.id))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        toHit(
          'competition_event',
          c.url,
          {
            id: r.id,
            ref: r.code,
            title: r.title,
            subtitle: [r.startsOn, r.city, r.status].filter(Boolean).join(' · ') || null,
          },
          explainMatch(c.q, [
            { field: 'code', role: 'identifier', value: r.code },
            { field: 'title', role: 'name', value: r.title },
            { field: 'venue', role: 'name', value: r.venue },
            { field: 'city', role: 'name', value: r.city },
            { field: 'description', role: 'text', value: r.description },
          ])
        )
      )
      .filter(Boolean) as SearchHit[],
  };
}

// — Certificates ——————————————————————————————————————————————————————————
//
// EXACT CERTIFICATE NUMBER ONLY. Not the holder's name, not a prefix, not the
// title. Prefix matching would be enough on its own: certificate numbers are
// sequential, so `MMAKF-CERT-2026-` would walk the entire year's grading
// register. The verify token is not a match field either — it is the secret a QR
// code carries, and a search box is not the place to trade it for a number.
//
// The scope filter is applied through the holder's placement, because a
// certificate carries no unit columns of its own.

async function searchCertificates(c: DomainContext): Promise<DomainResult> {
  if (!canAnywhere(c.principal, 'certificate:read')) return { skip: 'not_authorised' };

  // Certificate numbers have no spaces; anything else is a name search wearing a
  // disguise and is refused with a reason rather than silently returning [].
  if (/\s/.test(c.q)) return { skip: 'not_a_certificate_number' };

  const scope = scopeFilter(c.principal, 'certificate:read', {
    state: s.persons.stateUnitId,
    district: s.persons.districtUnitId,
    dojo: s.persons.dojoId,
  });
  if (scope.reach === 'none') return { skip: 'no_visible_scope' };

  const conds: SQL[] = [sql`lower(${s.certificates.certificateNo}) = lower(${c.q})`];
  if (scope.reach === 'scoped') conds.push(scope.predicate);

  const rows = await c.db
    .select({
      id: s.certificates.id,
      certificateNo: s.certificates.certificateNo,
      title: s.certificates.title,
      kind: s.certificates.kind,
      status: s.certificates.status,
      issuedOn: s.certificates.issuedOn,
      holder: s.persons.fullName,
    })
    .from(s.certificates)
    .innerJoin(s.persons, eq(s.persons.id, s.certificates.personId))
    .where(and(...conds))
    .orderBy(asc(s.certificates.id))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        toHit(
          'certificate',
          c.url,
          {
            id: r.id,
            ref: r.certificateNo,
            title: r.title,
            subtitle: [r.certificateNo, r.holder, r.status].filter(Boolean).join(' · ') || null,
          },
          explainMatch(c.q, [
            { field: 'certificateNo', role: 'identifier', value: r.certificateNo },
          ])
        )
      )
      .filter(Boolean) as SearchHit[],
  };
}

// — Courses ——————————————————————————————————————————————————————————————
//
// Published courses are public. Unpublished ones are national editorial work in
// progress: courses carry no unit columns, so a state-scoped `content:read`
// resolves to no additional rows, which is the correct outcome rather than an
// accident.

async function searchCourses(c: DomainContext): Promise<DomainResult> {
  const editorial = mayReadUnpublished(c.principal);

  const fields: MatchField[] = [
    { field: 'slug', column: s.courses.slug, role: 'identifier' },
    { field: 'title', column: s.courses.title, role: 'name' },
    { field: 'summary', column: s.courses.summary, role: 'text' },
  ];
  const conds: SQL[] = [matchPredicate(c.q, fields)];
  if (!editorial) conds.push(eq(s.courses.status, 'published') as SQL);

  const rows = await c.db
    .select()
    .from(s.courses)
    .where(and(...conds))
    .orderBy(rankExpression(c.q, fields), asc(s.courses.title), asc(s.courses.id))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        toHit(
          'course',
          c.url,
          {
            id: r.id,
            ref: r.slug,
            title: r.title,
            subtitle: [r.category, r.level, r.status].filter(Boolean).join(' · ') || null,
          },
          explainMatch(c.q, [
            { field: 'slug', role: 'identifier', value: r.slug },
            { field: 'title', role: 'name', value: r.title },
            { field: 'summary', role: 'text', value: r.summary },
          ])
        )
      )
      .filter(Boolean) as SearchHit[],
  };
}

// — Official documents ————————————————————————————————————————————————————
//
// Two independent gates, both required, because a governance document is where
// classification errors do the most damage:
//
//  · CLASSIFICATION. `public` only, unless the federation has configured which
//    action each other classification requires. An unconfigured classification
//    is excluded for everyone including SUPER_ADMIN, and the response SAYS the
//    rule was never set. A new, more sensitive classification added to the enum
//    later is therefore excluded by default rather than included by omission.
//  · PUBLICATION. A document is only public once its CURRENT version is
//    published — a draft revision of the constitution is not the constitution.

/**
 * The classifications this search may return, and the notice it owes the caller
 * when the federation has not said.
 *
 * `public` is unconditional: a document the federation itself classified as
 * public is public. Everything else needs `policy.documentClassificationRequires`
 * — see SearchPolicy for why this module refuses to invent that mapping.
 */
function documentClassifications(c: DomainContext): DataClassification[] {
  const map = c.policy.documentClassificationRequires;
  const configured = map ? (Object.keys(map) as DataClassification[]).filter((k) => k !== 'public' && map[k]) : [];

  if (!configured.length) {
    c.notices.push({
      code: 'document_classification_audience_not_configured',
      detail:
        'The federation has not configured which action each document classification requires, '
        + 'so only documents it classified as `public` were searched. Documents classified '
        + s.dataClass.enumValues.filter((v) => v !== 'public').map((v) => `\`${v}\``).join(', ')
        + ' were not searched for anyone, including SUPER_ADMIN.',
    });
    return ['public'];
  }
  return ['public', ...configured.filter((k) => canAnywhere(c.principal, map![k]!))];
}

async function searchDocuments(c: DomainContext): Promise<DomainResult> {
  const editorial = mayReadUnpublished(c.principal);

  const fields: MatchField[] = [
    { field: 'code', column: s.officialDocuments.code, role: 'identifier' },
    { field: 'title', column: s.officialDocuments.title, role: 'name' },
    { field: 'summary', column: s.officialDocuments.summary, role: 'text' },
  ];

  const conds: SQL[] = [
    matchPredicate(c.q, fields),
    eq(s.officialDocuments.active, true) as SQL,
    inArray(s.officialDocuments.classification, documentClassifications(c)) as SQL,
  ];
  if (!editorial) conds.push(eq(s.documentVersions.status, 'published') as SQL);

  const rows = await c.db
    .select({
      id: s.officialDocuments.id,
      code: s.officialDocuments.code,
      title: s.officialDocuments.title,
      summary: s.officialDocuments.summary,
      category: s.officialDocuments.category,
      classification: s.officialDocuments.classification,
      version: s.documentVersions.version,
    })
    .from(s.officialDocuments)
    // Inner join, not left: a document with no current version has nothing to
    // publish, and surfacing its title would advertise a rule nobody can read.
    .innerJoin(s.documentVersions, eq(s.documentVersions.id, s.officialDocuments.currentVersionId))
    .where(and(...conds))
    .orderBy(rankExpression(c.q, fields), asc(s.officialDocuments.title), asc(s.officialDocuments.id))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        toHit(
          'document',
          c.url,
          {
            id: r.id,
            ref: r.code,
            title: r.title,
            subtitle: [r.category, r.version && `v${r.version}`].filter(Boolean).join(' · ') || null,
          },
          explainMatch(c.q, [
            { field: 'code', role: 'identifier', value: r.code },
            { field: 'title', role: 'name', value: r.title },
            { field: 'summary', role: 'text', value: r.summary },
          ])
        )
      )
      .filter(Boolean) as SearchHit[],
  };
}

// — Technical reference ————————————————————————————————————————————————————
//
// Technique and kata entries are reference material, not federation policy, and
// `sourceKind` records whose interpretation each one is. Unpublished drafts are
// reachable only with national content:read; there is no anonymous path, because
// the brief's public surface is news, courses, the dojo directory and documents,
// and an unlisted domain fails closed.

async function searchTechniques(c: DomainContext): Promise<DomainResult> {
  if (!canAnywhere(c.principal, 'content:read')) return { skip: 'not_authorised' };
  const editorial = mayReadUnpublished(c.principal);

  const fields: MatchField[] = [
    { field: 'slug', column: s.techniques.slug, role: 'identifier' },
    { field: 'nameRomaji', column: s.techniques.nameRomaji, role: 'name' },
    { field: 'nameJa', column: s.techniques.nameJa, role: 'name' },
    { field: 'nameEn', column: s.techniques.nameEn, role: 'name' },
    { field: 'description', column: s.techniques.description, role: 'text' },
  ];
  const conds: SQL[] = [matchPredicate(c.q, fields)];
  if (!editorial) conds.push(eq(s.techniques.published, true) as SQL);

  const rows = await c.db
    .select()
    .from(s.techniques)
    .where(and(...conds))
    .orderBy(rankExpression(c.q, fields), asc(s.techniques.nameRomaji), asc(s.techniques.id))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        toHit(
          'technique',
          c.url,
          {
            id: r.id,
            ref: r.slug,
            title: r.nameRomaji,
            subtitle: [r.category, r.nameEn, r.sourceKind].filter(Boolean).join(' · ') || null,
          },
          explainMatch(c.q, [
            { field: 'slug', role: 'identifier', value: r.slug },
            { field: 'nameRomaji', role: 'name', value: r.nameRomaji },
            { field: 'nameJa', role: 'name', value: r.nameJa },
            { field: 'nameEn', role: 'name', value: r.nameEn },
            { field: 'description', role: 'text', value: r.description },
          ])
        )
      )
      .filter(Boolean) as SearchHit[],
  };
}

async function searchKata(c: DomainContext): Promise<DomainResult> {
  if (!canAnywhere(c.principal, 'content:read')) return { skip: 'not_authorised' };
  const editorial = mayReadUnpublished(c.principal);

  const fields: MatchField[] = [
    { field: 'slug', column: s.kata.slug, role: 'identifier' },
    { field: 'nameRomaji', column: s.kata.nameRomaji, role: 'name' },
    { field: 'nameJa', column: s.kata.nameJa, role: 'name' },
    { field: 'family', column: s.kata.family, role: 'name' },
    { field: 'meaning', column: s.kata.meaning, role: 'text' },
  ];
  const conds: SQL[] = [matchPredicate(c.q, fields)];
  if (!editorial) conds.push(eq(s.kata.published, true) as SQL);

  const rows = await c.db
    .select()
    .from(s.kata)
    .where(and(...conds))
    .orderBy(rankExpression(c.q, fields), asc(s.kata.nameRomaji), asc(s.kata.id))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        toHit(
          'kata',
          c.url,
          {
            id: r.id,
            ref: r.slug,
            title: r.nameRomaji,
            subtitle: [r.family, r.meaning].filter(Boolean).join(' · ') || null,
          },
          explainMatch(c.q, [
            { field: 'slug', role: 'identifier', value: r.slug },
            { field: 'nameRomaji', role: 'name', value: r.nameRomaji },
            { field: 'nameJa', role: 'name', value: r.nameJa },
            { field: 'family', role: 'name', value: r.family },
            { field: 'meaning', role: 'text', value: r.meaning },
          ])
        )
      )
      .filter(Boolean) as SearchHit[],
  };
}

// — News ——————————————————————————————————————————————————————————————————
//
// The only domain not backed by Postgres. News is editorial CMS content in Redis
// (FEDERATION-ARCHITECTURE §1) and is exactly what the public site already
// renders, so it is public and carries no scope to filter on — there is no
// visibleScopes() call here because there is no scope column to apply it to, and
// pretending otherwise would be a filter that filters nothing.

async function searchNews(c: DomainContext): Promise<DomainResult> {
  let items: NewsItem[];
  try {
    items = await c.newsProvider();
  } catch {
    // The editorial store being unreachable must not take the whole search down.
    // It is reported as unavailable rather than empty, because "Redis is down"
    // and "the federation has published no news" are different facts and a
    // reader is entitled to know which one they are looking at.
    return { skip: 'store_unavailable' };
  }
  if (!Array.isArray(items)) return { skip: 'store_unavailable' };

  const hits: SearchHit[] = [];
  for (const [i, item] of items.entries()) {
    if (!item || typeof item !== 'object') continue;
    const match = explainMatch(c.q, [
      { field: 'title', role: 'name', value: item.title },
      { field: 'body', role: 'text', value: item.body },
    ]);
    const hit = toHit(
      'news',
      c.url,
      {
        // Editorial items normally carry an id; position is the fallback so an
        // item saved without one is still addressable rather than dropped.
        id: item.id ?? `pos-${i}`,
        ref: null,
        title: typeof item.title === 'string' ? item.title : '(untitled)',
        subtitle: [item.date, item.type].filter(Boolean).join(' · ') || null,
      },
      match
    );
    if (hit) hits.push(hit);
  }
  // Deterministic before the cap, so the same query keeps the same items.
  hits.sort(
    (a, b) =>
      a.matchedOn.rank - b.matchedOn.rank ||
      (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  return { saturated: hits.length > c.fetch, hits: hits.slice(0, c.fetch) };
}

// ─── The registry ───────────────────────────────────────────────────────────

const DOMAINS: Record<SearchKind, (c: DomainContext) => Promise<DomainResult>> = {
  person: searchPeople,
  dojo: searchDojos,
  state_unit: searchStateUnits,
  district_unit: searchDistrictUnits,
  competition_event: searchCompetitionEvents,
  certificate: searchCertificates,
  course: searchCourses,
  document: searchDocuments,
  technique: searchTechniques,
  kata: searchKata,
  news: searchNews,
};

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * Search the federation.
 *
 * `principal` may be null for an anonymous caller; that caller reaches only
 * PUBLIC_KINDS, and each of those searchers still applies its own published or
 * active predicate, so the restriction survives someone later adding a domain to
 * the public list by mistake.
 *
 * Every domain that returns nothing says why, in `skipped`, and every rule that
 * could not be applied because the federation has not configured it says so in
 * `notices`. An empty result with no explanation is indistinguishable from a
 * broken query, and the difference between "you may not see this", "there is
 * nothing here" and "nobody has told this system what the rule is" is exactly
 * what a member asking why their record cannot be found needs to be told.
 *
 * Malformed input is REFUSED rather than coerced: an unknown domain, a
 * non-finite limit, a non-string query. A coerced input produces an answer
 * nobody asked for, and in this module those answers were "the whole federation"
 * and "nothing, and that is all of it".
 */
export async function search(
  db: DB,
  principal: Principal | null,
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResponse> {
  const q = normalise(query);
  const limit = boundLimit(opts.limit);

  // A principal whose bindings are not an array is a BROKEN principal, not a
  // powerful one. rbac.visibleScopes() iterates `bindings` directly and would
  // throw a TypeError out of the middle of a search; reducing it to anonymous
  // here means an unresolvable caller reaches the public surface and nothing
  // else (invariant 3), and the failure is a result rather than a stack trace.
  const caller: Principal | null =
    principal && Array.isArray(principal.bindings) ? principal : null;
  const anonymous = !caller || caller.bindings.length === 0;

  // OMITTED means every domain; an EMPTY ARRAY means none. Reading `[]` as
  // "everything" is how a caller that narrowed its domain list down to nothing
  // ends up searching the whole federation.
  const requested = requestedKinds(opts.kinds);
  const skipped: Array<{ kind: SearchKind; reason: SkipReason }> = [];
  const notices: SearchNotice[] = [];

  const ctx: DomainContext = {
    db,
    principal: caller,
    q,
    fetch: limit + 1,
    url: opts.url ?? DEFAULT_URL,
    newsProvider: opts.newsProvider ?? (() => storageGet<NewsItem[]>('news')),
    policy: opts.policy ?? {},
    notices,
  };

  const searched: SearchKind[] = [];
  const hits: SearchHit[] = [];
  // True as soon as ANY domain filled its fetch window, independently of how
  // many of its rows survived to become hits.
  let saturated = false;

  for (const kind of KIND_ORDER) {
    if (!requested.includes(kind)) {
      skipped.push({ kind, reason: 'not_requested' });
      continue;
    }
    // First of the two anonymous gates. The second lives inside each searcher.
    if (anonymous && !PUBLIC_KINDS.includes(kind)) {
      skipped.push({ kind, reason: 'not_public' });
      continue;
    }
    const result = await DOMAINS[kind](ctx);
    if ('skip' in result) {
      skipped.push({ kind, reason: result.skip });
      continue;
    }
    searched.push(kind);
    if (result.saturated) saturated = true;
    hits.push(...result.hits);
  }

  // Total order: relevance, then a fixed domain order, then title, then id.
  // Every key is deterministic, so the same query over the same data always
  // produces the same list — a search whose order drifts cannot be tested.
  hits.sort(
    (a, b) =>
      a.matchedOn.rank - b.matchedOn.rank ||
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );

  // Either more survived than the page holds, or a domain left rows behind at
  // its window. Saying `false` here is a claim that the caller is looking at
  // everything, and that claim has to be earned.
  const truncated = hits.length > limit || saturated;
  const response: SearchResponse = {
    query: q,
    kinds: searched,
    skipped,
    notices,
    hits: hits.slice(0, limit),
    truncated,
  };

  if (opts.audit) {
    // An audit row naming someone other than the caller is worse than none:
    // it is a false record of who read the register. The context carries its
    // own Principal for ip/reason, so this is a real mismatch to guard.
    const actor = opts.audit.principal;
    if (!caller || !actor || actor.userId !== caller.userId || actor.label !== caller.label) {
      throw new SearchError(
        'audit_actor_mismatch',
        'The audit context names a different principal than the one that searched.'
      );
    }
    // Recorded as an export: the register leaving the system a page at a time is
    // still the register leaving the system. The query is stored so a later
    // review can see what was asked, not merely that something was.
    await writeAudit(db, opts.audit, {
      entityType: 'search',
      entityId: null,
      action: 'export',
      newValue: {
        query: q,
        kinds: searched,
        skipped,
        notices,
        returned: response.hits.length,
        // Candidates seen, NOT a total: each domain stops at `fetch` rows, so
        // this is what the ranking chose from. Recording it as a match count
        // would be a number implying a full scan that never happened.
        candidates: hits.length,
        truncated,
      },
    });
  }

  return response;
}
