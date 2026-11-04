import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { storeScoped } from "../db";
import { createFakeAnthropicFetch } from "./messages-api-double";
import { createAssistantModel } from "./model";
import { ASSISTANT_STATIC_PROMPT } from "./system-prompt";
import { createChatHandler } from "./chat-handler";
import { assistantSpendState } from "./spend";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const hasDb = !!process.env.DATABASE_URL;
const KEY = "sk-ant-test";

describe.skipIf(!hasDb)("assistant chat through the Anthropic adapter", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  let slugA = "";
  let slugB = "";

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const suffix = randomUUID().slice(0, 8);
    slugA = `ai-prov-a-${suffix}`;
    slugB = `ai-prov-b-${suffix}`;
    storeA = (await raw.store.create({
      data: { slug: slugA, name: "Provider A", themePreset: "palm-and-shea", minimumOrderCents: 1000 },
    })).id;
    storeB = (await raw.store.create({
      data: { slug: slugB, name: "Provider B", themePreset: "lagoon-and-coral", minimumOrderCents: 2500 },
    })).id;
  });

  afterAll(async () => {
    if (storeA) await storeScoped(storeA).cart.deleteMany({});
    if (storeB) await storeScoped(storeB).cart.deleteMany({});
    if (raw) {
      await raw.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
      await raw.$disconnect();
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function post(slug: string, text: string, ip: string) {
    return new Request("http://prov.test/api/assistant/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "prov.test",
        origin: "http://prov.test",
        "x-store-slug": slug,
        "x-forwarded-for": ip,
      },
      body: JSON.stringify({
        message: { id: "m", role: "user", parts: [{ type: "text", text }] },
      }),
    });
  }

  it("sends exactly one cache breakpoint on the static system block", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", "claude-haiku-5-5");
    const fake = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [{ kind: "text", text: "hello", inputTokens: 20, outputTokens: 2 }],
    });
    const handler = createChatHandler({ model: createAssistantModel({ fetch: fake.fetch }) });
    const response = await handler(post(slugA, "hi", "203.0.113.100"));
    expect(response.status).toBe(200);
    await response.text();
    const body = fake.requests[0]?.body;
    const system = body?.system as Array<{ text?: string; cache_control?: { type?: string } }>;
    expect(JSON.stringify(body).split("cache_control").length - 1).toBe(1);
    expect(system[0]?.text).toBe(ASSISTANT_STATIC_PROMPT);
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(system[1]?.cache_control).toBeUndefined();
    expect(system[1]?.text).toContain("Store: Provider A");
  });

  it("the static block is identical across stores and days", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", "claude-haiku-5-5");
    const first = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [{ kind: "text", text: "a", inputTokens: 8, outputTokens: 1 }],
    });
    const second = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [{ kind: "text", text: "b", inputTokens: 8, outputTokens: 1 }],
    });
    const today = createChatHandler({
      model: createAssistantModel({ fetch: first.fetch }),
      now: () => new Date("2034-01-02T15:00:00Z"),
    });
    const later = createChatHandler({
      model: createAssistantModel({ fetch: second.fetch }),
      now: () => new Date("2034-06-02T15:00:00Z"),
    });
    await (await today(post(slugA, "one", "203.0.113.101"))).text();
    await (await later(post(slugB, "two", "203.0.113.102"))).text();
    const staticA = JSON.stringify(first.requests[0]?.body).match(/You are the helper[\s\S]*?Rule 40:[^"]+/)?.[0];
    const staticB = JSON.stringify(second.requests[0]?.body).match(/You are the helper[\s\S]*?Rule 40:[^"]+/)?.[0];
    expect(staticA).toBeTruthy();
    expect(staticA).toBe(staticB);
    expect(ASSISTANT_STATIC_PROMPT.length / 4).toBeGreaterThanOrEqual(512);
  });

  it("static prompt and tools reach the 512-token cache minimum", () => {
    expect(ASSISTANT_STATIC_PROMPT.length / 4).toBeGreaterThanOrEqual(512);
  });

  it("meters every step into the ledger and the conversation", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", "claude-haiku-5-5");
    const before = await assistantSpendState({ ASSISTANT_SPEND_CAP_USD: "1000000" });
    const fake = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [
        { kind: "text", text: "priced", inputTokens: 30, outputTokens: 3 },
      ],
    });
    const handler = createChatHandler({ model: createAssistantModel({ fetch: fake.fetch }) });
    const response = await handler(post(slugA, "price this", "203.0.113.103"));
    await response.text();
    const after = await assistantSpendState({ ASSISTANT_SPEND_CAP_USD: "1000000" });
    expect(after.spentMicros).toBeGreaterThan(before.spentMicros);
    const rows = await storeScoped(storeA).aiConversation.findMany({ where: { storeId: storeA } });
    const priced = rows.find((row) => JSON.stringify(row.messages).includes("price this"));
    expect(priced?.costMicros).toBeGreaterThan(BigInt(0));
  });

  it("an in-stream overloaded error yields the fixed message and saves the user turn", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", "claude-haiku-5-5");
    const fake = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [{ kind: "error", inputTokens: 10, outputTokens: 1 }],
    });
    const handler = createChatHandler({ model: createAssistantModel({ fetch: fake.fetch }) });
    const response = await handler(post(slugA, "keep the question", "203.0.113.104"));
    const body = await response.text();
    expect(body).toContain("Sorry, something went wrong. Please try again.");
    expect(body).not.toContain("Overloaded");
    const rows = await storeScoped(storeA).aiConversation.findMany({ where: { storeId: storeA } });
    const saved = rows.find((row) => JSON.stringify(row.messages).includes("keep the question"));
    expect(saved?.inFlightUntil).toBeNull();
  });
});
