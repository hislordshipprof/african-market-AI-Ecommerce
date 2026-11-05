import Stripe from "stripe";
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
import { RefundNotCreatedError, WebhookSecretMissingError, mapRefundStatus, overRefundError } from "./errors";

let _stripeClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (_stripeClient) return _stripeClient;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Stripe operations require this key at runtime.",
    );
  }
  _stripeClient = new Stripe(key);
  return _stripeClient;
}

function webhookSecrets(): string[] {
  const raw = process.env.STRIPE_WEBHOOK_SECRET;
  if (!raw?.trim()) throw new WebhookSecretMissingError();
  return raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toConnectAccount(account: any): ConnectAccount {
  const merchantCaps = account.configuration?.merchant?.capabilities;
  const chargesEnabled = merchantCaps?.card_payments?.status === "active";
  const payoutsEnabled =
    merchantCaps?.stripe_balance?.payouts?.status === "active";

  const requirementEntries: Array<{
    awaiting_action_from: string;
    description: string;
  }> = account.requirements?.entries ?? [];
  const userRequirements = requirementEntries
    .filter((e) => e.awaiting_action_from === "user")
    .map((e) => e.description);

  const detailsSubmitted =
    userRequirements.length === 0 &&
    account.configuration?.merchant?.applied === true;

  return {
    accountId: account.id,
    chargesEnabled,
    payoutsEnabled,
    detailsSubmitted,
    requirementsCurrentlyDue: userRequirements,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const stripeProvider: StripeProvider = {
  async createConnectAccount({ email, businessName, storeId }) {
    const stripe = getStripeClient();
    const account = await stripe.v2.core.accounts.create({
      contact_email: email,
      display_name: businessName,
      dashboard: "express",
      metadata: { platform_store_id: storeId },
      identity: {
        country: "US",
        entity_type: "company",
      },
      configuration: {
        merchant: {
          capabilities: {
            card_payments: { requested: true },
          },
        },
      },
      defaults: {
        responsibilities: {
          fees_collector: "application",
          losses_collector: "application",
        },
      },
      include: ["configuration.merchant", "requirements"],
    });
    return toConnectAccount(account);
  },

  async createAccountLink({ accountId, returnUrl, refreshUrl }) {
    const stripe = getStripeClient();
    const link = await stripe.v2.core.accountLinks.create({
      account: accountId,
      use_case: {
        type: "account_onboarding",
        account_onboarding: {
          refresh_url: refreshUrl,
          return_url: returnUrl,
        },
      },
    });
    return { url: link.url } satisfies AccountLinkResult;
  },

  async getAccount(accountId) {
    const stripe = getStripeClient();
    const account = await stripe.v2.core.accounts.retrieve(accountId, {
      include: ["configuration.merchant", "requirements"],
    });
    return toConnectAccount(account);
  },

  verifyWebhookSignature({ payload, signature }) {
    const stripe = getStripeClient();
    const secrets = webhookSecrets();
    let lastError: unknown;
    for (const secret of secrets) {
      try {
        const event = stripe.webhooks.constructEvent(payload, signature, secret);
        const obj = event.data?.object as {
          id?: string;
          object?: string;
          status?: string | null;
          payment_intent?: string | { id?: string };
          metadata?: { reservation?: string };
        } | undefined;
        const paymentIntentId =
          typeof obj?.payment_intent === "string" ? obj.payment_intent : obj?.payment_intent?.id;
        const reservationKey = typeof obj?.metadata?.reservation === "string" ? obj.metadata.reservation : undefined;
        const refund =
          obj?.object === "refund" && obj.id && paymentIntentId
            ? {
                id: obj.id,
                status: mapRefundStatus(obj.status),
                paymentIntentId,
                ...(reservationKey ? { reservationKey } : {}),
              }
            : undefined;
        return {
          type: event.type,
          accountId: obj?.id ?? event.account ?? "",
          ...(refund ? { refund } : {}),
        } satisfies WebhookEvent;
      } catch (err) {
        lastError = err;
      }
    }
    for (const secret of secrets) {
      try {
        const notification = stripe.parseEventNotification(payload, signature, secret);
        return {
          type: notification.type,
          accountId:
            ("related_object" in notification
              ? (notification.related_object as { id?: string } | null)?.id
              : undefined) ?? "",
        } satisfies WebhookEvent;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Invalid webhook signature");
  },

  async capturePaymentIntent(paymentIntentId, amountCents, idempotencyKey, applicationFeeAmount) {
    const stripe = getStripeClient();
    try {
      const pi = await stripe.paymentIntents.capture(paymentIntentId, {
        amount_to_capture: amountCents,
        ...(applicationFeeAmount ? { application_fee_amount: applicationFeeAmount } : {}),
      }, idempotencyKey ? { idempotencyKey } : undefined);
      return {
        paymentIntentId: pi.id,
        amountCaptured: pi.amount_received,
        status: pi.status,
      } satisfies CaptureResult;
    } catch (err: unknown) {
      if (err instanceof Stripe.errors.StripeInvalidRequestError
        && err.code === "payment_intent_unexpected_state") {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (pi.status === "succeeded") {
          return {
            paymentIntentId: pi.id,
            amountCaptured: pi.amount_received,
            status: pi.status,
          } satisfies CaptureResult;
        }
        throw new ProviderStateError("capture", pi.status);
      }
      throw err;
    }
  },

  async cancelPaymentIntent(paymentIntentId, idempotencyKey) {
    const stripe = getStripeClient();
    try {
      const pi = await stripe.paymentIntents.cancel(paymentIntentId, {},
        idempotencyKey ? { idempotencyKey } : undefined);
      return {
        paymentIntentId: pi.id,
        status: pi.status,
      } satisfies CancelResult;
    } catch (err: unknown) {
      if (err instanceof Stripe.errors.StripeInvalidRequestError
        && err.code === "payment_intent_unexpected_state") {
        const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
        if (pi.status === "canceled") {
          return {
            paymentIntentId: pi.id,
            status: pi.status,
          } satisfies CancelResult;
        }
        throw new ProviderStateError("cancel", pi.status);
      }
      throw err;
    }
  },

  async retrievePaymentIntent(paymentIntentId) {
    const stripe = getStripeClient();
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge"],
    });
    const charge = pi.latest_charge;
    const amountRefunded =
      charge && typeof charge !== "string" ? (charge.amount_refunded ?? 0) : 0;
    return {
      paymentIntentId: pi.id,
      status: pi.status,
      amountCapturable: pi.amount_capturable ?? 0,
      amountReceived: pi.amount_received ?? 0,
      amountRefunded,
    } satisfies RetrieveResult;
  },

  async listRefunds(paymentIntentId) {
    const stripe = getStripeClient();
    const listed = await stripe.refunds
      .list({ payment_intent: paymentIntentId, limit: 100 })
      .autoPagingToArray({ limit: 10_000 });
    return listed.map((refund) => ({
      refundId: refund.id,
      amountRefunded: refund.amount,
      status: mapRefundStatus(refund.status),
      ...(typeof refund.metadata?.reservation === "string"
        ? { reservationKey: refund.metadata.reservation }
        : {}),
      ...(typeof refund.metadata?.order_id === "string"
        ? { orderId: refund.metadata.order_id }
        : {}),
    })) satisfies RefundResult[];
  },

  async retrieveRefund(refundId) {
    const stripe = getStripeClient();
    const refund = await stripe.refunds.retrieve(refundId);
    return {
      refundId: refund.id,
      amountRefunded: refund.amount,
      status: mapRefundStatus(refund.status),
      ...(typeof refund.metadata?.reservation === "string"
        ? { reservationKey: refund.metadata.reservation }
        : {}),
      ...(typeof refund.metadata?.order_id === "string"
        ? { orderId: refund.metadata.order_id }
        : {}),
    } satisfies RefundResult;
  },

  async refundPayment(paymentIntentId, amountCents, idempotencyKey, options) {
    const stripe = getStripeClient();
    try {
      const refund = await stripe.refunds.create(
        {
          payment_intent: paymentIntentId,
          amount: amountCents,
          reverse_transfer: true,
          ...(options?.refundApplicationFee ? { refund_application_fee: true } : {}),
          ...(options?.reservationKey || options?.orderId
            ? {
                metadata: {
                  ...(options.reservationKey ? { reservation: options.reservationKey } : {}),
                  ...(options.orderId ? { order_id: options.orderId } : {}),
                },
              }
            : {}),
        },
        idempotencyKey ? { idempotencyKey } : undefined,
      );
      return {
        refundId: refund.id,
        amountRefunded: refund.amount,
        status: mapRefundStatus(refund.status),
        ...(options?.reservationKey ? { reservationKey: options.reservationKey } : {}),
        ...(options?.orderId ? { orderId: options.orderId } : {}),
      } satisfies RefundResult;
    } catch (err: unknown) {
      if (err instanceof Stripe.errors.StripeInvalidRequestError
        && err.code === "charge_already_refunded") {
        throw new RefundNotCreatedError("charge_already_refunded", err.message);
      }
      const over = overRefundError(err);
      if (over) throw over;
      throw err;
    }
  },
};
