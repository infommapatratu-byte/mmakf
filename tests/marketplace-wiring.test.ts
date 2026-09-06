// Does anything actually CALL it?
//
// ═════════════════════════════════════════════════════════════════════════════
// THE BUG CLASS THIS SUITE EXISTS FOR
// ═════════════════════════════════════════════════════════════════════════════
//
// Three defects in the marketplace shared one shape, and the third was found
// only by asking, of each export, who calls this:
//
//   1. Twenty-one event producers with no entry in EVENT_TYPES. publish()
//      refuses an unknown type, so each would have thrown on the first real
//      order. LOUD.
//
//   2. Entries catalogued above the notification drain's cap. consume() steps
//      over anything above 'member' WITHOUT erroring, so eight notices would
//      never have arrived. SILENT.
//
//   3. Producers, and onOrderPaid(), that NOTHING CALLED. No error, no missing
//      notice, no failing test — the suites called them directly and passed.
//      SILENT, and invisible to every check the first two taught us to run.
//
// (3) is the dangerous one, because a module can be complete, correct and fully
// tested while being unreachable from the application. `tests/money-safety.ts`
// is a repo-wide guard of the same kind; this is its equivalent for reachability.
//
// WHAT IS ASSERTED
//
//   · a real payment, confirmed through the real payment path, moves a
//     marketplace basket into fulfilment — not onOrderPaid() called by hand;
//   · every marketplace event producer has a caller in src/;
//   · the expiry sweep that releases marketplace stock has a caller.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { and, eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import { registerAccount } from '../src/db/onboarding';
import { applyToSell, approveSeller, createListing, submitListing, reviewListing } from '../src/db/marketplace';
import { addVariant } from '../src/db/catalogue';
import { createLocation, receiveStock, stockForSeller } from '../src/db/inventory';
import { checkout } from '../src/db/seller-orders';
import { beginPayment, confirmPayment } from '../src/db/orders';
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
const adminCtx = () => ctxOf(national());

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

async function seller(tag: string) {
  const r = await registerAccount(db, { email: `${tag}-${++seq}@example.in`, password: PW });
  const principal = { userId: r.userId, label: r.email, bindings: [] } as Principal;
  const applied = await applyToSell(db, ctxOf(principal), {
    tradingName: `${tag} Supplies`, contactEmail: `${tag}@shop.in`, stateUnitId: JH,
  });
  await approveSeller(db, adminCtx(), applied.sellerId, 'Checked.');

  const [p] = await db.insert(s.persons).values({
    federationId: `MMAKF-MEM-2026-${String(800000 + seq)}`,
    fullName: `${tag} Proprietor`, status: 'active', dob: '1985-01-01', stateUnitId: JH,
  }).returning({ id: s.persons.id });
  await db.update(s.sellers).set({ personId: p.id }).where(eq(s.sellers.id, applied.sellerId));

  const loc = await createLocation(db, ctxOf(principal), { code: `W${seq}`, name: 'Warehouse' });
  return { principal, sellerId: applied.sellerId, locationId: loc.locationId, personId: p.id };
}

