// RazorpayX payout adapter — DELIBERATELY NOT SWITCHED ON.
//
// ═════════════════════════════════════════════════════════════════════════════
// READ THIS BEFORE CHANGING ANYTHING IN THIS FILE
// ═════════════════════════════════════════════════════════════════════════════
//
// This adapter does not send money, and `isConfigured()` returns FALSE even
// when every credential is present and correct. That is not an oversight and it
// is not a stub somebody forgot to finish. It is the same rule the rest of this
// codebase applies to a commission rate MMAKF has not published, applied to an
// API contract nobody here has verified:
//
//   A PLAUSIBLE-LOOKING WRONG ENDPOINT IS WORSE THAN AN HONEST REFUSAL.
//
// The failure mode is specific and it is not hypothetical. Suppose the payout
// path is off by one field name — the idempotency header is called something
// else, or the amount field takes rupees rather than paise, or the fund-account
// id and the contact id are the other way round. Nothing fails at build time.
// Nothing fails in review. It fails on the first real settlement run, at
// whatever hour that runs, with real money either not moving (recoverable,
// embarrassing) or moving to the wrong place or moving twice (not recoverable
// by anything in this system). A person is then debugging a third party's API
// against live funds, at night, with sellers waiting.
//
// Against that, the cost of this file refusing is that MMAKF keeps making
// payouts by hand — which is what it does today, which works, and which is
// implemented completely in src/lib/payouts/manual.ts.
//
// So: the SHAPE is here, the guard rails are here, the webhook verification is
// here and is real, and every path that would move money refuses with a message
// naming exactly what a person must confirm first.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT MUST BE CONFIRMED AGAINST RAZORPAYX'S OWN DOCUMENTATION
// ═════════════════════════════════════════════════════════════════════════════
//
// Every item below is a thing this file does NOT assert. Whoever switches this
// adapter on works through them against the current RazorpayX documentation —
// not against a blog post, not against another codebase, and not against this
// comment — writes the confirmed value into the constants below, and only then
// removes the refusal in `isConfigured()`.
//
//  1. THE BASE URL AND API VERSION for RazorpayX payouts. It is not assumed to
//     be the same host or the same version prefix as the Razorpay payments API
//     that src/lib/payments/razorpay.ts calls.
//
//  2. THE RESOURCE PATHS AND THEIR ORDER. RazorpayX models a destination in
//     more than one object — a contact for the person, a fund account for the
//     bank details — and a payout names one of them. Which one, what each path
//     is, and which must exist before the other, must be read off the
//     documentation. Getting this pair the wrong way round produces a payout
//     that is accepted and goes nowhere identifiable.
//
//  3. THE IDEMPOTENCY HEADER NAME, and its semantics: how long the key is
//     honoured for, whether a repeat returns the original payout or an error,
//     and what happens when the same key arrives with a DIFFERENT amount. That
//     last one is the case that matters — see the note on `sendPayout` below.
//     THIS IS THE SINGLE MOST IMPORTANT ITEM ON THIS LIST. Without a header the
//     provider actually honours, the second guard against a double transfer
//     does not exist, and only the local unique index remains — which does not
//     help when the first request timed out after being accepted.
//
//  4. THE AMOUNT UNIT. Razorpay's payments API quotes integer paise. Whether
//     the payouts API does the same must be confirmed rather than assumed; a
//     hundredfold error in either direction is the worst single bug this
//     subsystem could carry.
//
//  5. THE SOURCE ACCOUNT FIELD. A RazorpayX payout is made FROM a specific
//     account, identified in the request. What the field is called, what value
//     it takes, and where an operator finds that value are all things to read
//     rather than guess.
//
//  6. THE MODE AND PURPOSE FIELDS. RazorpayX distinguishes rails and requires
//     a purpose. Which values are valid, and which of them MMAKF's seller
//     payouts fall under, is partly documentation and partly a federation
//     decision — see PAYOUT_PURPOSE_NOT_SET below.
//
//  7. THE PAYOUT STATUS VOCABULARY, and specifically which statuses are
//     TERMINAL. `mapStatus()` below deliberately maps nothing: a status this
//     file does not recognise must not be flattened into 'processing' (a
//     failed payout that polls for ever) or into 'failed' (a successful payout
//     reversed on paper while the money is gone).
//
//  8. THE WEBHOOK EVENT NAMES AND PAYLOAD SHAPE, and whether the signature
//     header is the one this file reads. See the note on `verifyWebhook` for
//     why that one method may nevertheless ship ahead of the rest.
//
//  9. TEST/LIVE SEPARATION. Whether RazorpayX credentials carry a prefix that
//     distinguishes a sandbox from a live account the way `rzp_test_` and
//     `rzp_live_` do on the payments side. If they do, this adapter needs the
//     equivalent of src/lib/payments/mode.ts before it goes live, and for the
//     same reason — a live credential in a preview deployment. If they do NOT,
//     that is a finding worth writing down, because it means the safeguard the
//     payments side relies on cannot be reproduced here and something else has
//     to stand in for it.
//
// 10. WHETHER A PAYOUT CAN BE CANCELLED, and up to what point. `seller_payouts`
//     has a `cancelled` status and this adapter offers no way to reach it,
//     because a cancel that silently does nothing is worse than no cancel.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT MAY AND MAY NOT LEAVE THIS FILE
// ═════════════════════════════════════════════════════════════════════════════
//
// Audited on the same terms as src/lib/payments/razorpay.ts, and more strictly
// in one respect, because this adapter handles bank account numbers:
//
//   · This adapter writes NOTHING to console. Not a debug line, not an error.
//   · No secret is returned by any function, including in masked form — a mask
//     still discloses a length.
//   · NO BANK ACCOUNT NUMBER LEAVES THIS FILE IN ANY FORM. It arrives on
//     `PayoutAccountInput`, and the return type has no field it could survive
//     in. No error message interpolates it. Nothing is logged. The value's
//     lifetime is the body of one function.
//   · RAZORPAYX_ACCOUNT_NUMBER — the federation's OWN source account — is read
//     only to answer a boolean about whether it is present. It is never
//     returned by the capability report, never interpolated into a message and
//     never thrown.

