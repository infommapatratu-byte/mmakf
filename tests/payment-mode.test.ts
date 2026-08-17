// The payment mode guard, and the Razorpay adapter's secrecy.
//
// These tests exist because the failure they cover is silent. A live key in a
// preview deployment does not throw, does not warn and does not look different
// on any screen — it simply charges real cards. So every refusal is asserted
// explicitly, in both directions, and the tests that matter most are the ones
// proving a charge CANNOT be attempted rather than that one can.
//
// Nothing here touches the network. fetch is stubbed with a spy that fails the
// test if it is ever called on a path that should have refused first.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import {
  paymentModeDecision, paymentModeReport, paymentModeOk,
  assertPaymentMode, keyIdMode, PaymentModeError,
} from '../src/lib/payments/mode';
import { razorpay, razorpayCapability, razorpayHealthCheck } from '../src/lib/payments/razorpay';
import { PaymentProviderError } from '../src/lib/payments/provider';

const TEST_KEY = 'rzp_test_A1b2C3d4E5f6G7';
const LIVE_KEY = 'rzp_live_A1b2C3d4E5f6G7';
const SECRET = 'sk_not_a_real_secret_00000';
const WEBHOOK = 'wh_not_a_real_secret_00000';

// ─── The decision, as a pure function ───────────────────────────────────────

