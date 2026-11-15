import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeStripeProvider } from "./fake";
import { getStripeProvider, setStripeProvider, type StripeSelection } from "./index";
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

describe("fake Stripe selection", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    setStripeProvider(null);
  });

  type Env = { NODE_ENV: string; VERCEL?: string; CI?: string; E2E_FAKE_STRIPE?: string; STRIPE_SECRET_KEY?: string };
  // Written out by hand from the policy, not computed, so a policy mistake cannot pass in both places.
  const cases: Array<[Env, StripeSelection]> = [
    [{ NODE_ENV: "development" }, "real"],
    [{ NODE_ENV: "development", E2E_FAKE_STRIPE: "1" }, "fake"],
    [{ NODE_ENV: "test", E2E_FAKE_STRIPE: "1" }, "fake"],
    [{ NODE_ENV: "test", CI: "true", E2E_FAKE_STRIPE: "1", STRIPE_SECRET_KEY: "sk_test_present" }, "fake"],
    [{ NODE_ENV: "development", VERCEL: "1", E2E_FAKE_STRIPE: "1" }, "unconfigured"],
    [{ NODE_ENV: "development", VERCEL: "1", E2E_FAKE_STRIPE: "1", STRIPE_SECRET_KEY: "sk_test_present" }, "real"],
    [{ NODE_ENV: "test", VERCEL: "1" }, "unconfigured"],
    [{ NODE_ENV: "production" }, "unconfigured"],
    [{ NODE_ENV: "production", STRIPE_SECRET_KEY: "sk_test_present" }, "real"],
    [{ NODE_ENV: "production", CI: "true", E2E_FAKE_STRIPE: "1" }, "fake"],
    [{ NODE_ENV: "production", CI: "1", E2E_FAKE_STRIPE: "1" }, "unconfigured"],
    [{ NODE_ENV: "production", CI: "1", E2E_FAKE_STRIPE: "1", STRIPE_SECRET_KEY: "sk_test_present" }, "real"],
    [{ NODE_ENV: "production", E2E_FAKE_STRIPE: "1", STRIPE_SECRET_KEY: "sk_test_present" }, "real"],
    [{ NODE_ENV: "production", VERCEL: "1", CI: "true", E2E_FAKE_STRIPE: "1" }, "unconfigured"],
  ];

  it("selects the fake, real or unconfigured provider for each listed environment", async () => {
    for (const [env, kind] of cases) {
      vi.stubEnv("NODE_ENV", env.NODE_ENV);
      vi.stubEnv("VERCEL", env.VERCEL ?? "");
      vi.stubEnv("CI", env.CI ?? "");
      vi.stubEnv("E2E_FAKE_STRIPE", env.E2E_FAKE_STRIPE ?? "");
      vi.stubEnv("STRIPE_SECRET_KEY", env.STRIPE_SECRET_KEY ?? "");
      setStripeProvider(null);
      const provider = getStripeProvider();
      if (kind === "fake") {
        expect(provider, JSON.stringify(env)).toBe(fakeStripeProvider);
      } else if (kind === "real") {
        expect(provider, JSON.stringify(env)).toBe(stripeProvider);
      } else {
        await expect(provider.capturePaymentIntent("pi_matrix", 100, "k"), JSON.stringify(env)).rejects.toThrow(
          /STRIPE_SECRET_KEY/,
        );
      }
    }
  });

  it("next dev with the e2e flag and no CI selects the fake", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("CI", "");
    vi.stubEnv("VERCEL", "");
    setStripeProvider(null);
    expect(getStripeProvider()).toBe(fakeStripeProvider);
  });

  it("Vercel build CI=1 never selects the fake", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("CI", "1");
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_present");
    setStripeProvider(null);
    expect(getStripeProvider()).toBe(stripeProvider);
  });
});
