// The payment mode guard.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS PREVENTS
// ─────────────────────────────────────────────────────────────────────────────
//
// Razorpay issues two key pairs that are byte-for-byte interchangeable at the
// call site. They differ only in a prefix:
//
//   rzp_test_…   a sandbox. No money moves. Cards are fake.
//   rzp_live_…   a real merchant account. Money moves. Members are charged.
//
// Nothing in the API, the SDK-less REST calls we make, or the checkout script
// distinguishes them. Paste the wrong one into the environment and every code
// path continues to work perfectly — while taking real money from real people
// against a schedule of fees MMAKF has not published, in a build nobody has
// signed off. That failure is silent, immediate, and irreversible: a refund
// undoes the transfer but not the chargeback exposure, the ledger noise, or the
// fact that a member was debited by a system in testing.
//
// So the mode is DECLARED, not inferred. PAYMENT_MODE states the intent, the
// key prefix states the fact, and this module refuses to run when the two
// disagree. A warning would not do: warnings are read after the money has left.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULES, AND WHY EACH ONE
// ─────────────────────────────────────────────────────────────────────────────
//
//  1. No key at all → NOT CONFIGURED. Not a refusal, not an error, not a
//     scary screen. It is today's honest state and every surface reading it
//     should say so plainly.
//
//  2. PAYMENT_MODE set to anything other than 'test' or 'live' → refuse. A
//     typo ('Test', 'sandbox', 'production') must not fall through to a
//     default, because the default a reader assumes and the default the code
//     picks are rarely the same one.
//
//  3. A key whose prefix is neither rzp_test_ nor rzp_live_ → refuse. We
//     cannot prove such a key is a sandbox key, and "cannot prove it is safe"
//     is the same as unsafe when the downside is charging somebody. A truncated
//     paste — 'rzp_test' with the trailing underscore lost — lands here.
//
//  4. PAYMENT_MODE unset → treated as 'test', and a LIVE key is refused under
//     it. The asymmetry is deliberate: forgetting to set a variable must never
//     be the act that turns real charging on. Going live is a thing you say out
//     loud.
//
//  5. Declared mode disagrees with the key prefix → refuse, in both
//     directions. Live key under test is money taken by accident. Test key
//     under live is worse than it looks: every payment fails while the rest of
//     the system has been told this deployment charges for real, so failures
//     get read as gateway flakiness rather than as the misconfiguration they
//     are.
//
//  6. A live key anywhere but VERCEL_ENV=production → refuse. Preview
//     deployments are built from every branch and are publicly reachable. A
//     live key on a preview URL is a checkout that charges real cards from a
//     build that was never reviewed. VERCEL_ENV unset (local development) is
//     not production either, and is refused for the same reason.
//
//  7. RAZORPAY_KEY_SECRET that looks like a key ID → refuse. The two fields sit
//     next to each other in every dashboard and get swapped often. Swapped
//     credentials fail authentication in a way that reads like an outage.
//
// This module reads the environment on every call rather than freezing a
// decision at import. Serverless functions are re-used across invocations and
// re-created without warning, and a cached "it was fine when we booted"
// outlives the configuration it was based on.
//
// NOTHING HERE EVER RETURNS, LOGS OR EMBEDS A SECRET. It reads the shape of
// RAZORPAY_KEY_SECRET — is it present, does it look like the wrong field — and
// reports booleans. The key ID is public by design and is the only credential
// value this module will hand back.

export type PaymentMode = 'test' | 'live';

/** Every way the guard can answer. `ok` is the only one that permits a charge. */
export type PaymentModeCode =
  | 'ok'
  | 'not_configured'
  | 'mode_invalid'
  | 'key_unrecognised'
  | 'mode_mismatch'
  | 'live_outside_production'
  | 'secret_looks_like_key_id';

export interface PaymentModeDecision {
  /** True only when a payment may legitimately be attempted. */
  ok: boolean;
  code: PaymentModeCode;
  /** Operator-facing, safe to print on an admin screen. Never quotes a secret. */
  message: string;
  /** The mode actually in force. Null whenever `ok` is false. */
  mode: PaymentMode | null;
  /** What PAYMENT_MODE said, before it was checked against the key. */
  declared: PaymentMode | null;
  /** What the key prefix proves. Null when the prefix is unrecognised. */
  keyMode: PaymentMode | null;
  /** True once RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are both present. */
  configured: boolean;
}

/** Thrown on a money path when the guard refuses. Never carries a secret. */
export class PaymentModeError extends Error {
  readonly code: PaymentModeCode;

  constructor(decision: PaymentModeDecision) {
    super(`[razorpay] ${decision.message}`);
    this.name = 'PaymentModeError';
    this.code = decision.code;
  }
}

const TEST_PREFIX = 'rzp_test_';
const LIVE_PREFIX = 'rzp_live_';

type Env = Record<string, string | undefined>;

/**
 * Trim before inspecting.
 *
 * A trailing newline survives a paste into a dashboard field and is invisible
 * there. It makes a value non-empty — so "is it set" says yes — while breaking
 * every comparison made against it.
 */
function read(env: Env, name: string): string {
  return (env[name] ?? '').trim();
}

/** What the prefix proves about a key ID. Null means it proves nothing. */
export function keyIdMode(keyId: string): PaymentMode | null {
  const k = keyId.trim();
  if (k.startsWith(TEST_PREFIX)) return 'test';
  if (k.startsWith(LIVE_PREFIX)) return 'live';
  return null;
}

/**
 * Decide whether Razorpay may be used, and say why not when it may not.
 *
 * `env` is injectable so the decision can be exercised against every
 * combination without mutating the process the tests run in.
 */
