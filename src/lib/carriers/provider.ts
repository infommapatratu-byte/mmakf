// Carrier abstraction — a parcel leaving a seller for a buyer.
//
// The third member of the family that already holds src/lib/payments/provider.ts
// (money coming in) and src/lib/payouts/provider.ts (money going out), and it
// exists for the reason the brief gives: "Do not hard-code one courier. Create
// a provider interface so courier integrations can be added later."
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT WAS HERE BEFORE, AND WHY IT NEEDED AN INTERFACE AT ALL
// ═════════════════════════════════════════════════════════════════════════════
//
// `shipments.carrier` and `shipments.tracking_number` are free text a seller
// types, and `shipments.tracking_url` is a third free-text field. That is not
// hard-coded to one courier — but it does mean the tracking LINK is whatever a
// seller pasted, and a seller who pastes nothing leaves the buyer with a number
// they must go and look up somewhere themselves.
//
// The temptation, and the reason this file exists rather than a helper, is to
// write `https://www.indiapost.gov.in/...${number}` inline in the one place
// that needs it. That is how a codebase acquires a courier: not by a decision,
// but by a template literal in a page, which the next courier then has to be
// special-cased around.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE RULE THIS INTERFACE ENFORCES ABOVE ALL OTHERS
// ═════════════════════════════════════════════════════════════════════════════
//
// A TRACKING URL IS NEVER INVENTED.
//
// `trackingUrl()` returns null unless the adapter KNOWS the pattern for that
// carrier, and the null is what the surfaces already render honestly: "sent
// without a tracking number, so there is nothing to follow." A guessed URL is
// strictly worse than none, because the buyer believes it, follows it, meets a
// 404 at a courier's site, and concludes their parcel is lost.
//
// The same rule governs every other method here. An adapter that cannot answer
// says so; nothing in this file has a plausible default.
//
// ═════════════════════════════════════════════════════════════════════════════
// AND WHAT AN ADAPTER MAY NOT DECIDE
// ═════════════════════════════════════════════════════════════════════════════
//
// THAT A PARCEL WAS DELIVERED. `markDelivered()` in src/db/seller-orders.ts is
// the only thing that closes a seller order, it is an act by a person, and it
// accrues the seller's settlement. A carrier adapter reporting `delivered` from
// a scan is reporting a CARRIER'S CLAIM — which is evidence, and is returned
// here as a tracking event for a human to act on, and is not itself the
// federation's record that goods arrived.
//
// THAT A LABEL IS A DISPATCH. `book()` returns a consignment reference and,
// where the carrier gives one, a label. `shipment_status` distinguishes
// 'label_created' from 'dispatched' precisely because a label sitting on a desk
// is not a parcel in a van, and src/lib/status.ts already says so in words.

/** The states `shipments.status` can hold, named so an adapter need not import the schema. */
export type CarrierShipmentStatus =
  | 'created'
  | 'label_created'
  | 'dispatched'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'failed'
  | 'returned'
  | 'cancelled';

/** Where a parcel is going. The same shape src/db/shipping.ts prices against. */
export interface CarrierAddress {
  name?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  district?: string | null;
  state?: string | null;
  postcode?: string | null;
  country?: string | null;
  phone?: string | null;
}

export interface CarrierParcel {
  /** Integer grams. A parcel with no recorded weight is `null`, never zero. */
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  packageCount?: number;
  /**
   * INTEGER MINOR UNITS, for a carrier that insures or collects on delivery.
   * Money is paise everywhere in this codebase and this interface is not the
   * place a float creeps in.
   */
  declaredValueMinor?: number | null;
}

export interface BookShipmentInput {
  /** The federation's own consignment reference — `shipments.ref`. */
  reference: string;
  from: CarrierAddress;
  to: CarrierAddress;
  parcel: CarrierParcel;
  /** The carrier's own service name, where the seller chose one. */
  service?: string | null;
  /**
   * REQUIRED, and for the reason payouts require one: a retried booking that
   * reaches the carrier twice produces two consignments, two labels and two
   * collections, and the second cannot be recalled by a status change.
   */
  idempotencyKey: string;
}

