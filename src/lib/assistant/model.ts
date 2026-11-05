import { createAnthropic } from "@ai-sdk/anthropic";
import { wrapLanguageModel, type LanguageModel } from "ai";
import { assistantFakeAllowed } from "./contract";
import { AssistantConfigError } from "./errors";
import { scriptedAssistantFetch } from "./fake-model";
import { spendMeteringMiddleware } from "./spend-middleware";

export { AssistantConfigError };

/** Messages API root. Pinned so ANTHROPIC_BASE_URL cannot redirect the key. */
export const ANTHROPIC_MESSAGES_BASE_URL = "https://api.anthropic.com/v1";

export type AssistantModelId = "claude-haiku-5-5" | "claude-sonnet-5-5";

const HAIKU: AssistantModelId = "claude-haiku-5-5";
const SONNET: AssistantModelId = "claude-sonnet-5-5";

/**
 * Reads ASSISTANT_MODEL on each call. Unset or "" is Haiku.
 * No trim and no case fold: a padded or differently cased value is a bad config.
 */
export function assistantModelId(
  env: NodeJS.ProcessEnv = process.env,
): AssistantModelId {
  const raw = env.ASSISTANT_MODEL;
  if (raw === undefined || raw === "") return HAIKU;
  if (raw === HAIKU || raw === SONNET) return raw;
  throw new AssistantConfigError(
    "ASSISTANT_MODEL must be one of: claude-haiku-5-5, claude-sonnet-5-5",
  );
}

/** Fresh objects on every call so a caller cannot mutate the next request. */
export function assistantProviderOptions(id: AssistantModelId): {
  anthropic: {
    thinking?: { type: "disabled" };
    effort: "medium";
  };
} {
  if (id === HAIKU) {
    return {
      anthropic: {
        thinking: { type: "disabled" },
        effort: "medium",
      },
    };
  }
  return { anthropic: { effort: "medium" } };
}

/**
 * Builds a model for one call. The key and model id are read here, never at import.
 * Pass `fetch` in tests. Production omits it and uses the global fetch.
 */
export function createAssistantModel(opts?: {
  fetch?: typeof fetch;
}): LanguageModel {
  const id = assistantModelId();
  const key = process.env.ANTHROPIC_API_KEY;
  if (typeof key !== "string" || key.trim() === "") {
    throw new AssistantConfigError(
      "ANTHROPIC_API_KEY is missing or blank. The shopper assistant cannot call the model.",
    );
  }
  const provider = createAnthropic({
    apiKey: key,
    baseURL: ANTHROPIC_MESSAGES_BASE_URL,
    fetch: opts?.fetch ?? (assistantFakeAllowed() ? scriptedAssistantFetch : undefined),
  });
  return wrapLanguageModel({
    model: provider(id),
    middleware: spendMeteringMiddleware(id),
  });
}
