// Two-person control (dual authorisation). Q-25.
//
// Some acts are too consequential for one person: revoking a certificate,
// approving a Dan grade, settling money, selecting a national team, deciding a
// disciplinary outcome, publishing a policy, correcting an official result.
// Each of those is, in the ordinary course, a single privileged call by a
// single administrator. This module makes the second person structural instead
// of procedural.
//
// THE ONE RULE THIS FILE EXISTS FOR: **THE APPROVER MUST NOT BE THE REQUESTER.**
// Everything else here is scaffolding around that sentence. It is also the rule
// most likely to be quietly bypassed — a "just this once" self-approval by a
// SUPER_ADMIN — so it is refused for every role without exception, and it is
// checked against identity, not against a flag a caller can pass in.
//
// WHY DOMAIN EVENTS AND NOT A TABLE:
// There is no approvals table yet (a proposed one is in this module's
// sharedFileEdits). Rather than invent one, the whole mechanism is stored in
// `domain_events`: a request is an appended event, each approval is another
// appended event, and the state is DERIVED by replaying them. That is not a
// workaround, it is the property the mechanism needs — `domain_events` has no
// update path and no delete path, so an approval can never be silently
// withdrawn, a rejection can never be edited into an approval, and the full
// history of who asked, who agreed and who ran it is reconstructible from the
// event log alone. A mutable status column would have none of those guarantees.
//
// THE TRAP THAT COMES WITH IT: derived state means every decision is a read
// followed by an append, and a read-then-append is a race. Two calls could each
// read "one approval, two required" and each append the SECOND approval FROM THE
// SAME PERSON; two calls could each read "approved, not executed" and each run
// the act. Both defeat the entire mechanism. Every mutation therefore runs
// inside a transaction that first takes a row lock on the request's originating
// event (see `lockRequest`) and RE-READS the log under that lock. The lock is a
// mutex and nothing more — the row is never updated; the log stays append-only.
//
// The consequence to know: the events carry `entity_type = 'approval_request'`
// and `entity_id = <request id>`, so every event for one request collates. The
// entity the request is ABOUT lives in the payload. Finding every request that
// touched a given certificate therefore means scanning payloads, which the
// proposed table would fix.

import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { allocateFederationId, writeAudit, type AuditContext } from '@/db/federation';
import {
  assertCan, can, visibleScopes,
  type Action, type Principal, type Resource,
} from '@/lib/rbac';

type DB = any; // drizzle client or transaction (postgres.js in prod, PGlite in tests)

export class ApprovalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

// ─── The acts under two-person control ──────────────────────────────────────

/**
 * The seven acts the federation's directive placed under dual authorisation.
 *
 * `requires` names the EXISTING rbac action a person must independently hold to
 * request, approve or execute the act. Mapping each act onto an existing action
 * is an engineering choice, not federation policy — but two of them have no
 * exact action yet, so they are bound to the nearest NARROWER authority rather
 * than a wider one, because a wrong guess here must fail closed:
 *
 *  · disciplinary_outcome → `membership:revoke`. A disciplinary sanction is the
 *    act that suspends or removes a member, and that action is held nationally
 *    only. A dedicated `discipline:decide` is requested in sharedFileEdits.
 *  · national_team_selection → `competition:sanction`, also national-only. Using
 *    `competition:write` would have let a state administrator approve a national
 *    selection, which is exactly the failure this module exists to prevent.
 *
 * An action not in this registry is refused. There is no "other" bucket: a
 * caller who could name an arbitrary action could name one nobody holds and get
 * a rubber-stamp approval that means nothing.
 */
export const APPROVAL_ACTIONS = {
  certificate_revocation: { requires: 'certificate:revoke' as Action, label: 'Certificate revocation' },
  dan_grade_approval: { requires: 'grading:approve' as Action, label: 'Dan grade approval' },
  financial_settlement: { requires: 'finance:write' as Action, label: 'Financial settlement' },
  national_team_selection: { requires: 'competition:sanction' as Action, label: 'National team selection' },
  disciplinary_outcome: { requires: 'membership:revoke' as Action, label: 'Disciplinary outcome' },
  policy_publication: { requires: 'content:write' as Action, label: 'Policy publication' },
  result_correction: { requires: 'result:finalize' as Action, label: 'Official result correction' },
  /**
   * Writing to more members than one person can follow up in person.
   *
   * Added for src/db/schedule-announce.ts. A schedule change at state or national
   * scope legitimately has to reach members — src/lib/notifications.ts refuses to
   * fan out automatically and says a circular "is a different act with a
   * different approval path" — and this is that path. The damage it guards
   * against is not financial: it is a message to several thousand people that
   * cannot be recalled, sent because somebody mistyped a form.
   */
  mass_notification: { requires: 'notification:send' as Action, label: 'Mass notification' },
} as const;

export type ApprovalActionName = keyof typeof APPROVAL_ACTIONS;

