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

import { POST } from "./route";
import { auth } from "@/lib/auth";
import { authPrisma, storeScoped } from "@/lib/db";

const BASE = "http://localhost:3000/api/auth";
const suffix = `${Date.now()}-inv`;
const password = "GuardPass-123!";
const email = `invite-309-${suffix}@test.example`;

function collectCookies(res: Response): string {
  return (res.headers.getSetCookie?.() ?? []).join("; ");
}

async function authPost(path: string, body: unknown, cookies?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cookies) headers.cookie = cookies;
  return auth.handler(new Request(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function verifiedCookies(): Promise<string> {
  const signedUp = await authPost("/sign-up/email", { email, password, name: "Invite 309" });
  expect(signedUp.status, await signedUp.clone().text()).toBe(200);
  const signedIn = await authPost("/sign-in/email", { email, password });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  const cookies = collectCookies(signedIn);
  const enabled = await authPost("/two-factor/enable", { password }, cookies);
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
  if (!secret) throw new Error("TOTP URI has no secret");
  const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, cookies);
  expect(verified.status, await verified.clone().text()).toBe(200);
  return collectCookies(verified) || cookies;
}

function postInvite(body: string, origin = "http://localhost:3000", host = "localhost:3000") {
  return POST(new NextRequest("http://localhost:3000/api/invite/accept", {
    method: "POST",
    body,
    headers: { origin, host, "content-type": "application/json" },
  }));
}

describe("invite accept boundary", () => {
  let storeId = "";
  let userId = "";

  beforeAll(async () => {
    storeId = crypto.randomUUID();
    headerState.set("cookie", await verifiedCookies());
    const user = await authPrisma.user.findFirstOrThrow({ where: { email } });
    userId = user.id;
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, 'Invite 309', ${`inv309-${suffix}`}, 'active', now())`;
    });
  }, 60_000);

  afterAll(async () => {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`DELETE FROM store_memberships WHERE user_id = ${userId} OR store_id = ${storeId}`;
      await tx.$executeRaw`DELETE FROM two_factors WHERE user_id = ${userId}`;
      await tx.$executeRaw`DELETE FROM sessions WHERE user_id = ${userId}`;
      await tx.$executeRaw`DELETE FROM accounts WHERE user_id = ${userId}`;
      await tx.$executeRaw`DELETE FROM verifications WHERE value LIKE ${"%" + email + "%"}`;
      await tx.$executeRaw`DELETE FROM users WHERE id = ${userId}`;
      await tx.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
    });
  });

  async function memberships(): Promise<number> {
    return storeScoped(storeId).storeMembership.count();
  }

  it("malformed, mistyped, extra-key and oversized bodies return 400 and write no membership", async () => {
    expect(await memberships()).toBe(0);
    const bodies = [
      "{",
      JSON.stringify({ token: 1 }),
      JSON.stringify({ token: "abc", role: "owner" }),
      JSON.stringify({ token: "a".repeat(10_000) }),
    ];
    for (const body of bodies) {
      const res = await postInvite(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Missing invite token" });
      expect(await memberships()).toBe(0);
    }
  });

  it("cross-origin POST with a valid session is 403 and makes no provider call", async () => {
    const res = await postInvite(
      JSON.stringify({ token: "abc" }),
      "https://other-store.example.com",
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(await memberships()).toBe(0);
  });

  it("store-A owner on store-B host is 403", async () => {
    const res = await postInvite(
      JSON.stringify({ token: "abc" }),
      "http://store-a.example.test",
      "store-b.example.test",
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(await memberships()).toBe(0);
  });
});
