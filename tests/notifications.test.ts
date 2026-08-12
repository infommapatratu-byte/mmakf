// Notifications.
//
// The rules under test: do not spam, do not lose a message, do not deliver one
// to the wrong person, and never claim a message was sent when no transport
// exists to send it.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { createPerson } from '../src/db/federation';
import {
  queue, deliverQueued, myNotifications, markRead, queueHealth,
  notifyForEvent, transportStatus, isNotifiable, NOTIFIABLE,
} from '../src/lib/notifications';
import type { Principal } from '../src/lib/rbac';

let db: any, JH: number;
let ALICE: any, BOB: any;
let ALICE_USER: number, BOB_USER: number;

const national: Principal = {
  userId: 1, label: 'federation-admin',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
};
const ctx = { principal: national };

const asUser = (userId: number): Principal => ({
  userId, label: 'member', bindings: [{ role: 'MEMBER', scopeType: 'national', scopeId: null }],
});

afterEach(() => {
  delete process.env.EMAIL_PROVIDER_URL;
  delete process.env.EMAIL_FROM;
  delete process.env.SMS_PROVIDER_URL;
});

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'ST-JH', state: 'Jharkhand', name: 'JH', status: 'active' })
    .returning({ id: s.stateUnits.id });
  JH = jh.id;

  ALICE = await createPerson(db, ctx, {
    fullName: 'Alice', stateUnitId: JH, email: 'alice@example.in', phone: '9876543210',
  });
  BOB = await createPerson(db, ctx, {
    fullName: 'Bob', stateUnitId: JH, email: 'bob@example.in',
  });

  const [au] = await db.insert(s.users)
    .values({ email: 'alice@example.in', personId: ALICE.id, status: 'active' })
    .returning({ id: s.users.id });
  const [bu] = await db.insert(s.users)
    .values({ email: 'bob@example.in', personId: BOB.id, status: 'active' })
    .returning({ id: s.users.id });
  ALICE_USER = au.id; BOB_USER = bu.id;
});

describe('the allow-list keeps it quiet by default', () => {
  it('recognises only the event types that produce a message', () => {
    expect(isNotifiable('GRADING_APPROVED')).toBe(true);
    // The feed carries far more than a member needs to hear about.
    expect(isNotifiable('PERSON_UPDATED')).toBe(false);
    expect(isNotifiable('AUDIT_WRITTEN')).toBe(false);
    expect(isNotifiable('__proto__')).toBe(false);
  });

  it('marks consequences of federation decisions as ESSENTIAL', () => {
    // Suppressing these would let someone opt out of being told their
    // credential was withdrawn.
    expect(NOTIFIABLE.CERTIFICATE_REVOKED.essential).toBe(true);
    expect(NOTIFIABLE.GRADING_APPROVED.essential).toBe(true);
    expect(NOTIFIABLE.CASE_ACKNOWLEDGED.essential).toBe(true);
    // Whereas a general ranking update is not.
    expect(NOTIFIABLE.RANKING_UPDATED.essential).toBe(false);
  });
});

describe('queueing', () => {
  it('records a message as QUEUED, never as sent', async () => {
    const n = await queue(db, { personId: ALICE.id, title: 'Test', body: 'Body' });
    // Only a transport that actually delivered may say sent.
    expect(n.status).toBe('queued');
    expect(n.sentAt).toBeNull();
  });

  it('DEDUPLICATES on the domain event, so a retried consumer cannot double-send', async () => {
    const [ev] = await db.insert(s.domainEvents).values({
      eventType: 'GRADING_APPROVED', entityType: 'person', entityId: String(ALICE.id),
      payload: { personId: ALICE.id },
    }).returning();

    const first = await queue(db, { personId: ALICE.id, title: 'X', body: 'Y', domainEventId: ev.id });
    const second = await queue(db, { personId: ALICE.id, title: 'X', body: 'Y', domainEventId: ev.id });

    expect((first as any).deduplicated).toBe(false);
    expect((second as any).deduplicated).toBe(true);

    const rows = await db.select().from(s.notifications)
      .where(eq(s.notifications.domainEventId, ev.id));
    expect(rows.length).toBe(1);
  });

  it('allows the SAME event on a different channel', async () => {
    const [ev] = await db.insert(s.domainEvents).values({
      eventType: 'CERTIFICATE_ISSUED', entityType: 'person', entityId: String(BOB.id),
      payload: { personId: BOB.id },
    }).returning();

    await queue(db, { personId: BOB.id, channel: 'in_app', title: 'A', body: 'B', domainEventId: ev.id });
    const email = await queue(db, { personId: BOB.id, channel: 'email', title: 'A', body: 'B', domainEventId: ev.id });
    expect((email as any).deduplicated).toBe(false);
  });

  it('bounds title and body rather than storing unbounded text', async () => {
    const n = await queue(db, { personId: ALICE.id, title: 'x'.repeat(500), body: 'y'.repeat(5000) });
    expect(n.title.length).toBe(200);
    expect(n.body.length).toBe(2000);
  });
});

