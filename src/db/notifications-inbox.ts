// The notification centre — the reading side (§T, §47, §103).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS SITS BESIDE src/lib/notifications.ts RATHER THAN INSIDE IT
// ─────────────────────────────────────────────────────────────────────────────
//
// src/lib/notifications.ts is the ENGINE: the allow-list of events that may
// produce a message, the queue, the transports, the fan-out from the event
// feed, and the deliberate refusal to mark anything `sent` that no provider
// accepted. It is covered by tests/notifications.test.ts and nothing here
// changes it.
//
// This module is the two READING surfaces — a member's inbox and an operator's
// view of delivery. It exists as its own file for one reason: the inbox needs
// columns `myNotifications()` does not return (topic, priority, channel, the
// originating event), and widening that function would change what every
// existing caller gets in order to serve one page.
//
// WHAT IS NOT DUPLICATED. `markRead` is imported from the engine and
// re-exported. It is the one write on the member's side, it is already scoped
// to the caller by construction, and tests/notifications.test.ts already proves
// that one member cannot mark another's rows read. A second UPDATE against the
// same table, written here, would be a second thing to get wrong.
//
// ─────────────────────────────────────────────────────────────────────────────
// A RECIPIENT IS RESOLVED FROM THE SESSION. ALWAYS.
// ─────────────────────────────────────────────────────────────────────────────
//
// Every function on the member's side takes a Principal and no identifier. There
// is no personId parameter to pass the wrong value to, and no query parameter a
// page could forward. The request cannot express "show me somebody else's
// inbox", which is a stronger guarantee than a check made after the question has
// been asked.
//
// ─────────────────────────────────────────────────────────────────────────────
// NOTHING HERE INVENTS A CATEGORY, A PRIORITY OR AN ACTION
// ─────────────────────────────────────────────────────────────────────────────
//
// §103 asks every notification to answer three questions: what happened, what it
// means, and what the reader can do. Those come from `title`, `body` and
// `linkUrl` on the stored row. A row with no link has no third answer, and the
// honest rendering is to omit the action — not to reach for a plausible one.
// `topic` and `priority` are the same: the engine does not set them today, so
// most rows carry none, and a surface that displays "Normal priority · General"
// on every row would be printing a fact nobody recorded.

import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import * as s from '@/db/schema';
import { assertCanAnywhere, visibleScopes, type Principal } from '@/lib/rbac';
import { markRead } from '@/lib/notifications';

type DB = any;

/**
 * Re-exported, not reimplemented. See the note at the top of this file.
 *
 * `markRead(db, principal, ids)` marks only rows whose personId is the caller's
 * own, and only ones not already read, and returns how many actually moved.
 */
export { markRead };

export class InboxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'InboxError';
    this.code = code;
  }
}

/** Shape check rather than `instanceof` — consistent with the other db modules. */
export function isInboxError(err: unknown): err is InboxError {
  return !!err && typeof err === 'object' && (err as any).name === 'InboxError'
    && typeof (err as any).code === 'string';
}

// ─── Who is reading ─────────────────────────────────────────────────────────

export interface Recipient {
  userId: number;
  personId: number;
}

/**
 * The caller's own recipient identity, or null.
 *
 * Null has three distinct causes and the caller is expected to tell them apart
 * for the reader: no session at all, a SHARED credential (the office password,
 * which is attributable to no individual and therefore has no inbox), and an
 * account not yet linked to a person. They are three different sentences and
 * none of them is "you have no notifications".
 */
export async function recipientFor(db: DB, principal: Principal | null | undefined): Promise<Recipient | null> {
  if (!principal || principal.userId == null) return null;

  const [user] = await db
    .select({ personId: s.users.personId })
    .from(s.users)
    .where(eq(s.users.id, principal.userId))
    .limit(1);

  if (!user?.personId) return null;
  return { userId: principal.userId, personId: user.personId };
}

// ─── The inbox ──────────────────────────────────────────────────────────────

/**
 * A ceiling, because an inbox is unbounded and this page must stay openable.
 *
 * Deliberately not pagination. A member with more than a hundred unread notices
 * has a different problem, and the surface says how many are not shown rather
 * than offering a second page nobody would reach the end of either.
 */
export const INBOX_LIMIT = 100;

export interface InboxItem {
  id: number;
  /** §103 — what happened. */
  title: string;
  /** §103 — what it means. */
  body: string;
  /** §103 — what I can do. Null for a row that records no action. */
  linkUrl: string | null;
  topic: string | null;
  priority: string;
  channel: string;
  status: string;
  readAt: Date | null;
  sentAt: Date | null;
  createdAt: Date;
  /**
   * The event this message was derived from.
   *
   * Carried through so the inbox can group and label by what actually happened
   * rather than by parsing the title. Null for a message queued directly — an
   * acknowledgement to somebody with no account, for instance.
   */
  eventType: string | null;
  entityType: string | null;
  entityId: string | null;
}