describe('payment mode guard', () => {
  it('reads the mode from the key prefix and nothing else', () => {
    expect(keyIdMode(TEST_KEY)).toBe('test');
    expect(keyIdMode(LIVE_KEY)).toBe('live');
    expect(keyIdMode('rzp_test')).toBeNull();          // truncated paste
    expect(keyIdMode('RZP_TEST_ABC')).toBeNull();      // case is not decoration
    expect(keyIdMode('')).toBeNull();
  });

  it('reports NOT CONFIGURED cleanly when there are no credentials', () => {
    const d = paymentModeDecision({});
    expect(d.ok).toBe(false);
    expect(d.code).toBe('not_configured');
    expect(d.configured).toBe(false);
    expect(d.mode).toBeNull();
    // Today's actual state. It must read as a fact, not as a fault.
    expect(d.message).toMatch(/not configured/i);
    expect(d.message).not.toMatch(/refus|error|fail/i);
  });

  it('reports not-configured when only one half of the pair is present', () => {
    expect(paymentModeDecision({ RAZORPAY_KEY_ID: TEST_KEY }).code).toBe('not_configured');
    expect(paymentModeDecision({ RAZORPAY_KEY_SECRET: SECRET }).code).toBe('not_configured');
  });

  it('permits a test key under an explicit test mode', () => {
    const d = paymentModeDecision({
      RAZORPAY_KEY_ID: TEST_KEY, RAZORPAY_KEY_SECRET: SECRET, PAYMENT_MODE: 'test',
    });
    expect(d.ok).toBe(true);
    expect(d.mode).toBe('test');
    expect(d.code).toBe('ok');
  });

  it('treats an unset PAYMENT_MODE as test, never as live', () => {
    const d = paymentModeDecision({ RAZORPAY_KEY_ID: TEST_KEY, RAZORPAY_KEY_SECRET: SECRET });
    expect(d.ok).toBe(true);
    expect(d.mode).toBe('test');
    expect(d.declared).toBeNull();
  });

  // ─── The refusal this whole module exists for ─────────────────────────────

  it('REFUSES a live key under PAYMENT_MODE=test', () => {
    const d = paymentModeDecision({
      RAZORPAY_KEY_ID: LIVE_KEY, RAZORPAY_KEY_SECRET: SECRET,
      PAYMENT_MODE: 'test', VERCEL_ENV: 'production',
    });
    expect(d.ok).toBe(false);
    expect(d.code).toBe('mode_mismatch');
    expect(d.mode).toBeNull();
    expect(d.message).toMatch(/REFUSING TO START/);
    expect(d.message).toMatch(/LIVE key/);
  });

  it('REFUSES a live key when PAYMENT_MODE was never set', () => {
    const d = paymentModeDecision({
      RAZORPAY_KEY_ID: LIVE_KEY, RAZORPAY_KEY_SECRET: SECRET, VERCEL_ENV: 'production',
    });
    expect(d.ok).toBe(false);
    expect(d.code).toBe('mode_mismatch');
    // Forgetting a variable must never be the act that turns charging on.
    expect(d.message).toMatch(/PAYMENT_MODE is unset/);
  });

  it('REFUSES a test key under PAYMENT_MODE=live', () => {
    const d = paymentModeDecision({
      RAZORPAY_KEY_ID: TEST_KEY, RAZORPAY_KEY_SECRET: SECRET,
      PAYMENT_MODE: 'live', VERCEL_ENV: 'production',
    });
    expect(d.ok).toBe(false);
    expect(d.code).toBe('mode_mismatch');
    expect(d.message).toMatch(/TEST key/);
  });

  it('REFUSES a live key anywhere but a production deployment', () => {
    for (const vercelEnv of ['preview', 'development', '', 'Production ']) {
      const d = paymentModeDecision({
        RAZORPAY_KEY_ID: LIVE_KEY, RAZORPAY_KEY_SECRET: SECRET,
        PAYMENT_MODE: 'live', VERCEL_ENV: vercelEnv,
      });
      // 'Production ' trims and lowercases to 'production', so it is allowed;
      // everything else is not.
      if (vercelEnv.trim().toLowerCase() === 'production') {
        expect(d.ok).toBe(true);
      } else {
        expect(d.ok).toBe(false);
        expect(d.code).toBe('live_outside_production');
        expect(d.message).toMatch(/REFUSING TO START/);
      }
    }
  });

  it('permits live only when it is declared, keyed and in production', () => {
    const d = paymentModeDecision({
      RAZORPAY_KEY_ID: LIVE_KEY, RAZORPAY_KEY_SECRET: SECRET,
      PAYMENT_MODE: 'live', VERCEL_ENV: 'production',
    });
    expect(d.ok).toBe(true);
    expect(d.mode).toBe('live');
    expect(d.message).toMatch(/Real cards will be charged/);
  });

  it('REFUSES a PAYMENT_MODE it does not recognise rather than defaulting', () => {
    for (const mode of ['sandbox', 'production', 'TEST-ish', 'true', '1']) {
      const d = paymentModeDecision({
        RAZORPAY_KEY_ID: TEST_KEY, RAZORPAY_KEY_SECRET: SECRET, PAYMENT_MODE: mode,
      });
      expect(d.ok).toBe(false);
      expect(d.code).toBe('mode_invalid');
    }
  });

  it('accepts PAYMENT_MODE in any casing, with stray whitespace', () => {
    expect(paymentModeDecision({
      RAZORPAY_KEY_ID: TEST_KEY, RAZORPAY_KEY_SECRET: SECRET, PAYMENT_MODE: '  TEST\n',
    }).ok).toBe(true);
  });

  it('REFUSES a key whose prefix proves nothing', () => {
    for (const key of ['rzp_test', 'k', 'abcdef', 'rzp_', 'test_key']) {
      const d = paymentModeDecision({ RAZORPAY_KEY_ID: key, RAZORPAY_KEY_SECRET: SECRET });
      expect(d.ok).toBe(false);
      expect(d.code).toBe('key_unrecognised');
    }
  });

  it('REFUSES when the key ID has been pasted into the secret field', () => {
    const d = paymentModeDecision({ RAZORPAY_KEY_ID: TEST_KEY, RAZORPAY_KEY_SECRET: TEST_KEY });
    expect(d.ok).toBe(false);
    expect(d.code).toBe('secret_looks_like_key_id');
  });

  it('survives a trailing newline from a dashboard paste', () => {
    const d = paymentModeDecision({
      RAZORPAY_KEY_ID: `${TEST_KEY}\n`, RAZORPAY_KEY_SECRET: ` ${SECRET} `, PAYMENT_MODE: 'test',
    });
    expect(d.ok).toBe(true);
  });

  it('throws a hard refusal from assertPaymentMode, and a mode from a good one', () => {
    const bad = { RAZORPAY_KEY_ID: LIVE_KEY, RAZORPAY_KEY_SECRET: SECRET, PAYMENT_MODE: 'test' };
    expect(() => assertPaymentMode(bad)).toThrow(PaymentModeError);
    expect(() => assertPaymentMode(bad)).toThrow(/REFUSING TO START/);
    expect(() => assertPaymentMode({})).toThrow(/not configured/i);

    const good = { RAZORPAY_KEY_ID: TEST_KEY, RAZORPAY_KEY_SECRET: SECRET, PAYMENT_MODE: 'test' };
    expect(assertPaymentMode(good)).toBe('test');
    expect(paymentModeOk(good)).toBe(true);
    expect(paymentModeOk(bad)).toBe(false);
  });

  it('never puts a secret in the operator report', () => {
    const env = {
      RAZORPAY_KEY_ID: TEST_KEY, RAZORPAY_KEY_SECRET: SECRET,
      RAZORPAY_WEBHOOK_SECRET: WEBHOOK, PAYMENT_MODE: 'test',
    };
    const report = paymentModeReport(env);
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain(WEBHOOK);
    // The key ID is public by design — it is handed to the browser.
    expect(report.keyId).toBe(TEST_KEY);
    expect(report.keySecretPresent).toBe(true);
    expect(report.mode).toBe('test');
  });
});

