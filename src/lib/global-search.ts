// Federation-wide search, grouped by record type (§10, §11).
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS IS NOT A SECOND SEARCH ENGINE. IT IS A LAYER OVER THE ONE IN search.ts.
// ─────────────────────────────────────────────────────────────────────────────
//
// src/lib/search.ts already owns the hard parts — relevance tiers, the scope
// predicate built from visibleScopes(), the refusal to return a row whose match
// cannot be explained, and the rule that certificates are found by exact number
// only. Re-deriving any of that here would mean two implementations of one
// permission model, and the second one is always the one that drifts. So:
//
//  · THE ELEVEN DOMAINS search.ts ALREADY COVERS ARE NOT REIMPLEMENTED. They are
//    obtained by calling search() ONCE PER KIND. That costs exactly the same
//    number of SQL queries as one combined call — search() runs one query per
//    domain either way — and it buys the thing a single call cannot give:
//    a per-group cap and a per-group `truncated` flag. With one global limit,
//    a query matching four hundred people crowds every other type off the page,
//    and grouping by type is the entire feature (§10).
//
//  · THE NINE DOMAINS IT DOES NOT COVER reuse its primitives — matchPredicate(),
//    rankExpression(), explainMatch() and scopeFilter() — which were made
//    exported for this module. Only the table-specific parts (which columns,
//    which Action gates them, which join reaches the scope columns) are written
//    here, because only those are genuinely new.
//
// WHAT WAS ADDED, AND WHAT IT IS GATED ON. Each of these has a real data model
// in this repository; none of them had a search path.
//
//    coach                    coach_profiles          coach:read
//    official                 official_quals          person:read
//    institution              institutions            engagement:read
//    registration             event_entries           competition:read
//    ranking                  ranking_entries         result:read
//    lead                     leads                   engagement:read
//    institution_application  institution_applications engagement:read
//    coach_application        coach_applications      coach:read
//    role_application         role_applications       role:grant (national only)
//
// Athletes are people, and people are search.ts's `person` domain — there is no
// separate athletes table to search, so adding an `athlete` kind would have meant
// a second name for one register. The federation's own organisations are its
// state and district units, which search.ts already covers as `state_unit` and
// `district_unit`; client organisations are the new `institution` kind.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THAT DECIDES WHICH COLUMNS MAY BE MATCHED
// ─────────────────────────────────────────────────────────────────────────────
//
// A CATEGORY LABEL IS NOT A MATCH FIELD. Matching `official.kind` would mean
// typing "referee" returns every referee in scope — that is a roster export with
// a search box in front of it, not a search, and it is the same failure
// search.ts refuses when it declines to find certificates by holder name. So
// officials, rankings and registrations are matched through the HOLDER's name
// and federation id, never through the grade, level, discipline, status or
// period label that classifies them.
//
// AND CONTACT DETAILS ARE NOT MATCH FIELDS. A lead carries an email address and
// a telephone number. Matching them would be useful and would also put the value
// into `matchedOn.value`, which is echoed back to the caller — so the search box
// would become a way to confirm "is this person's address in your database".
// Leads are matched on their reference, the contact's NAME and the city.
//
// Safeguarding, medical and disciplinary casework remains unreachable: there is
// no kind for it here either, so a hit is not representable. See
// NEVER_SEARCHABLE in search.ts.

import { and, asc, desc, eq, gte, isNotNull, isNull, or, type SQL } from 'drizzle-orm';
import * as s from '@/db/schema';
import * as o from '@/db/operations.schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { todayIso } from '@/db/membership';
import { canAnywhere, visibleScopes, type Principal } from '@/lib/rbac';
import {
  search,
  explainMatch,
  matchPredicate,
  rankExpression,
  scopeFilter,
  KIND_ORDER,
  MAX_QUERY_LENGTH,
  MIN_QUERY_LENGTH,
  SearchError,
  type MatchExplanation,
  type MatchField,
  type NewsItem,
  type SearchKind,
  type SearchNotice,
  type SearchPolicy,
  type SkipReason,
} from '@/lib/search';

type DB = any;

// ─── Kinds ──────────────────────────────────────────────────────────────────

/** The nine domains this module adds to the eleven search.ts already owns. */
export type ExtraKind =
  | 'coach'
  | 'official'
  | 'institution'
  | 'registration'
  | 'ranking'
  | 'lead'
  | 'institution_application'
  | 'coach_application'
  | 'role_application';

export type GlobalKind = SearchKind | ExtraKind;

/**
 * Group order. People first because a name is what is usually typed, then the
 * credentials that answer "is this person who they say they are", then places,
 * then competition, then the operational queues, then reference material.
 *
 * Fixed, so the same query over the same data produces the same page.
 */
export const GROUP_ORDER: readonly GlobalKind[] = [
  'person', 'coach', 'official', 'certificate',
  'dojo', 'state_unit', 'district_unit', 'institution',
  'competition_event', 'registration', 'ranking',
  'lead', 'institution_application', 'coach_application', 'role_application',
  'course', 'document', 'technique', 'kata', 'news',
];

/**
 * The type name shown above each group. §10 asks for the type to be NAMED, not
 * merely colour-coded: the same name returning an athlete, a coach, a result and
 * a certificate is only legible if each block says which it is.
 */
export const GROUP_LABEL: Record<GlobalKind, string> = {
  person: 'People',
  coach: 'Coaches',
  official: 'Officials',
  certificate: 'Certificates',
  dojo: 'Dojos',
  state_unit: 'State units',
  district_unit: 'District units',
  institution: 'Institutions',
  competition_event: 'Competitions',
  registration: 'Competition entries',
  ranking: 'Rankings',
  lead: 'Leads',
  institution_application: 'Institution applications',
  coach_application: 'Coach applications',
  role_application: 'Role applications',
  course: 'Courses',
  document: 'Documents',
  technique: 'Techniques',
  kata: 'Kata',
  news: 'News',
};

