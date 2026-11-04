import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { auth } from "../auth";
import { authPrisma, storeScoped, storeScopedTransaction } from "../db";

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

import { createChatHandler } from "./chat-handler";
import { createAssistantModel } from "./model";
import { createFakeAnthropicFetch } from "./messages-api-double";
import * as spend from "./spend";

const hasDb = !!process.env.DATABASE_URL;
const usage = {
  inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 4, text: 4, reasoning: 0 },
};

function streamOf(chunks: Array<Record<string, unknown>>) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function textStream(text: string) {
  return streamOf([
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "text-1" },
    { type: "text-delta", id: "text-1", delta: text },
    { type: "text-end", id: "text-1" },
    { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
  ]);
}

function assertSafePrompt(prompt: unknown) {
  const json = JSON.stringify(prompt);
  if (json.includes("4242424242424242") || json.includes("4242 4242")) {
    throw new Error("card digits reached the model");
  }
  const breakpoints = json.split("cacheControl").length - 1;
  if (breakpoints > 4) throw new Error("more than 4 cache breakpoints");
}

function strictModel(reply: (call: number) => Array<Record<string, unknown>>) {
  const prompts: unknown[] = [];
  let calls = 0;
  const model = new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      assertSafePrompt(prompt);
      calls += 1;
      prompts.push(prompt);
      return { stream: streamOf(reply(calls)) };
    },
  });
  return { model, prompts, calls: () => calls };
}

function userBody(text: string, extra?: Record<string, unknown>) {
  return JSON.stringify({
    ...extra,
    message: { id: "m1", role: "user", parts: [{ type: "text", text }] },
  });
}

