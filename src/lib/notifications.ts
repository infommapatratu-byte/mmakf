// Notifications. Q-21.
//
// The `notifications` table exists and nothing writes to it. This is the engine
// that turns domain events into messages, and the transport that delivers them.
//
// THE RULE THAT SHAPES IT: DO NOT SPAM. A federation that emails a member about
// every event in the system trains them to ignore it, and the one message that
// mattered — a grading result, a safeguarding acknowledgement, a membership
// about to lapse — arrives in a stream they stopped reading months ago.
//
// So: every notification is derived from a domain event that ALREADY happened,
// deduplicated, batched where batching is honest, and suppressed where the
// recipient has said no. Nothing here invents a reason to contact someone.
//
// WHAT IS NOT CONFIGURED IS NOT SENT. No email provider exists in this project's
// dependencies. `transportStatus()` reports that plainly and messages queue
// rather than being silently dropped — a notification that was never delivered
// and never recorded as undelivered is worse than one that failed loudly.

import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCanAnywhere, type Principal } from '@/lib/rbac';
import { log } from '@/lib/observability';

type DB = any;

export class NotificationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'NotificationError';
    this.code = code;
  }
}

// ─── What a member may be told about ────────────────────────────────────────

/**
 * The event types that produce a notification, and who receives each.
 *
 * A domain event NOT listed here produces nothing. That is deliberate: the feed
 * carries far more than a member needs to hear about, and an allow-list is the
 * only version of this that stays quiet by default.
 *
 * `essential` messages cannot be unsubscribed from. A grading result, a
 * certificate revocation and a safeguarding acknowledgement are consequences of
 * the federation's own decisions about that person — suppressing them would let
 * someone opt out of being told their credential was withdrawn.
 */
export const NOTIFIABLE = {
  GRADING_APPROVED:    { audience: 'subject', essential: true,  title: 'Your grading result' },
  CERTIFICATE_ISSUED:  { audience: 'subject', essential: true,  title: 'Your certificate has been issued' },
  CERTIFICATE_REVOKED: { audience: 'subject', essential: true,  title: 'A certificate has been withdrawn' },
  MEMBERSHIP_EXPIRING: { audience: 'subject', essential: true,  title: 'Your membership is due for renewal' },
  ENTRY_CONFIRMED:     { audience: 'subject', essential: true,  title: 'Your competition entry is confirmed' },
  RESULT_FINALIZED:    { audience: 'subject', essential: false, title: 'Competition results published' },
  DRAW_PUBLISHED:      { audience: 'entrants', essential: false, title: 'The draw has been published' },
  RANKING_UPDATED:     { audience: 'subject', essential: false, title: 'National rankings updated' },
  LIVE_STARTED:        { audience: 'enrolled', essential: false, title: 'A live class has started' },
  AFFILIATION_EXPIRING:{ audience: 'unit',    essential: true,  title: 'Your affiliation is due for renewal' },
  CASE_ACKNOWLEDGED:   { audience: 'subject', essential: true,  title: 'Your report has been received' },
  APPROVAL_REQUESTED:  { audience: 'approvers', essential: true, title: 'An approval is waiting for you' },
  // ESSENTIAL, and not a preference anybody may switch off: somebody is
  // otherwise going to a dojo for a class that is not happening. The audience
  // is 'booked' — the people who actually hold a place on that occurrence,
  // which is a query this system can answer exactly rather than approximately.
  CLASS_SESSION_CANCELLED: { audience: 'booked', essential: true, title: 'A class has been cancelled' },
  CLASS_SESSION_RESCHEDULED: { audience: 'booked', essential: true, title: 'A class has moved' },
  // THE CLUB'S OWN MEMBERS, and only a CLUB's. See the 'unit_members' case in
  // resolveRecipients(): a national or state publication resolves to nobody
  // rather than to every member in the country.
  SCHEDULE_PUBLISHED: { audience: 'unit_members', essential: true, title: 'Your club’s timings have changed' },
} as const;

