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

function getWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "STRIPE_WEBHOOK_SECRET is not set. Webhook verification requires this key at runtime.",
    );
  }
  return secret;
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
    const secret = getWebhookSecret();
    try {
      const event = stripe.webhooks.constructEvent(
        payload,
        signature,
        secret,
      );
      const obj = event.data?.object as { id?: string } | undefined;
      return {
        type: event.type,
        accountId: obj?.id ?? event.account ?? "",
      } satisfies WebhookEvent;
    } catch {
      // v1 parse failed — try v2 thin event
    }
    const notification = stripe.parseEventNotification(
      payload,
      signature,
      secret,
    );
    return {
      type: notification.type,
      accountId:
        ("related_object" in notification
          ? (notification.related_object as { id?: string } | null)?.id
          : undefined) ?? "",
    } satisfies WebhookEvent;
  },

  async capturePaymentIntent(paymentIntentId, amountCents, idempotencyKey) {
    const stripe = getStripeClient();
    try {
      const pi = await stripe.paymentIntents.capture(paymentIntentId, {
        amount_to_capture: amountCents,
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
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    return {
      paymentIntentId: pi.id,
      status: pi.status,
      amountCapturable: pi.amount_capturable ?? 0,
      amountReceived: pi.amount_received ?? 0,
    } satisfies RetrieveResult;
  },

  async refundPayment(paymentIntentId, amountCents, idempotencyKey) {
    const stripe = getStripeClient();
    try {
      const refund = await stripe.refunds.create(
        { payment_intent: paymentIntentId, amount: amountCents, reverse_transfer: true },
        idempotencyKey ? { idempotencyKey } : undefined,
      );
      return {
        refundId: refund.id,
        amountRefunded: refund.amount,
        status: refund.status ?? "succeeded",
      } satisfies RefundResult;
    } catch (err: unknown) {
      if (err instanceof Stripe.errors.StripeInvalidRequestError
        && /already been refunded/i.test(err.message)) {
        const refunds = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 1 });
        const existing = refunds.data[0];
        if (existing) {
          return {
            refundId: existing.id,
            amountRefunded: existing.amount,
            status: existing.status ?? "succeeded",
          } satisfies RefundResult;
        }
      }
      throw err;
    }
  },
};
