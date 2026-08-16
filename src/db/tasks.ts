// The federation's work queue.
//
// Every automation that needs a human ends here. "A school in Ranchi applied,
// somebody review it" is a task; so is "this coach's safeguarding clearance
// expires in three weeks" and "this ticket has gone unanswered".
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT governance.actionItems
// ─────────────────────────────────────────────────────────────────────────────
//
// `action_items` minutes a decision taken at a meeting and belongs to that
// meeting's resolution. This is the operational queue: it is created by
// machines, assigned to roles rather than named people, has a service clock,
// and escalates. Putting both in one table would mean the executive committee's
// minutes and the school-applications backlog share a status enum.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO DECISIONS WORTH KNOWING ABOUT
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. A TASK CAN BE ASSIGNED TO A ROLE, NOT ONLY TO A PERSON. The federation is
//    small and volunteers change; a task addressed to a departed administrator
//    is a task nobody does. Role assignment means the queue survives the
//    person, and `claimTask` is how an individual takes one on.
//
// 2. DEADLINES ARE NULL UNLESS THE FEDERATION SET ONE. There is no default of
//    "48 hours" anywhere in this file. A due date the federation never agreed
//    to is the system inventing a service commitment on its behalf, and the
//    first person embarrassed by it is whoever answers the telephone.

import { and, asc, desc, eq, inArray, isNull, isNotNull, lte, or, sql } from 'drizzle-orm';
import * as o from './operations.schema';
import { allocateFederationId, writeAudit, type AuditContext } from './federation';
import { isUniqueViolation } from './pgerror';
import {
  assertCanAnywhere, canAnywhere, visibleScopes,
  type Principal, type Role,
} from '@/lib/rbac';

type DB = any;

export class TaskError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TaskError';
    this.code = code;
  }
}

/** Shape check, not `instanceof` — see the note in src/lib/workflow.ts. */
export function isTaskError(err: unknown): err is TaskError {
  return !!err && typeof err === 'object' && (err as any).name === 'TaskError'
    && typeof (err as any).code === 'string';
}

export const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * The one place that says which transitions are legal.
 *
 * A `done` task cannot go back to `open`: reopening is a new task with a
 * dependency on the old one, so the record still says the first job was
 * finished and a second was needed. Editing the first to say it was never done
 * loses that.
 */
const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ['in_progress', 'blocked', 'done', 'cancelled'],
  in_progress: ['blocked', 'done', 'cancelled', 'open'],
  blocked: ['open', 'in_progress', 'cancelled'],
  done: [],
  cancelled: [],
};

// ─── Templates ──────────────────────────────────────────────────────────────

export interface TaskTemplateInput {
  code: string;
  title: string;
  description?: string | null;
  defaultRole?: Role | string | null;
  defaultPriority?: TaskPriority;
  dueInHours?: number | null;
  escalateAfterHours?: number | null;
  escalateToRole?: Role | string | null;
}

/**
 * Install a template, or update it in place if it already exists.
 *
 * Unlike workflow definitions, templates are NOT versioned. A template only
 * shapes tasks created after it — every task copies its title, deadline and
 * escalation target at creation time — so an edit cannot rewrite history the
 * way an edited fee rule or workflow could.
 */
export async function upsertTaskTemplate(db: DB, input: TaskTemplateInput) {
  const values = {
    code: input.code,
    title: input.title,
    description: input.description ?? null,
    defaultRole: (input.defaultRole as string) ?? null,
    defaultPriority: input.defaultPriority ?? 'normal',
    dueInHours: input.dueInHours ?? null,
    escalateAfterHours: input.escalateAfterHours ?? null,
    escalateToRole: (input.escalateToRole as string) ?? null,
    active: true,
  };

  const [row] = await db
    .insert(o.taskTemplates)
    .values(values)
    .onConflictDoUpdate({ target: o.taskTemplates.code, set: values })
    .returning();
  return row;
}

export async function taskTemplate(db: DB, code: string) {
  const [row] = await db
    .select().from(o.taskTemplates)
    .where(eq(o.taskTemplates.code, code)).limit(1);
  return row ?? null;
}

// ─── Creation ───────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  /** Use a template where one exists — it carries the deadline and escalation. */
  templateCode?: string | null;
  title?: string;
  detail?: string | null;
  subjectKind?: string | null;
  subjectId?: number | null;
  institutionId?: number | null;
  assignedRole?: Role | string | null;
  assignedUserId?: number | null;
  priority?: TaskPriority;
  /** Overrides the template. Null means no deadline, which is a real answer. */
  dueAt?: Date | null;
  /**
   * Makes creation repeatable.
   *
   * The unique index on this column is what stops a replayed workflow from
   * creating a second "review this application" task. Without it, the automation
   * engine's own retry would fill the queue with duplicates of the work it was
   * retrying.
   */
  idempotencyKey?: string | null;
  now?: Date;
}

