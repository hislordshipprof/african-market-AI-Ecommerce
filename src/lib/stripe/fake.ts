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
import { OverRefundError } from "./errors";

const lateRefundKeys = new Set<string>();

const VALID_WEBHOOK_SIGNATURE = "fake_valid_sig";
const STRIPE_USD_MINIMUM_CAPTURE_CENTS = 50;

class FakeStripeError extends Error {
  code?: string;
  type: string;
  statusCode: number;
  constructor(
    code: string,
    message: string,
    statusCode = 400,
    type = "StripeInvalidRequestError",
  ) {
    super(message);
    this.name = "FakeStripeError";
    this.type = type;
    this.statusCode = statusCode;
    if (code) this.code = code;
  }
}

type RefundEntry = {
  paymentIntentId: string;
  amountRefunded: number;
  status: string;
  feePortion: number;
  seq: number;
  reservationKey?: string;
  orderId?: string;
};

type IdemRecord = {
  fingerprint: string;
  error?: unknown;
  value?: unknown;
};

function stripeApiError(message: string): FakeStripeError {
  return new FakeStripeError("api_error", message, 500, "StripeAPIError");
}

function resourceMissing(kind: string, id: string): FakeStripeError {
  return new FakeStripeError(
    "resource_missing",
    `No such ${kind}: '${id}'`,
    404,
  );
}

function idempotencyMismatch(key: string): FakeStripeError {
  return new FakeStripeError(
    "",
    `Keys for idempotent requests can only be used with the same parameters they were first used with. Try using a key other than '${key}' if you meant to execute a different request.`,
    400,
    "StripeIdempotencyError",
  );
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function countsTowardBalance(status: string): boolean {
  return status !== "failed" && status !== "canceled";
}

const accounts = new Map<string, ConnectAccount>();
const capturedPayments = new Map<string, number>();
const capturedFees = new Map<string, number>();
const captureKeys = new Map<string, string>();
const cancelledPayments = new Set<string>();
const cancelKeys = new Map<string, string>();
const authorizedAmounts = new Map<string, number>();
const refundedPayments = new Map<string, number>();
const refunds = new Map<string, RefundEntry>();
const nextRefundStatus = new Map<string, string>();
const feeRefunded = new Map<string, number>();
const refundRequests: Array<{
  paymentIntentId: string;
  amountCents: number;
  idempotencyKey?: string;
  refundApplicationFee: boolean;
}> = [];
const captureErrorBudget = new Map<string, number>();
const captureConflicts = new Set<string>();
const captureAppliesBeforeError = new Set<string>();
const cancelErrorBudget = new Map<string, number>();
const cancelUnexpected = new Set<string>();
const refundErrorBudget = new Map<string, number>();
const retrieveScript = new Map<string, string[]>();
const idempotency = new Map<string, IdemRecord>();
const inFlightKeys = new Set<string>();
const captureCalls: string[] = [];
let captureHold: Promise<void> | null = null;
let releaseCaptureHold: (() => void) | null = null;
let notifyCaptureEntered: (() => void) | null = null;
let refundSeq = 0;

function holdNextCapture(): Promise<void> {
  const entered = new Promise<void>((resolve) => {
    notifyCaptureEntered = resolve;
  });
  captureHold = new Promise<void>((resolve) => {
    releaseCaptureHold = resolve;
  });
  return entered;
}

function releaseHeldCaptures(): void {
  releaseCaptureHold?.();
  captureHold = null;
  releaseCaptureHold = null;
}

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
  captureConflicts.clear();
  captureAppliesBeforeError.clear();
  cancelErrorBudget.clear();
  cancelUnexpected.clear();
  refundErrorBudget.clear();
  retrieveScript.clear();
  idempotency.clear();
  inFlightKeys.clear();
  lateRefundKeys.clear();
  captureCalls.length = 0;
  captureHold = null;
  releaseCaptureHold = null;
  notifyCaptureEntered = null;
  refundSeq = 0;
}

function syncRefundBalance(paymentIntentId: string) {
  let amount = 0;
  let fee = 0;
  for (const entry of refunds.values()) {
    if (entry.paymentIntentId !== paymentIntentId) continue;
    if (!countsTowardBalance(entry.status)) continue;
    amount += entry.amountRefunded;
    fee += entry.feePortion;
  }
  if (amount === 0) refundedPayments.delete(paymentIntentId);
  else refundedPayments.set(paymentIntentId, amount);
  if (fee === 0) feeRefunded.delete(paymentIntentId);
  else feeRefunded.set(paymentIntentId, fee);
}

