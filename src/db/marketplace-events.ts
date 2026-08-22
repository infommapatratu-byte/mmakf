// The marketplace's producer layer for the domain-event feed.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS MODULE EXISTS TO CLOSE
// ═════════════════════════════════════════════════════════════════════════════
//
// Migration 0029 shipped fifty-four tables and every one of the acts that
// happen on them — a basket splitting into seller orders, a dispatch, a return,
// a refund, a payout — and NOT ONE OF THEM APPENDED ANYTHING TO THE FEED.
//
// That is the same shape of defect as the one src/db/shipping.ts was written to
// close: nothing errored, no test failed, and the cost fell on somebody outside
// the building. A buyer whose parcel was dispatched was never told. A seller
// whose money cleared was never told. The federation's own officers learned
// about a fraud signal by opening a queue nobody had a reason to open.
//
// This file is the ONE place a marketplace fact becomes an event. It holds no
// state machine, decides no permission and writes no table of its own; every
// function here reads the row the acting module has already written and appends
// the corresponding fact to `domain_events`.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE THREE PROPERTIES EVERY FUNCTION BELOW IS BUILT AROUND
// ═════════════════════════════════════════════════════════════════════════════
//
// 1. THE PAYLOAD CARRIES IDENTIFIERS AND NOTHING ELSE.
//
//    Not a buyer's address, not their telephone number, not their email, not a
//    seller's bank account, not a review's text, not a fraud detector's free
//    prose, not a refund's amount. `domain_events` has no state, district or
//    dojo column, so scope CANNOT be applied to it row by row — classification
//    is the only filter a read passes through (see `clearanceFor()`). An event
//    that must reach its own subject therefore has to sit at 'member', and
//    'member' is `canAnywhere(p, 'content:read')`, which is a lot of people.
//
//    So the rule is not "classify it high enough to be safe". It is: PUT
//    NOTHING ON THE FEED THAT WOULD NEED A HIGH CLASSIFICATION. The fact
//    travels; the substance stays in the row, behind the surface that is gated
//    on being the person it is about. That is the same discipline
//    CERTIFICATE_REVOKED applies to its reason and `describe()` in
//    src/lib/notifications.ts applies to a grading result.
//
//    What breaks if somebody "simplifies" this by spreading the row onto the
//    payload: a seller order carries `shipTo`, `buyerPhone` and `buyerEmail`,
//    and `...sellerOrder` would put a named buyer's home address on a feed that
//    every content:read holder in the federation can read, for ever, with no
//    delete path. There is no update path on this feed and no delete path. A
//    payload mistake here is not a bug that gets fixed — it is a disclosure
//    that gets appended.
//
// 2. THE CORRELATION ID IS DERIVED FROM THE ENTITY, NEVER FROM THE CLOCK.
//
//    `entityType:id:verb` — `seller_order:1183:shipped`. A gateway retries its
//    webhooks and src/pages/api/cron/reconcile.ts retries them again; a
//    correlation id containing `Date.now()` would be a different key every time
//    and every retry would put a second notification in a real person's inbox.
//    Derived from the row, the second publish returns `duplicate: true` and
//    appends nothing.
//
//    And it is deliberately NOT idempotent in the "quietly accept anything"
//    sense: `publish()` refuses a republish under the same key carrying a
//    DIFFERENT payload, with `correlation_conflict`. That is why no payload
//    below carries a figure that can move between two publishes of one fact —
//    a running total, a stock level, a refunded-to-date. A payload that changes
//    under a stable key turns every retry into an exception.
//
// 3. AN UNRESOLVABLE RECIPIENT PUBLISHES NOTHING.
//
//    `resolveRecipients('subject')` in src/lib/notifications.ts ends with
//    `Number(event.payload?.personId ?? event.entityId)`. For a marketplace
//    event the entity id is a SELLER ORDER id, and a seller order id is a
//    perfectly valid person id belonging to somebody with no connection to the
//    purchase whatever. The MEMBERSHIP_EXPIRING note in
//    src/lib/domain-events.ts describes exactly this hazard and says its sweep
//    publishes nothing for an entitlement it cannot resolve a person for.
//
//    This module obeys that twice over. Every buyer- or seller-addressed
//    producer RESOLVES THE RECIPIENT FIRST, from the database, and returns
//    `published: false` with a stated reason when there is nobody to address —
//    a guest checkout with no person record, a seller account held by a shared
//    office credential. And none of the notification entries this module
//    proposes uses the 'subject' audience, so even a future producer bug cannot
//    reach the entity-id fallback.
//
//    Losing the feed row is the lesser harm and is nearly no harm at all: the
//    order, `seller_order_events` and the audit trail all still record what
//    happened. What is avoided is a notice about somebody else's purchase
//    landing in a stranger's inbox, which is not recoverable by any means.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS MODULE DOES NOT DO, AND WHY THAT IS NOT AN OMISSION
// ═════════════════════════════════════════════════════════════════════════════
//
// IT DOES NOT EDIT THE CATALOGUE. `publish()` refuses an event type that is not
// in `EVENT_TYPES`, so every type below must be added to
// src/lib/domain-events.ts before any of these functions can run.
// `MARKETPLACE_EVENT_TYPES` holds those entries VERBATIM so the wiring is a
// copy rather than a re-derivation, and `marketplaceCatalogueGaps()` compares
// the two so that a drift between this module and the catalogue is a failing
// test rather than an event whose floor quietly changed.
//
// IT DOES NOT WRITE NOTIFICATIONS. `notifyForEvent()` does, from the feed,
// which is what stops a fact being announced twice by two routes.
// `MARKETPLACE_NOTIFIABLE` holds the allow-list entries this module's events
// need, on the same "copy, do not re-derive" terms.
//
// IT DOES NOT AUDIT. Appending to the feed is not a privileged mutation — the
// mutation happened in the module that called us and was audited there. A
// second audit row per event would double the trail and make it read as though
// two things had been decided.

import { eq, sql } from 'drizzle-orm';
import * as s from '@/db/schema';
import {
  publish, EVENT_TYPES, type Classification, type EventTypeSpec,
} from '@/lib/domain-events';
import { isNotifiable } from '@/lib/notifications';
import { MarketplaceError } from '@/db/marketplace';
import { lowStock } from '@/db/inventory';
import type { Principal } from '@/lib/rbac';

type DB = any;

// ─── What is withheld, and why, in the federation's own words ───────────────

export const NO_BUYER_PERSON_RECORD =
  'This purchase has no person record behind it — a guest checkout identified ' +
  'only by an email address. Nothing was published to the feed, because the ' +
  'notification consumer resolves a recipient from an id and there is no id ' +
  'here that means this buyer. A notice addressed to whoever happens to share ' +
  'the number would reach a stranger.';

export const NO_SELLER_PERSON_RECORD =
  'This seller account is not attached to a person record — a shared office ' +
  'credential holds it. Nothing was published, for the same reason a guest ' +
  'checkout publishes nothing: there is nobody on the register to address.';

export const NOT_A_MARKETPLACE_ORDER =
  'That order has no seller orders on it, so it is not a marketplace basket — ' +
  'a fee, an entry or a membership went through the same payment path. ' +
  'Nothing was published to the marketplace feed for it.';

export const LOW_STOCK_RULE_NOT_SET =
  'This seller has published no low-stock threshold, so there is no level at ' +
  'which anything is low. Nothing is assumed on their behalf: five units is ' +
  'critical for a dojo and irrelevant for a manufacturer, and a threshold ' +
  'chosen here would send one of them several hundred notices on the day it ' +
  'shipped. Set one in the portal and the notice begins.';

export const LOW_STOCK_CADENCE_NOT_SET =
  'How often MMAKF, or a seller, wants to be told that stock is low is not set ' +
  'anywhere. So the producer takes the notice key as an argument and refuses to ' +
  'run without one rather than choosing a cadence — the same discipline ' +
  'raiseRenewalNotices() applies to the renewal window it will not default.';

export const POLICY_BROADCAST_NOT_DECIDED =
  'Whether publishing a marketplace policy writes to every seller on the ' +
  'platform is a decision MMAKF has not made. It is a circular — an act with ' +
  'its own approval path — not a side effect of an officer saving a form, so ' +
  'MARKETPLACE_POLICY_PUBLISHED goes onto the feed as the record and names no ' +
  'notification consumer. The seller portal already lists a policy they have ' +
  'not accepted, through outstandingAcceptances().';

export const ADMIN_NOTICES_NOT_WIRED =
  'The federation-facing marketplace events are classified above "member", and ' +
  'the only consumer draining this feed — the notifications pass in ' +
  'src/pages/api/cron/reconcile.ts — is capped at "member" and steps over ' +
  'anything higher. Declaring a notification consumer on them without also ' +
  'raising that cap or adding a second pass would produce an allow-list entry ' +
  'that can never fire, which is the exact defect the retired SCHEDULE_CHANGED ' +
  'entry was removed for. They are on the feed as the record; the officers read ' +
  'them through the marketplace queues until the second pass exists.';

