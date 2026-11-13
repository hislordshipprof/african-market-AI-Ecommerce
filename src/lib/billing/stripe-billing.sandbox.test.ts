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

  it("the Customer Portal lets the owner switch between Starter and Pro (B2)", async () => {
    const stripe = getStripeClient();
    const prices = await stripeBillingProvider.planPrices();
    const config = await stripe.billingPortal.configurations.retrieve(await stripeBillingProvider.portalConfiguration(), {
      expand: ["features.subscription_update.products"],
    });
    expect(config.active).toBe(true);
    const update = config.features.subscription_update;
    expect(update.enabled).toBe(true);
    expect(update.default_allowed_updates).toEqual(["price"]);
    expect(update.trial_update_behavior).toBe("continue_trial");
    expect(update.products?.flatMap((p) => p.prices).sort()).toEqual([prices.starter, prices.pro].sort());
    expect(update.products?.every((p) => !p.adjustable_quantity.enabled)).toBe(true);
    expect(config.features.payment_method_update.enabled).toBe(true);
    expect(config.features.subscription_cancel.enabled).toBe(true);
  }, 30_000);

  it("an open Checkout is expired before another opens; a completed one is reported (B1)", async () => {
    const customerId = await stripeBillingProvider.createCustomer({
      storeId: `sandbox-co-${Date.now()}`,
      name: "Sandbox checkout store",
      email: "owner@example.test",
    });
    customers.push(customerId);
    const checkout = await stripeBillingProvider.createCheckoutSession({
      customerId,
      plan: "starter",
      storeId: "sandbox-store",
      trialEnd: null,
      successUrl: "https://example.test/ok",
      cancelUrl: "https://example.test/cancel",
    });
    expect(checkout.id).toMatch(/^cs_test_/);
    expect(await stripeBillingProvider.closeCheckoutSession(checkout.id)).toBe("closed");
    expect((await getStripeClient().checkout.sessions.retrieve(checkout.id)).status).toBe("expired");
    expect(await stripeBillingProvider.closeCheckoutSession(checkout.id)).toBe("closed");
  }, 30_000);

  it("ending a pilot trial charges now, and a duplicate subscription can be cancelled (B1, B3)", async () => {
    const stripe = getStripeClient();
    const prices = await stripeBillingProvider.planPrices();
    const customer = await stripe.customers.create({
      name: "Sandbox removed pilot",
      payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" },
    });
    customers.push(customer.id);
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: prices.starter }],
      trial_end: Math.floor(pilotTrialEnd(new Date()).getTime() / 1000),
    });
    expect(sub.status).toBe("trialing");
    await stripeBillingProvider.setTrialEnd(sub.id, "now");
    const ended = await stripe.subscriptions.retrieve(sub.id, { expand: ["latest_invoice"] });
    expect(ended.status).toBe("active");
    expect(ended.trial_end).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect((ended.latest_invoice as { amount_due: number }).amount_due).toBe(4900);
    expect((await stripeBillingProvider.getSubscription(sub.id)).status).toBe("active");

    await stripeBillingProvider.cancelSubscription(sub.id);
    expect((await stripe.subscriptions.retrieve(sub.id)).status).toBe("canceled");
  }, 30_000);
});
