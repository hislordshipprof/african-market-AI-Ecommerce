import { describe, expect, it } from "vitest";
import { evalView, formatAiUsd, storeChatUsage } from "./ai-eval-spend";

function run(overrides: Record<string, unknown> = {}, summary: Record<string, unknown> = {}) {
  return {
    model: "claude-haiku-5-5",
    startedAt: "2026-11-14T08:28:44.755Z",
    finishedAt: "2026-11-14T08:34:43.434Z",
    complete: true,
    verdict: "sonnet-candidate",
    verdictReasons: ["the model stated amounts the grounder removed"],
    spend: { micros: "219300", usd: "0.219300" },
    summary: {
      microPrecision: 1,
      microRecall: 0.9872340425531915,
      dishPassRate: 0.95,
      dishPassed: 38,
      dishCases: 40,
      hallucinatedItems: 0,
      ...summary,
    },
    cases: [],
    ...overrides,
  };
}

describe("evalView", () => {
  it("reads both runs of the committed report with the averaged rates and the summed cost", () => {
    const view = evalView({
      schemaVersion: 1,
      runs: [run(), run({ startedAt: "2026-11-14T08:34:43.435Z", finishedAt: "2026-11-14T08:40:39.952Z", spend: { micros: "224573" } }, { hallucinatedItems: 1 })],
      average: { microPrecision: 1, microRecall: 0.9893617021276595, dishPassRate: 0.975 },
    });

    expect(view).toEqual({
      models: ["claude-haiku-5-5"],
      finishedAt: "2026-11-14T08:40:39.952Z",
      average: { precision: 1, recall: 0.9893617021276595, dishPassRate: 0.975 },
      runs: [
        {
          model: "claude-haiku-5-5",
          finishedAt: "2026-11-14T08:34:43.434Z",
          precision: 1,
          recall: 0.9872340425531915,
          dishPassRate: 0.95,
          dishPassed: 38,
          dishCases: 40,
          madeUpItems: 0,
          verdict: "sonnet-candidate",
          verdictReasons: ["the model stated amounts the grounder removed"],
          costMicros: BigInt(219300),
        },
        expect.objectContaining({ madeUpItems: 1, costMicros: BigInt(224573), finishedAt: "2026-11-14T08:40:39.952Z" }),
      ],
      madeUpItems: 1,
      verdict: "sonnet-candidate",
      costMicros: BigInt(443873),
    });
  });

  it("calls the report haiku-ok only when every run is", () => {
    const ok = run({ verdict: "haiku-ok", verdictReasons: [] });
    const average = { microPrecision: 1, microRecall: 1, dishPassRate: 1 };
    expect(evalView({ schemaVersion: 1, runs: [ok, ok], average })?.verdict).toBe("haiku-ok");
    expect(evalView({ schemaVersion: 1, runs: [ok, run()], average })?.verdict).toBe("sonnet-candidate");
  });

  it("returns null for a missing or unreadable report instead of showing made-up figures", () => {
    expect(evalView(null)).toBeNull();
    expect(evalView({ schemaVersion: 2, runs: [run()], average: {} })).toBeNull();
    expect(evalView({ schemaVersion: 1, runs: [], average: {} })).toBeNull();
    expect(evalView({ schemaVersion: 1, runs: [run({ spend: { micros: "12.5" } })], average: { microPrecision: 1, microRecall: 1, dishPassRate: 1 } })).toBeNull();
  });
});

describe("formatAiUsd", () => {
  it("rounds micro-dollars half up to the cent", () => {
    expect(formatAiUsd(BigInt(0))).toBe("$0.00");
    expect(formatAiUsd(BigInt(5_000))).toBe("$0.01");
    expect(formatAiUsd(BigInt(1_234_999))).toBe("$1.23");
    expect(formatAiUsd(BigInt(1_235_000))).toBe("$1.24");
    expect(formatAiUsd(BigInt(10_000_000))).toBe("$10.00");
    expect(formatAiUsd(BigInt(1_234_567_890_000))).toBe("$1,234,567.89");
  });

  it("does not show a small non-zero spend as nothing", () => {
    expect(formatAiUsd(BigInt(1))).toBe("under $0.01");
    expect(formatAiUsd(BigInt(4_999))).toBe("under $0.01");
  });
});

describe("storeChatUsage", () => {
  const row = (storeId: string, chats: number, sub: { plan: string; status: string } | null = null) => ({
    storeId,
    storeName: `Store ${storeId}`,
    chats,
    subscriptionPlan: sub?.plan ?? null,
    subscriptionStatus: sub?.status ?? null,
  });

  it("measures each store against its own plan cap and marks stores at 80% or more", () => {
    const usage = storeChatUsage([
      row("a", 799),
      row("b", 800),
      row("c", 3_999, { plan: "pro", status: "active" }),
      row("d", 4_000, { plan: "pro", status: "trialing" }),
      row("e", 1_000, { plan: "pro", status: "canceled" }),
    ]);
    const byId = Object.fromEntries(usage.stores.map((store) => [store.storeId, store]));

    expect(byId.a).toMatchObject({ plan: "starter", chats: 799, cap: 1_000, nearCap: false, atCap: false });
    expect(byId.b).toMatchObject({ plan: "starter", cap: 1_000, nearCap: true, atCap: false });
    expect(byId.c).toMatchObject({ plan: "pro", cap: 5_000, nearCap: false });
    expect(byId.d).toMatchObject({ plan: "pro", cap: 5_000, nearCap: true });
    expect(byId.e).toMatchObject({ plan: "starter", cap: 1_000, nearCap: true, atCap: true });
  });

  it("lists the fullest stores first and keeps every marked store when the list is cut", () => {
    const quiet = Array.from({ length: 60 }, (_, i) => row(`q${i}`, 10 + i));
    const usage = storeChatUsage([...quiet, row("full", 1_000), row("near", 850)], 50);

    expect(usage.stores.slice(0, 2).map((store) => store.storeId)).toEqual(["full", "near"]);
    expect(usage.stores).toHaveLength(50);
    expect(usage.hidden).toBe(12);
    expect(usage.stores[2]?.storeId).toBe("q59");

    const tight = storeChatUsage([row("q", 5), row("full", 1_000), row("near", 850)], 1);
    expect(tight.stores.map((store) => store.storeId)).toEqual(["full", "near"]);
    expect(tight.hidden).toBe(1);
  });
});