export async function createTask(db: DB, ctx: AuditContext, input: CreateTaskInput) {
  const now = input.now ?? new Date();
  const tpl = input.templateCode ? await taskTemplate(db, input.templateCode) : null;

  if (input.templateCode && !tpl) {
    throw new TaskError('unknown_template', `No task template "${input.templateCode}".`);
  }
  if (tpl && tpl.active === false) {
    throw new TaskError('inactive_template', `Task template "${input.templateCode}" is switched off.`);
  }

  const title = input.title ?? tpl?.title;
  if (!title) throw new TaskError('missing_title', 'A task needs a title or a template that supplies one.');

  // Hours are copied from the template at creation, not read from it later:
  // changing a template must not silently move the deadline of work already
  // outstanding.
  const dueAt = input.dueAt !== undefined
    ? input.dueAt
    : tpl?.dueInHours != null
      ? new Date(now.getTime() + tpl.dueInHours * 3_600_000)
      : null;

  const escalateAt = tpl?.escalateAfterHours != null
    ? new Date(now.getTime() + tpl.escalateAfterHours * 3_600_000)
    : null;

  const ref = await allocateFederationId(db, 'TSK', now.getFullYear());

  const values = {
    ref,
    templateCode: input.templateCode ?? null,
    title,
    detail: input.detail ?? tpl?.description ?? null,
    subjectKind: input.subjectKind ?? null,
    subjectId: input.subjectId ?? null,
    institutionId: input.institutionId ?? null,
    assignedRole: (input.assignedRole as string) ?? tpl?.defaultRole ?? null,
    assignedUserId: input.assignedUserId ?? null,
    status: 'open' as const,
    priority: input.priority ?? (tpl?.defaultPriority as TaskPriority) ?? 'normal',
    dueAt,
    escalateAt,
    idempotencyKey: input.idempotencyKey ?? null,
    createdByUserId: ctx.principal.userId ?? null,
  };

  let row;
  try {
    [row] = await db.insert(o.tasks).values(values).returning();
  } catch (err) {
    // The duplicate is the SUCCESS case for a replayed automation, so it adopts
    // the existing task and reports it rather than failing the run. Note the
    // allocated `ref` is spent — reference numbers have gaps, which is correct:
    // a gap records that an allocation happened, and reusing numbers would make
    // them ambiguous.
    if (isUniqueViolation(err) && input.idempotencyKey) {
      const [existing] = await db
        .select().from(o.tasks)
        .where(eq(o.tasks.idempotencyKey, input.idempotencyKey)).limit(1);
      if (existing) return existing;
    }
    throw err;
  }

  await db.insert(o.taskEvents).values({
    taskId: row.id, kind: 'created', note: title,
    actorUserId: ctx.principal.userId ?? null, at: now,
  });

  await writeAudit(db, ctx, {
    entityType: 'task', entityId: row.id, action: 'create',
    newValue: { ref, title, assignedRole: values.assignedRole, dueAt },
  });

  return row;
}

// ─── Transitions ────────────────────────────────────────────────────────────

async function loadTask(db: DB, taskId: number) {
  const [row] = await db.select().from(o.tasks).where(eq(o.tasks.id, taskId)).limit(1);
  if (!row) throw new TaskError('not_found', `No task ${taskId}.`);
  return row;
}

/**
 * May this principal act on this task?
 *
 * Holding 'task:write' is necessary and not sufficient — the task must also be
 * one they can see. An institution-scoped user may only touch tasks belonging
 * to their own institution, which is what stops a school's coordinator closing
 * another school's work by guessing an id.
 */
function assertMayAct(principal: Principal, task: any) {
  assertCanAnywhere(principal, 'task:write');

  const scopes = visibleScopes(principal, 'task:write');
  if (scopes.kind === 'all') return;
  if (scopes.kind === 'none') throw new TaskError('forbidden', 'No authority over tasks.');

  if (task.institutionId != null && scopes.institutions.includes(task.institutionId)) return;
  if (task.assignedUserId != null && task.assignedUserId === principal.userId) return;

  const heldRoles = new Set(principal.bindings.map((b) => b.role as string));
  if (task.assignedRole && heldRoles.has(task.assignedRole)) return;

  throw new TaskError('forbidden', 'This task is outside your scope.');
}

