// Scheduled reconciliation.
//
// Two jobs that nothing was doing, both of which lose money or block sales:
//
//  1. EXPIRE STALE ORDERS. An unpaid order holds a stock reservation. With no
//     scheduler, abandoned checkouts held the last gi forever and the item
//     showed as out of stock while sitting on the shelf.
//
//  2. DRAIN THE DOMAIN-EVENT FEED. Seventeen event types declare a
//     'notifications' consumer, and `publish()` had been appending them to
//     `domain_events` for months — but NOTHING IN THE APPLICATION EVER CALLED
//     `consume()`. The cursor never advanced, `notifyForEvent()` never ran
//     outside its tests, and the member inbox at /my/notifications never
//     received a row.
//
//     That is not an abstract gap. An administrator cancelling a class through
//     /admin/schedules publishes CLASS_SESSION_CANCELLED inside the same
//     transaction that releases every booking on it; the catalogue promises the
//     people holding those places are told; and nobody was. The same severed
//     link stranded CERTIFICATE_ISSUED, CLASS_SESSION_RESCHEDULED,
//     SCHEDULE_PUBLISHED, PROGRAM_ACCESS_REVOKED and the expiry warnings.
//
//  3. RETRY FAILED FULFILMENTS. The webhook handler deliberately returns 200
//     when fulfilment throws, because a provider retry would hit the replay
//     guard and change nothing. That is correct — but it means a payment that
//     was captured and failed to fulfil is money taken with nothing issued, and
//     nothing else was ever going to look at it again. This is the exceptions
//     queue.
//
// Invoked by Vercel Cron (see vercel.json). Authorised by CRON_SECRET, because
// an unauthenticated endpoint that mutates orders is an endpoint an attacker
// can use to expire everyone's checkout.

import type { APIRoute } from 'astro';
import { and, eq, isNotNull, isNull, desc } from 'drizzle-orm';
import { isConfigured, db } from '@/db';
import { expireStaleOrders, confirmPayment, markWebhookProcessed } from '@/db/orders';
import { releaseExpiredReservations } from '@/db/inventory';
import { runDailySweeps } from '@/db/automations';
import { detectReviewPatterns, computeAllPerformance } from '@/db/marketplace-trust';
import { consume } from '@/lib/domain-events';
import { notifyForEvent, deliverQueued } from '@/lib/notifications';
import { deliverQueuedPush } from '@/lib/push';
import { legacyAdminPrincipal } from '@/lib/rbac';
import { providerById } from '@/lib/payments';
import * as s from '@/db/schema';

export const prerender = false;

/** Retry at most this many failed events per run, so one run cannot run long. */
const RETRY_BATCH = 25;

/**
 * THE STEPS, NAMED, SO THE RESPONSE CAN SAY WHICH ONES DID NOT RUN.
 *
 * This route returned `{ok: true}` with HTTP 200 unconditionally — after the
 * report was assembled, and without ever looking at it. Every step is wrapped
 * in its own try/catch on purpose, so that one bad night for the push backlog
 * cannot stop task escalation; the cost of that isolation is that a run in
 * which EVERY step threw looked, from outside, exactly like a run in which
 * every step succeeded.
 *
 * It was not hypothetical. Between 22 August and 6 September 2026 production
 * Postgres refused the application's password (28P01) and this job ran nightly,
 * caught nine exceptions a night, and reported success roughly fifteen times.
 * Nothing alerted, because there was nothing in the response for an alert to
 * key on. The outage was eventually found from the sign-in page, not from here.
 *
 * The list is written out rather than derived from key names because the keys
 * do not follow one pattern and cannot safely be inferred:
 *   · the fulfilment step sets `retryError` on failure but ALSO always sets
 *     `fulfilmentRetried`/`fulfilmentRecovered`/`stillFailing` outside its
 *     try, so "has a result key" does not mean "succeeded";
 *   · the reservation step reports as `marketplaceReservationsReleased` but
 *     fails as `marketplaceReservationsError`, so stripping the suffix yields
 *     neither name.
 * A derived version of this would be wrong in a way nobody would notice until
 * the next silent fortnight.
 */
