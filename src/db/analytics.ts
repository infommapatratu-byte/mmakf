// Federation analytics and the annual report. Q-18, Q-22.
//
// THE REASON THIS MODULE EXISTS: the public site currently says "5,000+
// students" and "130+ schools" and cannot say where either number came from.
// Every figure produced here is a COUNT OF ROWS, run against the register, with
// the table and the filter that produced it travelling alongside the number. A
// reader who doubts a total can reconstruct it. That is the whole point, and it
// is the discipline this file must never lose.
//
// FOUR RULES SHAPE EVERY FUNCTION BELOW:
//
//  1. NOTHING IS ESTIMATED. No projection, no rounding up, no "+", no figure
//     carried over from a previous report. If the database does not know it,
//     this module does not report it.
//
//  2. ZERO IS REPORTED AS ZERO — on a dashboard. A dashboard is a live view of
//     the register and an empty register is a true answer. The ANNUAL REPORT is
//     different: there, a section with no source rows says "no records for this
//     period" and returns null, because a printed "0 gradings held" reads as a
//     measurement and would be indistinguishable from a year nobody recorded.
//
//  3. A TOTAL LEAKS AS QUIETLY AS A ROW. Scope is applied IN SQL, from the
//     principal's own bindings, on every scoped query. A state administrator
//     asking for another state's dashboard is refused, not silently served.
//
//  4. A FIGURE THAT CANNOT BE NARROWED TO THE REQUESTED SCOPE IS WITHHELD, not
//     substituted with the national number. `event_entries` records no district
//     unit, so a district dashboard says so rather than quietly reporting the
//     whole federation's entries under a district heading.
//
// This module WRITES NOTHING — no audit row, no cache, no materialised total.
// It cannot corrupt the record it reports on, and every call re-derives from
// the authoritative tables, so a corrected result or a revoked certificate is
// reflected the moment it happens.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as s from './schema';
import { assertCan, assertCanAnywhere, canAnywhere, type Action, type Principal } from '@/lib/rbac';

// ─── Gates borrowed from the modules that own the rows ──────────────────────
//
// A COUNT IS A READ. Anything this module can only report by reading rows that
// another module refuses to show must be gated on THAT module's gate, or the
// dashboard becomes a way round it. `src/lib/rbac.ts` is not this file's to
// edit, so the actions below are copied verbatim from `src/db/cases.ts`, which
// owns these tables and documents why each was chosen. If cases.ts changes its
// gate, this must change with it.
//
// The line is drawn at ROW CLASSIFICATION, not at every domain action: these
// three tables default to `classification` = confidential or highly_restricted,
// and a count over a small unit re-identifies the individual. Grade, unit and
// competition figures are not classified that way and are not gated further
// here — if the federation wants them narrowed, that belongs in rbac.ts.

/** cases.ts DISCIPLINE — no `discipline:*` action exists; sanctions imply this. */
const DISCIPLINE_READ: Action = 'membership:revoke';
/** cases.ts SUPPORT_DESK — a ticket carries a contact email and phone. */
const SUPPORT_DESK_READ: Action = 'person:read_pii';
/** cases.ts assertSafeguardingRead — held by SUPER_ADMIN/SAFEGUARDING_OFFICER only. */
const SAFEGUARDING_READ: Action = 'safeguarding:read';

type DB = any;

export class AnalyticsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AnalyticsError';
    this.code = code;
  }
}

// ─── Provenance ─────────────────────────────────────────────────────────────

/**
 * Where a number came from. Attached to every figure this module returns.
 *
 * `filter` is written for a human auditor, not for a machine: it must describe
 * the WHERE clause faithfully enough that someone with database access can
 * reproduce the count and get the same answer.
 */
export interface Source {
  table: string;
  filter: string;
  /** The date/timestamp column a period figure was bounded on, when there is one. */
  column?: string;
}

/** A figure that exists but was not returned, and the reason it was not. */
export interface Withheld {
  key: string;
  reason: 'not_authorised' | 'not_scopable';
  detail: string;
}

// ─── Scope ──────────────────────────────────────────────────────────────────

export type ScopeKind = 'national' | 'state' | 'district' | 'dojo';

export type ScopeInput =
  | { kind: 'national' }
  | { kind: 'state'; id: number }
  | { kind: 'district'; id: number }
  | { kind: 'dojo'; id: number };

/**
 * A resolved scope. Every id is filled in from the hierarchy, so a dojo scope
 * knows its district and its state — which is what lets a figure sourced from a
 * table that only records a state still be narrowed for a dojo dashboard.
 */
export interface ScopeRef {
  kind: ScopeKind;
  stateUnitId: number | null;
  districtUnitId: number | null;
  dojoId: number | null;
  label: string;
}

const NATIONAL: ScopeRef = {
  kind: 'national', stateUnitId: null, districtUnitId: null, dojoId: null,
  label: 'MMAKF (national)',
};

/**
 * Resolve a scope from the database, then authorise the principal against the
 * placement the database actually reports.
 *
 * The order is deliberate and is the same one `federation.ts` uses: an id the
 * caller supplied is not evidence of where that unit sits. Authorising against
 * a caller-asserted placement is how IDOR gets in.
 */
async function resolveScope(db: DB, principal: Principal, input: ScopeInput): Promise<ScopeRef> {
  if (input.kind === 'national') {
    // An empty resource is only contained by a NATIONAL binding, so this is
    // exactly the check that stops a state administrator reading the federation
    // totals — see scopeContains() in rbac.ts.
    assertCan(principal, 'unit:read', {});
    return NATIONAL;
  }

  if (input.kind === 'state') {
    const row = (await db.select().from(s.stateUnits).where(eq(s.stateUnits.id, input.id)).limit(1))[0];
    if (!row) throw new AnalyticsError('unknown_state_unit', 'Unknown state unit');
    assertCan(principal, 'unit:read', { stateUnitId: row.id });
    return { kind: 'state', stateUnitId: row.id, districtUnitId: null, dojoId: null, label: row.name };
  }

  if (input.kind === 'district') {
    const row = (await db.select().from(s.districtUnits).where(eq(s.districtUnits.id, input.id)).limit(1))[0];
    if (!row) throw new AnalyticsError('unknown_district_unit', 'Unknown district unit');
    // Both ids are passed so a STATE binding containing this district also
    // satisfies the check — authority flows downward through the hierarchy.
    assertCan(principal, 'unit:read', { stateUnitId: row.stateUnitId, districtUnitId: row.id });
    return {
      kind: 'district', stateUnitId: row.stateUnitId, districtUnitId: row.id,
      dojoId: null, label: row.name,
    };
  }

  const row = (await db.select().from(s.dojos).where(eq(s.dojos.id, input.id)).limit(1))[0];
  if (!row) throw new AnalyticsError('unknown_dojo', 'Unknown dojo');
  // 'dojo:read' rather than 'unit:read': a DOJO_ADMIN and an INSTRUCTOR hold
  // the former and not the latter, and both must be able to read their own
  // dojo's numbers.
  assertCan(principal, 'dojo:read', {
    stateUnitId: row.stateUnitId, districtUnitId: row.districtUnitId, dojoId: row.id,
  });
  return {
    kind: 'dojo', stateUnitId: row.stateUnitId, districtUnitId: row.districtUnitId,
    dojoId: row.id, label: row.name,
  };
}

// ─── Scope clauses ──────────────────────────────────────────────────────────

type ScopeClause =
  | { scopable: true; where: any | null }
  | { scopable: false; detail: string };

const ALL_ROWS: ScopeClause = { scopable: true, where: null };
const ok = (where: any): ScopeClause => ({ scopable: true, where });
const cannot = (detail: string): ScopeClause => ({ scopable: false, detail });

/** Scope a table that carries unit columns of its own. */
function byUnit(
  sc: ScopeRef,
  m: { state?: any; district?: any; dojo?: any },
  table: string
): ScopeClause {
  switch (sc.kind) {
    case 'national':
      return ALL_ROWS;
    case 'state':
      return m.state ? ok(eq(m.state, sc.stateUnitId!)) : cannot(`${table} records no state unit`);
    case 'district':
      return m.district ? ok(eq(m.district, sc.districtUnitId!)) : cannot(`${table} records no district unit`);
    case 'dojo':
      return m.dojo ? ok(eq(m.dojo, sc.dojoId!)) : cannot(`${table} records no dojo`);
  }
}

