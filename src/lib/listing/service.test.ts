import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped } from "../db";
import {
  createListing,
  updateListing,
  deactivateListing,
  reactivateListing,
  listListings,
  getListing,
  updateVariants,
} from "./service";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Listing service (DB integration)", () => {
  let rawPrisma: PrismaClient;
  let storeId: string;
  let userId: string;

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
    await rawPrisma.$connect();

    const store = await rawPrisma.store.upsert({
      where: { slug: "svc-listing-test" },
      update: {},
      create: { slug: "svc-listing-test", name: "Listing Svc Test", themePreset: "palm-and-shea" },
    });
    storeId = store.id;

    const user = await rawPrisma.user.upsert({
      where: { email: "svc-listing-user@example.com" },
      update: {},
      create: { id: "svc-listing-user", email: "svc-listing-user@example.com", name: "Svc Test User", emailVerified: true },
    });
    userId = user.id;
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.auditLog.deleteMany({ where: { storeId } }),
    ]);
    await rawPrisma.stockEvent.deleteMany({ where: { storeId } });
    await rawPrisma.listingVariant.deleteMany({ where: { listing: { storeId } } });
    await rawPrisma.listing.deleteMany({ where: { storeId } });
    await rawPrisma.user.deleteMany({ where: { email: "svc-listing-user@example.com" } });
    await rawPrisma.store.deleteMany({ where: { slug: "svc-listing-test" } });
    await rawPrisma.$disconnect();
  });

  it("creates a custom listing with variants", async () => {
    const result = await createListing({
      storeId,
      customName: "Garri White",
      price: 800,
      stockMode: "counted",
      qty: 25,
      frozen: false,
      perishable: false,
      variants: [
        { label: "1kg", price: 800, weightG: 1000 },
        { label: "2kg", price: 1500, weightG: 2000 },
      ],
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    expect(result.customName).toBe("Garri White");
    expect(result.price).toBe(800);
    expect(result.stockMode).toBe("counted");
    expect(result.qty).toBe(25);
    expect(result.variants).toHaveLength(2);

    const scoped = storeScoped(storeId);
    const found = await scoped.listing.findUnique({ where: { id: result.id } });
    expect(found).not.toBeNull();
    expect(found!.customName).toBe("Garri White");
  });

  it("creates an audit log entry on listing creation", async () => {
    const result = await createListing({
      storeId,
      customName: "Palm Oil",
      price: 1500,
      stockMode: "status",
      status: "in_stock",
      frozen: false,
      perishable: true,
      variants: [{ label: "1L", price: 1500, weightG: 900 }],
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    const scoped = storeScoped(storeId);
    const logs = await scoped.auditLog.findMany({
      where: { entityType: "listing", entityId: result.id, action: "listing.create" },
    });
    expect(logs).toHaveLength(1);
    expect((logs[0].after as Record<string, unknown>).customName).toBe("Palm Oil");
  });

  it("creates a stock event on counted listing creation", async () => {
    const result = await createListing({
      storeId,
      customName: "Egusi Seeds",
      price: 1200,
      stockMode: "counted",
      qty: 10,
      frozen: false,
      perishable: false,
      variants: [{ label: "500g", price: 1200, weightG: 500 }],
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    const scoped = storeScoped(storeId);
    const events = await scoped.stockEvent.findMany({
      where: { listingId: result.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("recount");
    expect(events[0].delta).toBe(10);
  });

  it("updates listing price and creates audit entry", async () => {
    const listing = await createListing({
      storeId,
      customName: "Suya Spice",
      price: 500,
      stockMode: "counted",
      qty: 100,
      frozen: false,
      perishable: false,
      variants: [{ label: "100g", price: 500, weightG: 100 }],
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    await updateListing({
      storeId,
      listingId: listing.id,
      price: 600,
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    const scoped = storeScoped(storeId);
    const logs = await scoped.auditLog.findMany({
      where: { entityId: listing.id, action: "listing.price_change" },
    });
    expect(logs).toHaveLength(1);
    expect((logs[0].before as Record<string, unknown>).price).toBe(500);
    expect((logs[0].after as Record<string, unknown>).price).toBe(600);
  });

  it("updates counted stock, creates audit entry and stock event", async () => {
    const listing = await createListing({
      storeId,
      customName: "Plantain Chips",
      price: 400,
      stockMode: "counted",
      qty: 30,
      frozen: false,
      perishable: false,
      variants: [{ label: "150g", price: 400, weightG: 150 }],
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    await updateListing({
      storeId,
      listingId: listing.id,
      qty: 20,
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    const scoped = storeScoped(storeId);
    const logs = await scoped.auditLog.findMany({
      where: { entityId: listing.id, action: "listing.stock_change" },
    });
    expect(logs).toHaveLength(1);
    expect((logs[0].before as Record<string, unknown>).qty).toBe(30);
    expect((logs[0].after as Record<string, unknown>).qty).toBe(20);

    const events = await scoped.stockEvent.findMany({
      where: { listingId: listing.id, type: "adjust" },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
    const adjustEvent = events.find((e) => e.delta === -10);
    expect(adjustEvent).toBeDefined();
  });

  it("updates status stock and creates stock event", async () => {
    const listing = await createListing({
      storeId,
      customName: "Ata Rodo",
      price: 300,
      stockMode: "status",
      status: "in_stock",
      frozen: false,
      perishable: true,
      variants: [{ label: "1 bunch", price: 300, weightG: 200 }],
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    await updateListing({
      storeId,
      listingId: listing.id,
      status: "low",
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    const scoped = storeScoped(storeId);
    const logs = await scoped.auditLog.findMany({
      where: { entityId: listing.id, action: "listing.stock_change" },
    });
    expect(logs).toHaveLength(1);
    expect((logs[0].before as Record<string, unknown>).status).toBe("in_stock");
    expect((logs[0].after as Record<string, unknown>).status).toBe("low");
  });

  it("deactivates a listing", async () => {
    const listing = await createListing({
      storeId,
      customName: "Ogbono",
      price: 1100,
      stockMode: "counted",
      qty: 15,
      frozen: false,
      perishable: false,
      variants: [{ label: "200g", price: 1100, weightG: 200 }],
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    const result = await deactivateListing(storeId, listing.id, userId, "svc-listing-user@example.com");
    expect(result.active).toBe(false);

    const activeListings = await listListings(storeId, false);
    expect(activeListings.find((l) => l.id === listing.id)).toBeUndefined();

    const allListings = await listListings(storeId, true);
    expect(allListings.find((l) => l.id === listing.id)).toBeDefined();
  });

  it("reactivates a deactivated listing", async () => {
    const listing = await createListing({
      storeId,
      customName: "Dried Crayfish",
      price: 900,
      stockMode: "status",
      status: "in_stock",
      frozen: false,
      perishable: false,
      variants: [{ label: "100g", price: 900, weightG: 100 }],
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    await deactivateListing(storeId, listing.id, userId, "svc-listing-user@example.com");
    const result = await reactivateListing(storeId, listing.id, userId, "svc-listing-user@example.com");
    expect(result.active).toBe(true);
  });

  it("getListing returns listing with variants", async () => {
    const listing = await createListing({
      storeId,
      customName: "Stockfish",
      price: 2500,
      stockMode: "counted",
      qty: 5,
      frozen: true,
      perishable: false,
      variants: [{ label: "Whole", price: 2500, weightG: 500 }],
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    const found = await getListing(storeId, listing.id);
    expect(found).not.toBeNull();
    expect(found!.customName).toBe("Stockfish");
    expect(found!.frozen).toBe(true);
    expect(found!.variants).toHaveLength(1);
  });

  it("switching from counted to status clears qty", async () => {
    const listing = await createListing({
      storeId,
      customName: "Mode Switch Test",
      price: 500,
      stockMode: "counted",
      qty: 20,
      frozen: false,
      perishable: false,
      variants: [{ label: "1kg", price: 500, weightG: 1000 }],
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    expect(listing.qty).toBe(20);

    await updateListing({
      storeId,
      listingId: listing.id,
      stockMode: "status",
      status: "in_stock",
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    const found = await getListing(storeId, listing.id);
    expect(found!.stockMode).toBe("status");
    expect(found!.status).toBe("in_stock");
    expect(found!.qty).toBeNull();
  });

  it("switching from status to counted clears status", async () => {
    const listing = await createListing({
      storeId,
      customName: "Mode Switch Test 2",
      price: 600,
      stockMode: "status",
      status: "in_stock",
      frozen: false,
      perishable: false,
      variants: [{ label: "1kg", price: 600, weightG: 1000 }],
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    expect(listing.status).toBe("in_stock");

    await updateListing({
      storeId,
      listingId: listing.id,
      stockMode: "counted",
      qty: 10,
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    const found = await getListing(storeId, listing.id);
    expect(found!.stockMode).toBe("counted");
    expect(found!.qty).toBe(10);
    expect(found!.status).toBeNull();
  });

  it("updateVariants replaces all variants", async () => {
    const listing = await createListing({
      storeId,
      customName: "Yam Flour",
      price: 700,
      stockMode: "counted",
      qty: 40,
      frozen: false,
      perishable: false,
      variants: [{ label: "1kg", price: 700, weightG: 1000 }],
      actorId: userId,
      actorEmail: "svc-listing-user@example.com",
    });

    await updateVariants({
      storeId,
      listingId: listing.id,
      variants: [
        { label: "500g", price: 400, weightG: 500 },
        { label: "2kg", price: 1300, weightG: 2000 },
        { label: "5kg", price: 3000, weightG: 5000 },
      ],
    });

    const found = await getListing(storeId, listing.id);
    expect(found!.variants).toHaveLength(3);
  });
});