const EXTRA_KINDS: readonly ExtraKind[] = GROUP_ORDER.filter(
  (k): k is ExtraKind => !(KIND_ORDER as readonly string[]).includes(k)
);

// ─── Result shape ───────────────────────────────────────────────────────────

/**
 * Why a group is absent. Extends search.ts's own list with the two reasons that
 * only exist once domains are grouped and an empty query is answerable.
 */
export type GlobalSkipReason =
  | SkipReason
  /** Suggestion mode: this domain has nothing to suggest without a query. */
  | 'needs_query'
  /** Suggestion mode: this domain has no ordering that could produce "recent". */
  | 'no_recent_order';

export const SKIP_TEXT: Record<GlobalSkipReason, string> = {
  not_requested: 'not included in this search',
  not_public: 'sign in to search this',
  not_authorised: 'your account does not have access to this',
  no_visible_scope: 'you have no unit in scope for this',
  not_a_certificate_number:
    'certificates are found by their exact certificate number only — a name will not match one',
  store_unavailable: 'this content store is not reachable right now',
  needs_query: 'type something to search this',
  no_recent_order: 'this record type has no "recent" ordering, so it cannot be suggested',
};

export interface GlobalHit {
  kind: GlobalKind;
  id: string;
  /** The record's natural key — federation id, code, reference, entry number. */
  ref: string | null;
  title: string;
  subtitle: string | null;
  /** Null where the site has no route that resolves this record. See globalUrl(). */
  url: string | null;
  /**
   * Why the row came back — null ONLY in suggestion mode, where nothing was
   * matched. A null here in response to a real query would be a hit nobody can
   * account for, and those are dropped rather than shown.
   */
  matchedOn: MatchExplanation | null;
}

export interface GlobalGroup {
  kind: GlobalKind;
  label: string;
  hits: GlobalHit[];
  /** More matched in THIS group than the per-group cap allowed through. */
  truncated: boolean;
}

export type GlobalState =
  | 'results'
  | 'suggested'
  | 'too_short'
  | 'not_configured';

export interface GlobalSearchResponse {
  state: GlobalState;
  /** The normalised query actually executed. Empty string in suggestion mode. */
  query: string;
  groups: GlobalGroup[];
  /** Hits actually returned, across every group. */
  total: number;
  /** True when any group left rows behind. Never claims completeness it has not earned. */
  truncated: boolean;
  skipped: Array<{ kind: GlobalKind; label: string; reason: GlobalSkipReason; detail: string }>;
  notices: SearchNotice[];
}

// ─── Deep links (§11) ───────────────────────────────────────────────────────

export type GlobalUrlResolver = (hit: {
  kind: GlobalKind;
  id: string;
  ref: string | null;
}) => string | null;

/**
 * Resolve a hit to the page that opens THAT RECORD, for THIS caller.
 *
 * Two things this deliberately does not do.
 *
 * IT DOES NOT INVENT ROUTES. §11 asks every result to deep-link to the exact
 * entity, and for most record types this repository has no per-record page yet.
 * Emitting `/dojos/17` would satisfy the letter of that and produce a link to a
 * 404 — worse than no link, because a caller cannot tell a missing page from a
 * missing record. Every URL below was checked against a route that exists and
 * genuinely resolves a single record from the parameter given; everything else
 * returns null, and the surface renders those as plain text.
 *
 * IT DOES NOT LINK SOMEWHERE THE CALLER CANNOT GO. A person resolves to the
 * staff register entry for someone holding membership:read and to the public
 * register entry otherwise, because handing an /admin link to a member who will
 * be bounced at the door is the same broken promise as a 404.
 */
export function globalUrl(principal: Principal | null): GlobalUrlResolver {
  const staffRegister = canAnywhere(principal, 'membership:read');
  const staffPipeline = canAnywhere(principal, 'engagement:read');

  return (hit) => {
    switch (hit.kind) {
      // /admin/membership?id=… looks a federation id up; /athlete/:federationId
      // is the public register entry for the same person.
      case 'person':
        if (!hit.ref) return null;
        return staffRegister
          ? `/admin/membership?id=${encodeURIComponent(hit.ref)}`
          : `/athlete/${encodeURIComponent(hit.ref)}`;

      // The verification page, not /api/verify: a person following a search
      // result wants the page that explains the credential, not its JSON.
      case 'certificate':
        return hit.ref ? `/verify?id=${encodeURIComponent(hit.ref)}` : null;

      case 'competition_event':
        return `/competitions?event=${encodeURIComponent(hit.id)}`;

      case 'kata':
        return hit.ref ? `/kata/${encodeURIComponent(hit.ref)}` : null;

      case 'lead':
        return staffPipeline ? `/admin/leads?lead=${encodeURIComponent(hit.id)}` : null;

      // Everything else — coaches, officials, institutions, entries, rankings,
      // applications, dojos, units, courses, documents, techniques, news — has a
      // list surface but no route that opens one record. When one is built, it
      // is added here and nowhere else.
      default:
        return null;
    }
  };
}

// ─── Options ────────────────────────────────────────────────────────────────

