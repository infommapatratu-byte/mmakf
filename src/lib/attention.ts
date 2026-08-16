// WHAT NEEDS MY ATTENTION — the engine behind the two role dashboards
// (§19, §36, §39, §40, §41, §42, §114).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS A MODULE AND NOT MARKUP ON A PAGE
// ─────────────────────────────────────────────────────────────────────────────
//
// /admin/command and /admin/dashboard both answer the same question — "what is
// waiting on me?" — one across the caller's whole reach, one narrowed to a
// single unit. Written twice, the two answers diverge the first time somebody
// adds a status, and the federation then has two screens giving two answers to
// one question. There is one engine because there must be one answer.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FOUR RULES THIS FILE EXISTS TO KEEP
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. THE DICTIONARY DECIDES WHAT IS ACTIONABLE, NOT THIS FILE.
//    needsAction() in src/lib/status.ts already knows which of the federation's
//    statuses are waiting on a person. Every figure below is derived by
//    filtering a schema enum through it. Nothing here hard-codes "submitted or
//    under review" — that is exactly how one screen ends up counting
//    `escalated` as work and another not.
//
// 2. EVERY FIGURE IS A COUNT OF ROWS. No estimate, no cached total, no dash
//    standing in for a count that was inconvenient. A figure that cannot be
//    counted is returned as UNAVAILABLE with its reason, and the page prints the
//    reason. It is never a zero.
//
// 3. SCOPE IS A SQL PREDICATE. visibleScopes() goes inside the WHERE clause,
//    never as a filter over rows already read. A credential whose table carries
//    no column that can narrow it is refused with that reason — never shown the
//    federation-wide number under a local heading.
//
// 4. EVERY FIGURE HAS A DESTINATION. A count nobody can click is a count nobody
//    can act on, so each item carries the href of the list that produced it.
//    Where the destination cannot filter on that status, `hrefFiltered` is false
//    and the page says the list arrives unnarrowed — an honest half-answer
//    rather than a link that pretends.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHAT IT REFUSES TO ANSWER
// ─────────────────────────────────────────────────────────────────────────────
//
// §114 asks eight questions. Two of them the register cannot answer, and this
// module manufactures neither — see UNANSWERABLE at the foot of the file, which
// both dashboards print rather than quietly dropping the question.

