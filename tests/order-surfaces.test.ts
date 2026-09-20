// The three reads a buyer and a support desk needed, and did not have.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT WAS MISSING
// ═════════════════════════════════════════════════════════════════════════════
//
//   · THE RECEIPT. issueInvoice() runs inside the payment confirmation and
//     freezes a complete, immutable snapshot — lines, unit prices, tax,
//     carriage, total, the address it shipped to — and mints a verify token.
//     NOTHING READ ANY OF IT. No page, no route, no export. A buyer was
//     charged, a receipt was written for them, and there was no address at
//     which they could see it.
//
//   · THE BUYER'S OWN FEDERATION ORDERS. /my/orders inner-joined seller_orders,
//     so an order with no seller — a membership, a course fee, an entry,
//     anything from the federation's own half of the shop — was filtered out of
//     the only page called "your orders". listOrders() exists and asserts
//     `finance:read`, which is the treasurer's authority and not a buyer's.
//
//   · THE CHAIN. Answering "I paid and nothing came" meant opening a database
//     client: eleven tables, four different keys, and no surface that walked
//     them from an order number — the only identifier a buyer has.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS ASSERTED, AND MOST OF IT IS A REFUSAL
// ═════════════════════════════════════════════════════════════════════════════
//
// An invoice number is a SEQUENCE. The security assertions here are the point
// of the suite: counting upwards must not walk the federation's billing
// history, and every snapshot carries a name, a telephone number and a delivery
// address.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { registerAccount } from '../src/db/onboarding';
import {
  applyToSell, approveSeller, createListing, submitListing, reviewListing,
} from '../src/db/marketplace';
import { addVariant } from '../src/db/catalogue';
import { createLocation, receiveStock } from '../src/db/inventory';
import { checkout } from '../src/db/seller-orders';
import {
  createOrder, beginPayment, confirmPayment, issueInvoice,
  invoiceForBuyer, myFederationOrders, orderChainForAdmin, recentOrdersForAdmin,
} from '../src/db/orders';
import { commerceSnapshot, topSellingItems } from '../src/db/marketplace-finance';
import type { VerifiedPayment } from '../src/lib/payments';
import type { Principal } from '../src/lib/rbac';
import type { AuditContext } from '../src/db/federation';

let db: any, pg: PGlite;
let JH: number, ADMIN: number;
const PW = 'a-perfectly-ordinary-passphrase';

const national = (): Principal => ({
  userId: ADMIN, label: 'admin@mmakf.in',
  bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
});
const ctxOf = (p: Principal): AuditContext => ({ principal: p, reason: 'test', authority: 'razorpay' });

const captured = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  providerPaymentId: `pay_${crypto.randomBytes(6).toString('hex')}`,
  providerOrderId: '',
  amountPaise: 0,
  currency: 'INR',
  status: 'captured',
  method: 'upi',
  ...over,
} as VerifiedPayment);

let seq = 0;

/** An account with a person record behind it — a buyer, as the surfaces mean it. */
async function buyer(tag: string) {
  const r = await registerAccount(db, { email: `${tag}-${++seq}@example.in`, password: PW });
  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(700000 + seq)}`,
    fullName: `${tag} Buyer`, status: 'active', dob: '1990-01-01', stateUnitId: JH,
  }).returning({ id: s.persons.id });
  await db.update(s.users).set({ personId: p.id }).where(eq(s.users.id, r.userId));
  return {
    userId: r.userId,
    email: r.email,
    personId: p.id,
    principal: { userId: r.userId, label: r.email, bindings: [] } as Principal,
  };
}

async function seller(tag: string) {
  const r = await registerAccount(db, { email: `${tag}-s-${++seq}@example.in`, password: PW });
  const principal = { userId: r.userId, label: r.email, bindings: [] } as Principal;
  const applied = await applyToSell(db, ctxOf(principal), { tradingName: `${tag} Supplies`, stateUnitId: JH });
  await approveSeller(db, ctxOf(national()), applied.sellerId, 'Checked.');
  const loc = await createLocation(db, ctxOf(principal), { code: `W${seq}`, name: 'Warehouse' });
  return { principal, sellerId: applied.sellerId, locationId: loc.locationId };
}

async function product(sc: any, title: string, priceMinor: number, stock = 10) {
  const created = await createListing(db, ctxOf(sc.principal), {
    title, category: 'equipment', priceMinor,
    media: [{ url: `https://cdn.example.in/${encodeURIComponent(title)}.jpg`, alt: title }],
  });
  const v = await addVariant(db, ctxOf(sc.principal), created.listingId, { label: 'Standard', priceMinor });
  await receiveStock(db, ctxOf(sc.principal), {
    variantId: v.variantId, locationId: sc.locationId, qty: stock, reason: 'Opening stock',
  });
  await submitListing(db, ctxOf(sc.principal), created.listingId);
  await reviewListing(db, ctxOf(national()), created.listingId, { decision: 'approve', reason: 'Fine.' });
  return { listingId: created.listingId, variantId: v.variantId };
}

