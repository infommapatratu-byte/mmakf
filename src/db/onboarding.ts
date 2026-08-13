// Registration, and the life of a request for authority.
//
// THE RULE THAT SHAPES THE MODULE: REGISTRATION GRANTS NOTHING.
//
// Creating an account is not joining the federation, and it is certainly not
// becoming a coach. A brand-new account holds zero role bindings, which under
// the deny-by-default engine in src/lib/rbac.ts means it can reach exactly one
// thing: its own record. Everything else — every admin surface, every other
// person's record, every review queue — refuses it, and refuses it because the
// authority is absent rather than because a page remembered to check.
//
// Authority arrives one way only: a human being with the power to confer it
// decides to. This module is the paperwork around that decision.
//
// FIVE THINGS IT REFUSES TO DO.
//
//  1. IT WILL NOT WRITE A ROLE BINDING ITSELF. An approval calls grantRole()
//     in src/db/users.ts, gated by canGrantRole() in src/lib/rbac.ts, which is
//     the same path an administrator uses by hand. A queue with its own private
//     insert into role_bindings is a privilege-escalation vector wearing an
//     admin screen, and it is the single most dangerous thing this feature
//     could contain.
//
//  2. IT WILL NOT LET ANYBODY DECIDE THEIR OWN APPLICATION. Not even a
//     SUPER_ADMIN. src/lib/approvals.ts already refuses self-approval without
//     exception and this matches it, checked against identity rather than
//     against a flag the caller passes in.
//
//  3. IT WILL NOT LET A REVIEWER CHOOSE THE SCOPE. The binding is made at the
//     scope written on the APPLICATION. A Jharkhand administrator approving a
//     coach binds a Jharkhand coach, because the scope was never theirs to
//     type. Letting the decision carry its own scope is how "approve" quietly
//     becomes "approve, nationally".
//
//  4. IT WILL NOT DECIDE WHO QUALIFIES. What grade, licence or experience makes
//     somebody a coach or a referee is a FEDERATION decision and MMAKF has not
//     published one. `evidence` is captured verbatim and judged by a person.
//     A validation rule here would be this file inventing federation policy,
//     and it would be wrong quietly.
//
//  5. IT WILL NOT CLAIM AN EMAIL WAS SENT. No email transport is configured in
//     this project. src/lib/notifications.ts queues and marks messages `queued`
//     rather than `sent`, and registration reports the same truth: nothing has
//     been delivered, and here is why.

import { and, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import * as s from '@/db/schema';
import { OPEN_APPLICATION_STATUSES } from '@/db/onboarding.schema';
import { allocateFederationId, writeAudit, resolvePlacement, type AuditContext } from '@/db/federation';
import { createUser, grantRole } from '@/db/users';
import { transportStatus } from '@/lib/notifications';
import { isUniqueViolation } from '@/db/pgerror';
import {
  actionsForRole, canAnywhere, canGrantRole, visibleScopes,
  ROLES, type Action, type Principal, type Role, type ScopeType,
} from '@/lib/rbac';

type DB = any;

export class OnboardingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OnboardingError';
    this.code = code;
  }
}

/** See calendar.ts for why identity is checked by shape and not `instanceof`. */
export function isOnboardingError(err: unknown): err is OnboardingError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'OnboardingError';
}

// ─── What may be applied for ────────────────────────────────────────────────

/**
 * The roles a person may put themselves forward for.
 *
 * These are the CREDENTIAL roles — what somebody does on the mat, at the
 * table, or in the ring. Every other role in src/lib/rbac.ts is administrative
 * authority over other people's records, and administrative authority is
 * CONFERRED by the federation, never REQUESTED through a public form.
 *
 * This is deliberately NOT a statement about who qualifies. Nothing here says a
 * referee needs a licence or a coach needs a Dan grade; those are federation
 * decisions nobody has published, and a human reads the evidence and decides.
 * It says only which kinds of request the queue will accept at all.
 *
 * The list is defended structurally rather than by trust: `APPLICATION_MUST_NOT_CONFER`
 * below names the actions that would turn this queue into an escalation path,
 * and tests/onboarding.test.ts asserts that no applicable role holds one. If
 * somebody widens a role's grants in rbac.ts, that test fails before the queue
 * becomes dangerous.
 */
