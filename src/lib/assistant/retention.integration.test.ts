import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  platformAdminTransaction,
  storeScoped,
  storeScopedTransaction,
  withSessionTimeZone,
} from "../db";
import { runAssistantRetention, type AssistantStep } from "./retention";

const hasDb = !!process.env.DATABASE_URL;
const PINNED_NOW = "2001-06-01T00:00:00.000Z";
const OLD = new Date("2001-03-02T23:00:00.000Z");
const BOUNDARY = new Date("2001-03-03T00:00:00.000Z");
const NEWER = new Date("2001-03-04T00:00:00.000Z");

interface FaithfulStep extends AssistantStep {
  calls: number;
  loseFresh(nth: number): void;
  loseNextResult(): void;
  resetCounts(): void;
}

function makeFaithfulStep(): FaithfulStep {
  const memos = new Map<string, unknown[]>();
  const seen = new Map<string, number>();
  let loseAtFresh = 0;
  let fresh = 0;
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    loseFresh(nth: number) {
      loseAtFresh = nth;
    },
    loseNextResult() {
      loseAtFresh = fresh + 1;
    },
    resetCounts() {
      for (const id of seen.keys()) seen.set(id, 0);
    },
    async run<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
      calls += 1;
      const history = memos.get(id) ?? [];
      const index = seen.get(id) ?? 0;
      if (index < history.length) {
        seen.set(id, index + 1);
        return history[index] as T;
      }
      const value = await fn();
      const encoded = JSON.stringify(value);
      if (encoded === undefined) throw new Error("step result is not JSON");
      const parsed = JSON.parse(encoded) as T;
      history.push(parsed);
      memos.set(id, history);
      seen.set(id, index + 1);
      fresh += 1;
      if (fresh === loseAtFresh) {
        history.pop();
        throw new Error("step result lost");
      }
      return parsed;
    },
  };
}

