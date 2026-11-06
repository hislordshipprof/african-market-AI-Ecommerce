import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import Stripe from "stripe";
import { NextRequest } from "next/server";
import { storeScoped, storeScopedTransaction } from "../db";
import { SYSTEM_ACTOR_EMAIL, SYSTEM_ACTOR_ID } from "../system-actor";
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

  async function postRefund(type: string, refundId: string, paymentIntentId: string, status: string, reservation?: string) {
    const payload = JSON.stringify({
      id: `evt_${type}_${refundId}`,
      object: "event",
      api_version: "2024-06-20",
      created: Math.floor(Date.now() / 1000),
      type,
      livemode: false,
      pending_webhooks: 1,
      request: { id: null, idempotency_key: null },
      data: {
        object: {
          id: refundId,
          object: "refund",
          status,
          payment_intent: paymentIntentId,
          ...(reservation ? { metadata: { reservation } } : {}),
        },
      },
    });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    const { POST } = await import("@/app/api/webhooks/stripe/route");
    return POST(new NextRequest("http://localhost:3000/api/webhooks/stripe", {
      method: "POST",
      body: payload,
      headers: { "stripe-signature": signature, "content-type": "application/json" },
    }));
  }

  it("refund.created for an app key marks the request created", async () => {
    const customer = await storeScoped(storeA).customer.create({
      data: { storeId: storeA, name: "Created webhook" },
    });
    const pi = `pi_created_${run}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap-created");
    const order = await storeScoped(storeA).order.create({
      data: {
        storeId: storeA,
        number: 18611,
        customerId: customer.id,
        status: "CANCELLING",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    const key = `refund:${order.id}:1`;
    await storeScoped(storeA).refundRequest.create({
      data: {
        storeId: storeA,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 1000,
        refundApplicationFee: true,
        state: "RESERVED",
      },
    });
    const refund = await fakeStripeProvider.refundPayment(pi, 1000, key, { reservationKey: key, orderId: order.id });
    const response = await postRefund("refund.created", refund.refundId, pi, "pending", key);
    expect(response.status).toBe(200);
    const row = await storeScoped(storeA).refundRequest.findFirstOrThrow({ where: { orderId: order.id } });
    expect(row.state).toBe("CREATED");
    expect(row.providerRefundId).toBe(refund.refundId);
    expect(row.providerStatus).toBe("succeeded");
  });

  it("refund.updated succeeded on a resolved order alerts overpayment", async () => {
    const customer = await storeScoped(storeA).customer.create({
      data: { storeId: storeA, name: "Overpay webhook" },
    });
    const pi = `pi_overpay_${run}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap-overpay");
    const order = await storeScoped(storeA).order.create({
      data: {
        storeId: storeA,
        number: 18612,
        customerId: customer.id,
        status: "CANCELLED",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    await storeScoped(storeA).auditLog.create({
      data: {
        storeId: storeA,
        actorId: SYSTEM_ACTOR_ID,
        actorEmail: SYSTEM_ACTOR_EMAIL,
        action: "refund_resolved_manually",
        entityType: "order",
        entityId: order.id,
        after: { note: "Paid by Zelle", alert: "store", repaidCents: 1000 },
      },
    });
    const refund = await fakeStripeProvider.refundPayment(pi, 600, "overpay-wh");
    const response = await postRefund("refund.updated", refund.refundId, pi, "succeeded");
    expect(response.status).toBe(200);
    const stored = await storeScoped(storeA).order.findUnique({ where: { id: order.id } });
    expect(stored?.status).toBe("CANCELLED");
    const alert = await storeScoped(storeA).auditLog.findFirst({
      where: { entityId: order.id, action: "refund_after_manual_resolution" },
    });
    expect(alert?.after).toMatchObject({ overpaidCents: 600, refundId: refund.refundId });
  });

  it("out-of-order refund events are applied from a re-fetched refund", async () => {
    const customer = await storeScoped(storeA).customer.create({
      data: { storeId: storeA, name: "Out of order" },
    });
    const pi = `pi_ooo_${run}`;
    setAuthorizedAmount(pi, 800);
    await fakeStripeProvider.capturePaymentIntent(pi, 800, "cap-ooo");
    const order = await storeScoped(storeA).order.create({
      data: {
        storeId: storeA,
        number: 18613,
        customerId: customer.id,
        status: "CANCELLING",
        fulfillment: "pickup",
        subtotalCents: 800,
        bufferCents: 0,
        totalAuthorizedCents: 800,
        totalCents: 800,
        capturedAmountCents: 800,
        paymentIntentId: pi,
      },
    });
    const key = `refund:${order.id}:1`;
    await storeScoped(storeA).refundRequest.create({
      data: {
        storeId: storeA,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 800,
        refundApplicationFee: true,
        state: "UNKNOWN",
      },
    });
    const refund = await fakeStripeProvider.refundPayment(pi, 800, key, { reservationKey: key, orderId: order.id });
    const response = await postRefund("refund.updated", refund.refundId, pi, "pending", key);
    expect(response.status).toBe(200);
    const row = await storeScoped(storeA).refundRequest.findFirstOrThrow({ where: { orderId: order.id } });
    expect(row.providerStatus).toBe("succeeded");
    expect(row.state).toBe("CREATED");
  });

  it("a failed order that later becomes fully refunded is cancelled by webhook", async () => {
    const customer = await storeScoped(storeA).customer.create({
      data: { storeId: storeA, name: "Fully refunded later" },
    });
    const pi = `pi_full_later_${run}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap-full-later");
    const failed = await fakeStripeProvider.refundPayment(pi, 1000, "full-later-fail");
    setRefundStatus(failed.refundId, "failed");
    const order = await storeScoped(storeA).order.create({
      data: {
        storeId: storeA,
        number: 18614,
        customerId: customer.id,
        status: "CANCELLING",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: null,
        paymentIntentId: pi,
        refundId: failed.refundId,
      },
    });
    expect((await postRefund("refund.failed", failed.refundId, pi, "failed")).status).toBe(200);
    expect((await storeScoped(storeA).order.findUnique({ where: { id: order.id } }))?.status).toBe("REFUND_FAILED");
    const covered = await fakeStripeProvider.refundPayment(pi, 1000, "full-later-ok");
    expect((await postRefund("refund.updated", covered.refundId, pi, "succeeded")).status).toBe(200);
    const stored = await storeScoped(storeA).order.findUnique({ where: { id: order.id } });
    expect(stored?.status).toBe("CANCELLED");
    const succeeded = (await fakeStripeProvider.listRefunds(pi))
      .filter((refund) => refund.status === "succeeded")
      .reduce((sum, refund) => sum + refund.amountRefunded, 0);
    expect(succeeded).toBe(1000);
    expect(await storeScoped(storeA).refundRequest.count({ where: { orderId: order.id, state: { in: ["RESERVED", "UNKNOWN"] } } })).toBe(0);
  });

  it("duplicate event applied once", async () => {
    const customer = await storeScoped(storeA).customer.create({
      data: { storeId: storeA, name: "Duplicate webhook" },
    });
    const pi = `pi_dup_${run}`;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap-dup");
    const order = await storeScoped(storeA).order.create({
      data: {
        storeId: storeA,
        number: 18615,
        customerId: customer.id,
        status: "CANCELLING",
        fulfillment: "pickup",
        subtotalCents: 1000,
        bufferCents: 0,
        totalAuthorizedCents: 1000,
        totalCents: 1000,
        capturedAmountCents: 1000,
        paymentIntentId: pi,
      },
    });
    const key = `refund:${order.id}:dup`;
    await storeScoped(storeA).refundRequest.create({
      data: {
        storeId: storeA,
        orderId: order.id,
        paymentIntentId: pi,
        key,
        amountCents: 1000,
        refundApplicationFee: true,
        state: "RESERVED",
      },
    });
    const refund = await fakeStripeProvider.refundPayment(pi, 1000, key, { reservationKey: key, orderId: order.id });
    expect((await postRefund("refund.created", refund.refundId, pi, "succeeded", key)).status).toBe(200);
    expect((await postRefund("refund.created", refund.refundId, pi, "succeeded", key)).status).toBe(200);
    const rows = await storeScoped(storeA).refundRequest.findMany({ where: { orderId: order.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("CREATED");
    expect(rows[0]?.amountCents).toBe(1000);
    expect(rows[0]?.providerRefundId).toBe(refund.refundId);
    const stored = await storeScoped(storeA).order.findUnique({ where: { id: order.id } });
    expect(stored?.capturedAmountCents).toBe(1000);
  });
});