// ─── The adapter under the guard ────────────────────────────────────────────

describe('Razorpay adapter respects the guard', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'PAYMENT_MODE', 'VERCEL_ENV']) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'PAYMENT_MODE', 'VERCEL_ENV']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  /** Any call to this fails the test: the guard should have refused first. */
  function forbidNetwork() {
    const spy = vi.fn(async () => {
      throw new Error('the adapter reached the network when it should have refused');
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  it('is not configured when the mode guard refuses, so nothing selects it', () => {
    process.env.RAZORPAY_KEY_ID = LIVE_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK;
    process.env.PAYMENT_MODE = 'test';
    expect(razorpay.isConfigured()).toBe(false);

    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    expect(razorpay.isConfigured()).toBe(true);
  });

  it('is not configured when nothing could ever confirm a payment', () => {
    // Both credentials present, mode agreed, and STILL not offered: without a
    // webhook secret the only proof of payment this system accepts can never
    // arrive. Dropping out here is what puts manual UPI in front of the payer
    // instead of a checkout that debits them into silence.
    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.PAYMENT_MODE = 'test';
    expect(razorpay.isConfigured()).toBe(false);

    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK;
    expect(razorpay.isConfigured()).toBe(true);
  });

  it('refuses to open a checkout it could never confirm, before any network call', async () => {
    const fetchSpy = forbidNetwork();
    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.PAYMENT_MODE = 'test';
    // No RAZORPAY_WEBHOOK_SECRET.

    await expect(razorpay.createOrder({
      amountPaise: 189000, currency: 'INR',
      reference: 'MMAKF-ORD-2026-000043', idempotencyKey: 'idem-43',
    })).rejects.toThrow(/could ever be confirmed/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses to create an order on a mode mismatch, before any network call', async () => {
    const fetchSpy = forbidNetwork();
    process.env.RAZORPAY_KEY_ID = LIVE_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.PAYMENT_MODE = 'test';
    process.env.VERCEL_ENV = 'production';

    await expect(razorpay.createOrder({
      amountPaise: 189000, currency: 'INR',
      reference: 'MMAKF-ORD-2026-000042', idempotencyKey: 'idem-1',
    })).rejects.toThrow(PaymentModeError);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses to refund on a mode mismatch, before any network call', async () => {
    const fetchSpy = forbidNetwork();
    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.PAYMENT_MODE = 'live';

    await expect(razorpay.refund('pay_1', 1000, 'duplicate')).rejects.toThrow(PaymentModeError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a bad amount as a CALL fault, not a configuration fault', async () => {
    const fetchSpy = forbidNetwork();
    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;

    for (const amount of [0, -100, 12.5, NaN]) {
      await expect(razorpay.createOrder({
        amountPaise: amount, currency: 'INR', reference: 'MMAKF-ORD-1', idempotencyKey: 'k',
      })).rejects.toThrow(/positive integer/i);
    }
    // Below Razorpay's one-rupee floor — nearly always a double conversion.
    await expect(razorpay.createOrder({
      amountPaise: 50, currency: 'INR', reference: 'MMAKF-ORD-1', idempotencyKey: 'k',
    })).rejects.toThrow(/one-rupee minimum/i);

    await expect(razorpay.createOrder({
      amountPaise: 50000, currency: 'RUPEES', reference: 'MMAKF-ORD-1', idempotencyKey: 'k',
    })).rejects.toThrow(/three-letter ISO/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the SERVER amount in paise and ties the gateway order to ours', async () => {
    let sent: any = null;
    let sentHeaders: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      sentHeaders = init.headers;
      return new Response(JSON.stringify({
        id: 'order_TEST1', amount: sent.amount, currency: sent.currency, status: 'created',
      }), { status: 200 });
    }));

    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK;
    process.env.PAYMENT_MODE = 'test';

    const result = await razorpay.createOrder({
      amountPaise: 189000, currency: 'inr',
      reference: 'MMAKF-ORD-2026-000042',
      notes: { orderNo: 'MMAKF-ORD-2026-000042' },
      idempotencyKey: 'idem-42',
    });

    expect(sent.amount).toBe(189000);              // integer paise, never a float
    expect(sent.currency).toBe('INR');
    expect(sent.receipt).toBe('MMAKF-ORD-2026-000042');
    expect(sent.receipt.length).toBeLessThanOrEqual(40);
    expect(sent.partial_payment).toBe(false);
    expect(sent.notes.mmakf_reference).toBe('MMAKF-ORD-2026-000042');
    expect(sent.notes.mmakf_mode).toBe('test');
    expect(Object.keys(sent.notes).length).toBeLessThanOrEqual(15);
    expect(sentHeaders['X-Razorpay-Idempotency-Key']).toBe('idem-42');

    expect(result.providerOrderId).toBe('order_TEST1');
    // What goes to the browser: the PUBLIC key and nothing else credential-like.
    expect(result.checkout.key).toBe(TEST_KEY);
    expect(JSON.stringify(result.checkout)).not.toContain(SECRET);
  });

  it('cannot have its tie-back overwritten by caller-supplied notes', async () => {
    let sent: any = null;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      sent = JSON.parse(init.body);
      return new Response(JSON.stringify({ id: 'order_X', amount: sent.amount, currency: 'INR' }), { status: 200 });
    }));
    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK;

    await razorpay.createOrder({
      amountPaise: 50000, currency: 'INR', reference: 'MMAKF-ORD-2026-000099',
      notes: { mmakf_reference: 'SOMEONE-ELSES-ORDER', mmakf_mode: 'live' },
      idempotencyKey: 'k',
    });
    expect(sent.notes.mmakf_reference).toBe('MMAKF-ORD-2026-000099');
    expect(sent.notes.mmakf_mode).toBe('test');
  });

  it('refuses to open checkout when Razorpay echoes a different amount', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'order_X', amount: 100, currency: 'INR',        // not what we asked for
    }), { status: 200 })));
    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK;

    await expect(razorpay.createOrder({
      amountPaise: 189000, currency: 'INR', reference: 'MMAKF-ORD-1', idempotencyKey: 'k',
    })).rejects.toThrow(/Refusing to open checkout/i);
  });

  it('refuses an order Razorpay returned with no id — it could never be reconciled', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      amount: 189000, currency: 'INR',                    // no id at all
    }), { status: 200 })));
    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK;

    // Without this the string "undefined" would be stored as the gateway order
    // id: a value that matches no callback, and that a SECOND such order would
    // collide with on the unique index.
    await expect(razorpay.createOrder({
      amountPaise: 189000, currency: 'INR', reference: 'MMAKF-ORD-1', idempotencyKey: 'k',
    })).rejects.toThrow(/no id/i);
  });

  it('scrubs a secret out of an error message even if the gateway echoes it', async () => {
    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { description: `bad credential ${SECRET}` },
    }), { status: 401 })));

    const err = await razorpay.createOrder({
      amountPaise: 50000, currency: 'INR', reference: 'MMAKF-ORD-1', idempotencyKey: 'k',
    }).catch((e) => e);

    expect(err).toBeInstanceOf(PaymentProviderError);
    expect(err.message).not.toContain(SECRET);
    expect(err.message).toContain('[redacted:secret]');
  });
});

