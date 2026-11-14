import { afterEach, describe, expect, it } from "vitest";
import { magicLinkMessage } from "../magic-link-mail";
import { quotedFrom } from "../notifications/messages";
import { isProviderQuotaError } from "./provider-quota";
import { ResendSender, type EmailMessage } from "./send";

const apiKey = process.env.RESEND_API_KEY;
const fromAddress = process.env.EMAIL_FROM ?? "onboarding@resend.dev";

// The sandbox sends real email, so the account's daily quota can run out. That says nothing about our code,
// so a quota refusal skips the test with a warning instead of failing it (#591).
async function sendOrSkipOnQuota(ctx: { skip: () => void }, sender: ResendSender, message: EmailMessage) {
  try {
    return await sender.send(message);
  } catch (error) {
    if (!isProviderQuotaError(error)) throw error;
    console.warn(`Resend sandbox skipped: provider quota reached (${(error as Error).message.slice(0, 120)})`);
    ctx.skip();
    throw error;
  }
}

describe.skipIf(!apiKey)("Resend magic-link sandbox", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("delivers a store-branded magic link to the sandbox recipient", async (ctx) => {
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
    const result = await sendOrSkipOnQuota(ctx, sender, message);

    expect(serializedFrom).toBe(message.from);
    expect(result.id).toMatch(/\S/);
  }, 20_000);

  it("an order email sent twice with one idempotency key is accepted once", async (ctx) => {
    const key = `notif_sandbox_${Date.now()}`;
    const message = {
      to: "delivered@resend.dev",
      subject: "Order placed",
      html: "<p>Track your order</p>",
      from: quotedFrom("Mama's Kitchen, LLC (Test)", fromAddress),
      idempotencyKey: key,
    };
    const sender = new ResendSender(apiKey!, fromAddress);
    const first = await sendOrSkipOnQuota(ctx, sender, message);
    const second = await sendOrSkipOnQuota(ctx, sender, message);
    expect(first.id).toMatch(/\S/);
    expect(second.id).toBe(first.id);
  }, 20_000);
});
