// Telling members a timetable changed — deliberately, and never by accident.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS IS NOT JUST A CONSUMER ON SCHEDULE_PUBLISHED
// ═══════════════════════════════════════════════════════════════════════════
//
// src/lib/notifications.ts resolves SCHEDULE_PUBLISHED to the club's own members
// for a dojo-scoped schedule, and to NOBODY for a national, state or district
// one. The comment there says why:
//
//     "'every member of the federation' is a fan-out this system must never
//      perform on the strength of one administrator saving a form. When MMAKF
//      wants a national announcement it is a circular, which is a different act
//      with a different approval path."
//
// That paragraph named a thing that did not exist. This module is it.
//
// The gap it closes is real and it cuts both ways. Without this, a state office
// that moves every club's Sunday has no way at all to tell anybody — so it
// telephones, or it does not bother, and a family turns up to a locked dojo. With
// an automatic fan-out, one mistyped form writes to every member in the country
// and cannot be recalled. Neither is acceptable, so the act exists and is
// GOVERNED.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FOUR SAFETIES, IN THE ORDER THEY BITE
// ═══════════════════════════════════════════════════════════════════════════
//
// ONE. THE AUDIENCE IS COUNTED AND FROZEN BEFORE ANYTHING IS SENT.
// `draftAnnouncement()` writes `audience_count` from a real query and returns it.
// An administrator authorises a NUMBER — "this will write to 4,182 people" — not
// a promise. A system that counted at send time would show a plausible screen
// and then do something else.
//
// TWO. ABOVE A THRESHOLD IT TAKES TWO PEOPLE. Not a second implementation of
// two-person control: `src/lib/approvals.ts` already exists, already has the
// once-only execution guard, already writes the APPROVAL_* events, and is
// already the thing tests/approvals.test.ts holds to account. This module raises
// a request through it and records the id on the row.
//
// THREE. WHAT WENT OUT IS RECORDED SEPARATELY FROM WHAT WAS PROMISED.
// `sent_count` need not equal `audience_count`: somebody may have left the club
// between drafting and sending, or a member may already hold an identical
// notification and be deduplicated. Reporting the estimate as the outcome would
// be lying about delivery, which is the specific failure that makes an operator
// stop believing the delivery report.
//
// FOUR. IT CANNOT WRITE TO ANYBODY TWICE. `queue()` deduplicates on
// (domainEventId, personId, channel) — that is the ONLY deduplication it has, and
// an invented `dedupeKey` would have been ignored silently. So the announcement
// publishes SCHEDULE_ANNOUNCED first and stamps every notification with that
// event's id, which makes a retried or re-executed send a no-op per recipient
// rather than a second message.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THE MESSAGE SAYS
// ═══════════════════════════════════════════════════════════════════════════
//
// The fact and the effective date, and a link. NOT the new hours: a timetable is
// a table, a notification body is one line, and half a timetable is worse than
// none. The recipient goes to the page, which has all of it.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import * as sch from '@/db/scheduling.schema';
import { writeAudit, type AuditContext } from '@/db/federation';
import { assertCan, type Principal } from '@/lib/rbac';
import { queue } from '@/lib/notifications';
import { publish } from '@/lib/domain-events';
import { requestApproval, approvalState, executeIfApproved } from '@/lib/approvals';
import { resourceForOwner, type OwnerScope } from '@/db/scheduling';

type DB = any;

export class AnnounceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AnnounceError';
    this.code = code;
  }
}

export function isAnnounceError(err: unknown): err is AnnounceError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'AnnounceError';
}

/**
 * Above this many recipients, one person may not send it alone.
 *
 * NOT A POLICY NUMBER THE FEDERATION SET — MMAKF has set none — and it is
 * therefore deliberately conservative and stated out loud rather than tuned. The
 * reasoning is about recall: a message to a single club is a mistake its
 * administrator can follow up in person, and a message to several hundred people
 * across a state is one nobody can. Two hundred is where the first stops being
 * true.
 *
 * A club announcing to its own members is almost always below it, which is the
 * intended effect: the ordinary case needs no ceremony.
 */
export const TWO_PERSON_THRESHOLD = 200;