export const APPLICABLE_ROLES: readonly Role[] = [
  'INSTRUCTOR', 'EXAMINER', 'REFEREE', 'JUDGE', 'ATHLETE', 'MEMBER',
];

/**
 * Actions no applicable role may hold.
 *
 * Each of these is authority over the authority system itself, over other
 * people's private data, or over money. A queue that could hand any of them out
 * on request is not an onboarding queue.
 */
export const APPLICATION_MUST_NOT_CONFER: readonly Action[] = [
  'role:grant', 'user:write', 'user:read',
  'safeguarding:read', 'safeguarding:write',
  'finance:write', 'person:read_pii',
  'marketplace:review', 'marketplace:suspend',
];

export function isApplicableRole(role: unknown): role is Role {
  return typeof role === 'string' && (APPLICABLE_ROLES as readonly string[]).includes(role);
}

/**
 * What a surface prints where a qualification requirement would go.
 *
 * There is no requirement to print. Saying so is honest and useful; inventing
 * "Requires 1st Dan and two years' teaching" is the one failure this project
 * treats as unforgivable.
 */
export const EVIDENCE_REQUIREMENTS_NOT_SET =
  'The federation has not published what evidence qualifies an applicant for this role. ' +
  'Attach whatever supports the application; a reviewer at MMAKF decides.';

/** Nobody at MMAKF has committed to a review turnaround, so nothing promises one. */
export const REVIEW_TURNAROUND_NOT_SET =
  'The federation has not set a review turnaround time for applications.';

// ─── Registration ───────────────────────────────────────────────────────────

export interface RegisterInput {
  email: string;
  password: string;
  /** Optional. Recorded on the account for a reviewer to read; confers nothing. */
  displayName?: string | null;
  ip?: string | null;
  requestId?: string | null;
}

export interface RegistrationResult {
  userId: number;
  email: string;
  /**
   * Always zero, and returned rather than assumed.
   *
   * A caller reading this value cannot write "the new account can now…" without
   * noticing that the answer is nothing. The type is the literal 0 so that a
   * future change which grants something on registration fails to compile here
   * before it reaches a user.
   */
  roleBindingCount: 0;
  /**
   * What actually happened about verification.
   *
   * `emailSent` is the literal false. No email transport is configured in this
   * project, so no verification message exists, and a surface that printed
   * "check your inbox" would be sending the user to wait for something that is
   * never coming.
   */
  verification: {
    emailSent: false;
    transportConfigured: boolean;
    note: string;
  };
}

/**
 * Create an account.
 *
 * ON ENUMERATION: a taken address is reported as taken. That does disclose
 * which email addresses hold accounts, and the alternative — reporting success
 * and silently creating nothing — leaves a real person unable to sign in with
 * no way to find out why. The disclosure is accepted here and mitigated at the
 * edge by the IP rate limiter, exactly as the sign-in path is; what is NOT
 * acceptable is a registration that lies about what it did.
 */