export const STEPS: ReadonlyArray<{ errorKey: string; name: string }> = [
  { errorKey: 'ordersExpiredError', name: 'expire-stale-orders' },
  { errorKey: 'marketplaceReservationsError', name: 'release-reservations' },
  { errorKey: 'retryError', name: 'retry-fulfilment' },
  { errorKey: 'notificationsError', name: 'drain-domain-events' },
  { errorKey: 'notificationsDeliveryError', name: 'deliver-notifications' },
  { errorKey: 'pushBacklogError', name: 'deliver-push' },
  { errorKey: 'operationsError', name: 'daily-sweeps' },
  { errorKey: 'reviewPatternsError', name: 'detect-review-patterns' },
  { errorKey: 'performanceError', name: 'seller-performance' },
];

/**
 * What the run actually achieved, in terms an alert can read.
 *
 * `ok` is false the moment ANY step failed — a partial run is not a success,
 * and calling it one is how fifteen nights went by. The HTTP status is a
 * coarser signal on purpose: 500 only when every step failed, because that is
 * the shape of an infrastructure fault (the register is unreachable; nothing
 * can run) as opposed to one step having a bad night. Vercel's cron dashboard
 * keys on the status, so a total failure goes red there without a single flaky
 * push delivery turning the job red every other night and training whoever
 * watches it to ignore the colour.
 */
export function outcome(report: Record<string, unknown>) {
  const failedSteps = STEPS.filter((s) => s.errorKey in report).map((s) => s.name);
  return {
    ok: failedSteps.length === 0,
    failedSteps,
    // Reported rather than inferred: a reader should not have to know how many
    // steps this file has in order to tell "all of them" from "most of them".
    stepsTotal: STEPS.length,
    everyStepFailed: failedSteps.length === STEPS.length,
  };
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  // No secret configured means the job cannot be triggered at all, rather than
  // being open to anyone — an unset variable must never mean "allow".
  if (!secret) return false;
  const header = request.headers.get('authorization') || '';
  return header === `Bearer ${secret}`;
}

