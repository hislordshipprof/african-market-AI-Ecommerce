import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeStripeProvider } from "./fake";
import { getStripeProvider, setStripeProvider } from "./index";
import { stripeProvider } from "./provider";

describe("production Stripe provider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setStripeProvider(null);
  });

  it("throws at call time when NODE_ENV=production and the secret key is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_FAKE_STRIPE", "");
    vi.stubEnv("CI", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    setStripeProvider(null);

    const provider = getStripeProvider();
    await expect(provider.capturePaymentIntent("pi_prod_missing", 500, "k")).rejects.toThrow(
      /STRIPE_SECRET_KEY/,
    );
  });

  it("uses the fake in production only when CI e2e asks for it and Vercel is unset", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("CI", "true");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    setStripeProvider(null);

    expect(getStripeProvider()).toBe(fakeStripeProvider);
  });

  it("throws when the CI e2e flag is set on Vercel and the key is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("CI", "true");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    setStripeProvider(null);

    const provider = getStripeProvider();
    await expect(provider.capturePaymentIntent("pi_vercel_ci", 500, "k")).rejects.toThrow(
      /STRIPE_SECRET_KEY/,
    );
  });

  it("throws when the e2e flag is set in production without CI", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("CI", "");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    setStripeProvider(null);

    const provider = getStripeProvider();
    await expect(provider.capturePaymentIntent("pi_prod_no_ci", 500, "k")).rejects.toThrow(
      /STRIPE_SECRET_KEY/,
    );
  });

  it("throws at call time when VERCEL is set and the secret key is missing", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CI", "true");
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
