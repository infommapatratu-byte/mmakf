// The entitlement engine — payment activates the service (§15-18, §49-52).
//
// THE GAP THIS CLOSES. The commerce spine could take money, verify the capture
// against the provider's own record, post the double entry and issue a receipt.
// Then it stopped. Nothing turned a captured membership fee into a row in the
// register that /verify reads, an entry fee into a financially cleared entry, or
// a booking fee into a confirmed booking. The payer's card was debited and the
// federation issued them nothing — the transaction was perfectly accounted for
// and completely undelivered.
//
// ONE RULE ABOVE ALL OTHERS: AN ENTITLEMENT IS CREATED ONLY FROM A
// SERVER-VERIFIED PAYMENT.
//
// Not from a browser callback. Not from a client assertion. Not optimistically,
// "because the customer is clearly about to pay". Every function here starts by
// finding a payment row this system has already marked `captured` — which
// src/db/orders.ts only does after checking the provider's own record for
// status, amount and currency. There is no parameter that can substitute for
// that, and `payment_id` is NOT NULL in the schema so no future caller can
// invent one either. A browser that posts "payment succeeded" activates
// NOTHING; it cannot even reach a code path that would.
//
// IDEMPOTENCY IS A DATABASE CONSTRAINT, NOT A CODE PATH. Every gateway retries
// its webhooks, and the reconcile cron retries them again afterwards. The
// UNIQUE index on entitlements.order_line_id is what makes a replay safe: the
// row is CLAIMED FIRST and the membership is issued afterwards, inside the same
// transaction, so a loser's whole transaction — claim and membership together —
// rolls back. A check-then-insert could not do this; two confirmations arriving
// in the same millisecond both read "no entitlement yet".
//
// A NOTE ON renew(), because the brief asked for it to be verified rather than
// assumed. `renew()` in src/db/membership.ts is NOT idempotent, and is not
// meant to be: every call appends a new term and supersedes the previous one,
// which is exactly right for a renewal and exactly wrong as a replay guard —
// two calls leave two membership rows. So the guard is NOT duplicated inside
// renew(); it lives once, in the claim above, and renew() is called at most
// once per order line because the claim decides who may call it.
//
// PAYMENT DOES NOT OVERRIDE ELIGIBILITY. Money arrives before this module gets
// to decide whether what was bought can be issued: an entry may have become
// ineligible, a person record may be missing, the federation may not have
// configured what a membership fee actually buys. In every one of those cases
// the entitlement is RECORDED, with status `blocked` and a reason, and money
// stays taken until a human refunds it. The two unacceptable answers are
// activating anyway and recording nothing.

import { and, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import * as s from './schema';
import { writeAudit, type AuditContext } from './federation';
import { isUniqueViolation } from './pgerror';
import { assertCan, assertCanAnywhere, type Principal } from '@/lib/rbac';
import { publish } from '@/lib/domain-events';
import { renew, type Category } from './membership';
import { checkEntryEligibility, entriesAreLocked } from './competition';

type DB = any; // drizzle client (postgres.js in prod, PGlite in tests)

export class EntitlementError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EntitlementError';
    this.code = code;
  }
}

/** See calendar.ts for why identity is checked by shape and not `instanceof`. */
export function isEntitlementError(err: unknown): err is EntitlementError {
  return Boolean(err) && typeof (err as any).code === 'string' && (err as any).name === 'EntitlementError';
}

export type Subject = (typeof s.entitlementSubject.enumValues)[number];

// ─── Who the system acts as ─────────────────────────────────────────────────

/**
 * The authority an activation is performed under.
 *
 * A webhook arrives at three in the morning with no human behind it, and the
 * writes it causes — issuing a membership, confirming an entry — demand real
 * authority. Two wrong answers were available: loosen `membership:issue` so a
 * principal with no bindings can write to the register, or attribute the act to
 * whichever administrator happened to be logged in. This is the third: the
 * federation acts as ITSELF, under a label that says so in every audit row.
 *
 * The property that matters: this principal is CONSTRUCTED HERE and is never
 * derived from a request. No header, cookie, body field or webhook payload can
 * cause a caller to be treated as the system. Same device, same reasoning, as
 * systemEntryIntakePrincipal() in src/db/competition.ts.
 */
export function systemEntitlementPrincipal(): Principal {
  return {
    userId: null,
    label: 'system:entitlement-activation',
    bindings: [{ role: 'FEDERATION_ADMIN', scopeType: 'national', scopeId: null }],
  };
}

/**
 * The audit context an activation runs under.
 *
 * The caller's ip/requestId/authority are carried through so the trail still
 * says which webhook or cron run caused it — but the PRINCIPAL is replaced,
 * because the caller's principal is a webhook label with no bindings and
 * borrowing it would either fail every write or, worse, tempt someone to
 * weaken the check that made it fail.
 */
export function systemEntitlementContext(from?: AuditContext | null): AuditContext {
  return {
    principal: systemEntitlementPrincipal(),
    ip: from?.ip ?? null,
    requestId: from?.requestId ?? null,
    reason: 'Activated from a server-verified payment capture.',
    authority: from?.authority ?? 'MMAKF entitlement service',
  };
}

// ─── Dates ──────────────────────────────────────────────────────────────────

