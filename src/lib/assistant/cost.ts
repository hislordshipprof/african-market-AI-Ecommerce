import { AssistantConfigError } from "./errors";

/** Micro-dollars per million tokens: input, 5-minute cache write, cache hit, output. */
const PRICES: Record<string, { short: Rates; long?: Rates }> = {
  "claude-haiku-5-5": {
    short: rates(100_000, 125_000, 10_000, 500_000),
    long: rates(500_000, 625_000, 50_000, 2_500_000),
  },
  "claude-sonnet-5-5": {
    short: rates(2_000_000, 2_500_000, 100_000, 10_000_000),
  },
};

interface Rates {
  input: bigint;
  cacheWrite: bigint;
  cacheHit: bigint;
  output: bigint;
}

function rates(input: number, cacheWrite: number, cacheHit: number, output: number): Rates {
  return {
    input: BigInt(input),
    cacheWrite: BigInt(cacheWrite),
    cacheHit: BigInt(cacheHit),
    output: BigInt(output),
  };
}

export interface TokenUsage {
  inputTokens?: {
    total?: number;
    noCache?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  outputTokens?: { total?: number };
  /** The provider's own usage object; it carries the billed web searches. */
  raw?: unknown;
}

/** Web search is billed per search: $10 per 1,000. */
export const WEB_SEARCH_MICROS = BigInt(10_000);

/** Searches Anthropic billed, from its usage object. */
export function billedSearches(raw: unknown): number {
  const count = (raw as { server_tool_use?: { web_search_requests?: unknown } } | null | undefined)?.server_tool_use
    ?.web_search_requests;
  return typeof count === "number" && Number.isInteger(count) && count > 0 ? count : 0;
}

const MILLION = BigInt(1_000_000);
const LONG_PROMPT = BigInt(100_000);

export function callCostMicros(modelId: string, usage: TokenUsage): bigint {
  const table = PRICES[modelId];
  if (!table) {
    throw new AssistantConfigError(`No price for model ${modelId}`);
  }
  const input = usage.inputTokens ?? {};
  const cacheRead = count(input.cacheRead);
  const cacheWrite = count(input.cacheWrite);
  const total = input.total == null ? cacheRead + cacheWrite + count(input.noCache) : count(input.total);
  const noCache = input.noCache == null ? total - cacheRead - cacheWrite : count(input.noCache);
  const output = count(usage.outputTokens?.total);
  const tier = table.long && total > LONG_PROMPT ? table.long : table.short;
  const numerator =
    noCache * tier.input +
    cacheWrite * tier.cacheWrite +
    cacheRead * tier.cacheHit +
    output * tier.output;
  return (numerator + MILLION - BigInt(1)) / MILLION + WEB_SEARCH_MICROS * BigInt(billedSearches(usage.raw));
}

function count(value: number | undefined): bigint {
  if (value == null || !Number.isFinite(value) || value <= 0) return BigInt(0);
  return BigInt(Math.floor(value));
}

/** The AI SDK's step usage, or an already normalized one, as TokenUsage. Keeps raw for the search fee. */
export function tokenUsageOf(usage: unknown): TokenUsage {
  const value = (usage ?? {}) as {
    inputTokens?: number | TokenUsage["inputTokens"];
    outputTokens?: number | TokenUsage["outputTokens"];
    inputTokenDetails?: { noCacheTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
    raw?: unknown;
  };
  if (value.inputTokens && typeof value.inputTokens === "object") {
    const output = value.outputTokens;
    return {
      inputTokens: value.inputTokens,
      outputTokens: output && typeof output === "object" ? output : { total: typeof output === "number" ? output : 0 },
      raw: value.raw,
    };
  }
  const details = value.inputTokenDetails ?? {};
  return {
    inputTokens: {
      total: typeof value.inputTokens === "number" ? value.inputTokens : 0,
      noCache: details.noCacheTokens,
      cacheRead: details.cacheReadTokens,
      cacheWrite: details.cacheWriteTokens,
    },
    outputTokens: { total: typeof value.outputTokens === "number" ? value.outputTokens : 0 },
    raw: value.raw,
  };
}
