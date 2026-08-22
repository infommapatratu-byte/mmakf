// Manual bank transfer — what MMAKF actually does today, modelled properly.
//
// The federation's finance officer opens the federation's own bank portal,
// makes a NEFT or IMPS transfer to a seller, and copies the reference back onto
// the payout at /admin/marketplace/settlements. That is not a stopgap to be
// pretended away until a provider is live; it is the process, it is audited,
// and it works. What this adapter does is give it the SAME SHAPE as an
// automated provider, so that:
//
//   · the settlements page calls one interface and does not branch on which
//     provider is live;
//   · switching to RazorpayX later changes a configuration value and not a
//     page;
//   · and — the part that earns its keep today — a bank reference typed by a
//     human is validated before it is recorded as evidence, instead of any
//     string at all landing in `seller_payouts.utr`.
//
// It is the exact counterpart of src/lib/payments/manual-upi.ts on the paying-in
// side, and it refuses in the same places for the same reason: every method
// that would IMPLY an automatic outcome says plainly that there is not one.
//
// ═════════════════════════════════════════════════════════════════════════════
// THE THING THIS ADAPTER CANNOT DO, STATED SO NOBODY BUILDS ON IT
// ═════════════════════════════════════════════════════════════════════════════
//
// IT CANNOT STOP A SECOND TRANSFER.
//
// `seller_payouts.idempotency_key` is UNIQUE, so a retried instruction cannot
// create a second ROW — that guard holds whichever provider is active. The
// second guard, the one that stops a second TRANSFER when the first request
// timed out after the provider accepted it, is the provider's own
// de-duplication, and a bank portal driven by a person has none. If the officer
// pays the same payout twice, two transfers leave.
//
// This adapter therefore does the only thing it honestly can: it hands the
// officer the idempotency key and OUR payout reference in the instruction text,
// tells them to put the reference in the transfer narration, and says in as
// many words that a duplicate is caught by them and by nobody else. A surface
// that quietly implied the system was guarding against it would be worse than
// silence, because the officer would stop checking.
//
// That gap is the strongest argument for a real payout provider, and it is
// written here rather than in a ticket so that whoever evaluates one can read
// what they are buying.
//
// ═════════════════════════════════════════════════════════════════════════════
// AND THE ACCOUNT NUMBER
// ═════════════════════════════════════════════════════════════════════════════
//
// With no provider there is nowhere to lodge the seller's account, so the
// obvious reading of "the provider holds the account" is that MMAKF must hold
// it instead. It does not, and this is the one place that decision could quietly
// be reversed, so:
//
//   · `createPayoutAccount()` takes the number, derives `last4` and the IFSC
//     bank code, and DROPS IT. The return type has no field it could survive in
//     (see PayoutAccountRef in provider.ts) and `payout_accounts` has no column
//     for it.
//   · `providerAccountId` is returned as NULL, not as an invented handle. There
//     is no provider, so there is no provider account id. Hashing the account
//     number to manufacture a stable identifier was considered and rejected:
//     an Indian account number is a low-entropy value, so a bare hash of one is
//     recoverable by brute force in seconds and would be the account number
//     with extra steps and a false sense of safety.
//   · The account details the officer needs in order to type the transfer live
//     in the federation's own bank beneficiary list, entered once and verified
//     there. That is a system with its own access control, its own audit and
//     its own two-person approval — all of which this database does not have
//     for that class of secret.
//
// The consequence is a real one and is not hidden: a seller's account can only
// be paid after somebody has added it as a beneficiary at the bank. That is a
// process step, it is stated in the instruction text below, and it is the cost
// of not keeping a list of bank accounts in a web application's database.

import {
  PayoutProviderError,
  assertAmountMinor, assertCurrency, assertIdempotencyKey,
  ifscPrefixOf, last4Of, normaliseUtr,
  type ManualConfirmation, type ManualConfirmationResult,
  type PayoutAccountInput, type PayoutAccountRef, type PayoutAccountVerification,
  type PayoutProvider, type PayoutStatusResult, type PayoutWebhookResult,
  type SendPayoutInput, type SendPayoutResult,
} from './provider';

const ID = 'manual';

/**
 * MMAKF has published no rule about WHO in the office may make a transfer, or
 * whether a second person must approve it before it leaves.
 *
 * `createPayout()` records `initiatedByUserId` and `markPayoutPaid()` records
 * the confirming officer, so whatever the federation decides is already
 * evidenced. What is not decided is whether those two must be different people
 * — the same separation `closeSettlement` and `approveSettlement` already make
 * available without imposing. Nothing here enforces a rule the federation has
 * not made, and nothing here quietly permits one either: the two names are
 * simply both on the record.
 */
export const PAYOUT_APPROVAL_SEPARATION_NOT_SET =
  'MMAKF has not decided whether the officer who instructs a payout may also be ' +
  'the officer who records it as paid. Both names are recorded on every payout, ' +
  'so either rule can be evidenced after the fact, but neither is enforced here.';

