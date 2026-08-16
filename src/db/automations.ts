// Where the automation engine meets the federation's actual work.
//
// src/lib/workflow.ts is a general engine that knows nothing about karate. This
// file supplies the two things it needs: the ACTIONS a step may perform, and
// the WORKFLOWS the federation runs. It is also the only module that imports
// both the engine and the domain, which is what keeps the cycle out of both.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY ACTION IS IDEMPOTENT
// ─────────────────────────────────────────────────────────────────────────────
//
// Not "usually safe to re-run" — idempotent, by a database constraint:
//
//   create_task          tasks.idempotency_key      unique
//   send_message         notifications.dedupe_key   unique
//   record_event         domain_events correlation  checked before insert
//
// The keys are derived from the run and the step, so the SECOND attempt of step
// 3 computes the same key as the first and the insert is refused rather than
// duplicated. Without this the retry that exists to finish a half-done
// automation would instead double everything the automation already did.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as o from './operations.schema';
import * as g from './governance.schema';
import * as e from './engagement.schema';
import * as s from './schema';
import {
  dispatch as engineDispatch,
  runWorkflow as engineRun,
  sweepRetries as engineSweep,
  installWorkflow,
  type ActionRegistry,
  type ActionContext,
  type RunOutcome,
  type WorkflowSpec,
} from '@/lib/workflow';
import { render as renderTemplate } from '@/lib/email-templates';
import { publish as publishDomainEvent } from '@/lib/domain-events';
import { createTask, upsertTaskTemplate, escalateOverdueTasks } from './tasks';
import {
  submitApplication, systemIntakeContext, submitIndividualEnquiry,
  type SubmitInput, type SubmitResult,
  type IndividualSubmitInput, type IndividualSubmitResult,
} from './applications';
import { applyAsCoach, recommendCoaches, type CoachApplyInput } from './coaches';
import { isUniqueViolation } from './pgerror';
import type { AuditContext } from './federation';

type DB = any;

const PUBLIC_ORIGIN = 'https://www.mmakf.in';
const LEARN_ORIGIN = 'https://learn.mmakf.in';

/** A stable key for one step of one run. See the header. */
function stepKey(ctx: ActionContext, suffix: string): string {
  return `wf:${ctx.run.id}:${suffix}`;
}