// ─── The catalogue entries these producers need ─────────────────────────────

/**
 * The `EVENT_TYPES` entries for every marketplace event, VERBATIM.
 *
 * Held here so adding them to src/lib/domain-events.ts is a copy and not a
 * re-derivation, and so `marketplaceCatalogueGaps()` can prove the copy did not
 * drift. A floor lowered by half a step in one of the two files and not the
 * other is a disclosure nobody would find by reading either file alone.
 *
 * ─── HOW THE FLOORS WERE CHOSEN ────────────────────────────────────────────
 *
 * 'member' for everything a buyer or a seller is told about their own
 * transaction, and NOT because it is harmless — because the notifications
 * consumer is capped at 'member', so an event above it can never reach the
 * person it is about. That is a hard constraint, and the honest way to meet it
 * is to make the payload small enough to deserve the floor rather than to
 * classify a fat payload low. Every 'member' entry below therefore carries ids
 * and nothing a person could be harmed by.
 *
 * 'official' where the fact is the federation's business and names a business:
 * an application, a report about a shop.
 *
 * 'confidential' where money or an allegation is involved, matching the money
 * section of the catalogue — 'an order names a person and an amount'.
 *
 * EVERY ENTRY DECLARES `publicFields: []`, and that is a decision rather than a
 * blank. There is no public form of a purchase, a return, a payout or a fraud
 * signal; MMAKF has published no editorial policy that would create one; and an
 * allowlist on any of these is a leak waiting for the first producer who adds a
 * field. Whether the federation advertises its published marketplace policies
 * on a public page is a real editorial question, and the answer to it is a
 * public POLICY REGISTER — not a public projection of an event that also names
 * the officer who pressed publish.
 */
export const MARKETPLACE_EVENT_TYPES = {
  // ── What the BUYER is told ────────────────────────────────────────────────
  //
  // Every one carries `buyerPersonId`, and the audience proposed for them is
  // 'buyer', which resolves from THAT KEY ONLY. It never falls back to the
  // entity id, because the entity id here is an order or a seller order and a
  // notice addressed by it would reach whoever holds that number in `persons`.

  MARKETPLACE_ORDER_PLACED: {
    floor: 'member', publicFields: [],
    payload: ['orderId', 'orderNo', 'buyerPersonId', 'sellerOrderCount'],
    consumers: ['notifications'],
    means: 'A marketplace basket was placed and split into one seller order per seller.',
  },
  // NOT a reuse of the existing ORDER_PAID, which is 'confidential' and
  // therefore unreachable by the member-capped notifications consumer, and
  // which fires for fees, entries and memberships as well. A consumer counting
  // marketplace payments must not be handed a grading fee.
  MARKETPLACE_ORDER_PAID: {
    floor: 'member', publicFields: [],
    payload: ['orderId', 'orderNo', 'buyerPersonId'],
    consumers: ['notifications'],
    means: 'A marketplace basket was paid for against a verified capture.',
  },
  // `trackingRecorded` is a BOOLEAN and never the tracking number itself. "Do
  // not fake tracking" — the brief — and a consignment with no tracking is
  // displayed as one; the flag is what lets the notice say "with tracking" or
  // stay silent about it, without the number travelling to a feed reader who
  // could use it to watch somebody's parcel.
  MARKETPLACE_ORDER_SHIPPED: {
    floor: 'member', publicFields: [],
    payload: ['sellerOrderId', 'sellerOrderNo', 'orderId', 'buyerPersonId', 'trackingRecorded'],
    consumers: ['notifications'],
    means: 'A seller dispatched their part of a marketplace basket.',
  },
  MARKETPLACE_ORDER_DELIVERED: {
    floor: 'member', publicFields: [],
    payload: ['sellerOrderId', 'sellerOrderNo', 'orderId', 'buyerPersonId'],
    consumers: ['notifications'],
    means: 'A dispatched consignment was recorded as delivered.',
  },
  // The buyer's side of a return is the DECISION — they made the request
  // themselves and do not need telling that they did. `outcome` is on the
  // payload because "authorised, here is your RMA" and "refused" are different
  // sentences and a consumer must not have to open a row to find out which.
  // The seller's REASON is not on the payload: it is free text written about a
  // buyer, and no allowlist can bound what a person typed into a text box.
  MARKETPLACE_RETURN_DECIDED: {
    floor: 'member', publicFields: [],
    payload: ['returnRequestId', 'returnRef', 'sellerOrderId', 'buyerPersonId', 'outcome'],
    consumers: ['notifications'],
    means: 'A seller decided a buyer’s return request; the reason stays on the record.',
  },
  // NO AMOUNT. A refund figure on a 'member'-floor event would put what a named
  // person was repaid in front of every content:read holder, and the buyer
  // reads the figure on their own order page where it belongs. This is also
  // what keeps the payload stable under a retried publish: a running refunded
  // total moves, an id does not.
  MARKETPLACE_REFUND_ISSUED: {
    floor: 'member', publicFields: [],
    payload: ['returnRequestId', 'returnRef', 'sellerOrderId', 'buyerPersonId'],
    consumers: ['notifications'],
    means: 'A refund was issued to a buyer against a return. The amount is not on the feed.',
  },

  // ── What the SELLER is told ───────────────────────────────────────────────
  //
  // NONE of these carries `buyerPersonId`, and that is the whole reason they
  // are separate types rather than the buyer events with two audiences. A
  // seller event addressed to the seller must not put the buyer's identity on
  // the feed as a side effect of telling a shop it has an order.

  MARKETPLACE_SELLER_ORDER_PLACED: {
    floor: 'member', publicFields: [],
    payload: ['sellerOrderId', 'sellerOrderNo', 'sellerId'],
    consumers: ['notifications'],
    means: 'A seller received a new order to fulfil.',
  },
  // `dispatchByIso` is NULL whenever MMAKF has published no SLA, and it is on
  // the payload precisely so the null travels. A seller order with no deadline
  // is not late for anything; a notice that invented "dispatch within 48 hours"
  // would be quoting the federation on a window it never published.
  MARKETPLACE_SELLER_ORDER_PAID: {
    floor: 'member', publicFields: [],
    payload: ['sellerOrderId', 'sellerOrderNo', 'sellerId', 'dispatchByIso'],
    consumers: ['notifications'],
    means: 'Payment cleared on a seller order; the dispatch clock, where one exists, started.',
  },
  MARKETPLACE_SELLER_RETURN_REQUESTED: {
    floor: 'member', publicFields: [],
    payload: ['returnRequestId', 'returnRef', 'sellerId', 'sellerOrderId', 'respondByIso'],
    consumers: ['notifications'],
    means: 'A buyer asked to return goods and the seller has to decide.',
  },
  // The seller's half of a refund: money has come out of what they are owed.
  // Again no amount — their settlement statement is the record of the figure,
  // and it is the only place the figure cannot be read by somebody else.
  MARKETPLACE_SELLER_REFUND_POSTED: {
    floor: 'member', publicFields: [],
    payload: ['returnRequestId', 'sellerId', 'sellerOrderId'],
    consumers: ['notifications'],
    means: 'A refund was posted against a seller’s account. The figure stays on the settlement.',
  },
  // PUBLISHED, not submitted. Reviews arrive `pending` and are moderated before
  // publication, so a notice on submission would tell a seller about a review
  // the public cannot see and which may never be published — and the first
  // thing they would do is reply to it.
  //
  // NEITHER THE RATING NOR THE TEXT IS ON THE PAYLOAD. They are a buyer's words
  // about a named shop; they belong on the seller's own review page, not on a
  // feed. A one-star rating on the feed is also a payload that would tempt the
  // next author into putting the body beside it.
  MARKETPLACE_SELLER_REVIEW_PUBLISHED: {
    floor: 'member', publicFields: [],
    payload: ['reviewId', 'reviewKind', 'sellerId'],
    consumers: ['notifications'],
    means: 'A moderated review of a seller or of their product was published.',
  },
  // NO QUANTITY AND NO THRESHOLD. What a shop has left is commercially
  // sensitive and 'member' is a wide readership; the seller sees the number in
  // their own stock page. The notice exists to send them there.
  MARKETPLACE_SELLER_LOW_STOCK: {
    floor: 'member', publicFields: [],
    payload: ['variantId', 'sellerId', 'noticeKey'],
    consumers: ['notifications'],
    means: 'A variant fell to or below a threshold the seller themselves published.',
  },
  // WHICH check and WHAT the outcome was are deliberately absent from the
  // payload. "MMAKF rejected this shop's PAN" is a fact about a business that
  // every content:read holder would otherwise be able to read off the feed, and
  // 'member' is the floor this event must sit at for its own subject's notice
  // to be deliverable at all. So the FACT travels and the SUBSTANCE does not,
  // exactly as CERTIFICATE_REVOKED keeps its reason off the feed. The seller
  // reads the decision in their portal, which is gated on being them.
  //
  // The correlation id does name the check, because the same seller can have
  // six verifications decided on one afternoon and each is its own fact needing
  // its own key. A check NAME without an outcome is a far weaker disclosure
  // than the pair, and a correlation id is projected nowhere.
  MARKETPLACE_SELLER_VERIFICATION_DECIDED: {
    floor: 'member', publicFields: [],
    payload: ['sellerId'],
    consumers: ['notifications'],
    means: 'A verification decision was recorded on a seller account. The check and the outcome stay on the record.',
  },
  // PAID, not initiated. `createPayout()` writes an instruction; a provider
  // marks it paid. Telling a seller they have been paid when a transfer has
  // only been queued is the message they will quote back at the federation the
  // week it does not arrive.
  MARKETPLACE_PAYOUT_PAID: {
    floor: 'member', publicFields: [],
    payload: ['payoutId', 'payoutRef', 'sellerId', 'settlementId'],
    consumers: ['notifications'],
    means: 'A payout to a seller was confirmed as paid. The amount is on the statement, not on the feed.',
  },

  // ── On the feed for the record, with no consumer ──────────────────────────

  // NO CONSUMER, and POLICY_BROADCAST_NOT_DECIDED says why: writing to every
  // seller on the platform is a circular, not a side effect of saving a form.
  MARKETPLACE_POLICY_PUBLISHED: {
    floor: 'member', publicFields: [],
    means: 'A version of a marketplace policy was published and became the current one.',
  },
  // The instruction, carrying its amount — which is why it is confidential and
  // why it is a different type from MARKETPLACE_PAYOUT_PAID above. A settlement
  // total is exactly the sort of figure the money section of the catalogue
  // classifies at 'confidential', and it must not ride on the seller's own
  // notice in order to get there.
  MARKETPLACE_PAYOUT_INITIATED: {
    floor: 'confidential', publicFields: [],
    means: 'A payout instruction was created against an approved settlement. No money has moved.',
  },

  // ── What the FEDERATION is told ───────────────────────────────────────────
  //
  // Every entry in this group names NO consumer. See ADMIN_NOTICES_NOT_WIRED:
  // the only pass draining this feed is capped at 'member', so a notification
  // entry here would be an allow-list line that can never fire.

  MARKETPLACE_SELLER_APPLIED: {
    floor: 'official', publicFields: [],
    means: 'Somebody applied to sell on the MMAKF marketplace and is waiting for a decision.',
  },
  // 'confidential' as the FLOOR, and the producer RAISES it to 'restricted'
  // when the subject is a person. A signal against a shop is a commercial
  // matter; a signal against a named individual is an allegation about a human
  // being, and this feed has no scope filter that would keep it near the
  // district that raised it. `publish()` permits a producer to be more careful
  // than the catalogue and never less.
  //
  // `detail` and `evidence` never travel. Both are free text a detector wrote,
  // and a detector that names the person it suspects would put that sentence on
  // the feed verbatim.
  MARKETPLACE_FRAUD_SIGNAL_RAISED: {
    floor: 'confidential', publicFields: [],
    means: 'A detector raised a fraud signal for a human to look at. A signal decides nothing.',
  },
  // The buyer's own words are not on the payload, and neither is the buyer.
  // An officer opening the report sees both; a feed reader has no need of
  // either and every reason not to have them.
  MARKETPLACE_PRODUCT_REPORTED: {
    floor: 'official', publicFields: [],
    means: 'A buyer reported a problem with a product or an order to the federation.',
  },
  // The two figures ARE the fact here — a mismatch with the amounts withheld is
  // an alarm with no information in it — and 'confidential' is where the
  // catalogue already puts an amount beside an order.
  MARKETPLACE_PAYMENT_MISMATCH: {
    floor: 'confidential', publicFields: [],
    means: 'A captured amount did not match a marketplace order total. An integration fault or an attack; a human decides which.',
  },
  // Settlement is BLOCKED rather than failed where the cause is an unpublished
  // commission: the sale completed, the seller shipped, and the money waits for
  // a federation decision. The reason is a closed vocabulary, never free text,
  // so a queue can group on it.
  MARKETPLACE_SETTLEMENT_BLOCKED: {
    floor: 'confidential', publicFields: [],
    means: 'A settlement or payout could not proceed, with a stated reason from a closed list.',
  },
} as const satisfies Record<string, EventTypeSpec>;

