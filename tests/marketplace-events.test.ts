// The marketplace's domain events — the catalogue, the audiences, and what
// travels on the feed.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHY THIS SUITE EXISTS AT ALL
// ═════════════════════════════════════════════════════════════════════════════
//
// src/db/marketplace-events.ts was written with twenty-one event types that
// were not in src/lib/domain-events.ts. `publish()` validates against
// EVENT_TYPES at runtime and refuses an unknown type outright, so every one of
// those producers threw the first time a real order was placed — and nothing in
// the type system said so, because the module casts past the union deliberately
// in order to be written before the catalogue change lands.
//
// The second version of that wiring was worse, and is the reason for the
// central assertion below. The floors were hand-chosen on sensitivity: a
// seller's order flow is commercial information, so 'official'; a verification
// outcome is 'confidential'. Both readings are defensible and both are FATAL,
// because the notifications drain in src/pages/api/cron/reconcile.ts runs
//
//     consume(db, 'notifications', ..., { maxClassification: 'member' })
//
// and consume() STEPS OVER anything above its cap WITHOUT ERRORING. Eight
// seller notices would never have been delivered, and the feed would have shown
// the events sitting there looking exactly like ones that had been.
//
// So: a notifiable marketplace event MUST sit at 'member', and sensitivity is
// held by keeping the material off the payload instead. That is the rule this
// file exists to keep, and it is asserted directly rather than inferred.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS ASSERTED
// ═════════════════════════════════════════════════════════════════════════════
//
//   The catalogue      the module's own copy and the live EVENT_TYPES agree on
//                      every floor, payload and consumer list — its two
//                      exported gap-finders return nothing.
//   Deliverability     every notifiable type is at or below the drain's cap.
//   The audiences      'buyer' and 'seller' resolve through a real query, and
//                      neither falls back to the entity id.
//   Correlation ids    a retry is one fact; two orders are two.
//   The payloads       no address, no phone, no email, no tracking number.
//   The silences       nothing is published when there is nobody to address,
//                      and a withheld event is distinguishable from a fault.
//   Delivery           a buyer's notice reaches the buyer and a seller's
//                      reaches the seller — end to end, through the real
//                      resolveRecipients().

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { registerAccount } from '../src/db/onboarding';
import { applyToSell, approveSeller, createListing, submitListing, reviewListing } from '../src/db/marketplace';
import { addVariant } from '../src/db/catalogue';
import { createLocation, receiveStock } from '../src/db/inventory';
import { checkout } from '../src/db/seller-orders';
import { EVENT_TYPES } from '../src/lib/domain-events';
import { NOTIFIABLE, notifyForEvent } from '../src/lib/notifications';
import {
  MARKETPLACE_EVENT_TYPES, MARKETPLACE_NOTIFIABLE, MARKETPLACE_AUDIENCES,
  ENTITY_ID_FALLBACK_AUDIENCES, marketplaceCatalogueGaps, marketplaceNotificationGaps,
  publishOrderPlaced, publishOrderPaid, publishOrderShipped, publishOrderDelivered,
  publishSellerOrderPlaced, publishSellerApplied, publishLowStock,
  NO_BUYER_PERSON_RECORD, NO_SELLER_PERSON_RECORD, NOT_A_MARKETPLACE_ORDER,
  LOW_STOCK_CADENCE_NOT_SET,
} from '../src/db/marketplace-events';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any, pg: PGlite;
let JH: number, ADMIN: number;

const PW = 'a-perfectly-ordinary-passphrase';

const national = (): Principal => ({
  userId: ADMIN, label: 'admin@mmakf.in',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
});
const ctxOf = (p: Principal): AuditContext => ({ principal: p, reason: 'test', authority: 'test' });
const adminCtx = (): AuditContext => ctxOf(national());

let seq = 0;