/**
 * Nor has it decided which rail a manual transfer goes over.
 *
 * NEFT settles in batches, IMPS is immediate and capped, RTGS has a floor. Each
 * costs differently and each fails differently, and a payout that a seller was
 * told would arrive "immediately" because a screen assumed IMPS is a complaint
 * the federation cannot answer. The officer chooses at the bank; this module
 * does not put a rail on the record because it does not know one.
 */
export const PAYOUT_RAIL_NOT_SET =
  'MMAKF has not published which payment rail a seller payout uses (NEFT, IMPS or ' +
  'RTGS). The officer chooses at the bank, so no expected arrival time is stated ' +
  'to the seller — an invented one becomes a promise the federation did not make.';

/**
 * The instruction handed to whoever has to make the transfer.
 *
 * Written for that person, present tense, in the order they will do it, and
 * carrying the two values that make the payment reconcilable afterwards: our
 * payout reference (which goes in the narration and comes back on the bank
 * statement) and the amount as an integer of paise.
 *
 * THE AMOUNT IS NOT FORMATTED INTO RUPEES HERE. Money is integer minor units
 * everywhere in this subsystem, and the one place a rupee figure is rendered is
 * the surface that displays it, using the shared helper. A second formatting
 * site is a second rounding rule.
 */
function instructionFor(input: SendPayoutInput, idempotencyKey: string): string {
  const reference = input.ref ? input.ref.trim() : idempotencyKey;
  return [
    'This payout is made by hand. Nothing has been sent.',
    '',
    'In the federation bank portal:',
    `  1. Select the seller's account from the saved beneficiary list. If it is not `,
    '     there, it has to be added and confirmed at the bank first — MMAKF does not',
    '     hold account numbers in this system, only the last four digits.',
    `  2. Transfer the amount shown against this payout, in full. Do not net anything`,
    '     off; a deduction is an adjustment with a reason, recorded separately.',
    `  3. Put "${reference}" in the transfer narration, so the statement line can be`,
    '     matched back to this payout without guesswork.',
    '  4. Copy the bank reference (UTR) from the statement onto this payout.',
    '',
    'Check first that this payout has not already been paid from the portal. Nothing',
    'in this system can prevent a second transfer once it has left the bank.',
  ].join('\n');
}

