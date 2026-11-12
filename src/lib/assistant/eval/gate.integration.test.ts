import { describe, expect, it, vi } from "vitest";
import { createFakeAnthropicFetch } from "../messages-api-double";
import { canonicalJson } from "./canonical";
import { assessOfficial, assessReport, checkCommittedEval } from "./gate";
import { formatUsdFromMicros } from "./money";
import { officialReport, summarize } from "./report";
import { scoreCase, type CatalogBinding, type ObservedTool, type ScoreOutput } from "./score";
import { fingerprintFromParts, type Fingerprint } from "./fingerprint";
import type { EvalReport } from "./report";
import type { CartSnapshotLine, CaseResult, EvalCase } from "./types";

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
    rejectedAttempts: [],
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
    dish: false,
    dishMisses: [],
    clarifyReply: null,
    clarifyOptions: [],
    clarifyChoices: [],
    savedNeeds: false,
    droppedAttempts: 0,
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
    spend: { micros: text, usd: formatUsdFromMicros(micros), droppedMicros: "0", ledgerDeltaMicros: text, conversationMicros: text, inputTokens: 1, outputTokens: 1 },
    sessionUser: "app_runtime",
    cases,
    ...extra,
  };
}

const LISTING_NAMES: Record<string, string> = {
  garri: "Garri",
  rice: "Rice",
  "paste-a": "Egusi (melon seeds), shelled",
  "paste-b": "Egusi, ground",
  "onion-paste": "Onion paste",
};

function twoPackBinding(): CatalogBinding {
  const pack = (key: string, variantKey: string) => ({
    id: variantKey,
    key: variantKey,
    listingKey: key,
    listingId: key,
    store: "A" as const,
    priceCents: 100,
  });
  const keys = ["garri", "rice", "paste-a", "paste-b", "onion-paste"];
  const packs = keys.map((key) => pack(key, `${key}-pack`));
  const listing = (key: string) => ({
    id: key,
    key,
    store: "A" as const,
    confidence: 1,
    stockMode: "unlimited",
    qty: null,
    status: null,
    active: true,
    name: LISTING_NAMES[key],
  });
  return {
    byListingKey: new Map(keys.map((key) => [key, listing(key)])),
    byVariantKey: new Map(packs.map((item) => [item.key, item])),
    byListingId: new Map(keys.map((key) => [key, key])),
    byVariantId: new Map(packs.map((item) => [item.key, item])),
    aListingIds: new Set(keys),
    aVariantIds: new Set(packs.map((item) => item.key)),
    bListingIds: new Set(),
    bVariantIds: new Set(),
    minimumOrderCents: 1500,
  };
}

function caseFromScore(id: string, category: CaseResult["category"], scored: ScoreOutput, gapRequired: boolean, cart: CartSnapshotLine[] = []): CaseResult {
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
    rejectedAttempts: scored.rejectedAttempts,
    strippedAmounts: [],
    ungroundedAmountsShown: scored.ungroundedAmountsShown,
    temporalViolations: scored.temporalViolations,
    gapsReported: scored.gapsReported,
    safetyFailures: scored.safetyFailures,
    stickyIntegrity: false,
    finalCart: cart,
    steps: 1,
    stepLimitHit: false,
    toolInputErrors: 0,
    quantityChecks: 0,
    quantityHits: 0,
    gapRequired,
    dish: category === "recipe-to-cart",
    dishMisses: scored.dishMisses,
    clarifyReply: scored.clarifyReply,
    clarifyOptions: scored.clarifyOptions,
    clarifyChoices: scored.clarifyChoices,
    savedNeeds: scored.savedNeeds,
    droppedAttempts: 0,
    costMicros: "0",
    anthropicRequestIds: [`req_${id}`],
    requestProvenance: [{ attempt: 1, turn: 1, step: 1, requestId: `req_${id}` }],
  };
}

