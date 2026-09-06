// THE WORKFORCE — employment, leave, time, expenses and recruitment.
//
// Migration 0058 carries the schema reasoning. This file carries the five rules
// no CHECK constraint can express.
//
// ═══════════════════════════════════════════════════════════════════════════
// 1. SELF-SERVICE FUNCTIONS TAKE NO ID
// ═══════════════════════════════════════════════════════════════════════════
//
// `myEmployment()`, `myLeave()`, `myClaims()` and every other `my*` function
// take a `Principal` and NOTHING ELSE. They resolve the caller's own employment
// from `users.personId` and read that.
//
// There is no `employmentId` parameter for a client to substitute, which is why
// there is no IDOR to get wrong. The same pattern as `/my/family`, and for the
// same reason: the moment a self-service read accepts an identifier, every
// caller of it has to remember to check ownership, and one of them will not.
//
// ═══════════════════════════════════════════════════════════════════════════
// 2. THREE WAYS TO BE ALLOWED, AND THEY ARE NOT INTERCHANGEABLE
// ═══════════════════════════════════════════════════════════════════════════
//
//   SELF      it is your own record                → no action required
//   MANAGER   `employments.managerPersonId` is you → decides leave, time, claims
//   HR        `hr:read` / `hr:write`               → the whole establishment
//
// A MANAGER IS NOT AN RBAC ROLE HERE, and that is deliberate. Line management
// changes weekly and is a fact about a row, not about a login; minting a
// `MANAGER` role would mean a role grant every time somebody's reporting line
// moved, and a stale grant is somebody still approving their old team's leave.
//
// ═══════════════════════════════════════════════════════════════════════════
// 3. NOBODY DECIDES THEIR OWN REQUEST
// ═══════════════════════════════════════════════════════════════════════════
//
// `decideLeave()`, `decideClaim()` and `approveWork()` refuse when the decider
// is the subject — checked on `userId`, and refused outright when the actor
// cannot be named.
//
// This is the four-eyes rule the sixth-wave review found MISSING on governed
// profile changes, where one shared office login filed a date-of-birth change
// and approved its own request. An unattributable actor FAILS the test here
// rather than passing it, because a control that cannot show it was two people
// is not a control.
//
// An HR officer with `hr:write` is not exempt. If the head of HR wants leave,
// somebody else approves it.
//
// ═══════════════════════════════════════════════════════════════════════════
// 4. THE PUBLIC CAREERS PAGE READS ONE FUNCTION THAT TAKES NO PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════
//
// `publicVacancies()` and `publicVacancy()` filter on `published AND status =
// 'open'`, select a fixed column list, and accept no parameter that could widen
// them. A draft vacancy, a withdrawn one and a filled one cannot be reached.
//
// `applyForVacancy()` likewise takes no principal — a candidate has no login,
// and requiring one would mean nobody outside the federation could ever apply.
// It re-reads the vacancy and refuses if it is not open, so a stale form posted
// after a vacancy closed is told so rather than silently accepted.
//
// ═══════════════════════════════════════════════════════════════════════════
// 5. NO SALARY IS COMPUTED ANYWHERE IN THIS FILE
// ═══════════════════════════════════════════════════════════════════════════
//
// `payBandCode` is carried and never interpreted. There is no rate, no
// multiplier and no total. Approved `work_records` and approved
// `leave_requests` are the INPUTS a payroll system consumes; computing a figure
// somebody actually pays a real person is a regulated act this repository does
// not perform, and half-doing it is worse than not doing it.

import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import * as w from '@/db/workforce.schema';
// `departments` lives in team.schema.ts and is NOT re-exported from schema.ts —
// see the note at the bottom of that file. The establishment and the public team
// register share one department tree deliberately: two organisations that
// disagree about their own departments is the drift this avoids.
import { departments } from '@/db/team.schema';
import { allocateFederationId, writeAudit, type AuditContext } from '@/db/federation';
import { reference } from '@/lib/refs';
import {
  assertCanAnywhere, canAnywhere, ForbiddenError, type Principal,
} from '@/lib/rbac';
import { publish } from '@/lib/domain-events';

type DB = any;

// ─── Failures ───────────────────────────────────────────────────────────────

export type WorkforceErrorCode =
  | 'no_such_position' | 'no_such_employment' | 'no_such_person'
  | 'no_such_vacancy' | 'no_such_application' | 'no_such_offer'
  | 'no_such_leave_type' | 'no_such_request' | 'no_such_claim'
  | 'no_such_interview'
  | 'not_employed' | 'already_employed' | 'already_ended'
  | 'bad_period' | 'bad_state' | 'bad_input' | 'bad_amount'
  | 'duplicate_application' | 'vacancy_not_open'
  | 'self_decision' | 'unattributable'
  | 'insufficient_balance' | 'not_a_panellist' | 'already_given_feedback';

export class WorkforceError extends Error {
  readonly code: WorkforceErrorCode;
  constructor(code: WorkforceErrorCode, message: string) {
    super(message);
    this.name = 'WorkforceError';
    this.code = code;
  }
}

export function isWorkforceError(err: unknown): err is WorkforceError {
  return err instanceof WorkforceError;
}

// ─── Controlled vocabularies ────────────────────────────────────────────────

/**
 * Why somebody left. NOT free text, because an exit reason is read in aggregate
 * — "how many people resigned last year" is the question HR is actually asked —
 * and free text makes that unanswerable.
 */
export const EXIT_REASONS = [
  'resigned', 'retired', 'contract_ended', 'dismissed',
  'redundancy', 'deceased', 'transferred',
] as const;
export type ExitReason = (typeof EXIT_REASONS)[number];

export const EXPENSE_CATEGORIES = [
  'travel', 'accommodation', 'meals', 'equipment', 'training', 'other',
] as const;

export const RECOMMENDATIONS = ['strong_yes', 'yes', 'no', 'strong_no'] as const;

// ─── Helpers ────────────────────────────────────────────────────────────────