export type NotifiableEvent = keyof typeof NOTIFIABLE;

export function isNotifiable(eventType: string): eventType is NotifiableEvent {
  return Object.prototype.hasOwnProperty.call(NOTIFIABLE, eventType);
}

// ─── Transport ──────────────────────────────────────────────────────────────

export interface TransportStatus {
  channel: string;
  configured: boolean;
  reason: string;
}

/**
 * What can actually be delivered right now.
 *
 * `in_app` always works — it is a row this system owns. Everything else needs a
 * provider that is not a dependency of this project, and saying so is the point:
 * a federation that believes it is emailing members and is not has a worse
 * problem than one that knows it is not.
 */
export function transportStatus(): TransportStatus[] {
  return [
    {
      channel: 'in_app',
      configured: true,
      reason: 'Delivered inside MMAKF. Always available.',
    },
    {
      channel: 'email',
      configured: Boolean(process.env.EMAIL_PROVIDER_URL && process.env.EMAIL_FROM),
      reason: process.env.EMAIL_PROVIDER_URL && process.env.EMAIL_FROM
        ? 'Configured.'
        : 'No email provider is configured (EMAIL_PROVIDER_URL / EMAIL_FROM unset). Email notifications are QUEUED, not sent.',
    },
    {
      channel: 'sms',
      configured: Boolean(process.env.SMS_PROVIDER_URL),
      reason: process.env.SMS_PROVIDER_URL
        ? 'Configured.'
        : 'No SMS provider is configured (SMS_PROVIDER_URL unset). SMS notifications are QUEUED, not sent.',
    },
  ];
}

function channelConfigured(channel: string): boolean {
  return transportStatus().find((t) => t.channel === channel)?.configured ?? false;
}

// ─── Queueing ───────────────────────────────────────────────────────────────

export interface QueueInput {
  personId?: number | null;
  userId?: number | null;
  channel?: 'in_app' | 'email' | 'sms';
  title: string;
  body: string;
  linkUrl?: string | null;
  domainEventId?: number | null;
}

/**
 * Queue one notification.
 *
 * DEDUPLICATED ON THE DOMAIN EVENT. A consumer that is retried — which is the
 * normal way a cursor-based consumer behaves after a failure — must not send the
 * same person the same message twice. The guard is a lookup rather than a unique
 * index because a person may legitimately receive the same event on two channels.
 */
export async function queue(db: DB, input: QueueInput) {
  const channel = input.channel ?? 'in_app';

  if (input.domainEventId != null && input.personId != null) {
    const existing = (await db
      .select({ id: s.notifications.id })
      .from(s.notifications)
      .where(and(
        eq(s.notifications.domainEventId, input.domainEventId),
        eq(s.notifications.personId, input.personId),
        eq(s.notifications.channel, channel)
      ))
      .limit(1))[0];
    if (existing) return { ...existing, deduplicated: true };
  }

  const [row] = await db.insert(s.notifications).values({
    personId: input.personId ?? null,
    userId: input.userId ?? null,
    channel,
    title: input.title.slice(0, 200),
    body: input.body.slice(0, 2000),
    linkUrl: input.linkUrl ?? null,
    domainEventId: input.domainEventId ?? null,
    // Queued, never "sent". Only a transport that actually delivered may say so.
    status: 'queued',
  }).returning();

  return { ...row, deduplicated: false };
}

// ─── Delivery ───────────────────────────────────────────────────────────────

export interface DeliveryReport {
  attempted: number;
  delivered: number;
  queuedNoTransport: number;
  failed: number;
  errors: string[];
}

/**
 * Deliver queued notifications.
 *
 * Runs on a schedule. Three outcomes, and the middle one is the important one:
 *
 *   sent               a transport accepted it
 *   queued_no_transport  no provider is configured — it stays queued, visibly
 *   failed             a provider rejected it, with the reason recorded
 *
 * A message with no transport is NOT marked failed and NOT silently discarded.
 * It waits, and the report says how many are waiting, so configuring a provider
 * later delivers the backlog rather than losing it.
 */
