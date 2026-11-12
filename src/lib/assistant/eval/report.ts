import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "./canonical";
import { formatUsdFromMicros } from "./money";
import { PARTIAL_REPORT_PATH, REPORT_PATH, TICKET_SPEND_PATH } from "./dataset";
import type { Fingerprint } from "./fingerprint";
import type { CaseResult, RunResult } from "./types";

export interface EvalReport {
  schemaVersion: 1;
  fingerprint: Fingerprint;
  model: string;
  gitSha: string;
  startedAt: string;
  finishedAt: string;
  datasetCases: number;
  complete: boolean;
  incompleteReason: string | null;
  summary: ReportSummary;
  verdict: "haiku-ok" | "sonnet-candidate";
  verdictReasons: string[];
  spend: {
    micros: string;
    usd: string;
    ledgerDeltaMicros: string | null;
    conversationMicros: string;
    inputTokens: number;
    outputTokens: number;
  };
  sessionUser: string;
  cases: CaseResult[];
}

export interface ReportSummary {
  microPrecision: number;
  microRecall: number;
  precisionNumerator: number;
  precisionDenominator: number;
  recallNumerator: number;
  recallDenominator: number;
  hallucinatedItems: number;
  ungroundedAmountsShown: number;
  strippedAmounts: number;
  temporalViolations: number;
  safetyFailures: number;
}

export function summarize(cases: CaseResult[]): ReportSummary {
  let precisionNumerator = 0;
  let precisionDenominator = 0;
  let recallNumerator = 0;
  let recallDenominator = 0;
  let hallucinatedItems = 0;
  let ungroundedAmountsShown = 0;
  let strippedAmounts = 0;
  let temporalViolations = 0;
  let safetyFailures = 0;
  for (const item of cases) {
    precisionNumerator += item.precisionNumerator;
    precisionDenominator += item.precisionDenominator;
    recallNumerator += item.recallNumerator;
    recallDenominator += item.recallDenominator;
    hallucinatedItems += item.hallucinated.length;
    ungroundedAmountsShown += item.ungroundedAmountsShown.length;
    strippedAmounts += item.strippedAmounts.length;
    temporalViolations += item.temporalViolations.length;
    safetyFailures += item.safetyFailures.length;
  }
  return {
    microPrecision: precisionDenominator === 0 ? 1 : precisionNumerator / precisionDenominator,
    microRecall: recallDenominator === 0 ? 1 : recallNumerator / recallDenominator,
    precisionNumerator,
    precisionDenominator,
    recallNumerator,
    recallDenominator,
    hallucinatedItems,
    ungroundedAmountsShown,
    strippedAmounts,
    temporalViolations,
    safetyFailures,
  };
}

export function verdictFor(summary: ReportSummary, gateOk: boolean): { verdict: EvalReport["verdict"]; reasons: string[] } {
  const reasons: string[] = [];
  if (!gateOk) reasons.push("customer-visible gate failed");
  if (summary.strippedAmounts > 0) reasons.push("the model stated amounts the grounder removed");
  if (summary.temporalViolations > 0) reasons.push("the model stated amounts that were not yet allowed");
  if (reasons.length === 0) return { verdict: "haiku-ok", reasons: [] };
  return { verdict: "sonnet-candidate", reasons };
}

export function buildReport(args: {
  result: RunResult;
  fingerprint: Fingerprint;
  model: string;
  gitSha: string;
  startedAt: string;
  finishedAt: string;
  datasetCases: number;
  gateOk: boolean;
}): EvalReport {
  const summary = summarize(args.result.cases);
  const verdict = verdictFor(summary, args.gateOk);
  return {
    schemaVersion: 1,
    fingerprint: args.fingerprint,
    model: args.model,
    gitSha: args.gitSha,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    datasetCases: args.datasetCases,
    complete: args.result.complete,
    incompleteReason: args.result.incompleteReason,
    summary,
    verdict: verdict.verdict,
    verdictReasons: verdict.reasons,
    spend: {
      micros: args.result.spendMicros.toString(),
      usd: formatUsdFromMicros(args.result.spendMicros),
      ledgerDeltaMicros: args.result.ledgerDeltaMicros?.toString() ?? null,
      conversationMicros: args.result.conversationMicros.toString(),
      inputTokens: args.result.inputTokens,
      outputTokens: args.result.outputTokens,
    },
    sessionUser: args.result.sessionUser,
    cases: args.result.cases,
  };
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${canonicalJson(value)}\n`);
  renameSync(tmp, path);
}

/** A full complete run with a clean teardown replaces the committed report. Anything else leaves it untouched. */
export function publishEvalReport(
  report: EvalReport,
  full: boolean,
  cleanupError: string | null,
  paths: { committed?: string; partial?: string } = {},
): { committed: boolean; path: string } {
  const committedPath = paths.committed ?? REPORT_PATH;
  const partialPath = paths.partial ?? PARTIAL_REPORT_PATH;
  const publishable = full && report.complete && !cleanupError && report.incompleteReason == null;
  if (!publishable) {
    writeJsonAtomic(partialPath, report);
    return { committed: false, path: partialPath };
  }
  writeJsonAtomic(committedPath, report);
  return { committed: true, path: committedPath };
}

export function readTicketSpend(path = TICKET_SPEND_PATH): bigint {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { micros?: unknown };
    if (typeof parsed.micros === "string" && /^\d+$/.test(parsed.micros)) return BigInt(parsed.micros);
  } catch {
    return BigInt(0);
  }
  return BigInt(0);
}

export function addTicketSpend(spent: bigint, path = TICKET_SPEND_PATH): bigint {
  const next = readTicketSpend(path) + (spent < BigInt(0) ? BigInt(0) : spent);
  writeJsonAtomic(path, { schemaVersion: 1, micros: next.toString(), usd: formatUsdFromMicros(next) });
  return next;
}
