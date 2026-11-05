import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from "ai";

type ActionRow = { id: string; tool: string; input: unknown; output: unknown };

export function assistantMessageFromActions(actions: ActionRow[]): UIMessage {
  return {
    id: `replay-${actions[0]?.id ?? "empty"}`,
    role: "assistant",
    parts: actions
      .filter((action) => action.tool !== "grounding_strip")
      .map((action) => ({
        type: `tool-${action.tool}`,
        toolCallId: action.id,
        state: "output-available" as const,
        input: action.input,
        output: action.output,
      })),
  };
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
