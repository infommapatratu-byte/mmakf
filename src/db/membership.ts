// Membership standing, renewal and lapse.
//
// The single most-asked question of any federation is not "who are your
// members" — it is "is THIS person a member in good standing, TODAY?" A
// tournament desk asks it before accepting an entry. An insurer asks it after
// an injury. A school asks it before letting a coach through the gate. Until
// now this system could issue a membership and never answer that question.
//
// THE RULE THAT SHAPES THE MODULE: STANDING IS DERIVED, NEVER STORED.
//
// The obvious design puts `status = 'expired'` in the row and runs a nightly
// job to set it. That design is wrong in a way that is invisible until it
// matters: between the moment a membership lapses and the moment the job runs,
// the database says the person is active. If the job fails on a Friday, it says
// so all weekend — and the tournament desk on Saturday morning believes it.
// Worse, the row cannot answer "was this person in good standing on the day of
// the incident", which is precisely the question that gets asked afterwards.
//
// So `standing()` computes the answer from the dates AS AT A DATE, and the
// stored `status` carries only the facts a date cannot express: pending, active,
// suspended, revoked. The word `expired` exists in the enum and this module
// never writes it — lapse is a consequence of the calendar, not an event
// somebody records.
//
// FOUR THINGS THIS MODULE REFUSES TO DO.
//
//  1. IT WILL NOT INVENT A MEMBERSHIP TERM. The federation has not told this
//     system whether membership runs for a year, a season, or to a fixed date
//     in the calendar. `renew()` therefore requires `validTo` to be supplied or
//     explicitly declared open-ended. Defaulting to twelve months would encode
//     a federation policy nobody set, and it would be wrong quietly.
//
//  2. "NO EXPIRY RECORDED" IS NOT "VALID FOREVER". A row with a null `validTo`
//     may be deliberate or may be an omission in the register, and only the
//     office can tell. It gets its own standing, and every surface must print
//     it as what it is.
//
//  3. IT WILL NOT HIDE A GAP. Renewing a membership that lapsed three months
//     ago is legitimate and common; pretending the three months were covered is
//     not. `renew()` returns the gap it created so a caller can show it, and
//     the previous membership keeps its real dates.
//
//  4. IT WILL NOT ANSWER FOR A DATE IT WAS NOT ASKED ABOUT. Every function that
//     touches validity takes `asAt` and returns it alongside the answer, so a
//     cached page cannot present a stale "active" as though it were current.

import { and, asc, desc, eq, inArray, isNull, lte, gte, or, sql, type SQL } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, canAnywhere, visibleScopes, type Principal } from '@/lib/rbac';
import { isStudentMembershipCategory } from './student-rule';

type DB = any;

export class MembershipError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'MembershipError';
    this.code = code;
  }
}

/** See calendar.ts for why identity is checked by shape and not `instanceof`. */
export function isMembershipError(err: unknown): err is MembershipError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'MembershipError';
}

export type Category = 'athlete' | 'instructor' | 'dojo' | 'official';
export const CATEGORIES: readonly Category[] = ['athlete', 'instructor', 'dojo', 'official'];

// ─── Standing ───────────────────────────────────────────────────────────────

/**
 * Every answer this module can give about a person's membership on a date.
 *
 * These are deliberately NOT collapsed into a boolean. "Lapsed" and "revoked"
 * are both "not a member today" and could not be more different: one is an
 * administrative oversight a renewal fixes, and the other is a decision the
 * federation made. A surface that renders both as a red cross throws away the
 * distinction that matters most to the person standing in front of it.
 */
export type Standing =
  | 'in_good_standing'
  | 'lapsed'
  | 'not_yet_valid'
  | 'no_expiry_recorded'
  | 'pending'
  | 'suspended'
  | 'revoked'
  | 'never_registered';

export interface StandingAnswer {
  standing: Standing;
  /** The date this was answered for. Always echoed; never assumed to be today. */
  asAt: string;
  /** The membership the answer came from, or null when there is none at all. */
  membership: {
    id: number;
    category: Category;
    validFrom: string;
    validTo: string | null;
    status: string;
  } | null;
  /**
   * Whether the person may be treated as a member for this date. Provided so a
   * caller does not re-implement the mapping and get it subtly different, but
   * `standing` is the answer — this is a convenience derived from it.
   */
  covered: boolean;
  /** One sentence a member-facing surface can print verbatim. */
  explanation: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function requireIsoDate(value: string, field: string): string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new MembershipError('bad_date', `${field} must be an ISO date (YYYY-MM-DD); received ${JSON.stringify(value)}.`);
  }
  if (Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw new MembershipError('bad_date', `${field} is not a real date.`);
  }
  return value;
}

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

