// An engine with no door is not a feature.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEFECT CLASS
// ═════════════════════════════════════════════════════════════════════════════
//
// /api/marketplace/[...action].ts exposes ninety actions. Every one of them is
// implemented, authorised, audited and covered by a suite that calls the
// underlying function directly — and thirty of them could not be reached by any
// human being, because nothing in the tree drew a control that called them.
//
// The consequences were not theoretical:
//
//   · `return/inspect` and `return/refund` had no control, so a return could be
//     requested and authorised and the money then stopped there. The refund
//     chain dead-ended in the middle.
//   · `review/product`, `review/seller` and `review/moderate` had none, so no
//     review could be written and none published — and refreshSellerRating()
//     counts published reviews only, so every seller would have shown as
//     unrated for ever.
//   · `stock/adjust` and `stock/count` had none, so from the seller portal
//     stock could go UP and never down.
//   · `variant/update` and `variant/discontinue` had none, so a price could be
//     set once and never corrected.
//   · `listing/quarantine` and `listing/unquarantine` had none, so the fast
//     reversible remedy could not be applied and — worse — could not be lifted.
//   · `authenticity/open`, `authenticity/decide`, `flag/raise`, `fraud/review`
//     and `badge/revoke` had none, so a counterfeit complaint could be filed
//     over HTTP and found by nobody, and an endorsement could be granted and
//     never withdrawn.
//
// tests/marketplace-wiring.test.ts asks the same question of the EVENT
// producers — "does anything call it?" — and this suite asks it of the
// ACTIONS, from the other end: does anything a person can press call it?
//
// ═════════════════════════════════════════════════════════════════════════════
// HOW IT ASKS
// ═════════════════════════════════════════════════════════════════════════════
//
// The action names are read out of the route's own dispatch table, so the list
// cannot drift from the routes that exist. A control counts when the action
// name appears anywhere under src/pages or src/components outside the API route
// itself — that is deliberately generous, because the pages post through one
// `fetch(\`/api/marketplace/${action}\`)` helper and a stricter match would be
// asserting a coding style rather than reachability.
//
// EVERY EXEMPTION CARRIES ITS REASON, in the same spirit as EXCLUSIONS in
// src/lib/seo.ts: an exemption nobody can justify later is deleted by somebody
// tidying up, and the control quietly stops existing again.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const API_ROUTE = join('src', 'pages', 'api', 'marketplace', '[...action].ts');

/**
 * Actions that legitimately have no control bearing their name, and why.
 *
 * A reason is mandatory — the test asserts the map's values are real sentences,
 * not placeholders.
 */
const NO_CONTROL_BY_DESIGN: Record<string, string> = {
  'listing/review':
    'The listing review queue at /admin/listings decides through a form POST to itself, calling ' +
    'reviewListing() server-side rather than through the JSON API. That is the stronger shape, not ' +
    'a weaker one: it works with scripting off, which matters on the page that decides whether a ' +
    'seller may trade at all.',
  'listing/delist':
    'Same page and same reason as listing/review — /admin/listings calls delistListing() directly ' +
    'in its own POST handler, so the control exists and does not go through this route.',
  'store/open':
    'Wired on /portal/seller as post(`store/${which}`), where `which` is "open" or "close" from the ' +
    'button. The control exists; the literal string does not, because one handler serves both ' +
    'directions and splitting it would be two copies of one act.',
  'store/close':
    'The other half of the same control on /portal/seller. See store/open.',
  'settlement/accrue':
    'Called by the engine itself: markDelivered() in src/db/seller-orders.ts accrues the seller ' +
    'order as part of recording the delivery. The API action exists so that a run can be repeated ' +
    'by hand after a fault, and a button for it would invite somebody to accrue a sale twice.',
};

/** Every action name the route dispatches on, read from the route itself. */
function actionNames(): string[] {
  const text = readFileSync(API_ROUTE, 'utf8');
  const names = [...text.matchAll(/^\s+'([a-z][a-z-]*\/[a-z][a-z-]*)':/gm)].map((m) => m[1]);
  return [...new Set(names)];
}

function surfaceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) surfaceFiles(p, out);
    else if (/\.(astro|ts)$/.test(e)) out.push(p);
  }
  return out;
}

/**
 * Every surface file, read once.
 *
 * The API route is excluded: it defines the actions, so its own text would
 * make every one of them look reachable.
 */
const SURFACES: ReadonlyArray<readonly [string, string]> = (() => {
  const files = [
    ...surfaceFiles(join('src', 'pages')),
    ...surfaceFiles(join('src', 'components')),
  ].filter((f) => !f.endsWith(join('marketplace', '[...action].ts')));
  return files.map((f) => [f, readFileSync(f, 'utf8')] as const);
})();

function controlsFor(action: string): string[] {
  return SURFACES.filter(([, src]) => src.includes(action)).map(([f]) => f);
}

