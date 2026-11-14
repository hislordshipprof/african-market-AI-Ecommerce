import { readFileSync } from "node:fs";
import { ASSISTANT_STEP_CAP, createChatHandler } from "../chat-handler";
import { createAssistantModel, assistantModelId } from "../model";
import { createFakeAnthropicFetch } from "../messages-api-double";
import { canonicalJson } from "./canonical";
import { DATASET_PATH, FIXTURE_PATH, REPORT_PATH, loadDataset, loadFixture, validateDataset, validateFixture } from "./dataset";
import { createEvalStores, deleteOwnedStores } from "./fixture-store";
import { changedFingerprintParts, fingerprintFromRequest, type Fingerprint } from "./fingerprint";
import { formatUsdFromMicros } from "./money";
import { recordingFetch, type RecordedExchange } from "./recording-fetch";
import { averageRates, summarize, type EvalReport, type OfficialEvalReport, type ReportSummary } from "./report";
import { bindingFromFixture, dishCartMisses, scoreCase, type CatalogBinding } from "./score";
import type { CaseResult, EvalCase } from "./types";

const REQUEST_ID = /^req_/;

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

interface Expected {
  fingerprint: Fingerprint;
  caseIds: string[];
  model: string;
  cases?: EvalCase[];
  binding?: CatalogBinding;
}

const OFFICIAL_RUNS = 2;

/** Each run must be sound and safe on its own; the rate floors apply to the average of the two runs. */
export function assessOfficial(report: unknown, expected: Expected): GateResult {
  if (!report || typeof report !== "object") return { ok: false, reasons: ["report is missing"] };
  const body = report as Partial<OfficialEvalReport>;
  const reasons: string[] = [];
  if (body.schemaVersion !== 1) reasons.push("schema version");
  if (!Array.isArray(body.runs) || body.runs.length !== OFFICIAL_RUNS) return { ok: false, reasons: [...reasons, "two runs"] };
  const runs = body.runs;
  runs.forEach((run, index) => {
    for (const reason of assessReport(run, expected, { floors: false }).reasons) reasons.push(`run ${index + 1}: ${reason}`);
  });
  if (reasons.length > 0) return { ok: false, reasons };
  const ids = runs.flatMap((run) => run.cases.flatMap((item) => item.anthropicRequestIds));
  if (new Set(ids).size !== ids.length) reasons.push("runs reuse request ids");
  const average = averageRates(runs);
  if (canonicalJson(body.average) !== canonicalJson(average)) reasons.push("average does not match the runs");
  const summaries = runs.map((run) => summarize(run.cases));
  if (summaries.some((summary) => summary.precisionDenominator > 0) && average.microPrecision < 0.9) reasons.push("micro precision below 0.90");
  if (summaries.some((summary) => summary.recallDenominator > 0) && average.microRecall < 0.85) reasons.push("micro recall below 0.85");
  if (summaries.some((summary) => summary.dishCases > 0) && average.dishPassRate < 0.85) reasons.push("dish pass rate below 0.85");
  return { ok: reasons.length === 0, reasons };
}

