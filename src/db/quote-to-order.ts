// THE SECOND HOP: an accepted quotation becomes something payable.
//
// The first hop is src/db/fees.ts — a request becomes a quotation with a
// figure, an explanation and a framework version frozen onto it. This module is
// what happens next:
//
//     quote accepted ─▶ order ─▶ invoice ─▶ gateway order ─▶ /pay/<token>
//
// and every one of those arrows is guarded, because each of them is a place
// where a school can be charged twice, charged the wrong amount, or charged for
// an offer that had already lapsed.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE RULE THIS MODULE EXISTS TO ENFORCE
// ═════════════════════════════════════════════════════════════════════════════
//
// THE AMOUNT COMES FROM THE QUOTE VERSION. Not from a request, not from a form,
// not from a recomputation, not from `activeFramework()`. The quote version
// stores its own total, its own inputs and its own framework version, frozen at
// issue; that figure is what the invoice carries and what the gateway order is
// created from, and a fee change published afterwards must not alter a penny of
// it. tests/fees.test.ts asserts the freezing one step upstream
// ("A HISTORICAL QUOTE IS UNCHANGED BY A NEW FRAMEWORK VERSION"); this module is
// where that frozen figure is spent, and tests/quote-to-order.test.ts asserts
// that publishing an entirely different framework after an order exists moves
// neither the order nor the invoice by one paisa.
//
// The figure is carried by REFERENCE, never by value: createOrder() is handed a
// `quoteVersionId` and reads the total itself. Passing the number would have
// made this module a client of the order spine holding a price in its hand,
// which is precisely the shape of the attack the order spine exists to refuse.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT IS NOT PAYABLE, AND WHY EACH REFUSAL SAYS WHAT TO DO INSTEAD
// ═════════════════════════════════════════════════════════════════════════════
//
// AN EXPIRED QUOTATION. `validUntil` is the date the federation said the offer
// stood until. Past it the figure is no longer one MMAKF has committed to, and
// charging it would be charging a price nobody currently offers. The refusal
// offers a fresh quotation rather than ending the conversation — a school
// reading "this quotation expired on 14 March" and nothing else has been sent
// away by its own supplier.
//
// A QUOTATION AWAITING APPROVAL. A rule held it for a second pair of eyes.
// Payment is not the loophole that skips them: money arriving is exactly the
// event that makes an unapproved discount permanent.
//
// A QUOTATION WITH NO FIGURE. Today, this is all of them. MMAKF has published
// no fee framework, `activeFramework()` returns null, and `computeFee()` sets
// `requiresManualQuote` with no number attached. There is nothing to charge and
// this module says so — it does NOT stub a total, does not fall back to a
// benchmark and does not treat zero as a price. Zero reads as FREE.
//
// A SUPERSEDED, REJECTED OR WITHDRAWN VERSION. Re-quoting supersedes; the
// superseded version keeps its rows for the record and stops being an offer.
//
// ═════════════════════════════════════════════════════════════════════════════
// IDEMPOTENCY — WHERE IT IS ENFORCED AND WHERE IT MERELY LOOKS ENFORCED
// ═════════════════════════════════════════════════════════════════════════════
//
// Accepting twice must produce ONE invoice and ONE gateway order, and a second
// call must return the EXISTING link rather than open a second charge. Three
// unique indexes carry that, none of them a SELECT-then-INSERT:
//
//   quote_acceptances_quote_version_uk      one agreement per version
//   quote_payment_links_quote_version_uk    one charge per version
//   payments_idempotency_uk                 one payment attempt per key
//
// and the same key is sent to the gateway as its own idempotency header, so a
// retry that gets as far as the network still comes back with the gateway order
// that already exists.
//
// THREE INDEXES ARE NOT ENOUGH ON THEIR OWN, because all three key on the
// VERSION and the thing an institution experiences is the QUOTE. Re-quoting
// supersedes only what is still 'issued', so a version already accepted and
// invoiced survives a re-quote untouched — and accepting the new version then
// raised a SECOND live invoice for one request, each for the whole engagement
// rather than for the difference, with neither version's index able to see the
// other. assessPayability() refuses that in `charged_on_another_version`, and
// says which order to cancel if this version really does replace it.
//
// The claim row is written BEFORE the order, and every later step is guarded on
// the column it fills being still NULL. That makes the row a resume point: a
// process killed after the order but before the gateway call restarts, finds
// `order_id` set and `provider_order_id` null, and does only what is left. The
// alternative — checking whether an order exists by looking for one — cannot
// work, because creating it is the thing being deduplicated.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS DOES NOT DO
// ═════════════════════════════════════════════════════════════════════════════
//
// IT DOES NOT MARK ANYTHING PAID. `confirmPayment()` does, from a verified
// capture, and nothing here touches order status. Handing somebody a link is
// not evidence they used it.
//
// IT DOES NOT NOTIFY ANYBODY. The two event types it publishes are absent from
// NOTIFIABLE in src/lib/notifications.ts, so they reach the feed and no inbox.
// That is stated rather than hidden, because "an event nobody is subscribed to"
// is a bug class this project has already hit twice: resolveRecipients() has no
// audience that resolves an INSTITUTION to people, and inventing one here —
// mailing every contact row attached to a school — is a decision about who at a
// client hears about money, which is the federation's to make. The link is
// returned to the caller so the surface that asked for it can show it, and
// today the office sends it. Closing this gap means adding an institution
// audience to resolveRecipients() and only THEN the two event names to
// NOTIFIABLE — in that order, because a NOTIFIABLE entry whose audience
// resolves to nobody is the same silence with a queue row in front of it.

import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import crypto from 'node:crypto';
import * as s from './schema';
import * as q from './quote-orders.schema';
import { writeAudit, type AuditContext } from './federation';
import { isUniqueViolation } from './pgerror';
import { createOrder, issueInvoice, beginPayment, formatINR, OrderError } from './orders';
import { activeFramework } from './fees';
import { activeProvider, PaymentProviderError, type PaymentProvider } from '@/lib/payments';
import { publish } from '@/lib/domain-events';
import { assertCan, canAnywhere, type Principal } from '@/lib/rbac';

type DB = any;