function str(params: Record<string, unknown>, key: string, fallback?: string): string {
  const v = params[key];
  if (v === undefined || v === null || String(v).trim() === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Workflow step is missing the parameter "${key}".`);
  }
  return String(v);
}

/**
 * Resolve a value that may be a literal or a reference into the run context.
 *
 * `{ from: 'application.id' }` reads the path; anything else is used as given.
 * This is what lets a stored workflow definition refer to the record an earlier
 * step created without the definition containing code.
 */
function resolve(ctx: ActionContext, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'from' in (value as any)) {
    const path = String((value as any).from);
    const scope: Record<string, unknown> = { ...ctx.context, ...ctx.state, context: ctx.context, state: ctx.state };
    let cur: any = scope;
    for (const part of path.split('.')) {
      if (cur == null || typeof cur !== 'object') return undefined;
      cur = cur[part];
    }
    return cur;
  }
  return value;
}

// ─── The actions ────────────────────────────────────────────────────────────

export const ACTIONS: ActionRegistry = {
  /**
   * Append to an application's timeline.
   *
   * `visibleToApplicant` decides whether the school reads it. Defaults to
   * FALSE: an automation writing to a customer-facing timeline by default is an
   * automation that will one day publish "duplicate suspected, check before
   * acting" to the duplicate in question.
   */
  async record_timeline(ctx, params) {
    const applicationId = Number(resolve(ctx, params.applicationId ?? { from: 'applicationId' }));
    if (!Number.isFinite(applicationId)) throw new Error('record_timeline needs an applicationId.');

    const [row] = await ctx.db.insert(o.applicationEvents).values({
      applicationId,
      at: ctx.now,
      kind: str(params, 'kind'),
      summary: str(params, 'summary'),
      detail: (params.detail ?? null) as any,
      visibleToApplicant: params.visibleToApplicant === true,
    }).returning();
    return { applicationEventId: row.id };
  },

  /** Create a piece of work for a human. Idempotent on the step key. */
  async create_task(ctx, params) {
    const task = await createTask(ctx.db, ctx.actor, {
      templateCode: (params.templateCode as string) ?? null,
      title: (params.title as string) ?? undefined,
      detail: (params.detail as string) ?? null,
      subjectKind: (params.subjectKind as string) ?? ctx.run.subjectKind,
      subjectId: Number(resolve(ctx, params.subjectId ?? ctx.run.subjectId)) || null,
      institutionId: Number(resolve(ctx, params.institutionId ?? { from: 'institutionId' })) || null,
      assignedRole: (resolve(ctx, params.assignedRole ?? { from: 'ownerRole' }) as string) ?? null,
      assignedUserId: Number(resolve(ctx, params.assignedUserId ?? { from: 'ownerUserId' })) || null,
      priority: (params.priority as any) ?? undefined,
      idempotencyKey: stepKey(ctx, `task:${params.templateCode ?? params.title ?? 'task'}`),
      now: ctx.now,
    });
    return { taskId: task.id, taskRef: task.ref };
  },

  /**
   * Queue a message.
   *
   * QUEUE, not send: MMAKF has no mail provider configured. The row is created
   * with status 'queued' and the drain job will send it the day one exists. See
   * the header of src/lib/email-templates.ts for why this is not hidden behind
   * a sendEmail() that returns success.
   */
  async send_message(ctx, params) {
    const templateKey = str(params, 'template');
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((params.values ?? {}) as Record<string, unknown>)) {
      values[k] = resolve(ctx, v);
    }

    const rendered = renderTemplate(templateKey, values);

    const recipientEmail = resolve(ctx, params.to ?? { from: 'contactEmail' });
    const recipientName = resolve(ctx, params.toName ?? { from: 'contactName' });
    const userId = Number(resolve(ctx, params.userId)) || null;
    const personId = Number(resolve(ctx, params.personId)) || null;

    if (!recipientEmail && !userId && !personId) {
      throw new Error(`send_message(${templateKey}) has nobody to address.`);
    }

    try {
      const [row] = await ctx.db.insert(g.notifications).values({
        personId,
        userId,
        channel: (params.channel as string) ?? 'email',
        title: rendered.subject,
        body: rendered.text,
        linkUrl: (resolve(ctx, params.linkUrl) as string) ?? null,
        recipientEmail: recipientEmail ? String(recipientEmail) : null,
        recipientName: recipientName ? String(recipientName) : null,
        template: templateKey,
        payload: values as any,
        topic: rendered.topic,
        priority: (params.priority as string) ?? 'normal',
        institutionId: Number(resolve(ctx, params.institutionId)) || null,
        dedupeKey: stepKey(ctx, `msg:${templateKey}`),
        status: 'queued',
      }).returning();
      return { notificationId: row.id, subject: rendered.subject, status: 'queued' };
    } catch (err) {
      // Already queued by an earlier attempt of this same step. That is the
      // success case for a retry, not a failure.
      if (isUniqueViolation(err)) return { deduplicated: true, subject: rendered.subject };
      throw err;
    }
  },

  /**
   * Tell everyone holding a role.
   *
   * Resolves the role to the users actually bound to it right now, rather than
   * addressing a mailbox. A role with nobody in it produces NO notifications
   * and says so in the result — silently succeeding would mean the federation
   * believes an administrator was told when nobody was.
   */
  async notify_role(ctx, params) {
    const role = str(params, 'role');
    const holders = await ctx.db
      .select({ userId: s.roleBindings.userId })
      .from(s.roleBindings)
      .where(and(
        eq(s.roleBindings.role, role),
        eq(s.roleBindings.status, 'active')
      ));

    if (!holders.length) {
      return { notified: 0, role, note: `Nobody currently holds ${role}; the task remains in the role queue.` };
    }

    const ids: number[] = [];
    for (const h of holders) {
      try {
        const [row] = await ctx.db.insert(g.notifications).values({
          userId: h.userId,
          channel: 'in_app',
          title: str(params, 'title'),
          body: str(params, 'body'),
          linkUrl: (resolve(ctx, params.linkUrl) as string) ?? null,
          topic: (params.topic as string) ?? 'institution',
          priority: (params.priority as string) ?? 'normal',
          dedupeKey: stepKey(ctx, `role:${role}:${h.userId}`),
          status: 'queued',
        }).returning();
        ids.push(row.id);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return { notified: ids.length, role };
  },

  /**
   * Append to a LEAD's history.
   *
   * The individual path has no application row and therefore no application
   * timeline; a lead's activity trail is where its history lives, and this is
   * the action that writes to it.
   *
   * NOT idempotent by a constraint, unlike its siblings — lead_activities has
   * no unique key to hang one on, and inventing one would mean a migration for
   * a table whose whole purpose is to accept repeated entries. A replayed step
   * therefore writes a second identical activity line. That is stated here
   * rather than implied, because it is the one action in this registry where
   * "safe to re-run" means "harmless", not "deduplicated": a repeated line in a
   * history is noise, where a repeated task or message is work nobody asked for.
   */
  async record_lead_activity(ctx, params) {
    const leadId = Number(resolve(ctx, params.leadId ?? { from: 'leadId' }));
    if (!Number.isFinite(leadId)) throw new Error('record_lead_activity needs a leadId.');

    const [row] = await ctx.db.insert(e.leadActivities).values({
      leadId,
      at: ctx.now,
      kind: str(params, 'kind'),
      summary: str(params, 'summary'),
      detail: (params.detail ?? null) as any,
    }).returning();
    return { leadActivityId: row.id };
  },

  /**
   * Append to the federation's event feed.
   *
   * `correlationId` is the step key, so publish() recognises a replay and
   * returns the existing event instead of appending a second one.
   */
  async record_event(ctx, params) {
    const result = await publishDomainEvent(ctx.db, {
      eventType: str(params, 'eventType') as any,
      entityType: str(params, 'entityType'),
      entityId: String(resolve(ctx, params.entityId ?? ctx.run.subjectId)),
      payload: ((params.payload ?? {}) as any),
      correlationId: stepKey(ctx, `evt:${params.eventType}`),
      actor: ctx.actor.principal,
    });
    return { eventId: (result as any)?.event?.id ?? null, duplicate: (result as any)?.duplicate ?? false };
  },

  /** Move an application to a new status without a human decision. */
  async set_application_status(ctx, params) {
    const applicationId = Number(resolve(ctx, params.applicationId ?? { from: 'applicationId' }));
    const status = str(params, 'status');
    const [row] = await ctx.db.update(o.institutionApplications)
      .set({ status: status as any, acknowledgedAt: status === 'acknowledged' ? ctx.now : undefined, updatedAt: ctx.now })
      .where(eq(o.institutionApplications.id, applicationId))
      .returning();
    if (!row) throw new Error(`No application ${applicationId}.`);
    return { status: row.status };
  },

  /** Shortlist coaches for an approved programme. Recommends only. */
  async recommend_coaches(ctx, params) {
    const programId = Number(resolve(ctx, params.programId ?? { from: 'programId' }));
    if (!Number.isFinite(programId)) throw new Error('recommend_coaches needs a programId.');

    const startsAt = new Date(String(resolve(ctx, params.startsAt ?? { from: 'startsAt' })));
    const endsAt = new Date(String(resolve(ctx, params.endsAt ?? { from: 'endsAt' })));

    const result = await recommendCoaches(ctx.db, ctx.actor, {
      programId,
      criteria: {
        startsAt,
        endsAt,
        stateUnitId: Number(resolve(ctx, params.stateUnitId)) || null,
        districtUnitId: Number(resolve(ctx, params.districtUnitId)) || null,
        city: (resolve(ctx, params.city) as string) ?? null,
        involvesMinors: resolve(ctx, params.involvesMinors) === true,
        requiredLanguage: (resolve(ctx, params.requiredLanguage) as string) ?? null,
      },
      take: Number(params.take) || 3,
    }, ctx.now);

    return {
      recommended: result.recommended.map((r: any) => ({ id: r.id, coachPersonId: r.coachPersonId, score: r.score })),
      eligibleCount: result.considered.filter((c) => c.eligible).length,
      consideredCount: result.considered.length,
    };
  },
};

// ─── The workflows the federation runs ──────────────────────────────────────

export const STANDARD_TASK_TEMPLATES = [
  {
    code: 'REVIEW_INSTITUTION_APPLICATION',
    title: 'Review an institutional application',
    description: 'Read the submission, check the requirements are workable, and decide the next step.',
    defaultRole: 'TRAINING_OPERATIONS',
    defaultPriority: 'normal' as const,
    // NULL. The federation has published no turnaround, and a number invented
    // here becomes a deadline the system reports people as missing.
    dueInHours: null,
    escalateAfterHours: null,
    escalateToRole: 'TRAINING_DIRECTOR',
  },
  {
    code: 'SCREEN_COACH_APPLICATION',
    title: 'Screen a coaching candidate',
    description: 'Check the grade, the experience and the references before inviting an interview.',
    defaultRole: 'COACH_MANAGER',
    defaultPriority: 'normal' as const,
    dueInHours: null,
    escalateAfterHours: null,
    escalateToRole: 'TRAINING_DIRECTOR',
  },
  {
    code: 'CONFIRM_COACH_ASSIGNMENT',
    title: 'Confirm a coach onto a programme',
    description: 'The engine has shortlisted candidates. Confirm one, or choose somebody else.',
    defaultRole: 'COACH_MANAGER',
    defaultPriority: 'high' as const,
    dueInHours: null,
    escalateAfterHours: null,
    escalateToRole: 'TRAINING_DIRECTOR',
  },
  {
    code: 'ANSWER_TRAINING_ENQUIRY',
    title: 'Answer a training enquiry',
    description:
      'Somebody asked about training for themselves or for a child. Tell them what runs near them and what it would cost.',
    defaultRole: 'TRAINING_OPERATIONS',
    defaultPriority: 'normal' as const,
    // NULL, as everywhere else. The federation has published no turnaround, and
    // a number invented here becomes a deadline it reports itself as missing.
    dueInHours: null,
    escalateAfterHours: null,
    escalateToRole: 'TRAINING_DIRECTOR',
  },
  {
    code: 'ANSWER_SUPPORT_TICKET',
    title: 'Answer a support ticket',
    description: 'Reply to the person who raised it.',
    defaultRole: 'SUPPORT_AGENT',
    defaultPriority: 'normal' as const,
    dueInHours: null,
    escalateAfterHours: null,
    escalateToRole: 'TRAINING_DIRECTOR',
  },
];

/**
 * The definitions.
 *
 * Read these as the answer to "what does MMAKF do automatically when a school
 * applies?" — they are meant to be legible to somebody who does not read
 * TypeScript, which is why they are data.
 */
export const STANDARD_WORKFLOWS: Array<{
  code: string; title: string; trigger: string; description: string; spec: WorkflowSpec;
}> = [
  {
    code: 'INSTITUTION_APPLICATION_INTAKE',
    title: 'When an institution applies',
    trigger: 'INSTITUTION_APPLICATION_SUBMITTED',
    description:
      'Acknowledges the applicant, records the event, puts the review in the right queue and tells the responsible role.',
    spec: {
      maxAttempts: 4,
      steps: [
        {
          action: 'record_event',
          params: {
            eventType: 'INSTITUTION_APPLICATION_SUBMITTED',
            entityType: 'institution_application',
            entityId: { from: 'applicationId' },
            payload: {},
          },
        },
        {
          action: 'set_application_status',
          params: { applicationId: { from: 'applicationId' }, status: 'acknowledged' },
        },
        {
          action: 'record_timeline',
          params: {
            applicationId: { from: 'applicationId' },
            kind: 'acknowledged',
            summary: 'MMAKF has your application and it is with the training office.',
            visibleToApplicant: true,
          },
        },
        {
          action: 'create_task',
          params: {
            templateCode: 'REVIEW_INSTITUTION_APPLICATION',
            subjectKind: 'institution_application',
            subjectId: { from: 'applicationId' },
            institutionId: { from: 'institutionId' },
            assignedRole: { from: 'ownerRole' },
            assignedUserId: { from: 'ownerUserId' },
          },
        },
        {
          action: 'send_message',
          // Only where an address was given. A step that cannot run is skipped
          // and recorded as skipped, not failed — an application submitted by
          // telephone is not a broken automation.
          when: { path: 'contactEmail', op: 'present' },
          params: {
            template: 'application_received',
            to: { from: 'contactEmail' },
            toName: { from: 'contactName' },
            values: {
              contactName: { from: 'contactName' },
              institutionName: { from: 'institutionName' },
              ref: { from: 'ref' },
              statusUrl: { from: 'statusUrl' },
            },
          },
        },
        {
          action: 'notify_role',
          when: { path: 'ownerRole', op: 'present' },
          params: {
            role: { from: 'ownerRole' },
            title: 'New institutional application',
            body: 'An institution has applied for a training programme and is waiting for review.',
            linkUrl: { from: 'adminUrl' },
            topic: 'institution',
          },
          optional: true,
        },
      ],
    },
  },

  {
    code: 'INDIVIDUAL_ENQUIRY_INTAKE',
    title: 'When a person asks about training',
    trigger: 'TRAINING_ENQUIRY_SUBMITTED',
    description:
      'Records the event, writes the acknowledgement onto the lead, puts the reply in the training office queue and tells the enquirer their enquiry arrived.',
    spec: {
      maxAttempts: 4,
      steps: [
        {
          action: 'record_event',
          params: {
            eventType: 'TRAINING_ENQUIRY_SUBMITTED',
            entityType: 'training_request',
            entityId: { from: 'requestId' },
            // Empty on purpose. The feed carries the identifier of the request
            // and nothing about the participant — an event about a nine-year-old
            // must not itself be a fact about a nine-year-old.
            payload: {},
          },
        },
        {
          action: 'record_lead_activity',
          params: {
            leadId: { from: 'leadId' },
            kind: 'note',
            summary: 'MMAKF has the enquiry. It is in the training office queue for a reply.',
          },
        },
        {
          action: 'create_task',
          params: {
            templateCode: 'ANSWER_TRAINING_ENQUIRY',
            subjectKind: 'training_request',
            subjectId: { from: 'requestId' },
            assignedRole: { from: 'ownerRole' },
            assignedUserId: { from: 'ownerUserId' },
          },
        },
        {
          action: 'send_message',
          // Only where an address was given. An enquiry left with a telephone
          // number alone is answered by somebody dialling it, and that is not a
          // broken automation.
          when: { path: 'contactEmail', op: 'present' },
          params: {
            template: 'training_enquiry_received',
            to: { from: 'contactEmail' },
            toName: { from: 'contactName' },
            values: {
              contactName: { from: 'contactName' },
              ref: { from: 'ref' },
              summary: { from: 'summary' },
            },
          },
        },
        {
          action: 'notify_role',
          // The training office, named literally, because notify_role resolves a
          // ROLE to its current holders and takes no reference. Where a routing
          // rule named somebody more specific, that person holds the TASK — this
          // is the queue being told there is something in it.
          params: {
            role: 'TRAINING_OPERATIONS',
            title: 'New training enquiry',
            body: 'Somebody has asked MMAKF about training and is waiting for a reply.',
            linkUrl: { from: 'adminUrl' },
            topic: 'training',
          },
          optional: true,
        },
      ],
    },
  },

  {
    code: 'COACH_APPLICATION_INTAKE',
    title: 'When somebody applies to teach',
    trigger: 'COACH_APPLICATION_SUBMITTED',
    description: 'Acknowledges the candidate and puts screening in the coach manager’s queue.',
    spec: {
      maxAttempts: 4,
      steps: [
        {
          action: 'record_event',
          params: {
            eventType: 'COACH_APPLICATION_SUBMITTED',
            entityType: 'coach_application',
            entityId: { from: 'coachApplicationId' },
            payload: {},
          },
        },
        {
          action: 'create_task',
          params: {
            templateCode: 'SCREEN_COACH_APPLICATION',
            subjectKind: 'coach_application',
            subjectId: { from: 'coachApplicationId' },
            assignedRole: 'COACH_MANAGER',
          },
        },
        {
          action: 'send_message',
          when: { path: 'email', op: 'present' },
          params: {
            template: 'coach_application_received',
            to: { from: 'email' },
            toName: { from: 'fullName' },
            values: { fullName: { from: 'fullName' }, ref: { from: 'ref' } },
          },
        },
        {
          action: 'notify_role',
          params: {
            role: 'COACH_MANAGER',
            title: 'New coaching application',
            body: 'A candidate has applied to teach for MMAKF.',
            topic: 'coach',
          },
          optional: true,
        },
      ],
    },
  },

  {
    code: 'PROGRAMME_COACH_SHORTLIST',
    title: 'When a programme is approved',
    trigger: 'PROGRAM_SCHEDULED',
    description:
      'Shortlists eligible coaches and asks a manager to confirm one. The engine never appoints anybody.',
    spec: {
      maxAttempts: 3,
      steps: [
        {
          action: 'recommend_coaches',
          params: {
            programId: { from: 'programId' },
            startsAt: { from: 'startsAt' },
            endsAt: { from: 'endsAt' },
            stateUnitId: { from: 'stateUnitId' },
            districtUnitId: { from: 'districtUnitId' },
            city: { from: 'city' },
            involvesMinors: { from: 'involvesMinors' },
            take: 3,
          },
        },
        {
          action: 'create_task',
          params: {
            templateCode: 'CONFIRM_COACH_ASSIGNMENT',
            subjectKind: 'training_program',
            subjectId: { from: 'programId' },
            institutionId: { from: 'institutionId' },
            assignedRole: 'COACH_MANAGER',
          },
        },
        {
          action: 'record_event',
          params: {
            eventType: 'COACH_ASSIGNMENT_RECOMMENDED',
            entityType: 'training_program',
            entityId: { from: 'programId' },
            payload: {},
          },
        },
      ],
    },
  },
];

/**
 * Put the standard automations in place. Safe to call repeatedly.
 *
 * Called by the bootstrap and by the tests. installWorkflow() versions rather
 * than edits, so re-running after a change leaves the old version on record for
 * any run that failed under it.
 */
export async function installStandardAutomations(db: DB) {
  for (const t of STANDARD_TASK_TEMPLATES) await upsertTaskTemplate(db, t);
  const results = [];
  for (const w of STANDARD_WORKFLOWS) {
    results.push(await installWorkflow(db, {
      code: w.code, title: w.title, trigger: w.trigger,
      description: w.description, spec: w.spec,
    }));
  }
  return results;
}

// ─── Bound entry points ─────────────────────────────────────────────────────

export function dispatch(db: DB, req: Parameters<typeof engineDispatch>[2]): Promise<RunOutcome[]> {
  return engineDispatch(db, ACTIONS, req);
}

export function sweepWorkflowRetries(db: DB, actor: AuditContext, now?: Date, limit?: number) {
  return engineSweep(db, ACTIONS, actor, now, limit);
}

/**
 * Submit an institutional application AND run the automation.
 *
 * The one function the public endpoint calls. It exists so that the endpoint
 * cannot accidentally do the first half — storing the application — and forget
 * the second, which is the failure mode the federation described as
 * administrators copying data between systems.
 *
 * The automation's outcome is RETURNED, not thrown. A school whose application
 * was stored must see a success page even if the acknowledgement could not be
 * queued; the run is recorded as failed and the retry sweep finishes it.
 */
export async function submitApplicationWithAutomation(
  db: DB, input: SubmitInput
): Promise<SubmitResult & { automation: RunOutcome[] }> {
  const result = await submitApplication(db, input);
  const now = input.now ?? new Date();

  let automation: RunOutcome[] = [];
  try {
    automation = await dispatch(db, {
      trigger: 'INSTITUTION_APPLICATION_SUBMITTED',
      idempotencyKey: `application:${result.applicationId}`,
      subjectKind: 'institution_application',
      subjectId: result.applicationId,
      context: {
        applicationId: result.applicationId,
        ref: result.ref,
        institutionId: result.institutionId,
        leadId: result.leadId,
        ownerRole: result.ownerRole,
        ownerUserId: result.ownerUserId,
        contactEmail: (input.payload.contactEmail as string) ?? null,
        contactName: (input.payload.contactName as string) ?? null,
        institutionName: (input.payload.institutionName as string) ?? null,
        statusUrl: `${LEARN_ORIGIN}/applications/${encodeURIComponent(result.ref)}?k=${encodeURIComponent(result.accessToken)}`,
        adminUrl: `${PUBLIC_ORIGIN}/admin/applications/${result.applicationId}`,
      },
      actor: systemIntakeContext(),
      now,
    });
  } catch (err: any) {
    // The engine itself failed, not a step within it. The application is stored
    // and the school gets its reference; this is recorded rather than raised.
    await db.insert(o.applicationEvents).values({
      applicationId: result.applicationId, at: now, kind: 'automation_failed',
      summary: 'The follow-up automation could not start.',
      detail: { error: String(err?.message ?? err) } as any,
      visibleToApplicant: false,
    });
  }

  return { ...result, automation };
}

/**
 * Record an individual's training enquiry AND run the automation.
 *
 * The one function the /start/individual endpoint calls, for the same reason
 * its institutional sibling exists: so a surface cannot store the enquiry and
 * forget the half that puts it in front of a human. Without the second half the
 * enquiry sits in the lead pipeline waiting for somebody to think of looking,
 * which is the federation's original complaint in a different table.
 *
 * The automation's outcome is RETURNED, never thrown. A person whose enquiry
 * was recorded must see their reference even if the acknowledgement could not
 * be queued; the run is recorded as failed and the retry sweep finishes it.
 *
 * A REPLAY DISPATCHES NOTHING. `alreadyRecorded` means the same form was sent
 * twice — the workflow ran the first time, and running it again would produce a
 * second acknowledgement to somebody who has already had one.
 */
export async function submitIndividualEnquiryWithAutomation(
  db: DB, input: IndividualSubmitInput
): Promise<IndividualSubmitResult & { automation: RunOutcome[] }> {
  const result = await submitIndividualEnquiry(db, input);
  const now = input.now ?? new Date();

  if (result.alreadyRecorded) return { ...result, automation: [] };

  let automation: RunOutcome[] = [];
  try {
    automation = await dispatch(db, {
      trigger: 'TRAINING_ENQUIRY_SUBMITTED',
      idempotencyKey: `training-enquiry:${result.requestId}`,
      subjectKind: 'training_request',
      subjectId: result.requestId,
      context: {
        requestId: result.requestId,
        leadId: result.leadId,
        ref: result.ref,
        summary: result.summary,
        involvesMinor: result.involvesMinor,
        ownerRole: result.routing.targetRole,
        ownerUserId: result.routing.targetUserId,
        // Read from the answers rather than from the stored request, because
        // the request deliberately holds no contact details — those live on the
        // lead, which is the record of who is asking.
        contactEmail: (input.answers?.contactEmail as string) ?? null,
        contactName: (input.answers?.contactName as string) ?? null,
        adminUrl: `${PUBLIC_ORIGIN}/admin/leads?lead=${result.leadId ?? ''}`,
      },
      actor: systemIntakeContext(),
      now,
    });
  } catch (err: any) {
    // The engine itself failed, not a step within it. The enquiry is recorded
    // and the person has their reference; this is written onto the lead rather
    // than raised, so an administrator opening the lead can see it happened.
    if (result.leadId) {
      await db.insert(e.leadActivities).values({
        leadId: result.leadId, at: now, kind: 'note',
        summary: 'The follow-up automation could not start for this enquiry.',
        detail: { error: String(err?.message ?? err) } as any,
      });
    }
  }

  return { ...result, automation };
}

/** The same wiring for a coaching application. */
export async function applyAsCoachWithAutomation(db: DB, input: CoachApplyInput) {
  const result = await applyAsCoach(db, input);
  const now = input.now ?? new Date();

  let automation: RunOutcome[] = [];
  if (!result.deduplicated) {
    try {
      automation = await dispatch(db, {
        trigger: 'COACH_APPLICATION_SUBMITTED',
        idempotencyKey: `coach-application:${result.id}`,
        subjectKind: 'coach_application',
        subjectId: result.id,
        context: {
          coachApplicationId: result.id,
          ref: result.ref,
          fullName: result.fullName,
          email: result.email,
        },
        actor: systemIntakeContext(),
        now,
      });
    } catch {
      // Recorded by the engine; the candidate still has their reference.
    }
  }

  return { ...result, automation };
}

/**
 * Everything the daily cron runs.
 *
 * One function so that adding a sweep does not mean remembering to wire it into
 * the cron route as well. Each part is independent: a failure in one is
 * reported and does not stop the others, because a stuck workflow retry must
 * not prevent task escalation from running for a week.
 */
export async function runDailySweeps(db: DB, actor: AuditContext, now: Date = new Date()) {
  const report: Record<string, unknown> = { at: now.toISOString() };

  try {
    report.workflowRetries = await sweepWorkflowRetries(db, actor, now);
  } catch (err: any) {
    report.workflowRetries = { error: String(err?.message ?? err) };
  }

  try {
    report.taskEscalations = await escalateOverdueTasks(db, actor, now);
  } catch (err: any) {
    report.taskEscalations = { error: String(err?.message ?? err) };
  }

  try {
    const { escalateStaleTickets } = await import('./support');
    report.ticketEscalations = await escalateStaleTickets(db, actor, now);
  } catch (err: any) {
    report.ticketEscalations = { error: String(err?.message ?? err) };
  }

  return report;
}
