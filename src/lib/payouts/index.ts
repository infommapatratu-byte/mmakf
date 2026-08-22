// Payout provider registry.
//
// The counterpart of src/lib/payments/index.ts, and the same discipline: the
// active provider is chosen by CONFIGURATION, not by code, and "no provider at
// all" is reported honestly rather than rendering a Send button that cannot
// work (§70).
//
// One difference from the payments registry, and it is deliberate. On the
// paying-in side there is a state with no provider at all — no gateway keys and
// no UPI id — and `activeProvider()` returns null for it. Here there is not:
// the manual adapter needs no credentials, because its implementation is a
// person with access to the federation's bank, so `activePayoutProvider()`
// always returns something. The federation is never left holding an approved
// settlement with no way to pay it.
//
// What that must NOT become is a screen implying an automatic transfer. Every
// surface reads `automatic` from the report below and says which of the two it
// is, because a payout queue that looks like it is running itself is a payout
// queue nobody works.

import type { PayoutProvider } from './provider';
import { razorpayxPayouts } from './razorpayx';
import { manualPayouts } from './manual';

export * from './provider';
export { razorpayxPayouts, manualPayouts };
export {
  razorpayxCapability, mapPayoutStatus,
  RAZORPAYX_NOT_VERIFIED, RAZORPAYX_ENV,
  RAZORPAYX_SIGNATURE_HEADER, RAZORPAYX_EVENT_ID_HEADER,
  PAYOUT_PURPOSE_NOT_SET,
} from './razorpayx';
export type { RazorpayXCapability } from './razorpayx';
export {
  PAYOUT_APPROVAL_SEPARATION_NOT_SET, PAYOUT_RAIL_NOT_SET,
} from './manual';

/**
 * Every provider, in preference order.
 *
 * RazorpayX first so that the day it is verified, setting its credentials is
 * the entire act of switching over — the same property `activeProvider()` has
 * on the payments side, where adding Razorpay credentials is going live.
 * Manual is last and is the floor: it is always configured, so it is always
 * what is left when nothing above it qualifies.
 */
const PAYOUT_PROVIDERS: PayoutProvider[] = [razorpayxPayouts, manualPayouts];

export function payoutProviderById(id: string): PayoutProvider | null {
  return PAYOUT_PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * Whether a provider's credentials are present — which is NOT the same as being
 * usable, and must never be substituted for isConfigured() when choosing one.
 *
 * A provider that does not draw the distinction answers both with
 * isConfigured(), and for such a provider the two genuinely are one question.
 * RazorpayX is the case that makes the distinction load-bearing: it can have
 * perfect credentials and still be unusable, and telling an operator "no
 * credentials" would send them to re-enter values that are already right.
 */
export function payoutProviderHasCredentials(provider: PayoutProvider): boolean {
  return provider.hasCredentials ? provider.hasCredentials() : provider.isConfigured();
}

/** Providers that may actually send money right now. */
export function availablePayoutProviders(): PayoutProvider[] {
  return PAYOUT_PROVIDERS.filter((p) => p.isConfigured());
}

/**
 * The provider to use for a new payout.
 *
 * PAYOUT_PROVIDER pins a specific one when set — useful for exercising a
 * provider before switching over. A pin that names an unusable provider
 * resolves to NULL rather than silently falling through to manual: somebody who
 * pinned RazorpayX and got a manual instruction would conclude the pin worked
 * and the provider was broken, when the truth is that the pin was refused.
 *
 * Unpinned, the first provider that reports itself usable wins, which today and
 * until RazorpayX is verified means the manual adapter every time.
 */
export function activePayoutProvider(): PayoutProvider | null {
  const pinned = (process.env.PAYOUT_PROVIDER || '').trim();
  if (pinned) {
    const p = payoutProviderById(pinned);
    return p && p.isConfigured() ? p : null;
  }
  return availablePayoutProviders()[0] ?? null;
}

/**
 * For surfaces that must state plainly how a seller is going to be paid.
 *
 * `automatic` is the field that matters and it is the reason this function
 * exists rather than callers reading `activePayoutProvider()?.id` and deciding
 * for themselves. False means a person has to go and make the transfer, and a
 * screen that does not say so is telling a seller their money is moving when it
 * is waiting on somebody's Monday.
 *
 * `note` carries the reason a better provider is not being used, when there is
 * one — so an admin screen can show "payouts are manual BECAUSE the RazorpayX
 * adapter is unverified" rather than leaving an operator to work out why the
 * credentials they set are doing nothing.
 */
export function payoutStatusReport(): {
  ready: boolean;
  provider: string | null;
  label: string | null;
  automatic: boolean;
  note: string | null;
  /** Providers holding credentials but not usable, with the reason for each. */
  withheld: Array<{ provider: string; label: string; reason: string | null }>;
} {
  const active = activePayoutProvider();
  const withheld = PAYOUT_PROVIDERS
    .filter((p) => !p.isConfigured() && payoutProviderHasCredentials(p))
    .map((p) => ({
      provider: p.id,
      label: p.label,
      reason: p.readinessNote ? p.readinessNote() : null,
    }));

  return {
    ready: Boolean(active),
    provider: active?.id ?? null,
    label: active?.label ?? null,
    automatic: Boolean(active?.automatic),
    // The active provider's own note first — a manual provider has none, so
    // the useful sentence is the one explaining what is being held back.
    note: (active?.readinessNote ? active.readinessNote() : null) ?? withheld[0]?.reason ?? null,
    withheld,
  };
}