export async function registerAccount(db: DB, input: RegisterInput): Promise<RegistrationResult> {
  const email = String(input?.email ?? '').trim().toLowerCase();

  let created: { id: number; email: string };
  try {
    // Reuse rather than re-implement: createUser() already normalises the
    // address, applies the password policy from src/lib/password.ts and hashes
    // with scrypt. A second copy of that logic is a second place for the
    // password rules to be weaker.
    created = await createUser(db, { email: input.email, password: input.password });
  } catch (err: any) {
    if (/already exists/i.test(String(err?.message ?? ''))) {
      throw new OnboardingError('email_taken', `An account already exists for ${email}.`);
    }
    // A unique violation here is USUALLY the email, lost to a race between
    // createUser's existence check and its insert. It is not necessarily the
    // email, and assuming so is how a genuine fault hides: a database whose
    // users id sequence has fallen behind its rows raises 23505 on the primary
    // key, and reporting that as "that address is taken" sends an operator
    // hunting a duplicate account that does not exist while the real problem
    // stays invisible. So the claim is CHECKED before it is made.
    if (isUniqueViolation(err)) {
      const clash = (await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.email, email)).limit(1))[0];
      if (clash) throw new OnboardingError('email_taken', `An account already exists for ${email}.`);
    }
    throw new OnboardingError('registration_refused', String(err?.message ?? 'Registration refused.'));
  }

  // The actor is the person registering. They have no bindings and no
  // authority, and the audit record says exactly that rather than attributing
  // the row to "system" as though the federation had created it.
  const ctx: AuditContext = {
    principal: { userId: created.id, label: `registration:${created.email}`, bindings: [] },
    ip: input.ip ?? null,
    requestId: input.requestId ?? null,
  };

  await writeAudit(db, ctx, {
    entityType: 'user',
    entityId: created.id,
    action: 'create',
    newValue: {
      email: created.email,
      selfRegistered: true,
      // Recorded so the audit trail itself carries the invariant. If a row ever
      // appears with a non-zero count here, something granted authority at
      // registration and this is where it becomes visible.
      roleBindingsGranted: 0,
      displayName: input.displayName ?? null,
    },
  });

  const email_transport = transportStatus().find((t) => t.channel === 'email');

  return {
    userId: created.id,
    email: created.email,
    roleBindingCount: 0,
    verification: {
      emailSent: false,
      transportConfigured: Boolean(email_transport?.configured),
      note: email_transport?.configured
        ? 'No verification email is sent by this system. The account is usable and holds no authority.'
        : 'No email transport is configured, so no verification message was sent or queued. ' +
          'The account is usable and holds no authority.',
    },
  };
}

// ─── Applying ───────────────────────────────────────────────────────────────

export interface ApplyInput {
  requestedRole: Role;
  scopeType: ScopeType;
  scopeId?: number | null;
  /** Free-form. Whatever the applicant supplies; nothing here is required. */
  evidence?: Record<string, unknown> | null;
}

export interface ApplicationRef {
  applicationId: number;
  ref: string;
  status: 'submitted';
}

/** Evidence is free-form but not unbounded — a jsonb column is not file storage. */
const MAX_EVIDENCE_BYTES = 16_384;

function normaliseEvidence(evidence: unknown): Record<string, unknown> | null {
  if (evidence == null) return null;
  if (typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new OnboardingError('bad_evidence', 'Evidence must be an object of named fields.');
  }
  const encoded = JSON.stringify(evidence);
  if (encoded.length > MAX_EVIDENCE_BYTES) {
    throw new OnboardingError(
      'evidence_too_large',
      `Evidence must be under ${MAX_EVIDENCE_BYTES} characters when encoded. ` +
      'Upload documents through the file store and reference them here rather than inlining them.'
    );
  }
  return evidence as Record<string, unknown>;
}

/**
 * Apply for a role.
 *
 * THERE IS NO applicantUserId PARAMETER. The applicant is whoever is signed in,
 * read from the principal — which is the structural way to make applying on
 * somebody else's behalf impossible, rather than a check that a later refactor
 * can drop. Same construction as myNotifications() in src/lib/notifications.ts.
 */