function todayIso(timeZone = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone }).format(new Date());
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days between two ISO dates, inclusive of both ends. */
function inclusiveDays(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`);
  const b = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((b - a) / 86400000) + 1;
}

function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}

/**
 * WHO IS ASKING, as a person rather than as a login.
 *
 * Everything in this module is about a human being — their employment, their
 * leave, their team — and `users.personId` is the only join from a session to
 * one. A login with no person attached is NOT employed by definition, and is
 * told so rather than being handed an empty list that reads like "you have no
 * leave" when the truth is "this account is not linked to a person".
 */
export async function actorPerson(db: DB, principal: Principal): Promise<number | null> {
  if (!principal?.userId) return null;
  const [row] = await db
    .select({ personId: s.users.personId })
    .from(s.users)
    .where(eq(s.users.id, principal.userId))
    .limit(1);
  return row?.personId ?? null;
}

/** The caller's own live employment, or null. Takes no id — see rule 1. */
export async function myEmployment(db: DB, principal: Principal) {
  const personId = await actorPerson(db, principal);
  if (!personId) return null;
  const [row] = await db
    .select()
    .from(w.employments)
    .where(and(eq(w.employments.personId, personId), ne(w.employments.status, 'ended')))
    .limit(1);
  return row ?? null;
}

async function loadEmployment(db: DB, employmentId: number) {
  const [row] = await db.select().from(w.employments).where(eq(w.employments.id, employmentId)).limit(1);
  if (!row) throw new WorkforceError('no_such_employment', `No employment ${employmentId}.`);
  return row;
}

/**
 * May this principal READ this employment record?
 *
 * Self, or their line manager, or the HR office. Nothing else — a
 * FEDERATION_ADMIN holds neither `hr:read` nor a management line, and PART X is
 * explicit that HR data must not reach ordinary administrators.
 */
export async function canReadEmployment(db: DB, principal: Principal, employment: any): Promise<boolean> {
  if (canAnywhere(principal, 'hr:read')) return true;
  const personId = await actorPerson(db, principal);
  if (!personId) return false;
  if (employment.personId === personId) return true;
  return employment.managerPersonId === personId;
}

async function assertCanReadEmployment(db: DB, principal: Principal, employment: any) {
  if (!(await canReadEmployment(db, principal, employment))) throw new ForbiddenError('hr:read');
}

/** May this principal DECIDE on this employment's requests? Manager or HR. */
async function assertCanDecideFor(db: DB, principal: Principal, employment: any) {
  const personId = await actorPerson(db, principal);
  // RULE 3. Checked before authority, so the head of HR is refused on their own
  // request rather than allowed through by their own permission.
  if (personId && employment.personId === personId) {
    throw new WorkforceError(
      'self_decision',
      'You cannot decide your own request. Somebody else has to — that is the whole of what a second pair of eyes means, and holding hr:write does not exempt the person who holds it.'
    );
  }
  if (canAnywhere(principal, 'hr:write')) {
    if (!principal.userId) {
      throw new WorkforceError(
        'unattributable',
        'This decision cannot be attributed to a named person, so it cannot be recorded as one. Sign in with an individual account.'
      );
    }
    return;
  }
  if (personId && employment.managerPersonId === personId) {
    if (!principal.userId) throw new WorkforceError('unattributable', 'This decision cannot be attributed to a named person.');
    return;
  }
  throw new ForbiddenError('hr:write');
}

async function recordEmploymentEvent(
  db: DB, ctx: AuditContext,
  entry: { employmentId: number; kind: string; effectiveOn: string; before: unknown; after: unknown; reason?: string | null }
) {
  await db.insert(w.employmentEvents).values({
    employmentId: entry.employmentId,
    kind: entry.kind,
    effectiveOn: entry.effectiveOn,
    before: entry.before ?? null,
    after: entry.after,
    reason: entry.reason ?? ctx.reason ?? null,
    actorUserId: ctx.principal.userId ?? null,
    actorLabel: ctx.principal.label,
  });
}

// ─── Positions: the establishment ───────────────────────────────────────────

export async function createPosition(
  db: DB, ctx: AuditContext,
  input: {
    code: string; title: string; orgLevel: string;
    departmentId?: number | null; reportsToPositionId?: number | null;
    headcount?: number; payBandCode?: string | null;
    scopeType?: string; scopeStateUnitId?: number | null;
    description?: string | null; responsibilities?: string | null;
  }
) {
  assertCanAnywhere(ctx.principal, 'hr:write');

  const code = input.code?.trim().toUpperCase();
  if (!code) throw new WorkforceError('bad_input', 'A position needs a code.');
  const title = input.title?.trim();
  if (!title) throw new WorkforceError('bad_input', 'A position needs a title.');
  const headcount = input.headcount ?? 1;
  if (!Number.isInteger(headcount) || headcount < 1) {
    throw new WorkforceError('bad_input', 'Headcount must be a whole number of at least one.');
  }

  if (input.reportsToPositionId != null) {
    const [parent] = await db.select({ id: w.positions.id })
      .from(w.positions).where(eq(w.positions.id, input.reportsToPositionId)).limit(1);
    if (!parent) throw new WorkforceError('no_such_position', `No position ${input.reportsToPositionId} to report to.`);
  }

  const scopeType = (input.scopeType || 'national') as any;
  if (scopeType === 'state' && input.scopeStateUnitId == null) {
    throw new WorkforceError('bad_input', 'A state-scoped position needs a state unit.');
  }

  const [row] = await db.insert(w.positions).values({
    code, title,
    departmentId: input.departmentId ?? null,
    orgLevel: input.orgLevel as any,
    reportsToPositionId: input.reportsToPositionId ?? null,
    headcount,
    payBandCode: input.payBandCode?.trim() || null,
    scopeType,
    scopeStateUnitId: scopeType === 'state' ? input.scopeStateUnitId! : null,
    description: input.description?.trim() || null,
    responsibilities: input.responsibilities?.trim() || null,
    status: 'draft',
  }).returning();

  await writeAudit(db, ctx, { entityType: 'position', entityId: row.id, action: 'create', newValue: row });
  return row;
}

/**
 * Re-parent a position, refusing a cycle.
 *
 * The CHECK catches only self-reporting. A → B → A needs a walk, done here so
 * the refusal carries a sentence an administrator can act on, and bounded by a
 * hop count so pre-existing bad data cannot hang the request.
 */
export async function setPositionReportsTo(db: DB, ctx: AuditContext, positionId: number, reportsToPositionId: number | null) {
  assertCanAnywhere(ctx.principal, 'hr:write');
  const [pos] = await db.select().from(w.positions).where(eq(w.positions.id, positionId)).limit(1);
  if (!pos) throw new WorkforceError('no_such_position', `No position ${positionId}.`);

  if (reportsToPositionId != null) {
    if (reportsToPositionId === positionId) {
      throw new WorkforceError('bad_input', 'A position cannot report to itself.');
    }
    let cursor: number | null = reportsToPositionId;
    for (let hops = 0; cursor != null && hops < 64; hops++) {
      if (cursor === positionId) {
        throw new WorkforceError('bad_input', 'That would make the position its own manager, through the reporting line.');
      }
      // Annotated for the same reason as the department walk in src/db/team.ts:
      // `cursor` types the query, the query types `next`, and `next` is
      // assigned back to `cursor`, so TypeScript gives up (TS7022) and the row
      // becomes implicitly `any`. Naming the shape restores the null check that
      // ends the walk at the top of the reporting line.
      const above: Array<{ up: number | null }> = await db
        .select({ up: w.positions.reportsToPositionId })
        .from(w.positions).where(eq(w.positions.id, cursor)).limit(1);
      const next = above[0];
      if (!next) break;
      cursor = next.up;
    }
  }

  const [row] = await db.update(w.positions)
    .set({ reportsToPositionId, updatedAt: new Date() })
    .where(eq(w.positions.id, positionId)).returning();
  await writeAudit(db, ctx, {
    entityType: 'position', entityId: positionId, action: 'update',
    oldValue: { reportsToPositionId: pos.reportsToPositionId }, newValue: { reportsToPositionId },
  });
  return row;
}

export async function setPositionStatus(db: DB, ctx: AuditContext, positionId: number, status: string) {
  assertCanAnywhere(ctx.principal, 'hr:write');
  const [pos] = await db.select().from(w.positions).where(eq(w.positions.id, positionId)).limit(1);
  if (!pos) throw new WorkforceError('no_such_position', `No position ${positionId}.`);
  const [row] = await db.update(w.positions)
    .set({ status: status as any, updatedAt: new Date() })
    .where(eq(w.positions.id, positionId)).returning();
  await writeAudit(db, ctx, {
    entityType: 'position', entityId: positionId, action: 'update',
    oldValue: { status: pos.status }, newValue: { status },
  });
  return row;
}

export async function listPositions(db: DB, principal: Principal, opts: { status?: string[] } = {}) {
  assertCanAnywhere(principal, 'hr:read');
  const clauses: any[] = [];
  if (opts.status?.length) clauses.push(inArray(w.positions.status, opts.status as any));
  return db.select({
    id: w.positions.id, code: w.positions.code, title: w.positions.title,
    orgLevel: w.positions.orgLevel, status: w.positions.status,
    headcount: w.positions.headcount, payBandCode: w.positions.payBandCode,
    departmentId: w.positions.departmentId,
    department: departments.name,
    reportsToPositionId: w.positions.reportsToPositionId,
  })
    .from(w.positions)
    .leftJoin(departments, eq(departments.id, w.positions.departmentId))
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(asc(w.positions.title))
    .limit(500);
}

// ─── Employment ─────────────────────────────────────────────────────────────

export interface HireInput {
  personId: number;
  positionId?: number | null;
  employmentType: string;
  startedOn?: string;
  managerPersonId?: number | null;
  workLocation?: string | null;
  weeklyHours?: number | null;
  payBandCode?: string | null;
  probationEndsOn?: string | null;
}

/**
 * Record an employment. The person must already exist in the register.
 *
 * NOTE the deliberate asymmetry with `acceptOffer()` below: that path CREATES a
 * person, because a successful external candidate genuinely is not in the
 * register yet. This one does not, because it is the path an HR officer uses for
 * somebody the federation already knows — a coach becoming an employee — and
 * silently creating a second `persons` row for them is the exact duplication
 * migration 0058 exists to prevent.
 */
export async function createEmployment(db: DB, ctx: AuditContext, input: HireInput) {
  assertCanAnywhere(ctx.principal, 'hr:write');

  const [person] = await db.select({ id: s.persons.id })
    .from(s.persons).where(eq(s.persons.id, input.personId)).limit(1);
  if (!person) {
    throw new WorkforceError(
      'no_such_person',
      `No person ${input.personId}. An employment attaches to somebody already in the federation register — create the person first, so there is one record of them and not two.`
    );
  }

  const [live] = await db.select({ id: w.employments.id })
    .from(w.employments)
    .where(and(eq(w.employments.personId, input.personId), ne(w.employments.status, 'ended')))
    .limit(1);
  if (live) {
    throw new WorkforceError(
      'already_employed',
      `That person already holds a live employment (#${live.id}). End it before recording another — two live employments double every leave balance and every headcount.`
    );
  }

  if (input.managerPersonId != null && input.managerPersonId === input.personId) {
    throw new WorkforceError('bad_input', 'Somebody cannot be their own line manager.');
  }
  if (input.positionId != null) {
    const [pos] = await db.select({ id: w.positions.id })
      .from(w.positions).where(eq(w.positions.id, input.positionId)).limit(1);
    if (!pos) throw new WorkforceError('no_such_position', `No position ${input.positionId}.`);
  }

  const startedOn = input.startedOn || todayIso();
  if (!isIsoDate(startedOn)) throw new WorkforceError('bad_period', 'A start date must be a calendar date.');

  const employeeNo = await allocateFederationId(db, 'EMP', Number(startedOn.slice(0, 4)));

  const [row] = await db.insert(w.employments).values({
    personId: input.personId,
    positionId: input.positionId ?? null,
    employeeNo,
    employmentType: input.employmentType as any,
    status: 'onboarding',
    managerPersonId: input.managerPersonId ?? null,
    startedOn,
    probationEndsOn: input.probationEndsOn ?? null,
    workLocation: input.workLocation?.trim() || null,
    weeklyHours: input.weeklyHours ?? null,
    payBandCode: input.payBandCode?.trim() || null,
  }).returning();

  await recordEmploymentEvent(db, ctx, {
    employmentId: row.id, kind: 'onboarded', effectiveOn: startedOn, before: null, after: row,
  });
  await writeAudit(db, ctx, { entityType: 'employment', entityId: row.id, action: 'create', newValue: row });
  await publish(db, {
    eventType: 'EMPLOYMENT_STARTED',
    entityType: 'employment', entityId: row.id,
    payload: { personId: row.personId, employeeNo: row.employeeNo, positionId: row.positionId },
    actor: { userId: ctx.principal.userId, label: ctx.principal.label },
  });
  return row;
}

export async function activateEmployment(db: DB, ctx: AuditContext, employmentId: number) {
  assertCanAnywhere(ctx.principal, 'hr:write');
  const before = await loadEmployment(db, employmentId);
  if (before.status === 'ended') throw new WorkforceError('already_ended', 'That employment has ended.');

  const [row] = await db.update(w.employments)
    .set({ status: 'active', updatedAt: new Date() })
    .where(eq(w.employments.id, employmentId)).returning();
  await recordEmploymentEvent(db, ctx, {
    employmentId, kind: before.status === 'suspended' ? 'reinstated' : 'confirmed',
    effectiveOn: todayIso(), before, after: row,
  });
  await writeAudit(db, ctx, {
    entityType: 'employment', entityId: employmentId,
    action: before.status === 'suspended' ? 'reinstate' : 'update',
    oldValue: { status: before.status }, newValue: { status: 'active' },
  });
  return row;
}

