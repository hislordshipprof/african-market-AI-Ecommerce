import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { stepCountIs, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";

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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeScoped } from "../../db";
import { assistantTools } from "./index";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("assistant tool loop", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  let cartId = "";
  let conversationId = "";
  let foreignVariant = "";

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const suffix = randomUUID().slice(0, 8);
    storeA = (await raw.store.create({
      data: { slug: `ai-loop-a-${suffix}`, name: "Loop A", themePreset: "palm-and-shea" },
    })).id;
    storeB = (await raw.store.create({
      data: { slug: `ai-loop-b-${suffix}`, name: "Loop B", themePreset: "lagoon-and-coral" },
    })).id;
    cartId = (await storeScoped(storeA).cart.create({ data: { storeId: storeA, source: "manual" } })).id;
    conversationId = (await storeScoped(storeA).aiConversation.create({
      data: { storeId: storeA, cartId, model: "claude-haiku-5-5", messages: [] },
    })).id;
    const listing = await storeScoped(storeB).listing.create({
      data: {
        storeId: storeB,
        customName: "Foreign",
        price: 100,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    foreignVariant = (await storeScoped(storeB).listingVariant.create({
      data: { listingId: listing.id, label: "Each", price: 100, weightG: 100 },
    })).id;
  });

  afterAll(async () => {
    if (storeA) await storeScoped(storeA).cart.deleteMany({});
    if (storeB) await storeScoped(storeB).listing.deleteMany({});
    if (raw) {
      await raw.store.deleteMany({ where: { id: { in: [storeA, storeB].filter(Boolean) } } });
      await raw.$disconnect();
    }
  });

  function modelWith(firstInput: unknown) {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        const chunks = prompts.length === 1
          ? [
              { type: "stream-start", warnings: [] },
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "add_to_cart",
                input: JSON.stringify(firstInput),
              },
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
            ]
          : [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "text-1" },
              { type: "text-delta", id: "text-1", delta: "Noted." },
              { type: "text-end", id: "text-1" },
              { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
            ];
        return { stream: streamOf(chunks) };
      },
    });
    return { model, prompts };
  }

  it("a failing tool returns ok:false to the model and the loop continues", async () => {
    const { model, prompts } = modelWith({ items: [{ variant_id: foreignVariant, qty: 1 }] });
    const result = streamText({
      model,
      prompt: "Add that item",
      tools: assistantTools({
        storeId: storeA,
        cartId,
        conversationId,
        actorUserId: null,
      }),
      stopWhen: stepCountIs(4),
    });
    await result.consumeStream();
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain("variant_not_found");
    expect(await storeScoped(storeA).cartLine.count({ where: { cartId } })).toBe(0);
    const action = await storeScoped(storeA).aiAction.findFirst({
      where: { conversationId, tool: "add_to_cart" },
    });
    expect(action?.ok).toBe(false);
  });

  it("a schema rejection comes back to the model and writes nothing", async () => {
    const before = await storeScoped(storeA).aiAction.count({ where: { conversationId } });
    const { model, prompts } = modelWith({ items: [{ variant_id: foreignVariant, qty: 100 }] });
    const result = streamText({
      model,
      prompt: "Add one hundred",
      tools: assistantTools({
        storeId: storeA,
        cartId,
        conversationId,
        actorUserId: null,
      }),
      stopWhen: stepCountIs(4),
    });
    await result.consumeStream();
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    expect(await storeScoped(storeA).cartLine.count({ where: { cartId } })).toBe(0);
    expect(await storeScoped(storeA).aiAction.count({ where: { conversationId } })).toBe(before);
  });
});