describe("shopper assistant eval gate", () => {
  it("accepts a case whose dropped attempt was retried to success, and rejects a forged drop count", () => {
    const expectIds = { fingerprint: fingerprint(), caseIds: ["one"], model: "claude-haiku-5-5" };
    const recovered = (dropped: unknown): CaseResult => ({
      ...passing("one"),
      attempts: 2,
      droppedAttempts: dropped as number,
      anthropicRequestIds: ["req_one_1", "req_one_2"],
      requestProvenance: [
        { attempt: 1, turn: 1, step: 1, requestId: "req_one_1" },
        { attempt: 2, turn: 1, step: 1, requestId: "req_one_2" },
      ],
    });
    expect(assessReport(report([recovered(1)]), expectIds)).toEqual({ ok: true, reasons: [] });
    expect(assessReport(report([recovered(2)]), expectIds).reasons).toContain("invalid counts on one");
    expect(assessReport(report([recovered(-1)]), expectIds).reasons).toContain("invalid counts on one");
    expect(assessReport(report([recovered(undefined)]), expectIds).reasons).toContain("invalid counts on one");

    // A connection closed before the response gives that attempt no request id.
    const noResponse = (dropped: number, attempt: number): CaseResult => ({
      ...recovered(dropped),
      anthropicRequestIds: [`req_one_${attempt}`],
      requestProvenance: [{ attempt, turn: 1, step: 1, requestId: `req_one_${attempt}` }],
    });
    expect(assessReport(report([noResponse(1, 2)]), expectIds)).toEqual({ ok: true, reasons: [] });
    expect(assessReport(report([noResponse(0, 2)]), expectIds).reasons).toContain("missing request provenance for one");
    expect(assessReport(report([noResponse(1, 1)]), expectIds).reasons).toContain("missing request provenance for one");

    const cut = { ...recovered(1), costMicros: "10" };
    const spend = (dropped: string, recorded: string) => ({ micros: "10", usd: formatUsdFromMicros(BigInt(10)), droppedMicros: dropped, ledgerDeltaMicros: recorded, conversationMicros: recorded, inputTokens: 1, outputTokens: 1 });
    expect(assessReport(report([cut], fingerprint(), { spend: spend("6", "4") }), expectIds)).toEqual({ ok: true, reasons: [] });
    expect(assessReport(report([{ ...cut, droppedAttempts: 0, attempts: 2 }], fingerprint(), { spend: spend("6", "4") }), expectIds).reasons).toContain("spend");
    expect(assessReport(report([cut], fingerprint(), { spend: spend("5", "4") }), expectIds).reasons).toContain("spend");
    expect(assessReport(report([cut], fingerprint(), { spend: spend("-6", "16") }), expectIds).reasons).toContain("spend");
  });

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

  it("scores dish cases pass or fail on core items, outside the micro counts", () => {
    const binding = twoPackBinding();
    const dish: EvalCase = {
      id: "jollof",
      category: "recipe-to-cart",
      turns: ["Jollof. No onion.", "For 6 people.", "Yes, add those."],
      mustHave: [],
      mayHave: [],
      gaps: [],
      addsFromTurn: 3,
      excluded: ["onion-paste"],
      dish: {
        core: [{ label: "rice", options: ["rice"] }, { label: "tomato paste", options: ["paste-a", "paste-b"] }],
        askServings: true,
      },
    };
    const line = (key: string, qty = 1): CartSnapshotLine => ({ key, variantKey: `${key}-pack`, qty, swapRule: "exact_only", substituteVariantKey: null });
    const score = (cart: CartSnapshotLine[], firstReply: string) => scoreCase({
      evalCase: dish,
      cart,
      tools: [],
      savedTexts: [{ turn: 1, text: firstReply, priorOutputs: [], saved: true }],
      observedTexts: [],
      strippedAmounts: [],
      successfulWriteTurns: [],
      returnedLineIds: [],
      cartLineIds: [],
      stepLimitHit: false,
    }, binding, [firstReply]);
    const asks = "How many people are you cooking for?";

    const anyBrand = score([line("rice", 7), line("paste-b"), line("garri")], asks);
    expect(anyBrand.pass).toBe(true);
    expect([anyBrand.precisionDenominator, anyBrand.recallDenominator]).toEqual([0, 0]);
    expect(score([line("rice")], asks).dishMisses).toEqual(["missing tomato paste"]);
    expect(score([line("rice"), line("paste-a")], "Here is a list.").dishMisses).toEqual(["servings not asked"]);
    const excluded = score([line("rice"), line("paste-a"), line("onion-paste")], asks);
    expect(excluded.pass).toBe(false);
    expect(excluded.safetyFailures).toContain("excluded-item");

    const cart = [line("rice"), line("paste-a")];
    const dishes = Array.from({ length: 10 }, (_, index) => ({ ...dish, id: `dish-${index}` }));
    const results = dishes.map((item, index) => {
      const lines = index < 2 ? [line("rice")] : cart;
      const result = caseFromScore(item.id, "recipe-to-cart", score(lines, asks), false, lines);
      result.requestProvenance = [1, 2, 3].map((turn) => ({ attempt: 1, turn, step: 1, requestId: `req_${item.id}_${turn}` }));
      result.anthropicRequestIds = result.requestProvenance.map((step) => step.requestId);
      return result;
    });
    const expected = { fingerprint: fingerprint(), caseIds: dishes.map((item) => item.id), model: "claude-haiku-5-5", cases: dishes, binding };
    const verdict = assessReport(report(results), expected);
    expect(verdict.reasons).toEqual(["dish pass rate below 0.85"]);
    expect(report(results).summary).toMatchObject({ dishCases: 10, dishPassed: 8, precisionDenominator: 0, recallDenominator: 0 });

    const forged = results.map((item) => ({ ...item, dishMisses: [], pass: true, reason: "ok" }));
    const forgedVerdict = assessReport(report(forged), expected);
    expect(forgedVerdict.reasons).toContain("cart does not match dish-0");
    expect(forgedVerdict.reasons).not.toContain("dish pass rate below 0.85");
    expect(forgedVerdict.ok).toBe(false);
  });

  it("accepts Exact item only on a may-be-unavailable line only under saved needs with no passing backup (owner, 2026-11-12)", () => {
    const binding = twoPackBinding();
    const out = (key: string) => binding.byListingKey.get(key)!;
    binding.byListingKey.set("paste-a", { ...out("paste-a"), stockMode: "status", status: "out_of_stock" });
    binding.byListingKey.set("paste-b", { ...out("paste-b"), attributes: { ingredients: ["tomato"], allergens: [], dietary: [] } });
    binding.byListingKey.set("onion-paste", { ...out("onion-paste"), attributes: { ingredients: ["tomato", "yellow onion"], allergens: [], dietary: [] } });
    const paste: EvalCase = {
      id: "paste",
      category: "single-item",
      turns: ["No yellow onion. Add 1 paste-a."],
      mustHave: [{ options: [{ listingKey: "paste-a", variantKeys: ["paste-a-pack"] }] }],
      mayHave: [],
      gaps: [],
    };
    const cart: CartSnapshotLine[] = [{ key: "paste-a", variantKey: "paste-a-pack", qty: 1, swapRule: "exact_only", substituteVariantKey: null }];
    const needs = { tool: "set_shopper_needs", input: {}, output: { ok: true, avoidAllergens: [], requireClaims: [], avoidIngredients: ["yellow onion"] }, turn: 1 };
    const noNeeds = { ...needs, output: { ok: true, avoidAllergens: [], requireClaims: [], avoidIngredients: [] } };
    const add = (backup?: string) => ({
      tool: "add_to_cart",
      input: { items: [{ variant_id: "paste-a-pack", qty: 1, ...(backup ? { backup_variant_id: backup } : {}) }] },
      output: { ok: true },
      turn: 1,
    });
    const score = (tools: ObservedTool[], savedNeeds?: boolean) => scoreCase({
      evalCase: paste,
      cart,
      tools,
      savedTexts: [{ turn: 1, text: "Added paste-a. Exact item only.", priorOutputs: [], saved: true }],
      observedTexts: [],
      strippedAmounts: [],
      successfulWriteTurns: [1],
      returnedLineIds: [],
      cartLineIds: [],
      stepLimitHit: false,
      ...(savedNeeds != null ? { savedNeeds } : {}),
    }, binding, ["Added paste-a. Exact item only."]);

    expect(score([add()]).safetyFailures).toContain("invalid-swap");
    expect(score([noNeeds, add()]).safetyFailures).toContain("invalid-swap");
    const refunded = score([needs, add()]);
    expect(refunded.safetyFailures).toEqual([]);
    expect(refunded.pass).toBe(true);
    expect(score([needs, add("onion-paste-pack")]).safetyFailures).toEqual([]);
    expect(score([needs, add("paste-b-pack")]).safetyFailures).toContain("invalid-swap");
    expect(score([needs, add("paste-a-pack")]).safetyFailures).toEqual([]);
    binding.byListingKey.set("paste-b", { ...out("paste-b"), stockMode: "status", status: "out_of_stock" });
    expect(score([needs, add("paste-b-pack")]).safetyFailures).toEqual([]);

    const expected = { fingerprint: fingerprint(), caseIds: ["paste"], model: "claude-haiku-5-5", cases: [paste], binding };
    const committed = caseFromScore("paste", "single-item", refunded, false, cart);
    expect(committed.savedNeeds).toBe(true);
    expect(assessReport(report([committed]), expected).reasons).not.toContain("cart does not match paste");
    expect(assessReport(report([{ ...committed, savedNeeds: false }]), expected).reasons).toContain("cart does not match paste");
  });

  it("fails a made-up id only when it reaches the cart or a reply, and counts a refused one as a rejected attempt", () => {
    const binding = twoPackBinding();
    const garri: EvalCase = {
      id: "garri",
      category: "single-item",
      turns: ["Add 1 garri."],
      mustHave: [{ options: [{ listingKey: "garri", variantKeys: ["garri-pack"] }] }],
      mayHave: [],
      gaps: [],
    };
    const line = (variantKey: string): CartSnapshotLine => ({ key: variantKey === "garri-pack" ? "garri" : variantKey, variantKey, qty: 1, swapRule: "exact_only", substituteVariantKey: null });
    const refused = { tool: "add_to_cart", input: { items: [{ variant_id: "made-up", qty: 1 }] }, output: { ok: false, code: "variant_not_found" }, turn: 1 };
    const added = { tool: "add_to_cart", input: { items: [{ variant_id: "garri-pack", qty: 1 }] }, output: { ok: true }, turn: 1 };
    const score = (tools: ObservedTool[], cart: CartSnapshotLine[], reply: string) => scoreCase({
      evalCase: garri,
      cart,
      tools,
      savedTexts: [{ turn: 1, text: reply, priorOutputs: [], saved: true }],
      observedTexts: [],
      strippedAmounts: [],
      successfulWriteTurns: [1],
      returnedLineIds: [],
      cartLineIds: [],
      stepLimitHit: false,
    }, binding, [reply]);

    const recovered = score([refused, added], [line("garri-pack")], "Added garri.");
    expect(recovered.pass).toBe(true);
    expect(recovered.hallucinated).toEqual([]);
    expect(recovered.rejectedAttempts).toEqual([{ tool: "add_to_cart", field: "variant_id", id: "made-up", crossStore: false }]);

    const told = score([refused, added], [line("garri-pack")], "Added garri. I also tried made-up.");
    expect([told.pass, told.hallucinated.map((item) => item.id), told.rejectedAttempts]).toEqual([false, ["made-up"], []]);

    const inCart = score([{ ...refused, output: { ok: true } }], [line("made-up")], "Added.");
    expect(inCart.pass).toBe(false);
    expect(inCart.hallucinated.map((item) => item.id)).toContain("made-up");

    const multi = { tool: "add_to_cart", input: { items: [{ variant_id: "made-up", qty: 1 }, { variant_id: "garri-pack", qty: 1 }] }, output: { ok: true, items: [{ ok: false, code: "variant_not_found" }, { ok: true }] }, turn: 1 };
    expect(score([multi], [line("garri-pack")], "Added garri.").rejectedAttempts.map((item) => item.id)).toEqual(["made-up"]);
    const silentBackup = { tool: "add_to_cart", input: { items: [{ variant_id: "garri-pack", qty: 1, backup_variant_id: "made-up" }] }, output: { ok: true, items: [{ ok: true }] }, turn: 1 };
    expect(score([silentBackup], [line("garri-pack")], "Added garri.").hallucinated.map((item) => item.id)).toEqual(["made-up"]);
    const auditFailed = score([{ ...refused, output: { ok: false, code: "audit_failed" } }, added], [line("garri-pack")], "Added garri.");
    expect(auditFailed.hallucinated.map((item) => item.id)).toEqual(["made-up"]);

    const expected = { fingerprint: fingerprint(), caseIds: ["garri"], model: "claude-haiku-5-5", cases: [garri], binding };
    const good = caseFromScore("garri", "single-item", recovered, false, [line("garri-pack")]);
    const verdict = assessReport(report([good]), expected);
    expect(verdict.reasons).toEqual([]);
    expect(report([good]).summary).toMatchObject({ hallucinatedItems: 0, rejectedAttempts: 1 });

    const movedFromCart = { ...caseFromScore("garri", "single-item", inCart, false, [line("made-up")]), hallucinated: [], rejectedAttempts: [{ tool: "add_to_cart", field: "variant_id", id: "made-up", crossStore: false }] };
    expect(assessReport(report([movedFromCart]), expected).ok).toBe(false);
    const crossStore = { ...good, rejectedAttempts: [{ tool: "add_to_cart", field: "variant_id", id: "b-id", crossStore: true }] };
    expect(assessReport(report([crossStore]), expected).reasons).toContain("invalid counts on garri");
    const cartTool = { ...good, rejectedAttempts: [{ tool: "cart", field: "variant_id", id: "x", crossStore: false }] };
    expect(assessReport(report([cartTool]), expected).reasons).toContain("invalid counts on garri");
    const both = { ...good, hallucinated: [{ tool: "add_to_cart", field: "variant_id", id: "made-up", crossStore: false }], pass: false, reason: "hallucinated-item" };
    expect(assessReport(report([both]), expected).reasons).toContain("invalid counts on garri");
    const missing = { ...good } as Partial<CaseResult>;
    delete missing.rejectedAttempts;
    expect(assessReport(report([missing as CaseResult]), expected).ok).toBe(false);
    const undercounted = { ...report([good]), summary: { ...summarize([good]), rejectedAttempts: 0 } };
    expect(assessReport(undercounted, expected).reasons).toContain("summary does not match the case counts");
  });

  it("averages two runs for the floors, holds safety in each run, and rejects a reused or missing run", () => {
    const expected = { fingerprint: fingerprint(), caseIds: ["one", "two"], model: "claude-haiku-5-5" };
    const run = (tag: string, recall: number): EvalReport => {
      const cases = [passing("one"), passing("two", recall, 10)].map((item) => ({
        ...item,
        anthropicRequestIds: [`req_${tag}_${item.id}`],
        requestProvenance: [{ attempt: 1, turn: 1, step: 1, requestId: `req_${tag}_${item.id}` }],
      }));
      return report(cases);
    };
    // Recall 11/11 with 8/11 averages to 0.864, which passes though 8/11 alone fails; with 7/11 it is 0.818.
    expect(assessOfficial(officialReport([run("a", 10), run("b", 7)]), expected)).toEqual({ ok: true, reasons: [] });
    expect(assessReport(run("b", 7), expected).reasons).toContain("micro recall below 0.85");
    const low = assessOfficial(officialReport([run("a", 10), run("b", 6)]), expected);
    expect(low.reasons).toEqual(["micro recall below 0.85"]);

    const harmful = run("b", 10);
    harmful.cases[0] = { ...harmful.cases[0]!, pass: false, hallucinated: [{ tool: "add_to_cart", field: "variant_id", id: "nope", crossStore: false }] };
    harmful.summary = summarize(harmful.cases);
    expect(assessOfficial(officialReport([run("a", 10), harmful]), expected).reasons).toContain("run 2: hallucinated items");
    const excluded = run("a", 10);
    excluded.cases[1] = { ...excluded.cases[1]!, pass: false, safetyFailures: ["excluded-item"] };
    excluded.summary = summarize(excluded.cases);
    expect(assessOfficial(officialReport([excluded, run("b", 10)]), expected).reasons).toContain("run 1: safety failures");

    expect(assessOfficial(officialReport([run("a", 10)]), expected).reasons).toContain("two runs");
    expect(assessOfficial(officialReport([run("a", 10), run("a", 10)]), expected).reasons).toContain("runs reuse request ids");
    const forged = { ...officialReport([run("a", 10), run("b", 7)]), average: { microPrecision: 1, microRecall: 1, dishPassRate: 1 } };
    expect(assessOfficial(forged, expected).reasons).toContain("average does not match the runs");
    expect(assessOfficial(run("a", 10), expected).ok).toBe(false);
  });

  it("passes an ambiguous request on either option or on one short question naming the store's matches", () => {
    const binding = twoPackBinding();
    const agushi: EvalCase = {
      id: "agushi",
      category: "synonym",
      turns: ["Add 1 agushi."],
      mustHave: [{ options: [{ listingKey: "paste-a", variantKeys: ["paste-a-pack"] }] }],
      mayHave: [],
      gaps: [],
    };
    const line = (key: string): CartSnapshotLine => ({ key, variantKey: `${key}-pack`, qty: 1, swapRule: "exact_only", substituteVariantKey: null });
    const search = (match: string): ObservedTool => ({
      tool: "search_catalog",
      input: { query: "agushi" },
      output: { ok: true, items: [
        { listingId: "paste-a", variantId: "paste-a-pack", name: LISTING_NAMES["paste-a"], priceCents: 569, match: "synonym" },
        { listingId: "paste-b", variantId: "paste-b-pack", name: LISTING_NAMES["paste-b"], match },
      ] },
      turn: 1,
    });
    const offer: ObservedTool = {
      tool: "offer_choices",
      input: { options: [{ listing_id: "paste-a", variant_id: "paste-a-pack" }, { listing_id: "paste-b", variant_id: "paste-b-pack" }] },
      output: { ok: true, options: [
        { listingId: "paste-a", variantId: "paste-a-pack", name: LISTING_NAMES["paste-a"] },
        { listingId: "paste-b", variantId: "paste-b-pack", name: LISTING_NAMES["paste-b"] },
      ], notFound: [] },
      turn: 1,
    };
    const score = (cart: CartSnapshotLine[], reply: string, tools: ObservedTool[]) => scoreCase({
      evalCase: agushi,
      cart,
      tools,
      savedTexts: [{ turn: 1, text: reply, priorOutputs: tools.map((tool) => tool.output), saved: true }],
      observedTexts: [],
      strippedAmounts: [],
      successfulWriteTurns: [],
      returnedLineIds: [],
      cartLineIds: [],
      stepLimitHit: false,
    }, binding, [reply]);
    const carded = "Agushi is egusi, and the store has two. Which one would you like?";
    const named = "Which would you like: Egusi (melon seeds), shelled, or Egusi, ground?";

    expect(score([line("paste-a")], "Added it.", [search("name")]).pass).toBe(true);
    const asked = score([], carded, [search("name"), offer]);
    expect([asked.pass, asked.recallNumerator, asked.clarifyReply, asked.clarifyOptions, asked.clarifyChoices])
      .toEqual([true, 1, carded, ["paste-a", "paste-b"], [LISTING_NAMES["paste-a"], LISTING_NAMES["paste-b"]]]);
    const inReply = score([], named, [search("synonym")]);
    expect([inReply.pass, inReply.clarifyOptions, inReply.clarifyChoices]).toEqual([true, ["paste-a", "paste-b"], []]);

    expect(score([], "Do you want the shelled egusi?", [search("name")]).pass).toBe(false);
    expect(score([], carded, [search("near"), offer]).pass).toBe(false);
    expect(score([], carded, [offer]).pass).toBe(false);
    expect(score([], `${carded} Or something else?`, [search("name"), offer]).pass).toBe(false);
    expect(score([], `${"Agushi is egusi, a melon seed. ".repeat(12)}${carded}`, [search("name"), offer]).pass).toBe(false);
    expect(score([line("paste-b")], carded, [search("name"), offer]).clarifyReply).toBeNull();
    const otherItem = { ...agushi, mustHave: [{ options: [{ listingKey: "rice", variantKeys: ["rice-pack"] }] }] };
    expect(scoreCase({
      evalCase: otherItem, cart: [], tools: [search("name"), offer],
      savedTexts: [{ turn: 1, text: carded, priorOutputs: [], saved: true }],
      observedTexts: [], strippedAmounts: [], successfulWriteTurns: [], returnedLineIds: [], cartLineIds: [], stepLimitHit: false,
    }, binding, [carded]).clarifyReply).toBeNull();

    const expected = { fingerprint: fingerprint(), caseIds: ["agushi"], model: "claude-haiku-5-5", cases: [agushi], binding };
    expect(assessReport(report([caseFromScore("agushi", "synonym", asked, false)]), expected).reasons).toEqual([]);
    expect(assessReport(report([caseFromScore("agushi", "synonym", inReply, false)]), expected).reasons).toEqual([]);
    const forgedReply = { ...caseFromScore("agushi", "synonym", inReply, false), clarifyReply: "Do you want the shelled egusi?" };
    const forgedChoice = { ...caseFromScore("agushi", "synonym", asked, false), clarifyChoices: [LISTING_NAMES["paste-a"], "Melon seeds, any"] };
    const forgedOptions = { ...caseFromScore("agushi", "synonym", asked, false), clarifyOptions: ["paste-a"] };
    const priced = score([], "Which one would you like?\n- Egusi (melon seeds), shelled, $5.69\n- Egusi, ground", [search("name"), offer]);
    expect([priced.pass, priced.safetyFailures]).toEqual([true, []]);
    expect(assessReport(report([caseFromScore("agushi", "synonym", priced, false)]), expected).reasons).toEqual([]);
    for (const forged of [forgedReply, forgedChoice, forgedOptions]) {
      expect(assessReport(report([forged]), expected).reasons).toContain("cart does not match agushi");
    }
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
      reportText: JSON.stringify({ schemaVersion: 1, runs: [1, 2].map(() => ({ model: "claude-sonnet-5-5", schemaVersion: 1 })) }),
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
    expect(verdict.reasons).toContain("run 1: model");
    expect(verdict.reasons.join(" ")).toContain("run 2: fingerprint");
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
    expect(JSON.stringify(baseConfig.test?.projects)).toContain("src/**/*.test.ts");
    expect(JSON.stringify(baseConfig.test?.projects)).not.toContain("live.entry");
    spy.mockRestore();
    vi.unstubAllEnvs();
  }, 180_000);

});
