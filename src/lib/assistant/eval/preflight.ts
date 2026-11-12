import { assistantFakeAllowed, E2E_FAKE_ANTHROPIC_KEY } from "../contract";
import { assistantModelId } from "../model";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

export interface EffectivePgTarget {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

/**
 * Effective driver target, including query-string overrides, matching
 * pg-connection-string without reading SSL files.
 */
export function effectivePgTarget(connectionString: string): EffectivePgTarget {
  let dummyHost = false;
  let str = connectionString;
  if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(str)) {
    str = encodeURI(str).replace(/%25(\d\d)/g, "%$1");
  }
  let result: URL;
  try {
    result = new URL(str);
  } catch {
    result = new URL(str.replace("@/", "@___DUMMY___/"));
    dummyHost = true;
  }
  const config: Record<string, string> = {};
  for (const [key, value] of result.searchParams.entries()) config[key] = value;
  const user = config.user || decodeURIComponent(result.username);
  const password = config.password || decodeURIComponent(result.password);
  const hostname = (dummyHost ? "" : result.hostname).replace(/^\[(.+)\]$/, "$1");
  const host = config.host ? config.host : decodeURIComponent(hostname);
  const port = config.port || result.port;
  const database = decodeURIComponent(result.pathname.slice(1));
  return { host, port, user, password, database };
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/%$/, "");
  return LOOPBACK.has(normalized);
}

export type EvalEnv = Record<string, string | undefined>;

export function runtimeConnectionString(env: EvalEnv): string {
  const base = env.DATABASE_URL;
  if (!base) throw new Error("DATABASE_URL is missing.");
  const password = env.APP_RUNTIME_PASSWORD;
  if (!password) throw new Error("APP_RUNTIME_PASSWORD is missing.");
  const url = new URL(base);
  url.username = "app_runtime";
  url.password = password;
  return url.toString();
}

/** Null when the live eval may continue. Otherwise a refusal with no secrets. */
export function refuseLiveEval(env: EvalEnv): string | null {
  if (env.ASSISTANT_EVAL_LIVE !== "1") {
    return "Set ASSISTANT_EVAL_LIVE=1 to run the live shopper assistant eval.";
  }
  if (env.VERCEL) return "The live eval refuses to run on Vercel.";
  if (env.E2E_FAKE_ASSISTANT === "1" || assistantFakeAllowed(env as NodeJS.ProcessEnv)) {
    return "The live eval refuses a fake assistant or an active fake.";
  }
  const key = env.ANTHROPIC_API_KEY;
  if (typeof key !== "string" || key.trim() === "") return "ANTHROPIC_API_KEY is missing or blank.";
  if (key === E2E_FAKE_ANTHROPIC_KEY) return "The live eval refuses the fake Anthropic key.";
  try {
    const model = assistantModelId(env as NodeJS.ProcessEnv);
    if (model !== "claude-haiku-5-5") return "This eval runs only on claude-haiku-5-5.";
  } catch {
    return "ASSISTANT_MODEL is invalid.";
  }
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    return "BETTER_AUTH_SECRET is missing or shorter than 32 characters.";
  }
  if (!env.APP_RUNTIME_PASSWORD) return "APP_RUNTIME_PASSWORD is missing.";
  if (!env.DATABASE_URL) return "DATABASE_URL is missing.";
  let target: EffectivePgTarget;
  try {
    target = effectivePgTarget(runtimeConnectionString(env));
  } catch {
    return "DATABASE_URL could not be read as a driver configuration.";
  }
  if (!isLoopbackHost(target.host) || target.user !== "app_runtime" || !target.database) {
    return "The database connection is not the local app_runtime database.";
  }
  const budget = parseUsdMicros(env.ASSISTANT_EVAL_MAX_USD, BigInt(2000000));
  if (budget == null) return "ASSISTANT_EVAL_MAX_USD must be a positive finite USD amount.";
  const concurrency = parseConcurrency(env.ASSISTANT_EVAL_CONCURRENCY);
  if (concurrency == null) return "ASSISTANT_EVAL_CONCURRENCY must be an integer from 1 to 4.";
  return null;
}

export function liveBudgetMicros(env: EvalEnv): bigint {
  return parseUsdMicros(env.ASSISTANT_EVAL_MAX_USD, BigInt(2000000)) ?? BigInt(2000000);
}

export function liveConcurrency(env: EvalEnv): number {
  return parseConcurrency(env.ASSISTANT_EVAL_CONCURRENCY) ?? 2;
}

function parseUsdMicros(raw: string | undefined, fallback: bigint): bigint | null {
  if (raw == null || raw === "") return fallback;
  if (!/^\d+(\.\d{1,6})?$/.test(raw.trim())) return null;
  const [whole, frac = ""] = raw.trim().split(".");
  const micros = BigInt(whole) * BigInt(1000000) + BigInt((frac + "000000").slice(0, 6));
  if (micros <= BigInt(0)) return null;
  return micros;
}

function parseConcurrency(raw: string | undefined): number | null {
  if (raw == null || raw === "") return 2;
  if (!/^[1-4]$/.test(raw.trim())) return null;
  return Number(raw.trim());
}