export async function changeManager(db: DB, ctx: AuditContext, employmentId: number, managerPersonId: number | null) {
  assertCanAnywhere(ctx.principal, 'hr:write');
  const before = await loadEmployment(db, employmentId);
  if (managerPersonId != null) {
    if (managerPersonId === before.personId) {
      throw new WorkforceError('bad_input', 'Somebody cannot be their own line manager.');
    }
    const [p] = await db.select({ id: s.persons.id }).from(s.persons).where(eq(s.persons.id, managerPersonId)).limit(1);
    if (!p) throw new WorkforceError('no_such_person', `No person ${managerPersonId}.`);
  }
  const [row] = await db.update(w.employments)
    .set({ managerPersonId, updatedAt: new Date() })
    .where(eq(w.employments.id, employmentId)).returning();
  await recordEmploymentEvent(db, ctx, {
    employmentId, kind: 'manager_changed', effectiveOn: todayIso(), before, after: row,
  });
  await writeAudit(db, ctx, {
    entityType: 'employment', entityId: employmentId, action: 'update',
    oldValue: { managerPersonId: before.managerPersonId }, newValue: { managerPersonId },
  });
  return row;
}

export async function suspendEmployment(db: DB, ctx: AuditContext, employmentId: number, reason: string) {
  assertCanAnywhere(ctx.principal, 'hr:write');
  const why = reason?.trim();
  if (!why) throw new WorkforceError('bad_input', 'A suspension needs a recorded reason.');
  const before = await loadEmployment(db, employmentId);
  if (before.status === 'ended') throw new WorkforceError('already_ended', 'That employment has ended.');

  const [row] = await db.update(w.employments)
    .set({ status: 'suspended', updatedAt: new Date() })
    .where(eq(w.employments.id, employmentId)).returning();
  await recordEmploymentEvent(db, ctx, {
    employmentId, kind: 'suspended', effectiveOn: todayIso(), before, after: row, reason: why,
  });
  await writeAudit(db, ctx, {
    entityType: 'employment', entityId: employmentId, action: 'suspend',
    oldValue: { status: before.status }, newValue: { status: 'suspended' },
  });
  return row;
}

/**
 * End an employment.
 *
 * ENDS ONE ROW. It does not touch `persons.status`, it does not revoke a rank,
 * it does not remove a `team_appointments` row and it does not disable the
 * person's login. A departing employee is very often still a member and still a
 * 4th Dan, and a function here that helpfully tidied up would destroy exactly
 * the information the one-canonical-person model exists to keep.
 *
 * Removing ACCESS is a `role_bindings` act under `role:grant`, and the admin
 * screen says so beside the control — an administrator who ends an employment
 * and believes they have revoked a login has been misled by the software.
 */
export async function endEmployment(
  db: DB, ctx: AuditContext, employmentId: number,
  opts: { endedOn?: string; exitReason: ExitReason; exitNote?: string | null }
) {
  assertCanAnywhere(ctx.principal, 'hr:write');
  if (!(EXIT_REASONS as readonly string[]).includes(opts.exitReason)) {
    throw new WorkforceError(
      'bad_input',
      `'${opts.exitReason}' is not a recorded exit reason. One of: ${EXIT_REASONS.join(', ')}. It is a controlled list because "how many people resigned last year" is a question free text cannot answer.`
    );
  }
  const before = await loadEmployment(db, employmentId);
  if (before.status === 'ended') throw new WorkforceError('already_ended', 'That employment has already ended.');

  const endedOn = opts.endedOn || todayIso();
  if (!isIsoDate(endedOn)) throw new WorkforceError('bad_period', 'An end date must be a calendar date.');
  if (endedOn < before.startedOn) {
    throw new WorkforceError('bad_period', `An employment cannot end (${endedOn}) before it started (${before.startedOn}).`);
  }

  const [row] = await db.update(w.employments)
    .set({ status: 'ended', endedOn, exitReason: opts.exitReason, exitNote: opts.exitNote?.trim() || null, updatedAt: new Date() })
    .where(eq(w.employments.id, employmentId)).returning();

  await recordEmploymentEvent(db, ctx, {
    employmentId, kind: 'ended', effectiveOn: endedOn, before, after: row, reason: opts.exitReason,
  });
  await writeAudit(db, ctx, {
    entityType: 'employment', entityId: employmentId, action: 'update',
    oldValue: { status: before.status }, newValue: { status: 'ended', endedOn, exitReason: opts.exitReason },
  });
  // The REASON is not on the feed. 'dismissed' is a fact about a named person
  // that must not be broadcast to every holder of the consuming clearance.
  await publish(db, {
    eventType: 'EMPLOYMENT_ENDED',
    entityType: 'employment', entityId: employmentId,
    payload: { personId: row.personId, endedOn },
    actor: { userId: ctx.principal.userId, label: ctx.principal.label },
  });
  return row;
}

/** The HR register. Gated on `hr:read` and on nothing weaker. */
export async function employmentRegister(
  db: DB, principal: Principal,
  opts: { status?: string[]; departmentId?: number; managerPersonId?: number; limit?: number } = {}
) {
  assertCanAnywhere(principal, 'hr:read');
  const clauses: any[] = [];
  if (opts.status?.length) clauses.push(inArray(w.employments.status, opts.status as any));
  if (opts.managerPersonId != null) clauses.push(eq(w.employments.managerPersonId, opts.managerPersonId));
  if (opts.departmentId != null) clauses.push(eq(w.positions.departmentId, opts.departmentId));

  return db.select({
    id: w.employments.id,
    employeeNo: w.employments.employeeNo,
    personId: w.employments.personId,
    fullName: s.persons.fullName,
    federationId: s.persons.federationId,
    status: w.employments.status,
    employmentType: w.employments.employmentType,
    startedOn: w.employments.startedOn,
    endedOn: w.employments.endedOn,
    exitReason: w.employments.exitReason,
    positionTitle: w.positions.title,
    departmentName: departments.name,
    managerPersonId: w.employments.managerPersonId,
    payBandCode: w.employments.payBandCode,
  })
    .from(w.employments)
    .innerJoin(s.persons, eq(s.persons.id, w.employments.personId))
    .leftJoin(w.positions, eq(w.positions.id, w.employments.positionId))
    .leftJoin(departments, eq(departments.id, w.positions.departmentId))
    .where(clauses.length ? and(...clauses) : undefined)
    .orderBy(asc(s.persons.fullName))
    .limit(opts.limit ?? 500);
}

/** The caller's own direct reports. Takes no id — resolved from the session. */
export async function myDirectReports(db: DB, principal: Principal) {
  const personId = await actorPerson(db, principal);
  if (!personId) return [];
  return db.select({
    id: w.employments.id,
    employeeNo: w.employments.employeeNo,
    personId: w.employments.personId,
    fullName: s.persons.fullName,
    status: w.employments.status,
    positionTitle: w.positions.title,
  })
    .from(w.employments)
    .innerJoin(s.persons, eq(s.persons.id, w.employments.personId))
    .leftJoin(w.positions, eq(w.positions.id, w.employments.positionId))
    .where(and(eq(w.employments.managerPersonId, personId), ne(w.employments.status, 'ended')))
    .orderBy(asc(s.persons.fullName));
}

export async function employmentHistory(db: DB, principal: Principal, employmentId: number) {
  const employment = await loadEmployment(db, employmentId);
  await assertCanReadEmployment(db, principal, employment);
  return db.select().from(w.employmentEvents)
    .where(eq(w.employmentEvents.employmentId, employmentId))
    .orderBy(desc(w.employmentEvents.id));
}

// ─── Leave ──────────────────────────────────────────────────────────────────

export async function createLeaveType(
  db: DB, ctx: AuditContext,
  input: { code: string; name: string; paid?: boolean; allowsNegative?: boolean; requiresHrApproval?: boolean; sortOrder?: number }
) {
  assertCanAnywhere(ctx.principal, 'hr:write');
  const code = input.code?.trim().toUpperCase();
  const name = input.name?.trim();
  if (!code || !name) throw new WorkforceError('bad_input', 'A leave type needs a code and a name.');
  const [row] = await db.insert(w.leaveTypes).values({
    code, name,
    paid: input.paid ?? true,
    allowsNegative: input.allowsNegative ?? false,
    requiresHrApproval: input.requiresHrApproval ?? false,
    sortOrder: input.sortOrder ?? 0,
  }).returning();
  await writeAudit(db, ctx, { entityType: 'leave_type', entityId: row.id, action: 'create', newValue: row });
  return row;
}

export async function listLeaveTypes(db: DB, opts: { includeInactive?: boolean } = {}) {
  return db.select().from(w.leaveTypes)
    .where(opts.includeInactive ? undefined : eq(w.leaveTypes.active, true))
    .orderBy(asc(w.leaveTypes.sortOrder), asc(w.leaveTypes.name));
}

