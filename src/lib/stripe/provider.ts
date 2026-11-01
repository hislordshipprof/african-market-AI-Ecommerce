import Stripe from "stripe";
import type {
  StripeProvider,
  ConnectAccount,
  AccountLinkResult,
  WebhookEvent,
} from "./types";

let _stripeClient: Stripe | null = null;

function getStripeClient(): Stripe {
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

function toConnectAccount(account: Stripe.Account): ConnectAccount {
  return {
    accountId: account.id,
    chargesEnabled: account.charges_enabled ?? false,
    payoutsEnabled: account.payouts_enabled ?? false,
    detailsSubmitted: account.details_submitted ?? false,
    requirementsCurrentlyDue:
      account.requirements?.currently_due ?? [],
  };
}

export const stripeProvider: StripeProvider = {
  async createConnectAccount({ email, businessName, storeId }) {
    const stripe = getStripeClient();
    const v2Account = await stripe.v2.core.accounts.create({
      contact_email: email,
      display_name: businessName,
      dashboard: "express",
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
      metadata: { platform_store_id: storeId },
      include: ["configuration.merchant", "requirements"],
    });
    const account = await stripe.accounts.retrieve(v2Account.id);
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
    const account = await stripe.accounts.retrieve(accountId);
    return toConnectAccount(account);
  },

  verifyWebhookSignature({ payload, signature }) {
    const stripe = getStripeClient();
    const secret = getWebhookSecret();
    const event = stripe.webhooks.constructEvent(payload, signature, secret);
    return event as unknown as WebhookEvent;
  },
};