/**
 * Scope a table through the person it belongs to.
 *
 * EXISTS rather than a join: a join would multiply rows if the relationship
 * were ever one-to-many, and a count that silently double-counts is worse than
 * one that refuses.
 */
function byPerson(sc: ScopeRef, personCol: any): ScopeClause {
  if (sc.kind === 'national') return ALL_ROWS;
  const c =
    sc.kind === 'state' ? eq(s.persons.stateUnitId, sc.stateUnitId!)
      : sc.kind === 'district' ? eq(s.persons.districtUnitId, sc.districtUnitId!)
        : eq(s.persons.dojoId, sc.dojoId!);
  return ok(sql`EXISTS (SELECT 1 FROM ${s.persons} WHERE ${s.persons.id} = ${personCol} AND ${c})`);
}

/** Scope a table through the competition event it belongs to. */
function byEvent(sc: ScopeRef, eventCol: any): ScopeClause {
  if (sc.kind === 'national') return ALL_ROWS;
  if (sc.kind === 'dojo') return cannot('competition_events records no dojo');
  const c =
    sc.kind === 'state'
      ? eq(s.competitionEvents.stateUnitId, sc.stateUnitId!)
      : eq(s.competitionEvents.districtUnitId, sc.districtUnitId!);
  return ok(sql`EXISTS (SELECT 1 FROM ${s.competitionEvents} WHERE ${s.competitionEvents.id} = ${eventCol} AND ${c})`);
}

// ─── Counting ───────────────────────────────────────────────────────────────

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function scalar(db: DB, base: any, conds: any[], expr?: any): Promise<number> {
  const clauses = conds.filter((c) => c != null);
  const q = db.select({ n: expr ?? sql<number>`count(*)::int` }).from(base);
  const rows = clauses.length ? await q.where(and(...clauses)) : await q;
  return Number(rows[0]?.n ?? 0);
}

/**
 * Count rows grouped by a column, zero-filling every value the enum allows.
 *
 * The zero-fill is not cosmetic. A missing key is a gap a caller may interpolate
 * or silently drop; an explicit 0 is a measurement. Same principle as the empty
 * buckets in growthOverTime().
 */
async function groupedCount(
  db: DB,
  base: any,
  col: any,
  values: readonly string[],
  conds: any[]
): Promise<Record<string, number>> {
  const clauses = conds.filter((c) => c != null);
  const q = db.select({ v: col, n: sql<number>`count(*)::int` }).from(base);
  const rows = await (clauses.length ? q.where(and(...clauses)).groupBy(col) : q.groupBy(col));

  const out: Record<string, number> = {};
  for (const v of values) out[v] = 0;
  for (const r of rows) out[String(r.v)] = Number(r.n ?? 0);
  return out;
}

/** A live-status figure a dashboard reports. */
interface CountSpec {
  key: string;
  base: any;
  /** Non-scope conditions, built as at a date where validity is date-aware. */
  cond: (asAt: string) => any[];
  /** count(distinct <col>) instead of count(*) — for "how many PEOPLE". */
  distinct?: any;
  scope: (sc: ScopeRef) => ScopeClause;
  table: string;
  filter: string;
  /** An extra action the principal must hold, beyond the dashboard's own gate. */
  requires?: Action;
}

/** A credential is only current if its status says so AND its dates agree. */
const currentCredential = (t: any, asAt: string) => [
  eq(t.status, 'active'),
  sql`(${t.expiresOn} IS NULL OR ${t.expiresOn} >= ${asAt})`,
  sql`${t.grantedOn} <= ${asAt}`,
];

const CREDENTIAL_FILTER =
  "status = 'active' and granted_on <= the as-at date and (expires_on is null or expires_on >= it), distinct person_id";

/** Case statuses that are not an ending. Read off the case_status enum. */
const OPEN_CASE_STATUSES = s.caseStatus.enumValues.filter((v) => v !== 'closed' && v !== 'withdrawn');
const OPEN_TICKET_STATUSES = s.ticketStatus.enumValues.filter((v) => v !== 'resolved' && v !== 'closed');

