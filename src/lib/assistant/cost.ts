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
  return (numerator + MILLION - BigInt(1)) / MILLION;
}

function count(value: number | undefined): bigint {
  if (value == null || !Number.isFinite(value) || value <= 0) return BigInt(0);
  return BigInt(Math.floor(value));
}