export async function applyForRole(db: DB, ctx: AuditContext, input: ApplyInput): Promise<ApplicationRef> {
  const applicantUserId = ctx.principal?.userId ?? null;
  if (applicantUserId == null) {
    throw new OnboardingError('not_signed_in', 'Applying for a role requires a signed-in account.');
  }

  if (!ROLES.includes(input.requestedRole)) {
    throw new OnboardingError('unknown_role', `Unknown role: ${String(input.requestedRole)}.`);
  }
  if (!isApplicableRole(input.requestedRole)) {
    throw new OnboardingError(
      'role_not_applicable',
      `${input.requestedRole} is administrative authority and is conferred by the federation, not requested. ` +
      `Applications are accepted for: ${APPLICABLE_ROLES.join(', ')}.`
    );
  }

  const scopeType = input.scopeType;
  if (!['national', 'state', 'district', 'dojo'].includes(scopeType)) {
    throw new OnboardingError('bad_scope', `Unknown scope type: ${String(scopeType)}.`);
  }
  const scopeId = scopeType === 'national' ? null : (input.scopeId ?? null);
  if (scopeType !== 'national' && scopeId == null) {
    throw new OnboardingError('bad_scope', 'A scoped application must name the unit it applies to.');
  }

  // The named unit has to exist. Without this an applicant files against unit
  // 99999, no reviewer's scope ever contains it, and the application is
  // invisible to everybody including the applicant's own state office.
  await assertScopeExists(db, scopeType, scopeId);

  const evidence = normaliseEvidence(input.evidence);

  const user = (await db.select().from(s.users).where(eq(s.users.id, applicantUserId)).limit(1))[0];
  if (!user) throw new OnboardingError('unknown_user', 'No such account.');

  // Already held? An application that would change nothing wastes a reviewer's
  // attention, and reviewer attention is the scarce resource this whole queue
  // is spending.
  const held = await db.select({ id: s.roleBindings.id }).from(s.roleBindings).where(and(
    eq(s.roleBindings.userId, applicantUserId),
    eq(s.roleBindings.role, input.requestedRole),
    eq(s.roleBindings.scopeType, scopeType),
    scopeId == null ? sql`${s.roleBindings.scopeId} IS NULL` : eq(s.roleBindings.scopeId, scopeId),
    eq(s.roleBindings.status, 'active'),
  )).limit(1);
  if (held.length) {
    throw new OnboardingError('already_held', `This account already holds ${input.requestedRole} at that scope.`);
  }

  const ref = await allocateFederationId(db, 'APP');

  let row: { id: number };
  try {
    [row] = await db.insert(s.roleApplications).values({
      ref,
      applicantUserId,
      personId: user.personId ?? null,
      requestedRole: input.requestedRole,
      scopeType,
      scopeId,
      evidence,
      status: 'submitted',
    }).returning({ id: s.roleApplications.id });
  } catch (err) {
    // The partial unique index in onboarding.schema.ts, doing its job. Two
    // submissions in the same instant both read "nothing open" and both insert;
    // the database refuses the second, and this is where that refusal becomes a
    // sentence somebody can read.
    if (isUniqueViolation(err)) {
      throw new OnboardingError(
        'already_open',
        'An application for this role at this scope is already open. Withdraw it before filing another.'
      );
    }
    throw err;
  }

  await writeAudit(db, ctx, {
    entityType: 'role_application',
    entityId: row.id,
    action: 'create',
    newValue: {
      ref, requestedRole: input.requestedRole, scopeType, scopeId,
      // The evidence itself is NOT copied into the audit trail: it is the
      // applicant's personal material, it can be large, and the row it belongs
      // to is already immutable enough for the purpose. What was supplied is
      // recorded as field names, which is what an auditor actually asks.
      evidenceFields: evidence ? Object.keys(evidence) : [],
    },
  });

  return { applicationId: row.id, ref, status: 'submitted' };
}

async function assertScopeExists(db: DB, scopeType: ScopeType, scopeId: number | null): Promise<void> {
  if (scopeType === 'national') return;
  if (scopeType === 'state') {
    // resolvePlacement() is reused for districts and dojos because it also
    // proves the hierarchy AGREES with itself; a bare existence check would
    // accept a dojo id from another state.
    const row = (await db.select({ id: s.stateUnits.id }).from(s.stateUnits).where(eq(s.stateUnits.id, scopeId!)).limit(1))[0];
    if (!row) throw new OnboardingError('unknown_scope', 'No such state unit.');
    return;
  }
  try {
    if (scopeType === 'district') await resolvePlacement(db, { districtUnitId: scopeId });
    else await resolvePlacement(db, { dojoId: scopeId });
  } catch (err: any) {
    throw new OnboardingError('unknown_scope', String(err?.message ?? 'No such unit.'));
  }
}