export class QuoteOrderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'QuoteOrderError';
    this.code = code;
  }
}

/** Identified by shape, not by `instanceof` — see src/lib/calendar.ts for why. */
export function isQuoteOrderError(err: unknown): err is QuoteOrderError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'QuoteOrderError';
}

/** Today, in the calendar the `valid_until` column is written in. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════════════════════
// PAYABILITY
// ═══════════════════════════════════════════════════════════════════════════

export type PayabilityCode =
  | 'payable'
  | 'unknown_quote_version'
  | 'no_figure'
  | 'awaiting_approval'
  | 'not_issued'
  | 'not_accepted'
  | 'expired'
  | 'superseded'
  | 'rejected'
  | 'withdrawn'
  | 'currency_unsupported'
  | 'not_reconcilable'
  | 'charged_on_another_version'
  | 'already_paid';

export interface Payability {
  /** True only when a charge may legitimately be raised for this version. */
  payable: boolean;
  code: PayabilityCode;
  /**
   * Addressed to the person who has to act. Every refusal names the next step,
   * because a quotation that cannot be paid is a conversation that has to
   * continue somehow, and "no" on its own ends it.
   */
  message: string;
  quoteVersionId: number;
  quoteId: number | null;
  ref: string | null;
  version: number | null;
  status: string | null;
  /** NULL whenever there is no figure. Never 0 standing in for "unknown". */
  totalMinor: number | null;
  currency: string | null;
  validUntil: string | null;
  /** True once the version has been ACCEPTED, which is a separate question. */
  accepted: boolean;
}

/**
 * Can this quotation version be charged for, and if not, why not?
 *
 * A READ. It writes nothing and takes no lock, so a surface may call it to
 * decide whether to render a button. The write paths below re-ask the same
 * question rather than trusting an answer a caller obtained earlier — between
 * the render and the click, a quotation can expire.
 *
 * `requireAcceptance` distinguishes the two gates. Recording an acceptance
 * needs a quotation that is ISSUED and current; raising a charge needs one that
 * is additionally ACCEPTED.
 */
