// Razorpay adapter.
//
// Recommended primary for MMAKF: it is the most widely used Indian gateway, it
// onboards registered societies and trusts, and it settles to an Indian current
// account with UPI, cards, net banking and wallets in one integration. Nothing
// in the rest of the codebase depends on that choice — see provider.ts.
//
// Credentials, all from the environment, never committed:
//   RAZORPAY_KEY_ID          public; safe to send to the browser
//   RAZORPAY_KEY_SECRET      secret; signs and authenticates API calls
//   RAZORPAY_WEBHOOK_SECRET  secret; signs webhook bodies (a DIFFERENT secret)
//   PAYMENT_MODE             'test' | 'live'; declared intent — see mode.ts
//
// The two secrets are genuinely different values. Using the API secret to verify
// webhooks is a common integration bug and silently rejects every callback.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT MAY AND MAY NOT LEAVE THIS FILE
// ─────────────────────────────────────────────────────────────────────────────
//
// Audited, because a payment adapter is exactly where a secret escapes:
//
//   · This adapter writes NOTHING to console. Not a debug line, not an error.
//     Callers log, and callers only ever receive scrubbed messages.
//   · KEY_SECRET is used in two places — the Basic auth header, and the HMAC —
//     and is held in a local for the length of that expression only.
//   · Every error message crossing the boundary passes through scrub(), which
//     removes any literal occurrence of either secret. That is belt and braces:
//     Razorpay does not echo credentials back. But an adapter is the wrong place
//     to rely on somebody else's response body staying well behaved.
//   · The capability report returns KEY_ID (public by design) and booleans.
//     Never a secret, and never a masked secret either — a mask still discloses
//     a length.
//
// ─────────────────────────────────────────────────────────────────────────────
// MODE
// ─────────────────────────────────────────────────────────────────────────────
//
// Every path that could move money — order creation, any authenticated API
// call, refunds — asserts the mode guard first and throws if it refuses. See
// mode.ts for why a warning would be useless here.
//
// Order creation refuses on one further condition the mode guard has no opinion
// about: a missing RAZORPAY_WEBHOOK_SECRET. A signed webhook is the only thing
// this system accepts as proof that money moved, so without that secret a
// checkout takes money nothing can ever confirm. That is a debit with nothing
// on the other side of it, and it is refused rather than reported.
//
// Signature verification deliberately does NOT consult the guard. Verifying is
// a question of authenticity — did Razorpay sign this — and the answer does not
// change with our configuration. An order can only exist if createOrder passed
// the guard, so refusing to verify its callback would strand a payment that has
// already been taken rather than prevent one.

import crypto from 'node:crypto';
import {
  PaymentProviderError,
  type CreateOrderInput, type CreateOrderResult, type PaymentProvider,
  type RefundResult, type VerifiedPayment, type WebhookResult,
} from './provider';
import {
  assertPaymentMode, paymentModeDecision,
  type PaymentMode, type PaymentModeCode,
} from './mode';

const API = 'https://api.razorpay.com/v1';

// Razorpay rejects an INR order below one rupee. Caught here so the caller gets
// a sentence instead of a 400 from a third party — and because an amount that
// small is nearly always a rupees/paise conversion done twice.
const MIN_INR_PAISE = 100;

// Razorpay caps `notes` at 15 keys. Two are reserved for the tie-back to our
// own order, which is what makes a dashboard row reconcilable at all.
const MAX_NOTES = 15;
const RESERVED_NOTES = 2;

function keyId() { return (process.env.RAZORPAY_KEY_ID || '').trim(); }
function keySecret() { return (process.env.RAZORPAY_KEY_SECRET || '').trim(); }
function webhookSecret() { return (process.env.RAZORPAY_WEBHOOK_SECRET || '').trim(); }

/**
 * Remove any literal secret from a string before it can be thrown, returned or
 * logged by a caller.
 *
 * Short values are left alone: a two-character "secret" would match everywhere
 * and turn a diagnostic into confetti.
 */
