// Payout provider abstraction — money leaving the federation for a seller.
//
// Deliberately the mirror image of src/lib/payments/provider.ts, and for the
// same reason: a federation should not be locked to one supplier, and
// `seller_payouts.provider` / `payout_accounts.provider` are plain strings so
// that switching is a configuration change rather than a rewrite.
//
// It is NOT the same interface, and merging the two would be a mistake worth
// naming. Taking money and sending money fail in opposite directions:
//
//   · a payment that fails leaves the payer's money where it was;
//   · a payout that fails twice leaves the federation's money in somebody
//     else's account, and there is no status transition that brings it back.
//     A reversal is a request to a bank, not a write.
//
// So everything below is arranged around the second fact.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT THIS INTERFACE REFUSES TO LET AN ADAPTER DO
// ═════════════════════════════════════════════════════════════════════════════
//
// 1. IT CANNOT HAND BACK A BANK ACCOUNT NUMBER.
//
//    `createPayoutAccount()` takes the account number and returns
//    `PayoutAccountRef`, whose fields are exactly the columns `payout_accounts`
//    has: providerAccountId, providerContactId, holderName, bankName, last4,
//    ifscPrefix, status. There is no field on the return type that could carry
//    the number, so an adapter cannot leak it by accident, a caller cannot
//    persist it by accident, and a future "just add the number to the result so
//    the admin screen can show it" is a change to THIS file that somebody has
//    to argue for — not a one-line edit inside an adapter nobody reviews.
//
//    See src/db/seller.schema.ts: `payout_accounts` has no account-number
//    column, and that is not an oversight awaiting a migration. The provider
//    holds the account; MMAKF holds a handle to it plus four digits that let a
//    human recognise it. Four digits identify. They do not enable.
//
//    The type is the enforcement. The prose is why the type is shaped that way.
//
// 2. IT CANNOT SEND MONEY WITHOUT AN IDEMPOTENCY KEY.
//
//    `SendPayoutInput.idempotencyKey` is required, and every adapter refuses an
//    empty one. See the long note on `sendPayout` below for why the key must
//    reach the PROVIDER and not merely the local unique index.
//
// 3. IT CANNOT BE SELECTED BECAUSE ITS CREDENTIALS EXIST.
//
//    `isConfigured()` means USABLE END TO END. `hasCredentials()` is the
//    narrower question, and index.ts never substitutes one for the other. An
//    adapter that could send a transfer and never confirm it must answer false
//    to the first and true to the second — that state is a configuration
//    problem an operator can fix, and telling them "no keys" when the keys are
//    fine sends them to the wrong screen.
//
// ═════════════════════════════════════════════════════════════════════════════
// WHAT AN ADAPTER IS NOT ALLOWED TO DECIDE
// ═════════════════════════════════════════════════════════════════════════════
//
// That a payout has been PAID. Only a bank reference — a UTR from a statement,
// or a provider status read back from the provider's own API — settles that.
// An adapter returning `status: 'paid'` from the response to its own send
// request is asserting the outcome of a transfer that has, at that moment, only
// been ACCEPTED. `sendPayout` therefore returns 'queued' or 'processing' in the
// ordinary case, and the confirmation arrives later through
// `fetchPayoutStatus()` or a verified webhook.

/**
 * The seven states `seller_payouts.status` can hold, named here so an adapter
 * can be written against the interface without importing the schema.
 *
 * Kept byte-identical to the `seller_payout_status` enum in
 * src/db/marketplace-finance.schema.ts. A caller writes an adapter's status
 * straight into the column, so a value this type permits and the enum does not
 * would be a constraint violation in the middle of a transfer — discovered at
 * the worst possible moment, with money already in flight.
 */
export type PayoutStatus =
  | 'pending' | 'queued' | 'processing' | 'paid' | 'failed' | 'reversed' | 'cancelled';

/** The five states `payout_accounts.status` can hold. Same reasoning. */
export type PayoutAccountStatus =
  | 'pending' | 'verifying' | 'verified' | 'failed' | 'disabled';

// ─── Accounts ───────────────────────────────────────────────────────────────

