import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { sandboxConnectedAccountId } from "./test-sandbox-account";

const hasKey = Boolean(process.env.STRIPE_SECRET_KEY);

describe.skipIf(!hasKey)("saved card sandbox", () => {
  let stripe: Stripe;
  let accountId = "";
  const customers: string[] = [];
  const intents: string[] = [];

  beforeAll(async () => {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
    accountId = await sandboxConnectedAccountId(stripe);
  }, 120_000);

  afterAll(async () => {
    if (!stripe) return;
    for (const id of intents) {
      try { await stripe.paymentIntents.cancel(id); } catch { /* already closed */ }
    }
    for (const id of customers) {
      try { await stripe.customers.del(id); } catch { /* already gone */ }
    }
  }, 60_000);

  it("an unticked confirm attaches nothing and a ticked confirm attaches visa 4242", async () => {
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
  }, 60_000);
});