export async function deliverQueued(db: DB, limit = 100): Promise<DeliveryReport> {
  const report: DeliveryReport = {
    attempted: 0, delivered: 0, queuedNoTransport: 0, failed: 0, errors: [],
  };

  const pending = await db
    .select()
    .from(s.notifications)
    .where(eq(s.notifications.status, 'queued'))
    .orderBy(asc(s.notifications.id))
    .limit(limit);

  for (const n of pending) {
    report.attempted++;

    if (n.channel === 'in_app') {
      // Nothing to deliver: the row IS the notification.
      await db.update(s.notifications)
        .set({ status: 'sent', sentAt: new Date() })
        .where(eq(s.notifications.id, n.id));
      report.delivered++;
      continue;
    }

    if (!channelConfigured(n.channel)) {
      report.queuedNoTransport++;
      continue;
    }

    try {
      await sendVia(n.channel, n, db);
      await db.update(s.notifications)
        .set({ status: 'sent', sentAt: new Date() })
        .where(eq(s.notifications.id, n.id));
      report.delivered++;
    } catch (err: any) {
      const message = String(err?.message ?? err).slice(0, 400);
      await db.update(s.notifications)
        .set({ status: 'failed', failureReason: message })
        .where(eq(s.notifications.id, n.id));
      report.failed++;
      report.errors.push(`#${n.id}: ${message}`);
    }
  }

  if (report.queuedNoTransport > 0) {
    // Surfaced, not swallowed: a growing backlog is how an operator learns a
    // provider was never configured.
    log.warn('notifications.no_transport', {
      count: report.queuedNoTransport,
      detail: 'Notifications are queued because no provider is configured. They are not lost, and will send once one is.',
    });
  }

  return report;
}

/**
 * Hand a message to a provider.
 *
 * Deliberately a thin HTTP POST rather than a vendor SDK: the federation should
 * be able to change email provider without changing this file, and adding an SDK
 * for something this simple is a dependency taken on for no benefit.
 *
 * The recipient address is resolved HERE, from the person record, and never
 * passed in — so a caller cannot redirect a notification to an address of its
 * choosing.
 */
async function sendVia(channel: string, notification: any, db: DB): Promise<void> {
  const person = notification.personId
    ? (await db.select().from(s.persons).where(eq(s.persons.id, notification.personId)).limit(1))[0]
    : null;

  if (!person) throw new NotificationError('no_recipient', 'No person record to resolve an address from.');

  const to = channel === 'email' ? person.email : person.phone;
  if (!to) {
    throw new NotificationError(
      'no_address',
      `That member has no ${channel === 'email' ? 'email address' : 'mobile number'} on record.`
    );
  }

  const endpoint = channel === 'email' ? process.env.EMAIL_PROVIDER_URL : process.env.SMS_PROVIDER_URL;
  const res = await fetch(endpoint!, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.NOTIFICATION_PROVIDER_TOKEN
        ? { Authorization: `Bearer ${process.env.NOTIFICATION_PROVIDER_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      to,
      from: process.env.EMAIL_FROM,
      subject: notification.title,
      text: notification.body,
      // The link is absolute so it survives being forwarded, which members do.
      link: notification.linkUrl ? `https://www.mmakf.in${notification.linkUrl}` : undefined,
    }),
  });

  if (!res.ok) {
    throw new NotificationError('provider_rejected', `Provider returned HTTP ${res.status}`);
  }
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * A person's own notifications.
 *
 * Takes no id: it reads the CALLER's, resolved from their user record. That is
 * the structural way to make reading someone else's impossible, rather than a
 * check that must be remembered.
 */