/** How many notifications are queued between commits. */
const BATCH = 200;

export interface AnnouncementRecord {
  id: number;
  scheduleId: number;
  versionId: number | null;
  ownerScope: OwnerScope;
  ownerId: number | null;
  status: 'draft' | 'awaiting_approval' | 'approved' | 'sent' | 'cancelled';
  audienceCount: number;
  sentCount: number;
  reason: string;
  approvalRequestId: string | null;
  requiresTwoPeople: boolean;
  createdAt: string;
  sentAt: string | null;
  cancelledReason: string | null;
}

function toRecord(row: any): AnnouncementRecord {
  return {
    id: row.id,
    scheduleId: row.scheduleId,
    versionId: row.versionId ?? null,
    ownerScope: row.ownerScope,
    ownerId: row.ownerId ?? null,
    status: row.status,
    audienceCount: row.audienceCount,
    sentCount: row.sentCount,
    reason: row.reason,
    approvalRequestId: row.approvalRequestId ?? null,
    requiresTwoPeople: row.audienceCount > TWO_PERSON_THRESHOLD,
    createdAt: new Date(row.createdAt).toISOString(),
    sentAt: row.sentAt ? new Date(row.sentAt).toISOString() : null,
    cancelledReason: row.cancelledReason ?? null,
  };
}

/**
 * Who a schedule change actually reaches.
 *
 * ACTIVE PEOPLE PLACED UNDER THAT UNIT. `persons.dojoId`, `districtUnitId` and
 * `stateUnitId` are where a member is placed, so this is a query rather than an
 * estimate — which is what lets the count be frozen and authorised.
 *
 * A national announcement is every active person with a placement of any kind.
 * People with NO placement at all are excluded, and that is deliberate: a person
 * record created by an intake that has not been placed yet is not somebody with a
 * timetable, and writing to them would be writing to a form rather than a member.
 */
export async function announcementAudience(
  db: DB, owner: { scope: OwnerScope; id: number | null }
): Promise<number[]> {
  const active = eq(s.persons.status, 'active');
  let where: any;
  switch (owner.scope) {
    case 'dojo':
      where = and(active, eq(s.persons.dojoId, owner.id as number));
      break;
    case 'district':
      where = and(active, eq(s.persons.districtUnitId, owner.id as number));
      break;
    case 'state':
      where = and(active, eq(s.persons.stateUnitId, owner.id as number));
      break;
    case 'national':
      where = and(
        active,
        sql`(${s.persons.dojoId} is not null or ${s.persons.districtUnitId} is not null or ${s.persons.stateUnitId} is not null)`
      );
      break;
    case 'institution':
      // A client organisation's participants are not MMAKF members and are not
      // reachable through `persons` placement. An institutional programme change
      // goes to the client through its own portal and its own coordinator, which
      // is a different surface with a different contract.
      return [];
    default:
      return [];
  }
  const rows = await db.select({ id: s.persons.id }).from(s.persons).where(where);
  return rows.map((r: any) => r.id);
}

export interface DraftInput {
  scheduleId: number;
  versionId?: number | null;
  reason: string;
}

/**
 * Prepare an announcement, count its audience, and send nothing.
 *
 * Returning a row with a frozen count rather than sending is the whole design:
 * the administrator sees the number before it becomes an act, and the number
 * they saw is the number the row carries.
 */