export const APPROVAL_ACTION_NAMES = Object.keys(APPROVAL_ACTIONS) as ApprovalActionName[];

function registryEntry(action: string): { requires: Action; label: string } {
  const entry = (APPROVAL_ACTIONS as Record<string, { requires: Action; label: string }>)[action];
  if (!entry) {
    throw new ApprovalError(
      'unknown_action',
      `'${action}' is not an act under two-person control. Known acts: ${APPROVAL_ACTION_NAMES.join(', ')}.`
    );
  }
  return entry;
}

// ─── Event types ────────────────────────────────────────────────────────────

const ENTITY_TYPE = 'approval_request';

export const APPROVAL_EVENTS = {
  requested: 'APPROVAL_REQUESTED',
  granted: 'APPROVAL_GRANTED',
  rejected: 'APPROVAL_REJECTED',
  executed: 'APPROVAL_EXECUTED',
  failed: 'APPROVAL_EXECUTION_FAILED',
} as const;

/**
 * The floor classification for anything under two-person control.
 *
 * This is a STORAGE-SAFETY floor, not a federation classification rule: the
 * `domain_events` column defaults to `member`, which would put a consequential
 * act and the reasoning behind it in front of every logged-in member. A caller
 * may raise the classification and never lower it.
 *
 * THE BUG THIS REPLACES: every event after the request was written at this floor
 * regardless of how the request itself was classified, so a request raised at
 * `restricted` produced approval and execution events at `official` — and the
 * execution event carries the handler's OUTCOME, the failure event the error
 * text. A consumer filtering `domain_events` by classification would have been
 * shown the sensitive half. Every event for a request now inherits the
 * request's own classification.
 */
type Classification = (typeof s.dataClass.enumValues)[number];
const CLASSIFICATION_FLOOR: Classification = 'official';
// The enum is declared least- to most-restrictive, which is the only reason an
// index comparison is meaningful. If that order ever changes, this must too.
const CLASSIFICATION_ORDER = s.dataClass.enumValues as readonly Classification[];

function atLeastFloor(requested?: Classification | null): Classification {
  if (!requested) return CLASSIFICATION_FLOOR;
  const want = CLASSIFICATION_ORDER.indexOf(requested);
  const floor = CLASSIFICATION_ORDER.indexOf(CLASSIFICATION_FLOOR);
  if (want < 0) return CLASSIFICATION_FLOOR;
  return want > floor ? requested : CLASSIFICATION_FLOOR;
}

// ─── Identity ───────────────────────────────────────────────────────────────

export interface ApprovalParty {
  userId: number;
  label: string;
  /**
   * The role of the binding that ACTUALLY granted the authority for this act in
   * this request's scope — not merely the person's first binding. "Who agreed,
   * under what authority" is not reconstructible evidence if it names an expired
   * or unrelated binding that happened to be listed first.
   */
  role: string | null;
}

/**
 * Which of a principal's bindings authorised this act, here?
 *
 * Asked of `can()` one binding at a time rather than re-derived, so the answer
 * can never drift from the policy module. Null means no single binding did;
 * callers reach this only after `assertCan` has passed, so null is recorded as
 * an honest "not attributable" rather than guessed at.
 */
function authorisingRole(principal: Principal, action: Action, scope: Resource): string | null {
  for (const b of principal.bindings ?? []) {
    if (can({ userId: principal.userId, label: principal.label, bindings: [b] }, action, scope)) {
      return b.role;
    }
  }
  return null;
}

/**
 * Two-person control requires two IDENTIFIED people.
 *
 * A principal with no `userId` — the legacy admin and unit principals in
 * `rbac.ts` are exactly this — cannot be told apart from any other principal
 * sharing that path, so it can neither raise nor approve a request. Allowing it
 * would mean one operator holding one shared login could satisfy both halves of
 * the rule and the mechanism would be decorative.
 */
function identify(principal: Principal, what: string, action: Action, scope: Resource): ApprovalParty {
  if (principal?.userId == null) {
    throw new ApprovalError(
      'unidentified_principal',
      `Two-person control requires an identified user account. A shared or legacy principal cannot ${what}.`
    );
  }
  return {
    userId: principal.userId,
    label: principal.label,
    role: authorisingRole(principal, action, scope),
  };
}

// ─── Serialisation ──────────────────────────────────────────────────────────

/**
 * Whatever is recorded must survive a round trip through jsonb, because the
 * replay is the only record there is. A value that cannot survive it is stored
 * as an explicit note that it could not, rather than as `null` — which would be
 * indistinguishable from a handler that legitimately returned nothing.
 */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return { unserialisable: true, describedAs: String(value) };
  }
}

// ─── State ──────────────────────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'lapsed' | 'executed';

export interface ApprovalExpiry {
  /** False when MMAKF has set no window. An unset rule is not applied. */
  configured: boolean;
  windowHours: number | null;
  expiresAt: string | null;
  note: string;
}

