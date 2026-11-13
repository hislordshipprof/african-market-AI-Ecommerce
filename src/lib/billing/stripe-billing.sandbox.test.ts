import { afterAll, describe, expect, it } from "vitest";
import { getStripeClient } from "../stripe/provider";
import { PLAN_LOOKUP_KEYS, stripeBillingProvider } from "./provider";
import { pilotTrialEnd } from "./service";
import { billingObjects } from "./webhook-objects";

const hasKey = process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") ?? false;

describe.skipIf(!hasKey)("Stripe Billing sandbox (#494)", () => {
  const customers: string[] = [];

  afterAll(async () => {
    const stripe = getStripeClient();
    for (const id of customers) await stripe.customers.del(id).catch(() => undefined);
  });

  it("finds or creates the Starter $49 and Pro $99 monthly prices by lookup key", async () => {
    const prices = await stripeBillingProvider.planPrices();
    const stripe = getStripeClient();
    const starter = await stripe.prices.retrieve(prices.starter);
    const pro = await stripe.prices.retrieve(prices.pro);
    expect([starter.lookup_key, starter.unit_amount, starter.recurring?.interval]).toEqual([PLAN_LOOKUP_KEYS.starter, 4900, "month"]);
    expect([pro.lookup_key, pro.unit_amount, pro.recurring?.interval]).toEqual([PLAN_LOOKUP_KEYS.pro, 9900, "month"]);
  });

  it("a pilot subscription bills nothing for 3 months; the first charge is dated after the trial", async () => {
    const stripe = getStripeClient();
    const prices = await stripeBillingProvider.planPrices();
    const customer = await stripe.customers.create({
      name: "Sandbox pilot store",
      payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" },
      metadata: { platform_store_id: "sandbox-test" },
    });
    customers.push(customer.id);
    const trialEnd = Math.floor(pilotTrialEnd(new Date()).getTime() / 1000);
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: prices.starter }],
      trial_end: trialEnd,
      metadata: { platform_store_id: "sandbox-test" },
    });
    expect(sub.status).toBe("trialing");
    expect(sub.trial_end).toBe(trialEnd);

    const invoices = await stripe.invoices.list({ subscription: sub.id });
    expect(invoices.data.every((invoice) => invoice.amount_due === 0)).toBe(true);

    // The webhook parser reads Stripe's real object shapes.
    expect(billingObjects(sub).subscription).toMatchObject({
      id: sub.id,
      customerId: customer.id,
      status: "trialing",
      lookupKey: PLAN_LOOKUP_KEYS.starter,
      storeId: "sandbox-test",
      trialEnd,
      currentPeriodEnd: trialEnd,
    });
    expect(billingObjects(invoices.data[0]).invoice).toMatchObject({ customerId: customer.id, subscriptionId: sub.id });

    const next = await stripe.invoices.createPreview({ subscription: sub.id });
    expect(next.amount_due).toBe(4900);
    expect(next.period_end).toBeGreaterThanOrEqual(trialEnd);
    expect(next.lines.data[0]?.period.start).toBe(trialEnd);
  }, 30_000);

  it("Checkout and the Customer Portal open for a store's customer", async () => {
    const customerId = await stripeBillingProvider.createCustomer({
      storeId: `sandbox-${Date.now()}`,
      name: "Sandbox store",
      email: "owner@example.test",
    });
    customers.push(customerId);
    const checkout = await stripeBillingProvider.createCheckoutSession({
      customerId,
      plan: "pro",
      storeId: "sandbox-store",
      trialEnd: null,
      successUrl: "https://example.test/ok",
      cancelUrl: "https://example.test/cancel",
    });
    expect(checkout.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const portal = await stripeBillingProvider.createPortalSession({ customerId, returnUrl: "https://example.test/back" });
    expect(portal.url).toMatch(/^https:\/\/billing\.stripe\.com\//);
  }, 30_000);
});