export const manualPayouts: PayoutProvider = {
  id: ID,
  label: 'Bank transfer, made and recorded by the federation office',

  /**
   * FALSE, and this is the single most important boolean in the module.
   *
   * A payout through this adapter needs a person at a bank portal. Every
   * surface that shows a payout queue reads this to decide whether to say
   * "sent" or "waiting for the finance officer", and a true here would produce
   * a screen telling a seller their money is on its way while it sits in a
   * queue nobody has been told to work.
   */
  automatic: false,

  /**
   * TRUE, always, and it is not a shortcut.
   *
   * The implementation of this provider is a person with access to the
   * federation's bank. There is no credential this deployment could be missing,
   * so there is no state in which it is unconfigured — and, unlike an automated
   * provider, there is no state in which it could send money and fail to
   * confirm it, because the confirmation and the transfer are the same human
   * act. That is precisely the test `isConfigured()` asks (see provider.ts),
   * and manual passes it.
   *
   * The practical consequence is that `activePayoutProvider()` always returns
   * something. The federation is never left with a payout queue and no way to
   * pay it, which is the same reason manual UPI is the fallback on the
   * paying-in side.
   */
  isConfigured() {
    return true;
  },

  /**
   * Record a seller's bank account.
   *
   * Validates, derives the two recognition fields, and drops the number. See
   * the file header for why there is no provider handle and no hash.
   */
  async createPayoutAccount(input: PayoutAccountInput): Promise<PayoutAccountRef> {
    assertIdempotencyKey(ID, input?.idempotencyKey);

    const holderName = String(input?.holderName ?? '').trim();
    if (!holderName) {
      throw new PayoutProviderError(
        ID, 'holder_name_required',
        'The account holder\'s name is required. It is what the bank matches the transfer ' +
        'against, and a mismatch is the most common reason a payout is returned.',
      );
    }

    // Order matters: validate the IFSC before touching the number, so a seller
    // who mistyped their branch code is told about the branch code and not
    // about their account number. Both throws are scrubbed of the number by
    // construction — neither message interpolates it.
    const ifscPrefix = ifscPrefixOf(ID, input?.ifsc);
    const last4 = last4Of(ID, input?.accountNumber);

    return {
      // No provider holds this account, so there is no handle to it. Null is
      // the honest value; `payout_accounts.provider_account_id` is nullable for
      // exactly this case.
      providerAccountId: null,
      providerContactId: null,
      holderName: holderName.slice(0, 200),
      bankName: input?.bankName ? String(input.bankName).trim().slice(0, 120) || null : null,
      last4,
      ifscPrefix,
      // NOT 'verified'. Nothing has been checked yet, and `createPayout()`
      // pays only to a verified account — so an adapter returning 'verified'
      // from a function that performed no verification would defeat the one
      // guard standing between a typo and a stranger's bank account.
      status: 'pending',
      note:
        'Recorded, not verified. Somebody at the federation must check these details ' +
        'against the seller\'s cancelled cheque or bank statement, add the account to the ' +
        'bank\'s beneficiary list, and only then mark it verified. No payout is made to an ' +
        'account nobody has checked.',
    };
  },

  /**
   * There is nothing to ask.
   *
   * A penny-drop check — sending one rupee and reading back the name the bank
   * returns — is what an automated provider does here, and it is a real
   * transfer that needs a provider to make. With no provider, verification is a
   * person comparing a cancelled cheque against a form.
   *
   * This RETURNS rather than throws, unlike `fetchPayoutStatus` below, because
   * "a human verifies this" is a complete and correct answer to the question.
   * `automatic: false` is what stops a surface rendering it as a check that
   * passed.
   */
  async verifyPayoutAccount(): Promise<PayoutAccountVerification> {
    return {
      status: 'pending',
      automatic: false,
      note:
        'This account cannot be verified automatically — no payout provider is configured, ' +
        'so there is nothing to ask. A federation officer verifies it against the seller\'s ' +
        'cancelled cheque or a bank statement showing the holder\'s name, and records that ' +
        'they did.',
    };
  },

  /**
   * Produce the instruction. MOVE NO MONEY.
   *
   * Everything is validated exactly as an automated provider would validate it
   * — amount, currency, idempotency key — so that the day MMAKF switches to
   * RazorpayX, a call that worked here does not start failing there on a
   * malformed argument that was never checked.
   *
   * The status returned is 'pending', not 'queued'. 'queued' means a provider
   * has the instruction and will act on it; nobody has this instruction yet
   * except a screen.
   */
  async sendPayout(input: SendPayoutInput): Promise<SendPayoutResult> {
    const idempotencyKey = assertIdempotencyKey(ID, input?.idempotencyKey);
    assertAmountMinor(ID, input?.amountMinor);
    assertCurrency(ID, input?.currency);

    // A providerAccountId here would mean an account lodged with a provider,
    // and there is no provider. Refusing rather than ignoring it: a caller
    // passing one has confused two adapters, and the confusion would otherwise
    // surface as a transfer to whatever that handle means somewhere else.
    if (input?.providerAccountId) {
      throw new PayoutProviderError(
        ID, 'unexpected_provider_account',
        'A provider account id was supplied for a manual bank transfer, but no payout ' +
        'provider holds this account. Either the wrong adapter is active or the account ' +
        'was registered against a provider that is no longer configured.',
      );
    }

    return {
      // Null, not a manufactured handle. See SendPayoutResult in provider.ts:
      // a value that looks like a provider reference and resolves to nothing is
      // worse than an empty column, because somebody will quote it at a bank.
      providerPayoutId: null,
      status: 'pending',
      manual: true,
      instruction: instructionFor(input, idempotencyKey),
    };
  },

  /**
   * REFUSES. There is no state to read.
   *
   * A transfer made from the federation's own account exists in the bank's
   * records and nowhere else this deployment can reach. Returning 'pending'
   * here — the tempting, quiet alternative — would let a reconciliation job
   * poll for ever and report a healthy "still processing" about a transfer that
   * completed a fortnight ago, or failed.
   *
   * The mirror of manualUpi.fetchPayment(), and refused for the same reason.
   */
  async fetchPayoutStatus(): Promise<PayoutStatusResult> {
    throw new PayoutProviderError(
      ID, 'no_queryable_state',
      'A bank transfer made from the federation\'s own account has no queryable state. ' +
      'The finance officer confirms it against the bank statement and records the UTR; ' +
      'there is no API to ask.',
    );
  },

  /**
   * INVALID, always. No signature exists because nobody signed anything.
   *
   * Returns the same closed shape as `manualUpi.verifyWebhook()` rather than
   * throwing, so a webhook route that iterates providers to find one that
   * recognises a body does not blow up on this one.
   */
  verifyWebhook(): PayoutWebhookResult {
    return { valid: false, eventId: '', eventType: '', raw: null };
  },

  /**
   * The act this whole adapter exists for: an officer records a transfer they
   * made, with the reference from the statement.
   *
   * The validation is deliberately a floor and not a scheme — see
   * UTR_FORMAT_NOT_SET in provider.ts. What it does catch is the failure that
   * actually happens: a paste that dragged in a line break or the neighbouring
   * column, or an empty box submitted by somebody tabbing through the form,
   * recorded as though it were evidence that money moved.
   *
   * Synchronous on purpose. It touches nothing outside this function, and an
   * async signature would invite somebody to make a call inside it.
   */
  confirmManual(confirmation: ManualConfirmation): ManualConfirmationResult {
    const utr = normaliseUtr(ID, confirmation?.utr);
    return {
      utr,
      // 'paid' is correct HERE and only here: unlike a provider's response to a
      // send request, this is a person reporting a completed transfer they have
      // read off a statement. That is the confirmation, not an acknowledgement
      // of an instruction.
      status: 'paid',
      note: confirmation?.note ? String(confirmation.note).trim().slice(0, 500) || null : null,
    };
  },
};