export interface GlobalSearchOptions {
  /** Rows per GROUP, clamped to 1..MAX_PER_GROUP. The page cap is a consequence. */
  perGroup?: number;
  /** Restrict to these types. Omitted means every type the caller may reach. */
  kinds?: GlobalKind[];
  policy?: SearchPolicy;
  url?: GlobalUrlResolver;
  newsProvider?: () => Promise<NewsItem[]>;
  /**
   * When supplied, ONE audit row is written for the whole search.
   *
   * Not passed down to the per-kind search() calls: twenty domains would write
   * twenty rows for one keystroke, and an audit trail that has to be
   * de-duplicated before it can be read is not an audit trail.
   */
  audit?: AuditContext;
}

export const DEFAULT_PER_GROUP = 5;
export const MAX_PER_GROUP = 20;

function boundPerGroup(raw: unknown): number {
  if (raw === undefined) return DEFAULT_PER_GROUP;
  // Refused rather than clamped, for the reason boundLimit() in search.ts gives:
  // NaN silently becomes "no results, and that is all of them".
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new SearchError('per_group_invalid', 'Results per group must be a finite number.');
  }
  return Math.min(Math.max(1, Math.trunc(raw)), MAX_PER_GROUP);
}

// ─── The extra domains ──────────────────────────────────────────────────────

interface ExtraContext {
  db: DB;
  principal: Principal | null;
  /**
   * The query, or NULL in suggestion mode.
   *
   * One context serves both modes on purpose. A domain that built its
   * suggestion list separately from its search list would be two queries with
   * two sets of scope filters, and the day they disagree is the day the
   * suggestion list shows a row the search would have withheld.
   */
  q: string | null;
  /** Rows to pull: one more than the cap, so overflow is detectable. */
  fetch: number;
  url: GlobalUrlResolver;
}

type ExtraResult = { hits: GlobalHit[]; saturated: boolean } | { skip: GlobalSkipReason };

/**
 * Assemble a hit. In query mode a row with no explicable match is DROPPED, on
 * search.ts's rule: a hit that cannot say why it is a hit cannot be audited.
 */
function assemble(
  c: ExtraContext,
  kind: GlobalKind,
  row: { id: number | string; ref: string | null; title: string; subtitle: string | null },
  match: MatchExplanation | null
): GlobalHit | null {
  if (c.q !== null && !match) return null;
  const id = String(row.id);
  return {
    kind,
    id,
    ref: row.ref,
    title: row.title,
    subtitle: row.subtitle,
    url: c.url({ kind, id, ref: row.ref }),
    matchedOn: match,
  };
}

/** Join non-empty parts of a record into a subtitle. Never invents a value. */
function sub(parts: Array<unknown>): string | null {
  const kept = parts.filter((p) => p !== null && p !== undefined && p !== '').map(String);
  return kept.length ? kept.join(' · ') : null;
}

/** WHERE fragments common to both modes: match in query mode, nothing otherwise. */
function baseConds(c: ExtraContext, fields: MatchField[]): SQL[] {
  return c.q === null ? [] : [matchPredicate(c.q, fields)];
}

/** ORDER BY: relevance in query mode, most recent first in suggestion mode. */
function order(c: ExtraContext, fields: MatchField[], recent: any, ...tie: any[]): any[] {
  return c.q === null ? [desc(recent), ...tie] : [rankExpression(c.q, fields), ...tie];
}

// — Coaches ——————————————————————————————————————————————————————————————
//
// Gated on coach:read, which COACH_MANAGER, TRAINING_DIRECTOR and the sector
// managers hold and an ordinary member does not. `headline` is the coach's own
// public-facing blurb and is matched as prose; `danGrade` is a category and so
// is not a match field, only a subtitle.

async function searchCoaches(c: ExtraContext): Promise<ExtraResult> {
  if (!canAnywhere(c.principal, 'coach:read')) return { skip: 'not_authorised' };

  const scope = scopeFilter(c.principal, 'coach:read', {
    state: o.coachProfiles.stateUnitId,
    district: o.coachProfiles.districtUnitId,
    dojo: o.coachProfiles.homeDojoId,
  });
  if (scope.reach === 'none') return { skip: 'no_visible_scope' };

  const fields: MatchField[] = [
    { field: 'federationId', column: s.persons.federationId, role: 'identifier' },
    { field: 'fullName', column: s.persons.fullName, role: 'name' },
    { field: 'baseCity', column: o.coachProfiles.baseCity, role: 'name' },
    { field: 'headline', column: o.coachProfiles.headline, role: 'text' },
  ];
  const conds = baseConds(c, fields);
  if (scope.reach === 'scoped') conds.push(scope.predicate);

  const rows = await c.db
    .select({
      id: o.coachProfiles.id,
      status: o.coachProfiles.status,
      danGrade: o.coachProfiles.danGrade,
      baseCity: o.coachProfiles.baseCity,
      headline: o.coachProfiles.headline,
      federationId: s.persons.federationId,
      fullName: s.persons.fullName,
    })
    .from(o.coachProfiles)
    .innerJoin(s.persons, eq(s.persons.id, o.coachProfiles.personId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...order(c, fields, o.coachProfiles.createdAt, asc(s.persons.fullName), asc(o.coachProfiles.id)))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        assemble(
          c,
          'coach',
          {
            id: r.id,
            ref: r.federationId,
            title: r.fullName,
            subtitle: sub([r.danGrade, r.baseCity, r.status]),
          },
          c.q === null
            ? null
            : explainMatch(c.q, [
                { field: 'federationId', role: 'identifier', value: r.federationId },
                { field: 'fullName', role: 'name', value: r.fullName },
                { field: 'baseCity', role: 'name', value: r.baseCity },
                { field: 'headline', role: 'text', value: r.headline },
              ])
        )
      )
      .filter(Boolean) as GlobalHit[],
  };
}