describe.skipIf(!hasDb)("assistant retention", () => {
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  const carts: string[] = [];

  beforeAll(async () => {
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const suffix = randomUUID().slice(0, 8);
    storeA = (await raw.store.create({
      data: { slug: `ai-ret-a-${suffix}`, name: "Retention A", themePreset: "palm-and-shea" },
    })).id;
    storeB = (await raw.store.create({
      data: { slug: `ai-ret-b-${suffix}`, name: "Retention B", themePreset: "lagoon-and-coral" },
    })).id;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    while (carts.length > 0) {
      const id = carts.pop();
      if (!id) continue;
      await storeScoped(storeA).cart.deleteMany({ where: { id } });
      await storeScoped(storeB).cart.deleteMany({ where: { id } });
    }
  });

  afterAll(async () => {
    if (storeA) await storeScoped(storeA).cart.deleteMany({});
    if (storeB) await storeScoped(storeB).cart.deleteMany({});
    if (raw) {
      await raw.store.deleteMany({ where: { id: { in: [storeA, storeB].filter(Boolean) } } });
      await raw.$disconnect();
    }
  });

  function pinClock() {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(PINNED_NOW));
  }

  async function conversation(
    storeId: string,
    createdAt: Date,
    inFlightUntil?: Date,
  ): Promise<{ cartId: string; conversationId: string }> {
    const cart = await storeScoped(storeId).cart.create({
      data: { storeId, source: "manual" },
    });
    carts.push(cart.id);
    const row = await storeScoped(storeId).aiConversation.create({
      data: {
        storeId,
        cartId: cart.id,
        model: "claude-haiku-5-5",
        messages: [],
        createdAt,
        lastMessageAt: createdAt,
        inFlightUntil: inFlightUntil ?? null,
      },
    });
    return { cartId: cart.id, conversationId: row.id };
  }

  async function action(storeId: string, conversationId: string, createdAt: Date, id?: string) {
    await storeScoped(storeId).aiAction.create({
      data: {
        id,
        storeId,
        conversationId,
        tool: "search_catalog",
        input: {},
        output: {},
        ok: true,
        createdAt,
      },
    });
  }

  async function bulkActions(storeId: string, conversationId: string, count: number, createdAt: Date) {
    const prefix = randomUUID().slice(0, 8);
    await storeScopedTransaction(storeId, (tx) =>
      tx.$executeRaw`
        INSERT INTO ai_actions (id, store_id, conversation_id, tool, input, output, ok, created_at)
        SELECT ${prefix} || '-' || g::text, ${storeId}, ${conversationId},
               'search_catalog', '{}'::jsonb, '{}'::jsonb, true, ${createdAt}
        FROM generate_series(1, ${count}) AS g
      `,
    );
  }

  it("deletes rows strictly older than 90 days and keeps the boundary", async () => {
    pinClock();
    const oldA = await conversation(storeA, OLD);
    const oldB = await conversation(storeB, OLD);
    const edge = await conversation(storeA, BOUNDARY);
    const recent = await conversation(storeA, NEWER);
    await action(storeA, oldA.conversationId, OLD);
    await action(storeB, oldB.conversationId, OLD);
    await action(storeA, edge.conversationId, BOUNDARY);
    await action(storeA, recent.conversationId, NEWER);

    const result = await runAssistantRetention(makeFaithfulStep());
    expect(result.actionsDeleted).toBeGreaterThanOrEqual(2);
    expect(result.conversationsDeleted).toBeGreaterThanOrEqual(2);

    expect(await storeScoped(storeA).aiConversation.findUnique({ where: { id: oldA.conversationId } })).toBeNull();
    expect(await storeScoped(storeB).aiConversation.findUnique({ where: { id: oldB.conversationId } })).toBeNull();
    expect(await storeScoped(storeA).aiAction.count({ where: { conversationId: oldA.conversationId } })).toBe(0);
    expect(await storeScoped(storeA).aiConversation.findUnique({ where: { id: edge.conversationId } })).not.toBeNull();
    expect(await storeScoped(storeA).aiAction.count({ where: { conversationId: edge.conversationId } })).toBe(1);
    expect(await storeScoped(storeA).aiConversation.findUnique({ where: { id: recent.conversationId } })).not.toBeNull();
  });

  it("deletes old actions on a leased conversation and keeps the conversation", async () => {
    pinClock();
    const leased = await conversation(storeA, OLD, new Date("2001-06-01T01:00:00.000Z"));
    await action(storeA, leased.conversationId, OLD);
    await runAssistantRetention(makeFaithfulStep());
    const still = await storeScoped(storeA).aiConversation.findUnique({ where: { id: leased.conversationId } });
    expect(still).not.toBeNull();
    expect(await storeScoped(storeA).aiAction.count({ where: { conversationId: leased.conversationId } })).toBe(0);
  });

  it("an empty sweep takes one step per table", async () => {
    pinClock();
    const recent = await conversation(storeA, NEWER);
    await action(storeA, recent.conversationId, NEWER);
    const step = makeFaithfulStep();
    const result = await runAssistantRetention(step);
    expect(result).toEqual({ actionsDeleted: 0, conversationsDeleted: 0 });
    expect(step.calls).toBe(3);
    expect(await storeScoped(storeA).aiConversation.findUnique({ where: { id: recent.conversationId } })).not.toBeNull();
  });

  it("deletes 2500 old rows in three batches and leaves a newer row", async () => {
    pinClock();
    const old = await conversation(storeA, OLD);
    const recent = await conversation(storeB, NEWER);
    await bulkActions(storeA, old.conversationId, 2500, OLD);
    await action(storeB, recent.conversationId, NEWER);
    const step = makeFaithfulStep();
    const result = await runAssistantRetention(step);
    expect(result.actionsDeleted).toBe(2500);
    expect(result.conversationsDeleted).toBe(1);
    expect(step.calls).toBe(5);
    expect(await storeScoped(storeB).aiAction.count({ where: { conversationId: recent.conversationId } })).toBe(1);
  }, 60_000);

  it("stops at the batch cap, logs, and finishes on the next run", async () => {
    pinClock();
    const kept = await conversation(storeA, NEWER);
    await bulkActions(storeA, kept.conversationId, 25, OLD);
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    const first = await runAssistantRetention(makeFaithfulStep(), { batchSize: 10, maxBatches: 2 });
    expect(first.actionsDeleted).toBe(20);
    expect(errors.some((line) => line.includes("batch cap reached ai_actions"))).toBe(true);
    expect(await storeScoped(storeA).aiAction.count({ where: { conversationId: kept.conversationId } })).toBe(5);
    errors.length = 0;
    const second = await runAssistantRetention(makeFaithfulStep(), { batchSize: 10, maxBatches: 2 });
    expect(second.actionsDeleted).toBe(5);
    expect(errors.some((line) => line.includes("batch cap reached"))).toBe(false);
    expect(await storeScoped(storeA).aiAction.count({ where: { conversationId: kept.conversationId } })).toBe(0);
  });

  it("a second sweep deletes nothing", async () => {
    pinClock();
    const recent = await conversation(storeA, NEWER);
    await action(storeA, recent.conversationId, NEWER);
    const step = makeFaithfulStep();
    await runAssistantRetention(step);
    const again = await runAssistantRetention(makeFaithfulStep());
    expect(again).toEqual({ actionsDeleted: 0, conversationsDeleted: 0 });
    expect(await storeScoped(storeA).aiConversation.findUnique({ where: { id: recent.conversationId } })).not.toBeNull();
  });

  it("re-entry keeps the memoized cutoff after the clock moves", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.parse(PINNED_NOW));
    const kept = await conversation(storeA, NEWER);
    await action(storeA, kept.conversationId, NEWER);
    const step = makeFaithfulStep();
    await runAssistantRetention(step);
    now.mockReturnValue(Date.parse("2001-06-03T00:00:00.000Z"));
    step.resetCounts();
    await runAssistantRetention(step);
    expect(await storeScoped(storeA).aiConversation.findUnique({ where: { id: kept.conversationId } })).not.toBeNull();
    expect(await storeScoped(storeA).aiAction.count({ where: { conversationId: kept.conversationId } })).toBe(1);
  });

  it("retries after a lost step and each old row is deleted once", async () => {
    pinClock();
    const old = await conversation(storeA, OLD);
    await bulkActions(storeA, old.conversationId, 1500, OLD);
    const step = makeFaithfulStep();
    step.loseFresh(2);
    await expect(runAssistantRetention(step, { batchSize: 1000 })).rejects.toThrow("step result lost");
    expect(await storeScoped(storeA).aiAction.count({ where: { conversationId: old.conversationId } })).toBe(500);
    step.resetCounts();
    await runAssistantRetention(step, { batchSize: 1000 });
    expect(await storeScoped(storeA).aiAction.count({ where: { conversationId: old.conversationId } })).toBe(0);
    expect(await storeScoped(storeA).aiConversation.findUnique({ where: { id: old.conversationId } })).toBeNull();
  }, 60_000);

  it("overlapping sweeps delete each old row once", async () => {
    pinClock();
    const old = await conversation(storeA, OLD);
    await bulkActions(storeA, old.conversationId, 100, OLD);
    await Promise.all([
      runAssistantRetention(makeFaithfulStep(), { batchSize: 40 }),
      runAssistantRetention(makeFaithfulStep(), { batchSize: 40 }),
    ]);
    expect(await storeScoped(storeA).aiAction.count({ where: { conversationId: old.conversationId } })).toBe(0);
  });

  it("uses the same cutoff under America/Denver", async () => {
    pinClock();
    const old = await conversation(storeA, OLD);
    const edge = await conversation(storeA, BOUNDARY);
    await action(storeA, old.conversationId, OLD);
    await action(storeA, edge.conversationId, BOUNDARY);
    await withSessionTimeZone("America/Denver", async () => {
      const zone = await platformAdminTransaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ tz: string }>>`
          SELECT current_setting('TimeZone') AS tz
        `;
        return rows[0]?.tz;
      });
      expect(zone).toBe("America/Denver");
      await runAssistantRetention(makeFaithfulStep());
    });
    expect(await storeScoped(storeA).aiConversation.findUnique({ where: { id: old.conversationId } })).toBeNull();
    expect(await storeScoped(storeA).aiConversation.findUnique({ where: { id: edge.conversationId } })).not.toBeNull();
  });

  it("step results are JSON-safe", async () => {
    pinClock();
    const step = makeFaithfulStep();
    await expect(step.run("bigint", async () => BigInt(1))).rejects.toThrow();
    const recent = await conversation(storeA, NEWER);
    const result = await runAssistantRetention(step);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(await storeScoped(storeA).aiConversation.findUnique({ where: { id: recent.conversationId } })).not.toBeNull();
  });
});
