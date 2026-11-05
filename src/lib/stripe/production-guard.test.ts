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

  const nodeEnvs = ["development", "test", "production"] as const;
  const vercels = [undefined, "1"] as const;
  const cis = [undefined, "true", "1"] as const;
  const flags = [undefined, "1"] as const;
  const keys = [undefined, "sk_test_present"] as const;

  function expectedKind(input: {
    NODE_ENV: string;
    VERCEL?: string;
    CI?: string;
    E2E_FAKE_STRIPE?: string;
    STRIPE_SECRET_KEY?: string;
  }): StripeSelection {
    const fake =
      input.E2E_FAKE_STRIPE === "1" &&
      !input.VERCEL &&
      (input.CI === "true" || input.NODE_ENV !== "production");
    if (fake) return "fake";
    const production = input.NODE_ENV === "production" || Boolean(input.VERCEL);
    if (production && !input.STRIPE_SECRET_KEY) return "unconfigured";
    return "real";
  }

  it("selects the fake, real or unconfigured provider for every environment combination", async () => {
    for (const NODE_ENV of nodeEnvs) {
      for (const VERCEL of vercels) {
        for (const CI of cis) {
          for (const E2E_FAKE_STRIPE of flags) {
            for (const STRIPE_SECRET_KEY of keys) {
              const env = { NODE_ENV, VERCEL, CI, E2E_FAKE_STRIPE, STRIPE_SECRET_KEY };
              const kind = expectedKind(env);
              vi.stubEnv("NODE_ENV", NODE_ENV);
              vi.stubEnv("VERCEL", VERCEL ?? "");
              vi.stubEnv("CI", CI ?? "");
              vi.stubEnv("E2E_FAKE_STRIPE", E2E_FAKE_STRIPE ?? "");
              vi.stubEnv("STRIPE_SECRET_KEY", STRIPE_SECRET_KEY ?? "");
              setStripeProvider(null);
              const provider = getStripeProvider();
              if (kind === "fake") {
                expect(provider, JSON.stringify(env)).toBe(fakeStripeProvider);
              } else if (kind === "real") {
                expect(provider, JSON.stringify(env)).toBe(stripeProvider);
              } else {
                await expect(provider.capturePaymentIntent("pi_matrix", 100, "k")).rejects.toThrow(
                  /STRIPE_SECRET_KEY/,
                );
              }
            }
          }
        }
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