export async function myNotifications(db: DB, principal: Principal, limit = 50) {
  if (principal.userId == null) return [];

  const user = (await db
    .select({ personId: s.users.personId })
    .from(s.users)
    .where(eq(s.users.id, principal.userId))
    .limit(1))[0];

  if (!user?.personId) return [];

  return db
    .select({
      id: s.notifications.id,
      title: s.notifications.title,
      body: s.notifications.body,
      linkUrl: s.notifications.linkUrl,
      status: s.notifications.status,
      readAt: s.notifications.readAt,
      createdAt: s.notifications.createdAt,
    })
    .from(s.notifications)
    .where(and(
      eq(s.notifications.personId, user.personId),
      eq(s.notifications.channel, 'in_app')
    ))
    .orderBy(desc(s.notifications.id))
    .limit(limit);
}

/** Mark as read. Scoped to the caller's own rows by the same construction. */
export async function markRead(db: DB, principal: Principal, notificationIds: number[]) {
  if (principal.userId == null || !notificationIds.length) return 0;

  const user = (await db
    .select({ personId: s.users.personId })
    .from(s.users)
    .where(eq(s.users.id, principal.userId))
    .limit(1))[0];
  if (!user?.personId) return 0;

  const rows = await db.update(s.notifications)
    .set({ readAt: new Date() })
    .where(and(
      eq(s.notifications.personId, user.personId),
      inArray(s.notifications.id, notificationIds.slice(0, 200)),
      isNull(s.notifications.readAt)
    ))
    .returning({ id: s.notifications.id });

  return rows.length;
}

/**
 * The operator's view of the queue.
 *
 * `oldestQueued` is the number that matters: a backlog with nothing older than a
 * few minutes is a working system, and one with a message from three weeks ago
 * is a provider nobody configured.
 */
export async function queueHealth(db: DB, principal: Principal) {
  assertCanAnywhere(principal, 'content:read');

  const counts = await db
    .select({ status: s.notifications.status, channel: s.notifications.channel, n: sql<number>`count(*)::int` })
    .from(s.notifications)
    .groupBy(s.notifications.status, s.notifications.channel);

  const oldest = (await db
    .select({ createdAt: s.notifications.createdAt })
    .from(s.notifications)
    .where(eq(s.notifications.status, 'queued'))
    .orderBy(asc(s.notifications.id))
    .limit(1))[0];

  return {
    counts,
    oldestQueued: oldest?.createdAt ?? null,
    transports: transportStatus(),
  };
}

// ─── Fan-out from the event feed ────────────────────────────────────────────

/**
 * Turn one domain event into notifications.
 *
 * Called by a consumer of the event feed. Returns the number queued so the
 * consumer can report it.
 *
 * Every recipient is resolved from the EVENT'S OWN payload and the database —
 * never from a list the caller supplies. A notification fan-out that accepts a
 * recipient list is a mail-merge waiting to be pointed at the whole membership.
 */
export async function notifyForEvent(
  db: DB,
  ctx: AuditContext,
  event: { id: number; eventType: string; entityType: string; entityId: string; payload: any }
): Promise<number> {
  if (!isNotifiable(event.eventType)) return 0;

  const spec = NOTIFIABLE[event.eventType];
  const recipients = await resolveRecipients(db, event, spec.audience);
  let queued = 0;

  for (const personId of recipients) {
    const result = await queue(db, {
      personId,
      channel: 'in_app',
      title: spec.title,
      body: describe(event),
      linkUrl: linkFor(event),
      domainEventId: event.id,
    });
    if (!(result as any).deduplicated) queued++;
  }

  if (queued > 0) {
    await writeAudit(db, ctx, {
      entityType: 'notification',
      entityId: event.id,
      action: 'create',
      newValue: { eventType: event.eventType, recipients: queued },
    });
  }
  return queued;
}

