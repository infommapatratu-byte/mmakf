// The second hop: an accepted quotation becomes an invoice and a payment link.
//
// The properties asserted here are the ones that cost money when they are
// wrong, so each one is exercised against a real Postgres engine (PGlite) with
// every migration applied, not against a mock:
//
//   · THE AMOUNT COMES FROM THE QUOTE VERSION, and a fee change published
//     afterwards does not move it by one paisa.
//   · An expired, unapproved, unaccepted or figureless quotation is NOT payable,
//     and each refusal says what to do next.
//   · Accepting twice produces ONE acceptance, ONE order, ONE invoice and ONE
//     gateway order. A second call returns the existing link.
//   · With no fee framework — MMAKF's actual state — the whole path is
//     unreachable and says why, without inventing a figure anywhere.
//
// THE FIGURES BELOW ARE TEST FIXTURES AND ARE NOT MMAKF'S FEES. The federation
// has published none; the engine ships empty for exactly that reason.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { eq } from 'drizzle-orm';
import * as s from '../src/db/schema';
import * as qs from '../src/db/quote-orders.schema';
import {
  activeFramework, createFramework, addRule, publishFramework, issueQuote,
} from '../src/db/fees';
import {
  assessPayability, acceptQuoteVersion, createPaymentLink,
  payPageByToken, paymentLinkFor, loopReadiness, isQuoteOrderError,
} from '../src/db/quote-to-order';
import { createOrder } from '../src/db/orders';
import type { Principal } from '../src/lib/rbac';

let db: any;
let FW: number;

const finance: Principal = {
  userId: 1, label: 'finance', bindings: [{ role: 'FINANCE_OFFICER', scopeType: 'national', scopeId: null }],
};
/** Issues quotations. Holds quote:issue and NOT contract:write. */
const ops: Principal = {
  userId: 3, label: 'ops', bindings: [{ role: 'TRAINING_OPERATIONS', scopeType: 'national', scopeId: null }],
};
/** Records acceptances and raises the charge. Holds contract:write. */
const director: Principal = {
  userId: 4, label: 'director', bindings: [{ role: 'TRAINING_DIRECTOR', scopeType: 'national', scopeId: null }],
};

const ctx = { principal: finance };
const opsCtx = { principal: ops };
const dirCtx = { principal: director };

const DAY = 86_400_000;
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

const INPUTS = { audience: 'school', mode: 'on_site', participants: 120 };

/** A fresh quotation, issued and valid, for a fresh request. */
let requestSeq = 0;
async function issueFresh(opts: { validUntil?: string | null } = {}) {
  requestSeq += 1;
  const [req] = await db.insert(s.trainingRequests).values({
    ref: `MMAKF-REQ-Q2O-${requestSeq}`, audience: 'school', parameters: {},
  }).returning({ id: s.trainingRequests.id });

  const issued = await issueQuote(db, opsCtx, {
    requestId: req.id,
    institutionId: INSTITUTION,
    frameworkId: FW,
    inputs: INPUTS,
    validUntil: opts.validUntil === undefined ? isoDay(30) : opts.validUntil,
  });
  const [qv] = await db.select().from(s.quoteVersions)
    .where(eq(s.quoteVersions.quoteId, issued.quoteId))
    .orderBy(s.quoteVersions.version);
  const rows = await db.select().from(s.quoteVersions)
    .where(eq(s.quoteVersions.quoteId, issued.quoteId));
  const latest = rows.reduce((a: any, b: any) => (a.version > b.version ? a : b), qv);
  return { quoteId: issued.quoteId, quoteVersionId: latest.id, total: issued.computation.totalMinor };
}

const ACCEPT = {
  acceptedByName: 'A. Principal',
  acceptedByRole: 'Principal',
  method: 'signed_document' as const,
  evidenceRef: 'MMAKF/ACC/2026/0001.pdf',
};

let INSTITUTION: number;
const ENV_KEYS = ['MMAKF_UPI_ID', 'PAYMENT_PROVIDER', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET'];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // Every provider off by default. The default state of this suite is MMAKF's
  // real one: an invoice can be raised and cannot be paid online.
  for (const k of ENV_KEYS) delete process.env[k];

  const client = new PGlite();
  db = drizzle(client, { schema: s });
  for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
    for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
      if (st.trim()) await client.exec(st.trim());
    }
  }

  await db.insert(s.users).values([
    { id: 1, email: 'finance@mmakf.in', status: 'active' },
    { id: 3, email: 'ops@mmakf.in', status: 'active' },
    { id: 4, email: 'director@mmakf.in', status: 'active' },
  ]);

  const [inst] = await db.insert(s.institutions).values({
    code: 'MMAKF-INST-Q2O-1', name: 'Test Public School', kind: 'school', status: 'contracted',
  }).returning({ id: s.institutions.id });
  INSTITUTION = inst.id;
  await db.insert(s.institutionContacts).values({
    institutionId: INSTITUTION, fullName: 'A. Principal', role: 'Principal',
    email: 'principal@example.edu', isDecisionMaker: true,
  });

  const fw = await createFramework(db, ctx, { title: 'Test framework', version: 1 });
  FW = fw.id;
  await addRule(db, ctx, FW, {
    code: 'BASE-SCHOOL', label: 'School programme base', kind: 'base',
    audience: 'school', amountMinor: 5_000_000, sortOrder: 10,
  });
  await addRule(db, ctx, FW, {
    code: 'PER-CHILD', label: 'Per participant', kind: 'per_participant',
    audience: 'school', amountMinor: 45_000, sortOrder: 20,
  });
  await addRule(db, ctx, FW, {
    code: 'GST', label: 'Tax', kind: 'tax',
    audience: 'school', factorPpm: 1_180_000, sortOrder: 90,
  });
  await publishFramework(db, ctx, FW);
}, 180_000);

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

