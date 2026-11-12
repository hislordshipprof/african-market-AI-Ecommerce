import { describe, expect, it, vi } from "vitest";
import { createFakeAnthropicFetch } from "../messages-api-double";
import { assessReport, checkCommittedEval } from "./gate";
import { summarize } from "./report";
import { fingerprintFromParts, type Fingerprint } from "./fingerprint";
import type { EvalReport } from "./report";
import type { CaseResult } from "./types";
import baseConfig from "../../../../vitest.config";
import evalConfig from "../../../../vitest.eval.config";

vi.mock("next/cache", () => ({
  unstable_cache: (fn: () => unknown) => fn,
  revalidateTag: () => {},
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));

const hasDb = !!process.env.DATABASE_URL;

function fingerprint(staticPrompt = "prompt"): Fingerprint {
  return fingerprintFromParts({
    staticPrompt,
    storeContext: "Golden Eval Market",
    tools: [{ name: "search_catalog" }],
    requestParams: { model: "claude-haiku-5-5", maxTokens: 1024, thinking: { type: "disabled" }, effort: "medium" },
    stepCap: 8,
    dataset: [],
    fixture: {
      schemaVersion: 1,
      pinnedNow: "2026-06-15T16:00:00.000Z",
      store: {
        name: "Golden Eval Market",
        timezone: "America/Chicago",
        hours: { mon: { open: "09:00", close: "21:00" } },
        minimumOrderCents: 1500,
        pickupEnabled: true,
      },
      listings: [],
    },
    masterCatalog: [{ id: "garri-white", name: "Garri", categoryId: "cat_grains", synonyms: ["garri"] }],
  });
}

function passing(id: string, numerator = 1, denominator = 1): CaseResult {
  return {
    id,
    category: "single-item",
    pass: numerator === denominator,
    reason: numerator === denominator ? "ok" : "recall",
    attempts: 1,
    precision: 1,
    recall: numerator / denominator,
    precisionNumerator: 1,
    precisionDenominator: 1,
    recallNumerator: numerator,
    recallDenominator: denominator,
    hallucinated: [],
    strippedAmounts: [],
    ungroundedAmountsShown: [],
    temporalViolations: [],
    gapsReported: true,
    safetyFailures: [],
    stickyIntegrity: false,
    finalCart: [],
    steps: 1,
    stepLimitHit: false,
    toolInputErrors: 0,
    quantityChecks: 0,
    quantityHits: 0,
    gapRequired: false,
    costMicros: "1",
    anthropicRequestIds: [`req_${id}`],
    requestProvenance: [{ attempt: 1, turn: 1, step: 1, requestId: `req_${id}` }],
  };
}

function report(cases: CaseResult[], current = fingerprint(), extra: Partial<EvalReport> = {}): EvalReport {
  return {
    schemaVersion: 1,
    fingerprint: current,
    model: "claude-haiku-5-5",
    gitSha: "abc",
    startedAt: "2026-06-15T16:00:00.000Z",
    finishedAt: "2026-06-15T16:10:00.000Z",
    datasetCases: cases.length,
    complete: true,
    incompleteReason: null,
    summary: summarize(cases),
    verdict: "haiku-ok",
    verdictReasons: [],
    spend: { micros: "1", usd: "0.000001", ledgerDeltaMicros: "1", conversationMicros: "1", inputTokens: 1, outputTokens: 1 },
    sessionUser: "app_runtime",
    cases,
    ...extra,
  };
}

describe("shopper assistant eval gate", () => {
  it("rejects stale fingerprints malformed evidence and inconsistent summaries", () => {
    const current = fingerprint("current prompt");
    const ids = ["one", "two"];
    const expectIds = { fingerprint: current, caseIds: ids, model: "claude-haiku-5-5" };
    const changed = assessReport(report([passing("one"), passing("two")], fingerprint("old prompt")), expectIds);
    expect(changed.ok).toBe(false);
    expect(changed.reasons.join(" ")).toContain("static prompt");

    const missing = assessReport(report([passing("one")]), { ...expectIds, caseIds: ids });
    expect(missing.reasons).toContain("case ids");

    const duplicate = report([passing("one"), passing("one")]);
    expect(assessReport(duplicate, { ...expectIds, caseIds: ["one", "one"] }).reasons).toContain("duplicate case ids");

    const bare = passing("one");
    bare.requestProvenance = [{ attempt: 1, turn: 1, step: 1, requestId: "msg_missing" }];
    expect(assessReport(report([bare, passing("two")]), expectIds).reasons.join(" ")).toContain("missing request provenance");

    const hallucinated = passing("one");
    hallucinated.hallucinated = [{ tool: "add_to_cart", field: "variant_id", id: "nope", crossStore: false }];
    hallucinated.pass = false;
    expect(assessReport(report([hallucinated, passing("two")]), expectIds).reasons).toContain("hallucinated items");

    const shown = passing("one");
    shown.ungroundedAmountsShown = [999];
    shown.pass = false;
    expect(assessReport(report([shown, passing("two")]), expectIds).reasons).toContain("ungrounded amounts shown");

    const unsafe = passing("one");
    unsafe.safetyFailures = ["wrong-pack"];
    unsafe.pass = false;
    expect(assessReport(report([unsafe, passing("two")]), expectIds).reasons).toContain("safety failures");

    const uneven = report([passing("one", 1, 1), passing("two", 8, 10)]);
    const floors = assessReport(uneven, expectIds);
    expect(floors.ok).toBe(false);
    expect(floors.reasons).toContain("micro recall below 0.85");
    expect(floors.reasons.join(" ")).not.toContain("0.90");

    const forged = report([passing("one"), passing("two")]);
    forged.summary.recallNumerator = 99;
    expect(assessReport(forged, expectIds).reasons).toContain("summary does not match the case counts");

    const flagged = passing("one");
    flagged.pass = true;
    flagged.safetyFailures = ["audit_failed"];
    expect(assessReport(report([flagged, passing("two")]), expectIds).reasons.join(" ")).toContain("forged pass flag");

    const incomplete = report([passing("one"), passing("two")], current, { complete: false });
    expect(assessReport(incomplete, expectIds).reasons).toContain("incomplete");

    const malformed = report([passing("one"), passing("two")]);
    malformed.spend = undefined as unknown as EvalReport["spend"];
    malformed.startedAt = "";
    malformed.finishedAt = "";
    malformed.verdict = undefined as unknown as EvalReport["verdict"];
    malformed.cases[0]!.precisionNumerator = -1;
    malformed.cases[0]!.precisionDenominator = -1;
    malformed.cases[0]!.stickyIntegrity = true;
    malformed.cases[0]!.anthropicRequestIds = [];
    malformed.cases[1]!.requestProvenance = [{ attempt: 1, turn: 1, step: 1, requestId: "req_one" }];
    malformed.cases[1]!.anthropicRequestIds = ["req_one"];
    const rejected = assessReport(malformed, expectIds);
    expect(rejected.ok).toBe(false);
    expect(rejected.reasons.join(" ")).toMatch(/spend|startedAt|verdict|invalid counts|sticky integrity|reused request id|missing request provenance/);

    const same = fingerprint("current prompt");
    expect(same.sha256).toBe(current.sha256);
    expect(Object.keys(same.parts).sort()).toEqual(["dataset", "fixture", "masterCatalog", "requestParams", "staticPrompt", "stepCap", "storeContext", "tools"]);
  });

  it.skipIf(!hasDb)("uses only the injected fake under hosted CI and with inherited local live flags", async () => {
    vi.stubEnv("E2E_FAKE_ASSISTANT", "1");
    vi.stubEnv("CI", "true");
    vi.stubEnv("ASSISTANT_EVAL_LIVE", "1");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-live-looking-key");
    vi.stubEnv("ASSISTANT_SPEND_CAP_USD", "1000000");
    const spy = vi.spyOn(globalThis, "fetch");
    let injected = 0;
    const fake = createFakeAnthropicFetch({
      expectedKey: "sk-ant-test",
      steps: [{ kind: "text", text: "probe" }],
    });
    const verdict = await checkCommittedEval({
      fetch: async (input, init) => {
        injected += 1;
        return fake.fetch(input, init);
      },
    });
    expect(injected).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
    expect(verdict.reasons.join(" ")).not.toContain("api.anthropic.com");
    expect(evalConfig.test?.include).toEqual(["src/lib/assistant/eval/live.entry.ts"]);
    expect(JSON.stringify(baseConfig.test?.include)).not.toContain("live.entry");
    spy.mockRestore();
    vi.unstubAllEnvs();
  }, 180_000);

});