const SPECS: CountSpec[] = [
  {
    key: 'people', base: s.persons, cond: () => [],
    scope: (sc) => byUnit(sc, { state: s.persons.stateUnitId, district: s.persons.districtUnitId, dojo: s.persons.dojoId }, 'persons'),
    table: 'persons', filter: 'all rows',
  },
  {
    key: 'peopleActive', base: s.persons, cond: () => [eq(s.persons.status, 'active')],
    scope: (sc) => byUnit(sc, { state: s.persons.stateUnitId, district: s.persons.districtUnitId, dojo: s.persons.dojoId }, 'persons'),
    table: 'persons', filter: "status = 'active'",
  },
  {
    key: 'membersActive', base: s.memberships, cond: () => [eq(s.memberships.status, 'active')],
    distinct: s.memberships.personId,
    scope: (sc) => byPerson(sc, s.memberships.personId),
    table: 'memberships', filter: "status = 'active', distinct person_id",
  },
  {
    key: 'athletes', base: s.memberships,
    cond: () => [eq(s.memberships.status, 'active'), eq(s.memberships.category, 'athlete')],
    distinct: s.memberships.personId,
    scope: (sc) => byPerson(sc, s.memberships.personId),
    table: 'memberships', filter: "category = 'athlete' and status = 'active', distinct person_id",
  },
  {
    key: 'instructors', base: s.instructorQuals, cond: (asAt) => currentCredential(s.instructorQuals, asAt),
    distinct: s.instructorQuals.personId,
    scope: (sc) => byPerson(sc, s.instructorQuals.personId),
    table: 'instructor_quals', filter: CREDENTIAL_FILTER,
  },
  {
    key: 'examiners', base: s.examinerQuals, cond: (asAt) => currentCredential(s.examinerQuals, asAt),
    distinct: s.examinerQuals.personId,
    scope: (sc) => byPerson(sc, s.examinerQuals.personId),
    table: 'examiner_quals', filter: CREDENTIAL_FILTER,
  },
  {
    key: 'officials', base: s.officialQuals, cond: (asAt) => currentCredential(s.officialQuals, asAt),
    distinct: s.officialQuals.personId,
    scope: (sc) => byPerson(sc, s.officialQuals.personId),
    table: 'official_quals', filter: CREDENTIAL_FILTER,
  },
  {
    key: 'stateUnits', base: s.stateUnits, cond: () => [],
    // Every scoped dashboard sits inside exactly one state, so the figure is
    // still a real count — of one row — rather than a constant written in code.
    scope: (sc) => (sc.kind === 'national' ? ALL_ROWS : ok(eq(s.stateUnits.id, sc.stateUnitId!))),
    table: 'state_units', filter: 'all rows',
  },
  {
    key: 'stateUnitsActive', base: s.stateUnits, cond: () => [eq(s.stateUnits.status, 'active')],
    scope: (sc) => (sc.kind === 'national' ? ALL_ROWS : ok(eq(s.stateUnits.id, sc.stateUnitId!))),
    table: 'state_units', filter: "status = 'active'",
  },
  {
    key: 'districtUnits', base: s.districtUnits, cond: () => [],
    scope: (sc) =>
      sc.kind === 'national' ? ALL_ROWS
        : sc.kind === 'state' ? ok(eq(s.districtUnits.stateUnitId, sc.stateUnitId!))
          // A dojo may sit directly under a state with no district; `false` makes
          // that a measured 0 from the database rather than a value invented here.
          : sc.districtUnitId != null ? ok(eq(s.districtUnits.id, sc.districtUnitId)) : ok(sql`false`),
    table: 'district_units', filter: 'all rows',
  },
  {
    key: 'districtUnitsActive', base: s.districtUnits, cond: () => [eq(s.districtUnits.status, 'active')],
    scope: (sc) =>
      sc.kind === 'national' ? ALL_ROWS
        : sc.kind === 'state' ? ok(eq(s.districtUnits.stateUnitId, sc.stateUnitId!))
          : sc.districtUnitId != null ? ok(eq(s.districtUnits.id, sc.districtUnitId)) : ok(sql`false`),
    table: 'district_units', filter: "status = 'active'",
  },
  {
    key: 'dojos', base: s.dojos, cond: () => [],
    scope: (sc) => byUnit(sc, { state: s.dojos.stateUnitId, district: s.dojos.districtUnitId, dojo: s.dojos.id }, 'dojos'),
    table: 'dojos', filter: 'all rows',
  },
  {
    key: 'gradingEvents', base: s.gradingEvents, cond: () => [],
    scope: (sc) => byUnit(sc, { state: s.gradingEvents.stateUnitId, district: s.gradingEvents.districtUnitId, dojo: s.gradingEvents.dojoId }, 'grading_events'),
    table: 'grading_events', filter: 'all rows',
  },
  {
    key: 'gradingsHeld', base: s.gradingEvents, cond: () => [eq(s.gradingEvents.status, 'locked')],
    scope: (sc) => byUnit(sc, { state: s.gradingEvents.stateUnitId, district: s.gradingEvents.districtUnitId, dojo: s.gradingEvents.dojoId }, 'grading_events'),
    table: 'grading_events',
    // 'locked' is the only status that evidences a completed examination whose
    // results can no longer change. Anything earlier may still be abandoned.
    filter: "status = 'locked'",
  },
  {
    key: 'gradingCandidates', base: s.gradingCandidates, cond: () => [],
    scope: (sc) => byPerson(sc, s.gradingCandidates.personId),
    table: 'grading_candidates', filter: 'all rows',
  },
  {
    key: 'gradingCandidatesPassed', base: s.gradingCandidates, cond: () => [eq(s.gradingCandidates.outcome, 'pass')],
    scope: (sc) => byPerson(sc, s.gradingCandidates.personId),
    table: 'grading_candidates', filter: "outcome = 'pass'",
  },
  {
    key: 'certificates', base: s.certificates, cond: () => [],
    scope: (sc) => byPerson(sc, s.certificates.personId),
    table: 'certificates', filter: 'all rows',
  },
  {
    key: 'certificatesInIssue', base: s.certificates,
    cond: () => [inArray(s.certificates.status, ['issued', 'reissued'])],
    scope: (sc) => byPerson(sc, s.certificates.personId),
    table: 'certificates', filter: "status in ('issued', 'reissued')",
  },
  {
    key: 'certificatesRevoked', base: s.certificates, cond: () => [eq(s.certificates.status, 'revoked')],
    scope: (sc) => byPerson(sc, s.certificates.personId),
    table: 'certificates', filter: "status = 'revoked'",
  },
  {
    key: 'competitionEvents', base: s.competitionEvents, cond: () => [],
    scope: (sc) => byUnit(sc, { state: s.competitionEvents.stateUnitId, district: s.competitionEvents.districtUnitId }, 'competition_events'),
    table: 'competition_events', filter: 'all rows',
  },
  {
    key: 'entries', base: s.eventEntries, cond: () => [],
    // Scoped on what the ENTRY declared, not on where the athlete is filed. An
    // entry states the state and dojo it is made for, and that is the fact a
    // competition figure should count.
    scope: (sc) => byUnit(sc, { state: s.eventEntries.stateUnitId, dojo: s.eventEntries.dojoId }, 'event_entries'),
    table: 'event_entries', filter: 'all rows',
  },
  {
    key: 'entriesConfirmed', base: s.eventEntries, cond: () => [eq(s.eventEntries.status, 'confirmed')],
    scope: (sc) => byUnit(sc, { state: s.eventEntries.stateUnitId, dojo: s.eventEntries.dojoId }, 'event_entries'),
    table: 'event_entries', filter: "status = 'confirmed'",
  },
  {
    key: 'matches', base: s.matches, cond: () => [],
    scope: (sc) => byEvent(sc, s.matches.eventId),
    table: 'matches', filter: 'all rows',
  },
  {
    key: 'matchesCompleted', base: s.matches, cond: () => [eq(s.matches.status, 'completed')],
    scope: (sc) => byEvent(sc, s.matches.eventId),
    table: 'matches', filter: "status = 'completed'",
  },
  {
    key: 'resultsFinal', base: s.competitionResults, cond: () => [eq(s.competitionResults.status, 'final')],
    scope: (sc) => byPerson(sc, s.competitionResults.personId),
    table: 'competition_results', filter: "status = 'final'",
  },
  {
    key: 'courses', base: s.courses, cond: () => [],
    // Courses belong to the federation, not to a unit. Reporting the national
    // figure under a state heading would invite it to be summed across states.
    scope: (sc) => (sc.kind === 'national' ? ALL_ROWS : cannot('courses records no unit — the academy is federation-wide')),
    table: 'courses', filter: 'all rows',
  },
  {
    key: 'coursesPublished', base: s.courses, cond: () => [eq(s.courses.status, 'published')],
    scope: (sc) => (sc.kind === 'national' ? ALL_ROWS : cannot('courses records no unit — the academy is federation-wide')),
    table: 'courses', filter: "status = 'published'",
  },
  {
    key: 'enrolments', base: s.enrolments, cond: () => [],
    scope: (sc) => byPerson(sc, s.enrolments.personId),
    table: 'enrolments', filter: 'all rows',
  },
  {
    key: 'enrolmentsActive', base: s.enrolments, cond: () => [eq(s.enrolments.status, 'active')],
    scope: (sc) => byPerson(sc, s.enrolments.personId),
    table: 'enrolments', filter: "status = 'active'",
  },
  {
    key: 'enrolmentsCompleted', base: s.enrolments, cond: () => [eq(s.enrolments.status, 'completed')],
    scope: (sc) => byPerson(sc, s.enrolments.personId),
    table: 'enrolments', filter: "status = 'completed'",
  },
  {
    key: 'openSupportTickets', base: s.supportTickets,
    cond: () => [inArray(s.supportTickets.status, OPEN_TICKET_STATUSES)],
    scope: (sc) => byPerson(sc, s.supportTickets.raisedByPersonId),
    table: 'support_tickets',
    filter: `status in (${OPEN_TICKET_STATUSES.map((v) => `'${v}'`).join(', ')})`,
  },
];

/** Open casework, kept out of SPECS because each kind is authorised separately. */
const CASE_SPECS: CountSpec[] = [
  {
    key: 'disciplinary', base: s.disciplinaryCases,
    cond: () => [inArray(s.disciplinaryCases.status, OPEN_CASE_STATUSES)],
    scope: (sc) => byPerson(sc, s.disciplinaryCases.subjectPersonId),
    table: 'disciplinary_cases',
    filter: `status in (${OPEN_CASE_STATUSES.map((v) => `'${v}'`).join(', ')}), scoped by the subject person`,
  },
  {
    key: 'safeguarding', base: s.safeguardingCases,
    cond: () => [inArray(s.safeguardingCases.status, OPEN_CASE_STATUSES)],
    scope: (sc) => byPerson(sc, s.safeguardingCases.subjectPersonId),
    table: 'safeguarding_cases',
    filter: `status in (${OPEN_CASE_STATUSES.map((v) => `'${v}'`).join(', ')}), scoped by the subject person`,
    // A count of child-protection cases in a single dojo is itself disclosive.
    // It is withheld from anyone who could not read the cases themselves.
    requires: 'safeguarding:read',
  },
];

// ─── Dashboards ─────────────────────────────────────────────────────────────

export interface Dashboard {
  scope: ScopeRef;
  /** The date credential validity was judged against. */
  asAt: string;
  generatedAt: string;
  counts: Record<string, number>;
  dojosByStatus: Record<string, number>;
  eventsByStatus: Record<string, number>;
  openCasesByKind: Record<string, number>;
  sources: Record<string, Source>;
  withheld: Withheld[];
}