function scrub(text: string): string {
  let out = text;
  for (const secret of [keySecret(), webhookSecret()]) {
    if (secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join('[redacted:secret]');
    }
  }
  return out;
}

function fail(message: string, detail?: unknown): never {
  throw new PaymentProviderError('razorpay', scrub(message), detail);
}

/** Compare HMACs in constant time; lengths must match before timingSafeEqual. */
function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // Hex is case-insensitive, so normalising is not a weakening — it stops a
  // correct signature being rejected because something upcased it in transit.
  // The constant-time comparison still happens over the full digest.
  const ba = Buffer.from(a.trim().toLowerCase(), 'utf8');
  const bb = Buffer.from(b.trim().toLowerCase(), 'utf8');
  // timingSafeEqual THROWS on a length mismatch, so the lengths are checked
  // first. That check leaks only the length of a SHA-256 hex digest, which is
  // 64 characters for everybody.
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hmacHex(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Case-insensitive header lookup; runtimes disagree about header casing. */
function header(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers ?? {})) {
    if (key.toLowerCase() === wanted) return String(headers[key] ?? '');
  }
  return '';
}

/**
 * The key the replay guard runs on.
 *
 * Razorpay sends `x-razorpay-event-id`, and every RETRY of one event carries the
 * same value — which is exactly what a replay guard wants.
 *
 * THE FALLBACK IS THE DANGEROUS PART. It used to be the payment id, and a
 * payment id is not an event id: `payment.authorized` and `payment.captured`
 * for one payment carry the SAME payment id, so the second one — the capture,
 * the only event that can pay an order — was swallowed by the unique index as a
 * duplicate of the first. Money taken, order left AWAITING PAYMENT, and the
 * event log reading "already seen" rather than an error, so nothing retried it
 * and nobody was told. A refund event is worse still: it carries the payment
 * entity too, so it collided with the capture that preceded it.
 *
 * So the fallback names the event, the most specific entity in it (a refund id
 * where there is one, since a refund event carries both), and the digest of the
 * exact bytes signed. Two genuinely different events cannot collide; two
 * deliveries of the same event still key alike.
 *
 * This is byte-for-byte the derivation in src/pages/api/payments/razorpay/webhook.ts,
 * deliberately: the two intake routes must agree on the key, or an event that
 * arrived at both doors would be processed twice.
 */
function webhookEventId(headers: Record<string, string>, body: any, rawBody: string): string {
  const fromHeader = header(headers, 'x-razorpay-event-id');
  if (fromHeader) return fromHeader.slice(0, 200);

  const refundId = body?.payload?.refund?.entity?.id;
  const paymentId = body?.payload?.payment?.entity?.id;
  const entityId = refundId ?? paymentId;
  const digest = crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
  return `derived:${String(body?.event ?? 'unknown')}:${String(entityId ?? '')}:${digest}`;
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  if (!keyId() || !keySecret()) {
    fail('Not configured: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are unset');
  }
  // Throws PaymentModeError — deliberately NOT a PaymentProviderError, because
  // this is our misconfiguration and not a gateway fault, and the two should
  // never be reported to an operator in the same words.
  assertPaymentMode();

  const auth = Buffer.from(`${keyId()}:${keySecret()}`).toString('base64');

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } catch (err: any) {
    fail(`Network failure calling ${path}: ${err?.message}`);
  }

  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (!res.ok) {
    const detail = body?.error?.description || text.slice(0, 300);
    fail(`${res.status} on ${path}: ${detail}`, body);
  }
  return body;
}

/** Razorpay's payment states mapped onto ours. */
function mapStatus(s: string): VerifiedPayment['status'] {
  switch (s) {
    case 'captured': return 'captured';
    case 'authorized': return 'authorized';
    case 'failed': return 'failed';
    case 'refunded': return 'refunded';
    default: return 'created';
  }
}

/**
 * A gateway identifier, or an empty string.
 *
 * `String(p.id)` on a field the gateway did not send produces the literal text
 * "undefined" — a perfectly valid database value and a perfectly useless one.
 * It matches no order, and a SECOND malformed entity produces the same text and
 * collides with the first on the UNIQUE index over (provider,
 * provider_payment_id), turning a data problem into a constraint violation in
 * the middle of a confirmation. An absent id is absent, and every lookup
 * downstream is written to expect that.
 */
