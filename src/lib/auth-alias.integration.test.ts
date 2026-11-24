import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// The allowed hosts are read when auth loads, so the production alias must be configured first (#766).
vi.hoisted(() => {
  process.env.AUTH_RATE_LIMIT_RELAXED = "1";
  process.env.VERCEL_ENV = "production";
  process.env.VERCEL_PROJECT_PRODUCTION_URL = "african-market-ai-ecommerce.vercel.app";
  process.env.PLATFORM_ROOT_DOMAIN = "";
});

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => () => fn(),
  revalidateTag: () => {},
}));
import { authPrisma } from "./db";
import { authPost } from "./test-auth";
import { clearTestSentEmails, getTestSentEmails } from "./email/send";

const ALIAS = "african-market-ai-ecommerce.vercel.app";
const suffix = Date.now();

describe("magic links on the production alias (#766, real DB)", () => {
  const storeId = crypto.randomUUID();
  const storeSlug = `alias-store-${suffix}`;
  const email = `alias-shopper-${suffix}@test.example`;

  async function asPlatform(run: (tx: Parameters<Parameters<typeof authPrisma.$transaction>[0]>[0]) => Promise<unknown>) {
    await authPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await run(tx);
    });
  }

  beforeAll(async () => {
    await asPlatform((tx) => tx.$executeRaw`INSERT INTO stores (id, name, slug, status, updated_at) VALUES (${storeId}, 'Alias Store', ${storeSlug}, 'active', now())`);
  });

  afterAll(async () => {
    await asPlatform(async (tx) => {
      await tx.$executeRaw`DELETE FROM verifications WHERE identifier LIKE 'magic-link-store:%' AND value = ${storeId}`;
      await tx.$executeRaw`DELETE FROM verifications WHERE value LIKE ${"%" + email + "%"}`;
      await tx.$executeRaw`DELETE FROM users WHERE email = ${email}`;
      await tx.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
    });
  });

  it("a link asked for on the alias opens on the alias, naming its store", async () => {
    clearTestSentEmails();
    const res = await authPost(
      "/sign-in/magic-link",
      { email, callbackURL: "/account" },
      undefined,
      { "x-store-slug": storeSlug, host: ALIAS },
    );
    expect(res.status).toBe(200);
    const href = getTestSentEmails().at(-1)?.html?.match(/href="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
    const link = new URL(href!);
    // The scheme follows the request URL: http here, https on Vercel.
    expect(link.host).toBe(ALIAS);
    expect(link.pathname).toBe("/account/sign-in/confirm");
    expect(link.searchParams.get("store")).toBe(storeSlug);
  });
});