async function transition(
  db: DB,
  ctx: AuditContext,
  taskId: number,
  to: TaskStatus,
  patch: Record<string, unknown>,
  note?: string | null,
  now: Date = new Date()
) {
  const task = await loadTask(db, taskId);
  assertMayAct(ctx.principal, task);

  const from = task.status as TaskStatus;
  if (from === to) return task;
  if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
    throw new TaskError(
      'bad_transition',
      `A task cannot go from ${from} to ${to}.` +
      (from === 'done' ? ' Raise a new task instead — reopening would erase the record that this one was finished.' : '')
    );
  }

  const [updated] = await db.update(o.tasks)
    .set({ status: to, updatedAt: now, ...patch })
    .where(and(eq(o.tasks.id, taskId), eq(o.tasks.status, from)))  // optimistic guard
    .returning();

  if (!updated) throw new TaskError('conflict', 'The task changed while you were working on it.');

  await db.insert(o.taskEvents).values({
    taskId, kind: to, note: note ?? null,
    actorUserId: ctx.principal.userId ?? null, at: now,
  });

  await writeAudit(db, ctx, {
    entityType: 'task', entityId: taskId, action: 'update',
    oldValue: { status: from }, newValue: { status: to, note: note ?? null },
  });

  return updated;
}

/** Take an unassigned or role-assigned task as your own. */
export async function claimTask(db: DB, ctx: AuditContext, taskId: number, now = new Date()) {
  const task = await loadTask(db, taskId);
  assertMayAct(ctx.principal, task);

  if (task.assignedUserId != null && task.assignedUserId !== ctx.principal.userId) {
    throw new TaskError('already_claimed', 'Somebody else already holds this task.');
  }

  const [updated] = await db.update(o.tasks)
    .set({ assignedUserId: ctx.principal.userId ?? null, status: 'in_progress', startedAt: now, updatedAt: now })
    .where(and(eq(o.tasks.id, taskId), or(isNull(o.tasks.assignedUserId), eq(o.tasks.assignedUserId, ctx.principal.userId ?? -1))))
    .returning();

  if (!updated) throw new TaskError('already_claimed', 'Somebody else claimed this task first.');

  await db.insert(o.taskEvents).values({
    taskId, kind: 'claimed', actorUserId: ctx.principal.userId ?? null, at: now,
  });
  return updated;
}

export async function startTask(db: DB, ctx: AuditContext, taskId: number, now = new Date()) {
  return transition(db, ctx, taskId, 'in_progress', { startedAt: now }, null, now);
}

export async function blockTask(db: DB, ctx: AuditContext, taskId: number, reason: string, now = new Date()) {
  if (!reason?.trim()) throw new TaskError('reason_required', 'Say why the task is blocked.');
  return transition(db, ctx, taskId, 'blocked', {}, reason, now);
}

export async function completeTask(
  db: DB, ctx: AuditContext, taskId: number, outcome?: string | null, now = new Date()
) {
  // Dependencies are checked here rather than at creation, because a task can
  // legitimately be created before the thing it waits on is finished.
  const deps = await db
    .select({ status: o.tasks.status, ref: o.tasks.ref })
    .from(o.taskDependencies)
    .innerJoin(o.tasks, eq(o.tasks.id, o.taskDependencies.dependsOnTaskId))
    .where(eq(o.taskDependencies.taskId, taskId));

  const outstanding = deps.filter((d: any) => d.status !== 'done' && d.status !== 'cancelled');
  if (outstanding.length) {
    throw new TaskError(
      'blocked_by_dependency',
      `Finish ${outstanding.map((d: any) => d.ref).join(', ')} first.`
    );
  }

  return transition(db, ctx, taskId, 'done', {
    completedAt: now,
    completedByUserId: ctx.principal.userId ?? null,
    outcome: outcome ?? null,
  }, outcome ?? null, now);
}

export async function cancelTask(db: DB, ctx: AuditContext, taskId: number, reason: string, now = new Date()) {
  if (!reason?.trim()) throw new TaskError('reason_required', 'Say why the task is being cancelled.');
  return transition(db, ctx, taskId, 'cancelled', { outcome: reason }, reason, now);
}