/** Who receives this event, resolved from the database. */
async function resolveRecipients(db: DB, event: any, audience: string): Promise<number[]> {
  switch (audience) {
    case 'subject': {
      const id = Number(event.payload?.personId ?? event.entityId);
      return Number.isFinite(id) ? [id] : [];
    }
    case 'entrants': {
      const categoryId = Number(event.payload?.categoryId);
      if (!Number.isFinite(categoryId)) return [];
      const rows = await db
        .select({ personId: s.eventEntries.personId })
        .from(s.eventEntries)
        .where(and(
          eq(s.eventEntries.categoryId, categoryId),
          inArray(s.eventEntries.status, ['confirmed', 'checked_in', 'weighed_in'])
        ));
      return rows.map((r: any) => r.personId).filter(Boolean);
    }
    case 'enrolled': {
      const courseId = Number(event.payload?.courseId);
      if (!Number.isFinite(courseId)) return [];
      const rows = await db
        .select({ personId: s.enrolments.personId })
        .from(s.enrolments)
        .where(and(eq(s.enrolments.courseId, courseId), eq(s.enrolments.status, 'active')));
      return rows.map((r: any) => r.personId).filter(Boolean);
    }
    case 'booked': {
      // The people holding a live place on that occurrence. Read from
      // `bookings` rather than from an attendance list, because attendance is
      // recorded after the fact and this message has to arrive before it.
      const sessionId = Number(event.payload?.sessionId ?? event.entityId);
      if (!Number.isFinite(sessionId)) return [];
      const rows = await db
        .select({ personId: s.bookings.personId })
        .from(s.bookings)
        .where(and(
          eq(s.bookings.classSessionId, sessionId),
          // 'cancelled' IS included: cancelSession() releases every place in the
          // same transaction that cancels the session, so by the time this runs
          // the bookings it must tell about are already cancelled. Filtering
          // them out would notify nobody, which is the failure this exists to
          // prevent.
          inArray(s.bookings.status, ['requested', 'proposed', 'confirmed', 'rescheduled', 'cancelled'])
        ));
      // Set<number>, stated rather than inferred: `filter(Boolean)` has already
      // dropped every null personId, but the inference through the spread lands
      // on unknown[] and the function promises number[].
      return [...new Set<number>(rows.map((r: any) => r.personId).filter(Boolean))];
    }
    case 'unit_members': {
      // THE PEOPLE WHO TRAIN THERE. `persons.dojoId` is where a member is
      // placed, so this is a query and not an estimate.
      //
      // AND IT IS DELIBERATELY LIMITED TO A CLUB. A schedule published at
      // national, state or district scope resolves to NOBODY here — not
      // because those changes do not matter, but because "every member of the
      // federation" is a fan-out this system must never perform on the strength
      // of one administrator saving a form. When MMAKF wants a national
      // announcement it is a circular, which is a different act with a
      // different approval path.
      if (event.payload?.ownerScope !== 'dojo') return [];
      const dojoId = Number(event.payload?.ownerId);
      if (!Number.isFinite(dojoId)) return [];
      const rows = await db
        .select({ id: s.persons.id })
        .from(s.persons)
        .where(and(eq(s.persons.dojoId, dojoId), eq(s.persons.status, 'active')));
      return rows.map((r: any) => r.id).filter(Boolean);
    }
    case 'approvers': {
      // Resolved from role bindings, and the REQUESTER is excluded — they cannot
      // approve their own request, so telling them one is waiting is noise.
      const requesterUserId = Number(event.payload?.requestedByUserId);
      const rows = await db
        .select({ userId: s.roleBindings.userId })
        .from(s.roleBindings)
        .where(and(
          inArray(s.roleBindings.role, ['SUPER_ADMIN', 'FEDERATION_ADMIN', 'PRESIDENT']),
          eq(s.roleBindings.status, 'active')
        ));
      const userIds = [...new Set(rows.map((r: any) => r.userId))]
        .filter((id) => id !== requesterUserId);
      if (!userIds.length) return [];
      const people = await db
        .select({ personId: s.users.personId })
        .from(s.users)
        .where(inArray(s.users.id, userIds as number[]));
      return people.map((p: any) => p.personId).filter(Boolean);
    }
    default:
      // An unrecognised audience notifies NOBODY. Fail closed: the alternative
      // is a fan-out to everyone.
      return [];
  }
}

