vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn }));
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { Client } from "pg";
import { catalogImageUrl } from "../r2";
import { storeScoped, storeScopedTransaction } from "../db";

import {
  listCategories,
  listingsByCategory,
  getListingDetail,
  searchListings,
  getActiveListings,
  getActiveCollections,
  getCollectionListings,
  getListingsByCategory,
  getFlowCatalog,
  extractStoreProfile,
  getListingFacts,
} from "./service";

const hasDb = !!process.env.DATABASE_URL;

describe("extractStoreProfile delivery radius", () => {
  const store = (deliveryRadiusMi: unknown) => extractStoreProfile({
    ownerName: null, ownerStory: null, ownerPhotoUrl: null, neighborhood: null, deliveryInfo: null,
    hours: null, pickupEnabled: true, deliveryRadiusMi, prepTimeMinutes: 30,
  }).deliveryRadiusMi;

  it("falls back to the schema default 8 when the radius is missing", () => {
    expect(store(null)).toBe(8);
    expect(store(undefined)).toBe(8);
  });

  it("keeps a valid Decimal radius", () => {
    expect(store(new Prisma.Decimal("12.5"))).toBe(12.5);
    expect(store(0)).toBe(0);
  });

  it("falls back to 8 for values that are not a finite number", () => {
    for (const bad of ["", "  ", "abc", NaN, Infinity, {}]) expect(store(bad)).toBe(8);
  });
});