import crypto from 'node:crypto';
import {
  PayoutProviderError,
  assertAmountMinor, assertCurrency, assertIdempotencyKey,
  ifscPrefixOf, last4Of,
  type PayoutAccountInput, type PayoutAccountRef, type PayoutAccountVerification,
  type PayoutProvider, type PayoutStatusResult, type PayoutWebhookResult,
  type SendPayoutInput, type SendPayoutResult,
} from './provider';

const ID = 'razorpayx';

// ═════════════════════════════════════════════════════════════════════════════
// THE REFUSAL
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Why this adapter cannot send money, in the words an operator should read.
 *
 * Exported so a surface can quote it without knowing anything about RazorpayX,
 * and so a test can assert that the refusal still says what it says.
 */
export const RAZORPAYX_NOT_VERIFIED =
  'The RazorpayX payout adapter is present but has NOT been verified against ' +
  'RazorpayX\'s API documentation, so it will not send money. The endpoint paths, ' +
  'the idempotency header, the amount unit and the payout status vocabulary must ' +
  'each be confirmed and written into src/lib/payouts/razorpayx.ts first. Until ' +
  'then payouts are made by bank transfer and recorded by the federation office, ' +
  'which is what MMAKF does today. A guessed endpoint that fails mid-transfer is ' +
  'worse than a queue somebody works by hand.';

/**
 * Which RazorpayX payout purpose MMAKF's seller settlements fall under, and
 * which rail they use, is unset.
 *
 * Part documentation (what values does the API accept) and part federation
 * decision (a payout categorised as one thing rather than another is a
 * statement about what the money is, which reaches accounting and possibly
 * TDS). Neither half is settled, so neither is guessed.
 */
export const PAYOUT_PURPOSE_NOT_SET =
  'MMAKF has not decided how a seller settlement is categorised to the payout ' +
  'provider — the purpose it is filed under and the rail it goes over. Both reach ' +
  'accounting and possibly tax treatment, so neither is defaulted here.';

/**
 * The environment variables this adapter would read.
 *
 * Named in one place so the capability report and the readiness note cannot
 * drift from each other, and so an operator reading the report is told the
 * exact variable names rather than an approximation of them.
 *
 * `RAZORPAYX_ACCOUNT_NUMBER` is the federation's own source account. It is
 * genuinely a sensitive value and this file reads it only to answer "is it
 * present". It is never returned and never interpolated into a message.
 */