// — Officials ——————————————————————————————————————————————————————————————
//
// An officiating credential, reached through its holder. `kind` (judge, referee,
// technical delegate) and `level` are NOT match fields — see the header: typing
// a category must not return the category.
//
// official_quals carries no unit columns, so the scope predicate is applied
// through the holder's placement, exactly as search.ts does for certificates.
//
// THE PUBLISHED DIRECTORY IS THE DEFAULT, NOT THE WHOLE REGISTER.
//
// `person:read` is a MEMBER-level action — every signed-in member and athlete
// holds it. What /officials publishes to the world is narrower than the table:
// publicOfficialsDirectory() serves only credentials that are active, held by
// an active person, and not past their expiry. Searching official_quals with no
// visibility clause would hand any member the rest of it — that a named
// person's referee licence is REVOKED, SUSPENDED or LAPSED — which is the same
// disclosure search.ts refuses when it keeps a suspended dojo affiliation out
// of the public directory. A withdrawn credential is the federation's news to
// break, not a search box's.
//
// So the directory clause stands on its own for a member, and is UNIONed with
// the caller's own reach for the office: `user:read` is what gates the staff
// view of these registries elsewhere (expiringLicences() in src/db/officials.ts
// asserts exactly that), so it is what widens this one. National `user:read`
// makes every clause redundant and the filter drops away entirely rather than
// being written as a tautology.

async function searchOfficials(c: ExtraContext): Promise<ExtraResult> {
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
  const conds = baseConds(c, fields);
  if (scope.reach === 'scoped') conds.push(scope.predicate);

  // Expiry is compared against today's date rather than left to the row's
  // status column: a licence whose expiry has passed has lapsed whether or not
  // anyone has run the job that flips its status.
  const office = scopeFilter(c.principal, 'user:read', {
    state: s.persons.stateUnitId,
    district: s.persons.districtUnitId,
    dojo: s.persons.dojoId,
  });
  if (office.reach !== 'all') {
    const directory = and(
      eq(s.officialQuals.status, 'active'),
      eq(s.persons.status, 'active'),
      or(isNull(s.officialQuals.expiresOn), gte(s.officialQuals.expiresOn, todayIso()))
    ) as SQL;
    conds.push(
      office.reach === 'scoped' ? (or(directory, office.predicate) as SQL) : directory
    );
  }

  const rows = await c.db
    .select({
      id: s.officialQuals.id,
      kind: s.officialQuals.kind,
      level: s.officialQuals.level,
      status: s.officialQuals.status,
      expiresOn: s.officialQuals.expiresOn,
      federationId: s.persons.federationId,
      fullName: s.persons.fullName,
    })
    .from(s.officialQuals)
    .innerJoin(s.persons, eq(s.persons.id, s.officialQuals.personId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...order(c, fields, s.officialQuals.createdAt, asc(s.persons.fullName), asc(s.officialQuals.id)))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        assemble(
          c,
          'official',
          {
            id: r.id,
            ref: r.federationId,
            title: r.fullName,
            subtitle: sub([r.kind, r.level, r.status]),
          },
          c.q === null
            ? null
            : explainMatch(c.q, [
                { field: 'federationId', role: 'identifier', value: r.federationId },
                { field: 'fullName', role: 'name', value: r.fullName },
              ])
        )
      )
      .filter(Boolean) as GlobalHit[],
  };
}

// — Institutions ————————————————————————————————————————————————————————————
//
// A client school, corporate or university. `notes` is internal commentary about
// a customer and is not a match field: a search box is not the place to surface
// what a colleague wrote about a prospect.
//
// Institutions carry state and district columns but no dojo column, so a
// principal holding engagement:read only at dojo scope resolves to no visible
// scope — the fail-closed reading, and the correct one.

async function searchInstitutions(c: ExtraContext): Promise<ExtraResult> {
  if (!canAnywhere(c.principal, 'engagement:read')) return { skip: 'not_authorised' };

  const scope = scopeFilter(c.principal, 'engagement:read', {
    state: s.institutions.stateUnitId,
    district: s.institutions.districtUnitId,
  });
  if (scope.reach === 'none') return { skip: 'no_visible_scope' };

  const fields: MatchField[] = [
    { field: 'code', column: s.institutions.code, role: 'identifier' },
    { field: 'name', column: s.institutions.name, role: 'name' },
    { field: 'city', column: s.institutions.city, role: 'name' },
  ];
  const conds = baseConds(c, fields);
  if (scope.reach === 'scoped') conds.push(scope.predicate);

  const rows = await c.db
    .select({
      id: s.institutions.id,
      code: s.institutions.code,
      name: s.institutions.name,
      kind: s.institutions.kind,
      city: s.institutions.city,
      status: s.institutions.status,
    })
    .from(s.institutions)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...order(c, fields, s.institutions.createdAt, asc(s.institutions.name), asc(s.institutions.id)))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        assemble(
          c,
          'institution',
          {
            id: r.id,
            ref: r.code,
            title: r.name,
            subtitle: sub([r.kind, r.city, r.status]),
          },
          c.q === null
            ? null
            : explainMatch(c.q, [
                { field: 'code', role: 'identifier', value: r.code },
                { field: 'name', role: 'name', value: r.name },
                { field: 'city', role: 'name', value: r.city },
              ])
        )
      )
      .filter(Boolean) as GlobalHit[],
  };
}

// — Competition entries ————————————————————————————————————————————————————
//
// One athlete's registration for one category. A team entry has no personId, so
// the join to persons is a LEFT join and such a row is titled by its entry
// number — dropping team entries because they have no individual would make the
// draw look smaller than it is.

