import { randomInt, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appUserQuery, loseNextSpendAcks, platformSessionUser, storeScoped, withSessionTimeZone } from "../db";
import { runAssistantRetention, type AssistantStep } from "./retention";
import { assistantSpendState, claimCapAlert, recordSpend, resetInvalidCapLog } from "./spend";

const hasDb = !!process.env.DATABASE_URL;

function freshDay(): string {
  const at = new Date(Date.UTC(2100, 0, 1) + randomInt(20_000) * 86_400_000);
  return at.toISOString().slice(0, 10);
}

function formatCap(micros: bigint): string {
  const whole = micros / BigInt(1_000_000);
  const frac = (micros % BigInt(1_000_000)).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

function atNoon(day: string): Date {
  return new Date(`${day}T12:00:00.000Z`);
}

async function dayTotal(day: string): Promise<bigint> {
  const rows = await appUserQuery((tx) =>
    tx.$queryRaw<Array<{ cost: bigint }>>`
      SELECT cost_micros AS cost FROM assistant_spend_days WHERE day = CAST(${day} AS date)
    `,
  );
  return BigInt(rows[0]?.cost ?? 0);
}

describe.skipIf(!hasDb)("assistant spend ledger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetInvalidCapLog();
  });

  it("connects as app_runtime", async () => {
    expect(await platformSessionUser()).toBe("app_runtime");
  });

  it("sums every day's spend for the cap", async () => {
    const first = freshDay();
    const second = freshDay();
    const firstBefore = await dayTotal(first);
    const secondBefore = await dayTotal(second);
    await recordSpend(BigInt(4), atNoon(first));
    await recordSpend(BigInt(6), atNoon(second));
    expect(await dayTotal(first)).toBe(firstBefore + BigInt(4));
    expect(await dayTotal(second)).toBe(secondBefore + BigInt(6));
    const raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    try {
      await raw.$transaction(async (tx) => {
        // Other test files record spend in parallel; the lock holds their writes until both sums are read.
        await tx.$executeRaw`LOCK TABLE assistant_spend_days IN SHARE MODE`;
        const rows = await tx.$queryRaw<Array<{ spent: bigint }>>`
          SELECT COALESCE(SUM(cost_micros), 0) AS spent FROM assistant_spend_days
        `;
        const state = await assistantSpendState({ ASSISTANT_SPEND_CAP_USD: "1000000" });
        expect(state.spentMicros).toBe(BigInt(rows[0]?.spent ?? 0));
        expect(state.resting).toBe(false);
      });
    } finally {
      await raw.$disconnect();
    }
  });

  it("deleting conversations does not lower spend", async () => {
    const day = freshDay();
    const before = await assistantSpendState({ ASSISTANT_SPEND_CAP_USD: "1000000" });
    const dayBefore = await dayTotal(day);
    await recordSpend(BigInt(15), atNoon(day));
    const raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    const suffix = randomUUID().slice(0, 8);
    const store = await raw.store.create({
      data: { slug: `ai-spend-ret-${suffix}`, name: "Spend Retention", themePreset: "palm-and-shea" },
    });
    try {
      vi.spyOn(Date, "now").mockReturnValue(Date.parse("1990-06-01T00:00:00.000Z"));
      const createdAt = new Date("1980-01-01T00:00:00.000Z");
      const cart = await storeScoped(store.id).cart.create({ data: { storeId: store.id, source: "manual" } });
      const conversation = await storeScoped(store.id).aiConversation.create({
        data: {
          storeId: store.id,
          cartId: cart.id,
          model: "claude-haiku-5-5",
          messages: [],
          createdAt,
          lastMessageAt: createdAt,
        },
      });
      await storeScoped(store.id).aiAction.create({
        data: {
          storeId: store.id,
          conversationId: conversation.id,
          tool: "search_catalog",
          input: {},
          output: {},
          ok: true,
          createdAt,
        },
      });
      const step: AssistantStep = { async run(_id, fn) { return fn(); } };
      const swept = await runAssistantRetention(step);
      expect(swept.conversationsDeleted).toBeGreaterThanOrEqual(1);
      expect(swept.actionsDeleted).toBeGreaterThanOrEqual(1);
      expect(await storeScoped(store.id).aiConversation.findUnique({ where: { id: conversation.id } })).toBeNull();
      expect(await storeScoped(store.id).aiAction.count({ where: { conversationId: conversation.id } })).toBe(0);
    } finally {
      vi.useRealTimers();
      await storeScoped(store.id).cart.deleteMany({});
      await raw.store.delete({ where: { id: store.id } });
      await raw.$disconnect();
    }
    const after = await assistantSpendState({ ASSISTANT_SPEND_CAP_USD: "1000000" });
    expect(await dayTotal(day)).toBe(dayBefore + BigInt(15));
    expect(after.spentMicros).toBeGreaterThanOrEqual(before.spentMicros + BigInt(15));
  });

  it("a lost acknowledgement does not book the same call twice", async () => {
    const day = freshDay();
    const before = await dayTotal(day);
    const callId = randomUUID();
    loseNextSpendAcks(1);
    await expect(recordSpend(BigInt(2), atNoon(day), callId)).rejects.toThrow("ack lost");
    await recordSpend(BigInt(2), atNoon(day), callId);
    expect(await dayTotal(day)).toBe(before + BigInt(2));
  });

  it("concurrent records lose no increment", async () => {
    const day = freshDay();
    const before = await dayTotal(day);
    await Promise.all(Array.from({ length: 50 }, () => recordSpend(BigInt(1), atNoon(day))));
    expect(await dayTotal(day)).toBe(before + BigInt(50));
  });

  it("alerts once per UTC day under concurrency", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    const day = freshDay();
    const results = await Promise.all(Array.from({ length: 20 }, () => claimCapAlert(day)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(errors.filter((line) => line.includes("spend cap reached"))).toHaveLength(1);
    const next = freshDay();
    expect(await claimCapAlert(next)).toBe(true);
  });

  it("books spend to the UTC day regardless of session time zone", async () => {
    const day = "2001-06-01";
    await withSessionTimeZone("America/Denver", () =>
      recordSpend(BigInt(7), new Date("2001-06-01T02:00:00.000Z")),
    );
    expect(await dayTotal(day)).toBeGreaterThanOrEqual(BigInt(7));
    const shifted = await dayTotal("2001-05-31");
    expect(shifted).toBe(BigInt(0));
  });

  it("rests when spend equals the cap", async () => {
    const current = await assistantSpendState({ ASSISTANT_SPEND_CAP_USD: "1000000" });
    const exact = await assistantSpendState({
      ASSISTANT_SPEND_CAP_USD: formatCap(current.spentMicros),
    });
    expect(exact.resting).toBe(true);
    const under = await assistantSpendState({
      ASSISTANT_SPEND_CAP_USD: formatCap(current.spentMicros + BigInt(1_000_000_000_000)),
    });
    expect(under.resting).toBe(false);
  });

  it("fails closed on an invalid cap", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
    const state = await assistantSpendState({ ASSISTANT_SPEND_CAP_USD: "abc" });
    expect(state.resting).toBe(true);
    expect(errors.some((line) => line.includes("ASSISTANT_SPEND_CAP_USD"))).toBe(true);
    const exact = await assistantSpendState({ ASSISTANT_SPEND_CAP_USD: "0" });
    expect(exact.resting).toBe(true);
    expect(exact.capMicros).toBe(BigInt(0));
  });
});