async function person(name: string) {
  seq++;
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(700000 + seq)}`,
    fullName: name, status: 'active', dob: '1990-04-04', stateUnitId: JH,
  }).returning({ id: s.persons.id });
  return p.id as number;
}

/**
 * A seller, approved, with a warehouse.
 *
 * `attachPerson` chooses WHICH HOP the recipient is found on. 'seller' fills
 * sellers.personId; 'user' leaves that null and fills users.personId instead;
 * 'none' leaves a shared office credential attached to nobody. All three are
 * real states, and the audience must agree with the producer about each.
 */
async function seller(tag: string, attachPerson: 'seller' | 'user' | 'none' = 'seller') {
  const r = await registerAccount(db, { email: `${tag}-${++seq}@example.in`, password: PW });
  const principal = { userId: r.userId, label: r.email, bindings: [] } as Principal;
  const applied = await applyToSell(db, ctxOf(principal), {
    tradingName: `${tag} Supplies`, contactEmail: `${tag}@shop.in`, stateUnitId: JH,
  });
  await approveSeller(db, adminCtx(), applied.sellerId, 'Checked at the state office.');

  let personId: number | null = null;
  if (attachPerson === 'seller') {
    personId = await person(`${tag} Proprietor`);
    await db.update(s.sellers).set({ personId }).where(eq(s.sellers.id, applied.sellerId));
  } else if (attachPerson === 'user') {
    personId = await person(`${tag} Account Holder`);
    await db.update(s.users).set({ personId }).where(eq(s.users.id, r.userId));
  }

  const loc = await createLocation(db, ctxOf(principal), { code: `W${seq}`, name: 'Warehouse' });
  return { principal, userId: r.userId, sellerId: applied.sellerId, locationId: loc.locationId, personId };
}

/** A published listing with one variant, in stock. */
async function product(sellerCtx: any, title: string, priceMinor: number, stock = 10) {
  const created = await createListing(db, ctxOf(sellerCtx.principal), {
    title, description: 'Plain, no federation marking.',
    category: 'equipment', priceMinor,
    media: [{ url: `https://cdn.example.in/${encodeURIComponent(title)}.jpg`, alt: title }],
  });
  const variant = await addVariant(db, ctxOf(sellerCtx.principal), created.listingId, {
    label: 'Standard', priceMinor,
  });
  await receiveStock(db, ctxOf(sellerCtx.principal), {
    variantId: variant.variantId, locationId: sellerCtx.locationId, qty: stock, reason: 'Opening stock',
  });
  await submitListing(db, ctxOf(sellerCtx.principal), created.listingId);
  await reviewListing(db, adminCtx(), created.listingId, {
    decision: 'approve', reason: 'Plain equipment, correctly described.',
  });
  return { listingId: created.listingId, variantId: variant.variantId };
}

/** The event rows written for one correlation id. */
async function feedFor(correlationId: string) {
  return db.select().from(s.domainEvents).where(eq(s.domainEvents.correlationId, correlationId));
}

beforeAll(async () => {
  pg = new PGlite();
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      const t = stmt.trim();
      if (t) await pg.exec(t);
    }
  }
  db = drizzle(pg, { schema: s });

  const [jh] = await db.insert(s.stateUnits)
    .values({ code: 'MMAKF-ST-JH', state: 'Jharkhand', name: 'Jharkhand', status: 'active' }).returning();
  JH = jh.id;
  ADMIN = (await registerAccount(db, { email: 'admin@mmakf.in', password: PW })).userId;
}, 180_000);

