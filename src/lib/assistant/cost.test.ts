import { describe, expect, it } from "vitest";
import { AssistantConfigError } from "./errors";
import { callCostMicros } from "./cost";
import { spendCapMicros } from "./spend";

describe("assistant call cost", () => {
  it("prices Haiku 5.5 usage in micros rounding up", () => {
    const cost = callCostMicros("claude-haiku-5-5", {
      inputTokens: { total: 20_000, noCache: 10_000, cacheWrite: 2_000, cacheRead: 8_000 },
      outputTokens: { total: 1_000 },
    });
    expect(cost).toBe(BigInt(1830));
    expect(callCostMicros("claude-haiku-5-5", {
      inputTokens: { total: 1, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1 },
    })).toBe(BigInt(1));
  });

  it("switches Haiku to long-prompt prices above 100000 input tokens", () => {
    const usage = {
      inputTokens: { total: 100_001, noCache: 100_001, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0 },
    };
    const atBoundary = callCostMicros("claude-haiku-5-5", {
      inputTokens: { total: 100_000, noCache: 100_000, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0 },
    });
    expect(atBoundary).toBe(BigInt(10_000));
    expect(callCostMicros("claude-haiku-5-5", usage)).toBe(BigInt(50_001));
  });

  it("prices Sonnet 5.5 cache hits at 0.05x", () => {
    const cost = callCostMicros("claude-sonnet-5-5", {
      inputTokens: { total: 1_000_000, noCache: 0, cacheRead: 1_000_000, cacheWrite: 0 },
      outputTokens: { total: 0 },
    });
    expect(cost).toBe(BigInt(100_000));
  });

  it("derives no-cache tokens when missing", () => {
    const cost = callCostMicros("claude-haiku-5-5", {
      inputTokens: { total: 10, cacheRead: 4, cacheWrite: 1 },
      outputTokens: { total: 0 },
    });
    const explicit = callCostMicros("claude-haiku-5-5", {
      inputTokens: { total: 10, noCache: 5, cacheRead: 4, cacheWrite: 1 },
      outputTokens: { total: 0 },
    });
    expect(cost).toBe(explicit);
  });

  it("sums fractional micros before one ceil", () => {
    expect(callCostMicros("claude-haiku-5-5", {
      inputTokens: { total: 50, noCache: 0, cacheRead: 50, cacheWrite: 0 },
      outputTokens: { total: 0 },
    })).toBe(BigInt(1));
    expect(callCostMicros("claude-haiku-5-5", {})).toBe(BigInt(0));
  });

  it("rejects an unknown model id", () => {
    expect(() => callCostMicros("claude-opus", { outputTokens: { total: 1 } })).toThrow(AssistantConfigError);
  });
});

describe("spend cap parsing", () => {
  it("fails closed on an invalid cap", () => {
    expect(spendCapMicros({}).micros).toBe(BigInt(10_000_000));
    expect(spendCapMicros({ ASSISTANT_SPEND_CAP_USD: "12.50" }).micros).toBe(BigInt(12_500_000));
    expect(spendCapMicros({ ASSISTANT_SPEND_CAP_USD: "10.005" }).micros).toBe(BigInt(10_005_000));
    expect(spendCapMicros({ ASSISTANT_SPEND_CAP_USD: "0" })).toEqual({ micros: BigInt(0), invalid: false });
    for (const bad of ["", "abc", "-5", "1e3", "NaN"]) {
      expect(spendCapMicros({ ASSISTANT_SPEND_CAP_USD: bad }).invalid).toBe(true);
    }
  });
});
