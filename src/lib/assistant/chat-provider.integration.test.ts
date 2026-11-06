import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { updateLineQty } from "../cart/service";
import { storeScoped } from "../db";
import { createFakeAnthropicFetch } from "./messages-api-double";
import { createAssistantModel } from "./model";
import { ASSISTANT_STATIC_PROMPT } from "./system-prompt";
import { createChatHandler } from "./chat-handler";
import { assistantSpendState } from "./spend";

process.env.ASSISTANT_CHAT_ENABLED = "1";

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
    if (storeA) await storeScoped(storeA).listing.deleteMany({});
    if (storeB) await storeScoped(storeB).listing.deleteMany({});
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

  function message(id: string, text: string, cookie?: string, slug = slugA, ip = "203.0.113.180") {
    return new Request("http://prov.test/api/assistant/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "prov.test",
        origin: "http://prov.test",
        "x-store-slug": slug,
        "x-forwarded-for": ip,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify({
        message: { id, role: "user", parts: [{ type: "text", text }] },
      }),
    });
  }

  async function listing(storeId: string, name: string, price: number) {
    const row = await storeScoped(storeId).listing.create({
      data: {
        storeId,
        customName: name,
        price,
        stockMode: "unlimited",
        confidence: 1,
        active: true,
        frozen: false,
        perishable: false,
      },
    });
    const variant = await storeScoped(storeId).listingVariant.create({
      data: { listingId: row.id, label: "Each", price, weightG: 100 },
    });
    return { listingId: row.id, variantId: variant.id };
  }

  async function settled(storeId: string, cartId: string) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const row = await storeScoped(storeId).aiConversation.findFirst({ where: { storeId, cartId } });
      if (row && row.inFlightUntil == null) return row;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("assistant turn did not settle");
  }

  function assistantText(messages: unknown): string[] {
    if (!Array.isArray(messages)) return [];
    return messages.flatMap((message) => {
      if (!message || typeof message !== "object" || (message as { role?: string }).role !== "assistant") return [];
      const parts = (message as { parts?: Array<{ type?: string; text?: string }> }).parts ?? [];
      return parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text ?? "");
    });
  }

  async function stripAmounts(storeId: string, amounts: string[]) {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const rows = await storeScoped(storeId).aiAction.findMany({
        where: { storeId, tool: "grounding_strip" },
      });
      const found = new Set(rows.map((row) => JSON.stringify(row.input)));
      if (amounts.every((amount) => [...found].some((input) => input.includes(amount)))) return rows;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`grounding strips not saved: ${amounts.join(", ")}`);
  }

  it("real prices from earlier turns and cart totals reach the shopper; invented and stale amounts do not", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", "claude-haiku-5-5");
    const egusi = await listing(storeA, "Egusi", 1099);
    const fake = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [
        { kind: "tool", toolName: "search_catalog", toolInput: { query: "Egusi" } },
        { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: egusi.variantId, qty: 2 }] } },
        { kind: "text", text: "Added 2 at $10.99 each, $21.98 total." },
        {
          kind: "text",
          text: "Your cart still has 2 packs of Egusi at $10.99 each. Adding more would bring the subtotal to $21.98. A basket that is not in the cart would bring the subtotal to $35.94.",
        },
        { kind: "tool", toolName: "search_catalog", toolInput: { query: "Egusi" } },
        { kind: "text", text: "Egusi is $8.99. It was $10.99." },
      ],
    });
    const handler = createChatHandler({ model: createAssistantModel({ fetch: fake.fetch }) });
    const first = await handler(message("egusi-turn-1", "add egusi", undefined, slugA, "203.0.113.181"));
    expect(first.status).toBe(200);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    const turn1 = await first.text();
    expect(turn1).toContain("$10.99");
    expect(turn1).toContain("$21.98");
    expect(turn1).not.toContain("(see card)");
    const cartId = decodeURIComponent(cookie.slice("cart_id=".length));
    const saved1 = await settled(storeA, cartId);
    const addAction = await storeScoped(storeA).aiAction.findFirst({
      where: { conversationId: saved1.id, tool: "add_to_cart" },
    });
    expect(addAction?.output).toMatchObject({
      unitPriceCents: 1099,
      lineTotalCents: 2198,
      addedTotalCents: 2198,
      subtotalCents: 2198,
    });
    const searchAction = await storeScoped(storeA).aiAction.findFirst({
      where: { conversationId: saved1.id, tool: "search_catalog" },
    });
    expect(JSON.stringify(searchAction?.output)).toContain("1099");
    const sent = fake.requests.map((request) => JSON.stringify(request.body));
    expect(sent[1]).toContain("1099");
    expect(sent[2]).toContain("lineTotalCents");
    expect(sent[2]).toContain("2198");
    const line = await storeScoped(storeA).cartLine.findFirst({ where: { cartId, variantId: egusi.variantId } });
    await updateLineQty(storeA, cartId, line!.id, 1, null);
    const second = await handler(message("egusi-turn-2", "what is in the cart", cookie, slugA, "203.0.113.181"));
    const turn2 = await second.text();
    expect(turn2).toContain("$10.99");
    expect(turn2).toContain("I couldn't confirm that price.");
    expect(turn2).not.toContain("21.98");
    expect(turn2).not.toContain("35.94");
    expect(turn2).not.toContain("(see card)");
    await stripAmounts(storeA, ["$21.98", "$35.94"]);
    const saved2 = await settled(storeA, cartId);
    const texts = assistantText(saved2.messages);
    expect(texts.some((text) => text.includes("$21.98"))).toBe(true);
    const later = texts.find((text) => text.includes("still has"));
    expect(later).toContain("$10.99");
    expect(later).not.toContain("21.98");
    expect(later).not.toContain("35.94");
    expect(JSON.stringify(fake.requests[3]?.body)).toContain("tool_result");
    expect(JSON.stringify(fake.requests[3]?.body)).toContain("2198");
    await storeScoped(storeA).listingVariant.update({ where: { id: egusi.variantId }, data: { price: 899 } });
    const third = await handler(message("egusi-turn-3", "what does it cost now", cookie, slugA, "203.0.113.181"));
    const turn3 = await third.text();
    expect(turn3).toContain("$8.99");
    expect(turn3).toContain("I couldn't confirm that price.");
    expect(turn3).not.toContain("10.99");
    expect(turn3).not.toContain("(see card)");
    await stripAmounts(storeA, ["$10.99"]);
    const saved3 = await settled(storeA, cartId);
    const fresh = assistantText(saved3.messages).find((text) => text.includes("$8.99"));
    expect(fresh).toContain("I couldn't confirm that price.");
    expect(fresh).not.toContain("10.99");
  }, 30_000);

  it("only validated prices within the sent history window are carried forward", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", "claude-haiku-5-5");
    const opened = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [{ kind: "text", text: "Ready." }],
    });
    const opener = createChatHandler({ model: createAssistantModel({ fetch: opened.fetch }) });
    const first = await opener(message("window-open-1", "hello", undefined, slugA, "203.0.113.190"));
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    await first.text();
    const cartId = decodeURIComponent(cookie.slice("cart_id=".length));
    const row = await settled(storeA, cartId);
    const filler = Array.from({ length: 30 }, (_, index) => ({
      id: `window-pad-${index}-abcd`,
      role: index % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: index === 29 ? "The old card said $77.77." : `pad ${index}` }],
    }));
    const expired = {
      id: "window-old-tool-1",
      role: "assistant",
      parts: [{
        type: "tool-search_catalog",
        toolCallId: "window-old-call",
        state: "output-available",
        input: { query: "old" },
        output: { ok: true, items: [{ variantId: "variant-old", listingId: "listing-old", priceCents: 7777 }] },
      }],
    };
    await storeScoped(storeA).aiConversation.update({
      where: { id: row.id },
      data: { messages: [expired, ...filler] as never },
    });
    const quoted = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [{ kind: "text", text: "That old price is $77.77." }],
    });
    const handler = createChatHandler({ model: createAssistantModel({ fetch: quoted.fetch }) });
    const response = await handler(message("window-turn-2", "repeat the old price", cookie, slugA, "203.0.113.190"));
    const body = await response.text();
    expect(body).toContain("I couldn't confirm that price.");
    expect(body).not.toContain("77.77");
    const invalid = {
      id: "window-bad-tool-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Remember $42.42 from the broken tool." },
        {
          type: "tool-search_catalog",
          toolCallId: "window-bad-call",
          state: "output-available",
          input: { query: 12 },
          output: { ok: true, items: [{ variantId: "variant-bad", priceCents: 4242 }] },
        },
      ],
    };
    await storeScoped(storeA).aiConversation.update({
      where: { id: row.id },
      data: { messages: [invalid] as never },
    });
    const broken = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [{ kind: "text", text: "The broken tool price is $42.42." }],
    });
    const again = await createChatHandler({ model: createAssistantModel({ fetch: broken.fetch }) })(
      message("window-turn-3", "repeat the broken price", cookie, slugA, "203.0.113.190"),
    );
    const brokenBody = await again.text();
    expect(brokenBody).toContain("I couldn't confirm that price.");
    expect(brokenBody).not.toContain("42.42");
  }, 30_000);

  it("repricing preserves independent price sources and only the newest keyed price survives the next turn", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", "claude-haiku-5-5");
    const suffix = randomUUID().slice(0, 8);
    const store = await raw.store.create({
      data: { slug: `reprice-${suffix}`, name: "Reprice", themePreset: "palm-and-shea", minimumOrderCents: 500 },
    });
    try {
      const egusi = await listing(store.id, "Reprice Egusi", 1099);
      const palm = await listing(store.id, "Reprice Palm", 1099);
      const bark = await listing(store.id, "Reprice Bark", 1499);
      let seen = 0;
      const inner = createFakeAnthropicFetch({
        expectedKey: KEY,
        steps: [
          { kind: "tool", toolName: "show_products", toolInput: { listing_ids: [egusi.listingId, palm.listingId] } },
          { kind: "text", text: "Both are $10.99." },
          { kind: "tool", toolName: "show_products", toolInput: { listing_ids: [egusi.listingId] } },
          { kind: "tool", toolName: "show_products", toolInput: { listing_ids: [egusi.listingId] } },
          { kind: "text", text: "Egusi is $8.99. Earlier it was $10.99. Palm is $10.99." },
          { kind: "tool", toolName: "check_availability", toolInput: { listing_ids: [bark.listingId] } },
          { kind: "tool", toolName: "show_products", toolInput: { listing_ids: [palm.listingId] } },
          { kind: "text", text: "Palm is $7.99. Bark is $14.99. The shared price was $10.99." },
          { kind: "tool", toolName: "add_to_cart", toolInput: { items: [{ variant_id: egusi.variantId, qty: 1 }] } },
          { kind: "tool", toolName: "get_cart_summary", toolInput: {} },
          { kind: "text", text: "Egusi is $8.99. The minimum is $5.00. Invented is $6.66." },
        ],
      });
      const fetchImpl: typeof fetch = async (input, init) => {
        seen += 1;
        if (seen === 4) {
          await storeScoped(store.id).listingVariant.update({ where: { id: egusi.variantId }, data: { price: 899 } });
        }
        if (seen === 7) {
          await storeScoped(store.id).listingVariant.update({ where: { id: palm.variantId }, data: { price: 799 } });
        }
        return inner.fetch(input, init);
      };
      const handler = createChatHandler({ model: createAssistantModel({ fetch: fetchImpl }) });
      const opened = await handler(message("reprice-turn-1", "show both", undefined, store.slug, "203.0.113.191"));
      const cookie = (opened.headers.get("set-cookie") ?? "").split(";")[0];
      const turn1 = await opened.text();
      expect(turn1).toContain("$10.99");
      const cartId = decodeURIComponent(cookie.slice("cart_id=".length));
      await settled(store.id, cartId);
      const turn2 = await (await handler(message("reprice-turn-2", "reprice egusi", cookie, store.slug, "203.0.113.191"))).text();
      expect(turn2).toContain("$8.99");
      expect(turn2).toContain("$10.99");
      await settled(store.id, cartId);
      const turn3 = await (await handler(message("reprice-turn-3", "reprice palm", cookie, store.slug, "203.0.113.191"))).text();
      expect(turn3).toContain("$7.99");
      expect(turn3).toContain("$14.99");
      expect(turn3).toContain("I couldn't confirm that price.");
      expect(turn3).not.toContain("10.99");
      await settled(store.id, cartId);
      const turn4 = await (await handler(message("reprice-turn-4", "totals", cookie, store.slug, "203.0.113.191"))).text();
      expect(turn4).toContain("$8.99");
      expect(turn4).toContain("$5.00");
      expect(turn4).toContain("I couldn't confirm that price.");
      expect(turn4).not.toContain("6.66");
      const summary = await storeScoped(store.id).aiAction.findFirst({
        where: { tool: "get_cart_summary", conversation: { cartId } },
      });
      expect(JSON.stringify(summary?.output)).toContain(egusi.variantId);
    } finally {
      await storeScoped(store.id).cart.deleteMany({});
      await storeScoped(store.id).listing.deleteMany({});
      await raw.store.delete({ where: { id: store.id } });
    }
  }, 30_000);

  it("simultaneous conversations do not share prices or minimums", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", KEY);
    vi.stubEnv("ASSISTANT_MODEL", "claude-haiku-5-5");
    const left = await listing(storeA, "Left Egusi", 1099);
    const right = await listing(storeB, "Right Palm", 2599);
    const fakeA = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [
        { kind: "tool", toolName: "show_products", toolInput: { listing_ids: [left.listingId] } },
        { kind: "text", text: "Ours is $10.99. Theirs is $25.99. The minimum is $10.00. Their minimum is $25.00." },
      ],
    });
    const fakeB = createFakeAnthropicFetch({
      expectedKey: KEY,
      steps: [
        { kind: "tool", toolName: "show_products", toolInput: { listing_ids: [right.listingId] } },
        { kind: "text", text: "Ours is $25.99. Theirs is $10.99. The minimum is $25.00. Their minimum is $10.00." },
      ],
    });
    const handlerA = createChatHandler({ model: createAssistantModel({ fetch: fakeA.fetch }) });
    const handlerB = createChatHandler({ model: createAssistantModel({ fetch: fakeB.fetch }) });
    const [bodyA, bodyB] = await Promise.all([
      handlerA(message("iso-turn-a1", "price", undefined, slugA, "203.0.113.192")).then((response) => response.text()),
      handlerB(message("iso-turn-b1", "price", undefined, slugB, "203.0.113.193")).then((response) => response.text()),
    ]);
    expect(bodyA).toContain("$10.99");
    expect(bodyA).toContain("$10.00");
    expect(bodyA).not.toContain("25.99");
    expect(bodyA).not.toContain("25.00");
    expect(bodyB).toContain("$25.99");
    expect(bodyB).toContain("$25.00");
    expect(bodyB).not.toContain("10.99");
    expect(bodyB).not.toContain("10.00");
  }, 30_000);
});
