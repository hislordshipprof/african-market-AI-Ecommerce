import { describe, expect, it } from "vitest";
import { assistantMessageFromActions, replaceRecoveredTurn, replyStatus, stampAssistant } from "./replay";
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

  it("replaces the failed span and keeps a newer turn", () => {
    const synthetic = assistantMessageFromActions([{
      id: "audit-row-123",
      tool: "add_to_cart",
      input: { _call: "toolu_fake_0", items: [] },
      output: { ok: true, items: [{ ok: true, lineId: "line-1", added: 2, name: "Egusi" }] },
    }]);
    const failed = {
      id: "failed",
      role: "assistant" as const,
      parts: [{ type: "tool-add_to_cart" as const, toolCallId: "toolu_fake_0", state: "output-available" as const, input: {}, output: {} }],
    };
    const next = replaceRecoveredTurn([
      { id: "user-1", role: "user", parts: [{ type: "text", text: "add two" }] },
      failed,
      { id: "user-2", role: "user", parts: [{ type: "text", text: "something else" }] },
    ], "user-1", synthetic);
    expect(next?.map((message) => message.id)).toEqual(["user-1", synthetic.id, "user-2"]);
    const ids = next?.flatMap((message) => message.parts.flatMap((part) => "toolCallId" in part && part.toolCallId ? [part.toolCallId] : []));
    expect(ids).toEqual(["toolu_fake_0"]);
  });

  it("does not treat a failed assistant record as a completed reply", () => {
    const failed = { id: "a", role: "assistant", parts: [{ type: "text", text: "" }] } as UIMessage;
    expect(replyStatus(failed)).toBeNull();
    expect(replyStatus(stampAssistant([failed], "failed")[0])).toBe("failed");
    expect(replyStatus(stampAssistant([failed], "complete")[0])).toBe("complete");
  });
});