function refundView(refundId: string): RefundResult {
  const entry = refunds.get(refundId);
  if (!entry) throw resourceMissing("refund", refundId);
  return {
    refundId,
    amountRefunded: entry.amountRefunded,
    status: entry.status,
    ...(entry.reservationKey ? { reservationKey: entry.reservationKey } : {}),
    ...(entry.orderId ? { orderId: entry.orderId } : {}),
  };
}

async function withIdempotency<T>(
  key: string | undefined,
  fingerprint: string,
  run: () => Promise<T>,
): Promise<T> {
  if (key) {
    const existing = idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw idempotencyMismatch(key);
      if (existing.error && lateRefundKeys.has(key)) {
        idempotency.delete(key);
        lateRefundKeys.delete(key);
      } else {
        if (existing.error) throw existing.error;
        // Stripe replays the saved first response, not the object's current state.
        return structuredClone(existing.value) as T;
      }
    }
    if (inFlightKeys.has(key)) {
      throw new FakeStripeError(
        "idempotency_key_in_use",
        "There is currently another in-progress request using this Idempotent Key",
        409,
      );
    }
    inFlightKeys.add(key);
  }
  try {
    const value = await run();
    if (key) idempotency.set(key, { fingerprint, value: structuredClone(value) });
    return value;
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (key && statusCode !== 409 && (error instanceof FakeStripeError || error instanceof ProviderStateError)) {
      idempotency.set(key, { fingerprint, error });
    }
    throw error;
  } finally {
    if (key) inFlightKeys.delete(key);
  }
}