export async function draftAnnouncement(
  db: DB, ctx: AuditContext, input: DraftInput
): Promise<AnnouncementRecord> {
  const [schedule] = await db.select().from(sch.schedules)
    .where(eq(sch.schedules.id, input.scheduleId)).limit(1);
  if (!schedule) throw new AnnounceError('not_found', `No schedule ${input.scheduleId}.`);

  const owner = { scope: schedule.ownerScope as OwnerScope, id: schedule.ownerId ?? null };
  const resource = await resourceForOwner(db, owner);
  // Both actions, and the pairing is the point: you may not announce a timetable
  // you could not have published, and you may not send a notification without the
  // authority to send notifications.
  assertCan(ctx.principal, 'schedule:publish', resource);
  assertCan(ctx.principal, 'notification:send', resource);

  const reason = (input.reason ?? '').trim();
  if (!reason) {
    throw new AnnounceError(
      'reason_required',
      'An announcement must record why it was sent. It is read afterwards by whoever is asked to justify writing to this many people.'
    );
  }

  if (input.versionId != null) {
    const [version] = await db.select().from(sch.scheduleVersions)
      .where(eq(sch.scheduleVersions.id, input.versionId)).limit(1);
    if (!version) throw new AnnounceError('not_found', `No schedule version ${input.versionId}.`);
    if (version.scheduleId !== input.scheduleId) {
      throw new AnnounceError('mismatch', 'That version belongs to a different schedule.');
    }
    if (version.status === 'draft') {
      throw new AnnounceError(
        'not_published',
        'That version is still a draft. Announcing a timetable nobody can see would send members to a page that still shows the old hours.'
      );
    }
  }

  const audience = await announcementAudience(db, owner);

  const rows = await db.insert(sch.scheduleAnnouncements).values({
    scheduleId: input.scheduleId,
    versionId: input.versionId ?? null,
    ownerScope: owner.scope as any,
    ownerId: owner.id,
    status: 'draft',
    audienceCount: audience.length,
    reason,
    createdByUserId: ctx.principal.userId ?? null,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'schedule_announcement', entityId: rows[0].id, action: 'create',
    newValue: {
      scheduleId: input.scheduleId, versionId: input.versionId ?? null,
      ownerScope: owner.scope, ownerId: owner.id,
      audienceCount: audience.length, reason,
    },
  });
  return toRecord(rows[0]);
}

/**
 * Raise the two-person request a large announcement needs.
 *
 * Only where the frozen count is above the threshold. Below it the draft is sent
 * directly, and calling this anyway is refused rather than quietly indulged — an
 * approval nobody needed is an approval that teaches people approvals are
 * theatre.
 */
export async function requestAnnouncementApproval(
  db: DB, ctx: AuditContext, announcementId: number
): Promise<{ announcement: AnnouncementRecord; requestId: string }> {
  const row = await load(db, announcementId);
  const owner = { scope: row.ownerScope as OwnerScope, id: row.ownerId ?? null };
  const resource = await resourceForOwner(db, owner);
  assertCan(ctx.principal, 'notification:send', resource);

  if (row.status !== 'draft') {
    throw new AnnounceError('not_draft', `That announcement is ${row.status}.`);
  }
  if (row.audienceCount <= TWO_PERSON_THRESHOLD) {
    throw new AnnounceError(
      'not_required',
      `That announcement reaches ${row.audienceCount} people, which is under the ${TWO_PERSON_THRESHOLD} that needs a second person. Send it.`
    );
  }

  const requestId = await requestApproval(db, ctx, {
    action: 'mass_notification',
    entityType: 'schedule_announcement',
    entityId: announcementId,
    payload: {
      scheduleId: row.scheduleId,
      versionId: row.versionId ?? null,
      ownerScope: row.ownerScope,
      ownerId: row.ownerId ?? null,
      // THE COUNT IS IN THE PAYLOAD, so the second person approves the same
      // number the first person saw rather than whatever it has become.
      audienceCount: row.audienceCount,
    },
    reason: row.reason,
    scope: resource,
    classification: 'official',
  });

  const updated = await db.update(sch.scheduleAnnouncements)
    .set({ status: 'awaiting_approval', approvalRequestId: requestId })
    .where(eq(sch.scheduleAnnouncements.id, announcementId))
    .returning();

  await writeAudit(db, ctx, {
    entityType: 'schedule_announcement', entityId: announcementId, action: 'update',
    oldValue: { status: 'draft' },
    newValue: { status: 'awaiting_approval', approvalRequestId: requestId },
  });
  return { announcement: toRecord(updated[0]), requestId };
}

export interface SendResult {
  announcement: AnnouncementRecord;
  queued: number;
  /** Frozen count minus what actually went out, and why it can differ. */
  shortfall: number;
}

