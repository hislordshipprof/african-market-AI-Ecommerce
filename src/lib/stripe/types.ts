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
