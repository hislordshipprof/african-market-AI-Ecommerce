import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";

const requireStoreOwner = vi.fn();
vi.mock("../store-admin/session", async (original) => ({
  ...(await original<typeof import("../store-admin/session")>()),
  requireStoreOwner: () => requireStoreOwner(),
}));
vi.mock("../inngest/notify", async (original) => ({
  ...(await original<typeof import("../inngest/notify")>()),
  scheduleOrderNotification: () => {},
  scheduleCourierCancel: () => {},
}));

const { storeRefundAction, markNoShowAction } = await import("./actions");
const { storeScoped } = await import("../db");
const { setStripeProvider } = await import("../stripe");
const { fakeStripeProvider, refundRequests, reset, setAuthorizedAmount } = await import("../stripe/fake");
const { completePickup } = await import("./service");
const { countedListing } = await import("./stock-ledger-test-helpers");

const hasDb = !!process.env.DATABASE_URL;
const OWNER = { id: crypto.randomUUID(), email: `owner-${Date.now()}@store.test` };

describe.skipIf(!hasDb)("store refund after capture (#798)", () => {
  const run = `sr798-${Date.now()}`;
  let raw: PrismaClient;
  let storeId = "";
  let variantId = "";
  let number = 0;

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.user.create({ data: { ...OWNER, name: "Owner", emailVerified: true } });
    const store = await raw.store.create({ data: { slug: run, name: "Owner refunds", themePreset: "palm-and-shea", autoRefundLimitCents: 0 } });
    storeId = store.id;
    variantId = (await countedListing(storeId, 50)).variantId;
    reset();
    setStripeProvider(fakeStripeProvider);
  });

  beforeEach(() => {
    requireStoreOwner.mockReset();
    requireStoreOwner.mockResolvedValue({ store: { id: storeId, slug: run }, user: OWNER, membership: { role: "owner", readOnly: false } });
  });

  afterAll(async () => {
    setStripeProvider(null);
    if (!raw) return;
    await raw.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL ROLE app_user`;
      await tx.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`;
      await tx.auditLog.deleteMany({ where: { storeId } });
      await tx.notificationLog.deleteMany({ where: { storeId } });
      await tx.issueReport.deleteMany({ where: { storeId } });
      await tx.order.deleteMany({ where: { storeId } });
      await tx.customer.deleteMany({ where: { storeId } });
      await tx.stockEvent.deleteMany({ where: { storeId } });
      await tx.listingVariant.deleteMany({ where: { listing: { storeId } } });
      await tx.listing.deleteMany({ where: { storeId } });
      await tx.store.deleteMany({ where: { id: storeId } });
    });
    await raw.user.deleteMany({ where: { id: OWNER.id } });
    await raw.$disconnect();
  });

  /** A captured pickup order: two lines, $10 × 2 and $5 × 1, plus a $1.50 service fee. */
  async function capturedOrder(status: "AWAITING_PICKUP" | "COMPLETED" = "COMPLETED") {
    number += 1;
    const scoped = storeScoped(storeId);
    const customer = await scoped.customer.create({ data: { storeId, name: `Refund ${number}`, email: `c${number}@${run}.test` } });
    const captured = 2500 + 150;
    const pi = `pi_sr798_${number}_${run}`;
    setAuthorizedAmount(pi, captured);
    await fakeStripeProvider.capturePaymentIntent(pi, captured, `cap-sr798-${number}`);
    const order = await scoped.order.create({
      data: {
        storeId, number, customerId: customer.id, status, fulfillment: "pickup", subtotalCents: 2500, bufferCents: 0,
        totalAuthorizedCents: captured, totalCents: captured, capturedAmountCents: captured, captureCents: captured,
        serviceFeeCents: 150, paymentIntentId: pi, trackingToken: `t-${run}-${number}`,
        completedAt: status === "COMPLETED" ? new Date() : null,
      },
    });
    const yam = await scoped.orderLine.create({
      data: { storeId, orderId: order.id, listingVariantId: variantId, qtyOrdered: 2, qtyPicked: 2, unitPriceCents: 1000, status: "picked" },
    });
    const oil = await scoped.orderLine.create({
      data: { storeId, orderId: order.id, listingVariantId: variantId, qtyOrdered: 1, qtyPicked: 1, unitPriceCents: 500, status: "picked" },
    });
    return { order, yam, oil };
  }

  const refund = (orderId: string, picks: Array<{ lineId: string; qty: number }> | "whole_order", submissionId: string = crypto.randomUUID()) =>
    storeRefundAction(orderId, { picks, reason: "Bruised yam", submissionId });

  const refunded = (pi: string) => refundRequests.filter((row) => row.paymentIntentId === pi).reduce((sum, row) => sum + row.amountCents, 0);

  async function state(orderId: string) {
    const scoped = storeScoped(storeId);
    return {
      order: await scoped.order.findUniqueOrThrow({ where: { id: orderId } }),
      requests: await scoped.refundRequest.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } }),
      audits: await scoped.auditLog.findMany({ where: { entityId: orderId, action: { in: ["store_refund", "store_cancel"] } } }),
    };
  }

  it("refunds one unit of a line with its share of the service fee, records the line, who and why, and marks the order Partly refunded", async () => {
    const { order, yam } = await capturedOrder();
    // $10 of goods is 40% of $25, so 60¢ of the $1.50 fee goes with it.
    expect(await refund(order.id, [{ lineId: yam.id, qty: 1 }])).toEqual({ ok: true, amountCents: 1060, pending: false, cancelled: false });
    const after = await state(order.id);
    expect(after.order.status).toBe("PARTIALLY_REFUNDED");
    expect(after.requests).toHaveLength(1);
    expect(after.requests[0]).toMatchObject({ amountCents: 1060, providerStatus: "succeeded", lines: [{ lineId: yam.id, qty: 1, amountCents: 1060 }] });
    expect(after.requests[0].key).toMatch(/:store:/);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({ action: "store_refund", actorId: OWNER.id, actorEmail: OWNER.email, entityType: "order" });
    expect(after.audits[0].after).toMatchObject({ amountCents: 1060, reason: "Bruised yam", lines: [{ lineId: yam.id, qty: 1 }] });
  });

  it("never refunds a unit twice, and a resubmitted form refunds once", async () => {
    const { order, yam } = await capturedOrder();
    const submissionId = crypto.randomUUID();
    expect(await refund(order.id, [{ lineId: yam.id, qty: 1 }], submissionId)).toMatchObject({ ok: true, amountCents: 1060 });
    expect(await refund(order.id, [{ lineId: yam.id, qty: 1 }], submissionId)).toMatchObject({ ok: true, amountCents: 1060 });
    expect(await refund(order.id, [{ lineId: yam.id, qty: 2 }])).toEqual({ ok: false, error: "Choose at least one item, and no more than is left to refund of it." });
    expect(await refund(order.id, [{ lineId: yam.id, qty: 1 }])).toMatchObject({ ok: true });
    expect(refundRequests.filter((row) => row.paymentIntentId === order.paymentIntentId)).toHaveLength(2);
  });

  it("refunds a line before pickup without moving the order, and marks it Partly refunded once collected", async () => {
    const { order, oil } = await capturedOrder("AWAITING_PICKUP");
    expect(await refund(order.id, [{ lineId: oil.id, qty: 1 }])).toMatchObject({ ok: true, amountCents: 530 });
    expect((await state(order.id)).order.status).toBe("AWAITING_PICKUP");
    expect(await completePickup(storeId, order.id)).toEqual({ ok: true });
    expect((await state(order.id)).order.status).toBe("PARTIALLY_REFUNDED");
  });

  it("refunding the whole of an order the store still holds cancels it and refunds the whole capture", async () => {
    const { order } = await capturedOrder("AWAITING_PICKUP");
    expect(await refund(order.id, "whole_order")).toEqual({ ok: true, cancelled: true });
    const after = await state(order.id);
    expect(after.order.status).toBe("CANCELLED");
    expect(refunded(order.paymentIntentId!)).toBe(2650);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]).toMatchObject({ action: "store_cancel", actorId: OWNER.id });
    expect(after.audits[0].after).toEqual({ reason: "other", note: "Bruised yam" });
  });

  it("refunding the whole of a collected order refunds what is left and marks it Refunded", async () => {
    const { order, yam } = await capturedOrder();
    await refund(order.id, [{ lineId: yam.id, qty: 1 }]);
    expect(await refund(order.id, "whole_order")).toMatchObject({ ok: true, amountCents: 2650 - 1060 });
    expect((await state(order.id)).order.status).toBe("REFUNDED");
  });

  it("a no-show cancels an uncollected pickup with the reason no_show and refunds it in full", async () => {
    const { order } = await capturedOrder("AWAITING_PICKUP");
    expect(await markNoShowAction(order.id, "Called twice")).toEqual({ ok: true, cancelled: true });
    const after = await state(order.id);
    expect(after.order.status).toBe("CANCELLED");
    expect(after.audits[0].after).toEqual({ reason: "no_show", note: "Called twice" });
    expect(refunded(order.paymentIntentId!)).toBe(2650);
    const collected = await capturedOrder();
    expect(await markNoShowAction(collected.order.id)).toEqual({ ok: false, error: "Only a pickup order that is ready for pickup can be marked as not collected." });
  });

  it("staff cannot refund: the owner check stops the action before any refund", async () => {
    const { order, yam } = await capturedOrder();
    requireStoreOwner.mockRejectedValue(new Error("NEXT_REDIRECT"));
    await expect(refund(order.id, [{ lineId: yam.id, qty: 1 }])).rejects.toThrow("NEXT_REDIRECT");
    await expect(markNoShowAction(order.id)).rejects.toThrow("NEXT_REDIRECT");
    expect((await state(order.id)).requests).toHaveLength(0);
  });
});
