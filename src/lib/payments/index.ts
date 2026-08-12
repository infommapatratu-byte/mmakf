// Provider registry.
//
// The active provider is chosen by configuration, not by code. A gateway with
// credentials is preferred; manual UPI is the fallback so the federation can
// always take money, and "no provider at all" is reported honestly rather than
// rendering a Pay button that cannot work (§70).

import type { PaymentProvider } from './provider';
import { razorpay } from './razorpay';
import { manualUpi } from './manual-upi';

export * from './provider';
export { razorpay, manualUpi };
export { upiDeepLink } from './manual-upi';

/** Every provider, in preference order. */
const PROVIDERS: PaymentProvider[] = [razorpay, manualUpi];

export function providerById(id: string): PaymentProvider | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

/** Providers that actually have credentials right now. */
export function availableProviders(): PaymentProvider[] {
  return PROVIDERS.filter((p) => p.isConfigured());
}

/**
 * The provider to use for a new order.
 *
 * PAYMENT_PROVIDER pins a specific one when set — useful for testing a gateway
 * before switching over. Otherwise the first configured provider wins, which
 * means adding Razorpay credentials is the entire act of going live.
 */
export function activeProvider(): PaymentProvider | null {
  const pinned = process.env.PAYMENT_PROVIDER;
  if (pinned) {
    const p = providerById(pinned);
    return p && p.isConfigured() ? p : null;
  }
  return availableProviders()[0] ?? null;
}

/** For surfaces that must state plainly whether payment is possible. */
export function paymentStatusReport(): {
  ready: boolean;
  provider: string | null;
  label: string | null;
  automatic: boolean;
} {
  const p = activeProvider();
  return {
    ready: Boolean(p),
    provider: p?.id ?? null,
    label: p?.label ?? null,
    // False for manual UPI: confirmation needs a human, and any surface that
    // implies instant confirmation would be lying to the payer.
    automatic: Boolean(p && p.id !== 'manual_upi'),
  };
}