export type MarketplaceEventType = keyof typeof MARKETPLACE_EVENT_TYPES;

/**
 * The `NOTIFIABLE` entries in src/lib/notifications.ts these events need.
 *
 * TWO AUDIENCES THAT DO NOT YET EXIST — 'buyer' and 'seller' — and that is
 * stated here rather than worked around. The nearest existing audience is
 * 'subject', and 'subject' ends in `Number(payload?.personId ?? entityId)`.
 * Reusing it for an event whose entity is a seller order would address a
 * federation notice to whoever happens to hold that number in `persons`. A
 * near-miss audience is how a notice reaches the wrong person, so this module
 * names the two it needs and proposes their `resolveRecipients()` cases rather
 * than borrowing one that almost fits.
 *
 * EVERY ENTRY IS `essential: true`, and none of them is a preference anybody
 * may switch off. Each is a consequence of a transaction the recipient is a
 * party to: a parcel that has left, money that has moved, goods somebody wants
 * to send back, a decision on a shop's standing. A preference that let MMAKF
 * stop saying "your order was dispatched" would turn a delivery into a doorstep
 * surprise, and one that suppressed "a return is waiting for your decision"
 * would run the seller's own response clock down for them.
 *
 * The one judgement call is the review notice, and it is essential for the
 * reason the others are: a published review is a public statement about that
 * shop which the seller may reply to, and a reply window they were never told
 * about is not a right they have.
 */
export const MARKETPLACE_NOTIFIABLE = {
  MARKETPLACE_ORDER_PLACED:    { audience: 'buyer', essential: true, title: 'Your order has been placed' },
  MARKETPLACE_ORDER_PAID:      { audience: 'buyer', essential: true, title: 'Payment received for your order' },
  MARKETPLACE_ORDER_SHIPPED:   { audience: 'buyer', essential: true, title: 'Your order has been dispatched' },
  MARKETPLACE_ORDER_DELIVERED: { audience: 'buyer', essential: true, title: 'Your order has been delivered' },
  MARKETPLACE_RETURN_DECIDED:  { audience: 'buyer', essential: true, title: 'A decision on your return' },
  MARKETPLACE_REFUND_ISSUED:   { audience: 'buyer', essential: true, title: 'A refund has been issued to you' },

  MARKETPLACE_SELLER_ORDER_PLACED:         { audience: 'seller', essential: true, title: 'You have a new order' },
  MARKETPLACE_SELLER_ORDER_PAID:           { audience: 'seller', essential: true, title: 'An order has been paid for' },
  MARKETPLACE_SELLER_RETURN_REQUESTED:     { audience: 'seller', essential: true, title: 'A buyer has asked to return goods' },
  MARKETPLACE_SELLER_REFUND_POSTED:        { audience: 'seller', essential: true, title: 'A refund has been posted against your account' },
  MARKETPLACE_SELLER_REVIEW_PUBLISHED:     { audience: 'seller', essential: true, title: 'A review of your shop has been published' },
  MARKETPLACE_SELLER_LOW_STOCK:            { audience: 'seller', essential: true, title: 'Stock has fallen to your own low-stock level' },
  MARKETPLACE_SELLER_VERIFICATION_DECIDED: { audience: 'seller', essential: true, title: 'A verification decision on your seller account' },
  MARKETPLACE_PAYOUT_PAID:                 { audience: 'seller', essential: true, title: 'A payout to you has been paid' },
} as const;

export type MarketplaceNotifiableEvent = keyof typeof MARKETPLACE_NOTIFIABLE;

/** The audiences this module introduces. Neither exists in notifications.ts yet. */
export const MARKETPLACE_AUDIENCES = ['buyer', 'seller'] as const;

/**
 * Audiences that resolve a recipient by FALLING BACK to the event's entity id.
 *
 * Named so a test can assert that no marketplace notification uses one. This is
 * not a criticism of 'subject' — for a grading, the entity IS the person, and
 * the fallback is correct. It is wrong for every event in this file, where the
 * entity is an order, a shop or a parcel.
 */
export const ENTITY_ID_FALLBACK_AUDIENCES = ['subject'] as const;

// ─── Self-check: this module against the live catalogue ─────────────────────

function setsDiffer(a: readonly string[] = [], b: readonly string[] = []): boolean {
  return a.length !== b.length || a.some((x) => !b.includes(x));
}

/**
 * Where `MARKETPLACE_EVENT_TYPES` and the live `EVENT_TYPES` disagree.
 *
 * Returns findings rather than throwing, on the same reasoning as
 * `catalogueDefects()`: a static comparison either always fails or never does,
 * and a module that refuses to load in production over a developer's typo takes
 * the whole site down. The test suite is where this fails.
 *
 * The comparison matters because the two copies are edited by different hands
 * at different times. A floor raised here and not there means every producer
 * publishes below the floor it documents; a floor raised there and not here
 * means a notice the catalogue has silently made undeliverable, because the
 * consumer is capped at 'member' and steps over anything above it WITHOUT
 * erroring.
 */
