import { describe, expect, it, vi } from "vitest";
import { createFakeAnthropicFetch } from "../messages-api-double";
import { canonicalJson } from "./canonical";
import { assessReport, checkCommittedEval } from "./gate";
import { formatUsdFromMicros } from "./money";
import { summarize } from "./report";
import { scoreCase, type CatalogBinding, type ScoreOutput } from "./score";
import { fingerprintFromParts, type Fingerprint } from "./fingerprint";
import type { EvalReport } from "./report";
import type { CaseResult, EvalCase } from "./types";

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
    completed: true,
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
  const micros = cases.reduce((sum, item) => sum + BigInt(item.costMicros), BigInt(0));
  const text = micros.toString();
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
    spend: { micros: text, usd: formatUsdFromMicros(micros), ledgerDeltaMicros: text, conversationMicros: text, inputTokens: 1, outputTokens: 1 },
    sessionUser: "app_runtime",
    cases,
    ...extra,
  };
}

function twoPackBinding(): CatalogBinding {
  const pack = (key: string, variantKey: string) => ({
    id: variantKey,
    key: variantKey,
    listingKey: key,
    listingId: key,
    store: "A" as const,
    priceCents: 100,
  });
  const garri = pack("garri", "garri-pack");
  const rice = pack("rice", "rice-pack");
  const listing = (key: string) => ({
    id: key,
    key,
    store: "A" as const,
    confidence: 1,
    stockMode: "unlimited",
    qty: null,
    status: null,
    active: true,
  });
  return {
    byListingKey: new Map([["garri", listing("garri")], ["rice", listing("rice")]]),
    byVariantKey: new Map([["garri-pack", garri], ["rice-pack", rice]]),
    byListingId: new Map([["garri", "garri"], ["rice", "rice"]]),
    byVariantId: new Map([["garri-pack", garri], ["rice-pack", rice]]),
    aListingIds: new Set(["garri", "rice"]),
    aVariantIds: new Set(["garri-pack", "rice-pack"]),
    bListingIds: new Set(),
    bVariantIds: new Set(),
    minimumOrderCents: 1500,
  };
}