/**
 * Withdraw one's own application.
 *
 * TAKES NO applicantUserId. The row is matched on the caller's identity in the
 * WHERE clause, so withdrawing somebody else's application is not a check that
 * can fail — it is a query that returns nothing.
 */
export async function withdrawApplication(
  db: DB, ctx: AuditContext, applicationId: number, reason?: string | null
): Promise<{ id: number; status: 'withdrawn' }> {
  const userId = ctx.principal?.userId ?? null;
  if (userId == null) throw new OnboardingError('not_signed_in', 'Withdrawing an application requires a signed-in account.');

  const updated = await db.update(s.roleApplications)
    .set({
      status: 'withdrawn',
      decisionReason: reason?.trim() || 'Withdrawn by the applicant.',
      updatedAt: new Date(),
    })
    .where(and(
      eq(s.roleApplications.id, applicationId),
      eq(s.roleApplications.applicantUserId, userId),
      inArray(s.roleApplications.status, [...OPEN_APPLICATION_STATUSES]),
    ))
    .returning({ id: s.roleApplications.id });

  if (!updated.length) {
    // Deliberately one message for "not yours", "does not exist" and "already
    // decided". Distinguishing them would let a signed-in account enumerate
    // which application ids exist and which are still open.
    throw new OnboardingError('not_withdrawable', 'No open application of yours with that id.');
  }

  await writeAudit(db, { ...ctx, reason: reason?.trim() ?? null }, {
    entityType: 'role_application',
    entityId: applicationId,
    action: 'update',
    newValue: { status: 'withdrawn' },
  });

  return { id: applicationId, status: 'withdrawn' };
}

/**
 * The caller's own applications.
 *
 * NO userId PARAMETER, for the same reason as myNotifications(): a function
 * that cannot be asked about somebody else cannot be tricked into answering
 * about them.
 */
export async function myApplications(db: DB, principal: Principal) {
  if (principal?.userId == null) return [];
  return db.select({
    id: s.roleApplications.id,
    ref: s.roleApplications.ref,
    requestedRole: s.roleApplications.requestedRole,
    scopeType: s.roleApplications.scopeType,
    scopeId: s.roleApplications.scopeId,
    status: s.roleApplications.status,
    evidence: s.roleApplications.evidence,
    submittedAt: s.roleApplications.submittedAt,
    reviewedAt: s.roleApplications.reviewedAt,
    decisionReason: s.roleApplications.decisionReason,
  })
    .from(s.roleApplications)
    .where(eq(s.roleApplications.applicantUserId, principal.userId))
    .orderBy(desc(s.roleApplications.id));
}

// ─── The review queue ───────────────────────────────────────────────────────

/**
 * May this principal decide applications at all?
 *
 * Exported so a surface can say "you do not hold the authority to confer roles"
 * rather than presenting an empty queue that looks like an empty inbox.
 *
 * NOTE FOR THE FEDERATION, stated rather than quietly worked around: under the
 * current authority model in src/lib/rbac.ts only SUPER_ADMIN and
 * FEDERATION_ADMIN hold `role:grant`, so a STATE_ADMIN cannot approve a coach
 * in their own state. Whether state offices should be able to is a governance
 * decision MMAKF has not made. Widening it here would be this code inventing
 * one, so the queue reports the truth instead: a state administrator sees
 * nothing, and is told why.
 */
export function canReviewApplications(principal: Principal | null | undefined): boolean {
  return canAnywhere(principal, 'role:grant');
}

/**
 * Restrict application rows to the scopes a principal may confer roles in.
 *
 * Built as SQL and returned for the WHERE clause. `null` means national reach —
 * no restriction — and `sql\`false\`` means none, so a caller can never end up
 * with "no predicate" standing in for "everything".
 */
