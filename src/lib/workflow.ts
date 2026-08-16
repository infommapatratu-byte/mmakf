// The MMAKF automation engine.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT PROBLEM THIS SOLVES
// ─────────────────────────────────────────────────────────────────────────────
//
// A school fills in the application wizard. Twelve things must then happen: an
// institution record, a lead, an owner, a task, an acknowledgement, an SLA
// clock, a timeline entry, and so on. Written inline at the end of the submit
// handler, those twelve things have three problems that only appear in
// production:
//
//   1. The eighth one fails. The first seven already happened — including an
//      email that is now in someone's inbox — so there is nothing to roll back
//      to, and nothing records how far it got.
//   2. The applicant double-clicks Submit, or a retry fires, and the school
//      gets two institutions, two leads and two acknowledgement emails.
//   3. Nobody can answer "what did the system do on our behalf?" without
//      reading TypeScript.
//
// So automations are RUNS with STEPS: each step's outcome is recorded whether
// it worked or not, the whole run carries an idempotency key the database
// enforces, and a failed run resumes from the first step that has not yet
// succeeded rather than starting over.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY ACTIONS ARE CODE AND WORKFLOWS ARE DATA
// ─────────────────────────────────────────────────────────────────────────────
//
// `workflow_definitions` is a table, so the federation can see and disable an
// automation without a deployment. The ACTIONS a step may call are a registry
// in TypeScript, because an action definable through the admin console would be
// a remote code execution feature with a nice form around it.
//
// An action name that is not in the registry FAILS THE STEP. It is never
// ignored: a workflow that quietly skips the step nobody implemented is a
// workflow that reports success while doing nothing.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS MODULE IMPORTS NO DOMAIN LOGIC
// ─────────────────────────────────────────────────────────────────────────────
//
// The registry is passed in. src/db/automations.ts builds it from the domain
// modules and re-exports a bound `dispatch`. Keeping the engine free of domain
// imports is what stops the cycle — applications.ts needs the engine, and the
// engine's actions need applications.ts.

import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import * as o from '@/db/operations.schema';
import type { AuditContext } from '@/db/federation';

type DB = any; // drizzle client (postgres.js in prod, PGlite in tests)

// ─── Errors ─────────────────────────────────────────────────────────────────

export class WorkflowError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
  }
}

/**
 * Identity by SHAPE, not `instanceof`.
 *
 * Vite gives the server bundle and a test's import of the same module separate
 * class objects, so `err instanceof WorkflowError` is false for an error this
 * very module threw. That has already cost this project a debugging session in
 * calendar.ts; the same check is used for fee, membership and engagement
 * errors.
 */
