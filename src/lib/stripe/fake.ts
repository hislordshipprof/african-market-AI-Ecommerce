import type {
  StripeProvider,
  ConnectAccount,
  AccountLinkResult,
  WebhookEvent,
  CaptureResult,
  CancelResult,
  RetrieveResult,
  RefundResult,
} from "./types";
import { ProviderStateError } from "./types";

const VALID_WEBHOOK_SIGNATURE = "fake_valid_sig";
const STRIPE_USD_MINIMUM_CAPTURE_CENTS = 50;

class FakeStripeError extends Error {
  code: string;
  type: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FakeStripeError";
    this.code = code;
    this.type = "StripeInvalidRequestError";
  }
}

const accounts = new Map<string, ConnectAccount>();
const capturedPayments = new Map<string, number>();
const captureKeys = new Map<string, string>();
const cancelledPayments = new Set<string>();
const cancelKeys = new Map<string, string>();
const authorizedAmounts = new Map<string, number>();
const refundedPayments = new Map<string, number>();
const refunds = new Map<string, { paymentIntentId: string; amountRefunded: number; status: string }>();
const nextRefundStatus = new Map<string, string>();

function reset() {
  accounts.clear();
  capturedPayments.clear();
  captureKeys.clear();
  cancelledPayments.clear();
  cancelKeys.clear();
  authorizedAmounts.clear();
  refundedPayments.clear();
  refunds.clear();
  nextRefundStatus.clear();
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

  async capturePaymentIntent(paymentIntentId, amountCents, idempotencyKey) {
    if (cancelledPayments.has(paymentIntentId)) {
      throw new ProviderStateError("capture", "canceled");
    }
    if (capturedPayments.has(paymentIntentId)) {
      return {
        paymentIntentId,
        amountCaptured: capturedPayments.get(paymentIntentId)!,
        status: "succeeded",
      } satisfies CaptureResult;
    }
    if (amountCents < STRIPE_USD_MINIMUM_CAPTURE_CENTS) {
      throw new FakeStripeError(
        "amount_too_small",
        `Amount must be at least 50 cents.`,
      );
    }
    const authorized = authorizedAmounts.get(paymentIntentId);
    if (authorized !== undefined && amountCents > authorized) {
      throw new FakeStripeError(
        "amount_too_large",
        `Capture amount ${amountCents} exceeds authorized amount ${authorized}`,
      );
    }
    capturedPayments.set(paymentIntentId, amountCents);
    if (idempotencyKey) captureKeys.set(paymentIntentId, idempotencyKey);
    return {
      paymentIntentId,
      amountCaptured: amountCents,
      status: "succeeded",
    } satisfies CaptureResult;
  },

  async cancelPaymentIntent(paymentIntentId, idempotencyKey) {
    if (capturedPayments.has(paymentIntentId)) {
      throw new ProviderStateError("cancel", "succeeded");
    }
    if (cancelledPayments.has(paymentIntentId)) {
      return {
        paymentIntentId,
        status: "canceled",
      } satisfies CancelResult;
    }
    cancelledPayments.add(paymentIntentId);
    if (idempotencyKey) cancelKeys.set(paymentIntentId, idempotencyKey);
    return {
      paymentIntentId,
      status: "canceled",
    } satisfies CancelResult;
  },

  async refundPayment(paymentIntentId, amountCents) {
    if (!capturedPayments.has(paymentIntentId)) {
      throw new Error(
        `PaymentIntent ${paymentIntentId} has not been captured and cannot be refunded.`,
      );
    }
    if (refundedPayments.has(paymentIntentId)) {
      const refundId = `re_fake_${paymentIntentId}`;
      const existing = refunds.get(refundId);
      return {
        refundId,
        amountRefunded: refundedPayments.get(paymentIntentId)!,
        status: existing?.status === "pending" ? "pending" : "succeeded",
      } satisfies RefundResult;
    }
    const captured = capturedPayments.get(paymentIntentId)!;
    if (amountCents > captured) {
      throw new Error(
        `Refund amount ${amountCents} exceeds captured amount ${captured}`,
      );
    }
    const status = nextRefundStatus.get(paymentIntentId) ?? "succeeded";
    const refundId = `re_fake_${paymentIntentId}`;
    refundedPayments.set(paymentIntentId, amountCents);
    refunds.set(refundId, { paymentIntentId, amountRefunded: amountCents, status });
    return {
      refundId,
      amountRefunded: amountCents,
      status,
    } satisfies RefundResult;
  },

  async retrieveRefund(refundId) {
    const entry = refunds.get(refundId);
    if (!entry) {
      throw new Error(`Refund ${refundId} not found`);
    }
    // Model pending → succeeded: a later retrieve always sees succeeded
    return {
      refundId,
      amountRefunded: entry.amountRefunded,
      status: entry.status === "pending" ? "succeeded" : entry.status,
    } satisfies RefundResult;
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

function setNextRefundStatus(paymentIntentId: string, status: string) {
  nextRefundStatus.set(paymentIntentId, status);
}

export { FakeStripeError, fakeStripeProvider, reset, getAccounts, capturedPayments, cancelledPayments, authorizedAmounts, refundedPayments, setAuthorizedAmount, setNextRefundStatus, nextRefundStatus, VALID_WEBHOOK_SIGNATURE };