function applicationScopeCondition(principal: Principal): SQL | null {
  const scopes = visibleScopes(principal, 'role:grant');
  if (scopes.kind === 'all') return null;
  if (scopes.kind === 'none') return sql`false`;

  const parts: SQL[] = [];
  if (scopes.states.length) {
    parts.push(and(eq(s.roleApplications.scopeType, 'state'), inArray(s.roleApplications.scopeId, scopes.states)) as SQL);
  }
  if (scopes.districts.length) {
    parts.push(and(eq(s.roleApplications.scopeType, 'district'), inArray(s.roleApplications.scopeId, scopes.districts)) as SQL);
  }
  if (scopes.dojos.length) {
    parts.push(and(eq(s.roleApplications.scopeType, 'dojo'), inArray(s.roleApplications.scopeId, scopes.dojos)) as SQL);
  }
  // A scoped granter with no matching scope list sees nothing. Returning no
  // predicate here would mean "every application in the country", which is the
  // failure mode this function exists to make unrepresentable.
  if (!parts.length) return sql`false`;
  return (parts.length === 1 ? parts[0] : or(...parts)) as SQL;
}

export interface QueueOptions {
  /** Defaults to the open statuses. Pass explicitly to review decided ones. */
  statuses?: readonly string[];
  limit?: number;
}

export const MAX_QUEUE_ROWS = 200;

/**
 * Applications this principal may act on, filtered in SQL.
 *
 * Scoped by `role:grant`, because the only useful queue is one where every row
 * is a decision the reader could actually take. Rows outside the caller's scope
 * are excluded by the query, not hidden by the template — a template hides
 * things from a person and a query hides them from the process.
 */
export async function applicationQueue(db: DB, principal: Principal, opts: QueueOptions = {}) {
  if (!canReviewApplications(principal)) {
    throw new OnboardingError(
      'forbidden',
      'Reviewing role applications requires role:grant. Under the federation\'s current authority model ' +
      'that is held nationally; a scoped administrator holds no power to confer roles.'
    );
  }
  const limit = Math.max(1, Math.min(MAX_QUEUE_ROWS, Math.floor(opts.limit ?? 100)));
  const statuses = (opts.statuses?.length ? opts.statuses : OPEN_APPLICATION_STATUSES) as string[];

  const where: SQL[] = [inArray(s.roleApplications.status, statuses as any)];
  const scoped = applicationScopeCondition(principal);
  if (scoped) where.push(scoped);

  const rows = await db.select({
    id: s.roleApplications.id,
    ref: s.roleApplications.ref,
    applicantUserId: s.roleApplications.applicantUserId,
    applicantEmail: s.users.email,
    personId: s.roleApplications.personId,
    requestedRole: s.roleApplications.requestedRole,
    scopeType: s.roleApplications.scopeType,
    scopeId: s.roleApplications.scopeId,
    evidence: s.roleApplications.evidence,
    status: s.roleApplications.status,
    submittedAt: s.roleApplications.submittedAt,
  })
    .from(s.roleApplications)
    .innerJoin(s.users, eq(s.users.id, s.roleApplications.applicantUserId))
    .where(and(...where))
    .orderBy(s.roleApplications.submittedAt, s.roleApplications.id)
    .limit(limit + 1);

  return {
    rows: rows.slice(0, limit).map((r: any) => ({
      ...r,
      // Answered per row rather than assumed for the queue: a reviewer may hold
      // authority over one application and not the next, and a screen that
      // offers an Approve button it will then refuse teaches people to distrust
      // the system.
      canDecide: canGrantRole(principal, r.requestedRole as Role, { scopeType: r.scopeType, scopeId: r.scopeId ?? null }),
      evidenceRequirement: EVIDENCE_REQUIREMENTS_NOT_SET,
    })),
    truncated: rows.length > limit,
    turnaround: REVIEW_TURNAROUND_NOT_SET,
  };
}