const iso = (v: string | Date | null | undefined): string | null =>
  !v ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

const COVERED: ReadonlySet<Standing> = new Set<Standing>(['in_good_standing', 'no_expiry_recorded']);

const EXPLANATION: Record<Standing, string> = {
  in_good_standing: 'Membership is current for this date.',
  lapsed: 'Membership has lapsed. It can be renewed; nothing has been withdrawn.',
  not_yet_valid: 'Membership has been issued but does not begin until a later date.',
  no_expiry_recorded:
    'Membership is active and the register records no expiry date. That may be deliberate or an omission — the federation office can confirm which.',
  pending: 'Membership has been raised but not yet issued.',
  suspended: 'Membership is suspended. This is a federation decision, not a lapse.',
  revoked: 'Membership has been revoked by the federation.',
  never_registered: 'No membership of this category has ever been recorded for this person.',
};

/**
 * The standing of ONE membership row as at a date. Exported because a caller
 * holding a row already should not have to re-query to interpret it, and
 * because interpreting it in two places is how two answers appear.
 */
export function standingOf(
  row: { status: string; validFrom: string | Date; validTo: string | Date | null } | null | undefined,
  asAt: string
): Standing {
  if (!row) return 'never_registered';

  // Federation decisions outrank the calendar. A suspended membership whose
  // dates happen to be current is not "in good standing" for one day longer.
  if (row.status === 'revoked') return 'revoked';
  if (row.status === 'suspended') return 'suspended';
  if (row.status === 'pending') return 'pending';

  const from = iso(row.validFrom)!;
  const to = iso(row.validTo);

  if (asAt < from) return 'not_yet_valid';
  if (to === null) return 'no_expiry_recorded';
  return asAt <= to ? 'in_good_standing' : 'lapsed';
}

/**
 * Is this person in good standing, as at a date?
 *
 * Reads the person's own memberships for the category and returns the one that
 * gives the STRONGEST answer for the date — because a person can legitimately
 * hold a lapsed membership from 2024 and a current one from 2026, and reporting
 * the most recent row would say "lapsed" for somebody who renewed.
 */
export async function standing(
  db: DB,
  principal: Principal,
  personId: number,
  category: Category,
  opts: { asAt?: string } = {}
): Promise<StandingAnswer> {
  if (!CATEGORIES.includes(category)) {
    throw new MembershipError('bad_category', `Unknown membership category: ${String(category)}.`);
  }
  const asAt = opts.asAt ? requireIsoDate(opts.asAt, 'asAt') : todayIso();

  const person = (await db.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1))[0];
  if (!person) throw new MembershipError('unknown_person', 'No such person.');

  assertCan(principal, 'membership:read', {
    stateUnitId: person.stateUnitId,
    districtUnitId: person.districtUnitId,
    dojoId: person.dojoId,
  });

  const rows = await db.select().from(s.memberships)
    .where(and(eq(s.memberships.personId, personId), eq(s.memberships.category, category)))
    .orderBy(desc(s.memberships.validFrom), desc(s.memberships.id));

  return resolveStanding(rows, asAt);
}

/**
 * Rank of answers, strongest first. Used to pick which of several memberships
 * speaks for the person on a date.
 *
 * `revoked` and `suspended` sit ABOVE `lapsed` deliberately: if the federation
 * has revoked a membership, that fact must survive the existence of an older
 * expired one. It sits below `in_good_standing` equally deliberately — a
 * revoked 2024 membership does not undo a validly issued 2026 one.
 */
const STRENGTH: Standing[] = [
  'in_good_standing',
  'no_expiry_recorded',
  'revoked',
  'suspended',
  'not_yet_valid',
  'pending',
  'lapsed',
  'never_registered',
];