export interface ApprovalEventRow {
  id: number;
  eventType: string;
  at: string;
  actorUserId: number | null;
  actorLabel: string | null;
  classification: Classification;
  payload: any;
}

export interface ApprovalRequestState {
  requestId: string;
  action: ApprovalActionName;
  /** The authority a person must independently hold to act on this request. */
  requires: Action;
  label: string;
  status: ApprovalStatus;
  /** Inherited by every event appended for this request. */
  classification: Classification;
  requester: ApprovalParty;
  requestedAt: string;
  reason: string;
  target: { entityType: string; entityId: string };
  payload: unknown;
  scope: Resource;
  approvalsRequired: number;
  approvals: Array<{ by: ApprovalParty; at: string }>;
  rejection: { by: ApprovalParty; at: string; reason: string; selfWithdrawn: boolean } | null;
  expiry: ApprovalExpiry;
  execution: { at: string; by: ApprovalParty; outcome: unknown } | null;
  /** Every failed execution attempt. A thrown handler is recorded, not swallowed. */
  failures: Array<{ at: string; by: ApprovalParty; error: string }>;
  /** The raw events, in order. The state above is nothing but a replay of these. */
  history: ApprovalEventRow[];
}

function toRow(e: any): ApprovalEventRow {
  return {
    id: e.id,
    eventType: e.eventType,
    at: e.occurredAt instanceof Date ? e.occurredAt.toISOString() : String(e.occurredAt),
    actorUserId: e.actorUserId ?? null,
    actorLabel: e.actorLabel ?? null,
    classification: e.classification ?? CLASSIFICATION_FLOOR,
    payload: e.payload ?? null,
  };
}

/**
 * Replay the event log for one request into its current state.
 *
 * Pure: it reads events and a clock and computes everything else. Nothing about
 * a request is stored as a mutable status, so this function and the log can
 * never disagree.
 */
function replay(events: any[], on: Date): ApprovalRequestState {
  const rows = events.map(toRow);
  const requested = rows.find((r) => r.eventType === APPROVAL_EVENTS.requested);
  if (!requested) {
    throw new ApprovalError('unknown_request', 'No approval request with that id.');
  }

  const p = requested.payload ?? {};
  const entry = registryEntry(p.action);

  const approvals: ApprovalRequestState['approvals'] = [];
  let rejection: ApprovalRequestState['rejection'] = null;
  let execution: ApprovalRequestState['execution'] = null;
  const failures: ApprovalRequestState['failures'] = [];

  for (const r of rows) {
    if (r.eventType === APPROVAL_EVENTS.granted) {
      // ONE PERSON, ONE APPROVAL. Enforced on append under the row lock, and
      // enforced again on replay so that a log which somehow held two from the
      // same person could never be read as a quorum that was never reached. The
      // duplicate is not deleted — it stays in `history`, it just does not count.
      if (approvals.some((a) => a.by?.userId === r.payload?.by?.userId)) continue;
      approvals.push({ by: r.payload.by, at: r.at });
    } else if (r.eventType === APPROVAL_EVENTS.rejected && !rejection) {
      // First rejection is final. A later one cannot revive or override it.
      rejection = {
        by: r.payload.by,
        at: r.at,
        reason: r.payload.reason,
        selfWithdrawn: Boolean(r.payload.selfWithdrawn),
      };
    } else if (r.eventType === APPROVAL_EVENTS.executed && !execution) {
      execution = { at: r.at, by: r.payload.by, outcome: r.payload.outcome ?? null };
    } else if (r.eventType === APPROVAL_EVENTS.failed) {
      failures.push({ at: r.at, by: r.payload.by, error: String(r.payload.error ?? '') });
    }
  }

  const windowHours: number | null = p.windowHours ?? null;
  const expiresAt: string | null = p.expiresAt ?? null;
  const approvalsRequired: number = p.approvalsRequired ?? 1;

  let status: ApprovalStatus = approvals.length >= approvalsRequired ? 'approved' : 'pending';
  if (rejection) status = 'rejected';
  if (execution) status = 'executed';
  // Expiry bites only while a request is still waiting for its second person.
  // Once approved it has had its two-person authorisation and the window it was
  // approved within is a fact in the log; lapsing it afterwards would discard a
  // decision that was validly taken.
  if (status === 'pending' && expiresAt && on.getTime() > Date.parse(expiresAt)) status = 'lapsed';

  return {
    requestId: p.requestId,
    action: p.action,
    requires: entry.requires,
    label: entry.label,
    status,
    // Read from the stored ROW rather than the payload: the column is what every
    // consumer of domain_events actually filters on.
    classification: atLeastFloor(requested.classification),
    requester: p.requester,
    requestedAt: requested.at,
    reason: p.reason,
    target: { entityType: p.target?.entityType, entityId: p.target?.entityId },
    payload: p.payload ?? null,
    // An unreadable scope resolves to {} — national — which is the NARROWEST
    // reachable scope and not the widest: only a national binding satisfies it.
    scope: p.scope ?? {},
    approvalsRequired,
    approvals,
    rejection,
    expiry: {
      configured: windowHours != null,
      windowHours,
      expiresAt,
      note: windowHours == null
        ? 'No approval window has been configured by the federation, so this request does not expire.'
        : `Approval window of ${windowHours} hour(s) as configured when the request was raised; lapses ${expiresAt}.`,
    },
    execution,
    failures,
    history: rows,
  };
}

