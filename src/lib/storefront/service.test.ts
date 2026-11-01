import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

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
} from "./service";

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Storefront service (DB integration)", () => {
  let rawPrisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let masterProductId: string;
  let synonymId: string;
  let listingAId: string;
  let listingBId: string;
  let inactiveListingId: string;
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

  beforeAll(async () => {
    const adapter = new PrismaPg(process.env.DATABASE_URL!);
    rawPrisma = new PrismaClient({ adapter });
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

    // Get the vegetables category (seeded by migration)
    const vegCat = await rawPrisma.category.findUnique({ where: { slug: "vegetables" } });

    // Create master product with category
    const mp = await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.masterProduct.create({
        data: { name: "Fluted Pumpkin Leaves", categoryId: vegCat?.id ?? null },
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
    ]);
  });

  afterAll(async () => {
    // Clean up in reverse order of dependencies
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeCollectionListing.deleteMany({ where: { collectionId } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.storeCollection.deleteMany({ where: { id: collectionId } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.listingVariant.deleteMany({ where: { listingId: { in: [listingAId, listingBId, inactiveListingId] } } }),
    ]);
    await rawPrisma.$transaction([
      rawPrisma.$executeRaw`SET LOCAL ROLE app_user`,
      rawPrisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      rawPrisma.listing.deleteMany({ where: { id: { in: [listingAId, listingBId, inactiveListingId] } } }),
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

  // Seam 7: category seed migration
  it("has exactly 11 categories after seed", async () => {
    const categories = await listCategories();
    expect(categories.length).toBe(11);
    const slugs = categories.map((c) => c.slug);
    expect(slugs).toContain("tubers-and-roots");
    expect(slugs).toContain("vegetables");
    expect(slugs).toContain("spices-and-seasonings");
    expect(slugs).toContain("grains-and-flours");
    expect(slugs).toContain("fish-and-meat");
    expect(slugs).toContain("frozen");
    expect(slugs).toContain("snacks");
    expect(slugs).toContain("drinks");
    expect(slugs).toContain("beauty");
    expect(slugs).toContain("oils-and-butters");
    expect(slugs).toContain("pantry-staples");
  });

  // Seam 1: category browse store isolation
  it("category browse returns only store A listings for store A", async () => {
    const result = await listingsByCategory(storeAId, "vegetables");
    expect(result.category).not.toBeNull();
    expect(result.category!.slug).toBe("vegetables");
    expect(result.listings.length).toBeGreaterThanOrEqual(1);
    expect(result.listings.some((l) => l.id === listingAId)).toBe(true);
    expect(result.listings.some((l) => l.id === listingBId)).toBe(false);
  });

  it("category browse returns only store B listings for store B", async () => {
    const result = await listingsByCategory(storeBId, "vegetables");
    expect(result.listings.length).toBeGreaterThanOrEqual(1);
    expect(result.listings.some((l) => l.id === listingBId)).toBe(true);
    expect(result.listings.some((l) => l.id === listingAId)).toBe(false);
  });

  // Seam 3: listing detail store isolation
  it("listing detail returns listing for its own store", async () => {
    const detail = await getListingDetail(storeAId, listingAId);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(listingAId);
    expect(detail!.displayName).toBe("Fluted Pumpkin Leaves");
    expect(detail!.variants.length).toBe(2);
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
  it("fuzzy search 'pumkin' finds 'Fluted Pumpkin Leaves' via trigram", async () => {
    const results = await searchListings(storeAId, "pumkin");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id === listingAId)).toBe(true);
  });

  it("category browse shows starting price from cheapest variant", async () => {
    const result = await listingsByCategory(storeAId, "vegetables");
    const listing = result.listings.find((l) => l.id === listingAId);
    expect(listing).toBeDefined();
    expect(listing!.startingPrice).toBe(500);
    expect(listing!.packLabels).toEqual(expect.arrayContaining(["1 bunch", "3 bunches"]));
    expect(listing!.packOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "3 bunches", price: 1400, weightG: 600 }),
    ]));
  });

  it("inactive listing excluded from category browse", async () => {
    const result = await listingsByCategory(storeAId, "vegetables");
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
    const vegRail = rails.find((r) => r.categorySlug === "vegetables");
    expect(vegRail).toBeDefined();
    expect(vegRail!.listings.length).toBeGreaterThanOrEqual(1);
  });
});
