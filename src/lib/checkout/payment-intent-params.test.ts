import { describe, expect, it } from "vitest";
import { guestPaymentIntentParams, planPaymentAttempt } from "./payment-intent-params";

const base = {
  holdCents: 4200,
  storeAccountId: "acct_store",
  storeId: "store_1",
  cartId: "cart_1",
};

describe("payment intent params", () => {
  it("guest PI params equal main's exactly; tick adds customer and on_session; saved card adds customer and payment_method without setup_future_usage", () => {
    expect(guestPaymentIntentParams(base)).toEqual({
      amount: 4200,
      currency: "usd",
      capture_method: "manual",
      on_behalf_of: "acct_store",
      transfer_data: { destination: "acct_store" },
      metadata: { store_id: "store_1", cart_id: "cart_1" },
    });

    const ticked = planPaymentAttempt({
      existing: null,
      ...base,
      selection: {
        actorUserId: "user_1",
        stripeCustomerId: "cus_1",
        saveCard: true,
        paymentMethodId: null,
        attemptToken: null,
      },
      nextToken: "attempt_1",
      idempotencyKey: "attempt_1",
    });
    expect(ticked.action).toBe("create");
    if (ticked.action !== "create") return;
    expect(ticked.params.customer).toBe("cus_1");
    expect(ticked.params.setup_future_usage).toBe("on_session");
    expect(ticked.params.payment_method).toBeUndefined();
    expect(ticked.params.metadata.user_id).toBe("user_1");

    const saved = planPaymentAttempt({
      existing: null,
      ...base,
      selection: {
        actorUserId: "user_1",
        stripeCustomerId: "cus_1",
        saveCard: true,
        paymentMethodId: "pm_1",
        attemptToken: null,
      },
      nextToken: "attempt_2",
      idempotencyKey: "attempt_2",
    });
    expect(saved.action).toBe("create");
    if (saved.action !== "create") return;
    expect(saved.params.customer).toBe("cus_1");
    expect(saved.params.payment_method).toBe("pm_1");
    expect(saved.params.setup_future_usage).toBeUndefined();
  });

  it("a matching attempt token clears save intent and a stale token replaces the PaymentIntent", () => {
    const existing = {
      id: "pi_1",
      status: "requires_payment_method",
      amount: 4200,
      currency: "usd",
      customer: "cus_1",
      setup_future_usage: "on_session",
      payment_method: null,
      client_secret: "pi_1_secret",
      metadata: { store_id: "store_1", cart_id: "cart_1", attempt_token: "attempt_1", user_id: "user_1" },
    };
    const cleared = planPaymentAttempt({
      existing,
      ...base,
      selection: {
        actorUserId: "user_1",
        stripeCustomerId: "cus_1",
        saveCard: false,
        paymentMethodId: null,
        attemptToken: "attempt_1",
      },
      nextToken: "attempt_2",
      idempotencyKey: "attempt_2",
    });
    expect(cleared.action).toBe("update");
    if (cleared.action !== "update") return;
    expect(cleared.params.setup_future_usage).toBe("");
    expect(cleared.paymentIntentId).toBe("pi_1");

    const replaced = planPaymentAttempt({
      existing,
      ...base,
      selection: {
        actorUserId: "user_1",
        stripeCustomerId: "cus_2",
        saveCard: true,
        paymentMethodId: null,
        attemptToken: null,
      },
      nextToken: "attempt_3",
      idempotencyKey: "attempt_3",
    });
    expect(replaced.action).toBe("replace");
    if (replaced.action !== "replace") return;
    expect(replaced.cancelId).toBe("pi_1");

    const held = planPaymentAttempt({
      existing: { ...existing, status: "requires_capture" },
      ...base,
      selection: {
        actorUserId: "user_1",
        stripeCustomerId: "cus_2",
        saveCard: true,
        paymentMethodId: null,
        attemptToken: null,
      },
      nextToken: "attempt_4",
      idempotencyKey: "attempt_4",
    });
    expect(held).toEqual({ action: "blocked", reason: "already_confirmed" });
  });
});
