import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fakeStripeProvider, reset, VALID_WEBHOOK_SIGNATURE } from "./fake";
import { setStripeProvider } from "./index";
import type { WebhookEvent } from "./types";

vi.mock("./update-store-status", () => ({
  updateStoreOnboardingStatus: vi.fn().mockResolvedValue({
    storeId: "store_123",
    status: "complete",
  }),
}));

import { updateStoreOnboardingStatus } from "./update-store-status";

async function callWebhook(body: string, signature: string) {
  const { POST } = await import("@/app/api/webhooks/stripe/route");
  const req = new Request("http://localhost:3000/api/webhooks/stripe", {
    method: "POST",
    body,
    headers: {
      "stripe-signature": signature,
      "content-type": "application/json",
    },
  });
  const { NextRequest } = await import("next/server");
  const nextReq = new NextRequest(req);
  return POST(nextReq);
}

describe("Stripe webhook handler", () => {
  beforeEach(() => {
    reset();
    setStripeProvider(fakeStripeProvider);
    vi.mocked(updateStoreOnboardingStatus).mockClear();
  });

  afterEach(() => {
    setStripeProvider(null);
  });

  it("returns 400 when stripe-signature header is missing", async () => {
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const req = new Request("http://localhost:3000/api/webhooks/stripe", {
      method: "POST",
      body: "{}",
    });
    const { NextRequest } = await import("next/server");
    const nextReq = new NextRequest(req);
    const res = await POST(nextReq);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/missing/i);
  });

  it("returns 400 when signature is invalid", async () => {
    const res = await callWebhook("{}", "bad_signature");
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/invalid/i);
  });

  it("returns 200 and updates store for valid account.updated event", async () => {
    const event: WebhookEvent = {
      type: "account.updated",
      account: "acct_fake_store_123",
      data: {
        object: {
          id: "acct_fake_store_123",
          charges_enabled: true,
          payouts_enabled: true,
          details_submitted: true,
          requirements: { currently_due: [] },
        },
      },
    };

    const res = await callWebhook(
      JSON.stringify(event),
      VALID_WEBHOOK_SIGNATURE,
    );
    expect(res.status).toBe(200);
    expect(updateStoreOnboardingStatus).toHaveBeenCalledWith(
      "acct_fake_store_123",
    );
  });

  it("returns 200 but does not update store for unrelated event types", async () => {
    const event = {
      type: "payment_intent.succeeded",
      account: "acct_fake_store_123",
      data: { object: { id: "pi_123" } },
    };

    const res = await callWebhook(
      JSON.stringify(event),
      VALID_WEBHOOK_SIGNATURE,
    );
    expect(res.status).toBe(200);
    expect(updateStoreOnboardingStatus).not.toHaveBeenCalled();
  });
});
