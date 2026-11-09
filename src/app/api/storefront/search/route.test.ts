vi.mock("next/cache", () => ({ unstable_cache: (fn: () => unknown) => fn, revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-store-slug": currentSlug }) }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("notFound"); } }));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
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
    prisma = testPrismaClient();
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

  it("over-long q is 400 with no read", async () => {
    currentSlug = "this-store-does-not-exist";
    const res = await GET(new NextRequest(`http://localhost/api/storefront/search?q=${"a".repeat(201)}`));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Search query is too long" });
    const spaces = await call(slugA, `?q=${encodeURIComponent(" ".repeat(201))}`);
    expect(spaces.status).toBe(200);
    expect(await spaces.json()).toEqual({ results: [] });
  });

  it("suspended store is 404", async () => {
    await prisma.store.update({ where: { id: storeAId }, data: { status: "suspended" } });
    const res = await call(slugA, "?q=");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Store unavailable" });
    await prisma.store.update({ where: { id: storeAId }, data: { status: "active" } });
  });

  it("search 61st request 429 with Retry-After", async () => {
    currentSlug = slugA;
    const headers = { "x-shop-browser": "browser61ok", "x-forwarded-for": "198.51.100.61" };
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) {
      last = await GET(new NextRequest("http://localhost/api/storefront/search?q=routetest", { headers }));
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toBeTruthy();
    expect(await last?.json()).toEqual({ error: "Too many requests" });
    const other = await GET(new NextRequest("http://localhost/api/storefront/search?q=routetest", {
      headers: { "x-shop-browser": "browser62ok", "x-forwarded-for": "198.51.100.61" },
    }));
    expect(other.status).toBe(200);
  });
});