export function marketplaceCatalogueGaps(): string[] {
  const gaps: string[] = [];
  const live = EVENT_TYPES as unknown as Record<string, EventTypeSpec>;

  for (const [name, mine] of Object.entries(MARKETPLACE_EVENT_TYPES) as Array<[string, EventTypeSpec]>) {
    const there = live[name];
    if (!there) {
      gaps.push(`${name}: is not in EVENT_TYPES. publish() will refuse it — copy the entry from MARKETPLACE_EVENT_TYPES.`);
      continue;
    }
    if (there.floor !== mine.floor) {
      gaps.push(`${name}: floor is '${there.floor}' in the catalogue and '${mine.floor}' here.`);
    }
    if ((there.publicFields ?? []).length) {
      gaps.push(`${name}: the catalogue declares public fields for it. No marketplace event has a public form.`);
    }
    if (setsDiffer(mine.payload, there.payload)) {
      gaps.push(
        `${name}: payload contract differs — catalogue [${(there.payload ?? []).join(', ')}], ` +
        `here [${(mine.payload ?? []).join(', ')}].`
      );
    }
    if (setsDiffer(mine.consumers, there.consumers)) {
      gaps.push(
        `${name}: consumer list differs — catalogue [${(there.consumers ?? []).join(', ')}], ` +
        `here [${(mine.consumers ?? []).join(', ')}].`
      );
    }
  }
  return gaps;
}

/**
 * Where `MARKETPLACE_NOTIFIABLE` and the live `NOTIFIABLE` disagree.
 *
 * An event that declares `consumers: ['notifications']` and has no allow-list
 * entry is a wire drawn on a diagram: the feed carries the fact, the consumer
 * runs, and `notifyForEvent()` returns 0 for ever because `isNotifiable()` said
 * no. That reads as a working notification path right up until somebody asks
 * why nobody was told.
 */
export function marketplaceNotificationGaps(): string[] {
  const gaps: string[] = [];

  for (const [name, spec] of Object.entries(MARKETPLACE_EVENT_TYPES) as Array<[string, EventTypeSpec]>) {
    const wantsNotice = (spec.consumers ?? []).includes('notifications');
    const declared = Object.prototype.hasOwnProperty.call(MARKETPLACE_NOTIFIABLE, name);
    if (wantsNotice && !declared) {
      gaps.push(`${name}: names the notifications consumer but this module proposes no NOTIFIABLE entry for it.`);
    }
    if (!wantsNotice && declared) {
      gaps.push(`${name}: has a NOTIFIABLE entry but names no notifications consumer, so nothing would ever read it.`);
    }
    if (wantsNotice && !isNotifiable(name)) {
      gaps.push(`${name}: is not in NOTIFIABLE yet — copy the entry from MARKETPLACE_NOTIFIABLE into src/lib/notifications.ts.`);
    }
  }
  return gaps;
}

// ─── Publishing ─────────────────────────────────────────────────────────────

export interface MarketplaceEventOutcome {
  eventType: MarketplaceEventType;
  /** False when nothing was appended. `withheldReason` says why. */
  published: boolean;
  /** True when this fact was already on the feed under the same key. */
  duplicate: boolean;
  eventId: number | null;
  correlationId: string;
  /** Null when the event was published. */
  withheldReason: string | null;
}

interface Emit {
  eventType: MarketplaceEventType;
  entityType: string;
  entityId: number | string;
  correlationId: string;
  payload: Record<string, unknown>;
  /** Only ever ABOVE the catalogue floor. `publish()` refuses anything below. */
  classification?: Classification;
  actor?: Principal | null;
  occurredAt?: Date;
}

function withheld(
  e: { eventType: MarketplaceEventType; correlationId: string },
  reason: string
): MarketplaceEventOutcome {
  return {
    eventType: e.eventType, published: false, duplicate: false,
    eventId: null, correlationId: e.correlationId, withheldReason: reason,
  };
}

/**
 * The single call to `publish()` in this module.
 *
 * ONE PLACE, so that the correlation id, the classification and the actor are
 * handled once. Twenty copies of this call is twenty places for a producer to
 * forget the correlation id, and a producer that forgets it is a webhook retry
 * writing a second notification to a real person.
 *
 * THE CAST. `publish()` types `eventType` as `DomainEventType`, the union of
 * the catalogue's keys. Until the entries in `MARKETPLACE_EVENT_TYPES` are
 * copied into src/lib/domain-events.ts these names are not in that union, so
 * the cast is what lets this module be written and tested before the catalogue
 * change lands. It is NOT a way past the check that matters: `publish()`
 * validates the type against `EVENT_TYPES` at RUNTIME and refuses an unknown
 * one outright, so a producer running against a catalogue that has not been
 * updated throws `unknown_event_type` rather than appending an unclassified
 * event. Delete the cast once the entries are in and the union covers them.
 */
async function emit(db: DB, e: Emit): Promise<MarketplaceEventOutcome> {
  const result = await publish(db, {
    eventType: e.eventType as any,
    entityType: e.entityType,
    entityId: e.entityId,
    payload: e.payload,
    classification: e.classification,
    actor: e.actor ?? null,
    correlationId: e.correlationId,
    occurredAt: e.occurredAt,
  });
  return {
    eventType: e.eventType,
    published: !result.duplicate,
    duplicate: result.duplicate,
    eventId: result.event.id,
    correlationId: e.correlationId,
    withheldReason: null,
  };
}

// ─── Resolving a recipient, from the database and never from a caller ───────

/**
 * The person behind a seller account, or null.
 *
 * Two hops, in order: the seller's own `personId`, then the person behind the
 * user that holds the account. A seller row always has a `userId` — the column
 * is NOT NULL — but a user need not be a person: a shared office credential is
 * attributable to nobody, which is exactly why /portal/seller/_gate.ts has a
 * 'shared_credential' state of its own. That account has no inbox, and the
 * honest answer is nobody rather than the nearest id.
 *
 * TAKES A sellerId AND IS NOT A SELLER-FACING FUNCTION. It is private to this
 * module and is called by producers that have already been handed a seller
 * order or a payout the acting module resolved under its own isolation rules;
 * nothing here is reachable from a seller's request with an id of their
 * choosing.
 */
async function sellerRecipient(db: DB, sellerId: number): Promise<number | null> {
  const row = (await db
    .select({ personId: s.sellers.personId, userId: s.sellers.userId })
    .from(s.sellers)
    .where(eq(s.sellers.id, sellerId))
    .limit(1))[0];
  if (!row) return null;
  if (row.personId != null) return Number(row.personId);

  const user = (await db
    .select({ personId: s.users.personId })
    .from(s.users)
    .where(eq(s.users.id, row.userId))
    .limit(1))[0];
  return user?.personId != null ? Number(user.personId) : null;
}

/**
 * The buyer behind an order, or null.
 *
 * READ FROM THE ROW, never accepted as an argument. `notifyForEvent()` makes
 * the same point about its own recipients: a fan-out that accepts a recipient
 * list is a mail-merge waiting to be pointed at the whole membership, and a
 * producer that accepted a `buyerPersonId` would let its caller decide who
 * hears about somebody else's purchase.
 *
 * Null for a guest checkout. `orders.email` is what identifies that buyer, and
 * an email address is not a person record — there is nothing in `notifications`
 * to address and nothing in `persons` to address it to.
 */
async function buyerOfOrder(
  db: DB, orderId: number
): Promise<{ orderNo: string; personId: number | null } | null> {
  const row = (await db
    .select({ orderNo: s.orders.orderNo, personId: s.orders.personId })
    .from(s.orders)
    .where(eq(s.orders.id, orderId))
    .limit(1))[0];
  if (!row) return null;
  return { orderNo: String(row.orderNo), personId: row.personId != null ? Number(row.personId) : null };
}

/** How many seller orders sit on an order. Zero means it is not a basket. */
async function sellerOrderCount(db: DB, orderId: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(s.sellerOrders)
    .where(eq(s.sellerOrders.orderId, orderId));
  return Number(rows[0]?.n ?? 0);
}

async function sellerOrderRow(db: DB, sellerOrderId: number) {
  return (await db
    .select({
      id: s.sellerOrders.id,
      sellerOrderNo: s.sellerOrders.sellerOrderNo,
      orderId: s.sellerOrders.orderId,
      sellerId: s.sellerOrders.sellerId,
      buyerPersonId: s.sellerOrders.buyerPersonId,
      dispatchBy: s.sellerOrders.dispatchBy,
    })
    .from(s.sellerOrders)
    .where(eq(s.sellerOrders.id, sellerOrderId))
    .limit(1))[0] ?? null;
}

