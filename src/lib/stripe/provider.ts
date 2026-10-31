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
    const account = await stripe.accounts.create({
      type: "express",
      email,
      business_profile: { name: businessName },
      metadata: { platform_store_id: storeId },
    });
    return toConnectAccount(account);
  },

  async createAccountLink({ accountId, returnUrl, refreshUrl }) {
    const stripe = getStripeClient();
    const link = await stripe.accountLinks.create({
      account: accountId,
      return_url: returnUrl,
      refresh_url: refreshUrl,
      type: "account_onboarding",
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
