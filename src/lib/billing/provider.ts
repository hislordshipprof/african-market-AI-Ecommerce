import { getStripeClient } from "../stripe/provider";
import { stripeProviderKind } from "../stripe";
import type { WebhookSubscription } from "../stripe/types";
import type { Plan } from "./plan";
import { billingObjects } from "./webhook-objects";

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

/** The Portal configuration that allows switching between the two plans; found by this metadata key. */
const PORTAL_CONFIG_KEY = "store_plans_v1";

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
  }): Promise<{ id: string; url: string }>;
  /** Expires a Checkout that is still open. "complete" means the owner already paid in it. */
  closeCheckoutSession(sessionId: string): Promise<"closed" | "complete">;
  /** Customer Portal: switch between Starter and Pro (prorated), change card, or cancel. */
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Moves a subscription's trial end: a date (pilot granted after subscribing) or "now" (pilot removed). */
  setTrialEnd(subscriptionId: string, trialEnd: number | "now"): Promise<void>;
  /** Stripe's current state of a subscription. */
  getSubscription(subscriptionId: string): Promise<WebhookSubscription>;
  /** Cancels a subscription at once (a duplicate the store must not pay twice for). */
  cancelSubscription(subscriptionId: string): Promise<void>;
}

let cachedPlans: Record<Plan, { price: string; product: string }> | null = null;
let cachedPortalConfig: string | null = null;

async function planCatalog(): Promise<Record<Plan, { price: string; product: string }>> {
  if (cachedPlans) return cachedPlans;
  const stripe = getStripeClient();
  const found = await stripe.prices.list({
    lookup_keys: Object.values(PLAN_LOOKUP_KEYS),
    active: true,
    limit: 10,
  });
  const plans = {} as Record<Plan, { price: string; product: string }>;
  for (const plan of ["starter", "pro"] as const) {
    const existing = found.data.find((p) => p.lookup_key === PLAN_LOOKUP_KEYS[plan]);
    if (existing) {
      plans[plan] = { price: existing.id, product: typeof existing.product === "string" ? existing.product : existing.product.id };
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
    plans[plan] = { price: price.id, product: product.id };
  }
  cachedPlans = plans;
  return plans;
}

export const stripeBillingProvider: BillingProvider & { portalConfiguration(): Promise<string> } = {
  async planPrices() {
    const plans = await planCatalog();
    return { starter: plans.starter.price, pro: plans.pro.price };
  },

  /**
   * Finds or creates the Portal configuration that lists both plans (the account default allows no plan change),
   * and brings it in line with these features once per process.
   */
  async portalConfiguration() {
    if (cachedPortalConfig) return cachedPortalConfig;
    const stripe = getStripeClient();
    const plans = await planCatalog();
    const features = {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" as const },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price" as const],
        proration_behavior: "create_prorations" as const,
        // A pilot store switching plans keeps its free months.
        trial_update_behavior: "continue_trial" as const,
        products: (["starter", "pro"] as const).map((plan) => ({
          product: plans[plan].product,
          prices: [plans[plan].price],
          adjustable_quantity: { enabled: false },
        })),
      },
    };
    for await (const config of stripe.billingPortal.configurations.list({ active: true, limit: 100 })) {
      if (config.metadata?.platform_key === PORTAL_CONFIG_KEY) {
        await stripe.billingPortal.configurations.update(config.id, { features });
        return (cachedPortalConfig = config.id);
      }
    }
    const config = await stripe.billingPortal.configurations.create(
      { metadata: { platform_key: PORTAL_CONFIG_KEY }, features },
      { idempotencyKey: `portal-config-${PORTAL_CONFIG_KEY}` },
    );
    return (cachedPortalConfig = config.id);
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
    return { id: session.id, url: session.url };
  },

  async closeCheckoutSession(sessionId) {
    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.status === "complete") return "complete";
    if (session.status === "open") {
      const expired = await stripe.checkout.sessions.expire(sessionId).catch(async (err) => {
        // Completed between the read and the expire.
        if ((await stripe.checkout.sessions.retrieve(sessionId)).status === "complete") return null;
        throw err;
      });
      if (!expired) return "complete";
    }
    return "closed";
  },

  async createPortalSession({ customerId, returnUrl }) {
    const stripe = getStripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      configuration: await this.portalConfiguration(),
    });
    return { url: session.url };
  },

  async setTrialEnd(subscriptionId, trialEnd) {
    const stripe = getStripeClient();
    await stripe.subscriptions.update(subscriptionId, { trial_end: trialEnd, proration_behavior: "none" });
  },

  async getSubscription(subscriptionId) {
    const sub = await getStripeClient().subscriptions.retrieve(subscriptionId);
    const parsed = billingObjects(sub).subscription;
    if (!parsed) throw new Error(`Stripe returned no subscription for ${subscriptionId}`);
    return parsed;
  },

  async cancelSubscription(subscriptionId) {
    await getStripeClient().subscriptions.cancel(subscriptionId);
  },
};