describe('transport honesty', () => {
  it('reports in-app as always available and the rest as unconfigured', () => {
    const status = transportStatus();
    expect(status.find((t) => t.channel === 'in_app')!.configured).toBe(true);
    const email = status.find((t) => t.channel === 'email')!;
    expect(email.configured).toBe(false);
    // A federation that believes it is emailing members and is not has a worse
    // problem than one that knows it is not.
    expect(email.reason).toMatch(/QUEUED, not sent/);
  });

  it('reports email as configured once a provider is set', () => {
    process.env.EMAIL_PROVIDER_URL = 'https://provider.example/send';
    process.env.EMAIL_FROM = 'noreply@mmakf.in';
    expect(transportStatus().find((t) => t.channel === 'email')!.configured).toBe(true);
  });
});

describe('delivery', () => {
  it('delivers in-app immediately, because the row IS the notification', async () => {
    await db.delete(s.notifications);
    await queue(db, { personId: ALICE.id, channel: 'in_app', title: 'In app', body: 'Body' });

    const report = await deliverQueued(db);
    expect(report.delivered).toBe(1);
    expect(report.failed).toBe(0);

    const [row] = await db.select().from(s.notifications);
    expect(row.status).toBe('sent');
    expect(row.sentAt).not.toBeNull();
  });

  it('LEAVES a message queued when no transport exists — never failed, never dropped', async () => {
    await db.delete(s.notifications);
    await queue(db, { personId: ALICE.id, channel: 'email', title: 'Email', body: 'Body' });

    const report = await deliverQueued(db);
    expect(report.queuedNoTransport).toBe(1);
    expect(report.delivered).toBe(0);
    expect(report.failed).toBe(0);

    // Still queued: configuring a provider later delivers the backlog rather
    // than losing it.
    const [row] = await db.select().from(s.notifications);
    expect(row.status).toBe('queued');
    expect(row.failureReason).toBeNull();
  });

  it('records a provider rejection as FAILED with the reason', async () => {
    await db.delete(s.notifications);
    process.env.EMAIL_PROVIDER_URL = 'http://127.0.0.1:1/send';   // refused
    process.env.EMAIL_FROM = 'noreply@mmakf.in';
    await queue(db, { personId: ALICE.id, channel: 'email', title: 'Email', body: 'Body' });

    const report = await deliverQueued(db);
    expect(report.failed).toBe(1);

    const [row] = await db.select().from(s.notifications);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toBeTruthy();
  });

  it('fails a message to someone with no address on record, and says which', async () => {
    await db.delete(s.notifications);
    process.env.SMS_PROVIDER_URL = 'https://sms.example/send';
    // Bob has an email but no phone.
    await queue(db, { personId: BOB.id, channel: 'sms', title: 'SMS', body: 'Body' });

    const report = await deliverQueued(db);
    expect(report.failed).toBe(1);
    expect(report.errors[0]).toMatch(/no mobile number/i);
  });
});

describe('reading is scoped by construction, not by a check', () => {
  beforeAll(async () => {
    await db.delete(s.notifications);
    await queue(db, { personId: ALICE.id, title: 'For Alice', body: 'Alice body' });
    await queue(db, { personId: BOB.id, title: 'For Bob', body: 'Bob body' });
  });

  it('returns only the CALLER\'s notifications', async () => {
    // myNotifications takes no id — it resolves the caller's person record. That
    // is the structural way to make reading someone else's impossible.
    const alice = await myNotifications(db, asUser(ALICE_USER));
    expect(alice.length).toBe(1);
    expect(alice[0].title).toBe('For Alice');

    const bob = await myNotifications(db, asUser(BOB_USER));
    expect(bob.map((n: any) => n.title)).toEqual(['For Bob']);
  });

  it('returns nothing for a principal with no user id', async () => {
    expect(await myNotifications(db, { userId: null, label: 'anon', bindings: [] })).toEqual([]);
  });

  it('returns nothing for a user with no person linked', async () => {
    const [orphan] = await db.insert(s.users)
      .values({ email: 'orphan@mmakf.in', status: 'active' })
      .returning({ id: s.users.id });
    expect(await myNotifications(db, asUser(orphan.id))).toEqual([]);
  });

  it('ATTACK: marking read cannot touch another member\'s row', async () => {
    const all = await db.select().from(s.notifications);
    const bobsRow = all.find((n: any) => n.personId === BOB.id);

    const touched = await markRead(db, asUser(ALICE_USER), [bobsRow.id]);
    expect(touched).toBe(0);

    const [after] = await db.select().from(s.notifications).where(eq(s.notifications.id, bobsRow.id));
    expect(after.readAt).toBeNull();
  });

  it('marks the caller\'s own rows read, and is idempotent', async () => {
    const alice = await myNotifications(db, asUser(ALICE_USER));
    expect(await markRead(db, asUser(ALICE_USER), [alice[0].id])).toBe(1);
    expect(await markRead(db, asUser(ALICE_USER), [alice[0].id])).toBe(0);
  });
});

