import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  platformSessionUser,
  storeScoped,
  storeScopedTransaction,
} from "../db";
import { isRlsRejection } from "../listing/cross-store-write";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("assistant records isolation", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  let cartA = "";
  let cartB = "";
  let customerA = "";
  let customerB = "";
  let conversationA = "";
  let conversationB = "";
  let actionA = "";

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const suffix = randomUUID().slice(0, 8);
    const a = await raw.store.create({
      data: { slug: `ai-rec-a-${suffix}`, name: "Assistant A", themePreset: "palm-and-shea" },
    });
    const b = await raw.store.create({
      data: { slug: `ai-rec-b-${suffix}`, name: "Assistant B", themePreset: "lagoon-and-coral" },
    });
    storeA = a.id;
    storeB = b.id;
    cartA = (await storeScoped(storeA).cart.create({
      data: { storeId: storeA, source: "manual" },
    })).id;
    cartB = (await storeScoped(storeB).cart.create({
      data: { storeId: storeB, source: "manual" },
    })).id;
    customerA = (await storeScoped(storeA).customer.create({
      data: { storeId: storeA, name: "Ada" },
    })).id;
    customerB = (await storeScoped(storeB).customer.create({
      data: { storeId: storeB, name: "Bea" },
    })).id;
    conversationA = (await storeScoped(storeA).aiConversation.create({
      data: {
        storeId: storeA,
        cartId: cartA,
        customerId: customerA,
        model: "claude-haiku-5-5",
        messages: [],
      },
    })).id;
    conversationB = (await storeScoped(storeB).aiConversation.create({
      data: {
        storeId: storeB,
        cartId: cartB,
        customerId: customerB,
        model: "claude-haiku-5-5",
        messages: [],
      },
    })).id;
    actionA = (await storeScoped(storeA).aiAction.create({
      data: {
        storeId: storeA,
        conversationId: conversationA,
        tool: "search_catalog",
        input: { query: "egusi" },
        output: { ok: true },
        ok: true,
      },
    })).id;
    await storeScoped(storeB).aiAction.create({
      data: {
        storeId: storeB,
        conversationId: conversationB,
        tool: "search_catalog",
        input: { query: "rice" },
        output: { ok: true },
        ok: true,
      },
    });
  });

  afterAll(async () => {
    if (storeA) await storeScoped(storeA).cart.deleteMany({});
    if (storeB) await storeScoped(storeB).cart.deleteMany({});
    if (storeA) await storeScoped(storeA).customer.deleteMany({});
    if (storeB) await storeScoped(storeB).customer.deleteMany({});
    if (raw) {
      await raw.store.deleteMany({ where: { id: { in: [storeA, storeB].filter(Boolean) } } });
      await raw.$disconnect();
    }
  });

  it("connects as app_runtime", async () => {
    expect(await platformSessionUser()).toBe("app_runtime");
  });

  it("storeScoped(B) cannot read A's conversations or actions", async () => {
    const scoped = storeScoped(storeB);
    expect(await scoped.aiConversation.findUnique({ where: { id: conversationA } })).toBeNull();
    expect(await scoped.aiAction.findUnique({ where: { id: actionA } })).toBeNull();
    const conversations = await scoped.aiConversation.findMany();
    const actions = await scoped.aiAction.findMany();
    expect(conversations.map((row) => row.id)).not.toContain(conversationA);
    expect(actions.map((row) => row.id)).not.toContain(actionA);
    expect(await scoped.aiConversation.count()).toBe(conversations.length);
    expect(conversations.every((row) => row.storeId === storeB)).toBe(true);
  });

  it("storeScoped(B) cannot update or delete A's conversations or actions", async () => {
    const scoped = storeScoped(storeB);
    await expect(
      scoped.aiConversation.update({ where: { id: conversationA }, data: { model: "stolen" } }),
    ).rejects.toMatchObject({ code: "P2025" });
    await expect(
      scoped.aiAction.delete({ where: { id: actionA } }),
    ).rejects.toMatchObject({ code: "P2025" });
    expect(await scoped.aiConversation.updateMany({
      where: { id: conversationA },
      data: { model: "stolen" },
    })).toEqual({ count: 0 });
    expect(await scoped.aiAction.deleteMany({ where: { id: actionA } })).toEqual({ count: 0 });
    const still = await storeScoped(storeA).aiConversation.findUnique({ where: { id: conversationA } });
    expect(still?.model).toBe("claude-haiku-5-5");
    expect(await storeScoped(storeA).aiAction.findUnique({ where: { id: actionA } })).not.toBeNull();
  });

  it("storeScoped(B) cannot create a conversation for store A, on A's cart, on A's customer, or on a missing cart", async () => {
    const scoped = storeScoped(storeB);
    const attempts = [
      { storeId: storeA, cartId: cartB, customerId: customerB },
      { storeId: storeB, cartId: cartA, customerId: null },
      { storeId: storeB, cartId: cartB, customerId: customerA },
      { storeId: storeB, cartId: `missing-${randomUUID()}`, customerId: null },
    ];
    for (const data of attempts) {
      await expect(
        scoped.aiConversation.create({
          data: { ...data, model: "claude-haiku-5-5", messages: [] },
        }),
      ).rejects.toSatisfy(isRlsRejection);
    }
    expect(await storeScoped(storeA).aiConversation.count()).toBe(1);
  });

  it("storeScoped(B) cannot move its conversation to A's cart", async () => {
    await expect(
      storeScoped(storeB).aiConversation.update({
        where: { id: conversationB },
        data: { cartId: cartA },
      }),
    ).rejects.toSatisfy(isRlsRejection);
    const still = await storeScoped(storeB).aiConversation.findUnique({ where: { id: conversationB } });
    expect(still?.cartId).toBe(cartB);
  });

  it("storeScoped(B) cannot attach or move an action to A's conversation", async () => {
    await expect(
      storeScoped(storeB).aiAction.create({
        data: {
          storeId: storeB,
          conversationId: conversationA,
          tool: "add_to_cart",
          input: {},
          output: {},
          ok: false,
        },
      }),
    ).rejects.toSatisfy(isRlsRejection);
    const own = await storeScoped(storeB).aiAction.findFirst({ where: { conversationId: conversationB } });
    await expect(
      storeScoped(storeB).aiAction.update({
        where: { id: own!.id },
        data: { conversationId: conversationA },
      }),
    ).rejects.toSatisfy(isRlsRejection);
    expect(
      await storeScoped(storeA).aiAction.count({ where: { conversationId: conversationA } }),
    ).toBe(1);
  });

  it("one conversation per cart under concurrent creates", async () => {
    const cart = await storeScoped(storeA).cart.create({
      data: { storeId: storeA, source: "manual" },
    });
    const results = await Promise.allSettled([
      storeScoped(storeA).aiConversation.create({
        data: { storeId: storeA, cartId: cart.id, model: "claude-haiku-5-5", messages: [] },
      }),
      storeScoped(storeA).aiConversation.create({
        data: { storeId: storeA, cartId: cart.id, model: "claude-haiku-5-5", messages: [] },
      }),
    ]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "P2002" });
    expect(await storeScoped(storeA).aiConversation.count({ where: { cartId: cart.id } })).toBe(1);
    await storeScoped(storeA).cart.delete({ where: { id: cart.id } });
  });

  it("deleting a cart removes its conversation and actions", async () => {
    const cart = await storeScoped(storeA).cart.create({
      data: { storeId: storeA, source: "manual" },
    });
    const conversation = await storeScoped(storeA).aiConversation.create({
      data: { storeId: storeA, cartId: cart.id, model: "claude-haiku-5-5", messages: [] },
    });
    await storeScoped(storeA).aiAction.create({
      data: {
        storeId: storeA,
        conversationId: conversation.id,
        tool: "get_cart_summary",
        input: {},
        output: {},
        ok: true,
      },
    });
    await storeScoped(storeA).cart.delete({ where: { id: cart.id } });
    expect(await storeScoped(storeA).aiConversation.findUnique({ where: { id: conversation.id } })).toBeNull();
    expect(await storeScoped(storeA).aiAction.count({ where: { conversationId: conversation.id } })).toBe(0);
  });

  it("deleting a customer keeps the conversation visible with no customer", async () => {
    const cart = await storeScoped(storeA).cart.create({
      data: { storeId: storeA, source: "manual" },
    });
    const customer = await storeScoped(storeA).customer.create({
      data: { storeId: storeA, name: "Gone" },
    });
    const conversation = await storeScoped(storeA).aiConversation.create({
      data: {
        storeId: storeA,
        cartId: cart.id,
        customerId: customer.id,
        model: "claude-haiku-5-5",
        messages: [{ role: "user" }],
      },
    });
    await storeScoped(storeA).customer.delete({ where: { id: customer.id } });
    const still = await storeScoped(storeA).aiConversation.findUnique({ where: { id: conversation.id } });
    expect(still?.customerId).toBeNull();
    expect(still?.messages).toEqual([{ role: "user" }]);
    await storeScoped(storeA).cart.delete({ where: { id: cart.id } });
  });

  it("an action written in a store-scoped transaction rolls back with it", async () => {
    const before = await storeScoped(storeA).aiAction.count({ where: { conversationId: conversationA } });
    await expect(
      storeScopedTransaction(storeA, async (tx) => {
        await tx.aiAction.create({
          data: {
            storeId: storeA,
            conversationId: conversationA,
            tool: "add_to_cart",
            input: {},
            output: {},
            ok: true,
          },
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await storeScoped(storeA).aiAction.count({ where: { conversationId: conversationA } })).toBe(before);
  });
});