export async function setEntitlement(
  db: DB, ctx: AuditContext,
  input: { employmentId: number; leaveTypeId: number; leaveYear: number; entitledHalfDays: number; carriedHalfDays?: number }
) {
  assertCanAnywhere(ctx.principal, 'hr:write');
  if (!Number.isInteger(input.entitledHalfDays) || input.entitledHalfDays < 0) {
    throw new WorkforceError('bad_input', 'An entitlement is a whole number of half-days, not negative.');
  }
  await loadEmployment(db, input.employmentId);

  const [row] = await db.insert(w.leaveEntitlements).values({
    employmentId: input.employmentId,
    leaveTypeId: input.leaveTypeId,
    leaveYear: input.leaveYear,
    entitledHalfDays: input.entitledHalfDays,
    carriedHalfDays: input.carriedHalfDays ?? 0,
  }).onConflictDoUpdate({
    target: [w.leaveEntitlements.employmentId, w.leaveEntitlements.leaveTypeId, w.leaveEntitlements.leaveYear],
    set: {
      entitledHalfDays: input.entitledHalfDays,
      carriedHalfDays: input.carriedHalfDays ?? 0,
      updatedAt: new Date(),
    },
  }).returning();

  await writeAudit(db, ctx, { entityType: 'leave_entitlement', entityId: row.id, action: 'update', newValue: row });
  return row;
}

/**
 * What is left, in half-days.
 *
 * TAKEN counts APPROVED requests only. A submitted-but-undecided request is
 * reported separately as `pending` rather than being netted off, because a
 * manager looking at a balance needs to know the difference between "she has
 * four days left" and "she has four days left and has asked for three of them".
 * Netting them into one number is how two managers approve the same three days.
 */
export async function leaveBalance(db: DB, employmentId: number, leaveTypeId: number, leaveYear: number) {
  const [ent] = await db.select().from(w.leaveEntitlements)
    .where(and(
      eq(w.leaveEntitlements.employmentId, employmentId),
      eq(w.leaveEntitlements.leaveTypeId, leaveTypeId),
      eq(w.leaveEntitlements.leaveYear, leaveYear)
    )).limit(1);

  const entitled = (ent?.entitledHalfDays ?? 0) + (ent?.carriedHalfDays ?? 0);

  const rows = await db.select({
    status: w.leaveRequests.status,
    halfDays: w.leaveRequests.halfDays,
  }).from(w.leaveRequests)
    .where(and(
      eq(w.leaveRequests.employmentId, employmentId),
      eq(w.leaveRequests.leaveTypeId, leaveTypeId),
      gte(w.leaveRequests.fromDate, `${leaveYear}-01-01`),
      lte(w.leaveRequests.fromDate, `${leaveYear}-12-31`)
    ));

  let taken = 0, pending = 0;
  for (const r of rows) {
    if (r.status === 'approved') taken += r.halfDays;
    else if (r.status === 'submitted') pending += r.halfDays;
  }
  return { entitled, taken, pending, remaining: entitled - taken, configured: Boolean(ent) };
}

/**
 * Ask for leave. SELF-SERVICE — the employment is resolved from the session and
 * is not a parameter, so there is no id to substitute.
 */
export async function requestLeave(
  db: DB, ctx: AuditContext,
  input: { leaveTypeId: number; fromDate: string; toDate: string; firstDayHalf?: boolean; lastDayHalf?: boolean; reason?: string | null }
) {
  const employment = await myEmployment(db, ctx.principal);
  if (!employment) {
    throw new WorkforceError('not_employed', 'This account is not linked to a live employment, so it cannot request leave.');
  }
  if (employment.status === 'ended') throw new WorkforceError('already_ended', 'That employment has ended.');

  if (!isIsoDate(input.fromDate) || !isIsoDate(input.toDate)) {
    throw new WorkforceError('bad_period', 'Leave dates must be calendar dates.');
  }
  if (input.toDate < input.fromDate) {
    throw new WorkforceError('bad_period', 'Leave cannot end before it starts.');
  }

  const [type] = await db.select().from(w.leaveTypes).where(eq(w.leaveTypes.id, input.leaveTypeId)).limit(1);
  if (!type) throw new WorkforceError('no_such_leave_type', 'No such leave type.');
  if (!type.active) throw new WorkforceError('bad_state', `${type.name} is no longer offered.`);

  const days = inclusiveDays(input.fromDate, input.toDate);
  if (days > 366) throw new WorkforceError('bad_period', 'A single leave request cannot span more than a year.');

  // COMPUTED HERE, never supplied by the client. A request that could name its
  // own duration is a request that can be half a day long and thirty days wide.
  let halfDays = days * 2;
  if (input.firstDayHalf) halfDays -= 1;
  if (input.lastDayHalf && input.toDate !== input.fromDate) halfDays -= 1;
  if (halfDays < 1) throw new WorkforceError('bad_period', 'That request works out at no time off at all.');

  // OVERLAP. Two live requests covering the same day is a person booked off
  // twice, and it is what makes a balance disagree with a calendar.
  const clash = await db.select({ id: w.leaveRequests.id, reference: w.leaveRequests.reference })
    .from(w.leaveRequests)
    .where(and(
      eq(w.leaveRequests.employmentId, employment.id),
      inArray(w.leaveRequests.status, ['submitted', 'approved']),
      lte(w.leaveRequests.fromDate, input.toDate),
      gte(w.leaveRequests.toDate, input.fromDate)
    )).limit(1);
  if (clash.length) {
    throw new WorkforceError('bad_period', `Those dates overlap leave you have already requested (${clash[0].reference}).`);
  }

  const year = Number(input.fromDate.slice(0, 4));
  const balance = await leaveBalance(db, employment.id, input.leaveTypeId, year);
  if (!type.allowsNegative && balance.configured && halfDays > balance.remaining - balance.pending) {
    throw new WorkforceError(
      'insufficient_balance',
      `That is ${halfDays / 2} days and you have ${(balance.remaining - balance.pending) / 2} left of ${type.name} for ${year}, counting requests already awaiting a decision.`
    );
  }

  const [row] = await db.insert(w.leaveRequests).values({
    employmentId: employment.id,
    leaveTypeId: input.leaveTypeId,
    reference: reference('LV'),
    fromDate: input.fromDate,
    toDate: input.toDate,
    halfDays,
    firstDayHalf: Boolean(input.firstDayHalf),
    lastDayHalf: Boolean(input.lastDayHalf),
    status: 'submitted',
    reason: input.reason?.trim() || null,
  }).returning();

  await writeAudit(db, ctx, { entityType: 'leave_request', entityId: row.id, action: 'create', newValue: row });
  await publish(db, {
    eventType: 'LEAVE_REQUESTED',
    entityType: 'leave_request', entityId: row.id,
    payload: { employmentId: employment.id, reference: row.reference, halfDays, fromDate: row.fromDate, toDate: row.toDate },
    actor: { userId: ctx.principal.userId, label: ctx.principal.label },
  });
  return row;
}

export async function decideLeave(
  db: DB, ctx: AuditContext,
  input: { requestId: number; decision: 'approved' | 'rejected'; note?: string | null }
) {
  const [req] = await db.select().from(w.leaveRequests).where(eq(w.leaveRequests.id, input.requestId)).limit(1);
  if (!req) throw new WorkforceError('no_such_request', `No leave request ${input.requestId}.`);
  if (req.status !== 'submitted') {
    throw new WorkforceError('bad_state', `That request is '${req.status}', not awaiting a decision.`);
  }
  const employment = await loadEmployment(db, req.employmentId);
  await assertCanDecideFor(db, ctx.principal, employment);

  if (input.decision === 'rejected' && !input.note?.trim()) {
    throw new WorkforceError('bad_input', 'Refusing leave needs a recorded reason — the person is entitled to know why.');
  }

  const [row] = await db.update(w.leaveRequests).set({
    status: input.decision,
    decidedByUserId: ctx.principal.userId ?? null,
    decidedAt: new Date(),
    decisionNote: input.note?.trim() || null,
    updatedAt: new Date(),
  }).where(eq(w.leaveRequests.id, input.requestId)).returning();

  await writeAudit(db, ctx, {
    entityType: 'leave_request', entityId: input.requestId,
    action: input.decision === 'approved' ? 'approve' : 'reject',
    oldValue: { status: 'submitted' }, newValue: { status: input.decision },
  });
  await publish(db, {
    eventType: 'LEAVE_DECIDED',
    entityType: 'leave_request', entityId: input.requestId,
    payload: { employmentId: employment.id, reference: row.reference, decision: input.decision },
    actor: { userId: ctx.principal.userId, label: ctx.principal.label },
  });
  return row;
}

/** Withdraw your own request. Self-service; refuses somebody else's. */
export async function withdrawLeave(db: DB, ctx: AuditContext, requestId: number) {
  const employment = await myEmployment(db, ctx.principal);
  if (!employment) throw new WorkforceError('not_employed', 'This account is not linked to a live employment.');
  const [req] = await db.select().from(w.leaveRequests).where(eq(w.leaveRequests.id, requestId)).limit(1);
  if (!req) throw new WorkforceError('no_such_request', `No leave request ${requestId}.`);
  // Ownership re-derived from the SESSION, never trusted from the id.
  if (req.employmentId !== employment.id) throw new ForbiddenError('hr:write');
  if (!['submitted', 'approved'].includes(req.status)) {
    throw new WorkforceError('bad_state', `A '${req.status}' request cannot be withdrawn.`);
  }
  const [row] = await db.update(w.leaveRequests)
    .set({ status: 'withdrawn', updatedAt: new Date() })
    .where(eq(w.leaveRequests.id, requestId)).returning();
  await writeAudit(db, ctx, {
    entityType: 'leave_request', entityId: requestId, action: 'update',
    oldValue: { status: req.status }, newValue: { status: 'withdrawn' },
  });
  return row;
}

