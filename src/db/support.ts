// Support — the parts the existing desk did not have.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS IS AN EXTENSION, NOT A SECOND HELP DESK
// ─────────────────────────────────────────────────────────────────────────────
//
// src/db/cases.ts already owns support tickets: raiseTicket, assignTicket,
// respondToTicket, resolveTicket, ticketStanding, the scope gate, and the
// deliberate refusal to invent a service standard the federation never
// published. All of that stays where it is and is called from here.
//
// What was missing, and is added here:
//
//   · A CONVERSATION. `respondToTicket` records one response as a case note.
//     A ticket is a thread — the requester replies, the agent replies, an agent
//     writes something only agents should see. That needs its own table with an
//     `internal` flag, which is what ticket_messages is.
//   · ESCALATION. A ticket nobody answers must rise, or the service standard is
//     a number in a database that changes nobody's behaviour.
//   · A TENANT. A school raising a ticket should see it in its own portal, and
//     its own portal must not show it anybody else's.
//   · A CATEGORY LIST. Fourteen categories, stated once, so the form and the
//     routing agree.

import { and, asc, desc, eq, inArray, isNull, isNotNull, lte, or, sql } from 'drizzle-orm';
import * as o from './operations.schema';
import * as g from './governance.schema';
import * as s from './schema';
import { writeAudit, type AuditContext } from './federation';
import {
  assertCanAnywhere, canAnywhere, visibleScopes,
  type Principal,
} from '@/lib/rbac';

type DB = any;

export class SupportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SupportError';
    this.code = code;
  }
}

/** Shape check, not `instanceof` — see the note in src/lib/workflow.ts. */
export function isSupportError(err: unknown): err is SupportError {
  return !!err && typeof err === 'object' && (err as any).name === 'SupportError'
    && typeof (err as any).code === 'string';
}

// ─── The categories ─────────────────────────────────────────────────────────

export const SUPPORT_CATEGORIES = [
  { value: 'training', label: 'Training and programmes', department: 'training' },
  { value: 'school', label: 'School programmes', department: 'training' },
  { value: 'corporate', label: 'Corporate programmes', department: 'training' },
  { value: 'university', label: 'University programmes', department: 'training' },
  { value: 'booking', label: 'Bookings', department: 'training' },
  { value: 'calendar', label: 'Calendar and scheduling', department: 'training' },
  { value: 'payment', label: 'Payments and invoices', department: 'finance' },
  { value: 'competition', label: 'Competitions and entries', department: 'competition' },
  { value: 'grading', label: 'Gradings and examinations', department: 'technical' },
  { value: 'membership', label: 'Membership', department: 'membership' },
  { value: 'certificate', label: 'Certificates and verification', department: 'technical' },
  { value: 'technical', label: 'Website or technical problem', department: 'support' },
  { value: 'account', label: 'Account and sign-in', department: 'support' },
  { value: 'general', label: 'Something else', department: 'support' },
] as const;

export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number]['value'];

export function isSupportCategory(v: unknown): v is SupportCategory {
  return SUPPORT_CATEGORIES.some((c) => c.value === v);
}

/**
 * Which desk a category belongs to.
 *
 * Returns 'support' for anything unrecognised rather than throwing: a ticket
 * that arrives with a category nobody expected still needs answering, and the
 * general desk is the right place for it. Losing the ticket to a validation
 * error is the one outcome that helps nobody.
 */
export function departmentFor(category: string): string {
  return SUPPORT_CATEGORIES.find((c) => c.value === category)?.department ?? 'support';
}

/**
 * Suggested priority. ADVICE, not a decision.
 *
 * Deliberately keyword-free apart from one case: a ticket that says a child was
 * hurt is not a support ticket at all and must reach a human immediately. Every
 * other category takes the default, because guessing urgency from wording is
 * how a politely-worded emergency gets triaged as routine.
 *
 * Anything safeguarding-shaped is flagged for REDIRECTION, not merely
 * prioritised — the safeguarding route in cases.ts is where it belongs.
 */
