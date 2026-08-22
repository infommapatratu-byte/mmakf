// Order and payment operations (§15-18, §49-52).
//
// The rule this module exists to enforce: an order becomes PAID only when a
// payment is confirmed CAPTURED from the provider's own record, for the amount
// we asked for, in the currency we asked for. Not when the customer returns
// from a payment page, not when the browser says so, not when someone reports
// it on WhatsApp.

import { and, eq, gte, isNull, lte, or, sql, desc } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from './schema';
import { writeAudit, type AuditContext } from './federation';
import { isUniqueViolation } from './pgerror';
import { assertCan, assertCanAnywhere, type Principal } from '@/lib/rbac';
import type { VerifiedPayment } from '@/lib/payments';
// The single sanctioned tax rounding. Inlining `Math.round((total * bps) /
// 10_000)` here was a second implementation of the same arithmetic in float —
// see the note on taxOnMinor() for why that is a liability even while it agrees.
import { taxOnMinor } from './fees';
import { classifyScheduledFee } from './student-rule';

/**
 * Order-line kinds that buy STANDING WITH THE FEDERATION rather than a thing.
 *
 * Stated here as well as read as text by src/db/student-rule.ts, because the
 * merchandise branch of createOrder() needs the structural fact on its own: a
 * product variant carries `stock_qty` and a reservation, and standing cannot be
 * stocked. That refusal is about the SHAPE of the line and holds whatever the
 * item happens to be called.
 */
const STANDING_LINE_KINDS = new Set(['membership', 'affiliation']);

type DB = any;

// ─── Money ──────────────────────────────────────────────────────────────────

/**
 * All arithmetic is integer paise. Rupee values only ever appear at the edges,
 * for display, and are formatted from paise — never parsed back into one.
 */
export function paise(rupees: number): number {
  return Math.round(rupees * 100);
}

/**
 * Today, in the FEDERATION'S OWN timezone.
 *
 * `new Date().toISOString().slice(0, 10)` is the UTC date, and India runs 5½
 * hours ahead of UTC: between midnight and 05:30 IST it names YESTERDAY. Two
 * things in this module are dated, and both were dated that way.
 *
 *   · `ledger_entries.occurred_on`, which /admin/revenue sums BETWEEN TWO DATES
 *     COMPUTED IN Asia/Kolkata. A capture at 02:00 IST on 1 April posted to
 *     31 March — the previous FINANCIAL YEAR — and the treasurer's report for
 *     the year it belonged to was short by exactly that payment.
 *   · the fee window below, where "is this fee in force today" has to be asked
 *     in the timezone the federation publishes its fees in.
 *
 * Exported, and src/db/revenue.ts's `todayInIndia` is now this function, so the
 * date a ledger row is WRITTEN with and the date it is READ BETWEEN can never
 * drift apart again.
 */
