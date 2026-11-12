import { readFileSync } from "node:fs";
import { ASSISTANT_STEP_CAP, createChatHandler } from "../chat-handler";
import { createAssistantModel, assistantModelId } from "../model";
import { createFakeAnthropicFetch } from "../messages-api-double";
import { DATASET_PATH, FIXTURE_PATH, REPORT_PATH, loadDataset, loadFixture, validateDataset, validateFixture } from "./dataset";
import { createEvalStores, deleteOwnedStores } from "./fixture-store";
import { changedFingerprintParts, fingerprintFromRequest, type Fingerprint } from "./fingerprint";
import { recordingFetch, type RecordedExchange } from "./recording-fetch";
import { summarize, type EvalReport } from "./report";
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
  if (!body.fingerprint || body.fingerprint.sha256 !== expected.fingerprint.sha256) {
    const changed = body.fingerprint ? changedFingerprintParts(body.fingerprint, expected.fingerprint) : ["fingerprint"];
    reasons.push(changed.length > 0 ? `fingerprint changed: ${changed.join(", ")}` : "fingerprint");
  }
  const cases = Array.isArray(body.cases) ? body.cases : [];
  const ids = cases.map((item) => item.id);
  if (ids.length !== expected.caseIds.length || ids.some((id, index) => id !== expected.caseIds[index])) {
    reasons.push("case ids");
  }
  if (new Set(ids).size !== ids.length) reasons.push("duplicate case ids");
  for (const item of cases) {
    if (!provenanceOk(item)) reasons.push(`missing request provenance for ${item.id}`);
    if (item.pass !== caseLooksPassing(item)) reasons.push(`forged pass flag on ${item.id}`);
  }
  const summary = summarize(cases);
  const claimed = body.summary;
  if (!claimed || claimed.precisionNumerator !== summary.precisionNumerator || claimed.precisionDenominator !== summary.precisionDenominator || claimed.recallNumerator !== summary.recallNumerator || claimed.recallDenominator !== summary.recallDenominator) {
    reasons.push("summary does not match the case counts");
  }
  if (summary.hallucinatedItems > 0) reasons.push("hallucinated items");
  if (summary.ungroundedAmountsShown > 0) reasons.push("ungrounded amounts shown");
  if (summary.safetyFailures > 0) reasons.push("safety failures");
  if (summary.precisionDenominator > 0 && summary.precisionNumerator / summary.precisionDenominator < 0.9) reasons.push("micro precision below 0.90");
  if (summary.recallDenominator > 0 && summary.recallNumerator / summary.recallDenominator < 0.85) reasons.push("micro recall below 0.85");
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function provenanceOk(item: CaseResult): boolean {
  if (!Array.isArray(item.requestProvenance) || item.requestProvenance.length === 0) return false;
  const seen = new Set<string>();
  for (const step of item.requestProvenance) {
    if (!REQUEST_ID.test(step.requestId)) return false;
    const key = `${step.attempt}:${step.turn}:${step.step}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return item.attempts >= 1;
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