describe.skipIf(!hasDb)("Storefront service (DB integration)", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let masterProductId: string;
  let synonymId: string;
  let listingAId: string;
  let listingBId: string;
  let inactiveListingId: string;
  let e2eListingId: string;
  let frozenListingId: string;
  let customOnlyListingId: string;
  let aisledCustomListingId: string;
  let collectionId: string;

  it("projects checkout catalog variants without crossing stores or including inactive listings", async () => {
    const [a, b] = await Promise.all([getFlowCatalog(storeAId), getFlowCatalog(storeBId)]);
    expect(a.some(item => item.listingId === listingAId)).toBe(true);
    expect(a.some(item => item.listingId === listingBId || item.listingId === inactiveListingId)).toBe(false);
    expect(b.some(item => item.listingId === listingBId)).toBe(true);
    expect(b.some(item => item.listingId === listingAId)).toBe(false);
    for (const item of a) {
      expect(item.weightG).toBeGreaterThan(0);
      expect(item.maxPerOrder).toBeGreaterThan(0);
      expect(Number.isInteger(item.price)).toBe(true);
    }
  });

  it("uses the linked master image in browse, home rails, detail, search and collections", async () => {
    const expected = catalogImageUrl("catalog/storefront-test.jpg");
    const [browse, active, detail, search, rails, collection] = await Promise.all([
      listingsByCategory(storeAId, "fresh-produce"), getActiveListings(storeAId),
      getListingDetail(storeAId, listingAId), searchListings(storeAId, "ugu"),
      getListingsByCategory(storeAId), getCollectionListings(storeAId, "test-soup-kit"),
    ]);
    expect(browse.listings.find(item => item.id === listingAId)?.imageUrl).toBe(expected);
    expect(active.find(item => item.id === listingAId)?.imageUrl).toBe(expected);
    expect(detail?.imageUrl).toBe(expected);
    expect(search.find(item => item.id === listingAId)?.imageUrl).toBe(expected);
    expect(rails.flatMap(rail => rail.listings).find(item => item.id === listingAId)?.imageUrl).toBe(expected);
    expect(collection.listings.find(item => item.id === listingAId)?.imageUrl).toBe(expected);
  });

  beforeAll(async () => {
    rawPrisma = testPrismaClient();
    await rawPrisma.$connect();

    const storeA = await rawPrisma.store.upsert({
      where: { slug: "sf-test-store-a" },
      update: {},
      create: { slug: "sf-test-store-a", name: "SF Store A", themePreset: "palm-and-shea" },
    });
    storeAId = storeA.id;

    const storeB = await rawPrisma.store.upsert({
      where: { slug: "sf-test-store-b" },
      update: {},
      create: { slug: "sf-test-store-b", name: "SF Store B", themePreset: "lagoon-and-coral" },
    });
    storeBId = storeB.id;

    await rawPrisma.user.upsert({
      where: { email: "sf-test-user@example.com" },
      update: {},
      create: { id: "sf-test-user", email: "sf-test-user@example.com", name: "SF Test User", emailVerified: true },
    });

    // A subcategory of Fresh Produce (#861), seeded by migration
    const vegCat = await rawPrisma.category.findUnique({ where: { slug: "leafy-greens-and-wrapping-leaves" } });

    // Create master product with category
    const mp = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.masterProduct.create({
        data: { name: "Fluted Pumpkin Leaves", categoryId: vegCat?.id ?? null, imageUrl: "/api/catalog-image/catalog/storefront-test.jpg" },
      }),
    ]);
    masterProductId = (mp[2] as { id: string }).id;

    // Create product synonym
    const syn = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.productSynonym.create({
        data: { productId: masterProductId, term: "ugu", language: "igbo", region: "nigeria" },
      }),
    ]);
    synonymId = (syn[2] as { id: string }).id;

    // Create listing in store A linked to master product
    const listingA = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
      rawPrisma.listing.create({
        data: {
          storeId: storeAId,
          masterProductId,
          customName: null,
          price: 500,
          stockMode: "counted",
          qty: 20,
          frozen: false,
          perishable: true,
          confidence: 0.8,
        },
      }),
    ]);
    listingAId = (listingA[2] as { id: string }).id;

    // Add variants for store A listing
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
      rawPrisma.listingVariant.create({
        data: { listingId: listingAId, label: "1 bunch", price: 500, weightG: 200 },
      }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
      rawPrisma.listingVariant.create({
        data: { listingId: listingAId, label: "3 bunches", price: 1400, weightG: 600 },
      }),
    ]);

    // Create listing in store B linked to same master product
    const listingB = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeBId}, true)`,
      rawPrisma.listing.create({
        data: {
          storeId: storeBId,
          masterProductId,
          customName: "Ugu Leaves (Fresh)",
          price: 600,
          stockMode: "status",
          status: "in_stock",
          frozen: false,
          perishable: true,
          confidence: 0.9,
        },
      }),
    ]);
    listingBId = (listingB[2] as { id: string }).id;

    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeBId}, true)`,
      rawPrisma.listingVariant.create({
        data: { listingId: listingBId, label: "1 bunch", price: 600, weightG: 250 },
      }),
    ]);

    // Create an inactive listing in store A for exclusion tests
    const inactiveListing = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
      rawPrisma.listing.create({
        data: {
          storeId: storeAId,
          masterProductId,
          customName: "Deactivated Pumpkin",
          price: 300,
          stockMode: "counted",
          qty: 0,
          frozen: false,
          perishable: false,
          confidence: 0.0,
          active: false,
        },
      }),
    ]);
    inactiveListingId = (inactiveListing[2] as { id: string }).id;

    // An active listing carrying the e2e name prefix: it must never reach customers (#116)
    const e2eListing = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
      rawPrisma.listing.create({
        data: {
          storeId: storeAId,
          masterProductId,
          customName: "E2E Sentinel Pumpkin",
          price: 400,
          stockMode: "counted",
          qty: 5,
          frozen: false,
          perishable: false,
          confidence: 0.9,
          variants: { create: [{ label: "1 bunch", price: 400, weightG: 200 }] },
        },
      }),
    ]);
    e2eListingId = (e2eListing[2] as { id: string }).id;

    // Frozen listing (AC4) and custom-name-only listing with no master product (AC5), both store A
    const mkListing = async (data: Record<string, unknown>) => {
      const r = await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
        rawPrisma.listing.create({
          data: {
            storeId: storeAId, price: 700, stockMode: "counted", qty: 5, perishable: false, confidence: 0.9,
            variants: { create: [{ label: "1 pack", price: 700, weightG: 300 }] },
            ...data,
          } as never,
        }),
      ]);
      return (r[2] as { id: string }).id;
    };
    frozenListingId = await mkListing({ masterProductId, customName: "Frozen Ugu Cubes", frozen: true });
    customOnlyListingId = await mkListing({ masterProductId: null, customName: "Custom Item", frozen: false });
    // #782: a custom listing in an aisle, and an inactive one whose aisle must stay hidden.
    const oils = await rawPrisma.category.findUniqueOrThrow({ where: { slug: "palm-oil" } });
    const snacks = await rawPrisma.category.findUniqueOrThrow({ where: { slug: "chips-and-savoury-snacks" } });
    aisledCustomListingId = await mkListing({ masterProductId: null, customName: "Red Palm Oil 1L", categoryId: oils.id });
    await mkListing({ masterProductId: null, customName: "Old Chin Chin", categoryId: snacks.id, active: false });

    // Create a collection in store A with an item
    const collection = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
      rawPrisma.storeCollection.create({
        data: {
          storeId: storeAId,
          title: "Test Soup Kit",
          slug: "test-soup-kit",
          active: true,
          sortOrder: 0,
        },
      }),
    ]);
    collectionId = (collection[2] as { id: string }).id;

    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
      rawPrisma.storeCollectionListing.create({
        data: { collectionId, listingId: listingAId, sortOrder: 0 },
      }),
      rawPrisma.storeCollectionListing.create({
        data: { collectionId, listingId: e2eListingId, sortOrder: 1 },
      }),
    ]);
  });

  afterAll(async () => {
    // Clean up in reverse order of dependencies. By store, not by this run's ids: the
    // stores are upserted, so an interrupted run's rows would block the store delete.
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeCollectionListing.deleteMany({ where: { collection: { storeId: { in: [storeAId, storeBId] } } } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeCollection.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.listingVariant.deleteMany({ where: { listing: { storeId: { in: [storeAId, storeBId] } } } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.listing.deleteMany({ where: { storeId: { in: [storeAId, storeBId] } } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.productSynonym.deleteMany({ where: { id: synonymId } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.masterProduct.deleteMany({ where: { id: masterProductId } }),
    ]);
    await rawPrisma.user.deleteMany({ where: { email: "sf-test-user@example.com" } });
    await rawPrisma.store.deleteMany({ where: { slug: { in: ["sf-test-store-a", "sf-test-store-b"] } } });
    await rawPrisma.$disconnect();
  });

  // #782 AC2: the aisle menu lists only aisles this store has an active listing in.
  it("lists only the aisles a store stocks", async () => {
    const slugsA = (await listCategories(storeAId)).map((category) => category.slug);
    expect(slugsA).toEqual(["fresh-produce", "oils-sauces-and-condiments"]);
    const slugsB = (await listCategories(storeBId)).map((category) => category.slug);
    expect(slugsB).toEqual(["fresh-produce"]);
  });

  // #862: the aisle tree counts each aisle's active listings and names only the subcategories the store stocks.
  it("gives each aisle its listing count and its stocked subcategories with theirs", async () => {
    const [produce, oils] = await listCategories(storeAId);
    const leafy = (await listingsByCategory(storeAId, "leafy-greens-and-wrapping-leaves")).listings.length;
    expect(leafy).toBeGreaterThan(0);
    expect(produce.subcategories).toEqual([{ name: "Leafy Greens & Wrapping Leaves", slug: "leafy-greens-and-wrapping-leaves", count: leafy }]);
    expect(produce.count).toBe((await listingsByCategory(storeAId, "fresh-produce")).listings.length);
    expect(oils.subcategories).toEqual([{ name: "Palm Oil", slug: "palm-oil", count: 1 }]);
    expect(oils.count).toBe(1);
  });

  // #861: an aisle page shows its subcategories' listings and names the stocked subcategories; a
  // subcategory page shows only its own and names its aisle.
  it("browses an aisle through its subcategories", async () => {
    const aisle = await listingsByCategory(storeAId, "fresh-produce");
    expect(aisle.category).toEqual({ name: "Fresh Produce", slug: "fresh-produce", aisle: null });
    expect(aisle.subcategories).toEqual([{ name: "Leafy Greens & Wrapping Leaves", slug: "leafy-greens-and-wrapping-leaves" }]);
    const sub = await listingsByCategory(storeAId, "leafy-greens-and-wrapping-leaves");
    expect(sub.category).toEqual({ name: "Leafy Greens & Wrapping Leaves", slug: "leafy-greens-and-wrapping-leaves", aisle: { name: "Fresh Produce", slug: "fresh-produce" } });
    expect(sub.listings.map((l) => l.id).sort()).toEqual(aisle.listings.map((l) => l.id).sort());
    expect((await listingsByCategory(storeAId, "palm-oil")).listings.map((l) => l.id)).toEqual([aisledCustomListingId]);
    expect((await listingsByCategory(storeAId, "fresh-vegetables")).listings).toEqual([]);
  });

  // Seam 1: category browse store isolation
  it("category browse returns only store A listings for store A", async () => {
    const result = await listingsByCategory(storeAId, "fresh-produce");
    expect(result.category).not.toBeNull();
    expect(result.category!.slug).toBe("fresh-produce");
    expect(result.listings.length).toBeGreaterThanOrEqual(1);
    expect(result.listings.some((l) => l.id === listingAId)).toBe(true);
    expect(result.listings.some((l) => l.id === listingBId)).toBe(false);
  });

  it("category browse returns only store B listings for store B", async () => {
    const result = await listingsByCategory(storeBId, "fresh-produce");
    expect(result.listings.length).toBeGreaterThanOrEqual(1);
    expect(result.listings.some((l) => l.id === listingBId)).toBe(true);
    expect(result.listings.some((l) => l.id === listingAId)).toBe(false);
  });

  // #72 AC4: frozen flag reaches search results
  it("search results carry the frozen flag", async () => {
    const results = await searchListings(storeAId, "Frozen Ugu Cubes");
    expect(results.find((r) => r.id === frozenListingId)?.frozen).toBe(true);
    const fresh = await searchListings(storeAId, "ugu");
    expect(fresh.find((r) => r.id === listingAId)?.frozen).toBe(false);
  });

  // #782 AC1: a custom listing with an aisle is browsed in that aisle and carries its slug.
  it("custom listing with an aisle shows in that aisle", async () => {
    const browse = await listingsByCategory(storeAId, "oils-sauces-and-condiments");
    expect(browse.listings.map((l) => l.id)).toEqual([aisledCustomListingId]);
    expect(browse.listings[0]?.categorySlug).toBe("oils-sauces-and-condiments");
    expect((await getListingDetail(storeAId, aisledCustomListingId))?.categorySlug).toBe("oils-sauces-and-condiments");
    const rails = await getListingsByCategory(storeAId);
    expect(rails.find((rail) => rail.categorySlug === "oils-sauces-and-condiments")?.listings.map((l) => l.id)).toEqual([aisledCustomListingId]);
    const flow = await getFlowCatalog(storeAId);
    expect(flow.find((item) => item.listingId === aisledCustomListingId)?.categoryId).toBeTruthy();
    expect(flow.find((item) => item.listingId === aisledCustomListingId)?.categoryId).not.toBe("uncategorized");
  });

  // #72 AC5, #782 AC4: a custom listing without an aisle stays out of aisles but is searchable
  it("custom-only listing is absent from category browse but found by search", async () => {
    const browse = await listingsByCategory(storeAId, "fresh-produce");
    expect(browse.listings.some((l) => l.id === customOnlyListingId)).toBe(false);
    const search = await searchListings(storeAId, "Custom Item");
    expect(search.some((r) => r.id === customOnlyListingId)).toBe(true);
  });

  // Seam 3: listing detail store isolation
  it("listing detail returns listing for its own store", async () => {
    const detail = await getListingDetail(storeAId, listingAId);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(listingAId);
    expect(detail!.displayName).toBe("Fluted Pumpkin Leaves");
    expect(detail!.variants.length).toBe(2);
  });

  it("the product page gets catering terms, a prepared item's stated allergens and claims, and the stock left (#808)", async () => {
    const scoped = storeScoped(storeAId);
    const chinChin = await scoped.listing.create({
      data: {
        storeId: storeAId, customName: "Chin Chin 808", price: 599, stockMode: "counted", qty: 3, frozen: false, perishable: false,
        prepared: "cold", cateringLeadHours: 72, cateringMinQty: 4,
      },
    });
    await scoped.listingVariant.create({ data: { listingId: chinChin.id, label: "8 oz bag", price: 599, weightG: 227 } });
    await storeScopedTransaction(storeAId, (tx) => tx.listingAttributes.create({
      data: { listingId: chinChin.id, storeId: storeAId, allergens: ["wheat"], allergensStatus: "known", dietaryClaims: ["vegetarian"], dietaryStatus: "known" },
    }));
    const detail = await getListingDetail(storeAId, chinChin.id);
    expect(detail).toMatchObject({ catering: { leadHours: 72, minQty: 4 }, prepared: "cold" });
    expect(await getListingFacts(storeAId, chinChin.id)).toEqual({ stockLeft: 3, allergens: ["wheat"], dietary: ["vegetarian"] });
    const card = (await getActiveListings(storeAId)).find((listing) => listing.id === chinChin.id);
    expect(card).toMatchObject({ stockLeft: 3, cateringMinQty: 4 });
    const flow = (await getFlowCatalog(storeAId)).find((item) => item.listingId === chinChin.id);
    expect(flow).toMatchObject({ stockLeft: 3, cateringMinQty: 4 });
  });

  it("the product page states nothing for unknown allergens or for grocery, and no stock count outside counted mode (#808)", async () => {
    expect(await getListingFacts(storeBId, listingBId)).toEqual({ stockLeft: undefined, allergens: null, dietary: null });
    expect(await getListingFacts(storeAId, listingAId)).toMatchObject({ stockLeft: 20, allergens: null });
    expect(await getListingFacts(storeBId, listingAId)).toBeNull();
  });

  it("listing detail returns null for cross-store access", async () => {
    const detail = await getListingDetail(storeBId, listingAId);
    expect(detail).toBeNull();
  });

  it("listing detail shows variant prices and weights", async () => {
    const detail = await getListingDetail(storeAId, listingAId);
    expect(detail!.variants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "1 bunch", price: 500, weightG: 200 }),
        expect.objectContaining({ label: "3 bunches", price: 1400, weightG: 600 }),
      ]),
    );
  });

  it("listing detail shows correct stock badge", async () => {
    const detail = await getListingDetail(storeAId, listingAId);
    expect(detail!.badge).toBe("in-stock");
  });

  // Seam 2 & 5: search store isolation + synonym integration
  it("search 'ugu' scoped to store A returns only store A listing", async () => {
    const results = await searchListings(storeAId, "ugu");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id === listingAId)).toBe(true);
    expect(results.some((r) => r.id === listingBId)).toBe(false);
  });

  it("search 'ugu' scoped to store B returns only store B listing", async () => {
    const results = await searchListings(storeBId, "ugu");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id === listingBId)).toBe(true);
    expect(results.some((r) => r.id === listingAId)).toBe(false);
  });

  it("search for nonexistent term returns empty", async () => {
    const results = await searchListings(storeAId, "xyznonexistent123");
    expect(results).toHaveLength(0);
  });

  // Seam 6: pg_trgm fuzzy search (word_similarity)
  it("ranks the exact local egusi match first without cassava or garden eggs", async () => {
    const store = await rawPrisma.store.findUniqueOrThrow({ where: { slug: "mama-ngozi" } });
    const results = await searchListings(store.id, "egusi");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name.toLowerCase()).toContain("egusi");
    expect(results.some(r => /cassava|garden eggs/i.test(r.name))).toBe(false);
  });

  it("ranks English and local prefixes before unrelated fuzzy candidates", async () => {
    const results = await searchListings(storeAId, "ug");
    expect(results[0]?.id).toBe(listingAId);
    expect(await searchListings(storeAId, "x")).toEqual([]);
  });
  it("fuzzy search 'pumkin' finds 'Fluted Pumpkin Leaves' via trigram", async () => {
    const results = await searchListings(storeAId, "pumkin");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id === listingAId)).toBe(true);
  });

  it("category browse shows starting price from cheapest variant", async () => {
    const result = await listingsByCategory(storeAId, "fresh-produce");
    const listing = result.listings.find((l) => l.id === listingAId);
    expect(listing).toBeDefined();
    expect(listing!.startingPrice).toBe(500);
    expect(listing!.packLabels).toEqual(expect.arrayContaining(["1 bunch", "3 bunches"]));
    expect(listing!.packOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "3 bunches", price: 1400, weightG: 600 }),
    ]));
  });

  it("inactive listing excluded from category browse", async () => {
    const result = await listingsByCategory(storeAId, "fresh-produce");
    expect(result.listings.some((l) => l.id === inactiveListingId)).toBe(false);
    expect(result.listings.some((l) => l.id === listingAId)).toBe(true);
  });

  it("inactive listing excluded from getListingDetail", async () => {
    const detail = await getListingDetail(storeAId, inactiveListingId);
    expect(detail).toBeNull();
  });

  it("inactive listing excluded from getActiveListings", async () => {
    const listings = await getActiveListings(storeAId);
    expect(listings.some((l) => l.id === inactiveListingId)).toBe(false);
  });

  it("getActiveListings returns store A listings only", async () => {
    const listings = await getActiveListings(storeAId);
    expect(listings.length).toBeGreaterThanOrEqual(1);
    expect(listings.every((l) => l.id !== listingBId)).toBe(true);
  });

  // Collection service tests (S9)
  it("getActiveCollections returns store A collections", async () => {
    const collections = await getActiveCollections(storeAId);
    expect(collections.length).toBeGreaterThanOrEqual(1);
    expect(collections.some((c) => c.slug === "test-soup-kit")).toBe(true);
  });

  it("getActiveCollections isolates by store", async () => {
    const collections = await getActiveCollections(storeBId);
    expect(collections.every((c) => c.slug !== "test-soup-kit")).toBe(true);
  });

  it("getCollectionListings returns listings for a collection", async () => {
    const result = await getCollectionListings(storeAId, "test-soup-kit");
    expect(result.collection).not.toBeNull();
    expect(result.collection!.title).toBe("Test Soup Kit");
    expect(result.listings.length).toBeGreaterThanOrEqual(1);
    expect(result.listings.some((l) => l.id === listingAId)).toBe(true);
  });

  it("never shows e2e-prefixed listings to customers on any storefront read (#116)", async () => {
    const [flow, browse, search, active, rails, collection] = await Promise.all([
      getFlowCatalog(storeAId),
      listingsByCategory(storeAId, "fresh-produce"),
      searchListings(storeAId, "E2E Sentinel"),
      getActiveListings(storeAId),
      getListingsByCategory(storeAId),
      getCollectionListings(storeAId, "test-soup-kit"),
    ]);
    expect(flow.some((i) => i.listingId === e2eListingId)).toBe(false);
    expect(browse.listings.some((i) => i.id === e2eListingId)).toBe(false);
    expect(search.some((i) => i.id === e2eListingId)).toBe(false);
    expect(active.some((i) => i.id === e2eListingId)).toBe(false);
    expect(rails.flatMap((r) => r.listings).some((i) => i.id === e2eListingId)).toBe(false);
    expect(collection.listings.some((i) => i.id === e2eListingId)).toBe(false);
    // Unnamed listings (custom_name NULL) must still show: NOT LIKE alone would drop NULLs.
    expect(active.some((i) => i.id === listingAId)).toBe(true);
    expect(search.length === 0 || search.every((i) => !i.name.startsWith("E2E "))).toBe(true);
  });

  it("getCollectionListings returns null for nonexistent slug", async () => {
    const result = await getCollectionListings(storeAId, "nonexistent-collection");
    expect(result.collection).toBeNull();
    expect(result.listings).toHaveLength(0);
  });

  it("getCollectionListings excludes inactive listings", async () => {
    const result = await getCollectionListings(storeAId, "test-soup-kit");
    expect(result.listings.every((l) => l.id !== inactiveListingId)).toBe(true);
  });

  // getListingsByCategory (new return type)
  it("getListingsByCategory returns category rails with slugs", async () => {
    const rails = await getListingsByCategory(storeAId);
    expect(rails.length).toBeGreaterThanOrEqual(1);
    const vegRail = rails.find((r) => r.categorySlug === "fresh-produce");
    expect(vegRail).toBeDefined();
    expect(vegRail!.listings.length).toBeGreaterThanOrEqual(1);
  });

  async function seedProbe(customName: string, variants: { id: string; label: string; price: number; weightG: number }[]) {
    const listing = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
      rawPrisma.listing.create({
        data: {
          storeId: storeAId,
          masterProductId,
          customName,
          price: 100,
          stockMode: "counted",
          qty: 8,
          frozen: false,
          perishable: false,
          confidence: 0.9,
        },
      }),
    ]);
    const listingId = (listing[2] as { id: string }).id;
    for (const variant of variants) {
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
        rawPrisma.listingVariant.create({ data: { ...variant, listingId } }),
      ]);
    }
    const collection = await storeScoped(storeAId).storeCollection.create({
      data: { storeId: storeAId, title: customName, slug: customName, active: true },
    });
    await storeScoped(storeAId).storeCollectionListing.create({
      data: { collectionId: collection.id, listingId },
    });
    return { listingId, collectionId: collection.id };
  }

  async function dropProbe(listingId: string, collectionId: string) {
    await storeScoped(storeAId).storeCollectionListing.deleteMany({ where: { listingId } });
    await storeScoped(storeAId).listingVariant.deleteMany({ where: { listingId } });
    await storeScoped(storeAId).listing.deleteMany({ where: { id: listingId } });
    await storeScoped(storeAId).storeCollection.deleteMany({ where: { id: collectionId } });
  }

  async function packIds(listingId: string, collectionSlug: string) {
    const [browse, active, detail, rails, collection, flow] = await Promise.all([
      listingsByCategory(storeAId, "fresh-produce"),
      getActiveListings(storeAId),
      getListingDetail(storeAId, listingId),
      getListingsByCategory(storeAId),
      getCollectionListings(storeAId, collectionSlug),
      getFlowCatalog(storeAId),
    ]);
    const fromBrowse = browse.listings.find((item) => item.id === listingId)?.packOptions?.map((pack) => pack.id);
    const fromActive = active.find((item) => item.id === listingId)?.packOptions?.map((pack) => pack.id);
    const fromRails = rails.flatMap((rail) => rail.listings).find((item) => item.id === listingId)?.packOptions?.map((pack) => pack.id);
    const fromCollection = collection.listings.find((item) => item.id === listingId)?.packOptions?.map((pack) => pack.id);
    const fromDetail = detail?.variants.map((pack) => pack.id);
    const fromFlow = flow.filter((item) => item.listingId === listingId).map((item) => item.variantId);
    return { fromBrowse, fromActive, fromRails, fromCollection, fromDetail, fromFlow, detailDefault: browse.listings.find((item) => item.id === listingId)?.variantId };
  }

  it("list and detail reads return packs cheapest first whatever the stored order", async () => {
    const prefix = `t226-ord-${Date.now()}`;
    const high = `${prefix}-high`;
    const low = `${prefix}-low`;
    const mid = `${prefix}-mid`;
    const expected = [low, mid, high];
    const seeded = await seedProbe(prefix, [
      { id: high, label: "High", price: 3000, weightG: 300 },
      { id: low, label: "Low", price: 1000, weightG: 100 },
      { id: mid, label: "Mid", price: 2000, weightG: 200 },
    ]);
    const listener = listenForVariantQueries();
    const take = () => {
      const batch = listener.seen.slice();
      listener.seen.length = 0;
      return batch;
    };
    const assertThisReadOrdersVariants = (label: string) => {
      const variantQueries = take().filter((query) => /listing_variants/i.test(query) && /select/i.test(query));
      expect(variantQueries.length, label).toBeGreaterThan(0);
      for (const query of variantQueries) assertPackQueryOrder(query, label);
    };
    try {
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.store_id', ${storeAId}, true)`,
        rawPrisma.listingVariant.update({ where: { id: low }, data: { label: "Low" } }),
      ]);
      take();
      await listingsByCategory(storeAId, "fresh-produce");
      assertThisReadOrdersVariants("listingsByCategory");
      await getActiveListings(storeAId);
      assertThisReadOrdersVariants("getActiveListings");
      await getListingsByCategory(storeAId);
      assertThisReadOrdersVariants("getListingsByCategory");
      await getCollectionListings(storeAId, prefix);
      assertThisReadOrdersVariants("getCollectionListings");
      const ids = await packIds(seeded.listingId, prefix);
      const packedReads = take().filter((query) => /listing_variants/i.test(query) && /select/i.test(query));
      expect(packedReads.length, "detail and flow").toBeGreaterThan(0);
      for (const query of packedReads) assertPackQueryOrder(query, "detail and flow");
      expect(ids.fromBrowse).toEqual(expected);
      expect(ids.fromActive).toEqual(expected);
      expect(ids.fromRails).toEqual(expected);
      expect(ids.fromCollection).toEqual(expected);
      expect(ids.fromDetail).toEqual(expected);
      expect(ids.fromFlow).toEqual(expected);
      expect(ids.detailDefault).toBe(low);
      const search = await searchListings(storeAId, prefix);
      const searchQueries = take().filter((query) => /listing_variants/i.test(query) && /select/i.test(query));
      expect(searchQueries.length, "searchListings").toBeGreaterThan(0);
      for (const query of searchQueries) assertPackQueryOrder(query, "searchListings");
      expect(search.find((item) => item.id === seeded.listingId)?.variantId).toBe(low);
    } finally {
      listener.restore();
      await dropProbe(seeded.listingId, seeded.collectionId);
    }
  });

  it("packs with equal prices are ordered by id in every read", async () => {
    const prefix = `t226-tie-${Date.now()}`;
    const low = `${prefix}-m-low`;
    const upperA = `${prefix}-A.pack`;
    const upperB = `${prefix}-B-pack`;
    const lowerA = `${prefix}-a_pack`;
    const lowerB = `${prefix}-b-pack`;
    // All five cost the same, so the winner is the id. 0x41 A, 0x42 B, 0x61 a, 0x62 b, then m.
    const expected = [upperA, upperB, lowerA, lowerB, low];
    const seeded = await seedProbe(prefix, [
      { id: low, label: "low", price: 200, weightG: 20 },
      { id: lowerB, label: "b", price: 200, weightG: 20 },
      { id: lowerA, label: "a", price: 200, weightG: 20 },
      { id: upperB, label: "B", price: 200, weightG: 20 },
      { id: upperA, label: "A", price: 200, weightG: 20 },
    ]);
    const listener = listenForVariantQueries();
    try {
      const ids = await packIds(seeded.listingId, prefix);
      expect(ids.fromBrowse).toEqual(expected);
      expect(ids.fromActive).toEqual(expected);
      expect(ids.fromRails).toEqual(expected);
      expect(ids.fromCollection).toEqual(expected);
      expect(ids.fromDetail).toEqual(expected);
      expect(ids.fromFlow).toEqual(expected);
      expect(ids.detailDefault).toBe(upperA);
      const search = await searchListings(storeAId, prefix);
      expect(search.find((item) => item.id === seeded.listingId)?.variantId).toBe(upperA);
      const variantQueries = listener.seen.filter((query) => /listing_variants/i.test(query) && /select/i.test(query));
      expect(variantQueries.length).toBeGreaterThan(0);
      for (const query of variantQueries) assertPackQueryOrder(query, "equal price");
    } finally {
      listener.restore();
      await dropProbe(seeded.listingId, seeded.collectionId);
    }
  });

  it("store B reads never return store A's listing or packs", async () => {
    const [browse, active, rails, collection, detail, flow] = await Promise.all([
      listingsByCategory(storeBId, "fresh-produce"),
      getActiveListings(storeBId),
      getListingsByCategory(storeBId),
      getCollectionListings(storeBId, "test-soup-kit"),
      getListingDetail(storeBId, listingAId),
      getFlowCatalog(storeBId),
    ]);
    expect(browse.listings.some((item) => item.id === listingAId)).toBe(false);
    expect(active.some((item) => item.id === listingAId)).toBe(false);
    expect(rails.flatMap((rail) => rail.listings).some((item) => item.id === listingAId)).toBe(false);
    expect(collection.listings.some((item) => item.id === listingAId)).toBe(false);
    expect(detail).toBeNull();
    expect(flow.some((item) => item.listingId === listingAId)).toBe(false);
    const [own, foreign] = await Promise.all([
      getListingDetail(storeAId, listingAId),
      getListingDetail(storeBId, listingAId),
    ]);
    expect(own?.id).toBe(listingAId);
    expect(foreign).toBeNull();
  });

  it("storeScoped(B) cannot write store A's listings, variants or collection items", async () => {
    const stamp = `t226-rls-${Date.now()}`;
    const own = await storeScoped(storeAId).listing.create({
      data: {
        storeId: storeAId,
        customName: stamp,
        price: 250,
        stockMode: "counted",
        qty: 3,
        frozen: false,
        perishable: false,
        confidence: 1,
      },
    });
    const variant = await storeScoped(storeAId).listingVariant.create({
      data: { listingId: own.id, label: "1 bag", price: 250, weightG: 100 },
    });
    const collection = await storeScoped(storeAId).storeCollection.create({
      data: { storeId: storeAId, title: stamp, slug: stamp, active: true },
    });
    const link = await storeScoped(storeAId).storeCollectionListing.create({
      data: { collectionId: collection.id, listingId: own.id },
    });
    const storeBCollection = await storeScoped(storeBId).storeCollection.create({
      data: { storeId: storeBId, title: `${stamp}-b`, slug: stamp, active: true },
    });
    const storeBListing = await storeScoped(storeBId).listing.create({
      data: {
        storeId: storeBId,
        customName: `${stamp}-b`,
        price: 300,
        stockMode: "counted",
        qty: 2,
        frozen: false,
        perishable: false,
        confidence: 1,
      },
    });
    try {
      await expect(storeScoped(storeBId).listing.create({
        data: {
          storeId: storeAId,
          customName: `${stamp}-stolen`,
          price: 1,
          stockMode: "counted",
          qty: 1,
          frozen: false,
          perishable: false,
          confidence: 1,
        },
      })).rejects.toThrow(/42501|row-level security/i);
      await expect(storeScoped(storeBId).listingVariant.create({
        data: { listingId: own.id, label: "stolen", price: 1, weightG: 1 },
      })).rejects.toThrow(/42501|row-level security/i);
      await expect(storeScoped(storeBId).storeCollection.create({
        data: { storeId: storeAId, title: "stolen", slug: `${stamp}-stolen`, active: true },
      })).rejects.toThrow(/42501|row-level security/i);
      await expect(storeScoped(storeBId).storeCollectionListing.create({
        data: { collectionId: collection.id, listingId: storeBListing.id },
      })).rejects.toThrow(/42501|row-level security/i);
      await expect(storeScoped(storeBId).storeCollectionListing.create({
        data: { collectionId: storeBCollection.id, listingId: own.id },
      })).rejects.toThrow(/42501|row-level security/i);
      expect((await storeScoped(storeBId).listing.updateMany({ where: { id: own.id }, data: { price: 1 } })).count).toBe(0);
      expect((await storeScoped(storeBId).listing.deleteMany({ where: { id: own.id } })).count).toBe(0);
      expect((await storeScoped(storeBId).listingVariant.updateMany({ where: { id: variant.id }, data: { price: 1 } })).count).toBe(0);
      expect((await storeScoped(storeBId).listingVariant.deleteMany({ where: { id: variant.id } })).count).toBe(0);
      expect((await storeScoped(storeBId).storeCollection.updateMany({ where: { id: collection.id }, data: { title: "stolen" } })).count).toBe(0);
      expect((await storeScoped(storeBId).storeCollection.deleteMany({ where: { id: collection.id } })).count).toBe(0);
      expect((await storeScoped(storeBId).storeCollectionListing.updateMany({ where: { id: link.id }, data: { sortOrder: 9 } })).count).toBe(0);
      expect((await storeScoped(storeBId).storeCollectionListing.deleteMany({ where: { id: link.id } })).count).toBe(0);
      // A link that crosses stores (only a platform admin can write one) is invisible to both stores.
      const [, , crossed] = await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.storeCollectionListing.create({ data: { collectionId: collection.id, listingId: storeBListing.id } }),
      ]);
      expect(await storeScoped(storeAId).storeCollectionListing.findMany({ where: { id: crossed.id } })).toEqual([]);
      expect(await storeScoped(storeBId).storeCollectionListing.findMany({ where: { id: crossed.id } })).toEqual([]);
      expect((await storeScoped(storeAId).storeCollectionListing.findMany({ where: { collectionId: collection.id } })).map((item) => item.id)).toEqual([link.id]);
      await rawPrisma.$transaction([
        rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
        rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        rawPrisma.storeCollectionListing.deleteMany({ where: { id: crossed.id } }),
      ]);
      const reread = await storeScoped(storeAId).listing.findUnique({ where: { id: own.id }, include: { variants: true, collectionItems: true } });
      expect(reread?.price).toBe(250);
      expect(reread?.variants.map((item) => item.id)).toEqual([variant.id]);
      expect(reread?.collectionItems.map((item) => item.id)).toEqual([link.id]);
      expect(reread?.collectionItems.map((item) => item.sortOrder)).toEqual([0]);
      const [aShelf, bShelf] = await Promise.all([
        getCollectionListings(storeAId, stamp),
        getCollectionListings(storeBId, stamp),
      ]);
      expect(aShelf.listings.map((item) => item.id)).toEqual([own.id]);
      expect(bShelf.listings.map((item) => item.id)).toEqual([]);
    } finally {
      await storeScoped(storeAId).storeCollectionListing.deleteMany({ where: { listingId: own.id } });
      await storeScoped(storeBId).storeCollectionListing.deleteMany({ where: { listingId: storeBListing.id } });
      await storeScoped(storeAId).listingVariant.deleteMany({ where: { listingId: own.id } });
      await storeScoped(storeAId).listing.deleteMany({ where: { id: own.id } });
      await storeScoped(storeBId).listing.deleteMany({ where: { id: storeBListing.id } });
      await storeScoped(storeAId).storeCollection.deleteMany({ where: { id: collection.id } });
      await storeScoped(storeBId).storeCollection.deleteMany({ where: { id: storeBCollection.id } });
    }
  });
});