// ─── Signature verification ─────────────────────────────────────────────────

describe('Razorpay signature verification', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('verifies HMAC-SHA256(order|payment) with the API secret', () => {
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    const orderId = 'order_ABC123', paymentId = 'pay_XYZ789';
    const good = crypto.createHmac('sha256', SECRET).update(`${orderId}|${paymentId}`).digest('hex');

    expect(razorpay.verifyCheckout({
      razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: good,
    })).toBe(true);
    // Hex is case-insensitive; an upcased digest is the same digest.
    expect(razorpay.verifyCheckout({
      razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: good.toUpperCase(),
    })).toBe(true);
  });

  it('rejects a signature made with the WEBHOOK secret', () => {
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    const wrong = crypto.createHmac('sha256', WEBHOOK).update('order_1|pay_1').digest('hex');
    expect(razorpay.verifyCheckout({
      razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: wrong,
    })).toBe(false);
  });

  it('rejects a prefix of a valid signature — no substring comparison', () => {
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    const good = crypto.createHmac('sha256', SECRET).update('order_1|pay_1').digest('hex');
    for (const forged of [good.slice(0, 63), good.slice(0, 8), good + '0', '']) {
      expect(razorpay.verifyCheckout({
        razorpay_order_id: 'order_1', razorpay_payment_id: 'pay_1', razorpay_signature: forged,
      })).toBe(false);
    }
  });

  it('refuses fields containing the separator, so two payments cannot share a digest', () => {
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    // 'order_1|pay' + '|' + '_1' hashes identically to 'order_1' + '|' + 'pay|_1'.
    const digest = crypto.createHmac('sha256', SECRET).update('order_1|pay|_1').digest('hex');
    expect(razorpay.verifyCheckout({
      razorpay_order_id: 'order_1|pay', razorpay_payment_id: '_1', razorpay_signature: digest,
    })).toBe(false);
    expect(razorpay.verifyCheckout({
      razorpay_order_id: 'order_1', razorpay_payment_id: 'pay|_1', razorpay_signature: digest,
    })).toBe(false);
  });

  it('finds the webhook signature header whatever its casing', () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK;
    const body = JSON.stringify({
      event: 'payment.captured', created_at: 1770000000,
      payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 50000, currency: 'INR', status: 'captured' } } },
    });
    const sig = crypto.createHmac('sha256', WEBHOOK).update(body).digest('hex');

    for (const name of ['x-razorpay-signature', 'X-Razorpay-Signature', 'X-RAZORPAY-SIGNATURE']) {
      expect(razorpay.verifyWebhook(body, { [name]: sig }).valid).toBe(true);
    }
  });

  it('rejects a webhook signed with the API secret rather than the webhook secret', () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    const body = '{"event":"payment.captured"}';
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(razorpay.verifyWebhook(body, { 'x-razorpay-signature': sig }).valid).toBe(false);
  });
});

