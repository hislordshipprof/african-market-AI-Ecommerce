import { spawnSync } from "node:child_process";
import path from "node:path";
import { testPrismaClient } from "@/lib/test-prisma";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: never[]) => unknown) => fn,
  revalidateTag: () => {},
  revalidatePath: () => {},
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({
    "x-store-slug": process.env.PRUNE_STORE_SLUG ?? "",
  }),
  cookies: async () => ({
    get: () => undefined,
    getAll: () => [],
    has: () => false,
  }),
}));

import { auth } from "../auth";
import { authPrisma } from "../db";

const child = process.env.RATE_LIMIT_PRUNE_CHILD === "1";
const hasDb = !!process.env.DATABASE_URL;
const vitestEntry = path.join(process.cwd(), "node_modules", "vitest", "vitest.mjs");

describe.skipIf(!hasDb || child)("app counters and Better Auth", () => {
  it("Better Auth window reset in a production child leaves app counters intact", () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: "production",
      RATE_LIMIT_PRUNE_CHILD: "1",
      ASSISTANT_CHAT_ENABLED: "1",
    };
    delete env.AUTH_RATE_LIMIT_RELAXED;
    delete env.VERCEL;
    delete env.VERCEL_ENV;
    const result = spawnSync(process.execPath, [
      vitestEntry,
      "run",
      "src/lib/rate-limit/app-limiter-better-auth.integration.test.ts",
      "-t",
      "production child prune",
    ], { cwd: process.cwd(), env, encoding: "utf8", timeout: 180_000 });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("APP_COUNTERS_INTACT");
  }, 200_000);
});

describe.skipIf(!child)("production child prune", () => {
  it("production child prune", async () => {
    const run = `${Date.now()}`;
    const slug = `prune-${run}`;
    const signInIp = `203.0.113.${Number(run.slice(-2)) % 200 + 20}`;
    const assistantIp = "198.51.100.81";
    const searchIp = "198.51.100.80";
    process.env.ASSISTANT_CHAT_ENABLED = "1";
    process.env.PRUNE_STORE_SLUG = slug;
    const owner = testPrismaClient();
    const store = await owner.store.create({
      data: {
        slug,
        name: "Prune store",
        themePreset: "palm-and-shea",
        prepTimeMinutes: 20,
      },
    });
    const keys: string[] = [];
    try {
      const { checkInviteRateLimit } = await import("../invite/rate-limit");
      await checkInviteRateLimit(store.id);
      await checkInviteRateLimit(store.id);

      const { GET } = await import("@/app/api/storefront/search/route");
      const { NextRequest } = await import("next/server");
      const searchHeaders = { "x-shop-browser": "browserprune", "x-forwarded-for": searchIp };
      const firstSearch = await GET(new NextRequest("http://localhost/api/storefront/search?q=prune", { headers: searchHeaders }));
      expect(firstSearch.status).toBe(200);
      await GET(new NextRequest("http://localhost/api/storefront/search?q=prune", { headers: searchHeaders }));

      const { createChatHandler } = await import("../assistant/chat-handler");
      const { MockLanguageModelV4 } = await import("ai/test");
      const model = new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "stream-start", warnings: [] });
              controller.enqueue({ type: "text-start", id: "t" });
              controller.enqueue({ type: "text-delta", id: "t", delta: "ok" });
              controller.enqueue({ type: "text-end", id: "t" });
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "stop", raw: "end_turn" },
                usage: {
                  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 1, text: 1, reasoning: 0 },
                },
              });
              controller.close();
            },
          }),
        }),
      });
      const chat = await createChatHandler({ model })(new Request("http://localhost:3000/api/assistant/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
          host: "localhost:3000",
          "x-store-slug": slug,
          "x-forwarded-for": assistantIp,
        },
        body: JSON.stringify({
          message: { id: "pruneMsg1", role: "user", parts: [{ type: "text", text: "hello" }] },
        }),
      }));
      const chatBody = await chat.text();
      expect(chat.status, chatBody.slice(0, 180)).toBe(200);
      const cartId = decodeURIComponent(/cart_id=([^;]+)/.exec(chat.headers.get("set-cookie") ?? "")?.[1] ?? "");
      expect(cartId).not.toBe("");

      keys.push(
        `invite:${store.id}`,
        "search:browser:browserprune",
        `search:ip:${searchIp}`,
        `assistant:ip:${assistantIp}`,
        `assistant:cart:${cartId}`,
      );
      const before = new Map<string, number>();
      for (const key of keys) {
        const row = await authPrisma.appRateLimit.findUnique({ where: { key } });
        expect(row?.count, key).toBeGreaterThan(0);
        before.set(key, row?.count ?? 0);
      }

      const old = BigInt(Date.now() - 120_000);
      await authPrisma.rateLimit.create({
        data: { key: `${signInIp}|/sign-in/email`, count: 1, lastRequest: old },
      });
      await authPrisma.rateLimit.create({
        data: { key: `sacrificial-${run}`, count: 1, lastRequest: old },
      });
      const response = await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": signInIp },
        body: JSON.stringify({ email: `nobody-${run}@test.example`, password: "not-a-real-password" }),
      }));
      expect(response.status).toBeGreaterThanOrEqual(400);
      const sacrificial = await authPrisma.rateLimit.findUnique({ where: { key: `sacrificial-${run}` } });
      expect(sacrificial).toBeNull();
      for (const key of keys) {
        const row = await authPrisma.appRateLimit.findUnique({ where: { key } });
        expect(row?.count, key).toBe(before.get(key));
      }
      console.log("APP_COUNTERS_INTACT");
      await authPrisma.rateLimit.deleteMany({
        where: { key: { in: [`${signInIp}|/sign-in/email`, `no-trusted-ip|/sign-in/email`] } },
      });
    } finally {
      if (keys.length) await authPrisma.appRateLimit.deleteMany({ where: { key: { in: keys } } });
      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL ROLE app_user`;
        await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
        await tx.$executeRaw`DELETE FROM ai_actions WHERE conversation_id IN (SELECT id FROM ai_conversations WHERE store_id = ${store.id})`;
        await tx.$executeRaw`DELETE FROM ai_conversations WHERE store_id = ${store.id}`;
        await tx.$executeRaw`DELETE FROM carts WHERE store_id = ${store.id}`;
        await tx.store.delete({ where: { id: store.id } });
      }).catch(() => {});
      await owner.$disconnect();
    }
  }, 90_000);
});
