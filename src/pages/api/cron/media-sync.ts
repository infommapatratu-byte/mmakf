// Scheduled media synchronisation — broadcast detection for the Live Master
// Teacher system. §24, §25.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE GAP THIS CLOSES
// ─────────────────────────────────────────────────────────────────────────────
//
// `syncBroadcasts()` and `closeStaleBroadcasts()` in src/lib/youtube.ts are
// complete: OAuth, encrypted refresh tokens, idempotent broadcast records,
// per-channel error isolation, recording capture with retry. And NOTHING CALLED
// EITHER OF THEM. No route, no cron, no admin button.
//
// So the whole premise of §25 — that a class appears inside MMAKF by itself
// when an authorised teacher goes live — was never true. Detection existed as
// code and never as behaviour, which is indistinguishable from not existing to
// everybody except the person reading the module.
//
// This is the second instance of that exact defect found in one session; the
// technical library's seeder was the first. Both are the same shape as a page
// linked from nowhere, and worth naming as a pattern: a capability is not
// shipped until something invokes it on its own.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A SEPARATE JOB FROM /api/cron/reconcile
// ─────────────────────────────────────────────────────────────────────────────
//
// Cadence. Reconcile runs nightly, which is right for expiring stale orders and
// retrying fulfilments. A live class detected up to twenty-four hours after it
// started is not detected at all — the entire value is being live while it is
// live. This job wants minutes, and putting it inside the nightly run would
// either make detection useless or make the nightly job run all day.
//
// Isolation is the second reason: a failure in broadcast polling must not stop
// order reconciliation, and vice versa.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND WHY IT IS NOT IN vercel.json, WHICH MATTERS MORE THAN IT LOOKS
// ─────────────────────────────────────────────────────────────────────────────
//
// It was, at `*/5 * * * *`, and tests/vercel-config.test.ts refused it. That
// guard is not a style rule — it encodes seventeen hours of stale production:
//
//   cron_jobs_limits_reached — Hobby accounts are limited to daily cron jobs.
//
// Vercel rejects a sub-daily schedule WHEN THE DEPLOYMENT IS CREATED, before any
// build starts. No deployment appears, nothing shows in the Deployments tab, and
// the Git integration goes on reporting itself healthy while production serves
// yesterday's build. Registering this cron would not have made detection run
// every five minutes; it would have stopped the site deploying at all.
//
// A DAILY SCHEDULE WAS NOT THE ANSWER EITHER. A class lasts an hour. Polling
// once a day cannot detect one, and a cron entry that looks scheduled and can
// never work is exactly the fake affordance this project forbids — worse than
// an absent feature, because it reads as done.
//
// So the route exists, is authorised, and is invoked by whatever scheduler the
// deployment actually has:
//
//   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/media-sync
//
// A GitHub Actions schedule, an external ping service, or a Vercel plan that
// permits sub-daily crons all work. The choice belongs to whoever operates the
// deployment, and docs/technical/MASTER-TEACHER-INTEGRATION.md records it.
//
// ─────────────────────────────────────────────────────────────────────────────
// AUTHORISATION, AND WHY AN UNSET SECRET MEANS NO
// ─────────────────────────────────────────────────────────────────────────────
//
// CRON_SECRET, exactly as reconcile.ts does it. An endpoint that polls a third
// party and writes to the media register is an endpoint an attacker would
// happily run for you: quota is finite, and exhausting it is how detection
// stops working for the rest of the day.
//
// No secret configured means the job CANNOT BE TRIGGERED, rather than being
// open to anyone. An unset variable must never mean "allow".

import type { APIRoute } from 'astro';
import { isConfigured, db } from '@/db';
import { syncBroadcasts, closeStaleBroadcasts, integrationStatus } from '@/lib/youtube';
import { legacyAdminPrincipal } from '@/lib/rbac';
import type { AuditContext } from '@/db/federation';

export const prerender = false;

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get('authorization') || '';
  return header === `Bearer ${secret}`;
}

export const GET: APIRoute = async ({ request }) => {
  if (!authorised(request)) return json({ error: 'Unauthorized' }, 401);

  // Both of these are SKIPPED, not failed. A deployment without a database or
  // without YouTube credentials is a legitimate configuration — most of them,
  // currently — and a cron that reported failure every five minutes for a
  // condition nobody intends to change is a cron whose alerts get muted, taking
  // the real failures with them.
  if (!isConfigured()) {
    return json({ ok: true, skipped: 'no database configured' }, 200);
  }

  const status = integrationStatus();
  if (!status.ready) {
    return json({ ok: true, skipped: 'youtube integration not configured', missing: status.missing }, 200);
  }

  // The sync writes audit rows, and an audit row must name who acted. Nobody
  // signed in to a cron, so it acts as the scheduler and says so — the audit
  // trail should read "the scheduler did this", never a borrowed human name.
  const ctx: AuditContext = {
    principal: legacyAdminPrincipal(),
    reason: 'Scheduled broadcast detection',
    authority: 'cron:media-sync',
  };

  const report: Record<string, unknown> = {};

  try {
    // syncBroadcasts() already closes stale broadcasts as its last step, and is
    // written never to throw for one channel's failure — a revoked token on one
    // teacher's channel must not stop every other channel from syncing. Its
    // per-channel errors come back in the report rather than as an exception.
    const sync = await syncBroadcasts(db(), ctx);
    report.channelsPolled = sync.channelsPolled;
    report.broadcastsFound = sync.broadcastsFound;
    report.broadcastsStarted = sync.broadcastsStarted;
    report.broadcastsEnded = sync.broadcastsEnded;
    report.recordingsLinked = sync.recordingsLinked;
    report.liveClassesCreated = sync.liveClassesCreated;
    if (sync.errors.length) report.channelErrors = sync.errors.slice(0, 20);
  } catch (err: any) {
    // Only a fault outside any single channel reaches here — the database
    // itself, or a configuration error. Recorded rather than thrown, so the
    // sweep below still runs.
    report.syncError = String(err?.message ?? err).slice(0, 300);

    // The stale-broadcast sweep is worth attempting even when polling failed:
    // a broadcast that ended while the poller was broken should still be
    // closed, otherwise it shows as live indefinitely on a public page.
    try {
      const swept = await closeStaleBroadcasts(db(), ctx);
      report.broadcastsEnded = swept.ended;
      report.recordingsLinked = swept.recordingsLinked;
    } catch (sweepErr: any) {
      report.sweepError = String(sweepErr?.message ?? sweepErr).slice(0, 300);
    }
  }

  // NOTHING HERE PUBLISHES ANYTHING. Everything detected lands pending review
  // with rights not cleared, and a live class is published only where the
  // federation has explicitly configured that channel to auto-publish. §24 is
  // the rule: a teacher's channel is not a federation curriculum.
  report.published = 0;

  const failed = Boolean(report.syncError || report.sweepError);
  return json({ ok: !failed, ...report }, failed ? 500 : 200);
};
