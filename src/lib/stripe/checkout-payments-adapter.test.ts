import { afterEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());

vi.mock("./provider", () => ({
  getStripeClient: () => ({
    paymentIntents: { create },
  }),
}));

import { getCheckoutPayments } from "./checkout-payments";

afterEach(() => {
  create.mockReset();
  vi.unstubAllEnvs();
});

describe("real checkout payment adapter", () => {
  it("passes setup_future_usage through to Stripe", async () => {
    vi.stubEnv("E2E_FAKE_STRIPE", "");
    vi.stubEnv("VERCEL", "");
    create.mockResolvedValue({
      id: "pi_adapter",
      status: "requires_payment_method",
      amount: 4200,
      currency: "usd",
      client_secret: "sec",
      customer: "cus_adapter",
      setup_future_usage: "on_session",
      payment_method: null,
      metadata: { store_id: "store", cart_id: "cart" },
      on_behalf_of: "acct",
      transfer_data: { destination: "acct" },
    });
    await getCheckoutPayments().createPaymentIntent({
      amount: 4200,
      currency: "usd",
      capture_method: "manual",
      customer: "cus_adapter",
      setup_future_usage: "on_session",
      metadata: { store_id: "store", cart_id: "cart" },
    }, "cart-pi-adapter");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ setup_future_usage: "on_session", customer: "cus_adapter" }),
      { idempotencyKey: "cart-pi-adapter" },
    );
  });
});