const PRISMA_PACK_ORDER = '"public"."listing_variants"."price" ASC, "public"."listing_variants"."id" ASC';
const SEARCH_PACK_ORDER = 'lv.price, lv.id COLLATE "C"';

function orderByClause(query: string): string {
  const match = query.match(/\bORDER BY\s+([\s\S]+?)(?:\s+OFFSET\b|\s+LIMIT\b|\s+FOR\b|$)/i);
  return match?.[1].replace(/\s+/g, " ").trim() ?? "";
}

function assertPackQueryOrder(query: string, label: string) {
  const clause = orderByClause(query);
  const expected = /\blv\.price\b/i.test(clause) ? SEARCH_PACK_ORDER : PRISMA_PACK_ORDER;
  expect(clause, label).toBe(expected);
}

function listenForVariantQueries() {
  const seen: string[] = [];
  const proto = Client.prototype as unknown as { query: (this: unknown, ...args: unknown[]) => unknown };
  const original = proto.query;
  proto.query = function (this: unknown, ...args: unknown[]) {
    const first = args[0] as { text?: string } | string | undefined;
    const text = typeof first === "string" ? first : first?.text;
    if (typeof text === "string") seen.push(text);
    return original.apply(this, args);
  };
  return { seen, restore: () => { proto.query = original; } };
}