// ═══════════════════════════════════════════════════════════════════════════

describe('WITH NO PUBLISHED FEES, the whole path is unreachable and says why', () => {
  it('reports the reason as upstream — no framework, therefore no figure', async () => {
    // A SEPARATE, EMPTY DATABASE. The suite's own fixture framework would hide
    // exactly the state the federation is actually in.
    const client = new PGlite();
    const empty = drizzle(client, { schema: s });
    for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
      for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (st.trim()) await client.exec(st.trim());
      }
    }

    const readiness = await loopReadiness(empty);
    expect(readiness.reachable).toBe(false);
    expect(readiness.summary).toMatch(/published no fee framework/i);
    // And it names the fix as PUBLISHING FEES, not as shipping code.
    expect(readiness.summary).toMatch(/no code change/i);

    const framework = readiness.steps.find((s) => /fee framework is published/i.test(s.step));
    expect(framework?.ok).toBe(false);
    expect(framework?.detail).toMatch(/has published no fee framework/i);
  }, 180_000);

  it('a quotation that nothing could price carries NO number and is not payable', async () => {
    // Priced against a framework whose only rule does not match: the engine
    // produces requiresManualQuote with no figure at all.
    requestSeq += 1;
    const issued = await issueQuote(db, opsCtx, {
      frameworkId: FW,
      // No audience 'school', so no rule fires.
      inputs: { audience: 'individual', participants: 1 },
    });
    expect(issued.computation.requiresManualQuote).toBe(true);
    expect(issued.computation.totalMinor).toBe(0);

    const [qv] = await db.select().from(s.quoteVersions)
      .where(eq(s.quoteVersions.quoteId, issued.quoteId)).limit(1);

    const check = await assessPayability(db, qv.id);
    expect(check.payable).toBe(false);
    expect(check.code).toBe('no_figure');
    // THE POINT: no number is reported, and certainly not the zero in the row.
    expect(check.totalMinor).toBeNull();
    expect(check.message).toMatch(/not published a fee|prepares/i);

    await expect(createPaymentLink(db, dirCtx, qv.id)).rejects.toMatchObject({ code: 'no_figure' });
  });
});

describe('what is NOT payable', () => {
  it('an unknown version, without pretending it might exist', async () => {
    const check = await assessPayability(db, 999_999);
    expect(check.code).toBe('unknown_quote_version');
    expect(check.payable).toBe(false);
  });

  it('a quotation still awaiting approval — payment is not the way round a reviewer', async () => {
    const fw2 = await createFramework(db, ctx, { title: 'Held framework', version: 90 });
    await addRule(db, ctx, fw2.id, {
      code: 'HELD-BASE', label: 'Base', kind: 'base',
      audience: 'school', amountMinor: 1_000_000, sortOrder: 10, requiresApproval: true,
    });
    await publishFramework(db, ctx, fw2.id);

    const issued = await issueQuote(db, opsCtx, { frameworkId: fw2.id, inputs: INPUTS });
    const [qv] = await db.select().from(s.quoteVersions)
      .where(eq(s.quoteVersions.quoteId, issued.quoteId)).limit(1);
    expect(qv.status).toBe('awaiting_approval');

    const check = await assessPayability(db, qv.id);
    expect(check.payable).toBe(false);
    expect(check.code).toBe('awaiting_approval');
    expect(check.message).toMatch(/quote:approve/);

    // And the write path refuses it too, rather than trusting the read.
    await expect(acceptQuoteVersion(db, dirCtx, qv.id, ACCEPT))
      .rejects.toMatchObject({ code: 'awaiting_approval' });
  });

  it('AN EXPIRED QUOTATION, with an offer of a fresh one rather than a dead end', async () => {
    const { quoteVersionId } = await issueFresh({ validUntil: isoDay(-1) });

    const check = await assessPayability(db, quoteVersionId);
    expect(check.payable).toBe(false);
    expect(check.code).toBe('expired');
    expect(check.message).toMatch(/fresh quotation/i);
    // The figure is still readable — the offer lapsed, the record did not.
    expect(check.totalMinor).toBeGreaterThan(0);

    await expect(createPaymentLink(db, dirCtx, quoteVersionId))
      .rejects.toMatchObject({ code: 'expired' });
  });

  it('a quotation nobody has accepted', async () => {
    const { quoteVersionId } = await issueFresh();
    const check = await assessPayability(db, quoteVersionId);
    expect(check.payable).toBe(false);
    expect(check.code).toBe('not_accepted');
    expect(check.accepted).toBe(false);
    await expect(createPaymentLink(db, dirCtx, quoteVersionId))
      .rejects.toMatchObject({ code: 'not_accepted' });
  });

  it('a version superseded by a re-quote', async () => {
    requestSeq += 1;
    const [req] = await db.insert(s.trainingRequests).values({
      ref: `MMAKF-REQ-Q2O-SUP-${requestSeq}`, audience: 'school', parameters: {},
    }).returning({ id: s.trainingRequests.id });

    const first = await issueQuote(db, opsCtx, { requestId: req.id, frameworkId: FW, inputs: INPUTS });
    await issueQuote(db, opsCtx, {
      requestId: req.id, frameworkId: FW, inputs: { ...INPUTS, participants: 200 },
    });

    const versions = await db.select().from(s.quoteVersions)
      .where(eq(s.quoteVersions.quoteId, first.quoteId));
    const v1 = versions.find((v: any) => v.version === 1);
    expect(v1.status).toBe('superseded');

    const check = await assessPayability(db, v1.id);
    expect(check.code).toBe('superseded');
    expect(check.message).toMatch(/current version/i);
  });
});

