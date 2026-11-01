import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  fakeStripeProvider,
  reset,
  getAccounts,
  VALID_WEBHOOK_SIGNATURE,
} from "./fake";
import {
  deriveOnboardingStatus,
  setStripeProvider,
  getStripeProvider,
} from "./index";
import type { WebhookEvent } from "./types";

describe("deriveOnboardingStatus", () => {
  it("returns complete when charges and payouts are enabled", () => {
    expect(
      deriveOnboardingStatus({
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        requirementsCurrentlyDue: [],
      }),
    ).toBe("complete");
  });

  it("returns restricted when requirements are due", () => {
    expect(
      deriveOnboardingStatus({
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: true,
        requirementsCurrentlyDue: ["external_account"],
      }),
    ).toBe("restricted");
  });

  it("returns pending when no requirements but not enabled", () => {
    expect(
      deriveOnboardingStatus({
        chargesEnabled: false,
        payoutsEnabled: false,
        detailsSubmitted: false,
        requirementsCurrentlyDue: [],
      }),
    ).toBe("pending");
  });
});

describe("fakeStripeProvider", () => {
  beforeEach(() => reset());

  it("creates a connect account and stores it", async () => {
    const account = await fakeStripeProvider.createConnectAccount({
      email: "owner@store.com",
      businessName: "Test Store",
      storeId: "store_123",
    });

    expect(account.accountId).toBe("acct_fake_store_123");
    expect(account.chargesEnabled).toBe(false);
    expect(account.payoutsEnabled).toBe(false);
    expect(getAccounts().has(account.accountId)).toBe(true);
  });

  it("creates an account link for an existing account", async () => {
    const account = await fakeStripeProvider.createConnectAccount({
      email: "owner@store.com",
      businessName: "Test Store",
      storeId: "store_123",
    });

    const link = await fakeStripeProvider.createAccountLink({
      accountId: account.accountId,
      returnUrl: "https://example.com/return",
      refreshUrl: "https://example.com/refresh",
    });

    expect(link.url).toContain(account.accountId);
  });

  it("throws when creating link for unknown account", async () => {
    await expect(
      fakeStripeProvider.createAccountLink({
        accountId: "acct_unknown",
        returnUrl: "https://example.com/return",
        refreshUrl: "https://example.com/refresh",
      }),
    ).rejects.toThrow("No account found");
  });

  it("retrieves an existing account", async () => {
    const created = await fakeStripeProvider.createConnectAccount({
      email: "owner@store.com",
      businessName: "Test Store",
      storeId: "store_123",
    });

    const retrieved = await fakeStripeProvider.getAccount(created.accountId);
    expect(retrieved.accountId).toBe(created.accountId);
  });

  it("verifies webhook signature with valid signature", () => {
    const event: WebhookEvent = {
      type: "account.updated",
      accountId: "acct_fake_store_123",
    };

    const result = fakeStripeProvider.verifyWebhookSignature({
      payload: JSON.stringify(event),
      signature: VALID_WEBHOOK_SIGNATURE,
    });

    expect(result.type).toBe("account.updated");
    expect(result.accountId).toBe("acct_fake_store_123");
  });

  it("rejects webhook with invalid signature", () => {
    expect(() =>
      fakeStripeProvider.verifyWebhookSignature({
        payload: "{}",
        signature: "invalid_sig",
      }),
    ).toThrow(/signature/i);
  });
});

describe("setStripeProvider / getStripeProvider", () => {
  afterEach(() => setStripeProvider(null));

  it("returns overridden provider when set", () => {
    setStripeProvider(fakeStripeProvider);
    expect(getStripeProvider()).toBe(fakeStripeProvider);
  });

  it("returns real provider when no override (keys checked lazily)", () => {
    const provider = getStripeProvider();
    expect(provider).toBeDefined();
    expect(typeof provider.createConnectAccount).toBe("function");
  });
});