/**
 * A producer was handed an id nothing wrote.
 *
 * THROWS rather than being folded into `withheldReason`. Every producer here is
 * called from inside the acting module immediately after it wrote the row, so a
 * miss is a programming fault — and reporting it as a withheld event would make
 * it indistinguishable from the deliberate silences this module exists to
 * report, which are the ones an operator must be able to trust.
 */
function unknown(entity: string): MarketplaceError {
  return new MarketplaceError(
    'unknown_entity',
    `No such ${entity}. A marketplace event producer was called with an id nothing wrote.`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// THE BUYER'S EVENTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A marketplace basket was placed.
 *
 * Published after `checkout()` has written the order and every seller order, so
 * `sellerOrderCount` counts rows and not the caller's intentions.
 */
export async function publishOrderPlaced(
  db: DB, orderId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = { eventType: 'MARKETPLACE_ORDER_PLACED' as const, correlationId: `order:${orderId}:placed` };

  const order = await buyerOfOrder(db, orderId);
  if (!order) throw unknown('order');
  if (order.personId == null) return withheld(e, NO_BUYER_PERSON_RECORD);

  const n = await sellerOrderCount(db, orderId);
  if (!n) return withheld(e, NOT_A_MARKETPLACE_ORDER);

  return emit(db, {
    ...e,
    entityType: 'order',
    entityId: orderId,
    actor,
    payload: {
      orderId,
      orderNo: order.orderNo,
      buyerPersonId: order.personId,
      sellerOrderCount: n,
    },
  });
}

/**
 * The capture cleared.
 *
 * THE CORRELATION ID NAMES THE ORDER AND NOT THE PAYMENT ATTEMPT. A basket paid
 * for on a second attempt after a failed first one is one payment fact to the
 * buyer, and keying on the payment id would tell them twice.
 */
export async function publishOrderPaid(
  db: DB, orderId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = { eventType: 'MARKETPLACE_ORDER_PAID' as const, correlationId: `order:${orderId}:paid` };

  const order = await buyerOfOrder(db, orderId);
  if (!order) throw unknown('order');
  if (order.personId == null) return withheld(e, NO_BUYER_PERSON_RECORD);

  const n = await sellerOrderCount(db, orderId);
  if (!n) return withheld(e, NOT_A_MARKETPLACE_ORDER);

  return emit(db, {
    ...e,
    entityType: 'order',
    entityId: orderId,
    actor,
    payload: { orderId, orderNo: order.orderNo, buyerPersonId: order.personId },
  });
}

/**
 * One seller's consignment has left.
 *
 * ONE EVENT PER SELLER ORDER, never one per basket. A basket from two sellers
 * ships twice, on two days, and a single "your order has shipped" would be a
 * lie about half of it the first time and a duplicate the second.
 */
export async function publishOrderShipped(
  db: DB, sellerOrderId: number, opts: { trackingRecorded?: boolean } = {}, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = {
    eventType: 'MARKETPLACE_ORDER_SHIPPED' as const,
    correlationId: `seller_order:${sellerOrderId}:shipped`,
  };

  const so = await sellerOrderRow(db, sellerOrderId);
  if (!so) throw unknown('seller order');
  if (so.buyerPersonId == null) return withheld(e, NO_BUYER_PERSON_RECORD);

  return emit(db, {
    ...e,
    entityType: 'seller_order',
    entityId: sellerOrderId,
    actor,
    payload: {
      sellerOrderId,
      sellerOrderNo: so.sellerOrderNo,
      orderId: Number(so.orderId),
      buyerPersonId: Number(so.buyerPersonId),
      // A BOOLEAN. The number itself would let anybody reading the feed follow
      // a stranger's parcel across a carrier's website.
      trackingRecorded: !!opts.trackingRecorded,
    },
  });
}

export async function publishOrderDelivered(
  db: DB, sellerOrderId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = {
    eventType: 'MARKETPLACE_ORDER_DELIVERED' as const,
    correlationId: `seller_order:${sellerOrderId}:delivered`,
  };

  const so = await sellerOrderRow(db, sellerOrderId);
  if (!so) throw unknown('seller order');
  if (so.buyerPersonId == null) return withheld(e, NO_BUYER_PERSON_RECORD);

  return emit(db, {
    ...e,
    entityType: 'seller_order',
    entityId: sellerOrderId,
    actor,
    payload: {
      sellerOrderId,
      sellerOrderNo: so.sellerOrderNo,
      orderId: Number(so.orderId),
      buyerPersonId: Number(so.buyerPersonId),
    },
  });
}

/**
 * The seller decided a return.
 *
 * `outcome` is READ FROM THE ROW rather than taken from the caller, so the event
 * cannot say 'authorised' about a return the database records as rejected.
 *
 * The correlation id deliberately does NOT include the outcome. A return is
 * decided once — `decideReturn()` refuses a second decision with
 * `already_decided` — and a key that carried the outcome would let a corrected
 * decision become a quiet second notice instead of the `correlation_conflict`
 * that tells the caller to publish a corrective event.
 */
export async function publishReturnDecided(
  db: DB, returnRequestId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = {
    eventType: 'MARKETPLACE_RETURN_DECIDED' as const,
    correlationId: `return_request:${returnRequestId}:decided`,
  };

  const req = (await db
    .select({
      ref: s.returnRequests.ref,
      sellerOrderId: s.returnRequests.sellerOrderId,
      buyerPersonId: s.returnRequests.buyerPersonId,
      status: s.returnRequests.status,
    })
    .from(s.returnRequests)
    .where(eq(s.returnRequests.id, returnRequestId))
    .limit(1))[0];
  if (!req) throw unknown('return request');
  if (req.buyerPersonId == null) return withheld(e, NO_BUYER_PERSON_RECORD);

  return emit(db, {
    ...e,
    entityType: 'return_request',
    entityId: returnRequestId,
    actor,
    payload: {
      returnRequestId,
      returnRef: String(req.ref),
      sellerOrderId: Number(req.sellerOrderId),
      buyerPersonId: Number(req.buyerPersonId),
      outcome: String(req.status),
    },
  });
}

/**
 * Money went back to the buyer.
 *
 * SEPARATE FROM THE SELLER'S EVENT BELOW, which is the same business fact seen
 * from the other side of the counter. Two types rather than one with two
 * audiences, because a single event addressed to both would have to carry both
 * the buyer's person id and the seller's, and the buyer's identity has no
 * business travelling in order to make a seller's notice work.
 */
export async function publishRefundIssued(
  db: DB, returnRequestId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = {
    eventType: 'MARKETPLACE_REFUND_ISSUED' as const,
    correlationId: `return_request:${returnRequestId}:refunded`,
  };

  const req = (await db
    .select({
      ref: s.returnRequests.ref,
      sellerOrderId: s.returnRequests.sellerOrderId,
      buyerPersonId: s.returnRequests.buyerPersonId,
    })
    .from(s.returnRequests)
    .where(eq(s.returnRequests.id, returnRequestId))
    .limit(1))[0];
  if (!req) throw unknown('return request');
  if (req.buyerPersonId == null) return withheld(e, NO_BUYER_PERSON_RECORD);

  return emit(db, {
    ...e,
    entityType: 'return_request',
    entityId: returnRequestId,
    actor,
    payload: {
      returnRequestId,
      returnRef: String(req.ref),
      sellerOrderId: Number(req.sellerOrderId),
      buyerPersonId: Number(req.buyerPersonId),
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SELLER'S EVENTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A new order to fulfil.
 *
 * THERE IS NO SELLER EVENT FOR DISPATCH OR DELIVERY, and that is a decision.
 * The seller performs both of those acts with their own hand, and a
 * notification telling somebody what they have just done is precisely the noise
 * `NOTIFIABLE` exists to keep out — "a federation that emails a member about
 * every event in the system trains them to ignore it, and the one message that
 * mattered arrives in a stream they stopped reading months ago". The dispatch
 * FACT is on the feed once, as MARKETPLACE_ORDER_SHIPPED, addressed to the
 * buyer, who is the person that did not already know.
 *
 * If a carrier webhook ever marks dispatch or delivery instead of the seller,
 * that is a different producer and gets its own type — because then the seller
 * is the one who does not know, and that is a different fact.
 */
export async function publishSellerOrderPlaced(
  db: DB, sellerOrderId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = {
    eventType: 'MARKETPLACE_SELLER_ORDER_PLACED' as const,
    correlationId: `seller_order:${sellerOrderId}:placed`,
  };

  const so = await sellerOrderRow(db, sellerOrderId);
  if (!so) throw unknown('seller order');
  if ((await sellerRecipient(db, Number(so.sellerId))) == null) return withheld(e, NO_SELLER_PERSON_RECORD);

  return emit(db, {
    ...e,
    entityType: 'seller_order',
    entityId: sellerOrderId,
    actor,
    payload: {
      sellerOrderId,
      sellerOrderNo: so.sellerOrderNo,
      sellerId: Number(so.sellerId),
    },
  });
}

/**
 * Money cleared on a seller's consignment, and their clock — if MMAKF has
 * published one — started.
 *
 * `dispatchByIso` IS NULL WHENEVER NO SLA IS PUBLISHED, and the null travels on
 * purpose. `seller_orders.dispatch_by` is nullable for exactly this reason and
 * `overdueDispatch()` is indexed to skip the nulls, so a seller with no SLA is
 * never late for anything. A producer that filled this in with 24 or 48 hours
 * would be quoting the federation on a window it has never published.
 */
export async function publishSellerOrderPaid(
  db: DB, sellerOrderId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = {
    eventType: 'MARKETPLACE_SELLER_ORDER_PAID' as const,
    correlationId: `seller_order:${sellerOrderId}:paid`,
  };

  const so = await sellerOrderRow(db, sellerOrderId);
  if (!so) throw unknown('seller order');
  if ((await sellerRecipient(db, Number(so.sellerId))) == null) return withheld(e, NO_SELLER_PERSON_RECORD);

  return emit(db, {
    ...e,
    entityType: 'seller_order',
    entityId: sellerOrderId,
    actor,
    payload: {
      sellerOrderId,
      sellerOrderNo: so.sellerOrderNo,
      sellerId: Number(so.sellerId),
      dispatchByIso: so.dispatchBy ? new Date(so.dispatchBy).toISOString() : null,
    },
  });
}

/**
 * A buyer wants to send something back, and the seller has to decide.
 *
 * `respondByIso` is null on the same terms as `dispatchByIso` above: the return
 * response window is one of the service levels MMAKF has not published.
 */
export async function publishSellerReturnRequested(
  db: DB, returnRequestId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = {
    eventType: 'MARKETPLACE_SELLER_RETURN_REQUESTED' as const,
    correlationId: `return_request:${returnRequestId}:requested`,
  };

  const req = (await db
    .select({
      ref: s.returnRequests.ref,
      sellerId: s.returnRequests.sellerId,
      sellerOrderId: s.returnRequests.sellerOrderId,
      respondBy: s.returnRequests.respondBy,
    })
    .from(s.returnRequests)
    .where(eq(s.returnRequests.id, returnRequestId))
    .limit(1))[0];
  if (!req) throw unknown('return request');
  if ((await sellerRecipient(db, Number(req.sellerId))) == null) return withheld(e, NO_SELLER_PERSON_RECORD);

  return emit(db, {
    ...e,
    entityType: 'return_request',
    entityId: returnRequestId,
    actor,
    payload: {
      returnRequestId,
      returnRef: String(req.ref),
      sellerId: Number(req.sellerId),
      sellerOrderId: Number(req.sellerOrderId),
      respondByIso: req.respondBy ? new Date(req.respondBy).toISOString() : null,
    },
  });
}

/** The seller's side of a refund: it has come out of what they are owed. */
export async function publishSellerRefundPosted(
  db: DB, returnRequestId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = {
    eventType: 'MARKETPLACE_SELLER_REFUND_POSTED' as const,
    correlationId: `return_request:${returnRequestId}:refund_posted`,
  };

  const req = (await db
    .select({
      sellerId: s.returnRequests.sellerId,
      sellerOrderId: s.returnRequests.sellerOrderId,
    })
    .from(s.returnRequests)
    .where(eq(s.returnRequests.id, returnRequestId))
    .limit(1))[0];
  if (!req) throw unknown('return request');
  if ((await sellerRecipient(db, Number(req.sellerId))) == null) return withheld(e, NO_SELLER_PERSON_RECORD);

  return emit(db, {
    ...e,
    entityType: 'return_request',
    entityId: returnRequestId,
    actor,
    payload: {
      returnRequestId,
      sellerId: Number(req.sellerId),
      sellerOrderId: Number(req.sellerOrderId),
    },
  });
}

/**
 * A review of this seller, or of their product, has been PUBLISHED.
 *
 * REFUSES TO PUBLISH FOR A REVIEW THAT IS NOT PUBLISHED, whatever the caller
 * says. Reviews arrive `pending` and are moderated before publication; an event
 * fired on submission would tell a seller about words the public cannot see and
 * which may be rejected, and the first thing they would do is reply to a review
 * that never appears.
 */
export async function publishSellerReviewPublished(
  db: DB, input: { kind: 'product' | 'seller'; reviewId: number }, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const kind = input?.kind;
  if (kind !== 'product' && kind !== 'seller') {
    throw new MarketplaceError('bad_review_kind', 'A review is a product review or a seller review. Say which.');
  }
  const e = {
    eventType: 'MARKETPLACE_SELLER_REVIEW_PUBLISHED' as const,
    correlationId: `${kind}_review:${input.reviewId}:published`,
  };

  const table = kind === 'product' ? s.productReviews : s.sellerReviews;
  const row = (await db
    .select({ id: table.id, sellerId: table.sellerId, status: table.status })
    .from(table)
    .where(eq(table.id, input.reviewId))
    .limit(1))[0];
  if (!row) throw unknown(`${kind} review`);
  if (row.status !== 'published') {
    throw new MarketplaceError(
      'review_not_published',
      `That review is ${row.status}. A seller is told about a review when it becomes public, not when it is ` +
      'written — telling them earlier invites a reply to something the public may never see.'
    );
  }
  if ((await sellerRecipient(db, Number(row.sellerId))) == null) return withheld(e, NO_SELLER_PERSON_RECORD);

  return emit(db, {
    ...e,
    entityType: `${kind}_review`,
    entityId: input.reviewId,
    actor,
    payload: {
      reviewId: input.reviewId,
      reviewKind: kind,
      sellerId: Number(row.sellerId),
      // NEITHER THE RATING NOR THE TEXT. They are a buyer's words about a named
      // shop and belong on the seller's review page, behind the surface that
      // knows who is reading.
    },
  });
}

/**
 * Stock has fallen to a level THE SELLER THEMSELVES published.
 *
 * TAKES `noticeKey` AND REFUSES WITHOUT ONE. How often anybody should be told
 * that stock is low is not set — see LOW_STOCK_CADENCE_NOT_SET — and this is a
 * fact that is true continuously rather than at an instant, so it has no
 * natural key. Defaulting to "once ever" would tell a seller the first time a
 * gi ran low and never again; defaulting to "every sweep" would put a notice in
 * their inbox every hour for as long as they left it low. Neither is chosen
 * here. The caller states the key — a date for a daily sweep, a week number for
 * a weekly one — and the correlation id carries it, so the same sweep run twice
 * is one notice and the next period's is a new one.
 */
export async function publishLowStock(
  db: DB, input: { sellerId: number; variantId: number; noticeKey: string }, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const noticeKey = String(input?.noticeKey ?? '').trim();
  if (!noticeKey) throw new MarketplaceError('notice_key_required', LOW_STOCK_CADENCE_NOT_SET);

  const e = {
    eventType: 'MARKETPLACE_SELLER_LOW_STOCK' as const,
    correlationId: `listing_variant:${input.variantId}:low_stock:${noticeKey}`,
  };

  const variant = (await db
    .select({ id: s.listingVariants.id, sellerId: s.listingVariants.sellerId })
    .from(s.listingVariants)
    .where(eq(s.listingVariants.id, input.variantId))
    .limit(1))[0];
  if (!variant) throw unknown('variant');
  if (Number(variant.sellerId) !== Number(input.sellerId)) {
    // The same message a seller-facing refusal would give, and for the same
    // reason: telling a caller "that variant belongs to seller 41" confirms
    // which ids are real.
    throw new MarketplaceError('not_your_variant', 'No such variant on that seller account.');
  }
  if ((await sellerRecipient(db, Number(input.sellerId))) == null) return withheld(e, NO_SELLER_PERSON_RECORD);

  return emit(db, {
    ...e,
    entityType: 'listing_variant',
    entityId: input.variantId,
    actor,
    payload: {
      variantId: Number(input.variantId),
      sellerId: Number(input.sellerId),
      // The key is on the payload as well as in the correlation id, so a
      // consumer can tell which sweep produced a notice without parsing a
      // string this module is free to reformat.
      noticeKey,
      // NO QUANTITY AND NO THRESHOLD. What a shop has left is commercially
      // sensitive, 'member' is a wide readership, and the seller's own stock
      // page has the number.
    },
  });
}

export interface LowStockSweepResult {
  /** False when the seller has published no threshold. Nothing was published. */
  configured: boolean;
  reason: string | null;
  outcomes: MarketplaceEventOutcome[];
}

/**
 * One sweep of a seller's own low-stock rules.
 *
 * PUBLISHES NOTHING WHEN NO RULE EXISTS, and says so. `lowStock()` returns
 * `configured: false` for a seller who has set no threshold, because there is
 * no level at which anything is low until somebody says what it is — five units
 * is critical for a dojo and irrelevant for a manufacturer. A sweep that
 * invented a threshold would send a manufacturer several hundred notices on the
 * day it shipped, which is the fastest way to make every notice this federation
 * sends unreadable.
 *
 * TAKES THE CALLER'S OWN PRINCIPAL AND NO sellerId. `lowStock()` resolves the
 * seller from the signed-in user inside its own query, so this cannot be asked
 * about somebody else's shelves.
 */
export async function publishLowStockForSeller(
  db: DB, principal: Principal, noticeKey: string
): Promise<LowStockSweepResult> {
  if (!String(noticeKey ?? '').trim()) {
    throw new MarketplaceError('notice_key_required', LOW_STOCK_CADENCE_NOT_SET);
  }
  const report = await lowStock(db, principal);
  if (!report.configured) {
    return { configured: false, reason: LOW_STOCK_RULE_NOT_SET, outcomes: [] };
  }

  const outcomes: MarketplaceEventOutcome[] = [];
  for (const row of report.rows) {
    // The seller id is re-read from the variant rather than carried across, so
    // the ownership check inside publishLowStock() is a real check and not a
    // restatement of something this function already assumed.
    const variant = (await db
      .select({ sellerId: s.listingVariants.sellerId })
      .from(s.listingVariants)
      .where(eq(s.listingVariants.id, row.variantId))
      .limit(1))[0];
    if (!variant) continue;
    outcomes.push(await publishLowStock(db, {
      sellerId: Number(variant.sellerId),
      variantId: Number(row.variantId),
      noticeKey: String(noticeKey).trim(),
    }, principal));
  }
  return { configured: true, reason: null, outcomes };
}

/**
 * A verification decision was recorded on a seller account.
 *
 * THE CHECK AND THE OUTCOME DO NOT GO ON THE PAYLOAD. See the catalogue entry:
 * "MMAKF rejected this shop's PAN" is a fact about a business that every
 * content:read holder would be able to read off a 'member'-floor feed, and
 * 'member' is where this has to sit for its own subject to be told at all.
 *
 * The check DOES go in the correlation id, and only because six checks decided
 * on one afternoon are six facts that each need their own key. Without it the
 * second decision of the day would come back `duplicate: true` and the seller
 * would never hear about it.
 */
export async function publishVerificationDecided(
  db: DB, input: { sellerId: number; check: string }, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const check = String(input?.check ?? '').trim();
  if (!check) {
    throw new MarketplaceError('check_required', 'A verification decision names which check was decided.');
  }
  const e = {
    eventType: 'MARKETPLACE_SELLER_VERIFICATION_DECIDED' as const,
    correlationId: `seller:${input.sellerId}:verification:${check}`,
  };

  if ((await sellerRecipient(db, Number(input.sellerId))) == null) return withheld(e, NO_SELLER_PERSON_RECORD);

  return emit(db, {
    ...e,
    entityType: 'seller',
    entityId: input.sellerId,
    actor,
    payload: { sellerId: Number(input.sellerId) },
  });
}

/**
 * A payout was CONFIRMED PAID.
 *
 * Reads the row and refuses if it is not paid, because "you have been paid" is
 * the one message a seller will quote back at the federation the week the money
 * does not arrive. `createPayout()` writes an instruction; a provider marks it
 * paid; only the second is this event.
 */
export async function publishPayoutPaid(
  db: DB, payoutId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = { eventType: 'MARKETPLACE_PAYOUT_PAID' as const, correlationId: `seller_payout:${payoutId}:paid` };

  const row = (await db
    .select({
      ref: s.sellerPayouts.ref,
      sellerId: s.sellerPayouts.sellerId,
      settlementId: s.sellerPayouts.settlementId,
      status: s.sellerPayouts.status,
    })
    .from(s.sellerPayouts)
    .where(eq(s.sellerPayouts.id, payoutId))
    .limit(1))[0];
  if (!row) throw unknown('payout');
  if (row.status !== 'paid') {
    throw new MarketplaceError(
      'payout_not_paid',
      `That payout is ${row.status}. A seller is told they have been paid when the transfer has landed, ` +
      'not when it was instructed.'
    );
  }
  if ((await sellerRecipient(db, Number(row.sellerId))) == null) return withheld(e, NO_SELLER_PERSON_RECORD);

  return emit(db, {
    ...e,
    entityType: 'seller_payout',
    entityId: payoutId,
    actor,
    payload: {
      payoutId,
      payoutRef: String(row.ref),
      sellerId: Number(row.sellerId),
      settlementId: row.settlementId == null ? null : Number(row.settlementId),
      // NO AMOUNT, and that is the only reason this can sit at 'member' beside
      // the seller's other notices. The figure is on their statement.
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// THE RECORD, AND THE FEDERATION'S EVENTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A payout instruction was created. NO MONEY HAS MOVED.
 *
 * Carries the amount, which is why it is 'confidential' and why it is not the
 * seller's notice. Keeping the figure on a separate, higher-classified event is
 * exactly what lets MARKETPLACE_PAYOUT_PAID be deliverable to the seller at all.
 */
export async function publishPayoutInitiated(
  db: DB, payoutId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = {
    eventType: 'MARKETPLACE_PAYOUT_INITIATED' as const,
    correlationId: `seller_payout:${payoutId}:initiated`,
  };

  const row = (await db
    .select({
      ref: s.sellerPayouts.ref,
      sellerId: s.sellerPayouts.sellerId,
      settlementId: s.sellerPayouts.settlementId,
      amountMinor: s.sellerPayouts.amountMinor,
      currency: s.sellerPayouts.currency,
    })
    .from(s.sellerPayouts)
    .where(eq(s.sellerPayouts.id, payoutId))
    .limit(1))[0];
  if (!row) throw unknown('payout');

  return emit(db, {
    ...e,
    entityType: 'seller_payout',
    entityId: payoutId,
    actor,
    payload: {
      payoutId,
      payoutRef: String(row.ref),
      sellerId: Number(row.sellerId),
      settlementId: row.settlementId == null ? null : Number(row.settlementId),
      // INTEGER MINOR UNITS, copied from the row and never recomputed. Nothing
      // in this module divides or scales money; there is no arithmetic on an
      // amount anywhere in this file, which is the only way to be certain none
      // of it is wrong.
      amountMinor: Number(row.amountMinor),
      currency: String(row.currency),
    },
  });
}

/**
 * A version of a marketplace policy was published.
 *
 * NO NOTIFICATION CONSUMER. See POLICY_BROADCAST_NOT_DECIDED: writing to every
 * seller on the platform is a circular with its own approval path, not a side
 * effect of an officer saving a form, and `outstandingAcceptances()` already
 * puts an unaccepted mandatory policy in front of the seller who has to accept
 * it. The event is the record that it happened, and when.
 *
 * The policy CODE travels and the BODY never does. The body is the document
 * itself; a copy of it on an append-only feed is a second, unversioned
 * publication that nobody can correct.
 */
export async function publishPolicyPublished(
  db: DB, policyVersionId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = {
    eventType: 'MARKETPLACE_POLICY_PUBLISHED' as const,
    correlationId: `policy_version:${policyVersionId}:published`,
  };

  const row = (await db
    .select({
      policyId: s.policyVersions.policyId,
      version: s.policyVersions.version,
      effectiveFrom: s.policyVersions.effectiveFrom,
      publishedAt: s.policyVersions.publishedAt,
      code: s.marketplacePolicies.code,
      mandatoryForSellers: s.marketplacePolicies.mandatoryForSellers,
    })
    .from(s.policyVersions)
    .innerJoin(s.marketplacePolicies, eq(s.policyVersions.policyId, s.marketplacePolicies.id))
    .where(eq(s.policyVersions.id, policyVersionId))
    .limit(1))[0];
  if (!row) throw unknown('policy version');
  if (!row.publishedAt) {
    throw new MarketplaceError(
      'policy_not_published',
      'That policy version has not been published. A draft on the feed reads to every consumer as a document in force.'
    );
  }

  return emit(db, {
    ...e,
    entityType: 'policy_version',
    entityId: policyVersionId,
    actor,
    payload: {
      policyVersionId,
      policyId: Number(row.policyId),
      policyCode: String(row.code),
      version: Number(row.version),
      effectiveFrom: String(row.effectiveFrom),
      mandatoryForSellers: !!row.mandatoryForSellers,
    },
  });
}

/** Somebody applied to sell, and a reviewer has to decide. */
export async function publishSellerApplied(
  db: DB, sellerId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = { eventType: 'MARKETPLACE_SELLER_APPLIED' as const, correlationId: `seller:${sellerId}:applied` };

  const row = (await db
    .select({
      ref: s.sellers.ref,
      stateUnitId: s.sellers.stateUnitId,
      districtUnitId: s.sellers.districtUnitId,
      dojoId: s.sellers.dojoId,
    })
    .from(s.sellers)
    .where(eq(s.sellers.id, sellerId))
    .limit(1))[0];
  if (!row) throw unknown('seller');

  return emit(db, {
    ...e,
    entityType: 'seller',
    entityId: sellerId,
    actor,
    payload: {
      sellerId,
      sellerRef: String(row.ref),
      // THE PLACEMENT, AND NOT THE APPLICANT. These three ids are what a scoped
      // resolver needs to route this to the right reviewer, and they say nothing
      // about the person. The trading name, the contact details, the GSTIN, the
      // PAN and the bank account are all on the seller row for a reviewer with
      // the authority to open it; not one of them is a fact this feed needs in
      // order to say that an application is waiting.
      stateUnitId: row.stateUnitId == null ? null : Number(row.stateUnitId),
      districtUnitId: row.districtUnitId == null ? null : Number(row.districtUnitId),
      dojoId: row.dojoId == null ? null : Number(row.dojoId),
    },
  });
}

/**
 * A detector noticed something.
 *
 * RAISES THE CLASSIFICATION FOR A SIGNAL ABOUT A PERSON. The catalogue floor is
 * 'confidential', which suits a signal against a shop — a commercial matter for
 * the national office. A signal whose subject is a named individual is an
 * ALLEGATION about a human being, and this feed carries no scope column that
 * would keep it anywhere near the district that raised it, so the producer asks
 * for 'restricted' — national `audit:read` only, the same population that
 * already reads the audit trail. `publish()` permits a producer to be more
 * careful than the catalogue and refuses one that tries to be less.
 *
 * `detail` and `evidence` never travel, on the rule the identity section of the
 * catalogue states plainly: no allowlist can bound what a human, or a detector
 * written by one, put in a free-text field.
 */
export async function publishFraudSignal(
  db: DB, signalId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = {
    eventType: 'MARKETPLACE_FRAUD_SIGNAL_RAISED' as const,
    correlationId: `fraud_signal:${signalId}:raised`,
  };

  const row = (await db
    .select({
      subjectType: s.fraudSignals.subjectType,
      subjectId: s.fraudSignals.subjectId,
      sellerId: s.fraudSignals.sellerId,
      kind: s.fraudSignals.kind,
      severity: s.fraudSignals.severity,
    })
    .from(s.fraudSignals)
    .where(eq(s.fraudSignals.id, signalId))
    .limit(1))[0];
  if (!row) throw unknown('fraud signal');

  return emit(db, {
    ...e,
    entityType: 'fraud_signal',
    entityId: signalId,
    actor,
    classification: String(row.subjectType) === 'person' ? 'restricted' : undefined,
    payload: {
      signalId,
      subjectType: String(row.subjectType),
      subjectId: Number(row.subjectId),
      sellerId: row.sellerId == null ? null : Number(row.sellerId),
      kind: String(row.kind),
      severity: Number(row.severity),
    },
  });
}

/**
 * A buyer reported a problem.
 *
 * NEITHER THE REPORTER NOR THEIR WORDS ARE ON THE PAYLOAD. `detail` is free
 * text a customer typed in the middle of being annoyed, and it routinely names
 * a member of the seller's staff. The officer opens the report; the feed only
 * has to say that one is waiting and what it is about.
 */
export async function publishProductReported(
  db: DB, reportId: number, actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = { eventType: 'MARKETPLACE_PRODUCT_REPORTED' as const, correlationId: `buyer_report:${reportId}:raised` };

  const row = (await db
    .select({
      ref: s.buyerReports.ref,
      sellerId: s.buyerReports.sellerId,
      sellerOrderId: s.buyerReports.sellerOrderId,
      listingId: s.buyerReports.listingId,
      kind: s.buyerReports.kind,
    })
    .from(s.buyerReports)
    .where(eq(s.buyerReports.id, reportId))
    .limit(1))[0];
  if (!row) throw unknown('buyer report');

  return emit(db, {
    ...e,
    entityType: 'buyer_report',
    entityId: reportId,
    actor,
    payload: {
      reportId,
      reportRef: String(row.ref),
      sellerId: row.sellerId == null ? null : Number(row.sellerId),
      sellerOrderId: row.sellerOrderId == null ? null : Number(row.sellerOrderId),
      listingId: row.listingId == null ? null : Number(row.listingId),
      kind: String(row.kind),
    },
  });
}

/**
 * A capture did not match a marketplace order total.
 *
 * PUBLISHES NOTHING FOR AN ORDER WITH NO SELLER ORDERS. The same payment path
 * carries grading fees, competition entries and memberships, and putting those
 * on the marketplace feed would make "how many marketplace payments went wrong
 * this month" a number nobody could trust. The mismatch is still recorded on
 * the payment row and in the audit trail by src/db/orders.ts, which is where it
 * happened.
 *
 * THE TWO FIGURES ARE THE FACT. A mismatch alarm with the amounts withheld
 * gives the officer nothing to act on, and 'confidential' is exactly where the
 * catalogue already puts an amount beside an order.
 */
export async function publishPaymentMismatch(
  db: DB,
  input: { orderId: number; paymentId: number; expectedMinor: number; receivedMinor: number; currency: string },
  actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  const e = {
    eventType: 'MARKETPLACE_PAYMENT_MISMATCH' as const,
    // KEYED ON THE PAYMENT, not the order. Two different attempts against one
    // basket can each mismatch, each is its own thing for a human to look at,
    // and keying on the order would hide the second behind the first.
    correlationId: `payment:${input.paymentId}:mismatch`,
  };

  for (const [k, v] of [['expectedMinor', input.expectedMinor], ['receivedMinor', input.receivedMinor]] as const) {
    // Integer minor units, asserted rather than assumed. A rupee figure that
    // reached this payload would read as paise to every consumer and understate
    // the discrepancy by a factor of a hundred.
    if (!Number.isInteger(v)) {
      throw new MarketplaceError('bad_amount', `${k} must be a whole number of minor units (paise).`);
    }
  }

  const sellerOrders = await db
    .select({ id: s.sellerOrders.id })
    .from(s.sellerOrders)
    .where(eq(s.sellerOrders.orderId, input.orderId));
  if (!sellerOrders.length) return withheld(e, NOT_A_MARKETPLACE_ORDER);

  return emit(db, {
    ...e,
    entityType: 'order',
    entityId: input.orderId,
    actor,
    payload: {
      orderId: Number(input.orderId),
      paymentId: Number(input.paymentId),
      sellerOrderIds: sellerOrders.map((r: any) => Number(r.id)),
      expectedMinor: input.expectedMinor,
      receivedMinor: input.receivedMinor,
      currency: String(input.currency),
    },
  });
}

/** The closed vocabulary of reasons a settlement or payout cannot proceed. */
export const SETTLEMENT_BLOCK_REASONS = [
  'commission_unresolved',
  'no_verified_payout_account',
  'payout_provider_rejected',
  'settlement_on_hold',
] as const;

export type SettlementBlockReason = (typeof SETTLEMENT_BLOCK_REASONS)[number];

/**
 * A settlement or a payout could not proceed.
 *
 * THE REASON IS A CLOSED LIST AND NEVER FREE TEXT. An officer's sentence on a
 * feed cannot be grouped, counted or acted on by anything, and within a month
 * there are four spellings of "no bank account". The list is short on purpose:
 * every entry corresponds to a refusal a function in
 * src/db/marketplace-finance.ts actually makes.
 *
 * `commission_unresolved` is the one that will fire, and it is not a fault.
 * MMAKF has published no commission, so the sale completes, the seller ships,
 * and the money waits for a decision — which is the designed behaviour recorded
 * in MARKETPLACE-POLICY.md, not an error to be cleared.
 */
export async function publishSettlementBlocked(
  db: DB,
  input: { settlementId: number; reason: SettlementBlockReason },
  actor?: Principal | null
): Promise<MarketplaceEventOutcome> {
  if (!SETTLEMENT_BLOCK_REASONS.includes(input?.reason as SettlementBlockReason)) {
    throw new MarketplaceError(
      'bad_reason',
      `A settlement block reason is one of: ${SETTLEMENT_BLOCK_REASONS.join(', ')}. ` +
      'Free text here cannot be counted or queued on, so it is refused rather than accepted and lost.'
    );
  }
  const e = {
    eventType: 'MARKETPLACE_SETTLEMENT_BLOCKED' as const,
    // The reason is IN the key: a settlement blocked for a missing bank account
    // and later blocked again for an unresolved commission is two facts, and one
    // key for both would report the second as a duplicate of the first.
    correlationId: `seller_settlement:${input.settlementId}:blocked:${input.reason}`,
  };

  const row = (await db
    .select({ id: s.sellerSettlements.id, sellerId: s.sellerSettlements.sellerId })
    .from(s.sellerSettlements)
    .where(eq(s.sellerSettlements.id, input.settlementId))
    .limit(1))[0];
  if (!row) throw unknown('settlement');

  return emit(db, {
    ...e,
    entityType: 'seller_settlement',
    entityId: input.settlementId,
    actor,
    payload: {
      settlementId: Number(input.settlementId),
      // READ FROM THE ROW, and deliberately not a parameter. A caller-supplied
      // seller id that disagreed with the settlement would file one seller's
      // blockage under another seller's name in every queue that groups on it.
      sellerId: Number(row.sellerId),
      reason: input.reason,
      // NO FIGURE. What is owed is on the settlement, and a payable total on a
      // feed is a number that moves under a stable correlation id — which is how
      // a retried publish becomes a correlation_conflict instead of a duplicate.
    },
  });
}
