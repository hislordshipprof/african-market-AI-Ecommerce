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
}

export interface WebhookEvent {
  type: string;
  accountId: string;
  refund?: WebhookRefund;
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
    options?: { refundApplicationFee?: boolean },
  ): Promise<RefundResult>;

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