async function buildDashboard(
  db: DB,
  principal: Principal,
  input: ScopeInput,
  opts: { asAt?: string; now?: Date } = {}
): Promise<Dashboard> {
  const scope = await resolveScope(db, principal, input);
  const now = opts.now ?? new Date();
  const asAt = opts.asAt ?? isoDate(now);

  const counts: Record<string, number> = {};
  const sources: Record<string, Source> = {};
  const withheld: Withheld[] = [];

  for (const spec of [...SPECS, ...CASE_SPECS]) {
    const isCase = CASE_SPECS.includes(spec);
    const key = isCase ? `openCases.${spec.key}` : spec.key;

    if (spec.requires && !canAnywhere(principal, spec.requires)) {
      withheld.push({
        key, reason: 'not_authorised',
        detail: `${spec.requires} is required to read this figure.`,
      });
      continue;
    }
    const sc = spec.scope(scope);
    if (!sc.scopable) {
      withheld.push({
        key, reason: 'not_scopable',
        detail: `${sc.detail}, so this figure cannot be narrowed to a ${scope.kind}.`,
      });
      continue;
    }

    const n = await scalar(
      db, spec.base, [...spec.cond(asAt), sc.where],
      spec.distinct ? sql<number>`count(distinct ${spec.distinct})::int` : undefined
    );
    if (isCase) {
      counts[key] = n;
    } else {
      counts[spec.key] = n;
    }
    sources[key] = { table: spec.table, filter: spec.filter };
  }

  const openCasesByKind: Record<string, number> = {};
  for (const spec of CASE_SPECS) {
    const key = `openCases.${spec.key}`;
    if (key in counts) openCasesByKind[spec.key] = counts[key];
  }

  // Grouped breakdowns. Both zero-fill every value the enum permits, so a status
  // nobody is currently in reads as 0 rather than disappearing.
  const dojoScope = byUnit(
    scope, { state: s.dojos.stateUnitId, district: s.dojos.districtUnitId, dojo: s.dojos.id }, 'dojos'
  );
  const dojosByStatus = dojoScope.scopable
    ? await groupedCount(db, s.dojos, s.dojos.status, s.unitStatus.enumValues, [dojoScope.where])
    : {};
  if (dojoScope.scopable) {
    sources.dojosByStatus = { table: 'dojos', filter: 'all rows, grouped by status' };
  } else {
    withheld.push({ key: 'dojosByStatus', reason: 'not_scopable', detail: dojoScope.detail });
  }

  const eventScope = byUnit(
    scope, { state: s.competitionEvents.stateUnitId, district: s.competitionEvents.districtUnitId }, 'competition_events'
  );
  const eventsByStatus = eventScope.scopable
    ? await groupedCount(db, s.competitionEvents, s.competitionEvents.status, s.eventStatus.enumValues, [eventScope.where])
    : {};
  if (eventScope.scopable) {
    sources.eventsByStatus = { table: 'competition_events', filter: 'all rows, grouped by status' };
  } else {
    withheld.push({
      key: 'eventsByStatus', reason: 'not_scopable',
      detail: `${eventScope.detail}, so this figure cannot be narrowed to a ${scope.kind}.`,
    });
  }

  return {
    scope, asAt, generatedAt: now.toISOString(),
    counts, dojosByStatus, eventsByStatus, openCasesByKind, sources, withheld,
  };
}

/** Every figure the federation holds, nationally. Requires a national binding. */
export function nationalDashboard(db: DB, principal: Principal, opts: { asAt?: string; now?: Date } = {}) {
  return buildDashboard(db, principal, { kind: 'national' }, opts);
}

export function stateDashboard(db: DB, principal: Principal, stateUnitId: number, opts: { asAt?: string; now?: Date } = {}) {
  return buildDashboard(db, principal, { kind: 'state', id: stateUnitId }, opts);
}

export function districtDashboard(db: DB, principal: Principal, districtUnitId: number, opts: { asAt?: string; now?: Date } = {}) {
  return buildDashboard(db, principal, { kind: 'district', id: districtUnitId }, opts);
}

export function dojoDashboard(db: DB, principal: Principal, dojoId: number, opts: { asAt?: string; now?: Date } = {}) {
  return buildDashboard(db, principal, { kind: 'dojo', id: dojoId }, opts);
}

// ─── Growth over time ───────────────────────────────────────────────────────

export type Granularity = 'day' | 'week' | 'month' | 'year';

export type GrowthMetric =
  | 'persons' | 'memberships' | 'dojos' | 'state_units' | 'district_units'
  | 'grading_events' | 'grading_candidates' | 'certificates'
  | 'competition_events' | 'event_entries' | 'matches' | 'competition_results'
  | 'enrolments' | 'support_tickets' | 'disciplinary_cases';

interface MetricSpec {
  base: any;
  /** The creation timestamp. Named in the source so a reader knows what was counted. */
  ts: any;
  column: string;
  table: string;
  scope: (sc: ScopeRef) => ScopeClause;
}