async function loadEvents(db: DB, requestId: string): Promise<any[]> {
  return db.select().from(s.domainEvents)
    .where(and(eq(s.domainEvents.entityType, ENTITY_TYPE), eq(s.domainEvents.entityId, requestId)))
    .orderBy(asc(s.domainEvents.id));
}

/**
 * The state of one request, WITHOUT an authorisation check.
 *
 * Private on purpose. The scope a caller must be authorised against lives inside
 * the request, so it has to be read before it can be checked; nothing read here
 * reaches a caller until `approvalState` has run `assertCan`.
 */
async function loadState(db: DB, requestId: string, on: Date): Promise<ApprovalRequestState> {
  return replay(await loadEvents(db, requestId), on);
}

/**
 * Read one request, as someone entitled to see it.
 *
 * THE BUG THIS REPLACES: this took no principal at all, so anyone holding a
 * database handle and a request id could read the requester's identity, the
 * stated reason, the entire proposed payload, the recorded outcome and every
 * failure message — for a `restricted` disciplinary outcome as readily as for a
 * routine one. The read is now gated on the same authority the act itself
 * requires, in the request's own scope: if you could not approve it, you cannot
 * read it.
 */
export async function approvalState(
  db: DB,
  ctx: AuditContext,
  requestId: string,
  on: Date = new Date()
): Promise<ApprovalRequestState> {
  const state = await loadState(db, requestId, on);
  assertCan(ctx.principal, state.requires, state.scope);
  return state;
}

/**
 * Serialise every mutation for one request.
 *
 * Takes a row lock on the request's originating event. That row is never
 * updated — the lock is a mutex, and it is the only thing standing between
 * "read the log, decide, append" and two callers deciding on the same stale
 * read. Without it, `approvalsRequired: 2` could be satisfied twice over by one
 * person and an approved act could execute twice.
 *
 * HONEST LIMIT ON THE EVIDENCE: the test suite runs on PGlite, one connection,
 * so it cannot exercise two genuinely simultaneous callers — the overlapping
 * tests in tests/approvals.test.ts still pass with this lock deleted. The lock
 * is what makes exclusion hold in production and nothing here proves it.
 */
async function lockRequest(tx: DB, requestId: string): Promise<void> {
  await tx.execute(sql`
    select id from domain_events
     where entity_type = ${ENTITY_TYPE}
       and entity_id = ${requestId}
       and event_type = ${APPROVAL_EVENTS.requested}
       for update
  `);
}

// ─── Policy (configuration, not invention) ──────────────────────────────────

/**
 * The rules MMAKF supplies for a request.
 *
 * There is no settings table yet, so the policy arrives from the caller's
 * configuration source and is FROZEN INTO THE REQUEST. That is deliberate: a
 * request must lapse according to the window that was in force the day it was
 * raised, not one changed afterwards, and a reader months later must be able to
 * see which window applied without consulting a table that has since moved.
 *
 * `windowHours` unset means NO EXPIRY. Not a default of a day, not a week —
 * nothing, and the derived state says so in `expiry.note`.
 */
export interface ApprovalPolicy {
  /** Hours a request may wait for its approval. Unset ⇒ it never lapses. */
  windowHours?: number | null;
  /**
   * How many people OTHER THAN THE REQUESTER must approve. Defaults to 1, which
   * is not a policy number — it is the definition of two-person control. Any
   * value above 1 is federation configuration.
   */
  approvalsRequired?: number | null;
}

// ─── 1. Request ─────────────────────────────────────────────────────────────

export interface RequestApprovalInput {
  action: ApprovalActionName;
  entityType: string;
  entityId: string | number;
  payload: unknown;
  reason: string;
  /** Where the act sits in the hierarchy. Empty ⇒ national, reachable only from a national binding. */
  scope?: Resource;
  classification?: Classification;
}

/**
 * Raise a request for an act under two-person control.
 *
 * The requester must ALREADY hold the authority for the act. Two-person control
 * narrows who may act; it is not a route by which someone without the authority
 * obtains it by finding a sponsor.
 */
