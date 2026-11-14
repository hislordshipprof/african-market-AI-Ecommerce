import { beforeEach, describe, expect, it } from "vitest";
import { WhatsAppApiError } from "./errors";
import { fakeWhatsAppProvider, getFakeOutbox, noteInbound, resetFake } from "./fake";
import { ownerLinkCodeMessage } from "./templates";

const TO = "14045550123";

async function rejectionCode(promise: Promise<unknown>): Promise<number | null> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(WhatsAppApiError);
  return (error as WhatsAppApiError).code;
}

describe("fake WhatsApp provider", () => {
  beforeEach(() => resetFake());

  it("records text, interactive and template sends, and rejects free text outside the 24-hour window, more than three buttons, and an unknown template", async () => {
    // No inbound message yet: only a template may open the conversation.
    expect(await rejectionCode(fakeWhatsAppProvider.send({ type: "text", to: TO, body: "hello" }))).toBe(131047);
    noteInbound(TO, Date.now() - 25 * 60 * 60 * 1000);
    expect(await rejectionCode(fakeWhatsAppProvider.send({ type: "text", to: TO, body: "hello" }))).toBe(131047);
    expect(await rejectionCode(fakeWhatsAppProvider.send({
      type: "template", to: TO, name: "order_update", language: "en_US",
    }))).toBe(132001);
    expect(await rejectionCode(fakeWhatsAppProvider.send(
      ownerLinkCodeMessage(TO, "1234567890123456"),
    ))).toBe(132000);
    expect(getFakeOutbox()).toHaveLength(0);

    await fakeWhatsAppProvider.send(ownerLinkCodeMessage(`+${TO}`, "482913"));
    noteInbound(TO);
    await fakeWhatsAppProvider.send({ type: "text", to: TO, body: "hello" });
    await fakeWhatsAppProvider.send({
      type: "interactive",
      to: TO,
      body: "Accept the order?",
      buttons: [{ id: "accept", title: "Accept" }, { id: "decline", title: "Decline" }],
    });
    await fakeWhatsAppProvider.send({ type: "media", to: TO, mediaType: "image", link: "https://example.com/a.jpg" });

    expect(await rejectionCode(fakeWhatsAppProvider.send({
      type: "interactive",
      to: TO,
      body: "Pick one",
      buttons: ["a", "b", "c", "d"].map((id) => ({ id, title: id })),
    }))).toBe(131009);

    const outbox = getFakeOutbox();
    expect(outbox.map((entry) => entry.message.type)).toEqual(["template", "text", "interactive", "media"]);
    expect(outbox[0].result.waId).toBe(TO);
    expect(new Set(outbox.map((entry) => entry.result.messageId)).size).toBe(4);
  });
});