const METRICS: Record<GrowthMetric, MetricSpec> = {
  persons: {
    base: s.persons, ts: s.persons.createdAt, column: 'created_at', table: 'persons',
    scope: (sc) => byUnit(sc, { state: s.persons.stateUnitId, district: s.persons.districtUnitId, dojo: s.persons.dojoId }, 'persons'),
  },
  memberships: {
    base: s.memberships, ts: s.memberships.createdAt, column: 'created_at', table: 'memberships',
    scope: (sc) => byPerson(sc, s.memberships.personId),
  },
  dojos: {
    base: s.dojos, ts: s.dojos.createdAt, column: 'created_at', table: 'dojos',
    scope: (sc) => byUnit(sc, { state: s.dojos.stateUnitId, district: s.dojos.districtUnitId, dojo: s.dojos.id }, 'dojos'),
  },
  state_units: {
    base: s.stateUnits, ts: s.stateUnits.createdAt, column: 'created_at', table: 'state_units',
    scope: (sc) => (sc.kind === 'national' ? ALL_ROWS : ok(eq(s.stateUnits.id, sc.stateUnitId!))),
  },
  district_units: {
    base: s.districtUnits, ts: s.districtUnits.createdAt, column: 'created_at', table: 'district_units',
    scope: (sc) =>
      sc.kind === 'national' ? ALL_ROWS
        : sc.kind === 'state' ? ok(eq(s.districtUnits.stateUnitId, sc.stateUnitId!))
          : sc.districtUnitId != null ? ok(eq(s.districtUnits.id, sc.districtUnitId)) : ok(sql`false`),
  },
  grading_events: {
    base: s.gradingEvents, ts: s.gradingEvents.createdAt, column: 'created_at', table: 'grading_events',
    scope: (sc) => byUnit(sc, { state: s.gradingEvents.stateUnitId, district: s.gradingEvents.districtUnitId, dojo: s.gradingEvents.dojoId }, 'grading_events'),
  },
  grading_candidates: {
    base: s.gradingCandidates, ts: s.gradingCandidates.createdAt, column: 'created_at', table: 'grading_candidates',
    scope: (sc) => byPerson(sc, s.gradingCandidates.personId),
  },
  certificates: {
    base: s.certificates, ts: s.certificates.createdAt, column: 'created_at', table: 'certificates',
    scope: (sc) => byPerson(sc, s.certificates.personId),
  },
  competition_events: {
    base: s.competitionEvents, ts: s.competitionEvents.createdAt, column: 'created_at', table: 'competition_events',
    scope: (sc) => byUnit(sc, { state: s.competitionEvents.stateUnitId, district: s.competitionEvents.districtUnitId }, 'competition_events'),
  },
  event_entries: {
    base: s.eventEntries, ts: s.eventEntries.createdAt, column: 'created_at', table: 'event_entries',
    scope: (sc) => byUnit(sc, { state: s.eventEntries.stateUnitId, dojo: s.eventEntries.dojoId }, 'event_entries'),
  },
  matches: {
    base: s.matches, ts: s.matches.createdAt, column: 'created_at', table: 'matches',
    scope: (sc) => byEvent(sc, s.matches.eventId),
  },
  competition_results: {
    base: s.competitionResults, ts: s.competitionResults.createdAt, column: 'created_at', table: 'competition_results',
    scope: (sc) => byPerson(sc, s.competitionResults.personId),
  },
  enrolments: {
    base: s.enrolments, ts: s.enrolments.enrolledAt, column: 'enrolled_at', table: 'enrolments',
    scope: (sc) => byPerson(sc, s.enrolments.personId),
  },
  support_tickets: {
    base: s.supportTickets, ts: s.supportTickets.createdAt, column: 'created_at', table: 'support_tickets',
    scope: (sc) => byPerson(sc, s.supportTickets.raisedByPersonId),
  },
  disciplinary_cases: {
    base: s.disciplinaryCases, ts: s.disciplinaryCases.createdAt, column: 'created_at', table: 'disciplinary_cases',
    scope: (sc) => byPerson(sc, s.disciplinaryCases.subjectPersonId),
  },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDate(value: string, field: string): string {
  if (!DATE_RE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new AnalyticsError('bad_date', `${field} must be an ISO date (YYYY-MM-DD); received "${value}".`);
  }
  return value;
}

/**
 * Start of the bucket containing an ISO date, in UTC.
 *
 * MUST agree with Postgres `date_trunc`, which is what groups the rows — a
 * mismatch would leave observed counts orphaned from their bucket and silently
 * report zeros. `date_trunc('week', …)` starts on MONDAY, hence the shift.
 */
function bucketStart(iso: string, gran: Granularity): string {
  if (gran === 'year') return `${iso.slice(0, 4)}-01-01`;
  if (gran === 'month') return `${iso.slice(0, 7)}-01`;
  if (gran === 'day') return iso;
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function nextBucket(iso: string, gran: Granularity): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (gran === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (gran === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else if (gran === 'month') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

export interface GrowthSeries {
  metric: GrowthMetric;
  granularity: Granularity;
  fromDate: string;
  toDate: string;
  scope: ScopeRef;
  source: Source;
  /** One entry per period in the range. An empty period is an explicit 0. */
  buckets: Array<{ bucket: string; count: number }>;
  total: number;
}

/**
 * A real time series, from real creation timestamps.
 *
 * EVERY PERIOD IN THE RANGE IS PRESENT, including the empty ones. A gap in a
 * series is an invitation to interpolate, and an interpolated federation
 * statistic is exactly the kind of number this module exists to abolish.
 *
 * Everything is bucketed in UTC — both sides of the join — so the answer does
 * not move with the server's timezone.
 */
export async function growthOverTime(
  db: DB,
  principal: Principal,
  input: {
    metric: GrowthMetric;
    fromDate: string;
    toDate: string;
    granularity: Granularity;
    scope?: ScopeInput;
  }
): Promise<GrowthSeries> {
  const spec = METRICS[input.metric];
  if (!spec) throw new AnalyticsError('unknown_metric', `Unknown metric: ${String(input.metric)}`);
  if (!['day', 'week', 'month', 'year'].includes(input.granularity)) {
    throw new AnalyticsError('unknown_granularity', `Unknown granularity: ${String(input.granularity)}`);
  }
  const from = assertDate(input.fromDate, 'fromDate');
  const to = assertDate(input.toDate, 'toDate');
  if (from > to) throw new AnalyticsError('bad_range', 'fromDate must not be after toDate.');

  const scope = await resolveScope(db, principal, input.scope ?? { kind: 'national' });
  const sc = spec.scope(scope);
  if (!sc.scopable) {
    throw new AnalyticsError(
      'not_scopable',
      `${sc.detail}, so ${input.metric} cannot be reported for a ${scope.kind}.`
    );
  }

  // The upper bound is EXCLUSIVE at the start of the day after toDate, so a row
  // created at 23:59 on toDate is counted. A `<=` on a timestamp would drop it.
  const toExclusive = nextBucket(to, 'day');
  const gran = input.granularity;
  const bucketExpr = sql<string>`to_char(date_trunc(${gran}::text, (${spec.ts} AT TIME ZONE 'UTC')), 'YYYY-MM-DD')`;

  const rows = await db
    .select({ bucket: bucketExpr, n: sql<number>`count(*)::int` })
    .from(spec.base)
    // `sc.where` is null for national reach and MUST be dropped rather than
    // passed to and(): drizzle binds a null as a parameter, the clause becomes
    // `… AND NULL`, and the query silently matches no rows at all. A national
    // series would have come back all zeros and looked like a real answer.
    .where(and(...[
      sql`(${spec.ts} AT TIME ZONE 'UTC') >= ${from}::timestamp`,
      sql`(${spec.ts} AT TIME ZONE 'UTC') < ${toExclusive}::timestamp`,
      sc.where,
    ].filter((c) => c != null)))
    // GROUP BY 1, not by the expression object. Drizzle renders a column
    // UNQUALIFIED inside a projection and QUALIFIED inside GROUP BY, so passing
    // the same fragment to both emits `"created_at"` in one and
    // `"persons"."created_at"` in the other — which Postgres refuses with
    // "must appear in the GROUP BY clause". The ordinal cannot drift apart.
    .groupBy(sql`1`);

  const observed = new Map<string, number>();
  for (const r of rows) observed.set(String(r.bucket), Number(r.n ?? 0));

  const buckets: GrowthSeries['buckets'] = [];
  const last = bucketStart(to, gran);
  for (let b = bucketStart(from, gran); b <= last; b = nextBucket(b, gran)) {
    buckets.push({ bucket: b, count: observed.get(b) ?? 0 });
  }

  return {
    metric: input.metric,
    granularity: gran,
    fromDate: from,
    toDate: to,
    scope,
    source: {
      table: spec.table,
      column: spec.column,
      filter: `${spec.column} from ${from} to ${to} inclusive, bucketed by ${gran} in UTC`,
    },
    buckets,
    total: buckets.reduce((a, b) => a + b.count, 0),
  };
}

// ─── Annual report ──────────────────────────────────────────────────────────

export interface ReportFigure {
  key: string;
  label: string;
  /** null when the section has no records for the period, or was withheld. */
  value: number | null;
  source: Source;
}

export interface ReportSection {
  key: string;
  title: string;
  status: 'reported' | 'no_records' | 'withheld';
  note: string | null;
  figures: ReportFigure[];
  rows: Array<Record<string, unknown>>;
}

export interface AnnualReport {
  year: number;
  periodFrom: string;
  periodTo: string;
  scope: ScopeRef;
  generatedAt: string;
  sections: ReportSection[];
}

const NO_RECORDS_NOTE = 'No records for this period.';

/**
 * Finish a section.
 *
 * THE RULE: if every figure counted zero rows, the section reports NO RECORDS
 * and each value becomes null. A printed "0" is read as a measurement — "the
 * federation held no gradings" — and would be indistinguishable from "nobody
 * entered any gradings into the system". Those are different claims and the
 * federation can only honestly make the second.
 *
 * Once ANY figure is non-zero the section is a real measurement, and the zeros
 * inside it are measurements too.
 */
function seal(
  key: string,
  title: string,
  figures: ReportFigure[],
  rows: Array<Record<string, unknown>> = []
): ReportSection {
  const any = figures.some((f) => (f.value ?? 0) > 0) || rows.length > 0;
  if (any) return { key, title, status: 'reported', note: null, figures, rows };
  return {
    key, title, status: 'no_records', note: NO_RECORDS_NOTE,
    figures: figures.map((f) => ({ ...f, value: null })),
    rows: [],
  };
}

function withheldSection(key: string, title: string, action: Action, figures: ReportFigure[]): ReportSection {
  return {
    key, title, status: 'withheld',
    note: `Withheld: ${action} is required to read this section.`,
    figures: figures.map((f) => ({ ...f, value: null })),
    rows: [],
  };
}

/** Helper: a figure whose value is a count over a period-bounded date column. */
function fig(key: string, label: string, value: number, table: string, column: string, filter: string): ReportFigure {
  return { key, label, value, source: { table, column, filter } };
}

/**
 * The federation's annual report, assembled entirely from the register.
 *
 * EVERY FIGURE CARRIES THE TABLE, THE COLUMN AND THE FILTER THAT PRODUCED IT.
 * That is not decoration: an annual report is the document a member, a sponsor
 * or a regulator is most likely to challenge, and the only defensible answer to
 * a challenge is "here is the query".
 *
 * Only PERIOD-BOUNDED figures appear. A column that records current state and
 * carries no history — `dojos.status`, for instance — cannot answer "how many
 * dojos were active in 2024", so it is not offered here at all rather than
 * offered with a caveat nobody will read.
 *
 * National only. This is the FEDERATION's report; state-level figures are the
 * scoped dashboards' job.
 */
export async function annualReport(
  db: DB,
  principal: Principal,
  year: number,
  opts: { now?: Date } = {}
): Promise<AnnualReport> {
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw new AnalyticsError('bad_year', `A report year must be a four-digit year; received ${String(year)}.`);
  }
  const scope = await resolveScope(db, principal, { kind: 'national' });
  const now = opts.now ?? new Date();

  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const toExclusive = `${year + 1}-01-01`;

  /** A date column falling inside the calendar year. */
  const inYearDate = (col: any) => and(sql`${col} >= ${from}::date`, sql`${col} <= ${to}::date`);
  /** A timestamp falling inside the calendar year, compared in UTC. */
  const inYearTs = (col: any) => and(
    sql`(${col} AT TIME ZONE 'UTC') >= ${from}::timestamp`,
    sql`(${col} AT TIME ZONE 'UTC') < ${toExclusive}::timestamp`
  );

  const sections: ReportSection[] = [];

  // ── Membership ────────────────────────────────────────────────────────────
  sections.push(seal('membership', 'Membership', [
    fig('newRegistrations', 'People first registered during the year',
      await scalar(db, s.persons, [inYearTs(s.persons.createdAt)]),
      'persons', 'created_at', `created_at within ${year}`),
    fig('membershipsBeginning', 'Memberships beginning during the year',
      await scalar(db, s.memberships, [inYearDate(s.memberships.validFrom)]),
      'memberships', 'valid_from', `valid_from within ${year}`),
    fig('membershipsActiveAtYearEnd', `Memberships active on ${to}`,
      await scalar(db, s.memberships, [
        eq(s.memberships.status, 'active'),
        sql`${s.memberships.validFrom} <= ${to}::date`,
        sql`(${s.memberships.validTo} IS NULL OR ${s.memberships.validTo} >= ${to}::date)`,
      ]),
      'memberships', 'valid_from / valid_to',
      `status = 'active' and valid_from <= ${to} and (valid_to is null or valid_to >= ${to})`),
    fig('membershipsLapsingInYear', 'Memberships whose validity ended during the year',
      await scalar(db, s.memberships, [inYearDate(s.memberships.validTo)]),
      'memberships', 'valid_to', `valid_to within ${year}`),
  ]));

  // ── Units ─────────────────────────────────────────────────────────────────
  sections.push(seal('units', 'Units chartered and affiliated', [
    fig('stateUnitsChartered', 'State units chartered during the year',
      await scalar(db, s.stateUnits, [inYearDate(s.stateUnits.charteredOn)]),
      'state_units', 'chartered_on', `chartered_on within ${year}`),
    fig('districtUnitsChartered', 'District units chartered during the year',
      await scalar(db, s.districtUnits, [inYearDate(s.districtUnits.charteredOn)]),
      'district_units', 'chartered_on', `chartered_on within ${year}`),
    fig('dojosAffiliated', 'Dojos affiliated during the year',
      await scalar(db, s.dojos, [inYearDate(s.dojos.affiliatedOn)]),
      'dojos', 'affiliated_on', `affiliated_on within ${year}`),
    fig('dojoAffiliationsExpiring', 'Dojo affiliations expiring during the year',
      await scalar(db, s.dojos, [inYearDate(s.dojos.affiliationExpiresOn)]),
      'dojos', 'affiliation_expires_on', `affiliation_expires_on within ${year}`),
  ]));

  // ── Gradings ──────────────────────────────────────────────────────────────
  const decidedInYear = inYearTs(s.gradingCandidates.decidedAt);
  sections.push(seal('gradings', 'Gradings', [
    fig('gradingsHeldOn', 'Gradings with a held date in the year',
      await scalar(db, s.gradingEvents, [inYearDate(s.gradingEvents.heldOn)]),
      'grading_events', 'held_on', `held_on within ${year}`),
    fig('gradingsLocked', 'Gradings whose results were locked',
      await scalar(db, s.gradingEvents, [inYearDate(s.gradingEvents.heldOn), eq(s.gradingEvents.status, 'locked')]),
      'grading_events', 'held_on', `held_on within ${year} and status = 'locked'`),
    fig('candidatesDecided', 'Candidates whose grading was decided',
      await scalar(db, s.gradingCandidates, [decidedInYear]),
      'grading_candidates', 'decided_at', `decided_at within ${year}`),
    fig('candidatesPassed', 'Candidates passed',
      await scalar(db, s.gradingCandidates, [decidedInYear, eq(s.gradingCandidates.outcome, 'pass')]),
      'grading_candidates', 'decided_at', `decided_at within ${year} and outcome = 'pass'`),
    fig('candidatesFailed', 'Candidates failed',
      await scalar(db, s.gradingCandidates, [decidedInYear, eq(s.gradingCandidates.outcome, 'fail')]),
      'grading_candidates', 'decided_at', `decided_at within ${year} and outcome = 'fail'`),
    fig('candidatesReferred', 'Candidates referred',
      await scalar(db, s.gradingCandidates, [decidedInYear, eq(s.gradingCandidates.outcome, 'refer')]),
      'grading_candidates', 'decided_at', `decided_at within ${year} and outcome = 'refer'`),
  ]));

  // ── Certificates ──────────────────────────────────────────────────────────
  sections.push(seal('certificates', 'Certificates', [
    fig('issued', 'Certificates issued during the year',
      await scalar(db, s.certificates, [inYearDate(s.certificates.issuedOn)]),
      'certificates', 'issued_on', `issued_on within ${year}`),
    fig('revoked', 'Certificates revoked during the year',
      await scalar(db, s.certificates, [inYearDate(s.certificates.revokedOn)]),
      'certificates', 'revoked_on', `revoked_on within ${year}`),
  ]));

  // ── Competition ───────────────────────────────────────────────────────────
  sections.push(seal('events', 'Competition and events', [
    fig('eventsStarting', 'Events starting during the year',
      await scalar(db, s.competitionEvents, [inYearDate(s.competitionEvents.startsOn)]),
      'competition_events', 'starts_on', `starts_on within ${year}`),
    fig('eventsResultsFinal', 'Events whose results were finalised',
      await scalar(db, s.competitionEvents, [inYearTs(s.competitionEvents.resultsFinalisedAt)]),
      'competition_events', 'results_finalised_at', `results_finalised_at within ${year}`),
    fig('entriesReceived', 'Entries received',
      await scalar(db, s.eventEntries, [inYearTs(s.eventEntries.createdAt)]),
      'event_entries', 'created_at', `created_at within ${year}`),
    fig('matchesCompleted', 'Matches completed',
      await scalar(db, s.matches, [inYearTs(s.matches.endedAt), eq(s.matches.status, 'completed')]),
      'matches', 'ended_at', `ended_at within ${year} and status = 'completed'`),
  ]));

  // ── Results and medals ────────────────────────────────────────────────────
  const finalInYear = [eq(s.competitionResults.status, 'final'), inYearTs(s.competitionResults.finalisedAt)];
  sections.push(seal('results', 'Official results', [
    fig('finalResults', 'Results finalised during the year',
      await scalar(db, s.competitionResults, finalInYear),
      'competition_results', 'finalised_at', `finalised_at within ${year} and status = 'final'`),
    fig('gold', 'Gold medals',
      await scalar(db, s.competitionResults, [...finalInYear, eq(s.competitionResults.medal, 'gold')]),
      'competition_results', 'finalised_at', `finalised_at within ${year}, status = 'final', medal = 'gold'`),
    fig('silver', 'Silver medals',
      await scalar(db, s.competitionResults, [...finalInYear, eq(s.competitionResults.medal, 'silver')]),
      'competition_results', 'finalised_at', `finalised_at within ${year}, status = 'final', medal = 'silver'`),
    fig('bronze', 'Bronze medals',
      await scalar(db, s.competitionResults, [...finalInYear, eq(s.competitionResults.medal, 'bronze')]),
      'competition_results', 'finalised_at', `finalised_at within ${year}, status = 'final', medal = 'bronze'`),
  ]));

  // ── Medals by state ───────────────────────────────────────────────────────
  //
  // Attributed to the STATE THE ENTRY DECLARED, not to where the athlete is
  // filed today: a medal was won representing a unit, and a later transfer must
  // not silently move it. Entries that declared no state are reported as
  // unattributed rather than dropped, so the rows still sum to the medal totals
  // in the section above.
  const medalRows = await db
    .select({
      stateUnitId: s.eventEntries.stateUnitId,
      medal: s.competitionResults.medal,
      n: sql<number>`count(*)::int`,
    })
    .from(s.competitionResults)
    .innerJoin(s.eventEntries, eq(s.competitionResults.entryId, s.eventEntries.id))
    .where(and(
      ...finalInYear,
      inArray(s.competitionResults.medal, ['gold', 'silver', 'bronze'])
    ))
    .groupBy(s.eventEntries.stateUnitId, s.competitionResults.medal);

  const stateNames = new Map<number, string>();
  for (const u of await db.select({ id: s.stateUnits.id, name: s.stateUnits.name }).from(s.stateUnits)) {
    stateNames.set(u.id, u.name);
  }
  const byState = new Map<string, Record<string, unknown>>();
  for (const r of medalRows) {
    const id: number | null = r.stateUnitId ?? null;
    const k = String(id);
    if (!byState.has(k)) {
      byState.set(k, {
        stateUnitId: id,
        state: id == null ? 'Unattributed — the entry declared no state unit' : (stateNames.get(id) ?? 'Unknown state unit'),
        gold: 0, silver: 0, bronze: 0, total: 0,
      });
    }
    const row = byState.get(k)!;
    row[String(r.medal)] = Number(r.n ?? 0);
    row.total = Number(row.gold) + Number(row.silver) + Number(row.bronze);
  }
  const medalTable = [...byState.values()].sort(
    (a, b) => Number(b.total) - Number(a.total) || String(a.state).localeCompare(String(b.state))
  );
  sections.push(seal('medalsByState', 'Medals by state unit', [
    fig('medalsCounted', 'Medals attributed to a state unit',
      medalTable.reduce((acc, r) => acc + Number(r.total), 0),
      'competition_results', 'finalised_at',
      `finalised_at within ${year}, status = 'final', medal in ('gold','silver','bronze'), grouped by event_entries.state_unit_id`),
  ], medalTable));

  // ── Education ─────────────────────────────────────────────────────────────
  sections.push(seal('education', 'Academy', [
    fig('coursesPublished', 'Courses published during the year',
      await scalar(db, s.courses, [inYearTs(s.courses.publishedAt)]),
      'courses', 'published_at', `published_at within ${year}`),
    fig('enrolments', 'Enrolments taken',
      await scalar(db, s.enrolments, [inYearTs(s.enrolments.enrolledAt)]),
      'enrolments', 'enrolled_at', `enrolled_at within ${year}`),
    fig('completions', 'Enrolments completed',
      await scalar(db, s.enrolments, [inYearTs(s.enrolments.completedAt)]),
      'enrolments', 'completed_at', `completed_at within ${year}`),
  ]));

  // ── Cases handled ─────────────────────────────────────────────────────────
  sections.push(seal('cases', 'Cases and member support', [
    fig('disciplinaryReceived', 'Disciplinary cases received',
      await scalar(db, s.disciplinaryCases, [inYearDate(s.disciplinaryCases.receivedOn)]),
      'disciplinary_cases', 'received_on', `received_on within ${year}`),
    fig('disciplinaryClosed', 'Disciplinary cases closed',
      await scalar(db, s.disciplinaryCases, [inYearDate(s.disciplinaryCases.closedOn)]),
      'disciplinary_cases', 'closed_on', `closed_on within ${year}`),
    fig('supportTicketsRaised', 'Support tickets raised',
      await scalar(db, s.supportTickets, [inYearTs(s.supportTickets.createdAt)]),
      'support_tickets', 'created_at', `created_at within ${year}`),
    fig('supportTicketsResolved', 'Support tickets resolved',
      await scalar(db, s.supportTickets, [inYearTs(s.supportTickets.resolvedAt)]),
      'support_tickets', 'resolved_at', `resolved_at within ${year}`),
  ]));

  // ── Safeguarding ──────────────────────────────────────────────────────────
  //
  // Its own section so it can be withheld without withholding everything else.
  // A federation working with children should be able to publish that it
  // received and referred concerns; whether THIS reader may see the figures is
  // a separate question, answered here.
  const safeguardingFigures = (received: number, closed: number, referred: number): ReportFigure[] => [
    fig('received', 'Safeguarding concerns received', received,
      'safeguarding_cases', 'received_on', `received_on within ${year}`),
    fig('closed', 'Safeguarding concerns closed', closed,
      'safeguarding_cases', 'closed_on', `closed_on within ${year}`),
    fig('referredToAuthority', 'Concerns referred to an external authority', referred,
      'safeguarding_cases', 'referred_on', `referred_on within ${year}`),
  ];
  if (canAnywhere(principal, 'safeguarding:read')) {
    sections.push(seal('safeguarding', 'Safeguarding', safeguardingFigures(
      await scalar(db, s.safeguardingCases, [inYearDate(s.safeguardingCases.receivedOn)]),
      await scalar(db, s.safeguardingCases, [inYearDate(s.safeguardingCases.closedOn)]),
      await scalar(db, s.safeguardingCases, [inYearDate(s.safeguardingCases.referredOn)]),
    )));
  } else {
    sections.push(withheldSection('safeguarding', 'Safeguarding', 'safeguarding:read', safeguardingFigures(0, 0, 0)));
  }

  // ── Finance ───────────────────────────────────────────────────────────────
  //
  // Every amount is INTEGER PAISE, taken straight from the ledger. No rupee
  // conversion happens here: converting is a display decision and doing it in
  // the data layer is how a float gets into a federation's accounts.
  const financeFigures = (credits: number, debits: number, entries: number): ReportFigure[] => [
    fig('creditsPaise', 'Total credits posted (paise)', credits,
      'ledger_entries', 'occurred_on', `occurred_on within ${year} and direction = 'credit'`),
    fig('debitsPaise', 'Total debits posted (paise)', debits,
      'ledger_entries', 'occurred_on', `occurred_on within ${year} and direction = 'debit'`),
    fig('entries', 'Ledger entries posted', entries,
      'ledger_entries', 'occurred_on', `occurred_on within ${year}`),
  ];
  if (canAnywhere(principal, 'finance:read')) {
    const ledgerInYear = inYearDate(s.ledgerEntries.occurredOn);
    const sumPaise = async (direction: string) => {
      const rows = await db
        .select({ n: sql<number>`COALESCE(sum(${s.ledgerEntries.amountPaise}), 0)::bigint` })
        .from(s.ledgerEntries)
        .where(and(ledgerInYear, eq(s.ledgerEntries.direction, direction)));
      return Number(rows[0]?.n ?? 0);
    };
    const accounts = await db
      .select({
        account: s.ledgerEntries.account,
        direction: s.ledgerEntries.direction,
        amountPaise: sql<number>`COALESCE(sum(${s.ledgerEntries.amountPaise}), 0)::bigint`,
        entries: sql<number>`count(*)::int`,
      })
      .from(s.ledgerEntries)
      .where(ledgerInYear)
      .groupBy(s.ledgerEntries.account, s.ledgerEntries.direction);

    sections.push(seal(
      'finance', 'Finance',
      financeFigures(
        await sumPaise('credit'),
        await sumPaise('debit'),
        await scalar(db, s.ledgerEntries, [ledgerInYear])
      ),
      accounts
        .map((r: any) => ({
          account: r.account,
          direction: r.direction,
          amountPaise: Number(r.amountPaise ?? 0),
          entries: Number(r.entries ?? 0),
        }))
        .sort((a: any, b: any) => a.account.localeCompare(b.account) || a.direction.localeCompare(b.direction))
    ));
  } else {
    sections.push(withheldSection('finance', 'Finance', 'finance:read', financeFigures(0, 0, 0)));
  }

  return {
    year,
    periodFrom: from,
    periodTo: to,
    scope,
    generatedAt: now.toISOString(),
    sections,
  };
}

// ─── Data quality ───────────────────────────────────────────────────────────

export interface DataQualityItem {
  key: string;
  /** What the gap is, and why it matters — not just which column is null. */
  description: string;
  /** Rows with the gap. */
  count: number;
  /** Rows examined, so the count can be read in proportion without a float. */
  total: number;
  source: Source;
}

export interface DataQualityReport {
  scope: ScopeRef;
  generatedAt: string;
  items: DataQualityItem[];
  withheld: Withheld[];
}

interface QualitySpec {
  key: string;
  description: string;
  base: any;
  /** Rows in the denominator. */
  population: () => any[];
  /** Rows in the numerator — the gap. */
  gap: () => any[];
  scope: (sc: ScopeRef) => ScopeClause;
  table: string;
  filter: string;
}

const QUALITY: QualitySpec[] = [
  {
    key: 'personsWithoutDateOfBirth',
    description: 'People with no date of birth. Every age-based eligibility rule the federation may set is unenforceable for these records.',
    base: s.persons, population: () => [], gap: () => [isNull(s.persons.dob)],
    scope: (sc) => byUnit(sc, { state: s.persons.stateUnitId, district: s.persons.districtUnitId, dojo: s.persons.dojoId }, 'persons'),
    table: 'persons', filter: 'dob is null',
  },
  {
    key: 'personsWithoutDojo',
    description: 'People attached to no dojo. They cannot appear in any dojo-scoped figure, so dojo totals will not sum to the national total.',
    base: s.persons, population: () => [], gap: () => [isNull(s.persons.dojoId)],
    scope: (sc) => byUnit(sc, { state: s.persons.stateUnitId, district: s.persons.districtUnitId, dojo: s.persons.dojoId }, 'persons'),
    table: 'persons', filter: 'dojo_id is null',
  },
  {
    key: 'activeRanksWithoutGradingEvent',
    description: 'Active ranks traceable to no examination — legacy records carried over from paper. Real grades, but unverified.',
    base: s.rankRecords,
    population: () => [eq(s.rankRecords.status, 'active')],
    gap: () => [eq(s.rankRecords.status, 'active'), isNull(s.rankRecords.gradingEventId)],
    scope: (sc) => byPerson(sc, s.rankRecords.personId),
    table: 'rank_records', filter: "status = 'active' and grading_event_id is null",
  },
  {
    key: 'dojosWithoutChiefInstructor',
    description: 'Dojos with no chief instructor recorded. Nobody is on the register as answerable for the training done there.',
    base: s.dojos, population: () => [], gap: () => [isNull(s.dojos.chiefInstructorPersonId)],
    scope: (sc) => byUnit(sc, { state: s.dojos.stateUnitId, district: s.dojos.districtUnitId, dojo: s.dojos.id }, 'dojos'),
    table: 'dojos', filter: 'chief_instructor_person_id is null',
  },
  {
    key: 'dojosWithoutDistrictUnit',
    description: 'Dojos filed under a state but no district. They vanish from every district dashboard.',
    base: s.dojos, population: () => [], gap: () => [isNull(s.dojos.districtUnitId)],
    scope: (sc) => byUnit(sc, { state: s.dojos.stateUnitId, district: s.dojos.districtUnitId, dojo: s.dojos.id }, 'dojos'),
    table: 'dojos', filter: 'district_unit_id is null',
  },
  {
    key: 'certificatesWithoutVerifyToken',
    description: 'Certificates with no usable verification token. The column is NOT NULL, so only a blank token can occur — and a blank one cannot be verified by anybody.',
    base: s.certificates, population: () => [],
    gap: () => [sql`(${s.certificates.verifyToken} IS NULL OR btrim(${s.certificates.verifyToken}) = '')`],
    scope: (sc) => byPerson(sc, s.certificates.personId),
    table: 'certificates', filter: "verify_token is null or btrim(verify_token) = ''",
  },
  {
    key: 'gradeCertificatesWithoutGradingEvent',
    description: 'Grade certificates traceable to no grading event. This is the single most important number here: it is the count of credentials the federation cannot chain back to an examination.',
    base: s.certificates,
    population: () => [inArray(s.certificates.kind, ['kyu_grade', 'dan_grade'])],
    gap: () => [inArray(s.certificates.kind, ['kyu_grade', 'dan_grade']), isNull(s.certificates.gradingEventId)],
    scope: (sc) => byPerson(sc, s.certificates.personId),
    table: 'certificates', filter: "kind in ('kyu_grade', 'dan_grade') and grading_event_id is null",
  },
  {
    key: 'resultsWithoutPerson',
    description: 'Official results attached to no person. They can never reach an athlete passport or a ranking.',
    base: s.competitionResults, population: () => [], gap: () => [isNull(s.competitionResults.personId)],
    // Scoped through the entry, since the person these rows lack is the whole gap.
    scope: (sc) =>
      sc.kind === 'national' ? ALL_ROWS
        : sc.kind === 'district' ? cannot('event_entries records no district unit')
          : ok(sql`EXISTS (SELECT 1 FROM ${s.eventEntries} WHERE ${s.eventEntries.id} = ${s.competitionResults.entryId} AND ${
            sc.kind === 'state'
              ? eq(s.eventEntries.stateUnitId, sc.stateUnitId!)
              : eq(s.eventEntries.dojoId, sc.dojoId!)
          })`),
    table: 'competition_results', filter: 'person_id is null',
  },
  {
    key: 'activeMembershipsWithoutExpiry',
    description: 'Active memberships with no end date. They never lapse, so a renewal is never due and the active-member count only ever grows.',
    base: s.memberships,
    population: () => [eq(s.memberships.status, 'active')],
    gap: () => [eq(s.memberships.status, 'active'), isNull(s.memberships.validTo)],
    scope: (sc) => byPerson(sc, s.memberships.personId),
    table: 'memberships', filter: "status = 'active' and valid_to is null",
  },
];

/**
 * How trustworthy are the federation's own numbers?
 *
 * More valuable than any dashboard, and the reason is simple: a dashboard tells
 * you what the register says, and this tells you how much of the register is
 * missing. A count of 4,900 members means nothing if 3,000 of them have no date
 * of birth, because every age-gated figure derived from them is guesswork.
 *
 * Every item reports the gap AND the population it was measured against, so the
 * caller can judge proportion. No percentage is computed here — a percentage is
 * a float, and this codebase does not put floats in front of federation
 * decisions.
 */
export async function dataQuality(
  db: DB,
  principal: Principal,
  input: ScopeInput = { kind: 'national' },
  opts: { now?: Date } = {}
): Promise<DataQualityReport> {
  const scope = await resolveScope(db, principal, input);
  const now = opts.now ?? new Date();

  const items: DataQualityItem[] = [];
  const withheld: Withheld[] = [];

  for (const spec of QUALITY) {
    const sc = spec.scope(scope);
    if (!sc.scopable) {
      withheld.push({
        key: spec.key, reason: 'not_scopable',
        detail: `${sc.detail}, so this check cannot be narrowed to a ${scope.kind}.`,
      });
      continue;
    }
    items.push({
      key: spec.key,
      description: spec.description,
      count: await scalar(db, spec.base, [...spec.gap(), sc.where]),
      total: await scalar(db, spec.base, [...spec.population(), sc.where]),
      source: { table: spec.table, filter: spec.filter },
    });
  }

  return { scope, generatedAt: now.toISOString(), items, withheld };
}