export async function requestApproval(
  db: DB,
  ctx: AuditContext,
  input: RequestApprovalInput,
  policy: ApprovalPolicy = {},
  now: Date = new Date()
): Promise<string> {
  const entry = registryEntry(input.action);
  const scope: Resource = input.scope ?? {};

  assertCan(ctx.principal, entry.requires, scope);
  const requester = identify(ctx.principal, 'raise a request', entry.requires, scope);

  if (!input.reason?.trim()) {
    throw new ApprovalError('reason_required', 'A request under two-person control must state its reason.');
  }
  if (!input.entityType?.trim() || String(input.entityId ?? '').trim() === '') {
    throw new ApprovalError('target_required', 'A request must name the entity it would act on.');
  }

  const windowHours = policy.windowHours ?? null;
  if (windowHours != null && (!Number.isInteger(windowHours) || windowHours <= 0)) {
    throw new ApprovalError('bad_window', 'An approval window must be a positive whole number of hours.');
  }
  const approvalsRequired = policy.approvalsRequired ?? 1;
  if (!Number.isInteger(approvalsRequired) || approvalsRequired < 1) {
    throw new ApprovalError(
      'bad_approvals_required',
      'At least one approver other than the requester is required; that is what two-person control means.'
    );
  }

  const classification = atLeastFloor(input.classification);
  const requestId = await allocateFederationId(db, 'APR', now.getFullYear());
  const expiresAt = windowHours == null
    ? null
    : new Date(now.getTime() + windowHours * 3600_000).toISOString();

  await db.insert(s.domainEvents).values({
    eventType: APPROVAL_EVENTS.requested,
    entityType: ENTITY_TYPE,
    entityId: requestId,
    classification,
    actorUserId: requester.userId,
    actorLabel: requester.label,
    correlationId: requestId,
    occurredAt: now,
    payload: {
      requestId,
      action: input.action,
      requires: entry.requires,
      requester,
      reason: input.reason.trim(),
      target: { entityType: input.entityType, entityId: String(input.entityId) },
      payload: jsonSafe(input.payload),
      scope,
      windowHours,
      expiresAt,
      approvalsRequired,
    },
  });

  await writeAudit(db, { ...ctx, reason: input.reason.trim() }, {
    entityType: ENTITY_TYPE,
    entityId: requestId,
    action: 'create',
    newValue: {
      action: input.action,
      target: { entityType: input.entityType, entityId: String(input.entityId) },
      requesterUserId: requester.userId,
      classification,
      expiresAt,
      approvalsRequired,
    },
  });

  return requestId;
}

// ─── 2. Approve and reject ──────────────────────────────────────────────────

/**
 * Approve a request as the second person.
 *
 * FOUR independent conditions, all required, none of them skippable:
 *  1. the approver holds the action's authority IN THE REQUEST'S SCOPE — a
 *     second person who lacks the permission is not a second authorisation, and
 *     `assertCan` is asked, never re-implemented here;
 *  2. the approver is not the requester, for every role including SUPER_ADMIN;
 *  3. the request is still pending;
 *  4. the approver has not already approved it — one person cannot supply two of
 *     the required approvals by calling twice, NOR BY CALLING TWICE AT ONCE,
 *     which is why 3 and 4 are decided again under the row lock rather than on
 *     the read taken before it.
 */
export async function approve(
  db: DB,
  ctx: AuditContext,
  requestId: string,
  now: Date = new Date()
): Promise<ApprovalRequestState> {
  const pre = await loadState(db, requestId, now);

  assertCan(ctx.principal, pre.requires, pre.scope);
  const approver = identify(ctx.principal, 'approve a request', pre.requires, pre.scope);

  // Identity, not state: settled before the lock because the requester recorded
  // in the log is immutable and no concurrent call can change it.
  if (approver.userId === pre.requester.userId) {
    throw new ApprovalError(
      'self_approval',
      'The approver must not be the requester. Self-approval is refused for every role, including SUPER_ADMIN.'
    );
  }

  await db.transaction(async (tx: DB) => {
    await lockRequest(tx, requestId);
    const state = await loadState(tx, requestId, now);

    if (state.status !== 'pending') {
      throw new ApprovalError('not_pending', `This request is ${state.status} and can no longer be approved.`);
    }
    if (state.approvals.some((a) => a.by.userId === approver.userId)) {
      throw new ApprovalError('already_approved_by_you', 'You have already approved this request.');
    }

    await tx.insert(s.domainEvents).values({
      eventType: APPROVAL_EVENTS.granted,
      entityType: ENTITY_TYPE,
      entityId: requestId,
      classification: state.classification,
      actorUserId: approver.userId,
      actorLabel: approver.label,
      correlationId: requestId,
      occurredAt: now,
      payload: { requestId, by: approver, action: state.action },
    });

    await writeAudit(tx, ctx, {
      entityType: ENTITY_TYPE,
      entityId: requestId,
      action: 'approve',
      oldValue: { status: state.status, approvals: state.approvals.length },
      newValue: {
        approverUserId: approver.userId,
        approverRole: approver.role,
        approvals: state.approvals.length + 1,
        required: state.approvalsRequired,
      },
    });
  });

  return loadState(db, requestId, now);
}

