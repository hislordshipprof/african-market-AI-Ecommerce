import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelReplaceablePaymentIntent } from "../checkout/saved-card-payment";
import { fakeCheckoutPayments, resetFakeCheckoutPayments } from "./checkout-payments";

afterEach(() => {
  resetFakeCheckoutPayments();
});

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
});
