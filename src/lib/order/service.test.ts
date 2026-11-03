import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped, storeScopedTransaction } from "../db";
import { acceptOrder, autoCancelOrder, completePickup, markLinePicked, markReady, reconcileStuckOrder, sortPickListLines } from "./service";
import { setStripeProvider } from "../stripe";
import type { StripeProvider, CancelResult } from "../stripe/types";
import { fakeStripeProvider, reset as resetFakeStripe, capturedPayments, cancelledPayments, refundedPayments, setAuthorizedAmount } from "../stripe/fake";
import { SYSTEM_ACTOR_ID } from "../system-actor";

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
    opts?: { tipCents?: number; deliveryFeeCents?: number },
  ) {
    const num = ++orderSeq;
    const tipCents = opts?.tipCents ?? 0;
    const deliveryFeeCents = opts?.deliveryFeeCents ?? 0;
    // Lines: 2x1000 + 1x2000 + 3x500 = 5500
    const subtotalCents = 5500;
    const bufferCents = 550;
    const totalAuthorizedCents = subtotalCents + bufferCents + tipCents + deliveryFeeCents;
    return storeScopedTransaction(storeId, async (tx) => {
      const order = await tx.order.create({
        data: {
          storeId,
          number: num,
          customerId,
          status,
          fulfillment: "pickup",
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

  it("completePickup transitions AWAITING_PICKUP -> COMPLETED", async () => {
    const order = await createTestOrder();
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

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("COMPLETED");
    expect(updated!.completedAt).toBeTruthy();
  });

  it("completePickup rejects wrong status", async () => {
    const order = await createTestOrder();
    const result = await completePickup(storeId, order.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Cannot complete");
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
    }

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("AWAITING_PICKUP");
    expect(updated!.readyAt).toBeTruthy();
    expect(updated!.capturedAmountCents).toBe(6000);

    expect(capturedPayments.get(order.paymentIntentId!)).toBe(6000);
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

  it("completePickup accepts READY status for pickup orders (A5)", async () => {
    const order = await createTestOrder();
    await storeScopedTransaction(storeId, async (tx) => {
      await tx.order.update({ where: { id: order.id }, data: { status: "READY", readyAt: new Date() } });
    });
    const result = await completePickup(storeId, order.id);
    expect(result.ok).toBe(true);
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("COMPLETED");
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

  it("K3: markReady voids authorization when final amount is zero (all lines refunded)", async () => {
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
    if (result.ok) expect(result.capturedAmountCents).toBe(0);

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
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

    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    for (const line of lines) {
      await markLinePicked(storeId, line.id);
    }

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.capturedAmountCents).toBe(0);

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
    await new Promise((r) => setTimeout(r, 100));

    // Verify transitional status is CANCELLING while Stripe call is in-flight
    const mid = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
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
  });

  it("Codex-4: void finalization verifies CANCELLING before writing CANCELLED", async () => {
    const order = await createTestOrder();
    await acceptOrder(storeId, order.id, 15);
    const lines = await storeScoped(storeId).orderLine.findMany({
      where: { orderId: order.id },
    });
    // Refund all lines
    await markLinePicked(storeId, lines[0].id);
    for (const line of lines) {
      await storeScopedTransaction(storeId, async (tx) => {
        await tx.orderLine.update({
          where: { id: line.id },
          data: { status: "refunded", qtyPicked: 0 },
        });
      });
    }

    const result = await markReady(storeId, order.id);
    expect(result.ok).toBe(true);

    // Verify it went through CANCELLING → CANCELLED (not PICKING → CANCELLED)
    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("CANCELLED");
    expect(updated!.cancelledAt).toBeTruthy();
    expect(cancelledPayments.has(order.paymentIntentId!)).toBe(true);
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

  it("markReady idempotent: second call after Stripe already captured succeeds", async () => {
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

    // UI calls markReady on a CAPTURING order — Phase 1 treats it as alreadyClaiming
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
  });

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
});
