import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import {
  acknowledgeUndo,
  commitUndoLabel,
  noteAcceptedSend,
  partsForRetry,
  resetAssistantSessions,
  retainSession,
  retryOffer,
  settleAttempt,
  undoLabelsForChat,
  visibleRetry,
} from "./chat-session";

const store = { storeId: "store-a", accountId: null as string | null, cartId: "cart-a", loading: false };

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

describe("retained assistant session", () => {
  beforeEach(() => {
    resetAssistantSessions();
  });

  it("an Undone label from one cart never marks the same addition id in another cart", () => {
    const cartA = retainSession(store);
    commitUndoLabel(cartA, "toolu_same:0", "undone");
    const otherStore = retainSession({ storeId: "store-b", accountId: null, cartId: "cart-a", loading: false });
    expect(undoLabelsForChat(otherStore)).toEqual({});
    expect(undoLabelsForChat(cartA)).toEqual({ "toolu_same:0": "undone" });

    const cartB = retainSession({ ...store, cartId: "cart-b" });
    expect(cartB).not.toBe(cartA);
    expect(undoLabelsForChat(cartB)).toEqual({});
    commitUndoLabel(cartA, "toolu_same:0", "undone");
    expect(undoLabelsForChat(cartB)).toEqual({});
    expect(visibleRetry(cartB)).toBeNull();
  });

  it("pending Undo acknowledgements stay with their originating retained session", async () => {
    const guest = retainSession({ ...store, cartId: null, loading: true });
    const adoptedCart = retainSession({ ...store, cartId: "cart-a", loading: false });
    expect(adoptedCart).toBe(guest);
    let releaseUndone: () => void = () => {};
    let releaseRemoved: () => void = () => {};
    const undoneGate = new Promise<void>((resolve) => {
      releaseUndone = resolve;
    });
    const removedGate = new Promise<void>((resolve) => {
      releaseRemoved = resolve;
    });
    const undone = undoneGate.then(() => acknowledgeUndo(
      guest,
      "toolu_a:0",
      { status: "confirmed", qty: 0, removed: true },
      "failed",
    ));
    const removed = removedGate.then(() => acknowledgeUndo(
      guest,
      "toolu_b:1",
      { status: "already_removed" },
      "ok",
    ));
    releaseRemoved();
    await removed;
    releaseUndone();
    await undone;
    expect(undoLabelsForChat(guest)).toEqual({ "toolu_b:1": "already_removed", "toolu_a:0": "undone" });

    const signingIn = retainSession({ ...store, accountId: "user-1", cartId: null, loading: true });
    expect(signingIn).toBe(guest);
    const claimed = retainSession({ ...store, accountId: "user-1", cartId: "cart-a", loading: false });
    expect(claimed).toBe(guest);
    expect(undoLabelsForChat(claimed)).toEqual({ "toolu_b:1": "already_removed", "toolu_a:0": "undone" });

    let releaseLate: () => void = () => {};
    const lateGate = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const late = lateGate.then(() => {
      acknowledgeUndo(guest, "toolu_c:2", { status: "confirmed", qty: 1, removed: false }, "ok");
      commitUndoLabel(guest, "toolu_same:0", "undone");
    });
    const replacement = retainSession({ ...store, accountId: "user-2", cartId: "cart-b", loading: false });
    resetAssistantSessions();
    const fresh = retainSession({ ...store, accountId: "user-2", cartId: "cart-b", loading: false });
    releaseLate();
    await late;
    expect(undoLabelsForChat(replacement)).toEqual({});
    expect(undoLabelsForChat(fresh)).toEqual({});
    expect(undoLabelsForChat(guest)).toEqual({});
  });

  it("Retry follows keep and adopt and cannot return after reset or a newer customer send", () => {
    const early = retainSession({ ...store, cartId: null, loading: true });
    const seq = noteAcceptedSend(early, { messageId: "m1", text: "yam", hasFiles: false });
    early.messages = [user("m1", "yam")];
    expect(visibleRetry(early)).toBeNull();
    settleAttempt(early, seq, "retryable");
    expect(visibleRetry(early)).toEqual({ messageId: "m1", text: "yam" });

    const withCart = retainSession({ ...store, loading: false });
    expect(withCart).toBe(early);
    const signingIn = retainSession({ ...store, accountId: "user-1", cartId: null, loading: true });
    expect(signingIn).toBe(early);
    const adopted = retainSession({ ...store, accountId: "user-1", cartId: "cart-a", loading: false });
    expect(adopted).toBe(early);
    expect(visibleRetry(adopted)).toEqual({ messageId: "m1", text: "yam" });

    const otherStore = retainSession({ storeId: "store-b", accountId: "user-1", cartId: "cart-a", loading: false });
    expect(visibleRetry(otherStore)).toBeNull();
    expect(visibleRetry(adopted)).toEqual({ messageId: "m1", text: "yam" });

    const stale = noteAcceptedSend(adopted, { messageId: "m-stale", text: "old", hasFiles: false });
    const newer = noteAcceptedSend(adopted, { messageId: "m2", text: "rice", hasFiles: false });
    adopted.messages = [user("m1", "yam"), user("m-stale", "old"), user("m2", "rice")];
    settleAttempt(adopted, stale, "retryable");
    expect(visibleRetry(adopted)).toBeNull();
    settleAttempt(adopted, newer, "success");
    expect(visibleRetry(adopted)).toBeNull();

    const failed = noteAcceptedSend(adopted, { messageId: "m3", text: "beans", hasFiles: false });
    const busy = noteAcceptedSend(adopted, { messageId: "m3", text: "beans", hasFiles: false });
    adopted.messages = [...adopted.messages, user("m3", "beans")];
    settleAttempt(adopted, failed, "success");
    settleAttempt(adopted, busy, "retryable");
    expect(visibleRetry(adopted)).toEqual({ messageId: "m3", text: "beans" });

    const terminal = noteAcceptedSend(adopted, { messageId: "m4", text: "nope", hasFiles: false });
    adopted.messages = [...adopted.messages, user("m4", "nope")];
    settleAttempt(adopted, terminal, "disqualified");
    expect(visibleRetry(adopted)).toBeNull();

    const files = noteAcceptedSend(adopted, { messageId: "m5", text: "list", hasFiles: true });
    adopted.messages = [...adopted.messages, user("m5", "list")];
    settleAttempt(adopted, files, "retryable");
    expect(visibleRetry(adopted)).toBeNull();

    const missing = noteAcceptedSend(adopted, { messageId: "missing", text: "gone", hasFiles: false });
    settleAttempt(adopted, missing, "retryable");
    expect(visibleRetry(adopted)).toBeNull();
    const assistantId = noteAcceptedSend(adopted, { messageId: "assistant-1", text: "no", hasFiles: false });
    adopted.messages = [...adopted.messages, { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "no" }] }];
    settleAttempt(adopted, assistantId, "retryable");
    expect(visibleRetry(adopted)).toBeNull();

    const older = noteAcceptedSend(adopted, { messageId: "m1", text: "yam", hasFiles: false });
    settleAttempt(adopted, older, "retryable");
    expect(visibleRetry(adopted)).toBeNull();

    const open = noteAcceptedSend(adopted, { messageId: "m9", text: "plantain", hasFiles: false });
    adopted.messages = [...adopted.messages, user("m9", "plantain")];
    const reset = retainSession({ ...store, accountId: "user-1", cartId: "cart-z", loading: false });
    expect(visibleRetry(reset)).toBeNull();
    settleAttempt(adopted, open, "retryable");
    commitUndoLabel(adopted, "toolu_same:0", "undone");
    expect(visibleRetry(reset)).toBeNull();
    expect(undoLabelsForChat(reset)).toEqual({});
  });

  it("an in-band error keeps the original text retry and does not take composer files", async () => {
    const events = [
      { type: "start", messageId: "asst-1" },
      { type: "start-step" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "partial" },
      { type: "error", errorText: "Overloaded" },
      { type: "finish-step" },
      { type: "finish", finishReason: "error" },
    ];
    const sse = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
    vi.stubGlobal("fetch", async () => new Response(sse, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    try {
      const chat = retainSession({ ...store, storeId: "store-inband" });
      noteAcceptedSend(chat, { messageId: "m-err", text: "mid-stream", hasFiles: false });
      chat.messages = [user("m-err", "mid-stream")];
      await chat.sendMessage({
        messageId: "m-err",
        role: "user",
        parts: [{ type: "text", text: "mid-stream" }],
      }).catch(() => undefined);
      expect(chat.status).toBe("error");
      expect(visibleRetry(chat)).toEqual({ messageId: "m-err", text: "mid-stream" });
      const offer = retryOffer(chat, {
        routeCode: "unknown",
        terminal: false,
        openFileFlight: null,
      });
      expect(offer).toEqual({ kind: "text", messageId: "m-err", text: "mid-stream" });
      if (offer?.kind !== "text") throw new Error("expected a text retry");
      expect(partsForRetry(offer, [{ type: "file" }])).toEqual([{ type: "text", text: "mid-stream" }]);
      expect(retryOffer(chat, {
        routeCode: "attachment_rate_limited",
        terminal: false,
        openFileFlight: { messageId: "file-1", text: "the list" },
      })).toEqual({ kind: "files", messageId: "file-1", text: "the list" });
      expect(retryOffer(chat, {
        routeCode: "rate_limited",
        terminal: false,
        openFileFlight: { messageId: "file-1", text: "the list" },
      })).toBeNull();
      expect(retryOffer(chat, {
        routeCode: "assistant_unavailable",
        terminal: true,
        openFileFlight: { messageId: "file-1", text: "the list" },
      })).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