export function triage(input: { category: string; subject: string; body: string }): {
  priority: 'low' | 'normal' | 'high' | 'urgent';
  redirectToSafeguarding: boolean;
  note: string | null;
} {
  const text = `${input.subject} ${input.body}`.toLowerCase();
  const safeguardingWords = /\b(abuse|abused|assault|assaulted|molest|groom(ed|ing)?|unsafe|hurt my child|hit my child)\b/;

  if (safeguardingWords.test(text)) {
    return {
      priority: 'urgent',
      redirectToSafeguarding: true,
      note: 'This mentions harm to a person. It should be handled as a safeguarding concern, not as a support ticket.',
    };
  }

  return { priority: 'normal', redirectToSafeguarding: false, note: null };
}

// ─── The conversation ───────────────────────────────────────────────────────

async function loadTicket(db: DB, ticketId: number) {
  const [row] = await db.select().from(g.supportTickets)
    .where(eq(g.supportTickets.id, ticketId)).limit(1);
  if (!row) throw new SupportError('not_found', `No ticket ${ticketId}.`);
  return row;
}

export interface PostMessageInput {
  ticketId: number;
  body: string;
  /** 'requester' | 'staff' | 'system'. */
  authorKind: 'requester' | 'staff' | 'system';
  authorName?: string | null;
  /** Staff-only note. Refused outright on a requester message — see below. */
  internal?: boolean;
  attachments?: unknown[] | null;
  now?: Date;
}

/**
 * Add a message to a ticket.
 *
 * `internal` is refused on a message from a requester. Not ignored — refused.
 * Silently accepting it would let a caller mark their own message internal, and
 * an internal message is one the requester does not see, so the ticket would
 * then contain something its own author cannot read. That is a confusing state
 * to arrive at by accident and a useful one to arrive at deliberately.
 */
export async function postTicketMessage(db: DB, ctx: AuditContext, input: PostMessageInput) {
  const now = input.now ?? new Date();
  const body = (input.body ?? '').trim();
  if (!body) throw new SupportError('empty', 'A message cannot be empty.');

  const ticket = await loadTicket(db, input.ticketId);

  if (input.authorKind === 'staff' || input.internal) {
    assertCanAnywhere(ctx.principal, 'support:write');
  }
  if (input.authorKind === 'requester' && input.internal) {
    throw new SupportError('not_internal', 'A message from the person who raised the ticket cannot be internal.');
  }

  const [row] = await db.insert(o.ticketMessages).values({
    ticketId: input.ticketId,
    at: now,
    authorKind: input.authorKind,
    authorUserId: ctx.principal.userId ?? null,
    authorName: input.authorName ?? ctx.principal.label ?? null,
    body,
    internal: input.internal === true,
    attachments: (input.attachments ?? null) as any,
  }).returning();

  // A public reply from staff is a response for service-standard purposes; an
  // internal note is not. `firstResponseAt` is set once and never moved — see
  // respondToTicket in cases.ts, which made the same decision for the same
  // reason: a measurement that can be rewritten measures nothing.
  const patch: Record<string, unknown> = { lastActivityAt: now };
  if (input.authorKind === 'staff' && !input.internal && !ticket.firstResponseAt) {
    patch.firstResponseAt = now;
  }
  if (input.authorKind === 'requester' && ticket.status === 'awaiting_member') {
    patch.status = 'in_progress';
  }
  await db.update(g.supportTickets).set(patch).where(eq(g.supportTickets.id, input.ticketId));

  return row;
}

/**
 * The thread.
 *
 * `includeInternal` is decided HERE from the principal, never passed in by a
 * caller. A boolean argument controlling whether private staff notes are
 * returned is a boolean that will one day be wired to a query parameter.
 */
export async function ticketThread(db: DB, principal: Principal | null, ticketId: number) {
  const staff = canAnywhere(principal, 'support:read');
  const rows = await db.select().from(o.ticketMessages)
    .where(staff
      ? eq(o.ticketMessages.ticketId, ticketId)
      : and(eq(o.ticketMessages.ticketId, ticketId), eq(o.ticketMessages.internal, false)))
    .orderBy(asc(o.ticketMessages.at));
  return rows;
}

// ─── Institution linkage ────────────────────────────────────────────────────

/** Attach a ticket to the client it came from, so it appears in their portal. */
export async function linkTicketToInstitution(
  db: DB, ctx: AuditContext, ticketId: number, institutionId: number
) {
  assertCanAnywhere(ctx.principal, 'support:write');
  const [row] = await db.update(g.supportTickets)
    .set({ institutionId })
    .where(eq(g.supportTickets.id, ticketId))
    .returning();
  if (!row) throw new SupportError('not_found', `No ticket ${ticketId}.`);

  await writeAudit(db, ctx, {
    entityType: 'support_ticket', entityId: ticketId, action: 'update',
    newValue: { institutionId },
  });
  return row;
}

