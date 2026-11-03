import { afterEach, describe, expect, it, vi } from "vitest";
import { getStripeProvider, setStripeProvider } from "./index";
import { stripeProvider } from "./provider";

describe("production Stripe provider never falls back to the fake", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setStripeProvider(null);
  });

  it("throws at call time when NODE_ENV=production and the secret key is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    setStripeProvider(null);

    const provider = getStripeProvider();
    await expect(provider.capturePaymentIntent("pi_prod_missing", 500, "k")).rejects.toThrow(
      /STRIPE_SECRET_KEY/,
    );
  });

  it("throws at call time when VERCEL is set and the secret key is missing", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    setStripeProvider(null);

    const provider = getStripeProvider();
    await expect(provider.retrievePaymentIntent("pi_vercel_missing")).rejects.toThrow(
      /STRIPE_SECRET_KEY/,
    );
  });

  it("returns the real provider in production when the key is present and the fake is not requested", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_FAKE_STRIPE", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_present");
    setStripeProvider(null);

    expect(getStripeProvider()).toBe(stripeProvider);
  });

  it("ignores the fake flag on Vercel even when a key is present", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_present");
    setStripeProvider(null);

    expect(getStripeProvider()).toBe(stripeProvider);
  });
});
