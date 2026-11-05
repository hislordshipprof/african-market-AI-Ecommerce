import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import Stripe from "stripe";
import { NextRequest } from "next/server";
import { storeScoped, storeScopedTransaction } from "../db";
import { setStripeProvider } from "../stripe";
import { stripeProvider } from "./provider";
import { fakeStripeProvider, reset, setAuthorizedAmount, setRefundStatus } from "./fake";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("signed refund.failed webhook (lane DB)", () => {
  const run = `wh186-${Date.now()}`;
  let raw: PrismaClient;
  let storeA = "";
  let storeB = "";
  let secret = "";

  beforeAll(async () => {
    secret = process.env.STRIPE_WEBHOOK_SECRET?.split(",")[0]?.trim() || "whsec_test_ticket_186";
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", secret);
    if (!process.env.STRIPE_SECRET_KEY) vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    raw = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await raw.$connect();
    const a = await raw.store.create({
      data: {
        slug: `wh-a-${run}`,
        name: "Webhook A",
        themePreset: "palm-and-shea",
        prepTimeMinutes: 20,
        stripeAccountId: "acct_wh_a",
      },
    });
    const b = await raw.store.create({
      data: {
        slug: `wh-b-${run}`,
        name: "Webhook B",
        themePreset: "lagoon-and-coral",
        prepTimeMinutes: 20,
        stripeAccountId: "acct_wh_b",
      },
    });
    storeA = a.id;
    storeB = b.id;
    reset();
    setStripeProvider({
      ...fakeStripeProvider,
      verifyWebhookSignature: (input) => stripeProvider.verifyWebhookSignature(input),
    });
  });

  afterAll(async () => {
    setStripeProvider(null);
    vi.unstubAllEnvs();
    if (!raw) return;
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.auditLog.deleteMany({ where: { storeId: { in: [storeA, storeB] } } });
      await tx.order.deleteMany({ where: { storeId: { in: [storeA, storeB] } } });
      await tx.customer.deleteMany({ where: { storeId: { in: [storeA, storeB] } } });
      await tx.store.deleteMany({ where: { id: { in: [storeA, storeB] } } });
    });
    await raw.$disconnect();
  });

  it("a platform-signed refund.failed changes store A and leaves store B", async () => {
    const customerA = await storeScoped(storeA).customer.create({
      data: { storeId: storeA, name: "Webhook Customer A" },
    });
    const customerB = await storeScoped(storeB).customer.create({
      data: { storeId: storeB, name: "Webhook Customer B" },
    });
    const pi = `pi_wh_${run}`;
    setAuthorizedAmount(pi, 2500);
    await fakeStripeProvider.capturePaymentIntent(pi, 2500, "cap-wh");
    const refund = await fakeStripeProvider.refundPayment(pi, 2500, "ref-wh");
    setRefundStatus(refund.refundId, "failed");
    const orderA = await storeScoped(storeA).order.create({
      data: {
        storeId: storeA,
        number: 18601,
        customerId: customerA.id,
        status: "CANCELLING",
        fulfillment: "pickup",
        subtotalCents: 2500,
        bufferCents: 0,
        totalAuthorizedCents: 2500,
        totalCents: 2500,
        capturedAmountCents: null,
        paymentIntentId: pi,
        refundId: refund.refundId,
      },
    });
    const orderB = await storeScoped(storeB).order.create({
      data: {
        storeId: storeB,
        number: 18602,
        customerId: customerB.id,
        status: "CANCELLING",
        fulfillment: "delivery",
        subtotalCents: 800,
        bufferCents: 0,
        totalAuthorizedCents: 800,
        totalCents: 800,
        capturedAmountCents: 800,
        paymentIntentId: `pi_other_${run}`,
      },
    });

    const payload = JSON.stringify({
      id: `evt_${run}`,
      object: "event",
      api_version: "2024-06-20",
      created: Math.floor(Date.now() / 1000),
      type: "refund.failed",
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      data: {
        object: {
          id: refund.refundId,
          object: "refund",
          status: "failed",
          payment_intent: pi,
        },
      },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    expect(() => stripeProvider.verifyWebhookSignature({ payload, signature })).not.toThrow();
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    const response = await POST(
      new NextRequest("http://localhost:3000/api/webhooks/stripe", {
        method: "POST",
        body: payload,
        headers: { "stripe-signature": signature, "content-type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);

    const updatedA = await storeScoped(storeA).order.findUnique({ where: { id: orderA.id } });
    expect(updatedA?.status).toBe("REFUND_FAILED");
    expect(updatedA?.capturedAmountCents).toBe(2500);
    const updatedB = await storeScopedTransaction(storeB, (tx) =>
      tx.order.findUnique({ where: { id: orderB.id } }),
    );
    expect(updatedB?.status).toBe("CANCELLING");
    expect(updatedB?.capturedAmountCents).toBe(800);
    expect(updatedB?.notes).toBeNull();
  });
});