/**
 * What a seller supplies when they tell the federation where to send money.
 *
 * `accountNumber` IS A SECRET AND IS THE ONLY SECRET HERE. It exists on the
 * input type because an account cannot be registered with a provider without
 * it, and it exists nowhere else in this subsystem:
 *
 *   · it is not on `PayoutAccountRef`, the return type;
 *   · it is not on any error this module throws — the adapters scrub;
 *   · it is not written to a log, because these adapters write to no log at
 *     all (audited, same rule as src/lib/payments/razorpay.ts);
 *   · it has no column in `payout_accounts` to be written to.
 *
 * So the value's entire lifetime is the body of one adapter call. That is the
 * design, and the reason it is stated at this length is that the obvious
 * "improvement" — keeping the number so a support agent can read it back to a
 * seller who has forgotten it — turns a table nobody guards especially hard
 * into a list of bank accounts, and turns every ordinary admin into somebody
 * who can read one.
 */
export interface PayoutAccountInput {
  holderName: string;
  /** SECRET. Never returned, never logged, never stored. See above. */
  accountNumber: string;
  /** RBI format: four letters, a zero, six alphanumerics. */
  ifsc: string;
  bankName?: string | null;
  /** Contact details the provider may require to open a beneficiary record. */
  email?: string | null;
  phone?: string | null;
  /**
   * OUR seller reference, sent so the provider's dashboard is searchable by it.
   * Never a raw database id — a dashboard row that says `47` is a row nobody
   * can tie back to a seller six months later.
   */
  sellerRef: string;
  /** Registering the same account twice must not create two beneficiaries. */
  idempotencyKey: string;
}

/**
 * Everything MMAKF may keep about where a seller's money goes.
 *
 * Field for field, the safe columns of `payout_accounts`. If you find yourself
 * wanting to add one, check first whether it is a credential: the test is
 * whether the value alone would let a stranger send money somewhere, or would
 * help them prove an account exists.
 */
export interface PayoutAccountRef {
  /** The PROVIDER's handle. Useless without the provider's own credentials. */
  providerAccountId: string | null;
  /** The provider's beneficiary/contact record, where it keeps one separately. */
  providerContactId: string | null;
  holderName: string | null;
  bankName: string | null;
  /** Four digits. Enough to recognise, not enough to use. */
  last4: string | null;
  /** The bank code from the IFSC. Not a credential; identifies the bank. */
  ifscPrefix: string | null;
  status: PayoutAccountStatus;
  failureReason?: string | null;
  /**
   * What a human must do next, when the provider cannot settle it alone.
   * Rendered verbatim on an admin screen, so it is written for that reader.
   */
  note?: string | null;
}

export interface PayoutAccountVerification {
  status: PayoutAccountStatus;
  /**
   * True only when the PROVIDER confirmed the account. False means a person
   * has to, and a surface that showed a green tick for the second case would
   * be claiming a check nobody performed.
   */
  automatic: boolean;
  note: string | null;
  failureReason?: string | null;
}

// ─── Transfers ──────────────────────────────────────────────────────────────

export interface SendPayoutInput {
  /**
   * THE DOUBLE-PAYMENT GUARD, and it has to work in two places at once.
   *
   * `seller_payouts.idempotency_key` is UNIQUE, so a retried instruction cannot
   * create a second ROW. That is necessary and it is not sufficient, because
   * the row and the transfer are not the same event and they fail apart:
   *
   *   t0  we POST the transfer to the provider
   *   t1  the provider accepts it and begins the NEFT
   *   t2  the response never reaches us — a timeout, a cold start, a dropped
   *       connection, a lambda killed mid-flight
   *   t3  the operator, seeing a payout still sitting at `pending`, retries
   *
   * At t3 the local unique index has nothing to say: there is one row, and the
   * retry is an UPDATE of it, not a second INSERT. Without a key the provider
   * recognises, the second POST is a second transfer, and the seller is paid
   * twice out of MMAKF's account. Recovering that is a phone call, a favour and
   * a solvent counterparty — it is not a status change.
   *
   * So the key goes to the provider as well, and the provider's own
   * de-duplication returns the FIRST payout instead of creating another.
   *
   *   local unique index  →  stops a second ROW
   *   provider key        →  stops a second TRANSFER
   *
   * Neither substitutes for the other. `createPayout()` in
   * src/db/marketplace-finance.ts derives the key deterministically as
   * `settlement:<id>`, so the same settlement always produces the same key
   * however many times anybody presses the button.
   */
  idempotencyKey: string;
  /** Integer minor units (paise). Never a float, never rupees. */
  amountMinor: number;
  /** ISO 4217, three letters. */
  currency: string;
  /**
   * The provider's handle for the destination account. Null where the provider
   * holds no account — the manual adapter — which is why it is nullable rather
   * than an empty string standing in for one.
   */
  providerAccountId: string | null;
  /** Our payout reference (MMAKF-PAY-…), for the provider's dashboard. */
  ref?: string | null;
  /** What appears on the seller's bank statement, where the provider allows it. */
  narration?: string | null;
}

