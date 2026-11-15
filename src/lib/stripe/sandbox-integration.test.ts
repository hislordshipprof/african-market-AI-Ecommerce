import { describe, it, expect, beforeAll } from "vitest";
import Stripe from "stripe";
import { stripeProvider } from "./provider";
import { deriveOnboardingStatus } from "./types";
import { sandboxConnectedAccountId } from "./test-sandbox-account";
import { liveSandbox, providerSandbox } from "../test-live-provider";

const hasKey = !!process.env.STRIPE_SECRET_KEY;

const sandbox = providerSandbox("Stripe");

// Reuses the onboarded sandbox account: each created account stayed in the sandbox (#160).
describe.skipIf(!liveSandbox || !hasKey)("Stripe Connect sandbox integration", () => {
  let accountId: string;

  beforeAll(sandbox.hook(async () => {
    accountId = await sandboxConnectedAccountId(new Stripe(process.env.STRIPE_SECRET_KEY!));
  }), 120_000);

  it("retrieves an onboarded account via the v2 API and derives complete", { timeout: 30_000 }, sandbox.test(async () => {
    const account = await stripeProvider.getAccount(accountId);
    expect(account.accountId).toBe(accountId);
    expect(deriveOnboardingStatus(account)).toBe("complete");
  }));

  it("creates an account link for onboarding", { timeout: 30_000 }, sandbox.test(async () => {
    const link = await stripeProvider.createAccountLink({
      accountId,
      returnUrl: "http://localhost:3000/store-admin/payouts?store=test",
      refreshUrl: "http://localhost:3000/store-admin/payouts?store=test",
    });
    expect(link.url).toMatch(/^https:\/\/connect\.stripe\.com/);
  }));
});