async function searchRegistrations(c: ExtraContext): Promise<ExtraResult> {
  if (!canAnywhere(c.principal, 'competition:read')) return { skip: 'not_authorised' };

  const scope = scopeFilter(c.principal, 'competition:read', {
    state: s.eventEntries.stateUnitId,
    dojo: s.eventEntries.dojoId,
  });
  if (scope.reach === 'none') return { skip: 'no_visible_scope' };

  const fields: MatchField[] = [
    { field: 'entryNo', column: s.eventEntries.entryNo, role: 'identifier' },
    { field: 'federationId', column: s.persons.federationId, role: 'identifier' },
    { field: 'fullName', column: s.persons.fullName, role: 'name' },
  ];
  const conds = baseConds(c, fields);
  if (scope.reach === 'scoped') conds.push(scope.predicate);

  const rows = await c.db
    .select({
      id: s.eventEntries.id,
      entryNo: s.eventEntries.entryNo,
      status: s.eventEntries.status,
      eventTitle: s.competitionEvents.title,
      federationId: s.persons.federationId,
      fullName: s.persons.fullName,
    })
    .from(s.eventEntries)
    .innerJoin(s.competitionEvents, eq(s.competitionEvents.id, s.eventEntries.eventId))
    .leftJoin(s.persons, eq(s.persons.id, s.eventEntries.personId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...order(c, fields, s.eventEntries.createdAt, asc(s.eventEntries.entryNo), asc(s.eventEntries.id)))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        assemble(
          c,
          'registration',
          {
            id: r.id,
            ref: r.entryNo,
            title: r.fullName || r.entryNo,
            subtitle: sub([r.eventTitle, r.fullName ? r.entryNo : null, r.status]),
          },
          c.q === null
            ? null
            : explainMatch(c.q, [
                { field: 'entryNo', role: 'identifier', value: r.entryNo },
                { field: 'federationId', role: 'identifier', value: r.federationId },
                { field: 'fullName', role: 'name', value: r.fullName },
              ])
        )
      )
      .filter(Boolean) as GlobalHit[],
  };
}

// — Rankings ——————————————————————————————————————————————————————————————
//
// A position in a ranking table is a PUBLISHED FEDERATION STATEMENT. An
// unpublished period is a computation nobody has stood behind yet, so it is
// visible only to those who may finalise results — the same distinction the
// athlete profile makes when it shows final results and withholds provisional
// ones.
//
// The period label is not a match field: matching it would return the whole
// table, which is a leaderboard export rather than a search.
//
// ranking_entries has no createdAt, so it cannot answer "recent" and says so in
// suggestion mode rather than being silently absent.

async function searchRankings(c: ExtraContext): Promise<ExtraResult> {
  if (!canAnywhere(c.principal, 'result:read')) return { skip: 'not_authorised' };
  if (c.q === null) return { skip: 'no_recent_order' };

  const scope = scopeFilter(c.principal, 'result:read', {
    state: s.rankingEntries.stateUnitId,
    dojo: s.rankingEntries.dojoId,
  });
  if (scope.reach === 'none') return { skip: 'no_visible_scope' };

  const fields: MatchField[] = [
    { field: 'federationId', column: s.persons.federationId, role: 'identifier' },
    { field: 'fullName', column: s.persons.fullName, role: 'name' },
  ];
  const conds = baseConds(c, fields);
  if (scope.reach === 'scoped') conds.push(scope.predicate);
  if (!canAnywhere(c.principal, 'result:finalize')) {
    conds.push(isNotNull(s.rankingPeriods.publishedAt) as SQL);
  }

  const rows = await c.db
    .select({
      id: s.rankingEntries.id,
      rank: s.rankingEntries.rank,
      points: s.rankingEntries.points,
      label: s.rankingPeriods.label,
      categoryKey: s.rankingPeriods.categoryKey,
      federationId: s.persons.federationId,
      fullName: s.persons.fullName,
    })
    .from(s.rankingEntries)
    .innerJoin(s.rankingPeriods, eq(s.rankingPeriods.id, s.rankingEntries.periodId))
    .innerJoin(s.persons, eq(s.persons.id, s.rankingEntries.personId))
    .where(and(...conds))
    .orderBy(rankExpression(c.q, fields), asc(s.rankingEntries.rank), asc(s.rankingEntries.id))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        assemble(
          c,
          'ranking',
          {
            id: r.id,
            ref: r.federationId,
            title: r.fullName,
            // Every part is a stored column. Nothing here is computed into a
            // statistic the federation has not published.
            subtitle: sub([r.label, r.categoryKey, `rank ${r.rank}`, `${r.points} points`]),
          },
          explainMatch(c.q!, [
            { field: 'federationId', role: 'identifier', value: r.federationId },
            { field: 'fullName', role: 'name', value: r.fullName },
          ])
        )
      )
      .filter(Boolean) as GlobalHit[],
  };
}

// — Leads ——————————————————————————————————————————————————————————————————
//
// The engagement pipeline. Contact email and telephone are deliberately not
// match fields — see the header. The subtitle carries neither.