describe('recording an acceptance', () => {
  it('is NOT held by whoever issued the quotation', async () => {
    const { quoteVersionId } = await issueFresh();
    // TRAINING_OPERATIONS issues quotations and cannot record that a school
    // agreed to one. The person who sends the price is not the person who
    // records the commitment.
    await expect(acceptQuoteVersion(db, opsCtx, quoteVersionId, ACCEPT)).rejects.toThrow();
  });

  it('demands a named person and evidence of how the federation knows', async () => {
    const { quoteVersionId } = await issueFresh();
    await expect(
      acceptQuoteVersion(db, dirCtx, quoteVersionId, { ...ACCEPT, acceptedByName: '' })
    ).rejects.toMatchObject({ code: 'acceptance_unattributed' });
    await expect(
      acceptQuoteVersion(db, dirCtx, quoteVersionId, { ...ACCEPT, method: 'somebody said so' as any })
    ).rejects.toMatchObject({ code: 'acceptance_method_required' });
  });

  it('freezes the figure onto the acceptance and moves the version to accepted', async () => {
    const { quoteVersionId, total } = await issueFresh();
    const accepted = await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);

    expect(accepted.totalMinor).toBe(total);
    expect(accepted.alreadyAccepted).toBe(false);

    const [qv] = await db.select().from(s.quoteVersions)
      .where(eq(s.quoteVersions.id, quoteVersionId)).limit(1);
    expect(qv.status).toBe('accepted');

    const rows = await db.select().from(qs.quoteAcceptances)
      .where(eq(qs.quoteAcceptances.quoteVersionId, quoteVersionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].method).toBe('signed_document');
    expect(rows[0].evidenceRef).toBe(ACCEPT.evidenceRef);
    // The MMAKF account that typed it and the person who agreed are kept apart.
    expect(rows[0].recordedByUserId).toBe(4);
    expect(rows[0].acceptedByName).toBe('A. Principal');
  });

  it('ACCEPTING TWICE RECORDS ONE AGREEMENT', async () => {
    const { quoteVersionId } = await issueFresh();
    const a = await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);
    const b = await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);

    expect(a.alreadyAccepted).toBe(false);
    expect(b.alreadyAccepted).toBe(true);
    expect(b.totalMinor).toBe(a.totalMinor);

    const rows = await db.select().from(qs.quoteAcceptances)
      .where(eq(qs.quoteAcceptances.quoteVersionId, quoteVersionId));
    expect(rows).toHaveLength(1);
  });

  it('publishes QUOTE_ACCEPTED once, however many times it is called', async () => {
    const { quoteVersionId } = await issueFresh();
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);

    const events = await db.select().from(s.domainEvents)
      .where(eq(s.domainEvents.eventType, 'QUOTE_ACCEPTED'));
    const mine = events.filter((e: any) => String(e.entityId) === String(quoteVersionId));
    expect(mine).toHaveLength(1);
    // Money-adjacent, and it names an institution and a sum together.
    expect(mine[0].classification).toBe('confidential');
  });
});

