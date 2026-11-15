import committedReport from "../assistant/eval/report.json";
import { assistantSpendState } from "../assistant/spend";
import { chatMonth } from "../billing/assistant-chats";
import { assistantChatCap, assistantChatWarnAt, effectivePlan, type Plan } from "../billing/plan";
import { listAssistantChatMonthRows, listAssistantSpendDays, type AssistantChatMonthRow } from "../db";

type Verdict = "haiku-ok" | "sonnet-candidate";

export type EvalRunView = {
  model: string;
  finishedAt: string;
  precision: number;
  recall: number;
  dishPassRate: number;
  dishPassed: number;
  dishCases: number;
  madeUpItems: number;
  verdict: Verdict;
  verdictReasons: string[];
  costMicros: bigint;
};

export type EvalView = {
  models: string[];
  finishedAt: string;
  average: { precision: number; recall: number; dishPassRate: number };
  runs: EvalRunView[];
  madeUpItems: number;
  verdict: Verdict;
  costMicros: bigint;
};

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function runView(raw: unknown): EvalRunView | null {
  if (!isRecord(raw) || !isRecord(raw.summary) || !isRecord(raw.spend)) return null;
  const { summary, spend } = raw;
  const micros = spend.micros;
  if (typeof raw.model !== "string" || typeof raw.finishedAt !== "string") return null;
  if (raw.verdict !== "haiku-ok" && raw.verdict !== "sonnet-candidate") return null;
  if (typeof micros !== "string" || !/^\d+$/.test(micros)) return null;
  const numbers = [summary.microPrecision, summary.microRecall, summary.dishPassRate, summary.dishPassed, summary.dishCases, summary.hallucinatedItems];
  if (!numbers.every(isNumber)) return null;
  const reasons = Array.isArray(raw.verdictReasons) ? raw.verdictReasons.filter((reason): reason is string => typeof reason === "string") : [];
  return {
    model: raw.model,
    finishedAt: raw.finishedAt,
    precision: summary.microPrecision as number,
    recall: summary.microRecall as number,
    dishPassRate: summary.dishPassRate as number,
    dishPassed: summary.dishPassed as number,
    dishCases: summary.dishCases as number,
    madeUpItems: summary.hallucinatedItems as number,
    verdict: raw.verdict,
    verdictReasons: reasons,
    costMicros: BigInt(micros),
  };
}

/** The committed #146 report as the admin reads it. Null when it is missing or not in the shape the eval writes. */
export function evalView(raw: unknown): EvalView | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !Array.isArray(raw.runs) || raw.runs.length === 0) return null;
  const average = raw.average;
  if (!isRecord(average) || ![average.microPrecision, average.microRecall, average.dishPassRate].every(isNumber)) return null;
  const runs = raw.runs.map(runView);
  if (runs.some((run) => run === null)) return null;
  const read = runs as EvalRunView[];
  return {
    models: [...new Set(read.map((run) => run.model))],
    finishedAt: read.map((run) => run.finishedAt).sort().at(-1)!,
    average: { precision: average.microPrecision as number, recall: average.microRecall as number, dishPassRate: average.dishPassRate as number },
    runs: read,
    madeUpItems: read.reduce((sum, run) => sum + run.madeUpItems, 0),
    verdict: read.every((run) => run.verdict === "haiku-ok") ? "haiku-ok" : "sonnet-candidate",
    costMicros: read.reduce((sum, run) => sum + run.costMicros, BigInt(0)),
  };
}

const MICROS_PER_CENT = BigInt(10_000);
const HALF_CENT = BigInt(5_000);

/** Micro-dollars to the cent, rounded half up; a spend under half a cent still shows as spend. */
export function formatAiUsd(micros: bigint): string {
  if (micros > BigInt(0) && micros < HALF_CENT) return "under $0.01";
  const cents = (micros + HALF_CENT) / MICROS_PER_CENT;
  const dollars = (cents / BigInt(100)).toLocaleString("en-US");
  return `$${dollars}.${(cents % BigInt(100)).toString().padStart(2, "0")}`;
}

export type StoreChatUsage = {
  storeId: string;
  storeName: string;
  plan: Plan;
  chats: number;
  cap: number;
  /** At or over 80% of the cap: the point the owner is emailed. */
  nearCap: boolean;
  atCap: boolean;
};

/** Each store against its own plan cap, fullest first. Cut to `limit` rows, never dropping a store at 80% or more. */
export function storeChatUsage(rows: AssistantChatMonthRow[], limit = 50): { stores: StoreChatUsage[]; hidden: number } {
  const all = rows
    .map((row): StoreChatUsage => {
      const plan = effectivePlan({ plan: row.subscriptionPlan ?? "starter", status: row.subscriptionStatus ?? "none", overridePlan: row.overridePlan });
      const cap = assistantChatCap(plan);
      return {
        storeId: row.storeId,
        storeName: row.storeName,
        plan,
        chats: row.chats,
        cap,
        nearCap: row.chats >= assistantChatWarnAt(plan),
        atCap: row.chats >= cap,
      };
    })
    .sort((a, b) => b.chats / b.cap - a.chats / a.cap || a.storeName.localeCompare(b.storeName));
  const shown = Math.max(limit, all.filter((store) => store.nearCap).length);
  return { stores: all.slice(0, shown), hidden: Math.max(all.length - shown, 0) };
}

export type SpendDay = { day: string; costMicros: bigint; capAlerted: boolean };

const SPEND_DAYS = 30;

/** Ledger rows for `at`'s UTC day and the 29 before it, newest first. Days with no spend have no row. */
export async function listSpendDays(at: Date): Promise<SpendDay[]> {
  const rows = await listAssistantSpendDays(at.toISOString().slice(0, 10), SPEND_DAYS);
  return rows.map((row) => ({ day: row.day.toISOString().slice(0, 10), costMicros: BigInt(row.cost), capAlerted: row.alerted }));
}

/** Every store's shopper-assistant chats in `at`'s UTC month, read as platform admin. */
export async function listChatMonth(at: Date): Promise<{ month: string; stores: StoreChatUsage[]; hidden: number }> {
  const month = chatMonth(at);
  const rows = await listAssistantChatMonthRows(month);
  return { month, ...storeChatUsage(rows) };
}

/** Everything the eval and spend page shows. Reads the committed report and the database only; never calls a model. */
export async function loadAiEvalSpend(
  at: Date = new Date(),
  env: { ASSISTANT_SPEND_CAP_USD?: string } = { ASSISTANT_SPEND_CAP_USD: process.env.ASSISTANT_SPEND_CAP_USD },
) {
  const [days, state, chats] = await Promise.all([listSpendDays(at), assistantSpendState(env), listChatMonth(at)]);
  return { eval: evalView(committedReport), spend: { days, ...state }, chats };
}