import { and, gte, inArray, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import * as o from '@/db/operations.schema';
import { needsAction, statusOf } from '@/lib/status';
import { visibleScopes, type Action, type Principal } from '@/lib/rbac';
import type { ScopeRef } from '@/db/analytics';

/** Drizzle's inferred types are enormous; every query here is hand-checked. */
type DB = any;

// ─── What a figure is ───────────────────────────────────────────────────────

export interface AttentionSource {
  table: string;
  column: string;
  filter: string;
}

/** One actionable status of one register, counted. */
export interface AttentionItem {
  /** Unique within a render: `<register>:<status>`. */
  key: string;
  /** The raw database value, for <Status value={…} domain={…} />. */
  status: string;
  domain: string;
  /** The count. null ONLY when it was not produced — see `unavailable`. */
  count: number | null;
  /** Why there is no count. Non-null exactly when `count` is null. */
  unavailable: string | null;
  href: string;
  /** False when the destination could not be narrowed to this status. */
  hrefFiltered: boolean;
  source: AttentionSource | null;
}

/** One register, with its actionable statuses beneath it. */
export interface AttentionRegister {
  key: string;
  /** The section it belongs under: "People", "Finance", … */
  group: string;
  /** "Institutional applications" — sentence case, plural. */
  label: string;
  /** The sum across its actionable statuses, or null if it was not counted. */
  total: number | null;
  unavailable: string | null;
  /** The module where this work is done. */
  href: string;
  /** Whether that module can be arrived at pre-filtered. */
  filterable: boolean;
  /** What would make these figures move off zero. */
  populatedBy: string;
  /**
   * Set when the narrowing had to go through the person a row belongs to.
   *
   * Printed beside the figure, because it changes what the figure means: rows
   * that name no person cannot be attributed to a unit and are not in the
   * count. Silence here would present an under-count as a count.
   */
  scopeCaveat: string | null;
  items: AttentionItem[];
}

export interface AttentionReport {
  registers: AttentionRegister[];
  /**
   * Registers this credential holds no authority over at all.
   *
   * Reported once, quietly, rather than as a refusal card per register: a coach
   * manager has no business being told the finance queue is closed to them
   * eleven times on one screen. But it is reported, because a dashboard that
   * silently omits whole registers cannot be read as complete.
   */
  outOfReach: Array<{ group: string; label: string; action: Action }>;
  generatedAt: string;
}

// ─── Scope predicates ───────────────────────────────────────────────────────
//
// A table is narrowed by whichever of these columns it actually carries.
// `person` is the fallback for tables that record no unit of their own — a
// certificate belongs to a person, and the person is filed to a dojo. EXISTS
// rather than a join, for the reason analytics.ts gives: a join multiplies rows
// if the relationship is ever one-to-many, and a count that double-counts is
// worse than one that refuses.

interface UnitColumns {
  state?: any;
  district?: any;
  dojo?: any;
  /** A person id, when the row is only locatable through the person. */
  person?: any;
}

type Clause =
  | { ok: true; where: any | null; viaPerson: boolean }
  /**
   * `reason` separates two facts the reader must be able to tell apart: this
   * credential holds nothing here at all, or it holds something and the table
   * cannot be narrowed to it. The first is a register that is none of your
   * business; the second is a figure that would be wrong if it were shown.
   */
  | { ok: false; reason: 'no_authority' | 'not_narrowable'; why: string };

/**
 * Narrow to a set of ids at one level of the hierarchy.
 *
 * `viaPerson` matters to the reader and is carried back rather than hidden. A
 * table narrowed through the person a row belongs to CANNOT ACCOUNT FOR ROWS
 * THAT NAME NO PERSON — an institutional booking, a ticket raised by an email
 * address that is nobody on the register — and those rows drop out of the
 * count. That is the safe direction to be wrong in, and it is still a
 * qualification the figure has to travel with.
 */
function atLevel(
  cols: UnitColumns,
  level: 'state' | 'district' | 'dojo',
  ids: number[]
): { where: any; viaPerson: boolean } | null {
  if (!ids.length) return null;
  const own = level === 'state' ? cols.state : level === 'district' ? cols.district : cols.dojo;
  if (own) return { where: inArray(own, ids), viaPerson: false };
  if (!cols.person) return null;

  const personCol =
    level === 'state' ? s.persons.stateUnitId
      : level === 'district' ? s.persons.districtUnitId
        : s.persons.dojoId;
  return {
    where: sql`EXISTS (SELECT 1 FROM ${s.persons} WHERE ${s.persons.id} = ${cols.person} AND ${inArray(personCol, ids)})`,
    viaPerson: true,
  };
}

/**
 * The predicate for what this credential may see at all.
 *
 * Applied to EVERY query here regardless of what else narrows it. A national
 * officer looking at one state gets the unit predicate and this one passes
 * freely; a state administrator looking at their own state gets both, and both
 * must hold. Two predicates that agree cost nothing. The day they disagree, the
 * narrower one is the safe answer.
 */
function reachClause(principal: Principal, action: Action, cols: UnitColumns, what: string): Clause {
  const vs = visibleScopes(principal, action);
  if (vs.kind === 'none') {
    return {
      ok: false,
      reason: 'no_authority',
      why: `Counting ${what} needs the "${action}" authority, which this credential holds in no scope.`,
    };
  }
  if (vs.kind === 'all') return { ok: true, where: null, viaPerson: false };

  const parts = [
    atLevel(cols, 'state', vs.states),
    atLevel(cols, 'district', vs.districts),
    atLevel(cols, 'dojo', vs.dojos),
  ].filter((c) => c != null) as Array<{ where: any; viaPerson: boolean }>;

  if (!parts.length) {
    // An institution binding is not a rung of the federation hierarchy — it is
    // a TENANT, as rbac.ts says at its head — and this engine narrows only by
    // state, district and dojo. Saying so is the difference between a true
    // refusal and a plausible one: telling a client institution's administrator
    // that the register "records no column that can narrow it" would be false
    // where the table does carry an institution id, and would send them to
    // argue with the schema instead of asking for the binding they need.
    const onlyInstitution =
      vs.states.length === 0 && vs.districts.length === 0 && vs.dojos.length === 0 &&
      vs.institutions.length > 0;

    return {
      ok: false,
      reason: 'not_narrowable',
      why: onlyInstitution
        ? `Your "${action}" authority is held at institution scope, which is a client tenancy rather ` +
          `than a unit of the federation. This engine narrows by state, district and dojo only, so ${what} ` +
          'cannot be counted for you here. Your institution\'s own records are reached through the ' +
          'institution portal, not through a federation-wide figure.'
        : `Your "${action}" authority is bound to particular units, and this register records no column ` +
          `that can narrow ${what} to them. The federation-wide figure is not shown under a local ` +
          'heading, because a reader would sum it across units and count it several times.',
    };
  }
  return {
    ok: true,
    where: parts.length === 1 ? parts[0].where : or(...parts.map((p) => p.where)),
    viaPerson: parts.some((p) => p.viaPerson),
  };
}

/** The predicate for one named unit — the scoped dashboard's own narrowing. */
function unitClause(scope: ScopeRef | null, cols: UnitColumns, what: string): Clause {
  if (!scope || scope.kind === 'national') return { ok: true, where: null, viaPerson: false };
  const level = scope.kind;
  const id =
    level === 'state' ? scope.stateUnitId : level === 'district' ? scope.districtUnitId : scope.dojoId;

  if (id == null) {
    return {
      ok: false,
      reason: 'not_narrowable',
      why: `This ${level} scope resolved without an id, so nothing was counted.`,
    };
  }

  const part = atLevel(cols, level, [id]);
  if (!part) {
    return {
      ok: false,
      reason: 'not_narrowable',
      why:
        `This register records no ${level} — neither directly nor through the person a row belongs ` +
        `to — so ${what} cannot honestly be narrowed to ${scope.label}.`,
    };
  }
  return { ok: true, where: part.where, viaPerson: part.viaPerson };
}

// ─── The registers ──────────────────────────────────────────────────────────
//
// One entry per register that carries work. `values` is the enum exactly as the
// database declares it; the actionable subset is DERIVED from the dictionary
// below, never listed here.

interface Spec {
  key: string;
  group: string;
  /** The authority needed to count these rows at all. */
  requires: Action;
  /** Status vocabulary, for the dictionary and for <Status domain>. */
  domain: string;
  /** Every value the column may hold, straight from the schema. */
  values: readonly string[];
  table: any;
  statusCol: any;
  cols: UnitColumns;
  tableName: string;
  columnName: string;
  /** Sentence case, plural: "Institutional applications". */
  label: string;
  /** The module that works these. */
  page: string;
  /** True when `page` accepts ?status= and will therefore arrive filtered. */
  filterable: boolean;
  populatedBy: string;
}

const SPECS: Spec[] = [
  {
    key: 'applications',
    group: 'Training and engagement',
    requires: 'engagement:read',
    domain: 'application',
    values: o.applicationStatus.enumValues,
    table: o.institutionApplications,
    statusCol: o.institutionApplications.status,
    cols: {
      state: o.institutionApplications.stateUnitId,
      district: o.institutionApplications.districtUnitId,
    },
    tableName: 'institution_applications',
    columnName: 'status',
    label: 'Institutional applications',
    page: '/admin/applications',
    filterable: true,
    populatedBy:
      'A school, corporate or university completing the application wizard. Nothing is seeded: an empty ' +
      'queue means none has been submitted.',
  },
  {
    key: 'leads',
    group: 'Training and engagement',
    requires: 'engagement:read',
    domain: 'lead',
    values: s.leadStatus.enumValues,
    table: s.leads,
    statusCol: s.leads.status,
    cols: { state: s.leads.stateUnitId, district: s.leads.districtUnitId },
    tableName: 'leads',
    columnName: 'status',
    label: 'Leads',
    page: '/admin/leads',
    filterable: true,
    populatedBy: 'An enquiry arriving through a training request, a contact form or a campaign landing page.',
  },
  {
    key: 'bookings',
    group: 'Training and engagement',
    requires: 'booking:read',
    domain: 'booking',
    values: s.bookingStatus.enumValues,
    table: s.bookings,
    statusCol: s.bookings.status,
    cols: { dojo: s.bookings.dojoId, person: s.bookings.personId },
    tableName: 'bookings',
    columnName: 'status',
    label: 'Bookings',
    page: '/admin/bookings',
    filterable: false,
    populatedBy: 'A session requested against a programme, a coach or a venue.',
  },
  {
    key: 'coaches',
    group: 'People',
    requires: 'coach:read',
    domain: 'coach',
    values: o.coachStatus.enumValues,
    table: o.coachProfiles,
    statusCol: o.coachProfiles.status,
    cols: {
      state: o.coachProfiles.stateUnitId,
      district: o.coachProfiles.districtUnitId,
      dojo: o.coachProfiles.homeDojoId,
    },
    tableName: 'coach_profiles',
    columnName: 'status',
    label: 'Coaches',
    page: '/admin/coaches',
    filterable: true,
    populatedBy:
      'Somebody applying to coach for MMAKF, or a standing decision taken on a coach already on the register.',
  },
  {
    key: 'memberships',
    group: 'People',
    requires: 'membership:read',
    domain: 'membership',
    values: s.membershipStatus.enumValues,
    table: s.memberships,
    statusCol: s.memberships.status,
    cols: { person: s.memberships.personId },
    tableName: 'memberships',
    columnName: 'status',
    label: 'Memberships',
    page: '/admin/membership',
    filterable: false,
    populatedBy: 'A registration reaching the point where a membership record exists for it.',
  },
  {
    key: 'certificates',
    group: 'People',
    requires: 'certificate:read',
    domain: 'certificate',
    values: s.certificateStatus.enumValues,
    table: s.certificates,
    statusCol: s.certificates.status,
    cols: { person: s.certificates.personId },
    tableName: 'certificates',
    columnName: 'status',
    label: 'Certificates',
    page: '/admin/grading',
    filterable: false,
    populatedBy:
      'A certificate being suspended pending a decision. Issuing one does not appear here — an issued ' +
      'certificate is finished work, not waiting work.',
  },
  {
    key: 'events',
    group: 'Sport',
    requires: 'competition:read',
    domain: 'event',
    values: s.eventStatus.enumValues,
    table: s.competitionEvents,
    statusCol: s.competitionEvents.status,
    cols: {
      state: s.competitionEvents.stateUnitId,
      district: s.competitionEvents.districtUnitId,
      // The organiser, which is the only dojo a competition event records. A
      // dojo dashboard therefore reports the events it is running, not every
      // event its athletes entered — and the page says so under the figure.
      dojo: s.competitionEvents.organiserDojoId,
    },
    tableName: 'competition_events',
    columnName: 'status',
    label: 'Competitions',
    page: '/admin/competition',
    filterable: false,
    populatedBy: 'An event entered into the calendar and moved along its lifecycle.',
  },
  {
    key: 'dojos',
    group: 'Federation',
    requires: 'dojo:read',
    domain: 'unit',
    values: s.unitStatus.enumValues,
    table: s.dojos,
    statusCol: s.dojos.status,
    cols: { state: s.dojos.stateUnitId, district: s.dojos.districtUnitId, dojo: s.dojos.id },
    tableName: 'dojos',
    columnName: 'status',
    label: 'Dojos',
    page: '/admin/governance',
    filterable: false,
    populatedBy:
      'A dojo whose standing is changed by a federation decision. Affiliation reviews are NOT counted ' +
      'here — see the unanswerable questions below for why.',
  },
  {
    key: 'tickets',
    group: 'Operations',
    requires: 'support:read',
    domain: 'ticket',
    values: s.ticketStatus.enumValues,
    table: s.supportTickets,
    statusCol: s.supportTickets.status,
    cols: { person: s.supportTickets.raisedByPersonId },
    tableName: 'support_tickets',
    columnName: 'status',
    label: 'Support tickets',
    page: '/admin/support',
    filterable: false,
    populatedBy: 'A member, parent or institution raising a question at the support desk.',
  },
  {
    key: 'tasks',
    group: 'Operations',
    requires: 'task:read',
    domain: 'task',
    values: o.taskStatus.enumValues,
    table: o.tasks,
    statusCol: o.tasks.status,
    // No unit column at all: a task is raised against a subject, and the
    // subject may be an application, a ticket or a coach application. It is
    // federation-wide by construction, and a scoped credential is told so
    // rather than shown the national figure.
    cols: {},
    tableName: 'tasks',
    columnName: 'status',
    label: 'Tasks',
    page: '/admin/tasks',
    filterable: false,
    populatedBy: 'The workflow engine raising work from an application, a ticket or a coach application.',
  },
  {
    key: 'quotes',
    group: 'Finance',
    requires: 'quote:read',
    domain: 'quote',
    values: s.quoteStatus.enumValues,
    table: s.quoteVersions,
    statusCol: s.quoteVersions.status,
    // A quotation belongs to an institution or a person, not to a unit of the
    // federation. Nothing on it can narrow it to a state.
    cols: {},
    tableName: 'quote_versions',
    columnName: 'status',
    label: 'Quotation versions',
    page: '/admin/quotes',
    filterable: false,
    populatedBy:
      'A quotation computed against a fee framework where a rule referred it for approval. MMAKF has ' +
      'published no fee rules, so nothing can be computed yet.',
  },
  {
    key: 'payments',
    group: 'Finance',
    requires: 'finance:read',
    domain: 'payment',
    values: s.paymentStatus.enumValues,
    table: s.payments,
    statusCol: s.payments.status,
    // A payment attaches to an order, and an order need not name a person at
    // all — a guest can buy. There is no unit to narrow to, and following the
    // buyer would silently drop every guest payment from the count.
    cols: {},
    tableName: 'payments',
    columnName: 'status',
    label: 'Payments',
    // There is no payments desk in this platform. The audit log filtered to
    // payment entities is the nearest real destination, and the page says so
    // rather than linking to a screen that does not exist.
    page: '/admin/audit?entity=payment',
    filterable: false,
    populatedBy: 'A payment attempt against an order — a membership fee, an entry fee or a shop purchase.',
  },
];

/**
 * The one status excluded from every count, and why it is named rather than
 * silently skipped.
 *
 * `draft` is not excluded by a judgement of this file — the dictionary already
 * says draft is not actionable. It is listed because a reader who knows the
 * register holds drafts is entitled to know they were never in scope: an
 * unfinished application is the applicant's business until they send it.
 */
export const NEVER_COUNTED = 'draft';

/**
 * The statuses of a domain the dictionary says are waiting on somebody.
 *
 * The whole of this module's "needs attention" judgement is this one line, and
 * it is a call into status.ts rather than a list. Marking a status actionable in
 * the dictionary adds it to both dashboards; nothing else moves.
 */
export function actionableStatuses(values: readonly string[], domain: string): string[] {
  return values.filter((v) => v !== NEVER_COUNTED && needsAction(v, domain));
}

// ─── Running them ───────────────────────────────────────────────────────────

export interface AttentionOptions {
  /** The unit being looked at, when the caller is the scoped dashboard. */
  scope?: ScopeRef | null;
  /** Surface-aware link builder. Identity is a fine default. */
  link?: (path: string) => string;
}

/** Every register this caller is entitled to, counted. */
export async function attention(
  db: DB,
  principal: Principal,
  opts: AttentionOptions = {}
): Promise<AttentionReport> {
  const link = opts.link ?? ((p: string) => p);
  const scope = opts.scope ?? null;

  const registers: AttentionRegister[] = [];
  const outOfReach: AttentionReport['outOfReach'] = [];

  for (const spec of SPECS) {
    const statuses = actionableStatuses(spec.values, spec.domain);
    // A register whose vocabulary contains nothing actionable is not work, and
    // a card reading "0" for it would imply it could ever be anything else.
    if (!statuses.length) continue;

    const what = spec.label.toLowerCase();
    const reach = reachClause(principal, spec.requires, spec.cols, what);
    if (!reach.ok && reach.reason === 'no_authority') {
      outOfReach.push({ group: spec.group, label: spec.label, action: spec.requires });
      continue;
    }

    const unit = unitClause(scope, spec.cols, what);
    let blocked: string | null = !reach.ok ? reach.why : !unit.ok ? unit.why : null;

    const viaPerson = (reach.ok && reach.viaPerson) || (unit.ok && unit.viaPerson);
    const scopeCaveat = viaPerson
      ? `Narrowed through the person each row belongs to, because ${spec.tableName} records no unit of ` +
        'its own. A row naming no person cannot be attributed to a unit and is NOT in this figure — so ' +
        'this is a floor, not a total.'
      : null;

    // The narrowing, in words, so a reader can reconstruct the query. Never
    // omitted: a filter the reader cannot see is a filter they cannot check.
    const scopeText =
      !scope || scope.kind === 'national'
        ? 'every row this credential may read'
        : `narrowed to ${scope.label} in SQL`;

    const counts: Record<string, number> = {};
    if (!blocked) {
      try {
        const where = [
          inArray(spec.statusCol, statuses as any),
          (reach as { where: any }).where,
          (unit as { where: any }).where,
        ].filter((c) => c != null);

        const rows = await db
          .select({ v: spec.statusCol, n: sql<number>`count(*)::int` })
          .from(spec.table)
          .where(and(...where))
          .groupBy(spec.statusCol);

        // Zero-filled from the actionable list rather than from what came back.
        // A status with no rows is a MEASURED zero; a missing key would be a gap
        // the reader fills in for themselves.
        for (const st of statuses) counts[st] = 0;
        for (const r of rows) counts[String(r.v)] = Number(r.n ?? 0);
      } catch (err) {
        console.error(`[attention] ${spec.key} failed`, err);
        blocked =
          `The ${spec.tableName} register could not be read, so no figure is shown. A zero here would be ` +
          'indistinguishable from a measurement. The failure is in this deployment’s server log.';
      }
    }

    const items: AttentionItem[] = statuses.map((st) => ({
      key: `${spec.key}:${st}`,
      status: st,
      domain: spec.domain,
      count: blocked ? null : counts[st],
      unavailable: blocked,
      href: spec.filterable ? link(`${spec.page}?status=${encodeURIComponent(st)}`) : link(spec.page),
      hrefFiltered: spec.filterable,
      source: blocked
        ? null
        : {
            table: spec.tableName,
            column: spec.columnName,
            filter: `${spec.columnName} = '${st}', ${scopeText}${viaPerson ? ', through persons' : ''}`,
          },
    }));

    registers.push({
      key: spec.key,
      group: spec.group,
      label: spec.label,
      total: blocked ? null : items.reduce((n, i) => n + (i.count ?? 0), 0),
      unavailable: blocked,
      href: link(spec.page),
      filterable: spec.filterable,
      populatedBy: spec.populatedBy,
      scopeCaveat: blocked ? null : scopeCaveat,
      items,
    });
  }

  return { registers, outOfReach, generatedAt: new Date().toISOString() };
}

/** The words the dictionary uses for a status, for a caption or a sentence. */
export function statusLabel(status: string, domain: string): string {
  return statusOf(status, domain).label;
}

// ─── The two figures that are not statuses ──────────────────────────────────

export interface DatedFigure {
  label: string;
  count: number | null;
  unavailable: string | null;
  href: string | null;
  source: AttentionSource | null;
  populatedBy: string;
}

/** Today, as the audit page's own date filter reads it. */
export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * §114: "what changed today".
 *
 * audit_events carries no state, district or dojo column — an audit row is a
 * fact about the federation, not about a place — so this figure is national by
 * construction and is offered only to a credential holding `audit:read`, which
 * no scoped role holds. That is the same reasoning /admin/audit gives for
 * itself, and it is why the figure is NOT narrowed by scope: a filtered audit
 * count would be a lie about completeness.
 */
export async function changedToday(
  db: DB,
  principal: Principal,
  link: (p: string) => string = (p) => p,
  now: Date = new Date()
): Promise<DatedFigure> {
  const day = todayIso(now);
  const base: DatedFigure = {
    label: 'Decisions recorded today',
    count: null,
    unavailable: null,
    href: link(`/admin/audit?from=${day}`),
    source: null,
    populatedBy:
      'Any decision the federation records — a rank awarded, a result finalised, a certificate issued, a ' +
      'coach suspended. The modules that take those decisions write the row.',
  };

  if (visibleScopes(principal, 'audit:read').kind === 'none') {
    return {
      ...base,
      href: null,
      unavailable:
        'Reading the federation’s record of its own decisions needs "audit:read", which this credential ' +
        'does not hold. The rows exist; they are not yours to count.',
    };
  }

  try {
    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.auditEvents)
      .where(gte(s.auditEvents.at, new Date(`${day}T00:00:00Z`)));
    return {
      ...base,
      count: Number(rows[0]?.n ?? 0),
      source: { table: 'audit_events', column: 'at', filter: `at >= ${day} 00:00 UTC` },
    };
  } catch (err) {
    console.error('[attention] changedToday failed', err);
    return { ...base, unavailable: 'The audit table could not be read, so no figure is shown.' };
  }
}

