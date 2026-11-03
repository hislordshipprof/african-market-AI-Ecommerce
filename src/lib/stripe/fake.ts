import type {
  StripeProvider,
  ConnectAccount,
  AccountLinkResult,
  WebhookEvent,
  CaptureResult,
  CancelResult,
  RetrieveResult,
} from "./types";

const VALID_WEBHOOK_SIGNATURE = "fake_valid_sig";

const accounts = new Map<string, ConnectAccount>();
const capturedPayments = new Map<string, number>();
const cancelledPayments = new Set<string>();
const authorizedAmounts = new Map<string, number>();

function reset() {
  accounts.clear();
  capturedPayments.clear();
  cancelledPayments.clear();
  authorizedAmounts.clear();
}

function getAccounts(): Map<string, ConnectAccount> {
  return accounts;
}

function setAuthorizedAmount(paymentIntentId: string, amount: number) {
  authorizedAmounts.set(paymentIntentId, amount);
}

const fakeStripeProvider: StripeProvider = {
  async createConnectAccount({ storeId }) {
    const accountId = `acct_fake_${storeId}`;
    const account: ConnectAccount = {
      accountId,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirementsCurrentlyDue: ["business_profile", "external_account"],
    };
    accounts.set(accountId, account);
    return account;
  },

  async createAccountLink({ accountId }) {
    if (!accounts.has(accountId)) {
      throw new Error(`No account found with id ${accountId}`);
    }
    return {
      url: `https://connect.stripe.com/fake-onboarding/${accountId}`,
    } satisfies AccountLinkResult;
  },

  async getAccount(accountId) {
    const account = accounts.get(accountId);
    if (!account) {
      throw new Error(`No account found with id ${accountId}`);
    }
    return account;
  },

  verifyWebhookSignature({ payload, signature }) {
    if (signature !== VALID_WEBHOOK_SIGNATURE) {
      throw new Error(
        "No signatures found matching the expected signature for payload.",
      );
    }
    const parsed = JSON.parse(payload);
    return {
      type: parsed.type as string,
      accountId: (parsed.accountId ?? parsed.data?.object?.id ?? "") as string,
    } satisfies WebhookEvent;
  },

  async capturePaymentIntent(paymentIntentId, amountCents) {
    if (cancelledPayments.has(paymentIntentId)) {
      throw new Error(
        `PaymentIntent ${paymentIntentId} has already been canceled and cannot be captured.`,
      );
    }
    if (capturedPayments.has(paymentIntentId)) {
      return {
        paymentIntentId,
        amountCaptured: capturedPayments.get(paymentIntentId)!,
        status: "succeeded",
      } satisfies CaptureResult;
    }
    const authorized = authorizedAmounts.get(paymentIntentId);
    if (authorized !== undefined && amountCents > authorized) {
      throw new Error(
        `Capture amount ${amountCents} exceeds authorized amount ${authorized}`,
      );
    }
    capturedPayments.set(paymentIntentId, amountCents);
    return {
      paymentIntentId,
      amountCaptured: amountCents,
      status: "succeeded",
    } satisfies CaptureResult;
  },

  async cancelPaymentIntent(paymentIntentId) {
    if (capturedPayments.has(paymentIntentId)) {
      throw new Error(
        `PaymentIntent ${paymentIntentId} has already been captured (succeeded) and cannot be canceled.`,
      );
    }
    if (cancelledPayments.has(paymentIntentId)) {
      return {
        paymentIntentId,
        status: "canceled",
      } satisfies CancelResult;
    }
    cancelledPayments.add(paymentIntentId);
    return {
      paymentIntentId,
      status: "canceled",
    } satisfies CancelResult;
  },

  async retrievePaymentIntent(paymentIntentId) {
    if (capturedPayments.has(paymentIntentId)) {
      return {
        paymentIntentId,
        status: "succeeded",
        amountCapturable: 0,
        amountReceived: capturedPayments.get(paymentIntentId)!,
      } satisfies RetrieveResult;
    }
    if (cancelledPayments.has(paymentIntentId)) {
      return {
        paymentIntentId,
        status: "canceled",
        amountCapturable: 0,
        amountReceived: 0,
      } satisfies RetrieveResult;
    }
    const authorized = authorizedAmounts.get(paymentIntentId);
    return {
      paymentIntentId,
      status: "requires_capture",
      amountCapturable: authorized ?? 0,
      amountReceived: 0,
    } satisfies RetrieveResult;
  },
};

export { fakeStripeProvider, reset, getAccounts, capturedPayments, cancelledPayments, authorizedAmounts, setAuthorizedAmount, VALID_WEBHOOK_SIGNATURE };