/** In-memory double with Stripe's rules: unknown customers and subscriptions are refused, trials must be in the future. */
export function createFakeBillingProvider() {
  const customers = new Map<string, string>();
  const subscriptions = new Set<string>();
  const states = new Map<string, WebhookSubscription>();
  const trialEnds = new Map<string, number | "now">();
  let seq = 0;
  const missing = (kind: string, id: string) =>
    Object.assign(new Error(`No such ${kind}: '${id}'`), { code: "resource_missing", statusCode: 404 });
  const provider: BillingProvider & {
    addSubscription(id: string): void;
    setSubscription(sub: WebhookSubscription): void;
    trialEndOf(id: string): number | "now" | undefined;
    completeCheckout(id: string): void;
    checkouts: { id: string; status: "open" | "complete" | "expired"; customerId: string; plan: Plan; storeId: string; trialEnd: number | null }[];
    canceled: Set<string>;
  } = {
    checkouts: [],
    canceled: new Set(),
    addSubscription(id) {
      subscriptions.add(id);
    },
    setSubscription(sub) {
      subscriptions.add(sub.id);
      states.set(sub.id, sub);
    },
    completeCheckout(id) {
      const checkout = provider.checkouts.find((c) => c.id === id);
      if (checkout) checkout.status = "complete";
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
      const id = `cus_fake_${storeId}`;
      customers.set(storeId, id);
      return id;
    },
    async createCheckoutSession(input) {
      if (![...customers.values()].includes(input.customerId)) throw missing("customer", input.customerId);
      if (input.trialEnd !== null && input.trialEnd * 1000 <= Date.now()) {
        throw Object.assign(new Error("trial_end must be in the future"), { code: "parameter_invalid_integer" });
      }
      const id = `cs_fake_${++seq}`;
      provider.checkouts.push({ id, status: "open", customerId: input.customerId, plan: input.plan, storeId: input.storeId, trialEnd: input.trialEnd });
      return { id, url: `https://checkout.stripe.test/c/${seq}` };
    },
    async closeCheckoutSession(id) {
      const checkout = provider.checkouts.find((c) => c.id === id);
      if (!checkout) throw missing("checkout session", id);
      if (checkout.status === "complete") return "complete";
      checkout.status = "expired";
      return "closed";
    },
    async createPortalSession({ customerId }) {
      if (![...customers.values()].includes(customerId)) throw missing("customer", customerId);
      return { url: `https://billing.stripe.test/p/${++seq}` };
    },
    async setTrialEnd(subscriptionId, trialEnd) {
      if (!subscriptions.has(subscriptionId)) throw missing("subscription", subscriptionId);
      if (trialEnd !== "now" && trialEnd * 1000 <= Date.now()) {
        throw Object.assign(new Error("trial_end must be in the future"), { code: "parameter_invalid_integer" });
      }
      trialEnds.set(subscriptionId, trialEnd);
    },
    async getSubscription(id) {
      const state = states.get(id);
      if (!state) throw missing("subscription", id);
      return state;
    },
    async cancelSubscription(id) {
      provider.canceled.add(id);
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