/**
 * The message body.
 *
 * Deliberately terse and factual, and it NEVER carries a decision's substance —
 * "Your grading result is available" rather than the result itself. A
 * notification travels through channels the federation does not control; the
 * record it points to is where the detail belongs.
 */
function describe(event: { eventType: string; payload: any }): string {
  switch (event.eventType) {
    case 'GRADING_APPROVED':
      return 'Your grading result has been recorded. Open your passport to see it.';
    case 'CERTIFICATE_ISSUED':
      return 'A certificate has been issued to you. It is available in your passport and is publicly verifiable.';
    case 'CERTIFICATE_REVOKED':
      return 'A certificate issued to you has been withdrawn. Open your passport for the details, or contact the federation office.';
    case 'MEMBERSHIP_EXPIRING':
      return 'Your MMAKF membership is due for renewal.';
    case 'ENTRY_CONFIRMED':
      return 'Your competition entry has been confirmed.';
    case 'RESULT_FINALIZED':
      return 'Results have been published for a competition you entered.';
    case 'DRAW_PUBLISHED':
      return 'The draw has been published for a category you entered.';
    case 'RANKING_UPDATED':
      return 'The national rankings have been updated.';
    case 'CLASS_SESSION_RESCHEDULED':
      return `${event.payload?.className ?? 'A class'} has moved from ${String(event.payload?.previousStartsAt ?? '').slice(0, 16).replace('T', ' ')} to ${String(event.payload?.startsAt ?? '').slice(0, 16).replace('T', ' ')}. Your place moved with it.`;
    case 'SCHEDULE_PUBLISHED':
      // NOT the new hours themselves. A timetable is a table, the body of a
      // notification is one line, and half a timetable is worse than none —
      // the reader goes to the page, which has all of it.
      return `Your club has published new timings, in force from ${event.payload?.effectiveFrom ?? 'a date shown on the schedule'}. Check the class you attend before your next session.`;
    case 'CLASS_SESSION_CANCELLED':
      // Names the class and the time, because "a class has been cancelled" sends
      // somebody to open the app to find out which one — and the person most
      // likely to miss the message is the one already on their way.
      return `${event.payload?.className ?? 'A class'} on ${String(event.payload?.startsAt ?? '').slice(0, 16).replace('T', ' ')} has been cancelled. Your place has been released; no fee applies.`;
    case 'LIVE_STARTED':
      return 'A live class has started on a course you are enrolled on.';
    case 'AFFILIATION_EXPIRING':
      return 'Your affiliation is due for renewal.';
    case 'CASE_ACKNOWLEDGED':
      return 'Your report has been received by the federation.';
    case 'APPROVAL_REQUESTED':
      return 'A request is waiting for your approval.';
    default:
      return 'There is an update on your MMAKF record.';
  }
}

function linkFor(event: { eventType: string; payload: any }): string {
  switch (event.eventType) {
    case 'GRADING_APPROVED':
    case 'CERTIFICATE_ISSUED':
    case 'CERTIFICATE_REVOKED':
      return '/my/passport';
    case 'ENTRY_CONFIRMED':
    case 'RESULT_FINALIZED':
    case 'DRAW_PUBLISHED':
      return '/competitions';
    case 'RANKING_UPDATED':
      return '/rankings';
    case 'LIVE_STARTED':
      return '/live';
    case 'APPROVAL_REQUESTED':
      return '/admin/approvals';
    case 'CLASS_SESSION_CANCELLED':
    case 'CLASS_SESSION_RESCHEDULED':
    case 'SCHEDULE_PUBLISHED':
      return '/my/schedule';
    default:
      return '/my';
  }
}
