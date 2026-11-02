import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped, storeScopedTransaction } from "../db";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Customer, Order, OrderLine RLS isolation", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let variantAId: string;
  let variantBId: string;
  let customerAId: string;
  let customerBId: string;
  let orderAId: string;
  let orderBId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "rls-order-a" },
      update: {},
      create: {
        slug: "rls-order-a",
        name: "Order Store A",
        themePreset: "palm-and-shea",
      },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "rls-order-b" },
      update: {},
      create: {
        slug: "rls-order-b",
        name: "Order Store B",
        themePreset: "lagoon-and-coral",
      },
    });
    storeBId = storeB.id;

    const scopedA = storeScoped(storeAId);
    const listingA = await scopedA.listing.create({
      data: {
        storeId: storeAId,
        customName: "Order Test Product A",
        price: 1200,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const vA = await scopedA.listingVariant.create({
      data: {
        listingId: listingA.id,
        label: "500g",
        price: 1200,
        weightG: 500,
      },
    });
    variantAId = vA.id;

    const scopedB = storeScoped(storeBId);
    const listingB = await scopedB.listing.create({
      data: {
        storeId: storeBId,
        customName: "Order Test Product B",
        price: 900,
        stockMode: "unlimited",
        frozen: false,
        perishable: false,
      },
    });
    const vB = await scopedB.listingVariant.create({
      data: {
        listingId: listingB.id,
        label: "250g",
        price: 900,
        weightG: 250,
      },
    });
    variantBId = vB.id;

    const custA = await scopedA.customer.create({
      data: {
        storeId: storeAId,
        name: "Alice Test",
        email: "alice@test.example",
        phone: "+15551234567",
      },
    });
    customerAId = custA.id;

    const custB = await scopedB.customer.create({
      data: {
        storeId: storeBId,
        name: "Bob Test",
        email: "bob@test.example",
        phone: "+15559876543",
      },
    });
    customerBId = custB.id;

    const oA = await scopedA.order.create({
      data: {
        storeId: storeAId,
        number: 1,
        customerId: customerAId,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 2400,
        bufferCents: 240,
        totalAuthorizedCents: 2640,
        paymentIntentId: `pi_test_isolation_a_${Date.now()}`,
      },
    });
    orderAId = oA.id;

    await scopedA.orderLine.create({
      data: {
        storeId: storeAId,
        orderId: orderAId,
        listingVariantId: variantAId,
        qtyOrdered: 2,
        unitPriceCents: 1200,
        swapRule: "exact_only",
      },
    });

    const oB = await scopedB.order.create({
      data: {
        storeId: storeBId,
        number: 1,
        customerId: customerBId,
        status: "AUTHORIZED",
        fulfillment: "pickup",
        subtotalCents: 900,
        bufferCents: 90,
        totalAuthorizedCents: 990,
        paymentIntentId: `pi_test_isolation_b_${Date.now()}`,
      },
    });
    orderBId = oB.id;

    await scopedB.orderLine.create({
      data: {
        storeId: storeBId,
        orderId: orderBId,
        listingVariantId: variantBId,
        qtyOrdered: 1,
        unitPriceCents: 900,
        swapRule: "store_suggests",
      },
    });
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.orderLine.deleteMany({
        where: { storeId: { in: [storeAId, storeBId] } },
      }),
      rawPrisma.order.deleteMany({
        where: { storeId: { in: [storeAId, storeBId] } },
      }),
      rawPrisma.customer.deleteMany({
        where: { storeId: { in: [storeAId, storeBId] } },
      }),
      rawPrisma.listingVariant.deleteMany({
        where: {
          listing: { storeId: { in: [storeAId, storeBId] } },
        },
      }),
      rawPrisma.listing.deleteMany({
        where: { storeId: { in: [storeAId, storeBId] } },
      }),
    ]);
    await rawPrisma.store.deleteMany({
      where: { slug: { in: ["rls-order-a", "rls-order-b"] } },
    });
    await rawPrisma.$disconnect();
  });

  // --- Customer isolation ---

  it("store A can read its own customers", async () => {
    const scoped = storeScoped(storeAId);
    const customers = await scoped.customer.findMany();
    expect(customers.length).toBeGreaterThanOrEqual(1);
    expect(customers.every((c) => c.storeId === storeAId)).toBe(true);
  });

  it("store B cannot read store A customers", async () => {
    const scoped = storeScoped(storeBId);
    const customers = await scoped.customer.findMany();
    expect(customers.every((c) => c.storeId === storeBId)).toBe(true);
    expect(customers.find((c) => c.id === customerAId)).toBeUndefined();
  });

  it("cross-store customer insert is rejected by RLS", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.customer.create({
        data: {
          storeId: storeBId,
          name: "Cross-store",
          email: "cross@test.example",
          phone: "+15550000000",
        },
      }),
    ).rejects.toThrow();
  });

  // --- Order isolation ---

  it("store A can read its own orders", async () => {
    const scoped = storeScoped(storeAId);
    const orders = await scoped.order.findMany();
    expect(orders.length).toBeGreaterThanOrEqual(1);
    expect(orders.every((o) => o.storeId === storeAId)).toBe(true);
  });

  it("store B cannot read store A orders", async () => {
    const scoped = storeScoped(storeBId);
    const orders = await scoped.order.findMany();
    expect(orders.every((o) => o.storeId === storeBId)).toBe(true);
    expect(orders.find((o) => o.id === orderAId)).toBeUndefined();
  });

  it("cross-store order insert is rejected by RLS", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.order.create({
        data: {
          storeId: storeBId,
          number: 999,
          customerId: customerBId,
          status: "AUTHORIZED",
          fulfillment: "pickup",
          subtotalCents: 100,
          bufferCents: 10,
          totalAuthorizedCents: 110,
        },
      }),
    ).rejects.toThrow();
  });

  // --- OrderLine isolation ---

  it("store A can read its own order lines", async () => {
    const scoped = storeScoped(storeAId);
    const lines = await scoped.orderLine.findMany();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines.every((l) => l.storeId === storeAId)).toBe(true);
  });

  it("store B cannot read store A order lines", async () => {
    const scoped = storeScoped(storeBId);
    const lines = await scoped.orderLine.findMany();
    expect(lines.every((l) => l.storeId === storeBId)).toBe(true);
  });

  it("cross-store order line insert is rejected by RLS", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.orderLine.create({
        data: {
          storeId: storeBId,
          orderId: orderBId,
          listingVariantId: variantBId,
          qtyOrdered: 1,
          unitPriceCents: 900,
          swapRule: "exact_only",
        },
      }),
    ).rejects.toThrow();
  });

  // --- storeScopedTransaction ---

  it("storeScopedTransaction enforces isolation for orders", async () => {
    await storeScopedTransaction(storeAId, async (tx) => {
      const customers = await tx.customer.findMany();
      expect(customers.every((c) => c.storeId === storeAId)).toBe(true);
      const orders = await tx.order.findMany();
      expect(orders.every((o) => o.storeId === storeAId)).toBe(true);
      const lines = await tx.orderLine.findMany();
      expect(lines.every((l) => l.storeId === storeAId)).toBe(true);
    });
  });
});
