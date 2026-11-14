import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { sandboxConnectedAccountId } from "./test-sandbox-account";
import { liveSandbox, providerSandbox } from "../test-live-provider";
import { getCheckoutPayments } from "./checkout-payments";
import { planPaymentAttempt } from "../checkout/payment-intent-params";

const hasKey = Boolean(process.env.STRIPE_SECRET_KEY);

const sandbox = providerSandbox("Stripe");

describe.skipIf(!liveSandbox || !hasKey)("saved card sandbox", () => {
  let stripe: Stripe;
  let accountId = "";
  const customers: string[] = [];
  const intents: string[] = [];

  beforeAll(sandbox.hook(async () => {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    accountId = await sandboxConnectedAccountId(stripe);
  }), 120_000);

  afterAll(sandbox.hook(async () => {
    if (!stripe) return;
    for (const id of intents) {
      try { await stripe.paymentIntents.cancel(id); } catch { /* already closed */ }
    }
    for (const id of customers) {
      try { await stripe.customers.del(id); } catch { /* already gone */ }
    }
  }), 60_000);

  it("an unticked confirm attaches nothing and a ticked confirm attaches visa 4242", sandbox.test(async () => {
    const customer = await stripe.customers.create({ metadata: { user_id: `t248-${Date.now()}` } });
    customers.push(customer.id);
    const shared = {
      amount: 500,
      currency: "usd",
      capture_method: "manual" as const,
      customer: customer.id,
      on_behalf_of: accountId,
      transfer_data: { destination: accountId },
    };
    const plain = await stripe.paymentIntents.create(shared);
    intents.push(plain.id);
    const plainConfirmed = await stripe.paymentIntents.confirm(plain.id, {
      payment_method: "pm_card_visa",
      return_url: "https://example.com/return",
    });
    expect(plainConfirmed.status).toBe("requires_capture");
    const afterPlain = await stripe.customers.listPaymentMethods(customer.id, { type: "card" });
    expect(afterPlain.data).toHaveLength(0);

    const saved = await stripe.paymentIntents.create({ ...shared, setup_future_usage: "on_session" });
    intents.push(saved.id);
    const savedConfirmed = await stripe.paymentIntents.confirm(saved.id, {
      payment_method: "pm_card_visa",
      return_url: "https://example.com/return",
    });
    expect(savedConfirmed.status).toBe("requires_capture");
    const afterSaved = await stripe.customers.listPaymentMethods(customer.id, { type: "card" });
    expect(afterSaved.data).toHaveLength(1);
    expect(afterSaved.data[0]?.card?.last4).toBe("4242");
  }), 60_000);

  it("a card saved on the platform customer pays a store's destination hold through the app's own params", sandbox.test(async () => {
    const customer = await stripe.customers.create({ metadata: { user_id: `t311-${Date.now()}` } });
    customers.push(customer.id);
    const first = await stripe.paymentIntents.create({
      amount: 500,
      currency: "usd",
      capture_method: "manual",
      customer: customer.id,
      setup_future_usage: "on_session",
      on_behalf_of: accountId,
      transfer_data: { destination: accountId },
    });
    intents.push(first.id);
    const saved = await stripe.paymentIntents.confirm(first.id, {
      payment_method: "pm_card_visa",
      return_url: "https://example.com/return",
    });
    const card = saved.payment_method as string;

    const plan = planPaymentAttempt({
      existing: null,
      holdCents: 1500,
      storeAccountId: accountId,
      storeId: "store-t311",
      cartId: `cart-t311-${Date.now()}`,
      selection: { actorUserId: "user-t311", stripeCustomerId: customer.id, saveCard: false, paymentMethodId: card, attemptToken: null },
      nextToken: "gen:t311",
      idempotencyKey: `t311-${Date.now()}`,
    });
    if (plan.action !== "create") throw new Error(`expected a create plan, got ${plan.action}`);
    const payments = getCheckoutPayments();
    const created = await payments.createPaymentIntent({ ...plan.params }, plan.idempotencyKey);
    intents.push(created.id);
    // The browser confirms the saved-card intent with Stripe.js; this is the same call.
    await stripe.paymentIntents.confirm(created.id, { payment_method: card, return_url: "https://example.com/return" });
    const held = await payments.retrievePaymentIntent(created.id);
    console.info(`[t311] saved-card destination hold ${held.id}`);
    expect([held.status, held.payment_method, held.on_behalf_of, held.transfer_data?.destination]).toEqual([
      "requires_capture",
      card,
      accountId,
      accountId,
    ]);
  }), 60_000);
});