describe('THE CHAIN — invoice, order and payment link', () => {
  it('raises ONE order and ONE invoice for the frozen figure', async () => {
    const { quoteVersionId, total } = await issueFresh();
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);

    const link = await createPaymentLink(db, dirCtx, quoteVersionId);

    expect(link.amountMinor).toBe(total);
    expect(link.orderNo).toMatch(/^MMAKF-ORD-/);
    expect(link.invoiceNo).toBeTruthy();
    expect(link.payUrl).toBe(`/pay/${link.token}`);
    // 24 random bytes, base64url — never a database id.
    expect(link.token.length).toBeGreaterThanOrEqual(32);
    expect(link.token).not.toBe(String(quoteVersionId));

    const [order] = await db.select().from(s.orders).where(eq(s.orders.id, link.orderId)).limit(1);
    // THE FIGURE THE GATEWAY WOULD BE ASKED FOR IS THE QUOTATION'S OWN.
    expect(order.totalPaise).toBe(total);
    expect(order.status).toBe('awaiting_payment');

    // The tax is the quotation's frozen tax, not a rate re-applied here.
    const lines = await db.select().from(s.orderLines).where(eq(s.orderLines.orderId, order.id));
    expect(lines).toHaveLength(1);
    expect(lines[0].refType).toBe('quote_version');
    expect(lines[0].refId).toBe(quoteVersionId);
    const [qv] = await db.select().from(s.quoteVersions)
      .where(eq(s.quoteVersions.id, quoteVersionId)).limit(1);
    expect(lines[0].taxPaise).toBe(qv.taxMinor);
    expect(lines[0].unitPricePaise + lines[0].taxPaise).toBe(total);
  });

  it('does NOT expire the invoice 45 minutes later like an abandoned basket', async () => {
    const validUntil = isoDay(20);
    const { quoteVersionId } = await issueFresh({ validUntil });
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);
    const link = await createPaymentLink(db, dirCtx, quoteVersionId);

    const [order] = await db.select().from(s.orders).where(eq(s.orders.id, link.orderId)).limit(1);
    // The quotation's own validity governs — expireStaleOrders() would
    // otherwise cancel a school's invoice three quarters of an hour after it
    // was raised.
    expect(order.expiresAt.toISOString().slice(0, 10)).toBe(validUntil);
    expect(order.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60 * 60_000);
  });

  it('CALLING IT TWICE RETURNS THE EXISTING LINK — one invoice, one charge', async () => {
    const { quoteVersionId } = await issueFresh();
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);

    const first = await createPaymentLink(db, dirCtx, quoteVersionId);
    const second = await createPaymentLink(db, dirCtx, quoteVersionId);

    expect(second.orderId).toBe(first.orderId);
    expect(second.orderNo).toBe(first.orderNo);
    expect(second.invoiceNo).toBe(first.invoiceNo);
    expect(second.token).toBe(first.token);
    expect(second.alreadyExisted).toBe(true);

    const links = await db.select().from(qs.quotePaymentLinks)
      .where(eq(qs.quotePaymentLinks.quoteVersionId, quoteVersionId));
    expect(links).toHaveLength(1);

    const invoices = await db.select().from(s.invoices)
      .where(eq(s.invoices.orderId, first.orderId));
    expect(invoices).toHaveLength(1);
  });

  it('races on the same quotation cannot open two charges', async () => {
    const { quoteVersionId } = await issueFresh();
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);

    const results = await Promise.allSettled([
      createPaymentLink(db, dirCtx, quoteVersionId),
      createPaymentLink(db, dirCtx, quoteVersionId),
      createPaymentLink(db, dirCtx, quoteVersionId),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>[];
    expect(ok.length).toBeGreaterThan(0);

    // Whatever the interleaving, the database holds ONE link and ONE order for
    // this quotation. The unique index decided it, not a SELECT.
    const links = await db.select().from(qs.quotePaymentLinks)
      .where(eq(qs.quotePaymentLinks.quoteVersionId, quoteVersionId));
    expect(links).toHaveLength(1);

    const orderIds = new Set(ok.map((r) => r.value.orderId));
    expect(orderIds.size).toBe(1);
    const invoices = await db.select().from(s.invoices)
      .where(eq(s.invoices.orderId, links[0].orderId));
    expect(invoices).toHaveLength(1);
  });

  it('WITH NO PAYMENT PROVIDER the invoice still exists and the link says why it cannot be paid', async () => {
    const { quoteVersionId, total } = await issueFresh();
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);

    const link = await createPaymentLink(db, dirCtx, quoteVersionId);
    expect(link.provider).toBeNull();
    expect(link.checkout).toBeNull();
    expect(link.blockedReason).toMatch(/No payment provider is configured/i);
    // The money is still owed and the paperwork still exists. "We cannot take
    // cards" is not "we cannot bill".
    expect(link.invoiceNo).toBeTruthy();
    expect(link.amountMinor).toBe(total);

    const payments = await db.select().from(s.payments)
      .where(eq(s.payments.orderId, link.orderId));
    expect(payments).toHaveLength(0);
  });
});

describe('with a provider configured, the gateway order is opened once', () => {
  it('creates one gateway order and one payment attempt, and resumes rather than repeating', async () => {
    process.env.MMAKF_UPI_ID = 'mmakf@testbank';
    try {
      const { quoteVersionId, total } = await issueFresh();
      await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);

      const first = await createPaymentLink(db, dirCtx, quoteVersionId);
      expect(first.provider).toBe('manual_upi');
      expect(first.blockedReason).toBeNull();
      expect(first.providerOrderId).toBe(first.orderNo);

      const second = await createPaymentLink(db, dirCtx, quoteVersionId);
      expect(second.providerOrderId).toBe(first.providerOrderId);

      // ONE payment attempt, for the quotation's own figure.
      const payments = await db.select().from(s.payments)
        .where(eq(s.payments.orderId, first.orderId));
      expect(payments).toHaveLength(1);
      expect(payments[0].amountPaise).toBe(total);
      // The gateway's idempotency key and ours are the same string, so a retry
      // that reaches the network gets the same gateway order back.
      const [link] = await db.select().from(qs.quotePaymentLinks)
        .where(eq(qs.quotePaymentLinks.quoteVersionId, quoteVersionId));
      expect(payments[0].idempotencyKey).toBe(link.idempotencyKey);
    } finally {
      delete process.env.MMAKF_UPI_ID;
    }
  });
});

