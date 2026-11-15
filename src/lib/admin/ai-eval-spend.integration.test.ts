import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { recordSpend } from "../assistant/spend";
import { listChatMonth, listSpendDays, loadAiEvalSpend } from "./ai-eval-spend";

const hasDb = !!process.env.DATABASE_URL;
const DAY = 86_400_000;

let prisma: PrismaClient;
const storeIds: string[] = [];

/** A far-future UTC day no other file writes, so the window holds only this file's spend. */
function freshDay(): Date {
  return new Date(Date.UTC(2400, 0, 1) + randomInt(20_000) * 50 * DAY + 12 * 3_600_000);
}

async function asPlatformAdmin<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL ROLE app_user`;
    await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
    return fn(tx);
  });
}

async function makeStore(name: string, chats: Array<{ month: string; chats: number }>, sub?: { plan: string; status: string }) {
  const id = randomUUID();
  storeIds.push(id);
  await prisma.store.create({ data: { id, slug: `ai-eval-${id.slice(0, 8)}`, name, themePreset: "palm-and-shea" } });
  await asPlatformAdmin(async (tx) => {
    if (sub) await tx.storeSubscription.create({ data: { storeId: id, ...sub } });
    for (const row of chats) {
      await tx.assistantChatMonth.create({ data: { storeId: id, month: new Date(`${row.month}T00:00:00Z`), chats: row.chats } });
    }
  });
  return id;
}

beforeAll(() => {
  if (hasDb) prisma = testPrismaClient();
});

afterAll(async () => {
  if (!hasDb) return;
  await asPlatformAdmin(async (tx) => {
    await tx.assistantChatMonth.deleteMany({ where: { storeId: { in: storeIds } } });
    await tx.storeSubscription.deleteMany({ where: { storeId: { in: storeIds } } });
  });
  await prisma.store.deleteMany({ where: { id: { in: storeIds } } });
  await prisma.$disconnect();
});

describe.skipIf(!hasDb)("AI eval and spend (lane DB)", () => {
  it("lists spend by UTC day for the last 30 days, newest first, with the day the cap alert went out", async () => {
    const today = freshDay();
    const day = (offset: number) => new Date(today.getTime() - offset * DAY);
    await recordSpend(BigInt(1_200), day(0));
    await recordSpend(BigInt(300), day(0));
    await recordSpend(BigInt(4_500), day(2));
    await recordSpend(BigInt(9_999), day(30));
    await prisma.$executeRaw`UPDATE assistant_spend_days SET cap_alerted_at = now() WHERE day = CAST(${day(2).toISOString().slice(0, 10)} AS date)`;

    const days = await listSpendDays(today);

    expect(days).toEqual([
      { day: day(0).toISOString().slice(0, 10), costMicros: BigInt(1_500), capAlerted: false },
      { day: day(2).toISOString().slice(0, 10), costMicros: BigInt(4_500), capAlerted: true },
    ]);
  });

  it("counts each store's chats for this UTC month only, against its own plan", async () => {
    const at = new Date(Date.UTC(2390 + randomInt(9), randomInt(12), 15, 23, 30));
    const month = `${at.toISOString().slice(0, 7)}-01`;
    const lastMonth = `${new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - 1, 1)).toISOString().slice(0, 10)}`;
    const starter = await makeStore("Starter Market", [{ month, chats: 812 }, { month: lastMonth, chats: 999 }]);
    const pro = await makeStore("Pro Market", [{ month, chats: 812 }], { plan: "pro", status: "active" });
    const quiet = await makeStore("Quiet Market", [{ month: lastMonth, chats: 700 }]);

    const { stores } = await listChatMonth(at);
    const mine = stores.filter((store) => storeIds.includes(store.storeId));

    expect(mine).toEqual([
      { storeId: starter, storeName: "Starter Market", plan: "starter", chats: 812, cap: 1_000, nearCap: true, atCap: false },
      { storeId: pro, storeName: "Pro Market", plan: "pro", chats: 812, cap: 5_000, nearCap: false, atCap: false },
    ]);
    expect(mine.some((store) => store.storeId === quiet)).toBe(false);
  });

  it("loads the page data without calling Anthropic", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const data = await loadAiEvalSpend(freshDay(), { ASSISTANT_SPEND_CAP_USD: "1000000" });
      expect(data.eval?.runs.length).toBeGreaterThan(0);
      expect(data.spend.capMicros).toBe(BigInt(1_000_000_000_000));
      expect(data.spend.resting).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("reports the assistant as resting at the cap", async () => {
    const data = await loadAiEvalSpend(freshDay(), { ASSISTANT_SPEND_CAP_USD: "0" });
    expect(data.spend.resting).toBe(true);
  });
});