export function federationToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function formatINR(amountPaise: number): string {
  const sign = amountPaise < 0 ? '-' : '';
  const abs = Math.abs(amountPaise);
  const rupees = Math.floor(abs / 100);
  const p = String(abs % 100).padStart(2, '0');
  // Indian digit grouping: 12,34,567.89 — not 1,234,567.89.
  const str = String(rupees);
  const last3 = str.slice(-3);
  const rest = str.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${sign}₹${grouped}.${p}`;
}

// ─── Order numbers ──────────────────────────────────────────────────────────

async function nextOrderNo(db: DB, year = new Date().getFullYear()): Promise<string> {
  await db.insert(s.idSequences).values({ prefix: 'ORD', year, next: 1 })
    .onConflictDoNothing({ target: [s.idSequences.prefix, s.idSequences.year] });
  const rows = await db.update(s.idSequences)
    .set({ next: sql`${s.idSequences.next} + 1` })
    .where(and(eq(s.idSequences.prefix, 'ORD'), eq(s.idSequences.year, year)))
    .returning({ next: s.idSequences.next });
  return `MMAKF-ORD-${year}-${String((rows[0]?.next ?? 1) - 1).padStart(6, '0')}`;
}

/**
 * Invoice numbers run in their own unbroken sequence.
 *
 * Deliberately separate from order numbers: orders are abandoned before payment
 * all the time, and a tax document series with gaps in it is a problem at audit.
 */
async function nextInvoiceNo(db: DB, year = new Date().getFullYear()): Promise<string> {
  await db.insert(s.idSequences).values({ prefix: 'INV', year, next: 1 })
    .onConflictDoNothing({ target: [s.idSequences.prefix, s.idSequences.year] });
  const rows = await db.update(s.idSequences)
    .set({ next: sql`${s.idSequences.next} + 1` })
    .where(and(eq(s.idSequences.prefix, 'INV'), eq(s.idSequences.year, year)))
    .returning({ next: s.idSequences.next });
  return `MMAKF/${year}/${String((rows[0]?.next ?? 1) - 1).padStart(5, '0')}`;
}

// ─── Order creation ─────────────────────────────────────────────────────────

export interface DraftLine {
  // 'training' was added by migration 0045: a STUDENT'S own training, as
  // opposed to 'membership' (which students do not buy) and 'program' (which is
  // an institution's contracted block). Its own kind rather than 'other',
  // because postLedger() posts income under this column and because
  // src/db/training-products.ts filters on it to find the lines it must turn
  // into a right to train — a training line billed as 'other' would be paid for,
  // undelivered, and invisible in both places built to notice.
  kind: 'product' | 'membership' | 'affiliation' | 'event_entry' | 'grading' | 'course' | 'certificate' | 'donation' | 'training' | 'program' | 'other';
  description: string;
  quantity?: number;
  /** Omit for catalogue/fee lines — the price is then read from the server. */
  unitPricePaise?: number;
  variantId?: number;
  feeCode?: string;
  /**
   * An ISSUED-AND-ACCEPTED quote version this line pays for.
   *
   * A THIRD server-priced path, alongside `variantId` (the catalogue) and
   * `feeCode` (the published fee schedule), and it obeys the same rule as both:
   * the caller names WHAT is being paid for and the price is read here.
   *
   * The price read is the FROZEN one on the quote version — `subtotal_minor +
   * adjustment_minor` for the line and `tax_minor` for its tax, which sum back
   * to `total_minor` by construction. Nothing is recomputed from the fee
   * framework. That is the whole point: a school that accepted ₹4,80,000 in
   * March is charged ₹4,80,000 in June, whatever the federation has published
   * since, and tests/fees.test.ts already asserts the property one step
   * upstream.
   *
   * See src/db/quote-to-order.ts, which is the only caller and which checks
   * acceptance, approval and expiry before it gets here. The checks below are
   * repeated rather than trusted to it, because this is the function that
   * decides what somebody is charged.
   */
  quoteVersionId?: number;
  refType?: string;
  refId?: number;
  taxRateBps?: number;
}

export interface DraftOrder {
  personId?: number | null;
  buyerName?: string;
  email?: string;
  phone?: string;
  lines: DraftLine[];
  shipTo?: Record<string, unknown> | null;
  shippingPaise?: number;
}

export class OrderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OrderError';
    this.code = code;
  }
}

/**
 * Create an order, pricing it ENTIRELY on the server.
 *
 * A client-supplied price is never trusted for anything in the catalogue or the
 * fee schedule — that is the oldest e-commerce attack there is. A caller may
 * only name what they are buying; what it costs is looked up here.
 */
export async function createOrder(db: DB, ctx: AuditContext | null, draft: DraftOrder) {
  if (!Array.isArray(draft.lines) || draft.lines.length === 0) {
    throw new OrderError('empty', 'An order must contain at least one line');
  }
  if (draft.lines.length > 50) {
    throw new OrderError('too_many_lines', 'An order may contain at most 50 lines');
  }

  const priced: any[] = [];
  let subtotal = 0;
  let tax = 0;

  // ── When a quotation is what is being paid for ──
  //
  // A quote-derived order reserves no stock, so the 45-minute reservation
  // release below has nothing to release, and applying it would EXPIRE a
  // school's invoice three quarters of an hour after it was raised —
  // expireStaleOrders() cancels anything still `awaiting_payment` past its
  // `expiresAt`. What actually governs is the quotation's own validity, so that
  // is what the order takes. `null` when the federation set no validity: an
  // offer with no stated end date does not acquire one here.
  let quoteValidUntil: string | null = null;
  let quotePriced = false;

  for (const line of draft.lines) {
    const qty = Number.isInteger(line.quantity) ? line.quantity! : 1;
    if (qty < 1 || qty > 99) throw new OrderError('bad_quantity', 'Quantity must be between 1 and 99');

    // ── A QUOTATION LINE IS PRICED AND PUSHED HERE, AND SKIPS THE REST ──
    //
    // Handled before the catalogue chain and returned from with `continue`,
    // rather than folded into the shared arithmetic below, for one reason: the
    // shared arithmetic DERIVES a tax from a rate, and a quotation's tax is not
    // derived — it is part of a total somebody already accepted. Threading a
    // "unless it is frozen" exception through the common path would have put a
    // conditional inside the one calculation in this function that every other
    // kind of line depends on. This branch computes nothing; it copies.
    if (line.quoteVersionId != null) {
      // A caller that names both a quote version and a catalogue item has a bug,
      // and the frozen figure is the one that must win — silently pricing from
      // the catalogue instead would charge a school something it never agreed to.
      if (line.variantId != null || line.feeCode) {
        throw new OrderError(
          'ambiguous_line',
          'A line names both a quotation and a catalogue item. A quoted figure and a catalogue price are two different amounts and this function will not choose between them.'
        );
      }
      // A quotation is agreed once, as a whole. Multiplying it by a quantity
      // would be the caller inventing a price out of one the federation issued.
      if (qty !== 1) {
        throw new OrderError('bad_quantity', 'A quotation is paid once. It has no quantity to multiply.');
      }

      const qv = (await db.select().from(s.quoteVersions)
        .where(eq(s.quoteVersions.id, line.quoteVersionId)).limit(1))[0];
      if (!qv) throw new OrderError('unknown_quote_version', 'No such quotation version');

      // THE HONEST STATE, and today the only reachable one. A quotation nothing
      // could price carries no figure at all — never a zero, which would read
      // as free — so there is nothing here to charge for.
      if (qv.requiresManualQuote) {
        throw new OrderError(
          'quote_has_no_figure',
          'That quotation carries no figure: the federation has not published a fee covering it, so the office prepares it by hand. There is nothing to charge.'
        );
      }
      // Repeated from src/db/quote-to-order.ts on purpose. This is the function
      // that decides what somebody is charged, and it does not delegate the
      // question of whether they ever agreed to be.
      if (qv.status !== 'accepted') {
        throw new OrderError(
          'quote_not_accepted',
          `That quotation is ${qv.status}. Only an accepted quotation can be charged for.`
        );
      }
      if (qv.currency !== 'INR') {
        // The order spine accounts in INR paise throughout. Billing a USD
        // quotation through it would charge the number without the currency.
        throw new OrderError(
          'quote_currency_unsupported',
          `That quotation is in ${qv.currency}. Orders are raised in INR, and this system will not treat one currency's figure as another's.`
        );
      }

      // subtotal + adjustment + tax = total, by construction in computeFee().
      // Asserted rather than assumed: if the three stored figures do not add up
      // then something wrote this row that was not the fee engine, and the
      // right response to that is to refuse rather than to pick two of them.
      const net = qv.subtotalMinor + qv.adjustmentMinor;
      const quoteTax = qv.taxMinor;
      if (!Number.isInteger(net) || !Number.isInteger(quoteTax) || net + quoteTax !== qv.totalMinor) {
        throw new OrderError(
          'quote_not_reconcilable',
          'That quotation\'s stored subtotal, adjustment and tax do not add up to its total. Refusing to charge a figure this system cannot reconstruct.'
        );
      }
      if (qv.totalMinor <= 0) {
        throw new OrderError(
          'quote_has_no_figure',
          'That quotation totals nothing. A zero would be charged as free, which is not something the federation has agreed.'
        );
      }

      quotePriced = true;
      quoteValidUntil = (qv.validUntil as string | null) ?? quoteValidUntil;

      const quoteDescription = String(line.description ?? '').slice(0, 300)
        || `Quotation ${qv.frameworkCode} v${qv.version}`;

      // ── THE THIRD PRICE SOURCE, JUDGED LIKE THE OTHER TWO ──
      //
      // A quotation is computed by the fee framework, which addRule() and
      // publishFramework() already guard — so on the sanctioned path this can
      // never fire, and src/db/quote-to-order.ts (the only caller) passes kind
      // 'other' with a description it composes itself.
      //
      // It is here for the row nobody composed. `quote_versions` carries a
      // total and no line detail, so what an INVOICE ends up SAYING is the
      // caller's `description` and the caller's `kind`. A directly inserted
      // 'accepted' quote version, paid for by a line calling itself a junior
      // membership, would put that sentence and that figure on a federation
      // receipt without any framework having agreed to it. Every line this
      // function prices is now read before it is charged, and this was the last
      // one that was not.
      const quoteVerdict = classifyScheduledFee({
        code: null, label: quoteDescription, kind: line.kind,
      });
      if (quoteVerdict.studentCharge) {
        throw new OrderError('student_charge_refused', quoteVerdict.refusal as string);
      }

      subtotal += net;
      tax += quoteTax;
      priced.push({
        kind: line.kind, variantId: null, feeCode: null,
        // refType/refId are set HERE and overwrite whatever the caller passed.
        // A line that is paying for a quotation must say so in the one place a
        // reconciliation query looks, and letting a caller relabel it would
        // break the tie-back the invoice depends on.
        refType: 'quote_version', refId: line.quoteVersionId,
        description: quoteDescription,
        quantity: 1,
        unitPricePaise: net,
        // ZERO, and not the rate that produced `quoteTax`. A rate stored beside
        // a frozen amount is an invitation to recompute one from the other, and
        // the whole point of this line is that nothing recomputes it.
        taxRateBps: 0,
        taxPaise: quoteTax,
        totalPaise: qv.totalMinor,
      });
      continue;
    }

    let unit: number;
    let description = String(line.description ?? '').slice(0, 300);
    let taxRateBps = 0;

    if (line.variantId != null) {
      const v = (await db.select().from(s.productVariants).where(eq(s.productVariants.id, line.variantId)).limit(1))[0];
      if (!v || v.status !== 'active') throw new OrderError('unavailable', 'That item is not available');
      if (v.stockQty - v.reservedQty < qty) throw new OrderError('out_of_stock', `Only ${Math.max(0, v.stockQty - v.reservedQty)} left of ${v.label}`);

      const product = (await db.select().from(s.products).where(eq(s.products.id, v.productId)).limit(1))[0];
      unit = v.pricePaise;
      taxRateBps = product?.taxRateBps ?? 0;
      description = `${product?.name ?? 'Item'} — ${v.label}`;

      // ── STANDING IS NOT STOCK ──
      //
      // Before any question of wording. A variant carries `stock_qty` and a
      // reservation, and standing with a federation cannot be stocked — there
      // is no such thing as forty memberships on a shelf. A line claiming to buy
      // membership or affiliation out of the merchandise catalogue is malformed
      // whatever the item is called, so this refuses on the SHAPE of the request
      // and needs to read no names at all.
      //
      // `line.kind` is a caller's word and the check below is right not to trust
      // it in the permissive direction. This one only ever refuses: a caller who
      // sends 'product' does not escape anything, because the catalogue's own
      // words are read immediately afterwards.
      if (STANDING_LINE_KINDS.has(String(line.kind))) {
        throw new OrderError(
          'standing_is_not_stock',
          `A '${line.kind}' line cannot be priced from the merchandise catalogue. ` +
          'Standing with the federation is not an item with stock — it is bought from the published fee ' +
          'schedule, which is where the rule that a student pays no membership fee is enforced.'
        );
      }

      // ── THE SAME REFUSAL, ONE TABLE ACROSS ──
      //
      // The shop catalogue is a third register that can charge somebody, and a
      // withdrawn fee does not care which table it is sold from: a product
      // called 'Junior Membership 2026' with a ₹500 variant is the student
      // subscription with a barcode on it. Guarded here so the refusal does not
      // depend on which page an operator happened to use.
      //
      // NARROWER THAN THE FEE REGISTER, DELIBERATELY. `fee_schedule` is refused
      // on all three verdicts including 'it never says who pays', because a fee
      // that cannot name its payer should not charge one. A MERCHANDISE name is
      // not written to that standard — 'membership certificate frame' and
      // 'member handbook' are goods, and refusing them would block the shop
      // while looking like a safety feature, which is how a guard gets deleted.
      // So only a POSITIVE identification of a student payer refuses here.
      // The product's OWN name, SKU and variant label — catalogue rows an
      // operator wrote. `line.kind` is deliberately NOT passed HERE: it is
      // whatever the browser said, and a caller who could set it could evade
      // this check by sending 'product'. The caller's word is used only by the
      // structural refusal above, which it can trip but never escape.
      const shopVerdict = classifyScheduledFee({
        // The SKU counts too. 'MEM-JR-2026' is a name; it is just a name typed
        // by somebody who expected only machines to read it.
        code: product?.sku ?? null, label: description, kind: null,
      });
      if (
        shopVerdict.studentCharge
        && shopVerdict.refusalCode !== 'unattributed_standing_charge'
      ) {
        throw new OrderError('student_charge_refused', shopVerdict.refusal as string);
      }
    } else if (line.feeCode) {
      // ── THE ROW IN FORCE TODAY, NOT MERELY THE NEWEST ONE MARKED ACTIVE ──
      //
      // `fee_schedule` is a DATED register. `effective_from` is how the
      // federation enters next year's fee in advance — which is the only way a
      // fee change can be approved before it applies — and `effective_to` is
      // how it closes one that has been superseded. This query read neither.
      //
      // `order by effective_from desc limit 1` therefore picked the FUTURE row
      // the moment it was entered: a fee approved in August to take effect next
      // April sorts first, and every payer between August and April was charged
      // next April's price. The mirror of it is as bad — a fee closed in 2022
      // went on charging for as long as nobody remembered to unset `active`,
      // because `active` is a switch and `effective_to` is a date, and the two
      // say different things.
      //
      // Neither figure has any authority behind it on the day it is taken,
      // which makes it the same defect as inventing one. The window is applied
      // in SQL and the newest row INSIDE it wins; where nothing is in force the
      // refusal is the ordinary "the federation has not published this", never a
      // fallback to a lapsed price and never a zero.
      const today = federationToday();
      const fee = (await db.select().from(s.feeSchedule)
        .where(and(
          eq(s.feeSchedule.code, line.feeCode),
          eq(s.feeSchedule.active, true),
          lte(s.feeSchedule.effectiveFrom, today),
          or(isNull(s.feeSchedule.effectiveTo), gte(s.feeSchedule.effectiveTo, today)),
        ))
        .orderBy(desc(s.feeSchedule.effectiveFrom)).limit(1))[0];
      // §68: a fee the federation has not published is not invented here.
      if (!fee) {
        // Distinguish "never published" from "published for another period", so
        // an operator who has entered next year's fee is told that is what has
        // happened rather than hunting for a row that is sitting in front of them.
        const outside = (await db.select({ id: s.feeSchedule.id }).from(s.feeSchedule)
          .where(and(eq(s.feeSchedule.code, line.feeCode), eq(s.feeSchedule.active, true)))
          .limit(1))[0];
        throw new OrderError(
          'fee_not_published',
          outside
            ? `No fee for ${line.feeCode} is in force on ${today}. A fee is entered against the dates it applies between, and one outside its own dates is not charged.`
            : `No published fee for ${line.feeCode}`
        );
      }

      // ── A STUDENT DOES NOT PAY A MEMBERSHIP FEE FOR BEING A STUDENT ──
      //
      // THE LAST GATE BEFORE AN INVOICE EXISTS, and the only one on this side
      // of the system. src/db/student-rule.ts guards `fee_rules` at addRule()
      // and at publishFramework(); it never saw `fee_schedule`, which is the
      // table this line is priced from and the table nothing in src/ writes —
      // so its rows arrive only from a seed, a migration, a restored backup or
      // an operator's INSERT, none of which pass through a fee framework at all.
      //
      // Judged HERE rather than at the INSERT for the same reason the framework
      // is judged at publishFramework() rather than only at addRule(): this is
      // the moment the row acquires the power to charge somebody, and it is the
      // moment every path — the anonymous POST /api/payments/checkout, an
      // accepted quotation, an admin raising an order by hand — necessarily
      // arrives at. A row that cannot price a line cannot reach an order line,
      // a payment, an invoice, a ledger entry or an entitlement.
      //
      // It reads the row and never the caller: `line.kind` is whatever the
      // browser said, and a browser that relabels its student membership as a
      // 'course' would walk past a check that trusted it.
      //
      // NOTHING HISTORICAL IS TOUCHED. This refuses a NEW charge. Orders,
      // invoices, payments and ledger entries already raised against such a fee
      // stay exactly as they are and stay readable — see src/db/revenue.ts,
      // which reports them under `historical_withdrawn` rather than hiding them.
      const verdict = classifyScheduledFee({ code: fee.code, label: fee.label, kind: fee.kind });
      if (verdict.studentCharge) {
        throw new OrderError('student_charge_refused', verdict.refusal as string);
      }

      unit = fee.amountPaise;
      description = fee.label;
    } else if (Number.isInteger(line.unitPricePaise) && line.kind === 'donation') {
      // Donations are the one case where the payer sets the amount.
      unit = line.unitPricePaise!;
      if (unit < 100) throw new OrderError('bad_amount', 'Minimum donation is ₹1');
    } else {
      throw new OrderError('unpriced', `Line "${description}" names no variant, fee code, or permitted amount`);
    }

    if (!Number.isInteger(unit) || unit < 0) throw new OrderError('bad_amount', 'Invalid price');

    const lineTotal = unit * qty;
    const lineTax = taxOnMinor(lineTotal, taxRateBps);
    subtotal += lineTotal;
    tax += lineTax;

    priced.push({
      kind: line.kind, variantId: line.variantId ?? null, feeCode: line.feeCode ?? null,
      refType: line.refType ?? null, refId: line.refId ?? null,
      description, quantity: qty, unitPricePaise: unit,
      taxRateBps, taxPaise: lineTax, totalPaise: lineTotal + lineTax,
    });
  }

  // Shipping is the ONE amount a caller still hands in, and it was accepted on
  // `Number.isInteger` alone — which is true of -500000. A negative carriage
  // charge is a discount nobody authorised: it reduces the total the gateway is
  // asked for, and `total <= 0` does not catch it because a big enough basket
  // stays positive all the way down to ₹1. Bounded here, at the only place a
  // caller can reach it.
  const shipping = Number.isInteger(draft.shippingPaise) ? draft.shippingPaise! : 0;
  if (shipping < 0) throw new OrderError('bad_amount', 'Shipping cannot be negative');

  const total = subtotal + tax + shipping;
  if (total <= 0) throw new OrderError('bad_total', 'Order total must be positive');
  // Beyond this, `unit * qty` above has left the exactly-representable range and
  // every figure downstream is a rounded approximation of itself. The integer
  // column would reject it, but only AFTER the order number was consumed and
  // the stock reserved — so it is refused here, while nothing has been written.
  if (!Number.isSafeInteger(total)) {
    throw new OrderError('bad_total', 'Order total is beyond the range this system will price');
  }

  const orderNo = await nextOrderNo(db);
  const needsShipping = priced.some((l) => l.kind === 'product');

  // See the note beside `quoteValidUntil`. An invoice raised against an accepted
  // quotation is not an abandoned basket, and must not be swept away as one.
  // End of the last valid day, in UTC — a quotation valid "until the 31st" is
  // valid ON the 31st, and taking midnight would take a day off it.
  const expiresAt = quotePriced
    ? (quoteValidUntil ? new Date(`${quoteValidUntil}T23:59:59.999Z`) : null)
    : new Date(Date.now() + 45 * 60_000);

  const [order] = await db.insert(s.orders).values({
    orderNo,
    personId: draft.personId ?? null,
    buyerName: draft.buyerName?.slice(0, 120) ?? null,
    email: draft.email?.trim().toLowerCase().slice(0, 254) ?? null,
    phone: draft.phone?.slice(0, 32) ?? null,
    status: 'awaiting_payment',
    subtotalPaise: subtotal,
    taxPaise: tax,
    shippingPaise: shipping,
    totalPaise: total,
    shipTo: draft.shipTo ?? null,
    fulfilment: needsShipping ? 'pending' : 'not_required',
    // Unpaid orders release their stock reservation after 45 minutes, so an
    // abandoned checkout cannot hold the last item indefinitely. A quote-derived
    // order is the exception — see above.
    expiresAt,
  }).returning();

  for (const line of priced) {
    await db.insert(s.orderLines).values({ ...line, orderId: order.id });
    if (line.variantId) {
      await db.update(s.productVariants)
        .set({ reservedQty: sql`${s.productVariants.reservedQty} + ${line.quantity}` })
        .where(eq(s.productVariants.id, line.variantId));
    }
  }

  if (ctx) {
    await writeAudit(db, ctx, {
      entityType: 'order', entityId: order.id, action: 'create',
      newValue: { orderNo, totalPaise: total, lines: priced.length },
    });
  }
  return { ...order, lines: priced };
}

// ─── Payment confirmation ───────────────────────────────────────────────────

/**
 * Record a payment attempt against an order.
 *
 * Creating the attempt does NOT pay the order. Only confirmPayment() does, and
 * only on a captured status from the provider.
 */
export async function beginPayment(
  db: DB,
  orderId: number,
  input: { provider: string; providerOrderId: string; amountPaise: number; idempotencyKey: string }
) {
  const order = (await db.select().from(s.orders).where(eq(s.orders.id, orderId)).limit(1))[0];
  if (!order) throw new OrderError('unknown_order', 'Unknown order');
  if (order.status === 'paid' || order.status === 'fulfilled') {
    throw new OrderError('already_paid', 'This order has already been paid');
  }
  if (input.amountPaise !== order.totalPaise) {
    throw new OrderError('amount_mismatch', 'Payment amount does not match the order total');
  }

  const [payment] = await db.insert(s.payments).values({
    orderId,
    provider: input.provider,
    providerOrderId: input.providerOrderId,
    amountPaise: input.amountPaise,
    status: 'created',
    idempotencyKey: input.idempotencyKey,
  }).returning();
  return payment;
}

/**
 * Confirm a payment from a VERIFIED provider record.
 *
 * Three checks before an order is marked paid, all of which have to pass:
 *   1. the payment status is `captured` — authorized is money held, not taken;
 *   2. the amount equals the order total exactly;
 *   3. the currency matches.
 *
 * Idempotent: the provider will deliver the same event more than once, and
 * fulfilling twice is worse than not fulfilling at all.
 */
export async function confirmPayment(
  db: DB,
  ctx: AuditContext | null,
  verified: VerifiedPayment
): Promise<{ orderId: number; alreadyProcessed: boolean } | null> {
  const existing = (await db.select().from(s.payments)
    .where(and(
      eq(s.payments.provider, ctx?.authority ?? ''),
      eq(s.payments.providerPaymentId, verified.providerPaymentId)
    )).limit(1))[0];

  // Match on the provider order id, which is what we stored when checkout began.
  //
  // Only when there IS one. A gateway entity carrying no order id yields the
  // empty string, and `provider_order_id = ''` is a query that matches whatever
  // row happens to hold an empty reference — a payment picked by accident
  // rather than the one this event is about. No match at all is the correct
  // answer to "which payment is this?" when the event does not say.
  const payment = existing ?? (verified.providerOrderId
    ? (await db.select().from(s.payments)
      .where(eq(s.payments.providerOrderId, verified.providerOrderId))
      .orderBy(desc(s.payments.id)).limit(1))[0]
    : undefined);

  if (!payment) return null;

  if (payment.status === 'captured') {
    // A replay is only a replay if the FIRST confirmation actually finished.
    // Before the confirmation became one transaction, the capture flag could
    // commit while the order status, the stock, the ledger and the receipt did
    // not — and this guard then answered "already processed" to every retry
    // that followed, the gateway's and the cron's alike, so the money stayed
    // taken and nothing was ever issued for it. Prove it finished first.
    await assertConfirmationComplete(db, payment);
    // A replay still activates. The entitlement engine is idempotent through a
    // unique index, so re-running it issues nothing twice — and a payment whose
    // activation was interrupted (the process died between the commit below and
    // the activation) has no other way back. Retrying it here is what makes the
    // webhook's own retry, and the reconcile cron, self-healing.
    await activate(db, ctx, payment.orderId);
    return { orderId: payment.orderId, alreadyProcessed: true };   // replay
  }

  const order = (await db.select().from(s.orders).where(eq(s.orders.id, payment.orderId)).limit(1))[0];
  if (!order) return null;

  if (verified.status !== 'captured') {
    await db.update(s.payments).set({
      status: verified.status === 'failed' ? 'failed' : verified.status === 'authorized' ? 'authorized' : 'created',
      providerPaymentId: verified.providerPaymentId,
      failureReason: verified.failureReason ?? null,
      updatedAt: new Date(),
    }).where(eq(s.payments.id, payment.id));
    return { orderId: order.id, alreadyProcessed: false };
  }

  // A captured amount that does not match is never quietly accepted: it is an
  // integration fault or an attack, and a human must look at it.
  if (verified.amountPaise !== order.totalPaise || verified.currency !== order.currency) {
    await db.update(s.payments).set({
      status: 'failed',
      providerPaymentId: verified.providerPaymentId,
      failureReason: `Amount or currency mismatch: provider reported ${verified.amountPaise} ${verified.currency}, order is ${order.totalPaise} ${order.currency}`,
      updatedAt: new Date(),
    }).where(eq(s.payments.id, payment.id));
    if (ctx) {
      await writeAudit(db, ctx, {
        entityType: 'payment', entityId: payment.id, action: 'update',
        oldValue: { expected: order.totalPaise }, newValue: { received: verified.amountPaise, flagged: true },
      });
    }
    throw new OrderError('amount_mismatch', 'Captured amount does not match the order total');
  }

  // ONE TRANSACTION, or none of it.
  //
  // Taking money is six writes — the payment, the order, the stock, the ledger,
  // the receipt, the audit trail — and as separate awaited statements each one
  // was its own transaction. Any fault between two of them (a dropped backend,
  // a unique violation from the invoice sequence under concurrency, a rejected
  // audit payload) left money captured with no receipt, no ledger postings and
  // an order still awaiting payment. Wrapped, a fault rolls the whole thing
  // back and the retry does it properly.
  //
  // This also matters on the transaction-mode pooler the deployment uses: an
  // explicit BEGIN pins one backend for the duration, which is exactly the
  // guarantee that mode gives, whereas consecutive loose statements may each be
  // served by a different backend.
  let alreadyProcessed = false;

  await db.transaction(async (tx: DB) => {
    // Lock the payment row for the rest of the transaction. Two confirmations
    // of the same payment arriving together — the webhook and the cron retry,
    // which happens — would otherwise both pass the guard above and issue two
    // receipts and two sets of ledger postings.
    const locked = (await tx.select().from(s.payments)
      .where(eq(s.payments.id, payment.id)).limit(1).for('update'))[0];
    if (!locked || locked.status === 'captured') {
      alreadyProcessed = true;
      return;
    }

    await tx.update(s.orders).set({ status: 'paid', paidAt: new Date(), updatedAt: new Date() })
      .where(eq(s.orders.id, order.id));

    // Reserved stock becomes sold stock.
    const lines = await tx.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
    for (const line of lines) {
      if (!line.variantId) continue;
      await tx.update(s.productVariants).set({
        stockQty: sql`${s.productVariants.stockQty} - ${line.quantity}`,
        reservedQty: sql`GREATEST(0, ${s.productVariants.reservedQty} - ${line.quantity})`,
      }).where(eq(s.productVariants.id, line.variantId));
    }

    await postLedger(tx, order, payment, verified);
    await issueInvoice(tx, order.id);

    if (ctx) {
      await writeAudit(tx, ctx, {
        entityType: 'order', entityId: order.id, action: 'update',
        oldValue: { status: order.status },
        newValue: { status: 'paid', paymentId: payment.id, amountPaise: verified.amountPaise },
      });
    }

    // LAST, deliberately. This is the write the replay guard at the top reads,
    // so it is the one that must never outlive the work it stands for.
    await tx.update(s.payments).set({
      status: 'captured',
      providerPaymentId: verified.providerPaymentId,
      method: verified.method ?? null,
      providerFeePaise: verified.feePaise ?? null,
      providerTaxPaise: verified.taxPaise ?? null,
      capturedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(s.payments.id, payment.id));
  });

  // ── The money is now taken and recorded. Issue what it bought. ───────────
  //
  // AFTER the commit, deliberately, and not inside it. Activation issues
  // memberships and confirms entries through modules that open their own
  // transactions; nesting them under this one would make a failure while
  // issuing a membership roll back the record that the money was taken, which
  // is the more dangerous of the two half-states. Outside it, the worst case is
  // a paid order whose entitlement is missing — visible in
  // entitlements.activationBacklog(), retried by the replay path above, and
  // never a payment this system has forgotten.
  await activate(db, ctx, order.id);

  return { orderId: order.id, alreadyProcessed };
}

/**
 * Hand a confirmed payment to the entitlement engine.
 *
 * Imported dynamically so that src/db/orders.ts stays loadable on its own —
 * entitlements.ts reaches into membership, competition and booking, and a
 * static import would drag all three into every module that only wanted to
 * price an order.
 *
 * A failure here is re-thrown. The webhook records it against the event and the
 * reconcile cron retries it, which is exactly the exceptions queue those two
 * were built for; swallowing it would leave money taken, nothing issued, and no
 * trace that anything was meant to be.
 */
async function activate(db: DB, ctx: AuditContext | null, orderId: number): Promise<void> {
  const { activateForOrder } = await import('./entitlements');
  await activateForOrder(db, ctx, orderId);

  // ── AND THE TRAINING LINES, WHICH activateForOrder() DOES NOT ISSUE ──
  //
  // 'training' is not an entitlement subject. entitlements.ts reports such a
  // line as `not_entitling`, which is an honest statement about THAT module and
  // says nothing about whether the student may train — and until this call
  // existed, nothing else was listening. A fully confirmed payment for a
  // child's classes wrote no row at all: no entitlement, and not even the
  // BLOCKED record that src/db/training-products.ts exists to leave behind, so
  // the money was taken, nothing was issued, and blockedTraining() — the finance
  // desk's refund queue — could not see it either. That is the one state this
  // whole design is meant to make impossible, and it was the default.
  //
  // Gated twice before it runs. On the order carrying a training line, so a
  // merchandise order pays for no extra queries; and on the order being PAID,
  // so a replayed confirmation of a refunded order does not acquire a new way
  // to throw. Idempotent through `training_entitlements_order_line_uk`, exactly
  // as activateForOrder() is idempotent through its own unique index, so the
  // gateway's retry and the reconcile cron issue nothing twice.
  const [current] = await db.select({ status: s.orders.status })
    .from(s.orders).where(eq(s.orders.id, orderId)).limit(1);
  if (current?.status !== 'paid' && current?.status !== 'fulfilled') return;

  const [trainingLine] = await db.select({ id: s.orderLines.id }).from(s.orderLines)
    .where(and(eq(s.orderLines.orderId, orderId), eq(s.orderLines.kind, 'training')))
    .limit(1);
  if (!trainingLine) return;

  const { activateTrainingForOrder } = await import('./training-products');
  await activateTrainingForOrder(db, ctx, orderId);
}

/** Order statuses that are only reachable once a confirmation has completed. */
const CONFIRMED_ORDER_STATUSES = new Set([
  'paid', 'fulfilled', 'refunded', 'partially_refunded', 'cancelled',
]);

/**
 * Refuse to describe a half-finished confirmation as a replay.
 *
 * A captured payment whose order never became paid, or that issued no receipt,
 * is money taken with nothing given for it. Reporting that as "already
 * processed" is what let the webhook handler and the reconcile cron clear the
 * error and count the wreck as recovered. Throwing instead keeps it in the
 * exceptions queue, where a human sees it.
 */
async function assertConfirmationComplete(db: DB, payment: any): Promise<void> {
  const order = (await db.select().from(s.orders).where(eq(s.orders.id, payment.orderId)).limit(1))[0];
  const invoice = (await db.select({ id: s.invoices.id }).from(s.invoices)
    .where(eq(s.invoices.orderId, payment.orderId)).limit(1))[0];

  const missing: string[] = [];
  if (!order || !CONFIRMED_ORDER_STATUSES.has(order.status)) {
    missing.push(`the order is ${order ? order.status : 'missing'}`);
  }
  if (!invoice) missing.push('no receipt was issued');
  if (!missing.length) return;

  throw new OrderError(
    'incomplete_confirmation',
    `Payment ${payment.id} is captured but its confirmation did not complete (${missing.join('; ')}). ` +
    'Money was taken and nothing was issued for it — this needs a human, and is not a replay.'
  );
}

/** Double-entry postings so the treasurer's report derives from one record. */
async function postLedger(db: DB, order: any, payment: any, verified: VerifiedPayment) {
  // The federation's own date, not UTC's. See federationToday().
  const today = federationToday();
  const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));

  for (const line of lines) {
    await db.insert(s.ledgerEntries).values({
      account: `income.${line.kind}`,
      direction: 'credit',
      amountPaise: line.totalPaise,
      orderId: order.id,
      // WHICH line, not merely which order (migration 0044). The account says
      // `income.other` for both an institutional training quotation and a
      // facility hire, so a revenue report reading the account alone cannot
      // tell them apart on the same order. src/db/revenue.ts joins through
      // this, and reports "not attributable" where it is null rather than
      // choosing a line — which is what the old rows have to be given.
      orderLineId: line.id,
      paymentId: payment.id,
      description: line.description,
      occurredOn: today,
    });
  }

  await db.insert(s.ledgerEntries).values({
    account: 'assets.gateway_receivable',
    direction: 'debit',
    amountPaise: order.totalPaise,
    orderId: order.id,
    paymentId: payment.id,
    description: `Payment received — ${order.orderNo}`,
    occurredOn: today,
  });

  // The gateway's cut is an expense, not a discount on income.
  if (verified.feePaise) {
    await db.insert(s.ledgerEntries).values({
      account: 'expense.gateway_fees',
      direction: 'debit',
      amountPaise: verified.feePaise + (verified.taxPaise ?? 0),
      orderId: order.id,
      paymentId: payment.id,
      description: `${payment.provider} fee — ${order.orderNo}`,
      occurredOn: today,
    });
  }
}

/** Issue the receipt, freezing exactly what it says. Idempotent. */
export async function issueInvoice(db: DB, orderId: number) {
  const existing = (await db.select().from(s.invoices).where(eq(s.invoices.orderId, orderId)).limit(1))[0];
  if (existing) return existing;

  const order = (await db.select().from(s.orders).where(eq(s.orders.id, orderId)).limit(1))[0];
  if (!order) throw new OrderError('unknown_order', 'Unknown order');
  const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, orderId));

  const [invoice] = await db.insert(s.invoices).values({
    orderId,
    invoiceNo: await nextInvoiceNo(db),
    // Frozen: a later catalogue or address edit must not alter an issued receipt.
    snapshot: {
      orderNo: order.orderNo,
      buyerName: order.buyerName,
      email: order.email,
      phone: order.phone,
      shipTo: order.shipTo,
      lines: lines.map((l: any) => ({
        description: l.description, quantity: l.quantity,
        unitPricePaise: l.unitPricePaise, taxPaise: l.taxPaise, totalPaise: l.totalPaise,
      })),
      subtotalPaise: order.subtotalPaise,
      taxPaise: order.taxPaise,
      shippingPaise: order.shippingPaise,
      totalPaise: order.totalPaise,
      currency: order.currency,
      issuedAt: new Date().toISOString(),
    },
    verifyToken: crypto.randomBytes(18).toString('base64url'),
  }).returning();

  return invoice;
}

// ─── Webhook intake ─────────────────────────────────────────────────────────

/**
 * Log a provider callback before acting on it, and refuse duplicates.
 *
 * Returns false when this event has been seen before — the replay guard. Every
 * gateway retries webhooks, and fulfilling an order twice is worse than a
 * delayed fulfilment.
 */
export async function recordWebhook(
  db: DB,
  input: { provider: string; eventId: string; eventType: string; signatureValid: boolean; payload: unknown }
): Promise<{ fresh: boolean; id: number | null }> {
  try {
    const [row] = await db.insert(s.paymentEvents).values({
      provider: input.provider,
      eventId: input.eventId,
      eventType: input.eventType,
      signatureValid: input.signatureValid,
      payload: input.payload as any,
    }).returning({ id: s.paymentEvents.id });
    return { fresh: true, id: row.id };
  } catch (err: any) {
    // Drizzle wraps the driver error, so the SQLSTATE is not on the outermost
    // object — see src/db/pgerror.ts. Matching only the wrapper meant the
    // replay guard never fired and every retried webhook raised a 500.
    if (isUniqueViolation(err)) return { fresh: false, id: null };
    throw err;
  }
}

export async function markWebhookProcessed(db: DB, id: number, error?: string) {
  await db.update(s.paymentEvents)
    .set({ processedAt: new Date(), processingError: error ?? null })
    .where(eq(s.paymentEvents.id, id));
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function orderByNumber(db: DB, orderNo: string) {
  const order = (await db.select().from(s.orders).where(eq(s.orders.orderNo, orderNo)).limit(1))[0];
  if (!order) return null;
  const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
  const payments = await db.select().from(s.payments).where(eq(s.payments.orderId, order.id));
  return { ...order, lines, payments };
}

export async function listOrders(db: DB, principal: Principal, limit = 100) {
  assertCanAnywhere(principal, 'finance:read');
  return db.select().from(s.orders).orderBy(desc(s.orders.id)).limit(limit);
}

/**
 * Release reservations held by orders that were never paid, so an abandoned
 * checkout does not hold the last item forever. Safe to run repeatedly.
 *
 * "Never paid" is checked against the payments, not only against the order's
 * own status: an order whose confirmation was interrupted still reads
 * `awaiting_payment` while the money is captured, and expiring it would release
 * the stock of an order somebody has already been charged for. Those are left
 * alone, awaiting_payment and visible, rather than quietly written off.
 */
export async function expireStaleOrders(db: DB): Promise<number> {
  const stale = await db.select().from(s.orders)
    .where(and(eq(s.orders.status, 'awaiting_payment'), sql`${s.orders.expiresAt} < now()`));

  let expired = 0;
  for (const order of stale) {
    const paid = await db.select({ id: s.payments.id }).from(s.payments)
      .where(and(eq(s.payments.orderId, order.id), eq(s.payments.status, 'captured'))).limit(1);
    if (paid.length) continue;

    const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
    for (const line of lines) {
      if (!line.variantId) continue;
      await db.update(s.productVariants)
        .set({ reservedQty: sql`GREATEST(0, ${s.productVariants.reservedQty} - ${line.quantity})` })
        .where(eq(s.productVariants.id, line.variantId));
    }
    await db.update(s.orders).set({ status: 'expired', updatedAt: new Date() }).where(eq(s.orders.id, order.id));
    expired++;
  }
  return expired;
}

/**
 * Refunds require authority and a reason, and never delete the payment (§78).
 *
 * ONE TRANSACTION, WITH THE PAYMENT ROW LOCKED. The over-refund guard below is
 * a read (every refund so far), an arithmetic comparison, and then a write. Run
 * loose, those three steps are not one decision: two requests for ₹6,00,000
 * against a ₹10,00,000 capture BOTH read a prior total of zero, both find
 * headroom, and both insert — ₹12,00,000 requested against ₹10,00,000 taken.
 * That is not a stress-test artefact; it needs only two operators, or one
 * double-clicking, because each call suspends on its read before either write.
 *
 * confirmPayment() solves exactly this problem for captures, 300 lines above,
 * with db.transaction() and .for('update'). This does the same, and for the
 * same reason: the guard has to hold against the state at the moment of the
 * INSERT, not the state at the moment of the SELECT. Locking the PAYMENT rather
 * than the refunds is deliberate — the invariant is a property of the payment
 * ("nothing may be refunded beyond what this payment captured"), and a lock on
 * rows that do not exist yet cannot exclude the insert of a new one.
 */
export async function requestRefund(
  db: DB,
  ctx: AuditContext,
  input: { paymentId: number; amountPaise: number; reason: string }
) {
  assertCan(ctx.principal, 'finance:write', {});
  if (!input.reason?.trim()) throw new OrderError('no_reason', 'A refund requires a reason');
  // Rejected before any row is read: a non-integer or out-of-range amount is a
  // caller fault, and letting it reach the arithmetic below would compare paise
  // against a float.
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise <= 0) {
    throw new OrderError('bad_amount', 'A refund amount is a positive whole number of paise');
  }

  const refund = await db.transaction(async (tx: DB) => {
    // FOR UPDATE. Any concurrent requestRefund against this payment now waits
    // here until this transaction commits, and then reads the refund it wrote.
    const payment = (await tx.select().from(s.payments)
      .where(eq(s.payments.id, input.paymentId)).limit(1).for('update'))[0];
    if (!payment) throw new OrderError('unknown_payment', 'Unknown payment');
    if (payment.status !== 'captured' && payment.status !== 'partially_refunded') {
      throw new OrderError('not_refundable', 'Only a captured payment can be refunded');
    }

    // Read INSIDE the lock, or the count is a photograph of a moment that has
    // already passed.
    const already = await tx.select().from(s.refunds).where(eq(s.refunds.paymentId, payment.id));
    const refunded = already.reduce((sum: number, r: any) => sum + (r.status === 'failed' ? 0 : r.amountPaise), 0);
    if (refunded + input.amountPaise > payment.amountPaise) {
      throw new OrderError(
        'over_refund',
        `Refund exceeds the amount captured: ${formatINR(refunded)} is already refunded or requested ` +
        `against ${formatINR(payment.amountPaise)}, leaving ${formatINR(payment.amountPaise - refunded)}.`
      );
    }

    const [row] = await tx.insert(s.refunds).values({
      paymentId: payment.id,
      orderId: payment.orderId,
      amountPaise: input.amountPaise,
      reason: input.reason.trim(),
      status: 'requested',
      requestedByUserId: ctx.principal.userId ?? null,
    }).returning();

    // Inside the transaction too. An audit row that survives a rolled-back
    // refund describes something that did not happen.
    await writeAudit(tx, { ...ctx, reason: input.reason }, {
      entityType: 'refund', entityId: row.id, action: 'create',
      newValue: { paymentId: payment.id, amountPaise: input.amountPaise },
    });
    return row;
  });

  return refund;
}

/**
 * Record that a refund actually completed — the money left the account.
 *
 * requestRefund() records an INTENTION. Nothing turned that intention into a
 * completed refund, so the ledger never learned that money went back and the
 * thing the payment had activated stayed active for ever. A member could be
 * refunded in full and still verify as a member; that is not a refund, it is a
 * gift with paperwork.
 *
 * WHAT COMPLETION MEANS HERE, precisely: the gateway (or, for manual UPI, the
 * finance officer with a bank reference) has confirmed the money moved. It is
 * recorded once — a second call is reported as a replay rather than posting the
 * reversal twice.
 *
 * The entitlement reversal is the LAST step and runs outside this function's
 * writes, for the reason activation does: reversing a membership is the
 * membership module's business, and a fault there must not un-record a refund
 * the bank has already made.
 */
export async function completeRefund(
  db: DB,
  ctx: AuditContext,
  input: { refundId: number; providerRefundId?: string | null; now?: Date }
) {
  assertCan(ctx.principal, 'finance:write', {});
  const now = input.now ?? new Date();

  const refund = (await db.select().from(s.refunds).where(eq(s.refunds.id, input.refundId)).limit(1))[0];
  if (!refund) throw new OrderError('unknown_refund', 'Unknown refund');
  if (refund.status === 'completed') {
    // Idempotent by intent: the reversal below has already been posted, and a
    // second set of ledger entries would show the federation refunding twice.
    return { refund, alreadyCompleted: true };
  }
  if (refund.status === 'failed') {
    throw new OrderError('refund_failed', 'This refund failed at the provider and cannot be completed without a new one.');
  }

  const payment = (await db.select().from(s.payments).where(eq(s.payments.id, refund.paymentId)).limit(1))[0];
  const order = (await db.select().from(s.orders).where(eq(s.orders.id, refund.orderId)).limit(1))[0];
  if (!payment || !order) throw new OrderError('unknown_payment', 'The refund names a payment or order that no longer exists');

  const completed = (await db.select().from(s.refunds).where(eq(s.refunds.paymentId, payment.id)))
    .filter((r: any) => r.status === 'completed')
    .reduce((sum: number, r: any) => sum + r.amountPaise, 0) + refund.amountPaise;
  const full = completed >= payment.amountPaise;

  await db.transaction(async (tx: DB) => {
    await tx.update(s.refunds).set({
      status: 'completed',
      providerRefundId: input.providerRefundId ?? refund.providerRefundId ?? null,
      approvedByUserId: refund.approvedByUserId ?? ctx.principal.userId ?? null,
      completedAt: now,
    }).where(eq(s.refunds.id, refund.id));

    await tx.update(s.payments).set({
      status: full ? 'refunded' : 'partially_refunded',
      updatedAt: now,
    }).where(eq(s.payments.id, payment.id));

    await tx.update(s.orders).set({
      status: full ? 'refunded' : 'partially_refunded',
      updatedAt: now,
    }).where(eq(s.orders.id, order.id));

    // The reversal, posted as its own pair rather than by deleting the original
    // entries. An accounts trail that can be edited is not a trail (§78).
    const today = federationToday(now);
    await tx.insert(s.ledgerEntries).values({
      account: 'income.refunds',
      direction: 'debit',
      amountPaise: refund.amountPaise,
      orderId: order.id, paymentId: payment.id, refundId: refund.id,
      description: `Refund — ${order.orderNo}`,
      occurredOn: today,
    });
    await tx.insert(s.ledgerEntries).values({
      account: 'assets.gateway_receivable',
      direction: 'credit',
      amountPaise: refund.amountPaise,
      orderId: order.id, paymentId: payment.id, refundId: refund.id,
      description: `Refund paid out — ${order.orderNo}`,
      occurredOn: today,
    });

    await writeAudit(tx, { ...ctx, reason: refund.reason }, {
      entityType: 'refund', entityId: refund.id, action: 'update',
      oldValue: { status: refund.status },
      newValue: { status: 'completed', amountPaise: refund.amountPaise, fullyRefunded: full },
    });
  });

  // What the money bought is now withdrawn, with the reason and a timestamp,
  // and the entitlement row is kept. See src/db/entitlements.ts.
  const { revokeForRefund } = await import('./entitlements');
  const revocation = await revokeForRefund(db, ctx, refund.id, { now });

  // AND THE TRAINING IT PAID FOR. revokeForRefund() reads `entitlements`, which
  // has no term for training, so a refunded family used to get their money back
  // and keep the mat until the term ran out. Same rules, applied by the module
  // that owns the table: a completed refund only, a full refund only, and the
  // row kept with the refund and the reason on it.
  const { revokeTrainingForRefund } = await import('./training-products');
  const trainingRevocation = await revokeTrainingForRefund(db, ctx, refund.id, { now });

  const after = (await db.select().from(s.refunds).where(eq(s.refunds.id, refund.id)).limit(1))[0];
  return { refund: after, alreadyCompleted: false, fullyRefunded: full, revocation, trainingRevocation };
}