describe('THE FROZEN FIGURE — a later fee change moves nothing', () => {
  it('publishing an entirely different framework does not alter the order or the invoice', async () => {
    const { quoteVersionId, total } = await issueFresh();
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);
    const link = await createPaymentLink(db, dirCtx, quoteVersionId);

    const [beforeOrder] = await db.select().from(s.orders).where(eq(s.orders.id, link.orderId)).limit(1);
    const [beforeInvoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, link.invoiceId!)).limit(1);
    expect(beforeOrder.totalPaise).toBe(total);

    // A completely different set of fees is published, in force from today.
    const v2 = await createFramework(db, ctx, { title: 'Framework two', version: 2 });
    await addRule(db, ctx, v2.id, {
      code: 'BASE-SCHOOL', label: 'School base', kind: 'base',
      audience: 'school', amountMinor: 99_999_999, sortOrder: 10,
    });
    await publishFramework(db, ctx, v2.id);

    const [afterOrder] = await db.select().from(s.orders).where(eq(s.orders.id, link.orderId)).limit(1);
    const [afterInvoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, link.invoiceId!)).limit(1);

    // NOT ONE PAISA.
    expect(afterOrder.totalPaise).toBe(total);
    expect(afterOrder.taxPaise).toBe(beforeOrder.taxPaise);
    expect(afterInvoice.snapshot.totalPaise).toBe(beforeInvoice.snapshot.totalPaise);

    // And re-reading the link still reports the accepted figure, not a new one.
    const again = await createPaymentLink(db, dirCtx, quoteVersionId);
    expect(again.amountMinor).toBe(total);
    expect(again.orderNo).toBe(link.orderNo);

    const view = await payPageByToken(db, link.token);
    expect(view!.amountMinor).toBe(total);
  });
});

describe('createOrder will not be talked into a price', () => {
  it('refuses a client-supplied amount on a quotation line', async () => {
    const { quoteVersionId, total } = await issueFresh();
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);

    const order = await createOrder(db, null, {
      lines: [{
        kind: 'other', description: 'x',
        quoteVersionId,
        // The oldest attack there is: a price in the request body.
        unitPricePaise: 1,
      } as any],
    });
    // The frozen figure won. The supplied amount was never consulted.
    expect(order.totalPaise).toBe(total);
  });

  it('refuses to multiply a quotation by a quantity', async () => {
    const { quoteVersionId } = await issueFresh();
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);
    await expect(createOrder(db, null, {
      lines: [{ kind: 'other', description: 'x', quoteVersionId, quantity: 4 }],
    })).rejects.toMatchObject({ code: 'bad_quantity' });
  });

  it('refuses a line that names both a quotation and a catalogue item', async () => {
    const { quoteVersionId } = await issueFresh();
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);
    await expect(createOrder(db, null, {
      lines: [{ kind: 'other', description: 'x', quoteVersionId, feeCode: 'membership.athlete.annual' }],
    })).rejects.toMatchObject({ code: 'ambiguous_line' });
  });

  it('refuses an unaccepted quotation even when reached directly', async () => {
    const { quoteVersionId } = await issueFresh();
    await expect(createOrder(db, null, {
      lines: [{ kind: 'other', description: 'x', quoteVersionId }],
    })).rejects.toMatchObject({ code: 'quote_not_accepted' });
  });
});