export async function assessPayability(
  db: DB,
  quoteVersionId: number,
  opts: { asAt?: string; requireAcceptance?: boolean } = {}
): Promise<Payability> {
  const asAt = opts.asAt ?? today();
  const requireAcceptance = opts.requireAcceptance !== false;

  const [qv] = await db.select().from(s.quoteVersions)
    .where(eq(s.quoteVersions.id, quoteVersionId)).limit(1);

  const base = {
    quoteVersionId,
    quoteId: null as number | null,
    ref: null as string | null,
    version: null as number | null,
    status: null as string | null,
    totalMinor: null as number | null,
    currency: null as string | null,
    validUntil: null as string | null,
    accepted: false,
  };

  if (!qv) {
    return {
      ...base, payable: false, code: 'unknown_quote_version',
      message: 'No such quotation version. Check the reference, or issue a quotation for this request.',
    };
  }

  const [quote] = await db.select().from(s.quotes)
    .where(eq(s.quotes.id, qv.quoteId)).limit(1);
  const [acceptance] = await db.select().from(q.quoteAcceptances)
    .where(eq(q.quoteAcceptances.quoteVersionId, quoteVersionId)).limit(1);

  const ctx = {
    quoteVersionId,
    quoteId: qv.quoteId as number,
    ref: (quote?.ref ?? null) as string | null,
    version: qv.version as number,
    status: qv.status as string,
    // The figure is reported ONLY when there is one. `requiresManualQuote`
    // below is checked before this is read as money.
    totalMinor: qv.requiresManualQuote ? null : (qv.totalMinor as number),
    currency: (qv.currency ?? null) as string | null,
    validUntil: (qv.validUntil ?? null) as string | null,
    accepted: Boolean(acceptance),
  };

  // ── No figure. Today this is every quotation there is. ──
  if (qv.requiresManualQuote) {
    return {
      ...ctx, payable: false, code: 'no_figure',
      message:
        (qv.manualReason as string | null) ??
        'The federation has not published a fee covering this request, so the quotation carries no figure. ' +
        'The office prepares it by hand — there is nothing here to charge.',
    };
  }

  // ── Held for a second pair of eyes. Payment is not the way round them. ──
  if (qv.status === 'awaiting_approval') {
    return {
      ...ctx, payable: false, code: 'awaiting_approval',
      message:
        'This quotation is still waiting for approval — a pricing rule held it for a second person to review. ' +
        'It becomes payable once somebody who holds quote:approve, and who did not issue it, approves it.',
    };
  }

  if (qv.status === 'rejected') {
    return {
      ...ctx, payable: false, code: 'rejected',
      message: 'This quotation was refused at approval and was never offered. Issue a new one to quote this request.',
    };
  }
  if (qv.status === 'superseded') {
    return {
      ...ctx, payable: false, code: 'superseded',
      message:
        'This version has been superseded by a later quotation for the same request. ' +
        'The current version is the one to accept; this one is kept for the record.',
    };
  }
  if (qv.status === 'withdrawn') {
    return {
      ...ctx, payable: false, code: 'withdrawn',
      message: 'This quotation was withdrawn by the federation and is no longer an offer.',
    };
  }
  if (qv.status === 'expired') {
    return {
      ...ctx, payable: false, code: 'expired',
      message:
        'This quotation has expired. The figure on it is no longer one the federation is offering — ' +
        'ask the office for a fresh quotation and it will be prepared against the fees in force now.',
    };
  }
  if (qv.status === 'draft') {
    return {
      ...ctx, payable: false, code: 'not_issued',
      message: 'This quotation is still a draft. It has not been issued to anybody and cannot be paid.',
    };
  }

  // ── Expiry by date, which the status may not have caught up with ──
  //
  // Checked from `validUntil` rather than from the status, because nothing
  // sweeps quote versions into 'expired' on a schedule and an offer does not
  // stay open because a cron did not run.
  if (ctx.validUntil && ctx.validUntil < asAt) {
    return {
      ...ctx, payable: false, code: 'expired',
      message:
        `This quotation was valid until ${ctx.validUntil} and has lapsed, so the figure on it is no longer ` +
        'one the federation is offering. Ask the office for a fresh quotation — the request is still on ' +
        'file and re-quoting it takes minutes.',
    };
  }

  if (ctx.currency !== 'INR') {
    return {
      ...ctx, payable: false, code: 'currency_unsupported',
      message:
        `This quotation is in ${ctx.currency}. The federation's orders are raised in INR, and this system ` +
        'will not treat one currency\'s figure as another\'s. The office settles a foreign-currency quotation directly.',
    };
  }

  // subtotal + adjustment + tax = total, by construction in computeFee().
  const net = (qv.subtotalMinor as number) + (qv.adjustmentMinor as number);
  if (net + (qv.taxMinor as number) !== (qv.totalMinor as number)) {
    return {
      ...ctx, payable: false, code: 'not_reconcilable',
      message:
        'This quotation\'s stored subtotal, adjustment and tax do not add up to its total. ' +
        'Something other than the fee engine wrote it. Refusing to charge a figure that cannot be reconstructed.',
    };
  }
  if ((qv.totalMinor as number) <= 0) {
    return {
      ...ctx, payable: false, code: 'no_figure',
      message:
        'This quotation totals nothing. A zero would be charged as free, and free is not a price the ' +
        'federation has published. Re-quote it, or record it as a waiver rather than as a payment.',
    };
  }

  if (requireAcceptance && qv.status !== 'accepted') {
    return {
      ...ctx, payable: false, code: 'not_accepted',
      message:
        `This quotation is ${qv.status}. Nothing is charged until the institution has accepted it — ` +
        'record the acceptance, with how the federation knows about it, and the invoice follows.',
    };
  }

  // ── ANOTHER VERSION OF THIS QUOTATION IS ALREADY BEING CHARGED FOR ──
  //
  // The unique index is on the VERSION, and it has to be — a version is what
  // carries a figure. But the commercial thread is the QUOTE, and re-quoting
  // leaves an already-accepted version alone: issueQuote() supersedes only what
  // is still 'issued'. So the sequence
  //
  //     v1 accepted → invoiced → office re-quotes → v2 accepted → invoiced
  //
  // ends with a school holding TWO live invoices for one request, each for the
  // whole engagement rather than for the difference between them, and neither
  // version's own unique index can see the other. It is refused here, at the
  // one gate both of them pass through, and the way out is named rather than
  // implied: cancel the order that was replaced, or raise the new scope as its
  // own request.
  //
  // ON THE CHARGE PATH ONLY. That an institution accepted a revised quotation
  // is a fact worth recording whatever the billing then says, so
  // acceptQuoteVersion() — which asks with `requireAcceptance: false` — still
  // gets its answer.
  if (requireAcceptance) {
    const siblings = await db.select().from(q.quotePaymentLinks)
      .where(and(
        eq(q.quotePaymentLinks.quoteId, ctx.quoteId),
        ne(q.quotePaymentLinks.quoteVersionId, quoteVersionId),
      ));
    for (const sib of siblings) {
      if (sib.orderId == null) continue;
      const [order] = await db.select().from(s.orders)
        .where(eq(s.orders.id, sib.orderId)).limit(1);
      // A cancelled order is a charge the federation has already withdrawn, so
      // it is not one the institution is holding.
      if (!order || order.status === 'cancelled') continue;
      const [sv] = await db.select({ version: s.quoteVersions.version }).from(s.quoteVersions)
        .where(eq(s.quoteVersions.id, sib.quoteVersionId)).limit(1);
      return {
        ...ctx, payable: false, code: 'charged_on_another_version',
        message:
          `Version ${sv?.version ?? '?'} of this quotation has already been charged for, on order ` +
          `${order.orderNo} — ${formatINR(order.totalPaise)}, currently ${order.status}. Raising a second ` +
          'charge would leave the institution holding two live invoices for one request, each for the whole ' +
          'engagement rather than for the difference. Cancel the earlier order if this version replaces it, ' +
          'or raise the new scope as a request of its own.',
      };
    }
  }

  // ── Already charged for, and already paid ──
  const [link] = await db.select().from(q.quotePaymentLinks)
    .where(eq(q.quotePaymentLinks.quoteVersionId, quoteVersionId)).limit(1);
  if (link?.orderId != null) {
    const [order] = await db.select().from(s.orders)
      .where(eq(s.orders.id, link.orderId)).limit(1);
    if (order && (order.status === 'paid' || order.status === 'fulfilled')) {
      return {
        ...ctx, payable: false, code: 'already_paid',
        message: `This quotation has already been paid, on order ${order.orderNo}.`,
      };
    }
  }

  return {
    ...ctx, payable: true, code: 'payable',
    message: `Payable: ${formatINR(ctx.totalMinor as number)} against quotation ${ctx.ref ?? ''} version ${ctx.version}.`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCEPTANCE
// ═══════════════════════════════════════════════════════════════════════════

export type AcceptanceMethod = 'email' | 'signed_document' | 'portal' | 'meeting_minuted';

const METHODS: readonly AcceptanceMethod[] = ['email', 'signed_document', 'portal', 'meeting_minuted'];

export interface AcceptanceInput {
  /** The person AT THE INSTITUTION who agreed. Not an MMAKF account. */
  acceptedByName: string;
  acceptedByRole?: string | null;
  method: AcceptanceMethod;
  /** The message id, document reference or minute number behind `method`. */
  evidenceRef?: string | null;
  note?: string | null;
}

export interface AcceptanceResult {
  quoteId: number;
  quoteVersionId: number;
  ref: string | null;
  version: number;
  totalMinor: number;
  currency: string;
  acceptedAt: Date;
  /** True when this call found an acceptance already recorded and changed nothing. */
  alreadyAccepted: boolean;
}

/**
 * Record that an institution accepted a quotation at its quoted figure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY 'contract:write' AND NOT 'quote:issue'
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Issuing a quotation is an offer; recording an acceptance is the federation
 * asserting that a commercial commitment now exists, which is the thing a
 * contract is. TRAINING_OPERATIONS holds `quote:issue` and not
 * `contract:write`, so the person who sends a school a price is not the person
 * who can record that the school said yes to it. That is the same separation
 * approveQuoteVersion() enforces one step earlier, applied to the step where
 * the money becomes real.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS STORED, AND WHY THE EVIDENCE IS MANDATORY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `method` is a closed vocabulary and the database CHECK enforces it. An
 * acceptance that cannot say how the federation knows about it is not evidence
 * of anything, and the moment it is disputed — which is the only moment it
 * matters — "somebody remembered a phone call" is worth nothing. The figure is
 * frozen onto the acceptance row as well, so what was agreed is recorded
 * independently of the row it was agreed from.
 *
 * IDEMPOTENT by unique index. Clicking Accept twice records one agreement and
 * the second call returns the first, unchanged, rather than raising.
 */
export async function acceptQuoteVersion(
  db: DB,
  ctx: AuditContext,
  quoteVersionId: number,
  input: AcceptanceInput
): Promise<AcceptanceResult> {
  assertCan(ctx.principal, 'contract:write', {});

  const name = String(input?.acceptedByName ?? '').trim();
  if (name.length < 2) {
    throw new QuoteOrderError(
      'acceptance_unattributed',
      'An acceptance must name the person at the institution who gave it. "The school agreed" is not a record of anything.'
    );
  }
  if (!METHODS.includes(input?.method as AcceptanceMethod)) {
    throw new QuoteOrderError(
      'acceptance_method_required',
      `An acceptance must say how the federation knows about it: ${METHODS.join(', ')}. ` +
      'A commitment with no evidence behind it cannot be produced when it is disputed.'
    );
  }

  // Already recorded? Return it. Checked before the payability gate on purpose:
  // a quotation accepted in March and now expired is still an accepted
  // quotation, and re-reading the record must not start failing because time
  // passed.
  const [existing] = await db.select().from(q.quoteAcceptances)
    .where(eq(q.quoteAcceptances.quoteVersionId, quoteVersionId)).limit(1);
  if (existing) {
    const [quote] = await db.select().from(s.quotes).where(eq(s.quotes.id, existing.quoteId)).limit(1);
    const [qv] = await db.select().from(s.quoteVersions).where(eq(s.quoteVersions.id, quoteVersionId)).limit(1);
    return {
      quoteId: existing.quoteId,
      quoteVersionId,
      ref: quote?.ref ?? null,
      version: qv?.version ?? 0,
      totalMinor: existing.totalMinor,
      currency: existing.currency,
      acceptedAt: existing.acceptedAt,
      alreadyAccepted: true,
    };
  }

  // The version must be a live, issued offer with a figure. `requireAcceptance:
  // false` because being accepted is what this call is about.
  const check = await assessPayability(db, quoteVersionId, { requireAcceptance: false });
  if (!check.payable) {
    throw new QuoteOrderError(check.code, check.message);
  }
  if (check.status !== 'issued') {
    throw new QuoteOrderError(
      'not_issued',
      `This quotation is ${check.status}, not issued, so there is no live offer for anybody to accept.`
    );
  }

  const now = new Date();
  let row: any;
  try {
    [row] = await db.insert(q.quoteAcceptances).values({
      quoteVersionId,
      quoteId: check.quoteId!,
      acceptedByName: name.slice(0, 200),
      acceptedByRole: input.acceptedByRole?.slice(0, 120) ?? null,
      method: input.method,
      evidenceRef: input.evidenceRef?.slice(0, 300) ?? null,
      note: input.note?.slice(0, 2000) ?? null,
      // Frozen a second time, from the version rather than from the caller.
      totalMinor: check.totalMinor!,
      currency: check.currency!,
      acceptedAt: now,
      recordedByUserId: ctx.principal.userId ?? null,
    }).returning();
  } catch (err: any) {
    // Two callers raced. The index decided; read the winner rather than raise.
    if (!isUniqueViolation(err)) throw err;
    return acceptQuoteVersion(db, ctx, quoteVersionId, input);
  }

  // The status move is guarded on the status it is moving FROM, so a version
  // that was superseded between the check and here is not dragged back to life.
  await db.update(s.quoteVersions)
    .set({ status: 'accepted' })
    .where(and(
      eq(s.quoteVersions.id, quoteVersionId),
      eq(s.quoteVersions.status, 'issued'),
    ));

  await writeAudit(db, ctx, {
    entityType: 'quote', entityId: check.quoteId!, action: 'approve',
    oldValue: { version: check.version, status: 'issued' },
    newValue: {
      version: check.version, status: 'accepted',
      totalMinor: check.totalMinor, currency: check.currency,
      acceptedBy: name, method: input.method,
    },
  });

  const [quote] = await db.select().from(s.quotes).where(eq(s.quotes.id, check.quoteId!)).limit(1);
  await publish(db, {
    eventType: 'QUOTE_ACCEPTED',
    entityType: 'quote_version',
    entityId: quoteVersionId,
    actor: ctx.principal,
    // One acceptance, one event, however many times this is retried.
    correlationId: `quote-accepted:${quoteVersionId}`,
    payload: {
      quoteId: check.quoteId,
      quoteVersionId,
      ref: check.ref,
      version: check.version,
      institutionId: quote?.institutionId ?? null,
      totalMinor: check.totalMinor,
      currency: check.currency,
      method: input.method,
    },
  });

  return {
    quoteId: check.quoteId!,
    quoteVersionId,
    ref: check.ref,
    version: check.version!,
    totalMinor: row.totalMinor,
    currency: row.currency,
    acceptedAt: row.acceptedAt,
    alreadyAccepted: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// THE PAYMENT LINK
// ═══════════════════════════════════════════════════════════════════════════

export interface PaymentLink {
  quoteVersionId: number;
  quoteId: number;
  ref: string | null;
  version: number | null;
  /** The URL an institution opens. Relative — the host is the caller's business. */
  payUrl: string;
  token: string;
  orderId: number;
  orderNo: string;
  invoiceId: number | null;
  invoiceNo: string | null;
  /** The frozen figure, in integer paise. Equal to the quote version's total. */
  amountMinor: number;
  currency: string;
  /** Null when no gateway is configured — see `blockedReason`. */
  provider: string | null;
  providerOrderId: string | null;
  checkout: Record<string, unknown> | null;
  /** Why online payment is not available, when it is not. Null when it is. */
  blockedReason: string | null;
  /** True when this call found the whole chain already done and changed nothing. */
  alreadyExisted: boolean;
}

/** 24 random bytes. See the schema note on why this is not an id. */
function mintToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

async function linkRow(db: DB, quoteVersionId: number) {
  const [row] = await db.select().from(q.quotePaymentLinks)
    .where(eq(q.quotePaymentLinks.quoteVersionId, quoteVersionId)).limit(1);
  return row ?? null;
}

/**
 * Turn an accepted quotation into an order, an invoice and a payment link.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ORDER OF OPERATIONS, AND WHY IT IS THIS ONE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  1. CLAIM. Insert the link row. The unique index on `quote_version_id` means
 *     exactly one caller proceeds; everybody else reads the winner's row. This
 *     happens BEFORE the order exists, because "has this already been charged
 *     for?" cannot be answered by looking for the order we are trying not to
 *     create twice.
 *
 *  2. ORDER, then INVOICE, inside one transaction. createOrder() is handed the
 *     quote version id and reads the frozen figure itself. issueInvoice()
 *     freezes what the invoice says. Both land or neither does.
 *
 *  3. GATEWAY, outside the transaction. A network call inside a transaction
 *     holds a database lock for the duration of somebody else's outage. The
 *     step is guarded on `provider_order_id` being null, so a crash between (2)
 *     and (3) resumes here rather than starting again.
 *
 *  4. PAYMENT ATTEMPT, with the same idempotency key the gateway was given.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AMOUNT IS CHECKED AT EVERY HOP
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The quote version's total, the claim's `amount_minor`, the order's
 * `total_paise` and the amount sent to the gateway must be the same integer.
 * They are compared rather than assumed, and a mismatch stops the chain with
 * nothing handed out — a figure that drifted between two steps of one function
 * is not something to route round.
 */
export async function createPaymentLink(
  db: DB,
  ctx: AuditContext,
  quoteVersionId: number,
  opts: { buyerName?: string; email?: string; phone?: string } = {}
): Promise<PaymentLink> {
  // The same authority that records the acceptance. Deliberately not a second,
  // different one: the charge is a mechanical consequence of an agreement
  // already recorded at a figure nobody here can alter, so requiring a second
  // person to press a second button would add a step and no control.
  assertCan(ctx.principal, 'contract:write', {});

  // Already done? Return it, WITHOUT re-running payability. A link created
  // against a valid quotation stays valid; re-checking would make an existing
  // invoice unreadable the day its quotation lapsed, which is the opposite of
  // what an invoice is for.
  const done = await linkRow(db, quoteVersionId);
  if (done?.orderId != null && (done.providerOrderId != null || done.blockedReason != null)) {
    return hydrate(db, done, true);
  }

  // PAYABILITY GATES RAISING A CHARGE, NOT FINISHING ONE.
  //
  // A link that already carries an order is a charge raised earlier, under a
  // check that passed at the time, against an invoice the institution is now
  // holding. Re-asking the question on the way back in would make a chain that
  // was interrupted between the invoice and the gateway call UNFINISHABLE the
  // moment the quotation lapsed — leaving a real invoice with no way ever to
  // pay it, which is the opposite of what the expiry rule is for. So the gate
  // is asked only where a charge is about to be created, and the resume path
  // carries on from where it stopped.
  //
  // The figure is not taken on trust for that: openGatewayOrder() compares the
  // order's total against the claim before it asks a gateway for anything.
  let link = done;
  let check: Payability | null = null;
  if (link?.orderId == null) {
    check = await assessPayability(db, quoteVersionId);
    if (!check.payable) throw new QuoteOrderError(check.code, check.message);
  }

  // ── 1. Claim ──
  if (!link) {
    try {
      [link] = await db.insert(q.quotePaymentLinks).values({
        quoteVersionId,
        // `check` is non-null on every path that reaches here: no link means no
        // order, and no order is what makes the gate above run.
        quoteId: check!.quoteId!,
        token: mintToken(),
        idempotencyKey: crypto.randomUUID(),
        amountMinor: check!.totalMinor!,
        currency: check!.currency!,
        createdByUserId: ctx.principal.userId ?? null,
      }).returning();
    } catch (err: any) {
      if (!isUniqueViolation(err)) throw err;
      link = await linkRow(db, quoteVersionId);
      if (!link) throw err;
    }
  }

  // The claim was made against a figure. If it no longer matches the version's,
  // something rewrote a frozen row and nothing further should happen. Asked
  // only where the version was re-read — on a resume the equivalent comparison
  // is the order against the claim, which openGatewayOrder() makes.
  if (check && link.amountMinor !== check.totalMinor) {
    throw new QuoteOrderError(
      'amount_drifted',
      `The payment link for this quotation was claimed at ${formatINR(link.amountMinor)} and the quotation now reads ` +
      `${formatINR(check.totalMinor!)}. A frozen figure has changed. Refusing to charge either of them.`
    );
  }

  // ── 2. Order and invoice ──
  if (link.orderId == null) {
    link = await createOrderAndInvoice(db, ctx, link, check!, opts);
  }

  // ── 3 and 4. Gateway order and payment attempt ──
  if (link.providerOrderId == null && link.blockedReason == null) {
    link = await openGatewayOrder(db, link);
  }

  const result = await hydrate(db, link, false);

  await publish(db, {
    eventType: 'QUOTE_PAYMENT_LINK_ISSUED',
    entityType: 'quote_version',
    entityId: quoteVersionId,
    actor: ctx.principal,
    correlationId: `quote-payment-link:${quoteVersionId}`,
    payload: {
      quoteVersionId,
      quoteId: result.quoteId,
      orderId: result.orderId,
      orderNo: result.orderNo,
      invoiceNo: result.invoiceNo,
      amountMinor: result.amountMinor,
      currency: result.currency,
      provider: result.provider,
      blockedReason: result.blockedReason,
    },
  });

  return result;
}

/**
 * Step 2, in one transaction.
 *
 * The UPDATE that records the order id is guarded on `order_id IS NULL`, so if
 * two callers somehow both reach here — a claim read by one while the other was
 * mid-insert — the loser's transaction rolls back and its order never exists.
 * That is why the guard is inside the transaction rather than after it: an
 * order that lost the race must not survive as an orphan charge.
 */
async function createOrderAndInvoice(
  db: DB,
  ctx: AuditContext,
  link: any,
  check: Payability,
  opts: { buyerName?: string; email?: string; phone?: string }
): Promise<any> {
  const [quote] = await db.select().from(s.quotes).where(eq(s.quotes.id, link.quoteId)).limit(1);

  // Contact details, in the order of how much the federation can stand behind
  // them: what the caller supplied for this invoice, then the decision-maker on
  // file at the institution. Never invented.
  let buyerName = opts.buyerName ?? null;
  let email = opts.email ?? null;
  let phone = opts.phone ?? null;
  if (quote?.institutionId && (!buyerName || !email)) {
    const [contact] = await db.select().from(s.institutionContacts)
      .where(eq(s.institutionContacts.institutionId, quote.institutionId))
      .orderBy(desc(s.institutionContacts.isDecisionMaker), s.institutionContacts.id)
      .limit(1);
    const [institution] = await db.select().from(s.institutions)
      .where(eq(s.institutions.id, quote.institutionId)).limit(1);
    buyerName = buyerName ?? institution?.name ?? contact?.fullName ?? null;
    email = email ?? contact?.email ?? null;
    phone = phone ?? contact?.phone ?? null;
  }

  return db.transaction(async (tx: DB) => {
    const order = await createOrder(tx, ctx, {
      personId: quote?.personId ?? null,
      buyerName: buyerName ?? undefined,
      email: email ?? undefined,
      phone: phone ?? undefined,
      lines: [{
        // 'other' rather than 'course'. A course line is an academy enrolment,
        // and an institutional training programme is not one — mislabelling it
        // would put it in the academy's income report.
        kind: 'other',
        description: `Quotation ${check.ref ?? ''} version ${check.version}`.trim(),
        // BY REFERENCE. createOrder() reads the frozen total itself; this
        // module never hands it a number.
        quoteVersionId: link.quoteVersionId,
      }],
    });

    // Rule 3, applied to our own code as well as to a client's. The order was
    // priced from the same row this link was claimed against, so a disagreement
    // means one of them was rewritten mid-flight.
    if (order.totalPaise !== link.amountMinor) {
      throw new QuoteOrderError(
        'amount_mismatch',
        `The order was created for ${formatINR(order.totalPaise)} against a quotation of ${formatINR(link.amountMinor)}. ` +
        'Refusing to invoice a figure this system did not derive from the quotation.'
      );
    }

    // The invoice the institution pays against. issueInvoice() freezes a
    // snapshot of exactly what it says, and is idempotent — confirmPayment()
    // calls it again on capture and gets this same row back rather than a
    // second invoice number.
    const invoice = await issueInvoice(tx, order.id);

    const [won] = await tx.update(q.quotePaymentLinks)
      .set({ orderId: order.id, invoiceId: invoice.id, updatedAt: new Date() })
      .where(and(
        eq(q.quotePaymentLinks.id, link.id),
        isNull(q.quotePaymentLinks.orderId),
      ))
      .returning();
    if (!won) {
      // Somebody else got there first. Rolling back takes this order and this
      // invoice with it, which is the point.
      throw new QuoteOrderError(
        'link_already_created',
        'Another request created the order for this quotation a moment ago. Re-read the payment link.'
      );
    }
    return won;
  }).catch(async (err: any) => {
    if (isQuoteOrderError(err) && err.code === 'link_already_created') {
      const fresh = await linkRow(db, link.quoteVersionId);
      if (fresh?.orderId != null) return fresh;
    }
    throw err;
  });
}

/**
 * Steps 3 and 4 — the gateway order and the payment attempt.
 *
 * NO PROVIDER IS NOT AN ERROR. It is MMAKF's state today: `activeProvider()`
 * returns null because neither Razorpay nor a UPI id is configured. The order
 * and the invoice are real and the institution genuinely owes the money; what
 * is missing is a way to pay it online. That is written onto the row as
 * `blocked_reason` and rendered on the link, rather than throwing and leaving a
 * caller with an invoice it cannot explain.
 */
async function openGatewayOrder(db: DB, link: any): Promise<any> {
  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, link.orderId)).limit(1);
  if (!order) throw new QuoteOrderError('unknown_order', 'The order this payment link points at is missing.');
  // Settled already — by transfer, in cash at the office, or through a checkout
  // whose link row never got written back. There is nothing left to open, and
  // asking a gateway for the money a second time is the one outcome this whole
  // module exists to prevent.
  if (order.status === 'paid' || order.status === 'fulfilled') return link;
  if (order.status === 'cancelled') {
    throw new QuoteOrderError(
      'order_cancelled',
      `Order ${order.orderNo} for this quotation has been cancelled, so there is nothing to collect against it. ` +
      'Issue a fresh quotation if the engagement is going ahead after all.'
    );
  }
  if (order.totalPaise !== link.amountMinor) {
    throw new QuoteOrderError(
      'amount_mismatch',
      `The order totals ${formatINR(order.totalPaise)} and the quotation ${formatINR(link.amountMinor)}. ` +
      'Refusing to ask a gateway for either figure until they agree.'
    );
  }

  const provider: PaymentProvider | null = activeProvider();
  if (!provider) {
    const [blocked] = await db.update(q.quotePaymentLinks)
      .set({
        blockedReason:
          'No payment provider is configured on this deployment, so the invoice cannot be paid online. ' +
          'The order and the invoice exist and the amount is owed — the federation office arranges settlement directly.',
        updatedAt: new Date(),
      })
      .where(eq(q.quotePaymentLinks.id, link.id))
      .returning();
    return blocked ?? link;
  }

  let providerOrderId: string;
  let checkout: Record<string, unknown>;
  try {
    const created = await provider.createOrder({
      // THE SERVER'S OWN FIGURE, read from the order, which was priced from the
      // quote version. Nothing on this path came from a request body.
      amountPaise: order.totalPaise,
      currency: order.currency,
      reference: order.orderNo,
      idempotencyKey: link.idempotencyKey,
      notes: { quote_version: String(link.quoteVersionId) },
    });
    providerOrderId = created.providerOrderId;
    checkout = created.checkout;
  } catch (err: any) {
    // A gateway that refuses — no keys, wrong mode, an outage — is a state to
    // report, not a reason to lose the invoice. The reason is recorded and the
    // link renders it; a later call retries from here with the same key.
    if (err instanceof PaymentProviderError || (err as any)?.name === 'PaymentModeError') {
      const [blocked] = await db.update(q.quotePaymentLinks)
        .set({ blockedReason: String(err.message).slice(0, 500), updatedAt: new Date() })
        .where(eq(q.quotePaymentLinks.id, link.id))
        .returning();
      return blocked ?? link;
    }
    throw err;
  }

  let payment: any;
  try {
    payment = await beginPayment(db, order.id, {
      provider: provider.id,
      providerOrderId,
      amountPaise: order.totalPaise,
      idempotencyKey: link.idempotencyKey,
    });
  } catch (err: any) {
    // `payments_idempotency_uk` fired: a concurrent call already opened the
    // attempt with this key. Read it rather than open a second one.
    if (!isUniqueViolation(err)) throw err;
    [payment] = await db.select().from(s.payments)
      .where(eq(s.payments.idempotencyKey, link.idempotencyKey)).limit(1);
    if (!payment) throw err;
  }

  const [updated] = await db.update(q.quotePaymentLinks)
    .set({
      provider: provider.id,
      providerOrderId,
      paymentId: payment.id,
      checkout: checkout as any,
      blockedReason: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(q.quotePaymentLinks.id, link.id),
      isNull(q.quotePaymentLinks.providerOrderId),
    ))
    .returning();

  // The guard did not match: another caller filled it first. Theirs stands.
  return updated ?? (await linkRow(db, link.quoteVersionId)) ?? link;
}

/** A stored link row, joined to what a caller needs to render or return it. */
async function hydrate(db: DB, link: any, alreadyExisted: boolean): Promise<PaymentLink> {
  const [order] = link.orderId != null
    ? await db.select().from(s.orders).where(eq(s.orders.id, link.orderId)).limit(1)
    : [null];
  const [invoice] = link.invoiceId != null
    ? await db.select().from(s.invoices).where(eq(s.invoices.id, link.invoiceId)).limit(1)
    : [null];
  const [quote] = await db.select().from(s.quotes).where(eq(s.quotes.id, link.quoteId)).limit(1);
  const [qv] = await db.select().from(s.quoteVersions)
    .where(eq(s.quoteVersions.id, link.quoteVersionId)).limit(1);

  return {
    quoteVersionId: link.quoteVersionId,
    quoteId: link.quoteId,
    ref: quote?.ref ?? null,
    version: qv?.version ?? null,
    payUrl: `/pay/${link.token}`,
    token: link.token,
    orderId: link.orderId,
    orderNo: order?.orderNo ?? '',
    invoiceId: link.invoiceId ?? null,
    invoiceNo: invoice?.invoiceNo ?? null,
    amountMinor: link.amountMinor,
    currency: link.currency,
    provider: link.provider ?? null,
    providerOrderId: link.providerOrderId ?? null,
    checkout: (link.checkout as Record<string, unknown> | null) ?? null,
    blockedReason: link.blockedReason ?? null,
    alreadyExisted,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// READS
// ═══════════════════════════════════════════════════════════════════════════

export interface PayPageView {
  found: boolean;
  orderNo: string;
  invoiceNo: string | null;
  amountMinor: number;
  currency: string;
  amountLabel: string;
  quoteRef: string | null;
  quoteVersion: number | null;
  buyerName: string | null;
  /** awaiting_payment | paid | fulfilled | expired | cancelled … */
  orderStatus: string;
  paid: boolean;
  /**
   * True only where money may still legitimately be collected.
   *
   * A WHITELIST, and deliberately not "not paid and not expired". `cancelled`,
   * `refunded`, `partially_refunded` and `expired` are all statuses in which
   * `paid` is false, so a rule phrased the other way round puts a live Pay
   * button in front of a school whose order the federation has cancelled — or
   * whose money it has just given back.
   */
  collectable: boolean;
  /** The offer's own end date, so the page can say when the link stops working. */
  validUntil: string | null;
  expired: boolean;
  provider: string | null;
  checkout: Record<string, unknown> | null;
  blockedReason: string | null;
}

/**
 * What /pay/<token> renders.
 *
 * THE TOKEN IS THE WHOLE AUTHORISATION, so this returns the narrowest thing
 * that lets somebody pay: an order number, a figure, a status and the
 * provider's public checkout parameters. NOT the quotation's inputs — how many
 * children at how many campuses is the school's own operational detail — NOT
 * the contact rows, NOT the fee rules that produced the figure, and NOT the
 * institution record. A bearer link that leaked would leak an invoice, which is
 * bad, rather than a client file, which is worse.
 *
 * Returns `found: false` rather than throwing for an unknown token, so the page
 * renders one honest sentence instead of a stack trace.
 */
export async function payPageByToken(db: DB, token: string): Promise<PayPageView | null> {
  const t = String(token ?? '').trim();
  // Length-checked before the query: an empty or truncated token must not turn
  // into a LIKE-shaped lookup that matches whatever happens to be shortest.
  if (t.length < 24 || t.length > 128) return null;

  const [link] = await db.select().from(q.quotePaymentLinks)
    .where(eq(q.quotePaymentLinks.token, t)).limit(1);
  if (!link || link.orderId == null) return null;

  const [order] = await db.select().from(s.orders).where(eq(s.orders.id, link.orderId)).limit(1);
  if (!order) return null;
  const [invoice] = link.invoiceId != null
    ? await db.select().from(s.invoices).where(eq(s.invoices.id, link.invoiceId)).limit(1)
    : [null];
  const [quote] = await db.select().from(s.quotes).where(eq(s.quotes.id, link.quoteId)).limit(1);
  const [qv] = await db.select().from(s.quoteVersions)
    .where(eq(s.quoteVersions.id, link.quoteVersionId)).limit(1);

  const validUntil = (qv?.validUntil as string | null) ?? null;
  const paid = order.status === 'paid' || order.status === 'fulfilled';
  // An expired offer is reported as expired even when the order row has not
  // been swept — the page must not offer to take money against a lapsed one.
  const expired = !paid && Boolean(validUntil && validUntil < today());

  return {
    found: true,
    orderNo: order.orderNo,
    invoiceNo: invoice?.invoiceNo ?? null,
    amountMinor: order.totalPaise,
    currency: order.currency,
    amountLabel: formatINR(order.totalPaise),
    quoteRef: quote?.ref ?? null,
    quoteVersion: qv?.version ?? null,
    buyerName: order.buyerName ?? null,
    orderStatus: order.status,
    paid,
    collectable: order.status === 'awaiting_payment' && !expired,
    validUntil,
    expired,
    provider: link.provider ?? null,
    checkout: (link.checkout as Record<string, unknown> | null) ?? null,
    blockedReason: link.blockedReason ?? null,
  };
}

/** The link for a quotation version, or null. For an admin surface. */
export async function paymentLinkFor(db: DB, principal: Principal, quoteVersionId: number): Promise<PaymentLink | null> {
  if (!canAnywhere(principal, 'quote:read')) {
    throw new QuoteOrderError('forbidden', 'Reading a quotation requires quote:read.');
  }
  const link = await linkRow(db, quoteVersionId);
  return link ? hydrate(db, link, true) : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE STATE OF THE LOOP, REPORTED HONESTLY
// ═══════════════════════════════════════════════════════════════════════════

export interface LoopReadiness {
  /** True when an accepted quotation could actually become a payment link. */
  reachable: boolean;
  /** Each precondition, whether it holds, and what publishing it would take. */
  steps: Array<{ step: string; ok: boolean; detail: string }>;
  summary: string;
}

/**
 * Why this path is or is not reachable, in the federation's own terms.
 *
 * WRITTEN FOR THE SCREEN THAT HAS TO SAY "THIS DOES NOT WORK YET". Today the
 * answer is that no fee framework is published, so `computeFee()` can produce
 * no figure, so no quotation carries one, so nothing is payable — and the fix
 * is publishing fees, NOT deploying code. The moment `activeFramework()` returns
 * a framework, every step below flips without a line changing here, which is
 * the property this module was built to have rather than to claim.
 *
 * A payment provider is reported SEPARATELY and is not required for the loop to
 * be reachable: an institution with an invoice owes the money whether or not a
 * gateway exists, and conflating the two would make "we cannot take cards" read
 * as "we cannot bill".
 */
export async function loopReadiness(db: DB): Promise<LoopReadiness> {
  const framework = await activeFramework(db, today());
  const provider = activeProvider();

  // 'issued' OR 'accepted'. Counting only 'issued' made this report worse the
  // better the loop was doing: the moment the one quotation carrying a figure
  // was accepted and invoiced — the loop demonstrably working — the count fell
  // to zero and the screen went back to saying nothing carries a figure.
  const [issued] = await db.select({ n: sql<number>`count(*)::int` })
    .from(s.quoteVersions)
    .where(and(
      eq(s.quoteVersions.requiresManualQuote, false),
      sql`${s.quoteVersions.status} IN ('issued', 'accepted')`,
    ));
  const withFigure = Number(issued?.n ?? 0);

  const steps = [
    {
      step: 'A fee framework is published',
      ok: Boolean(framework),
      detail: framework
        ? `${framework.code} is in force, so a request can be priced.`
        : 'MMAKF has published no fee framework. Until it does, computeFee() prices nothing, every quotation ' +
          'carries "requires a manual quote" instead of a figure, and there is nothing for an invoice to say. ' +
          'This is a decision for the federation, not a missing feature — publishing one is authoring rules ' +
          'through /admin/fees and pressing Publish. No code changes when it happens.',
    },
    {
      step: 'A quotation carries a figure',
      ok: withFigure > 0,
      detail: withFigure > 0
        ? `${withFigure} live quotation${withFigure === 1 ? '' : 's'} carr${withFigure === 1 ? 'ies' : 'y'} a figure.`
        : framework
          ? 'No quotation carrying a figure is live yet. Nothing is wrong: the fees exist and the next request ' +
            'quoted against them gets one.'
          : 'No quotation carries a figure, which follows from the step above rather than being a separate fault.',
    },
    {
      step: 'An accepted quotation can be invoiced',
      ok: true,
      detail: 'The order and invoice path is in place and does not depend on any provider. It runs the moment ' +
        'an accepted quotation with a figure exists.',
    },
    {
      step: 'The invoice can be paid online',
      ok: Boolean(provider),
      detail: provider
        ? `${provider.label} is configured, so the payment link opens a checkout.`
        : 'No payment provider is configured, so the link reports the amount owed and how to settle it rather ' +
          'than opening a checkout. The invoice is still real and is still owed. This does not block the loop.',
    },
  ];

  // THE PUBLISHED FRAMEWORK IS THE WHOLE GATE. Whether a quotation happens to
  // be open right now is a fact about the diary, not about the machinery: a
  // federation that published fees this morning and has not been asked for a
  // quotation since is fully able to bill. Making `reachable` depend on the
  // count as well produced a report that said "MMAKF has published no fee
  // framework" while a framework was published — a false sentence on the one
  // screen whose entire job is to state the true reason.
  const reachable = Boolean(framework);
  return {
    reachable,
    steps,
    summary: !framework
      ? 'This path is unreachable today, and the reason is upstream of it: MMAKF has published no fee framework, ' +
        'so no quotation carries a figure and there is nothing to charge. Publishing fees makes it work with no ' +
        'code change and no deployment.'
      : withFigure > 0
        ? 'An accepted quotation can be turned into an invoice and a payment link.'
        : `${framework.code} is published, so a request can be priced and an accepted quotation becomes an ` +
          'invoice and a payment link. No quotation carrying a figure is live at the moment — the next one ' +
          'quoted against these fees will be.',
  };
}

/** Re-exported so a caller catching order faults does not have to import two modules. */
export { OrderError };
