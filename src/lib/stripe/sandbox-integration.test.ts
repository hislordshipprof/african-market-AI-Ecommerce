import { describe, it, expect, afterAll } from "vitest";
import Stripe from "stripe";
import { stripeProvider } from "./provider";
import { deriveOnboardingStatus } from "./types";

const hasKey = !!process.env.STRIPE_SECRET_KEY;

const accountsToCleanup: string[] = [];

afterAll(async () => {
  if (!hasKey || accountsToCleanup.length === 0) return;
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
  for (const id of accountsToCleanup) {
    try {
      await stripe.accounts.del(id);
    } catch {
      // best-effort cleanup
    }
  }
});

describe.skipIf(!hasKey)("Stripe Connect sandbox integration", () => {
    let accountId: string | undefined;

    it("creates a real Express Connect account (requires v1 dashboard toggle)", { timeout: 15_000 }, async () => {
      try {
        const account = await stripeProvider.createConnectAccount({
          email: "integration-test@example.com",
          businessName: "Integration Test Store",
          storeId: "test-integration-store",
        });
        expect(account.accountId).toMatch(/^acct_/);
        expect(account.chargesEnabled).toBe(false);
        expect(account.detailsSubmitted).toBe(false);
        accountId = account.accountId;
        accountsToCleanup.push(accountId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("Accounts v1")) {
          console.warn(
            "SKIP: v1 Accounts API not enabled in dashboard. " +
              "Enable at Dashboard → Settings → Developers → API Policies → Accounts v1 support",
          );
          return;
        }
        throw err;
      }
    });

    it("retrieves an account and derives status", { timeout: 15_000 }, async () => {
      if (!accountId) {
        console.warn("SKIP: no account created (v1 not enabled)");
        return;
      }
      const account = await stripeProvider.getAccount(accountId);
      expect(account.accountId).toBe(accountId);
      const status = deriveOnboardingStatus(account);
      expect(["pending", "restricted"]).toContain(status);
    });

    it("creates an account link for onboarding", { timeout: 15_000 }, async () => {
      if (!accountId) {
        console.warn("SKIP: no account created (v1 not enabled)");
        return;
      }
      const link = await stripeProvider.createAccountLink({
        accountId,
        returnUrl: "http://localhost:3000/store-admin/payouts?store=test",
        refreshUrl: "http://localhost:3000/store-admin/payouts?store=test",
      });
      expect(link.url).toMatch(/^https:\/\/connect\.stripe\.com/);
    });

    it("webhook endpoint rejects invalid signature with 400", { timeout: 15_000 }, async () => {
      const res = await fetch("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "stripe-signature": "invalid_sig",
        },
        body: JSON.stringify({ type: "account.updated" }),
      });
      expect(res.status).toBe(400);
    });
  });
