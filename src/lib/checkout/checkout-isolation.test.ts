import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { storeScoped, storeScopedTransaction } from "../db";
import { customerRlsErrorText, isCustomerRlsRejection } from "../customer-rls-error";

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
    rawPrisma = testPrismaClient();
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

  it("cross-store Guest Customer fails for RLS and identical same-store row succeeds", async () => {
    const guest = {
      storeId: storeBId,
      name: "Cross-store guest",
      email: `cross-guest-${process.pid}@test.example`,
      phone: "+15550000099",
    };
    let caught: unknown;
    try {
      await storeScoped(storeAId).customer.create({ data: guest });
    } catch (error) {
      caught = error;
    }
    const text = customerRlsErrorText(caught);
    expect(isCustomerRlsRejection(caught), text).toBe(true);
    const absent = await storeScoped(storeBId).customer.findMany({
      where: { email: guest.email },
    });
    expect(absent).toHaveLength(0);
    const created = await storeScoped(storeBId).customer.create({ data: guest });
    expect(created).toMatchObject({
      storeId: storeBId,
      userId: null,
      name: guest.name,
      email: guest.email,
    });
  });

  it("store B cannot read, set, or point claimedByCustomerId at store A customers", async () => {
    const fromB = await storeScoped(storeBId).customer.updateMany({
      where: { id: customerAId },
      data: { claimedByCustomerId: customerBId, claimedAt: new Date() },
    });
    expect(fromB.count).toBe(0);

    // Run from store A so RLS allows the row: only the composite FK can refuse a store-B target.
    let caught: unknown;
    try {
      await storeScoped(storeAId).customer.updateMany({
        where: { id: customerAId },
        data: { claimedByCustomerId: customerBId, claimedAt: new Date() },
      });
    } catch (error) {
      caught = error;
    }
    const text = customerRlsErrorText(caught);
    // Prisma reports Postgres 23503 (foreign_key_violation) as P2003.
    expect(text).toContain("P2003");
    expect(text).toContain("customers_claimed_by_customer_id_store_id_fkey");
    const row = await storeScoped(storeAId).customer.findFirst({ where: { id: customerAId } });
    expect(row?.claimedByCustomerId).toBeNull();
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

  // --- Cross-store UPDATE/DELETE ---

  it("store B cannot update store A customer", async () => {
    const scoped = storeScoped(storeBId);
    const result = await scoped.customer.updateMany({
      where: { id: customerAId },
      data: { name: "Hacked" },
    });
    expect(result.count).toBe(0);
  });

  it("store B cannot delete store A customer", async () => {
    const scoped = storeScoped(storeBId);
    const result = await scoped.customer.deleteMany({
      where: { id: customerAId },
    });
    expect(result.count).toBe(0);
  });

  it("store B cannot update store A order", async () => {
    const scoped = storeScoped(storeBId);
    const result = await scoped.order.updateMany({
      where: { id: orderAId },
      data: { status: "CANCELLED" },
    });
    expect(result.count).toBe(0);
  });

  it("store B cannot delete store A order", async () => {
    const scoped = storeScoped(storeBId);
    const result = await scoped.order.deleteMany({
      where: { id: orderAId },
    });
    expect(result.count).toBe(0);
  });

  it("store B cannot update store A order lines", async () => {
    const scoped = storeScoped(storeBId);
    const result = await scoped.orderLine.updateMany({
      where: { orderId: orderAId },
      data: { qtyOrdered: 999 },
    });
    expect(result.count).toBe(0);
  });

  it("store B cannot delete store A order lines", async () => {
    const scoped = storeScoped(storeBId);
    const result = await scoped.orderLine.deleteMany({
      where: { orderId: orderAId },
    });
    expect(result.count).toBe(0);
  });

  // --- Composite FK rejection ---

  it("DB rejects order referencing customer from another store", async () => {
    await expect(
      storeScopedTransaction(storeAId, async (tx) => {
        await tx.order.create({
          data: {
            storeId: storeAId,
            number: 9998,
            customerId: customerBId,
            status: "AUTHORIZED",
            fulfillment: "pickup",
            subtotalCents: 100,
            bufferCents: 10,
            totalAuthorizedCents: 110,
            paymentIntentId: `pi_test_fk_reject_${Date.now()}`,
          },
        });
      }),
    ).rejects.toThrow();
  });

  it("DB rejects order line referencing order from another store", async () => {
    await expect(
      storeScopedTransaction(storeBId, async (tx) => {
        await tx.orderLine.create({
          data: {
            storeId: storeBId,
            orderId: orderAId,
            listingVariantId: variantBId,
            qtyOrdered: 1,
            unitPriceCents: 900,
            swapRule: "exact_only",
          },
        });
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
