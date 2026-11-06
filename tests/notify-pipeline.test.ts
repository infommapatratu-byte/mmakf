// The notification pipeline that receipts and class notices travel on.
//
// Three things were broken before this file existed, each silently:
//   1. email only knew an HTTP provider; the federation's mail is an SMTP mailbox;
//   2. notifyForEvent() wrote inbox rows only, so nothing essential was emailed,
//      and deliverPushForNotifications() had no caller, so nothing was pushed;
//   3. delivery ran once a day, so a payment receipt could wait 24 hours.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq, and } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { publish } from '../src/lib/domain-events';
import {
  transportStatus, smtpConfig, notifyForEvent, queueEmailForEssentialNotifications,
} from '../src/lib/notifications';
import { queuePaymentReceipt } from '../src/lib/receipts';
import { render } from '../src/lib/email-templates';
import { legacyAdminPrincipal } from '../src/lib/rbac';

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'SMTP_SECURE', 'EMAIL_FROM', 'EMAIL_PROVIDER_URL'];
const saved: Record<string, string | undefined> = {};
for (const k of SMTP_KEYS) saved[k] = process.env[k];
afterEach(() => { for (const k of SMTP_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const email = () => transportStatus().find((t) => t.channel === 'email')!;

describe('email can go out through an ordinary SMTP mailbox', () => {
  it('is NOT configured until host, user, password AND sender are all present', () => {
    for (const k of SMTP_KEYS) delete process.env[k];
    process.env.SMTP_HOST = 'smtp.titan.email';
    process.env.SMTP_USER = 'admin@mmakf.in';
    process.env.EMAIL_FROM = 'MMAKF <admin@mmakf.in>';
    expect(smtpConfig()).toBeNull();            // no password: parked, not failing
    expect(email().configured).toBe(false);
    process.env.SMTP_PASS = 'x';
    expect(email().configured).toBe(true);
    expect(email().reason).toMatch(/SMTP via smtp\.titan\.email/);
    delete process.env.EMAIL_FROM;
    expect(email().configured).toBe(false);     // a sender is still required
  });

  it('defaults to implicit TLS on 465, and STARTTLS-style on 587', () => {
    for (const k of SMTP_KEYS) delete process.env[k];
    Object.assign(process.env, { SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' });
    expect(smtpConfig()).toMatchObject({ port: 465, secure: true });
    process.env.SMTP_PORT = '587';
    expect(smtpConfig()).toMatchObject({ port: 587, secure: false });
  });
});

describe('the five-minute notification cron is wired, scheduled and guarded', () => {
  const route = readFileSync('src/pages/api/cron/notify.ts', 'utf8');

  it('runs every step, including the two fan-outs that had no caller', () => {
    for (const call of ['consume(', 'notifyForEvent(', 'queueEmailForEssentialNotifications(',
      'deliverPushForNotifications(', 'deliverQueued(', 'deliverQueuedPush(']) {
      expect(route, `notify.ts must call ${call}`).toContain(call);
    }
  });

  it('is scheduled in vercel.json', () => {
    const paths = (JSON.parse(readFileSync('vercel.json', 'utf8')).crons ?? []).map((c: any) => c.path);
    expect(paths).toContain('/api/cron/notify');
  });

  it('refuses a caller without the cron secret', async () => {
    const prev = process.env.CRON_SECRET;
    process.env.CRON_SECRET = 'test-secret-value';
    const { GET } = await import('../src/pages/api/cron/notify');
    const res = await (GET as any)({ request: new Request('https://www.mmakf.in/api/cron/notify') });
    expect(res.status).toBe(401);
    const wrong = await (GET as any)({ request: new Request('https://www.mmakf.in/api/cron/notify', { headers: { authorization: 'Bearer nope' } }) });
    expect(wrong.status).toBe(401);
    if (prev === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prev;
  });
});

describe('receipts and email twins, against a real schema', () => {
  let db: any;
  const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

  beforeAll(async () => {
    const client = new PGlite();
    db = drizzle(client, { schema: s });
    for (const f of MIGRATIONS) {
      for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (st.trim()) await client.exec(st.trim());
      }
    }
  }, 120_000);

  it('the receipt template renders every value it promises', () => {
    const r = render('payment_receipt', { fullName: 'A', orderNo: 'MMAKF-ORD-1', amount: '₹8,000.00', paidOn: 'today', invoiceNo: 'MMAKF/2026/00001' });
    expect(r.subject).toContain('MMAKF-ORD-1');
    expect(r.text).toContain('MMAKF/2026/00001');
    expect(r.text).not.toMatch(/\{\{/);
  });

  it('queues exactly one receipt email for a paid guest order, however often it is called', async () => {
    const [order] = await db.insert(s.orders).values({
      orderNo: 'MMAKF-ORD-T-1', status: 'paid', subtotalPaise: 800000, totalPaise: 800000,
      currency: 'INR', email: 'buyer@example.com', buyerName: 'Test Buyer', paidAt: new Date(),
    }).returning();
    const first = await queuePaymentReceipt(db, order.id);
    const second = await queuePaymentReceipt(db, order.id);
    expect(first).toMatchObject({ queued: 1, deduplicated: 0 });   // email only: no person, no inbox
    expect(second).toMatchObject({ queued: 0, deduplicated: 1 });
    const rows = await db.select().from(s.notifications).where(eq(s.notifications.dedupeKey, `receipt:order:${order.id}:email`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: 'email', recipientEmail: 'buyer@example.com', status: 'queued', template: 'payment_receipt' });
    expect(rows[0].body).toContain('MMAKF-ORD-T-1');
  });

  it('sends nothing for an order that is not paid', async () => {
    const [order] = await db.insert(s.orders).values({
      orderNo: 'MMAKF-ORD-T-2', status: 'awaiting_payment', subtotalPaise: 100, totalPaise: 100,
      currency: 'INR', email: 'x@example.com',
    }).returning();
    expect(await queuePaymentReceipt(db, order.id)).toMatchObject({ queued: 0, skipped: 'order is not paid' });
  });

  it('pairs an essential inbox notification with one email, once', async () => {
    const [person] = await db.insert(s.persons).values({ federationId: 'MMAKF-A-2026-90001', fullName: 'Learner One', email: 'learner@example.com' }).returning();
    await publish(db, {
      eventType: 'CERTIFICATE_ISSUED', entityType: 'certificate', entityId: '77',
      payload: { personId: person.id, certificateId: 77 },
    });
    const [event] = await db.select().from(s.domainEvents).where(eq(s.domainEvents.eventType, 'CERTIFICATE_ISSUED'));
    const ctx = { principal: legacyAdminPrincipal(), reason: 'test', authority: 'test' };
    expect(await notifyForEvent(db, ctx, event)).toBe(1);

    expect(await queueEmailForEssentialNotifications(db)).toMatchObject({ queued: 1 });
    expect(await queueEmailForEssentialNotifications(db)).toMatchObject({ queued: 0 });
    const emails = await db.select().from(s.notifications)
      .where(and(eq(s.notifications.domainEventId, event.id), eq(s.notifications.channel, 'email')));
    expect(emails).toHaveLength(1);
    expect(emails[0].personId).toBe(person.id);
  });
});
