import { afterEach, describe, expect, it } from "vitest";
import { magicLinkMessage } from "../magic-link-mail";
import { quotedFrom } from "../notifications/messages";
import { ResendSender } from "./send";

const apiKey = process.env.RESEND_API_KEY;
const fromAddress = process.env.EMAIL_FROM ?? "onboarding@resend.dev";

describe.skipIf(!apiKey)("Resend magic-link sandbox", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("delivers a store-branded magic link to the sandbox recipient", async () => {
    const message = magicLinkMessage({
      to: "delivered@resend.dev",
      url: "https://mama-ngozi.localhost/api/auth/magic-link/verify?token=sandbox&callbackURL=%2Faccount",
      storeName: "Mama Ngozi African Market",
      fromAddress,
    });
    expect(message.from).toMatch(/^Mama Ngozi African Market </);

    let serializedFrom = "";
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("api.resend.com/emails") && init?.body) {
        serializedFrom = JSON.parse(String(init.body)).from;
      }
      return originalFetch(input, init);
    };

    const sender = new ResendSender(apiKey!, fromAddress);
    const result = await sender.send(message);

    expect(serializedFrom).toBe(message.from);
    expect(result.id).toMatch(/\S/);
  }, 20_000);

  it("an order email sent twice with one idempotency key is accepted once", async () => {
    const key = `notif_sandbox_${Date.now()}`;
    const message = {
      to: "delivered@resend.dev",
      subject: "Order placed",
      html: "<p>Track your order</p>",
      from: quotedFrom("Mama's Kitchen, LLC (Test)", fromAddress),
      idempotencyKey: key,
    };
    const sender = new ResendSender(apiKey!, fromAddress);
    const first = await sender.send(message);
    const second = await sender.send(message);
    expect(first.id).toMatch(/\S/);
    expect(second.id).toBe(first.id);
  }, 20_000);
});
