// Manual UPI — the honest bridge until a merchant gateway is live.
//
// The federation currently takes payment by UPI deep link. That is not going to
// stop on the day this code ships, so the flow is modelled properly instead of
// being pretended away:
//
//   · a real order is created, with a real order number;
//   · the customer pays by UPI, with the order number in the transaction note;
//   · the customer submits the UPI reference (UTR) they received;
//   · the order stays AWAITING PAYMENT until an officer confirms the money
//     arrived in the federation's account and records the UTR.
//
// The customer is never told they have paid because they said so. That is the
// difference between this and the WhatsApp arrangement it replaces: there is an
// order, a reference, an audited confirmation step, and a receipt at the end.
//
// This provider deliberately implements no signature verification, because there
// is no cryptographic proof to verify — a human confirms against the bank
// statement. Every method that would imply automatic confirmation refuses.

import {
  PaymentProviderError,
  type CreateOrderInput, type CreateOrderResult, type PaymentProvider,
  type RefundResult, type VerifiedPayment, type WebhookResult,
} from './provider';

function upiId(): string {
  return process.env.MMAKF_UPI_ID || '';
}

/** The UPI intent link. Amount is in rupees with two decimals, as UPI requires. */
export function upiDeepLink(input: { amountPaise: number; reference: string; payeeName?: string }): string {
  const rupees = (input.amountPaise / 100).toFixed(2);
  const params = new URLSearchParams({
    pa: upiId(),
    pn: input.payeeName || 'MMAKF',
    am: rupees,
    cu: 'INR',
    // The order number in the note is what makes a bank statement line
    // reconcilable against an order at all.
    tn: `MMAKF ${input.reference}`,
  });
  return `upi://pay?${params.toString()}`;
}

export const manualUpi: PaymentProvider = {
  id: 'manual_upi',
  label: 'UPI (confirmed by the federation office)',

  isConfigured() {
    return Boolean(upiId());
  },

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    if (!upiId()) {
      throw new PaymentProviderError('manual_upi', 'Not configured: MMAKF_UPI_ID is unset');
    }
    if (!Number.isInteger(input.amountPaise) || input.amountPaise <= 0) {
      throw new PaymentProviderError('manual_upi', 'Amount must be a positive integer in paise');
    }
    return {
      // No provider order exists; our own reference stands in for one.
      providerOrderId: input.reference,
      checkout: {
        mode: 'manual_upi',
        upiId: upiId(),
        amountPaise: input.amountPaise,
        reference: input.reference,
        deepLink: upiDeepLink({ amountPaise: input.amountPaise, reference: input.reference }),
        // Rendered verbatim so nobody is left believing payment is instant.
        instruction:
          'Pay using any UPI app, keeping the reference in the payment note. ' +
          'Then enter the UPI reference number (UTR) shown by your app. The federation ' +
          'office confirms receipt against its bank statement, usually within one working ' +
          'day, and your receipt is issued at that point.',
      },
    };
  },

  // There is no signature: a claim of payment is not proof of payment.
  verifyCheckout(): boolean {
    return false;
  },

  verifyWebhook(): WebhookResult {
    return { valid: false, eventId: '', eventType: '', raw: null };
  },

  async fetchPayment(): Promise<VerifiedPayment> {
    throw new PaymentProviderError(
      'manual_upi',
      'Manual UPI payments have no queryable state — an officer confirms them against the bank statement'
    );
  },

  async refund(): Promise<RefundResult> {
    throw new PaymentProviderError(
      'manual_upi',
      'Manual UPI refunds are made by bank transfer and recorded by the finance officer, not issued through an API'
    );
  },
};