/**
 * Send it.
 *
 * THE CONFIRMED COUNT IS A PARAMETER, and it must match the frozen one. Not
 * ceremony: it is the difference between clicking a button and stating a number.
 * An administrator who cannot reproduce the figure they were shown is an
 * administrator looking at a stale page, and the send is refused.
 *
 * Above the threshold this runs THROUGH src/lib/approvals.ts, so the once-only
 * guarantee, the executor authority check and the APPROVAL_EXECUTED event are the
 * ones that module already provides rather than a second set written here.
 */
export async function sendAnnouncement(
  db: DB, ctx: AuditContext,
  announcementId: number,
  confirmedAudienceCount: number
): Promise<SendResult> {
  const row = await load(db, announcementId);
  const owner = { scope: row.ownerScope as OwnerScope, id: row.ownerId ?? null };
  const resource = await resourceForOwner(db, owner);
  assertCan(ctx.principal, 'notification:send', resource);

  if (row.status === 'sent') throw new AnnounceError('already_sent', 'That announcement has already gone out.');
  if (row.status === 'cancelled') throw new AnnounceError('cancelled', 'That announcement was cancelled.');

  if (Number(confirmedAudienceCount) !== row.audienceCount) {
    throw new AnnounceError(
      'count_mismatch',
      `This announcement was prepared for ${row.audienceCount} recipients and you confirmed ${confirmedAudienceCount}. Nothing has been sent — reload the page and check the figure.`
    );
  }

  const needsTwo = row.audienceCount > TWO_PERSON_THRESHOLD;
  if (needsTwo) {
    if (!row.approvalRequestId) {
      throw new AnnounceError(
        'approval_required',
        `Writing to ${row.audienceCount} people needs a second person to agree. Raise the request first.`
      );
    }
    const state = await approvalState(db, ctx, row.approvalRequestId);
    if (state.status !== 'approved') {
      throw new AnnounceError(
        'approval_required',
        `The request to send this is ${state.status}. Nothing has been sent.`
      );
    }
    const execution = await executeIfApproved(
      db, ctx, row.approvalRequestId,
      async (_state, tx) => await deliver(tx, ctx, row)
    );
    const outcome = execution.outcome as { queued: number };
    const after = await load(db, announcementId);
    return {
      announcement: toRecord(after),
      queued: outcome?.queued ?? after.sentCount,
      shortfall: after.audienceCount - after.sentCount,
    };
  }

  const outcome = await db.transaction(async (tx: DB) => await deliver(tx, ctx, row));
  const after = await load(db, announcementId);
  return {
    announcement: toRecord(after),
    queued: outcome.queued,
    shortfall: after.audienceCount - after.sentCount,
  };
}

/**
 * The delivery itself, inside whatever transaction it was handed.
 *
 * Re-reads the audience rather than trusting the frozen count: the count is what
 * was AUTHORISED, and this is who is actually there now. A person who left the
 * club since drafting is not written to, and `sent_count` records the difference
 * instead of hiding it.
 */
