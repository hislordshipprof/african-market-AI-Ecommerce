import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fakeStripeProvider, reset, getAccounts } from "./fake";
import { setStripeProvider } from "./index";

vi.mock("../db", () => ({
  platformAdmin: {
    store: {
      findMany: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../get-store", () => ({
  revalidateStore: vi.fn(),
}));

import { platformAdmin } from "../db";
import { revalidateStore } from "../get-store";
import { updateStoreOnboardingStatus } from "./update-store-status";

function makeDbStore(overrides = {}) {
  return {
    id: "store_123",
    slug: "test-store",
    stripeAccountId: "acct_fake_store_123",
    stripeOnboardingStatus: "pending",
    ...overrides,
  };
}

describe("updateStoreOnboardingStatus", () => {
  beforeEach(() => {
    reset();
    setStripeProvider(fakeStripeProvider);
    vi.clearAllMocks();
  });

  afterEach(() => {
    setStripeProvider(null);
  });

  it("returns null when no store matches the stripeAccountId", async () => {
    vi.mocked(platformAdmin.store.findMany).mockResolvedValue([]);
    const result = await updateStoreOnboardingStatus("acct_unknown");
    expect(result).toBeNull();
  });

  it("fetches account from Stripe and updates DB when status differs", async () => {
    const store = makeDbStore();
    vi.mocked(platformAdmin.store.findMany).mockResolvedValue([store] as never);

    await fakeStripeProvider.createConnectAccount({
      email: "o@test.com",
      businessName: "Test",
      storeId: "store_123",
    });
    const accounts = getAccounts();
    accounts.set("acct_fake_store_123", {
      accountId: "acct_fake_store_123",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
      requirementsCurrentlyDue: [],
    });

    const result = await updateStoreOnboardingStatus("acct_fake_store_123");

    expect(result).toEqual({ storeId: "store_123", status: "complete" });
    expect(platformAdmin.store.update).toHaveBeenCalledWith({
      where: { id: "store_123" },
      data: { stripeOnboardingStatus: "complete" },
    });
    expect(revalidateStore).toHaveBeenCalledWith({
      id: "store_123",
      slug: "test-store",
    });
  });

  it("skips DB write and revalidation when status is unchanged", async () => {
    const store = makeDbStore({ stripeOnboardingStatus: "restricted" });
    vi.mocked(platformAdmin.store.findMany).mockResolvedValue([store] as never);

    await fakeStripeProvider.createConnectAccount({
      email: "o@test.com",
      businessName: "Test",
      storeId: "store_123",
    });
    const accounts = getAccounts();
    accounts.set("acct_fake_store_123", {
      accountId: "acct_fake_store_123",
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: true,
      requirementsCurrentlyDue: ["external_account"],
    });

    const result = await updateStoreOnboardingStatus("acct_fake_store_123");

    expect(result).toEqual({ storeId: "store_123", status: "restricted" });
    expect(platformAdmin.store.update).not.toHaveBeenCalled();
    expect(revalidateStore).not.toHaveBeenCalled();
  });

  it("derives restricted status when requirements are due", async () => {
    const store = makeDbStore({ stripeOnboardingStatus: "pending" });
    vi.mocked(platformAdmin.store.findMany).mockResolvedValue([store] as never);

    await fakeStripeProvider.createConnectAccount({
      email: "o@test.com",
      businessName: "Test",
      storeId: "store_123",
    });
    const accounts = getAccounts();
    accounts.set("acct_fake_store_123", {
      accountId: "acct_fake_store_123",
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: true,
      requirementsCurrentlyDue: ["external_account"],
    });

    const result = await updateStoreOnboardingStatus("acct_fake_store_123");

    expect(result).toEqual({ storeId: "store_123", status: "restricted" });
    expect(platformAdmin.store.update).toHaveBeenCalledWith({
      where: { id: "store_123" },
      data: { stripeOnboardingStatus: "restricted" },
    });
  });
});
