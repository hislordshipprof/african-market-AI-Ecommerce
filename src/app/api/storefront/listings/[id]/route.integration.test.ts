vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(currentSlug ? { "x-store-slug": currentSlug } : {}) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("notFound"); } }));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { GET } from "./route";

let currentSlug = "";
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("GET /api/storefront/listings/[id]", () => {
  let prisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let suspendedId: string;
  let listingId: string;
  let inactiveId: string;
  const slugA = "t226-route-a";
  const slugB = "t226-route-b";
  const slugSuspended = "t226-route-suspended";
  const low = "t226-route-low";
  const mid = "t226-route-mid";
  const high = "t226-route-high";

  const scoped = (storeId: string) => [
    prisma.$executeRaw`SET LOCAL ROLE app_user`,
    prisma.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`,
  ];

  const call = (slug: string, id: string) => {
    currentSlug = slug;
    return GET(new Request("http://localhost/api/storefront/listings/" + id), {
      params: Promise.resolve({ id }),
    });
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await prisma.$connect();
    const [a, b, suspended] = await Promise.all([
      prisma.store.upsert({ where: { slug: slugA }, update: { status: "active" }, create: { slug: slugA, name: "Route A", themePreset: "palm-and-shea" } }),
      prisma.store.upsert({ where: { slug: slugB }, update: { status: "active" }, create: { slug: slugB, name: "Route B", themePreset: "palm-and-shea" } }),
      prisma.store.upsert({ where: { slug: slugSuspended }, update: { status: "suspended" }, create: { slug: slugSuspended, name: "Route Suspended", themePreset: "palm-and-shea", status: "suspended" } }),
    ]);
    storeAId = a.id;
    storeBId = b.id;
    suspendedId = suspended.id;
    await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.listingVariant.deleteMany({ where: { id: { in: [low, mid, high] } } }),
    ]);
    const [, , listing] = await prisma.$transaction([
      ...scoped(storeAId),
      prisma.listing.create({
        data: {
          storeId: storeAId,
          customName: "Route pack order",
          price: 100,
          stockMode: "counted",
          qty: 4,
          frozen: false,
          perishable: false,
          confidence: 0.9,
          active: true,
        },
      }),
    ]);
    listingId = (listing as { id: string }).id;
    for (const variant of [
      { id: high, label: "High", price: 3000, weightG: 300 },
      { id: low, label: "Low", price: 1000, weightG: 100 },
      { id: mid, label: "Mid", price: 2000, weightG: 200 },
    ]) {
      await prisma.$transaction([
        ...scoped(storeAId),
        prisma.listingVariant.create({ data: { ...variant, listingId } }),
      ]);
    }
    const [, , inactive] = await prisma.$transaction([
      ...scoped(storeAId),
      prisma.listing.create({
        data: {
          storeId: storeAId,
          customName: "Route inactive",
          price: 100,
          stockMode: "counted",
          qty: 0,
          frozen: false,
          perishable: false,
          confidence: 0.9,
          active: false,
        },
      }),
    ]);
    inactiveId = (inactive as { id: string }).id;
  });

  afterAll(async () => {
    if (!prisma) return;
    const ids = [storeAId, storeBId, suspendedId].filter(Boolean);
    if (ids.length) {
      await prisma.$transaction([
        prisma.$executeRaw`SET LOCAL ROLE app_user`,
        prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        prisma.listingVariant.deleteMany({ where: { listing: { storeId: { in: ids } } } }),
      ]);
      await prisma.$transaction([
        prisma.$executeRaw`SET LOCAL ROLE app_user`,
        prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
        prisma.listing.deleteMany({ where: { storeId: { in: ids } } }),
      ]);
      await prisma.store.deleteMany({ where: { id: { in: ids } } });
    }
    await prisma.$disconnect();
  });

  it("returns packs cheapest first for the store's listing", async () => {
    const response = await call(slugA, listingId);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.variants.map((variant: { id: string }) => variant.id)).toEqual([low, mid, high]);
    expect(body.id).toBe(listingId);
  });

  it("store B gets 404 for store A's listing id", async () => {
    const response = await call(slugB, listingId);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Listing not found" });
  });

  it("suspended inactive unknown and foreign-store details remain unavailable", async () => {
    const suspended = await call(slugSuspended, listingId);
    expect(suspended.status).toBe(404);
    expect(await suspended.json()).toEqual({ error: "Store unavailable" });

    const inactive = await call(slugA, inactiveId);
    expect(inactive.status).toBe(404);
    expect(await inactive.json()).toEqual({ error: "Listing not found" });

    const missing = await call(slugA, "t226-route-missing");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Listing not found" });

    await expect(call("", listingId)).rejects.toThrow("notFound");
    await expect(call("t226-route-unknown", listingId)).rejects.toThrow("notFound");
  });

  it("malformed listing id is 404 before cache", async () => {
    const response = await call("t226-route-unknown", "not-a-listing-id");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Listing not found" });
  });
});