async function product(sc: any, title: string, priceMinor: number, stock = 10) {
  const created = await createListing(db, ctxOf(sc.principal), {
    title, description: 'Plain, no federation marking.',
    category: 'equipment', priceMinor,
    media: [{ url: `https://cdn.example.in/${encodeURIComponent(title)}.jpg`, alt: title }],
  });
  const variant = await addVariant(db, ctxOf(sc.principal), created.listingId, {
    label: 'Standard', priceMinor,
  });
  await receiveStock(db, ctxOf(sc.principal), {
    variantId: variant.variantId, locationId: sc.locationId, qty: stock, reason: 'Opening stock',
  });
  await submitListing(db, ctxOf(sc.principal), created.listingId);
  await reviewListing(db, adminCtx(), created.listingId, {
    decision: 'approve', reason: 'Plain equipment.',
  });
  return { listingId: created.listingId, variantId: variant.variantId };
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
describe('A REAL PAYMENT moves a marketplace basket into fulfilment', () => {
// ═════════════════════════════════════════════════════════════════════════════

  it('confirmPayment() — not onOrderPaid() by hand — paid the sellers’ orders', async () => {
    const a = await seller('paid-a');
    const b = await seller('paid-b');
    const pa = await product(a, 'Wiring Mitts', 100_000);
    const pb = await product(b, 'Wiring Gi', 200_000);

    const buyer = (await db.insert(s.persons).values({
      federationId: `MMAKF-MEM-2026-${String(900000 + (++seq))}`,
      fullName: 'Wiring Buyer', status: 'active', dob: '1992-02-02', stateUnitId: JH,
    }).returning({ id: s.persons.id }))[0].id;

    const order = await checkout(db, null, {
      lines: [{ variantId: pa.variantId, quantity: 1 }, { variantId: pb.variantId, quantity: 1 }],
      personId: buyer, buyerName: 'Wiring Buyer', email: 'wiring@example.in',
      shipTo: { line1: '1 Dojo Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });
    expect(order.totalMinor).toBe(300_000);

    const before = await db.select().from(s.sellerOrders).where(eq(s.sellerOrders.orderId, order.orderId));
    expect(before).toHaveLength(2);
    for (const so of before) expect(['order_created', 'payment_pending']).toContain(so.status);

    // ── The real payment path. Nothing marketplace-specific is called here. ──
    const payment = await beginPayment(db, order.orderId, {
      provider: 'razorpay',
      providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalMinor,
      idempotencyKey: crypto.randomUUID(),
    });
    await confirmPayment(db, null, captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalMinor,
    }));

    // THE ASSERTION THE ABSENT CALL WOULD HAVE FAILED. Before the wiring these
    // stayed at payment_pending for ever, with the money taken.
    const after = await db.select().from(s.sellerOrders).where(eq(s.sellerOrders.orderId, order.orderId));
    expect(after).toHaveLength(2);
    for (const so of after) expect(so.status).toBe('paid');
    expect(after.every((x: any) => x.paidAt)).toBe(true);
  }, 240_000);

  it('committed the marketplace stock, and told each seller once', async () => {
    const sc = await seller('commit');
    const p = await product(sc, 'Commit Shield', 50_000, 5);

    const buyer = (await db.insert(s.persons).values({
      federationId: `MMAKF-MEM-2026-${String(910000 + (++seq))}`,
      fullName: 'Commit Buyer', status: 'active', dob: '1993-03-03', stateUnitId: JH,
    }).returning({ id: s.persons.id }))[0].id;

    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 2 }],
      personId: buyer, buyerName: 'Commit Buyer', email: 'commit@example.in',
      shipTo: { line1: '2 Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
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

    // Reserved became committed rather than staying held for ever.
    const stock = await stockForSeller(db, sc.principal);
    const row = stock.find((r: any) => Number(r.variantId) === Number(p.variantId));
    expect(row).toBeTruthy();
    expect(Number(row.committed)).toBe(2);
    expect(Number(row.reserved)).toBe(0);

    // And the seller was told, through the feed and the real audience resolver.
    const [so] = await db.select().from(s.sellerOrders).where(eq(s.sellerOrders.orderId, order.orderId));
    const paidEvents = await db.select().from(s.domainEvents)
      .where(eq(s.domainEvents.correlationId, `seller_order:${so.id}:paid`));
    expect(paidEvents).toHaveLength(1);
  }, 240_000);

  it('a replayed confirmation fulfils nothing twice', async () => {
    const sc = await seller('replay');
    const p = await product(sc, 'Replay Rope', 40_000, 5);
    const buyer = (await db.insert(s.persons).values({
      federationId: `MMAKF-MEM-2026-${String(920000 + (++seq))}`,
      fullName: 'Replay Buyer', status: 'active', dob: '1994-04-04', stateUnitId: JH,
    }).returning({ id: s.persons.id }))[0].id;

    const order = await checkout(db, null, {
      lines: [{ variantId: p.variantId, quantity: 1 }],
      personId: buyer, buyerName: 'Replay Buyer', email: 'replay@example.in',
      shipTo: { line1: '3 Road', city: 'Ramgarh', state: 'Jharkhand', postcode: '829122' },
    });
    const payment = await beginPayment(db, order.orderId, {
      provider: 'razorpay',
      providerOrderId: `order_${crypto.randomBytes(5).toString('hex')}`,
      amountPaise: order.totalMinor,
      idempotencyKey: crypto.randomUUID(),
    });
    const verified = captured({
      providerOrderId: payment.providerOrderId, amountPaise: order.totalMinor,
    });

    await confirmPayment(db, null, verified);
    // The gateway's retry, and the reconcile cron behind it.
    await confirmPayment(db, null, verified);

    const stock = await stockForSeller(db, sc.principal);
    const row = stock.find((r: any) => Number(r.variantId) === Number(p.variantId));
    expect(Number(row.committed)).toBe(1);      // not 2
    expect(Number(row.onHand)).toBe(5);
  }, 240_000);
});

// ═════════════════════════════════════════════════════════════════════════════
describe('REACHABILITY — a module nothing calls is not a built feature', () => {
// ═════════════════════════════════════════════════════════════════════════════

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) sourceFiles(p, out);
      else if (/\.(ts|astro|mjs)$/.test(e)) out.push(p);
    }
    return out;
  }

  /**
   * Every source file, read ONCE.
   *
   * The first version of this suite re-read all 397 files for each of twenty
   * producers — eight thousand reads, four minutes, and a wide window in which
   * a file being edited by anything else could be read half-written. It failed
   * in a full-suite run and passed alone, which is the signature of a test that
   * races rather than one that has found something. Read once, match many.
   */
  const CORPUS: ReadonlyArray<readonly [string, string]> = (() => {
    const files = sourceFiles('src');
    return files.map((f) => [f, readFileSync(f, 'utf8')] as const);
  })();

  const EVENTS_MODULE = join('src', 'db', 'marketplace-events.ts');

  /** Every producer this module exports. Read from the source, not listed here. */
  function producerNames(): string[] {
    const text = readFileSync(EVENTS_MODULE, 'utf8');
    return [...text.matchAll(/^export async function (publish\w+)/gm)]
      .map((m) => m[1])
      // The sweep calls publishLowStock() itself; it is the caller, not a gap.
      .filter((n) => n !== 'publishLowStock');
  }

  function callersOutside(name: string, skip: string[]): string[] {
    const re = new RegExp(`\\b${name}\\b`);
    return CORPUS
      .filter(([f]) => !skip.some((sk) => f.endsWith(sk)))
      .filter(([, src]) => re.test(src))
      .map(([f]) => f);
  }

  it('EVERY marketplace event producer is called from somewhere in src/', () => {
    // The guard that would have caught the whole thing. A producer with no
    // caller publishes nothing, for ever, and no other test can see it: the
    // suites that cover marketplace-events.ts call the producers themselves.
    const unreachable = producerNames()
      .filter((n) => callersOutside(n, [EVENTS_MODULE]).length === 0)
      // publishLowStockForSeller is the sweep. It has no caller BY DESIGN:
      // it takes a notice key because how often a seller is told their stock is
      // low is a decision MMAKF has not made, and choosing a cadence here would
      // be this system notifying real traders on its own authority.
      // LOW_STOCK_CADENCE_NOT_SET is the recorded reason.
      .filter((n) => n !== 'publishLowStockForSeller');

    expect(unreachable, `producers nothing calls: ${unreachable.join(', ')}`).toEqual([]);
  });

  it('the marketplace stock-expiry sweep is called by the cron', () => {
    // Abandoned baskets held `stock_reservations` for ever while this had no
    // caller: available quantity fell with every abandoned checkout and never
    // recovered, with no error and nothing in any queue.
    const callers = callersOutside('releaseExpiredReservations', [join('src', 'db', 'inventory.ts')]);
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.some((f) => f.includes('cron'))).toBe(true);
  });

  it('the marketplace fulfilment step is called by the payment path', () => {
    const callers = callersOutside('onOrderPaid', [join('src', 'db', 'seller-orders.ts')]);
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.some((f) => f.endsWith(join('db', 'orders.ts')))).toBe(true);
  });
});