// ═════════════════════════════════════════════════════════════════════════════
describe('THE CATALOGUE — the module and the live allow-list agree', () => {
// ═════════════════════════════════════════════════════════════════════════════

  // These two are the module's own self-checks. They return findings rather
  // than throwing, precisely so that a test is where they fail.
  it('every marketplace type is in EVENT_TYPES, with the same floor and contract', () => {
    expect(marketplaceCatalogueGaps()).toEqual([]);
  });

  it('every type wanting a notification has one, and none has a stray entry', () => {
    expect(marketplaceNotificationGaps()).toEqual([]);
  });

  it('publishes all twenty-one — a producer naming an uncatalogued type throws', () => {
    const live = EVENT_TYPES as Record<string, any>;
    const missing = Object.keys(MARKETPLACE_EVENT_TYPES).filter((k) => !live[k]);
    expect(missing).toEqual([]);
    expect(Object.keys(MARKETPLACE_EVENT_TYPES)).toHaveLength(21);
  });

  it('NOT ONE marketplace event has a public form', () => {
    // A marketplace event ties a named person to a purchase. Nobody agreed to
    // publish that by shopping.
    const withPublic = Object.keys(MARKETPLACE_EVENT_TYPES).filter(
      (k) => ((EVENT_TYPES as Record<string, any>)[k].publicFields ?? []).length > 0
    );
    expect(withPublic).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('DELIVERABILITY — the floor a notifiable event may not exceed', () => {
// ═════════════════════════════════════════════════════════════════════════════

  // THE REGRESSION TEST FOR THE BUG DESCRIBED AT THE TOP OF THIS FILE.
  //
  // src/pages/api/cron/reconcile.ts drains this feed for the notifications
  // consumer with { maxClassification: 'member' }, and consume() steps over
  // anything above the cap silently. Raising a notifiable event's floor to
  // 'official' — which reads like the careful choice — deletes the notice.
  it('every notifiable marketplace event sits at the drain’s cap of “member”', () => {
    const live = EVENT_TYPES as Record<string, any>;
    const undeliverable = Object.keys(MARKETPLACE_NOTIFIABLE)
      .filter((k) => live[k]?.floor !== 'member')
      .map((k) => `${k} is at '${live[k]?.floor}' and would never be delivered`);
    expect(undeliverable).toEqual([]);
  });

  it('the events that DO carry a figure are above the cap and notify nobody', () => {
    const live = EVENT_TYPES as Record<string, any>;
    // MARKETPLACE_PAYOUT_INITIATED carries the amount. That is the whole reason
    // MARKETPLACE_PAYOUT_PAID can be a seller's notice: the money is on a
    // separate, higher event that no consumer delivers.
    for (const k of ['MARKETPLACE_PAYOUT_INITIATED', 'MARKETPLACE_SETTLEMENT_BLOCKED', 'MARKETPLACE_PAYMENT_MISMATCH']) {
      expect(live[k].floor).toBe('confidential');
      expect(Object.prototype.hasOwnProperty.call(MARKETPLACE_NOTIFIABLE, k)).toBe(false);
    }
    expect(live.MARKETPLACE_PAYOUT_PAID.floor).toBe('member');
    expect((live.MARKETPLACE_PAYOUT_PAID.payload ?? [])).not.toContain('amountMinor');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('THE AUDIENCES — resolved from the register, never from the entity id', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('uses only the two audiences it introduced', () => {
    const used = new Set(Object.values(MARKETPLACE_NOTIFIABLE).map((n: any) => n.audience));
    for (const a of used) expect(MARKETPLACE_AUDIENCES).toContain(a);
  });

  it('NO marketplace notice uses an audience that falls back to the entity id', () => {
    // 'subject' ends in Number(payload?.personId ?? entityId). For a grading the
    // entity IS the person and that is correct. Every entity here is an order, a
    // shop or a parcel, and the fallback would address a stranger.
    const offenders = Object.entries(MARKETPLACE_NOTIFIABLE)
      .filter(([, n]: any) => (ENTITY_ID_FALLBACK_AUDIENCES as readonly string[]).includes(n.audience))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  it('the live NOTIFIABLE carries the module’s own audience and title for each', () => {
    const live = NOTIFIABLE as Record<string, any>;
    for (const [name, mine] of Object.entries(MARKETPLACE_NOTIFIABLE) as Array<[string, any]>) {
      expect(live[name], `${name} is not in NOTIFIABLE`).toBeTruthy();
      expect(live[name].audience).toBe(mine.audience);
      expect(live[name].title).toBe(mine.title);
      // None of these is a preference anybody may switch off: each is a
      // consequence of a transaction the recipient is a party to.
      expect(live[name].essential).toBe(true);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('CORRELATION IDS — a retry is one fact, two orders are two', () => {
// ═════════════════════════════════════════════════════════════════════════════

  let buyerPerson: number, sc: any, p: any;

  beforeAll(async () => {
    buyerPerson = await person('Correlation Buyer');
    sc = await seller('corr');
    p = await product(sc, 'Corr Mitts', 100_000);
  }, 180_000);

  it('publishing the same fact twice appends ONE row', async () => {
    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: buyerPerson, buyerName: 'Correlation Buyer', email: 'corr@example.in',
      shipTo: { line1: '1 Dojo Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });

    // CHECKOUT ITSELF PUBLISHES. Asserting that here is stronger than asserting
    // a manual call would be: it is the wiring, and the wiring is what was
    // missing for as long as this module was 1,739 lines nothing invoked.
    const [placed] = await feedFor(`order:${order.orderId}:placed`);
    expect(placed).toBeTruthy();

    // A webhook retried by the provider, or a cron run repeating a batch.
    const second = await publishOrderPlaced(db, order.orderId);
    expect(second.duplicate).toBe(true);
    expect(second.published).toBe(false);
    expect(second.eventId).toBe(placed.id);

    expect(await feedFor(`order:${order.orderId}:placed`)).toHaveLength(1);
  }, 120_000);

  it('two different orders are two different facts', async () => {
    const mk = async () => checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: buyerPerson, buyerName: 'Correlation Buyer', email: 'corr@example.in',
      shipTo: { line1: '1 Dojo Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });
    const a = await mk();
    const b = await mk();

    const ra = await publishOrderPlaced(db, a.orderId);
    const rb = await publishOrderPlaced(db, b.orderId);
    expect(ra.correlationId).not.toBe(rb.correlationId);
    // Both are duplicates of what checkout() already published, and they resolve
    // to DIFFERENT rows — which is the property under test. A key that collided
    // across orders would return the same event id for both.
    expect(ra.eventId).not.toBe(rb.eventId);
    expect(await feedFor(`order:${a.orderId}:placed`)).toHaveLength(1);
    expect(await feedFor(`order:${b.orderId}:placed`)).toHaveLength(1);
  }, 120_000);

  it('placed, paid, shipped and delivered are four keys on one order', async () => {
    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: buyerPerson, buyerName: 'Correlation Buyer', email: 'corr@example.in',
      shipTo: { line1: '1 Dojo Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });
    const [so] = await db.select().from(s.sellerOrders).where(eq(s.sellerOrders.orderId, order.orderId));

    const keys = new Set([
      (await publishOrderPlaced(db, order.orderId)).correlationId,
      (await publishOrderPaid(db, order.orderId)).correlationId,
      (await publishOrderShipped(db, so.id)).correlationId,
      (await publishOrderDelivered(db, so.id)).correlationId,
    ]);
    // Four distinct facts about the same basket. A single key would make the
    // dispatch notice a duplicate of the payment notice and swallow it.
    expect(keys.size).toBe(4);
  }, 120_000);
});

// ═════════════════════════════════════════════════════════════════════════════
describe('THE PAYLOADS — what is deliberately not on the feed', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('carries no delivery address, no phone and no email — for any of the four', async () => {
    const buyerPerson = await person('Private Buyer');
    const sc = await seller('private');
    const p = await product(sc, 'Private Belt', 80_000);

    // Distinctive enough that a substring search cannot miss it.
    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: buyerPerson,
      buyerName: 'Zenobia Quicksilver',
      email: 'zenobia-quicksilver@example.in',
      phone: '+919876500042',
      shipTo: {
        line1: '77 Marigold Crescent', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122',
      },
    });
    const [so] = await db.select().from(s.sellerOrders).where(eq(s.sellerOrders.orderId, order.orderId));

    await publishOrderPlaced(db, order.orderId);
    await publishOrderPaid(db, order.orderId);
    // A REAL TRACKING NUMBER IS RECORDED, and the event must still not carry it.
    await publishOrderShipped(db, so.id, { trackingRecorded: true });
    await publishOrderDelivered(db, so.id);
    await publishSellerOrderPlaced(db, so.id);

    const rows = await db.select().from(s.domainEvents);
    const marketplace = rows.filter((r: any) => String(r.eventType).startsWith('MARKETPLACE_'));
    expect(marketplace.length).toBeGreaterThanOrEqual(5);

    const serialised = JSON.stringify(marketplace.map((r: any) => r.payload));
    for (const secret of [
      'Marigold', '829122', 'zenobia-quicksilver', '9876500042', 'Zenobia',
    ]) {
      expect(serialised, `payload leaked ${secret}`).not.toContain(secret);
    }
  }, 180_000);

  it('records THAT tracking exists and never the number itself', async () => {
    const buyerPerson = await person('Tracked Buyer');
    const sc = await seller('tracked');
    const p = await product(sc, 'Tracked Gi', 90_000);
    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: buyerPerson, buyerName: 'Tracked Buyer', email: 't@example.in',
      shipTo: { line1: '2 Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });
    const [so] = await db.select().from(s.sellerOrders).where(eq(s.sellerOrders.orderId, order.orderId));

    const r = await publishOrderShipped(db, so.id, { trackingRecorded: true });
    const [row] = await feedFor(r.correlationId);
    // A boolean. The number would let anybody reading the feed follow a
    // stranger's parcel across a carrier's website.
    expect(row.payload.trackingRecorded).toBe(true);
    expect(typeof row.payload.trackingRecorded).toBe('boolean');
    expect(Object.keys(row.payload)).not.toContain('trackingNumber');
  }, 180_000);

  it('a seller’s application names the placement and not the applicant', async () => {
    const sc = await seller('applicant');
    const r = await publishSellerApplied(db, sc.sellerId);
    const [row] = await feedFor(r.correlationId);

    expect(row.payload.sellerId).toBe(sc.sellerId);
    expect(row.payload.stateUnitId).toBe(JH);
    // The trading name, contact address, GSTIN, PAN and bank account are all on
    // the seller row for a reviewer with the authority to open it. None of them
    // is needed to say that an application is waiting.
    const serialised = JSON.stringify(row.payload);
    expect(serialised).not.toContain('applicant@shop.in');
    expect(serialised).not.toContain('Supplies');
  }, 120_000);
});

// ═════════════════════════════════════════════════════════════════════════════
describe('THE SILENCES — publishing nothing, and saying why', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('a guest checkout publishes NOTHING, and is not an error', async () => {
    const sc = await seller('guest-host');
    const p = await product(sc, 'Guest Pads', 50_000);
    const order = await checkout(db, null, {
      // NO personId. An email address is not a person record: there is nothing
      // in `notifications` to address and nothing in `persons` to address it to.
      lines: [{ variantId: p.variantId, quantity: 1 }],
      buyerName: 'A Guest', email: 'guest@example.in',
      shipTo: { line1: '3 Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });

    const r = await publishOrderPlaced(db, order.orderId);
    expect(r.published).toBe(false);
    expect(r.duplicate).toBe(false);
    expect(r.eventId).toBeNull();
    expect(r.withheldReason).toBe(NO_BUYER_PERSON_RECORD);
    // And genuinely nothing on the feed — not an event nobody can receive.
    expect(await feedFor(r.correlationId)).toHaveLength(0);
  }, 180_000);

  it('a fee or a membership going through the same payment path is not a basket', async () => {
    const buyerPerson = await person('Fee Payer');
    const [order] = await db.insert(s.orders).values({
      orderNo: `ORD-TEST-${++seq}`, personId: buyerPerson,
      buyerName: 'Fee Payer', email: 'fee@example.in',
      status: 'awaiting_payment',
      subtotalPaise: 50_000, taxPaise: 0, shippingPaise: 0, totalPaise: 50_000,
      fulfilment: 'pending',
    }).returning();

    const r = await publishOrderPlaced(db, order.id);
    expect(r.published).toBe(false);
    expect(r.withheldReason).toBe(NOT_A_MARKETPLACE_ORDER);
  }, 120_000);

  it('a shared office credential has no inbox, and nothing is guessed', async () => {
    const sc = await seller('shared-cred', 'none');
    const buyerPerson = await person('Shared Buyer');
    const p = await product(sc, 'Shared Shield', 60_000);
    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: buyerPerson, buyerName: 'Shared Buyer', email: 'sh@example.in',
      shipTo: { line1: '4 Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });
    const [so] = await db.select().from(s.sellerOrders).where(eq(s.sellerOrders.orderId, order.orderId));

    const r = await publishSellerOrderPlaced(db, so.id);
    expect(r.published).toBe(false);
    expect(r.withheldReason).toBe(NO_SELLER_PERSON_RECORD);

    // THE BUYER'S SIDE OF THE SAME BASKET IS UNAFFECTED. One party having no
    // person record must not silence the other — and checkout() published it
    // during the very call that withheld the seller's.
    expect(await feedFor(`order:${order.orderId}:placed`)).toHaveLength(1);
  }, 180_000);

  it('an id nothing wrote THROWS — a fault is not a deliberate silence', async () => {
    // Folded into withheldReason it would be indistinguishable from the
    // silences above, which are the ones an operator must be able to trust.
    await expect(publishOrderPlaced(db, 987_654)).rejects.toMatchObject({ code: 'unknown_entity' });
    await expect(publishOrderShipped(db, 987_654)).rejects.toMatchObject({ code: 'unknown_entity' });
  });

  it('refuses to invent a low-stock cadence', async () => {
    const sc = await seller('cadence');
    const p = await product(sc, 'Cadence Bag', 70_000);
    // How often anybody wants to be told stock is low is not set anywhere, so
    // the producer takes the notice key as an argument rather than choosing one.
    await expect(
      publishLowStock(db, { sellerId: sc.sellerId, variantId: p.variantId, noticeKey: '  ' })
    ).rejects.toMatchObject({ code: 'notice_key_required' });

    await expect(
      publishLowStock(db, { sellerId: sc.sellerId, variantId: p.variantId, noticeKey: '' })
    ).rejects.toThrow(LOW_STOCK_CADENCE_NOT_SET);
  }, 180_000);

  it('a seller cannot raise a low-stock notice about another seller’s variant', async () => {
    const mine = await seller('ls-mine');
    const theirs = await seller('ls-theirs');
    const p = await product(theirs, 'Their Variant', 40_000);
    await expect(
      publishLowStock(db, { sellerId: mine.sellerId, variantId: p.variantId, noticeKey: '2026-08' })
    ).rejects.toMatchObject({ code: 'not_your_variant' });
  }, 180_000);
});

// ═════════════════════════════════════════════════════════════════════════════
describe('DELIVERY — the notice reaches the party it is about', () => {
// ═════════════════════════════════════════════════════════════════════════════

  async function deliver(correlationId: string) {
    const [ev] = await feedFor(correlationId);
    expect(ev, `nothing was published for ${correlationId}`).toBeTruthy();
    const queued = await notifyForEvent(db, adminCtx(), ev);
    const rows = await db.select().from(s.notifications)
      .where(eq(s.notifications.domainEventId, ev.id));
    return { queued, rows };
  }

  it('a buyer’s notice goes to the buyer, and the seller’s to the seller', async () => {
    const buyerPerson = await person('Delivered Buyer');
    const sc = await seller('delivery');           // person on the SELLER row
    const p = await product(sc, 'Delivery Kit', 120_000);
    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: buyerPerson, buyerName: 'Delivered Buyer', email: 'd@example.in',
      shipTo: { line1: '5 Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });
    const [so] = await db.select().from(s.sellerOrders).where(eq(s.sellerOrders.orderId, order.orderId));

    // NOTHING IS PUBLISHED HERE. checkout() already did it, and the correlation
    // ids are derivable — which is the point: if the wiring were removed, these
    // lookups would find nothing and the test would fail rather than quietly
    // publishing the events it meant to observe.
    const buyerSide = await deliver(`order:${order.orderId}:placed`);
    expect(buyerSide.queued).toBe(1);
    expect(buyerSide.rows.map((r: any) => r.personId)).toEqual([buyerPerson]);

    const sellerSide = await deliver(`seller_order:${so.id}:placed`);
    expect(sellerSide.queued).toBe(1);
    // THE POINT OF THE WHOLE ARRANGEMENT: the seller's notice is addressed to
    // the seller, and the buyer does not hear about a shop's order queue.
    expect(sellerSide.rows.map((r: any) => r.personId)).toEqual([sc.personId]);
    expect(sellerSide.rows[0].personId).not.toBe(buyerPerson);
  }, 240_000);

  it('finds the seller on the SECOND hop when the person is on the user', async () => {
    // sellerRecipient() in the producer tries sellers.personId then
    // users.personId. The 'seller' audience must resolve exactly the same set,
    // or the producer publishes an event that is delivered to nobody.
    const buyerPerson = await person('Second Hop Buyer');
    const sc = await seller('second-hop', 'user');
    const p = await product(sc, 'Second Hop Guard', 30_000);
    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: buyerPerson, buyerName: 'Second Hop Buyer', email: 'sh2@example.in',
      shipTo: { line1: '6 Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });
    const [so] = await db.select().from(s.sellerOrders).where(eq(s.sellerOrders.orderId, order.orderId));

    const side = await deliver(`seller_order:${so.id}:placed`);
    expect(side.queued).toBe(1);
    expect(side.rows.map((r: any) => r.personId)).toEqual([sc.personId]);
  }, 240_000);

  it('a retried consumer does not tell anybody twice', async () => {
    const buyerPerson = await person('Retried Buyer');
    const sc = await seller('retry');
    const p = await product(sc, 'Retry Rope', 20_000);
    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: buyerPerson, buyerName: 'Retried Buyer', email: 'r@example.in',
      shipTo: { line1: '7 Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });

    const ev = await publishOrderPlaced(db, order.orderId);
    const [row] = await feedFor(ev.correlationId);
    expect(await notifyForEvent(db, adminCtx(), row)).toBe(1);
    // A cursor-based consumer retried after a failure.
    expect(await notifyForEvent(db, adminCtx(), row)).toBe(0);

    const rows = await db.select().from(s.notifications)
      .where(eq(s.notifications.domainEventId, row.id));
    expect(rows).toHaveLength(1);
  }, 240_000);

  it('the notification body carries no substance of the transaction', async () => {
    const rows = await db.select().from(s.notifications);
    const placed = rows.filter((n: any) => n.title === 'Your order has been placed');
    expect(placed.length).toBeGreaterThan(0);
    // A notification travels through channels the federation does not control;
    // the record it points to is where the detail belongs.
    for (const n of placed) {
      const body = String(n.body ?? '');
      expect(body).not.toMatch(/Marigold|829122|₹|9876500042/);
    }
  });
});
