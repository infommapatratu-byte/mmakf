// The notification queue must not be blockable by mail nobody can send.
//
// THE DEFECT, WHICH WAS TWO CORRECT DECISIONS MEETING BADLY.
//
// deliverQueued() selected the oldest `limit` queued rows regardless of
// channel, then skipped any row whose channel had no configured transport —
// deliberately leaving its status `queued`, so that configuring a provider
// later delivers the backlog rather than losing it. Both halves are right.
//
// Together they wedge. A skipped row keeps status `queued` AND keeps its id, so
// it sorts into the same first hundred tomorrow, and every day after, forever.
// Neither email nor SMS is configured on this deployment, so once a hundred
// email rows accumulate at the head of the queue the entire page is email,
// every row is skipped, and nothing behind them ever drains — including in_app
// rows, which need no transport at all and would have delivered instantly.
//
// It is invisible from the report: attempted: 100, delivered: 0, failed: 0,
// night after night, which reads like a queue with nothing left to do.
//
// The number below is `limit`, not a round number chosen for flavour: the
// wedge needs exactly enough parked rows to fill one page.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { deliverQueued } from '../src/lib/notifications';

let db: any;
const savedEnv = { url: process.env.EMAIL_PROVIDER_URL, from: process.env.EMAIL_FROM, sms: process.env.SMS_PROVIDER_URL };

const MIGRATIONS = readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort();

beforeAll(async () => {
  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of MIGRATIONS) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }
});

afterAll(() => {
  process.env.EMAIL_PROVIDER_URL = savedEnv.url;
  process.env.EMAIL_FROM = savedEnv.from;
  process.env.SMS_PROVIDER_URL = savedEnv.sms;
});

beforeEach(async () => {
  await db.delete(s.notifications);
  // No transport at all — the deployment's real state, and the condition under
  // which the wedge forms.
  delete process.env.EMAIL_PROVIDER_URL;
  delete process.env.EMAIL_FROM;
  delete process.env.SMS_PROVIDER_URL;
});

async function queueRows(channel: string, n: number, titlePrefix: string) {
  const values = Array.from({ length: n }, (_, i) => ({
    channel,
    title: `${titlePrefix} ${i + 1}`,
    body: 'Body',
    status: 'queued' as const,
  }));
  await db.insert(s.notifications).values(values);
}

async function countByStatus(status: string) {
  const rows = await db.select({ id: s.notifications.id })
    .from(s.notifications).where(eq(s.notifications.status, status));
  return rows.length;
}

describe('an unconfigured channel cannot block the queue behind it', () => {
  it('THE WEDGE: 100 parked email rows do not stop one in_app row delivering', async () => {
    // Inserted FIRST, so every one of them has a lower id than the in_app row
    // and would fill the whole ordered page under the old selection.
    await queueRows('email', 100, 'Parked email');
    await queueRows('in_app', 1, 'Member notice');

    const report = await deliverQueued(db);

    expect(report.delivered, 'the in_app row must deliver despite 100 email rows ahead of it').toBe(1);
    expect(report.failed).toBe(0);
    expect(await countByStatus('sent')).toBe(1);
  });

  it('the parked rows are still queued afterwards — parked, not lost, not failed', async () => {
    await queueRows('email', 100, 'Parked email');
    await queueRows('in_app', 1, 'Member notice');

    await deliverQueued(db);

    expect(await countByStatus('queued')).toBe(100);
    expect(await countByStatus('failed')).toBe(0);
  });

  it('a queue that is ENTIRELY parked reports the backlog and delivers nothing', async () => {
    await queueRows('email', 5, 'Parked email');
    await queueRows('sms', 3, 'Parked sms');

    const report = await deliverQueued(db);

    expect(report.delivered).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.attempted, 'nothing deliverable was even selected').toBe(0);
    expect(report.queuedNoTransport).toBe(8);
  });
});

describe('the parked count is the real backlog, not the page', () => {
  it('counts past `limit`, because that number is what an operator acts on', async () => {
    // The old counter incremented inside the loop, so it could never report
    // more than `limit` however large the backlog grew. An operator deciding
    // whether to configure a provider was shown 100 when the true figure was
    // any number at all.
    await queueRows('email', 250, 'Parked email');

    const report = await deliverQueued(db);

    expect(report.queuedNoTransport).toBe(250);
  });

  it('counts only parked rows, not deliverable ones', async () => {
    await queueRows('email', 4, 'Parked email');
    await queueRows('in_app', 6, 'Member notice');

    const report = await deliverQueued(db);

    expect(report.queuedNoTransport).toBe(4);
    expect(report.delivered).toBe(6);
  });
});

describe('configuring a provider releases the backlog rather than losing it', () => {
  it('rows parked while unconfigured deliver once a transport exists', async () => {
    await queueRows('email', 3, 'Parked email');

    const before = await deliverQueued(db);
    expect(before.delivered).toBe(0);
    expect(before.queuedNoTransport).toBe(3);

    // The promise the original skip was written to keep. It still holds.
    process.env.EMAIL_PROVIDER_URL = 'https://provider.invalid/send';
    process.env.EMAIL_FROM = 'federation@mmakf.in';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as any;

    try {
      const after = await deliverQueued(db);
      expect(after.queuedNoTransport).toBe(0);
      // They have no person and no recipient_email, so they fail to ADDRESS
      // rather than deliver — the point here is that they were reached at all,
      // which is what being parked behind a wedge prevented.
      expect(after.attempted).toBe(3);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