export function assessReport(report: unknown, expected: Expected, options: { floors?: boolean } = {}): GateResult {
  const reasons: string[] = [];
  if (!report || typeof report !== "object") return { ok: false, reasons: ["report is missing"] };
  const body = report as Partial<EvalReport>;
  if (body.schemaVersion !== 1) reasons.push("schema version");
  if (body.model !== expected.model) reasons.push("model");
  if (body.complete !== true) reasons.push("incomplete");
  if (body.complete === true && body.incompleteReason != null) reasons.push("incomplete reason");
  if (typeof body.startedAt !== "string" || !Number.isFinite(Date.parse(body.startedAt))) reasons.push("startedAt");
  if (typeof body.finishedAt !== "string" || !Number.isFinite(Date.parse(body.finishedAt))) reasons.push("finishedAt");
  if (typeof body.startedAt === "string" && typeof body.finishedAt === "string") {
    const started = Date.parse(body.startedAt);
    const finished = Date.parse(body.finishedAt);
    if (Number.isFinite(started) && Number.isFinite(finished) && finished < started) reasons.push("finished before start");
  }
  if (typeof body.gitSha !== "string" || body.gitSha === "") reasons.push("gitSha");
  if (body.sessionUser !== "app_runtime") reasons.push("session user");
  if (body.verdict !== "haiku-ok" && body.verdict !== "sonnet-candidate") reasons.push("verdict");
  if (body.verdict === "haiku-ok" && (!Array.isArray(body.verdictReasons) || body.verdictReasons.length > 0)) reasons.push("verdict reasons");
  if (body.verdict === "sonnet-candidate" && (!Array.isArray(body.verdictReasons) || body.verdictReasons.length === 0)) reasons.push("verdict reasons");
  if (body.datasetCases !== expected.caseIds.length) reasons.push("dataset cases");
  if (!spendOk(body.spend)) reasons.push("spend");
  if (!body.fingerprint || body.fingerprint.sha256 !== expected.fingerprint.sha256) {
    const changed = body.fingerprint ? changedFingerprintParts(body.fingerprint, expected.fingerprint) : ["fingerprint"];
    reasons.push(changed.length > 0 ? `fingerprint changed: ${changed.join(", ")}` : "fingerprint");
  }
  const cases = Array.isArray(body.cases) ? body.cases : [];
  const ids = cases.map((item) => item?.id);
  if (ids.length !== expected.caseIds.length || ids.some((id, index) => id !== expected.caseIds[index])) {
    reasons.push("case ids");
  }
  if (new Set(ids).size !== ids.length) reasons.push("duplicate case ids");
  const requestIds = new Set<string>();
  for (const item of cases) {
    if (!item || typeof item !== "object") {
      reasons.push("invalid case");
      continue;
    }
    if (item.completed !== true) reasons.push(`incomplete case ${item.id}`);
    if (!countsOk(item)) reasons.push(`invalid counts on ${item.id}`);
    if (item.stickyIntegrity !== false) reasons.push("sticky integrity");
    if (!provenanceOk(item, requestIds)) reasons.push(`missing request provenance for ${item.id}`);
    if (item.pass !== caseLooksPassing(item)) reasons.push(`forged pass flag on ${item.id}`);
    if (expected.cases) cartAgrees(item, expected.cases, expected.binding, reasons);
  }
  if (!spendReconciles(body.spend, cases)) reasons.push("spend");
  const summary = summarize(cases);
  if (!summaryMatches(body.summary, summary)) reasons.push("summary does not match the case counts");
  if (summary.hallucinatedItems > 0) reasons.push("hallucinated items");
  if (summary.ungroundedAmountsShown > 0) reasons.push("ungrounded amounts shown");
  if (summary.safetyFailures > 0) reasons.push("safety failures");
  if (options.floors !== false) {
    if (summary.precisionDenominator > 0 && summary.precisionNumerator / summary.precisionDenominator < 0.9) reasons.push("micro precision below 0.90");
    if (summary.recallDenominator > 0 && summary.recallNumerator / summary.recallDenominator < 0.85) reasons.push("micro recall below 0.85");
    if (summary.dishCases > 0 && summary.dishPassed / summary.dishCases < 0.85) reasons.push("dish pass rate below 0.85");
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function spendReconciles(spend: EvalReport["spend"] | undefined, cases: CaseResult[]): boolean {
  if (!spendOk(spend)) return false;
  let sum = BigInt(0);
  for (const item of cases) {
    if (typeof item?.costMicros !== "string" || !/^\d+$/.test(item.costMicros)) return false;
    sum += BigInt(item.costMicros);
  }
  const dropped = BigInt(spend?.droppedMicros ?? "0");
  if (dropped > BigInt(0) && !cases.some((item) => nonNegativeInt(item?.droppedAttempts) && item.droppedAttempts > 0)) return false;
  const recorded = (sum - dropped).toString();
  return spend?.micros === sum.toString()
    && spend.conversationMicros === recorded
    && (spend.ledgerDeltaMicros == null || spend.ledgerDeltaMicros === recorded)
    && spend.usd === formatUsdFromMicros(sum);
}

function cartAgrees(item: CaseResult, cases: EvalCase[], binding: CatalogBinding | undefined, reasons: string[]): void {
  const spec = cases.find((candidate) => candidate.id === item.id);
  if (!spec) {
    reasons.push(`unknown case ${item.id}`);
    return;
  }
  if (!Array.isArray(item.finalCart)) {
    reasons.push(`cart does not match ${item.id}`);
    return;
  }
  if (item.category !== spec.category) reasons.push(`category ${item.id}`);
  if (item.gapRequired !== (spec.gaps.length > 0)) reasons.push(`gap flag ${item.id}`);
  if (item.dish !== (spec.dish != null)) reasons.push(`dish flag ${item.id}`);
  // The re-score trusts savedNeeds, so it is accepted only where the request states a need: a constraint case or one with excluded items.
  if (item.savedNeeds === true && spec.category !== "constraint" && (spec.excluded ?? []).length === 0) reasons.push(`saved needs ${item.id}`);
  if (item.pass) {
    for (let turn = 1; turn <= spec.turns.length; turn += 1) {
      if (!item.requestProvenance.some((step) => step.attempt === item.attempts && step.turn === turn)) {
        reasons.push(`missing turn provenance for ${item.id}`);
      }
    }
  }
  const scored = scoreCase({
    evalCase: spec,
    cart: item.finalCart,
    tools: [],
    savedTexts: typeof item.clarifyReply === "string" ? [{ turn: spec.turns.length, text: item.clarifyReply, priorOutputs: [], saved: true }] : [],
    observedTexts: [],
    strippedAmounts: [],
    successfulWriteTurns: [],
    returnedLineIds: [],
    cartLineIds: [],
    stepLimitHit: item.stepLimitHit,
    clarify: { options: item.clarifyOptions, choices: item.clarifyChoices },
    savedNeeds: item.savedNeeds,
  }, binding ?? bareBinding(), []);
  if (scored.precisionNumerator !== item.precisionNumerator
    || scored.precisionDenominator !== item.precisionDenominator
    || scored.recallNumerator !== item.recallNumerator
    || scored.recallDenominator !== item.recallDenominator
    || scored.clarifyReply !== item.clarifyReply
    || canonicalJson(scored.clarifyOptions) !== canonicalJson(item.clarifyOptions)
    || canonicalJson(scored.clarifyChoices) !== canonicalJson(item.clarifyChoices)
    // This re-score has no tool results to ground an amount the clarify reply quoted; the run's own amount checks cover it.
    || scored.safetyFailures.some((failure) => failure !== "ungrounded-amount" && !item.safetyFailures.includes(failure))
    || !sameCartMisses(dishCartMisses(spec, item.finalCart), item.dishMisses)) {
    reasons.push(`cart does not match ${item.id}`);
  }
  const quantityChecks = spec.qty?.length ?? 0;
  const quantityHits = (spec.qty ?? []).filter((rule) => item.finalCart.some((line) => line.key === rule.listingKey && line.variantKey === rule.variantKey && line.qty >= rule.min && line.qty <= rule.max)).length;
  if (item.quantityChecks !== quantityChecks || item.quantityHits !== quantityHits) reasons.push(`quantity counts ${item.id}`);
}

function sameCartMisses(expected: string[], claimed: unknown): boolean {
  if (!Array.isArray(claimed)) return false;
  const cartMisses: string[] = claimed = claimed.filter((miss): miss is string => typeof miss === "string" && miss.startsWith("missing "));
  return canonicalJson([...expected].sort()) === canonicalJson([...cartMisses].sort());
}

function bareBinding(): CatalogBinding {
  return {
    byListingKey: new Map(),
    byVariantKey: new Map(),
    byListingId: new Map(),
    byVariantId: new Map(),
    aListingIds: new Set(),
    aVariantIds: new Set(),
    bListingIds: new Set(),
    bVariantIds: new Set(),
    minimumOrderCents: 0,
  };
}

function spendOk(spend: EvalReport["spend"] | undefined): boolean {
  if (!spend) return false;
  return typeof spend.micros === "string" && /^\d+$/.test(spend.micros)
    && typeof spend.usd === "string"
    && typeof spend.droppedMicros === "string" && /^\d+$/.test(spend.droppedMicros)
    && typeof spend.conversationMicros === "string" && /^\d+$/.test(spend.conversationMicros)
    && (spend.ledgerDeltaMicros == null || (typeof spend.ledgerDeltaMicros === "string" && /^-?\d+$/.test(spend.ledgerDeltaMicros)))
    && Number.isInteger(spend.inputTokens) && spend.inputTokens >= 0
    && Number.isInteger(spend.outputTokens) && spend.outputTokens >= 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function nonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function countsOk(item: CaseResult): boolean {
  if (!nonNegativeInt(item.precisionNumerator) || !nonNegativeInt(item.precisionDenominator)) return false;
  if (!nonNegativeInt(item.recallNumerator) || !nonNegativeInt(item.recallDenominator)) return false;
  if (item.precisionNumerator > item.precisionDenominator || item.recallNumerator > item.recallDenominator) return false;
  if (!nonNegativeInt(item.attempts) || item.attempts < 1) return false;
  if (!nonNegativeInt(item.steps) || !nonNegativeInt(item.toolInputErrors)) return false;
  if (!nonNegativeInt(item.quantityChecks) || !nonNegativeInt(item.quantityHits) || item.quantityHits > item.quantityChecks) return false;
  if (typeof item.dish !== "boolean" || !Array.isArray(item.dishMisses) || item.dishMisses.some((miss) => typeof miss !== "string")) return false;
  if (item.dish && (item.precisionDenominator !== 0 || item.recallDenominator !== 0)) return false;
  if (item.clarifyReply !== null && typeof item.clarifyReply !== "string") return false;
  if (!stringArray(item.clarifyOptions) || !stringArray(item.clarifyChoices)) return false;
  if (typeof item.savedNeeds !== "boolean") return false;
  if (!rejectedAttemptsOk(item)) return false;
  if (!nonNegativeInt(item.droppedAttempts) || item.droppedAttempts >= item.attempts) return false;
  return typeof item.gapRequired === "boolean" && typeof item.gapsReported === "boolean" && typeof item.pass === "boolean";
}

const REJECTED_FIELDS = new Set(["listing_id", "listing_ids", "variant_id", "backup_variant_id", "substitute_variant_id", "line_id"]);

/** A rejected attempt must be a refused tool input that is not cross-store and never reached the cart or the clarify reply. */
function rejectedAttemptsOk(item: CaseResult): boolean {
  if (!Array.isArray(item.rejectedAttempts) || !Array.isArray(item.hallucinated) || !Array.isArray(item.finalCart)) return false;
  return item.rejectedAttempts.every((attempt) => !!attempt && typeof attempt === "object"
    && typeof attempt.tool === "string" && attempt.tool !== "cart"
    && typeof attempt.field === "string" && REJECTED_FIELDS.has(attempt.field)
    && typeof attempt.id === "string" && attempt.id !== ""
    && attempt.crossStore === false
    && !item.finalCart.some((line) => line?.variantKey === attempt.id || line?.substituteVariantKey === attempt.id)
    && !(typeof item.clarifyReply === "string" && item.clarifyReply.includes(attempt.id))
    && !item.hallucinated.some((found) => found?.id === attempt.id));
}

function summaryMatches(claimed: ReportSummary | undefined, summary: ReportSummary): boolean {
  if (!claimed) return false;
  const same = claimed.precisionNumerator === summary.precisionNumerator
    && claimed.precisionDenominator === summary.precisionDenominator
    && claimed.recallNumerator === summary.recallNumerator
    && claimed.recallDenominator === summary.recallDenominator
    && claimed.hallucinatedItems === summary.hallucinatedItems
    && claimed.rejectedAttempts === summary.rejectedAttempts
    && claimed.ungroundedAmountsShown === summary.ungroundedAmountsShown
    && claimed.strippedAmounts === summary.strippedAmounts
    && claimed.temporalViolations === summary.temporalViolations
    && claimed.safetyFailures === summary.safetyFailures
    && claimed.passRate === summary.passRate
    && claimed.dishCases === summary.dishCases
    && claimed.dishPassed === summary.dishPassed
    && claimed.dishPassRate === summary.dishPassRate
    && claimed.gapReportingRate === summary.gapReportingRate
    && claimed.quantityAccuracy === summary.quantityAccuracy
    && claimed.steps === summary.steps
    && claimed.stepLimitHits === summary.stepLimitHits
    && claimed.toolInputErrors === summary.toolInputErrors
    && claimed.microPrecision === summary.microPrecision
    && claimed.microRecall === summary.microRecall;
  return same && canonicalJson(claimed.byCategory) === canonicalJson(summary.byCategory);
}

function provenanceOk(item: CaseResult, seenIds: Set<string>): boolean {
  if (!Array.isArray(item.requestProvenance) || item.requestProvenance.length === 0) return false;
  if (!Array.isArray(item.anthropicRequestIds) || item.anthropicRequestIds.length === 0) return false;
  const seenSteps = new Set<string>();
  const ids = new Set<string>();
  // Only a dropped attempt may lack provenance: its connection can close before any request id. The last attempt never may.
  let unproven = 0;
  for (let attempt = 1; attempt <= item.attempts; attempt += 1) {
    if (item.requestProvenance.some((step) => step.attempt === attempt)) continue;
    if (attempt === item.attempts) return false;
    unproven += 1;
  }
  if (unproven > (nonNegativeInt(item.droppedAttempts) ? item.droppedAttempts : 0)) return false;
  for (const step of item.requestProvenance) {
    if (!REQUEST_ID.test(step.requestId)) return false;
    if (!nonNegativeInt(step.attempt) || !nonNegativeInt(step.turn) || !nonNegativeInt(step.step)) return false;
    if (step.turn < 1 || step.step < 1) return false;
    const key = `${step.attempt}:${step.turn}:${step.step}`;
    if (seenSteps.has(key) || seenIds.has(step.requestId)) return false;
    seenSteps.add(key);
    seenIds.add(step.requestId);
    ids.add(step.requestId);
  }
  return item.anthropicRequestIds.length === ids.size && item.anthropicRequestIds.every((id) => ids.has(id));
}

function caseLooksPassing(item: CaseResult): boolean {
  const precision = item.precisionDenominator === 0 ? 1 : item.precisionNumerator / item.precisionDenominator;
  const recall = item.recallDenominator === 0 ? 1 : item.recallNumerator / item.recallDenominator;
  return item.safetyFailures.length === 0 && item.hallucinated.length === 0 && item.ungroundedAmountsShown.length === 0 && item.gapsReported && precision === 1 && recall === 1 && Array.isArray(item.dishMisses) && item.dishMisses.length === 0;
}

/** Drives store A once through the fake and compares both committed runs to that fingerprint. */
export async function checkCommittedEval(options?: { fetch?: typeof fetch; reportText?: string }): Promise<GateResult> {
  const fixture = validateFixture(loadFixture());
  const cases = validateDataset(loadDataset(), fixture, { full: true });
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousModel = process.env.ASSISTANT_MODEL;
  const previousEnabled = process.env.ASSISTANT_CHAT_ENABLED;
  const previousCap = process.env.ASSISTANT_SPEND_CAP_USD;
  const defaultModel = assistantModelId(envWithoutModelOverride());
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ASSISTANT_MODEL = defaultModel;
  process.env.ASSISTANT_CHAT_ENABLED = "1";
  process.env.ASSISTANT_SPEND_CAP_USD = "1000000";
  const exchanges: RecordedExchange[] = [];
  const fake = options?.fetch ?? createFakeAnthropicFetch({
    expectedKey: "sk-ant-test",
    steps: [{ kind: "text", text: "Golden eval fingerprint probe." }],
  }).fetch;
  let stores: Awaited<ReturnType<typeof createEvalStores>> | null = null;
  try {
    stores = await createEvalStores(fixture);
    const handler = createChatHandler({
      model: createAssistantModel({ fetch: recordingFetch(fake, exchanges) }),
      now: () => new Date(fixture.pinnedNow),
    });
    const response = await handler(new Request("http://golden-eval.test/api/assistant/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "golden-eval.test",
        origin: "http://golden-eval.test",
        "x-store-slug": stores.slugA,
        "x-forwarded-for": `2001:db8:${stores.runId.slice(0, 4)}:probe`,
      },
      body: JSON.stringify({
        message: { id: "eprobe0001", role: "user", parts: [{ type: "text", text: "fingerprint" }] },
      }),
    }));
    await response.text();
    await Promise.all(exchanges.map((exchange) => exchange.done));
    const body = exchanges.find((exchange) => exchange.requestBody)?.requestBody;
    if (!body) return { ok: false, reasons: ["fingerprint probe sent no request"] };
    const fingerprint = fingerprintFromRequest(body, {
      dataset: cases,
      fixture,
      masterCatalog: stores.masterCatalog,
      stepCap: ASSISTANT_STEP_CAP,
    });
    const model = defaultModel;
    let report: unknown;
    try {
      report = JSON.parse(options?.reportText ?? readFileSync(REPORT_PATH, "utf8")) as unknown;
    } catch {
      return { ok: false, reasons: ["committed report is missing"] };
    }
    return assessOfficial(report, {
      fingerprint,
      caseIds: cases.map((item) => item.id),
      model,
      cases,
      binding: bindingFromFixture(fixture, stores.ids, stores.masterCatalog),
    });
  } catch (error) {
    return { ok: false, reasons: [error instanceof Error ? error.message : "fingerprint probe failed"] };
  } finally {
    if (stores) await deleteOwnedStores(stores).catch(() => {});
    restore("ANTHROPIC_API_KEY", previousKey);
    restore("ASSISTANT_MODEL", previousModel);
    restore("ASSISTANT_CHAT_ENABLED", previousEnabled);
    restore("ASSISTANT_SPEND_CAP_USD", previousCap);
  }
}

function envWithoutModelOverride(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ASSISTANT_MODEL;
  return env;
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export const EVAL_CONFIG_INCLUDE = ["src/lib/assistant/eval/live.entry.ts"];
export const DEFAULT_CONFIG_EXCLUDES_LIVE = true;
export { DATASET_PATH, FIXTURE_PATH, REPORT_PATH };
