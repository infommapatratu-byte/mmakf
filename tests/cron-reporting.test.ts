// The nightly job must not report success for work it did not do.
//
// WHAT THIS GUARDS, AND WHY IT IS WORTH A FILE OF ITS OWN.
//
// `/api/cron/reconcile` wraps each of its nine steps in its own try/catch, so
// that one bad night for the push backlog cannot stop task escalation from
// running for a week. That isolation is correct and should stay. Its cost is
// that the route assembles a report full of `*Error` keys and then — until
// this test existed — returned `{ok: true}` with HTTP 200 without ever looking
// at it.
//
// Between 22 August and 6 September 2026 production Postgres refused the
// application's password (28P01). This job ran every night, caught nine
// exceptions each time, and reported success roughly fifteen times in a row.
// Nothing alerted, because there was nothing in the response for an alert to
// key on, and the outage was eventually found from the sign-in page instead.
//
// So the assertions below are not about tidy JSON. Each one is the specific
// thing that, had it held in August, would have turned a silent fortnight into
// a red cron on the first morning.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { outcome, STEPS } from '../src/pages/api/cron/reconcile';

const ROUTE = 'src/pages/api/cron/reconcile.ts';

/** Every step failing at once — the shape of the register being unreachable. */
function everythingFailed(): Record<string, unknown> {
  const report: Record<string, unknown> = {};
  for (const step of STEPS) report[step.errorKey] = 'password authentication failed';
  return report;
}

describe('a clean run still reports success', () => {
  it('an empty report is ok with nothing failed', () => {
    const o = outcome({});
    expect(o.ok).toBe(true);
    expect(o.failedSteps).toEqual([]);
    expect(o.everyStepFailed).toBe(false);
  });

  it('a report carrying only results is ok', () => {
    const o = outcome({
      ordersExpired: 3,
      marketplaceReservationsReleased: 0,
      fulfilmentRetried: 2,
      notifications: { drained: 11 },
      operations: { taskEscalations: 4 },
    });
    expect(o.ok).toBe(true);
    expect(o.failedSteps).toEqual([]);
  });
});

describe('any failed step makes the run not ok', () => {
  it('one failure is reported by name', () => {
    const o = outcome({ ordersExpired: 3, pushBacklogError: 'VAPID not configured' });
    expect(o.ok).toBe(false);
    expect(o.failedSteps).toEqual(['deliver-push']);
    // One bad step is NOT an infrastructure fault, so the status stays 200 and
    // the cron dashboard stays green. Turning it red for a flaky push delivery
    // is how a team learns to ignore the colour.
    expect(o.everyStepFailed).toBe(false);
  });

  it('several failures are all named, in step order', () => {
    const o = outcome({
      ordersExpiredError: 'boom',
      operationsError: 'boom',
      performanceError: 'boom',
    });
    expect(o.ok).toBe(false);
    expect(o.failedSteps).toEqual(['expire-stale-orders', 'daily-sweeps', 'seller-performance']);
  });

  it('THE AUGUST SIGNATURE: every step failing sets everyStepFailed', () => {
    const o = outcome(everythingFailed());
    expect(o.ok).toBe(false);
    expect(o.failedSteps).toHaveLength(STEPS.length);
    expect(o.stepsTotal).toBe(STEPS.length);
    // This is the flag the route turns into HTTP 500, which is the only signal
    // Vercel's cron dashboard reads. Without it the fortnight is silent again.
    expect(o.everyStepFailed).toBe(true);
  });
});

describe('the two report keys that cannot be inferred from their names', () => {
  // Both of these would be got wrong by a derived implementation — one that
  // scanned for keys ending in "Error" and matched them against result keys —
  // and the wrongness would not show up until the next silent outage.

  it('a failed fulfilment retry is a failure even though the step still sets result keys', () => {
    // `fulfilmentRetried`/`fulfilmentRecovered`/`stillFailing` are assigned
    // OUTSIDE that step's try block, so they are present on the failure path
    // too. "Has a result key" therefore does not mean "succeeded".
    const o = outcome({
      retryError: 'connection terminated',
      fulfilmentRetried: 0,
      fulfilmentRecovered: 0,
      stillFailing: 0,
    });
    expect(o.ok).toBe(false);
    expect(o.failedSteps).toEqual(['retry-fulfilment']);
  });

  it('the reservation step is caught despite its result and error keys differing', () => {
    // Reports as `marketplaceReservationsReleased`, fails as
    // `marketplaceReservationsError`. Stripping the suffix yields neither name.
    const o = outcome({ marketplaceReservationsError: 'relation does not exist' });
    expect(o.ok).toBe(false);
    expect(o.failedSteps).toEqual(['release-reservations']);
  });
});

describe('the step list matches the route it describes', () => {
  const route = readFileSync(ROUTE, 'utf8');

  it('every error key STEPS names is actually written by the route', () => {
    // A step renamed in the route but not here would silently stop being
    // counted, and the run would go back to reporting success without it.
    for (const step of STEPS) {
      expect(route, `${ROUTE} must assign report.${step.errorKey}`)
        .toMatch(new RegExp(`report\\.${step.errorKey}\\s*=`));
    }
  });

  it('every error key the route writes is named in STEPS', () => {
    // The other direction, which is the one that rots: a step added to the
    // route without a STEPS entry fails invisibly forever.
    const written = new Set(
      Array.from(route.matchAll(/report\.([A-Za-z]+Error)\s*=/g)).map((m) => m[1])
    );
    const known = new Set(STEPS.map((s) => s.errorKey));
    const unaccounted = [...written].filter((k) => !known.has(k));
    expect(unaccounted, `these error keys are written but not in STEPS: ${unaccounted.join(', ')}`)
      .toEqual([]);
  });

  it('the route no longer returns an unconditional ok:true', () => {
    // The literal defect, asserted as a literal. `{ ok: true, ...report }` was
    // the whole bug.
    expect(route).not.toMatch(/return\s+json\(\s*\{\s*ok:\s*true,\s*\.\.\.report/);
    expect(route, 'the response must carry the computed outcome')
      .toMatch(/outcome\(report\)/);
    expect(route, 'a total failure must be able to answer 500')
      .toMatch(/everyStepFailed\s*\?\s*500\s*:\s*200/);
  });

  it('a failing run is logged at error level so it is findable by level alone', () => {
    expect(route).toMatch(/console\.error\(/);
  });
});
