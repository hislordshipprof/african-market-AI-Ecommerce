import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";

type ActionRow = { id: string; tool: string; input: unknown; output: unknown };

export function durableCallId(action: { id: string; input: unknown }): string {
  const input = action.input;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const call = (input as { _call?: unknown })._call;
    if (typeof call === "string" && call.length > 0) return call;
  }
  return action.id;
}

export function assistantMessageFromActions(actions: ActionRow[]): UIMessage {
  return {
    id: `replay-${actions[0]?.id ?? "empty"}`,
    role: "assistant",
    metadata: { status: "complete" },
    parts: actions
      .filter((action) => action.tool !== "grounding_strip")
      .map((action) => ({
        type: `tool-${action.tool}`,
        toolCallId: durableCallId(action),
        state: "output-available" as const,
        input: action.input,
        output: action.output,
      })),
  };
}

export function replyStatus(message: UIMessage): "complete" | "failed" | null {
  const meta = message.metadata;
  if (!meta || typeof meta !== "object") return null;
  const status = (meta as { status?: unknown }).status;
  return status === "complete" || status === "failed" ? status : null;
}

export function stampAssistant(messages: UIMessage[], status: "complete" | "failed"): UIMessage[] {
  let stamped = false;
  const out = [...messages];
  for (let index = out.length - 1; index >= 0; index -= 1) {
    if (out[index].role !== "assistant" || stamped) continue;
    out[index] = {
      ...out[index],
      metadata: { ...(out[index].metadata ?? {}), status },
    };
    stamped = true;
  }
  return out;
}

export function replayAssistantMessage(message: UIMessage, headers?: Headers): Response {
  const stream = createUIMessageStream({
    execute: ({ writer }) => {
      writer.write({ type: "start", messageId: message.id });
      writer.write({ type: "start-step" });
      for (const part of message.parts) {
        if (part.type === "text") {
          writer.write({ type: "text-start", id: "replay-text" });
          writer.write({ type: "text-delta", id: "replay-text", delta: part.text });
          writer.write({ type: "text-end", id: "replay-text" });
          continue;
        }
        if (typeof part.type === "string" && part.type.startsWith("tool-") && "toolCallId" in part) {
          const toolName = part.type.slice("tool-".length);
          writer.write({
            type: "tool-input-available",
            toolCallId: part.toolCallId,
            toolName,
            input: "input" in part ? part.input : {},
          });
          if ("output" in part) {
            writer.write({
              type: "tool-output-available",
              toolCallId: part.toolCallId,
              output: part.output,
            });
          }
        }
      }
      writer.write({ type: "finish-step" });
      writer.write({ type: "finish", finishReason: "stop" });
    },
  });
  return createUIMessageStreamResponse({ stream, headers });
}
