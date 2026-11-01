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
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

import { auth } from "@/lib/auth";
import { getStore } from "@/lib/get-store";
import { storeScoped, platformAdmin } from "@/lib/db";

function makeStore(overrides = {}) {
  return {
    id: "store_123",
    slug: "test-store",
    name: "Test Store",
    stripeAccountId: null,
    stripeOnboardingStatus: "not_started",
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

async function callConnect() {
  const { POST } = await import("@/app/api/stripe/connect/route");
  const req = new Request("http://localhost:3000/api/stripe/connect?store=test-store", {
    method: "POST",
  });
  const { NextRequest } = await import("next/server");
  return POST(new NextRequest(req));
}

describe("POST /api/stripe/connect", () => {
  beforeEach(() => {
    reset();
    setStripeProvider(fakeStripeProvider);
    vi.clearAllMocks();
  });

  afterEach(() => {
    setStripeProvider(null);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    const res = await callConnect();
    expect(res.status).toBe(401);
  });

  it("returns 401 when 2FA not verified", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(
      makeSession({ session: { twoFactorVerified: false } }) as never,
    );
    const res = await callConnect();
    expect(res.status).toBe(401);
  });

  it("returns 403 when user is not store owner", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession() as never);
    vi.mocked(getStore).mockResolvedValue(makeStore() as never);
    vi.mocked(storeScoped).mockReturnValue({
      storeMembership: {
        findUnique: vi.fn().mockResolvedValue({ role: "staff" }),
      },
    } as never);

    const res = await callConnect();
    expect(res.status).toBe(403);
  });

  it("returns 403 when user has no membership", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession() as never);
    vi.mocked(getStore).mockResolvedValue(makeStore() as never);
    vi.mocked(storeScoped).mockReturnValue({
      storeMembership: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    } as never);

    const res = await callConnect();
    expect(res.status).toBe(403);
  });

  it("creates stripe account and returns account link URL", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession() as never);
    vi.mocked(getStore).mockResolvedValue(makeStore() as never);
    vi.mocked(storeScoped).mockReturnValue({
      storeMembership: {
        findUnique: vi.fn().mockResolvedValue({ role: "owner" }),
      },
    } as never);

    const res = await callConnect();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.url).toContain("connect.stripe.com");

    expect(vi.mocked(platformAdmin.store.update)).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stripeAccountId: "acct_fake_store_123",
          stripeOnboardingStatus: "pending",
        }),
      }),
    );
  });

  it("reuses existing stripe account when already created", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(makeSession() as never);
    vi.mocked(getStore).mockResolvedValue(
      makeStore({ stripeAccountId: "acct_existing" }) as never,
    );
    vi.mocked(storeScoped).mockReturnValue({
      storeMembership: {
        findUnique: vi.fn().mockResolvedValue({ role: "owner" }),
      },
    } as never);

    // Need the account to exist in the fake
    await fakeStripeProvider.createConnectAccount({
      email: "owner@test.com",
      businessName: "Test Store",
      storeId: "existing",
    });
    // Manually add it with the right ID
    const { getAccounts } = await import("./fake");
    const accounts = getAccounts();
    accounts.set("acct_existing", {
      accountId: "acct_existing",
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
      requirementsCurrentlyDue: [],
    });

    const res = await callConnect();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.url).toContain("acct_existing");
    expect(vi.mocked(platformAdmin.store.update)).not.toHaveBeenCalled();
  });
});
