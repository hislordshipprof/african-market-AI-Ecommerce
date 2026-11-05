import { afterEach, describe, expect, it, vi } from "vitest";
import { listAccountCards } from "./saved-cards";
import { checkoutPaymentsUseFake } from "../stripe/checkout-payments";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("saved cards when Stripe is not configured", () => {
  it("production without a secret key reports cards unavailable and does not throw", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("E2E_FAKE_STRIPE", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CI", "");
    await expect(listAccountCards("user-without-stripe")).resolves.toEqual({
      unavailable: true,
      cards: [],
    });
  });

  it("the checkout fake stays off on Vercel and in production without CI", () => {
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("CI", "");
    expect(checkoutPaymentsUseFake()).toBe(false);

    vi.stubEnv("VERCEL", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "");
    expect(checkoutPaymentsUseFake()).toBe(false);

    vi.stubEnv("CI", "true");
    vi.stubEnv("VERCEL", "");
    expect(checkoutPaymentsUseFake()).toBe(true);
  });
});
