import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { generateTOTP } from "../../../../../e2e/totp";

vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
});

const { headerState } = vi.hoisted(() => ({ headerState: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => headerState,
}));

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

import { POST } from "./route";
import { auth } from "@/lib/auth";
import { authPrisma, storeScopedTransaction } from "@/lib/db";
import { setStripeProvider } from "@/lib/stripe";
import { fakeStripeProvider } from "@/lib/stripe/fake";

const BASE = "http://localhost:3000/api/auth";
const suffix = `${Date.now()}-con`;
const password = "GuardPass-123!";
const email = `connect-309-${suffix}@test.example`;

let creates = 0;

function collectCookies(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).join("; ");
}

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) headers.cookie = cookies;
  return auth.handler(new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

function postConnect(origin = "http://localhost:3000") {
  return POST(new NextRequest("http://localhost:3000/api/stripe/connect", {
    method: "POST",
    headers: { origin, host: "localhost:3000" },
  }));
}

async function accountId(storeId: string): Promise<string | null> {
  const rows = await storeScopedTransaction(storeId, (tx) =>
    tx.$queryRaw<Array<{ stripe_account_id: string | null }>>`SELECT stripe_account_id FROM stores WHERE id = ${storeId}`,
  );
  return rows[0]?.stripe_account_id ?? null;
}

describe("stripe connect origin and store", () => {
  let storeA = "";
  let storeB = "";
  let userId = "";
  const slugA = `con-a-${suffix}`;
  const slugB = `con-b-${suffix}`;

  beforeAll(async () => {
    setStripeProvider({
      ...fakeStripeProvider,
      createConnectAccount: async (input) => {
        creates += 1;
        return fakeStripeProvider.createConnectAccount(input);
      },
    });
    const signedUp = await authPost("/sign-up/email", { email, password, name: "Connect 309" });
    expect(signedUp.status, await signedUp.clone().text()).toBe(200);
    const signedIn = await authPost("/sign-in/email", { email, password });
    const cookies = collectCookies(signedIn);
    const enabled = await authPost("/two-factor/enable", { password }, cookies);
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
    if (!secret) throw new Error("TOTP URI has no secret");
    const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
    expect(verified.status, await verified.clone().text()).toBe(200);
    headerState.set("cookie", collectCookies(verified) || cookies);
    const user = await authPrisma.user.findFirstOrThrow({ where: { email } });
    userId = user.id;
    storeA = crypto.randomUUID();
    storeB = crypto.randomUUID();
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeA}, 'Connect A', ${slugA}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeB}, 'Connect B', ${slugB}, 'active', now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeA}, ${userId}, 'owner', now())`;
    });
  }, 60_000);

  afterAll(async () => {
    setStripeProvider(null);
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE user_id = ${userId}`;
      await tx.$executeRaw`DELETE FROM two_factors WHERE user_id = ${userId}`;
      await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${userId}`;
      await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${userId}`;
      await tx.$executeRaw`DELETE FROM verifications WHERE value LIKE ${"%" + email + "%"}`;
      await tx.$executeRaw`DELETE FROM users WHERE id = ${userId}`;
      await tx.$executeRaw`DELETE FROM stores WHERE id IN (${storeA}, ${storeB})`;
    });
  });

  it("cross-origin POST with a valid session is 403 and makes no provider call", async () => {
    creates = 0;
    headerState.set("x-store-slug", slugA);
    const res = await postConnect("https://other-store.example.com");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(creates).toBe(0);
    expect(await accountId(storeA)).toBeNull();
  });

  it("store-A owner on store-B host is 403", async () => {
    creates = 0;
    headerState.set("x-store-slug", slugB);
    const res = await postConnect();
    expect(res.status).toBe(403);
    expect(creates).toBe(0);
    expect(await accountId(storeB)).toBeNull();
    expect(await accountId(storeA)).toBeNull();
  });

  it("two concurrent posts store one stripe account id", async () => {
    creates = 0;
    headerState.set("x-store-slug", slugA);
    const [first, second] = await Promise.all([postConnect(), postConnect()]);
    expect([first.status, second.status].sort()).toEqual([200, 200]);
    expect(await accountId(storeA)).toBe(`acct_fake_${storeA}`);
    expect(creates).toBeGreaterThan(0);
  });
});