/**
 * §114: "which competitions are upcoming".
 *
 * A DATE question, not a status one, so it does not go through needsAction():
 * whether an event is in the future is a fact about the calendar and no
 * dictionary is involved. Cancelled events are excluded — a cancelled event is
 * not upcoming — and that is the only judgement made here.
 */
export async function upcomingCompetitions(
  db: DB,
  principal: Principal,
  opts: { scope?: ScopeRef | null; link?: (p: string) => string; now?: Date } = {}
): Promise<DatedFigure> {
  const link = opts.link ?? ((p: string) => p);
  const day = todayIso(opts.now ?? new Date());
  const cols: UnitColumns = {
    state: s.competitionEvents.stateUnitId,
    district: s.competitionEvents.districtUnitId,
    dojo: s.competitionEvents.organiserDojoId,
  };

  const base: DatedFigure = {
    label: 'Competitions dated today or later',
    count: null,
    unavailable: null,
    href: link('/admin/competition'),
    source: null,
    populatedBy: 'An event entered into the competition calendar with a start date.',
  };

  const reach = reachClause(principal, 'competition:read', cols, 'competitions');
  if (!reach.ok) return { ...base, unavailable: reach.why };
  const unit = unitClause(opts.scope ?? null, cols, 'competitions');
  if (!unit.ok) return { ...base, unavailable: unit.why };

  try {
    const where = [
      gte(s.competitionEvents.startsOn, day),
      sql`${s.competitionEvents.status} <> 'cancelled'`,
      reach.where,
      unit.where,
    ].filter((c) => c != null);

    const rows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.competitionEvents)
      .where(and(...where));

    return {
      ...base,
      count: Number(rows[0]?.n ?? 0),
      source: {
        table: 'competition_events',
        column: 'starts_on',
        filter: `starts_on >= ${day} and status <> 'cancelled'`,
      },
    };
  } catch (err) {
    console.error('[attention] upcomingCompetitions failed', err);
    return { ...base, unavailable: 'The competition calendar could not be read, so no figure is shown.' };
  }
}

