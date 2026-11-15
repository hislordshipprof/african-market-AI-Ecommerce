import { beforeEach, describe, expect, it } from "vitest";
import { WhatsAppApiError } from "./errors";
import { fakeWhatsAppProvider, getFakeOutbox, noteInbound, resetFake, revokeFakeTemplate } from "./fake";
import { ORDER_UPDATE_TEMPLATES, orderUpdateMessage, ownerLinkCodeMessage } from "./templates";

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

  it("takes an order update with a store name and a path suffix, from the store's number, until its approval is withdrawn (#560)", async () => {
    const template = ORDER_UPDATE_TEMPLATES.placed;
    expect(await rejectionCode(fakeWhatsAppProvider.send(orderUpdateMessage(TO, template, "Ada", "https://evil.example/x")))).toBe(132000);
    expect(await rejectionCode(fakeWhatsAppProvider.send(orderUpdateMessage(TO, template, "Ada", "/order/tok")))).toBe(132000);
    expect(await rejectionCode(fakeWhatsAppProvider.send(orderUpdateMessage(TO, template, " ", "order/tok")))).toBe(132000);
    await fakeWhatsAppProvider.send(orderUpdateMessage(TO, template, "Ada", "order/tok"), { phoneNumberId: "1234567890", accessToken: "t" });
    expect(getFakeOutbox().map((entry) => entry.from)).toEqual(["1234567890"]);
    revokeFakeTemplate(template.name);
    expect(await rejectionCode(fakeWhatsAppProvider.send(orderUpdateMessage(TO, template, "Ada", "order/tok")))).toBe(132001);
    resetFake();
    await fakeWhatsAppProvider.send(orderUpdateMessage(TO, template, "Ada", "order/tok"));
    expect(getFakeOutbox()[0].from).toBeNull();
  });
  it("records a list message in the window and rejects one outside it or past Meta's list limits (#559)", async () => {
    const list = (rows: Array<{ id: string; title: string; description?: string }>, button = "Choose") => ({
      type: "list" as const, to: TO, body: "Pick one", button, rows,
    });
    const row = { id: "Garri (2 kg)", title: "Garri", description: "2 kg · $5.99" };
    expect(await rejectionCode(fakeWhatsAppProvider.send(list([row])))).toBe(131047);
    noteInbound(TO);
    await fakeWhatsAppProvider.send(list([row, { id: "Yam (1 tuber)", title: "Yam" }]));
    expect(getFakeOutbox()).toHaveLength(1);

    const rows = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `r${index}`, title: `Row ${index}` }));
    expect(await rejectionCode(fakeWhatsAppProvider.send(list(rows(11))))).toBe(131009);
    expect(await rejectionCode(fakeWhatsAppProvider.send(list([])))).toBe(131009);
    expect(await rejectionCode(fakeWhatsAppProvider.send(list([{ id: "a", title: "x".repeat(25) }])))).toBe(131009);
    expect(await rejectionCode(fakeWhatsAppProvider.send(list([{ id: "a", title: "A", description: "d".repeat(73) }])))).toBe(131009);
    expect(await rejectionCode(fakeWhatsAppProvider.send(list([{ id: "a", title: "A" }, { id: "a", title: "B" }])))).toBe(131009);
    expect(await rejectionCode(fakeWhatsAppProvider.send(list([{ id: "i".repeat(201), title: "A" }])))).toBe(131009);
    expect(await rejectionCode(fakeWhatsAppProvider.send(list([row], "b".repeat(21))))).toBe(131009);
    expect(getFakeOutbox()).toHaveLength(1);
  });
});