/** One application, subject to exactly the same scope filter as the queue. */
export async function applicationDetail(db: DB, principal: Principal, applicationId: number) {
  if (!canReviewApplications(principal)) {
    throw new OnboardingError('forbidden', 'Reading the application queue requires role:grant.');
  }
  const where: SQL[] = [eq(s.roleApplications.id, applicationId)];
  const scoped = applicationScopeCondition(principal);
  if (scoped) where.push(scoped);

  const row = (await db.select().from(s.roleApplications).where(and(...where)).limit(1))[0];
  if (!row) throw new OnboardingError('not_found', 'No such application within your scope.');
  return {
    ...row,
    canDecide: canGrantRole(principal, row.requestedRole as Role, { scopeType: row.scopeType, scopeId: row.scopeId ?? null }),
    evidenceRequirement: EVIDENCE_REQUIREMENTS_NOT_SET,
  };
}

// ─── The decision ───────────────────────────────────────────────────────────

export type ApplicationDecision =
  | { decision: 'approve'; reason: string; expiresAt?: Date | null }
  | { decision: 'reject'; reason: string };

export interface DecisionResult {
  applicationId: number;
  status: 'approved' | 'rejected';
  /** The binding created, on an approval. Null on a rejection. */
  roleBindingId: number | null;
  /** Echoed back so a caller can prove the binding landed where the APPLICATION said. */
  boundAt: { role: Role; scopeType: ScopeType; scopeId: number | null } | null;
}

/**
 * Approve or reject an application.
 *
 * The order of the checks below is the security of the whole feature, so it is
 * spelled out rather than left to be inferred:
 *
 *   1. the application must still be open — a decided application is not
 *      re-decidable, and this is claimed with a conditional UPDATE rather than
 *      a read-then-write, so two reviewers pressing Approve at the same instant
 *      produce one binding and one loser who is told so;
 *   2. THE REVIEWER MUST NOT BE THE APPLICANT — including a SUPER_ADMIN, and
 *      including a rejection, because "reject your own" is a withdrawal wearing
 *      a reviewer's hat and there is a function for that;
 *   3. the role must still be one that may be applied for, checked again here
 *      rather than trusted from the row, because the row was written by an
 *      earlier version of this code and rows outlive code;
 *   4. canGrantRole() must permit the role AT THE APPLICATION'S SCOPE. This is
 *      the amplification gate. It is the same function an administrator's
 *      manual grant goes through, so the queue can never be a softer path to a
 *      binding than the console;
 *   5. a reason is required, for an approval as much as a rejection — a
 *      decision nobody can explain a year later is a decision the federation
 *      cannot defend, and the person who could explain it will have moved on.
 *
 * A REJECTION IS HELD TO THE SAME AUTHORITY AS AN APPROVAL: you may only refuse
 * what you could have granted. Otherwise anybody holding role:grant anywhere
 * could clear a queue of decisions that were never theirs to take.
 */
