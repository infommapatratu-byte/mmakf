// The carrier the federation actually has: a seller, a counter and a receipt.
//
// ═════════════════════════════════════════════════════════════════════════════
// THIS IS NOT A STUB
// ═════════════════════════════════════════════════════════════════════════════
//
// It is how every parcel on this marketplace is sent today, and it will remain
// how most of them are sent: a seller walks to a post office, hands over a
// parcel, and types the consignment number into /portal/seller/orders. There is
// no integration to wait for, and nothing here is pending.
//
// What it adds over the free-text fields it wraps is the ONE thing a seller
// cannot do from a counter: turn a consignment number into a link the buyer can
// follow. `shipments.tracking_url` is a third free-text field, and a seller who
// leaves it blank — which is almost all of them — leaves the buyer holding a
// number and no idea where to type it.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHERE THE PATTERNS COME FROM, AND WHY THERE ARE SO FEW
// ═════════════════════════════════════════════════════════════════════════════
//
// Each is a carrier's own PUBLIC consignment-tracking page, and the list is
// short on purpose. A pattern that is wrong sends a buyer to a 404 at a
// courier's site and teaches them the parcel is lost, which is worse than
// giving them the number and letting them look it up. So a carrier goes in this
// table only when its public URL is stable and its form takes the consignment
// number as a query parameter — and everything else answers null, honestly.
//
// MATCHED LOOSELY ON THE NAME, because the field is free text a seller typed:
// "India Post", "india post", "INDIAPOST" and "Speed Post (India Post)" are all
// the same courier to everybody except a string comparison. Matching is on the
// letters alone, so punctuation and spacing cannot defeat it.
//
// AND NO GUESSING BEYOND THE TABLE. An unknown carrier is unknown. This file
// contains no fallback that builds a Google search URL, or a "tracking101"
// aggregator link, or anything else that would put the federation's name behind
// a page it does not control.

import type {
  CarrierProvider, CarrierStatusReport,
} from './provider';

/**
 * Carrier name → a function producing its public tracking URL.
 *
 * The key is the carrier's name reduced to lowercase letters and digits. The
 * value takes an ALREADY-VALIDATED consignment number.
 */
const TRACKING_PATTERNS: ReadonlyArray<{
  /** Substrings of the normalised name that identify this carrier. */
  match: readonly string[];
  label: string;
  url: (n: string) => string;
}> = [
  {
    match: ['indiapost', 'speedpost', 'departmentofposts'],
    label: 'India Post',
    url: (n) => `https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx?logisticsId=${encodeURIComponent(n)}`,
  },
  {
    match: ['bluedart'],
    label: 'Blue Dart',
    url: (n) => `https://www.bluedart.com/tracking?trackingNumber=${encodeURIComponent(n)}`,
  },
  {
    match: ['delhivery'],
    label: 'Delhivery',
    url: (n) => `https://www.delhivery.com/track/package/${encodeURIComponent(n)}`,
  },
  {
    match: ['dtdc'],
    label: 'DTDC',
    url: (n) => `https://www.dtdc.in/tracking.asp?strCnno=${encodeURIComponent(n)}`,
  },
  {
    match: ['ekart'],
    label: 'Ekart',
    url: (n) => `https://ekartlogistics.com/shipmenttrack/${encodeURIComponent(n)}`,
  },
  {
    match: ['xpressbees'],
    label: 'XpressBees',
    url: (n) => `https://www.xpressbees.com/shipment/tracking?awb=${encodeURIComponent(n)}`,
  },
];

/** Letters and digits only — the field is free text somebody typed. */
function normalise(name: string): string {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * A consignment number that could safely go in a URL.
 *
 * Carriers use letters, digits and occasionally a hyphen. Anything else is not
 * a consignment number — it is a paste accident or an injection attempt — and
 * refusing it here means the link is never built from it. The encodeURIComponent
 * above is belt and braces; this is the belt.
 */
function usableNumber(trackingNumber: string): string | null {
  const n = String(trackingNumber ?? '').trim();
  if (!/^[A-Za-z0-9-]{4,40}$/.test(n)) return null;
  return n;
}

/** The carriers this deployment can build a link for, for a surface to list. */
export function knownCarriers(): string[] {
  return TRACKING_PATTERNS.map((p) => p.label);
}

export const CARRIER_INTEGRATION_NOT_SET =
  'MMAKF has not integrated a courier account, so consignments are booked by the seller at the ' +
  'counter and the number is recorded here. That is a complete way to send a parcel, not a ' +
  'degraded one — what an integration would add is booking and automatic scans, neither of which ' +
  'the federation has asked for.';

export const manualCarrier: CarrierProvider = {
  id: 'manual',
  label: 'Booked by the seller',

  // ALWAYS TRUE, and it is the floor of the registry for the same reason the
  // manual payout adapter is: its implementation is a person, so there are no
  // credentials to be missing. A marketplace is never left unable to ship.
  isConfigured: () => true,

  // It cannot book. Reported rather than left to be discovered by a surface
  // that drew a "Book collection" button and got a form.
  canBook: false,

  trackingUrl(trackingNumber: string, carrier?: string | null): string | null {
    const n = usableNumber(trackingNumber);
    if (!n) return null;
    const key = normalise(carrier ?? '');
    if (!key) return null;
    const hit = TRACKING_PATTERNS.find((p) => p.match.some((m) => key.includes(m)));
    // NULL, NOT A GUESS. An unknown courier is unknown, and the surfaces
    // already render that as "no tracking to follow".
    return hit ? hit.url(n) : null;
  },
};

export function manualCarrierReport(): CarrierStatusReport {
  return {
    id: manualCarrier.id,
    label: manualCarrier.label,
    automatic: false,
    linksTracking: true,
    summary: CARRIER_INTEGRATION_NOT_SET,
  };
}