describe('the page behind the link', () => {
  it('shows the invoice and NOT the client file', async () => {
    const { quoteVersionId, total } = await issueFresh();
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);
    const link = await createPaymentLink(db, dirCtx, quoteVersionId);

    const view = await payPageByToken(db, link.token);
    expect(view).not.toBeNull();
    expect(view!.orderNo).toBe(link.orderNo);
    expect(view!.amountMinor).toBe(total);
    expect(view!.paid).toBe(false);

    // The quotation's inputs — how many children at how many campuses — are the
    // school's own operational detail and are not on a bearer-token page.
    const asText = JSON.stringify(view);
    expect(asText).not.toMatch(/participants/);
    expect(asText).not.toMatch(/principal@example\.edu/);
  });

  it('an unknown or truncated token returns nothing, not the nearest match', async () => {
    expect(await payPageByToken(db, '')).toBeNull();
    expect(await payPageByToken(db, 'short')).toBeNull();
    expect(await payPageByToken(db, 'x'.repeat(32))).toBeNull();
  });

  it('OFFERS NO WAY TO PAY a cancelled, refunded or swept order', async () => {
    process.env.MMAKF_UPI_ID = 'mmakf@testbank';
    try {
      const { quoteVersionId } = await issueFresh();
      await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);
      const link = await createPaymentLink(db, dirCtx, quoteVersionId);

      // While it is genuinely awaiting payment, the page offers a checkout.
      const live = await payPageByToken(db, link.token);
      expect(live!.collectable).toBe(true);
      expect(live!.checkout).not.toBeNull();

      // Each of these reports `paid: false`. A page that decided from `paid`
      // alone would draw a Pay button on every one of them — inviting a school
      // to pay for a cancelled engagement, or to pay back its own refund.
      for (const status of ['cancelled', 'refunded', 'partially_refunded', 'expired']) {
        await db.update(s.orders).set({ status }).where(eq(s.orders.id, link.orderId));
        const view = await payPageByToken(db, link.token);
        expect(view!.paid).toBe(false);
        expect(view!.orderStatus).toBe(status);
        expect(view!.collectable).toBe(false);
      }

      await db.update(s.orders).set({ status: 'awaiting_payment' }).where(eq(s.orders.id, link.orderId));
      expect((await payPageByToken(db, link.token))!.collectable).toBe(true);
    } finally {
      delete process.env.MMAKF_UPI_ID;
    }
  }, 180_000);

  it('reports an expired offer as expired even when the order row has not been swept', async () => {
    const { quoteVersionId } = await issueFresh();
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);
    const link = await createPaymentLink(db, dirCtx, quoteVersionId);

    await db.update(s.quoteVersions)
      .set({ validUntil: isoDay(-2) })
      .where(eq(s.quoteVersions.id, quoteVersionId));

    const view = await payPageByToken(db, link.token);
    expect(view!.expired).toBe(true);
    expect(view!.collectable).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE PROPERTY THE WHOLE DESIGN CLAIMS
// ═══════════════════════════════════════════════════════════════════════════

describe('IT STARTS WORKING WHEN FEES ARE PUBLISHED — no code change, no deploy', () => {
  it('the identical call refuses on an empty federation and invoices once a framework exists', async () => {
    // A database holding nothing but the schema. That is MMAKF today.
    const client = new PGlite();
    const fresh = drizzle(client, { schema: s });
    for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
      for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (st.trim()) await client.exec(st.trim());
      }
    }
    await fresh.insert(s.users).values([
      { id: 1, email: 'finance@mmakf.in', status: 'active' },
      { id: 3, email: 'ops@mmakf.in', status: 'active' },
      { id: 4, email: 'director@mmakf.in', status: 'active' },
    ]);
    const [inst] = await fresh.insert(s.institutions).values({
      code: 'MMAKF-INST-LOOP-1', name: 'A school that asked', kind: 'school', status: 'contracted',
    }).returning({ id: s.institutions.id });
    const [req] = await fresh.insert(s.trainingRequests).values({
      ref: 'MMAKF-REQ-LOOP-1', audience: 'school', parameters: {},
    }).returning({ id: s.trainingRequests.id });

    // ── ONE FUNCTION, CALLED TWICE, IDENTICAL BOTH TIMES ──
    //
    // This is the whole assertion. Not one character of it differs between the
    // two calls, and no environment variable, no import and no flag changes
    // either. What changes between them is that the federation publishes fees,
    // through the same functions /admin/fees calls. If the loop needed a code
    // change to start working, this is where it would be impossible to hide.
    async function askTheFederationToQuoteAndBill() {
      const framework = await activeFramework(fresh, isoDay(0));
      if (!framework) {
        return { billed: false as const, readiness: await loopReadiness(fresh) };
      }
      const issued = await issueQuote(fresh, opsCtx, {
        requestId: req.id, institutionId: inst.id, frameworkId: framework.id,
        inputs: INPUTS, validUntil: isoDay(30),
      });
      const rows = await fresh.select().from(s.quoteVersions)
        .where(eq(s.quoteVersions.quoteId, issued.quoteId));
      const latest = rows.reduce((a: any, b: any) => (a.version > b.version ? a : b));
      await acceptQuoteVersion(fresh, dirCtx, latest.id, ACCEPT);
      const link = await createPaymentLink(fresh, dirCtx, latest.id);
      return { billed: true as const, link, computation: issued.computation, quoteVersionId: latest.id };
    }

    // ── BEFORE: nothing is priced, and the reason names the federation ──
    const before = await askTheFederationToQuoteAndBill();
    expect(before.billed).toBe(false);
    expect(before.readiness!.reachable).toBe(false);
    expect(before.readiness!.summary).toMatch(/published no fee framework/i);
    expect(before.readiness!.summary).toMatch(/no code change/i);
    // Nothing was invented in the attempt: no order, no invoice, no link.
    expect(await fresh.select().from(s.orders)).toHaveLength(0);
    expect(await fresh.select().from(s.invoices)).toHaveLength(0);
    expect(await fresh.select().from(qs.quotePaymentLinks)).toHaveLength(0);

    // ── THE ONLY THING THAT HAPPENS BETWEEN THE TWO CALLS ──
    //
    // Somebody at the federation authors fee rules and presses Publish. No file
    // is edited. Nothing is deployed. (These figures are a test fixture and are
    // NOT MMAKF's fees — the federation has published none.)
    const fw = await createFramework(fresh, ctx, { title: 'Published at last', version: 1 });
    await addRule(fresh, ctx, fw.id, {
      code: 'BASE-SCHOOL', label: 'School programme base', kind: 'base',
      audience: 'school', amountMinor: 5_000_000, sortOrder: 10,
    });
    await addRule(fresh, ctx, fw.id, {
      code: 'PER-CHILD', label: 'Per participant', kind: 'per_participant',
      audience: 'school', amountMinor: 45_000, sortOrder: 20,
    });
    await addRule(fresh, ctx, fw.id, {
      code: 'GST', label: 'Tax', kind: 'tax', audience: 'school', factorPpm: 1_180_000, sortOrder: 90,
    });
    await publishFramework(fresh, ctx, fw.id);

    // ── AFTER: the same call, and a real invoice comes out ──
    const after = await askTheFederationToQuoteAndBill();
    expect(after.billed).toBe(true);

    // A REAL FIGURE, and it is the fee engine's own arithmetic — base plus one
    // amount per child — not a number this module chose.
    const netExpected = 5_000_000 + 120 * 45_000;
    expect(after.computation!.requiresManualQuote).toBe(false);
    expect(after.computation!.subtotalMinor).toBe(netExpected);
    expect(after.computation!.totalMinor).toBeGreaterThan(netExpected);
    expect(after.link!.amountMinor).toBe(after.computation!.totalMinor);

    // …and it reached the order, the invoice and the page an institution opens.
    const [order] = await fresh.select().from(s.orders)
      .where(eq(s.orders.id, after.link!.orderId)).limit(1);
    expect(order.totalPaise).toBe(after.computation!.totalMinor);
    expect(after.link!.invoiceNo).toBeTruthy();
    const view = await payPageByToken(fresh, after.link!.token);
    expect(view!.amountMinor).toBe(after.computation!.totalMinor);
    expect(view!.paid).toBe(false);

    // The status screen now says so too, and names the framework rather than
    // still blaming a missing one.
    const readiness = await loopReadiness(fresh);
    expect(readiness.reachable).toBe(true);
    expect(readiness.summary).not.toMatch(/published no fee framework/i);
    expect(readiness.steps.find((x) => /fee framework is published/i.test(x.step))!.ok).toBe(true);
  }, 300_000);

  it('reports a published framework honestly before anybody has been quoted', async () => {
    // The gap that made the report lie: fees published, no quotation open yet.
    // The machinery is ready, and saying "MMAKF has published no fee framework"
    // in that state is simply false.
    const client = new PGlite();
    const fresh = drizzle(client, { schema: s });
    for (const f of readdirSync('drizzle').filter((x) => x.endsWith('.sql')).sort()) {
      for (const st of readFileSync(`drizzle/${f}`, 'utf8').split('--> statement-breakpoint')) {
        if (st.trim()) await client.exec(st.trim());
      }
    }
    await fresh.insert(s.users).values([{ id: 1, email: 'finance@mmakf.in', status: 'active' }]);

    const fw = await createFramework(fresh, ctx, { title: 'Fees, no customers yet', version: 1 });
    await addRule(fresh, ctx, fw.id, {
      code: 'BASE-SCHOOL', label: 'Base', kind: 'base',
      audience: 'school', amountMinor: 1_000_000, sortOrder: 10,
    });
    await publishFramework(fresh, ctx, fw.id);

    const readiness = await loopReadiness(fresh);
    expect(readiness.reachable).toBe(true);
    expect(readiness.summary).not.toMatch(/published no fee framework/i);
    expect(readiness.summary).toMatch(/is published/i);
  }, 300_000);
});