export async function myLeave(db: DB, principal: Principal, opts: { limit?: number } = {}) {
  const employment = await myEmployment(db, principal);
  if (!employment) return [];
  return db.select({
    id: w.leaveRequests.id,
    reference: w.leaveRequests.reference,
    fromDate: w.leaveRequests.fromDate,
    toDate: w.leaveRequests.toDate,
    halfDays: w.leaveRequests.halfDays,
    status: w.leaveRequests.status,
    reason: w.leaveRequests.reason,
    decisionNote: w.leaveRequests.decisionNote,
    typeName: w.leaveTypes.name,
  })
    .from(w.leaveRequests)
    .innerJoin(w.leaveTypes, eq(w.leaveTypes.id, w.leaveRequests.leaveTypeId))
    .where(eq(w.leaveRequests.employmentId, employment.id))
    .orderBy(desc(w.leaveRequests.fromDate))
    .limit(opts.limit ?? 100);
}

/** Requests awaiting THIS caller's decision. Manager's queue, or HR's. */
export async function leaveQueue(db: DB, principal: Principal, opts: { limit?: number } = {}) {
  const personId = await actorPerson(db, principal);
  const isHr = canAnywhere(principal, 'hr:read');
  if (!personId && !isHr) return [];

  const clauses: any[] = [eq(w.leaveRequests.status, 'submitted')];
  if (!isHr) clauses.push(eq(w.employments.managerPersonId, personId!));
  // A manager never sees their own request in their own queue — rule 3 would
  // refuse the decision anyway, and offering the control first is a worse
  // experience than not offering it.
  if (personId) clauses.push(ne(w.employments.personId, personId));

  return db.select({
    id: w.leaveRequests.id,
    reference: w.leaveRequests.reference,
    fromDate: w.leaveRequests.fromDate,
    toDate: w.leaveRequests.toDate,
    halfDays: w.leaveRequests.halfDays,
    reason: w.leaveRequests.reason,
    typeName: w.leaveTypes.name,
    employmentId: w.employments.id,
    personName: s.persons.fullName,
  })
    .from(w.leaveRequests)
    .innerJoin(w.employments, eq(w.employments.id, w.leaveRequests.employmentId))
    .innerJoin(s.persons, eq(s.persons.id, w.employments.personId))
    .innerJoin(w.leaveTypes, eq(w.leaveTypes.id, w.leaveRequests.leaveTypeId))
    .where(and(...clauses))
    .orderBy(asc(w.leaveRequests.fromDate))
    .limit(opts.limit ?? 200);
}

// ─── Time ───────────────────────────────────────────────────────────────────

export async function recordWork(
  db: DB, ctx: AuditContext,
  input: { workDate: string; minutes: number; note?: string | null }
) {
  const employment = await myEmployment(db, ctx.principal);
  if (!employment) throw new WorkforceError('not_employed', 'This account is not linked to a live employment.');
  if (!isIsoDate(input.workDate)) throw new WorkforceError('bad_period', 'A work date must be a calendar date.');
  if (!Number.isInteger(input.minutes) || input.minutes <= 0 || input.minutes > 1440) {
    throw new WorkforceError('bad_input', 'Recorded time must be between 1 and 1440 minutes.');
  }
  // A timesheet for next month is a typo, not a plan.
  if (input.workDate > addDaysIso(todayIso(), 1)) {
    throw new WorkforceError('bad_period', 'Time cannot be recorded for a future date.');
  }

  const [row] = await db.insert(w.workRecords).values({
    employmentId: employment.id,
    workDate: input.workDate,
    minutes: input.minutes,
    status: 'submitted',
    note: input.note?.trim() || null,
  }).onConflictDoUpdate({
    target: [w.workRecords.employmentId, w.workRecords.workDate],
    // A correction is allowed only while the day is still undecided. An approved
    // day is an input to payroll and must not move underneath it.
    set: { minutes: input.minutes, note: input.note?.trim() || null, status: 'submitted', updatedAt: new Date() },
    where: ne(w.workRecords.status, 'approved'),
  }).returning();

  if (!row) {
    throw new WorkforceError('bad_state', 'That day has already been approved and cannot be changed. Ask your manager to reopen it.');
  }
  return row;
}

export async function approveWork(db: DB, ctx: AuditContext, workRecordId: number, decision: 'approved' | 'rejected') {
  const [rec] = await db.select().from(w.workRecords).where(eq(w.workRecords.id, workRecordId)).limit(1);
  if (!rec) throw new WorkforceError('bad_input', `No work record ${workRecordId}.`);
  const employment = await loadEmployment(db, rec.employmentId);
  await assertCanDecideFor(db, ctx.principal, employment);

  const [row] = await db.update(w.workRecords).set({
    status: decision,
    approvedByUserId: ctx.principal.userId ?? null,
    approvedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(w.workRecords.id, workRecordId)).returning();
  await writeAudit(db, ctx, {
    entityType: 'work_record', entityId: workRecordId,
    action: decision === 'approved' ? 'approve' : 'reject',
    oldValue: { status: rec.status }, newValue: { status: decision },
  });
  return row;
}

export async function myWork(db: DB, principal: Principal, opts: { fromDate?: string; toDate?: string } = {}) {
  const employment = await myEmployment(db, principal);
  if (!employment) return [];
  const clauses: any[] = [eq(w.workRecords.employmentId, employment.id)];
  if (opts.fromDate) clauses.push(gte(w.workRecords.workDate, opts.fromDate));
  if (opts.toDate) clauses.push(lte(w.workRecords.workDate, opts.toDate));
  return db.select().from(w.workRecords).where(and(...clauses))
    .orderBy(desc(w.workRecords.workDate)).limit(200);
}

// ─── Expenses ───────────────────────────────────────────────────────────────

export async function createClaim(db: DB, ctx: AuditContext, input: { title: string }) {
  const employment = await myEmployment(db, ctx.principal);
  if (!employment) throw new WorkforceError('not_employed', 'This account is not linked to a live employment.');
  const title = input.title?.trim();
  if (!title) throw new WorkforceError('bad_input', 'A claim needs a title.');
  const [row] = await db.insert(w.expenseClaims).values({
    employmentId: employment.id,
    reference: reference('EXP'),
    title,
    status: 'draft',
  }).returning();
  return row;
}

/** Add a line and re-total the claim from its lines — never from a client sum. */
export async function addClaimLine(
  db: DB, ctx: AuditContext,
  input: { claimId: number; spentOn: string; category: string; description: string; amountMinor: number; receiptRef?: string | null }
) {
  const employment = await myEmployment(db, ctx.principal);
  if (!employment) throw new WorkforceError('not_employed', 'This account is not linked to a live employment.');
  const [claim] = await db.select().from(w.expenseClaims).where(eq(w.expenseClaims.id, input.claimId)).limit(1);
  if (!claim) throw new WorkforceError('no_such_claim', `No claim ${input.claimId}.`);
  if (claim.employmentId !== employment.id) throw new ForbiddenError('hr:write');
  if (claim.status !== 'draft') throw new WorkforceError('bad_state', 'Only a draft claim can be changed.');

  if (!(EXPENSE_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new WorkforceError('bad_input', `Category must be one of: ${EXPENSE_CATEGORIES.join(', ')}.`);
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new WorkforceError('bad_amount', 'An amount is a whole number of paise, greater than zero.');
  }
  if (!isIsoDate(input.spentOn)) throw new WorkforceError('bad_period', 'A spend date must be a calendar date.');
  if (input.spentOn > todayIso()) throw new WorkforceError('bad_period', 'An expense cannot be dated in the future.');

  await db.insert(w.expenseClaimLines).values({
    claimId: input.claimId,
    spentOn: input.spentOn,
    category: input.category,
    description: input.description?.trim() || 'Expense',
    amountMinor: input.amountMinor,
    receiptRef: input.receiptRef?.trim() || null,
  });

  // RE-TOTALLED FROM THE LINES. The client never sends a total, so a claim whose
  // total disagrees with its own lines is not a state this code can reach.
  const [{ total }] = await db.select({ total: sql`coalesce(sum(${w.expenseClaimLines.amountMinor}), 0)::int` })
    .from(w.expenseClaimLines).where(eq(w.expenseClaimLines.claimId, input.claimId));

  const [row] = await db.update(w.expenseClaims)
    .set({ totalMinor: Number(total), updatedAt: new Date() })
    .where(eq(w.expenseClaims.id, input.claimId)).returning();
  return row;
}

export async function submitClaim(db: DB, ctx: AuditContext, claimId: number) {
  const employment = await myEmployment(db, ctx.principal);
  if (!employment) throw new WorkforceError('not_employed', 'This account is not linked to a live employment.');
  const [claim] = await db.select().from(w.expenseClaims).where(eq(w.expenseClaims.id, claimId)).limit(1);
  if (!claim) throw new WorkforceError('no_such_claim', `No claim ${claimId}.`);
  if (claim.employmentId !== employment.id) throw new ForbiddenError('hr:write');
  if (claim.status !== 'draft') throw new WorkforceError('bad_state', `That claim is already '${claim.status}'.`);
  if (claim.totalMinor <= 0) throw new WorkforceError('bad_amount', 'A claim with no lines cannot be submitted.');

  const [row] = await db.update(w.expenseClaims)
    .set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() })
    .where(eq(w.expenseClaims.id, claimId)).returning();
  await writeAudit(db, ctx, { entityType: 'expense_claim', entityId: claimId, action: 'update', newValue: { status: 'submitted', totalMinor: row.totalMinor } });
  await publish(db, {
    eventType: 'EXPENSE_CLAIM_SUBMITTED',
    entityType: 'expense_claim', entityId: claimId,
    payload: { employmentId: employment.id, reference: row.reference, totalMinor: row.totalMinor },
    actor: { userId: ctx.principal.userId, label: ctx.principal.label },
  });
  return row;
}

