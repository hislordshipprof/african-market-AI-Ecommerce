import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped, storeScopedTransaction } from "../db";
import { acceptOrder, completePickup, markLinePicked, sortPickListLines } from "./service";

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
  let customerId: string;
  let variantId: string;
  let variantFrozenId: string;
  let variantPerishId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const store = await rawPrisma.store.upsert({
      where: { slug: "order-svc-test" },
      update: {},
      create: {
        slug: "order-svc-test",
        name: "Order Service Test Store",
        themePreset: "palm-and-shea",
        prepTimeMinutes: 25,
      },
    });
    storeId = store.id;

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
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.orderLine.deleteMany({ where: { storeId } }),
      rawPrisma.order.deleteMany({ where: { storeId } }),
      rawPrisma.customer.deleteMany({ where: { storeId } }),
      rawPrisma.listingVariant.deleteMany({ where: { listing: { storeId } } }),
      rawPrisma.listing.deleteMany({ where: { storeId } }),
    ]);
    await rawPrisma.store.deleteMany({ where: { slug: "order-svc-test" } });
    await rawPrisma.$disconnect();
  });

  let orderSeq = 90000;
  async function createTestOrder(status: string = "AUTHORIZED") {
    const num = ++orderSeq;
    return storeScopedTransaction(storeId, async (tx) => {
      const order = await tx.order.create({
        data: {
          storeId,
          number: num,
          customerId,
          status,
          fulfillment: "pickup",
          subtotalCents: 3500,
          bufferCents: 350,
          totalAuthorizedCents: 3850,
          totalCents: 3500,
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

  it("acceptOrder rejects wrong store", async () => {
    const order = await createTestOrder();
    const result = await acceptOrder("nonexistent-store-id", order.id, 20);
    expect(result.ok).toBe(false);
  });

  it("markLinePicked sets qtyPicked and transitions order to PICKING then AWAITING_PICKUP", async () => {
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
    if (r3.ok) expect(r3.orderStatus).toBe("AWAITING_PICKUP");

    const updated = await storeScoped(storeId).order.findUnique({ where: { id: order.id } });
    expect(updated!.status).toBe("AWAITING_PICKUP");
    expect(updated!.readyAt).toBeTruthy();
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
});