describe('fan-out from the event feed', () => {
  it('notifies the subject of a grading result', async () => {
    await db.delete(s.notifications);
    const [ev] = await db.insert(s.domainEvents).values({
      eventType: 'GRADING_APPROVED', entityType: 'person', entityId: String(ALICE.id),
      payload: { personId: ALICE.id },
    }).returning();

    expect(await notifyForEvent(db, ctx, ev)).toBe(1);

    const [row] = await db.select().from(s.notifications);
    expect(row.personId).toBe(ALICE.id);
    expect(row.linkUrl).toBe('/my/passport');
  });

  it('NEVER carries the substance of a decision in the message body', async () => {
    const rows = await db.select().from(s.notifications);
    const grading = rows.find((n: any) => n.title === 'Your grading result');
    // A notification travels through channels the federation does not control;
    // the record it points to is where the detail belongs.
    expect(grading.body).toMatch(/has been recorded/i);
    // Word-bounded: "passport" legitimately contains "pass", and an unbounded
    // pattern here would fail on the very sentence that is doing the right thing.
    expect(grading.body).not.toMatch(/(passed|failed|Dan|Kyu|score)/i);
  });

  it('produces NOTHING for an event type not on the allow-list', async () => {
    await db.delete(s.notifications);
    const [ev] = await db.insert(s.domainEvents).values({
      eventType: 'PERSON_UPDATED', entityType: 'person', entityId: String(ALICE.id),
      payload: { personId: ALICE.id },
    }).returning();

    expect(await notifyForEvent(db, ctx, ev)).toBe(0);
    expect((await db.select().from(s.notifications)).length).toBe(0);
  });

  it('is idempotent across a retried consumer', async () => {
    await db.delete(s.notifications);
    const [ev] = await db.insert(s.domainEvents).values({
      eventType: 'CERTIFICATE_ISSUED', entityType: 'person', entityId: String(BOB.id),
      payload: { personId: BOB.id },
    }).returning();

    expect(await notifyForEvent(db, ctx, ev)).toBe(1);
    // A cursor-based consumer retried after a failure must not re-send.
    expect(await notifyForEvent(db, ctx, ev)).toBe(0);
    expect((await db.select().from(s.notifications)).length).toBe(1);
  });

  it('fans out to every confirmed entrant when a draw is published', async () => {
    await db.delete(s.notifications);
    const [event] = await db.insert(s.competitionEvents).values({
      code: 'MMAKF-EVT-NOTIFY', title: 'Nationals', kind: 'national_championship', status: 'published',
    }).returning();
    const [cat] = await db.insert(s.eventCategories).values({
      eventId: event.id, code: 'CAT-1', label: 'Cadet Kumite', discipline: 'kumite',
    }).returning();

    await db.insert(s.eventEntries).values([
      { entryNo: 'E-1', eventId: event.id, categoryId: cat.id, personId: ALICE.id, status: 'confirmed' },
      { entryNo: 'E-2', eventId: event.id, categoryId: cat.id, personId: BOB.id, status: 'withdrawn' },
    ]);

    const [ev] = await db.insert(s.domainEvents).values({
      eventType: 'DRAW_PUBLISHED', entityType: 'category', entityId: String(cat.id),
      payload: { categoryId: cat.id },
    }).returning();

    // The withdrawn entrant is not notified about a draw they are not in.
    expect(await notifyForEvent(db, ctx, ev)).toBe(1);
    const [row] = await db.select().from(s.notifications);
    expect(row.personId).toBe(ALICE.id);
  });

  it('FAILS CLOSED on an unresolvable audience rather than fanning out to everyone', async () => {
    await db.delete(s.notifications);
    const [ev] = await db.insert(s.domainEvents).values({
      eventType: 'DRAW_PUBLISHED', entityType: 'category', entityId: 'not-a-number',
      payload: {},                               // no categoryId to resolve
    }).returning();

    expect(await notifyForEvent(db, ctx, ev)).toBe(0);
  });
});

describe('queue health', () => {
  it('surfaces the oldest queued message, which is how a missing provider shows up', async () => {
    await db.delete(s.notifications);
    await queue(db, { personId: ALICE.id, channel: 'email', title: 'Waiting', body: 'Body' });
    await deliverQueued(db);

    const health = await queueHealth(db, national);
    // A backlog with nothing older than a few minutes is a working system; one
    // with a message from three weeks ago is a provider nobody configured.
    expect(health.oldestQueued).not.toBeNull();
    expect(health.transports.find((t: any) => t.channel === 'email')!.configured).toBe(false);
  });

  it('requires authority to read', async () => {
    await expect(queueHealth(db, { userId: null, label: 'anon', bindings: [] }))
      .rejects.toThrow(/Forbidden/);
  });
});