describe('ONE REQUEST CANNOT BE BILLED TWICE THROUGH TWO VERSIONS', () => {
  /** Issue a quotation against `requestId`, returning the newest version. */
  async function requote(requestId: number, participants: number) {
    const issued = await issueQuote(db, opsCtx, {
      requestId, institutionId: INSTITUTION, frameworkId: FW,
      inputs: { ...INPUTS, participants }, validUntil: isoDay(30),
    });
    const rows = await db.select().from(s.quoteVersions)
      .where(eq(s.quoteVersions.quoteId, issued.quoteId));
    return { quoteId: issued.quoteId, version: rows.reduce((a: any, b: any) => (a.version > b.version ? a : b)) };
  }

  it('a re-quote after acceptance cannot raise a second live invoice', async () => {
    requestSeq += 1;
    const [req] = await db.insert(s.trainingRequests).values({
      ref: `MMAKF-REQ-Q2O-DBL-${requestSeq}`, audience: 'school', parameters: {},
    }).returning({ id: s.trainingRequests.id });

    const first = await requote(req.id, 120);
    await acceptQuoteVersion(db, dirCtx, first.version.id, ACCEPT);
    const link1 = await createPaymentLink(db, dirCtx, first.version.id);
    expect(link1.orderId).toBeTruthy();

    // The office re-quotes the SAME request at a larger scope. issueQuote()
    // supersedes what is still 'issued', and version 1 is 'accepted' — so it is
    // left alone and there are now two versions the federation stands behind.
    const second = await requote(req.id, 200);
    expect(second.version.status).toBe('issued');
    expect(second.version.totalMinor).not.toBe(first.version.totalMinor);

    // Recording that the school accepted the revised figure is still allowed —
    // it is a fact, and refusing to write it down does not make it untrue.
    const accepted = await acceptQuoteVersion(db, dirCtx, second.version.id, ACCEPT);
    expect(accepted.alreadyAccepted).toBe(false);

    // BILLING it is not, while the first invoice is still live.
    const check = await assessPayability(db, second.version.id);
    expect(check.payable).toBe(false);
    expect(check.code).toBe('charged_on_another_version');
    expect(check.message).toContain(link1.orderNo);
    // The refusal names both ways out rather than ending the conversation.
    expect(check.message).toMatch(/cancel the earlier order/i);
    expect(check.message).toMatch(/request of its own/i);

    await expect(createPaymentLink(db, dirCtx, second.version.id))
      .rejects.toMatchObject({ code: 'charged_on_another_version' });

    // ONE link, ONE order, ONE invoice for this request. Not two.
    const links = await db.select().from(qs.quotePaymentLinks)
      .where(eq(qs.quotePaymentLinks.quoteId, first.quoteId));
    expect(links).toHaveLength(1);
    expect(links[0].orderId).toBe(link1.orderId);
    const invoices = await db.select().from(s.invoices).where(eq(s.invoices.orderId, link1.orderId));
    expect(invoices).toHaveLength(1);
  }, 180_000);

  it('cancelling the replaced order releases the new version to be billed', async () => {
    requestSeq += 1;
    const [req] = await db.insert(s.trainingRequests).values({
      ref: `MMAKF-REQ-Q2O-DBL2-${requestSeq}`, audience: 'school', parameters: {},
    }).returning({ id: s.trainingRequests.id });

    const first = await requote(req.id, 120);
    await acceptQuoteVersion(db, dirCtx, first.version.id, ACCEPT);
    const link1 = await createPaymentLink(db, dirCtx, first.version.id);

    const second = await requote(req.id, 200);
    await acceptQuoteVersion(db, dirCtx, second.version.id, ACCEPT);
    await expect(createPaymentLink(db, dirCtx, second.version.id)).rejects.toBeTruthy();

    // The federation withdraws the charge it replaced. A cancelled order is not
    // something the institution is holding, so the block lifts.
    await db.update(s.orders).set({ status: 'cancelled' }).where(eq(s.orders.id, link1.orderId));

    const link2 = await createPaymentLink(db, dirCtx, second.version.id);
    expect(link2.orderId).not.toBe(link1.orderId);
    expect(link2.amountMinor).toBe(second.version.totalMinor);
    // And the earlier one is not resurrected by the new one existing.
    const [old] = await db.select().from(s.orders).where(eq(s.orders.id, link1.orderId)).limit(1);
    expect(old.status).toBe('cancelled');
  }, 180_000);
});