export function resolveStanding(rows: any[], asAt: string): StandingAnswer {
  if (!rows.length) {
    return {
      standing: 'never_registered', asAt, membership: null,
      covered: false, explanation: EXPLANATION.never_registered,
    };
  }

  let best: { standing: Standing; row: any } | null = null;
  for (const row of rows) {
    const st = standingOf(row, asAt);
    if (!best || STRENGTH.indexOf(st) < STRENGTH.indexOf(best.standing)) best = { standing: st, row };
  }

  const row = best!.row;
  return {
    standing: best!.standing,
    asAt,
    membership: {
      id: row.id,
      category: row.category,
      validFrom: iso(row.validFrom)!,
      validTo: iso(row.validTo),
      status: row.status,
    },
    covered: COVERED.has(best!.standing),
    explanation: EXPLANATION[best!.standing],
  };
}

// ─── Renewal ────────────────────────────────────────────────────────────────

export interface RenewInput {
  personId: number;
  category: Category;
  validFrom: string;
  /**
   * The end of the new term, or `null` to record a membership with NO expiry.
   *
   * REQUIRED — including the null. There is no default, because the federation
   * has not told this system how long a membership runs, and a twelve-month
   * default would encode a policy nobody set. Making the caller state it makes
   * an open-ended membership a decision somebody took rather than a field
   * somebody forgot.
   */
  validTo: string | null;
}

