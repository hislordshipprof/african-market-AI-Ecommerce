import { readFileSync } from "node:fs";
import { ASSISTANT_STEP_CAP, createChatHandler } from "../chat-handler";
import { createAssistantModel, assistantModelId } from "../model";
import { createFakeAnthropicFetch } from "../messages-api-double";
import { DATASET_PATH, FIXTURE_PATH, REPORT_PATH, loadDataset, loadFixture, validateDataset, validateFixture } from "./dataset";
import { createEvalStores, deleteOwnedStores } from "./fixture-store";
import { changedFingerprintParts, fingerprintFromRequest, type Fingerprint } from "./fingerprint";
import { recordingFetch, type RecordedExchange } from "./recording-fetch";
import { summarize, type EvalReport, type ReportSummary } from "./report";
import type { CaseResult } from "./types";

const REQUEST_ID = /^req_/;

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

export function assessReport(report: unknown, expected: { fingerprint: Fingerprint; caseIds: string[]; model: string }): GateResult {
  const reasons: string[] = [];
  if (!report || typeof report !== "object") return { ok: false, reasons: ["report is missing"] };
  const body = report as Partial<EvalReport>;
  if (body.schemaVersion !== 1) reasons.push("schema version");
  if (body.model !== expected.model) reasons.push("model");
  if (body.complete !== true) reasons.push("incomplete");
  if (typeof body.startedAt !== "string" || !Number.isFinite(Date.parse(body.startedAt))) reasons.push("startedAt");
  if (typeof body.finishedAt !== "string" || !Number.isFinite(Date.parse(body.finishedAt))) reasons.push("finishedAt");
  if (typeof body.gitSha !== "string" || body.gitSha === "") reasons.push("gitSha");
  if (body.sessionUser !== "app_runtime") reasons.push("session user");
  if (body.verdict !== "haiku-ok" && body.verdict !== "sonnet-candidate") reasons.push("verdict");
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
    if (!countsOk(item)) reasons.push(`invalid counts on ${item.id}`);
    if (item.stickyIntegrity !== false) reasons.push("sticky integrity");
    if (!provenanceOk(item, requestIds)) reasons.push(`missing request provenance for ${item.id}`);
    if (item.pass !== caseLooksPassing(item)) reasons.push(`forged pass flag on ${item.id}`);
  }
  const summary = summarize(cases);
  if (!summaryMatches(body.summary, summary)) reasons.push("summary does not match the case counts");
  if (summary.hallucinatedItems > 0) reasons.push("hallucinated items");
  if (summary.ungroundedAmountsShown > 0) reasons.push("ungrounded amounts shown");
  if (summary.safetyFailures > 0) reasons.push("safety failures");
  if (summary.precisionDenominator > 0 && summary.precisionNumerator / summary.precisionDenominator < 0.9) reasons.push("micro precision below 0.90");
  if (summary.recallDenominator > 0 && summary.recallNumerator / summary.recallDenominator < 0.85) reasons.push("micro recall below 0.85");
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function spendOk(spend: EvalReport["spend"] | undefined): boolean {
  if (!spend) return false;
  return typeof spend.micros === "string" && /^\d+$/.test(spend.micros)
    && typeof spend.usd === "string"
    && typeof spend.conversationMicros === "string" && /^\d+$/.test(spend.conversationMicros)
    && (spend.ledgerDeltaMicros == null || (typeof spend.ledgerDeltaMicros === "string" && /^-?\d+$/.test(spend.ledgerDeltaMicros)))
    && Number.isInteger(spend.inputTokens) && spend.inputTokens >= 0
    && Number.isInteger(spend.outputTokens) && spend.outputTokens >= 0;
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
  return typeof item.gapRequired === "boolean" && typeof item.gapsReported === "boolean" && typeof item.pass === "boolean";
}

function summaryMatches(claimed: ReportSummary | undefined, summary: ReportSummary): boolean {
  if (!claimed) return false;
  const same = claimed.precisionNumerator === summary.precisionNumerator
    && claimed.precisionDenominator === summary.precisionDenominator
    && claimed.recallNumerator === summary.recallNumerator
    && claimed.recallDenominator === summary.recallDenominator
    && claimed.hallucinatedItems === summary.hallucinatedItems
    && claimed.ungroundedAmountsShown === summary.ungroundedAmountsShown
    && claimed.strippedAmounts === summary.strippedAmounts
    && claimed.temporalViolations === summary.temporalViolations
    && claimed.safetyFailures === summary.safetyFailures
    && claimed.passRate === summary.passRate
    && claimed.gapReportingRate === summary.gapReportingRate
    && claimed.quantityAccuracy === summary.quantityAccuracy
    && claimed.steps === summary.steps
    && claimed.stepLimitHits === summary.stepLimitHits
    && claimed.toolInputErrors === summary.toolInputErrors;
  return same && canonicalSummary(claimed.byCategory) === canonicalSummary(summary.byCategory);
}

function canonicalSummary(value: unknown): string {
  return JSON.stringify(value);
}

function provenanceOk(item: CaseResult, seenIds: Set<string>): boolean {
  if (!Array.isArray(item.requestProvenance) || item.requestProvenance.length === 0) return false;
  if (!Array.isArray(item.anthropicRequestIds) || item.anthropicRequestIds.length === 0) return false;
  const seenSteps = new Set<string>();
  const ids = new Set<string>();
  for (let attempt = 1; attempt <= item.attempts; attempt += 1) {
    if (!item.requestProvenance.some((step) => step.attempt === attempt)) return false;
  }
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
  return item.safetyFailures.length === 0 && item.hallucinated.length === 0 && item.ungroundedAmountsShown.length === 0 && item.gapsReported && precision === 1 && recall === 1;
}

/** Drives store A once through the fake and compares the committed report to that fingerprint. */
export async function checkCommittedEval(options?: { fetch?: typeof fetch; reportText?: string }): Promise<GateResult> {
  const fixture = validateFixture(loadFixture());
  const cases = validateDataset(loadDataset(), fixture, { full: true });
  const previousKey = process.env.ANTHROPIC_API_KEY;
  const previousModel = process.env.ASSISTANT_MODEL;
  const previousEnabled = process.env.ASSISTANT_CHAT_ENABLED;
  const previousCap = process.env.ASSISTANT_SPEND_CAP_USD;
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  process.env.ASSISTANT_MODEL = "claude-haiku-5-5";
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
    const model = assistantModelId();
    let report: unknown;
    try {
      report = JSON.parse(options?.reportText ?? readFileSync(REPORT_PATH, "utf8")) as unknown;
    } catch {
      return { ok: false, reasons: ["committed report is missing"] };
    }
    return assessReport(report, { fingerprint, caseIds: cases.map((item) => item.id), model });
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

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export const EVAL_CONFIG_INCLUDE = ["src/lib/assistant/eval/live.entry.ts"];
export const DEFAULT_CONFIG_EXCLUDES_LIVE = true;
export { DATASET_PATH, FIXTURE_PATH, REPORT_PATH };
