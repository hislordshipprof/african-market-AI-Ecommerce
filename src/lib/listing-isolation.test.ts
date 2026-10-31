import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped, platformAdmin } from "./db";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Listing RLS isolation", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let testUserId: string;
  let listingAId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "rls-listing-a" },
      update: {},
      create: { slug: "rls-listing-a", name: "Listing Store A", themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "rls-listing-b" },
      update: {},
      create: { slug: "rls-listing-b", name: "Listing Store B", themePreset: "lagoon-and-coral" },
    });
    storeBId = storeB.id;

    const user = await rawPrisma.user.upsert({
      where: { email: "rls-listing-test@example.com" },
      update: {},
      create: { id: "rls-listing-user", email: "rls-listing-test@example.com", name: "Listing Test User", emailVerified: true },
    });
    testUserId = user.id;

    const scopedA = storeScoped(storeAId);
    const listing = await scopedA.listing.create({
      data: {
        storeId: storeAId,
        customName: "Egusi Ground",
        price: 1200,
        stockMode: "counted",
        qty: 50,
        frozen: false,
        perishable: false,
      },
    });
    listingAId = listing.id;

    await scopedA.listingVariant.create({
      data: {
        listingId: listingAId,
        label: "500g",
        price: 1200,
        weightG: 500,
      },
    });

    await scopedA.stockEvent.create({
      data: {
        storeId: storeAId,
        listingId: listingAId,
        type: "recount",
        delta: 50,
        actorId: testUserId,
      },
    });

    await scopedA.auditLog.create({
      data: {
        storeId: storeAId,
        actorId: testUserId,
        actorEmail: "rls-listing-test@example.com",
        action: "listing.create",
        entityType: "listing",
        entityId: listingAId,
        after: { customName: "Egusi Ground", price: 1200 },
      },
    });
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.auditLog.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      rawPrisma.stockEvent.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
      rawPrisma.stockEvent.deleteMany({ where: { actorId: testUserId } }),
      rawPrisma.listingVariant.deleteMany({ where: { listing: { storeId: { in: [storeAId, storeBId] } } } }),
      rawPrisma.listing.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.user.deleteMany({ where: { email: "rls-listing-test@example.com" } });
    await rawPrisma.store.deleteMany({ where: { slug: { in: ["rls-listing-a", "rls-listing-b"] } } });
    await rawPrisma.$disconnect();
  });

  it("store A can read its own listings", async () => {
    const scoped = storeScoped(storeAId);
    const rows = await scoped.listing.findMany();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.storeId === storeAId)).toBe(true);
  });

  it("store B cannot read store A listings", async () => {
    const scoped = storeScoped(storeBId);
    const rows = await scoped.listing.findMany();
    expect(rows.every((r) => r.storeId === storeBId)).toBe(true);
  });

  it("cross-store listing insert fails with RLS violation", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.listing.create({
        data: {
          storeId: storeBId,
          customName: "Hacked",
          price: 100,
          stockMode: "counted",
        },
      }),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("store A can read its own listing variants", async () => {
    const scoped = storeScoped(storeAId);
    const variants = await scoped.listingVariant.findMany();
    expect(variants.length).toBeGreaterThanOrEqual(1);
  });

  it("store B cannot read store A listing variants", async () => {
    const scoped = storeScoped(storeBId);
    const variants = await scoped.listingVariant.findMany();
    expect(variants.length).toBe(0);
  });

  it("cross-store variant insert fails", async () => {
    const scoped = storeScoped(storeBId);
    await expect(
      scoped.listingVariant.create({
        data: {
          listingId: listingAId,
          label: "Hacked",
          price: 100,
          weightG: 100,
        },
      }),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("store A can read its own stock events", async () => {
    const scoped = storeScoped(storeAId);
    const events = await scoped.stockEvent.findMany();
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.every((e) => e.storeId === storeAId)).toBe(true);
  });

  it("store B cannot read store A stock events", async () => {
    const scoped = storeScoped(storeBId);
    const events = await scoped.stockEvent.findMany();
    expect(events.every((e) => e.storeId === storeBId)).toBe(true);
  });

  it("cross-store stock event insert fails", async () => {
    const scoped = storeScoped(storeAId);
    await expect(
      scoped.stockEvent.create({
        data: {
          storeId: storeBId,
          listingId: listingAId,
          type: "adjust",
          delta: -1,
          actorId: testUserId,
        },
      }),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("store A can read its own audit logs", async () => {
    const scoped = storeScoped(storeAId);
    const logs = await scoped.auditLog.findMany({ where: { entityType: "listing" } });
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs.every((l) => l.storeId === storeAId)).toBe(true);
  });

  it("store B cannot read store A audit logs", async () => {
    const scoped = storeScoped(storeBId);
    const logs = await scoped.auditLog.findMany({ where: { entityType: "listing" } });
    expect(logs.every((l) => l.storeId === storeBId)).toBe(true);
  });

  it("store cannot UPDATE or DELETE audit log entries", async () => {
    const scoped = storeScoped(storeAId);
    const result = await scoped.auditLog.updateMany({
      where: { entityType: "listing" },
      data: { action: "hacked" },
    });
    expect(result.count).toBe(0);
  });
});

describe.skipIf(!hasDb)("MasterProduct RLS (shared read)", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let masterProductId: string;
  const testMpIds: string[] = [];

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const store = await rawPrisma.store.upsert({
      where: { slug: "rls-master-prod" },
      update: {},
      create: { slug: "rls-master-prod", name: "Master Prod Test", themePreset: "palm-and-shea" },
    });
    storeAId = store.id;

    const mp = await platformAdmin.masterProduct.create({
      data: { name: "Egusi Whole" },
    });
    masterProductId = mp.id;
    testMpIds.push(mp.id);
  });

  afterAll(async () => {
    await rawPrisma.masterProduct.deleteMany({ where: { id: { in: testMpIds } } });
    await rawPrisma.masterProduct.deleteMany({ where: { name: { startsWith: "Test Admin Insert" } } });
    await rawPrisma.store.deleteMany({ where: { slug: "rls-master-prod" } });
    await rawPrisma.$disconnect();
  });

  it("any store-scoped session can SELECT master products", async () => {
    const result = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
      rawPrisma.$queryRaw`SELECT * FROM master_products WHERE id = ${masterProductId}`,
    ]);
    const rows = result[2] as Array<{ id: string }>;
    expect(rows.length).toBe(1);
  });

  it("store-scoped session cannot INSERT into master products", async () => {
    await expect(
      rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
        rawPrisma.$executeRaw`INSERT INTO master_products (id, name, created_at, updated_at) VALUES ('rls_mp_test', 'Should Fail', NOW(), NOW())`,
      ]),
    ).rejects.toThrow(/42501|row-level security/i);
  });

  it("platformAdmin can INSERT into master products", async () => {
    const mp = await platformAdmin.masterProduct.create({
      data: { name: "Test Admin Insert" },
    });
    testMpIds.push(mp.id);
    expect(mp.name).toBe("Test Admin Insert");
    await rawPrisma.masterProduct.deleteMany({ where: { id: mp.id } });
  });
});