// ─── The capability report ──────────────────────────────────────────────────

describe('Razorpay capability report', () => {
  const saved = { ...process.env };
  const KEYS = ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'PAYMENT_MODE', 'VERCEL_ENV'];

  beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('reads well when nothing is configured — which is today', () => {
    const cap = razorpayCapability();
    expect(cap.configured).toBe(false);
    expect(cap.ready).toBe(false);
    expect(cap.mode).toBeNull();
    expect(cap.keyId).toBeNull();
    expect(cap.webhookConfigured).toBe(false);
    expect(cap.status).toBe('not_configured');
    expect(cap.message).toMatch(/not configured/i);
  });

  it('shows the public key, the mode and the webhook state — never a secret', () => {
    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK;
    process.env.PAYMENT_MODE = 'test';

    const cap = razorpayCapability();
    expect(cap.configured).toBe(true);
    expect(cap.ready).toBe(true);
    expect(cap.mode).toBe('test');
    expect(cap.keyId).toBe(TEST_KEY);
    expect(cap.webhookConfigured).toBe(true);

    const serialised = JSON.stringify(cap);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).not.toContain(WEBHOOK);
  });

  it('holds the gateway back when nothing could confirm a payment', () => {
    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    // No webhook secret. Credentials ARE present and the mode guard is content,
    // so this reads as configured — but a payment taken here could never be
    // confirmed, receipted or acted on, and that is not a degraded service. It
    // is a debit with nothing on the other side of it, so the provider is held
    // back and the reason is stated in full rather than left to be discovered
    // by the first person who pays.
    const cap = razorpayCapability();
    expect(cap.configured).toBe(true);
    expect(cap.webhookConfigured).toBe(false);
    expect(cap.ready).toBe(false);
    expect(cap.status).toBe('webhook_secret_missing');
    expect(cap.message).toMatch(/RAZORPAY_WEBHOOK_SECRET/);
    expect(cap.message).toMatch(/manual UPI/);
    expect(JSON.stringify(cap)).not.toContain(SECRET);
  });

  it('states the refusal on the admin screen rather than hiding it', () => {
    process.env.RAZORPAY_KEY_ID = LIVE_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.PAYMENT_MODE = 'test';
    const cap = razorpayCapability();
    expect(cap.configured).toBe(true);     // credentials ARE present
    expect(cap.ready).toBe(false);         // and must not be used
    expect(cap.status).toBe('mode_mismatch');
    expect(cap.message).toMatch(/REFUSING TO START/);
  });

  it('health-checks without touching the network when the guard refuses', async () => {
    const spy = vi.fn(async () => { throw new Error('should not be called'); });
    vi.stubGlobal('fetch', spy);
    process.env.RAZORPAY_KEY_ID = LIVE_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    process.env.PAYMENT_MODE = 'test';

    const health = await razorpayHealthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toMatch(/REFUSING TO START/);
    expect(spy).not.toHaveBeenCalled();
    expect(razorpayCapability().lastHealthCheck).toEqual(health);
  });

  it('records a health check that reached Razorpay, and never quotes a secret', async () => {
    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ count: 0, items: [] }), { status: 200 })));

    const health = await razorpayHealthCheck();
    expect(health.ok).toBe(true);
    expect(health.detail).toMatch(/test mode/);
    expect(JSON.stringify(razorpayCapability())).not.toContain(SECRET);
  });

  it('records a failed health check with a scrubbed reason', async () => {
    process.env.RAZORPAY_KEY_ID = TEST_KEY;
    process.env.RAZORPAY_KEY_SECRET = SECRET;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { description: `Authentication failed for ${SECRET}` },
    }), { status: 401 })));

    const health = await razorpayHealthCheck();
    expect(health.ok).toBe(false);
    expect(health.detail).toContain('401');
    expect(health.detail).not.toContain(SECRET);
  });
});