export interface InboxOptions {
  unreadOnly?: boolean;
  /** Filter to one stored topic. Ignored when the topic is not one of theirs. */
  topic?: string | null;
  limit?: number;
}

/**
 * The caller's own in-app notifications, newest first.
 *
 * ONLY `in_app`. The email and SMS rows for the same event are the same message
 * handed to a different transport; listing them here would show a member three
 * copies of one notice and imply the federation had told them three times.
 * Whether the email went is an operator's question, and it is answered on the
 * operator's page.
 */
export async function inbox(
  db: DB,
  principal: Principal | null | undefined,
  opts: InboxOptions = {}
): Promise<InboxItem[]> {
  const me = await recipientFor(db, principal);
  if (!me) return [];

  const where: SQL[] = [
    eq(s.notifications.personId, me.personId),
    eq(s.notifications.channel, 'in_app'),
  ];
  if (opts.unreadOnly) where.push(isNull(s.notifications.readAt));
  if (opts.topic) where.push(eq(s.notifications.topic, opts.topic));

  const limit = Math.min(Math.max(1, opts.limit ?? INBOX_LIMIT), INBOX_LIMIT);

  // LEFT join: a notification whose domain event was never recorded — or which
  // was queued without one — must still reach its recipient. An inner join here
  // would silently drop exactly the messages nobody can explain.
  return db
    .select({
      id: s.notifications.id,
      title: s.notifications.title,
      body: s.notifications.body,
      linkUrl: s.notifications.linkUrl,
      topic: s.notifications.topic,
      priority: s.notifications.priority,
      channel: s.notifications.channel,
      status: s.notifications.status,
      readAt: s.notifications.readAt,
      sentAt: s.notifications.sentAt,
      createdAt: s.notifications.createdAt,
      eventType: s.domainEvents.eventType,
      entityType: s.domainEvents.entityType,
      entityId: s.domainEvents.entityId,
    })
    .from(s.notifications)
    .leftJoin(s.domainEvents, eq(s.notifications.domainEventId, s.domainEvents.id))
    .where(and(...where))
    .orderBy(desc(s.notifications.createdAt), desc(s.notifications.id))
    .limit(limit);
}

/** How many of the caller's own in-app notices are unread. */
export async function unreadCount(db: DB, principal: Principal | null | undefined): Promise<number> {
  const me = await recipientFor(db, principal);
  if (!me) return 0;

  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.notifications)
    .where(and(
      eq(s.notifications.personId, me.personId),
      eq(s.notifications.channel, 'in_app'),
      isNull(s.notifications.readAt)
    ));

  return row?.n ?? 0;
}

/**
 * The topics present in the CALLER'S OWN inbox.
 *
 * Built from their rows rather than from a vocabulary written down somewhere,
 * for the same reason the audit log builds its filter menus from the table: a
 * filter that is offered and returns nothing is worse than a shorter menu. It
 * also means this surface never asserts that a category exists.
 */
export async function inboxTopics(db: DB, principal: Principal | null | undefined): Promise<string[]> {
  const me = await recipientFor(db, principal);
  if (!me) return [];

  const rows = await db
    .selectDistinct({ topic: s.notifications.topic })
    .from(s.notifications)
    .where(and(
      eq(s.notifications.personId, me.personId),
      eq(s.notifications.channel, 'in_app')
    ));

  return rows.map((r: any) => r.topic).filter(Boolean).sort();
}

/**
 * Mark everything currently unread as read.
 *
 * Scoped by the same construction as markRead: the predicate names the caller's
 * own personId, so there is no set of rows this could reach that are not theirs.
 * Returns the number that moved, so the page can say what it did rather than
 * claiming success unconditionally.
 */
export async function markAllRead(db: DB, principal: Principal | null | undefined): Promise<number> {
  const me = await recipientFor(db, principal);
  if (!me) return 0;

  const rows = await db
    .update(s.notifications)
    .set({ readAt: new Date() })
    .where(and(
      eq(s.notifications.personId, me.personId),
      eq(s.notifications.channel, 'in_app'),
      isNull(s.notifications.readAt)
    ))
    .returning({ id: s.notifications.id });

  return rows.length;
}