export async function addDependency(db: DB, ctx: AuditContext, taskId: number, dependsOnTaskId: number) {
  if (taskId === dependsOnTaskId) {
    throw new TaskError('self_dependency', 'A task cannot wait for itself.');
  }
  const task = await loadTask(db, taskId);
  assertMayAct(ctx.principal, task);
  await loadTask(db, dependsOnTaskId);

  // One level of cycle detection. A full graph walk is not warranted: task
  // chains here are two or three deep, and the pair check catches the mistake
  // that actually happens.
  const [reverse] = await db.select().from(o.taskDependencies)
    .where(and(
      eq(o.taskDependencies.taskId, dependsOnTaskId),
      eq(o.taskDependencies.dependsOnTaskId, taskId)
    )).limit(1);
  if (reverse) throw new TaskError('cycle', 'Those two tasks would wait for each other.');

  await db.insert(o.taskDependencies)
    .values({ taskId, dependsOnTaskId })
    .onConflictDoNothing();
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface QueueOptions {
  status?: TaskStatus | TaskStatus[];
  assignedRole?: string;
  assignedUserId?: number;
  institutionId?: number;
  subjectKind?: string;
  overdueOnly?: boolean;
  limit?: number;
  now?: Date;
}

export const MAX_QUEUE_ROWS = 200;

/**
 * The work queue, scope-filtered in SQL.
 *
 * The filter is built from `visibleScopes`, so a state administrator sees their
 * own institutions' tasks and a school coordinator sees only their own school's
 * — enforced in the WHERE clause rather than by discarding rows afterwards,
 * which is the difference between a filter and a leak with a filter over it.
 */
export async function taskQueue(db: DB, principal: Principal, opts: QueueOptions = {}) {
  assertCanAnywhere(principal, 'task:read');
  const now = opts.now ?? new Date();
  const scopes = visibleScopes(principal, 'task:read');
  if (scopes.kind === 'none') return [];

  const where: any[] = [];

  if (scopes.kind === 'scoped') {
    const mine: any[] = [];
    if (scopes.institutions.length) mine.push(inArray(o.tasks.institutionId, scopes.institutions));
    if (principal.userId != null) mine.push(eq(o.tasks.assignedUserId, principal.userId));
    const roles = [...new Set(principal.bindings.map((b) => b.role as string))];
    if (roles.length) mine.push(inArray(o.tasks.assignedRole, roles));
    // No basis for visibility at all → nothing, rather than everything.
    if (!mine.length) return [];
    where.push(or(...mine));
  }

  if (opts.status) {
    where.push(Array.isArray(opts.status)
      ? inArray(o.tasks.status, opts.status)
      : eq(o.tasks.status, opts.status));
  }
  if (opts.assignedRole) where.push(eq(o.tasks.assignedRole, opts.assignedRole));
  if (opts.assignedUserId != null) where.push(eq(o.tasks.assignedUserId, opts.assignedUserId));
  if (opts.institutionId != null) where.push(eq(o.tasks.institutionId, opts.institutionId));
  if (opts.subjectKind) where.push(eq(o.tasks.subjectKind, opts.subjectKind));
  if (opts.overdueOnly) {
    where.push(and(isNotNull(o.tasks.dueAt), lte(o.tasks.dueAt, now),
      inArray(o.tasks.status, ['open', 'in_progress', 'blocked'])));
  }

  const limit = Math.min(opts.limit ?? 50, MAX_QUEUE_ROWS);
  const q = db.select().from(o.tasks);
  return (where.length ? q.where(and(...where)) : q)
    .orderBy(
      // Urgent first, then by deadline. `NULLS LAST` matters: a task with no
      // deadline is not the most urgent thing in the federation, and the
      // default ordering would put every one of them at the top.
      desc(o.tasks.priority),
      sql`${o.tasks.dueAt} ASC NULLS LAST`,
      asc(o.tasks.id)
    )
    .limit(limit);
}

/** What one person owes, personally or through a role they hold. */
export async function myTasks(db: DB, principal: Principal, limit = 50) {
  if (!canAnywhere(principal, 'task:read')) return [];
  const roles = [...new Set(principal.bindings.map((b) => b.role as string))];
  const clauses: any[] = [];
  if (principal.userId != null) clauses.push(eq(o.tasks.assignedUserId, principal.userId));
  if (roles.length) {
    clauses.push(and(isNull(o.tasks.assignedUserId), inArray(o.tasks.assignedRole, roles)));
  }
  if (!clauses.length) return [];

  return db.select().from(o.tasks)
    .where(and(or(...clauses), inArray(o.tasks.status, ['open', 'in_progress', 'blocked'])))
    .orderBy(desc(o.tasks.priority), sql`${o.tasks.dueAt} ASC NULLS LAST`)
    .limit(Math.min(limit, MAX_QUEUE_ROWS));
}

export async function taskDetail(db: DB, principal: Principal, taskId: number) {
  assertCanAnywhere(principal, 'task:read');
  const task = await loadTask(db, taskId);

  const scopes = visibleScopes(principal, 'task:read');
  if (scopes.kind !== 'all') {
    const roles = new Set(principal.bindings.map((b) => b.role as string));
    const visible =
      (task.institutionId != null && scopes.kind === 'scoped' && scopes.institutions.includes(task.institutionId)) ||
      (task.assignedUserId != null && task.assignedUserId === principal.userId) ||
      (task.assignedRole && roles.has(task.assignedRole));
    if (!visible) throw new TaskError('forbidden', 'This task is outside your scope.');
  }

  const events = await db.select().from(o.taskEvents)
    .where(eq(o.taskEvents.taskId, taskId)).orderBy(asc(o.taskEvents.at));
  const dependencies = await db
    .select({ id: o.tasks.id, ref: o.tasks.ref, title: o.tasks.title, status: o.tasks.status })
    .from(o.taskDependencies)
    .innerJoin(o.tasks, eq(o.tasks.id, o.taskDependencies.dependsOnTaskId))
    .where(eq(o.taskDependencies.taskId, taskId));

  return { task, events, dependencies };
}

// ─── Escalation ─────────────────────────────────────────────────────────────

/**
 * Move unanswered work up. Run by the daily cron.
 *
 * Escalation RAISES THE PRIORITY AND CHANGES THE ROLE. It does not reassign to
 * a named person, because the point is that the named person did not act — and
 * handing it to another named person just moves the same failure sideways.
 *
 * `escalationLevel` increments rather than being a flag, so a task ignored
 * twice is visibly worse than one ignored once. The escalation clock is then
 * reset, so the next level is reached only after another full interval.
 */
export async function escalateOverdueTasks(
  db: DB,
  ctx: AuditContext,
  now: Date = new Date(),
  limit = 100
): Promise<{ escalated: number; refs: string[] }> {
  const due = await db.select().from(o.tasks)
    .where(and(
      inArray(o.tasks.status, ['open', 'in_progress', 'blocked']),
      isNotNull(o.tasks.escalateAt),
      lte(o.tasks.escalateAt, now)
    ))
    .orderBy(asc(o.tasks.escalateAt))
    .limit(limit);

  const refs: string[] = [];

  for (const task of due) {
    const tpl = task.templateCode ? await taskTemplate(db, task.templateCode) : null;
    const nextRole = tpl?.escalateToRole ?? task.assignedRole;

    const nextPriority: TaskPriority =
      task.priority === 'urgent' ? 'urgent'
      : task.priority === 'high' ? 'urgent'
      : task.priority === 'normal' ? 'high'
      : 'normal';

    const nextEscalateAt = tpl?.escalateAfterHours != null
      ? new Date(now.getTime() + tpl.escalateAfterHours * 3_600_000)
      : null;

    const [updated] = await db.update(o.tasks).set({
      escalationLevel: sql`${o.tasks.escalationLevel} + 1`,
      escalatedAt: now,
      escalateAt: nextEscalateAt,
      assignedRole: nextRole,
      // Clearing the holder is the point: the person who had it did not act, so
      // it returns to the role queue where somebody else can pick it up.
      assignedUserId: null,
      priority: nextPriority,
      updatedAt: now,
    }).where(and(eq(o.tasks.id, task.id), eq(o.tasks.escalationLevel, task.escalationLevel)))
      .returning();

    if (!updated) continue;   // another sweep got there first

    await db.insert(o.taskEvents).values({
      taskId: task.id, kind: 'escalated',
      note: `Level ${updated.escalationLevel}; now with ${nextRole ?? 'the unassigned queue'}.`,
      actorUserId: null, at: now,
    });

    await writeAudit(db, ctx, {
      entityType: 'task', entityId: task.id, action: 'update',
      oldValue: { escalationLevel: task.escalationLevel, priority: task.priority },
      newValue: { escalationLevel: updated.escalationLevel, priority: nextPriority, assignedRole: nextRole },
    });

    refs.push(task.ref);
  }

  return { escalated: refs.length, refs };
}

// ─── Counts for the command centre ──────────────────────────────────────────

export async function taskCounts(db: DB, principal: Principal, now = new Date()) {
  if (!canAnywhere(principal, 'task:read')) {
    return { open: 0, overdue: 0, escalated: 0, unassigned: 0 };
  }
  const rows = await taskQueue(db, principal, { limit: MAX_QUEUE_ROWS, now });
  const live = rows.filter((t: any) => t.status === 'open' || t.status === 'in_progress' || t.status === 'blocked');
  return {
    open: live.length,
    overdue: live.filter((t: any) => t.dueAt && new Date(t.dueAt) <= now).length,
    escalated: live.filter((t: any) => (t.escalationLevel ?? 0) > 0).length,
    unassigned: live.filter((t: any) => t.assignedUserId == null).length,
  };
}
