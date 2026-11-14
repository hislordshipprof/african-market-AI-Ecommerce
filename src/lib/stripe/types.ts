export type OnboardingStatus =
  | "not_started"
  | "pending"
  | "restricted"
  | "complete";

export interface ConnectAccount {
  accountId: string;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsCurrentlyDue: string[];
}

export interface AccountLinkResult {
  url: string;
}

export interface WebhookRefund {
  id: string;
  status: string;
  paymentIntentId: string;
  reservationKey?: string;
}

export interface WebhookPaymentIntent {
  id: string;
  status: string;
  cancellationReason: string | null;
}

/** A store's platform subscription (#494). Times are Unix seconds. */
export interface WebhookSubscription {
  id: string;
  customerId: string;
  status: string;
  lookupKey: string | null;
  storeId: string | null;
  trialEnd: number | null;
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

export interface WebhookInvoice {
  id: string;
  customerId: string;
  subscriptionId: string | null;
  storeId: string | null;
}

export interface WebhookEvent {
  type: string;
  accountId: string;
  /** Stripe's event id; a replay carries the same one. */
  eventId?: string;
  /** Unix seconds when Stripe created the event. */
  created?: number;
  refund?: WebhookRefund;
  paymentIntent?: WebhookPaymentIntent;
  subscription?: WebhookSubscription;
  invoice?: WebhookInvoice;
}

export interface CaptureResult {
  paymentIntentId: string;
  amountCaptured: number;
  status: string;
}

export interface CancelResult {
  paymentIntentId: string;
  status: string;
}

export interface RetrieveResult {
  paymentIntentId: string;
  status: string;
  amountCapturable: number;
  amountReceived: number;
  /** Already refunded on the charge. Absent means the caller has not been told. */
  amountRefunded?: number;
}

export interface RefundResult {
  refundId: string;
  amountRefunded: number;
  status: string;
  /** Set when this refund was created for a reserved application request. */
  reservationKey?: string;
  /** The order this refund was created for, when the app sent one. */
  orderId?: string;
}

export interface StripeProvider {
  createConnectAccount(input: {
    email: string;
    businessName: string;
    storeId: string;
  }): Promise<ConnectAccount>;

  createAccountLink(input: {
    accountId: string;
    returnUrl: string;
    refreshUrl: string;
  }): Promise<AccountLinkResult>;

  getAccount(accountId: string): Promise<ConnectAccount>;

  verifyWebhookSignature(input: {
    payload: string;
    signature: string;
  }): WebhookEvent;

  capturePaymentIntent(
    paymentIntentId: string,
    amountCents: number,
    idempotencyKey?: string,
    applicationFeeAmount?: number,
  ): Promise<CaptureResult>;

  cancelPaymentIntent(
    paymentIntentId: string,
    idempotencyKey?: string,
  ): Promise<CancelResult>;

  retrievePaymentIntent(
    paymentIntentId: string,
  ): Promise<RetrieveResult>;

  refundPayment(
    paymentIntentId: string,
    amountCents: number,
    idempotencyKey?: string,
    options?: { refundApplicationFee?: boolean; reservationKey?: string; orderId?: string },
  ): Promise<RefundResult>;

  /**
   * Returns `amountCents` of the charge's application fee to the connected account, once per
   * `reservationKey` (the refund it goes with). The platform funds that part of the refund.
   */
  refundApplicationFeePart(
    paymentIntentId: string,
    amountCents: number,
    reservationKey: string,
  ): Promise<{ feeRefundId: string }>;

  /** Refunds on this PaymentIntent. Pending refunds stay pending. */
  listRefunds(paymentIntentId: string): Promise<RefundResult[]>;

  retrieveRefund(
    refundId: string,
  ): Promise<RefundResult>;
}

export class ProviderStateError extends Error {
  actualStatus: string;
  constructor(expectedOp: "capture" | "cancel", actualStatus: string) {
    super(`${expectedOp} expected matching terminal status but PI is ${actualStatus}`);
    this.name = "ProviderStateError";
    this.actualStatus = actualStatus;
  }
}

export function deriveOnboardingStatus(account: {
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  requirementsCurrentlyDue: string[];
}): OnboardingStatus {
  if (account.chargesEnabled && account.payoutsEnabled) return "complete";
  if (account.requirementsCurrentlyDue.length > 0) return "restricted";
  return "pending";
}