/**
 * The tickets one client can see.
 *
 * Filtered on institutionId in SQL, and confidential tickets are excluded
 * outright. A ticket marked confidential is one the federation is handling
 * about a client rather than with them.
 */
export async function institutionTickets(
  db: DB, principal: Principal, institutionId: number, limit = 50
) {
  const scopes = visibleScopes(principal, 'support:read');
  const permitted =
    scopes.kind === 'all' ||
    (scopes.kind === 'scoped' && scopes.institutions.includes(institutionId));
  if (!permitted) throw new SupportError('forbidden', 'Those tickets are outside your scope.');

  return db.select({
    id: g.supportTickets.id,
    ticketNo: g.supportTickets.ticketNo,
    category: g.supportTickets.category,
    subject: g.supportTickets.subject,
    status: g.supportTickets.status,
    createdAt: g.supportTickets.createdAt,
    lastActivityAt: g.supportTickets.lastActivityAt,
    resolvedAt: g.supportTickets.resolvedAt,
  })
    .from(g.supportTickets)
    .where(and(
      eq(g.supportTickets.institutionId, institutionId),
      eq(g.supportTickets.confidential, false)
    ))
    .orderBy(desc(g.supportTickets.createdAt))
    .limit(Math.min(limit, 200));
}

// ─── Escalation ─────────────────────────────────────────────────────────────

/**
 * Raise tickets that have gone unanswered. Run by the daily cron.
 *
 * ONLY ACTS WHERE A STANDARD EXISTS. `slaDueAt` is null unless the federation
 * published a response time, and a null deadline is not a breach — it is an
 * unmeasured ticket. Escalating on a deadline nobody set would manufacture
 * urgency out of the federation's own silence, which is the same mistake as
 * printing "we reply within 48 hours" on a page nobody agreed to.
 *
 * Tickets waiting on the member are excluded: the clock is not running on the
 * federation while it is running on somebody else.
 */
export async function escalateStaleTickets(
  db: DB, ctx: AuditContext, now: Date = new Date(), limit = 100
): Promise<{ escalated: number; tickets: string[] }> {
  const due = await db.select().from(g.supportTickets)
    .where(and(
      isNotNull(g.supportTickets.slaDueAt),
      lte(g.supportTickets.slaDueAt, now),
      isNull(g.supportTickets.firstResponseAt),
      inArray(g.supportTickets.status, ['open', 'in_progress'])
    ))
    .orderBy(asc(g.supportTickets.slaDueAt))
    .limit(limit);

  const tickets: string[] = [];

  for (const t of due) {
    const [updated] = await db.update(g.supportTickets).set({
      status: 'escalated',
      escalationLevel: sql`${g.supportTickets.escalationLevel} + 1`,
      escalatedAt: now,
      // The holder did not answer, so it returns to the department queue rather
      // than being handed to another named individual who is equally able to
      // not answer it.
      assignedToUserId: null,
      priority: t.priority === 'urgent' ? 'urgent' : t.priority === 'high' ? 'urgent' : 'high',
    }).where(and(eq(g.supportTickets.id, t.id), eq(g.supportTickets.status, t.status)))
      .returning();

    if (!updated) continue;

    await db.insert(o.ticketMessages).values({
      ticketId: t.id, at: now, authorKind: 'system',
      authorName: 'MMAKF service monitor',
      body: `No response was recorded by the published deadline. Escalated to level ${updated.escalationLevel}.`,
      internal: true,
    });

    await writeAudit(db, ctx, {
      entityType: 'support_ticket', entityId: t.id, action: 'update',
      oldValue: { status: t.status, escalationLevel: t.escalationLevel },
      newValue: { status: 'escalated', escalationLevel: updated.escalationLevel },
    });

    tickets.push(t.ticketNo);
  }

  return { escalated: tickets.length, tickets };
}

