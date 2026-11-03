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
  statusCode?: number;
  constructor(code: string, message: string) {
    super(message);
    this.name = "FakeStripeError";
    this.code = code;
    this.type = "StripeInvalidRequestError";
  }
}

const accounts = new Map<string, ConnectAccount>();
const capturedPayments = new Map<string, number>();
const capturedFees = new Map<string, number>();
const captureKeys = new Map<string, string>();
const cancelledPayments = new Set<string>();
const cancelKeys = new Map<string, string>();
const authorizedAmounts = new Map<string, number>();
const refundedPayments = new Map<string, number>();
const refunds = new Map<string, { paymentIntentId: string; amountRefunded: number; status: string }>();
const nextRefundStatus = new Map<string, string>();
const feeRefunded = new Map<string, number>();
const refundRequests: Array<{
  paymentIntentId: string;
  amountCents: number;
  idempotencyKey?: string;
  refundApplicationFee: boolean;
}> = [];
const captureErrorBudget = new Map<string, number>();
const replayedCaptureErrors = new Map<string, true>();

function reset() {
  accounts.clear();
  capturedPayments.clear();
  capturedFees.clear();
  captureKeys.clear();
  cancelledPayments.clear();
  cancelKeys.clear();
  authorizedAmounts.clear();
  refundedPayments.clear();
  refunds.clear();
  nextRefundStatus.clear();
  feeRefunded.clear();
  refundRequests.length = 0;
  captureErrorBudget.clear();
  replayedCaptureErrors.clear();
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
    const parsed = JSON.parse(payload) as {
      type?: string;
      accountId?: string;
      data?: {
        object?: {
          id?: string;
          object?: string;
          status?: string;
          payment_intent?: string | { id?: string };
        };
      };
    };
    const obj = parsed.data?.object;
    const paymentIntentId =
      typeof obj?.payment_intent === "string" ? obj.payment_intent : obj?.payment_intent?.id;
    const refund =
      obj?.object === "refund" && obj.id && obj.status && paymentIntentId
        ? { id: obj.id, status: obj.status, paymentIntentId }
        : undefined;
    return {
      type: parsed.type as string,
      accountId: (parsed.accountId ?? obj?.id ?? "") as string,
      ...(refund ? { refund } : {}),
    } satisfies WebhookEvent;
  },

  async capturePaymentIntent(paymentIntentId, amountCents, idempotencyKey, applicationFeeAmount) {
    if (idempotencyKey && replayedCaptureErrors.has(idempotencyKey)) {
      const replay = new FakeStripeError("api_error", "Internal server error");
      replay.type = "StripeAPIError";
      replay.statusCode = 500;
      throw replay;
    }
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
    if (!authorizedAmounts.has(paymentIntentId)) {
      throw new FakeStripeError(
        "resource_missing",
        `No such payment_intent: '${paymentIntentId}'`,
      );
    }
    if (amountCents < STRIPE_USD_MINIMUM_CAPTURE_CENTS) {
      throw new FakeStripeError(
        "amount_too_small",
        `Amount must be at least 50 cents.`,
      );
    }
    const authorized = authorizedAmounts.get(paymentIntentId)!;
    if (amountCents > authorized) {
      throw new FakeStripeError(
        "amount_too_large",
        `Capture amount ${amountCents} exceeds authorized amount ${authorized}`,
      );
    }
    const failuresLeft = captureErrorBudget.get(paymentIntentId) ?? 0;
    if (failuresLeft > 0) {
      captureErrorBudget.set(paymentIntentId, failuresLeft - 1);
      if (idempotencyKey) replayedCaptureErrors.set(idempotencyKey, true);
      const err = new FakeStripeError("api_error", "Internal server error");
      err.type = "StripeAPIError";
      err.statusCode = 500;
      throw err;
    }
    capturedPayments.set(paymentIntentId, amountCents);
    if (applicationFeeAmount !== undefined) {
      // Stripe caps application_fee_amount at the captured amount instead of rejecting it.
      capturedFees.set(paymentIntentId, Math.min(applicationFeeAmount, amountCents));
    }
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

  async refundPayment(paymentIntentId, amountCents, idempotencyKey, options) {
    refundRequests.push({
      paymentIntentId,
      amountCents,
      idempotencyKey,
      refundApplicationFee: options?.refundApplicationFee === true,
    });
    if (options?.refundApplicationFee) {
      const fee = capturedFees.get(paymentIntentId) ?? 0;
      const captured = capturedPayments.get(paymentIntentId) ?? 0;
      const proportional = captured > 0 ? Math.round((fee * amountCents) / captured) : 0;
      feeRefunded.set(paymentIntentId, Math.min(fee, proportional));
    }
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

function setNextCaptureFailure(paymentIntentId: string, times = 1) {
  captureErrorBudget.set(paymentIntentId, times);
}

function ensureAuthorizedAmount(paymentIntentId: string, amount: number) {
  if (!authorizedAmounts.has(paymentIntentId)) {
    authorizedAmounts.set(paymentIntentId, amount);
  }
}

export { FakeStripeError, fakeStripeProvider, reset, getAccounts, capturedPayments, capturedFees, cancelledPayments, authorizedAmounts, refundedPayments, feeRefunded, refundRequests, setAuthorizedAmount, setNextRefundStatus, setNextCaptureFailure, ensureAuthorizedAmount, nextRefundStatus, VALID_WEBHOOK_SIGNATURE };