describe('every marketplace action a person is meant to take has a control', () => {
  it('reads a real dispatch table — the guard is not vacuous', () => {
    const actions = actionNames();
    expect(actions.length).toBeGreaterThan(50);
    // Spot-check that parsing found real entries rather than comment text.
    expect(actions).toContain('return/refund');
    expect(actions).toContain('review/moderate');
    expect(actions).toContain('seller/approve');
  });

  it('no action is reachable only over HTTP', () => {
    const orphans = actionNames()
      .filter((a) => !NO_CONTROL_BY_DESIGN[a])
      .filter((a) => controlsFor(a).length === 0);

    expect(
      orphans,
      'marketplace actions with no control anywhere in src/pages or src/components. ' +
      'Either draw the control, or add the action to NO_CONTROL_BY_DESIGN with the reason.',
    ).toEqual([]);
  });

  it('every exemption carries a reason a human wrote', () => {
    for (const [action, reason] of Object.entries(NO_CONTROL_BY_DESIGN)) {
      expect(action, `${action} is not an action name`).toMatch(/^[a-z][a-z-]*\/[a-z][a-z-]*$/);
      expect(reason.length, `${action} has no reason`).toBeGreaterThan(60);
    }
  });

  it('and no exemption names an action that no longer exists', () => {
    // The other direction, which catches a stale entry. Without it, renaming an
    // action would silently exempt the new one's absence for ever.
    const actions = new Set(actionNames());
    const stale = Object.keys(NO_CONTROL_BY_DESIGN).filter((a) => !actions.has(a));
    expect(stale, `exemptions for actions that no longer exist: ${stale.join(', ')}`).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('the chain each control belongs to actually reaches its surface', () => {
// ═════════════════════════════════════════════════════════════════════════════

  // Naming the surfaces makes the failure legible: "return/refund has no
  // control" says a control is missing, and these say WHICH page lost it.

  const has = (file: string, needle: string) =>
    readFileSync(file, 'utf8').includes(needle);

  it('a seller can inspect a return and refund it', () => {
    const page = join('src', 'pages', 'portal', 'seller', 'orders.astro');
    expect(has(page, 'return/inspect')).toBe(true);
    expect(has(page, 'return/refund')).toBe(true);
  });

  it('the federation can decide a dispute and post a refund a seller has not', () => {
    const page = join('src', 'pages', 'admin', 'marketplace', 'returns.astro');
    expect(has(page, 'dispute/decide')).toBe(true);
    expect(has(page, 'return/refund')).toBe(true);
  });

  it('a buyer can review what arrived and the shop that sent it', () => {
    const page = join('src', 'pages', 'my', 'orders.astro');
    expect(has(page, 'review/product')).toBe(true);
    expect(has(page, 'review/seller')).toBe(true);
  });

  it('the federation can moderate a review, and a seller can reply to a published one', () => {
    expect(has(join('src', 'pages', 'admin', 'marketplace', 'trust.astro'), 'review/moderate')).toBe(true);
    expect(has(join('src', 'pages', 'portal', 'seller', 'index.astro'), 'review/reply')).toBe(true);
  });

  it('a seller can correct stock downwards, not only receive it', () => {
    const page = join('src', 'pages', 'portal', 'seller', 'products.astro');
    expect(has(page, 'stock/receive')).toBe(true);
    expect(has(page, 'stock/adjust')).toBe(true);
    expect(has(page, 'stock/count')).toBe(true);
  });

  it('a seller can change a price and withdraw a variant', () => {
    const page = join('src', 'pages', 'portal', 'seller', 'products.astro');
    expect(has(page, 'variant/update')).toBe(true);
    expect(has(page, 'variant/discontinue')).toBe(true);
  });

  it('a quarantine can be applied AND lifted', () => {
    const page = join('src', 'pages', 'admin', 'marketplace', 'trust.astro');
    expect(has(page, 'listing/quarantine')).toBe(true);
    expect(has(page, 'listing/unquarantine')).toBe(true);
  });

  it('a seller can state a return window, without which every return is refused', () => {
    expect(has(join('src', 'pages', 'portal', 'seller', 'shipping.astro'), 'return-policy/set')).toBe(true);
  });

  it('an endorsement can be withdrawn as well as granted', () => {
    const page = join('src', 'pages', 'admin', 'marketplace', '[id].astro');
    expect(has(page, 'badge/grant')).toBe(true);
    expect(has(page, 'badge/revoke')).toBe(true);
  });

  it('the federation can cancel a seller order on a buyer’s behalf', () => {
    // cancelSellerOrder() accepts `by: 'buyer'` and requires FEDERATION
    // authority to use it — a buyer cannot cancel their own seller order. So a
    // buyer who rings the office was the only route, and the office had no
    // control: order/cancel existed and only a seller could reach it.
    expect(has(join('src', 'pages', 'admin', 'marketplace', 'orders.astro'), 'order/cancel')).toBe(true);
  });

  // ── THE STEP THE WHOLE CHAIN ENDS AT ──────────────────────────────────────
  //
  // /api/shop/pay asked the provider for a payment and returned its public
  // checkout parameters, and the page printed a sentence about them. There was
  // no window, no card form, and no way to hand over any money: a marketplace
  // order could be placed, its stock reserved and its commission frozen, and
  // the buyer could not pay. The chain ran the whole way to the gateway and
  // stopped one step short of it.
  it('the marketplace checkout OPENS the provider’s payment window', () => {
    const page = join('src', 'pages', 'shop', 'checkout.astro');
    expect(has(page, '/api/shop/pay')).toBe(true);
    expect(has(page, 'checkout.razorpay.com/v1/checkout.js')).toBe(true);
    expect(has(page, 'rzp.open()')).toBe(true);
  });

  it('and it does not claim the order is paid because the widget said so', () => {
    // Only confirmPayment(), from a signature-verified webhook or the reconcile
    // cron, marks an order paid. A page that told the buyer otherwise would be
    // asserting the outcome of something that has only been submitted.
    const page = readFileSync(join('src', 'pages', 'shop', 'checkout.astro'), 'utf8');
    expect(page).toMatch(/has been submitted/i);
    expect(page).toMatch(/not proof of payment/i);
  });

  it('the federation checkout has always opened it — the same handler, on the same terms', () => {
    // Named so the two cannot drift apart again without this failing.
    const page = join('src', 'pages', 'checkout.astro');
    expect(has(page, 'checkout.razorpay.com/v1/checkout.js')).toBe(true);
    expect(has(page, 'rzp.open()')).toBe(true);
  });
});
