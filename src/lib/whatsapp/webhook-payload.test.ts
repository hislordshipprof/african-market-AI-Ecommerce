import { describe, expect, it } from "vitest";
import { extractWebhook, whatsappWebhookSchema } from "./webhook-payload";

function payload(messages: unknown[], statuses?: unknown[]) {
  return whatsappWebhookSchema.parse({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "900111" }, messages, statuses } }] }],
  });
}

describe("extractWebhook", () => {
  it("reads the send time Meta stamps on a message, in seconds", () => {
    const [first] = extractWebhook(payload([
      { from: "15551234567", id: "wamid.a", timestamp: "1763164800", type: "text", text: { body: "rice" } },
    ])).messages;
    expect(first.message.timestamp).toBe(1763164800);
  });

  it("a missing or non-numeric timestamp is null, never a guess", () => {
    const { messages } = extractWebhook(payload([
      { from: "15551234567", id: "wamid.a", type: "text", text: { body: "rice" } },
      { from: "15551234567", id: "wamid.b", timestamp: "soon", type: "text", text: { body: "rice" } },
    ]));
    expect(messages.map((entry) => entry.message.timestamp)).toEqual([null, null]);
  });

  it("a tapped list row or reply button gives the row or button id", () => {
    const { messages } = extractWebhook(payload([
      {
        from: "15551234567",
        id: "wamid.list",
        timestamp: "1763164800",
        type: "interactive",
        interactive: { type: "list_reply", list_reply: { id: "Garri (2 kg)", title: "Garri", description: "2 kg · $5.99" } },
      },
      {
        from: "15551234567",
        id: "wamid.button",
        timestamp: "1763164800",
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "Yam (1 tuber)", title: "Yam" } },
      },
    ]));
    expect(messages.map((entry) => [entry.message.type, entry.message.replyId, entry.message.text])).toEqual([
      ["interactive", "Garri (2 kg)", null],
      ["interactive", "Yam (1 tuber)", null],
    ]);
  });

  it("a text message has no reply id", () => {
    const [first] = extractWebhook(payload([
      { from: "15551234567", id: "wamid.a", timestamp: "1763164800", type: "text", text: { body: "rice" } },
    ])).messages;
    expect(first.message.replyId).toBeNull();
  });

  it("a status shaped differently from Meta's docs never drops a message in the same payload (F13)", () => {
    const { messages, failedStatusCodes } = extractWebhook(payload(
      [{ from: "15551234567", id: "wamid.a", timestamp: "1763164800", type: "text", text: { body: "rice" } }],
      [
        { id: "wamid.s1", status: "failed", errors: [{ code: "131047" }] },
        { id: "wamid.s2", status: 3 },
        { id: "wamid.s3", status: "failed", errors: [{ code: 131026 }] },
      ],
    ));
    expect(messages.map((entry) => entry.message.id)).toEqual(["wamid.a"]);
    expect(failedStatusCodes).toEqual([131026]);
  });

  it("a numeric timestamp or an odd text field does not drop a message with a usable id, sender and type (F14)", () => {
    const { messages, unreadable } = extractWebhook(payload([
      { from: "15551234567", id: "wamid.a", timestamp: 1763164800, type: "text", text: { body: "rice" } },
      { from: "15551234567", id: "wamid.b", timestamp: "1763164800", type: "text", text: { body: 7 } },
    ]));
    expect(messages.map((entry) => [entry.message.id, entry.message.timestamp, entry.message.text])).toEqual([
      ["wamid.a", 1763164800, "rice"],
      ["wamid.b", 1763164800, null],
    ]);
    expect(unreadable).toEqual([]);
  });

  it("an unreadable message reports its key names only, never its values (F15)", () => {
    const { messages, unreadable } = extractWebhook(payload([
      { from: "15551234567", type: "text", text: { body: "my secret" } },
      { from: "15551234567", id: "wamid.ok", type: "text", text: { body: "rice" } },
      "not an object",
    ]));
    expect(messages.map((entry) => entry.message.id)).toEqual(["wamid.ok"]);
    expect(unreadable).toEqual([["from", "text", "type"], []]);
    expect(JSON.stringify(unreadable)).not.toContain("secret");
  });

  it("a message id Postgres cannot store (NUL byte) is unreadable, not a handler failure (F5)", () => {
    const { messages, unreadable } = extractWebhook(payload([
      { from: "15551234567", id: "wamid.\u0000x", type: "text", text: { body: "rice" } },
    ]));
    expect(messages).toEqual([]);
    expect(unreadable).toEqual([["from", "id", "text", "type"]]);
  });

  it("marks a message sent in a group chat (F16)", () => {
    const { messages } = extractWebhook(payload([
      { from: "15551234567", id: "wamid.g", type: "text", text: { body: "hi" }, group_id: "120363000000000000" },
      { from: "15551234567", id: "wamid.d", type: "text", text: { body: "hi" } },
    ]));
    expect(messages.map((entry) => entry.message.inGroup)).toEqual([true, false]);
  });
});
