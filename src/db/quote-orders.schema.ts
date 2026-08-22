// The join between an ACCEPTED QUOTATION and the money that pays it.
//
// Two tables, and the split between them is the point:
//
//   quote_acceptances     WHO agreed to the figure, when, and on what evidence.
//   quote_payment_links   the order, invoice and gateway order that agreement
//                         turned into, and the link that opens them.
//
// They are separate because acceptance can be recorded when nothing is payable.
// MMAKF has no configured payment provider today; an institution that signs a
// quotation has still accepted it, and folding the acceptance into the payment
// row would mean the federation could only record an agreement it could
// simultaneously charge for.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE LINK IS A TABLE AND NOT A COLUMN ON `orders`
// ─────────────────────────────────────────────────────────────────────────────
//
// The obvious shape is `orders.quote_version_id`. It is the wrong one, for a
// reason that only shows up under a retry.
//
// Turning an accepted quotation into something payable is four writes against
// three subsystems — an order, an invoice, a gateway order, a payment attempt —
// and there is a network call in the middle of it. Any of them can be the last
// thing that happens before the process dies. With the link expressed as a
// column on `orders`, the only way to ask "has this quotation already been
// turned into a charge?" is to have already created the order, which is exactly
// the write we are trying not to do twice.
//
// So the FIRST write is a CLAIM on `quote_payment_links`, and
// `quote_payment_links_quote_version_uk` is what makes it a claim rather than a
// hope: two callers racing on the same accepted quotation both attempt the
// insert, one wins, and the loser reads the winner's row and continues from it.
// Nothing downstream of the claim is reached twice, because every later step is
// guarded on the column it fills being still NULL.
//
// The columns fill in order — orderId, invoiceId, then providerOrderId — so the
// row is also a RESUME POINT. A retry after a crash reads how far the previous
// attempt got and does only what is left, rather than starting again.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE AMOUNT IS COPIED ONTO BOTH ROWS
// ─────────────────────────────────────────────────────────────────────────────
//
// Neither copy is the authority — the quote version is, and the order is — and
// nothing recomputes from either. They are here so that a mismatch is
// DETECTABLE: the figure that was accepted, the figure claimed at the start of
// the chain, the figure the order was created at and the figure the gateway was
// asked for must all be the same integer, and the only way to check four things
// against each other is to have all four written down. src/db/quote-to-order.ts
// compares them at every hop and refuses to hand out a link when they disagree.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TOKEN
// ─────────────────────────────────────────────────────────────────────────────
//
// The link an institution opens is `/pay/<token>`, and the token is the whole
// of its authorisation. It is 24 random bytes, and the page behind it shows an
// order number, an amount and a payment button — never a person's contact
// details, never the quotation's inputs, never another institution's anything.
// A sequential id in that URL would have made every institution's payment page
// enumerable from any other's.

import {
  pgTable, serial, text, integer, timestamp,
  uniqueIndex, index, jsonb,
} from 'drizzle-orm/pg-core';
import { users } from './schema';
import { orders, invoices, payments } from './commerce.schema';
import { quotes, quoteVersions } from './engagement.schema';

/**
 * An institution's agreement to a specific quoted figure.
 *
 * APPEND-ONLY IN SPIRIT AND UNIQUE IN FACT. One row per quote version, enforced
 * by `quote_acceptances_quote_version_uk`, so "accept" clicked twice records one
 * agreement. Re-quoting produces a NEW version, which may be accepted in its own
 * right — that is a second agreement to a second figure, and it gets its own row.
 *
 * `acceptedByName` is a person at the INSTITUTION, not an MMAKF account.
 * `recordedByUserId` is the MMAKF account that entered it. Conflating those two
 * would let the federation's own record say a school agreed to something when
 * what actually happened is that a member of staff typed it in.
 */
