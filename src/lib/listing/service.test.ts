import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { storeScoped, storeScopedTransaction } from "../db";
import {
  createListing,
  updateListing,
  deactivateListing,
  reactivateListing,
  listListings,
  getListing,
  updateVariants,
  listMasterProducts,
  type Actor,
  type CreateVariantInput,
} from "./service";
import { platformAdmin } from "../db";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Listing service (DB integration)", () => {
  let rawPrisma: PrismaClient;
  let storeId: string;
  let userId: string;
  let actor: Actor;

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
    actor = { id: user.id, email: user.email };
  });

  afterAll(async () => {
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.auditLog.deleteMany({ where: { storeId } }),
      rawPrisma.stockEvent.deleteMany({ where: { storeId } }),
      rawPrisma.stockEvent.deleteMany({ where: { actorId: userId } }),
      rawPrisma.listingVariant.deleteMany({ where: { listing: { storeId } } }),
      rawPrisma.listing.deleteMany({ where: { storeId } }),
    ]);
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
      actor,
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
      actor,
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
      actor,
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
      actor,
    });

    await updateListing({
      storeId,
      listingId: listing.id,
      price: 600,
      actor,
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
      actor,
    });

    await updateListing({
      storeId,
      listingId: listing.id,
      qty: 20,
      actor,
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
      actor,
    });

    await updateListing({
      storeId,
      listingId: listing.id,
      status: "low",
      actor,
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
      actor,
    });

    const result = await deactivateListing(storeId, listing.id, actor);
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
      actor,
    });

    await deactivateListing(storeId, listing.id, actor);
    const result = await reactivateListing(storeId, listing.id, actor);
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
      actor,
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
      actor,
    });

    expect(listing.qty).toBe(20);

    await updateListing({
      storeId,
      listingId: listing.id,
      stockMode: "status",
      status: "in_stock",
      actor,
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
      actor,
    });

    expect(listing.status).toBe("in_stock");

    await updateListing({
      storeId,
      listingId: listing.id,
      stockMode: "counted",
      qty: 10,
      actor,
    });

    const found = await getListing(storeId, listing.id);
    expect(found!.stockMode).toBe("counted");
    expect(found!.qty).toBe(10);
    expect(found!.status).toBeNull();
  });

  it("variant price change creates audit entry", async () => {
    const listing = await createListing({
      storeId,
      customName: "Audit Variant Price",
      price: 500,
      stockMode: "counted",
      qty: 10,
      frozen: false,
      perishable: false,
      variants: [
        { label: "250g", price: 500, weightG: 250 },
        { label: "1kg", price: 1800, weightG: 1000 },
      ],
      actor,
    });

    await updateListing({
      storeId,
      listingId: listing.id,
      variants: [
        { label: "250g", price: 600, weightG: 250 },
        { label: "1kg", price: 1800, weightG: 1000 },
      ],
      actor,
    });

    const scoped = storeScoped(storeId);
    const logs = await scoped.auditLog.findMany({
      where: { entityId: listing.id, action: "listing.variant_price_change" },
    });
    expect(logs).toHaveLength(1);
    const before = logs[0].before as Record<string, unknown>;
    const after = logs[0].after as Record<string, unknown>;
    expect(before).toHaveProperty("variants");
    expect(after).toHaveProperty("variants");
    const beforeVariants = before.variants as Array<{ label: string; price: number }>;
    const afterVariants = after.variants as Array<{ label: string; price: number }>;
    expect(beforeVariants.find((v) => v.label === "250g")?.price).toBe(500);
    expect(afterVariants.find((v) => v.label === "250g")?.price).toBe(600);
  });

  it("variant update with no price change creates no audit entry", async () => {
    const listing = await createListing({
      storeId,
      customName: "No Audit Variant",
      price: 700,
      stockMode: "counted",
      qty: 5,
      frozen: false,
      perishable: false,
      variants: [{ label: "1kg", price: 700, weightG: 1000 }],
      actor,
    });

    await updateListing({
      storeId,
      listingId: listing.id,
      variants: [{ label: "1kg", price: 700, weightG: 1000 }],
      actor,
    });

    const scoped = storeScoped(storeId);
    const logs = await scoped.auditLog.findMany({
      where: { entityId: listing.id, action: "listing.variant_price_change" },
    });
    expect(logs).toHaveLength(0);
  });

  it("reordered variants with same prices creates no audit entry", async () => {
    const listing = await createListing({
      storeId,
      customName: "Reorder Variant",
      price: 500,
      stockMode: "counted",
      qty: 10,
      frozen: false,
      perishable: false,
      variants: [
        { label: "250g", price: 500, weightG: 250 },
        { label: "1kg", price: 1800, weightG: 1000 },
      ],
      actor,
    });

    await updateListing({
      storeId,
      listingId: listing.id,
      variants: [
        { label: "1kg", price: 1800, weightG: 1000 },
        { label: "250g", price: 500, weightG: 250 },
      ],
      actor,
    });

    const scoped = storeScoped(storeId);
    const logs = await scoped.auditLog.findMany({
      where: { entityId: listing.id, action: "listing.variant_price_change" },
    });
    expect(logs).toHaveLength(0);
  });

  it("creates a listing linked to a master product", async () => {
    const mp = await platformAdmin.masterProduct.create({
      data: { name: "E2E Master Egusi" },
    });

    try {
      const listing = await createListing({
        storeId,
        masterProductId: mp.id,
        customName: null,
        price: 1200,
        stockMode: "counted",
        qty: 20,
        frozen: false,
        perishable: false,
        variants: [{ label: "500g", price: 1200, weightG: 500 }],
        actor,
      });

      expect(listing.masterProductId).toBe(mp.id);
      const found = await getListing(storeId, listing.id);
      expect(found!.masterProduct).not.toBeNull();
      expect(found!.masterProduct!.name).toBe("E2E Master Egusi");
    } finally {
      await rawPrisma.masterProduct.deleteMany({ where: { id: mp.id } });
    }
  });

  it("listMasterProducts returns products ordered by name", async () => {
    const mpA = await platformAdmin.masterProduct.create({ data: { name: "AAA Test Product" } });
    const mpZ = await platformAdmin.masterProduct.create({ data: { name: "ZZZ Test Product" } });

    try {
      const products = await listMasterProducts();
      expect(products.length).toBeGreaterThanOrEqual(2);
      const names = products.map((p) => p.name);
      const idxA = names.indexOf("AAA Test Product");
      const idxZ = names.indexOf("ZZZ Test Product");
      expect(idxA).toBeLessThan(idxZ);
    } finally {
      await rawPrisma.masterProduct.deleteMany({ where: { id: { in: [mpA.id, mpZ.id] } } });
    }
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
      actor,
    });

    await updateVariants({
      storeId,
      listingId: listing.id,
      variants: [
        { label: "500g", price: 400, weightG: 500 },
        { label: "2kg", price: 1300, weightG: 2000 },
        { label: "5kg", price: 3000, weightG: 5000 },
      ],
      actor,
    });

    const found = await getListing(storeId, listing.id);
    expect(found!.variants).toHaveLength(3);
  });

  async function newListing(
    name: string,
    variants: CreateVariantInput[] = [{ label: "1kg", price: 700, weightG: 1000 }],
  ) {
    return createListing({
      storeId,
      customName: name,
      price: 700,
      stockMode: "counted",
      qty: 5,
      frozen: false,
      perishable: false,
      variants,
      actor,
    });
  }

  async function auditFor(id: string, action: string) {
    return storeScoped(storeId).auditLog.findMany({
      where: { entityId: id, action },
      orderBy: { createdAt: "asc" },
    });
  }

  it("deactivate on an active listing audits before active:true, after active:false", async () => {
    const listing = await newListing("Toggle Active");
    await deactivateListing(storeId, listing.id, actor);
    const logs = await auditFor(listing.id, "listing.deactivate");
    expect(logs).toHaveLength(1);
    expect(logs[0].before).toEqual({ active: true });
    expect(logs[0].after).toEqual({ active: false });
  });

  it("deactivate on an already-inactive listing audits the true before-state", async () => {
    const listing = await newListing("Toggle Twice");
    await deactivateListing(storeId, listing.id, actor);
    await deactivateListing(storeId, listing.id, actor);
    const logs = await auditFor(listing.id, "listing.deactivate");
    expect(logs).toHaveLength(2);
    expect(logs[1].before).toEqual({ active: false });
    expect(logs[1].after).toEqual({ active: false });
  });

  it("reactivate on an already-active listing audits before active:true", async () => {
    const listing = await newListing("Reactivate Active");
    await reactivateListing(storeId, listing.id, actor);
    const logs = await auditFor(listing.id, "listing.reactivate");
    expect(logs).toHaveLength(1);
    expect(logs[0].before).toEqual({ active: true });
    expect(logs[0].after).toEqual({ active: true });
  });

  it("updateVariants with changed prices writes a variant_price_change audit entry", async () => {
    const listing = await newListing("UV Price Change");
    await updateVariants({
      storeId,
      listingId: listing.id,
      variants: [{ label: "1kg", price: 900, weightG: 1000 }],
      actor,
    });
    const logs = await auditFor(listing.id, "listing.variant_price_change");
    expect(logs).toHaveLength(1);
    expect(logs[0].actorId).toBe(actor.id);
    expect(logs[0].actorEmail).toBe(actor.email);
    expect(logs[0].before).toEqual({ variants: [{ label: "1kg", price: 700 }] });
    expect(logs[0].after).toEqual({ variants: [{ label: "1kg", price: 900 }] });
  });

  it("updateVariants with unchanged prices writes no audit entry", async () => {
    const listing = await newListing("UV No Change");
    await updateVariants({
      storeId,
      listingId: listing.id,
      variants: [{ label: "1kg", price: 700, weightG: 1200 }],
      actor,
    });
    expect(await auditFor(listing.id, "listing.variant_price_change")).toHaveLength(0);
  });

  it("round-trips sku and barcode through updateListing", async () => {
    const listing = await newListing("Sku Roundtrip", [
      { label: "1kg", price: 700, weightG: 1000, sku: "SKU-1", barcode: "123456" },
    ]);
    await updateListing({
      storeId,
      listingId: listing.id,
      variants: [{ label: "1kg", price: 700, weightG: 1000, sku: "SKU-1", barcode: "123456" }],
      actor,
    });
    const found = await getListing(storeId, listing.id);
    expect(found!.variants[0].sku).toBe("SKU-1");
    expect(found!.variants[0].barcode).toBe("123456");
  });

  it("concurrent same-listing updates produce correct stock event delta sum", async () => {
    const listing = await createListing({
      storeId,
      customName: "Concurrent Delta Test",
      price: 500,
      stockMode: "counted",
      qty: 100,
      frozen: false,
      perishable: false,
      variants: [{ label: "1kg", price: 500, weightG: 1000 }],
      actor,
    });

    await Promise.all([
      updateListing({ storeId, listingId: listing.id, qty: 90, actor }),
      updateListing({ storeId, listingId: listing.id, qty: 80, actor }),
    ]);

    const finalQty = (await getListing(storeId, listing.id))!.qty!;
    const scoped = storeScoped(storeId);
    const events = await scoped.stockEvent.findMany({
      where: { listingId: listing.id },
    });

    const adjustEvents = events.filter((e) => e.type === "adjust");
    const deltaSum = adjustEvents.reduce((sum, e) => sum + e.delta, 0);
    const initialEvent = events.find((e) => e.type === "recount");
    const initialQty = initialEvent ? initialEvent.delta : 0;

    expect(finalQty + initialQty + deltaSum).toBe(finalQty + initialQty + (finalQty - 100));
    expect(deltaSum).toBe(finalQty - 100);
  });

  it("concurrent updates to different listings do not block each other", async () => {
    const [l1, l2] = await Promise.all([
      createListing({
        storeId,
        customName: "Concurrent L1",
        price: 500,
        stockMode: "counted",
        qty: 50,
        frozen: false,
        perishable: false,
        variants: [{ label: "1kg", price: 500, weightG: 1000 }],
        actor,
      }),
      createListing({
        storeId,
        customName: "Concurrent L2",
        price: 600,
        stockMode: "counted",
        qty: 60,
        frozen: false,
        perishable: false,
        variants: [{ label: "1kg", price: 600, weightG: 1000 }],
        actor,
      }),
    ]);

    const [u1, u2] = await Promise.all([
      updateListing({ storeId, listingId: l1.id, qty: 40, actor }),
      updateListing({ storeId, listingId: l2.id, qty: 50, actor }),
    ]);

    expect(u1.qty).toBe(40);
    expect(u2.qty).toBe(50);
  });

  it("cross-store: stock events are not visible to another store", async () => {
    const otherStore = await rawPrisma.store.upsert({
      where: { slug: "svc-listing-xstore-stock" },
      update: {},
      create: { slug: "svc-listing-xstore-stock", name: "XStore Stock Test", themePreset: "palm-and-shea" },
    });
    try {
      const listing = await createListing({
        storeId,
        customName: "XStore Stock Events",
        price: 500,
        stockMode: "counted",
        qty: 10,
        frozen: false,
        perishable: false,
        variants: [{ label: "1kg", price: 500, weightG: 1000 }],
        actor,
      });

      await updateListing({ storeId, listingId: listing.id, qty: 5, actor });

      const otherScoped = storeScoped(otherStore.id);
      const events = await otherScoped.stockEvent.findMany({
        where: { listingId: listing.id },
      });
      expect(events).toHaveLength(0);
    } finally {
      await rawPrisma.store.deleteMany({ where: { slug: "svc-listing-xstore-stock" } });
    }
  });

  it("cross-store: lockListingRow in store B context does not lock store A listing", async () => {
    const otherStore = await rawPrisma.store.upsert({
      where: { slug: "svc-listing-xstore-lock" },
      update: {},
      create: { slug: "svc-listing-xstore-lock", name: "XStore Lock Test", themePreset: "palm-and-shea" },
    });
    try {
      const listing = await createListing({
        storeId,
        customName: "XStore Lock Target",
        price: 500,
        stockMode: "counted",
        qty: 10,
        frozen: false,
        perishable: false,
        variants: [{ label: "1kg", price: 500, weightG: 1000 }],
        actor,
      });

      const rows = await storeScopedTransaction(otherStore.id, async (tx) => {
        return tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM listings WHERE id = ${listing.id} FOR UPDATE
        `;
      });
      expect(rows).toHaveLength(0);

      const found = await getListing(storeId, listing.id);
      expect(found).not.toBeNull();
      expect(found!.qty).toBe(10);
    } finally {
      await rawPrisma.store.deleteMany({ where: { slug: "svc-listing-xstore-lock" } });
    }
  });

  it("rolls back the whole update when variant creation fails", async () => {
    const listing = await newListing("Rollback Target");
    await expect(
      updateListing({
        storeId,
        listingId: listing.id,
        price: 9999,
        variants: [
          { label: "ok", price: 1, weightG: 1 },
          { label: "bad", price: 1, weightG: 1e12 }, // out of INT4 range: fails inside the transaction after the update and delete ran
        ],
        actor,
      }),
    ).rejects.toThrow();

    const found = await getListing(storeId, listing.id);
    expect(found!.price).toBe(700);
    expect(found!.variants).toHaveLength(1);
    expect(found!.variants[0].label).toBe("1kg");
    expect(await auditFor(listing.id, "listing.price_change")).toHaveLength(0);
  });

  it("cross-store: another store cannot toggle a listing and sees none of its audit rows", async () => {
    const other = await rawPrisma.store.upsert({
      where: { slug: "svc-listing-test-b" },
      update: {},
      create: { slug: "svc-listing-test-b", name: "Listing Svc Test B", themePreset: "palm-and-shea" },
    });
    try {
      const listing = await newListing("Cross Store Toggle");
      await deactivateListing(storeId, listing.id, actor);

      await expect(deactivateListing(other.id, listing.id, actor)).rejects.toThrow();
      await expect(reactivateListing(other.id, listing.id, actor)).rejects.toThrow();
      await expect(
        updateVariants({
          storeId: other.id,
          listingId: listing.id,
          variants: [{ label: "x", price: 1, weightG: 1 }],
          actor,
        }),
      ).rejects.toThrow();

      const seenByOther = await storeScoped(other.id).auditLog.findMany({
        where: { entityId: listing.id },
      });
      expect(seenByOther).toHaveLength(0);
      expect((await getListing(storeId, listing.id))!.active).toBe(false);
    } finally {
      await rawPrisma.store.deleteMany({ where: { slug: "svc-listing-test-b" } });
    }
  });
});