function gatewayId(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Integer paise, or NaN. MONEY RULE 5, enforced at the boundary.
 *
 * `Number(null)` is 0 and `Number('')` is 0, so the obvious coercion turns a
 * field the gateway did not send into a payment of zero. Zero then flows into
 * an amount comparison, an audit row and a ledger posting as though somebody
 * had genuinely paid nothing — which is money rule 5 happening inside the
 * adapter rather than inside the fee engine.
 *
 * NaN is returned instead. It equals nothing, so every comparison downstream
 * fails closed and the payment lands in the finance exceptions queue where a
 * human sees it. A float lands here too: Razorpay quotes integer paise, and a
 * fractional one means a rupee figure has been converted somewhere it should
 * not have been.
 */
function paiseOrNaN(v: unknown): number {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : NaN;
  // A numeric string is accepted because a proxy or a re-encoder in the chain
  // may have stringified the JSON number. Anything else is not a number.
  // The digit class needs its backslash: /d/ matches the LETTER d, so every
  // real numeric string was rejected and the documented tolerance below did
  // not exist. Fifteen digits is the deliberate bound — it cannot overflow a
  // safe integer, which is why this branch may skip the isSafeInteger check.
  if (typeof v === 'string' && /^-?\d{1,15}$/.test(v.trim())) return Number(v.trim());
  return NaN;
}

/**
 * The gateway's own fee and tax: recorded when they are integer paise, omitted
 * otherwise. These become ledger postings, and an integer column will not take
 * a float — a malformed fee must not roll back the record that money arrived.
 */
function optionalPaise(v: unknown): number | undefined {
  if (v === null || v === undefined) return undefined;
  const n = paiseOrNaN(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

function toVerified(p: any): VerifiedPayment {
  return {
    providerPaymentId: gatewayId(p?.id),
    providerOrderId: gatewayId(p?.order_id),
    amountPaise: paiseOrNaN(p?.amount),   // Razorpay is already in paise
    // Upper-cased so a comparison against our own ISO code cannot fail on case.
    currency: String(p?.currency ?? 'INR').toUpperCase(),
    status: mapStatus(String(p?.status)),
    method: p?.method ? String(p.method) : undefined,
    feePaise: optionalPaise(p?.fee),
    taxPaise: optionalPaise(p?.tax),
    failureReason: p?.error_description ? String(p.error_description) : undefined,
  };
}

/**
 * The notes attached to the gateway order.
 *
 * Razorpay's dashboard is where a finance officer stands when a member says
 * "I paid and nothing happened". Without our order number on the gateway
 * record, answering that means matching on amount and timestamp, which is
 * guesswork the moment two people pay the same fee in the same minute.
 *
 * Our two keys are added AFTER the caller's and cannot be overwritten by them.
 */
function buildNotes(input: CreateOrderInput, mode: PaymentMode): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.notes ?? {})) {
    if (v === null || v === undefined) continue;
    if (Object.keys(notes).length >= MAX_NOTES - RESERVED_NOTES) break;
    const key = String(k).slice(0, 40);
    if (!key || key === 'mmakf_reference' || key === 'mmakf_mode') continue;
    notes[key] = String(v).slice(0, 250);
  }
  notes.mmakf_reference = input.reference.slice(0, 250);
  // Stamped on the gateway record so a test order can never be mistaken for a
  // real one while reading the dashboard.
  notes.mmakf_mode = mode;
  return notes;
}

// ─── Capability report ──────────────────────────────────────────────────────

export interface RazorpayHealthCheck {
  /** ISO timestamp of the attempt. */
  at: string;
  ok: boolean;
  /** Scrubbed, operator-facing. Never a secret. */
  detail: string;
}

