import { describe, expect, it } from "vitest";
import { createSendLock, outgoingMessage, settleSend } from "./send";

describe("assistant send", () => {
  it("the outgoing body is one scrubbed user message", () => {
    const sent = outgoingMessage({
      id: "turn-card",
      text: "  4242 4242 4242 4242 is my card  ",
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.body).toEqual({
      message: {
        id: "turn-card",
        role: "user",
        parts: [{ type: "text", text: "[card number removed] is my card" }],
      },
    });
    expect(JSON.stringify(sent.body)).not.toContain("4242");
    expect(outgoingMessage({ id: "a", text: "   " })).toEqual({ ok: false, reason: "empty" });
    expect(outgoingMessage({ id: "a", text: "a".repeat(2000) }).ok).toBe(true);
    expect(outgoingMessage({ id: "a", text: `${"a".repeat(1999)}\uFB01` })).toEqual({ ok: false, reason: "too_long" });
  });

  it("all send sources share an immediate lock and validate scrubbed wire text", () => {
    const lock = createSendLock();
    expect(lock.tryBegin()).toBe(true);
    expect(lock.tryBegin()).toBe(false);
    lock.end();
    expect(lock.tryBegin()).toBe(true);
    const dashed = outgoingMessage({ id: "card", text: "4242-4242-4242-4242" });
    expect(JSON.stringify(dashed)).not.toContain("4242");
  });

  it("settles one in-flight send from its generation and revision", () => {
    const flight = { generation: 1, revision: 4 };
    expect(settleSend({ outcome: "success", generation: 1, revision: 4, flight })).toEqual({ action: "revoke" });
    expect(settleSend({ outcome: "success", generation: 1, revision: 5, flight })).toEqual({ action: "revoke" });
    expect(settleSend({ outcome: "success", generation: 2, revision: 4, flight })).toEqual({ action: "ignore" });
    expect(settleSend({ outcome: "rejected", generation: 1, revision: 4, flight })).toEqual({ action: "restore" });
    expect(settleSend({ outcome: "rejected", generation: 1, revision: 5, flight })).toEqual({ action: "keep" });
    expect(settleSend({ outcome: "rejected", generation: 2, revision: 5, flight })).toEqual({ action: "ignore" });
    expect(settleSend({ outcome: "rejected", generation: 1, revision: 4, flight: null })).toEqual({ action: "ignore" });
  });
});
