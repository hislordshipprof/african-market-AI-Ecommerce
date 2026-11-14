import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fakeStripeProvider, reset } from "./fake";
import { setStripeProvider } from "./index";

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock("@/lib/get-store", () => ({
  getStore: vi.fn(),
  revalidateStore: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  storeScoped: vi.fn(),
  platformAdmin: {
    store: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("./update-store-status", () => ({
  updateStoreOnboardingStatus: vi.fn().mockResolvedValue({
    storeId: "store_123",
    status: "complete",
  }),
}));

import { auth } from "@/lib/auth";
import { getStore } from "@/lib/get-store";
import { storeScoped, platformAdmin } from "@/lib/db";
import { updateStoreOnboardingStatus } from "./update-store-status";

function makeStore(overrides = {}) {
  return {
    id: "store_123",
    slug: "test-store",
    name: "Test Store",
    stripeAccountId: "acct_test",
    stripeOnboardingStatus: "pending",
    ...overrides,
  };
}

function makeSession(overrides = {}) {
  return {
    user: {
      id: "user_1",
      email: "owner@test.com",
      twoFactorEnabled: true,
      ...((overrides as Record<string, unknown>).user as object ?? {}),
    },
    session: {
      twoFactorVerified: true,
      ...((overrides as Record<string, unknown>).session as object ?? {}),
    },
  };
}

async function callReturn(storeSlug = "test-store") {
  const { GET } = await import("@/app/api/stripe/return/route");
  const req = new Request(
    `http://localhost:3000/api/stripe/return?store=${storeSlug}`,
    { method: "GET" },
  );
  const { NextRequest } = await import("next/server");
  return GET(new NextRequest(req));
}

describe("GET /api/stripe/return", () => {
  beforeEach(() => {
    reset();
    setStripeProvider(fakeStripeProvider);
    vi.clearAllMocks();
  });

  afterEach(() => {
    setStripeProvider(null);
  });

  it("redirects to sign-in when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    const res = await callReturn();
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      "/store-admin/sign-in",
    );
  });

  it("redirects to store-admin when user is not owner", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession() as never);
    vi.mocked(getStore).mockResolvedValue(makeStore() as never);
    vi.mocked(storeScoped).mockReturnValue({
      storeMembership: {
        findUnique: vi.fn().mockResolvedValue({ role: "staff" }),
      },
    } as never);

    const res = await callReturn();
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      "/store-admin",
    );
  });

  it("calls updateStoreOnboardingStatus and redirects for owner", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession() as never);
    vi.mocked(getStore).mockResolvedValue(makeStore() as never);
    vi.mocked(storeScoped).mockReturnValue({
      storeMembership: {
        findUnique: vi.fn().mockResolvedValue({ role: "owner" }),
      },
    } as never);
    vi.mocked(platformAdmin.store.findUnique).mockResolvedValue({
      stripeAccountId: "acct_test",
    } as never);

    const res = await callReturn();
    expect(res.status).toBe(307);
    expect(updateStoreOnboardingStatus).toHaveBeenCalledWith("acct_test");
    expect(new URL(res.headers.get("location")!).pathname).toBe(
      "/store-admin",
    );
  });

  it("skips status update when store has no stripeAccountId", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession() as never);
    vi.mocked(getStore).mockResolvedValue(
      makeStore({ stripeAccountId: null }) as never,
    );
    vi.mocked(storeScoped).mockReturnValue({
      storeMembership: {
        findUnique: vi.fn().mockResolvedValue({ role: "owner" }),
      },
    } as never);
    vi.mocked(platformAdmin.store.findUnique).mockResolvedValue({
      stripeAccountId: null,
    } as never);

    const res = await callReturn();
    expect(res.status).toBe(307);
    expect(updateStoreOnboardingStatus).not.toHaveBeenCalled();
  });
});
