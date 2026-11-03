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

export interface WebhookEvent {
  type: string;
  accountId: string;
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
  ): Promise<RefundResult>;
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