export const GET: APIRoute = async ({ request }) => {
  if (!authorised(request)) return json({ error: 'Unauthorized' }, 401);
  if (!isConfigured()) return json({ ok: true, skipped: 'no database configured' }, 200);

  const report: Record<string, unknown> = {};

  // ── 1. Release reservations held by orders that were never paid ──────────
  try {
    report.ordersExpired = await expireStaleOrders(db());
  } catch (err: any) {
    report.ordersExpiredError = String(err?.message ?? err).slice(0, 300);
  }

  // ── 1b. And the MARKETPLACE's reservations, which are a different table ───
  //
  // expireStaleOrders() above releases the legacy shop's holds on
  // `product_variants`. A marketplace basket reserves in `stock_reservations`
  // against `listing_variants`, with an expiry checkout() sets, and NOTHING
  // released them: releaseExpiredReservations() existed, was tested, and had no
  // caller anywhere in src/.
  //
  // The failure is silent and cumulative. Every abandoned marketplace checkout
  // held its stock permanently, so a seller's available quantity fell with each
  // one and never recovered — until the item read out of stock while the goods
  // sat on the shelf. No error, no queue, nothing to notice.
  //
  // Separate try/catch from the block above so that a fault in one sweep does
  // not stop the other, which is the pattern every step in this file follows.
  try {
    report.marketplaceReservationsReleased = await releaseExpiredReservations(db());
  } catch (err: any) {
    report.marketplaceReservationsError = String(err?.message ?? err).slice(0, 300);
  }

  // ── 2. Re-attempt fulfilment for captured payments that failed to fulfil ──
  let retried = 0;
  let recovered = 0;
  const stillFailing: string[] = [];

  try {
    const failures = await db()
      .select()
      .from(s.paymentEvents)
      .where(and(eq(s.paymentEvents.signatureValid, true), isNotNull(s.paymentEvents.processingError)))
      .orderBy(desc(s.paymentEvents.id))
      .limit(RETRY_BATCH);

    for (const event of failures) {
      retried++;
      const provider = providerById(event.provider);
      if (!provider) { stillFailing.push(`${event.eventId}: unknown provider`); continue; }

      try {
        // Re-read the payment FROM THE PROVIDER rather than trusting the stored
        // payload: by now the truth may have moved on, and the provider is the
        // authority on whether money was taken.
        const entity = (event.payload as any)?.payload?.payment?.entity;
        const providerPaymentId = entity?.id;
        if (!providerPaymentId) { stillFailing.push(`${event.eventId}: no payment id in payload`); continue; }

        const verified = await provider.fetchPayment(String(providerPaymentId));
        await confirmPayment(
          db(),
          { principal: { userId: null, label: `cron:${event.provider}`, bindings: [] }, authority: event.provider },
          verified
        );
        await markWebhookProcessed(db(), event.id);
        recovered++;
      } catch (err: any) {
        stillFailing.push(`${event.eventId}: ${String(err?.message ?? err).slice(0, 120)}`);
      }
    }
  } catch (err: any) {
    report.retryError = String(err?.message ?? err).slice(0, 300);
  }

  report.fulfilmentRetried = retried;
  report.fulfilmentRecovered = recovered;
  // Surfaced, not swallowed: anything still failing after a retry needs a human,
  // and this is how the office learns it exists.
  report.stillFailing = stillFailing;

  // ── 3. Unpaid orders that are past their expiry but still reserved ────────
  try {
    const orphans = await db()
      .select({ orderNo: s.orders.orderNo })
      .from(s.orders)
      .where(and(eq(s.orders.status, 'paid'), isNull(s.orders.paidAt)))
      .limit(50);
    // A paid order with no paidAt would mean the two writes diverged; report it
    // rather than repairing silently, because it should be impossible.
    report.inconsistentOrders = orphans.map((o: any) => o.orderNo);
  } catch {
    /* diagnostic only */
  }

  // ── 4. Drain the domain-event feed into notifications ────────────────────
  //
  // CAPPED AT 'member'. A consumer that writes to a member's inbox must never
  // be handed an event above the level a member may see; `consume()` steps over
  // anything higher, advances past it, and RETURNS THE IDS it stepped over so an
  // operator asking "why did nobody hear about X" can reconstruct the answer.
  //
  // IDEMPOTENT. `notifyForEvent()` dedupes on the domain event id, so a run that
  // fails half way and is retried tomorrow cannot notify anybody twice. The
  // cursor stops immediately BEFORE the event whose handler threw, so nothing is
  // skipped silently on the way past a failure — and `failedAtEventId` names it.
  //
  // `more: true` means the batch filled and there is still a backlog. It is
  // reported rather than looped, because one cron run must not run long; the
  // next run continues from the cursor.
  try {
    const ctx = {
      principal: legacyAdminPrincipal(),
      reason: 'Scheduled domain-event feed drain.',
      authority: 'MMAKF cron',
    };
    const drained = await consume(
      db(),
      'notifications',
      async (event) => { await notifyForEvent(db(), ctx, event); },
      { maxClassification: 'member' },
    );
    report.notifications = {
      from: drained.from,
      to: drained.to,
      delivered: drained.delivered,
      skipped: drained.skipped,
      skippedEventIds: drained.skippedEventIds,
      failedAtEventId: drained.failedAtEventId,
      failureMessage: drained.failureMessage,
      backlog: drained.more,
    };
  } catch (err: any) {
    report.notificationsError = String(err?.message ?? err).slice(0, 300);
  }

  // ── 5. Send what the drain queued ────────────────────────────────────────
  //
  // An in-app row IS the notification, so it is marked sent here and appears in
  // the member's inbox. A row whose channel has no transport configured stays
  // queued and is counted, rather than being marked sent on the strength of a
  // credential nobody supplied.
  try {
    report.notificationsDelivery = await deliverQueued(db());
  } catch (err: any) {
    report.notificationsDeliveryError = String(err?.message ?? err).slice(0, 300);
  }

  // ── 6. Retry the push backlog ────────────────────────────────────────────
  //
  // Push rows queue rather than fail when VAPID keys are absent, which is the
  // right call — a member's device subscription is not invalidated by the
  // operator not having configured a key yet. But a backlog that is never
  // retried is a backlog that was dropped slowly, and nothing was retrying it.
  //
  // No guard here: `deliverQueuedPush()` checks `pushStatus()` itself and, when
  // push is unconfigured, retries nothing, marks nothing failed, and reports how
  // deep the backlog is. That is the honest answer and it belongs in the report.
  try {
    report.pushBacklog = await deliverQueuedPush(db());
  } catch (err: any) {
    report.pushBacklogError = String(err?.message ?? err).slice(0, 300);
  }

  // ── 7. The operations sweeps ─────────────────────────────────────────────
  //
  // Workflow retries, task escalation and support escalation. All three are
  // idempotent and each is independently guarded inside runDailySweeps(), so a
  // stuck workflow retry cannot stop task escalation from running for a week.
  //
  // ONE CRON, NOT FOUR. Vercel's Hobby plan allows daily crons only, and it
  // rejects a project that asks for more AT DEPLOYMENT CREATION — leaving no
  // deployment, no build log and no error anywhere in the dashboard. That cost
  // this project seventeen hours once already (see tests/vercel-config.test.ts).
  // Adding a second schedule here would risk it again for no benefit.
  try {
    report.operations = await runDailySweeps(db(), {
      principal: legacyAdminPrincipal(),
      reason: 'Scheduled daily operations sweep.',
      authority: 'MMAKF cron',
    });
  } catch (err: any) {
    report.operationsError = String(err?.message ?? err).slice(0, 300);
  }

  // ── 8. The marketplace trust sweeps ──────────────────────────────────────
  //
  // Neither of these had a caller. The console's fraud queue could only ever be
  // empty, and the performance band shown against every seller was computed by
  // nothing — a column that had never been written since the day it was added.
  //
  // SEPARATELY GUARDED, on the rule the rest of this file follows: a fault in
  // the detector must not stop the snapshots, and neither must stop the cron
  // from returning a report saying what did and did not run.

  // Raises SIGNALS for a person to look at, and decides nothing. Window and
  // thresholds are the module's own — nothing is chosen here.
  try {
    report.reviewPatterns = await detectReviewPatterns(db());
  } catch (err: any) {
    report.reviewPatternsError = String(err?.message ?? err).slice(0, 300);
  }

  // A TRAILING 30 DAYS, STATED RATHER THAN IMPLIED. A snapshot must be of some
  // period; this one drives no enforcement anywhere in the codebase, and a
  // seller with too few completed orders gets a null score and
  // PERFORMANCE_NOT_COMPUTED rather than a figure computed from a sample too
  // small to defend. If performance ever gains consequences, this window stops
  // being a reporting detail and belongs in configuration.
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86_400_000);
    report.performance = await computeAllPerformance(
      db(),
      {
        principal: legacyAdminPrincipal(),
        reason: 'Scheduled marketplace performance snapshot.',
        authority: 'MMAKF cron',
      },
      start.toISOString().slice(0, 10),
      end.toISOString().slice(0, 10),
    );
  } catch (err: any) {
    report.performanceError = String(err?.message ?? err).slice(0, 300);
  }

  const { ok, failedSteps, stepsTotal, everyStepFailed } = outcome(report);

  // console.error rather than console.log when anything failed, so the run is
  // findable in Vercel's log search by level alone. Grepping fifteen nights of
  // identical-looking `[cron/reconcile]` lines for a nested `*Error` key is the
  // work this line exists to remove.
  const line = `[cron/reconcile] ${JSON.stringify({ ok, failedSteps, ...report })}`;
  if (ok) console.log(line);
  else console.error(line);

  return json(
    { ok, failedSteps, stepsTotal, ...report },
    everyStepFailed ? 500 : 200,
  );
};