export const quoteAcceptances = pgTable('quote_acceptances', {
  id: serial('id').primaryKey(),
  quoteVersionId: integer('quote_version_id').notNull().references(() => quoteVersions.id),
  quoteId: integer('quote_id').notNull().references(() => quotes.id),

  /** The person at the institution who agreed. Free text: they are not a member. */
  acceptedByName: text('accepted_by_name').notNull(),
  acceptedByRole: text('accepted_by_role'),

  /**
   * HOW the federation knows. Not decorative — it is the difference between an
   * agreement that can be produced in a dispute and one that cannot.
   * email | signed_document | portal | meeting_minuted
   */
  method: text('method').notNull(),
  /** The message id, document reference or minute number behind `method`. */
  evidenceRef: text('evidence_ref'),
  note: text('note'),

  /** What was accepted, frozen again at the moment of acceptance. */
  totalMinor: integer('total_minor').notNull(),
  currency: text('currency').notNull().default('INR'),

  acceptedAt: timestamp('accepted_at', { withTimezone: true }).notNull().defaultNow(),
  recordedByUserId: integer('recorded_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  versionUk: uniqueIndex('quote_acceptances_quote_version_uk').on(t.quoteVersionId),
  quoteIdx: index('quote_acceptances_quote_idx').on(t.quoteId),
}));

export const quotePaymentLinks = pgTable('quote_payment_links', {
  id: serial('id').primaryKey(),

  /**
   * The VERSION, never the quote.
   *
   * A quote is re-versioned every time it is re-quoted, and the parent row
   * carries no figure at all. Pointing at the parent would mean an institution
   * paying whatever the latest computation happens to say, which is the precise
   * opposite of the guarantee the quote version exists to give.
   */
  quoteVersionId: integer('quote_version_id').notNull().references(() => quoteVersions.id),
  /** Denormalised for the "which quotations are payable?" query, which filters on it. */
  quoteId: integer('quote_id').notNull().references(() => quotes.id),

  /** The bearer secret in `/pay/<token>`. Unguessable, never a database id. */
  token: text('token').notNull(),

  /**
   * ONE key for the whole chain, generated at the claim and never regenerated.
   *
   * It is sent to the gateway as its idempotency header AND stored on the
   * payment attempt, where `payments_idempotency_uk` enforces it. A retry that
   * reaches the gateway again therefore gets the SAME gateway order back rather
   * than a second one, and cannot open a second payment attempt on our side
   * either. Regenerating it on retry — the natural thing to write — would
   * defeat both protections at once.
   */
  idempotencyKey: text('idempotency_key').notNull(),

  /** The frozen figure, copied from the quote version at claim time. See above. */
  amountMinor: integer('amount_minor').notNull(),
  currency: text('currency').notNull().default('INR'),

  // ── Filled in order, each one guarded on being NULL ──
  orderId: integer('order_id').references(() => orders.id),
  invoiceId: integer('invoice_id').references(() => invoices.id),
  paymentId: integer('payment_id').references(() => payments.id),

  provider: text('provider'),
  providerOrderId: text('provider_order_id'),

  /**
   * The provider's public checkout parameters, exactly as it returned them.
   *
   * Stored so the link keeps working across page loads without re-opening a
   * gateway order every time somebody refreshes. NEVER contains a secret — the
   * provider contract forbids it and src/lib/payments/razorpay.ts returns only
   * the public key id.
   */
  checkout: jsonb('checkout'),

  /**
   * Why the chain stopped short of a payable link, when it did.
   *
   * Written when there is no configured payment provider, which is MMAKF's
   * state today. The order and the invoice still exist and the institution
   * still owes the money — what is missing is a way to pay it online, and
   * saying so is better than an empty page.
   */
  blockedReason: text('blocked_reason'),

  createdByUserId: integer('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /** THE IDEMPOTENCY GUARANTEE. One accepted quote version, one charge. */
  quoteVersionUk: uniqueIndex('quote_payment_links_quote_version_uk').on(t.quoteVersionId),
  tokenUk: uniqueIndex('quote_payment_links_token_uk').on(t.token),
  idempotencyUk: uniqueIndex('quote_payment_links_idempotency_uk').on(t.idempotencyKey),
  quoteIdx: index('quote_payment_links_quote_idx').on(t.quoteId),
  orderIdx: index('quote_payment_links_order_idx').on(t.orderId),
}));