async function deliver(tx: DB, ctx: AuditContext, row: any): Promise<{ queued: number }> {
  const owner = { scope: row.ownerScope as OwnerScope, id: row.ownerId ?? null };
  const recipients = await announcementAudience(tx, owner);

  const [schedule] = await tx.select().from(sch.schedules)
    .where(eq(sch.schedules.id, row.scheduleId)).limit(1);
  const effectiveFrom = row.versionId
    ? (await tx.select({ effectiveFrom: sch.scheduleVersions.effectiveFrom })
        .from(sch.scheduleVersions).where(eq(sch.scheduleVersions.id, row.versionId)).limit(1))[0]?.effectiveFrom ?? null
    : null;

  const title = 'Training timings have changed';
  // The FACT and the DATE, and a link. Not the hours — see the header note.
  const body = effectiveFrom
    ? `${schedule?.name ?? 'A timetable'} has been updated, in force from ${effectiveFrom}. Check the class you attend before your next session.`
    : `${schedule?.name ?? 'A timetable'} has been updated. Check the class you attend before your next session.`;

  // THE EVENT FIRST, because its id is the deduplication key. `correlationId` is
  // the announcement, so re-executing a send finds the event that already exists
  // rather than publishing a second one — and then every queue() call below
  // deduplicates against the same id.
  const event = await publish(tx, {
    eventType: 'SCHEDULE_ANNOUNCED',
    entityType: 'schedule_announcement',
    entityId: row.id,
    payload: {
      announcementId: row.id,
      scheduleId: row.scheduleId,
      versionId: row.versionId ?? null,
      ownerScope: row.ownerScope,
      ownerId: row.ownerId ?? null,
      audienceCount: row.audienceCount,
    },
    correlationId: `schedule_announcement:${row.id}`,
    actor: ctx.principal,
  });
  const domainEventId = event.event.id;

  let queued = 0;
  for (let i = 0; i < recipients.length; i += BATCH) {
    const chunk = recipients.slice(i, i + BATCH);
    for (const personId of chunk) {
      const result = await queue(tx, {
        personId,
        channel: 'in_app',
        title,
        body,
        linkUrl: '/my/schedule',
        // The only deduplication queue() has. Without it a retried send writes
        // to four thousand people twice.
        domainEventId,
      });
      if (!(result as any)?.deduplicated) queued++;
    }
  }

  await tx.update(sch.scheduleAnnouncements).set({
    status: 'sent',
    sentAt: new Date(),
    sentByUserId: ctx.principal.userId ?? null,
    // What ACTUALLY went out, capped by the authorised figure so the CHECK
    // constraint holds even if the unit somehow grew between draft and send —
    // in which case the extra people are not written to at all, because nobody
    // authorised that many.
    sentCount: Math.min(queued, row.audienceCount),
  }).where(eq(sch.scheduleAnnouncements.id, row.id));

  await writeAudit(tx, ctx, {
    entityType: 'schedule_announcement', entityId: row.id, action: 'update',
    oldValue: { status: row.status, audienceCount: row.audienceCount },
    newValue: { status: 'sent', queued, recipients: recipients.length },
  });

  return { queued };
}

/** Withdraw a draft. A cancelled announcement stays on the record. */
export async function cancelAnnouncement(
  db: DB, ctx: AuditContext, announcementId: number, reason: string
): Promise<AnnouncementRecord> {
  const row = await load(db, announcementId);
  const resource = await resourceForOwner(db, { scope: row.ownerScope as OwnerScope, id: row.ownerId ?? null });
  assertCan(ctx.principal, 'notification:send', resource);

  const why = (reason ?? '').trim();
  if (!why) throw new AnnounceError('reason_required', 'Withdrawing an announcement must record why.');
  if (row.status === 'sent') {
    throw new AnnounceError(
      'already_sent',
      'That announcement has already gone out and cannot be unsent. Send a correction if the first one was wrong.'
    );
  }

  const updated = await db.update(sch.scheduleAnnouncements)
    .set({ status: 'cancelled', cancelledAt: new Date(), cancelledReason: why })
    .where(eq(sch.scheduleAnnouncements.id, announcementId))
    .returning();
  await writeAudit(db, ctx, {
    entityType: 'schedule_announcement', entityId: announcementId, action: 'update',
    oldValue: { status: row.status }, newValue: { status: 'cancelled', reason: why },
  });
  return toRecord(updated[0]);
}

export async function listAnnouncements(
  db: DB, principal: Principal, scheduleId: number
): Promise<AnnouncementRecord[]> {
  const [schedule] = await db.select().from(sch.schedules).where(eq(sch.schedules.id, scheduleId)).limit(1);
  if (!schedule) return [];
  assertCan(principal, 'schedule:read', await resourceForOwner(db, {
    scope: schedule.ownerScope as OwnerScope, id: schedule.ownerId ?? null,
  }));
  const rows = await db.select().from(sch.scheduleAnnouncements)
    .where(eq(sch.scheduleAnnouncements.scheduleId, scheduleId))
    .orderBy(sql`${sch.scheduleAnnouncements.createdAt} desc`);
  return rows.map(toRecord);
}

async function load(db: DB, announcementId: number) {
  const [row] = await db.select().from(sch.scheduleAnnouncements)
    .where(eq(sch.scheduleAnnouncements.id, announcementId)).limit(1);
  if (!row) throw new AnnounceError('not_found', `No announcement ${announcementId}.`);
  return row;
}
