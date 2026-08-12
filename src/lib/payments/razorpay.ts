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
//
// The two secrets are genuinely different values. Using the API secret to verify
// webhooks is a common integration bug and silently rejects every callback.

import crypto from 'node:crypto';
import {
  PaymentProviderError,
  type CreateOrderInput, type CreateOrderResult, type PaymentProvider,
  type RefundResult, type VerifiedPayment, type WebhookResult,
} from './provider';

const API = 'https://api.razorpay.com/v1';

function keyId() { return process.env.RAZORPAY_KEY_ID || ''; }
function keySecret() { return process.env.RAZORPAY_KEY_SECRET || ''; }
function webhookSecret() { return process.env.RAZORPAY_WEBHOOK_SECRET || ''; }

/** Compare HMACs in constant time; lengths must match before timingSafeEqual. */
function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hmacHex(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  if (!keyId() || !keySecret()) {
    throw new PaymentProviderError('razorpay', 'Not configured: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are unset');
  }
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
    throw new PaymentProviderError('razorpay', `Network failure calling ${path}: ${err?.message}`);
  }

  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }

  if (!res.ok) {
    const detail = body?.error?.description || text.slice(0, 300);
    throw new PaymentProviderError('razorpay', `${res.status} on ${path}: ${detail}`, body);
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

function toVerified(p: any): VerifiedPayment {
  return {
    providerPaymentId: String(p.id),
    providerOrderId: String(p.order_id ?? ''),
    amountPaise: Number(p.amount),        // Razorpay is already in paise
    currency: String(p.currency ?? 'INR'),
    status: mapStatus(String(p.status)),
    method: p.method ? String(p.method) : undefined,
    feePaise: p.fee != null ? Number(p.fee) : undefined,
    taxPaise: p.tax != null ? Number(p.tax) : undefined,
    failureReason: p.error_description ? String(p.error_description) : undefined,
  };
}

export const razorpay: PaymentProvider = {
  id: 'razorpay',
  label: 'Razorpay',

  isConfigured() {
    return Boolean(keyId() && keySecret());
  },

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new PaymentProviderError('razorpay', `Amount must be a positive integer in paise, got ${input.amountPaise}`);
    }

    const order = await call('/orders', {
      method: 'POST',
      // The idempotency key is sent as a header AND kept as the receipt, so a
      // retried request cannot open a second order for the same purchase.
      headers: { 'X-Razorpay-Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: input.currency || 'INR',
        receipt: input.reference.slice(0, 40),
        notes: input.notes ?? {},
      }),
    });

    return {
      providerOrderId: String(order.id),
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
      },
    };
  },

  verifyCheckout(fields: Record<string, string>): boolean {
    const orderId = fields.razorpay_order_id;
    const paymentId = fields.razorpay_payment_id;
    const signature = fields.razorpay_signature;
    if (!orderId || !paymentId || !signature || !keySecret()) return false;
    return safeEqualHex(hmacHex(`${orderId}|${paymentId}`, keySecret()), signature);
  },

  verifyWebhook(rawBody: string, headers: Record<string, string>): WebhookResult {
    const secret = webhookSecret();
    // Header names arrive with inconsistent casing across runtimes.
    const signature =
      headers['x-razorpay-signature'] ||
      headers['X-Razorpay-Signature'] ||
      headers['x-razorpay-signature'.toUpperCase()] ||
      '';

    const invalid = (): WebhookResult => ({ valid: false, eventId: '', eventType: '', raw: null });

    if (!secret || !signature || !rawBody) return invalid();
    // Signed over the RAW body: re-serialising parsed JSON changes the bytes and
    // the signature will not match.
    if (!safeEqualHex(hmacHex(rawBody, secret), signature)) return invalid();

    let body: any;
    try { body = JSON.parse(rawBody); } catch { return invalid(); }
    if (!body || typeof body !== 'object') return invalid();

    const entity = body.payload?.payment?.entity;
    return {
      valid: true,
      // Razorpay sends x-razorpay-event-id; fall back to the payment id so the
      // replay guard always has something unique to key on.
      eventId: String(headers['x-razorpay-event-id'] || entity?.id || `${body.event}:${body.created_at}`),
      eventType: String(body.event ?? 'unknown'),
      payment: entity ? toVerified(entity) : undefined,
      raw: body,
    };
  },

  async fetchPayment(providerPaymentId: string): Promise<VerifiedPayment> {
    return toVerified(await call(`/payments/${encodeURIComponent(providerPaymentId)}`));
  },

  async refund(providerPaymentId: string, amountPaise: number, reason: string): Promise<RefundResult> {
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new PaymentProviderError('razorpay', 'Refund amount must be a positive integer in paise');
    }
    const r = await call(`/payments/${encodeURIComponent(providerPaymentId)}/refund`, {
      method: 'POST',
      body: JSON.stringify({ amount: amountPaise, notes: { reason: reason.slice(0, 250) } }),
    });
    return {
      providerRefundId: String(r.id),
      amountPaise: Number(r.amount),
      status: r.status === 'processed' ? 'completed' : r.status === 'failed' ? 'failed' : 'processing',
    };
  },
};