export interface RazorpayCapability {
  provider: 'razorpay';
  /** Both credentials are present. Says nothing about whether they agree. */
  configured: boolean;
  /** Configured, the mode guard permits a charge, AND a confirmation could arrive. */
  ready: boolean;
  mode: PaymentMode | null;
  /** PUBLIC key. It is handed to the browser to open checkout. */
  keyId: string | null;
  webhookConfigured: boolean;
  /**
   * The mode guard's verdict, or 'webhook_secret_missing' — a refusal that
   * belongs to this adapter rather than to the test/live guard, and so is not
   * one of the guard's own codes.
   */
  status: PaymentModeCode | 'webhook_secret_missing';
  /** Plain English, safe to render verbatim on an admin screen. */
  message: string;
  lastHealthCheck: RazorpayHealthCheck | null;
}

// Per-instance, not persisted. A serverless instance is recycled without
// notice, so a null here means "not checked on this instance" — never "failed".
let lastHealthCheck: RazorpayHealthCheck | null = null;

/**
 * Everything an admin screen may show about this adapter.
 *
 * When credentials are absent this reports NOT CONFIGURED cleanly — which is
 * MMAKF's state today — rather than an error. Absence of a gateway is a fact
 * about the federation, not a fault in the software.
 */
export function razorpayCapability(): RazorpayCapability {
  const decision = paymentModeDecision();
  // Reported separately from `configured` because keys without a webhook secret
  // is the worst of the states: money can be taken and can never be confirmed.
  // It is no longer merely reported — it withholds the provider (see
  // isConfigured), because a state that is invisible until the first payment
  // sticks in AWAITING PAYMENT is not one an operator finds in time.
  const webhookConfigured = Boolean(webhookSecret());
  const cannotConfirm = decision.ok && !webhookConfigured;
  return {
    provider: 'razorpay',
    configured: decision.configured,
    ready: decision.ok && webhookConfigured,
    mode: decision.mode,
    keyId: keyId() || null,
    webhookConfigured,
    status: cannotConfirm ? 'webhook_secret_missing' : decision.code,
    message: cannotConfirm
      ? 'REFUSING TO START: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set, but ' +
        'RAZORPAY_WEBHOOK_SECRET is not. A payment could be taken and never confirmed, ' +
        'receipted or acted on, because a signed webhook is the only thing this system ' +
        'accepts as proof that money moved. Razorpay is held back until the webhook ' +
        'secret is set; payment falls to manual UPI in the meantime.'
      : decision.message,
    lastHealthCheck,
  };
}

/**
 * Prove the credentials are accepted, without moving money.
 *
 * A one-row payments listing is the cheapest authenticated read Razorpay
 * offers. A 401 here is the difference between "the key is wrong" and "the
 * gateway is down", which no amount of staring at a checkout screen resolves.
 */
export async function razorpayHealthCheck(): Promise<RazorpayHealthCheck> {
  const at = new Date().toISOString();
  const decision = paymentModeDecision();

  if (!decision.ok) {
    lastHealthCheck = { at, ok: false, detail: decision.message };
    return lastHealthCheck;
  }

  try {
    await call('/payments?count=1');
    lastHealthCheck = {
      at,
      ok: true,
      detail: `Razorpay accepted the credentials in ${decision.mode} mode.`,
    };
  } catch (err: any) {
    lastHealthCheck = { at, ok: false, detail: scrub(String(err?.message ?? err)).slice(0, 300) };
  }
  return lastHealthCheck;
}

