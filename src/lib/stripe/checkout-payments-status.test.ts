import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelReplaceablePaymentIntent } from "../checkout/saved-card-payment";
import { fakeCheckoutPayments, resetFakeCheckoutPayments } from "./checkout-payments";
import { fakeStripeProvider, reset as resetFakeStripe } from "./fake";

afterEach(() => {
  resetFakeCheckoutPayments();
  resetFakeStripe();
});

async function authorized(amount: number, key: string) {
  const created = await fakeCheckoutPayments.createPaymentIntent(
    { amount, currency: "usd", capture_method: "manual" },
    key,
  );
  return fakeCheckoutPayments.confirmPaymentIntent(created.id, { payment_method: "pm_card_visa" });
}

describe("fake payment status machine", () => {
  it("confirms a hold from another copy of the module, as a route handler does after a server action", async () => {
    const created = await fakeCheckoutPayments.createPaymentIntent(
      { amount: 4900, currency: "usd" },
      "bundle-key",
    );
    vi.resetModules();
    const other = await import("./checkout-payments");
    expect(other.fakeCheckoutPayments).not.toBe(fakeCheckoutPayments);
    const confirmed = await other.fakeCheckoutPayments.confirmPaymentIntent(created.id, {
      payment_method: "pm_card_visa",
    });
    expect(confirmed.status).toBe("requires_capture");
  });

  it("rejects confirmation of a canceled PaymentIntent and cancels an uncaptured authorization", async () => {
    const created = await fakeCheckoutPayments.createPaymentIntent(
      { amount: 1200, currency: "usd", payment_method: "pm_card_visa" },
      "status-key",
    );
    await fakeCheckoutPayments.cancelPaymentIntent(created.id);
    await expect(
      fakeCheckoutPayments.confirmPaymentIntent(created.id, { payment_method: "pm_card_visa" }),
    ).rejects.toThrow(/status of canceled/);

    const authorized = await fakeCheckoutPayments.createPaymentIntent(
      { amount: 1200, currency: "usd" },
      "status-key-2",
    );
    const confirmed = await fakeCheckoutPayments.confirmPaymentIntent(authorized.id, {
      payment_method: "pm_card_visa",
    });
    expect(confirmed.status).toBe("requires_capture");
    const canceled = await fakeCheckoutPayments.cancelPaymentIntent(authorized.id);
    expect(canceled.status).toBe("canceled");
    await expect(
      cancelReplaceablePaymentIntent(fakeCheckoutPayments, authorized.id),
    ).rejects.toThrow("Payment already confirmed for this cart");
  });

  it("does not cancel a hold that becomes authorized before replacement", async () => {
    const created = await fakeCheckoutPayments.createPaymentIntent(
      { amount: 1200, currency: "usd" },
      "race-key",
    );
    await fakeCheckoutPayments.confirmPaymentIntent(created.id, { payment_method: "pm_card_visa" });
    await expect(
      cancelReplaceablePaymentIntent(fakeCheckoutPayments, created.id),
    ).rejects.toThrow("Payment already confirmed for this cart");
    const after = await fakeCheckoutPayments.retrievePaymentIntent(created.id);
    expect(after.status).toBe("requires_capture");
  });

  it("returns the cached create after cancel, so a new purchase needs a new key", async () => {
    const first = await fakeCheckoutPayments.createPaymentIntent(
      { amount: 1200, currency: "usd", metadata: { cart_id: "cart_1" } },
      "same-key",
    );
    await fakeCheckoutPayments.cancelPaymentIntent(first.id);
    const replay = await fakeCheckoutPayments.createPaymentIntent(
      { amount: 1200, currency: "usd", metadata: { cart_id: "cart_1" } },
      "same-key",
    );
    expect(replay.id).toBe(first.id);
    expect(replay.status).toBe("canceled");
    const fresh = await fakeCheckoutPayments.createPaymentIntent(
      { amount: 1200, currency: "usd", metadata: { cart_id: "cart_1" } },
      "new-key",
    );
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.status).toBe("requires_payment_method");
  });

  it("fake customer and intent ids never repeat after reset, and an idempotent replay keeps its id", async () => {
    const customer = await fakeCheckoutPayments.createCustomer({ metadata: { user_id: "user-1" } }, "cus-key");
    const replayCustomer = await fakeCheckoutPayments.createCustomer({ metadata: { user_id: "user-1" } }, "cus-key");
    expect(replayCustomer.id).toBe(customer.id);
    expect(customer.id.startsWith("cus_fake_")).toBe(true);
    await expect(
      fakeCheckoutPayments.createCustomer({ metadata: { user_id: "user-2" } }, "cus-key"),
    ).rejects.toMatchObject({ code: "idempotency_error" });

    const intent = await fakeCheckoutPayments.createPaymentIntent({ amount: 500, currency: "usd" }, "pi-key");
    const replayIntent = await fakeCheckoutPayments.createPaymentIntent({ amount: 500, currency: "usd" }, "pi-key");
    expect(replayIntent.id).toBe(intent.id);
    expect(intent.id.startsWith("pi_fake_")).toBe(true);
    await expect(
      fakeCheckoutPayments.createPaymentIntent({ amount: 700, currency: "usd" }, "pi-key"),
    ).rejects.toMatchObject({ code: "idempotency_error" });

    resetFakeCheckoutPayments();
    const freshCustomer = await fakeCheckoutPayments.createCustomer({ metadata: { user_id: "user-1" } }, "cus-key");
    const freshIntent = await fakeCheckoutPayments.createPaymentIntent({ amount: 500, currency: "usd" }, "pi-key");
    expect(freshCustomer.id).not.toBe(customer.id);
    expect(freshIntent.id).not.toBe(intent.id);
  });

  // Expected errors were read from the Stripe sandbox on 2026-11-14 (#311).
  it("a declined confirm throws Stripe's card error and leaves the intent payable", async () => {
    const created = await fakeCheckoutPayments.createPaymentIntent({ amount: 1000, currency: "usd" }, "decline-key");
    await expect(
      fakeCheckoutPayments.confirmPaymentIntent(created.id, { payment_method: "pm_card_chargeCustomerFail" }),
    ).rejects.toMatchObject({ type: "StripeCardError", code: "card_declined", statusCode: 402 });
    const after = await fakeCheckoutPayments.retrievePaymentIntent(created.id);
    expect(after.status).toBe("requires_payment_method");
  });

  it("refuses an amount or card change once the intent holds or has ended, but still takes metadata", async () => {
    const held = await authorized(1000, "held-key");
    await expect(fakeCheckoutPayments.updatePaymentIntent(held.id, { amount: 1200 }))
      .rejects.toMatchObject({ type: "StripeInvalidRequestError", code: "payment_intent_unexpected_state" });
    await expect(fakeCheckoutPayments.updatePaymentIntent(held.id, { payment_method: "pm_card_visa" }))
      .rejects.toMatchObject({ code: "payment_intent_unexpected_state" });
    await fakeCheckoutPayments.cancelPaymentIntent(held.id);
    await expect(fakeCheckoutPayments.updatePaymentIntent(held.id, { amount: 1200 }))
      .rejects.toMatchObject({ code: "payment_intent_unexpected_state" });
    const tagged = await fakeCheckoutPayments.updatePaymentIntent(held.id, { metadata: { purchase_epoch: "2" } });
    expect(tagged).toMatchObject({ status: "canceled", amount: 1000, metadata: { purchase_epoch: "2" } });
  });

  it("re-amounting an intent that awaits 3DS sends it back to confirmation", async () => {
    const created = await fakeCheckoutPayments.createPaymentIntent({ amount: 1000, currency: "usd" }, "3ds-key");
    const pending = await fakeCheckoutPayments.confirmPaymentIntent(created.id, {
      payment_method: "pm_card_authenticationRequired",
    });
    expect(pending.status).toBe("requires_action");
    const updated = await fakeCheckoutPayments.updatePaymentIntent(created.id, { amount: 1200 });
    expect(updated).toMatchObject({ status: "requires_confirmation", amount: 1200 });
  });

  it("rejects an amount under Stripe's 50 cent minimum on create and update", async () => {
    await expect(fakeCheckoutPayments.createPaymentIntent({ amount: 30, currency: "usd" }, "small-key"))
      .rejects.toMatchObject({ code: "amount_too_small" });
    const created = await fakeCheckoutPayments.createPaymentIntent({ amount: 1000, currency: "usd" }, "ok-key");
    await expect(fakeCheckoutPayments.updatePaymentIntent(created.id, { amount: 30 }))
      .rejects.toMatchObject({ code: "amount_too_small" });
  });

  it("captures a checkout hold up to what was authorized and no more", async () => {
    const held = await authorized(1000, "capture-key");
    await expect(fakeStripeProvider.capturePaymentIntent(held.id, 1200))
      .rejects.toMatchObject({ code: "amount_too_large" });
    await expect(fakeStripeProvider.capturePaymentIntent(held.id, 1000))
      .resolves.toMatchObject({ amountCaptured: 1000, status: "succeeded" });
  });

  it("one saved card authorizes holds for two different store destinations", async () => {
    const customer = await fakeCheckoutPayments.createCustomer({ metadata: { user_id: "user-1" } }, "cus-dest");
    const first = await fakeCheckoutPayments.createPaymentIntent(
      { amount: 1000, currency: "usd", customer: customer.id, setup_future_usage: "on_session" },
      "save-key",
    );
    const saved = await fakeCheckoutPayments.confirmPaymentIntent(first.id, { payment_method: "pm_card_visa" });
    const card = saved.payment_method!;
    const holds = [];
    for (const destination of ["acct_store_a", "acct_store_b"]) {
      const intent = await fakeCheckoutPayments.createPaymentIntent(
        {
          amount: 1500,
          currency: "usd",
          customer: customer.id,
          payment_method: card,
          on_behalf_of: destination,
          transfer_data: { destination },
        },
        `dest-${destination}`,
      );
      holds.push(await fakeCheckoutPayments.confirmPaymentIntent(intent.id));
    }
    expect(holds.map((h) => [h.status, h.payment_method, h.transfer_data?.destination])).toEqual([
      ["requires_capture", card, "acct_store_a"],
      ["requires_capture", card, "acct_store_b"],
    ]);
  });
});
