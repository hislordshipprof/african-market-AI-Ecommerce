import type { LanguageModelMiddleware } from "ai";
import { callCostMicros, type TokenUsage } from "./cost";

export function spendMeteringMiddleware(modelId: string): LanguageModelMiddleware {
  return {
    specificationVersion: "v4",
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      await recordCall(modelId, result.usage);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      let usage: TokenUsage | null = null;
      return {
        ...rest,
        stream: stream.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              if (chunk?.type === "finish") usage = chunk.usage as TokenUsage;
              controller.enqueue(chunk);
            },
            async flush() {
              if (!usage) return;
              await recordCall(modelId, usage);
            },
          }),
        ),
      };
    },
  };
}

async function recordCall(modelId: string, usage: TokenUsage | undefined) {
  if (!usage) return;
  let micros: bigint;
  try {
    micros = callCostMicros(modelId, usage);
  } catch (error) {
    console.error("[assistant] spend not recorded", { modelId, error });
    return;
  }
  if (micros === BigInt(0)) return;
  if (!process.env.DATABASE_URL) {
    console.error("[assistant] spend not recorded", { modelId, micros: micros.toString() });
    return;
  }
  const { recordSpend } = await import("./spend");
  try {
    await recordSpend(micros, new Date());
  } catch (first) {
    try {
      await recordSpend(micros, new Date());
    } catch {
      console.error("[assistant] spend not recorded", {
        modelId,
        micros: micros.toString(),
        error: first,
      });
    }
  }
}