export const RAZORPAYX_ENV = {
  keyId: 'RAZORPAYX_KEY_ID',
  keySecret: 'RAZORPAYX_KEY_SECRET',
  webhookSecret: 'RAZORPAYX_WEBHOOK_SECRET',
  sourceAccount: 'RAZORPAYX_ACCOUNT_NUMBER',
} as const;

function env(name: string): string {
  // Trimmed before inspection, for the reason set out in
  // src/lib/payments/mode.ts: a trailing newline survives a paste into a
  // dashboard field, is invisible there, makes "is it set" answer yes, and
  // breaks every comparison made against the value.
  return (process.env[name] || '').trim();
}

function keyId() { return env(RAZORPAYX_ENV.keyId); }
function keySecret() { return env(RAZORPAYX_ENV.keySecret); }
function webhookSecret() { return env(RAZORPAYX_ENV.webhookSecret); }
function sourceAccountPresent() { return Boolean(env(RAZORPAYX_ENV.sourceAccount)); }

/**
 * Remove any literal secret from a string before it can be thrown or returned.
 *
 * Identical in construction to `scrub()` in src/lib/payments/razorpay.ts,
 * including the short-value guard: a two-character "secret" would match
 * everywhere and turn a diagnostic into confetti. RazorpayX does not echo
 * credentials back, and an adapter is the wrong place to rely on somebody
 * else's response body staying well behaved.
 */
function scrub(text: string): string {
  let out = text;
  for (const secret of [keySecret(), webhookSecret(), env(RAZORPAYX_ENV.sourceAccount)]) {
    if (secret.length >= 8 && out.includes(secret)) {
      out = out.split(secret).join('[redacted:secret]');
    }
  }
  return out;
}

