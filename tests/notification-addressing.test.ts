// An acknowledgement addressed to somebody who is not a member must reach them.
//
// THE DEFECT THIS PINS DOWN.
//
// `notifications.recipient_email` was added in migration 0011 for one stated
// purpose, quoted from its own comment in src/db/governance.schema.ts:
//
//   "Where to send it when the recipient has no account. A school principal who
//    filled in the application wizard is not a member, has no person record and
//    no user row — and is exactly who the acknowledgement is for. Without this
//    the notification could be created and never addressed."
//
// dispatch() in src/db/automations.ts writes that column, and admits a row when
// ANY of recipientEmail / userId / personId is present. sendVia() in
// src/lib/notifications.ts then read `persons` alone and threw 'no_recipient'
// the moment personId was null — so every automation-created acknowledgement to
// a non-member failed, permanently. `failed` is terminal in this queue: there
// is no retry and no dead-letter, so those rows never send.
//
// The producer and the consumer disagreed about where the address lives, and
// the consumer won silently. That is the class of defect a schema comment
// cannot prevent and a test can.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { deliverQueued } from '../src/lib/notifications';

let db: any;
let sent: Array<{ to: string; subject: string }> = [];
const realFetch = globalThis.fetch;
const savedEnv = {
  url: process.env.EMAIL_PROVIDER_URL,
  from: process.env.EMAIL_FROM,
};

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of MIGRATIONS) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  // The email transport is gated on BOTH variables — see transportStatus().
  // Without them deliverQueued() counts the rows as queuedNoTransport and never
  // calls sendVia() at all, which would make every assertion below vacuous.
  process.env.EMAIL_PROVIDER_URL = 'https://provider.invalid/send';
  process.env.EMAIL_FROM = 'federation@mmakf.in';

  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    sent.push({ to: body.to, subject: body.subject });
    return new Response('{}', { status: 200 });
  }) as any;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  process.env.EMAIL_PROVIDER_URL = savedEnv.url;
  process.env.EMAIL_FROM = savedEnv.from;
});

beforeEach(() => { sent = []; });

async function person(fullName: string, email: string | null) {
  const [row] = await db.insert(s.persons).values({
    federationId: `MMAKF-TEST-${Math.random().toString(36).slice(2, 10)}`,
    fullName,
    email,
    status: 'active',
  }).returning({ id: s.persons.id });
  return row.id as number;
}

async function queueEmail(values: Record<string, unknown>) {
  const [row] = await db.insert(s.notifications).values({
    channel: 'email',
    title: 'Your application has been received',
    body: 'MMAKF has your application and will be in touch.',
    status: 'queued',
    ...values,
  }).returning({ id: s.notifications.id });
  return row.id as number;
}

async function statusOf(id: number) {
  const [row] = await db.select({
    status: s.notifications.status,
    failureReason: s.notifications.failureReason,
  }).from(s.notifications).where(eq(s.notifications.id, id)).limit(1);
  return row;
}

describe('a recipient with no account at all', () => {
  it('THE SCHOOL PRINCIPAL: recipient_email alone is enough to deliver', async () => {
    // No personId, no userId — exactly the row migration 0011 added the column
    // for, and exactly the row that used to fail with 'no_recipient'.
    const id = await queueEmail({
      personId: null,
      recipientEmail: 'principal@stxaviers.example',
      recipientName: 'The Principal',
    });

    const report = await deliverQueued(db);

    expect(report.failed, `delivery errors: ${report.errors.join('; ')}`).toBe(0);
    expect(report.delivered).toBeGreaterThan(0);
    expect(sent.map((m) => m.to)).toContain('principal@stxaviers.example');
    expect((await statusOf(id)).status).toBe('sent');
  });
});

describe('a recipient who is on the register', () => {
  it("uses the person's own address, which is the canonical one", async () => {
    const pid = await person('Anita Verma', 'anita@example.in');
    const id = await queueEmail({ personId: pid });

    await deliverQueued(db);

    expect(sent.map((m) => m.to)).toContain('anita@example.in');
    expect((await statusOf(id)).status).toBe('sent');
  });

  it('PREFERS the register over a stale snapshot when the row carries both', async () => {
    // recipient_email is a point-in-time copy of whatever was typed into a
    // form. A member who corrected a typo in their address must not keep
    // receiving mail at the old one forever, so the person row wins.
    const pid = await person('Rakesh Nair', 'rakesh.corrected@example.in');
    const id = await queueEmail({
      personId: pid,
      recipientEmail: 'rakesh.typo@example.in',
    });

    await deliverQueued(db);

    expect(sent.map((m) => m.to)).toContain('rakesh.corrected@example.in');
    expect(sent.map((m) => m.to)).not.toContain('rakesh.typo@example.in');
    expect((await statusOf(id)).status).toBe('sent');
  });

  it('falls back to recipient_email when the register holds no address', async () => {
    const pid = await person('Suresh Patil', null);
    const id = await queueEmail({
      personId: pid,
      recipientEmail: 'suresh@example.in',
    });

    await deliverQueued(db);

    expect(sent.map((m) => m.to)).toContain('suresh@example.in');
    expect((await statusOf(id)).status).toBe('sent');
  });
});

describe('rows that genuinely cannot be addressed still fail, and say which way', () => {
  // The two codes need different repairs, and collapsing them would hide which
  // rows an operator can fix by editing a person record.

  it('a known person with no address on record fails as no_address', async () => {
    const pid = await person('Meera Joshi', null);
    const id = await queueEmail({ personId: pid, recipientEmail: null });

    await deliverQueued(db);

    const row = await statusOf(id);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toMatch(/no email address on record/i);
    expect(sent).toHaveLength(0);
  });

  it('no person and no address fails as no_recipient', async () => {
    const id = await queueEmail({ personId: null, recipientEmail: null });

    await deliverQueued(db);

    const row = await statusOf(id);
    expect(row.status).toBe('failed');
    expect(row.failureReason).toMatch(/no person record and no recipient email/i);
    expect(sent).toHaveLength(0);
  });
});
