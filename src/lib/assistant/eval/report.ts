import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "./canonical";
import { formatUsdFromMicros } from "./money";
import { PARTIAL_REPORT_PATH, REPORT_PATH, TICKET_SPEND_PATH } from "./dataset";
import type { Fingerprint } from "./fingerprint";
import type { CaseResult, EvalCategory, RunResult } from "./types";

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
    /** Part of micros from streams cut before their final usage, which the ledger and conversations never record. */
    droppedMicros: string;
    ledgerDeltaMicros: string | null;
    conversationMicros: string;
    inputTokens: number;
    outputTokens: number;
  };
  sessionUser: string;
  cases: CaseResult[];
}

/** The committed proof: two full runs, whose averaged rates meet the floors (owner, 2026-11-11). */
export interface OfficialEvalReport {
  schemaVersion: 1;
  runs: EvalReport[];
  average: AverageRates;
}

export interface AverageRates {
  microPrecision: number;
  microRecall: number;
  dishPassRate: number;
}

export function averageRates(runs: EvalReport[]): AverageRates {
  const mean = (pick: (summary: ReportSummary) => number) => runs.reduce((sum, run) => sum + pick(summarize(run.cases)), 0) / Math.max(runs.length, 1);
  return {
    microPrecision: mean((summary) => summary.microPrecision),
    microRecall: mean((summary) => summary.microRecall),
    dishPassRate: mean((summary) => summary.dishPassRate),
  };
}

export function officialReport(runs: EvalReport[]): OfficialEvalReport {
  return { schemaVersion: 1, runs, average: averageRates(runs) };
}

export interface CategoryBreakdown {
  cases: number;
  passed: number;
  passRate: number;
  gapReportingRate: number;
  quantityAccuracy: number;
  steps: number;
  stepLimitHits: number;
  toolInputErrors: number;
}

export interface ReportSummary {
  microPrecision: number;
  microRecall: number;
  precisionNumerator: number;
  precisionDenominator: number;
  recallNumerator: number;
  recallDenominator: number;
  hallucinatedItems: number;
  /** Made-up ids a tool refused before they reached the cart or a reply. Reported, not a floor. */
  rejectedAttempts: number;
  ungroundedAmountsShown: number;
  strippedAmounts: number;
  temporalViolations: number;
  safetyFailures: number;
  passRate: number;
  /** Dish-only cases are pass or fail and stay out of the micro precision and recall. */
  dishCases: number;
  dishPassed: number;
  dishPassRate: number;
  gapReportingRate: number;
  quantityAccuracy: number;
  steps: number;
  stepLimitHits: number;
  toolInputErrors: number;
  byCategory: Partial<Record<EvalCategory, CategoryBreakdown>>;
}

function rate(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return numerator / denominator;
}

function breakdown(items: CaseResult[]): CategoryBreakdown {
  let passed = 0;
  let gapCases = 0;
  let gapsReported = 0;
  let quantityChecks = 0;
  let quantityHits = 0;
  let steps = 0;
  let stepLimitHits = 0;
  let toolInputErrors = 0;
  for (const item of items) {
    if (item.pass) passed += 1;
    if (item.gapRequired) {
      gapCases += 1;
      if (item.gapsReported) gapsReported += 1;
    }
    quantityChecks += item.quantityChecks;
    quantityHits += item.quantityHits;
    steps += item.steps;
    if (item.stepLimitHit) stepLimitHits += 1;
    toolInputErrors += item.toolInputErrors;
  }
  return {
    cases: items.length,
    passed,
    passRate: rate(passed, items.length),
    gapReportingRate: rate(gapsReported, gapCases),
    quantityAccuracy: rate(quantityHits, quantityChecks),
    steps,
    stepLimitHits,
    toolInputErrors,
  };
}