const isoDate = (v: Date | string | null | undefined): string | null =>
  !v ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

/**
 * The last day of a term of N whole months beginning on `from`.
 *
 * A twelve-month term starting 1 January ends 31 December, not 1 January the
 * following year. One day of overlap is one day of double cover, and it
 * compounds: every renewal issued from the previous term's end shifts the whole
 * series by another day.
 *
 * The month-end clamp is the other half. JavaScript rolls 31 January plus one
 * month into 3 March; a member who paid on the 31st would get two extra days
 * every year, which nobody would notice and nobody could explain.
 */
export function termEndsOn(from: string, months: number): string {
  const d = new Date(`${from}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() !== day) d.setUTCDate(0);      // clamp back into the intended month
  d.setUTCDate(d.getUTCDate() - 1);                 // the day BEFORE the anniversary
  return d.toISOString().slice(0, 10);
}

// ─── What a fee entitles the payer to ───────────────────────────────────────

export interface TermInput {
  feeCode: string;
  subject: Subject;
  membershipCategory?: Category | null;
  termMonths?: number | null;
  openEnded?: boolean;
  notes?: string | null;
  approvedBy?: string | null;
}

/**
 * Record what a fee code buys.
 *
 * Gated on 'feeframework:write' rather than 'finance:write' for the reason
 * src/db/fees.ts gives for the same choice: whoever edits a rule changes every
 * future outcome silently, and recording a payment is a different job from
 * deciding what payments produce. A finance officer reconciling settlements has
 * no business lengthening the membership year.
 */
export async function configureTerm(db: DB, ctx: AuditContext, input: TermInput) {
  assertCan(ctx.principal, 'feeframework:write', {});

  const feeCode = String(input.feeCode ?? '').trim();
  if (!feeCode) throw new EntitlementError('bad_fee_code', 'A term must name the fee code it applies to.');
  if (!s.entitlementSubject.enumValues.includes(input.subject)) {
    throw new EntitlementError('bad_subject', `Unknown entitlement subject ${JSON.stringify(input.subject)}.`);
  }
  // The same refusal the fee schedule makes about an unpublished amount: a term
  // nobody stated is not defaulted to twelve months here.
  const openEnded = input.openEnded === true;
  const termMonths = input.termMonths ?? null;
  if (!openEnded && (!Number.isInteger(termMonths) || (termMonths as number) < 1)) {
    throw new EntitlementError(
      'term_not_stated',
      'State a term in whole months, or openEnded: true to record an entitlement the federation has decided has no expiry. ' +
      'There is no default: a term this system invented would be applied to every member who pays this fee.'
    );
  }
  if (input.subject === 'membership' && !input.membershipCategory) {
    throw new EntitlementError(
      'category_not_stated',
      'A membership fee must say WHICH register it admits the payer to. Deriving it from the fee code would be this system setting MMAKF policy by string match.'
    );
  }

  const values = {
    feeCode,
    subject: input.subject,
    membershipCategory: (input.membershipCategory ?? null) as any,
    termMonths: openEnded ? null : (termMonths as number),
    openEnded,
    notes: input.notes ?? null,
    approvedBy: input.approvedBy ?? null,
    setByUserId: ctx.principal.userId ?? null,
    updatedAt: new Date(),
  };

  const [row] = await db.insert(s.entitlementTerms).values(values)
    .onConflictDoUpdate({ target: s.entitlementTerms.feeCode, set: values })
    .returning();

  await writeAudit(db, ctx, {
    entityType: 'entitlement_term', entityId: row.id, action: 'update',
    newValue: { feeCode, subject: input.subject, termMonths: values.termMonths, openEnded },
  });
  return row;
}

export async function termFor(db: DB, feeCode: string | null | undefined) {
  if (!feeCode) return null;
  return (await db.select().from(s.entitlementTerms)
    .where(eq(s.entitlementTerms.feeCode, feeCode)).limit(1))[0] ?? null;
}

// ─── Which lines entitle the payer to anything ──────────────────────────────

/**
 * The line's `refType` is consulted FIRST, because it is the only field that
 * names the actual thing bought. `kind` is a billing category — a booking fee
 * and a seminar fee can both be `course` — and routing on it alone would
 * confirm the wrong object.
 */
const SUBJECT_BY_REF_TYPE: Record<string, Subject> = {
  membership: 'membership',
  event_entry: 'event_entry',
  entry: 'event_entry',
  grading: 'grading',
  booking: 'booking',
  course: 'course',
  certificate: 'certificate',
  document: 'document',
};

const SUBJECT_BY_KIND: Record<string, Subject> = {
  membership: 'membership',
  event_entry: 'event_entry',
  grading: 'grading',
  course: 'course',
  certificate: 'certificate',
};

/**
 * The subject an order line activates, or null when it activates nothing.
 *
 * `product`, `donation` and `other` legitimately entitle the payer to nothing
 * in this table — a gi is fulfilled by the despatch process and a donation buys
 * no service. `affiliation` returns null too, and that is a GAP rather than a
 * decision: a dojo's affiliation is a credential and belongs here, but the
 * subject vocabulary in migration 0019 has no term for it, and inventing one
 * silently would leave affiliation payments looking activated when nothing had
 * been issued. They are reported as `not_entitling` and appear in no backlog,
 * so the omission is visible rather than mistaken for coverage.
 */
export function subjectForLine(line: { kind: string; refType?: string | null }): Subject | null {
  const byRef = line.refType ? SUBJECT_BY_REF_TYPE[line.refType] : undefined;
  return byRef ?? SUBJECT_BY_KIND[line.kind] ?? null;
}

// ─── Activation ─────────────────────────────────────────────────────────────

export interface ActivationOutcome {
  orderLineId: number;
  subject: Subject | null;
  entitlementId: number | null;
  subjectId: number | null;
  /**
   * `replayed` is not a failure — it is the guard doing its job. It means this
   * line already carried an entitlement, so nothing was issued a second time.
   */
  status: 'active' | 'blocked' | 'replayed' | 'not_entitling';
  reason: string | null;
}

export interface ActivationReport {
  orderId: number;
  paymentId: number;
  activated: number;
  blocked: number;
  replayed: number;
  outcomes: ActivationOutcome[];
}

/** A decision taken from reads alone, BEFORE anything is written. */
type Decision =
  | { activate: true; act: (tx: DB) => Promise<number | null>; detail: Record<string, unknown> }
  | { activate: false; reason: string; detail: Record<string, unknown> };

/**
 * Activate everything a paid order entitles its payer to.
 *
 * REFUSES WITHOUT A VERIFIED CAPTURE. The first thing it does is look for a
 * payment row this system marked `captured` — and that flag is only ever set by
 * confirmPayment() against the provider's own record. There is no way to reach
 * an activation from a browser's claim of success, which is the entire point of
 * the module.
 *
 * SAFE TO RE-RUN, ALWAYS. Every line is claimed through a unique index, so a
 * webhook retry, a cron sweep and an administrator pressing the button all
 * converge on the same one membership. That is also why the reconcile path can
 * simply call this again rather than reasoning about what happened last time.
 *
 * DOES NOT THROW FOR A DOMAIN REFUSAL. An ineligible entry or an unconfigured
 * term produces a `blocked` row, because the money has already been taken and
 * an exception that rolls back the record would leave nothing behind to refund
 * against. It throws only for faults that a retry might genuinely fix.
 */
export async function activateForOrder(
  db: DB,
  ctx: AuditContext | null,
  orderId: number,
  opts: { now?: Date } = {}
): Promise<ActivationReport> {
  const now = opts.now ?? new Date();
  const order = (await db.select().from(s.orders).where(eq(s.orders.id, orderId)).limit(1))[0];
  if (!order) throw new EntitlementError('unknown_order', 'Unknown order');

  // ── THE GATE. A captured payment, read from this database, or nothing. ────
  const payment = (await db.select().from(s.payments)
    .where(and(eq(s.payments.orderId, order.id), eq(s.payments.status, 'captured')))
    .orderBy(desc(s.payments.id)).limit(1))[0];
  if (!payment) {
    throw new EntitlementError(
      'no_verified_payment',
      `Order ${order.orderNo} has no payment this system has verified as captured. ` +
      'An entitlement is created only from a server-verified capture — a browser reporting success is a claim, not a fact.'
    );
  }
  // A captured payment whose order never became paid is the "money taken, order
  // still awaiting payment" wreck confirmPayment() names. Activating over it
  // would bury the evidence under a membership.
  if (order.status !== 'paid' && order.status !== 'fulfilled') {
    throw new EntitlementError(
      'order_not_paid',
      `Order ${order.orderNo} carries a captured payment but its status is '${order.status}'. ` +
      'That is an incomplete confirmation, and it needs a human rather than an entitlement.'
    );
  }

  const invoice = (await db.select({ id: s.invoices.id }).from(s.invoices)
    .where(eq(s.invoices.orderId, order.id)).limit(1))[0] ?? null;
  const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));

  const activationCtx = systemEntitlementContext(ctx);
  const outcomes: ActivationOutcome[] = [];

  for (const line of lines) {
    const subject = subjectForLine(line);
    if (!subject) {
      outcomes.push({
        orderLineId: line.id, subject: null, entitlementId: null, subjectId: null,
        status: 'not_entitling', reason: `A ${line.kind} line entitles the payer to nothing in the register.`,
      });
      continue;
    }
    outcomes.push(await activateLine(db, activationCtx, { order, line, subject, payment, invoice, now }));
  }

  return {
    orderId: order.id,
    paymentId: payment.id,
    activated: outcomes.filter((o) => o.status === 'active').length,
    blocked: outcomes.filter((o) => o.status === 'blocked').length,
    replayed: outcomes.filter((o) => o.status === 'replayed').length,
    outcomes,
  };
}

interface LineContext {
  order: any;
  line: any;
  subject: Subject;
  payment: any;
  invoice: { id: number } | null;
  now: Date;
}

async function activateLine(db: DB, ctx: AuditContext, c: LineContext): Promise<ActivationOutcome> {
  try {
    return await db.transaction(async (tx: DB) => claimAndAct(tx, ctx, c));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    // Which constraint fired decides what this was. The order-line index means
    // the line already has an entitlement — an ordinary replay, and the reason
    // the whole design claims to be idempotent. Anything else means the SUBJECT
    // is already spoken for by a different order, which is a real conflict and
    // is recorded as one rather than swallowed.
    const existing = (await db.select().from(s.entitlements)
      .where(eq(s.entitlements.orderLineId, c.line.id)).limit(1))[0];
    if (existing) {
      return {
        orderLineId: c.line.id, subject: existing.subject, entitlementId: existing.id,
        subjectId: existing.subjectId ?? null, status: 'replayed',
        reason: 'This line was already entitled; nothing was issued a second time.',
      };
    }
    return blockOutside(db, ctx, c,
      'Another entitlement is already active for this exact subject. Two payments cannot clear the same thing twice.');
  }
}

/**
 * CLAIM FIRST, THEN ACT — the ordering that makes replay safe.
 *
 * The entitlement row is inserted BEFORE the membership is issued, so the
 * unique index decides which of two concurrent confirmations proceeds. The
 * loser's insert raises a unique violation, its whole transaction rolls back,
 * and the membership it was about to issue is never issued. Acting first and
 * recording afterwards would leave the second membership already written by the
 * time the constraint spoke.
 */
async function claimAndAct(tx: DB, ctx: AuditContext, c: LineContext): Promise<ActivationOutcome> {
  const decision = await decide(tx, c);
  const feeVersion = await resolveFeeVersion(tx, c.line);

  const [row] = await tx.insert(s.entitlements).values({
    subject: c.subject,
    subjectId: null,
    orderId: c.order.id,
    orderLineId: c.line.id,
    paymentId: c.payment.id,
    invoiceId: c.invoice?.id ?? null,
    feeVersion,
    status: decision.activate ? 'active' : 'blocked',
    activatedAt: decision.activate ? c.now : null,
    activatedBy: ctx.principal.label,
    activatedByUserId: ctx.principal.userId ?? null,
    reason: decision.activate ? null : decision.reason,
    detail: decision.detail as any,
  }).returning();

  let subjectId: number | null = null;
  if (decision.activate) {
    subjectId = await decision.act(tx);
    if (subjectId != null) {
      await tx.update(s.entitlements)
        .set({ subjectId, updatedAt: new Date() })
        .where(eq(s.entitlements.id, row.id));
    }
  }

  await writeAudit(tx, ctx, {
    entityType: 'entitlement', entityId: row.id, action: 'create',
    newValue: {
      subject: c.subject, subjectId,
      status: decision.activate ? 'active' : 'blocked',
      orderNo: c.order.orderNo, paymentId: c.payment.id,
      reason: decision.activate ? null : decision.reason,
    },
  });

  await publish(tx, {
    eventType: decision.activate ? 'ENTITLEMENT_ACTIVATED' : 'ENTITLEMENT_BLOCKED',
    entityType: 'entitlement',
    entityId: row.id,
    payload: {
      subject: c.subject, subjectId,
      orderId: c.order.id, orderLineId: c.line.id, paymentId: c.payment.id,
      personId: c.order.personId ?? null,
      reason: decision.activate ? null : decision.reason,
    },
    // The same logical fact republished — by a webhook retry that got past the
    // claim, say — is one event, not two.
    correlationId: `entitlement:line:${c.line.id}`,
    actor: ctx.principal,
    occurredAt: c.now,
  });

  return {
    orderLineId: c.line.id, subject: c.subject, entitlementId: row.id, subjectId,
    status: decision.activate ? 'active' : 'blocked',
    reason: decision.activate ? null : decision.reason,
  };
}

/** Record a blocked entitlement in its own transaction, after a failed claim. */
async function blockOutside(db: DB, ctx: AuditContext, c: LineContext, reason: string): Promise<ActivationOutcome> {
  const [row] = await db.insert(s.entitlements).values({
    subject: c.subject, subjectId: null,
    orderId: c.order.id, orderLineId: c.line.id, paymentId: c.payment.id,
    invoiceId: c.invoice?.id ?? null,
    feeVersion: await resolveFeeVersion(db, c.line),
    status: 'blocked', activatedBy: ctx.principal.label, reason,
    detail: { conflict: true } as any,
  }).returning();

  await writeAudit(db, ctx, {
    entityType: 'entitlement', entityId: row.id, action: 'create',
    newValue: { subject: c.subject, status: 'blocked', reason },
  });
  await publish(db, {
    eventType: 'ENTITLEMENT_BLOCKED', entityType: 'entitlement', entityId: row.id,
    payload: { subject: c.subject, orderId: c.order.id, orderLineId: c.line.id, reason },
    correlationId: `entitlement:line:${c.line.id}`, actor: ctx.principal,
  });

  return {
    orderLineId: c.line.id, subject: c.subject, entitlementId: row.id,
    subjectId: null, status: 'blocked', reason,
  };
}

/**
 * WHICH published fee priced this line, recorded verbatim.
 *
 * Stored rather than derived at read time, because a fee schedule edited next
 * year must not retell what somebody was charged this year. Null when the line
 * was not priced from the schedule at all — never a fabricated version string,
 * for the same reason an unknown amount is never rendered as zero.
 */
async function resolveFeeVersion(db: DB, line: any): Promise<string | null> {
  if (!line.feeCode) return line.variantId ? `variant:${line.variantId}` : null;
  const fee = (await db.select().from(s.feeSchedule)
    .where(and(eq(s.feeSchedule.code, line.feeCode), eq(s.feeSchedule.active, true)))
    .orderBy(desc(s.feeSchedule.effectiveFrom)).limit(1))[0];
  return fee ? `${fee.code}@${isoDate(fee.effectiveFrom)}#${fee.id}` : null;
}

// ─── The decisions, one subject at a time ───────────────────────────────────

async function decide(tx: DB, c: LineContext): Promise<Decision> {
  switch (c.subject) {
    case 'membership': return decideMembership(tx, c);
    case 'event_entry': return decideEventEntry(tx, c);
    case 'booking': return decideBooking(tx, c);
    default: return decideRecordOnly(tx, c);
  }
}

/**
 * A paid membership fee becomes a row in the Postgres register — the one
 * /verify reads.
 *
 * WHAT IT WILL NOT DO: invent a term. The federation has published no
 * membership length, and `renew()` refuses to assume one for exactly the reason
 * this module refuses to assume anything else. Where no term is configured for
 * the fee code, the payment produces a blocked entitlement that names the
 * missing configuration — visible, refundable, and impossible to mistake for a
 * membership that was issued.
 */
async function decideMembership(tx: DB, c: LineContext): Promise<Decision> {
  const personId: number | null = c.order.personId
    ?? (c.line.refType === 'person' ? c.line.refId : null)
    ?? null;
  if (!personId) {
    return {
      activate: false,
      reason: 'The order names no person, so there is no register entry to issue the membership against.',
      detail: { orderNo: c.order.orderNo, email: c.order.email ?? null },
    };
  }

  const person = (await tx.select().from(s.persons).where(eq(s.persons.id, personId)).limit(1))[0];
  if (!person) {
    return { activate: false, reason: `Person ${personId} is not in the register.`, detail: { personId } };
  }

  const term = await termFor(tx, c.line.feeCode);
  if (!term) {
    return {
      activate: false,
      reason: `No entitlement term is configured for fee code '${c.line.feeCode ?? '(none)'}'. ` +
        'The federation has not stated which membership this fee buys or how long it runs, and this system will not decide that on its behalf.',
      detail: { feeCode: c.line.feeCode ?? null },
    };
  }
  if (!term.membershipCategory) {
    return {
      activate: false,
      reason: `The term for '${term.feeCode}' does not say which membership category it admits the payer to.`,
      detail: { feeCode: term.feeCode },
    };
  }
  if (!term.openEnded && !term.termMonths) {
    return {
      activate: false,
      reason: `The term for '${term.feeCode}' states no length and is not marked open-ended.`,
      detail: { feeCode: term.feeCode },
    };
  }

  const category = term.membershipCategory as Category;
  // The term runs from the day the money was taken, not the day this ran. A
  // reconcile sweep three days later must not shorten what the member bought.
  const validFrom = isoDate(c.order.paidAt ?? c.payment.capturedAt ?? c.now)!;
  const validTo = term.openEnded ? null : termEndsOn(validFrom, term.termMonths as number);

  // renew() refuses to issue over a REVOKED membership, and it is right to:
  // that would let a payment reverse a federation decision. Read it here so the
  // refusal becomes a blocked entitlement with an explanation rather than an
  // exception that rolls back the record of the payment.
  const prior = (await tx.select().from(s.memberships)
    .where(and(eq(s.memberships.personId, personId), eq(s.memberships.category, category)))
    .orderBy(desc(s.memberships.validFrom), desc(s.memberships.id)).limit(1))[0];
  if (prior?.status === 'revoked') {
    return {
      activate: false,
      reason: 'The most recent membership in this category was REVOKED by the federation. ' +
        'A payment does not reverse a revocation; the revocation has to be addressed on its own terms, and this fee refunded or applied afterwards.',
      detail: { personId, category, previousMembershipId: prior.id },
    };
  }

  return {
    activate: true,
    detail: { personId, category, validFrom, validTo, feeCode: term.feeCode, termMonths: term.termMonths ?? null, openEnded: term.openEnded },
    act: async (db: DB) => {
      const result = await renew(db, systemEntitlementContext(), {
        personId, category, validFrom, validTo,
      });
      return result.membershipId;
    },
  };
}

/**
 * A paid entry fee clears the entry — ONLY IF the entry still stands and
 * eligibility still holds.
 *
 * ELIGIBILITY IS RE-CHECKED AGAINST THE RECORD AS IT IS NOW, not against the
 * snapshot taken when the entry was lodged. Entries open months before a
 * championship; a membership can lapse and a category can be corrected in
 * between. Confirming on the strength of a stale snapshot is how an uninsured
 * competitor reaches the mat, and paying the fee is not a cure for it. Where the
 * check now fails, the money stays taken and the entitlement is blocked with the
 * reasons, so the desk can refund it and tell the competitor why.
 */
async function decideEventEntry(tx: DB, c: LineContext): Promise<Decision> {
  const entryId: number | null = c.line.refId ?? null;
  if (!entryId) {
    return {
      activate: false,
      reason: 'The order line names no entry, so there is nothing to clear.',
      detail: { orderNo: c.order.orderNo },
    };
  }

  const entry = (await tx.select().from(s.eventEntries).where(eq(s.eventEntries.id, entryId)).limit(1))[0];
  if (!entry) {
    return { activate: false, reason: `Entry ${entryId} no longer exists.`, detail: { entryId } };
  }

  const DEAD: string[] = ['withdrawn', 'disqualified', 'no_show', 'ineligible'];
  if (DEAD.includes(entry.status)) {
    return {
      activate: false,
      reason: `Entry ${entry.entryNo} is ${String(entry.status).replace(/_/g, ' ')} and cannot be cleared by a payment.`,
      detail: { entryId, status: entry.status, ineligibleReason: entry.ineligibleReason ?? null },
    };
  }

  const event = (await tx.select().from(s.competitionEvents)
    .where(eq(s.competitionEvents.id, entry.eventId)).limit(1))[0];
  if (event && entriesAreLocked(event)) {
    return {
      activate: false,
      reason: `This event’s results are final; its entry list is history and a payment cannot change it now.`,
      detail: { entryId, eventId: entry.eventId },
    };
  }

  // Team entries are judged member by member — the entry itself carries no
  // personId, and clearing one on the strength of the captain alone would put
  // an ineligible team-mate on the mat.
  const competitors: number[] = entry.personId
    ? [entry.personId]
    : (await tx.select({ personId: s.entryMembers.personId }).from(s.entryMembers)
        .where(eq(s.entryMembers.entryId, entry.id))).map((m: any) => m.personId);

  if (!competitors.length) {
    return {
      activate: false,
      reason: `Entry ${entry.entryNo} names no competitor, so eligibility cannot be established.`,
      detail: { entryId },
    };
  }

  const checks: any[] = [];
  const failures: string[] = [];
  for (const personId of competitors) {
    const result = await checkEntryEligibility(tx, systemEntitlementPrincipal(), personId, entry.categoryId, c.now);
    checks.push({ personId, eligible: result.eligible, asOf: result.asOf, reasons: result.reasons });
    if (!result.eligible) failures.push(`${personId}: ${result.reasons.join(' ')}`);
  }

  if (failures.length) {
    return {
      activate: false,
      reason: `Entry ${entry.entryNo} no longer meets this category’s rules, and a paid fee does not override eligibility. ${failures.join(' | ')}`,
      detail: { entryId, checks },
    };
  }

  const CLEARABLE: string[] = ['draft', 'submitted', 'eligibility_check', 'fee_pending'];
  return {
    activate: true,
    detail: { entryId, entryNo: entry.entryNo, previousStatus: entry.status, checks },
    act: async (db: DB) => {
      // Past confirmation — checked in, weighed in — is match-day history and is
      // left exactly as it is. The entitlement still records that the fee was
      // paid, which is the question this table answers.
      if (CLEARABLE.includes(entry.status)) {
        await db.update(s.eventEntries)
          .set({ status: 'confirmed', orderId: c.order.id, updatedAt: c.now })
          .where(eq(s.eventEntries.id, entry.id));

        await writeAudit(db, systemEntitlementContext(), {
          entityType: 'event_entry', entityId: entry.id, action: 'approve',
          oldValue: { status: entry.status },
          newValue: { status: 'confirmed', orderId: c.order.id, entryNo: entry.entryNo },
        });
      }
      return entry.id;
    },
  };
}

/** A paid booking fee confirms the booking. */
async function decideBooking(tx: DB, c: LineContext): Promise<Decision> {
  const bookingId: number | null = c.line.refId ?? null;
  if (!bookingId) {
    return { activate: false, reason: 'The order line names no booking.', detail: { orderNo: c.order.orderNo } };
  }
  const booking = (await tx.select().from(s.bookings).where(eq(s.bookings.id, bookingId)).limit(1))[0];
  if (!booking) {
    return { activate: false, reason: `Booking ${bookingId} no longer exists.`, detail: { bookingId } };
  }

  // A slot that has been given back, or a session that has already happened.
  // Confirming either would put the diary at odds with what took place.
  const GONE: string[] = ['cancelled', 'expired', 'completed', 'no_show'];
  if (GONE.includes(booking.status)) {
    return {
      activate: false,
      reason: `Booking ${booking.ref} is ${String(booking.status).replace(/_/g, ' ')}; a payment cannot confirm it.`,
      detail: { bookingId, status: booking.status },
    };
  }

  return {
    activate: true,
    detail: { bookingId, ref: booking.ref, previousStatus: booking.status },
    act: async (db: DB) => {
      if (booking.status !== 'confirmed') {
        await db.update(s.bookings)
          .set({ status: 'confirmed', updatedAt: c.now })
          .where(eq(s.bookings.id, booking.id));
        await writeAudit(db, systemEntitlementContext(), {
          entityType: 'booking', entityId: booking.id, action: 'update',
          oldValue: { status: booking.status },
          newValue: { status: 'confirmed', paidByOrder: c.order.orderNo },
        });
      }
      return booking.id;
    },
  };
}

/**
 * Gradings, courses, certificates and documents.
 *
 * The entitlement records that the fee is PAID and points at what it was paid
 * for. It deliberately issues nothing: a grading is passed and a certificate is
 * awarded by an examiner, not bought, and a module that issued them on payment
 * would be selling credentials. Recording payment is the whole job here, and the
 * desks that award things read this table to see that the fee is settled.
 */
async function decideRecordOnly(_tx: DB, c: LineContext): Promise<Decision> {
  const refId: number | null = c.line.refId ?? null;
  return {
    activate: true,
    detail: {
      recordsPaymentOnly: true,
      refType: c.line.refType ?? null,
      note: 'The fee is settled. Issuing the credential itself remains a separate decision by the desk that awards it.',
    },
    act: async () => refId,
  };
}

// ─── Refund reverses it ─────────────────────────────────────────────────────

export interface RevocationOutcome {
  entitlementId: number;
  subject: Subject;
  subjectId: number | null;
  status: 'revoked' | 'retained';
  reason: string;
}

export interface RevocationReport {
  refundId: number;
  orderId: number;
  fullyRefunded: boolean;
  revoked: number;
  outcomes: RevocationOutcome[];
}

/**
 * A COMPLETED refund reverses what the payment activated.
 *
 * `completed` and nothing less. A requested or processing refund is an
 * intention; revoking a membership on an intention would strip a member of
 * their standing over a refund that may still fail at the gateway.
 *
 * NOTHING IS DELETED. The entitlement keeps its row, its subject, its order and
 * its receipt, and gains a revocation timestamp, the refund that caused it and
 * the reason. A refunded membership is a REVOKED membership with a history —
 * the person still holds whatever was sent to them, and a register that had
 * quietly forgotten the transaction could not explain why it no longer counts.
 *
 * A PARTIAL REFUND REVOKES NOTHING, and says so. Which half of a service is
 * withdrawn when half the fee comes back is a federation decision nobody has
 * taken; guessing it would either strip a member who is still owed the service
 * or leave one entitled who is not. The outcomes report says plainly that the
 * entitlements were retained, so the desk can act deliberately.
 */
export async function revokeForRefund(
  db: DB,
  ctx: AuditContext,
  refundId: number,
  opts: { now?: Date } = {}
): Promise<RevocationReport> {
  const now = opts.now ?? new Date();
  const refund = (await db.select().from(s.refunds).where(eq(s.refunds.id, refundId)).limit(1))[0];
  if (!refund) throw new EntitlementError('unknown_refund', 'Unknown refund');
  if (refund.status !== 'completed') {
    throw new EntitlementError(
      'refund_not_completed',
      `Refund ${refundId} is '${refund.status}'. An entitlement is reversed by a refund that actually completed, never by one that was merely requested.`
    );
  }

  const payment = (await db.select().from(s.payments).where(eq(s.payments.id, refund.paymentId)).limit(1))[0];
  const siblings = await db.select().from(s.refunds).where(eq(s.refunds.paymentId, refund.paymentId));
  const refunded = siblings
    .filter((r: any) => r.status === 'completed')
    .reduce((sum: number, r: any) => sum + r.amountPaise, 0);
  const fullyRefunded = Boolean(payment) && refunded >= payment.amountPaise;

  const active = await db.select().from(s.entitlements).where(and(
    eq(s.entitlements.paymentId, refund.paymentId),
    eq(s.entitlements.status, 'active')
  ));

  const revocationCtx: AuditContext = {
    ...ctx,
    principal: systemEntitlementPrincipal(),
    reason: refund.reason,
    authority: ctx.authority ?? 'MMAKF entitlement service',
  };

  const outcomes: RevocationOutcome[] = [];
  for (const ent of active) {
    if (!fullyRefunded) {
      outcomes.push({
        entitlementId: ent.id, subject: ent.subject, subjectId: ent.subjectId ?? null,
        status: 'retained',
        reason: 'Partially refunded. What a part refund withdraws is a federation decision, so nothing was withdrawn automatically.',
      });
      continue;
    }
    outcomes.push(await revokeOne(db, revocationCtx, ent, refund, now));
  }

  return {
    refundId: refund.id, orderId: refund.orderId, fullyRefunded,
    revoked: outcomes.filter((o) => o.status === 'revoked').length,
    outcomes,
  };
}

async function revokeOne(db: DB, ctx: AuditContext, ent: any, refund: any, now: Date): Promise<RevocationOutcome> {
  const reason = `Refunded: ${refund.reason}`;

  await db.transaction(async (tx: DB) => {
    await tx.update(s.entitlements).set({
      status: 'revoked',
      revokedAt: now,
      refundId: refund.id,
      reason,
      updatedAt: now,
    }).where(eq(s.entitlements.id, ent.id));

    await reverseSubject(tx, ctx, ent, reason, now);

    await writeAudit(tx, ctx, {
      entityType: 'entitlement', entityId: ent.id, action: 'revoke',
      oldValue: { status: 'active', subject: ent.subject, subjectId: ent.subjectId },
      newValue: { status: 'revoked', refundId: refund.id, reason },
    });

    await publish(tx, {
      eventType: 'ENTITLEMENT_REVOKED', entityType: 'entitlement', entityId: ent.id,
      payload: {
        subject: ent.subject, subjectId: ent.subjectId ?? null,
        orderId: ent.orderId, refundId: refund.id, reason,
      },
      correlationId: `entitlement:revoke:${ent.id}:${refund.id}`,
      actor: ctx.principal,
      occurredAt: now,
    });
  });

  return {
    entitlementId: ent.id, subject: ent.subject, subjectId: ent.subjectId ?? null,
    status: 'revoked', reason,
  };
}

/** Undo the thing itself, in the module that owns it, never by deleting a row. */
async function reverseSubject(tx: DB, ctx: AuditContext, ent: any, reason: string, now: Date): Promise<void> {
  if (ent.subjectId == null) return;

  if (ent.subject === 'membership') {
    const row = (await tx.select().from(s.memberships).where(eq(s.memberships.id, ent.subjectId)).limit(1))[0];
    if (!row || row.status === 'revoked') return;
    // Through the membership module, so the lifecycle rules and the audit row
    // are the same ones a human revocation produces. A refunded membership must
    // read as revoked everywhere, not as a special case only this table knows.
    const { revoke } = await import('./membership');
    await revoke(tx, ctx, ent.subjectId, reason);
    return;
  }

  if (ent.subject === 'event_entry') {
    const entry = (await tx.select().from(s.eventEntries).where(eq(s.eventEntries.id, ent.subjectId)).limit(1))[0];
    if (!entry) return;
    // Back to fee_pending, not to withdrawn. The competitor did not withdraw —
    // the fee was returned, so the entry is exactly what it was before the money
    // arrived: lodged and unpaid. decideEntry() refuses to confirm it in that
    // state, which is the correct consequence.
    if (entry.status !== 'confirmed') return;
    await tx.update(s.eventEntries)
      .set({ status: 'fee_pending', updatedAt: now })
      .where(eq(s.eventEntries.id, entry.id));
    await writeAudit(tx, ctx, {
      entityType: 'event_entry', entityId: entry.id, action: 'update',
      oldValue: { status: 'confirmed' },
      newValue: { status: 'fee_pending', reason },
    });
    return;
  }

  if (ent.subject === 'booking') {
    const booking = (await tx.select().from(s.bookings).where(eq(s.bookings.id, ent.subjectId)).limit(1))[0];
    if (!booking) return;
    const GONE: string[] = ['cancelled', 'expired', 'completed', 'no_show'];
    if (GONE.includes(booking.status)) return;
    const { cancel } = await import('./booking');
    await cancel(tx, ctx, booking.id, reason);
  }
  // grading / course / certificate / document record payment only, so there is
  // nothing to undo beyond the entitlement row itself.
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export async function entitlementsForOrder(db: DB, principal: Principal, orderId: number) {
  assertCanAnywhere(principal, 'finance:read');
  return db.select().from(s.entitlements)
    .where(eq(s.entitlements.orderId, orderId))
    .orderBy(s.entitlements.id);
}

/**
 * The exceptions queue: money taken for something that was not issued.
 *
 * This is the list somebody has to work. Every row is a payer who has been
 * charged and has received nothing, and each one ends either in an activation
 * once the obstacle is cleared or in a refund.
 */
export async function blockedEntitlements(db: DB, principal: Principal, limit = 100) {
  assertCanAnywhere(principal, 'finance:read');
  return db.select({
    id: s.entitlements.id,
    subject: s.entitlements.subject,
    orderId: s.entitlements.orderId,
    orderNo: s.orders.orderNo,
    totalPaise: s.orders.totalPaise,
    email: s.orders.email,
    reason: s.entitlements.reason,
    createdAt: s.entitlements.createdAt,
  })
    .from(s.entitlements)
    .innerJoin(s.orders, eq(s.orders.id, s.entitlements.orderId))
    .where(eq(s.entitlements.status, 'blocked'))
    .orderBy(desc(s.entitlements.id))
    .limit(limit);
}

/**
 * Paid order lines that entitle the payer to something and carry no entitlement
 * at all.
 *
 * The failure this detects is the one that is otherwise invisible: activation
 * that never ran, because a process died between the capture and the
 * activation. A blocked entitlement announces itself; a missing one is silence,
 * and silence is what this query converts into a list.
 */
export async function activationBacklog(db: DB, principal: Principal, limit = 100) {
  assertCanAnywhere(principal, 'finance:read');
  const entitlingKinds = Object.keys(SUBJECT_BY_KIND);
  return db.select({
    orderId: s.orders.id,
    orderNo: s.orders.orderNo,
    orderLineId: s.orderLines.id,
    kind: s.orderLines.kind,
    refType: s.orderLines.refType,
    refId: s.orderLines.refId,
    description: s.orderLines.description,
    paidAt: s.orders.paidAt,
  })
    .from(s.orderLines)
    .innerJoin(s.orders, eq(s.orders.id, s.orderLines.orderId))
    .leftJoin(s.entitlements, eq(s.entitlements.orderLineId, s.orderLines.id))
    .where(and(
      inArray(s.orders.status, ['paid', 'fulfilled']),
      isNull(s.entitlements.id),
      // Product, donation and affiliation lines are not activated by this
      // engine, and listing them would train whoever works this queue to ignore
      // it. See subjectForLine() on why affiliation is a stated gap.
      inArray(s.orderLines.kind, entitlingKinds as any),
    ))
    .orderBy(desc(s.orders.paidAt))
    .limit(limit);
}
