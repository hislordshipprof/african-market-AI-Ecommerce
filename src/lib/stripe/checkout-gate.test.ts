import { describe, it, expect } from "vitest";
import { checkCheckoutReady, checkoutTakesPayment, STORE_OPENING_SOON } from "./checkout-gate";

const live = (stripeOnboardingStatus: string) => ({ status: "active", stripeOnboardingStatus });

describe("checkCheckoutReady (checkout gate)", () => {
  it("returns enabled for a live store with complete payouts", () => {
    const result = checkCheckoutReady(live("complete"));
    expect(result.enabled).toBe(true);
    expect(result.message).toBeNull();
  });

  it("returns disabled while payouts are not_started, pending or restricted", () => {
    for (const status of ["not_started", "pending", "restricted"]) {
      expect(checkCheckoutReady(live(status))).toEqual({ enabled: false, message: "This store is not yet accepting online orders" });
    }
  });

  it("a store in setup is opening soon, even with payouts complete (#555)", () => {
    expect(checkCheckoutReady({ status: "setup", stripeOnboardingStatus: "complete" })).toEqual({ enabled: false, message: STORE_OPENING_SOON });
  });

  it("a suspended store is offline, whatever else is true (#555)", () => {
    expect(checkCheckoutReady({ status: "suspended", stripeOnboardingStatus: "complete" })).toEqual({
      enabled: false,
      message: "This store is temporarily offline.",
    });
  });
});

describe("checkoutTakesPayment", () => {
  it("takes payment only for a live, onboarded store with a publishable key or the harness", () => {
    expect(checkoutTakesPayment(live("complete"), "pk_test_x", false)).toBe(true);
    expect(checkoutTakesPayment(live("complete"), undefined, true)).toBe(true);
    expect(checkoutTakesPayment(live("complete"), "", false)).toBe(false);
    expect(checkoutTakesPayment(live("pending"), "pk_test_x", true)).toBe(false);
    expect(checkoutTakesPayment({ status: "setup", stripeOnboardingStatus: "complete" }, "pk_test_x", true)).toBe(false);
  });
});