export const razorpay: PaymentProvider = {
  id: 'razorpay',
  label: 'Razorpay',

  /**
   * Configured means USABLE END TO END, not merely populated.
   *
   * Two things make it false. A refusal from the mode guard — a mismatched key
   * pair must not be one bug away from charging somebody. And a missing webhook
   * secret, because taking a payment this deployment can never confirm is not a
   * degraded service, it is a debit with nothing on the other side of it.
   *
   * Either way Razorpay drops out of activeProvider() and manual UPI carries
   * the federation. The reason is never lost — razorpayCapability() states it
   * in full, on an admin screen, in a sentence.
   */
  isConfigured() {
    return paymentModeDecision().ok && Boolean(webhookSecret());
  },

  /**
   * The narrower question: are the keys there at all?
   *
   * True under a mode mismatch, and true with no webhook secret — in both cases
   * the credentials ARE present and are not the thing that needs fixing.
   * razorpayCapability() reports the same pair separately, for the same reason.
   */
  hasCredentials() {
    return paymentModeDecision().configured;
  },

  /** The refusal in a sentence, so a caller can quote it knowing nothing of Razorpay. */
  readinessNote() {
    const capability = razorpayCapability();
    return capability.ready ? null : capability.message;
  },

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    // Input validation first: these are faults in the CALL, and reporting them
    // as a configuration problem would send an operator to the wrong place.
    if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
      fail(`Amount must be a positive integer in paise, got ${input.amountPaise}`);
    }
    const currency = (input.currency || 'INR').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      fail(`Currency must be a three-letter ISO code, got ${JSON.stringify(input.currency)}`);
    }
    if (currency === 'INR' && input.amountPaise < MIN_INR_PAISE) {
      fail(
        `Amount ${input.amountPaise} paise is below Razorpay's one-rupee minimum. ` +
        'An amount this small is usually rupees converted to paise twice.'
      );
    }
    if (!input.reference) {
      fail('An order reference is required — it is what ties the gateway record to ours');
    }
    if (!input.idempotencyKey) {
      fail('An idempotency key is required — without one a retry opens a second order');
    }

    // Refuses on a test/live disagreement. Nothing below this line may run in
    // a mode nobody declared.
    const mode = assertPaymentMode();

    // NO WEBHOOK SECRET, NO CHECKOUT.
    //
    // Nothing in this system marks an order paid except a SIGNED webhook. The
    // browser's return from checkout is a claim (money rule 3), and no polling
    // confirmation exists: the reconcile cron only re-drives events that have
    // already arrived, so with no webhook secret no event ever arrives and
    // there is nothing for it to re-drive.
    //
    // Opening a checkout in that state takes money this deployment can never
    // confirm, never receipt and never issue anything for — and it fails
    // silently, which is the worst way for it to fail: the payer is debited,
    // the order sits in AWAITING PAYMENT for ever, and no error is raised
    // anywhere because from this side nothing happened at all.
    //
    // Refusing here costs a sale. Not refusing costs somebody their money. The
    // federation is not left without a way to be paid: isConfigured() reports
    // false for the same reason, so manual UPI carries it instead.
    if (!webhookSecret()) {
      fail(
        'RAZORPAY_WEBHOOK_SECRET is not set, so no payment could ever be confirmed. ' +
        'Refusing to open a checkout that would take money this deployment cannot verify. ' +
        'Set it to the secret configured on the Razorpay webhook.'
      );
    }

    const order = await call('/orders', {
      method: 'POST',
      // The idempotency key is sent as a header AND kept as the receipt, so a
      // retried request cannot open a second order for the same purchase.
      headers: { 'X-Razorpay-Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        // The SERVER's figure, in integer paise, exactly as Razorpay expects
        // it. Nothing here is derived from anything the browser sent.
        amount: input.amountPaise,
        currency,
        // Razorpay caps the receipt at 40 characters.
        receipt: input.reference.slice(0, 40),
        notes: buildNotes(input, mode),
        // Explicit: a part-paid order is an order that looks settled in the
        // dashboard and is short in the bank.
        partial_payment: false,
      }),
    });

    // Razorpay echoes the order back. If what it created is not what we asked
    // for, fulfilment stops here rather than adjusting to match (money rule 2).
    const echoedAmount = Number(order?.amount);
    if (!Number.isInteger(echoedAmount) || echoedAmount !== input.amountPaise) {
      fail(
        `Razorpay created an order for ${order?.amount} paise but ${input.amountPaise} was requested. ` +
        'Refusing to open checkout on a figure this system did not set.'
      );
    }
    if (String(order?.currency ?? currency).toUpperCase() !== currency) {
      fail(`Razorpay created the order in ${order?.currency}, not ${currency}. Refusing to open checkout.`);
    }
    // The gateway order id is what every later confirmation is matched on. With
    // no id, String() would store the text "undefined" against the payment —
    // matching nothing, and colliding with the next order that did the same.
    const providerOrderId = gatewayId(order?.id);
    if (!providerOrderId) {
      fail('Razorpay returned an order with no id. Refusing to open a checkout that could never be reconciled.');
    }

    return {
      providerOrderId,
      // Only public values. The key secret never reaches the browser.
      checkout: {
        key: keyId(),
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        name: 'MMAKF',
        description: input.reference,
        prefill: {
          name: input.customer?.name ?? '',
          email: input.customer?.email ?? '',
          contact: input.customer?.phone ?? '',
        },
        notes: { mmakf_reference: input.reference },
      },
    };
  },

  /**
   * Verify the signed handshake returned by Razorpay Checkout.
   *
   *   HMAC-SHA256(razorpay_order_id + "|" + razorpay_payment_id, KEY_SECRET)
   *
   * Signed with the API key secret — NOT the webhook secret. The order id must
   * come first: the separator is what stops "order_AB|pay_C" and "order_A|Bpay_C"
   * producing the same digest, and reversing the fields breaks that.
   *
   * A true here proves the browser did not fabricate a success. It does NOT
   * prove capture, and it is never on its own grounds to fulfil an order — the
   * webhook or a direct fetchPayment settles that.
   */
  verifyCheckout(fields: Record<string, string>): boolean {
    const orderId = fields?.razorpay_order_id;
    const paymentId = fields?.razorpay_payment_id;
    const signature = fields?.razorpay_signature;
    const secret = keySecret();
    if (!orderId || !paymentId || !signature || !secret) return false;
    if (typeof orderId !== 'string' || typeof paymentId !== 'string' || typeof signature !== 'string') return false;
    // A field containing the separator could otherwise be split differently by
    // the sender and by us, and two different payments would share a digest.
    if (orderId.includes('|') || paymentId.includes('|')) return false;
    return safeEqualHex(hmacHex(`${orderId}|${paymentId}`, secret), signature);
  },

  verifyWebhook(rawBody: string, headers: Record<string, string>): WebhookResult {
    const secret = webhookSecret();
    const signature = header(headers, 'x-razorpay-signature');

    const invalid = (): WebhookResult => ({ valid: false, eventId: '', eventType: '', raw: null });

    if (!secret || !signature || !rawBody) return invalid();
    // Signed over the RAW body: re-serialising parsed JSON changes the bytes and
    // the signature will not match.
    if (!safeEqualHex(hmacHex(rawBody, secret), signature)) return invalid();

    let body: any;
    try { body = JSON.parse(rawBody); } catch { return invalid(); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();

    const entity = body.payload?.payment?.entity;
    return {
      valid: true,
      // Collision-free per EVENT, stable across retries. See webhookEventId().
      eventId: webhookEventId(headers, body, rawBody),
      eventType: String(body.event ?? 'unknown'),
      payment: entity ? toVerified(entity) : undefined,
      raw: body,
    };
  },

  async fetchPayment(providerPaymentId: string): Promise<VerifiedPayment> {
    if (!providerPaymentId) fail('A provider payment id is required');
    return toVerified(await call(`/payments/${encodeURIComponent(providerPaymentId)}`));
  },

  async refund(providerPaymentId: string, amountPaise: number, reason: string): Promise<RefundResult> {
    if (!providerPaymentId) fail('A provider payment id is required');
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      fail('Refund amount must be a positive integer in paise');
    }
    const r = await call(`/payments/${encodeURIComponent(providerPaymentId)}/refund`, {
      method: 'POST',
      body: JSON.stringify({ amount: amountPaise, notes: { reason: String(reason ?? '').slice(0, 250) } }),
    });
    return {
      providerRefundId: String(r.id),
      amountPaise: Number(r.amount),
      status: r.status === 'processed' ? 'completed' : r.status === 'failed' ? 'failed' : 'processing',
    };
  },
};