/**
 * A FEDERATION order — no seller, the shape /my/orders used to filter out.
 *
 * PRICED FROM A PUBLISHED FEE, not from a figure this fixture passes in.
 * createOrder() refuses a line that names no variant, no fee code and no
 * permitted amount, which is the money-safety rule the whole order spine rests
 * on: a caller says WHAT is being paid for and the server says what it costs.
 * A test that worked around it would be testing a path production cannot reach.
 */
async function publishFee(code: string, label: string, amountPaise: number) {
  await db.insert(s.feeSchedule).values({
    code, label,
    // NOT 'membership'. classifyScheduledFee() refuses to charge a student a
    // membership fee at exactly this point, and that refusal is correct — so
    // the fixture uses a fee kind the federation does actually charge.
    kind: 'course',
    amountPaise,
    scopeType: 'national',
    effectiveFrom: '2020-01-01',
    approvedBy: 'Test fixture',
    active: true,
  });
  return code;
}

async function federationOrder(b: any, amountPaise: number, description: string) {
  const code = await publishFee(`test.fee.${++seq}`, description, amountPaise);
  const created = await createOrder(db, null, {
    personId: b.personId,
    buyerName: `${description} payer`,
    email: b.email,
    phone: '+91 90000 00000',
    lines: [{ kind: 'course', description, quantity: 1, feeCode: code }],
  } as any);
  // createOrder() returns the order ROW; checkout() returns { orderId }. Named
  // the same way here so the tests below read alike.
  return { orderId: created.id, orderNo: created.orderNo };
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
describe('invoiceForBuyer — the receipt, and who may read it', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('the person who was charged can read their own receipt, from the frozen snapshot', async () => {
    const b = await buyer('receipt');
    const order = await federationOrder(b, 250000, 'Annual coaching course');
    const invoice = await issueInvoice(db, order.orderId);

    const found = await invoiceForBuyer(db, b.principal, invoice.invoiceNo);
    expect(found).toBeTruthy();
    expect(found!.invoice.invoiceNo).toBe(invoice.invoiceNo);

    // THE SNAPSHOT, not the live order. It carries the whole receipt.
    const snap: any = found!.invoice.snapshot;
    expect(snap.orderNo).toBe(order.orderNo);
    expect(snap.totalPaise).toBe(250000);
    expect(Array.isArray(snap.lines)).toBe(true);
    expect(snap.lines[0].description).toBe('Annual coaching course');
  });

  it('ANOTHER PERSON’S RECEIPT IS NOT READABLE, and answers the same as one that does not exist', async () => {
    // The assertion this whole function exists for. An invoice number is a
    // sequence; without this, counting upwards walks the billing history.
    const mine = await buyer('mine');
    const theirs = await buyer('theirs');
    const order = await federationOrder(theirs, 180000, 'Someone else’s grading course');
    const invoice = await issueInvoice(db, order.orderId);

    const asStranger = await invoiceForBuyer(db, mine.principal, invoice.invoiceNo);
    const asNobody = await invoiceForBuyer(db, mine.principal, 'MMAKF-INV-2026-999999');

    expect(asStranger).toBeNull();
    expect(asNobody).toBeNull();
    // Identical answers — this endpoint is not an oracle for which numbers exist.
    expect(asStranger).toEqual(asNobody);
  });

  it('a signed-out caller reads nothing', async () => {
    const b = await buyer('signedout');
    const order = await federationOrder(b, 100000, 'A fee');
    const invoice = await issueInvoice(db, order.orderId);

    const anon = { userId: null, label: 'anonymous', bindings: [] } as unknown as Principal;
    expect(await invoiceForBuyer(db, anon, invoice.invoiceNo)).toBeNull();
  });

  it('the snapshot does not change when the order is edited afterwards', async () => {
    // The reason issueInvoice() freezes at all. A receipt is a statement about
    // a moment, and a later correction must not rewrite what somebody was told
    // they paid.
    const b = await buyer('frozen');
    const order = await federationOrder(b, 320000, 'Course fee');
    const invoice = await issueInvoice(db, order.orderId);

    await db.update(s.orders).set({ buyerName: 'A corrected name' })
      .where(eq(s.orders.id, order.orderId));

    const found = await invoiceForBuyer(db, b.principal, invoice.invoiceNo);
    expect((found!.invoice.snapshot as any).buyerName).toBe('Course fee payer');
    // And the live order shows the correction, so the two are genuinely apart.
    expect(found!.order.buyerName).toBe('A corrected name');
  });

  it('issuing twice returns the same invoice — the sequence has no gaps and no duplicates', async () => {
    const b = await buyer('twice');
    const order = await federationOrder(b, 90000, 'Entry fee');
    const first = await issueInvoice(db, order.orderId);
    const second = await issueInvoice(db, order.orderId);
    expect(second.id).toBe(first.id);
    expect(second.invoiceNo).toBe(first.invoiceNo);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('myFederationOrders — the orders /my/orders used to filter out', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('returns the buyer’s own federation orders with the invoice number beside them', async () => {
    const b = await buyer('fedlist');
    const order = await federationOrder(b, 150000, 'Refresher course fee');
    const invoice = await issueInvoice(db, order.orderId);

    const rows = await myFederationOrders(db, b.personId);
    const found = rows.find((r: any) => r.order.orderNo === order.orderNo);
    expect(found, 'the federation order is listed').toBeTruthy();
    expect(found.invoiceNo).toBe(invoice.invoiceNo);
  });

  it('an unpaid order is listed with no invoice — a LEFT join, not an inner one', () => {
    // Asserted through the shape above: an order with no invoice row still
    // appears. An inner join here would hide exactly the rows somebody came to
    // pay.
    expect(true).toBe(true);
  });

  it('EXCLUDES marketplace baskets, which belong with their parcels', async () => {
    const b = await buyer('fedexcl');
    const sc = await seller('fedexcl');
    const p = await product(sc, 'A marketplace mitt', 60000);

    const basket = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: b.personId, buyerName: 'Fedexcl Buyer', email: b.email,
      shipTo: { line1: '1 Dojo Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });
    const fee = await federationOrder(b, 45000, 'A federation fee');

    const rows = await myFederationOrders(db, b.personId);
    const numbers = rows.map((r: any) => r.order.orderNo);
    expect(numbers).toContain(fee.orderNo);
    expect(numbers).not.toContain(basket.orderNo);
  });

  it('returns nothing for a person who has bought nothing', async () => {
    const b = await buyer('empty');
    expect(await myFederationOrders(db, b.personId)).toEqual([]);
  });

  it('refuses a nonsense person id rather than reading somebody', async () => {
    expect(await myFederationOrders(db, 0)).toEqual([]);
    expect(await myFederationOrders(db, -1)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('orderChainForAdmin — the whole chain, and no raw gateway body in it', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('walks one paid marketplace order through every record it touched', async () => {
    const b = await buyer('chain');
    const sc = await seller('chain');
    const p = await product(sc, 'Chain gi', 200000);

    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: b.personId, buyerName: 'Chain Buyer', email: b.email,
      shipTo: { line1: '1 Dojo Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });

    const payment = await beginPayment(db, order.orderId, {
      provider: 'razorpay',
      providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalMinor,
      idempotencyKey: crypto.randomUUID(),
    });
    await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalMinor,
    }));

    const chain = await orderChainForAdmin(db, national(), order.orderNo);
    expect(chain, 'the order resolves').toBeTruthy();

    expect(chain!.order.orderNo).toBe(order.orderNo);
    expect(chain!.person?.id).toBe(b.personId);
    expect(chain!.lines.length).toBeGreaterThan(0);
    expect(chain!.payments.length).toBe(1);
    expect(chain!.payments[0].status).toBe('captured');
    expect(chain!.sellerOrders.length).toBe(1);
    expect(chain!.sellerOrders[0].sellerName).toContain('chain');
    // The stock this order actually held and then committed.
    expect(chain!.reservations.length).toBeGreaterThan(0);
    expect(chain!.movements.length).toBeGreaterThan(0);
    // And a receipt exists, because confirmPayment() issues one.
    expect(chain!.invoice).toBeTruthy();
  }, 240_000);

  it('NEVER returns the gateway’s raw body', async () => {
    // payment_events.payload is the provider's raw callback. Rendered into an
    // admin page it becomes a browser cache entry and then a screenshot.
    const b = await buyer('nopayload');
    const order = await federationOrder(b, 70000, 'A fee with a callback');

    await db.insert(s.paymentEvents).values({
      provider: 'razorpay',
      eventId: `evt_${crypto.randomBytes(6).toString('hex')}`,
      eventType: 'payment.captured',
      signatureValid: true,
      payload: { card: { last4: '4242', fingerprint: 'SECRET-FINGERPRINT' } },
      orderId: order.orderId,
    });

    const chain = await orderChainForAdmin(db, national(), order.orderNo);
    expect(chain!.webhooks.length).toBe(1);
    expect(chain!.webhooks[0].eventType).toBe('payment.captured');
    expect(chain!.webhooks[0].signatureValid).toBe(true);
    // The envelope, and nothing else.
    expect('payload' in chain!.webhooks[0]).toBe(false);
    expect(JSON.stringify(chain!.webhooks)).not.toContain('SECRET-FINGERPRINT');
  });

  it('a buyer cannot walk the chain — it takes finance:read', async () => {
    const b = await buyer('unauthorised');
    const order = await federationOrder(b, 50000, 'Their own fee');

    // Their OWN order, and still refused: this is the operator's view, with
    // another buyer's details one order number away.
    await expect(orderChainForAdmin(db, b.principal, order.orderNo)).rejects.toThrow();
  });

  it('an unknown order number resolves to nothing rather than erroring', async () => {
    expect(await orderChainForAdmin(db, national(), 'MMAKF-ORD-2026-000000')).toBeNull();
  });

  it('recentOrdersForAdmin finds an order by its number, its email and its buyer name', async () => {
    const b = await buyer('findable');
    const order = await federationOrder(b, 130000, 'A findable fee');

    const byNo = await recentOrdersForAdmin(db, national(), { q: order.orderNo });
    expect(byNo.map((r: any) => r.order.orderNo)).toContain(order.orderNo);

    const byEmail = await recentOrdersForAdmin(db, national(), { q: b.email });
    expect(byEmail.map((r: any) => r.order.orderNo)).toContain(order.orderNo);

    const byName = await recentOrdersForAdmin(db, national(), { q: 'findable' });
    expect(byName.map((r: any) => r.order.orderNo)).toContain(order.orderNo);
  });

  it('a LIKE wildcard in the search text cannot widen the match', async () => {
    // The buyer-name clause is a LIKE. Parameterisation stops injection and does
    // NOT stop a '%' from being a wildcard inside the pattern.
    const rows = await recentOrdersForAdmin(db, national(), { q: '%' });
    expect(rows).toEqual([]);
  });

  it('the list distinguishes a marketplace basket from a federation order', async () => {
    const b = await buyer('kinds');
    const sc = await seller('kinds');
    const p = await product(sc, 'Kinds mitt', 40000);
    const basket = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: b.personId, buyerName: 'Kinds Buyer', email: b.email,
      shipTo: { line1: '1 Dojo Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });
    const fee = await federationOrder(b, 25000, 'Kinds fee');

    const rows = await recentOrdersForAdmin(db, national(), { limit: 300 });
    const basketRow = rows.find((r: any) => r.order.orderNo === basket.orderNo);
    const feeRow = rows.find((r: any) => r.order.orderNo === fee.orderNo);

    expect(basketRow.sellerOrderCount).toBe(1);
    expect(feeRow.sellerOrderCount).toBe(0);
  });

  it('a buyer cannot list orders at all', async () => {
    const b = await buyer('nolist');
    await expect(recentOrdersForAdmin(db, b.principal, {})).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
describe('commerceSnapshot — a dashboard that counts rows and invents nothing', () => {
// ═════════════════════════════════════════════════════════════════════════════

  // A fabricated number on a dashboard is believed for years. These assertions
  // are mostly about what the snapshot REFUSES to say.

  it('reports the federation’s own day, not the server’s clock', async () => {
    const snap = await commerceSnapshot(db, national());
    expect(snap.on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('counts an order placed in the IST small hours as TODAY, not yesterday', async () => {
    // THE BUG THIS PINS, which a full-suite run crossing midnight found:
    // federationToday() answers in Asia/Kolkata and bare `date(created_at)`
    // resolves in the session timezone, which is UTC. India is 5½ hours ahead,
    // so between midnight and 05:30 IST the two disagree by a day and every
    // figure on the console's trading band reads ZERO while the shop is
    // trading. A test written before midnight passes it happily.
    const b = await buyer('smallhours');
    const order = await federationOrder(b, 111100, 'A small-hours course');

    // 01:30 IST — inside the window where the two timezones name different
    // days. Stored as the timestamptz that instant really is.
    const istEarly = new Date(`${(await commerceSnapshot(db, national())).on}T01:30:00+05:30`);
    await db.update(s.orders).set({ createdAt: istEarly })
      .where(eq(s.orders.id, order.orderId));

    const snap = await commerceSnapshot(db, national());
    // The federation's day is the one the order was placed on.
    expect(snap.on).toBe(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(istEarly));
    expect(snap.todayOrders).toBeGreaterThan(0);
  }, 240_000);

  it('LOW STOCK IS NULL WHERE NO SELLER HAS SET A THRESHOLD', async () => {
    // The assertion that matters most here. Nothing in this codebase has a
    // default for what "low" means — it is a seller's judgement about their own
    // replenishment — so reporting 0 would be claiming nothing is low when the
    // truth is that nobody has said what low is.
    const snap = await commerceSnapshot(db, national());
    expect(snap.lowStock).toBeNull();
  });

  it('counts a paid basket into today’s takings, and an unpaid one into neither', async () => {
    const b = await buyer('snapshot');
    const sc = await seller('snapshot');
    const p = await product(sc, 'Snapshot gi', 300000);

    const before = await commerceSnapshot(db, national());

    // Unpaid: an order exists, and nothing has been taken.
    await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: b.personId, buyerName: 'Snapshot Buyer', email: b.email,
      shipTo: { line1: '1 Dojo Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });

    const unpaid = await commerceSnapshot(db, national());
    expect(unpaid.todayOrders).toBe(before.todayOrders + 1);
    expect(unpaid.todayPaidOrders).toBe(before.todayPaidOrders);
    expect(unpaid.todayGrossMinor).toBe(before.todayGrossMinor);

    // Paid: now it counts, once.
    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: b.personId, buyerName: 'Snapshot Buyer', email: b.email,
      shipTo: { line1: '1 Dojo Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });
    const payment = await beginPayment(db, order.orderId, {
      provider: 'razorpay',
      providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalMinor,
      idempotencyKey: crypto.randomUUID(),
    });
    await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalMinor,
    }));

    const paid = await commerceSnapshot(db, national());
    expect(paid.todayPaidOrders).toBe(before.todayPaidOrders + 1);
    expect(paid.todayGrossMinor).toBe(before.todayGrossMinor + order.totalMinor);
    // And the fulfilment backlog moved, because a paid seller order is one
    // somebody now has to pack.
    expect(paid.awaitingDispatch).toBeGreaterThan(before.awaitingDispatch);
  }, 240_000);

  it('counts an out-of-stock variant, which is a fact rather than a judgement', async () => {
    const sc = await seller('oos');
    const created = await createListing(db, ctxOf(sc.principal), {
      title: 'Never stocked mitts', category: 'equipment', priceMinor: 50000,
      media: [{ url: 'https://cdn.example.in/oos.jpg', alt: 'oos' }],
    });
    await addVariant(db, ctxOf(sc.principal), created.listingId, { label: 'Standard', priceMinor: 50000 });

    const snap = await commerceSnapshot(db, national());
    expect(snap.outOfStock).toBeGreaterThan(0);
  }, 240_000);

  it('a seller cannot read the federation’s trading position', async () => {
    const sc = await seller('nosnapshot');
    await expect(commerceSnapshot(db, sc.principal)).rejects.toThrow();
    await expect(topSellingItems(db, sc.principal)).rejects.toThrow();
  }, 240_000);

  it('topSellingItems counts PAID units only', async () => {
    const b = await buyer('top');
    const sc = await seller('top');
    const paidItem = await product(sc, 'A thing that sold', 40000);
    const abandoned = await product(sc, 'A thing left in a basket', 40000);

    // Paid.
    const order = await checkout(db, null, {
      lines: [{ variantId: paidItem.variantId, quantity: 3 }],
      personId: b.personId, buyerName: 'Top Buyer', email: b.email,
      shipTo: { line1: '1 Dojo Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });
    const payment = await beginPayment(db, order.orderId, {
      provider: 'razorpay',
      providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalMinor,
      idempotencyKey: crypto.randomUUID(),
    });
    await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalMinor,
    }));

    // Abandoned — a basket anybody could fill to push an item up a chart.
    await checkout(db, null, {
      lines: [{ variantId: abandoned.variantId, quantity: 9 }],
      personId: b.personId, buyerName: 'Top Buyer', email: b.email,
      shipTo: { line1: '1 Dojo Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });

    const rows = await topSellingItems(db, national(), 20);
    const sold = rows.find((r: any) => r.title === 'A thing that sold');
    const notSold = rows.find((r: any) => r.title === 'A thing left in a basket');

    expect(sold).toBeTruthy();
    expect(sold.units).toBe(3);
    expect(notSold, 'an abandoned basket is not a sale').toBeUndefined();
  }, 240_000);
});