/**
 * The deep link stored against ONE of the caller's own notices (§47).
 *
 * Exists so a page can redirect a reader to the entity without ever taking the
 * destination from the request. The id is checked against the caller's own
 * personId in the WHERE clause, so an id belonging to somebody else matches no
 * row and returns null — which is also the answer for an id that does not
 * exist, so the two are indistinguishable to whoever asked.
 *
 * The stored value is passed through safeLink() here rather than at the call
 * site, so no caller can forget.
 */
export async function ownLink(
  db: DB,
  principal: Principal | null | undefined,
  notificationId: number
): Promise<string | null> {
  const me = await recipientFor(db, principal);
  if (!me || !Number.isInteger(notificationId)) return null;

  const [row] = await db
    .select({ linkUrl: s.notifications.linkUrl })
    .from(s.notifications)
    .where(and(
      eq(s.notifications.id, notificationId),
      eq(s.notifications.personId, me.personId),
      eq(s.notifications.channel, 'in_app')
    ))
    .limit(1);

  return safeLink(row?.linkUrl ?? null);
}

// ─── The deep link (§47) ────────────────────────────────────────────────────

/**
 * The stored link, if it is safe to follow.
 *
 * §47 requires a notification to deep-link to the entity it is about, and
 * `linkUrl` is a stored string. Every producer in this codebase writes an
 * internal path, but a link that is rendered into an anchor is not the place to
 * rely on that: a row that ever acquires an absolute URL — from an import, a
 * template, a future integration — would turn the member's inbox into an open
 * redirect wearing the federation's domain.
 *
 * So the rule is a shape, not a blocklist: it must be a path on this site.
 *
 *   ·  must begin with a single "/"           — no scheme, no "mailto:"
 *   ·  must not begin with "//"               — that is another host
 *   ·  no backslash                           — some parsers read "\" as "/"
 *   ·  no control characters or whitespace    — smuggling past the checks above
 *
 * Anything else returns null and the surface renders no action, which is the
 * §103 answer for a row that cannot say what the reader can do.
 */
export function safeLink(linkUrl: string | null | undefined): string | null {
  const v = String(linkUrl ?? '').trim();
  if (!v.startsWith('/')) return null;
  if (v.startsWith('//')) return null;
  if (/[\\\s]/.test(v)) return null;
  // Written as a loop rather than a character class: a control character
  // inside a regular expression in this file is a byte nobody can review.
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  return v;
}

// ─── The operator's view of delivery ────────────────────────────────────────

/**
 * Outcomes that are NOT failures.
 *
 * A suppression means the system honoured something: a quiet hour, a stated
 * preference, or the fact that an identical notice had just gone out. Nothing
 * went wrong and there is nothing to fix. src/lib/status.ts already tones all
 * three `neutral`; this list is what stops a page grouping them under a heading
 * that contradicts the tone.
 */
export const HELD_BY_DESIGN = [
  'suppressed_quiet_hours',
  'suppressed_preference',
  'suppressed_duplicate',
] as const;

export type OutcomeGroup = 'delivered' | 'waiting' | 'held' | 'churn' | 'attention';

/**
 * Which of five buckets an outcome belongs in, for an operator scanning a page.
 *
 * Any value beginning `suppressed_` is HELD, not just the three named above — so
 * a suppression added later is toned correctly on the day it is added rather
 * than being filed under failures until somebody notices.
 *
 * An unrecognised outcome falls to `attention`. That is the fail-loud
 * direction: a new outcome nobody has classified is worth a human look, and the
 * alternative — defaulting to `delivered` — would quietly report success for a
 * state this module has never heard of.
 */
export function outcomeGroup(outcome: string | null | undefined): OutcomeGroup {
  const v = String(outcome ?? '');
  if (v.startsWith('suppressed_')) return 'held';
  if (v === 'sent') return 'delivered';
  if (v === 'queued') return 'waiting';
  if (v === 'expired') return 'churn';
  return 'attention';
}

export interface DeliveryCount {
  status: string;
  channel: string;
  n: number;
}

export interface DeliveryFailure {
  id: number;
  title: string;
  channel: string;
  topic: string | null;
  failureReason: string | null;
  createdAt: Date;
}

export interface DeliveryOverview {
  /**
   * How much of the federation this account may see.
   *
   *   all           — a national authority; every row.
   *   institutions  — bound to client institutions; only their rows.
   *   none          — an authority this table cannot be narrowed by. See below.
   */
  reach: 'all' | 'institutions' | 'none';
  institutionIds: number[];
  byStatus: DeliveryCount[];
  oldestQueued: Date | null;
  failures: DeliveryFailure[];
}

/** How many recent failures an operator is shown. Enough to see a pattern. */
const FAILURE_LIMIT = 25;

