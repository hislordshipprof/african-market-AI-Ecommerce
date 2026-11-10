import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { healthQueryRaw, storeScoped } from "../db";
import { isRlsRejection } from "../listing/cross-store-write";

const hasDb = !!process.env.DATABASE_URL;

function rejectsAsRls(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return isRlsRejection(error) && !message.includes("23503");
}

describe.skipIf(!hasDb)("copilot records isolation", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  let userA = "";
  let userB = "";
  let listingA = "";
  let listingB = "";
  let conversationA = "";
  let conversationB = "";
  let proposalA = "";
  let proposalB = "";
  let receiptA = "";
  let receiptB = "";

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const role = (await healthQueryRaw`SELECT current_user`) as Array<{ current_user: string }>;
    expect(role[0]?.current_user).toBe("app_runtime");

    const suffix = randomUUID().slice(0, 8);
    userA = (await raw.user.create({
      data: { id: `copilot-a-${suffix}`, email: `copilot-a-${suffix}@example.com`, name: "Owner A", emailVerified: true },
    })).id;
    userB = (await raw.user.create({
      data: { id: `copilot-b-${suffix}`, email: `copilot-b-${suffix}@example.com`, name: "Owner B", emailVerified: true },
    })).id;
    storeA = (await raw.store.create({
      data: { slug: `copilot-a-${suffix}`, name: "Copilot A", themePreset: "palm-and-shea" },
    })).id;
    storeB = (await raw.store.create({
      data: { slug: `copilot-b-${suffix}`, name: "Copilot B", themePreset: "lagoon-and-coral" },
    })).id;
    listingA = (await storeScoped(storeA).listing.create({
      data: { storeId: storeA, customName: "Gari", price: 500, stockMode: "counted", qty: 12 },
    })).id;
    listingB = (await storeScoped(storeB).listing.create({
      data: { storeId: storeB, customName: "Rice", price: 500, stockMode: "counted", qty: 4 },
    })).id;
    conversationA = (await storeScoped(storeA).copilotConversation.create({
      data: { storeId: storeA, userId: userA, model: "claude-haiku-5-5", messages: [] },
    })).id;
    conversationB = (await storeScoped(storeB).copilotConversation.create({
      data: { storeId: storeB, userId: userB, model: "claude-haiku-5-5", messages: [] },
    })).id;
    proposalA = (await storeScoped(storeA).stockProposal.create({
      data: {
        storeId: storeA,
        conversationId: conversationA,
        listingId: listingA,
        clientMessageId: `msg-a-${suffix}`,
        kind: "restock",
        quantity: 2,
        before: { qty: 12, status: null },
        state: "pending",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })).id;
    proposalB = (await storeScoped(storeB).stockProposal.create({
      data: {
        storeId: storeB,
        conversationId: conversationB,
        listingId: listingB,
        clientMessageId: `msg-b-${suffix}`,
        kind: "restock",
        quantity: 1,
        before: { qty: 4, status: null },
        state: "pending",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })).id;
    receiptA = (await storeScoped(storeA).copilotClientMessage.create({
      data: {
        storeId: storeA,
        userId: userA,
        conversationId: conversationA,
        clientMessageId: `msg-a-${suffix}`,
        reply: "stored",
        claimedUntil: new Date(Date.now() + 60_000),
      },
    })).id;
    receiptB = (await storeScoped(storeB).copilotClientMessage.create({
      data: {
        storeId: storeB,
        userId: userB,
        conversationId: conversationB,
        clientMessageId: `msg-b-${suffix}`,
        reply: "stored",
        claimedUntil: new Date(Date.now() + 60_000),
      },
    })).id;
  });

  afterAll(async () => {
    for (const storeId of [storeA, storeB]) {
      if (!storeId) continue;
      await storeScoped(storeId).stockProposal.deleteMany({});
      await storeScoped(storeId).copilotClientMessage.deleteMany({});
      await storeScoped(storeId).copilotConversation.deleteMany({});
      await storeScoped(storeId).listing.deleteMany({});
    }
    if (raw) {
      await raw.user.deleteMany({ where: { id: { in: [userA, userB].filter(Boolean) } } });
      await raw.store.deleteMany({ where: { id: { in: [storeA, storeB].filter(Boolean) } } });
      await raw.$disconnect();
    }
  });

  it("storeScoped(B) cannot read, update or delete store A's copilot conversations and proposals", async () => {
    const scoped = storeScoped(storeB);
    expect(await scoped.copilotConversation.findUnique({ where: { id: conversationA } })).toBeNull();
    expect(await scoped.stockProposal.findUnique({ where: { id: proposalA } })).toBeNull();
    expect(await scoped.copilotClientMessage.findUnique({ where: { id: receiptA } })).toBeNull();
    expect((await scoped.copilotConversation.findMany()).map((row) => row.id)).not.toContain(conversationA);
    expect((await scoped.stockProposal.findMany()).map((row) => row.id)).not.toContain(proposalA);

    const beforeConversation = await storeScoped(storeA).copilotConversation.findUniqueOrThrow({ where: { id: conversationA } });
    const beforeProposal = await storeScoped(storeA).stockProposal.findUniqueOrThrow({ where: { id: proposalA } });
    await expect(scoped.copilotConversation.update({
      where: { id: conversationA },
      data: { model: "stolen" },
    })).rejects.toMatchObject({ code: "P2025" });
    await expect(scoped.copilotConversation.delete({ where: { id: conversationA } })).rejects.toMatchObject({ code: "P2025" });
    await expect(scoped.stockProposal.update({
      where: { id: proposalA },
      data: { kind: "recount", quantity: 0 },
    })).rejects.toMatchObject({ code: "P2025" });
    await expect(scoped.stockProposal.delete({ where: { id: proposalA } })).rejects.toMatchObject({ code: "P2025" });
    await expect(scoped.copilotClientMessage.delete({ where: { id: receiptA } })).rejects.toMatchObject({ code: "P2025" });
    expect(await scoped.copilotConversation.updateMany({ where: { id: conversationA }, data: { model: "stolen" } })).toEqual({ count: 0 });
    expect(await scoped.copilotConversation.deleteMany({ where: { id: conversationA } })).toEqual({ count: 0 });
    expect(await scoped.stockProposal.updateMany({ where: { id: proposalA }, data: { quantity: 9 } })).toEqual({ count: 0 });
    expect(await scoped.stockProposal.deleteMany({ where: { id: proposalA } })).toEqual({ count: 0 });
    expect(await scoped.copilotClientMessage.deleteMany({ where: { id: receiptA } })).toEqual({ count: 0 });

    const conversation = await storeScoped(storeA).copilotConversation.findUnique({ where: { id: conversationA } });
    const proposal = await storeScoped(storeA).stockProposal.findUnique({ where: { id: proposalA } });
    expect(conversation?.model).toBe(beforeConversation.model);
    expect(proposal?.quantity).toBe(beforeProposal.quantity);
    expect(proposal?.state).toBe("pending");
  });

  it("storeScoped(B) cannot create a conversation for A, or a proposal on A's conversation or A's listing", async () => {
    const scoped = storeScoped(storeB);
    await expect(scoped.copilotConversation.create({
      data: { storeId: storeA, userId: userB, model: "claude-haiku-5-5", messages: [] },
    })).rejects.toSatisfy(rejectsAsRls);
    await expect(scoped.stockProposal.create({
      data: {
        storeId: storeB,
        conversationId: conversationA,
        listingId: listingB,
        clientMessageId: `cross-${randomUUID()}`,
        kind: "restock",
        quantity: 1,
        before: { qty: 4, status: null },
        state: "pending",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })).rejects.toSatisfy(rejectsAsRls);
    await expect(scoped.stockProposal.create({
      data: {
        storeId: storeB,
        conversationId: conversationB,
        listingId: listingA,
        clientMessageId: `cross-${randomUUID()}`,
        kind: "restock",
        quantity: 1,
        before: { qty: 12, status: null },
        state: "pending",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })).rejects.toSatisfy(rejectsAsRls);
    await expect(scoped.stockProposal.create({
      data: {
        storeId: storeB,
        conversationId: conversationB,
        listingId: `missing-${randomUUID()}`,
        clientMessageId: `missing-${randomUUID()}`,
        kind: "restock",
        quantity: 1,
        before: { qty: 4, status: null },
        state: "pending",
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    })).rejects.toSatisfy(rejectsAsRls);

    await expect(scoped.stockProposal.update({
      where: { id: proposalB },
      data: { listingId: listingA },
    })).rejects.toSatisfy(rejectsAsRls);
    await expect(scoped.stockProposal.update({
      where: { id: proposalB },
      data: { conversationId: conversationA },
    })).rejects.toSatisfy(rejectsAsRls);
    await expect(scoped.copilotClientMessage.update({
      where: { id: receiptB },
      data: { conversationId: conversationA },
    })).rejects.toSatisfy(rejectsAsRls);

    const still = await storeScoped(storeB).stockProposal.findUnique({ where: { id: proposalB } });
    expect(still?.listingId).toBe(listingB);
    expect(still?.conversationId).toBe(conversationB);
    expect(await storeScoped(storeA).copilotConversation.count()).toBe(1);
    expect(await storeScoped(storeA).stockProposal.count()).toBe(1);
  });
});