/**
 * Refuse a request, with a reason.
 *
 * The requester MAY reject their own request, and it is recorded as a
 * withdrawal. The two-person rule guards the DOING of a consequential act, not
 * the refusal of one — a rejection can never cause the act to happen, so
 * requiring a second person to withdraw a request would add ceremony without
 * protecting anything, and would strand every request raised in error where no
 * expiry window is configured.
 */
export async function reject(
  db: DB,
  ctx: AuditContext,
  requestId: string,
  reason: string,
  now: Date = new Date()
): Promise<ApprovalRequestState> {
  const pre = await loadState(db, requestId, now);

  assertCan(ctx.principal, pre.requires, pre.scope);
  const rejector = identify(ctx.principal, 'reject a request', pre.requires, pre.scope);

  if (!reason?.trim()) {
    throw new ApprovalError('reason_required', 'A rejection must state its reason.');
  }

  const selfWithdrawn = rejector.userId === pre.requester.userId;

  // Under the same lock as approve and execute, so a rejection racing an
  // execution resolves one way or the other instead of both happening.
  await db.transaction(async (tx: DB) => {
    await lockRequest(tx, requestId);
    const state = await loadState(tx, requestId, now);

    if (state.status === 'executed' || state.status === 'rejected') {
      throw new ApprovalError('not_pending', `This request is ${state.status} and can no longer be rejected.`);
    }

    await tx.insert(s.domainEvents).values({
      eventType: APPROVAL_EVENTS.rejected,
      entityType: ENTITY_TYPE,
      entityId: requestId,
      classification: state.classification,
      actorUserId: rejector.userId,
      actorLabel: rejector.label,
      correlationId: requestId,
      occurredAt: now,
      payload: { requestId, by: rejector, reason: reason.trim(), selfWithdrawn, action: state.action },
    });

    await writeAudit(tx, { ...ctx, reason: reason.trim() }, {
      entityType: ENTITY_TYPE,
      entityId: requestId,
      action: 'reject',
      oldValue: { status: state.status },
      newValue: { status: 'rejected', rejectorUserId: rejector.userId, selfWithdrawn },
    });
  });

  return loadState(db, requestId, now);
}

// ─── 3. Execute ─────────────────────────────────────────────────────────────

export interface ExecutionResult {
  /** True only when the handler ran on THIS call. */
  ran: boolean;
  requestId: string;
  outcome: unknown;
  executedAt: string;
  executedBy: ApprovalParty;
  state: ApprovalRequestState;
}

/**
 * Run the approved act exactly once and record that it ran.
 *
 * ONCE-ONLY, AND NOT MERELY UNLIKELY. The guard used to be a read-then-append:
 * two processes could both observe 'approved' and both run the handler, applying
 * a revocation or a settlement twice — precisely the damage this module exists
 * to prevent. The whole sequence now runs inside one transaction that first
 * locks the request (`lockRequest`) and re-reads the log under that lock, so a
 * second caller waits and then finds the request already executed.
 *
 * THE HANDLER RECEIVES THE TRANSACTION AND MUST USE IT. Its writes then commit
 * atomically with the event recording that they happened: there is no window in
 * which the act has taken effect but the log says it has not, or the reverse. A
 * handler that writes through the outer `db` handle gets neither property and
 * may block on the lock this transaction holds.
 *
 * A SECOND CALL does not re-run the handler; it returns the outcome recorded by
 * the first, with `ran: false`.
 *
 * A HANDLER THAT THROWS IS NEVER SWALLOWED. Its writes roll back with the
 * transaction, the failure is then appended in its own statement, and the error
 * is rethrown; the request stays APPROVED and unexecuted, so the operator can
 * fix the cause and call again without begging for a second approval. Recording
 * the failure and returning normally would be a fake feature — the caller would
 * believe the act happened.
 *
 * The executor may be the requester: the second person has already agreed, and
 * the requester is the one who proposed the act. What the executor may not be is
 * unauthorised, so the authority is checked again here rather than inferred from
 * the approval.
 */