/**
 * Delivery, for whoever has to answer "did that message go out?".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SCOPE IS A SQL PREDICATE, AND SOMETIMES IT IS "NOTHING"
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `notification:read` is not a national-only action. Institution administrators
 * and coordinators hold it, bound at institution scope, and so do programme
 * managers who may be bound to a state. The `notifications` table carries an
 * `institution_id` and NOTHING ELSE placing a row in the hierarchy — no state,
 * no district, no dojo.
 *
 * So there are three answers and the third is the one worth writing down:
 *
 *   national scope     no predicate; every row.
 *   institution scope  `institution_id in (…)`, in the WHERE clause.
 *   any other scope    NOTHING. A state-scoped authority cannot be narrowed by
 *                      a column that does not exist, and the two ways of coping
 *                      are to show them the federation's whole delivery record
 *                      or to show them none of it. Showing all of it is a
 *                      disclosure; this returns none, and the page says why.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IT NAMES NO RECIPIENT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Not the person, not their name, not their address, and not the message body.
 * This answers a question about the CHANNEL — what was delivered, what is
 * waiting, what was held and what failed. `notification:read` is held by people
 * who do not hold `person:read_pii`, and a delivery report that joined the
 * person table would hand every one of them a membership list with a covering
 * story. Tracing one message to one member is done from that member's record,
 * by somebody with the authority to open it.
 */
export async function deliveryOverview(db: DB, principal: Principal | null | undefined): Promise<DeliveryOverview> {
  assertCanAnywhere(principal, 'notification:read');

  const scopes = visibleScopes(principal, 'notification:read');

  const empty = (reach: DeliveryOverview['reach'], institutionIds: number[] = []): DeliveryOverview => ({
    reach, institutionIds, byStatus: [], oldestQueued: null, failures: [],
  });

  if (scopes.kind === 'none') return empty('none');

  const where: SQL[] = [];
  let reach: DeliveryOverview['reach'] = 'all';
  let institutionIds: number[] = [];

  if (scopes.kind === 'scoped') {
    institutionIds = scopes.institutions;
    if (!institutionIds.length) return empty('none');
    reach = 'institutions';
    where.push(inArray(s.notifications.institutionId, institutionIds));
  }

  const clause = where.length ? and(...where) : undefined;

  const byStatus = await db
    .select({
      status: s.notifications.status,
      channel: s.notifications.channel,
      n: sql<number>`count(*)::int`,
    })
    .from(s.notifications)
    .where(clause as any)
    .groupBy(s.notifications.status, s.notifications.channel);

  // The oldest thing still waiting is the single most diagnostic figure on the
  // page: a backlog measured in minutes is a working queue, and one measured in
  // weeks is a provider nobody configured.
  const [oldest] = await db
    .select({ createdAt: s.notifications.createdAt })
    .from(s.notifications)
    .where(clause ? and(clause, eq(s.notifications.status, 'queued')) : eq(s.notifications.status, 'queued'))
    .orderBy(asc(s.notifications.createdAt), asc(s.notifications.id))
    .limit(1);

  const failedClause = eq(s.notifications.status, 'failed');
  const failures = await db
    .select({
      id: s.notifications.id,
      title: s.notifications.title,
      channel: s.notifications.channel,
      topic: s.notifications.topic,
      failureReason: s.notifications.failureReason,
      createdAt: s.notifications.createdAt,
    })
    .from(s.notifications)
    .where(clause ? and(clause, failedClause) : failedClause)
    .orderBy(desc(s.notifications.createdAt), desc(s.notifications.id))
    .limit(FAILURE_LIMIT);

  return {
    reach,
    institutionIds,
    byStatus,
    oldestQueued: oldest?.createdAt ?? null,
    failures,
  };
}

/**
 * Push delivery outcomes, and only for an account that may see all of them.
 *
 * `notification_deliveries` has a device, a user and a topic, and NO
 * institution — so unlike the table above there is no column to narrow it by at
 * all. A scoped account therefore gets null rather than a filtered view that
 * could not honestly be filtered, and the page prints the reason instead of an
 * empty chart.
 */
export async function pushOutcomes(
  db: DB,
  principal: Principal | null | undefined
): Promise<Array<{ outcome: string; n: number }> | null> {
  assertCanAnywhere(principal, 'notification:read');

  if (visibleScopes(principal, 'notification:read').kind !== 'all') return null;

  return db
    .select({ outcome: s.notificationDeliveries.outcome, n: sql<number>`count(*)::int` })
    .from(s.notificationDeliveries)
    .where(eq(s.notificationDeliveries.channel, 'push'))
    .groupBy(s.notificationDeliveries.outcome);
}
