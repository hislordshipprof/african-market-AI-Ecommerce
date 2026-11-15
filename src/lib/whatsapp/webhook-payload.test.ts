import { describe, expect, it } from "vitest";
import { extractWebhook, whatsappWebhookSchema } from "./webhook-payload";

function payload(messages: unknown[]) {
  return whatsappWebhookSchema.parse({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "900111" }, messages } }] }],
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
});
