import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { platformAdminTransaction, storeScoped, storeScopedTransaction } from "../db";
import { recordReconcileResult } from "../inngest/functions";
import { acceptOrder, autoCancelOrder, completePickup, fulfilledStatus, getStoreOrders, markLinePicked, markReady, markTerminalRefundFailure, reconcileStuckOrder, sortPickListLines } from "./service";
import { getStripeProvider, setStripeProvider } from "../stripe";
import type { StripeProvider, CancelResult } from "../stripe/types";
import { ProviderStateError } from "../stripe/types";
import { fakeStripeProvider, reset as resetFakeStripe, capturedPayments, capturedFees, cancelledPayments, refundedPayments, feeRefunded, refundRequests, captureCalls, holdNextCapture, releaseHeldCaptures, setAuthorizedAmount, setNextCaptureFailure, setNextCaptureAppliedFailure, setNextIdempotencyConflict, setNextCancelFailure, setNextRefundFailure, setCancelUnexpectedState, scriptRetrieveStatuses, setNextRefundStatus, setRefundStatus } from "../stripe/fake";
import { SYSTEM_ACTOR_ID, SYSTEM_ACTOR_EMAIL } from "../system-actor";

const hasDb = !!process.env.DATABASE_URL;

describe("sortPickListLines (pure)", () => {
  it("sorts non-frozen first, perishable second, frozen last", () => {
    const lines = [
      { id: "1", frozen: true, perishable: false, name: "Frozen fish" },
      { id: "2", frozen: false, perishable: true, name: "Fresh spinach" },
      { id: "3", frozen: false, perishable: false, name: "Rice" },
      { id: "4", frozen: true, perishable: false, name: "Frozen prawns" },
      { id: "5", frozen: false, perishable: true, name: "Tomatoes" },
    ];
    const sorted = sortPickListLines(lines);
    expect(sorted.map((l) => l.name)).toEqual([
      "Rice",
      "Fresh spinach",
      "Tomatoes",
      "Frozen fish",
      "Frozen prawns",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(sortPickListLines([])).toEqual([]);
  });

  it("pickup fulfills to awaiting pickup and delivery fulfills to ready", () => {
    expect(fulfilledStatus("pickup")).toBe("AWAITING_PICKUP");
    expect(fulfilledStatus("delivery")).toBe("READY");
  });

  it("does not mutate the original array", () => {
    const lines = [
      { id: "1", frozen: true, perishable: false },
      { id: "2", frozen: false, perishable: false },
    ];
    const sorted = sortPickListLines(lines);
    expect(sorted[0].id).toBe("2");
    expect(lines[0].id).toBe("1");
  });
});

describe.skipIf(!hasDb)("Order service (database)", () => {
  let rawPrisma: PrismaClient;
  let storeId: string;
  let storeBId: string;
  let customerId: string;
  let variantId: string;
  let variantFrozenId: string;
  let variantPerishId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    setStripeProvider(fakeStripeProvider);

    const store = await rawPrisma.store.upsert({
      where: { slug: "order-svc-test" },
      update: { stripeAccountId: "acct_test_order_svc" },
      create: {
        slug: "order-svc-test",
        name: "Order Service Test Store",
        themePreset: "palm-and-shea",
        prepTimeMinutes: 25,
        stripeAccountId: "acct_test_order_svc",
      },
    });
    storeId = store.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "order-svc-test-b" },
      update: { stripeAccountId: "acct_test_order_svc_b" },
      create: {
        slug: "order-svc-test-b",
        name: "Order Service Test Store B",
        themePreset: "lagoon-and-coral",
        prepTimeMinutes: 30,
        stripeAccountId: "acct_test_order_svc_b",
      },
    });
    storeBId = storeB.id;

    const scoped = storeScoped(storeId);

    const listing = await scoped.listing.create({
      data: {
        storeId,
        customName: "Test Product",
        price: 1000,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const v = await scoped.listingVariant.create({
      data: { listingId: listing.id, label: "500g", price: 1000, weightG: 500 },
    });
    variantId = v.id;

    const frozenListing = await scoped.listing.create({
      data: {
        storeId,
        customName: "Frozen Fish",
        price: 2000,
        stockMode: "unlimited",
        frozen: true,
        perishable: false,
      },
    });
    const vf = await scoped.listingVariant.create({
      data: { listingId: frozenListing.id, label: "1kg", price: 2000, weightG: 1000 },
    });
    variantFrozenId = vf.id;

    const perishListing = await scoped.listing.create({
      data: {
        storeId,
        customName: "Fresh Spinach",
        price: 500,
        stockMode: "unlimited",
        frozen: false,
        perishable: true,
      },
    });
    const vp = await scoped.listingVariant.create({
      data: { listingId: perishListing.id, label: "bunch", price: 500, weightG: 200 },
    });
    variantPerishId = vp.id;

    const cust = await scoped.customer.create({
      data: {
        storeId,
        name: "Order Test Customer",
        email: "order-test@example.com",
        phone: "+15551112222",
      },
    });
    customerId = cust.id;
  });

  afterAll(async () => {
    setStripeProvider(null);
    const storeIds = [storeId, storeBId];
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.auditLog.deleteMany({ where: { storeId: { in: storeIds } } }),
      rawPrisma.stockEvent.deleteMany({ where: { storeId: { in: storeIds } } }),
      rawPrisma.orderLine.deleteMany({ where: { storeId: { in: storeIds } } }),
      rawPrisma.order.deleteMany({ where: { storeId: { in: storeIds } } }),
      rawPrisma.customer.deleteMany({ where: { storeId: { in: storeIds } } }),
      rawPrisma.listingVariant.deleteMany({ where: { listing: { storeId: { in: storeIds } } } }),
      rawPrisma.listing.deleteMany({ where: { storeId: { in: storeIds } } }),
    ]);
    await rawPrisma.store.deleteMany({ where: { slug: { in: ["order-svc-test", "order-svc-test-b"] } } });
    await rawPrisma.$disconnect();
  });

  let orderSeq = 90000;
  async function createTestOrder(
    status: string = "AUTHORIZED",
    opts?: { tipCents?: number; deliveryFeeCents?: number; fulfillment?: "pickup" | "delivery" },
  ) {
    const num = ++orderSeq;
    const tipCents = opts?.tipCents ?? 0;
    const deliveryFeeCents = opts?.deliveryFeeCents ?? 0;
    // Lines: 2x1000 + 1x2000 + 3x500 = 5500
    const subtotalCents = 5500;
    const bufferCents = 550;
    const totalAuthorizedCents = subtotalCents + bufferCents + tipCents + deliveryFeeCents;
    const order = await storeScopedTransaction(storeId, async (tx) => {
      const order = await tx.order.create({
        data: {
          storeId,
          number: num,
          customerId,
          status,
          fulfillment: opts?.fulfillment ?? "pickup",
          subtotalCents,
          bufferCents,
          tipCents,
          deliveryFeeCents,
          totalAuthorizedCents,
          totalCents: subtotalCents,
          paymentIntentId: `pi_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        },
      });
      await tx.orderLine.create({
        data: {
          storeId,
          orderId: order.id,
          listingVariantId: variantId,
          qtyOrdered: 2,
          unitPriceCents: 1000,
        },
      });
      await tx.orderLine.create({
        data: {
          storeId,
          orderId: order.id,
          listingVariantId: variantFrozenId,
          qtyOrdered: 1,
          unitPriceCents: 2000,
        },
      });
      await tx.orderLine.create({
        data: {
          storeId,
          orderId: order.id,
          listingVariantId: variantPerishId,
          qtyOrdered: 3,
          unitPriceCents: 500,
        },
      });
      return order;
    });
    if (order.paymentIntentId) {
      setAuthorizedAmount(order.paymentIntentId, order.totalAuthorizedCents);
    }
    return order;
  }

  async function pickingBelowMinimum() {
    const num = ++orderSeq;
    const paymentIntentId = `pi_void_${num}_${Date.now()}`;
    const order = await storeScopedTransaction(storeId, async (tx) => {
      const created = await tx.order.create({
        data: {
          storeId,
          number: num,
          customerId,
          status: "AUTHORIZED",
          fulfillment: "pickup",
          subtotalCents: 30,
          bufferCents: 10,
          tipCents: 0,
          deliveryFeeCents: 0,
          totalAuthorizedCents: 40,
          totalCents: 30,
          paymentIntentId,
        },
      });
      await tx.orderLine.create({
        data: {
          storeId,
          orderId: created.id,
          listingVariantId: variantId,
          qtyOrdered: 1,
          unitPriceCents: 30,
        },
      });
      return created;
    });
    setAuthorizedAmount(paymentIntentId, 40);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) await markLinePicked(storeId, line.id);
    return order;
  }

  async function decoyAudit(orderId: string, action: string, after: Record<string, unknown> = {}) {
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: SYSTEM_ACTOR_ID,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action,
          entityType: "listing",
          entityId: orderId,
          after: after as object,
        },
      });
    });
  }

  beforeEach(() => {
    setStripeProvider(fakeStripeProvider);
    resetFakeStripe();
  });

  it("acceptOrder transitions AUTHORIZED -> ACCEPTED", async () => {
    const order = await createTestOrder();
    const result = await acceptOrder(storeId, order.id, 20);
    expect(result.ok).toBe(true);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("ACCEPTED");
    expect(updated!.prepEstimateMinutes).toBe(20);
    expect(updated!.acceptedAt).toBeTruthy();
  });

  it("acceptOrder rejects wrong status", async () => {
    const order = await createTestOrder("ACCEPTED");
    const result = await acceptOrder(storeId, order.id, 20);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Cannot accept");
    }
  });

  it("acceptOrder rejects wrong store (real store isolation)", async () => {
    const order = await createTestOrder();
    const result = await acceptOrder(storeBId, order.id, 20);
    expect(result.ok).toBe(false);
  });

  it("markLinePicked sets qtyPicked and stays at PICKING even when all lines resolved", async () => {
    const order = await createTestOrder();
    await acceptOrder(storeId, order.id, 15);

    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    expect(lines.length).toBe(3);

    const r1 = await markLinePicked(storeId, lines[0].id);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.orderStatus).toBe("PICKING");

    const r2 = await markLinePicked(storeId, lines[1].id);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.orderStatus).toBe("PICKING");

    const r3 = await markLinePicked(storeId, lines[2].id);
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.orderStatus).toBe("PICKING");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("PICKING");
    expect(updated!.readyAt).toBeNull();
  });

  it("markLinePicked rejects line from wrong status order", async () => {
    const order = await createTestOrder();
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    const result = await markLinePicked(storeId, lines[0].id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Cannot pick");
  });

  it("completePickup completes an order awaiting pickup once", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }
    await markReady(storeId, order.id);

    const result = await completePickup(storeId, order.id);
    expect(result.ok).toBe(true);
    const again = await completePickup(storeId, order.id);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toBe("Order is not awaiting pickup");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("COMPLETED");
    expect(updated!.completedAt).toBeTruthy();
  }, 10_000);

  it("completePickup rejects wrong status", async () => {
    const order = await createTestOrder();
    const result = await completePickup(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Order is not awaiting pickup");
  });

  it("markReady rejects when lines are unresolved", async () => {
    const order = await createTestOrder();
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    await markLinePicked(storeId, lines[0].id);

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unresolved");
    }
    expect(capturedPayments.size).toBe(0);
  });

  it("markReady succeeds and captures correct amount (lines + tip + delivery)", async () => {
    const order = await createTestOrder("AUTHORIZED", { tipCents: 200, deliveryFeeCents: 300 });
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 2x1000 + 1x2000 + 3x500 = 5500 lines + 200 tip + 300 delivery = 6000
      expect(result.capturedAmountCents).toBe(6000);
      expect(result.voided).toBeUndefined();
    }

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("AWAITING_PICKUP");
    expect(updated!.readyAt).toBeTruthy();
    expect(updated!.capturedAmountCents).toBe(6000);

    expect(capturedPayments.get(order.paymentIntentId!)).toBe(6000);
    // 2.9% + 30¢ of 6000 = 204, plus the $3 delivery fee.
    expect(capturedFees.get(order.paymentIntentId!)).toBe(504);
    expect(updated!.platformFeeCents).toBe(204);
  });

  it("markReady rejects when capture would exceed authorized amount", async () => {
    // Create order with very low authorized amount
    const num = ++orderSeq;
    const order = await storeScopedTransaction(storeId, async (tx) => {
      const o = await tx.order.create({
        data: {
          storeId,
          number: num,
          customerId,
          status: "AUTHORIZED",
          fulfillment: "pickup",
          subtotalCents: 1000,
          bufferCents: 0,
          tipCents: 0,
          deliveryFeeCents: 0,
          totalAuthorizedCents: 100, // way too low
          totalCents: 1000,
          paymentIntentId: `pi_test_cap_${Date.now()}`,
        },
      });
      await tx.orderLine.create({
        data: {
          storeId,
          orderId: o.id,
          listingVariantId: variantId,
          qtyOrdered: 2,
          unitPriceCents: 1000,
        },
      });
      return o;
    });

    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("exceeds authorized");
    }
    expect(capturedPayments.size).toBe(0);
  });

  it("markReady rejects order not in PICKING status", async () => {
    const order = await createTestOrder();
    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Cannot mark ready");
    }
  });

  it("markReady rejects when called from wrong store (real store isolation)", async () => {
    const order = await createTestOrder();
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }
    const result = await markReady(storeBId, order.id);
    expect(result.ok).toBe(false);
  });

  it("autoCancelOrder cancels AUTHORIZED order and voids payment", async () => {
    const order = await createTestOrder();

    const result = await autoCancelOrder(storeId, order.id);
    expect(result.ok).toBe(true);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.cancelledAt).toBeTruthy();

    expect(cancelledPayments.has(order.paymentIntentId!)).toBe(true);
  });

  it("M3: autoCancelOrder does NOT create cancel_restore StockEvents (stock not reserved at checkout, see #141)", async () => {
    const order = await createTestOrder();

    const beforeCount = await storeScoped(storeId).stockEvent.count({
      where: { type: "cancel_restore" },
    });

    await autoCancelOrder(storeId, order.id);

    const afterCount = await storeScoped(storeId).stockEvent.count({
      where: { type: "cancel_restore" },
    });
    expect(afterCount).toBe(beforeCount);
  });

  it("autoCancelOrder creates auto_cancel AuditLog entry", async () => {
    const order = await createTestOrder();

    await autoCancelOrder(storeId, order.id);

    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "auto_cancel" },
    });
    expect(logs.length).toBe(1);
    expect(logs[0].actorId).toBe(SYSTEM_ACTOR_ID);
    expect(logs[0].entityType).toBe("order");
  });

  it("the auto-cancel timer finishing a below-minimum void records void_zero_amount", async () => {
    const order = await pickingBelowMinimum();
    setNextCancelFailure(order.paymentIntentId!, 1);

    const ready = await markReady(storeId, order.id);
    expect(ready.ok).toBe(false);
    const mid = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(mid!.status).toBe("CANCELLING");
    expect(mid!.acceptedAt).not.toBeNull();

    const timer = await autoCancelOrder(storeId, order.id);
    expect(timer).toEqual({ ok: true });
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.capturedAmountCents).toBeNull();
    expect(cancelledPayments.has(order.paymentIntentId!)).toBe(true);
    const voids = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "void_zero_amount" },
    });
    const autos = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "auto_cancel" },
    });
    expect(voids).toHaveLength(1);
    expect(autos).toHaveLength(0);
  });

  it("timer wins an in-flight staff void without relabelling or duplicating its audit", async () => {
    const order = await pickingBelowMinimum();
    let releaseStaff!: (value: CancelResult) => void;
    const staffHeld = new Promise<CancelResult>((resolve) => {
      releaseStaff = resolve;
    });
    let staffEntered!: () => void;
    const staffEnteredGate = new Promise<void>((resolve) => {
      staffEntered = resolve;
    });
    let calls = 0;
    const deferredProvider: StripeProvider = {
      ...fakeStripeProvider,
      cancelPaymentIntent: async (paymentIntentId, idempotencyKey) => {
        calls += 1;
        // Hold only the staff void. The timer must cancel and commit on its own call.
        if (calls === 1) {
          staffEntered();
          return staffHeld;
        }
        return fakeStripeProvider.cancelPaymentIntent(paymentIntentId, idempotencyKey);
      },
    };
    setStripeProvider(deferredProvider);
    let staffReleased = false;
    const finishStaff = () => {
      if (staffReleased) return;
      staffReleased = true;
      releaseStaff({ paymentIntentId: order.paymentIntentId!, status: "canceled" });
    };
    const readyPromise = markReady(storeId, order.id);
    try {
      await staffEnteredGate;
      const claimed = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(claimed!.status).toBe("CANCELLING");
      expect(claimed!.acceptedAt).not.toBeNull();

      const timer = await autoCancelOrder(storeId, order.id);
      expect(timer).toEqual({ ok: true });
      const committed = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(committed!.status).toBe("CANCELLED");
      expect(committed!.capturedAmountCents).toBeNull();
      expect(cancelledPayments.has(order.paymentIntentId!)).toBe(true);
      const beforeStaff = await storeScoped(storeId).auditLog.findMany({
        where: {
          entityId: order.id,
          action: { in: ["void_zero_amount", "auto_cancel", "reconcile_cancel", "anomaly_refund", "capture_released"] },
        },
      });
      expect(beforeStaff.map((row) => row.action)).toEqual(["void_zero_amount"]);

      finishStaff();
      const ready = await readyPromise;
      expect(ready.ok).toBe(true);
      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("CANCELLED");
      expect(updated!.capturedAmountCents).toBeNull();
      const completion = await storeScoped(storeId).auditLog.findMany({
        where: {
          entityId: order.id,
          action: { in: ["void_zero_amount", "auto_cancel", "reconcile_cancel", "anomaly_refund", "capture_released"] },
        },
      });
      expect(completion.map((row) => row.action)).toEqual(["void_zero_amount"]);
    } finally {
      finishStaff();
      await readyPromise.catch(() => undefined);
      setStripeProvider(fakeStripeProvider);
    }
  }, 10_000);

  it("resuming a staff void without a PaymentIntent retains its action", async () => {
    const order = await pickingBelowMinimum();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING", paymentIntentId: null },
      });
    });
    const cancel = vi.spyOn(fakeStripeProvider, "cancelPaymentIntent");
    const result = await autoCancelOrder(storeId, order.id);
    expect(result).toEqual({ ok: true });
    expect(cancel).not.toHaveBeenCalled();
    cancel.mockRestore();
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.capturedAmountCents).toBeNull();
    const voids = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "void_zero_amount" },
    });
    const autos = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "auto_cancel" },
    });
    expect(voids).toHaveLength(1);
    expect(autos).toHaveLength(0);
  });

  it("non-order audit rows do not control order retries or cancellation dedupe", async () => {
    const decoy = await createTestOrder("CANCELLING");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: decoy.id }, data: { acceptedAt: new Date() } });
    });
    setAuthorizedAmount(decoy.paymentIntentId!, decoy.totalAuthorizedCents);
    await decoyAudit(decoy.id, "cancel_retry", { attempt: 9, inFlight: true });
    await decoyAudit(decoy.id, "void_zero_amount");
    const cancel = vi.spyOn(fakeStripeProvider, "cancelPaymentIntent");
    const finished = await autoCancelOrder(storeId, decoy.id);
    expect(finished).toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledWith(decoy.paymentIntentId, `cancel:${decoy.id}:1`);
    cancel.mockRestore();
    const voids = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: decoy.id, action: "void_zero_amount", entityType: "order" },
    });
    expect(voids).toHaveLength(1);
    const retries = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: decoy.id, action: "cancel_retry", entityType: "order" },
    });
    expect(retries.map((row) => (row.after as { attempt?: number }).attempt)).toContain(1);
    expect(retries.some((row) => (row.after as { attempt?: number }).attempt === 9)).toBe(false);

    const governed = await createTestOrder("CANCELLING");
    setAuthorizedAmount(governed.paymentIntentId!, governed.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: SYSTEM_ACTOR_ID,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: "cancel_retry",
          entityType: "order",
          entityId: governed.id,
          after: { attempt: 1 },
        },
      });
    });
    await decoyAudit(governed.id, "cancel_retry", { attempt: 1, inFlight: true });
    const nextKey = vi.spyOn(fakeStripeProvider, "cancelPaymentIntent");
    const governedResult = await autoCancelOrder(storeId, governed.id);
    expect(governedResult).toEqual({ ok: true });
    expect(nextKey).toHaveBeenCalledWith(governed.paymentIntentId, `cancel:${governed.id}:2`);
    nextKey.mockRestore();
    const governedAudits = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: governed.id, action: "auto_cancel", entityType: "order" },
    });
    expect(governedAudits).toHaveLength(1);
    const again = await autoCancelOrder(storeId, governed.id);
    expect(again.ok).toBe(false);
    const stillOne = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: governed.id, action: "auto_cancel", entityType: "order" },
    });
    expect(stillOne).toHaveLength(1);

    const refundOrder = await createTestOrder();
    const pi = refundOrder.paymentIntentId!;
    setAuthorizedAmount(pi, refundOrder.totalAuthorizedCents);
    await fakeStripeProvider.capturePaymentIntent(pi, refundOrder.totalAuthorizedCents, `cap-decoy-${refundOrder.id}`);
    const refund = await fakeStripeProvider.refundPayment(pi, refundOrder.totalAuthorizedCents, `ref-decoy-${refundOrder.id}`);
    setRefundStatus(refund.refundId, "failed");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: refundOrder.id },
        data: { status: "CANCELLING", capturedAmountCents: null, refundId: refund.refundId },
      });
    });
    await decoyAudit(refundOrder.id, "refund_failed", { refundId: refund.refundId });
    expect(await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: refund.refundId,
      refundStatus: "failed",
    })).toEqual({ ok: true, action: "refund_failed" });
    const failures = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: refundOrder.id, action: "refund_failed", entityType: "order" },
    });
    expect(failures).toHaveLength(1);
    expect(await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: refund.refundId,
      refundStatus: "failed",
    })).toEqual({ ok: true, action: "already_recorded" });
    const failuresAgain = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: refundOrder.id, action: "refund_failed", entityType: "order" },
    });
    expect(failuresAgain).toHaveLength(1);

    const collision = await createTestOrder("CANCELLING");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: collision.id }, data: { acceptedAt: new Date() } });
    });
    setAuthorizedAmount(collision.paymentIntentId!, collision.totalAuthorizedCents);
    setNextCancelFailure(collision.paymentIntentId!, 1);
    let releaseCancel!: () => void;
    const cancelGate = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let cancelEntered!: () => void;
    const cancelEnteredGate = new Promise<void>((resolve) => {
      cancelEntered = resolve;
    });
    const cancelKeys: string[] = [];
    const heldProvider: StripeProvider = {
      ...fakeStripeProvider,
      cancelPaymentIntent: async (paymentIntentId, idempotencyKey) => {
        cancelKeys.push(idempotencyKey ?? "");
        if (cancelKeys.length === 1) {
          cancelEntered();
          await cancelGate;
        }
        return fakeStripeProvider.cancelPaymentIntent(paymentIntentId, idempotencyKey);
      },
    };
    setStripeProvider(heldProvider);
    let cancelReleased = false;
    const finishCancel = () => {
      if (cancelReleased) return;
      cancelReleased = true;
      releaseCancel();
    };
    const firstPromise = autoCancelOrder(storeId, collision.id);
    try {
      await cancelEnteredGate;
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.auditLog.create({
          data: {
            storeId,
            actorId: SYSTEM_ACTOR_ID,
            actorEmail: SYSTEM_ACTOR_EMAIL,
            action: "cancel_retry",
            entityType: "listing",
            entityId: collision.id,
            after: { attempt: 9, inFlight: true },
            createdAt: new Date(Date.now() + 60_000),
          },
        });
      });
      finishCancel();
      const first = await firstPromise;
      expect(first.ok).toBe(false);
      expect(cancelKeys).toEqual([`cancel:${collision.id}:1`]);
      const released = await storeScoped(storeId).auditLog.findMany({
        where: { entityId: collision.id, action: "cancel_retry", entityType: "order" },
      });
      expect(released.some((row) => {
        const after = row.after as { attempt?: number; inFlight?: boolean } | null;
        return after?.attempt === 1 && after.inFlight === false;
      })).toBe(true);
      const second = await autoCancelOrder(storeId, collision.id);
      expect(second).toEqual({ ok: true });
      expect(cancelKeys[1]).toBe(`cancel:${collision.id}:2`);
    } finally {
      finishCancel();
      await firstPromise.catch(() => undefined);
      setStripeProvider(fakeStripeProvider);
    }
    const collisionOrder = await storeScoped(storeId).order.findUnique({ where: { id: collision.id } });
    expect(collisionOrder!.status).toBe("CANCELLED");
    expect(collisionOrder!.capturedAmountCents).toBeNull();
    const collisionVoids = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: collision.id, action: "void_zero_amount", entityType: "order" },
    });
    expect(collisionVoids).toHaveLength(1);
    const listingStillHeld = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: collision.id, action: "cancel_retry", entityType: "listing" },
    });
    expect(listingStillHeld.some((row) => {
      const after = row.after as { attempt?: number; inFlight?: boolean } | null;
      return after?.attempt === 9 && after.inFlight === true;
    })).toBe(true);
  });

  it("autoCancelOrder rejects non-AUTHORIZED order", async () => {
    const order = await createTestOrder();
    await acceptOrder(storeId, order.id, 15);

    const result = await autoCancelOrder(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not AUTHORIZED");
    }
    expect(cancelledPayments.size).toBe(0);
  });

  it("autoCancelOrder rejects wrong store (real store isolation)", async () => {
    const order = await createTestOrder();
    const result = await autoCancelOrder(storeBId, order.id);
    expect(result.ok).toBe(false);
  });

  it("markReady: Stripe failure leaves order in CAPTURING (retryable)", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }

    const failProvider: StripeProvider = {
      ...fakeStripeProvider,
      async capturePaymentIntent() {
        throw new Error("Stripe API timeout");
      },
    };
    setStripeProvider(failProvider);

    await expect(markReady(storeId, order.id)).rejects.toThrow("Stripe API timeout");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CAPTURING");
  });

  it("autoCancelOrder: Stripe failure leaves order in CANCELLING (retryable)", async () => {
    const order = await createTestOrder();

    const failProvider: StripeProvider = {
      ...fakeStripeProvider,
      async cancelPaymentIntent() {
        throw new Error("Stripe API timeout");
      },
    };
    setStripeProvider(failProvider);

    await expect(autoCancelOrder(storeId, order.id)).rejects.toThrow("Stripe API timeout");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLING");
    expect(updated!.cancelledAt).toBeNull();
    expect(cancelledPayments.size).toBe(0);
  });

  it("acceptOrder rejects CANCELLING order (A1 race fix)", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLING" } });
    });
    const result = await acceptOrder(storeId, order.id, 15);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("CANCELLING");
  });

  it("autoCancelOrder retries from CANCELLING state (idempotent retry)", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLING" } });
    });
    const result = await autoCancelOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
  });

  it("completePickup refuses a pickup order in READY", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "READY", readyAt: new Date() } });
    });
    const result = await completePickup(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Order is not awaiting pickup");
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("READY");
  });

  it("F3: completePickup rejects delivery order in READY status", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "READY", readyAt: new Date(), fulfillment: "delivery" },
      });
    });
    const result = await completePickup(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("delivery");
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("READY");
  });

  it("K3: markReady voids authorization when final amount is zero (all lines refunded)", { timeout: 10_000 }, async () => {
    const order = await createTestOrder();
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    // Pick one line to enter PICKING, then refund all lines
    await markLinePicked(storeId, lines[0].id);
    for (const line of lines) {
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.orderLine.update({
          where: { id: line.id },
          data: { status: "refunded", qtyPicked: 0 },
        });
      });
    }

    const beforeCount = await storeScoped(storeId).stockEvent.count({
      where: { type: "cancel_restore" },
    });

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.capturedAmountCents).toBe(0);
      expect(result.voided).toBe(true);
    }

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.capturedAmountCents).toBeNull();
    expect(updated!.cancelledAt).toBeTruthy();
    expect(cancelledPayments.has(order.paymentIntentId!)).toBe(true);
    expect(capturedPayments.size).toBe(0);

    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "void_zero_amount" },
    });
    expect(logs.length).toBe(1);

    // M3: void path must NOT create cancel_restore stock events (stock not reserved at checkout, see #141)
    const afterCount = await storeScoped(storeId).stockEvent.count({
      where: { type: "cancel_restore" },
    });
    expect(afterCount).toBe(beforeCount);
  });

  it("K3: markReady voids authorization when final amount is below Stripe minimum (50 cents USD)", async () => {
    // Create order with a single cheap line
    const num = ++orderSeq;
    const order = await storeScopedTransaction(storeId, async (tx) => {
      const o = await tx.order.create({
        data: {
          storeId,
          number: num,
          customerId,
          status: "AUTHORIZED",
          fulfillment: "pickup",
          subtotalCents: 30,
          bufferCents: 10,
          tipCents: 0,
          deliveryFeeCents: 0,
          totalAuthorizedCents: 40,
          totalCents: 30,
          paymentIntentId: `pi_test_min_${Date.now()}`,
        },
      });
      await tx.orderLine.create({
        data: {
          storeId,
          orderId: o.id,
          listingVariantId: variantId,
          qtyOrdered: 1,
          unitPriceCents: 30,
        },
      });
      return o;
    });
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);

    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.capturedAmountCents).toBe(0);
      expect(result.voided).toBe(true);
    }

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(cancelledPayments.has(order.paymentIntentId!)).toBe(true);
    expect(capturedPayments.size).toBe(0);
  });

  it("Codex-4: void path sets CANCELLING, blocking concurrent markReady", async () => {
    const order = await createTestOrder();
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    // Refund all lines so captured amount = 0 (below Stripe minimum)
    await markLinePicked(storeId, lines[0].id);
    for (const line of lines) {
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.orderLine.update({
          where: { id: line.id },
          data: { status: "refunded", qtyPicked: 0 },
        });
      });
    }

    // Deferred cancel: Phase 1 commits CANCELLING, then blocks on Stripe
    let resolveCancel!: (v: CancelResult) => void;
    const cancelDeferred = new Promise<CancelResult>((res) => { resolveCancel = res; });
    const deferredProvider: StripeProvider = {
      ...fakeStripeProvider,
      cancelPaymentIntent: () => cancelDeferred,
    };
    setStripeProvider(deferredProvider);

    const readyPromise = markReady(storeId, order.id);

    // Poll until Phase 1 commits CANCELLING
    let mid;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      mid = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      if (mid!.status === "CANCELLING") break;
    }
    expect(mid!.status).toBe("CANCELLING");

    // Concurrent markReady must fail because status is CANCELLING
    setStripeProvider(fakeStripeProvider);
    const concurrent = await markReady(storeId, order.id);
    expect(concurrent.ok).toBe(false);
    if (!concurrent.ok) expect(concurrent.error).toContain("CANCELLING");

    // Let the deferred cancel complete
    resolveCancel({ paymentIntentId: order.paymentIntentId!, status: "canceled" });
    const result = await readyPromise;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.capturedAmountCents).toBe(0);

    // Final state: CANCELLED with audit log
    const final = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(final!.status).toBe("CANCELLED");
    expect(final!.cancelledAt).toBeTruthy();

    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "void_zero_amount" },
    });
    expect(logs.length).toBe(1);
  }, 10_000);

  it("Codex-4: void finalization skips CANCELLED write when status changed mid-flight", async () => {
    const order = await createTestOrder();
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    await markLinePicked(storeId, lines[0].id);
    for (const line of lines) {
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.orderLine.update({
          where: { id: line.id },
          data: { status: "refunded", qtyPicked: 0 },
        });
      });
    }

    let resolveCancel!: (v: CancelResult) => void;
    const cancelDeferred = new Promise<CancelResult>((res) => { resolveCancel = res; });
    const deferredProvider: StripeProvider = {
      ...fakeStripeProvider,
      cancelPaymentIntent: () => cancelDeferred,
    };
    setStripeProvider(deferredProvider);

    const readyPromise = markReady(storeId, order.id);

    // Wait for Phase 1 to commit CANCELLING
    let mid;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 50));
      mid = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      if (mid!.status === "CANCELLING") break;
    }
    expect(mid!.status).toBe("CANCELLING");

    // Externally change status away from CANCELLING before Phase 3 runs
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "AUTHORIZED" },
      });
    });

    // Resolve Stripe cancel so Phase 3 runs
    resolveCancel({ paymentIntentId: order.paymentIntentId!, status: "canceled" });
    setStripeProvider(fakeStripeProvider);
    const result = await readyPromise;
    expect(result.ok).toBe(true);

    // Phase 3 guard saw status != CANCELLING, so order stayed AUTHORIZED (not CANCELLED)
    const final = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(final!.status).toBe("AUTHORIZED");
    expect(final!.cancelledAt).toBeNull();
  });

  it("K2: accept-during-cancel race — accept fails while cancel is in-flight", async () => {
    const order = await createTestOrder();

    let resolveCancel!: (v: CancelResult) => void;
    const cancelDeferred = new Promise<CancelResult>((res) => { resolveCancel = res; });
    const deferredProvider: StripeProvider = {
      ...fakeStripeProvider,
      cancelPaymentIntent: () => cancelDeferred,
    };
    setStripeProvider(deferredProvider);

    // Start autoCancelOrder — it will set CANCELLING in Phase 1, then block on Stripe
    const cancelPromise = autoCancelOrder(storeId, order.id);

    // Give Phase 1 time to commit CANCELLING
    let mid;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      mid = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      if (mid!.status === "CANCELLING") break;
    }
    expect(mid!.status).toBe("CANCELLING");

    // Attempt to accept mid-flight — must fail because status is CANCELLING
    setStripeProvider(fakeStripeProvider);
    const acceptResult = await acceptOrder(storeId, order.id, 15);
    expect(acceptResult.ok).toBe(false);
    if (!acceptResult.ok) expect(acceptResult.error).toContain("CANCELLING");

    // Resolve the deferred Stripe cancel so autoCancelOrder can finalize
    resolveCancel({ paymentIntentId: order.paymentIntentId!, status: "canceled" });
    const cancelResult = await cancelPromise;
    expect(cancelResult.ok).toBe(true);

    // Final state: CANCELLED, payment voided, never ACCEPTED
    const final = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(final!.status).toBe("CANCELLED");
    expect(final!.cancelledAt).toBeTruthy();
    expect(final!.acceptedAt).toBeNull();
  });

  it("markReady rejects a second call once the order has left picking", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }

    const r1 = await markReady(storeId, order.id);
    expect(r1.ok).toBe(true);

    // Fake provider returns already-captured for the same PI, so the call doesn't fail.
    // But markReady checks order status, so it rejects at the DB level (not PICKING).
    const r2 = await markReady(storeId, order.id);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toContain("Cannot mark ready");
  });

  // ── K1: reconcileStuckOrder tests ────────────────────────────────

  it("K1: sweep finalizes CAPTURING order when Stripe already captured (Phase 2 response lost)", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }

    // Simulate: Phase 1 set CAPTURING and capturedAmountCents, Phase 2 captured on Stripe
    // but the response was lost (Phase 3 never ran).
    const capturedAmount = 5500;
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CAPTURING", capturedAmountCents: capturedAmount },
      });
    });
    // Mark the PI as captured in fake Stripe
    capturedPayments.set(order.paymentIntentId!, capturedAmount);

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("finalized_capture");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("AWAITING_PICKUP");
    expect(updated!.readyAt).toBeTruthy();
    expect(updated!.capturedAmountCents).toBe(capturedAmount);

    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "reconcile_capture" },
    });
    expect(logs.length).toBe(1);
  });

  it("K1: sweep finalizes CAPTURING order when Phase 3 DB failure (Stripe succeeded)", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }

    // Simulate: Phase 1 + Phase 2 succeeded, but Phase 3 DB update failed.
    // Order is stuck in CAPTURING. Stripe has the captured payment.
    const capturedAmount = 5500;
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CAPTURING", capturedAmountCents: capturedAmount },
      });
    });
    capturedPayments.set(order.paymentIntentId!, capturedAmount);

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("finalized_capture");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("AWAITING_PICKUP");
  });

  it("K1: sweep retries capture when Stripe still requires_capture (CAPTURING)", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }

    const capturedAmount = 5500;
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CAPTURING", capturedAmountCents: capturedAmount },
      });
    });
    // Stripe still has requires_capture (no capturedPayments entry)

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("finalized_capture");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("AWAITING_PICKUP");
    expect(capturedPayments.has(order.paymentIntentId!)).toBe(true);
  });

  it("K1: retry capture from UI (markReady on CAPTURING order)", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }

    const capturedAmount = 5500;
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CAPTURING", capturedAmountCents: capturedAmount },
      });
    });

    // UI calls markReady on a CAPTURING order — Phase 1 resumes the capture already in flight
    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.capturedAmountCents).toBe(capturedAmount);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("AWAITING_PICKUP");
  });

  it("K1: sweep twice on same order is a no-op", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }

    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CAPTURING", capturedAmountCents: 5500 },
      });
    });
    capturedPayments.set(order.paymentIntentId!, 5500);

    const r1 = await reconcileStuckOrder(storeId, order.id);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.action).toBe("finalized_capture");

    const r2 = await reconcileStuckOrder(storeId, order.id);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.action).toBe("already_resolved");

    // Only one audit log
    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "reconcile_capture" },
    });
    expect(logs.length).toBe(1);
  }, 10_000);

  it("K1: sweep finalizes CANCELLING order when Stripe already canceled", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING" },
      });
    });
    cancelledPayments.add(order.paymentIntentId!);

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("finalized_cancel");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.cancelledAt).toBeTruthy();

    // M3: no cancel_restore stock events (stock not reserved at checkout, see #141)

    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "reconcile_cancel" },
    });
    expect(logs.length).toBe(1);
  });

  it("K1: sweep retries cancel when Stripe still requires_capture (CANCELLING)", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING" },
      });
    });
    // Stripe still has requires_capture (cancel didn't go through)

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("finalized_cancel");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(cancelledPayments.has(order.paymentIntentId!)).toBe(true);
  });

  it("M1: CANCELLING + Stripe succeeded issues full refund and anomaly_refund audit", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING" },
      });
    });
    capturedPayments.set(order.paymentIntentId!, 5000);
    setAuthorizedAmount(order.paymentIntentId!, 5000);

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("anomaly_refund");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.cancelledAt).toBeTruthy();

    expect(refundedPayments.get(order.paymentIntentId!)).toBe(5000);

    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "anomaly_refund" },
    });
    expect(logs.length).toBe(1);
    expect(logs[0].actorId).toBe(SYSTEM_ACTOR_ID);
  });

  it("M1: CANCELLING + Stripe succeeded refund is idempotent (no second refund on re-run)", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING" },
      });
    });
    capturedPayments.set(order.paymentIntentId!, 5000);
    setAuthorizedAmount(order.paymentIntentId!, 5000);

    const r1 = await reconcileStuckOrder(storeId, order.id);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.action).toBe("anomaly_refund");

    // Second run: order is now CANCELLED, so reconcile returns already_resolved
    const r2 = await reconcileStuckOrder(storeId, order.id);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.action).toBe("already_resolved");

    // Only one refund call (fake returns same result on duplicate, but order status blocks re-entry)
    expect(refundedPayments.get(order.paymentIntentId!)).toBe(5000);

    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "anomaly_refund" },
    });
    expect(logs.length).toBe(1);
  });

  it("Codex-2: CANCELLING + Stripe succeeded but refund fails does not finalize CANCELLED", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING" },
      });
    });
    capturedPayments.set(order.paymentIntentId!, 5000);
    setAuthorizedAmount(order.paymentIntentId!, 5000);
    setNextRefundStatus(order.paymentIntentId!, "failed");

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(false);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("REFUND_FAILED");
    const alerts = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "refund_failed" },
    });
    expect(alerts.length).toBe(1);
  });

  it("Codex-1/C4: CANCELLING + Stripe succeeded but refund pending does not finalize CANCELLED", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING" },
      });
    });
    capturedPayments.set(order.paymentIntentId!, 5000);
    setAuthorizedAmount(order.paymentIntentId!, 5000);
    setNextRefundStatus(order.paymentIntentId!, "pending");

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("pending");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLING");
  });

  it("Codex-1/C4: CANCELLING + Stripe succeeded but refund requires_action does not finalize CANCELLED", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING" },
      });
    });
    capturedPayments.set(order.paymentIntentId!, 5000);
    setAuthorizedAmount(order.paymentIntentId!, 5000);
    setNextRefundStatus(order.paymentIntentId!, "requires_action");

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("requires_action");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLING");
  });

  // ── M2: Persist Stripe's amount_received, clear capturedAmountCents on cancel ──

  it("M2: markReady persists Stripe amount_received, not requested amount", async () => {
    const order = await createTestOrder("AUTHORIZED", { tipCents: 200, deliveryFeeCents: 300 });
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }

    // Simulate: a prior markReady attempt captured at Stripe but Phase 3 DB write failed.
    // Pre-capture through the fake with the same idempotency key markReady will use,
    // at a slightly different amount (e.g., rounding) to verify we persist Stripe's actual amount.
    const stripeActual = 5900;
    await fakeStripeProvider.capturePaymentIntent(order.paymentIntentId!, stripeActual, `capture:${order.id}`);

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.capturedAmountCents).toBe(stripeActual);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.capturedAmountCents).toBe(stripeActual);
  });

  it("M2: autoCancelOrder sets capturedAmountCents to null", async () => {
    const order = await createTestOrder();
    await autoCancelOrder(storeId, order.id);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.capturedAmountCents).toBeNull();
  });

  it("M2: sweep cancel clears capturedAmountCents", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CAPTURING", capturedAmountCents: 5500 },
      });
    });
    // Stripe canceled (edge: capture attempted but Stripe declined)
    cancelledPayments.add(order.paymentIntentId!);

    await reconcileStuckOrder(storeId, order.id);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.capturedAmountCents).toBeNull();
  });

  it("M2: sweep retry capture persists Stripe amount_received", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }

    const capturedAmount = 5500;
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CAPTURING", capturedAmountCents: capturedAmount },
      });
    });
    // Stripe still requires_capture — sweep will retry and capture returns capturedAmount

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("AWAITING_PICKUP");
    expect(updated!.capturedAmountCents).toBe(capturedAmount);
  });

  // --- P1: ProviderStateError — never finalize on contradicting Stripe status ---

  it("P1: markReady capture finds PI canceled → CANCELLED + audit + staff error", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) await markLinePicked(storeId, line.id);

    // Simulate: PI was canceled externally before markReady captures
    cancelledPayments.add(order.paymentIntentId!);

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/authorization expired|voided|cancelled/i);
    }

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.capturedAmountCents).toBeNull();

    const audit = await storeScoped(storeId).auditLog.findFirst({
      where: { entityId: order.id, action: "capture_on_canceled_pi" },
    });
    expect(audit).toBeTruthy();
  });

  it("P1: markReady void path finds PI succeeded → refund + CANCELLED + audit", async () => {
    // Create an order with lines that total below minimum to trigger void path
    const num = ++orderSeq;
    const order = await storeScopedTransaction(storeId, async (tx) => {
      const o = await tx.order.create({
        data: {
          storeId,
          number: num,
          customerId,
          status: "PICKING",
          fulfillment: "pickup",
          subtotalCents: 10,
          bufferCents: 0,
          tipCents: 0,
          deliveryFeeCents: 0,
          totalAuthorizedCents: 100,
          totalCents: 10,
          paymentIntentId: `pi_void_pse_${Date.now()}`,
        },
      });
      await tx.orderLine.create({
        data: {
          storeId,
          orderId: o.id,
          listingVariantId: variantId,
          qtyOrdered: 1,
          unitPriceCents: 10,
          status: "picked",
          qtyPicked: 1,
        },
      });
      return o;
    });

    setAuthorizedAmount(order.paymentIntentId!, 100);
    // Simulate: PI was captured externally so cancel throws ProviderStateError
    capturedPayments.set(order.paymentIntentId!, 100);

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.voided).toBe(true);
      expect(result.capturedAmountCents).toBe(0);
    }

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");

    expect(refundedPayments.has(order.paymentIntentId!)).toBe(true);

    const audit = await storeScoped(storeId).auditLog.findFirst({
      where: { entityId: order.id, action: "anomaly_refund" },
    });
    expect(audit).toBeTruthy();
  });

  it("P1: autoCancelOrder cancel finds PI succeeded → refund + CANCELLED + anomaly_refund audit", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);

    // Simulate: PI was captured externally before autoCancel
    capturedPayments.set(order.paymentIntentId!, 5500);

    const result = await autoCancelOrder(storeId, order.id);
    expect(result.ok).toBe(true);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.capturedAmountCents).toBeNull();

    expect(refundedPayments.has(order.paymentIntentId!)).toBe(true);

    const audit = await storeScoped(storeId).auditLog.findFirst({
      where: { entityId: order.id, action: "anomaly_refund" },
    });
    expect(audit).toBeTruthy();
  });

  it("autoCancel refunds only the amount still unrefunded after an external partial refund", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    const captured = order.totalAuthorizedCents;
    await fakeStripeProvider.capturePaymentIntent(pi, captured, "external-capture");
    await fakeStripeProvider.refundPayment(pi, 200, "external-partial");

    const result = await autoCancelOrder(storeId, order.id);
    expect(result.ok).toBe(true);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(refundedPayments.get(pi)).toBe(captured);
    expect(refundRequests.at(-1)).toMatchObject({
      paymentIntentId: pi,
      amountCents: captured - 200,
      refundApplicationFee: true,
    });
  });

  it("reconcile refunds only the amount still unrefunded after an external partial refund", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    const captured = order.totalAuthorizedCents;
    await fakeStripeProvider.capturePaymentIntent(pi, captured, "external-capture");
    await fakeStripeProvider.refundPayment(pi, 200, "external-partial");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLING" } });
    });

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(refundedPayments.get(pi)).toBe(captured);
    expect(refundRequests.at(-1)).toMatchObject({
      paymentIntentId: pi,
      amountCents: captured - 200,
      refundApplicationFee: true,
    });
  });

  it.skipIf(!process.env.STRIPE_SECRET_KEY)(
    "sandbox: autoCancel refunds the remainder after an external partial refund",
    async () => {
      const Stripe = (await import("stripe")).default;
      const { stripeProvider } = await import("../stripe/provider");
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      let accountId = "";
      for await (const acct of stripe.accounts.list({ limit: 100 })) {
        if (acct.capabilities?.transfers === "active") {
          accountId = acct.id;
          break;
        }
      }
      expect(accountId).toBeTruthy();

      const created = await stripe.paymentIntents.create({
        amount: 1000,
        currency: "usd",
        capture_method: "manual",
        on_behalf_of: accountId,
        transfer_data: { destination: accountId },
      });
      const confirmed = await stripe.paymentIntents.confirm(created.id, {
        payment_method: "pm_card_visa",
        return_url: "https://example.com/return",
      });
      expect(confirmed.status).toBe("requires_capture");
      await stripe.paymentIntents.capture(created.id, {
        amount_to_capture: 1000,
        application_fee_amount: 100,
      });
      await stripe.refunds.create({
        payment_intent: created.id,
        amount: 200,
        reverse_transfer: true,
        refund_application_fee: true,
      });

      const order = await createTestOrder();
      await storeScoped(storeId).order.update({
        where: { id: order.id },
        data: { paymentIntentId: created.id },
      });
      setStripeProvider(stripeProvider);
      try {
        const result = await autoCancelOrder(storeId, order.id);
        expect(result.ok).toBe(true);
        const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
        expect(updated!.status).toBe("CANCELLED");
        const after = await stripe.paymentIntents.retrieve(created.id, { expand: ["latest_charge"] });
        const charge = after.latest_charge;
        expect(charge && typeof charge !== "string").toBe(true);
        if (charge && typeof charge !== "string") {
          expect(charge.amount).toBe(1000);
          expect(charge.amount_refunded).toBe(1000);
        }
      } finally {
        setStripeProvider(fakeStripeProvider);
        const leftover = await stripe.paymentIntents.retrieve(created.id, { expand: ["latest_charge"] });
        const charge = leftover.latest_charge;
        if (charge && typeof charge !== "string") {
          const rest = (charge.amount ?? 0) - (charge.amount_refunded ?? 0);
          if (rest > 0) {
            await stripe.refunds.create({
              payment_intent: created.id,
              amount: rest,
              reverse_transfer: true,
              refund_application_fee: true,
            });
          }
        }
      }
    },
    60_000,
  );

  it("duplicate autoCancel while a refund is pending stays CANCELLING with the real refund id", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    await fakeStripeProvider.capturePaymentIntent(pi, order.totalAuthorizedCents, "external-capture");
    setNextRefundStatus(pi, "pending");

    const first = await autoCancelOrder(storeId, order.id);
    expect(first.ok).toBe(false);
    const afterFirst = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(afterFirst!.status).toBe("CANCELLING");
    expect(afterFirst!.refundId).toMatch(/^re_fake_/);

    const second = await autoCancelOrder(storeId, order.id);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/pending/i);
    const afterSecond = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(afterSecond!.status).toBe("CANCELLING");
    expect(afterSecond!.refundId).toBe(afterFirst!.refundId);
  });

  it("reconcile recovers a cleared pending refund id and stays CANCELLING", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    await fakeStripeProvider.capturePaymentIntent(pi, order.totalAuthorizedCents, "external-capture");
    setNextRefundStatus(pi, "pending");
    await autoCancelOrder(storeId, order.id);
    const saved = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    const realRefundId = saved!.refundId;
    expect(realRefundId).toMatch(/^re_fake_/);

    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { refundId: null } });
    });

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(false);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLING");
    expect(updated!.refundId).toBe(realRefundId);
  });

  it("a succeeded refund settles the cancellation", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    await fakeStripeProvider.capturePaymentIntent(pi, order.totalAuthorizedCents, "external-capture");
    setNextRefundStatus(pi, "pending");
    const first = await autoCancelOrder(storeId, order.id);
    expect(first.ok).toBe(false);
    const saved = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    setRefundStatus(saved!.refundId!, "succeeded");

    const second = await autoCancelOrder(storeId, order.id);
    expect(second.ok).toBe(true);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.refundId).toBe(saved!.refundId);
  });

  it("autoCancel stays CANCELLING while a partial refund is still pending", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "external-capture");
    setNextRefundStatus(pi, "pending");
    await fakeStripeProvider.refundPayment(pi, 300, "external-partial");

    const result = await autoCancelOrder(storeId, order.id);
    expect(result.ok).toBe(false);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLING");
    const listed = await fakeStripeProvider.listRefunds(pi);
    expect(listed[0]?.status).toBe("pending");
    expect(updated!.refundId).toBe(listed[0]?.refundId);
  });

  it("reconcile stays CANCELLING when a saved refund succeeded and another is pending", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "external-capture");
    setNextRefundStatus(pi, "pending");
    const first = await fakeStripeProvider.refundPayment(pi, 300, "partial-a");
    const second = await fakeStripeProvider.refundPayment(pi, 700, "partial-b");
    setRefundStatus(second.refundId, "pending");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING", refundId: null },
      });
    });

    const listed = await reconcileStuckOrder(storeId, order.id);
    expect(listed.ok).toBe(false);
    const saved = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(saved!.status).toBe("CANCELLING");
    const pendingLeft = saved!.refundId === first.refundId ? second.refundId : first.refundId;
    setRefundStatus(saved!.refundId!, "succeeded");

    const again = await reconcileStuckOrder(storeId, order.id);
    expect(again.ok).toBe(false);
    const midway = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(midway!.status).toBe("CANCELLING");
    expect(midway!.refundId).toBe(pendingLeft);

    setRefundStatus(pendingLeft, "succeeded");
    const done = await reconcileStuckOrder(storeId, order.id);
    expect(done.ok).toBe(true);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
  });

  it.skipIf(!process.env.STRIPE_SECRET_KEY)(
    "sandbox: a pending refund stays CANCELLING on a duplicate cancel and a lost refund id",
    async () => {
      const Stripe = (await import("stripe")).default;
      const { stripeProvider } = await import("../stripe/provider");
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
      let accountId = "";
      for await (const acct of stripe.accounts.list({ limit: 100 })) {
        if (acct.capabilities?.transfers === "active") {
          accountId = acct.id;
          break;
        }
      }
      expect(accountId).toBeTruthy();

      const created = await stripe.paymentIntents.create({
        amount: 1000,
        currency: "usd",
        capture_method: "manual",
        on_behalf_of: accountId,
        transfer_data: { destination: accountId },
      });
      const confirmed = await stripe.paymentIntents.confirm(created.id, {
        payment_method: "pm_card_pendingRefund",
        return_url: "https://example.com/return",
      });
      expect(confirmed.status).toBe("requires_capture");
      await stripe.paymentIntents.capture(created.id, {
        amount_to_capture: 1000,
        application_fee_amount: 100,
      });

      const order = await createTestOrder();
      await storeScoped(storeId).order.update({
        where: { id: order.id },
        data: { paymentIntentId: created.id },
      });
      setStripeProvider(stripeProvider);
      try {
        const first = await autoCancelOrder(storeId, order.id);
        expect(first.ok).toBe(false);
        if (!first.ok) expect(first.error).toMatch(/pending/i);
        const afterFirst = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
        expect(afterFirst!.status).toBe("CANCELLING");
        expect(afterFirst!.refundId).toMatch(/^re_/);
        expect(afterFirst!.refundId).not.toMatch(/^re_external_/);
        const pending = await stripe.refunds.retrieve(afterFirst!.refundId!);
        expect(pending.status).toBe("pending");

        const second = await autoCancelOrder(storeId, order.id);
        expect(second.ok).toBe(false);
        if (!second.ok) expect(second.error).toMatch(/pending/i);
        const afterSecond = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
        expect(afterSecond!.status).toBe("CANCELLING");
        expect(afterSecond!.refundId).toBe(afterFirst!.refundId);
        const stillPending = await stripe.refunds.retrieve(afterFirst!.refundId!);
        expect(stillPending.status).toBe("pending");

        await storeScoped(storeId).order.update({
          where: { id: order.id },
          data: { refundId: null },
        });
        const recovered = await reconcileStuckOrder(storeId, order.id);
        expect(recovered.ok).toBe(false);
        const afterRecover = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
        expect(afterRecover!.status).toBe("CANCELLING");
        expect(afterRecover!.refundId).toBe(afterFirst!.refundId);
        const listed = await stripe.refunds.retrieve(afterRecover!.refundId!);
        expect(listed.status).toBe("pending");
      } finally {
        setStripeProvider(fakeStripeProvider);
      }
    },
    90_000,
  );

  it("P1: sweep retry capture on canceled PI → CANCELLED", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);

    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CAPTURING", capturedAmountCents: 5500 },
      });
    });
    // PI was canceled externally
    cancelledPayments.add(order.paymentIntentId!);

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.capturedAmountCents).toBeNull();
  });

  it("P1: sweep retry cancel on captured PI → refund + CANCELLED", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);

    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING" },
      });
    });
    // PI was captured externally — cancel will throw ProviderStateError
    capturedPayments.set(order.paymentIntentId!, 5500);

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");

    expect(refundedPayments.has(order.paymentIntentId!)).toBe(true);
  });

  // --- P3: Refund persistence — persist refundId, retrieve on retry ---

  it("P3: sweep pending refund persists refundId on order, stays CANCELLING", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING" },
      });
    });
    capturedPayments.set(order.paymentIntentId!, 5000);
    setAuthorizedAmount(order.paymentIntentId!, 5000);
    setNextRefundStatus(order.paymentIntentId!, "pending");

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("pending");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLING");
    expect(updated!.refundId).toBe(`re_fake_${order.paymentIntentId}`);
  });

  it("P3: sweep retry with stored refundId uses retrieveRefund (pending→succeeded)", async () => {
    const order = await createTestOrder();
    const refundId = `re_fake_${order.paymentIntentId}`;
    // Simulate: first sweep already created a pending refund and stored its id
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING", refundId },
      });
    });
    capturedPayments.set(order.paymentIntentId!, 5000);
    setAuthorizedAmount(order.paymentIntentId!, 5000);
    setNextRefundStatus(order.paymentIntentId!, "pending");
    await fakeStripeProvider.refundPayment(order.paymentIntentId!, 5000, `refund:${order.id}`);
    setRefundStatus(refundId, "succeeded");

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("anomaly_refund");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.refundId).toBe(refundId);
  });

  it("P3: sweep succeeded refund persists refundId on CANCELLED order", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING" },
      });
    });
    capturedPayments.set(order.paymentIntentId!, 5000);
    setAuthorizedAmount(order.paymentIntentId!, 5000);

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("anomaly_refund");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.refundId).toBe(`re_fake_${order.paymentIntentId}`);
  });

  it("P3: autoCancelOrder ProviderStateError pending refund persists refundId", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    capturedPayments.set(order.paymentIntentId!, 5500);
    setNextRefundStatus(order.paymentIntentId!, "pending");

    const result = await autoCancelOrder(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("pending");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLING");
    expect(updated!.refundId).toBe(`re_fake_${order.paymentIntentId}`);
  });

  it("P3: autoCancelOrder ProviderStateError succeeded refund persists refundId on CANCELLED", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    capturedPayments.set(order.paymentIntentId!, 5500);

    const result = await autoCancelOrder(storeId, order.id);
    expect(result.ok).toBe(true);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.refundId).toBe(`re_fake_${order.paymentIntentId}`);
  });

  it("P3: markReady void ProviderStateError refund persists refundId on CANCELLED", async () => {
    const num = ++orderSeq;
    const order = await storeScopedTransaction(storeId, async (tx) => {
      const o = await tx.order.create({
        data: {
          storeId,
          number: num,
          customerId,
          status: "PICKING",
          fulfillment: "pickup",
          subtotalCents: 10,
          bufferCents: 0,
          tipCents: 0,
          deliveryFeeCents: 0,
          totalAuthorizedCents: 100,
          totalCents: 10,
          paymentIntentId: `pi_void_p3_${Date.now()}`,
        },
      });
      await tx.orderLine.create({
        data: {
          storeId,
          orderId: o.id,
          listingVariantId: variantId,
          qtyOrdered: 1,
          unitPriceCents: 10,
          status: "picked",
          qtyPicked: 1,
        },
      });
      return o;
    });

    setAuthorizedAmount(order.paymentIntentId!, 100);
    capturedPayments.set(order.paymentIntentId!, 100);

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(true);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.refundId).toBe(`re_fake_${order.paymentIntentId}`);
  });

  it("B2: markReady void path failed refund moves to REFUND_FAILED", async () => {
    const num = ++orderSeq;
    const order = await storeScopedTransaction(storeId, async (tx) => {
      const o = await tx.order.create({
        data: {
          storeId,
          number: num,
          customerId,
          status: "PICKING",
          fulfillment: "pickup",
          subtotalCents: 10,
          bufferCents: 0,
          tipCents: 0,
          deliveryFeeCents: 0,
          totalAuthorizedCents: 100,
          totalCents: 10,
          paymentIntentId: `pi_void_b2_${Date.now()}`,
        },
      });
      await tx.orderLine.create({
        data: {
          storeId,
          orderId: o.id,
          listingVariantId: variantId,
          qtyOrdered: 1,
          unitPriceCents: 10,
          status: "picked",
          qtyPicked: 1,
        },
      });
      return o;
    });

    setAuthorizedAmount(order.paymentIntentId!, 100);
    capturedPayments.set(order.paymentIntentId!, 100);
    setNextRefundStatus(order.paymentIntentId!, "failed");

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(false);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("REFUND_FAILED");
    expect(updated!.refundId).toBe(`re_fake_${order.paymentIntentId}`);
  });

  it("B2: markReady void path pending refund stays CANCELLING for sweep retry", async () => {
    const num = ++orderSeq;
    const order = await storeScopedTransaction(storeId, async (tx) => {
      const o = await tx.order.create({
        data: {
          storeId,
          number: num,
          customerId,
          status: "PICKING",
          fulfillment: "pickup",
          subtotalCents: 10,
          bufferCents: 0,
          tipCents: 0,
          deliveryFeeCents: 0,
          totalAuthorizedCents: 100,
          totalCents: 10,
          paymentIntentId: `pi_void_b2p_${Date.now()}`,
        },
      });
      await tx.orderLine.create({
        data: {
          storeId,
          orderId: o.id,
          listingVariantId: variantId,
          qtyOrdered: 1,
          unitPriceCents: 10,
          status: "picked",
          qtyPicked: 1,
        },
      });
      return o;
    });

    setAuthorizedAmount(order.paymentIntentId!, 100);
    capturedPayments.set(order.paymentIntentId!, 100);
    setNextRefundStatus(order.paymentIntentId!, "pending");

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(false);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLING");
    expect(updated!.refundId).toBe(`re_fake_${order.paymentIntentId}`);
  });

  it("P3: sweep requires_capture cancel ProviderStateError pending refund persists refundId", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING" },
      });
    });
    // PI still requires_capture, but cancel throws ProviderStateError because
    // it was captured between retrieve and cancel
    const captureAmount = 5500;

    // Use a custom provider that returns requires_capture on retrieve
    // but throws ProviderStateError on cancel (simulating race)
    let cancelCalled = false;
    const raceProvider: StripeProvider = {
      ...fakeStripeProvider,
      async retrievePaymentIntent(piId) {
        if (!cancelCalled) {
          return { paymentIntentId: piId, status: "requires_capture", amountCapturable: captureAmount, amountReceived: 0 };
        }
        return { paymentIntentId: piId, status: "succeeded", amountCapturable: 0, amountReceived: captureAmount };
      },
      async cancelPaymentIntent() {
        cancelCalled = true;
        throw new ProviderStateError("cancel", "succeeded");
      },
      async refundPayment(piId, amount, key, options) {
        capturedPayments.set(piId, captureAmount);
        setNextRefundStatus(piId, "pending");
        return fakeStripeProvider.refundPayment(piId, amount, key, options);
      },
    };
    setStripeProvider(raceProvider);

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("pending");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLING");
    expect(updated!.refundId).toBe(`re_fake_${order.paymentIntentId}`);
  });

  it("full cancellation refunds the application fee", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    capturedPayments.set(order.paymentIntentId!, 5500);
    capturedFees.set(order.paymentIntentId!, 190);

    const result = await autoCancelOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    expect(refundRequests.at(-1)?.refundApplicationFee).toBe(true);
    expect(feeRefunded.get(order.paymentIntentId!)).toBe(190);
  });

  it("markReady for a delivery order captures and lands on READY", async () => {
    const order = await createTestOrder("AUTHORIZED", { fulfillment: "delivery" });
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) await markLinePicked(storeId, line.id);

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(true);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("READY");
    expect(updated!.readyAt).toBeTruthy();
    expect(capturedPayments.get(order.paymentIntentId!)).toBe(5500);
  });

  it("markReady rejects a short line and does not call Stripe", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.orderLine.update({
        where: { id: lines[0].id },
        data: { status: "short", qtyPicked: 0 },
      });
      for (const line of lines.slice(1)) {
        await tx.orderLine.update({
          where: { id: line.id },
          data: { status: "picked", qtyPicked: line.qtyOrdered },
        });
      }
      await tx.order.update({ where: { id: order.id }, data: { status: "PICKING" } });
    });

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(false);
    expect(capturedPayments.has(order.paymentIntentId!)).toBe(false);
  });

  it("markReady captures picked and substituted lines and skips refunded lines", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
      orderBy: { unitPriceCents: "asc" },
    });
    // 500*2 picked substitute qty, 1000 refunded, 2000 picked full.
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.orderLine.update({
        where: { id: lines[0].id },
        data: { status: "substituted", qtyPicked: 2 },
      });
      await tx.orderLine.update({
        where: { id: lines[1].id },
        data: { status: "refunded", qtyPicked: 0 },
      });
      await tx.orderLine.update({
        where: { id: lines[2].id },
        data: { status: "picked", qtyPicked: lines[2].qtyOrdered },
      });
      await tx.order.update({ where: { id: order.id }, data: { status: "PICKING" } });
    });

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.capturedAmountCents).toBe(2 * 500 + 1 * 2000);
  });

  async function expireCaptureBackoff(orderId: string) {
    await backdateCaptureAttempt(orderId, 20 * 60_000);
  }

  async function backdateCaptureAttempt(orderId: string, ageMs: number) {
    await platformAdminTransaction(async (tx) => {
      await tx.auditLog.updateMany({
        where: { entityId: orderId, action: "capture_retry" },
        data: { createdAt: new Date(Date.now() - ageMs) },
      });
    });
  }

  it("capture backoff refuses attempt 2 at 29 seconds and allows it at 30", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    setNextCaptureFailure(pi, 1);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) await markLinePicked(storeId, line.id);

    const first = await markReady(storeId, order.id);
    expect(first.ok).toBe(false);
    await backdateCaptureAttempt(order.id, 29_000);
    const tooSoon = await markReady(storeId, order.id);
    expect(tooSoon.ok).toBe(false);
    if (!tooSoon.ok) expect(tooSoon.error).toMatch(/^Retrying in \d+ min$/);
    expect(captureCalls.filter((key) => key.startsWith(`capture:${order.id}:`))).toEqual([
      `capture:${order.id}:1`,
    ]);

    await backdateCaptureAttempt(order.id, 30_000);
    const second = await markReady(storeId, order.id);
    expect(second.ok).toBe(true);
    expect(captureCalls.filter((key) => key === `capture:${order.id}:2`)).toEqual([
      `capture:${order.id}:2`,
    ]);
  });

  it("capture backoff is capped at 15 minutes", async () => {
    const order = await createTestOrder("CAPTURING");
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { capturedAmountCents: order.totalCents },
      });
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: SYSTEM_ACTOR_ID,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: "capture_retry",
          entityType: "order",
          entityId: order.id,
          after: { attempt: 10 },
        },
      });
    });

    await backdateCaptureAttempt(order.id, 14 * 60_000);
    const tooSoon = await markReady(storeId, order.id);
    expect(tooSoon.ok).toBe(false);
    if (!tooSoon.ok) expect(tooSoon.error).toMatch(/^Retrying in \d+ min$/);
    expect(captureCalls.filter((key) => key.startsWith(`capture:${order.id}:`))).toEqual([]);

    await backdateCaptureAttempt(order.id, 15 * 60_000);
    const allowed = await markReady(storeId, order.id);
    expect(allowed.ok).toBe(true);
    expect(captureCalls.filter((key) => key === `capture:${order.id}:2`)).toEqual([
      `capture:${order.id}:2`,
    ]);
  });

  it("idempotency_key_in_use returns pending without a reconcile_failed row", async () => {
    const order = await createTestOrder("CAPTURING");
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { capturedAmountCents: order.totalCents },
      });
    });
    setNextIdempotencyConflict(pi);
    const { recordReconcileResult } = await import("../inngest/functions");
    await recordReconcileResult(storeId, order.id);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CAPTURING");
    expect(captureCalls.filter((key) => key.startsWith(`capture:${order.id}:`))).toEqual([
      `capture:${order.id}:1`,
    ]);
    expect(
      await storeScoped(storeId).auditLog.count({
        where: { entityId: order.id, action: "capture_retry" },
      }),
    ).toBe(2);
    expect(
      await storeScoped(storeId).auditLog.count({
        where: { entityId: order.id, action: "reconcile_failed" },
      }),
    ).toBe(0);

    await recordReconcileResult(storeId, order.id);
    expect(captureCalls.filter((key) => key.startsWith(`capture:${order.id}:`))).toEqual([
      `capture:${order.id}:1`,
    ]);
    expect(
      await storeScoped(storeId).auditLog.count({
        where: { entityId: order.id, action: "reconcile_failed" },
      }),
    ).toBe(0);
  });

  it("a capture 409 keeps the same key after the backoff expires", async () => {
    const order = await createTestOrder("CAPTURING");
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { capturedAmountCents: order.totalCents },
      });
    });
    setNextIdempotencyConflict(pi);
    await recordReconcileResult(storeId, order.id);
    await backdateCaptureAttempt(order.id, 31_000);
    await recordReconcileResult(storeId, order.id);
    expect(captureCalls.filter((key) => key.startsWith(`capture:${order.id}:`))).toEqual([
      `capture:${order.id}:1`,
      `capture:${order.id}:1`,
    ]);
  });

  it("a capture 500 then a later attempt succeeds", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    setNextCaptureFailure(order.paymentIntentId!, 1);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) await markLinePicked(storeId, line.id);

    const first = await markReady(storeId, order.id);
    expect(first.ok).toBe(false);
    const mid = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(mid!.status).toBe("CAPTURING");

    const blocked = await markReady(storeId, order.id);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/^Retrying in \d+ min$/);
    expect(capturedPayments.has(order.paymentIntentId!)).toBe(false);

    await expireCaptureBackoff(order.id);
    const second = await markReady(storeId, order.id);
    expect(second.ok).toBe(true);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("AWAITING_PICKUP");
  });

  it("repeated capture 500s release the hold", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    setNextCaptureFailure(order.paymentIntentId!, 10);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) await markLinePicked(storeId, line.id);

    const first = await markReady(storeId, order.id);
    expect(first.ok).toBe(false);
    for (let i = 0; i < 4; i++) {
      await expireCaptureBackoff(order.id);
      await markReady(storeId, order.id);
    }

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(capturedPayments.has(order.paymentIntentId!)).toBe(false);
    expect(cancelledPayments.has(order.paymentIntentId!)).toBe(true);
    const released = await storeScoped(storeId).auditLog.findFirst({
      where: { entityId: order.id, action: "capture_released" },
    });
    expect(released).not.toBeNull();
    expect((released!.after as { alert: string }).alert).toBe("store_and_platform");
  });

  it("a failed release after five captures does not charge a sixth time", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    setNextCaptureFailure(pi, 5);
    setNextCancelFailure(pi, 1);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) await markLinePicked(storeId, line.id);

    expect((await markReady(storeId, order.id)).ok).toBe(false);
    for (let i = 0; i < 4; i++) {
      await expireCaptureBackoff(order.id);
      await markReady(storeId, order.id);
    }
    const stuck = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(stuck!.status).toBe("CAPTURING");
    expect(captureCalls.filter((key) => key.startsWith(`capture:${order.id}:`))).toEqual([
      `capture:${order.id}:1`,
      `capture:${order.id}:2`,
      `capture:${order.id}:3`,
      `capture:${order.id}:4`,
      `capture:${order.id}:5`,
    ]);

    await expireCaptureBackoff(order.id);
    const again = await markReady(storeId, order.id);
    expect(again.ok).toBe(false);
    expect(captureCalls.filter((key) => key.startsWith(`capture:${order.id}:`))).toEqual([
      `capture:${order.id}:1`,
      `capture:${order.id}:2`,
      `capture:${order.id}:3`,
      `capture:${order.id}:4`,
      `capture:${order.id}:5`,
    ]);
    expect(capturedPayments.has(pi)).toBe(false);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
  });

  it("two concurrent markReady calls reserve one attempt and capture once", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) await markLinePicked(storeId, line.id);

    const entered = holdNextCapture();
    const first = markReady(storeId, order.id);
    await entered;
    const denied = await markReady(storeId, order.id);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error).toMatch(/^Retrying in \d+ min$/);
    releaseHeldCaptures();
    const winner = await first;
    expect(winner.ok).toBe(true);
    expect(
      await storeScoped(storeId).auditLog.count({
        where: { entityId: order.id, action: "capture_retry" },
      }),
    ).toBe(1);
    expect(captureCalls.filter((key) => key === `capture:${order.id}:1`)).toEqual([
      `capture:${order.id}:1`,
    ]);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("AWAITING_PICKUP");
  });

  it("a fifth 500 after Stripe applied the capture finalizes the capture", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    setNextCaptureFailure(pi, 4);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) await markLinePicked(storeId, line.id);

    await markReady(storeId, order.id);
    for (let i = 0; i < 3; i++) {
      await expireCaptureBackoff(order.id);
      await markReady(storeId, order.id);
    }
    expect(capturedPayments.has(pi)).toBe(false);

    setNextCaptureAppliedFailure(pi, 1);
    await expireCaptureBackoff(order.id);
    const last = await markReady(storeId, order.id);
    expect(last.ok).toBe(true);
    if (last.ok) expect(last.capturedAmountCents).toBe(capturedPayments.get(pi));
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("AWAITING_PICKUP");
    expect(updated!.capturedAmountCents).toBe(capturedPayments.get(pi));
  });

  it("markReady returns the captured amount when a sweep finalizes the fifth attempt", async () => {
    const order = await createTestOrder("CAPTURING");
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { capturedAmountCents: 5500, status: "CAPTURING" },
      });
    });
    await platformAdminTransaction(async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { updatedAt: new Date(Date.now() - 20 * 60_000) },
      });
    });
    await seedFifthCapture(order.id);
    setNextCaptureAppliedFailure(pi, 1);
    const original = fakeStripeProvider.capturePaymentIntent.bind(fakeStripeProvider);
    const spy = vi.spyOn(fakeStripeProvider, "capturePaymentIntent").mockImplementation(async (...args) => {
      try {
        return await original(...args);
      } catch (err) {
        await reconcileStuckOrder(storeId, order.id);
        throw err;
      }
    });
    try {
      const result = await markReady(storeId, order.id);
      expect(result).toEqual({ ok: true, capturedAmountCents: 5500 });
      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("AWAITING_PICKUP");
      expect(updated!.capturedAmountCents).toBe(5500);
    } finally {
      spy.mockRestore();
    }
  });

  it("a fifth capture error reports the cancelled message when the order is already cancelled", async () => {
    const order = await createTestOrder("CAPTURING");
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { capturedAmountCents: 5500, status: "CAPTURING" },
      });
    });
    await seedFifthCapture(order.id);
    setNextCaptureFailure(pi, 1);
    const original = fakeStripeProvider.capturePaymentIntent.bind(fakeStripeProvider);
    const spy = vi.spyOn(fakeStripeProvider, "capturePaymentIntent").mockImplementation(async (...args) => {
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
      });
      return original(...args);
    });
    try {
      const result = await markReady(storeId, order.id);
      expect(result).toEqual({
        ok: false,
        error: "Payment authorization was released — order cancelled; contact the customer",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("review186 fifth-error COMPLETED without stored capture is refused", async () => {
    const order = await createTestOrder("CAPTURING");
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { capturedAmountCents: 5500 },
      });
    });
    await seedFifthCapture(order.id);
    setNextCaptureAppliedFailure(pi, 1);
    const original = fakeStripeProvider.capturePaymentIntent.bind(fakeStripeProvider);
    const spy = vi.spyOn(fakeStripeProvider, "capturePaymentIntent").mockImplementation(async (...args) => {
      try {
        return await original(...args);
      } catch (err) {
        await storeScopedTransaction(storeId, async (tx) => {
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: "COMPLETED",
              capturedAmountCents: null,
              completedAt: new Date(),
            },
          });
        });
        throw err;
      }
    });
    try {
      expect(await markReady(storeId, order.id)).toEqual({
        ok: false,
        error: "Order status changed during capture",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("a fifth applied failure keeps a completed order's stored partial amount", async () => {
    const order = await createTestOrder("CAPTURING");
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { capturedAmountCents: 5500 },
      });
    });
    await seedFifthCapture(order.id);
    setNextCaptureAppliedFailure(pi, 1);
    const original = fakeStripeProvider.capturePaymentIntent.bind(fakeStripeProvider);
    const spy = vi.spyOn(fakeStripeProvider, "capturePaymentIntent").mockImplementation(async (...args) => {
      try {
        return await original(...args);
      } catch (err) {
        await storeScopedTransaction(storeId, async (tx) => {
          await tx.order.update({
            where: { id: order.id },
            data: { status: "COMPLETED", capturedAmountCents: 400, completedAt: new Date() },
          });
        });
        throw err;
      }
    });
    try {
      expect(await markReady(storeId, order.id)).toEqual({ ok: true, capturedAmountCents: 400 });
    } finally {
      spy.mockRestore();
    }
  });

  it("a fifth applied failure returns the stored amount when pickup is already awaiting collection", async () => {
    const order = await createTestOrder("CAPTURING");
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { capturedAmountCents: 5500 },
      });
    });
    await seedFifthCapture(order.id);
    setNextCaptureAppliedFailure(pi, 1);
    const original = fakeStripeProvider.capturePaymentIntent.bind(fakeStripeProvider);
    const spy = vi.spyOn(fakeStripeProvider, "capturePaymentIntent").mockImplementation(async (...args) => {
      try {
        return await original(...args);
      } catch (err) {
        await storeScopedTransaction(storeId, async (tx) => {
          await tx.order.update({
            where: { id: order.id },
            data: { status: "AWAITING_PICKUP", capturedAmountCents: 5500 },
          });
        });
        throw err;
      }
    });
    try {
      expect(await markReady(storeId, order.id)).toEqual({ ok: true, capturedAmountCents: 5500 });
    } finally {
      spy.mockRestore();
    }
  });

  it("a fifth applied failure refuses a ready delivery with no stored amount", async () => {
    const order = await createTestOrder("CAPTURING", { fulfillment: "delivery" });
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { capturedAmountCents: 5500 },
      });
    });
    await seedFifthCapture(order.id);
    setNextCaptureAppliedFailure(pi, 1);
    const original = fakeStripeProvider.capturePaymentIntent.bind(fakeStripeProvider);
    const spy = vi.spyOn(fakeStripeProvider, "capturePaymentIntent").mockImplementation(async (...args) => {
      try {
        return await original(...args);
      } catch (err) {
        await storeScopedTransaction(storeId, async (tx) => {
          await tx.order.update({
            where: { id: order.id },
            data: { status: "READY", capturedAmountCents: null },
          });
        });
        throw err;
      }
    });
    try {
      expect(await markReady(storeId, order.id)).toEqual({
        ok: false,
        error: "Order status changed during capture",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("markReady does not capture zero when a capturing order has no stored amount", async () => {
    const order = await createTestOrder("CAPTURING");
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    const result = await markReady(storeId, order.id);
    expect(result).toEqual({ ok: false, error: "Order status changed during capture" });
    expect(captureCalls.filter((key) => key.startsWith(`capture:${order.id}:`))).toEqual([]);
  });

  it("a sweep does not capture zero when a capturing order has no stored amount", async () => {
    const order = await createTestOrder("CAPTURING");
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result).toEqual({
      ok: false,
      error: "Order status changed during capture",
      waiting: true,
    });
    expect(captureCalls.filter((key) => key.startsWith(`capture:${order.id}:`))).toEqual([]);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CAPTURING");
    expect(updated!.capturedAmountCents).toBeNull();
  });

  async function seedFifthCapture(orderId: string) {
    await storeScopedTransaction(storeId, async (tx) => {
      for (let attempt = 1; attempt <= 4; attempt++) {
        await tx.auditLog.create({
          data: {
            storeId,
            actorId: SYSTEM_ACTOR_ID,
            actorEmail: SYSTEM_ACTOR_EMAIL,
            action: "capture_retry",
            entityType: "order",
            entityId: orderId,
            after: { attempt },
          },
        });
      }
    });
    await expireCaptureBackoff(orderId);
  }

  it("releasing the hold writes capture_released with a store and platform alert before CANCELLED", async () => {
    const order = await createTestOrder("CAPTURING");
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { capturedAmountCents: order.totalAuthorizedCents },
      });
    });
    await seedFifthCapture(order.id);
    setNextCaptureFailure(pi, 1);

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("finalized_cancel");
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    const released = await storeScoped(storeId).auditLog.findFirst({
      where: { entityId: order.id, action: "capture_released" },
    });
    expect((released!.after as { alert: string }).alert).toBe("store_and_platform");
    expect(cancelledPayments.has(pi)).toBe(true);
  });

  it("settle stays pending when the fresh retrieve is neither succeeded nor canceled", async () => {
    const order = await createTestOrder("CAPTURING");
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { capturedAmountCents: order.totalAuthorizedCents },
      });
    });
    await seedFifthCapture(order.id);
    setNextCaptureFailure(pi, 1);
    scriptRetrieveStatuses(pi, ["requires_capture", "requires_capture", "processing"]);
    setCancelUnexpectedState(pi);

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.waiting).toBe(true);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CAPTURING");
    expect(cancelledPayments.has(pi)).toBe(false);
  });

  it("reconcile waits out capture backoff, then a later attempt can succeed", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    setNextCaptureFailure(order.paymentIntentId!, 1);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CAPTURING", capturedAmountCents: 5500 },
      });
    });

    const failed = await reconcileStuckOrder(storeId, order.id);
    expect(failed.ok).toBe(false);
    const tooSoon = await reconcileStuckOrder(storeId, order.id);
    expect(tooSoon.ok).toBe(false);
    if (!tooSoon.ok) expect(tooSoon.error).toBe("capture_backoff");
    expect(capturedPayments.has(order.paymentIntentId!)).toBe(false);

    await platformAdminTransaction(async (tx) => {
      await tx.auditLog.updateMany({
        where: { entityId: order.id, action: "capture_retry" },
        data: { createdAt: new Date(Date.now() - 20 * 60_000) },
      });
    });
    const retried = await reconcileStuckOrder(storeId, order.id);
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.action).toBe("finalized_capture");
  });

  it("a stored 500 on the refund key moves to the next attempt key", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    capturedPayments.set(pi, order.totalAuthorizedCents);
    setNextRefundFailure(pi, 1);

    await expect(autoCancelOrder(storeId, order.id)).rejects.toThrow(/internal server error/i);
    const stuck = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(stuck!.status).toBe("CANCELLING");

    const retried = await autoCancelOrder(storeId, order.id);
    expect(retried.ok).toBe(false);
    const keys = refundRequests
      .filter((request) => request.paymentIntentId === pi)
      .map((request) => request.idempotencyKey);
    expect(keys).toEqual([`refund:${order.id}:1`]);
  });

  it("a stored 500 on the cancel key moves to the next attempt key after a retrieve", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    setNextCancelFailure(order.paymentIntentId!, 1);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLING" } });
    });

    const failed = await reconcileStuckOrder(storeId, order.id);
    expect(failed.ok).toBe(false);
    expect(cancelledPayments.has(order.paymentIntentId!)).toBe(false);

    const retried = await reconcileStuckOrder(storeId, order.id);
    expect(retried.ok).toBe(true);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
  });

  it("webhook refund.failed moves a captured cancellation to REFUND_FAILED and restores the amount", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    await fakeStripeProvider.capturePaymentIntent(pi, order.totalAuthorizedCents, "cap-fail");
    const refund = await fakeStripeProvider.refundPayment(pi, order.totalAuthorizedCents, "ref-fail");
    setRefundStatus(refund.refundId, "failed");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING", capturedAmountCents: null, refundId: refund.refundId },
      });
    });

    const result = await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: refund.refundId,
      refundStatus: "failed",
    });
    expect(result).toEqual({ ok: true, action: "refund_failed" });
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("REFUND_FAILED");
    expect(updated!.refundId).toBe(refund.refundId);
    expect(updated!.capturedAmountCents).toBe(order.totalAuthorizedCents);
  });

  it("webhook refund.canceled moves a captured cancellation to REFUND_FAILED and restores the amount", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    await fakeStripeProvider.capturePaymentIntent(pi, order.totalAuthorizedCents, "cap-cancel");
    const refund = await fakeStripeProvider.refundPayment(pi, order.totalAuthorizedCents, "ref-cancel");
    setRefundStatus(refund.refundId, "canceled");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING", capturedAmountCents: null },
      });
    });

    await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: refund.refundId,
      refundStatus: "canceled",
    });
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("REFUND_FAILED");
    expect(updated!.capturedAmountCents).toBe(order.totalAuthorizedCents);
  });

  it("an uncaptured cancellation ignores refund.failed", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLING", capturedAmountCents: null } });
    });
    const result = await markTerminalRefundFailure({
      paymentIntentId: order.paymentIntentId!,
      refundId: "re_never_captured",
      refundStatus: "failed",
    });
    expect(result).toEqual({ ok: true, action: "ignored" });
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLING");
  });

  it("saves the newest succeeded refund id and the summed amount when two refunds cover the capture", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap");
    const older = await fakeStripeProvider.refundPayment(pi, 400, "older");
    const newer = await fakeStripeProvider.refundPayment(pi, 600, "newer");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLING", capturedAmountCents: 1000 } });
    });

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.refundId).toBe(newer.refundId);
    expect(updated!.refundId).not.toBe(older.refundId);
    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "anomaly_refund" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].after).toMatchObject({ refundId: newer.refundId, amountRefunded: 1000 });
  });

  it("saves the newest refund id when an older succeeded refund id was already stored", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap");
    const older = await fakeStripeProvider.refundPayment(pi, 400, "older");
    const newer = await fakeStripeProvider.refundPayment(pi, 600, "newer");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING", capturedAmountCents: 1000, refundId: older.refundId },
      });
    });

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.refundId).toBe(newer.refundId);
    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "anomaly_refund" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].after).toMatchObject({ refundId: newer.refundId, amountRefunded: 1000 });
  });

  it("sums every succeeded refund when reconciliation creates the remaining refund", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap");
    const older = await fakeStripeProvider.refundPayment(pi, 400, "external");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING", capturedAmountCents: 1000, refundId: null },
      });
    });

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(true);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    const listed = await fakeStripeProvider.listRefunds(pi);
    expect(listed).toHaveLength(2);
    expect(updated!.refundId).toBe(listed[0].refundId);
    expect(updated!.refundId).not.toBe(older.refundId);
    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "anomaly_refund" },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].after).toMatchObject({ refundId: listed[0].refundId, amountRefunded: 1000 });
  });

  it("an in-flight refund key writes no reconcile_failed row and keeps the same key", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING", capturedAmountCents: 1000, refundId: null },
      });
    });
    const original = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
    const keys: string[] = [];
    const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async (paymentIntentId, amount, key, fee) => {
      keys.push(key ?? "");
      if (keys.length === 1) {
        throw Object.assign(new Error("in flight"), { statusCode: 409, code: "idempotency_key_in_use" });
      }
      return original(paymentIntentId, amount, key, fee);
    });
    try {
      await recordReconcileResult(storeId, order.id);
      await recordReconcileResult(storeId, order.id);
      expect(keys[0]).toBe(`refund:${order.id}:1`);
      expect(keys[1]).toBe(keys[0]);
      expect(
        await storeScoped(storeId).auditLog.count({
          where: { entityId: order.id, action: "reconcile_failed" },
        }),
      ).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("a refund 409 followed by a stored 500 uses the next key", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING", capturedAmountCents: 1000, refundId: null },
      });
    });
    setNextRefundFailure(pi, 1);
    const original = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
    const keys: string[] = [];
    const spy = vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async (paymentIntentId, amount, key, fee) => {
      keys.push(key ?? "");
      if (keys.length === 1) {
        throw Object.assign(new Error("in flight"), { statusCode: 409, code: "idempotency_key_in_use" });
      }
      return original(paymentIntentId, amount, key, fee);
    });
    try {
      for (let i = 0; i < 4; i++) {
        try {
          await reconcileStuckOrder(storeId, order.id);
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
        }
      }
      expect(keys.every((key) => key === `refund:${order.id}:1`)).toBe(true);
      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("CANCELLING");
    } finally {
      spy.mockRestore();
    }
  });

  it("a cancel 409 followed by a stored 500 uses the next key", async () => {
    const order = await createTestOrder("CANCELLING");
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    setNextCancelFailure(pi, 1);
    const original = fakeStripeProvider.cancelPaymentIntent.bind(fakeStripeProvider);
    const keys: string[] = [];
    const spy = vi.spyOn(fakeStripeProvider, "cancelPaymentIntent").mockImplementation(async (paymentIntentId, key) => {
      keys.push(key ?? "");
      if (keys.length === 1) {
        throw Object.assign(new Error("in flight"), { statusCode: 409, code: "idempotency_key_in_use" });
      }
      return original(paymentIntentId, key);
    });
    try {
      for (let i = 0; i < 4; i++) {
        await reconcileStuckOrder(storeId, order.id);
      }
      expect(keys).toContain(`cancel:${order.id}:2`);
      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("CANCELLED");
    } finally {
      spy.mockRestore();
    }
  });

  it("an in-flight cancel key writes no reconcile_failed row and keeps the same key", async () => {
    const order = await createTestOrder("CANCELLING");
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    const original = fakeStripeProvider.cancelPaymentIntent.bind(fakeStripeProvider);
    const keys: string[] = [];
    const spy = vi.spyOn(fakeStripeProvider, "cancelPaymentIntent").mockImplementation(async (paymentIntentId, key) => {
      keys.push(key ?? "");
      if (keys.length === 1) {
        throw Object.assign(new Error("in flight"), { statusCode: 409, code: "idempotency_key_in_use" });
      }
      return original(paymentIntentId, key);
    });
    try {
      await recordReconcileResult(storeId, order.id);
      await recordReconcileResult(storeId, order.id);
      expect(keys[0]).toBe(`cancel:${order.id}:1`);
      expect(keys[1]).toBe(keys[0]);
      expect(
        await storeScoped(storeId).auditLog.count({
          where: { entityId: order.id, action: "reconcile_failed" },
        }),
      ).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("reconcile after a restart registers a seeded hold before the first retrieve", async () => {
    const order = await createTestOrder("CAPTURING");
    const seeded = `pi_seed_${order.id}`;
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { paymentIntentId: seeded, capturedAmountCents: 5500 },
      });
    });
    resetFakeStripe();
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CI", "true");
    try {
      const result = await reconcileStuckOrder(storeId, order.id);
      expect(result).toEqual({ ok: true, action: "finalized_capture" });
      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("AWAITING_PICKUP");
      expect(updated!.capturedAmountCents).toBe(5500);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the staff inbox keeps a resolved cancellation and hides a plain one", async () => {
    const shown = await createTestOrder("CANCELLED");
    const hidden = await createTestOrder("CANCELLED");
    const customerNote = await createTestOrder("CANCELLED");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: shown.id }, data: { notes: "Paid by Zelle" } });
      await tx.order.update({ where: { id: customerNote.id }, data: { notes: "Ring the side door" } });
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: SYSTEM_ACTOR_ID,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: "refund_resolved_manually",
          entityType: "order",
          entityId: shown.id,
          after: { note: "Paid by Zelle", alert: "store" },
        },
      });
    });
    const ids = (await getStoreOrders(storeId)).map((row) => row.id);
    expect(ids).toContain(shown.id);
    expect(ids).not.toContain(hidden.id);
    expect(ids).not.toContain(customerNote.id);
  });

  it("a second cancellation writes no extra audit and another store cannot finalize it", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    const cancelled = await autoCancelOrder(storeId, order.id);
    expect(cancelled.ok).toBe(true);
    const once = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(once!.capturedAmountCents).toBeNull();
    expect(
      await storeScoped(storeId).auditLog.count({ where: { entityId: order.id, action: "auto_cancel" } }),
    ).toBe(1);

    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLING", cancelledAt: null } });
    });
    const again = await autoCancelOrder(storeId, order.id);
    expect(again.ok).toBe(true);
    const settled = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(settled!.status).toBe("CANCELLED");
    expect(settled!.capturedAmountCents).toBeNull();
    expect(
      await storeScoped(storeId).auditLog.count({ where: { entityId: order.id, action: "auto_cancel" } }),
    ).toBe(1);

    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLING" } });
    });
    const foreign = await reconcileStuckOrder(storeBId, order.id);
    expect(foreign).toEqual({ ok: true, action: "already_resolved" });
    const untouched = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(untouched!.status).toBe("CANCELLING");
  });

  it("autoCancel registers a seeded hold before the first cancel", async () => {
    const order = await createTestOrder();
    const seeded = `pi_seed_cancel_${order.id}`;
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { paymentIntentId: seeded } });
    });
    resetFakeStripe();
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CI", "true");
    try {
      const result = await autoCancelOrder(storeId, order.id);
      expect(result.ok).toBe(true);
      expect(cancelledPayments.has(seeded)).toBe(true);
      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("CANCELLED");
      expect(updated!.capturedAmountCents).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a below-minimum markReady registers a seeded hold before the void cancel", async () => {
    const order = await createTestOrder("PICKING");
    const seeded = `pi_seed_void_${order.id}`;
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { paymentIntentId: seeded } });
      await tx.orderLine.updateMany({ where: { orderId: order.id }, data: { status: "refunded", qtyPicked: 0 } });
    });
    resetFakeStripe();
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("CI", "true");
    try {
      const result = await markReady(storeId, order.id);
      expect(result).toEqual({ ok: true, capturedAmountCents: 0, voided: true });
      expect(cancelledPayments.has(seeded)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a non-seed unknown PaymentIntent still fails with resource_missing", async () => {
    const order = await createTestOrder("CAPTURING");
    resetFakeStripe();
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    try {
      await expect(reconcileStuckOrder(storeId, order.id)).rejects.toMatchObject({
        code: "resource_missing",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a capture above a seeded order's authorization is rejected", async () => {
    const order = await createTestOrder("CAPTURING");
    const seeded = `pi_seed_over_${order.id}`;
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { paymentIntentId: seeded, totalAuthorizedCents: 100, capturedAmountCents: 5500 },
      });
    });
    resetFakeStripe();
    vi.stubEnv("E2E_FAKE_STRIPE", "1");
    vi.stubEnv("VERCEL", "");
    try {
      await expect(reconcileStuckOrder(storeId, order.id)).rejects.toMatchObject({
        code: "amount_too_large",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a failed refund after a completed cancellation moves the order to REFUND_FAILED", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, 5500);
    await fakeStripeProvider.capturePaymentIntent(pi, 5500, "cap-a1");
    const cancelled = await autoCancelOrder(storeId, order.id);
    expect(cancelled.ok).toBe(true);
    const settled = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(settled!.status).toBe("CANCELLED");
    expect(settled!.capturedAmountCents).toBeNull();
    setRefundStatus(settled!.refundId!, "failed");

    const result = await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: settled!.refundId!,
      refundStatus: "failed",
    });
    expect(result).toEqual({ ok: true, action: "refund_failed" });
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("REFUND_FAILED");
    expect(updated!.capturedAmountCents).toBe(5500);
  });

  it("a later refund.failed does not reopen a manually resolved order", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap-two");
    const first = await fakeStripeProvider.refundPayment(pi, 400, "first-fail");
    setRefundStatus(first.refundId, "failed");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING", capturedAmountCents: null },
      });
    });
    const opened = await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: first.refundId,
      refundStatus: "failed",
    });
    expect(opened).toEqual({ ok: true, action: "refund_failed" });
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLED", cancelledAt: new Date(), notes: "Paid by Zelle" },
      });
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: SYSTEM_ACTOR_ID,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: "refund_resolved_manually",
          entityType: "order",
          entityId: order.id,
          after: { note: "Paid by Zelle", refundId: first.refundId, alert: "store" },
        },
      });
    });
    const second = await fakeStripeProvider.refundPayment(pi, 600, "second-fail");
    setRefundStatus(second.refundId, "failed");
    const again = await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: second.refundId,
      refundStatus: "failed",
    });
    expect(again).toEqual({ ok: true, action: "already_resolved" });
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.notes).toBe("Paid by Zelle");
  });

  it("a lost refund response that later fails does not start a second refund", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    capturedPayments.set(pi, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING", capturedAmountCents: order.totalAuthorizedCents, refundId: null },
      });
      await tx.auditLog.create({
        data: {
          storeId,
          actorId: SYSTEM_ACTOR_ID,
          actorEmail: SYSTEM_ACTOR_EMAIL,
          action: "refund_retry",
          entityType: "order",
          entityId: order.id,
          after: { attempt: 1, alreadyRefundedCents: 0 },
        },
      });
    });
    const committed = await fakeStripeProvider.refundPayment(
      pi,
      order.totalAuthorizedCents,
      `refund:${order.id}:0:1`,
    );
    setRefundStatus(committed.refundId, "failed");

    const result = await reconcileStuckOrder(storeId, order.id);
    expect(result.ok).toBe(false);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("REFUND_FAILED");
    expect(updated!.refundId).toBe(committed.refundId);
    expect(refundRequests.filter((request) => request.paymentIntentId === pi)).toHaveLength(1);
    expect(await fakeStripeProvider.listRefunds(pi)).toHaveLength(1);
  });

  it("a refund that lands before the cancellation write is not issued again", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, order.totalAuthorizedCents);
    capturedPayments.set(pi, order.totalAuthorizedCents);
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING", capturedAmountCents: order.totalAuthorizedCents },
      });
    });
    const original = fakeStripeProvider.refundPayment.bind(fakeStripeProvider);
    vi.spyOn(fakeStripeProvider, "refundPayment").mockImplementation(async (...args) => {
      const result = await original(...args);
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({ where: { id: order.id }, data: { status: "AUTHORIZED" } });
      });
      return result;
    });
    try {
      const first = await reconcileStuckOrder(storeId, order.id);
      expect(first.ok).toBe(true);
      const mid = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(mid!.status).toBe("AUTHORIZED");
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLING" } });
      });
      vi.mocked(fakeStripeProvider.refundPayment).mockRestore();
      const second = await reconcileStuckOrder(storeId, order.id);
      expect(second.ok).toBe(true);
      expect(refundRequests.filter((request) => request.paymentIntentId === pi)).toHaveLength(1);
      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("CANCELLED");
    } finally {
      vi.restoreAllMocks();
      setStripeProvider(fakeStripeProvider);
    }
  });

  it("a transient refund list failure does not mark a covered cancellation REFUND_FAILED", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, 5500);
    await fakeStripeProvider.capturePaymentIntent(pi, 5500, "cap-a2");
    const older = await fakeStripeProvider.refundPayment(pi, 5500, "old-cover");
    setRefundStatus(older.refundId, "failed");
    await fakeStripeProvider.refundPayment(pi, 5500, "new-cover");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLING", capturedAmountCents: 5500 },
      });
    });

    const provider = getStripeProvider();
    let failedOnce = false;
    setStripeProvider({
      ...provider,
      async listRefunds(paymentIntentId: string) {
        if (!failedOnce) {
          failedOnce = true;
          const err = new Error("stripe unavailable") as Error & { statusCode: number };
          err.statusCode = 500;
          throw err;
        }
        return provider.listRefunds(paymentIntentId);
      },
    });
    try {
      const first = await markTerminalRefundFailure({
        paymentIntentId: pi,
        refundId: older.refundId,
        refundStatus: "failed",
      });
      expect(first).toEqual({ ok: false, error: "Refund coverage could not be read", retry: true });
      const mid = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(mid!.status).toBe("CANCELLING");

      const second = await markTerminalRefundFailure({
        paymentIntentId: pi,
        refundId: older.refundId,
        refundStatus: "failed",
      });
      expect(second).toEqual({ ok: true, action: "covered" });
      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("CANCELLING");
    } finally {
      setStripeProvider(fakeStripeProvider);
    }
  });

  it("markReady returns success when a sweep already finalized the capture", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) await markLinePicked(storeId, line.id);

    const provider = getStripeProvider();
    setStripeProvider({
      ...provider,
      async capturePaymentIntent(...args) {
        const captured = await provider.capturePaymentIntent(...args);
        await reconcileStuckOrder(storeId, order.id);
        return captured;
      },
    });
    try {
      const result = await markReady(storeId, order.id);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.capturedAmountCents).toBeGreaterThan(0);
      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("AWAITING_PICKUP");
      expect(updated!.capturedAmountCents).toBe(result.ok ? result.capturedAmountCents : null);
    } finally {
      setStripeProvider(fakeStripeProvider);
    }
  });

  it("markReady returns success when pickup was completed before the capture response", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) await markLinePicked(storeId, line.id);

    const provider = getStripeProvider();
    setStripeProvider({
      ...provider,
      async capturePaymentIntent(...args) {
        const captured = await provider.capturePaymentIntent(...args);
        await reconcileStuckOrder(storeId, order.id);
        await completePickup(storeId, order.id);
        return captured;
      },
    });
    try {
      const result = await markReady(storeId, order.id);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.capturedAmountCents).toBeGreaterThan(0);
      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("COMPLETED");
      expect(updated!.capturedAmountCents).toBe(result.ok ? result.capturedAmountCents : null);
    } finally {
      setStripeProvider(fakeStripeProvider);
    }
  });

  it("markReady returns success when a delivery order was completed before the capture response", async () => {
    const order = await createTestOrder("AUTHORIZED", { fulfillment: "delivery" });
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) await markLinePicked(storeId, line.id);

    const provider = getStripeProvider();
    setStripeProvider({
      ...provider,
      async capturePaymentIntent(...args) {
        const captured = await provider.capturePaymentIntent(...args);
        await reconcileStuckOrder(storeId, order.id);
        await storeScopedTransaction(storeId, async (tx) => {
          await tx.order.update({
            where: { id: order.id },
            data: { status: "COMPLETED", completedAt: new Date() },
          });
        });
        return captured;
      },
    });
    try {
      const result = await markReady(storeId, order.id);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.capturedAmountCents).toBeGreaterThan(0);
      const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
      expect(updated!.status).toBe("COMPLETED");
      expect(updated!.capturedAmountCents).toBe(result.ok ? result.capturedAmountCents : null);
    } finally {
      setStripeProvider(fakeStripeProvider);
    }
  });

  it("markReady reports a capture error when a completed order has no captured amount", async () => {
    const order = await createTestOrder();
    setAuthorizedAmount(order.paymentIntentId!, order.totalAuthorizedCents);
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({ where: { orderId: order.id } });
    for (const line of lines) await markLinePicked(storeId, line.id);

    const provider = getStripeProvider();
    setStripeProvider({
      ...provider,
      async capturePaymentIntent(...args) {
        const captured = await provider.capturePaymentIntent(...args);
        await storeScopedTransaction(storeId, async (tx) => {
          await tx.order.update({
            where: { id: order.id },
            data: { status: "COMPLETED", capturedAmountCents: null },
          });
        });
        return captured;
      },
    });
    try {
      const result = await markReady(storeId, order.id);
      expect(result).toEqual({ ok: false, error: "Order status changed during capture" });
    } finally {
      setStripeProvider(fakeStripeProvider);
    }
  });

  it("a refund.failed for an older refund leaves an order covered by a newer refund CANCELLED", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap");
    const older = await fakeStripeProvider.refundPayment(pi, 400, "older-fail");
    setRefundStatus(older.refundId, "failed");
    const newer = await fakeStripeProvider.refundPayment(pi, 1000, "newer-cover");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLED", capturedAmountCents: 1000, refundId: newer.refundId },
      });
    });

    const result = await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: older.refundId,
      refundStatus: "failed",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.action).toBe("covered");
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "refund_failed_while_covered" },
    });
    expect(logs).toHaveLength(1);
  });

  it("a refund failure that leaves the capture uncovered moves CANCELLED to REFUND_FAILED", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap");
    const older = await fakeStripeProvider.refundPayment(pi, 400, "part-a");
    await fakeStripeProvider.refundPayment(pi, 600, "part-b");
    setRefundStatus(older.refundId, "failed");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLED", capturedAmountCents: 1000, refundId: older.refundId },
      });
    });

    await markTerminalRefundFailure({
      paymentIntentId: pi,
      refundId: older.refundId,
      refundStatus: "failed",
    });
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("REFUND_FAILED");
  });

  it("the same refund failure twice writes one audit row", async () => {
    const order = await createTestOrder();
    const pi = order.paymentIntentId!;
    setAuthorizedAmount(pi, 1000);
    await fakeStripeProvider.capturePaymentIntent(pi, 1000, "cap");
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({
        where: { id: order.id },
        data: { status: "CANCELLED", capturedAmountCents: 1000 },
      });
    });
    const event = { paymentIntentId: pi, refundId: "re_same_event", refundStatus: "failed" };
    await markTerminalRefundFailure(event);
    await markTerminalRefundFailure(event);
    const logs = await storeScoped(storeId).auditLog.findMany({
      where: { entityId: order.id, action: "refund_failed" },
    });
    expect(logs).toHaveLength(1);
  });
});
