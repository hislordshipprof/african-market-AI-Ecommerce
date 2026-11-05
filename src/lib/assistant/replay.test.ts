import { describe, expect, it } from "vitest";
import { assistantMessageFromActions, replyStatus, stampAssistant } from "./replay";
import type { UIMessage } from "ai";

describe("assistant replay identity", () => {
  it("replays the provider tool-call id so undo matches the original receipt", () => {
    const message = assistantMessageFromActions([{
      id: "audit-row-123",
      tool: "add_to_cart",
      input: { _call: "original-provider-call", items: [] },
      output: { ok: true, items: [{ lineId: "line-1", added: 2, name: "Egusi" }] },
    }]);
    const part = message.parts[0];
    expect(part).toMatchObject({ toolCallId: "original-provider-call" });
  });

  it("does not treat a failed assistant record as a completed reply", () => {
    const failed = { id: "a", role: "assistant", parts: [{ type: "text", text: "" }] } as UIMessage;
    expect(replyStatus(failed)).toBeNull();
    expect(replyStatus(stampAssistant([failed], "failed")[0])).toBe("failed");
    expect(replyStatus(stampAssistant([failed], "complete")[0])).toBe("complete");
  });
});