export interface RenewResult {
  membershipId: number;
  /**
   * The membership this one follows, and the gap between them in days. Null
   * when this is a first membership. A POSITIVE gap means the person was
   * uncovered for that many days, and the caller must be able to say so —
   * renewing after a lapse is legitimate; implying the lapse did not happen is
   * not.
   */
  previous: { id: number; validTo: string | null; gapDays: number | null } | null;
  /** True when the new term starts before the previous one ended. */
  overlapsPrevious: boolean;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${toIso}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Renew (or first-issue) a membership.
 *
 * Append-only, like every other credential in this system: the previous
 * membership keeps its real dates and is marked `expired` ONLY in the sense of
 * being superseded — this function never rewrites history to make a renewal
 * look continuous.
 */
export async function renew(db: DB, ctx: AuditContext, input: RenewInput): Promise<RenewResult> {
  if (!CATEGORIES.includes(input.category)) {
    throw new MembershipError('bad_category', `Unknown membership category: ${String(input.category)}.`);
  }

  // ── A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT ──
  //
  // THE LAST PLACE ONE COULD BE CREATED. src/db/orders.ts refuses to CHARGE for
  // a student membership from any of its three price sources; configureTerm()
  // refuses to record that a fee BUYS one; decideMembership() refuses to ACT on
  // a term row that says it does. All of those sit on the money path. This
  // function does not: it is the register's own issue-and-renew action, and it
  // would still mint an athlete membership for anybody holding
  // 'membership:issue' — no charge, no fee code, no order, and therefore no
  // guard in front of it.
  //
  // The federation's instruction names who membership is for: coaches,
  // officials, examiners and clubs. An athlete is not on that list, and
  // src/db/revenue.ts has reported the category as withdrawn since 17 August
  // 2026 while nothing stopped another being issued. This is that sentence
  // becoming true rather than remaining a caption.
  //
  // WHAT IS NOT REFUSED, and the distinction is the whole of it:
  //
  //   · READING. standing(), resolveStanding(), history(), lapsingSoon(),
  //     /verify and the public register all still read athlete memberships
  //     exactly as they are. An issued credential is a fact.
  //   · CORRECTING. suspend(), reinstate() and revoke() still work on one. A
  //     federation that cannot revoke a credential it issued is worse off than
  //     one that never issued it.
  //
  // Only ISSUING ANOTHER is refused. The category stays in the enum for the
  // same reason: removing it would orphan the rows, and the rule governs what
  // may be created from now on, never what the record says already happened.
  if (isStudentMembershipCategory(input.category)) {
    throw new MembershipError(
      'student_membership_refused',
      `The federation does not issue a '${input.category}' membership. A student does not pay a membership ` +
      'fee for being a student — what a student buys is TRAINING, and an account, a profile, an enrolment ' +
      'and a place in a class are what having a student means rather than products to be sold. Access to ' +
      'training is decided by a valid training entitlement, which this row would not grant and whose absence ' +
      'it would not cure. The register admits an instructor, an official or a dojo. Memberships already ' +
      'issued in this category keep their rows and stay readable, and can still be suspended or revoked.'
    );
  }
  const validFrom = requireIsoDate(input.validFrom, 'validFrom');

  // `undefined` is a forgotten field; `null` is a stated decision. They are not
  // the same and this is the one place that difference is load-bearing.
  if (input.validTo === undefined) {
    throw new MembershipError(
      'term_not_stated',
      'validTo must be given, or explicitly null for a membership with no recorded expiry. ' +
      'This system does not know how long an MMAKF membership runs and will not assume a term.'
    );
  }
  const validTo = input.validTo === null ? null : requireIsoDate(input.validTo, 'validTo');
  if (validTo !== null && validTo < validFrom) {
    throw new MembershipError('bad_term', 'A membership cannot end before it begins.');
  }

  const person = (await db.select().from(s.persons).where(eq(s.persons.id, input.personId)).limit(1))[0];
  if (!person) throw new MembershipError('unknown_person', 'No such person.');

  assertCan(ctx.principal, 'membership:issue', {
    stateUnitId: person.stateUnitId,
    districtUnitId: person.districtUnitId,
    dojoId: person.dojoId,
  });

  const prior = await db.select().from(s.memberships)
    .where(and(eq(s.memberships.personId, input.personId), eq(s.memberships.category, input.category)))
    .orderBy(desc(s.memberships.validFrom), desc(s.memberships.id))
    .limit(1);

  const previousRow = prior[0] ?? null;

  // A revoked membership is a federation decision. Renewing over it silently
  // would let an administrator undo a revocation by issuing a new card, which
  // is precisely the control revocation exists to provide.
  if (previousRow && previousRow.status === 'revoked') {
    throw new MembershipError(
      'previous_revoked',
      'The most recent membership in this category was REVOKED by the federation. ' +
      'Renewing over a revocation would undo it without the decision that reversed it. ' +
      'The revocation must be addressed on its own terms first.'
    );
  }

  const [row] = await db.insert(s.memberships).values({
    personId: input.personId,
    category: input.category,
    validFrom,
    validTo,
    status: 'active',
    issuedByUserId: ctx.principal.userId ?? null,
  }).returning({ id: s.memberships.id });

  let previous: RenewResult['previous'] = null;
  let overlapsPrevious = false;

  if (previousRow) {
    const prevTo = iso(previousRow.validTo);
    // A gap is only meaningful against a term that actually ended. An
    // open-ended previous membership has no gap to measure, and reporting 0
    // would claim continuity this module cannot establish.
    const gapDays = prevTo ? Math.max(0, daysBetween(prevTo, validFrom) - 1) : null;
    overlapsPrevious = prevTo !== null && validFrom <= prevTo;
    previous = { id: previousRow.id, validTo: prevTo, gapDays };

    // Supersede rather than delete. The old row keeps its own dates, which is
    // what makes "was this person covered in March 2025" answerable later.
    if (previousRow.status === 'active') {
      await db.update(s.memberships)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(eq(s.memberships.id, previousRow.id));
    }
  }

  await writeAudit(db, ctx, {
    entityType: 'membership',
    entityId: row.id,
    action: 'create',
    newValue: {
      personId: input.personId, category: input.category, validFrom, validTo,
      renewalOf: previousRow?.id ?? null,
      gapDays: previous?.gapDays ?? null,
    },
  });

  return { membershipId: row.id, previous, overlapsPrevious };
}

// ─── Suspension and revocation ──────────────────────────────────────────────

/**
 * Suspend a membership. Distinct from revocation and from lapse, and the
 * distinction is the point: a suspension is reversible and says the federation
 * has paused someone's participation, which is a different sentence from "your
 * card ran out" and a different one again from "you are no longer a member".
 */
export async function suspend(db: DB, ctx: AuditContext, membershipId: number, reason: string) {
  return transition(db, ctx, membershipId, 'suspended', reason, 'suspend');
}

/** Lift a suspension, returning the membership to active. Requires a reason. */
export async function reinstate(db: DB, ctx: AuditContext, membershipId: number, reason: string) {
  const row = await load(db, membershipId);
  if (row.status !== 'suspended') {
    throw new MembershipError('not_suspended', `Only a suspended membership can be reinstated; this one is ${row.status}.`);
  }
  return transition(db, ctx, membershipId, 'active', reason, 'reinstate');
}

export async function revoke(db: DB, ctx: AuditContext, membershipId: number, reason: string) {
  return transition(db, ctx, membershipId, 'revoked', reason, 'revoke');
}

async function load(db: DB, membershipId: number) {
  const row = (await db.select().from(s.memberships).where(eq(s.memberships.id, membershipId)).limit(1))[0];
  if (!row) throw new MembershipError('unknown_membership', 'No such membership.');
  return row;
}

async function transition(
  db: DB, ctx: AuditContext, membershipId: number,
  next: 'suspended' | 'revoked' | 'active', reason: string,
  action: 'suspend' | 'reinstate' | 'revoke'
) {
  // A reason is not paperwork. Without one, the record cannot answer "why is
  // this person suspended" a year later, and the answer walks out of the office
  // with whoever made the decision.
  if (!reason || !reason.trim()) {
    throw new MembershipError('reason_required', `A ${action} requires a recorded reason.`);
  }

  const row = await load(db, membershipId);
  const person = (await db.select().from(s.persons).where(eq(s.persons.id, row.personId)).limit(1))[0];

  assertCan(ctx.principal, 'membership:revoke', {
    stateUnitId: person?.stateUnitId ?? null,
    districtUnitId: person?.districtUnitId ?? null,
    dojoId: person?.dojoId ?? null,
  });

  await db.update(s.memberships)
    .set({ status: next, revokedReason: reason.trim(), updatedAt: new Date() })
    .where(eq(s.memberships.id, membershipId));

  // The reason travels on the CONTEXT. writeAudit() reads ctx.reason and
  // ignores an entry-level field, so passing it in the entry silently dropped
  // it — the row kept the reason and the audit trail did not.
  await writeAudit(db, { ...ctx, reason: reason.trim() }, {
    entityType: 'membership',
    entityId: membershipId,
    action: action as any,
    oldValue: { status: row.status, revokedReason: row.revokedReason },
    newValue: { status: next, revokedReason: reason.trim() },
  });

  return { id: membershipId, status: next };
}

// ─── Lapse management ───────────────────────────────────────────────────────

export interface LapsingRow {
  membershipId: number;
  personId: number;
  federationId: string;
  fullName: string;
  category: Category;
  validTo: string;
  daysRemaining: number;
  stateUnitId: number | null;
  districtUnitId: number | null;
  dojoId: number | null;
}

export interface LapsingReport {
  asAt: string;
  withinDays: number;
  rows: LapsingRow[];
  /** True when the cap was reached, so a caller cannot read this as the total. */
  truncated: boolean;
  /**
   * Memberships with no expiry date, counted rather than listed. They cannot
   * lapse and so cannot appear above — but a register full of them is a data
   * quality problem the office should see, not a silence.
   */
  withNoExpiryRecorded: number;
}

export const MAX_LAPSING_ROWS = 500;

/**
 * Memberships lapsing within a window, scoped to what the caller may see.
 *
 * Ordered by how little time is left, because the only useful thing an
 * administrator does with this list is work down it.
 */
export async function lapsingSoon(
  db: DB,
  principal: Principal,
  opts: { withinDays?: number; asAt?: string; limit?: number } = {}
): Promise<LapsingReport> {
  if (!canAnywhere(principal, 'membership:read')) {
    throw new MembershipError('forbidden', 'Reading the membership register requires membership:read.');
  }
  const asAt = opts.asAt ? requireIsoDate(opts.asAt, 'asAt') : todayIso();
  const withinDays = Math.max(0, Math.min(365, Math.floor(opts.withinDays ?? 30)));
  const limit = Math.max(1, Math.min(MAX_LAPSING_ROWS, Math.floor(opts.limit ?? 200)));

  const horizon = new Date(`${asAt}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + withinDays);
  const horizonIso = horizon.toISOString().slice(0, 10);

  const scopes = visibleScopes(principal, 'membership:read');
  if (scopes.kind === 'none') {
    return { asAt, withinDays, rows: [], truncated: false, withNoExpiryRecorded: 0 };
  }

  const where: SQL[] = [
    eq(s.memberships.status, 'active'),
    gte(s.memberships.validTo, asAt),
    lte(s.memberships.validTo, horizonIso),
  ];

  if (scopes.kind === 'scoped') {
    const parts: SQL[] = [];
    if (scopes.states.length) parts.push(inArray(s.persons.stateUnitId, scopes.states) as SQL);
    if (scopes.districts.length) parts.push(inArray(s.persons.districtUnitId, scopes.districts) as SQL);
    if (scopes.dojos.length) parts.push(inArray(s.persons.dojoId, scopes.dojos) as SQL);
    // No scope predicate would mean "everyone". Refusing is the fail-closed
    // reading and the only safe one for a list of the whole register.
    if (!parts.length) {
      return { asAt, withinDays, rows: [], truncated: false, withNoExpiryRecorded: 0 };
    }
    where.push(or(...parts) as SQL);
  }

  const found = await db
    .select({
      membershipId: s.memberships.id,
      personId: s.persons.id,
      federationId: s.persons.federationId,
      fullName: s.persons.fullName,
      category: s.memberships.category,
      validTo: s.memberships.validTo,
      stateUnitId: s.persons.stateUnitId,
      districtUnitId: s.persons.districtUnitId,
      dojoId: s.persons.dojoId,
    })
    .from(s.memberships)
    .innerJoin(s.persons, eq(s.persons.id, s.memberships.personId))
    .where(and(...where))
    .orderBy(asc(s.memberships.validTo), asc(s.persons.fullName))
    .limit(limit + 1);

  const truncated = found.length > limit;
  const rows: LapsingRow[] = found.slice(0, limit).map((r: any) => ({
    ...r,
    validTo: iso(r.validTo)!,
    daysRemaining: daysBetween(asAt, iso(r.validTo)!),
  }));

  // Counted in the same scope, so the number means the same thing as the list.
  const noExpiryWhere: SQL[] = [eq(s.memberships.status, 'active'), isNull(s.memberships.validTo)];
  if (scopes.kind === 'scoped') {
    const parts: SQL[] = [];
    if (scopes.states.length) parts.push(inArray(s.persons.stateUnitId, scopes.states) as SQL);
    if (scopes.districts.length) parts.push(inArray(s.persons.districtUnitId, scopes.districts) as SQL);
    if (scopes.dojos.length) parts.push(inArray(s.persons.dojoId, scopes.dojos) as SQL);
    if (parts.length) noExpiryWhere.push(or(...parts) as SQL);
  }
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(s.memberships)
    .innerJoin(s.persons, eq(s.persons.id, s.memberships.personId))
    .where(and(...noExpiryWhere));

  return { asAt, withinDays, rows, truncated, withNoExpiryRecorded: Number(count) };
}

/**
 * The full membership history for one person — every category, every term,
 * every superseded row, each with the standing it would have had on the date
 * asked about.
 *
 * Nothing is filtered out. A lapsed 2024 membership is part of the record, and
 * a register that shows only what is current cannot answer the question that
 * gets asked after an incident.
 */
export async function history(
  db: DB,
  principal: Principal,
  personId: number,
  opts: { asAt?: string } = {}
) {
  const asAt = opts.asAt ? requireIsoDate(opts.asAt, 'asAt') : todayIso();
  const person = (await db.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1))[0];
  if (!person) throw new MembershipError('unknown_person', 'No such person.');

  assertCan(principal, 'membership:read', {
    stateUnitId: person.stateUnitId,
    districtUnitId: person.districtUnitId,
    dojoId: person.dojoId,
  });

  const rows = await db.select().from(s.memberships)
    .where(eq(s.memberships.personId, personId))
    .orderBy(desc(s.memberships.validFrom), desc(s.memberships.id));

  return {
    asAt,
    byCategory: CATEGORIES.map((category) => {
      const forCategory = rows.filter((r: any) => r.category === category);
      return {
        category,
        current: resolveStanding(forCategory, asAt),
        terms: forCategory.map((r: any) => ({
          id: r.id,
          validFrom: iso(r.validFrom)!,
          validTo: iso(r.validTo),
          status: r.status,
          standingAsAt: standingOf(r, asAt),
          revokedReason: r.revokedReason ?? null,
        })),
      };
    }).filter((c) => c.terms.length > 0),
  };
}
