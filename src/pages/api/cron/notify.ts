// /api/cron/notify — the notification pipeline, every five minutes.
//
// WHY THIS EXISTS BESIDE /api/cron/reconcile. Reconcile runs once a day (it was
// pinned to daily by the Hobby plan, and it does heavy work: order expiry,
// fulfilment retries, review sweeps). Notifications rode along with it, so a
// payment receipt or a class notice could wait up to 24 hours. On the Pro plan a
// short schedule is allowed, and this route does only the notification steps:
//
//   1. drain the domain-event feed into inbox notifications (notifyForEvent)
//   2. give every essential inbox notification an email twin
//   3. fan new inbox notifications out to subscribed devices as web push
//      (deliverPushForNotifications had no caller before this route)
//   4. send what is queued: inbox, email (SMTP or HTTP provider)
//   5. retry the push backlog
//
// Every step is idempotent and deduplicated, so overlapping with the nightly run
// is harmless. Each step is isolated: one failing step is reported and the rest
// still run. Authorised exactly like reconcile: Authorization: Bearer CRON_SECRET,
// which Vercel Cron sends when CRON_SECRET is set on the project.

import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import { consume } from '@/lib/domain-events';
import { notifyForEvent, deliverQueued, queueEmailForEssentialNotifications } from '@/lib/notifications';
import { deliverPushForNotifications, deliverQueuedPush } from '@/lib/push';
import { legacyAdminPrincipal } from '@/lib/rbac';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') || '';
  return header === `Bearer ${secret}`;
}

async function step(report: Record<string, unknown>, name: string, fn: () => Promise<unknown>) {
  try {
    report[name] = await fn();
  } catch (err: any) {
    report[`${name}Error`] = String(err?.message ?? err).slice(0, 300);
  }
}

export const GET: APIRoute = async ({ request }) => {
  if (!authorised(request)) return json({ error: 'Unauthorized' }, 401);
  if (!isConfigured()) return json({ ok: true, skipped: 'no database configured' }, 200);

  const report: Record<string, unknown> = {};
  const ctx = {
    principal: legacyAdminPrincipal(),
    reason: 'Scheduled notification pipeline.',
    authority: 'MMAKF cron',
  };

  await step(report, 'feed', async () => {
    const drained = await consume(
      db(),
      'notifications',
      async (event) => { await notifyForEvent(db(), ctx, event); },
      { maxClassification: 'member' },
    );
    return {
      from: drained.from, to: drained.to, delivered: drained.delivered,
      skipped: drained.skipped, failedAtEventId: drained.failedAtEventId, backlog: drained.more,
    };
  });
  await step(report, 'emailFanOut', () => queueEmailForEssentialNotifications(db()));
  await step(report, 'pushFanOut', () => deliverPushForNotifications(db()));
  await step(report, 'delivery', () => deliverQueued(db()));
  await step(report, 'pushBacklog', () => deliverQueuedPush(db()));

  const ok = !Object.keys(report).some((k) => k.endsWith('Error'));
  return json({ ok, ...report }, ok ? 200 : 500);
};
