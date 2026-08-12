// Payment provider abstraction (§17).
//
// Every gateway is reached through this interface, so switching provider — or
// running two at once — is a configuration change rather than a rewrite. A
// federation should not be locked to one supplier's pricing or terms, and the
// commerce tables deliberately store `provider` as a plain string for the same
// reason.
//
// What a provider is NOT allowed to do: decide that an order is paid. Only a
// verified `captured` signal, reconciled against the amount we asked for, marks
// an order paid. Returning from a payment page proves nothing — the customer
// controls that redirect.

export interface CreateOrderInput {
  /** Integer paise. Never a float. */
  amountPaise: number;
  currency: string;
  /** Our order number, sent so the provider's dashboard is searchable by it. */
  reference: string;
  customer?: { name?: string; email?: string; phone?: string };
  notes?: Record<string, string>;
  /** Retrying with the same key must never charge twice. */
  idempotencyKey: string;
}

export interface CreateOrderResult {
  providerOrderId: string;
  /** Everything the browser needs to open checkout. Never includes a secret. */
  checkout: Record<string, unknown>;
}

export interface VerifiedPayment {
  providerPaymentId: string;
  providerOrderId: string;
  amountPaise: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'failed' | 'refunded';
  method?: string;
  feePaise?: number;
  taxPaise?: number;
  failureReason?: string;
}

export interface WebhookResult {
  /** False means the signature did not verify — treat the body as hostile. */
  valid: boolean;
  eventId: string;
  eventType: string;
  payment?: VerifiedPayment;
  raw: unknown;
}

export interface RefundResult {
  providerRefundId: string;
  amountPaise: number;
  status: 'requested' | 'processing' | 'completed' | 'failed';
}

export interface PaymentProvider {
  readonly id: string;
  readonly label: string;

  /** True when this provider has the credentials it needs. */
  isConfigured(): boolean;

  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;

  /**
   * Verify the signed handshake the browser returns from checkout. Proves the
   * client did not fabricate a success, but is NOT on its own proof of capture:
   * the payment is still confirmed against the provider's API or webhook.
   */
  verifyCheckout(fields: Record<string, string>): boolean;

  /** Verify and parse a webhook. Must never trust an unverified body. */
  verifyWebhook(rawBody: string, headers: Record<string, string>): WebhookResult;

  /** Authoritative state, read from the provider rather than from the client. */
  fetchPayment(providerPaymentId: string): Promise<VerifiedPayment>;

  refund(providerPaymentId: string, amountPaise: number, reason: string): Promise<RefundResult>;
}

/** Thrown for provider faults, so callers can distinguish them from bugs. */
export class PaymentProviderError extends Error {
  readonly provider: string;
  readonly detail: unknown;

  constructor(provider: string, message: string, detail?: unknown) {
    super(`[${provider}] ${message}`);
    this.name = 'PaymentProviderError';
    this.provider = provider;
    this.detail = detail;
  }
}