describe.skipIf(!hasDb)("assistant chat handler", () => {
  let raw: PrismaClient;
  let storeId = "";
  let slug = "";
  let variantId = "";
  const host = "chat.test";

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    slug = `ai-chat-${randomUUID().slice(0, 8)}`;
    storeId = (await raw.store.create({
      data: {
        slug,
        name: "Chat Market",
        themePreset: "palm-and-shea",
        status: "active",
        timezone: "America/Chicago",
        minimumOrderCents: 2000,
        pickupEnabled: true,
        hours: { wed: "22:00-02:00" },
      },
    })).id;
    const listing = await storeScoped(storeId).listing.create({
      data: {
        storeId,
        customName: "Egusi",
        price: 450,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    variantId = (await storeScoped(storeId).listingVariant.create({
      data: { listingId: listing.id, label: "Each", price: 450, weightG: 100 },
    })).id;
  });

  afterAll(async () => {
    if (!storeId) return;
    await storeScoped(storeId).cart.deleteMany({});
    await storeScoped(storeId).customer.deleteMany({});
    await storeScoped(storeId).listing.deleteMany({});
    await raw.store.delete({ where: { id: storeId } });
    await raw.$disconnect();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function request(text: string, init?: { ip?: string; cookie?: string; origin?: string; extra?: Record<string, unknown> }) {
    return new Request(`http://${host}/api/assistant/chat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host,
        origin: init?.origin ?? `http://${host}`,
        "x-store-slug": slug,
        "x-forwarded-for": init?.ip ?? "203.0.113.10",
        ...(init?.cookie ? { cookie: init.cookie } : {}),
      },
      body: userBody(text, init?.extra),
    });
  }

  it("a guest turn creates the cart, sets the cookie and stores the conversation", async () => {
    const { model } = strictModel((call) => {
      if (call === 1) {
        return [
          { type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: "call-search", toolName: "search_catalog", input: JSON.stringify({ query: "egusi" }) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
        ];
      }
      if (call === 2) {
        return [
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "call-add",
            toolName: "add_to_cart",
            input: JSON.stringify({ items: [{ variant_id: variantId, qty: 2 }] }),
          },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
        ];
      }
      return [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", delta: "Added two egusi." },
        { type: "text-end", id: "text-1" },
        { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
      ];
    });
    const handler = createChatHandler({ model });
    const response = await handler(request("add two egusi", { ip: "203.0.113.20" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/cart_id=.*; HttpOnly; SameSite=Lax; Path=\//);
    const body = await response.text();
    expect(body).toContain("search_catalog");
    expect(body).toContain("add_to_cart");
    expect(body).toContain("Added two egusi.");
    const cartId = decodeURIComponent(cookie.split(";")[0].slice("cart_id=".length));
    const line = await storeScoped(storeId).cartLine.findFirst({ where: { cartId } });
    expect(line).toMatchObject({ source: "ai", qty: 2, variantId });
    const conversation = await storeScoped(storeId).aiConversation.findFirst({ where: { cartId } });
    expect(conversation?.inFlightUntil).toBeNull();
    expect(JSON.stringify(conversation?.messages)).toContain("add two egusi");
    const actions = await storeScoped(storeId).aiAction.count({ where: { conversationId: conversation?.id } });
    expect(actions).toBe(2);
  });

  it("a second turn reuses the conversation and sends prior messages", async () => {
    const { model, prompts } = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Hello." },
      { type: "text-end", id: "text-1" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    const handler = createChatHandler({ model });
    const first = await handler(request("first turn", { ip: "203.0.113.21" }));
    const cookie = first.headers.get("set-cookie") ?? "";
    await first.text();
    const second = await handler(request("second turn", { ip: "203.0.113.21", cookie: cookie.split(";")[0] }));
    await second.text();
    expect(prompts.length).toBe(2);
    expect(JSON.stringify(prompts[1])).toContain("first turn");
    const cartId = decodeURIComponent(cookie.split(";")[0].slice("cart_id=".length));
    const rows = await storeScoped(storeId).aiConversation.findMany({ where: { cartId } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].messages)).toContain("second turn");
  });

  it("rejects bad input, foreign origin, unknown and suspended stores without calling the model", async () => {
    const seen = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "no" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    const handler = createChatHandler({ model: seen.model });
    const bad = await handler(new Request(`http://${host}/api/assistant/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", host, origin: `http://${host}`, "x-store-slug": slug },
      body: "{",
    }));
    expect(bad.status).toBe(400);
    const long = await handler(request("x".repeat(2001), { ip: "203.0.113.22" }));
    expect(long.status).toBe(400);
    const role = await handler(new Request(`http://${host}/api/assistant/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", host, origin: `http://${host}`, "x-store-slug": slug },
      body: JSON.stringify({ message: { role: "assistant", parts: [{ type: "text", text: "hi" }] } }),
    }));
    expect(role.status).toBe(400);
    const foreign = await handler(request("hello", { origin: "http://evil.test", ip: "203.0.113.23" }));
    expect(foreign.status).toBe(403);
    const missingOrigin = await handler(new Request(`http://${host}/api/assistant/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", host, "x-store-slug": slug },
      body: userBody("hello"),
    }));
    expect(missingOrigin.status).toBe(403);
    const unknown = await handler(new Request(`http://${host}/api/assistant/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", host, origin: `http://${host}`, "x-store-slug": "missing-store" },
      body: userBody("hello"),
    }));
    expect(unknown.status).toBe(404);
    await raw.store.update({ where: { id: storeId }, data: { status: "suspended" } });
    const suspended = await handler(request("hello", { ip: "203.0.113.24" }));
    expect(suspended.status).toBe(403);
    await raw.store.update({ where: { id: storeId }, data: { status: "active" } });
    expect(seen.calls()).toBe(0);
  });

  it("limits by IP and by cart with Retry-After", async () => {
    const clock = new Date("2031-04-01T00:00:00Z");
    const { model } = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "ok" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    const handler = createChatHandler({ model, now: () => clock });
    let last: Response | undefined;
    for (let i = 0; i < 61; i += 1) {
      last = await handler(request(`ip ${i}`, { ip: "198.51.100.8" }));
      if (last.status !== 200) break;
      await last.text();
    }
    expect(last?.status).toBe(429);
    expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = await last!.json();
    expect(body.error.code).toBe("rate_limited");

    const opened = await handler(request("cart open", { ip: "198.51.100.31" }));
    const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];
    expect(opened.status).toBe(200);
    await opened.text();
    let cartLast: Response | undefined;
    for (let i = 0; i < 31; i += 1) {
      cartLast = await handler(request(`cart ${i}`, { ip: `198.51.100.${100 + i}`, cookie }));
      if (cartLast.status !== 200) break;
      await cartLast.text();
    }
    expect(cartLast?.status).toBe(429);
    expect((await cartLast!.json()).error.code).toBe("rate_limited");
  });

  it("returns assistant_unavailable without a key or with an unknown model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ASSISTANT_MODEL", "claude-haiku-5-5");
    const missing = await createChatHandler()(request("hello", { ip: "203.0.113.40" }));
    expect(missing.status).toBe(503);
    expect((await missing.json()).error.code).toBe("assistant_unavailable");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ASSISTANT_MODEL", "gpt-4o");
    const unknown = await createChatHandler()(request("hello", { ip: "203.0.113.41" }));
    expect(unknown.status).toBe(503);
    expect((await unknown.json()).error.code).toBe("assistant_unavailable");
  });

  it("returns assistant_resting at the cap and alerts once", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    vi.stubEnv("ASSISTANT_SPEND_CAP_USD", "0");
    const clock = new Date(Date.UTC(2200, 0, 1) + randomUUID().charCodeAt(0) * 86_400_000);
    const { model, calls } = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "no" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    const handler = createChatHandler({ model, now: () => clock });
    const first = await handler(request("hello", { ip: "203.0.113.50" }));
    expect(first.status).toBe(503);
    expect((await first.json()).error.code).toBe("assistant_resting");
    const second = await handler(request("hello again", { ip: "203.0.113.51" }));
    expect(second.status).toBe(503);
    await second.json();
    expect(calls()).toBe(0);
    expect(errors.filter((line) => line.includes("spend cap reached"))).toHaveLength(1);
  });

  it("a concurrent turn on the same cart gets assistant_busy", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    let hold = false;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        entered += 1;
        if (hold) await gate;
        return { stream: textStream("ok") };
      },
    });
    const handler = createChatHandler({ model });
    const opened = await handler(request("open", { ip: "203.0.113.59" }));
    const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];
    await opened.text();
    entered = 0;
    hold = true;
    const first = handler(request("one", { ip: "203.0.113.60", cookie }));
    await vi.waitFor(() => expect(entered).toBe(1));
    const second = await handler(request("two", { ip: "203.0.113.61", cookie }));
    expect(second.status).toBe(409);
    expect((await second.json()).error.code).toBe("assistant_busy");
    release();
    const done = await first;
    expect(done.status).toBe(200);
    await done.text();
    const cartId = decodeURIComponent(cookie.slice("cart_id=".length));
    const rows = await storeScoped(storeId).aiConversation.findMany({ where: { cartId } });
    const stored = JSON.stringify(rows[0]?.messages);
    expect(stored).toContain("\"text\":\"one\"");
    expect(stored).not.toContain("\"text\":\"two\"");
  });

  it("masks card numbers before the model and the database", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message: unknown) => logs.push(String(message)));
    vi.spyOn(console, "error").mockImplementation((message: unknown) => logs.push(String(message)));
    const { model, prompts } = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "I will not repeat that." },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    const handler = createChatHandler({ model });
    const response = await handler(request("my card is 4242 4242 4242 4242, add rice", { ip: "203.0.113.70" }));
    await response.text();
    expect(JSON.stringify(prompts)).not.toContain("4242");
    const rows = await storeScopedTransaction(storeId, (tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM ai_conversations
        WHERE store_id = ${storeId} AND messages::text LIKE ${"%4242%4242%"}
      `,
    );
    expect(rows).toHaveLength(0);
    const stored = await storeScoped(storeId).aiConversation.findMany({ where: { storeId } });
    expect(JSON.stringify(stored.map((row) => row.messages))).toContain("[card number removed]");
    expect(logs.join("\n")).not.toContain("4242");
  });

  it("an expired lease is taken over", async () => {
    let clock = Date.parse("2033-02-01T00:00:00Z");
    let hold = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (hold) await gate;
        return { stream: textStream("ok") };
      },
    });
    const handler = createChatHandler({ model, now: () => new Date(clock) });
    const opened = await handler(request("open", { ip: "203.0.113.80" }));
    const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];
    await opened.text();
    hold = true;
    const stuck = handler(request("stuck", { ip: "203.0.113.81", cookie }));
    await vi.waitFor(async () => {
      const cartId = decodeURIComponent(cookie.slice("cart_id=".length));
      const row = await storeScoped(storeId).aiConversation.findFirst({ where: { cartId } });
      expect(row?.inFlightUntil).not.toBeNull();
    });
    clock += 91_000;
    const next = await handler(request("next", { ip: "203.0.113.82", cookie }));
    expect(next.status).toBe(200);
    release();
    await stuck;
    await next.text();
  });

  it("the lease is released after an error", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "error", error: new Error("Overloaded") },
        ]),
      }),
    });
    const handler = createChatHandler({ model });
    const response = await handler(request("save me", { ip: "203.0.113.83" }));
    const body = await response.text();
    expect(body).toContain("Sorry, something went wrong");
    expect(body).not.toContain("Overloaded");
    const rows = await storeScoped(storeId).aiConversation.findMany({ where: { storeId } });
    const saved = rows.find((row) => JSON.stringify(row.messages).includes("save me"));
    expect(saved?.inFlightUntil).toBeNull();
  });

  it("ignores cartId and storeId in the body", async () => {
    const { model } = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "ok" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    const handler = createChatHandler({ model });
    const opened = await handler(request("mine", { ip: "203.0.113.84" }));
    const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];
    await opened.text();
    const cartId = decodeURIComponent(cookie.slice("cart_id=".length));
    const response = await handler(request("again", {
      ip: "203.0.113.85",
      cookie,
      extra: { cartId: "cart-from-another-store", storeId: "store-from-another-store" },
    }));
    await response.text();
    const rows = await storeScoped(storeId).aiConversation.findMany({ where: { cartId } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].messages)).toContain("again");
  });

  it("streams (see card) for an amount no tool returned", async () => {
    const { model } = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "That is $3.00." },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    const handler = createChatHandler({ model });
    const response = await handler(request("price?", { ip: "203.0.113.86" }));
    const body = await response.text();
    expect(body).toContain("(see card)");
    expect(body).not.toContain("3.00");
  });

  it("stops at eight steps with the step-limit part", async () => {
    let n = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        n += 1;
        return {
          stream: streamOf([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: `call-${n}`, toolName: "get_cart_summary", input: "{}" },
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
          ]),
        };
      },
    });
    const handler = createChatHandler({ model });
    const response = await handler(request("keep going", { ip: "203.0.113.87" }));
    const body = await response.text();
    expect(n).toBe(8);
    expect(body).toContain("data-step-limit");
    expect(body).toContain("I've done as much as I can in one go");
  });

  it("finishes and saves the turn after the client aborts", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await gate;
        return { stream: textStream("still here") };
      },
    });
    const handler = createChatHandler({ model });
    const response = await handler(request("do not drop this", { ip: "203.0.113.88" }));
    const reader = response.body?.getReader();
    await reader?.cancel();
    release();
    await vi.waitFor(async () => {
      const rows = await storeScoped(storeId).aiConversation.findMany({ where: { storeId } });
      const saved = rows.find((row) => JSON.stringify(row.messages).includes("do not drop this"));
      expect(saved?.inFlightUntil).toBeNull();
      expect(JSON.stringify(saved?.messages)).toContain("still here");
    });
  });

  it("store context uses the store time zone and overnight hours", async () => {
    await raw.store.update({
      where: { id: storeId },
      data: { hours: { tue: "22:00-02:00" } },
    });
    const wednesdayMorning = new Date("2026-11-04T07:00:00.000Z");
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        return { stream: textStream("ok") };
      },
    });
    const handler = createChatHandler({ model, now: () => wednesdayMorning });
    const response = await handler(request("are you open", { ip: "203.0.113.89" }));
    await response.text();
    const prompt = JSON.stringify(prompts[0]);
    expect(prompt).toContain("Open now: yes");
    expect(prompt).toContain("Today: 2026-11-04");
    await raw.store.update({
      where: { id: storeId },
      data: { hours: { wed: "not-hours" } },
    });
    const again = await handler(request("still open", { ip: "203.0.113.90" }));
    await again.text();
    expect(JSON.stringify(prompts[1])).toContain("Open now: yes");
  });

  it("a signed-in customer keeps the guest cart and conversation after sign-in", async () => {
    const email = `ada-${randomUUID().slice(0, 8)}@example.com`;
    const password = "CartLink-123!";
    const signedUp = await auth.handler(new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ email, password, name: "Ada" }),
    }));
    expect(signedUp.status, await signedUp.clone().text()).toBe(200);
    const signedIn = await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ email, password }),
    }));
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const session = (signedIn.headers.getSetCookie?.() ?? []).map((value) => value.split(";")[0]).join("; ");
    const user = await authPrisma.user.findFirstOrThrow({ where: { email } });
    const { model } = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "ok" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    const handler = createChatHandler({ model });
    const guest = await handler(request("guest hello", { ip: "203.0.113.110" }));
    const cartCookie = (guest.headers.get("set-cookie") ?? "").split(";")[0];
    await guest.text();
    const cartId = decodeURIComponent(cartCookie.slice("cart_id=".length));
    const signed = await handler(request("signed hello", {
      ip: "203.0.113.111",
      cookie: `${cartCookie}; ${session}`,
    }));
    expect(signed.status).toBe(200);
    await signed.text();
    const cart = await storeScoped(storeId).cart.findUnique({ where: { id: cartId } });
    expect(cart?.userId).toBe(user.id);
    const rows = await storeScoped(storeId).aiConversation.findMany({ where: { cartId } });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].messages)).toContain("signed hello");
    await storeScoped(storeId).customer.deleteMany({ where: { userId: user.id } });
    await authPrisma.session.deleteMany({ where: { userId: user.id } });
    await authPrisma.account.deleteMany({ where: { userId: user.id } });
    await authPrisma.user.delete({ where: { id: user.id } });
  });

  it("E2 a transcript save failure still returns the stream and releases the cart", async () => {
    const { model: opener } = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "opened" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    const opened = await createChatHandler({ model: opener })(request("open the cart", { ip: "203.0.113.120" }));
    const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];
    await opened.text();
    const cartId = decodeURIComponent(cookie.slice("cart_id=".length));
    const before = await raw.assistantSpendDay.aggregate({ _sum: { costMicros: true } });
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
    vi.stubEnv("ASSISTANT_MODEL", "claude-haiku-5-5");
    const fake = createFakeAnthropicFetch({
      expectedKey: "sk-ant-test",
      steps: [{ kind: "text", text: "kept reply", inputTokens: 20, outputTokens: 5 }],
    });
    const model = createAssistantModel({
      fetch: async (input, init) => {
        await storeScoped(storeId).aiConversation.deleteMany({ where: { cartId } });
        return fake.fetch(input, init);
      },
    });
    const response = await createChatHandler({ model })(request("save will fail", { ip: "203.0.113.121", cookie }));
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("kept reply");
    expect(errors.some((line) => line.includes("transcript not saved"))).toBe(true);
    const after = await raw.assistantSpendDay.aggregate({ _sum: { costMicros: true } });
    expect(after._sum.costMicros ?? BigInt(0)).toBeGreaterThan(before._sum.costMicros ?? BigInt(0));
    const again = await createChatHandler({ model: opener })(request("cart is free", { ip: "203.0.113.122", cookie }));
    expect(again.status).toBe(200);
    await again.text();
  });

  it("E3 an account cart cookie without that session becomes a new guest cart", async () => {
    const email = `owner-${randomUUID().slice(0, 8)}@example.com`;
    const password = "CartLink-123!";
    const signedUp = await auth.handler(new Request("http://localhost:3000/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:3000" },
      body: JSON.stringify({ email, password, name: "Owner" }),
    }));
    expect(signedUp.status).toBe(200);
    const user = await authPrisma.user.findFirstOrThrow({ where: { email } });
    const owned = await storeScoped(storeId).cart.create({
      data: { storeId, userId: user.id, source: "manual" },
    });
    const { model } = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "new cart" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    const response = await createChatHandler({ model })(request("guest on someone else's cart", {
      ip: "203.0.113.123",
      cookie: `cart_id=${encodeURIComponent(owned.id)}`,
    }));
    expect(response.status).toBe(200);
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
    const nextCart = decodeURIComponent(cookie.slice("cart_id=".length));
    expect(nextCart).not.toBe(owned.id);
    await response.text();
    const stillOwned = await storeScoped(storeId).cart.findUnique({ where: { id: owned.id } });
    expect(stillOwned?.userId).toBe(user.id);
    const guestCart = await storeScoped(storeId).cart.findUnique({ where: { id: nextCart } });
    expect(guestCart?.userId).toBeNull();
    const ownedTalk = await storeScoped(storeId).aiConversation.findMany({ where: { cartId: owned.id } });
    expect(ownedTalk).toHaveLength(0);
    const guestTalk = await storeScoped(storeId).aiConversation.findMany({ where: { cartId: nextCart } });
    expect(JSON.stringify(guestTalk[0]?.messages)).toContain("guest on someone else's cart");
    await storeScoped(storeId).customer.deleteMany({ where: { userId: user.id } });
    await authPrisma.session.deleteMany({ where: { userId: user.id } });
    await authPrisma.account.deleteMany({ where: { userId: user.id } });
    await authPrisma.user.delete({ where: { id: user.id } });
  });

  it("E4 a cart cookie from another store leaves that store untouched", async () => {
    const other = await raw.store.create({
      data: {
        slug: `ai-chat-b-${randomUUID().slice(0, 8)}`,
        name: "Other Market",
        themePreset: "palm-and-shea",
        status: "active",
        timezone: "America/Chicago",
        minimumOrderCents: 0,
        pickupEnabled: true,
        hours: { wed: "09:00-17:00" },
      },
    });
    const otherCart = await storeScoped(other.id).cart.create({
      data: { storeId: other.id, source: "manual" },
    });
    await storeScoped(other.id).aiConversation.create({
      data: {
        storeId: other.id,
        cartId: otherCart.id,
        model: "claude-haiku-5-5",
        messages: [{ id: "kept", role: "user", parts: [{ type: "text", text: "other-store-marker" }] }],
      },
    });
    const { model } = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "this store" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    const response = await createChatHandler({ model })(request("hello here", {
      ip: "203.0.113.124",
      cookie: `cart_id=${encodeURIComponent(otherCart.id)}`,
    }));
    expect(response.status).toBe(200);
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
    const here = decodeURIComponent(cookie.slice("cart_id=".length));
    expect(here).not.toBe(otherCart.id);
    await response.text();
    const untouched = await storeScoped(other.id).aiConversation.findMany({ where: { cartId: otherCart.id } });
    expect(JSON.stringify(untouched[0]?.messages)).toContain("other-store-marker");
    expect(JSON.stringify(untouched[0]?.messages)).not.toContain("hello here");
    await storeScoped(other.id).cart.deleteMany({});
    await raw.store.delete({ where: { id: other.id } });
  });

  it("E7 empty, whitespace, and exactly 2000 characters", async () => {
    const seen = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "ok" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    const handler = createChatHandler({ model: seen.model });
    const empty = await handler(request("", { ip: "203.0.113.125" }));
    expect(empty.status).toBe(400);
    const blank = await handler(request("   \n\t  ", { ip: "203.0.113.126" }));
    expect(blank.status).toBe(400);
    const exact = await handler(request("y".repeat(2000), { ip: "203.0.113.127" }));
    expect(exact.status).toBe(200);
    await exact.text();
    const over = await handler(request("z".repeat(2001), { ip: "203.0.113.128" }));
    expect(over.status).toBe(400);
    expect(seen.calls()).toBe(1);
  });

  it("E8 history of 80 messages sends the last 30 and keeps all", async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        return { stream: textStream("history ok") };
      },
    });
    const handler = createChatHandler({ model });
    const opened = await handler(request("seed history", { ip: "203.0.113.129" }));
    const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];
    await opened.text();
    const cartId = decodeURIComponent(cookie.slice("cart_id=".length));
    const history = Array.from({ length: 80 }, (_, index) => ({
      id: `hist-${index}`,
      role: index % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `history-marker-${index}` }],
    }));
    await storeScoped(storeId).aiConversation.update({
      where: { storeId_cartId: { storeId, cartId } },
      data: { messages: history },
    });
    prompts.length = 0;
    const response = await handler(request("the newest line", { ip: "203.0.113.130", cookie }));
    expect(response.status).toBe(200);
    await response.text();
    const prompt = JSON.stringify(prompts[0]);
    expect(prompt).toContain("history-marker-79");
    expect(prompt).toContain("history-marker-51");
    expect(prompt).not.toContain("history-marker-0");
    const stored = await storeScoped(storeId).aiConversation.findFirstOrThrow({ where: { cartId } });
    const text = JSON.stringify(stored.messages);
    expect(text).toContain("history-marker-0");
    expect(text).toContain("history-marker-79");
    expect(text).toContain("the newest line");
  });

  it("E9 a renamed tool in stored history does not fail the turn", async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        return { stream: textStream("still working") };
      },
    });
    const handler = createChatHandler({ model });
    const opened = await handler(request("seed tools", { ip: "203.0.113.131" }));
    const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];
    await opened.text();
    const cartId = decodeURIComponent(cookie.slice("cart_id=".length));
    await storeScoped(storeId).aiConversation.update({
      where: { storeId_cartId: { storeId, cartId } },
      data: {
        messages: [{
          id: "old-tool",
          role: "assistant",
          parts: [
            { type: "text", text: "keep-history" },
            {
              type: "tool-renamed_tool",
              toolCallId: "call-old",
              state: "input-available",
              input: {},
            },
          ],
        }],
      },
    });
    const response = await handler(request("continue", { ip: "203.0.113.132", cookie }));
    expect(response.status).toBe(200);
    await response.text();
    const prompt = JSON.stringify(prompts.at(-1));
    expect(prompt).toContain("keep-history");
    expect(prompt).not.toContain("renamed_tool");
  });

  it("E10 the rate limit key uses the first x-forwarded-for entry", async () => {
    const { model } = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "ok" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    const response = await createChatHandler({ model })(request("from a proxy", { ip: "1.1.1.1, 2.2.2.2" }));
    expect(response.status).toBe(200);
    await response.text();
    const first = await raw.rateLimit.findUnique({ where: { key: "assistant:ip:1.1.1.1" } });
    const second = await raw.rateLimit.findUnique({ where: { key: "assistant:ip:2.2.2.2" } });
    expect(first?.count).toBeGreaterThan(0);
    expect(second).toBeNull();
  });

  it("E12 an unreadable spend ledger rests the helper", async () => {
    const seen = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "no" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    vi.spyOn(spend, "assistantSpendState").mockRejectedValue(new Error("ledger down"));
    const response = await createChatHandler({ model: seen.model })(request("hello", { ip: "203.0.113.133" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("assistant_resting");
    expect(seen.calls()).toBe(0);
  });

  it("E14 an abort then a retry is busy until the turn ends", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    let hold = false;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        entered += 1;
        if (hold) await gate;
        return { stream: textStream("done after abort") };
      },
    });
    const handler = createChatHandler({ model });
    const opened = await handler(request("open", { ip: "203.0.113.134" }));
    const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];
    await opened.text();
    entered = 0;
    hold = true;
    const first = await handler(request("in flight", { ip: "203.0.113.135", cookie }));
    await vi.waitFor(() => expect(entered).toBe(1));
    const reader = first.body?.getReader();
    const cancelled = reader?.cancel();
    const busy = await handler(request("retry too soon", { ip: "203.0.113.136", cookie }));
    expect(busy.status).toBe(409);
    expect((await busy.json()).error.code).toBe("assistant_busy");
    release();
    await cancelled;
    const cartId = decodeURIComponent(cookie.slice("cart_id=".length));
    await vi.waitFor(async () => {
      const row = await storeScoped(storeId).aiConversation.findFirst({ where: { cartId } });
      expect(row?.inFlightUntil).toBeNull();
    });
    const again = await handler(request("after it ends", { ip: "203.0.113.137", cookie }));
    expect(again.status).toBe(200);
    await again.text();
  });

  it("E15 a suspended store with a valid cart cookie leaves the cart untouched", async () => {
    const cart = await storeScoped(storeId).cart.create({
      data: { storeId, source: "manual" },
    });
    await storeScoped(storeId).cartLine.create({
      data: { storeId, cartId: cart.id, variantId, qty: 1, source: "manual" },
    });
    const seen = strictModel(() => [
      { type: "stream-start", warnings: [] },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "no" },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
    ]);
    await raw.store.update({ where: { id: storeId }, data: { status: "suspended" } });
    const response = await createChatHandler({ model: seen.model })(request("still there?", {
      ip: "203.0.113.138",
      cookie: `cart_id=${encodeURIComponent(cart.id)}`,
    }));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("store_suspended");
    await raw.store.update({ where: { id: storeId }, data: { status: "active" } });
    const line = await storeScoped(storeId).cartLine.findFirst({ where: { cartId: cart.id } });
    expect(line?.qty).toBe(1);
    const talk = await storeScoped(storeId).aiConversation.findMany({ where: { cartId: cart.id } });
    expect(talk).toHaveLength(0);
    expect(seen.calls()).toBe(0);
  });
});
