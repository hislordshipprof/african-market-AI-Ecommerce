import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
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
const { fakeTaxCalculator, setTaxCalculatorForTests } = await import("../tax/calculator");

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
  async function capturedOrder(
    status: "AWAITING_PICKUP" | "COMPLETED" | "READY" | "DELIVERED" = "COMPLETED",
    fulfillment: "pickup" | "ship" = "pickup",
    extra: { deliveryFeeCents: number; tipCents: number; yamTaxCents: number; oilTaxCents: number } | null = null,
  ) {
    number += 1;
    const scoped = storeScoped(storeId);
    const customer = await scoped.customer.create({ data: { storeId, name: `Refund ${number}`, email: `c${number}@${run}.test` } });
    const taxCents = extra ? extra.yamTaxCents + extra.oilTaxCents : 0;
    const captured = 2500 + 150 + (extra ? extra.deliveryFeeCents + extra.tipCents + taxCents : 0);
    const pi = `pi_sr798_${number}_${run}`;
    setAuthorizedAmount(pi, captured);
    await fakeStripeProvider.capturePaymentIntent(pi, captured, `cap-sr798-${number}`);
    const order = await scoped.order.create({
      data: {
        storeId, number, customerId: customer.id, status, fulfillment, subtotalCents: 2500, bufferCents: 0,
        totalAuthorizedCents: captured, totalCents: captured, capturedAmountCents: captured, captureCents: captured,
        serviceFeeCents: 150, paymentIntentId: pi, trackingToken: `t-${run}-${number}`,
        completedAt: status === "COMPLETED" ? new Date() : null,
        ...(extra ? { deliveryFeeCents: extra.deliveryFeeCents, tipCents: extra.tipCents, taxCents, taxCalculationId: `taxcalc_${run}_${number}` } : {}),
      },
    });
    const yam = await scoped.orderLine.create({
      data: { storeId, orderId: order.id, listingVariantId: variantId, qtyOrdered: 2, qtyPicked: 2, unitPriceCents: 1000, status: "picked", taxCents: extra?.yamTaxCents ?? 0 },
    });
    const oil = await scoped.orderLine.create({
      data: { storeId, orderId: order.id, listingVariantId: variantId, qtyOrdered: 1, qtyPicked: 1, unitPriceCents: 500, status: "picked", taxCents: extra?.oilTaxCents ?? 0 },
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
    const { order, yam, oil } = await capturedOrder();
    await refund(order.id, [{ lineId: yam.id, qty: 1 }]);
    expect(await refund(order.id, "whole_order")).toMatchObject({ ok: true, amountCents: 2650 - 1060 });
    const after = await state(order.id);
    expect(after.order.status).toBe("REFUNDED");
    // The receipt names each item the whole-order refund returned: the units left, with the amount split over them.
    const lines = after.requests[1].lines as Array<{ lineId: string; qty: number; amountCents: number }>;
    expect(lines.map(({ lineId, qty }) => ({ lineId, qty }))).toEqual([{ lineId: yam.id, qty: 1 }, { lineId: oil.id, qty: 1 }]);
    expect(lines.reduce((sum, line) => sum + line.amountCents, 0)).toBe(2650 - 1060);
  });

  it("refunding the whole of a delivered order with a delivery fee and tip reverses no more tax than each line has", async () => {
    const { order, yam, oil } = await capturedOrder("DELIVERED", "ship", { deliveryFeeCents: 599, tipCents: 300, yamTaxCents: 160, oilTaxCents: 40 });
    expect(await refund(order.id, "whole_order")).toMatchObject({ ok: true, amountCents: 2500 + 150 + 599 + 300 + 200 });
    const after = await state(order.id);
    // The delivery fee and tip are not sales of the lines: the reversal is the lines' goods and tax, the sale left.
    expect(after.requests[0].taxReversal).toEqual({
      mode: "lines",
      totalCents: 2700,
      lines: [{ reference: yam.id, amountCents: 2000, taxCents: 160 }, { reference: oil.id, amountCents: 500, taxCents: 40 }],
    });
  });

  it("after a platform refund, a whole-order refund reverses no more tax than the sale has left", async () => {
    const { order } = await capturedOrder("DELIVERED", "ship", { deliveryFeeCents: 599, tipCents: 300, yamTaxCents: 160, oilTaxCents: 40 });
    const { refundOrderAsPlatform } = await import("./platform-refund");
    expect(await refundOrderAsPlatform(order.id, { amountCents: 1000, reason: "Late", submissionId: crypto.randomUUID() }, OWNER)).toMatchObject({ ok: true });
    expect(await refund(order.id, "whole_order")).toMatchObject({ ok: true });
    const [first, second] = (await state(order.id)).requests.map((row) => row.taxReversal as { mode: string; totalCents: number });
    // A flat reversal records no lines, so a lines plan would ask Stripe Tax for more than each line has left.
    expect(second).toMatchObject({ mode: "flat" });
    expect(first.totalCents + second.totalCents).toBeLessThanOrEqual(2700);
  });

  it("after a platform refund, a refund of some lines reverses its tax within what the lines have left", async () => {
    const { order, yam, oil } = await capturedOrder("DELIVERED", "ship", { deliveryFeeCents: 599, tipCents: 300, yamTaxCents: 160, oilTaxCents: 40 });
    const tax = fakeTaxCalculator({ TX: { rate: 0.08 } });
    setTaxCalculatorForTests(tax);
    onTestFinished(() => setTaxCalculatorForTests(null));
    const calculation = await tax.calculate({
      address: { line1: "600 Congress Ave", city: "Austin", state: "TX", postalCode: "78701" },
      lines: [{ reference: yam.id, amountCents: 2000, taxCode: null }, { reference: oil.id, amountCents: 500, taxCode: null }],
      liableParty: "platform", stripeAccount: null, idempotencyKey: `sale-${order.id}`,
    });
    const transaction = await tax.recordTransaction({ calculationId: calculation.id!, reference: `order_${order.id}`, liableParty: "platform", stripeAccount: null });
    await storeScoped(storeId).order.update({ where: { id: order.id }, data: { taxCalculationId: calculation.id, taxTransactionId: transaction.id } });
    const { refundOrderAsPlatform } = await import("./platform-refund");
    expect(await refundOrderAsPlatform(order.id, { amountCents: 1500, reason: "Late", submissionId: crypto.randomUUID() }, OWNER)).toMatchObject({ ok: true });
    expect(await refund(order.id, [{ lineId: yam.id, qty: 1 }])).toMatchObject({ ok: true });
    const [first, second] = (await state(order.id)).requests;
    // A flat reversal took part of every line, so a lines plan could ask for more than the yam has left.
    expect(second.taxReversal).toMatchObject({ mode: "flat" });
    expect(first.taxReversalId).not.toBeNull();
    expect(second.taxReversalId).not.toBeNull();
  });

  it("refunding the whole of a ready ship order cancels the shipment and keeps the owner's reason", async () => {
    const { order } = await capturedOrder("READY", "ship");
    expect(await refund(order.id, "whole_order")).toEqual({ ok: true, cancelled: true });
    const after = await state(order.id);
    expect(after.order.status).toBe("CANCELLED");
    expect(after.audits[0].after).toEqual({ reason: "other", note: "Bruised yam" });
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
