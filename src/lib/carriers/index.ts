// Carrier registry.
//
// The third of three, after src/lib/payments/index.ts and
// src/lib/payouts/index.ts, and it keeps their discipline: the active provider
// is chosen by CONFIGURATION rather than by code, and where nothing automatic
// exists the software says so plainly instead of drawing a control that cannot
// work (§70).
//
// LIKE THE PAYOUT REGISTRY AND UNLIKE THE PAYMENT ONE, there is no "no provider
// at all" state. The manual adapter needs no credentials because its
// implementation is a seller at a post office counter, so `activeCarrier()`
// always returns something and a marketplace is never left unable to ship.
//
// What that must NOT become is a screen implying an integration. Every surface
// reads `automatic` from the report below and says which of the two it is.

import type { CarrierProvider, CarrierStatusReport } from './provider';
import { manualCarrier, manualCarrierReport, knownCarriers, CARRIER_INTEGRATION_NOT_SET } from './manual';

export * from './provider';
export { manualCarrier, knownCarriers, CARRIER_INTEGRATION_NOT_SET };

/**
 * Every provider, in preference order.
 *
 * ONE ENTRY TODAY, and the array is the point: adding a courier integration is
 * appending an adapter and a line here, not editing the pages that ship
 * parcels. When one arrives it goes ABOVE manual, so configuring its
 * credentials is the whole act of switching over — the property the payments
 * and payouts registries already have.
 */
const CARRIERS: CarrierProvider[] = [manualCarrier];

export function carrierById(id: string): CarrierProvider | null {
  return CARRIERS.find((c) => c.id === id) ?? null;
}

export function availableCarriers(): CarrierProvider[] {
  return CARRIERS.filter((c) => c.isConfigured());
}

/**
 * The provider a new consignment would use.
 *
 * CARRIER_PROVIDER pins one when set, which is how an integration is exercised
 * before it is switched on for everybody. A pin naming an unusable provider
 * resolves to the manual floor rather than to null — a parcel must always be
 * sendable — but the report says the pin was refused, because somebody who
 * pinned a courier and silently got a manual form would conclude the
 * integration was broken when the truth is that it was never selected.
 */
export function activeCarrier(): CarrierProvider {
  const pinned = String(import.meta.env?.CARRIER_PROVIDER ?? process.env.CARRIER_PROVIDER ?? '').trim();
  if (pinned) {
    const found = carrierById(pinned);
    if (found && found.isConfigured()) return found;
  }
  const usable = availableCarriers();
  return usable[0] ?? manualCarrier;
}

/** Whether the pin names a provider that cannot be used, for the report. */
function pinRefused(): string | null {
  const pinned = String(import.meta.env?.CARRIER_PROVIDER ?? process.env.CARRIER_PROVIDER ?? '').trim();
  if (!pinned) return null;
  const found = carrierById(pinned);
  if (!found) return `CARRIER_PROVIDER names "${pinned}", which is not a courier this deployment has an adapter for.`;
  if (!found.isConfigured()) return `CARRIER_PROVIDER names "${pinned}", which is not usable on this deployment, so consignments fall back to being booked by the seller.`;
  return null;
}

export function carrierStatusReport(): CarrierStatusReport {
  const active = activeCarrier();
  const refusal = pinRefused();
  const base = active.id === manualCarrier.id
    ? manualCarrierReport()
    : {
        id: active.id,
        label: active.label,
        automatic: active.canBook,
        linksTracking: true,
        summary: `Consignments are booked through ${active.label}.`,
      };
  return refusal ? { ...base, summary: `${refusal} ${base.summary}` } : base;
}

/**
 * A tracking page for a consignment, or null — THROUGH THE ACTIVE PROVIDER.
 *
 * The single function every surface calls, so that the rule "a tracking URL is
 * never invented" is kept in one place. A seller who pasted their own URL is
 * honoured first by the caller; this answers the case where they did not.
 */
export function trackingUrlFor(trackingNumber: string, carrier?: string | null): string | null {
  if (!trackingNumber) return null;
  return activeCarrier().trackingUrl(trackingNumber, carrier ?? null);
}