async function searchLeads(c: ExtraContext): Promise<ExtraResult> {
  if (!canAnywhere(c.principal, 'engagement:read')) return { skip: 'not_authorised' };

  const scope = scopeFilter(c.principal, 'engagement:read', {
    state: s.leads.stateUnitId,
    district: s.leads.districtUnitId,
  });
  if (scope.reach === 'none') return { skip: 'no_visible_scope' };

  const fields: MatchField[] = [
    { field: 'ref', column: s.leads.ref, role: 'identifier' },
    { field: 'contactName', column: s.leads.contactName, role: 'name' },
    { field: 'city', column: s.leads.city, role: 'name' },
  ];
  const conds = baseConds(c, fields);
  if (scope.reach === 'scoped') conds.push(scope.predicate);

  const rows = await c.db
    .select({
      id: s.leads.id,
      ref: s.leads.ref,
      contactName: s.leads.contactName,
      audience: s.leads.audience,
      status: s.leads.status,
      city: s.leads.city,
    })
    .from(s.leads)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...order(c, fields, s.leads.createdAt, asc(s.leads.ref), asc(s.leads.id)))
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        assemble(
          c,
          'lead',
          {
            id: r.id,
            ref: r.ref,
            // A lead can arrive with no named contact. Its reference is then the
            // only honest title — "Unnamed lead" would be invented copy.
            title: r.contactName || r.ref,
            subtitle: sub([r.audience, r.city, r.status]),
          },
          c.q === null
            ? null
            : explainMatch(c.q, [
                { field: 'ref', role: 'identifier', value: r.ref },
                { field: 'contactName', role: 'name', value: r.contactName },
                { field: 'city', role: 'name', value: r.city },
              ])
        )
      )
      .filter(Boolean) as GlobalHit[],
  };
}

// — Institution applications ————————————————————————————————————————————————

async function searchInstitutionApplications(c: ExtraContext): Promise<ExtraResult> {
  if (!canAnywhere(c.principal, 'engagement:read')) return { skip: 'not_authorised' };

  const scope = scopeFilter(c.principal, 'engagement:read', {
    state: o.institutionApplications.stateUnitId,
    district: o.institutionApplications.districtUnitId,
  });
  if (scope.reach === 'none') return { skip: 'no_visible_scope' };

  const fields: MatchField[] = [
    { field: 'ref', column: o.institutionApplications.ref, role: 'identifier' },
    { field: 'institutionName', column: o.institutionApplications.institutionName, role: 'name' },
    { field: 'city', column: o.institutionApplications.city, role: 'name' },
  ];
  const conds = baseConds(c, fields);
  if (scope.reach === 'scoped') conds.push(scope.predicate);

  const rows = await c.db
    .select({
      id: o.institutionApplications.id,
      ref: o.institutionApplications.ref,
      institutionName: o.institutionApplications.institutionName,
      audience: o.institutionApplications.audience,
      city: o.institutionApplications.city,
      status: o.institutionApplications.status,
    })
    .from(o.institutionApplications)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(
      ...order(
        c,
        fields,
        o.institutionApplications.createdAt,
        asc(o.institutionApplications.ref),
        asc(o.institutionApplications.id)
      )
    )
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        assemble(
          c,
          'institution_application',
          {
            id: r.id,
            ref: r.ref,
            title: r.institutionName,
            subtitle: sub([r.audience, r.city, r.status]),
          },
          c.q === null
            ? null
            : explainMatch(c.q, [
                { field: 'ref', role: 'identifier', value: r.ref },
                { field: 'institutionName', role: 'name', value: r.institutionName },
                { field: 'city', role: 'name', value: r.city },
              ])
        )
      )
      .filter(Boolean) as GlobalHit[],
  };
}

// — Coach applications ——————————————————————————————————————————————————————
//
// Gated on coach:read rather than coach:review: finding an application is not
// deciding it, and a coach manager who cannot search the pipeline they own has
// to page through it instead.

async function searchCoachApplications(c: ExtraContext): Promise<ExtraResult> {
  if (!canAnywhere(c.principal, 'coach:read')) return { skip: 'not_authorised' };

  const scope = scopeFilter(c.principal, 'coach:read', {
    state: o.coachApplications.stateUnitId,
    district: o.coachApplications.districtUnitId,
  });
  if (scope.reach === 'none') return { skip: 'no_visible_scope' };

  const fields: MatchField[] = [
    { field: 'ref', column: o.coachApplications.ref, role: 'identifier' },
    { field: 'fullName', column: o.coachApplications.fullName, role: 'name' },
    { field: 'city', column: o.coachApplications.city, role: 'name' },
  ];
  const conds = baseConds(c, fields);
  if (scope.reach === 'scoped') conds.push(scope.predicate);

  const rows = await c.db
    .select({
      id: o.coachApplications.id,
      ref: o.coachApplications.ref,
      fullName: o.coachApplications.fullName,
      city: o.coachApplications.city,
      danGrade: o.coachApplications.danGrade,
      status: o.coachApplications.status,
    })
    .from(o.coachApplications)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(
      ...order(c, fields, o.coachApplications.createdAt, asc(o.coachApplications.ref), asc(o.coachApplications.id))
    )
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        assemble(
          c,
          'coach_application',
          {
            id: r.id,
            ref: r.ref,
            title: r.fullName,
            subtitle: sub([r.danGrade, r.city, r.status]),
          },
          c.q === null
            ? null
            : explainMatch(c.q, [
                { field: 'ref', role: 'identifier', value: r.ref },
                { field: 'fullName', role: 'name', value: r.fullName },
                { field: 'city', role: 'name', value: r.city },
              ])
        )
      )
      .filter(Boolean) as GlobalHit[],
  };
}

// — Role applications ————————————————————————————————————————————————————————
//
// A request to be granted authority. NATIONAL role:grant ONLY.
//
// role_applications records the scope APPLIED FOR (scopeType + scopeId), not a
// state_unit_id, and canGrantRole() lets a scoped granter act only at their
// exact scope. Resolving "which of these applications is at a scope this caller
// covers" needs the hierarchy walk this module does not own, and an unresolvable
// scope grants nothing (search.ts invariant 3) — so anyone short of national
// reach is told they have no visible scope rather than shown the queue.