function caseFromScore(id: string, category: CaseResult["category"], scored: ScoreOutput, gapRequired: boolean): CaseResult {
  return {
    id,
    category,
    pass: scored.pass,
    completed: true,
    reason: scored.reason,
    attempts: 1,
    precision: scored.precision,
    recall: scored.recall,
    precisionNumerator: scored.precisionNumerator,
    precisionDenominator: scored.precisionDenominator,
    recallNumerator: scored.recallNumerator,
    recallDenominator: scored.recallDenominator,
    hallucinated: scored.hallucinated,
    strippedAmounts: [],
    ungroundedAmountsShown: scored.ungroundedAmountsShown,
    temporalViolations: scored.temporalViolations,
    gapsReported: scored.gapsReported,
    safetyFailures: scored.safetyFailures,
    stickyIntegrity: false,
    finalCart: [],
    steps: 1,
    stepLimitHit: false,
    toolInputErrors: 0,
    quantityChecks: 0,
    quantityHits: 0,
    gapRequired,
    costMicros: "0",
    anthropicRequestIds: [`req_${id}`],
    requestProvenance: [{ attempt: 1, turn: 1, step: 1, requestId: `req_${id}` }],
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

    const roundTrip = report([passing("one")], current);
    const oneId = { fingerprint: current, caseIds: ["one"], model: "claude-haiku-5-5" };
    expect(assessReport(roundTrip, oneId).ok).toBe(true);
    expect(assessReport(JSON.parse(canonicalJson(roundTrip)), oneId).ok).toBe(true);

    const forgedProof = report([passing("proof")]);
    forgedProof.datasetCases = 999;
    forgedProof.incompleteReason = "authentication";
    forgedProof.finishedAt = "2020-01-01T00:00:00.000Z";
    forgedProof.cases[0]!.precision = -5;
    forgedProof.cases[0]!.recall = 999;
    forgedProof.summary.microPrecision = -5;
    forgedProof.summary.microRecall = 999;
    const forgedVerdict = assessReport(forgedProof, { fingerprint: current, caseIds: ["proof"], model: "claude-haiku-5-5" });
    expect(forgedVerdict.ok).toBe(false);
    expect(forgedVerdict.reasons.join(" ")).toMatch(/dataset cases|incomplete reason|finished before start|summary does not match/);

    const unmetCase: EvalCase = {
      id: "unmet",
      category: "single-item",
      turns: ["Add garri."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
    };
    expect(assessReport(report([passing("unmet")]), {
      fingerprint: current,
      caseIds: ["unmet"],
      model: "claude-haiku-5-5",
      cases: [unmetCase],
    }).reasons.join(" ")).toContain("cart does not match unmet");
  });

  it("empty gap cases do not dilute one wrong cart in the micro averages", () => {
    const binding = twoPackBinding();
    const wrong = scoreCase({
      evalCase: {
        id: "asked-garri",
        category: "single-item",
        turns: ["Add garri."],
        mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
        mayHave: [],
        gaps: [],
      },
      cart: [{ key: "rice", variantKey: "rice-pack", qty: 1, swapRule: "exact_only", substituteVariantKey: null }],
      tools: [],
      savedTexts: [],
      observedTexts: [],
      strippedAmounts: [],
      successfulWriteTurns: [],
      returnedLineIds: [],
      cartLineIds: [],
      stepLimitHit: false,
    }, binding, []);
    const gaps = Array.from({ length: 9 }, (_, index) => scoreCase({
      evalCase: {
        id: `gap-${index}`,
        category: "out-of-stock",
        turns: ["Add the missing one."],
        mustHave: [],
        mayHave: [],
        gaps: [{ mention: ["unavailable"] }],
      },
      cart: [],
      tools: [],
      savedTexts: [],
      observedTexts: [],
      strippedAmounts: [],
      successfulWriteTurns: [],
      returnedLineIds: [],
      cartLineIds: [],
      stepLimitHit: false,
    }, binding, ["That one is unavailable."]));
    const cases = [caseFromScore("asked-garri", "single-item", wrong, false), ...gaps.map((item, index) => caseFromScore(`gap-${index}`, "out-of-stock", item, true))];
    const verdict = assessReport(report(cases), {
      fingerprint: fingerprint(),
      caseIds: cases.map((item) => item.id),
      model: "claude-haiku-5-5",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toContain("micro precision below 0.90");
    expect(verdict.reasons).toContain("micro recall below 0.85");
  });

  it.skipIf(!hasDb)("rejects a report whose model is not the default Haiku fingerprint", async () => {
    vi.stubEnv("E2E_FAKE_ASSISTANT", "1");
    vi.stubEnv("CI", "true");
    vi.stubEnv("ASSISTANT_EVAL_LIVE", "1");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-live-looking-key");
    vi.stubEnv("ASSISTANT_MODEL", "claude-sonnet-5-5");
    const spy = vi.spyOn(globalThis, "fetch");
    const fake = createFakeAnthropicFetch({
      expectedKey: "sk-ant-test",
      steps: [{ kind: "text", text: "probe" }],
    });
    let probeModel = "";
    const verdict = await checkCommittedEval({
      reportText: JSON.stringify({ model: "claude-sonnet-5-5", schemaVersion: 1 }),
      fetch: async (input, init) => {
        const raw = typeof init?.body === "string"
          ? init.body
          : input instanceof Request
            ? await input.clone().text()
            : "";
        if (raw) {
          const parsed = JSON.parse(raw) as { model?: string };
          if (parsed.model) probeModel = parsed.model;
        }
        return fake.fetch(input, init);
      },
    });
    expect(probeModel).toBe("claude-haiku-5-5");
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons).toContain("model");
    expect(verdict.reasons.join(" ")).toContain("fingerprint");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    vi.unstubAllEnvs();
  }, 180_000);

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
    vi.stubEnv("ASSISTANT_MODEL", "claude-sonnet-5-5");
    let probeModel = "";
    const verdict = await checkCommittedEval({
      fetch: async (input, init) => {
        injected += 1;
        const raw = typeof init?.body === "string"
          ? init.body
          : input instanceof Request
            ? await input.clone().text()
            : "";
        if (raw) {
          const parsed = JSON.parse(raw) as { model?: string };
          if (parsed.model) probeModel = parsed.model;
        }
        return fake.fetch(input, init);
      },
    });
    expect(injected).toBeGreaterThan(0);
    expect(probeModel).toBe("claude-haiku-5-5");
    expect(spy).not.toHaveBeenCalled();
    expect(verdict.reasons.join(" ")).not.toContain("api.anthropic.com");
    expect(verdict.ok).toBe(true);
    expect(evalConfig.test?.include).toEqual(["src/lib/assistant/eval/live.entry.ts"]);
    expect(JSON.stringify(baseConfig.test?.include)).not.toContain("live.entry");
    spy.mockRestore();
    vi.unstubAllEnvs();
  }, 180_000);

});