export interface SendPayoutResult {
  /**
   * The provider's identifier for the transfer, or null where there is none.
   *
   * Null is a legitimate answer and not an error: a bank transfer typed into a
   * banking portal by the federation's finance officer has no provider id,
   * because there is no provider. Returning an invented one — a hash, our own
   * reference with a prefix — would put a value into `provider_payout_id` that
   * looks like a handle and resolves to nothing, and the first person to paste
   * it into a support ticket would be told it does not exist.
   */
  providerPayoutId: string | null;
  /**
   * NEVER 'paid' straight from a send. See the note at the head of this file:
   * an accepted instruction is not a completed transfer, and an adapter that
   * conflated them would let a settlement be closed against money still in the
   * clearing system.
   */
  status: PayoutStatus;
  /** Present only when the provider has already reported a bank reference. */
  utr?: string | null;
  failureReason?: string | null;
  /**
   * True when a HUMAN must now make the transfer. The surface must say so —
   * a queue that looks automatic and is not is a queue nobody works.
   */
  manual?: boolean;
  /** Verbatim instructions for that human. Null when there is nothing to do. */
  instruction?: string | null;
}

export interface PayoutStatusResult {
  providerPayoutId: string;
  status: PayoutStatus;
  /** Integer minor units as the PROVIDER reports them, or NaN if unreadable. */
  amountMinor: number;
  currency: string;
  /** The bank reference, once the transfer has landed. */
  utr?: string | null;
  failureReason?: string | null;
}

export interface PayoutWebhookResult {
  /** False means the signature did not verify — treat the body as hostile. */
  valid: boolean;
  eventId: string;
  eventType: string;
  /** Present only when the payload shape was RECOGNISED, never guessed at. */
  payout?: PayoutStatusResult;
  raw: unknown;
}

/** What the manual adapter accepts when an officer records a completed transfer. */
export interface ManualConfirmation {
  /** The bank reference from the statement. */
  utr: string;
  /** Free text, e.g. which account it went out of. Never a credential. */
  note?: string | null;
}

export interface ManualConfirmationResult {
  /** Trimmed and upper-cased, so two spellings of one reference match. */
  utr: string;
  status: PayoutStatus;
  note: string | null;
}

// ─── The interface ──────────────────────────────────────────────────────────

export interface PayoutProvider {
  readonly id: string;
  readonly label: string;

  /**
   * True when this provider completes a transfer without a person.
   *
   * Not cosmetic. A surface that implies an automatic payout when a human has
   * to go and make it is how a seller ends up waiting a fortnight for money
   * that a screen said was on its way, and `payoutStatusReport()` in index.ts
   * carries this value out to those surfaces for exactly that reason.
   */
  readonly automatic: boolean;

  /**
   * True when this provider may SEND MONEY end to end.
   *
   * Stricter than "the credentials are present", on purpose and more strictly
   * here than on the payments side. On the payments side the failure is a
   * payment that cannot be confirmed. Here the failure is a transfer that
   * leaves and cannot be traced, so an adapter whose behaviour has not been
   * confirmed against the provider's own documentation answers FALSE even with
   * perfect credentials. See src/lib/payouts/razorpayx.ts.
   */
  isConfigured(): boolean;

  /**
   * True when the credentials themselves are present, whatever else is wrong.
   *
   * Optional, exactly as on PaymentProvider: for a provider with nothing
   * further to satisfy the two answers are the same one, and index.ts falls
   * back to isConfigured() and says so.
   */
  hasCredentials?(): boolean;

  /**
   * Why this provider cannot be used, in one operator-facing sentence, when
   * isConfigured() is false. Null when there is nothing to add. Never a secret.
   */
  readinessNote?(): string | null;

  /**
   * Register a seller's bank account with the provider.
   *
   * Takes the account number. Returns a reference that CANNOT carry it.
   */
  createPayoutAccount(input: PayoutAccountInput): Promise<PayoutAccountRef>;

  /** Ask the provider whether the account is usable. Never returns the number. */
  verifyPayoutAccount(providerAccountId: string | null): Promise<PayoutAccountVerification>;

  /** Send money. The idempotency key goes to the provider — see SendPayoutInput. */
  sendPayout(input: SendPayoutInput): Promise<SendPayoutResult>;

  /** Authoritative state, read from the provider rather than assumed from a send. */
  fetchPayoutStatus(providerPayoutId: string): Promise<PayoutStatusResult>;

