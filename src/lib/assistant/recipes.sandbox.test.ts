import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authPrisma } from "../db";
import { WEB_SEARCH_MICROS } from "./cost";
import { lookUpDishOnline } from "./recipes";
import { setSpendClock } from "./spend";

const DAY = "2099-11-11";
const live = process.env.ASSISTANT_LIVE_TESTS === "1"
  && !!process.env.DATABASE_URL
  && typeof process.env.ANTHROPIC_API_KEY === "string"
  && process.env.ANTHROPIC_API_KEY.trim() !== "";

async function dayCost(): Promise<bigint> {
  const found = await authPrisma.$queryRaw<Array<{ cost_micros: bigint }>>`
    SELECT cost_micros FROM assistant_spend_days WHERE day = CAST(${DAY} AS date)
  `;
  return found[0]?.cost_micros ?? BigInt(0);
}

describe.skipIf(!live)("recipe lookup live sandbox", () => {
  beforeAll(() => setSpendClock(() => new Date(`${DAY}T12:00:00.000Z`)));
  afterAll(() => setSpendClock(null));

  it("looks up a real dish with Anthropic's web search and keeps a source the search returned", async () => {
    const before = await dayCost();
    const { found, costMicros } = await lookUpDishOnline("kelewele");
    expect(found).not.toBeNull();
    expect(found!.ingredients.length).toBeGreaterThan(0);
    expect(found!.sourceUrl).toMatch(/^https?:\/\//);
    expect(costMicros).toBeGreaterThan(WEB_SEARCH_MICROS);
    expect((await dayCost()) - before).toBe(costMicros);
  }, 120_000);
});