export function paymentModeDecision(env: Env = process.env): PaymentModeDecision {
  const keyId = read(env, 'RAZORPAY_KEY_ID');
  const keySecret = read(env, 'RAZORPAY_KEY_SECRET');
  const rawMode = read(env, 'PAYMENT_MODE').toLowerCase();
  const vercelEnv = read(env, 'VERCEL_ENV').toLowerCase();

  const declared: PaymentMode | null =
    rawMode === 'test' || rawMode === 'live' ? rawMode : null;

  const base = {
    mode: null,
    declared,
    keyMode: keyIdMode(keyId),
    configured: Boolean(keyId && keySecret),
  } as const;

  // (1) Absent credentials are not a fault. This is MMAKF's current state.
  if (!keyId || !keySecret) {
    return {
      ...base,
      ok: false,
      code: 'not_configured',
      message:
        'Razorpay is not configured. RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are unset, ' +
        'so no card payment can be taken through this deployment.',
    };
  }

  // (2) A mode we do not recognise is never quietly assumed.
  if (rawMode && !declared) {
    return {
      ...base,
      ok: false,
      code: 'mode_invalid',
      message:
        `PAYMENT_MODE must be exactly 'test' or 'live'. It is set to something else, ` +
        'so the intended mode cannot be established and no payment will be attempted.',
    };
  }

  // (7) The two credential fields sit together in the dashboard and get swapped.
  // Checked by shape only — the value never leaves this function.
  if (keySecret.startsWith(TEST_PREFIX) || keySecret.startsWith(LIVE_PREFIX)) {
    return {
      ...base,
      ok: false,
      code: 'secret_looks_like_key_id',
      message:
        'RAZORPAY_KEY_SECRET begins with a key-ID prefix, so the key ID has been pasted ' +
        'into the secret field. Re-copy both values from the Razorpay dashboard.',
    };
  }

  // (3) An unrecognised prefix cannot be proven to be a sandbox key.
  const keyMode = base.keyMode;
  if (!keyMode) {
    return {
      ...base,
      ok: false,
      code: 'key_unrecognised',
      message:
        `RAZORPAY_KEY_ID does not begin with '${TEST_PREFIX}' or '${LIVE_PREFIX}', so whether it is a ` +
        'sandbox or a live credential cannot be established. Refusing rather than guessing — ' +
        'a truncated or mistyped key must not be treated as a test key.',
    };
  }

  // (4) An undeclared mode means test. Live is never reached by omission.
  const effective: PaymentMode = declared ?? 'test';

  // (5) Intent and fact must agree, in both directions.
  if (keyMode !== effective) {
    const message =
      keyMode === 'live'
        ? 'REFUSING TO START: RAZORPAY_KEY_ID is a LIVE key (rzp_live_) but the payment mode is ' +
          `'test'${declared ? '' : ' (PAYMENT_MODE is unset, which means test)'}. A live key charges real cards. ` +
          "Set PAYMENT_MODE=live deliberately, or replace the key with the rzp_test_ pair."
        : "REFUSING TO START: PAYMENT_MODE=live but RAZORPAY_KEY_ID is a TEST key (rzp_test_). " +
          'Every payment would fail against the sandbox while this deployment tells members it is ' +
          'charging for real. Supply the rzp_live_ pair, or set PAYMENT_MODE=test.';
    return { ...base, ok: false, code: 'mode_mismatch', message };
  }

  // (6) Live belongs to production alone. Previews are built from every branch.
  if (effective === 'live' && vercelEnv !== 'production') {
    return {
      ...base,
      ok: false,
      code: 'live_outside_production',
      message:
        'REFUSING TO START: live Razorpay credentials on a deployment where VERCEL_ENV is ' +
        `${vercelEnv ? `'${vercelEnv}'` : 'unset'}, not 'production'. Preview and development builds are ` +
        'publicly reachable and were never reviewed for taking money.',
    };
  }

  return {
    ...base,
    ok: true,
    code: 'ok',
    mode: effective,
    message:
      effective === 'test'
        ? 'Razorpay is in TEST mode. No money moves; only Razorpay test instruments will succeed.'
        : 'Razorpay is in LIVE mode on a production deployment. Real cards will be charged.',
  };
}

/** True when a payment may be attempted. Never throws — for selection logic. */
export function paymentModeOk(env: Env = process.env): boolean {
  return paymentModeDecision(env).ok;
}

/**
 * The mode, or a hard refusal.
 *
 * Called at the top of every path that could move money. Throwing here is the
 * whole point: a caller that ignores a boolean cannot ignore this.
 */
export function assertPaymentMode(env: Env = process.env): PaymentMode {
  const decision = paymentModeDecision(env);
  if (!decision.ok || !decision.mode) throw new PaymentModeError(decision);
  return decision.mode;
}

/**
 * The guard as an admin screen should show it.
 *
 * `keyId` is Razorpay's PUBLIC key — it is handed to the browser to open
 * checkout, so displaying it reveals nothing. Neither secret appears here in
 * any form, redacted or otherwise: a masked secret still confirms its length.
 */
export function paymentModeReport(env: Env = process.env): {
  ok: boolean;
  code: PaymentModeCode;
  message: string;
  mode: PaymentMode | null;
  declaredMode: PaymentMode | null;
  keyId: string | null;
  keySecretPresent: boolean;
  vercelEnv: string | null;
} {
  const decision = paymentModeDecision(env);
  const keyId = read(env, 'RAZORPAY_KEY_ID');
  return {
    ok: decision.ok,
    code: decision.code,
    message: decision.message,
    mode: decision.mode,
    declaredMode: decision.declared,
    keyId: keyId || null,
    keySecretPresent: Boolean(read(env, 'RAZORPAY_KEY_SECRET')),
    vercelEnv: read(env, 'VERCEL_ENV') || null,
  };
}