  /** Verify and parse a webhook. Must never trust an unverified body. */
  verifyWebhook(rawBody: string, headers: Record<string, string>): PayoutWebhookResult;

  /**
   * Record a transfer a PERSON made, with the bank reference they read off the
   * statement.
   *
   * Optional, and present on the manual adapter alone. It is not a fallback an
   * automatic provider may borrow: typing a UTR against a RazorpayX payout
   * asserts an outcome the provider has not reported, and the provider is the
   * one holding the answer. Where an automatic transfer has genuinely been
   * made outside the system, that is an adjustment with a reason
   * (`adjustPayable`), not a confirmation.
   */
  confirmManual?(confirmation: ManualConfirmation): ManualConfirmationResult;
}

/** Thrown for provider faults, so callers can distinguish them from bugs. */
export class PayoutProviderError extends Error {
  readonly provider: string;
  readonly code: string;
  readonly detail: unknown;

  constructor(provider: string, code: string, message: string, detail?: unknown) {
    super(`[${provider}] ${message}`);
    this.name = 'PayoutProviderError';
    this.provider = provider;
    this.code = code;
    this.detail = detail;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// SHARED VALIDATION
// ═════════════════════════════════════════════════════════════════════════════
//
// Every adapter runs these before it does anything else, so a malformed call is
// refused identically whichever provider is active. A validation that lives in
// one adapter and not another is how a value that RazorpayX rejects gets typed
// into a bank portal by hand instead.

/**
 * The RBI's IFSC format: four letters naming the bank, a literal zero reserved
 * for future use, then six alphanumerics naming the branch.
 *
 * This is a published format, not a federation decision — checking it invents
 * nothing. It is worth checking because a malformed IFSC does not fail at the
 * point somebody typed it; it fails at the bank, after the payout has been
 * instructed, and the money sits in limbo while a person works out why.
 */
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/**
 * MMAKF has published no rule about the FORM of a bank reference, and this
 * module does not invent one.
 *
 * A UTR is 12 characters for NEFT/RTGS and 12 for IMPS in the common case, but
 * banks emit references in other shapes — an RRN, a transaction id from a
 * corporate portal, a reference with a bank-specific prefix — and a regex
 * tuned to one of them REJECTS A GENUINE REFERENCE from another. That failure
 * lands on the finance officer holding a statement that plainly says otherwise,
 * and its only remedy is to record the payout with no reference at all, which
 * is worse than recording an odd-looking one.
 *
 * So `normaliseUtr()` below enforces a SHAPE FLOOR — non-empty, no whitespace,
 * no control characters, bounded length — and nothing about a scheme.
 */
export const UTR_FORMAT_NOT_SET =
  'MMAKF has not published a required format for a payout bank reference (UTR). ' +
  'Only a shape floor is enforced — non-empty, no spaces, at most 64 characters — ' +
  'because a pattern tuned to NEFT would reject a genuine IMPS or corporate-portal ' +
  'reference and leave the officer no way to record what the statement says.';

/**
 * Whether a payout may be marked paid with NO bank reference is undecided.
 *
 * `markPayoutPaid()` accepts a null UTR today, and this module does not change
 * that by the back door: refusing here would be this file making a federation
 * decision about the federation's own bookkeeping. What it does instead is
 * refuse a reference that is not one — a UTR of `"  "` recorded as a bank
 * reference is worse than an absent one, because it reads as evidence.
 */
export const UTR_REQUIRED_NOT_SET =
  'MMAKF has not decided whether a bank reference is mandatory before a payout ' +
  'may be marked paid. A payout with no reference cannot be tied to a line on a ' +
  'bank statement, but requiring one is a bookkeeping rule the federation makes, ' +
  'not this module. A reference that is supplied is shape-checked either way.';

/** Integer minor units, positive, and small enough to stay exact. */
export function assertAmountMinor(provider: string, amountMinor: unknown): number {
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor)) {
    throw new PayoutProviderError(
      provider, 'bad_amount',
      'A payout amount must be an integer number of paise. A float here is a rupee figure ' +
      'that has been converted somewhere it should not have been — see money rule 3.',
    );
  }
  if (amountMinor <= 0) {
    throw new PayoutProviderError(
      provider, 'bad_amount',
      `A payout must be for a positive amount; ${amountMinor} was requested. A zero or ` +
      'negative transfer is an adjustment with a reason, not a payout.',
    );
  }
  return amountMinor;
}

export function assertCurrency(provider: string, currency: unknown): string {
  const c = String(currency ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) {
    throw new PayoutProviderError(
      provider, 'bad_currency',
      `A payout currency must be a three-letter ISO 4217 code; received ${JSON.stringify(currency)}.`,
    );
  }
  return c;
}

