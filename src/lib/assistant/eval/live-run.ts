import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ASSISTANT_STEP_CAP } from "../chat-handler";
import { assistantModelId } from "../model";
import { TICKET_SPEND_PATH, loadDataset, loadFixture, validateDataset, validateFixture } from "./dataset";
import { fingerprintFromRequest } from "./fingerprint";
import { assessReport } from "./gate";
import { liveBudgetMicros, liveConcurrency } from "./preflight";
import { buildReport, publishEvalReport, readTicketSpend, summarize, verdictFor } from "./report";
import { runEval } from "./runner";

// Owner raised the #146 eval budget to $20 on 2026-11-11 (issue #146).
const TICKET_CAP_MICROS = BigInt(20000000);

export async function runLiveEval(): Promise<void> {
  const startedAt = new Date().toISOString();
  const fixture = validateFixture(loadFixture());
  const dataset = validateDataset(loadDataset(), fixture, { full: true });
  const only = flag("--only");
  const limitRaw = flag("--limit");
  const limit = limitRaw == null ? null : Number(limitRaw);
  if (limit != null && (!Number.isInteger(limit) || limit < 1)) {
    console.error("ASSISTANT_EVAL --limit must be a positive integer.");
    process.exit(1);
  }
  const onlyIds = only?.split(",") ?? [];
  const selected = only ? dataset.filter((item) => onlyIds.includes(item.id) || onlyIds.includes(item.category)) : dataset;
  const cases = limit == null ? selected : selected.slice(0, limit);
  const full = !only && limit == null;
  if (cases.length === 0) {
    console.error("No eval cases matched.");
    process.exit(1);
  }
  const { assistantSpendState } = await import("../spend");
  const { assertRuntimeRole } = await import("./fixture-store");
  await assertRuntimeRole();
  const ledger = await assistantSpendState();
  if (ledger.resting) {
    console.error("The assistant spend ledger is resting. Reset the lane database before a live eval.");
    process.exit(1);
  }
  // Model comparison only: never published, and the gate still describes Haiku at its default effort.
  const compareDir = process.env.ASSISTANT_EVAL_COMPARE_DIR || null;
  const effort = process.env.ASSISTANT_EVAL_EFFORT || null;
  const turnMs: number[] = [];
  const prior = readTicketSpend();
  if (prior >= TICKET_CAP_MICROS) {
    console.error("This ticket has already spent its $20 eval budget.");
    process.exit(1);
  }
  const run = await runEval({
    cases,
    fixture,
    now: new Date(fixture.pinnedNow),
    concurrency: liveConcurrency(process.env),
    maxMicros: liveBudgetMicros(process.env),
    priorTicketMicros: prior,
    ticketCapMicros: TICKET_CAP_MICROS,
    full,
    fetchForAttempt: () => (effort ? withEffort(effort) : globalThis.fetch),
    onTurnMs: (ms) => turnMs.push(ms),
    ticketSpendPath: TICKET_SPEND_PATH,
  });
  const finishedAt = new Date().toISOString();
  const ticketTotal = readTicketSpend();
  const fingerprint = run.firstRequestBody
    ? fingerprintFromRequest(run.firstRequestBody, {
      dataset,
      fixture,
      masterCatalog: run.masterCatalog,
      stepCap: ASSISTANT_STEP_CAP,
    })
    : fingerprintFromRequest({}, { dataset, fixture, masterCatalog: run.masterCatalog, stepCap: ASSISTANT_STEP_CAP });
  const model = assistantModelId();
  const preview = buildReport({
    result: run.result,
    fingerprint,
    model,
    gitSha: gitSha(),
    startedAt,
    finishedAt,
    datasetCases: dataset.length,
    gateOk: false,
  });
  const gate = run.result.complete && full
    ? assessReport(preview, { fingerprint, caseIds: dataset.map((item) => item.id), model })
    : { ok: false, reasons: [run.result.incompleteReason ?? "partial run"] };
  const verdict = verdictFor(summarize(run.result.cases), gate.ok);
  const report = { ...preview, verdict: verdict.verdict, verdictReasons: verdict.reasons };
  const latency = { turns: turnMs.length, medianMs: percentile(turnMs, 0.5), p90Ms: percentile(turnMs, 0.9) };
  if (compareDir) {
    mkdirSync(compareDir, { recursive: true });
    const path = join(compareDir, `report-${model}-${effort ?? "default"}.json`);
    writeFileSync(path, `${JSON.stringify({ ...report, comparison: { model, effort: effort ?? "default", gateOk: gate.ok, latency } }, null, 2)}\n`);
    printRun(run.result.cases, preview.summary, verdict.verdict, verdict.reasons, run.result, ticketTotal, { committed: false, path }, latency);
    return;
  }
  const published = publishEvalReport(report, full && gate.ok, run.result.cleanupError);
  printRun(run.result.cases, preview.summary, verdict.verdict, verdict.reasons, run.result, ticketTotal, published, latency);
  if (!published.committed) process.exit(1);
}

function withEffort(effort: string): typeof fetch {
  return (input, init) => {
    if (typeof init?.body !== "string") return globalThis.fetch(input, init);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    body.output_config = { ...(body.output_config as object | undefined), effort };
    return globalThis.fetch(input, { ...init, body: JSON.stringify(body) });
  };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0);
}

function printRun(
  cases: Array<{ id: string; pass: boolean; reason: string; hallucinated: unknown[] }>,
  summary: ReturnType<typeof summarize>,
  verdict: string,
  reasons: string[],
  result: { spendMicros: bigint; inputTokens: number; outputTokens: number; ledgerDeltaMicros: bigint | null; conversationMicros: bigint; complete: boolean; incompleteReason: string | null },
  ticketTotal: bigint,
  published: { committed: boolean; path: string },
  latency: { turns: number; medianMs: number | null; p90Ms: number | null },
): void {
  for (const item of cases) {
    console.log(`${item.pass ? "PASS" : "FAIL"} ${item.id} ${item.reason}`);
    for (const hallucinated of item.hallucinated) console.log(`  hallucinated ${JSON.stringify(hallucinated)}`);
  }
  console.log(JSON.stringify({
    complete: result.complete,
    incompleteReason: result.incompleteReason,
    summary,
    verdict,
    reasons,
    spendMicros: result.spendMicros.toString(),
    ledgerDeltaMicros: result.ledgerDeltaMicros?.toString() ?? null,
    conversationMicros: result.conversationMicros.toString(),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    ticketMicros: ticketTotal.toString(),
    latency,
    report: published.path,
    committed: published.committed,
  }, null, 2));
}

// vitest rejects unknown CLI flags, so ASSISTANT_EVAL_ONLY / ASSISTANT_EVAL_LIMIT carry them too.
function flag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1] ?? null;
  return process.env[`ASSISTANT_EVAL_${name.slice(2).toUpperCase()}`] || null;
}

function gitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