/** Reopen a resolved ticket, counting how often it has happened. */
export async function reopenTicket(
  db: DB, ctx: AuditContext, ticketId: number, why: string, now = new Date()
) {
  assertCanAnywhere(ctx.principal, 'support:write');
  const reason = (why ?? '').trim();
  if (!reason) throw new SupportError('reason_required', 'Say why the ticket is being reopened.');

  const ticket = await loadTicket(db, ticketId);
  if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
    throw new SupportError('not_resolved', `That ticket is ${ticket.status}, so there is nothing to reopen.`);
  }

  const [row] = await db.update(g.supportTickets).set({
    status: 'in_progress',
    resolvedAt: null,
    reopenedCount: sql`${g.supportTickets.reopenedCount} + 1`,
    lastActivityAt: now,
  }).where(eq(g.supportTickets.id, ticketId)).returning();

  await db.insert(o.ticketMessages).values({
    ticketId, at: now, authorKind: 'system',
    authorName: ctx.principal.label,
    body: `Reopened: ${reason}`,
    internal: true,
  });

  await writeAudit(db, { ...ctx, reason }, {
    entityType: 'support_ticket', entityId: ticketId, action: 'update',
    oldValue: { status: ticket.status }, newValue: { status: 'in_progress', reopened: true },
  });

  return row;
}

// ─── The desk view ──────────────────────────────────────────────────────────

export interface DeskOptions {
  status?: string | string[];
  category?: string;
  department?: string;
  institutionId?: number;
  unassignedOnly?: boolean;
  breachedOnly?: boolean;
  limit?: number;
  now?: Date;
}

/**
 * The queue an agent works from.
 *
 * Note the ordering: escalated first, then by how long the ticket has been
 * waiting. Not by priority alone — priority is a judgement made at intake and
 * an old normal-priority ticket has usually become the more urgent thing.
 */
export async function supportDesk(db: DB, principal: Principal, opts: DeskOptions = {}) {
  assertCanAnywhere(principal, 'support:read');
  const now = opts.now ?? new Date();
  const scopes = visibleScopes(principal, 'support:read');
  if (scopes.kind === 'none') return [];

  const where: any[] = [];

  // Confidential tickets are national-desk work. A scoped administrator sees
  // the ordinary queue for their own area and not the sensitive ones.
  if (scopes.kind !== 'all') {
    where.push(eq(g.supportTickets.confidential, false));
    if (scopes.institutions.length) {
      where.push(inArray(g.supportTickets.institutionId, scopes.institutions));
    }
  }

  if (opts.status) {
    where.push(Array.isArray(opts.status)
      ? inArray(g.supportTickets.status, opts.status as any)
      : eq(g.supportTickets.status, opts.status as any));
  }
  if (opts.category) where.push(eq(g.supportTickets.category, opts.category));
  if (opts.department) where.push(eq(g.supportTickets.department, opts.department));
  if (opts.institutionId != null) where.push(eq(g.supportTickets.institutionId, opts.institutionId));
  if (opts.unassignedOnly) where.push(isNull(g.supportTickets.assignedToUserId));
  if (opts.breachedOnly) {
    where.push(and(
      isNotNull(g.supportTickets.slaDueAt),
      lte(g.supportTickets.slaDueAt, now),
      isNull(g.supportTickets.firstResponseAt)
    ));
  }

  const q = db.select().from(g.supportTickets);
  return (where.length ? q.where(and(...where)) : q)
    .orderBy(desc(g.supportTickets.escalationLevel), asc(g.supportTickets.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200));
}

/** Counts for the command centre. */
export async function supportCounts(db: DB, principal: Principal, now = new Date()) {
  if (!canAnywhere(principal, 'support:read')) {
    return { open: 0, unassigned: 0, escalated: 0, awaitingMember: 0, breached: 0 };
  }
  const rows = await supportDesk(db, principal, { limit: 200, now });
  const live = rows.filter((t: any) => !['resolved', 'closed'].includes(t.status));
  return {
    open: live.length,
    unassigned: live.filter((t: any) => t.assignedToUserId == null).length,
    escalated: live.filter((t: any) => t.status === 'escalated' || (t.escalationLevel ?? 0) > 0).length,
    awaitingMember: live.filter((t: any) => t.status === 'awaiting_member').length,
    // Only counts tickets that HAVE a deadline. See escalateStaleTickets.
    breached: live.filter((t: any) => t.slaDueAt && new Date(t.slaDueAt) <= now && !t.firstResponseAt).length,
  };
}