describe('AN INTERRUPTED CHAIN IS FINISHED, NOT ABANDONED', () => {
  it('a link stopped before the gateway can still be completed after the quotation lapses', async () => {
    const { quoteVersionId } = await issueFresh();
    await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);
    const link = await createPaymentLink(db, dirCtx, quoteVersionId);
    expect(link.orderId).toBeTruthy();

    // The process died between the invoice and the gateway call: an order and
    // an invoice exist, and nothing has been opened for them.
    await db.update(qs.quotePaymentLinks)
      .set({ blockedReason: null, providerOrderId: null, provider: null, checkout: null })
      .where(eq(qs.quotePaymentLinks.quoteVersionId, quoteVersionId));
    // …and the offer lapses before anybody retries.
    await db.update(s.quoteVersions)
      .set({ validUntil: isoDay(-1) })
      .where(eq(s.quoteVersions.id, quoteVersionId));

    // The expiry rule governs RAISING a charge. It must not strand an invoice
    // the institution is already holding with no way ever to settle it.
    const resumed = await createPaymentLink(db, dirCtx, quoteVersionId);
    expect(resumed.orderId).toBe(link.orderId);
    expect(resumed.invoiceNo).toBe(link.invoiceNo);
    expect(resumed.amountMinor).toBe(link.amountMinor);

    // Still ONE order and ONE invoice — resuming is not re-raising.
    const links = await db.select().from(qs.quotePaymentLinks)
      .where(eq(qs.quotePaymentLinks.quoteVersionId, quoteVersionId));
    expect(links).toHaveLength(1);
    const invoices = await db.select().from(s.invoices).where(eq(s.invoices.orderId, link.orderId));
    expect(invoices).toHaveLength(1);

    // And a NEW charge against that lapsed quotation is still refused.
    const check = await assessPayability(db, quoteVersionId);
    expect(check.code).toBe('expired');
  }, 180_000);

  it('never opens a second gateway order against an order that is already paid', async () => {
    process.env.MMAKF_UPI_ID = 'mmakf@testbank';
    try {
      const { quoteVersionId } = await issueFresh();
      await acceptQuoteVersion(db, dirCtx, quoteVersionId, ACCEPT);
      const link = await createPaymentLink(db, dirCtx, quoteVersionId);

      // Settled at the office, and the link row never learned about it.
      await db.update(s.orders).set({ status: 'paid', paidAt: new Date() })
        .where(eq(s.orders.id, link.orderId));
      await db.update(qs.quotePaymentLinks)
        .set({ providerOrderId: null, blockedReason: null })
        .where(eq(qs.quotePaymentLinks.quoteVersionId, quoteVersionId));

      const again = await createPaymentLink(db, dirCtx, quoteVersionId);
      expect(again.orderId).toBe(link.orderId);

      // ONE payment attempt for this order, not a second one raised against
      // money already taken.
      const payments = await db.select().from(s.payments)
        .where(eq(s.payments.orderId, link.orderId));
      expect(payments).toHaveLength(1);
    } finally {
      delete process.env.MMAKF_UPI_ID;
    }
  }, 180_000);
});

describe('reading a link back', () => {
  it('needs quote:read, and returns null when there is none', async () => {
    const { quoteVersionId } = await issueFresh();
    expect(await paymentLinkFor(db, director, quoteVersionId)).toBeNull();

    const athlete: Principal = {
      userId: 9, label: 'athlete', bindings: [{ role: 'ATHLETE', scopeType: 'national', scopeId: null }],
    };
    await expect(paymentLinkFor(db, athlete, quoteVersionId)).rejects.toSatisfy(isQuoteOrderError);
  });
});