export function assertIdempotencyKey(provider: string, key: unknown): string {
  const k = String(key ?? '').trim();
  if (!k) {
    throw new PayoutProviderError(
      provider, 'idempotency_key_required',
      'A payout needs an idempotency key. Without one, a request that timed out after the ' +
      'provider accepted it cannot be retried safely — the retry is a second transfer.',
    );
  }
  // Bounded because it travels in an HTTP header. A key long enough to be
  // truncated by an intermediary is a key that stops matching, which quietly
  // turns the guard off at exactly the moment it is needed.
  if (k.length > 200) {
    throw new PayoutProviderError(
      provider, 'idempotency_key_too_long',
      'A payout idempotency key must be at most 200 characters — it is sent as an HTTP ' +
      'header, and a truncated key silently stops de-duplicating.',
    );
  }
  return k;
}

/**
 * The last four digits of an account number, and nothing else.
 *
 * DIGITS ONLY, so a number written with spaces or hyphens yields the same four
 * as the same number written plainly — otherwise the recognition aid a human
 * relies on differs depending on how the seller typed it.
 */
export function last4Of(provider: string, accountNumber: unknown): string {
  const digits = String(accountNumber ?? '').replace(/\D/g, '');
  // A shape floor, not a bank scheme: Indian account numbers run from about
  // nine to eighteen digits, and this refuses only what cannot be one at all.
  // Refusing more than that would turn a valid account at an unusual bank into
  // a seller who cannot be paid.
  if (digits.length < 6 || digits.length > 25) {
    throw new PayoutProviderError(
      provider, 'bad_account_number',
      'That does not look like a bank account number — it must contain between 6 and 25 ' +
      'digits. Check it against the seller\'s cancelled cheque or bank statement.',
    );
  }
  return digits.slice(-4);
}

/**
 * The bank code from an IFSC.
 *
 * Four characters names the BANK, not the branch: the branch is the last six,
 * and it is not kept. So this column catches "paid into an SBI account when the
 * seller banks with HDFC" and does not catch a wrong branch of the right bank.
 * Whether MMAKF wants the whole IFSC stored — it is public information and
 * identifies a branch, not an account — is a decision about what the federation
 * retains, and the column it would go in is named `ifsc_prefix`, so a prefix is
 * what goes in it.
 */
export function ifscPrefixOf(provider: string, ifsc: unknown): string {
  const value = String(ifsc ?? '').trim().toUpperCase();
  if (!IFSC_PATTERN.test(value)) {
    throw new PayoutProviderError(
      provider, 'bad_ifsc',
      'That is not a valid IFSC. An IFSC is eleven characters: four letters for the bank, ' +
      'a zero, then six characters for the branch — for example HDFC0001234.',
    );
  }
  return value.slice(0, 4);
}

/**
 * A bank reference, trimmed and upper-cased, or a refusal.
 *
 * See UTR_FORMAT_NOT_SET for why this is a shape floor rather than a pattern.
 * Upper-casing is not cosmetic: the same reference read off a statement in one
 * case and typed in another must not become two references, because reconciling
 * a payout against a statement is a string comparison somebody does by eye.
 */
export function normaliseUtr(provider: string, utr: unknown): string {
  const raw = String(utr ?? '').trim();
  if (!raw) {
    throw new PayoutProviderError(
      provider, 'utr_required',
      'A bank reference is required to record a transfer as made. Copy the UTR or reference ' +
      'number from the bank statement line for this payment.',
    );
  }
  // Whitespace and control characters mean a paste picked up a line break or a
  // column separator. Silently stripping them would record a reference that is
  // not the one on the statement, which is the failure this check exists for.
  // A hyphen is NOT refused: some corporate portals emit a reference containing
  // one, and refusing it would be exactly the scheme-specific rule that
  // UTR_FORMAT_NOT_SET says this module must not make.
  const control = (ch: string) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f;
  if (/\s/.test(raw) || Array.from(raw).some(control)) {
    throw new PayoutProviderError(
      provider, 'bad_utr',
      'A bank reference cannot contain spaces or line breaks. Copy just the reference itself ' +
      'from the statement, without the surrounding columns.',
    );
  }
  if (raw.length > 64) {
    throw new PayoutProviderError(
      provider, 'bad_utr',
      'A bank reference is at most 64 characters. What was supplied is longer, so it is ' +
      'probably a whole statement line rather than the reference from it.',
    );
  }
  return raw.toUpperCase();
}