function uncapturedRefundError(paymentIntentId: string): FakeStripeError {
  return new FakeStripeError(
    "",
    `This uncaptured Charge was created by a PaymentIntent (${paymentIntentId}). You must cancel the PaymentIntent to reverse the authorization instead of refunding the Charge directly. For more information, see https://stripe.com/docs/payments/place-a-hold-on-a-payment-method`,
  );
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
      id?: string;
      type?: string;
      accountId?: string;
      data?: {
        object?: {
          id?: string;
          object?: string;
          status?: string;
          payment_intent?: string | { id?: string };
          cancellation_reason?: string | null;
          metadata?: { reservation?: string };
        };
      };
    };
    const obj = parsed.data?.object;
    const paymentIntentId =
      typeof obj?.payment_intent === "string" ? obj.payment_intent : obj?.payment_intent?.id;
    const reservationKey = typeof obj?.metadata?.reservation === "string" ? obj.metadata.reservation : undefined;
    const refund =
      obj?.object === "refund" && obj.id && obj.status && paymentIntentId
        ? {
            id: obj.id,
            status: obj.status,
            paymentIntentId,
            ...(reservationKey ? { reservationKey } : {}),
          }
        : undefined;
    const paymentIntent =
      obj?.object === "payment_intent" && obj.id && obj.status
        ? { id: obj.id, status: obj.status, cancellationReason: obj.cancellation_reason ?? null }
        : undefined;
    return {
      type: parsed.type as string,
      accountId: (parsed.accountId ?? obj?.id ?? "") as string,
      ...(parsed.id ? { eventId: parsed.id } : {}),
      ...(refund ? { refund } : {}),
      ...(paymentIntent ? { paymentIntent } : {}),
    } satisfies WebhookEvent;
  },

  async capturePaymentIntent(paymentIntentId, amountCents, idempotencyKey, applicationFeeAmount) {
    captureCalls.push(idempotencyKey ?? "");
    if (captureConflicts.delete(paymentIntentId)) {
      throw new FakeStripeError(
        "idempotency_key_in_use",
        "There is currently another in-progress request using this Idempotent Key",
        409,
      );
    }
    if (captureHold) {
      const notify = notifyCaptureEntered;
      notifyCaptureEntered = null;
      notify?.();
      await captureHold;
    }
    const fingerprint = `capture:${paymentIntentId}:${amountCents}:${applicationFeeAmount ?? ""}`;
    return withIdempotency(idempotencyKey, fingerprint, async () => {
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
        throw resourceMissing("payment_intent", paymentIntentId);
      }
      if (amountCents < STRIPE_USD_MINIMUM_CAPTURE_CENTS) {
        throw new FakeStripeError(
          "amount_too_small",
          "Amount must be at least 50 cents.",
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
        if (captureAppliesBeforeError.has(paymentIntentId)) {
          capturedPayments.set(paymentIntentId, amountCents);
          if (applicationFeeAmount !== undefined) {
            capturedFees.set(paymentIntentId, Math.min(applicationFeeAmount, amountCents));
          }
        }
        throw stripeApiError("Internal server error");
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
    });
  },

  async cancelPaymentIntent(paymentIntentId, idempotencyKey) {
    const fingerprint = `cancel:${paymentIntentId}`;
    return withIdempotency(idempotencyKey, fingerprint, async () => {
      if (cancelUnexpected.has(paymentIntentId)) {
        cancelUnexpected.delete(paymentIntentId);
        throw new ProviderStateError("cancel", "processing");
      }
      if (capturedPayments.has(paymentIntentId)) {
        throw new ProviderStateError("cancel", "succeeded");
      }
      if (cancelledPayments.has(paymentIntentId)) {
        return {
          paymentIntentId,
          status: "canceled",
        } satisfies CancelResult;
      }
      if (!authorizedAmounts.has(paymentIntentId)) {
        throw resourceMissing("payment_intent", paymentIntentId);
      }
      const failuresLeft = cancelErrorBudget.get(paymentIntentId) ?? 0;
      if (failuresLeft > 0) {
        cancelErrorBudget.set(paymentIntentId, failuresLeft - 1);
        throw stripeApiError("Internal server error");
      }
      cancelledPayments.add(paymentIntentId);
      if (idempotencyKey) cancelKeys.set(paymentIntentId, idempotencyKey);
      return {
        paymentIntentId,
        status: "canceled",
      } satisfies CancelResult;
    });
  },

  async refundPayment(paymentIntentId, amountCents, idempotencyKey, options) {
    const refundApplicationFee = options?.refundApplicationFee === true;
    const reservationKey = options?.reservationKey ?? "";
    const orderId = options?.orderId ?? "";
    const fingerprint = `refund:${paymentIntentId}:${amountCents}:${refundApplicationFee}:${reservationKey}:${orderId}`;
    if (!Number.isInteger(amountCents) || amountCents < 1) {
      throw new FakeStripeError(
        "parameter_invalid_integer",
        "This value must be greater than or equal to 1.",
      );
    }
    if (!authorizedAmounts.has(paymentIntentId) && !capturedPayments.has(paymentIntentId)) {
      throw resourceMissing("payment_intent", paymentIntentId);
    }
    return withIdempotency(idempotencyKey, fingerprint, async () => {
      refundRequests.push({
        paymentIntentId,
        amountCents,
        idempotencyKey,
        refundApplicationFee,
      });
      if (!capturedPayments.has(paymentIntentId)) {
        throw uncapturedRefundError(paymentIntentId);
      }
      const refundFailuresLeft = refundErrorBudget.get(paymentIntentId) ?? 0;
      if (refundFailuresLeft > 0) {
        refundErrorBudget.set(paymentIntentId, refundFailuresLeft - 1);
        throw stripeApiError("Internal server error");
      }
      const captured = capturedPayments.get(paymentIntentId)!;
      const already = refundedPayments.get(paymentIntentId) ?? 0;
      const remaining = captured - already;
      if (amountCents > remaining) {
        if (remaining === 0) {
          throw new FakeStripeError(
            "charge_already_refunded",
            `Charge ch_fake_${paymentIntentId} has already been refunded.`,
          );
        }
        throw new OverRefundError(
          `Refund amount (${usd(amountCents)}) is greater than unrefunded amount on charge (${usd(remaining)})`,
        );
      }
      const status = nextRefundStatus.get(paymentIntentId) ?? "succeeded";
      const prior = [...refunds.values()].filter((entry) => entry.paymentIntentId === paymentIntentId);
      refundSeq += 1;
      const refundId = prior.length === 0
        ? `re_fake_${paymentIntentId}`
        : `re_fake_${paymentIntentId}_n${refundSeq}`;
      const countedFee = [...refunds.values()]
        .filter((entry) => entry.paymentIntentId === paymentIntentId && countsTowardBalance(entry.status))
        .reduce((sum, entry) => sum + entry.feePortion, 0);
      const chargedFee = capturedFees.get(paymentIntentId) ?? 0;
      let feePortion = 0;
      if (refundApplicationFee && chargedFee > 0 && countsTowardBalance(status)) {
        const proportional = Math.round((chargedFee * amountCents) / captured);
        feePortion = Math.max(0, Math.min(proportional, chargedFee - countedFee));
      }
      refunds.set(refundId, {
        paymentIntentId,
        amountRefunded: amountCents,
        status,
        feePortion,
        seq: refundSeq,
        ...(options?.reservationKey ? { reservationKey: options.reservationKey } : {}),
        ...(options?.orderId ? { orderId: options.orderId } : {}),
      });
      syncRefundBalance(paymentIntentId);
      return {
        refundId,
        amountRefunded: amountCents,
        status,
        ...(options?.reservationKey ? { reservationKey: options.reservationKey } : {}),
        ...(options?.orderId ? { orderId: options.orderId } : {}),
      } satisfies RefundResult;
    });
  },

  async listRefunds(paymentIntentId) {
    const known =
      authorizedAmounts.has(paymentIntentId) ||
      capturedPayments.has(paymentIntentId) ||
      cancelledPayments.has(paymentIntentId) ||
      [...refunds.values()].some((entry) => entry.paymentIntentId === paymentIntentId);
    if (!known) throw resourceMissing("payment_intent", paymentIntentId);
    return [...refunds.entries()]
      .filter(([, entry]) => entry.paymentIntentId === paymentIntentId)
      .sort((left, right) => right[1].seq - left[1].seq)
      .map(([refundId]) => refundView(refundId)) satisfies RefundResult[];
  },

  async retrieveRefund(refundId) {
    return refundView(refundId);
  },

  async retrievePaymentIntent(paymentIntentId) {
    const scripted = retrieveScript.get(paymentIntentId);
    const scriptedStatus = scripted?.shift();
    if (scripted && scripted.length === 0) retrieveScript.delete(paymentIntentId);
    if (scriptedStatus) {
      const captured = capturedPayments.get(paymentIntentId) ?? 0;
      return {
        paymentIntentId,
        status: scriptedStatus,
        amountCapturable: scriptedStatus === "requires_capture" ? (authorizedAmounts.get(paymentIntentId) ?? 0) : 0,
        amountReceived: scriptedStatus === "succeeded" ? captured : 0,
        amountRefunded: refundedPayments.get(paymentIntentId) ?? 0,
      } satisfies RetrieveResult;
    }
    if (capturedPayments.has(paymentIntentId)) {
      return {
        paymentIntentId,
        status: "succeeded",
        amountCapturable: 0,
        amountReceived: capturedPayments.get(paymentIntentId)!,
        amountRefunded: refundedPayments.get(paymentIntentId) ?? 0,
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
    if (authorized === undefined) {
      throw resourceMissing("payment_intent", paymentIntentId);
    }
    return {
      paymentIntentId,
      status: "requires_capture",
      amountCapturable: authorized,
      amountReceived: 0,
    } satisfies RetrieveResult;
  },
};

function setRefundStatus(refundId: string, status: string) {
  const entry = refunds.get(refundId);
  if (!entry) return;
  entry.status = status;
  syncRefundBalance(entry.paymentIntentId);
}

function setNextRefundStatus(paymentIntentId: string, status: string) {
  nextRefundStatus.set(paymentIntentId, status);
}

function setNextCaptureFailure(paymentIntentId: string, times = 1) {
  captureErrorBudget.set(paymentIntentId, times);
}

function setNextIdempotencyConflict(paymentIntentId: string) {
  captureConflicts.add(paymentIntentId);
}

/** Stripe applied the capture, then the response was a 500. */
function setNextCaptureAppliedFailure(paymentIntentId: string, times = 1) {
  captureAppliesBeforeError.add(paymentIntentId);
  captureErrorBudget.set(paymentIntentId, times);
}

function setCancelUnexpectedState(paymentIntentId: string) {
  cancelUnexpected.add(paymentIntentId);
}

function scriptRetrieveStatuses(paymentIntentId: string, statuses: string[]) {
  retrieveScript.set(paymentIntentId, [...statuses]);
}

function setNextCancelFailure(paymentIntentId: string, times = 1) {
  cancelErrorBudget.set(paymentIntentId, times);
}

function setNextRefundFailure(paymentIntentId: string, times = 1) {
  refundErrorBudget.set(paymentIntentId, times);
}

/** The next replay of this key creates the refund instead of repeating a stored error. */
function setRefundCreatedLate(key: string) {
  lateRefundKeys.add(key);
}

function ensureAuthorizedAmount(paymentIntentId: string, amount: number) {
  if (!authorizedAmounts.has(paymentIntentId)) {
    authorizedAmounts.set(paymentIntentId, amount);
  }
}

export { FakeStripeError, fakeStripeProvider, reset, getAccounts, capturedPayments, capturedFees, cancelledPayments, refundedPayments, feeRefunded, refundRequests, captureCalls, holdNextCapture, releaseHeldCaptures, setAuthorizedAmount, setNextRefundStatus, setRefundStatus, setNextCaptureFailure, setNextCaptureAppliedFailure, setNextIdempotencyConflict, setNextCancelFailure, setNextRefundFailure, setRefundCreatedLate, setCancelUnexpectedState, scriptRetrieveStatuses, ensureAuthorizedAmount, VALID_WEBHOOK_SIGNATURE };
