vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-store-slug": currentSlug }) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("notFound"); } }));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { GET } from "./route";

let currentSlug = "";
const hasDb = !!process.env.DATABASE_URL;
const slugA = "sr-route-store-a";
const slugB = "sr-route-store-b";

const call = async (slug: string, qs: string) => {
  currentSlug = slug;
  return GET(new NextRequest(`http://localhost/api/storefront/search${qs}`));
};

describe.skipIf(!hasDb)("GET /api/storefront/search (DB integration)", () => {
  let prisma: PrismaClient;
  let storeAId: string;
  let storeBId: string;
  let listingAId: string;

  const scoped = (storeId: string) => [
    prisma.$executeRaw`SET LOCAL ROLE app_user`,
    prisma.$executeRaw`SELECT set_config('app.store_id', ${storeId}, true)`,
  ];

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL!) });
    await prisma.$connect();
    const a = await prisma.store.upsert({ where: { slug: slugA }, update: {}, create: { slug: slugA, name: "SR A", themePreset: "palm-and-shea" } });
    const b = await prisma.store.upsert({ where: { slug: slugB }, update: {}, create: { slug: slugB, name: "SR B", themePreset: "palm-and-shea" } });
    storeAId = a.id;
    storeBId = b.id;
    await cleanup(); // drop leftovers from an aborted earlier run
    const [, , listing] = await prisma.$transaction([
      ...scoped(storeAId),
      prisma.listing.create({ data: { storeId: storeAId, customName: "Routetest Egusi Seeds", price: 700, stockMode: "counted", qty: 5, frozen: false, perishable: false, confidence: 0.9 } }),
    ]);
    listingAId = (listing as { id: string }).id;
    await prisma.$transaction([
      ...scoped(storeAId),
      prisma.listingVariant.create({ data: { listingId: listingAId, label: "1 bag", price: 700, weightG: 500 } }),
    ]);
  });

  const cleanup = async () => {
    const storeIds = [storeAId, storeBId].filter((id): id is string => !!id);
    if (storeIds.length === 0) return;
    await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.listingVariant.deleteMany({ where: { listing: { storeId: { in: storeIds } } } }),
    ]);
    await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL ROLE app_user`,
      prisma.$executeRaw`SELECT set_config('app.is_platform_admin', 'true', true)`,
      prisma.listing.deleteMany({ where: { storeId: { in: storeIds } } }),
    ]);
  };

  afterAll(async () => {
    await cleanup();
    if (storeAId || storeBId) await prisma.store.deleteMany({ where: { id: { in: [storeAId, storeBId].filter((id): id is string => !!id) } } });
    await prisma.$disconnect();
  });

  it("returns 200 with results containing expected fields for a valid query", async () => {
    const res = await call(slugA, "?q=routetest");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toHaveLength(1);
    expect(body.results[0]).toEqual(expect.objectContaining({ id: listingAId, name: "Routetest Egusi Seeds", price: 700, badge: "in-stock" }));
  });

  it("returns 200 with empty results for missing or blank q", async () => {
    for (const qs of ["", "?q=", "?q=%20%20"]) {
      const res = await call(slugA, qs);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ results: [] });
    }
  });

  it("does not leak store A listings into store B search", async () => {
    const res = await call(slugB, "?q=routetest");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
  });
});
