import "server-only";
import { createAnthropic } from "@ai-sdk/anthropic";

const HAIKU_MODEL_ID = "claude-haiku-5-5";
const SONNET_MODEL_ID = "claude-sonnet-5-5";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1";

export type AssistantModelId = typeof HAIKU_MODEL_ID | typeof SONNET_MODEL_ID;

export class AssistantConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantConfigError";
  }
}

export function assistantModelId(): AssistantModelId {
  const configured = process.env.ASSISTANT_MODEL;
  if (configured === undefined || configured === "") return HAIKU_MODEL_ID;
  if (configured === HAIKU_MODEL_ID || configured === SONNET_MODEL_ID) return configured;
  throw new AssistantConfigError(
    "ASSISTANT_MODEL must be claude-haiku-5-5 or claude-sonnet-5-5.",
  );
}

export function assistantProviderOptions(id: AssistantModelId): {
  anthropic:
    | { thinking: { type: "disabled" }; effort: "medium" }
    | { effort: "medium" };
} {
  if (id === HAIKU_MODEL_ID) {
    return {
      anthropic: {
        thinking: { type: "disabled" },
        effort: "medium",
      },
    };
  }
  return { anthropic: { effort: "medium" } };
}

export function createAssistantModel(opts?: { fetch?: typeof fetch }) {
  const id = assistantModelId();
  const apiKey = anthropicApiKey();
  const provider = createAnthropic({
    apiKey,
    baseURL: ANTHROPIC_MESSAGES_URL,
    ...(opts?.fetch ? { fetch: opts.fetch } : {}),
  });
  return provider(id);
}

function anthropicApiKey(): string {
  const configured = process.env.ANTHROPIC_API_KEY;
  if (configured === undefined || configured.trim() === "") {
    throw new AssistantConfigError("ANTHROPIC_API_KEY must be a non-empty string.");
  }
  return configured;
}