async function searchRoleApplications(c: ExtraContext): Promise<ExtraResult> {
  if (!canAnywhere(c.principal, 'role:grant')) return { skip: 'not_authorised' };
  if (visibleScopes(c.principal, 'role:grant').kind !== 'all') return { skip: 'no_visible_scope' };

  const fields: MatchField[] = [
    { field: 'ref', column: s.roleApplications.ref, role: 'identifier' },
    { field: 'fullName', column: s.persons.fullName, role: 'name' },
  ];
  const conds = baseConds(c, fields);

  const rows = await c.db
    .select({
      id: s.roleApplications.id,
      ref: s.roleApplications.ref,
      requestedRole: s.roleApplications.requestedRole,
      scopeType: s.roleApplications.scopeType,
      status: s.roleApplications.status,
      fullName: s.persons.fullName,
    })
    .from(s.roleApplications)
    // Left: an application may come from an account with no person record yet,
    // and refusing to show it would hide exactly the applicants who are new.
    .leftJoin(s.persons, eq(s.persons.id, s.roleApplications.personId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(
      ...order(c, fields, s.roleApplications.createdAt, asc(s.roleApplications.ref), asc(s.roleApplications.id))
    )
    .limit(c.fetch);

  return {
    saturated: rows.length >= c.fetch,
    hits: rows
      .map((r: any) =>
        assemble(
          c,
          'role_application',
          {
            id: r.id,
            ref: r.ref,
            title: r.fullName || r.ref,
            subtitle: sub([r.requestedRole, r.scopeType, r.status]),
          },
          c.q === null
            ? null
            : explainMatch(c.q, [
                { field: 'ref', role: 'identifier', value: r.ref },
                { field: 'fullName', role: 'name', value: r.fullName },
              ])
        )
      )
      .filter(Boolean) as GlobalHit[],
  };
}

const EXTRA_DOMAINS: Record<ExtraKind, (c: ExtraContext) => Promise<ExtraResult>> = {
  coach: searchCoaches,
  official: searchOfficials,
  institution: searchInstitutions,
  registration: searchRegistrations,
  ranking: searchRankings,
  lead: searchLeads,
  institution_application: searchInstitutionApplications,
  coach_application: searchCoachApplications,
  role_application: searchRoleApplications,
};

// ─── Entry point ────────────────────────────────────────────────────────────

/** Normalise without refusing: an empty query is a legitimate request here. */
function tidy(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

/**
 * Search every record type the caller may reach, grouped by type.
 *
 * THREE ANSWERS THIS RETURNS THAT A SEARCH BOX USUALLY THROWS AWAY.
 *
 *  · `skipped` — the types this search did NOT cover, and why. An empty result
 *    and a withheld result are indistinguishable unless the answer says which,
 *    and "you may not see this", "there is nothing here" and "nobody has told
 *    this system what the rule is" are three different facts.
 *  · `notices` — federation rules that were not applied because they have never
 *    been configured. Carried straight through from search.ts.
 *  · per-group `truncated` — which groups left rows behind. A group that
 *    silently shows five of ninety is a lie about the size of the register.
 *
 * AN EMPTY QUERY RETURNS SUGGESTIONS, NEVER EVERYTHING. The suggestion set is
 * the caller's most RECENT records in the operational domains they may reach —
 * real rows, ordered by their own createdAt. The eleven domains in search.ts
 * cannot answer without a query (search() requires one), so they are reported as
 * `needs_query` rather than quietly omitted.
 */
export async function globalSearch(
  db: DB,
  principal: Principal | null,
  rawQuery: string,
  opts: GlobalSearchOptions = {}
): Promise<GlobalSearchResponse> {
  const perGroup = boundPerGroup(opts.perGroup);
  const query = tidy(rawQuery);

  // A principal whose bindings are not an array is BROKEN, not powerful.
  // search.ts reduces such a caller to anonymous for the same reason: an
  // unresolvable identity must reach the public surface and nothing else.
  const caller: Principal | null =
    principal && Array.isArray(principal.bindings) ? principal : null;

  const url = opts.url ?? globalUrl(caller);
  const requested: readonly GlobalKind[] =
    opts.kinds === undefined ? GROUP_ORDER : GROUP_ORDER.filter((k) => opts.kinds!.includes(k));

  const skipped: GlobalSearchResponse['skipped'] = [];
  const notices: SearchNotice[] = [];
  const groups: GlobalGroup[] = [];

  const note = (kind: GlobalKind, reason: GlobalSkipReason) =>
    skipped.push({ kind, label: GROUP_LABEL[kind], reason, detail: SKIP_TEXT[reason] });

  // A TYPE THE CALLER NARROWED AWAY IS REPORTED, NOT SILENTLY ABSENT. Without
  // this, a request for one type comes back with `groups: []` and an EMPTY
  // `skipped` whenever that type matched nothing, and a surface reading those
  // two fields says "nothing matched" about nineteen types it never looked at —
  // the exact confusion between a withheld answer and an empty one that the
  // rest of this module exists to prevent. search.ts records `not_requested`
  // for the same reason.
  if (opts.kinds !== undefined) {
    for (const kind of GROUP_ORDER) {
      if (!requested.includes(kind)) note(kind, 'not_requested');
    }
  }

  if (query.length > 0 && query.length < MIN_QUERY_LENGTH) {
    // A one-character query matches most of the register and answers nothing.
    // Reported as its own state so a surface can say so instead of rendering
    // "no results", which would be the opposite of the truth.
    return { state: 'too_short', query, groups: [], total: 0, truncated: false, skipped, notices };
  }

  const suggesting = query.length === 0;
  const ctx: ExtraContext = {
    db,
    principal: caller,
    q: suggesting ? null : query,
    // One more than the cap: without it a group that exactly fills is
    // indistinguishable from one with nothing behind it.
    fetch: perGroup + 1,
    url,
  };

  // ── The eleven domains search.ts owns ──────────────────────────────────────
  //
  // One call per kind. Each runs a single query, so this is the same database
  // cost as one combined call, and it is what makes a per-GROUP cap possible.
  const nativeWanted = requested.filter((k): k is SearchKind =>
    (KIND_ORDER as readonly string[]).includes(k)
  );

  const nativeResults = await Promise.all(
    nativeWanted.map(async (kind) => {
      if (suggesting) return { kind, suggestion: true as const };
      try {
        const r = await search(db, caller, query, {
          kinds: [kind],
          limit: perGroup,
          policy: opts.policy,
          newsProvider: opts.newsProvider,
          // Deliberately no `url` and no `audit`. The URL resolver is applied
          // here so one table maps every kind, native and extra alike; the audit
          // is written once for the whole search rather than once per domain.
        });
        return { kind, response: r };
      } catch (err) {
        return { kind, error: err };
      }
    })
  );

  let truncated = false;

  for (const kind of requested) {
    if (!(KIND_ORDER as readonly string[]).includes(kind)) continue;
    const entry = nativeResults.find((n) => n.kind === kind)!;

    if ('suggestion' in entry) {
      note(kind, 'needs_query');
      continue;
    }
    if ('error' in entry) {
      // A domain that failed is not a domain that was empty. It is reported as
      // unreachable so the caller is never told "nothing matched" by a query
      // that never ran.
      note(kind, 'store_unavailable');
      continue;
    }
    const r = entry.response;
    for (const n of r.notices) {
      if (!notices.some((existing) => existing.code === n.code)) notices.push(n);
    }
    const skip = r.skipped.find((sk) => sk.kind === kind && sk.reason !== 'not_requested');
    if (skip) {
      note(kind, skip.reason);
      continue;
    }
    if (!r.hits.length) continue;

    // search.ts resolved URLs with its own DEFAULT_URL; re-resolve through the
    // one table this module owns so a native and an extra kind cannot disagree
    // about where a record lives.
    const hits: GlobalHit[] = r.hits.map((h) => ({
      kind: h.kind as GlobalKind,
      id: h.id,
      ref: h.ref,
      title: h.title,
      subtitle: h.subtitle,
      url: url({ kind: h.kind as GlobalKind, id: h.id, ref: h.ref }),
      matchedOn: h.matchedOn,
    }));
    if (r.truncated) truncated = true;
    groups.push({ kind, label: GROUP_LABEL[kind], hits, truncated: r.truncated });
  }

  // ── The nine domains this module adds ──────────────────────────────────────
  const extraWanted = requested.filter((k): k is ExtraKind =>
    (EXTRA_KINDS as readonly string[]).includes(k)
  );

  const extraResults = await Promise.all(
    extraWanted.map(async (kind) => {
      try {
        return { kind, result: await EXTRA_DOMAINS[kind](ctx) };
      } catch (err) {
        return { kind, error: err };
      }
    })
  );

  for (const kind of requested) {
    if (!(EXTRA_KINDS as readonly string[]).includes(kind)) continue;
    const entry = extraResults.find((e) => e.kind === kind)!;
    if ('error' in entry) {
      note(kind, 'store_unavailable');
      continue;
    }
    const r = entry.result;
    if ('skip' in r) {
      note(kind, r.skip);
      continue;
    }
    if (!r.hits.length) continue;
    if (r.saturated) truncated = true;
    groups.push({
      kind,
      label: GROUP_LABEL[kind],
      hits: r.hits.slice(0, perGroup),
      truncated: r.saturated,
    });
  }

  // Groups back into the fixed order. Both halves ran concurrently, so without
  // this the page order would depend on which query finished first — and a
  // search whose layout moves between runs cannot be tested or trusted.
  groups.sort((a, b) => GROUP_ORDER.indexOf(a.kind) - GROUP_ORDER.indexOf(b.kind));
  skipped.sort((a, b) => GROUP_ORDER.indexOf(a.kind) - GROUP_ORDER.indexOf(b.kind));

  const total = groups.reduce((n, g) => n + g.hits.length, 0);

  const response: GlobalSearchResponse = {
    state: suggesting ? 'suggested' : 'results',
    query,
    groups,
    total,
    truncated,
    skipped,
    notices,
  };

  if (opts.audit) {
    // An audit row naming someone other than the caller is worse than no row at
    // all: it is a false record of who read the register.
    const actor = opts.audit.principal;
    if (!caller || !actor || actor.userId !== caller.userId || actor.label !== caller.label) {
      throw new SearchError(
        'audit_actor_mismatch',
        'The audit context names a different principal than the one that searched.'
      );
    }
    await writeAudit(db, opts.audit, {
      entityType: 'search:global',
      entityId: null,
      // Recorded as an export: the register leaving the system a page at a time
      // is still the register leaving the system.
      action: 'export',
      newValue: {
        query,
        state: response.state,
        groups: groups.map((g) => ({ kind: g.kind, returned: g.hits.length, truncated: g.truncated })),
        skipped,
        notices,
        returned: total,
        truncated,
      },
    });
  }

  return response;
}
