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
import {
  autoQuoteApplication, autoQuoteContext, CLOSED_APPLICATION_STATUSES,
} from './auto-quote';
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

    // `detail` is resolved one level deep, exactly as send_message resolves its
    // `values`. Without this a definition that wrote
    // `detail: { reason: { from: 'auto_quote.reason' } }` stored the REFERENCE
    // rather than the value — a timeline entry reading `{"from":"..."}` where
    // the operator expected the engine's explanation, and no error anywhere.
    let detail: unknown = params.detail ?? null;
    if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(detail as Record<string, unknown>)) {
        out[k] = resolve(ctx, v) ?? null;
      }
      detail = out;
    }

    const [row] = await ctx.db.insert(o.applicationEvents).values({
      applicationId,
      at: ctx.now,
      kind: str(params, 'kind'),
      summary: str(params, 'summary'),
      detail: detail as any,
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

  /**
   * Move an application to a new status without a human decision.
   *
   * ──────────────────────────────────────────────────────────────────────────────
   * IT MAY NOT REOPEN ONE A PERSON CLOSED
   * ──────────────────────────────────────────────────────────────────────────────
   *
   * A workflow run that fails part-way is retried by `sweepWorkflowRetries()`
   * hours or days later. It resumes from the step that failed, with the context
   * it was dispatched with, and it does NOT re-read the world: the steps that
   * already succeeded are skipped and the remaining ones run as written. So a
   * run that stalled after pricing an application, and was retried after an
   * administrator declined that same application, would set it back to 'quoted'
   * and carry on — the school being told, by a machine, that a decision a person
   * took has been undone.
   *
   * The retry reads the definition VERSION it started under, so correcting the
   * workflow would not protect the runs already in flight. The refusal has to be
   * here, in the action, which is always the current code.
   *
   * IT THROWS RATHER THAN SKIPPING. A run that tried to reopen a closed
   * application is an anomaly somebody should see, and a step that quietly did
   * nothing while reporting success is how it would stay invisible. The run
   * records the sentence below and stops; nothing is written either way.
   */
  async set_application_status(ctx, params) {
    const applicationId = Number(resolve(ctx, params.applicationId ?? { from: 'applicationId' }));
    const status = str(params, 'status');

    const [before] = await ctx.db.select({ status: o.institutionApplications.status })
      .from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, applicationId)).limit(1);
    if (!before) throw new Error(`No application ${applicationId}.`);

    const closed = (CLOSED_APPLICATION_STATUSES as readonly string[]).includes(String(before.status));
    if (closed && before.status !== status) {
      throw new Error(
        `Application ${applicationId} is ${before.status} and an automation may not move it to ${status}. ` +
        'A person closed this application; a workflow resumed from a stale context is not a reason to reopen it.'
      );
    }

    const [row] = await ctx.db.update(o.institutionApplications)
      .set({ status: status as any, acknowledgedAt: status === 'acknowledged' ? ctx.now : undefined, updatedAt: ctx.now })
      .where(eq(o.institutionApplications.id, applicationId))
      .returning();
    if (!row) throw new Error(`No application ${applicationId}.`);
    return { status: row.status };
  },

  /**
   * A GUARD, not an effect: refuse to go on with an application a person closed.
   *
   * Declared `recheck: true` in the workflow, so it is asked again on every
   * attempt — unlike every other step, which is skipped once it has succeeded.
   * That is the entire point. A run that failed at its fifth step is retried by
   * the sweep hours or days later, and in between an administrator can have
   * declined the application. Without this the resumed run would go on to tell
   * the school that its quotation was being prepared.
   *
   * READ-ONLY, because it runs on every attempt. It writes nothing and returns
   * the status it read, so the failure recorded against the run says which
   * status stopped it.
   *
   * It refuses only the CLOSED statuses. It deliberately does NOT refuse
   * 'quoted' or 'awaiting_quotation': those are states this very workflow puts
   * an application into, and refusing them would break the ordinary retry it
   * exists to make safe.
   */
  async require_application_open(ctx, params) {
    const applicationId = Number(resolve(ctx, params.applicationId ?? { from: 'applicationId' }));
    if (!Number.isFinite(applicationId)) throw new Error('require_application_open needs an applicationId.');

    const [row] = await ctx.db.select({ status: o.institutionApplications.status })
      .from(o.institutionApplications)
      .where(eq(o.institutionApplications.id, applicationId)).limit(1);
    if (!row) throw new Error(`No application ${applicationId}.`);

    if ((CLOSED_APPLICATION_STATUSES as readonly string[]).includes(String(row.status))) {
      throw new Error(
        `Application ${applicationId} is ${row.status}. The federation has closed it, so this automation stops here ` +
        'rather than continuing against a decision a person has already taken.'
      );
    }
    return { status: row.status };
  },

  /**
   * Price a completed application, or record that nothing priced it.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * THE ONE ACTION IN THIS REGISTRY THAT TOUCHES MONEY
   * ───────────────────────────────────────────────────────────────────────────
   *
   * It decides nothing about what anything costs. src/db/fees.ts does that, from
   * a framework the federation published, and today it publishes none — so this
   * step's honest answer is `manual_quote_required` with NO FIGURE AT ALL, and
   * the steps after it read that outcome and tell somebody.
   *
   * IDEMPOTENT BY A UNIQUE INDEX, not by the run key. That matters because the
   * two protect different things: the run key stops THIS run's retry doing the
   * work twice, and `application_quotations_application_uk` stops a second run,
   * a re-fired trigger or a concurrent worker doing it at all. A school must not
   * receive two quotations with two reference numbers for one application, and
   * the workflow engine alone cannot promise that.
   *
   * ACTS AS TRAINING_OPERATIONS, not as the intake principal. See
   * `autoQuotePrincipal()` — the machine issues quotations and is structurally
   * unable to approve one.
   */
  async auto_quote(ctx, params) {
    const applicationId = Number(resolve(ctx, params.applicationId ?? { from: 'applicationId' }));
    if (!Number.isFinite(applicationId)) throw new Error('auto_quote needs an applicationId.');

    const result = await autoQuoteApplication(ctx.db, autoQuoteContext(), applicationId, {
      now: ctx.now,
    });

    // Returned flat, because a workflow step's `when` reads a dotted path and a
    // definition is meant to be legible to somebody who does not read
    // TypeScript: `{ path: 'auto_quote.outcome', op: 'eq', value: 'quoted' }`.
    return {
      outcome: result.outcome,
      duplicate: result.duplicate,
      reason: result.reason,
      quoteId: result.quoteId,
      quoteRef: result.quoteRef,
      quoteVersionId: result.quoteVersionId,
      frameworkCode: result.frameworkCode,
      // NULL when the federation has not priced this. Never 0 — see the header
      // of src/db/auto-quote.ts. No step below renders it, deliberately.
      totalMinor: result.totalMinor,
      missing: result.missing,
    };
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
    // Raised by completeProgramme() in src/db/programme-lifecycle.ts. ONE task
    // per programme, never one per participant: a school cohort is four hundred
    // children and four hundred tasks is not a queue.
    //
    // TECHNICAL_DIRECTOR, and not the programme's own manager. The role that
    // delivered the training is not the role that certifies it — that is the
    // whole of §39's second pair of eyes, and the module refuses an approver who
    // wrote the register regardless of which role they hold.
    code: 'CERTIFY_PROGRAMME_PARTICIPANTS',
    title: 'Certify the participants of a completed programme',
    description:
      'The programme has finished, every delivered session has a register, and the attendance figures are frozen ' +
      'against each participant. Approve or decline each one. MMAKF has published no minimum attendance ' +
      'requirement, so whether the figures are sufficient is your decision and it is recorded against your name.',
    defaultRole: 'TECHNICAL_DIRECTOR',
    defaultPriority: 'normal' as const,
    // NULL, as everywhere else in this list. The federation has published no
    // turnaround for certification.
    dueInHours: null,
    escalateAfterHours: null,
    escalateToRole: 'GENERAL_SECRETARY',
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
    code: 'PREPARE_MANUAL_QUOTATION',
    title: 'Prepare a quotation by hand',
    description:
      'The fee engine could not price this application from a published rule, so there is no figure and the ' +
      'institution has been told one is being prepared. Read the requirements, agree the fee, and issue the ' +
      'quotation from /admin/quotes. The reason nothing priced it is on the application timeline — if it is ' +
      'that MMAKF has published no fee framework, this task will keep arriving until one is published.',
    defaultRole: 'TRAINING_OPERATIONS',
    // HIGH, and it is the only standard template that is. A school has been told
    // in writing that a quotation is coming and has been given no figure; every
    // day this sits is a day the federation is silent on the one question the
    // school asked. The review task alongside it is 'normal' because the school
    // has been told nothing that needs following through.
    defaultPriority: 'high' as const,
    // NULL, as everywhere else. The federation has published no turnaround, and
    // a number invented here becomes a deadline it reports itself as missing.
    dueInHours: null,
    escalateAfterHours: null,
    escalateToRole: 'TRAINING_DIRECTOR',
  },
  {
    code: 'APPROVE_AUTOMATIC_QUOTATION',
    title: 'Approve a quotation the rules held back',
    description:
      'A fee rule that fired on this application is marked as requiring approval, so the quotation was computed ' +
      'and NOT issued. Check it and approve it, or reject it with a reason. The approver may not be the issuer — ' +
      'and the issuer here was the automation, which holds no approval authority at all.',
    defaultRole: 'TRAINING_DIRECTOR',
    defaultPriority: 'high' as const,
    dueInHours: null,
    escalateAfterHours: null,
    escalateToRole: 'FINANCE_OFFICER',
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

  /**
   * THE FIRST HOP: requirements complete → a quotation, or an honest reason why
   * not.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * READ THE `when` CLAUSES. THEY ARE THE WHOLE DESIGN.
   * ───────────────────────────────────────────────────────────────────────────
   *
   * Step 0 asks the fee engine and records what it said. Every step after it is
   * guarded on `auto_quote.outcome`, and the four outcomes are mutually
   * exclusive — so exactly one of the four branches below runs, and the other
   * three are recorded as SKIPPED rather than silently absent. The fourth,
   * 'not_applicable', is the federation having already decided: declined,
   * withdrawn, lapsed or already quoted. Step 0 writes nothing for it, and the
   * only thing this workflow then does is note internally that it did not.
   *
   * TODAY, EVERY APPLICATION TAKES THE THIRD BRANCH, because MMAKF has published
   * no fee framework. The school is told a quotation is being prepared, the
   * application moves to 'awaiting_quotation', and a high-priority task lands in
   * the training office queue. Nobody is shown a zero and nobody is left in
   * silence.
   *
   * THE DAY A FRAMEWORK IS PUBLISHED, the first branch starts running instead.
   * Nothing in this definition changes, nothing is deployed, and nothing is
   * switched on: `activeFramework()` simply stops returning null. That property
   * is what tests/auto-quote.test.ts exists to prove.
   *
   * ───────────────────────────────────────────────────────────────────────────
   * A SEPARATE WORKFLOW, NOT MORE STEPS ON THE INTAKE
   * ───────────────────────────────────────────────────────────────────────────
   *
   * INSTITUTION_APPLICATION_INTAKE acknowledges a school and puts a review in a
   * queue; if its fourth step fails, nothing about money has happened. Folding
   * quotation into it would mean a failure anywhere in the acknowledgement chain
   * blocked the quotation, and a failure in the quotation left the school
   * unacknowledged. They also retry on different terms: an acknowledgement that
   * cannot be queued should be retried hard, and a quotation should not be
   * attempted over and over against a framework that has not changed.
   *
   * They are also separately switchable. The federation can turn automatic
   * quotation off — `workflow_definitions.active` is a column, not a deploy —
   * without turning off the acknowledgement a school is owed.
   */
  {
    code: 'APPLICATION_AUTO_QUOTE',
    title: 'When an application’s requirements are complete',
    trigger: 'INSTITUTION_APPLICATION_REQUIREMENTS_COMPLETE',
    description:
      'Prices the application against the published fee framework and issues the quotation. Where nothing prices ' +
      'it — which is every application until MMAKF publishes a fee framework — it records why, tells the ' +
      'institution a quotation is being prepared, and puts the work in the training office queue. It never shows ' +
      'a figure the federation has not published, and it never shows zero.',
    spec: {
      // THREE, not four. Every failure this step can have is either permanent
      // (no framework, no matching rule — both of which are ANSWERS and do not
      // fail at all) or a database fault worth two more tries. Retrying a
      // pricing decision harder does not make the federation publish fees.
      maxAttempts: 3,
      steps: [
        // THE GUARD, and the only step here re-asked on every attempt.
        //
        // An application a person declined, or the institution withdrew, or
        // that lapsed, stops the run dead — including a run resumed by the retry
        // sweep days after it stalled, which is the case the rest of this
        // workflow cannot see. `auto_quote` refuses the same statuses on its own
        // account, but it is skipped on a resume, and the steps that reach the
        // school are not.
        {
          action: 'require_application_open',
          recheck: true,
          params: { applicationId: { from: 'applicationId' } },
        },
        {
          action: 'auto_quote',
          params: { applicationId: { from: 'applicationId' } },
        },

        // ── Branch one: priced, and issued ──
        {
          action: 'record_event',
          when: { path: 'auto_quote.outcome', op: 'eq', value: 'quoted' },
          params: {
            eventType: 'QUOTE_ISSUED',
            entityType: 'institution_application',
            entityId: { from: 'applicationId' },
            // EMPTY. The feed carries the identifier and nothing else — an event
            // about a quotation must not itself be a disclosure of the amount,
            // which is what a school pays and is nobody else's business.
            payload: {},
          },
        },
        {
          action: 'set_application_status',
          when: { path: 'auto_quote.outcome', op: 'eq', value: 'quoted' },
          params: { applicationId: { from: 'applicationId' }, status: 'quoted' },
        },
        {
          action: 'record_timeline',
          when: { path: 'auto_quote.outcome', op: 'eq', value: 'quoted' },
          params: {
            applicationId: { from: 'applicationId' },
            kind: 'quoted',
            summary: 'A quotation has been prepared for your institution from the requirements you sent.',
            visibleToApplicant: true,
          },
        },
        {
          action: 'send_message',
          // Only where an address was given. An application taken by telephone
          // is not a broken automation — the task below still exists.
          when: {
            all: [
              { path: 'auto_quote.outcome', op: 'eq', value: 'quoted' },
              { path: 'contactEmail', op: 'present' },
            ],
          },
          params: {
            template: 'application_quotation_ready',
            to: { from: 'contactEmail' },
            toName: { from: 'contactName' },
            values: {
              contactName: { from: 'contactName' },
              institutionName: { from: 'institutionName' },
              ref: { from: 'ref' },
              quoteRef: { from: 'auto_quote.quoteRef' },
              statusUrl: { from: 'statusUrl' },
            },
          },
        },

        // ── Branch two: priced, and HELD for a person ──
        //
        // The automation computed a figure and is not permitted to send it. That
        // is the rule working: `autoQuotePrincipal()` holds 'quote:issue' and
        // not 'quote:approve', and `approveQuoteVersion()` refuses an approver
        // it cannot show to be somebody other than the issuer.
        {
          action: 'record_event',
          when: { path: 'auto_quote.outcome', op: 'eq', value: 'awaiting_approval' },
          params: {
            eventType: 'QUOTE_HELD_FOR_APPROVAL',
            entityType: 'institution_application',
            entityId: { from: 'applicationId' },
            payload: {},
          },
        },
        {
          action: 'create_task',
          when: { path: 'auto_quote.outcome', op: 'eq', value: 'awaiting_approval' },
          params: {
            templateCode: 'APPROVE_AUTOMATIC_QUOTATION',
            subjectKind: 'institution_application',
            subjectId: { from: 'applicationId' },
            institutionId: { from: 'institutionId' },
            assignedRole: 'TRAINING_DIRECTOR',
          },
        },

        // ── Branch three: nothing priced it. TODAY, THIS IS EVERY APPLICATION ──
        {
          action: 'record_event',
          when: { path: 'auto_quote.outcome', op: 'eq', value: 'manual_quote_required' },
          params: {
            eventType: 'QUOTE_MANUAL_QUOTATION_REQUIRED',
            entityType: 'institution_application',
            entityId: { from: 'applicationId' },
            payload: {},
          },
        },
        {
          action: 'create_task',
          when: { path: 'auto_quote.outcome', op: 'eq', value: 'manual_quote_required' },
          params: {
            templateCode: 'PREPARE_MANUAL_QUOTATION',
            subjectKind: 'institution_application',
            subjectId: { from: 'applicationId' },
            institutionId: { from: 'institutionId' },
            assignedRole: { from: 'ownerRole' },
            assignedUserId: { from: 'ownerUserId' },
          },
        },
        {
          action: 'record_timeline',
          when: { path: 'auto_quote.outcome', op: 'eq', value: 'manual_quote_required' },
          params: {
            applicationId: { from: 'applicationId' },
            kind: 'awaiting_quotation',
            // No figure, no date, and no apology for either. This is what the
            // school reads on its status page.
            summary: 'MMAKF has your requirements and the training office is preparing your quotation.',
            visibleToApplicant: true,
          },
        },
        {
          action: 'record_timeline',
          when: { path: 'auto_quote.outcome', op: 'eq', value: 'manual_quote_required' },
          params: {
            applicationId: { from: 'applicationId' },
            kind: 'quotation_not_automated',
            // The engine's own words, INTERNAL ONLY. "MMAKF has not published a
            // fee framework" is a true and useful sentence for the training
            // office and an alarming one for a customer.
            summary: 'The fee engine could not price this application automatically.',
            detail: { reason: { from: 'auto_quote.reason' }, missing: { from: 'auto_quote.missing' } },
            visibleToApplicant: false,
          },
        },
        {
          action: 'send_message',
          when: {
            all: [
              { path: 'auto_quote.outcome', op: 'eq', value: 'manual_quote_required' },
              { path: 'contactEmail', op: 'present' },
            ],
          },
          params: {
            template: 'application_quotation_pending',
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

        // ── Both held branches move the application off 'acknowledged' ──
        //
        // LAST, and after the message, deliberately. The status is what the
        // admin queue filters on, and moving it before the school had been told
        // would produce a window in which the federation's own screens said a
        // quotation was being prepared and the school had heard nothing.
        {
          action: 'set_application_status',
          when: {
            any: [
              { path: 'auto_quote.outcome', op: 'eq', value: 'manual_quote_required' },
              { path: 'auto_quote.outcome', op: 'eq', value: 'awaiting_approval' },
            ],
          },
          params: { applicationId: { from: 'applicationId' }, status: 'awaiting_quotation' },
        },
        // ── Branch four: the federation has already finished with it ──
        //
        // Declined, withdrawn, lapsed — or already quoted. `auto_quote` wrote
        // NOTHING in that case, so every branch above is skipped and the only
        // effect this workflow has is the internal note below, which is what an
        // administrator needs in order to understand why a run that says
        // 'succeeded' changed nothing.
        {
          action: 'record_timeline',
          when: { path: 'auto_quote.outcome', op: 'eq', value: 'not_applicable' },
          params: {
            applicationId: { from: 'applicationId' },
            kind: 'quotation_not_attempted',
            summary: 'No quotation was prepared automatically for this application.',
            detail: { reason: { from: 'auto_quote.reason' } },
            visibleToApplicant: false,
          },
        },
        {
          action: 'notify_role',
          // NAMED, not 'anything other than quoted'. The two outcomes below are
          // the ones where a person has work to do. 'not_applicable' is the
          // federation having already finished — telling the training office a
          // quotation needs somebody would be summoning it to an application it
          // has itself closed.
          when: {
            any: [
              { path: 'auto_quote.outcome', op: 'eq', value: 'manual_quote_required' },
              { path: 'auto_quote.outcome', op: 'eq', value: 'awaiting_approval' },
            ],
          },
          params: {
            role: 'TRAINING_OPERATIONS',
            title: 'A quotation needs a person',
            body: 'An institutional application is waiting for a quotation the fee engine could not produce.',
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

  // ── The first hop: requirements complete → a quotation ──
  //
  // A SECOND DISPATCH, not a step appended to the first. The two triggers say
  // different things — "a school applied" and "we now have everything needed to
  // price it" — and they will not always fire together: an application completed
  // by an administrator after a chase becomes requirements-complete long after
  // it was submitted, and the day that path exists it dispatches THIS trigger
  // and nothing else. Folding quotation into the intake workflow would have made
  // that impossible without re-acknowledging the school.
  //
  // Fired even where the intake automation failed. The two are independent: a
  // school whose acknowledgement could not be queued is still owed a quotation,
  // and the retry sweep will finish whichever half fell over.
  const quotation = await dispatchRequirementsComplete(db, {
    applicationId: result.applicationId,
    ref: result.ref,
    accessToken: result.accessToken,
    institutionId: result.institutionId,
    ownerRole: result.ownerRole,
    ownerUserId: result.ownerUserId,
    contactEmail: (input.payload.contactEmail as string) ?? null,
    contactName: (input.payload.contactName as string) ?? null,
    institutionName: (input.payload.institutionName as string) ?? null,
    now,
  });

  return { ...result, automation: [...automation, ...quotation] };
}

export interface RequirementsCompleteInput {
  applicationId: number;
  ref: string;
  /** For the applicant's status link. Omitted where the caller does not hold it. */
  accessToken?: string | null;
  institutionId?: number | null;
  ownerRole?: string | null;
  ownerUserId?: number | null;
  contactEmail?: string | null;
  contactName?: string | null;
  institutionName?: string | null;
  now?: Date;
}

/**
 * Fire the quotation automation for an application whose requirements are in.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IDEMPOTENT, AND TWICE OVER
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The idempotency key names the APPLICATION, so a second call for the same
 * application finds a succeeded run and does nothing — no second task, no second
 * message, no second timeline entry. Underneath that,
 * `application_quotations_application_uk` refuses a second quotation even if the
 * run record were somehow lost. Two independent guarantees, because the
 * consequence of losing this one is a school receiving two quotations with two
 * reference numbers and no way to tell which binds.
 *
 * Exported rather than private so that any path which later completes an
 * application — an administrator filling in a participant count after a phone
 * call, an information-requested reply arriving — can fire the same trigger
 * without knowing anything about fees. That is what "no code change when fees
 * are published" is worth: the caller says what happened, not what to do.
 *
 * Returns rather than throws. A school whose application is stored must see its
 * reference even if the quotation automation could not start.
 */
export async function dispatchRequirementsComplete(
  db: DB,
  input: RequirementsCompleteInput
): Promise<RunOutcome[]> {
  const now = input.now ?? new Date();
  try {
    return await dispatch(db, {
      trigger: 'INSTITUTION_APPLICATION_REQUIREMENTS_COMPLETE',
      idempotencyKey: `application-requirements-complete:${input.applicationId}`,
      subjectKind: 'institution_application',
      subjectId: input.applicationId,
      context: {
        applicationId: input.applicationId,
        ref: input.ref,
        institutionId: input.institutionId ?? null,
        ownerRole: input.ownerRole ?? null,
        ownerUserId: input.ownerUserId ?? null,
        contactEmail: input.contactEmail ?? null,
        contactName: input.contactName ?? null,
        institutionName: input.institutionName ?? null,
        statusUrl: input.accessToken
          ? `${LEARN_ORIGIN}/applications/${encodeURIComponent(input.ref)}?k=${encodeURIComponent(input.accessToken)}`
          : `${LEARN_ORIGIN}/applications/${encodeURIComponent(input.ref)}`,
        adminUrl: `${PUBLIC_ORIGIN}/admin/applications/${input.applicationId}`,
      },
      actor: systemIntakeContext(),
      now,
    });
  } catch (err: any) {
    // The engine itself failed, not a step within it. Recorded on the timeline
    // rather than raised, so an administrator opening the application can see
    // that the quotation was never attempted — which is a different fact from
    // "attempted and could not be priced", and the two must not look alike.
    await db.insert(o.applicationEvents).values({
      applicationId: input.applicationId, at: now, kind: 'automation_failed',
      summary: 'The quotation automation could not start for this application.',
      detail: { error: String(err?.message ?? err) } as any,
      visibleToApplicant: false,
    });
    return [];
  }
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