export function summarize(cases: CaseResult[]): ReportSummary {
  let precisionNumerator = 0;
  let precisionDenominator = 0;
  let recallNumerator = 0;
  let recallDenominator = 0;
  let hallucinatedItems = 0;
  let rejectedAttempts = 0;
  let ungroundedAmountsShown = 0;
  let strippedAmounts = 0;
  let temporalViolations = 0;
  let safetyFailures = 0;
  const grouped = new Map<EvalCategory, CaseResult[]>();
  for (const item of cases) {
    precisionNumerator += item.precisionNumerator;
    precisionDenominator += item.precisionDenominator;
    recallNumerator += item.recallNumerator;
    recallDenominator += item.recallDenominator;
    hallucinatedItems += item.hallucinated.length;
    rejectedAttempts += Array.isArray(item.rejectedAttempts) ? item.rejectedAttempts.length : 0;
    ungroundedAmountsShown += item.ungroundedAmountsShown.length;
    strippedAmounts += item.strippedAmounts.length;
    temporalViolations += item.temporalViolations.length;
    safetyFailures += item.safetyFailures.length;
    const list = grouped.get(item.category) ?? [];
    list.push(item);
    grouped.set(item.category, list);
  }
  const overall = breakdown(cases);
  const dish = breakdown(cases.filter((item) => item.dish));
  const byCategory: ReportSummary["byCategory"] = {};
  for (const [category, items] of grouped) byCategory[category] = breakdown(items);
  return {
    microPrecision: precisionDenominator === 0 ? 1 : precisionNumerator / precisionDenominator,
    microRecall: recallDenominator === 0 ? 1 : recallNumerator / recallDenominator,
    precisionNumerator,
    precisionDenominator,
    recallNumerator,
    recallDenominator,
    hallucinatedItems,
    rejectedAttempts,
    ungroundedAmountsShown,
    strippedAmounts,
    temporalViolations,
    safetyFailures,
    passRate: overall.passRate,
    dishCases: dish.cases,
    dishPassed: dish.passed,
    dishPassRate: dish.passRate,
    gapReportingRate: overall.gapReportingRate,
    quantityAccuracy: overall.quantityAccuracy,
    steps: overall.steps,
    stepLimitHits: overall.stepLimitHits,
    toolInputErrors: overall.toolInputErrors,
    byCategory,
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
      droppedMicros: args.result.droppedMicros.toString(),
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
  report: EvalReport | OfficialEvalReport,
  full: boolean,
  cleanupError: string | null,
  paths: { committed?: string; partial?: string } = {},
): { committed: boolean; path: string } {
  const committedPath = paths.committed ?? REPORT_PATH;
  const partialPath = paths.partial ?? PARTIAL_REPORT_PATH;
  const runs = "runs" in report ? report.runs : [report];
  const publishable = full && runs.length > 0 && runs.every((run) => run.complete && run.incompleteReason == null) && !cleanupError;
  if (!publishable) {
    writeJsonAtomic(partialPath, report);
    return { committed: false, path: partialPath };
  }
  writeJsonAtomic(committedPath, report);
  return { committed: true, path: committedPath };
}

function readTicketSpendUnlocked(path: string): bigint {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { micros?: unknown };
    if (typeof parsed.micros === "string" && /^\d+$/.test(parsed.micros)) return BigInt(parsed.micros);
  } catch {
    return BigInt(0);
  }
  return BigInt(0);
}

function withTicketLock<T>(path: string, fn: () => T): T {
  const lock = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  const started = Date.now();
  let fd: number | null = null;
  while (fd == null) {
    try {
      fd = openSync(lock, "wx");
    } catch {
      if (Date.now() - started > 5_000) throw new Error("The eval ticket spend file is locked.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      // The next waiter only needs the file to be gone.
    }
  }
}

export function readTicketSpend(path = TICKET_SPEND_PATH): bigint {
  return withTicketLock(path, () => readTicketSpendUnlocked(path));
}

export function addTicketSpend(spent: bigint, path = TICKET_SPEND_PATH): bigint {
  const delta = spent < BigInt(0) ? BigInt(0) : spent;
  return withTicketLock(path, () => {
    const next = readTicketSpendUnlocked(path) + delta;
    writeJsonAtomic(path, { schemaVersion: 1, micros: next.toString(), usd: formatUsdFromMicros(next) });
    return next;
  });
}

/** Reserves headroom in the ticket file. False when the reserve would pass the cap. */
export function tryReserveTicket(reserve: bigint, cap: bigint, path = TICKET_SPEND_PATH): boolean {
  return withTicketLock(path, () => {
    const current = readTicketSpendUnlocked(path);
    if (current + reserve > cap) return false;
    const next = current + reserve;
    writeJsonAtomic(path, { schemaVersion: 1, micros: next.toString(), usd: formatUsdFromMicros(next) });
    return true;
  });
}

/** Moves the persisted ticket total by delta. A negative delta releases a reservation. */
export function adjustTicketSpend(delta: bigint, path = TICKET_SPEND_PATH): bigint {
  return withTicketLock(path, () => {
    const next = readTicketSpendUnlocked(path) + delta;
    if (next < BigInt(0)) throw new Error("The eval ticket spend would become negative.");
    writeJsonAtomic(path, { schemaVersion: 1, micros: next.toString(), usd: formatUsdFromMicros(next) });
    return next;
  });
}