export async function executeIfApproved<T>(
  db: DB,
  ctx: AuditContext,
  requestId: string,
  handler: (state: ApprovalRequestState, tx: DB) => Promise<T> | T,
  now: Date = new Date()
): Promise<ExecutionResult> {
  const pre = await loadState(db, requestId, now);

  assertCan(ctx.principal, pre.requires, pre.scope);
  const executor = identify(ctx.principal, 'execute a request', pre.requires, pre.scope);

  // Cheap refusals before a transaction is opened. Both are decided again inside
  // it; these exist so an unauthorised or unapproved caller never takes the lock.
  if (pre.status === 'executed') return alreadyExecuted(requestId, pre);
  if (pre.status !== 'approved') {
    throw new ApprovalError(
      'not_approved',
      `This request is ${pre.status}. Only an approved request can be executed.`
    );
  }

  // Distinguishes "the act failed" from "this call lost the race or was
  // refused". Only the former is a failure of the act; only the former is
  // recorded as one.
  let handlerThrew = false;

  let result: { alreadyExecuted: boolean };
  try {
    result = await db.transaction(async (tx: DB) => {
      await lockRequest(tx, requestId);
      const state = await loadState(tx, requestId, now);

      if (state.status === 'executed') return { alreadyExecuted: true };
      if (state.status !== 'approved') {
        throw new ApprovalError(
          'not_approved',
          `This request is ${state.status}. Only an approved request can be executed.`
        );
      }

      let outcome: T;
      try {
        outcome = await handler(state, tx);
      } catch (err) {
        handlerThrew = true;
        throw err;
      }

      await tx.insert(s.domainEvents).values({
        eventType: APPROVAL_EVENTS.executed,
        entityType: ENTITY_TYPE,
        entityId: requestId,
        classification: state.classification,
        actorUserId: executor.userId,
        actorLabel: executor.label,
        correlationId: requestId,
        occurredAt: now,
        payload: { requestId, by: executor, action: state.action, outcome: jsonSafe(outcome) },
      });

      await writeAudit(tx, ctx, {
        entityType: ENTITY_TYPE,
        entityId: requestId,
        action: 'finalize',
        oldValue: { status: 'approved' },
        newValue: {
          status: 'executed',
          executorUserId: executor.userId,
          executorRole: executor.role,
          approvedBy: state.approvals.map((a) => a.by.userId),
        },
      });

      return { alreadyExecuted: false };
    });
  } catch (err: any) {
    // A refusal or a lost race is not an execution failure and must not be
    // recorded as one — a spurious failure row would misreport the act as having
    // been attempted and gone wrong.
    if (!handlerThrew) throw err;

    // Appended outside the rolled-back transaction, so the record of the failure
    // survives the rollback of everything the handler attempted.
    await db.insert(s.domainEvents).values({
      eventType: APPROVAL_EVENTS.failed,
      entityType: ENTITY_TYPE,
      entityId: requestId,
      classification: pre.classification,
      actorUserId: executor.userId,
      actorLabel: executor.label,
      correlationId: requestId,
      occurredAt: now,
      payload: {
        requestId,
        by: executor,
        error: String(err?.message ?? err),
        errorCode: err?.code ?? null,
        errorName: err?.name ?? null,
      },
    });
    await writeAudit(db, ctx, {
      entityType: ENTITY_TYPE,
      entityId: requestId,
      action: 'update',
      oldValue: { status: 'approved' },
      newValue: { status: 'approved', executionFailed: true, error: String(err?.message ?? err) },
    });
    throw err;
  }

  const after = await loadState(db, requestId, now);
  if (result.alreadyExecuted) return alreadyExecuted(requestId, after);

  return {
    ran: true,
    requestId,
    outcome: after.execution!.outcome,
    executedAt: after.execution!.at,
    executedBy: executor,
    state: after,
  };
}

/** The recorded first execution, returned verbatim. Nothing re-runs. */
function alreadyExecuted(requestId: string, state: ApprovalRequestState): ExecutionResult {
  return {
    ran: false,
    requestId,
    outcome: state.execution!.outcome,
    executedAt: state.execution!.at,
    executedBy: state.execution!.by,
    state,
  };
}

// ─── 4. The queue ───────────────────────────────────────────────────────────

export interface PendingApprovalQueue {
  items: ApprovalRequestState[];
  /**
   * FALSE means this queue is INCOMPLETE — more requests match than `scanLimit`
   * allowed to be examined, so a pending one may be missing from `items`. A
   * queue that quietly dropped work while looking complete would be a fake
   * feature.
   */
  complete: boolean;
  /** How many requests were examined after the SQL filters. */
  scanned: number;
  note: string;
}

/**
 * The SQL half of the scope filter.
 *
 * THE BUG THIS REPLACES: the scope check ran only in JavaScript, after every
 * recent request in the federation had already been loaded — payloads, reasons
 * and requester identities for states the viewer has no authority over included.
 * The filter now runs in the query, so out-of-scope rows are never read.
 *
 * It is a PREFILTER: it unions the scopes in which the viewer holds ANY of the
 * seven authorities, and the per-action `can()` check in `pendingApprovals` is
 * still the decision. A prefilter may only ever be WIDER than the real answer,
 * never narrower, or it would hide work the viewer is entitled to.
 */
