import { randomInt } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appUserQuery, platformSessionUser, withSessionTimeZone } from "../db";
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
    const before = await assistantSpendState({ ASSISTANT_SPEND_CAP_USD: "1000000" });
    const first = freshDay();
    const second = freshDay();
    await recordSpend(BigInt(4), atNoon(first));
    await recordSpend(BigInt(6), atNoon(second));
    const after = await assistantSpendState({ ASSISTANT_SPEND_CAP_USD: "1000000" });
    expect(after.spentMicros - before.spentMicros).toBe(BigInt(10));
    expect(after.resting).toBe(false);
  });

  it("deleting conversations does not lower spend", async () => {
    const day = freshDay();
    await recordSpend(BigInt(15), atNoon(day));
    const before = await dayTotal(day);
    await appUserQuery((tx) =>
      tx.$executeRaw`DELETE FROM ai_conversations WHERE created_at < CAST('1990-01-01' AS timestamp)`,
    );
    expect(await dayTotal(day)).toBe(before);
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
      ASSISTANT_SPEND_CAP_USD: formatCap(current.spentMicros + BigInt(1)),
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