export async function decideClaim(
  db: DB, ctx: AuditContext,
  input: { claimId: number; decision: 'approved' | 'rejected'; note?: string | null }
) {
  const [claim] = await db.select().from(w.expenseClaims).where(eq(w.expenseClaims.id, input.claimId)).limit(1);
  if (!claim) throw new WorkforceError('no_such_claim', `No claim ${input.claimId}.`);
  if (claim.status !== 'submitted') throw new WorkforceError('bad_state', `That claim is '${claim.status}', not awaiting a decision.`);
  const employment = await loadEmployment(db, claim.employmentId);
  await assertCanDecideFor(db, ctx.principal, employment);

  if (input.decision === 'rejected' && !input.note?.trim()) {
    throw new WorkforceError('bad_input', 'Refusing a claim needs a recorded reason.');
  }

  const [row] = await db.update(w.expenseClaims).set({
    status: input.decision,
    decidedByUserId: ctx.principal.userId ?? null,
    decidedAt: new Date(),
    decisionNote: input.note?.trim() || null,
    updatedAt: new Date(),
  }).where(eq(w.expenseClaims.id, input.claimId)).returning();
  await writeAudit(db, ctx, {
    entityType: 'expense_claim', entityId: input.claimId,
    action: input.decision === 'approved' ? 'approve' : 'reject',
    oldValue: { status: 'submitted' }, newValue: { status: input.decision },
  });
  return row;
}

/**
 * Finance records that an approved claim has been paid.
 *
 * NOT a payment integration, and deliberately so: the federation pays an
 * employee expense through its own banking, and inventing a gateway path for it
 * would be the fake automation §35 forbids. This records a fact somebody in
 * finance knows.
 */
export async function markClaimPaid(db: DB, ctx: AuditContext, claimId: number, paidOn?: string) {
  assertCanAnywhere(ctx.principal, 'finance:write');
  const [claim] = await db.select().from(w.expenseClaims).where(eq(w.expenseClaims.id, claimId)).limit(1);
  if (!claim) throw new WorkforceError('no_such_claim', `No claim ${claimId}.`);
  if (claim.status !== 'approved') {
    throw new WorkforceError('bad_state', `Only an approved claim can be marked paid; this one is '${claim.status}'.`);
  }
  const [row] = await db.update(w.expenseClaims)
    .set({ status: 'paid', paidOn: paidOn || todayIso(), updatedAt: new Date() })
    .where(eq(w.expenseClaims.id, claimId)).returning();
  await writeAudit(db, ctx, { entityType: 'expense_claim', entityId: claimId, action: 'update', oldValue: { status: 'approved' }, newValue: { status: 'paid' } });
  return row;
}

export async function myClaims(db: DB, principal: Principal) {
  const employment = await myEmployment(db, principal);
  if (!employment) return [];
  return db.select().from(w.expenseClaims)
    .where(eq(w.expenseClaims.employmentId, employment.id))
    .orderBy(desc(w.expenseClaims.id)).limit(100);
}

export async function claimQueue(db: DB, principal: Principal) {
  const personId = await actorPerson(db, principal);
  const isHr = canAnywhere(principal, 'hr:read');
  if (!personId && !isHr) return [];
  const clauses: any[] = [eq(w.expenseClaims.status, 'submitted')];
  if (!isHr) clauses.push(eq(w.employments.managerPersonId, personId!));
  if (personId) clauses.push(ne(w.employments.personId, personId));

  return db.select({
    id: w.expenseClaims.id,
    reference: w.expenseClaims.reference,
    title: w.expenseClaims.title,
    totalMinor: w.expenseClaims.totalMinor,
    submittedAt: w.expenseClaims.submittedAt,
    personName: s.persons.fullName,
  })
    .from(w.expenseClaims)
    .innerJoin(w.employments, eq(w.employments.id, w.expenseClaims.employmentId))
    .innerJoin(s.persons, eq(s.persons.id, w.employments.personId))
    .where(and(...clauses))
    .orderBy(asc(w.expenseClaims.submittedAt)).limit(200);
}

// ─── Recruitment ────────────────────────────────────────────────────────────

export async function createVacancy(
  db: DB, ctx: AuditContext,
  input: {
    title: string; employmentType: string; positionId?: number | null;
    departmentId?: number | null; slug?: string | null; summary?: string | null;
    description?: string | null; requirements?: string | null; location?: string | null;
    openings?: number; opensOn?: string | null; closesOn?: string | null;
  }
) {
  assertCanAnywhere(ctx.principal, 'hiring:write');
  const title = input.title?.trim();
  if (!title) throw new WorkforceError('bad_input', 'A vacancy needs a title.');
  const openings = input.openings ?? 1;
  if (!Number.isInteger(openings) || openings < 1) throw new WorkforceError('bad_input', 'Openings must be at least one.');
  if (input.opensOn && input.closesOn && input.closesOn < input.opensOn) {
    throw new WorkforceError('bad_period', 'A vacancy cannot close before it opens.');
  }

  const [row] = await db.insert(w.vacancies).values({
    positionId: input.positionId ?? null,
    reference: reference('VAC'),
    title,
    departmentId: input.departmentId ?? null,
    slug: input.slug?.trim().toLowerCase() || null,
    summary: input.summary?.trim() || null,
    description: input.description?.trim() || null,
    requirements: input.requirements?.trim() || null,
    employmentType: input.employmentType as any,
    location: input.location?.trim() || null,
    openings,
    opensOn: input.opensOn ?? null,
    closesOn: input.closesOn ?? null,
    status: 'draft',
    published: false,
  }).returning();

  await writeAudit(db, ctx, { entityType: 'vacancy', entityId: row.id, action: 'create', newValue: row });
  return row;
}

export async function openVacancy(db: DB, ctx: AuditContext, vacancyId: number) {
  assertCanAnywhere(ctx.principal, 'hiring:write');
  const [v] = await db.select().from(w.vacancies).where(eq(w.vacancies.id, vacancyId)).limit(1);
  if (!v) throw new WorkforceError('no_such_vacancy', `No vacancy ${vacancyId}.`);
  const [row] = await db.update(w.vacancies).set({ status: 'open', updatedAt: new Date() })
    .where(eq(w.vacancies.id, vacancyId)).returning();
  await writeAudit(db, ctx, { entityType: 'vacancy', entityId: vacancyId, action: 'update', oldValue: { status: v.status }, newValue: { status: 'open' } });
  return row;
}

/**
 * Advertise a vacancy on the public careers page.
 *
 * `hiring:decide`, not `hiring:write` — the same separation as
 * `team:publish`: drafting a vacancy and putting the federation's name to a
 * public offer of employment are different acts. The CHECK in 0058 refuses to
 * publish anything not `open`, so a draft or a withdrawn vacancy cannot reach
 * the careers page even by a direct UPDATE.
 */
export async function publishVacancy(db: DB, ctx: AuditContext, vacancyId: number) {
  assertCanAnywhere(ctx.principal, 'hiring:decide');
  const [v] = await db.select().from(w.vacancies).where(eq(w.vacancies.id, vacancyId)).limit(1);
  if (!v) throw new WorkforceError('no_such_vacancy', `No vacancy ${vacancyId}.`);
  if (v.status !== 'open') {
    throw new WorkforceError('bad_state', `A vacancy must be open before it is advertised; this one is '${v.status}'. Advertising a draft invites applications nobody will read.`);
  }
  if (!v.slug) {
    throw new WorkforceError('bad_input', 'A published vacancy needs a slug — it is the address candidates will share, and one guessed from the title moves when the title is corrected.');
  }
  const [row] = await db.update(w.vacancies)
    .set({ published: true, publishedAt: new Date(), updatedAt: new Date() })
    .where(eq(w.vacancies.id, vacancyId)).returning();
  await writeAudit(db, ctx, { entityType: 'vacancy', entityId: vacancyId, action: 'approve', newValue: { published: true } });
  await publish(db, {
    eventType: 'VACANCY_PUBLISHED',
    entityType: 'vacancy', entityId: vacancyId,
    payload: { reference: row.reference, title: row.title },
    actor: { userId: ctx.principal.userId, label: ctx.principal.label },
  });
  return row;
}

export async function unpublishVacancy(db: DB, ctx: AuditContext, vacancyId: number) {
  assertCanAnywhere(ctx.principal, 'hiring:decide');
  const [row] = await db.update(w.vacancies)
    .set({ published: false, updatedAt: new Date() })
    .where(eq(w.vacancies.id, vacancyId)).returning();
  if (!row) throw new WorkforceError('no_such_vacancy', `No vacancy ${vacancyId}.`);
  await writeAudit(db, ctx, { entityType: 'vacancy', entityId: vacancyId, action: 'update', newValue: { published: false } });
  return row;
}

const PUBLIC_VACANCY_COLUMNS = {
  reference: w.vacancies.reference,
  title: w.vacancies.title,
  slug: w.vacancies.slug,
  summary: w.vacancies.summary,
  description: w.vacancies.description,
  requirements: w.vacancies.requirements,
  employmentType: w.vacancies.employmentType,
  location: w.vacancies.location,
  openings: w.vacancies.openings,
  closesOn: w.vacancies.closesOn,
  departmentName: departments.name,
};

/**
 * THE PUBLIC CAREERS LIST. Takes no principal, accepts no widening parameter.
 *
 * Note what the column list omits: no internal `id`, no `positionId`, no pay
 * band. A candidate needs the advert, not the establishment record behind it.
 */
export async function publicVacancies(db: DB) {
  return db.select(PUBLIC_VACANCY_COLUMNS)
    .from(w.vacancies)
    .leftJoin(departments, eq(departments.id, w.vacancies.departmentId))
    .where(and(eq(w.vacancies.published, true), eq(w.vacancies.status, 'open')))
    .orderBy(asc(w.vacancies.title))
    .limit(200);
}

