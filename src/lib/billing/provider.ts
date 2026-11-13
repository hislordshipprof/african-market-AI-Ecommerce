import { getStripeClient } from "../stripe/provider";
import { stripeProviderKind } from "../stripe";
import type { Plan } from "./plan";

/** Prices are found by lookup key, never by a hard-coded price id. */
export const PLAN_LOOKUP_KEYS: Record<Plan, string> = {
  starter: "store_plan_starter_monthly",
  pro: "store_plan_pro_monthly",
};

const PLAN_PRODUCTS: Record<Plan, { name: string; cents: number }> = {
  starter: { name: "Starter store plan", cents: 4900 },
  pro: { name: "Pro store plan", cents: 9900 },
};

export function planForLookupKey(key: string | null): Plan | null {
  if (key === PLAN_LOOKUP_KEYS.starter) return "starter";
  if (key === PLAN_LOOKUP_KEYS.pro) return "pro";
  return null;
}

export interface BillingProvider {
  /** Finds both monthly prices, creating the products and prices once if missing. */
  planPrices(): Promise<Record<Plan, string>>;
  createCustomer(input: { storeId: string; name: string; email: string }): Promise<string>;
  /** Hosted Checkout for a new subscription; `trialEnd` (Unix seconds) gives the pilot's free months. */
  createCheckoutSession(input: {
    customerId: string;
    plan: Plan;
    storeId: string;
    trialEnd: number | null;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string }>;
  /** Customer Portal: change plan, card, or cancel. */
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Moves an existing subscription's trial end (pilot granted after subscribing). */
  setTrialEnd(subscriptionId: string, trialEnd: number): Promise<void>;
}

let cachedPrices: Record<Plan, string> | null = null;

export const stripeBillingProvider: BillingProvider = {
  async planPrices() {
    if (cachedPrices) return cachedPrices;
    const stripe = getStripeClient();
    const found = await stripe.prices.list({
      lookup_keys: Object.values(PLAN_LOOKUP_KEYS),
      active: true,
      limit: 10,
    });
    const prices = {} as Record<Plan, string>;
    for (const plan of ["starter", "pro"] as const) {
      const existing = found.data.find((p) => p.lookup_key === PLAN_LOOKUP_KEYS[plan]);
      if (existing) {
        prices[plan] = existing.id;
        continue;
      }
      const product = await stripe.products.create(
        { name: PLAN_PRODUCTS[plan].name, metadata: { platform_plan: plan } },
        { idempotencyKey: `plan-product-${plan}-v1` },
      );
      const price = await stripe.prices.create(
        {
          product: product.id,
          currency: "usd",
          unit_amount: PLAN_PRODUCTS[plan].cents,
          recurring: { interval: "month" },
          lookup_key: PLAN_LOOKUP_KEYS[plan],
        },
        { idempotencyKey: `plan-price-${plan}-v1` },
      );
      prices[plan] = price.id;
    }
    cachedPrices = prices;
    return prices;
  },

  async createCustomer({ storeId, name, email }) {
    const stripe = getStripeClient();
    const customer = await stripe.customers.create(
      { name, email, metadata: { platform_store_id: storeId } },
      { idempotencyKey: `store-customer-${storeId}` },
    );
    return customer.id;
  },

  async createCheckoutSession({ customerId, plan, storeId, trialEnd, successUrl, cancelUrl }) {
    const stripe = getStripeClient();
    const prices = await this.planPrices();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: prices[plan], quantity: 1 }],
      subscription_data: {
        metadata: { platform_store_id: storeId },
        ...(trialEnd ? { trial_end: trialEnd } : {}),
      },
      payment_method_collection: "always",
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    if (!session.url) throw new Error("Stripe Checkout returned no URL");
    return { url: session.url };
  },

  async createPortalSession({ customerId, returnUrl }) {
    const stripe = getStripeClient();
    const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
    return { url: session.url };
  },

  async setTrialEnd(subscriptionId, trialEnd) {
    const stripe = getStripeClient();
    await stripe.subscriptions.update(subscriptionId, { trial_end: trialEnd, proration_behavior: "none" });
  },
};

/** In-memory double with Stripe's rules: unknown customers and subscriptions are refused, trials must be in the future. */
export function createFakeBillingProvider() {
  const customers = new Map<string, string>();
  const subscriptions = new Set<string>();
  const trialEnds = new Map<string, number>();
  let seq = 0;
  const missing = (kind: string, id: string) =>
    Object.assign(new Error(`No such ${kind}: '${id}'`), { code: "resource_missing", statusCode: 404 });
  const provider: BillingProvider & {
    addSubscription(id: string): void;
    trialEndOf(id: string): number | undefined;
    checkouts: { customerId: string; plan: Plan; storeId: string; trialEnd: number | null }[];
  } = {
    checkouts: [],
    addSubscription(id) {
      subscriptions.add(id);
    },
    trialEndOf(id) {
      return trialEnds.get(id);
    },
    async planPrices() {
      return { starter: "price_fake_starter", pro: "price_fake_pro" };
    },
    async createCustomer({ storeId }) {
      const existing = customers.get(storeId);
      if (existing) return existing;
      const id = `cus_fake_${++seq}`;
      customers.set(storeId, id);
      return id;
    },
    async createCheckoutSession(input) {
      if (![...customers.values()].includes(input.customerId)) throw missing("customer", input.customerId);
      if (input.trialEnd !== null && input.trialEnd * 1000 <= Date.now()) {
        throw Object.assign(new Error("trial_end must be in the future"), { code: "parameter_invalid_integer" });
      }
      provider.checkouts.push({ customerId: input.customerId, plan: input.plan, storeId: input.storeId, trialEnd: input.trialEnd });
      return { url: `https://checkout.stripe.test/c/${++seq}` };
    },
    async createPortalSession({ customerId }) {
      if (![...customers.values()].includes(customerId)) throw missing("customer", customerId);
      return { url: `https://billing.stripe.test/p/${++seq}` };
    },
    async setTrialEnd(subscriptionId, trialEnd) {
      if (!subscriptions.has(subscriptionId)) throw missing("subscription", subscriptionId);
      if (trialEnd * 1000 <= Date.now()) {
        throw Object.assign(new Error("trial_end must be in the future"), { code: "parameter_invalid_integer" });
      }
      trialEnds.set(subscriptionId, trialEnd);
    },
  };
  return provider;
}

let override: BillingProvider | null = null;
let e2eFake: BillingProvider | null = null;

export function setBillingProvider(provider: BillingProvider | null): void {
  override = provider;
}

export function getBillingProvider(): BillingProvider {
  if (override) return override;
  if (stripeProviderKind() === "fake") return (e2eFake ??= createFakeBillingProvider());
  return stripeBillingProvider;
}