export async function reviewApplication(
  db: DB, ctx: AuditContext, applicationId: number, decision: ApplicationDecision
): Promise<DecisionResult> {
  const reviewerUserId = ctx.principal?.userId ?? null;
  const reason = String((decision as any)?.reason ?? '').trim();

  if (decision?.decision !== 'approve' && decision?.decision !== 'reject') {
    throw new OnboardingError('bad_decision', 'A decision must be "approve" or "reject".');
  }
  if (!reason) {
    throw new OnboardingError(
      'reason_required',
      'A decision on an application requires a recorded reason. Without one the record cannot answer ' +
      '"why was this refused?" a year later, and the answer leaves with whoever decided it.'
    );
  }

  const app = (await db.select().from(s.roleApplications)
    .where(eq(s.roleApplications.id, applicationId)).limit(1))[0];
  if (!app) throw new OnboardingError('not_found', 'No such application.');

  if (!(OPEN_APPLICATION_STATUSES as readonly string[]).includes(app.status)) {
    throw new OnboardingError('already_decided', `This application is already ${app.status}.`);
  }

  // NOBODY DECIDES THEIR OWN. Checked against identity, never against a flag a
  // caller could pass. Matches src/lib/approvals.ts, which refuses self-approval
  // for every role without exception including SUPER_ADMIN.
  if (reviewerUserId != null && reviewerUserId === app.applicantUserId) {
    throw new OnboardingError(
      'self_review',
      'An applicant cannot decide their own application, whatever authority they hold. ' +
      'Use withdrawApplication() to withdraw it, or ask another reviewer.'
    );
  }
  if (reviewerUserId == null) {
    // An unattributable decision cannot be checked against the applicant, so
    // the self-review rule above could not have fired. Refusing is the only
    // safe reading.
    throw new OnboardingError('anonymous_reviewer', 'A decision must be attributable to a signed-in reviewer.');
  }

  const role = app.requestedRole as Role;
  if (!isApplicableRole(role)) {
    throw new OnboardingError(
      'role_not_applicable',
      `${String(role)} is not a role that may be conferred through the application queue.`
    );
  }

  const target = { scopeType: app.scopeType as ScopeType, scopeId: (app.scopeId ?? null) as number | null };

  // THE AMPLIFICATION GATE. canGrantRole() refuses SUPER_ADMIN and
  // SAFEGUARDING_OFFICER except to a super admin, refuses any role holding an
  // action the reviewer does not themselves hold, and refuses a scope the
  // reviewer's own binding does not cover.
  if (!canGrantRole(ctx.principal, role, target)) {
    throw new OnboardingError(
      'cannot_grant',
      `You cannot confer ${role} at ${target.scopeType}${target.scopeId == null ? '' : ` ${target.scopeId}`}. ` +
      'A reviewer may only decide an application they could have granted: not a role more powerful than ' +
      'their own, and not outside their own scope.'
    );
  }

  const nextStatus = decision.decision === 'approve' ? 'approved' : 'rejected';

  return db.transaction(async (tx: DB) => {
    // CLAIM FIRST. The conditional WHERE is the concurrency control: whichever
    // of two simultaneous reviewers gets here first moves the row out of the
    // open statuses, and the second gets nothing back and stops. Doing the
    // grant first and the status second would let both create a binding.
    const claimed = await tx.update(s.roleApplications)
      .set({
        status: nextStatus,
        reviewedByUserId: reviewerUserId,
        reviewedAt: new Date(),
        decisionReason: reason,
        updatedAt: new Date(),
      })
      .where(and(
        eq(s.roleApplications.id, applicationId),
        inArray(s.roleApplications.status, [...OPEN_APPLICATION_STATUSES]),
      ))
      .returning({ id: s.roleApplications.id });

    if (!claimed.length) {
      throw new OnboardingError('already_decided', 'This application was decided by somebody else first.');
    }

    let roleBindingId: number | null = null;
    if (decision.decision === 'approve') {
      // THE SCOPE COMES FROM THE APPLICATION, not from the caller. There is no
      // parameter on this function that could put the binding anywhere else,
      // which is what stops a Jharkhand reviewer binding a national coach.
      const binding = await grantRole(tx, { ...ctx, reason }, {
        userId: app.applicantUserId,
        role,
        scopeType: target.scopeType,
        scopeId: target.scopeId,
        expiresAt: decision.expiresAt ?? null,
      });
      roleBindingId = binding.id;
    }

    await writeAudit(tx, { ...ctx, reason }, {
      entityType: 'role_application',
      entityId: applicationId,
      action: decision.decision === 'approve' ? 'approve' : 'reject',
      oldValue: { status: app.status },
      newValue: {
        status: nextStatus,
        role,
        scopeType: target.scopeType,
        scopeId: target.scopeId,
        roleBindingId,
      },
    });

    return {
      applicationId,
      status: nextStatus as 'approved' | 'rejected',
      roleBindingId,
      boundAt: decision.decision === 'approve'
        ? { role, scopeType: target.scopeType, scopeId: target.scopeId }
        : null,
    };
  });
}

/**
 * The actions a role would confer, for the review screen.
 *
 * A reviewer approving "REFEREE" should be shown what REFEREE can actually do
 * before they press the button. Re-exported from rbac rather than restated, so
 * the screen and the engine cannot disagree.
 */
export function actionsConferredBy(role: Role): Action[] {
  return actionsForRole(role);
}
