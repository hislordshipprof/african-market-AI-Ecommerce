import { describe, expect, it } from "vitest";
import { cartPaymentIdempotencyKey } from "../customer-account/consent";
import {
  guestPaymentIntentParams,
  nextAttemptToken,
  planPaymentAttempt,
} from "./payment-intent-params";

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

  it("a capability change replaces the PaymentIntent and a stale customer replaces it", () => {
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
    expect(cleared.action).toBe("replace");
    if (cleared.action !== "replace") return;
    expect(cleared.cancelId).toBe("pi_1");
    expect(cleared.params.setup_future_usage).toBeUndefined();

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

  it("reuses the same selection and only updates the amount when capabilities match", () => {
    const existing = {
      id: "pi_1",
      status: "requires_payment_method",
      amount: 4200,
      currency: "usd",
      customer: null,
      setup_future_usage: null,
      payment_method: null,
      client_secret: "pi_1_secret",
      metadata: { store_id: "store_1", cart_id: "cart_1", attempt_token: "attempt_1" },
    };
    const selection = {
      actorUserId: "user_1",
      stripeCustomerId: null,
      saveCard: false,
      paymentMethodId: null,
      attemptToken: "attempt_1",
    };
    const reused = planPaymentAttempt({
      existing,
      ...base,
      selection,
      nextToken: "attempt_2",
      idempotencyKey: "attempt_2",
    });
    expect(reused).toMatchObject({ action: "reuse", paymentIntentId: "pi_1", clientSecret: "pi_1_secret" });

    const amount = planPaymentAttempt({
      existing,
      ...base,
      holdCents: 5000,
      selection,
      nextToken: "attempt_2",
      idempotencyKey: "attempt_2",
    });
    expect(amount).toMatchObject({
      action: "update",
      paymentIntentId: "pi_1",
      params: { amount: 5000 },
    });
  });

  it("leaves a PaymentIntent from another cart untouched", () => {
    const foreign = planPaymentAttempt({
      existing: {
        id: "pi_foreign",
        status: "requires_payment_method",
        amount: 4200,
        currency: "usd",
        customer: null,
        setup_future_usage: null,
        payment_method: null,
        client_secret: "foreign_secret",
        on_behalf_of: "acct_other",
        transfer_data: { destination: "acct_other" },
        metadata: { store_id: "store_other", cart_id: "cart_other", attempt_token: "attempt_1" },
      },
      ...base,
      selection: {
        actorUserId: "user_1",
        stripeCustomerId: null,
        saveCard: false,
        paymentMethodId: null,
        attemptToken: "attempt_1",
      },
      nextToken: "attempt_new",
      idempotencyKey: "attempt_new",
    });
    expect(foreign.action).toBe("create");
    if (foreign.action !== "create") return;
    expect(foreign.params.metadata.cart_id).toBe("cart_1");
  });

  it("reuses a key only for the generation that has not recorded a PaymentIntent", () => {
    const fingerprint = "4200||nosave|";
    const stored = `gen:one:${fingerprint}`;
    expect(nextAttemptToken({
      paymentIntentId: null,
      storedToken: stored,
      fingerprint,
      forceNew: false,
    })).toBe(stored);
    const created = nextAttemptToken({
      paymentIntentId: "pi_1",
      storedToken: stored,
      fingerprint,
      forceNew: false,
    });
    expect(created).not.toBe(stored);
    expect(cartPaymentIdempotencyKey("cart_1", stored)).not.toBe(cartPaymentIdempotencyKey("cart_1", created));
  });
});