export interface BookedShipment {
  /** The carrier's own consignment number — what goes in `tracking_number`. */
  trackingNumber: string;
  /** Null when the carrier publishes no page for it. NEVER a guess. */
  trackingUrl: string | null;
  /** A label to print, where the carrier returns one. */
  labelUrl?: string | null;
  /** The carrier's name as it should be recorded, e.g. 'India Post'. */
  carrier: string;
  service?: string | null;
  /**
   * The carrier's own estimate, where it gives one, as an ISO date.
   *
   * AN ESTIMATE AND SAID TO BE ONE. src/lib/status.ts is explicit that carrier
   * dates are never shown to a buyer as a promise, and nothing downstream turns
   * this into a delivery commitment.
   */
  expectedBy?: string | null;
}

/** One scan, as the carrier reported it. Evidence, never a decision. */
export interface TrackingEvent {
  at: string;
  status: CarrierShipmentStatus;
  /** The carrier's own words. Not translated, not interpreted. */
  description?: string | null;
  location?: string | null;
}

export interface TrackingReport {
  trackingNumber: string;
  /** The carrier's view. The federation's record is `shipments.status`. */
  status: CarrierShipmentStatus;
  events: TrackingEvent[];
  /** Present only where the carrier says so. */
  deliveredAt?: string | null;
  deliveredTo?: string | null;
}

export class CarrierError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CarrierError';
    this.code = code;
  }
}

/** Identity by shape, as elsewhere in this codebase — see calendar.ts. */
export function isCarrierError(err: unknown): err is CarrierError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'CarrierError';
}

export interface CarrierProvider {
  /** Stable id, stored in `shipments.carrier` where a provider booked it. */
  readonly id: string;
  /** What a human should see: 'India Post', 'Booked by the seller'. */
  readonly label: string;

  /**
   * USABLE END TO END, right now — not "has credentials".
   *
   * The distinction is the one src/lib/payouts/index.ts draws and for the same
   * reason: an adapter with perfect keys that cannot reach the carrier must
   * answer false here and true to hasCredentials(), so an operator is sent to
   * the right screen.
   */
  isConfigured(): boolean;
  hasCredentials?(): boolean;

  /**
   * Whether this provider can BOOK a consignment, as opposed to merely
   * recording one somebody else booked.
   *
   * Reported rather than inferred from the presence of `book`, because a
   * surface has to be able to say which of the two it is offering. A "Book
   * collection" button that turns out to write a row is worse than a form.
   */
  readonly canBook: boolean;

  /**
   * A tracking page for a consignment, or NULL.
   *
   * Null is the ordinary answer for a carrier whose pattern this deployment
   * does not know, and every surface renders it as "no tracking to follow".
   * AN ADAPTER MUST NOT GUESS. See the rule at the top of this file.
   */
  trackingUrl(trackingNumber: string, carrier?: string | null): string | null;

  /** Absent on a provider that cannot book — see `canBook`. */
  book?(input: BookShipmentInput): Promise<BookedShipment>;

  /** Absent where the carrier publishes no machine-readable tracking. */
  track?(trackingNumber: string): Promise<TrackingReport>;

  /**
   * Cancel a booking that has not been collected.
   *
   * Optional because most carriers do not offer it, and an adapter that
   * pretended to would leave a collection scheduled against a cancelled order.
   */
  cancel?(trackingNumber: string, reason: string): Promise<void>;
}

/** What a surface needs in order to describe the position honestly. */
export interface CarrierStatusReport {
  /** The provider that would be used, or null when none is usable. */
  id: string | null;
  label: string | null;
  /** True only where a consignment can actually be booked from the software. */
  automatic: boolean;
  /** True where a tracking link can be produced for at least one carrier. */
  linksTracking: boolean;
  /** The sentence a surface prints. Never "not configured" on its own. */
  summary: string;
}