export function isWorkflowError(err: unknown): err is WorkflowError {
  return !!err && typeof err === 'object' && (err as any).name === 'WorkflowError'
    && typeof (err as any).code === 'string';
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

export interface ActionContext {
  db: DB;
  /** The run this step belongs to, for correlating anything it writes. */
  run: {
    id: number;
    code: string;
    trigger: string;
    subjectKind: string | null;
    subjectId: number | null;
  };
  /** The trigger payload — what the world told us. Never mutated by a step. */
  context: Record<string, unknown>;
  /**
   * Results of earlier steps, keyed by action name.
   *
   * This is how step 3 uses the institution step 1 created without either of
   * them knowing about the other. It is rebuilt on a resumed run from the
   * recorded step results, so a resume sees exactly what the first attempt saw.
   */
  state: Record<string, unknown>;
  actor: AuditContext;
  now: Date;
}

export type ActionHandler = (
  ctx: ActionContext,
  params: Record<string, unknown>
) => Promise<unknown>;

export type ActionRegistry = Record<string, ActionHandler>;

export interface StepSpec {
  action: string;
  params?: Record<string, unknown>;
  /** Skip this step unless the condition holds. Absent means always run. */
  when?: unknown;
  /**
   * A step that may fail without failing the run.
   *
   * Use sparingly and only for genuinely optional effects. An optional step
   * still records its failure — "optional" means the run continues, not that
   * nobody is told.
   */
  optional?: boolean;
}

export interface WorkflowSpec {
  steps: StepSpec[];
  maxAttempts?: number;
}

export interface RunOutcome {
  runId: number | null;
  status: 'succeeded' | 'partially_failed' | 'failed' | 'skipped';
  /** Set when nothing ran, saying which of the several reasons applied. */
  skipReason?: 'already_succeeded' | 'in_progress' | 'attempts_exhausted' | 'no_definition';
  steps: Array<{ seq: number; action: string; status: string; error?: string }>;
  state: Record<string, unknown>;
}

// ─── Conditions ─────────────────────────────────────────────────────────────

/**
 * Read a dotted path out of the context/state.
 *
 * Returns `undefined` for a missing path rather than throwing, so that a
 * condition on an absent field is *false* rather than an error — an enquiry
 * that never stated a participant count should simply not match a rule about
 * large cohorts.
 */
export function readPath(source: unknown, path: string): unknown {
  if (!path) return undefined;
  let cur: any = source;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

const OPS = new Set([
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'present', 'absent', 'truthy', 'falsy',
]);

/**
 * Evaluate a condition. FAILS CLOSED, and loudly.
 *
 * An unrecognised operator or malformed shape THROWS rather than returning
 * false. Returning false would mean a typo in a condition silently disables the
 * step it guards — the automation reports success, the school is never
 * acknowledged, and nothing anywhere says why. A throw marks the step failed
 * and puts it in the retry queue where somebody sees it.
 */
export function evaluateCondition(cond: unknown, scope: Record<string, unknown>): boolean {
  if (cond === undefined || cond === null) return true;
  if (typeof cond !== 'object') {
    throw new WorkflowError('bad_condition', `Condition must be an object, got ${typeof cond}.`);
  }

  const c = cond as Record<string, unknown>;

  if (Array.isArray(c.all)) return (c.all as unknown[]).every((x) => evaluateCondition(x, scope));
  if (Array.isArray(c.any)) return (c.any as unknown[]).some((x) => evaluateCondition(x, scope));
  if (c.not !== undefined) return !evaluateCondition(c.not, scope);

  const path = c.path;
  const op = c.op;
  if (typeof path !== 'string' || typeof op !== 'string') {
    throw new WorkflowError('bad_condition', 'Condition needs a string `path` and `op`.');
  }
  if (!OPS.has(op)) {
    throw new WorkflowError('bad_condition', `Unknown condition operator "${op}".`);
  }

  const actual = readPath(scope, path);
  const expected = c.value;

  switch (op) {
    case 'present': return actual !== undefined && actual !== null;
    case 'absent':  return actual === undefined || actual === null;
    case 'truthy':  return !!actual;
    case 'falsy':   return !actual;
    case 'eq':      return actual === expected;
    case 'ne':      return actual !== expected;
    case 'in':      return Array.isArray(expected) && expected.includes(actual as never);
    case 'nin':     return Array.isArray(expected) && !expected.includes(actual as never);
    default: break;
  }

  // Ordered comparisons need both sides to be numbers. A missing value is not
  // "less than 50" — it is unknown, and unknown must not match.
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  switch (op) {
    case 'gt':  return actual > expected;
    case 'gte': return actual >= expected;
    case 'lt':  return actual < expected;
    case 'lte': return actual <= expected;
    default:    return false;
  }
}

// ─── Retry timing ───────────────────────────────────────────────────────────

/**
 * Backoff before the next attempt: 1 minute, then 5, then 25, capped at an hour.
 *
 * Deliberately not seconds. Everything this engine retries is either a database
 * write that failed because something was briefly unavailable, or a
 * notification to a human — and a human does not benefit from being emailed
 * four seconds sooner.
 */
export function backoffMs(attempt: number): number {
  const minutes = Math.min(60, 1 * Math.pow(5, Math.max(0, attempt - 1)));
  return minutes * 60_000;
}

// ─── Running ────────────────────────────────────────────────────────────────

export interface RunRequest {
  code: string;
  trigger: string;
  spec: WorkflowSpec;
  idempotencyKey: string;
  subjectKind?: string | null;
  subjectId?: number | null;
  context?: Record<string, unknown>;
  version?: number;
  actor: AuditContext;
  now?: Date;
}

/**
 * Claim a run, creating it if this is the first sighting of the key.
 *
 * The unique index on idempotency_key is what makes this safe under
 * concurrency: two workers racing on the same key both attempt the insert, one
 * wins, and the loser falls through to the claim UPDATE. There is no read-then-
 * write window in which both could decide they are first.
 *
 * The claim is an UPDATE guarded on the current status, so a run another worker
 * is already executing cannot be picked up twice.
 */
async function claimRun(db: DB, req: RunRequest, now: Date) {
  const maxAttempts = req.spec.maxAttempts ?? 3;

  await db.insert(o.workflowRuns).values({
    workflowCode: req.code,
    workflowVersion: req.version ?? 1,
    trigger: req.trigger,
    subjectKind: req.subjectKind ?? null,
    subjectId: req.subjectId ?? null,
    idempotencyKey: req.idempotencyKey,
    status: 'pending',
    attempt: 0,
    maxAttempts,
    context: req.context ?? {},
  }).onConflictDoNothing({ target: o.workflowRuns.idempotencyKey });

  const claimed = await db
    .update(o.workflowRuns)
    .set({
      status: 'running',
      attempt: sql`${o.workflowRuns.attempt} + 1`,
      startedAt: now,
      nextAttemptAt: null,
    })
    .where(and(
      eq(o.workflowRuns.idempotencyKey, req.idempotencyKey),
      // Not already done, not held by someone else, not out of attempts.
      inArray(o.workflowRuns.status, ['pending', 'failed', 'partially_failed']),
      sql`${o.workflowRuns.attempt} < ${o.workflowRuns.maxAttempts}`
    ))
    .returning();

  if (claimed.length) return { run: claimed[0], skipReason: undefined as RunOutcome['skipReason'] };

  const [existing] = await db
    .select()
    .from(o.workflowRuns)
    .where(eq(o.workflowRuns.idempotencyKey, req.idempotencyKey))
    .limit(1);

  if (!existing) throw new WorkflowError('claim_failed', 'Run vanished between insert and claim.');
  if (existing.status === 'succeeded') return { run: existing, skipReason: 'already_succeeded' as const };
  if (existing.status === 'running') return { run: existing, skipReason: 'in_progress' as const };
  return { run: existing, skipReason: 'attempts_exhausted' as const };
}

/**
 * Execute a workflow.
 *
 * Returns rather than throws for a failed run. A caller submitting a school
 * application must not receive a 500 because the fourth automation step could
 * not reach the notification service — the application is stored, the run is
 * recorded as failed, and the retry sweep will finish the job.
 */
export async function runWorkflow(
  db: DB,
  registry: ActionRegistry,
  req: RunRequest
): Promise<RunOutcome> {
  const now = req.now ?? new Date();
  const { run, skipReason } = await claimRun(db, req, now);

  if (skipReason) {
    return { runId: run.id, status: 'skipped', skipReason, steps: [], state: {} };
  }

  // A resumed run must see what the first attempt saw, so state is rebuilt from
  // the steps that already succeeded rather than starting empty.
  const priorSteps = await db
    .select()
    .from(o.workflowSteps)
    .where(eq(o.workflowSteps.runId, run.id))
    .orderBy(asc(o.workflowSteps.seq));

  const succeeded = new Map<number, any>();
  for (const st of priorSteps) {
    if (st.status === 'succeeded' || st.status === 'skipped') succeeded.set(st.seq, st);
  }

  const state: Record<string, unknown> = {};
  for (const st of priorSteps) {
    if (st.status === 'succeeded' && st.result !== null && st.result !== undefined) {
      state[st.action] = (st.result as any)?.value ?? st.result;
    }
  }

  const context = (run.context ?? req.context ?? {}) as Record<string, unknown>;
  const outcome: RunOutcome['steps'] = [];
  let failed = false;
  let anySucceeded = succeeded.size > 0;
  let firstError: string | null = null;

  for (let seq = 0; seq < req.spec.steps.length; seq++) {
    const step = req.spec.steps[seq];

    if (succeeded.has(seq)) {
      outcome.push({ seq, action: step.action, status: 'already_done' });
      continue;
    }

    // Once a step has failed, later steps do not run: they were written
    // expecting it. Recording them as 'blocked' rather than leaving no row is
    // what makes the resume point unambiguous.
    if (failed) {
      await db.insert(o.workflowSteps).values({
        runId: run.id, seq, action: step.action, status: 'blocked',
        attempt: run.attempt, params: (step.params ?? {}) as any,
      });
      outcome.push({ seq, action: step.action, status: 'blocked' });
      continue;
    }

    const startedAt = new Date();
    const scope = { ...context, ...state, context, state };

    try {
      if (step.when !== undefined && !evaluateCondition(step.when, scope)) {
        await db.insert(o.workflowSteps).values({
          runId: run.id, seq, action: step.action, status: 'skipped',
          attempt: run.attempt, params: (step.params ?? {}) as any,
          startedAt, finishedAt: new Date(),
        });
        outcome.push({ seq, action: step.action, status: 'skipped' });
        continue;
      }

      const handler = registry[step.action];
      if (!handler) {
        throw new WorkflowError(
          'unknown_action',
          `No handler registered for action "${step.action}".`
        );
      }

      const result = await handler(
        {
          db,
          run: {
            id: run.id,
            code: run.workflowCode,
            trigger: run.trigger,
            subjectKind: run.subjectKind,
            subjectId: run.subjectId,
          },
          context,
          state,
          actor: req.actor,
          now,
        },
        (step.params ?? {}) as Record<string, unknown>
      );

      state[step.action] = result;
      anySucceeded = true;

      await db.insert(o.workflowSteps).values({
        runId: run.id, seq, action: step.action, status: 'succeeded',
        attempt: run.attempt, params: (step.params ?? {}) as any,
        result: { value: result ?? null } as any,
        startedAt, finishedAt: new Date(),
      });
      outcome.push({ seq, action: step.action, status: 'succeeded' });
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 2000);
      await db.insert(o.workflowSteps).values({
        runId: run.id, seq, action: step.action,
        status: step.optional ? 'failed_optional' : 'failed',
        attempt: run.attempt, params: (step.params ?? {}) as any,
        error: message, startedAt, finishedAt: new Date(),
      });
      outcome.push({ seq, action: step.action, status: step.optional ? 'failed_optional' : 'failed', error: message });

      if (!step.optional) {
        failed = true;
        firstError = message;
      }
    }
  }

  const attempt = run.attempt as number;
  const maxAttempts = run.maxAttempts as number;
  const exhausted = attempt >= maxAttempts;

  // 'partially_failed' is a distinct state, not a nicety. It says some effects
  // DID happen — an institution exists, an email went out — which is exactly
  // what an operator needs to know before deciding whether to re-run or to
  // finish the remaining steps by hand.
  const status: RunOutcome['status'] = !failed
    ? 'succeeded'
    : anySucceeded
      ? 'partially_failed'
      : 'failed';

  await db.update(o.workflowRuns).set({
    status,
    finishedAt: new Date(),
    error: firstError,
    result: { steps: outcome } as any,
    nextAttemptAt: failed && !exhausted ? new Date(now.getTime() + backoffMs(attempt)) : null,
  }).where(eq(o.workflowRuns.id, run.id));

  return { runId: run.id, status, steps: outcome, state };
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

export interface DispatchRequest {
  trigger: string;
  idempotencyKey: string;
  subjectKind?: string | null;
  subjectId?: number | null;
  context?: Record<string, unknown>;
  actor: AuditContext;
  now?: Date;
}

/**
 * Run every active workflow registered against a trigger.
 *
 * A trigger with no definition returns `[]` and is NOT an error: the federation
 * may legitimately have switched an automation off, and the submit handler that
 * fired the trigger has no opinion about whether one exists.
 *
 * The idempotency key is suffixed per workflow, so two automations on the same
 * event do not collide on one key — which would silently run only the first.
 */
export async function dispatch(
  db: DB,
  registry: ActionRegistry,
  req: DispatchRequest
): Promise<RunOutcome[]> {
  const defs = await db
    .select()
    .from(o.workflowDefinitions)
    .where(and(
      eq(o.workflowDefinitions.trigger, req.trigger),
      eq(o.workflowDefinitions.active, true)
    ))
    .orderBy(asc(o.workflowDefinitions.code), asc(o.workflowDefinitions.version));

  if (!defs.length) return [];

  // Only the highest active version of each code runs. Two versions of the same
  // automation both firing would double every effect it has.
  const latest = new Map<string, any>();
  for (const d of defs) {
    const prev = latest.get(d.code);
    if (!prev || d.version > prev.version) latest.set(d.code, d);
  }

  const results: RunOutcome[] = [];
  for (const def of latest.values()) {
    const spec = def.definition as WorkflowSpec;
    if (!spec || !Array.isArray(spec.steps)) {
      results.push({
        runId: null, status: 'failed', steps: [],
        state: { error: `Workflow ${def.code} has no steps array.` },
      });
      continue;
    }
    results.push(await runWorkflow(db, registry, {
      code: def.code,
      trigger: req.trigger,
      spec,
      version: def.version,
      idempotencyKey: `${req.idempotencyKey}:${def.code}:${def.version}`,
      subjectKind: req.subjectKind,
      subjectId: req.subjectId,
      context: req.context,
      actor: req.actor,
      now: req.now,
    }));
  }
  return results;
}

// ─── Retry sweep ────────────────────────────────────────────────────────────

/**
 * Re-run failed workflows whose backoff has elapsed. Called by the daily cron.
 *
 * Reads the DEFINITION again rather than trusting the run's stored spec, so a
 * workflow corrected after a failure is retried in its corrected form. That is
 * the point of retrying at all: the usual reason a step failed is that
 * something was wrong, and something was then fixed.
 */
export async function sweepRetries(
  db: DB,
  registry: ActionRegistry,
  actor: AuditContext,
  now: Date = new Date(),
  limit = 50
): Promise<{ attempted: number; succeeded: number; stillFailing: number }> {
  const due = await db
    .select()
    .from(o.workflowRuns)
    .where(and(
      inArray(o.workflowRuns.status, ['failed', 'partially_failed']),
      sql`${o.workflowRuns.attempt} < ${o.workflowRuns.maxAttempts}`,
      or(isNull(o.workflowRuns.nextAttemptAt), lte(o.workflowRuns.nextAttemptAt, now))
    ))
    .orderBy(asc(o.workflowRuns.nextAttemptAt))
    .limit(limit);

  let succeeded = 0;
  let stillFailing = 0;

  for (const run of due) {
    const [def] = await db
      .select()
      .from(o.workflowDefinitions)
      .where(and(
        eq(o.workflowDefinitions.code, run.workflowCode),
        eq(o.workflowDefinitions.version, run.workflowVersion)
      ))
      .limit(1);

    if (!def) {
      // The definition was deleted under a failed run. Retrying is impossible
      // and pretending otherwise would leave it in the queue for ever.
      await db.update(o.workflowRuns).set({
        status: 'failed',
        nextAttemptAt: null,
        error: `Workflow definition ${run.workflowCode} v${run.workflowVersion} no longer exists.`,
      }).where(eq(o.workflowRuns.id, run.id));
      stillFailing++;
      continue;
    }

    const result = await runWorkflow(db, registry, {
      code: run.workflowCode,
      trigger: run.trigger,
      spec: def.definition as WorkflowSpec,
      version: run.workflowVersion,
      idempotencyKey: run.idempotencyKey,
      subjectKind: run.subjectKind,
      subjectId: run.subjectId,
      context: (run.context ?? {}) as Record<string, unknown>,
      actor,
      now,
    });

    if (result.status === 'succeeded') succeeded++;
    else stillFailing++;
  }

  return { attempted: due.length, succeeded, stillFailing };
}

// ─── Authoring ──────────────────────────────────────────────────────────────

/**
 * Install or update a workflow definition.
 *
 * A changed definition becomes a NEW VERSION rather than editing the existing
 * row, so a run that failed under v1 is retried under v1 and the history says
 * which shape of the automation actually ran. Same reasoning as published fee
 * frameworks and superseded rank records.
 */
export async function installWorkflow(
  db: DB,
  def: {
    code: string;
    title: string;
    trigger: string;
    description?: string | null;
    spec: WorkflowSpec;
    createdByUserId?: number | null;
  }
): Promise<{ code: string; version: number; changed: boolean }> {
  if (!Array.isArray(def.spec?.steps) || def.spec.steps.length === 0) {
    throw new WorkflowError('empty_workflow', `Workflow ${def.code} must define at least one step.`);
  }

  const existing = await db
    .select()
    .from(o.workflowDefinitions)
    .where(eq(o.workflowDefinitions.code, def.code))
    .orderBy(asc(o.workflowDefinitions.version));

  const current = existing[existing.length - 1];
  if (current && JSON.stringify(current.definition) === JSON.stringify(def.spec)
      && current.trigger === def.trigger && current.active) {
    return { code: def.code, version: current.version, changed: false };
  }

  const version = current ? current.version + 1 : 1;

  // Older versions stop firing, but their rows stay: a failed run still needs
  // the definition it ran under in order to be retried faithfully.
  if (current) {
    await db.update(o.workflowDefinitions)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(o.workflowDefinitions.code, def.code));
  }

  await db.insert(o.workflowDefinitions).values({
    code: def.code,
    title: def.title,
    description: def.description ?? null,
    trigger: def.trigger,
    version,
    active: true,
    definition: def.spec as any,
    createdByUserId: def.createdByUserId ?? null,
  });

  return { code: def.code, version, changed: true };
}