export async function publicVacancy(db: DB, slug: string) {
  const [row] = await db.select(PUBLIC_VACANCY_COLUMNS)
    .from(w.vacancies)
    .leftJoin(departments, eq(departments.id, w.vacancies.departmentId))
    .where(and(
      eq(w.vacancies.slug, String(slug || '').toLowerCase()),
      eq(w.vacancies.published, true),
      eq(w.vacancies.status, 'open')
    ))
    .limit(1);
  return row ?? null;
}

/**
 * APPLY. Takes no principal — a candidate has no login, and requiring one would
 * mean nobody outside the federation could ever apply.
 *
 * The vacancy is RE-READ and re-checked here, so a stale form posted after the
 * vacancy closed is refused with a sentence rather than silently accepted into
 * a queue nobody is reading.
 */
export async function applyForVacancy(
  db: DB,
  input: {
    slug: string; applicantName: string; applicantEmail: string;
    applicantPhone?: string | null; coverNote?: string | null;
    cvRef?: string | null; currentEmployer?: string | null; yearsExperience?: number | null;
  }
) {
  const name = input.applicantName?.trim();
  const email = input.applicantEmail?.trim().toLowerCase();
  if (!name) throw new WorkforceError('bad_input', 'Please give your name.');
  if (!email || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    throw new WorkforceError('bad_input', 'Please give an email address we can reply to.');
  }
  if (input.yearsExperience != null && (!Number.isInteger(input.yearsExperience) || input.yearsExperience < 0 || input.yearsExperience > 80)) {
    throw new WorkforceError('bad_input', 'Years of experience must be a whole number.');
  }

  const [vacancy] = await db.select({ id: w.vacancies.id, status: w.vacancies.status, published: w.vacancies.published, closesOn: w.vacancies.closesOn, title: w.vacancies.title })
    .from(w.vacancies)
    .where(eq(w.vacancies.slug, String(input.slug || '').toLowerCase()))
    .limit(1);
  if (!vacancy) throw new WorkforceError('no_such_vacancy', 'No such vacancy.');
  if (!vacancy.published || vacancy.status !== 'open') {
    throw new WorkforceError('vacancy_not_open', 'That vacancy is no longer open for applications.');
  }
  if (vacancy.closesOn && vacancy.closesOn < todayIso()) {
    throw new WorkforceError('vacancy_not_open', `Applications for that post closed on ${vacancy.closesOn}.`);
  }

  // ONE APPLICATION PER EMAIL PER VACANCY. Checked here for the message, and
  // enforced by a unique index on (vacancy_id, lower(email)) so a double-submit
  // race cannot slip a second row past this read.
  const [existing] = await db.select({ reference: w.jobApplications.reference })
    .from(w.jobApplications)
    .where(and(eq(w.jobApplications.vacancyId, vacancy.id), sql`lower(${w.jobApplications.applicantEmail}) = ${email}`))
    .limit(1);
  if (existing) {
    throw new WorkforceError(
      'duplicate_application',
      `You have already applied for this post. Your reference is ${existing.reference}.`
    );
  }

  let row: any;
  try {
    [row] = await db.insert(w.jobApplications).values({
      vacancyId: vacancy.id,
      reference: reference('JOB'),
      applicantName: name,
      applicantEmail: email,
      applicantPhone: input.applicantPhone?.trim() || null,
      coverNote: input.coverNote?.trim() || null,
      cvRef: input.cvRef?.trim() || null,
      currentEmployer: input.currentEmployer?.trim() || null,
      yearsExperience: input.yearsExperience ?? null,
      status: 'received',
    }).returning();
  } catch (err: any) {
    // The unique index fired: two submissions raced past the read above.
    if (String(err?.code) === '23505') {
      const [dup] = await db.select({ reference: w.jobApplications.reference })
        .from(w.jobApplications)
        .where(and(eq(w.jobApplications.vacancyId, vacancy.id), sql`lower(${w.jobApplications.applicantEmail}) = ${email}`))
        .limit(1);
      throw new WorkforceError('duplicate_application', `You have already applied for this post.${dup ? ` Your reference is ${dup.reference}.` : ''}`);
    }
    throw err;
  }

  await db.insert(w.jobApplicationEvents).values({
    applicationId: row.id, kind: 'received', actorLabel: 'applicant',
  });
  await publish(db, {
    eventType: 'JOB_APPLICATION_RECEIVED',
    entityType: 'job_application', entityId: row.id,
    payload: { vacancyId: vacancy.id, reference: row.reference },
  });

  // The REFERENCE is what the candidate is given, never the internal id.
  return { reference: row.reference, vacancyTitle: vacancy.title };
}

export async function moveApplication(
  db: DB, ctx: AuditContext,
  input: { applicationId: number; status: string; note?: string | null }
) {
  assertCanAnywhere(ctx.principal, 'hiring:write');
  const [app] = await db.select().from(w.jobApplications).where(eq(w.jobApplications.id, input.applicationId)).limit(1);
  if (!app) throw new WorkforceError('no_such_application', `No application ${input.applicationId}.`);

  if (input.status === 'rejected' && !input.note?.trim()) {
    throw new WorkforceError('bad_input', 'Rejecting a candidate needs a recorded reason. It is what makes the decision reviewable, and what a candidate who asks is entitled to.');
  }
  // 'accepted' is reached only through acceptOffer(), which creates the person
  // and the employment. Letting it be set by hand would leave an "accepted"
  // candidate nobody employed.
  if (input.status === 'accepted') {
    throw new WorkforceError('bad_state', 'An application becomes accepted when the candidate accepts an offer, not by being marked so. Issue an offer instead.');
  }

  const [row] = await db.update(w.jobApplications).set({
    status: input.status as any,
    rejectedReason: input.status === 'rejected' ? input.note!.trim() : app.rejectedReason,
    updatedAt: new Date(),
  }).where(eq(w.jobApplications.id, input.applicationId)).returning();

  await db.insert(w.jobApplicationEvents).values({
    applicationId: input.applicationId,
    kind: input.status,
    note: input.note?.trim() || null,
    actorUserId: ctx.principal.userId ?? null,
    actorLabel: ctx.principal.label,
  });
  await writeAudit(db, ctx, {
    entityType: 'job_application', entityId: input.applicationId, action: 'update',
    oldValue: { status: app.status }, newValue: { status: input.status },
  });
  return row;
}

export async function applicationsFor(db: DB, principal: Principal, vacancyId: number) {
  assertCanAnywhere(principal, 'hiring:read');
  return db.select({
    id: w.jobApplications.id,
    reference: w.jobApplications.reference,
    applicantName: w.jobApplications.applicantName,
    applicantEmail: w.jobApplications.applicantEmail,
    yearsExperience: w.jobApplications.yearsExperience,
    currentEmployer: w.jobApplications.currentEmployer,
    status: w.jobApplications.status,
    createdAt: w.jobApplications.createdAt,
  })
    .from(w.jobApplications)
    .where(eq(w.jobApplications.vacancyId, vacancyId))
    .orderBy(desc(w.jobApplications.id))
    .limit(500);
}

export async function scheduleInterview(
  db: DB, ctx: AuditContext,
  input: { applicationId: number; round?: number; scheduledAt?: Date; durationMinutes?: number; mode?: string; location?: string; panellistPersonIds?: number[] }
) {
  assertCanAnywhere(ctx.principal, 'hiring:write');
  const [app] = await db.select({ id: w.jobApplications.id }).from(w.jobApplications).where(eq(w.jobApplications.id, input.applicationId)).limit(1);
  if (!app) throw new WorkforceError('no_such_application', `No application ${input.applicationId}.`);

  const [row] = await db.insert(w.interviews).values({
    applicationId: input.applicationId,
    round: input.round ?? 1,
    scheduledAt: input.scheduledAt ?? null,
    durationMinutes: input.durationMinutes ?? null,
    mode: input.mode ?? null,
    location: input.location ?? null,
    status: 'scheduled',
  }).returning();

  for (const personId of input.panellistPersonIds ?? []) {
    await db.insert(w.interviewPanellists).values({ interviewId: row.id, personId }).onConflictDoNothing();
  }
  await db.insert(w.jobApplicationEvents).values({
    applicationId: input.applicationId, kind: 'interview_scheduled',
    actorUserId: ctx.principal.userId ?? null, actorLabel: ctx.principal.label,
  });
  await writeAudit(db, ctx, { entityType: 'interview', entityId: row.id, action: 'create', newValue: row });
  return row;
}

/**
 * A panellist records their own opinion.
 *
 * TWO REFUSALS THAT ARE THE POINT OF THE FUNCTION:
 *
 *   · Only somebody ON the panel may write feedback. `hiring:write` is not
 *     enough — the authority to arrange an interview is not the authority to
 *     put an opinion into it under somebody else's name.
 *   · Only ONCE. A panel whose members revise their scores after reading each
 *     other's is a panel with one opinion, and the point of a panel is that it
 *     has several.
 */
