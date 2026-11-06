import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Stripe from "stripe";
import { fakeStripeProvider, reset, VALID_WEBHOOK_SIGNATURE } from "./fake";
import { setStripeProvider } from "./index";
import type { WebhookEvent } from "./types";

vi.mock("./update-store-status", () => ({
  updateStoreOnboardingStatus: vi.fn().mockResolvedValue({
    storeId: "store_123",
    status: "complete",
  }),
}));

vi.mock("@/lib/order/refund-requests", () => ({
  applyProviderRefund: vi.fn().mockResolvedValue(undefined),
}));

import { updateStoreOnboardingStatus } from "./update-store-status";
import * as orderService from "@/lib/order/service";

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
    vi.spyOn(orderService, "markTerminalRefundFailure");
  });

  afterEach(() => {
    setStripeProvider(null);
    vi.mocked(orderService.markTerminalRefundFailure).mockRestore();
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

  it("unsigned 400", async () => {
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const { NextRequest } = await import("next/server");
    const res = await POST(new NextRequest(new Request("http://localhost:3000/api/webhooks/stripe", { method: "POST", body: "{}" })));
    expect(res.status).toBe(400);
  });

  it("schema failure after signature 400", async () => {
    const res = await callWebhook(
      JSON.stringify({ type: "t".repeat(201), accountId: "acct_schema" }),
      VALID_WEBHOOK_SIGNATURE,
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid webhook payload" });
    expect(updateStoreOnboardingStatus).not.toHaveBeenCalled();
  });

  it("duplicate event applied once", async () => {
    const { applyProviderRefund } = await import("@/lib/order/refund-requests");
    vi.mocked(applyProviderRefund).mockClear();
    const body = JSON.stringify({
      type: "charge.refunded",
      accountId: "acct_dup",
      data: { object: { id: "re_dup", object: "refund", status: "succeeded", payment_intent: "pi_dup" } },
    });
    expect((await callWebhook(body, VALID_WEBHOOK_SIGNATURE)).status).toBe(200);
    expect((await callWebhook(body, VALID_WEBHOOK_SIGNATURE)).status).toBe(200);
    const amounts = vi.mocked(applyProviderRefund).mock.calls.map((call) => call[0]?.amountRefunded);
    expect(new Set(amounts).size).toBe(1);
  });

  it("DB failure returns 500 and retry converges", async () => {
    const { applyProviderRefund } = await import("@/lib/order/refund-requests");
    vi.mocked(applyProviderRefund).mockRejectedValueOnce(new Error("db down"));
    const body = JSON.stringify({
      type: "charge.refunded",
      accountId: "acct_db",
      data: { object: { id: "re_db", object: "refund", status: "succeeded", payment_intent: "pi_db" } },
    });
    expect((await callWebhook(body, VALID_WEBHOOK_SIGNATURE)).status).toBe(500);
    expect((await callWebhook(body, VALID_WEBHOOK_SIGNATURE)).status).toBe(200);
  });

  it("returns 200 and updates store for valid account.updated event", async () => {
    const event: WebhookEvent = {
      type: "account.updated",
      accountId: "acct_fake_store_123",
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

  it("refund.failed alerts the order service", async () => {
    const res = await callWebhook(
      JSON.stringify({
        type: "refund.failed",
        data: {
          object: {
            object: "refund",
            id: "re_failed_1",
            status: "failed",
            payment_intent: "pi_failed_1",
          },
        },
      }),
      VALID_WEBHOOK_SIGNATURE,
    );
    expect(res.status).toBe(200);
    expect(orderService.markTerminalRefundFailure).toHaveBeenCalledWith({
      paymentIntentId: "pi_failed_1",
      refundId: "re_failed_1",
      refundStatus: "failed",
    });
  });

  it("refund.updated canceled alerts the order service", async () => {
    const res = await callWebhook(
      JSON.stringify({
        type: "refund.updated",
        data: {
          object: {
            object: "refund",
            id: "re_canceled_1",
            status: "canceled",
            payment_intent: "pi_canceled_1",
          },
        },
      }),
      VALID_WEBHOOK_SIGNATURE,
    );
    expect(res.status).toBe(200);
    expect(orderService.markTerminalRefundFailure).toHaveBeenCalledWith({
      paymentIntentId: "pi_canceled_1",
      refundId: "re_canceled_1",
      refundStatus: "canceled",
    });
  });

  it("returns 200 but does not update store for unrelated event types", async () => {
    const event = {
      type: "payment_intent.succeeded",
      accountId: "pi_123",
    };

    const res = await callWebhook(
      JSON.stringify(event),
      VALID_WEBHOOK_SIGNATURE,
    );
    expect(res.status).toBe(200);
    expect(updateStoreOnboardingStatus).not.toHaveBeenCalled();
  });
});

describe("Stripe webhook signatures", () => {
  const platformSecret = "whsec_platform_test_secret_186";
  const connectSecret = "whsec_connect_test_secret_186";
  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousVercel = process.env.VERCEL;

  beforeEach(async () => {
    if (!process.env.STRIPE_SECRET_KEY) process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    const { stripeProvider } = await import("./provider");
    setStripeProvider(stripeProvider);
    process.env.STRIPE_WEBHOOK_SECRET = `${platformSecret}, ${connectSecret}`;
  });

  afterEach(() => {
    setStripeProvider(null);
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
    else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
    vi.stubEnv("NODE_ENV", previousNodeEnv ?? "test");
    if (previousVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previousVercel;
  });

  async function post(payload: string, signature: string) {
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const { NextRequest } = await import("next/server");
    return POST(new NextRequest("http://localhost:3000/api/webhooks/stripe", {
      method: "POST",
      body: payload,
      headers: { "stripe-signature": signature, "content-type": "application/json" },
    }));
  }

  function sign(payload: string, secret: string, timestamp?: number) {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "sk_test_placeholder");
    return stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
      ...(timestamp ? { timestamp } : {}),
    });
  }

  it("account.updated signed with the connect secret verifies when both secrets are listed", async () => {
    const payload = JSON.stringify({
      id: "evt_connect",
      object: "event",
      type: "account.updated",
      data: { object: { id: "acct_connect_186", object: "account" } },
    });
    const res = await post(payload, sign(payload, connectSecret));
    expect(res.status).toBe(200);
    expect(updateStoreOnboardingStatus).toHaveBeenCalledWith("acct_connect_186");
  });

  it("a payload signed with an unlisted secret is rejected with 400", async () => {
    const payload = JSON.stringify({ id: "evt_bad", object: "event", type: "account.updated", data: { object: { id: "acct_x", object: "account" } } });
    const res = await post(payload, sign(payload, "whsec_not_listed"));
    expect(res.status).toBe(400);
  });

  it("stale signature 400", async () => {
    const payload = JSON.stringify({ id: "evt_stale_301", object: "event", type: "account.updated", data: { object: { id: "acct_x", object: "account" } } });
    const res = await post(payload, sign(payload, platformSecret, Math.floor(Date.now() / 1000) - 301));
    expect(res.status).toBe(400);
  });

  it("a stale signature timestamp is rejected with 400", async () => {
    const payload = JSON.stringify({ id: "evt_stale", object: "event", type: "account.updated", data: { object: { id: "acct_x", object: "account" } } });
    const res = await post(payload, sign(payload, platformSecret, Math.floor(Date.now() / 1000) - 600));
    expect(res.status).toBe(400);
  });

  it("both missing Stripe secrets return 500 and log the webhook key", async () => {
    const runtime = { NODE_ENV: "production", VERCEL: "" };
    vi.stubEnv("NODE_ENV", runtime.NODE_ENV);
    vi.stubEnv("VERCEL", runtime.VERCEL);
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    vi.stubEnv("E2E_FAKE_STRIPE", "");
    setStripeProvider(null);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await post("{}", "t=1,v1=dead");
    expect(response.status).toBe(500);
    expect(log.mock.calls.flat().join(" ")).toContain("STRIPE_WEBHOOK_SECRET");
    log.mockRestore();
  });

  it("a missing webhook secret in production returns 500 and logs the key", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.VERCEL;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = JSON.stringify({ id: "evt_missing", object: "event", type: "account.updated", data: { object: { id: "acct_x", object: "account" } } });
    const res = await post(payload, "t=1,v1=dead");
    expect(res.status).toBe(500);
    expect(error.mock.calls.some((call) => String(call[0]).includes("STRIPE_WEBHOOK_SECRET"))).toBe(true);
    error.mockRestore();
  });
});