function scopePrefilter(principal: Principal): { kind: 'all' | 'none' } | { kind: 'sql'; where: any } {
  const states = new Set<number>(), districts = new Set<number>(), dojos = new Set<number>();
  for (const name of APPROVAL_ACTION_NAMES) {
    const v = visibleScopes(principal, APPROVAL_ACTIONS[name].requires);
    if (v.kind === 'all') return { kind: 'all' };
    if (v.kind === 'none') continue;
    v.states.forEach((x) => states.add(x));
    v.districts.forEach((x) => districts.add(x));
    v.dojos.forEach((x) => dojos.add(x));
  }

  const ors: any[] = [];
  // Compared as TEXT: `->>` already yields text, and casting to int would throw
  // on a payload whose scope id is not numeric. A malformed row must be excluded
  // from one person's queue, not turn the whole queue into an error.
  if (states.size) {
    ors.push(inArray(sql`${s.domainEvents.payload}->'scope'->>'stateUnitId'`, [...states].map(String)));
  }
  if (districts.size) {
    ors.push(inArray(sql`${s.domainEvents.payload}->'scope'->>'districtUnitId'`, [...districts].map(String)));
  }
  if (dojos.size) {
    ors.push(inArray(sql`${s.domainEvents.payload}->'scope'->>'dojoId'`, [...dojos].map(String)));
  }
  // No national binding and no scoped one: nothing is reachable. Note a request
  // with an EMPTY scope is national and is correctly excluded here — a state
  // binding never satisfies it.
  if (!ors.length) return { kind: 'none' };
  return { kind: 'sql', where: or(...ors) };
}

/**
 * What this person may actually act on.
 *
 * Filtered four ways: still pending, NOT their own (excluded in SQL — the
 * requested event's actor IS the requester), inside a scope where they hold the
 * action's authority, and not already approved by them. Showing someone a
 * request they are forbidden to approve is not a list, it is an invitation to
 * look for a way round the rule.
 *
 * `scanLimit` bounds the replay: state lives in the event log rather than an
 * indexed status column, so completeness cannot be had from a WHERE clause. It
 * is a query bound and not a federation rule, and when it bites `complete` is
 * false and the note says so, rather than the caller believing they have seen
 * everything.
 */
export async function pendingApprovals(
  db: DB,
  principal: Principal,
  opts: { on?: Date; limit?: number; scanLimit?: number } = {}
): Promise<PendingApprovalQueue> {
  const on = opts.on ?? new Date();
  const limit = opts.limit ?? 50;
  const scanLimit = opts.scanLimit ?? 500;

  // An unidentified principal can never be the second person, so their queue is
  // empty rather than a list of things they would be refused.
  if (principal?.userId == null) {
    return {
      items: [], complete: true, scanned: 0,
      note: 'Two-person control requires an identified user account; a shared or legacy login has no queue.',
    };
  }

  const prefilter = scopePrefilter(principal);
  if (prefilter.kind === 'none') {
    return {
      items: [], complete: true, scanned: 0,
      note: 'This account holds none of the authorities under two-person control, in any scope.',
    };
  }

  const conditions: any[] = [
    eq(s.domainEvents.entityType, ENTITY_TYPE),
    eq(s.domainEvents.eventType, APPROVAL_EVENTS.requested),
    // `is distinct from` rather than `<>`: a NULL actor must not slip through as
    // "not me" on three-valued logic.
    sql`${s.domainEvents.actorUserId} is distinct from ${principal.userId}`,
  ];
  if (prefilter.kind === 'sql') conditions.push(prefilter.where);

  // One more than the bound, so exhaustion is DETECTED rather than assumed.
  const requested = await db.select({ entityId: s.domainEvents.entityId })
    .from(s.domainEvents)
    .where(and(...conditions))
    .orderBy(desc(s.domainEvents.id))
    .limit(scanLimit + 1);

  const complete = requested.length <= scanLimit;
  const ids = requested.slice(0, scanLimit).map((r: any) => r.entityId);

  const note = complete
    ? 'Every request this account could act on was examined.'
    : `More than ${scanLimit} requests match; only the most recent ${scanLimit} were examined, so an older pending request may be missing from this list.`;

  if (!ids.length) return { items: [], complete, scanned: 0, note };

  const events = await db.select().from(s.domainEvents)
    .where(and(eq(s.domainEvents.entityType, ENTITY_TYPE), inArray(s.domainEvents.entityId, ids)))
    .orderBy(asc(s.domainEvents.id));

  const byRequest = new Map<string, any[]>();
  for (const e of events) {
    const list = byRequest.get(e.entityId) ?? [];
    list.push(e);
    byRequest.set(e.entityId, list);
  }

  const items: ApprovalRequestState[] = [];
  for (const id of ids) {
    const state = replay(byRequest.get(id) ?? [], on);
    if (state.status !== 'pending') continue;
    // Belt and braces with the SQL exclusion: that clause reads the event's
    // actor, this reads the requester recorded in the payload, and the two must
    // agree before a request is offered to anyone.
    if (state.requester.userId === principal.userId) continue;
    if (state.approvals.some((a) => a.by.userId === principal.userId)) continue;
    // THE decision. Everything above is a prefilter.
    if (!can(principal, state.requires, state.scope)) continue;
    items.push(state);
    if (items.length >= limit) break;
  }
  return { items, complete, scanned: ids.length, note };
}
