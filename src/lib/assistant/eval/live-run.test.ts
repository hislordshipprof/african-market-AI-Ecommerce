import { afterEach, describe, expect, it, vi } from "vitest";
import { evalFlagEnv } from "../../../../vitest.eval.config";
import { printRun } from "./live-run";
import { summarize } from "./report";

describe("live eval entry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hands --only and --limit after the script's -- to the run as environment", () => {
    const argv = ["node", "vitest", "run", "--config", "vitest.eval.config.ts", "--", "--limit", "1", "--only=synonym,single-item"];
    expect(evalFlagEnv(argv)).toEqual({ ASSISTANT_EVAL_LIMIT: "1", ASSISTANT_EVAL_ONLY: "synonym,single-item" });
    expect(evalFlagEnv(["node", "vitest", "run", "--config", "vitest.eval.config.ts", "--"])).toEqual({});
  });

  it("refuses a flag with no value instead of starting the full run", () => {
    expect(() => evalFlagEnv(["vitest", "--", "--limit"])).toThrow("--limit needs a value.");
    expect(() => evalFlagEnv(["vitest", "--", "--only", "--limit", "2"])).toThrow("--only needs a value.");
  });

  it("the console summary names the model and the spend in USD", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    printRun([], summarize([]), "fail", [], {
      spendMicros: BigInt(1234567),
      inputTokens: 10,
      outputTokens: 2,
      ledgerDeltaMicros: BigInt(1234567),
      conversationMicros: BigInt(1234567),
      complete: true,
      incompleteReason: null,
    }, BigInt(3235858), { turns: 0, medianMs: null, p90Ms: null }, "claude-haiku-5-5");
    const printed = JSON.parse(String(log.mock.calls.at(-1)?.[0])) as Record<string, unknown>;
    expect(printed).toMatchObject({ model: "claude-haiku-5-5", spendUsd: "1.234567", ticketUsd: "3.235858" });
  });
});
