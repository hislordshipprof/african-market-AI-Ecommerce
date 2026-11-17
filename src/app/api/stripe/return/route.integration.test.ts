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

import { GET } from "./route";
import { authPrisma } from "@/lib/db";
import { setStripeProvider } from "@/lib/stripe";
import { fakeStripeProvider } from "@/lib/stripe/fake";
import { authPost, collectCookies, testSignUp } from "../../../../lib/test-auth";

const suffix = `${Date.now()}-ret`;
const password = "GuardPass-123!";
const email = `return-710-${suffix}@test.example`;
const slug = `ret-${suffix}`;

let accountReads = 0;

/** Where the request ends up: a redirect response's Location, or the path a thrown redirect() names. */
async function landing(): Promise<string> {
  try {
    const res = await GET(new NextRequest(`http://localhost:3000/api/stripe/return?store=${slug}`));
    const url = new URL(res.headers.get("location") ?? "", "http://localhost:3000");
    return `${url.pathname}${url.search}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("REDIRECT:")) return message.slice("REDIRECT:".length);
    throw error;
  }
}

describe("stripe return needs a 2FA-verified store owner", () => {
  let storeId = "";
  let userId = "";
  let passwordCookies = "";

  beforeAll(async () => {
    setStripeProvider({
      ...fakeStripeProvider,
      getAccount: async (id) => {
        accountReads += 1;
        return fakeStripeProvider.getAccount(id);
      },
    });
    const signedIn = await testSignUp({ email, password, name: "Return 710" });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    passwordCookies = collectCookies(signedIn);
    userId = (await authPrisma.user.findFirstOrThrow({ where: { email } })).id;
    storeId = crypto.randomUUID();
    await fakeStripeProvider.createConnectAccount({ email, businessName: "Return 710", storeId });
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.$executeRaw`INSERT INTO stores (id, name, slug, status, stripe_account_id, updated_at) VALUES (${storeId}, 'Return 710', ${slug}, 'active', ${`acct_fake_${storeId}`}, now())`;
      await tx.$executeRaw`INSERT INTO store_memberships (id, store_id, user_id, role, updated_at) VALUES (${crypto.randomUUID()}, ${storeId}, ${userId}, 'owner', now())`;
    });
    headerState.set("x-store-slug", slug);
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
      await tx.$executeRaw`DELETE FROM users WHERE id = ${userId}`;
      await tx.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
    });
  });

  it("an owner signed in by password only is sent to sign-in and never reaches Stripe", async () => {
    accountReads = 0;
    headerState.set("cookie", passwordCookies);
    expect(await landing()).toBe(`/store-admin/sign-in?store=${slug}`);
    expect(accountReads).toBe(0);
  });

  it("a 2FA-verified owner refreshes the onboarding status and returns to store admin", async () => {
    const enabled = await authPost("/two-factor/enable", { password }, passwordCookies);
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const secret = new URL(((await enabled.json()) as { totpURI: string }).totpURI).searchParams.get("secret");
    if (!secret) throw new Error("TOTP URI has no secret");
    const verified = await authPost("/two-factor/verify-totp", { code: generateTOTP(secret) }, passwordCookies);
    expect(verified.status, await verified.clone().text()).toBe(200);
    accountReads = 0;
    headerState.set("cookie", collectCookies(verified) || passwordCookies);
    expect(await landing()).toBe(`/store-admin?store=${slug}`);
    expect(accountReads).toBe(1);
  });
});
