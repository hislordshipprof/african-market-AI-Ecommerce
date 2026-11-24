import { describe, expect, it } from "vitest";
import { paymentReadiness } from "./payment-ready";

describe("paymentReadiness (#783 AC4)", () => {
  it("a new card is ready only once Stripe.js and the Payment Element have both loaded", () => {
    expect(paymentReadiness({ stripe: "loading", cardForm: true, element: "loading" })).toBe("loading");
    expect(paymentReadiness({ stripe: "ready", cardForm: true, element: "loading" })).toBe("loading");
    expect(paymentReadiness({ stripe: "ready", cardForm: true, element: "ready" })).toBe("ready");
  });

  it("a saved card needs Stripe.js but never waits on the card form it does not show", () => {
    expect(paymentReadiness({ stripe: "ready", cardForm: false, element: "loading" })).toBe("ready");
    expect(paymentReadiness({ stripe: "loading", cardForm: false, element: "ready" })).toBe("loading");
  });

  it("fails when Stripe.js cannot load, or when the card form a shopper needs cannot", () => {
    expect(paymentReadiness({ stripe: "failed", cardForm: false, element: "loading" })).toBe("failed");
    expect(paymentReadiness({ stripe: "ready", cardForm: true, element: "failed" })).toBe("failed");
    expect(paymentReadiness({ stripe: "ready", cardForm: false, element: "failed" })).toBe("ready");
  });
});