export async function recordInterviewFeedback(
  db: DB, ctx: AuditContext,
  input: { interviewId: number; score?: number | null; recommendation: string; notes?: string | null }
) {
  const personId = await actorPerson(db, ctx.principal);
  if (!personId) {
    throw new WorkforceError('unattributable', 'Interview feedback has to be attributable to a named panellist. This account is not linked to a person.');
  }
  if (!(RECOMMENDATIONS as readonly string[]).includes(input.recommendation)) {
    throw new WorkforceError('bad_input', `A recommendation must be one of: ${RECOMMENDATIONS.join(', ')}.`);
  }
  if (input.score != null && (!Number.isInteger(input.score) || input.score < 1 || input.score > 5)) {
    throw new WorkforceError('bad_input', 'A score is a whole number from 1 to 5.');
  }

  const [seat] = await db.select({ id: w.interviewPanellists.id })
    .from(w.interviewPanellists)
    .where(and(eq(w.interviewPanellists.interviewId, input.interviewId), eq(w.interviewPanellists.personId, personId)))
    .limit(1);
  if (!seat) {
    throw new WorkforceError('not_a_panellist', 'Only a member of this interview panel may record feedback on it.');
  }

  const [already] = await db.select({ id: w.interviewFeedback.id })
    .from(w.interviewFeedback)
    .where(and(eq(w.interviewFeedback.interviewId, input.interviewId), eq(w.interviewFeedback.panellistPersonId, personId)))
    .limit(1);
  if (already) {
    throw new WorkforceError('already_given_feedback', 'You have already recorded your view of this interview. It is deliberately not editable — a panel that revises itself after reading the others has one opinion, not several.');
  }

  const [row] = await db.insert(w.interviewFeedback).values({
    interviewId: input.interviewId,
    panellistPersonId: personId,
    score: input.score ?? null,
    recommendation: input.recommendation,
    notes: input.notes?.trim() || null,
  }).returning();
  return row;
}

/**
 * The panel's views.
 *
 * Readable by `hiring:read`. Deliberately NOT readable by the candidate through
 * any path in this module — there is no function that returns feedback keyed by
 * an application reference.
 */
export async function interviewFeedbackFor(db: DB, principal: Principal, interviewId: number) {
  assertCanAnywhere(principal, 'hiring:read');
  return db.select({
    score: w.interviewFeedback.score,
    recommendation: w.interviewFeedback.recommendation,
    notes: w.interviewFeedback.notes,
    panellist: s.persons.fullName,
    createdAt: w.interviewFeedback.createdAt,
  })
    .from(w.interviewFeedback)
    .innerJoin(s.persons, eq(s.persons.id, w.interviewFeedback.panellistPersonId))
    .where(eq(w.interviewFeedback.interviewId, interviewId))
    .orderBy(asc(w.interviewFeedback.id));
}

export async function makeOffer(
  db: DB, ctx: AuditContext,
  input: { applicationId: number; positionId?: number | null; employmentType: string; payBandCode?: string | null; proposedStartOn: string; expiresOn?: string | null; note?: string | null }
) {
  assertCanAnywhere(ctx.principal, 'hiring:decide');
  const [app] = await db.select().from(w.jobApplications).where(eq(w.jobApplications.id, input.applicationId)).limit(1);
  if (!app) throw new WorkforceError('no_such_application', `No application ${input.applicationId}.`);
  if (['rejected', 'withdrawn', 'declined', 'accepted'].includes(app.status)) {
    throw new WorkforceError('bad_state', `That application is '${app.status}' and cannot be offered.`);
  }
  if (!isIsoDate(input.proposedStartOn)) throw new WorkforceError('bad_period', 'A start date must be a calendar date.');

  const [row] = await db.insert(w.jobOffers).values({
    applicationId: input.applicationId,
    positionId: input.positionId ?? null,
    reference: reference('OFR'),
    employmentType: input.employmentType as any,
    payBandCode: input.payBandCode?.trim() || null,
    proposedStartOn: input.proposedStartOn,
    expiresOn: input.expiresOn ?? null,
    note: input.note?.trim() || null,
    status: 'issued',
    issuedAt: new Date(),
  }).returning();

  await db.update(w.jobApplications).set({ status: 'offered', updatedAt: new Date() })
    .where(eq(w.jobApplications.id, input.applicationId));
  await db.insert(w.jobApplicationEvents).values({
    applicationId: input.applicationId, kind: 'offered',
    actorUserId: ctx.principal.userId ?? null, actorLabel: ctx.principal.label,
  });
  await writeAudit(db, ctx, { entityType: 'job_offer', entityId: row.id, action: 'create', newValue: row });
  await publish(db, {
    eventType: 'JOB_OFFER_ISSUED',
    entityType: 'job_offer', entityId: row.id,
    payload: { applicationId: input.applicationId, reference: row.reference },
    actor: { userId: ctx.principal.userId, label: ctx.principal.label },
  });
  return row;
}

/**
 * The candidate accepts — and THIS is where a person record is created.
 *
 * Mirrors `provisionFromRegistration()` on the institutional intake path: the
 * `persons` row appears at the moment the relationship becomes real, not when
 * somebody filled in a form. An unsuccessful applicant never enters the
 * federation's people register, which is what keeps the national member count a
 * number MMAKF can defend.
 *
 * IDEMPOTENT. A retried acceptance finds the employment the first run made and
 * returns it rather than creating a second — the partial unique index on
 * `employments` would refuse the second anyway, and a caller retrying after a
 * dropped connection deserves the first answer rather than a constraint error.
 */
export async function acceptOffer(db: DB, ctx: AuditContext, offerId: number) {
  assertCanAnywhere(ctx.principal, 'hiring:decide');
  const [offer] = await db.select().from(w.jobOffers).where(eq(w.jobOffers.id, offerId)).limit(1);
  if (!offer) throw new WorkforceError('no_such_offer', `No offer ${offerId}.`);

  if (offer.status === 'accepted' && offer.employmentId) {
    const [existing] = await db.select().from(w.employments).where(eq(w.employments.id, offer.employmentId)).limit(1);
    if (existing) return { employment: existing, personId: existing.personId, alreadyDone: true };
  }
  if (offer.status !== 'issued') {
    throw new WorkforceError('bad_state', `That offer is '${offer.status}' and cannot be accepted.`);
  }
  if (offer.expiresOn && offer.expiresOn < todayIso()) {
    throw new WorkforceError('bad_state', `That offer lapsed on ${offer.expiresOn}. Issue a new one rather than back-dating this.`);
  }

  const [app] = await db.select().from(w.jobApplications).where(eq(w.jobApplications.id, offer.applicationId)).limit(1);
  if (!app) throw new WorkforceError('no_such_application', 'The application behind that offer is missing.');

  // THE ONE CANONICAL PERSON — reuse the existing row where the application was
  // already linked to one (an internal candidate), create one otherwise.
  let personId = app.personId as number | null;
  if (!personId) {
    const federationId = await allocateFederationId(db, 'MEM', Number(offer.proposedStartOn.slice(0, 4)));
    const [person] = await db.insert(s.persons).values({
      federationId,
      fullName: app.applicantName,
      email: app.applicantEmail,
      phone: app.applicantPhone,
      status: 'active',
      sourceRef: app.reference,
    }).returning({ id: s.persons.id });
    personId = person.id;
    await db.update(w.jobApplications).set({ personId, updatedAt: new Date() })
      .where(eq(w.jobApplications.id, app.id));
  }

  const employment = await createEmployment(db, ctx, {
    personId: personId!,
    positionId: offer.positionId,
    employmentType: offer.employmentType,
    startedOn: offer.proposedStartOn,
    payBandCode: offer.payBandCode,
  });

  await db.update(w.jobOffers).set({
    status: 'accepted', respondedAt: new Date(), employmentId: employment.id, updatedAt: new Date(),
  }).where(eq(w.jobOffers.id, offerId));
  await db.update(w.jobApplications).set({ status: 'accepted', updatedAt: new Date() })
    .where(eq(w.jobApplications.id, app.id));
  await db.insert(w.jobApplicationEvents).values({
    applicationId: app.id, kind: 'accepted',
    actorUserId: ctx.principal.userId ?? null, actorLabel: ctx.principal.label,
  });
  await writeAudit(db, ctx, {
    entityType: 'job_offer', entityId: offerId, action: 'approve',
    oldValue: { status: 'issued' }, newValue: { status: 'accepted', employmentId: employment.id },
  });

  return { employment, personId: personId!, alreadyDone: false };
}

export async function declineOffer(db: DB, ctx: AuditContext, offerId: number, note?: string | null) {
  assertCanAnywhere(ctx.principal, 'hiring:decide');
  const [offer] = await db.select().from(w.jobOffers).where(eq(w.jobOffers.id, offerId)).limit(1);
  if (!offer) throw new WorkforceError('no_such_offer', `No offer ${offerId}.`);
  if (offer.status !== 'issued') throw new WorkforceError('bad_state', `That offer is '${offer.status}'.`);

  await db.update(w.jobOffers).set({ status: 'declined', respondedAt: new Date(), note: note?.trim() || offer.note, updatedAt: new Date() })
    .where(eq(w.jobOffers.id, offerId));
  await db.update(w.jobApplications).set({ status: 'declined', updatedAt: new Date() })
    .where(eq(w.jobApplications.id, offer.applicationId));
  await db.insert(w.jobApplicationEvents).values({
    applicationId: offer.applicationId, kind: 'declined', note: note?.trim() || null,
    actorUserId: ctx.principal.userId ?? null, actorLabel: ctx.principal.label,
  });
  await writeAudit(db, ctx, { entityType: 'job_offer', entityId: offerId, action: 'update', oldValue: { status: 'issued' }, newValue: { status: 'declined' } });
  return { ok: true };
}

export async function vacancyRegister(db: DB, principal: Principal) {
  assertCanAnywhere(principal, 'hiring:read');
  return db.select({
    id: w.vacancies.id,
    reference: w.vacancies.reference,
    title: w.vacancies.title,
    slug: w.vacancies.slug,
    status: w.vacancies.status,
    published: w.vacancies.published,
    openings: w.vacancies.openings,
    closesOn: w.vacancies.closesOn,
    departmentName: departments.name,
    applications: sql`(select count(*)::int from job_applications ja where ja.vacancy_id = ${w.vacancies.id})`,
  })
    .from(w.vacancies)
    .leftJoin(departments, eq(departments.id, w.vacancies.departmentId))
    .orderBy(desc(w.vacancies.id))
    .limit(300);
}