/** Every money path lands here. One place, one message, one code. */
function refuse(operation: string): never {
  throw new PayoutProviderError(
    ID, 'not_verified',
    scrub(`${operation} is not available: ${RAZORPAYX_NOT_VERIFIED}`),
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// SIGNATURE VERIFICATION — the one part that is real, and why it may be
// ═════════════════════════════════════════════════════════════════════════════
//
// Everything else in this file refuses because being wrong would move money
// wrongly. Verification cannot: it either says a body is authentic or it says
// it is not, and NOTHING IN THIS SYSTEM ACTS ON A FALSE. So the failure mode of
// a wrong header name or a wrong secret here is that every webhook is rejected
// — the adapter behaves exactly as if it were not implemented, which is the
// state it is in anyway.
//
// That asymmetry is the whole argument for shipping this method finished while
// the rest refuses. It FAILS CLOSED, so implementing it costs nothing that
// leaving it out would have saved, and it means the one piece of this adapter
// that is genuinely subtle — constant-time comparison over the raw bytes — is
// written and tested now rather than at the same time as everything else, by
// somebody in a hurry to switch a provider on.
//
// The construction is byte-for-byte the approach in
// src/lib/payments/razorpay.ts. The two are NOT shared through a common helper,
// deliberately: they verify with different secrets over different bodies, and a
// shared function is one refactor away from being called with the payments
// webhook secret against a payout body — which fails closed, and would be
// diagnosed as an outage rather than as the mix-up it is.

/** Compare digests in constant time; lengths must match before timingSafeEqual. */
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
 * The header the signature is expected on.
 *
 * UNCONFIRMED for RazorpayX specifically — item 8 on the list at the head of
 * this file. Named as a constant rather than inlined so that confirming it is a
 * one-line change in an obvious place, and so a test can state which header the
 * code currently reads instead of that fact being buried in a call.
 *
 * A wrong value here rejects every webhook. That is safe, and it is why this
 * method ships while the money paths do not.
 */
export const RAZORPAYX_SIGNATURE_HEADER = 'x-razorpay-signature';

/** The header a delivery id is expected on, when one is sent. Same caveat. */
export const RAZORPAYX_EVENT_ID_HEADER = 'x-razorpay-event-id';

/**
 * The key a replay guard runs on.
 *
 * Constructed so that it is CORRECT EVEN IF THE PAYLOAD SHAPE IS NOT WHAT THIS
 * FILE EXPECTS, which matters because the shape is unconfirmed:
 *
 *   · a delivery id from the header is used when present, because every RETRY
 *     of one event carries the same value, which is exactly what a replay guard
 *     wants;
 *   · otherwise the key names the event, the most specific entity id this file
 *     can find, AND the digest of the exact bytes that were signed.
 *
 * The digest is what makes the fallback safe under an unknown shape. Two
 * genuinely different events cannot produce the same bytes, so they cannot
 * collide even if neither entity id was found; two deliveries of the same event
 * are byte-identical and still key alike.
 *
 * This is the same derivation, and the same reasoning, as `webhookEventId()` in
 * src/lib/payments/razorpay.ts — where the defect it was written to fix was a
 * payment id standing in for an event id, so that `payment.captured` collided
 * with `payment.authorized` and the capture was swallowed as a duplicate. Money
 * taken, order left awaiting payment, and the log reading "already seen". The
 * payout equivalent would swallow a `payout.processed` behind the
 * `payout.initiated` that preceded it, leaving a settlement open against money
 * that had already gone.
 */
function webhookEventId(headers: Record<string, string>, body: any, rawBody: string): string {
  const fromHeader = header(headers, RAZORPAYX_EVENT_ID_HEADER);
  if (fromHeader) return fromHeader.slice(0, 200);

  const payload = body?.payload ?? {};
  const entityId =
    payload?.payout?.entity?.id ??
    payload?.transaction?.entity?.id ??
    payload?.fund_account?.entity?.id ??
    '';
  const digest = crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
  return `derived:${String(body?.event ?? 'unknown')}:${String(entityId)}:${digest}`;
}

/**
 * A provider status, mapped onto ours — or nothing at all.
 *
 * DELIBERATELY MAPS NOTHING TODAY. Item 7 at the head of this file: the RazorpayX
 * status vocabulary and, more importantly, which of its statuses are TERMINAL,
 * are unconfirmed.
 *
 * The two tempting defaults are both wrong in a way that costs money:
 *
 *   · defaulting an unknown status to 'processing' makes a FAILED payout poll
 *     for ever, so a seller waits on money that is never coming and no queue
 *     shows a problem;
 *   · defaulting it to 'failed' reverses a payout on paper while the money has
 *     actually left, so the settlement reopens and the seller is paid twice.
 *
 * So an unrecognised status returns null, and the caller is required to have a
 * branch for "the provider said something we do not understand" — which lands
 * in a queue a person looks at, where an unknown state belongs.
 */
export function mapPayoutStatus(_providerStatus: string): null {
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// CAPABILITY REPORT
// ═════════════════════════════════════════════════════════════════════════════

export interface RazorpayXCapability {
  provider: 'razorpayx';
  /** Both credentials are present. Says nothing about whether they work. */
  configured: boolean;
  /** Always false today. The adapter is unverified — see RAZORPAYX_NOT_VERIFIED. */
  ready: boolean;
  webhookConfigured: boolean;
  sourceAccountConfigured: boolean;
  /**
   * The PUBLIC key id, when present. Included for the same reason
   * `paymentModeReport()` includes Razorpay's: it is handed out by design, and
   * an operator matching a deployment against a dashboard needs to see which
   * account it is pointed at. NO OTHER CREDENTIAL APPEARS HERE IN ANY FORM.
   */
  keyId: string | null;
  status: 'not_verified';
  /** Plain English, safe to render verbatim on an admin screen. */
  message: string;
  /** What a person must confirm before this can be switched on. */
  checklist: string[];
}

/**
 * Everything an admin screen may show about this adapter.
 *
 * The distinction it draws is the one that saves an operator an afternoon:
 * `configured` says the credentials are there, `ready` says the adapter may be
 * used, and today the second is false regardless of the first. An operator who
 * has correctly set every variable and sees "not ready" needs to be told that
 * the variables are not the problem.
 */
export function razorpayxCapability(): RazorpayXCapability {
  return {
    provider: 'razorpayx',
    configured: Boolean(keyId() && keySecret()),
    ready: false,
    webhookConfigured: Boolean(webhookSecret()),
    sourceAccountConfigured: sourceAccountPresent(),
    keyId: keyId() || null,
    status: 'not_verified',
    message: RAZORPAYX_NOT_VERIFIED,
    checklist: [
      'Confirm the RazorpayX API base URL and version prefix for payouts.',
      'Confirm the contact and fund-account resource paths, and which must exist first.',
      'Confirm the idempotency header name, how long a key is honoured, and what a repeat returns.',
      'Confirm whether the payout amount field takes integer paise or rupees.',
      'Confirm the source-account field name and the value it takes.',
      'Confirm the valid mode and purpose values, then decide which MMAKF uses.',
      'Confirm the payout status vocabulary and which statuses are terminal.',
      'Confirm the webhook event names, payload shape and signature header.',
      'Confirm whether test and live credentials are distinguishable, as rzp_test_ / rzp_live_ are.',
      'Confirm whether a payout can be cancelled, and up to what point.',
    ],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// THE ADAPTER
// ═════════════════════════════════════════════════════════════════════════════

export const razorpayxPayouts: PayoutProvider = {
  id: ID,
  label: 'RazorpayX (not yet verified — no payout will be sent)',

  /**
   * True as a STATEMENT OF INTENT about what this provider would be, not a
   * claim about what it does today. `isConfigured()` is false, so nothing
   * selects it and nothing reads this.
   *
   * It is set truthfully rather than defensively because the day the adapter is
   * verified, `automatic` becoming wrong would be a silent surface bug — a
   * payout queue telling an officer to go and make a transfer that RazorpayX
   * already made.
   */
  automatic: true,

  /**
   * FALSE. ALWAYS. Whatever the credentials say.
   *
   * `isConfigured()` on the payments side already means "usable end to end"
   * rather than "populated" — a gateway that could take a payment and never
   * confirm it is withheld. This is the same test applied to a harder case: an
   * adapter whose API contract has not been confirmed could send a transfer and
   * be unable to describe what it did.
   *
   * Returning false is what keeps RazorpayX out of `availablePayoutProviders()`
   * and out of `activePayoutProvider()`, so the manual adapter carries the
   * federation exactly as manual UPI does on the paying-in side. The reason is
   * not lost: `readinessNote()` and `razorpayxCapability()` both state it in
   * full, in a sentence, on an admin screen.
   *
   * TO SWITCH THIS ON: work through the checklist at the head of this file
   * against RazorpayX's documentation, implement the calls, and only then
   * change this function. Changing this function alone gets you an adapter that
   * refuses at the first call with real money queued behind it.
   */
  isConfigured() {
    return false;
  },

  /**
   * The narrower question: are the keys there at all?
   *
   * True with perfect credentials and an unverified adapter — which is the
   * entire point of the method. An operator who has set every variable and is
   * told "not configured" goes and re-enters credentials that were right.
   */
  hasCredentials() {
    return Boolean(keyId() && keySecret());
  },

  readinessNote() {
    return RAZORPAYX_NOT_VERIFIED;
  },

  /**
   * VALIDATES, THEN REFUSES.
   *
   * The validation runs first and is not decoration. It means that the day this
   * adapter is switched on, a seller record that was accepted by the manual
   * adapter is accepted here too — the IFSC pattern and the account-number
   * shape floor are the shared ones in provider.ts, not a second copy that
   * drifts. A validation added on one side only is how an account that was fine
   * for eighteen months starts failing on the day the provider changes.
   *
   * NOTE WHAT DOES NOT HAPPEN even in this refusing version: the account number
   * is used to derive four digits and is then out of scope. It is not held, not
   * returned, not interpolated into the refusal, and not logged. The refusal
   * below is thrown AFTER the derivation precisely so that the shape of the
   * final implementation — validate, derive, call, return only the safe subset
   * — is already the shape of the code.
   */
  async createPayoutAccount(input: PayoutAccountInput): Promise<PayoutAccountRef> {
    assertIdempotencyKey(ID, input?.idempotencyKey);
    if (!String(input?.holderName ?? '').trim()) {
      throw new PayoutProviderError(
        ID, 'holder_name_required',
        'The account holder\'s name is required. It is what the bank matches the transfer ' +
        'against, and a mismatch is the most common reason a payout is returned.',
      );
    }
    ifscPrefixOf(ID, input?.ifsc);
    last4Of(ID, input?.accountNumber);

    // Item 2 on the checklist: which resource holds the bank details, which
    // holds the person, and which must be created first.
    refuse('Registering a payout account with RazorpayX');
  },

  async verifyPayoutAccount(): Promise<PayoutAccountVerification> {
    // A penny-drop validation is a REAL TRANSFER of a small amount. Making one
    // through an unverified adapter is exactly the thing this file exists to
    // prevent, in miniature — and a penny-drop to a wrong account still tells
    // somebody a name they should not have.
    refuse('Verifying a payout account with RazorpayX');
  },

  /**
   * VALIDATES, THEN REFUSES — and would send the idempotency key as a header.
   *
   * See `SendPayoutInput.idempotencyKey` in provider.ts for the full argument.
   * The short form: the local unique index stops a second ROW, and the
   * provider's key stops a second TRANSFER when the first request timed out
   * after the provider had already accepted it. The row and the transfer are
   * different events and they fail apart, so both guards are needed and neither
   * substitutes for the other.
   *
   * THE CASE TO CONFIRM MOST CAREFULLY (checklist item 3) is what the provider
   * does when the same key arrives with a DIFFERENT amount. Two behaviours are
   * defensible from the provider's side and they are opposite from ours: return
   * the original payout (safe — our retry is honoured, the amount we now think
   * we sent is wrong but no extra money moved), or reject (also safe, once we
   * handle it). What must not happen is a silent second transfer. Until it is
   * known which, this refuses.
   *
   * The amount is validated as integer minor units before anything else, so
   * that a rupee figure that reached this point is caught here rather than
   * being sent hundredfold wrong to a provider that quotes paise.
   */
  async sendPayout(input: SendPayoutInput): Promise<SendPayoutResult> {
    assertIdempotencyKey(ID, input?.idempotencyKey);
    assertAmountMinor(ID, input?.amountMinor);
    assertCurrency(ID, input?.currency);

    if (!input?.providerAccountId) {
      throw new PayoutProviderError(
        ID, 'provider_account_required',
        'RazorpayX sends money to an account it holds, named by its own identifier. This ' +
        'payout has none, so the seller\'s account has not been registered with the provider ' +
        'and there is nowhere to send it.',
      );
    }

    refuse('Sending a payout through RazorpayX');
  },

  async fetchPayoutStatus(providerPayoutId: string): Promise<PayoutStatusResult> {
    if (!providerPayoutId) {
      throw new PayoutProviderError(ID, 'provider_payout_id_required', 'A provider payout id is required.');
    }
    // Reading a status moves no money, so this is the one money-path method
    // that could arguably ship. It does not, for a reason worth stating: a
    // status read is only useful if its VOCABULARY is understood, and item 7
    // says it is not. A read that returns a status this file cannot map is a
    // call that succeeded and told the caller nothing, which invites exactly
    // the defaulting that `mapPayoutStatus()` refuses to do.
    refuse('Reading a payout status from RazorpayX');
  },

  /**
   * REAL, AND FAILS CLOSED. See the long note above `safeEqualHex`.
   *
   * The signature is computed over the RAW BODY. Re-serialising parsed JSON
   * changes the bytes — key order, whitespace, number formatting — and the
   * signature will not match, so the caller must hand this the exact text it
   * received and not `JSON.stringify(await request.json())`.
   *
   * A `valid: true` here proves only that whoever sent the body holds the
   * webhook secret. It is not on its own an instruction to mark a payout paid:
   * the event name and the payload shape are unconfirmed (item 8), so `payout`
   * is populated only when a recognisable entity is present, and is left
   * undefined rather than half-filled otherwise. `raw` carries the whole body
   * so a caller can queue it for a person to look at.
   */
  verifyWebhook(rawBody: string, headers: Record<string, string>): PayoutWebhookResult {
    const secret = webhookSecret();
    const signature = header(headers, RAZORPAYX_SIGNATURE_HEADER);

    const invalid = (): PayoutWebhookResult => ({ valid: false, eventId: '', eventType: '', raw: null });

    if (!secret || !signature || !rawBody) return invalid();
    if (!safeEqualHex(hmacHex(rawBody, secret), signature)) return invalid();

    let body: any;
    try { body = JSON.parse(rawBody); } catch { return invalid(); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();

    return {
      valid: true,
      // Collision-free per event and stable across retries even under a payload
      // shape this file does not recognise. See webhookEventId().
      eventId: webhookEventId(headers, body, rawBody),
      eventType: String(body.event ?? 'unknown'),
      // NEVER POPULATED TODAY. `mapPayoutStatus()` maps nothing, and a payout
      // summary carrying a status this file invented is precisely the
      // fabrication the whole adapter refuses. The body is handed over whole
      // instead, for a person to read.
      payout: undefined,
      raw: body,
    };
  },
};