// ─── What the register cannot answer ────────────────────────────────────────

/**
 * §114 questions this platform will not manufacture an answer to.
 *
 * Printed on both dashboards. A question quietly dropped is indistinguishable
 * from a question answered as zero, and the federation is entitled to know
 * which of the eight it asked for is missing, and why.
 */
export const UNANSWERABLE: Array<{ question: string; why: string }> = [
  {
    question: 'Which certificates are pending?',
    why:
      'There is no pending certificate. certificate_status holds issued, reissued, suspended, revoked and ' +
      'superseded: a certificate exists once it has been issued, and before that there is only a grading ' +
      'candidate. Counting candidates and calling them pending certificates would report a queue the ' +
      'federation does not have. Suspended certificates ARE counted, because a suspension is a decision ' +
      'waiting to be revisited.',
  },
  {
    question: 'Which dojos need approval?',
    why:
      'A dojo under affiliation review sits at draft in dojos.status, which the status dictionary defines ' +
      'as "not yet submitted" — the same value covers an application nobody has sent and one the technical ' +
      'panel is reading. What separates them is the affiliation ledger, one append-only audit row per unit, ' +
      'which no WHERE clause can count. Unit submissions awaiting a decision are counted in the editorial ' +
      'queue instead, which is where that work is actually done.',
  },
];
