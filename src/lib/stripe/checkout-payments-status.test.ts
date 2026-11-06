import { afterEach, describe, expect, it } from "vitest";
import { cancelReplaceablePaymentIntent } from "../checkout/saved-card-payment";
import { fakeCheckoutPayments, resetFakeCheckoutPayments } from "./checkout-payments";

afterEach(() => {
  resetFakeCheckoutPayments();
});

describe("fake payment status machine", () => {
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
});
