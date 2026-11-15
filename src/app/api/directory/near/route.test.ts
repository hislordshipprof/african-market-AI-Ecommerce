import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { GET, NEAR_BROWSER_LIMIT } from "./route";

const hasDb = !!process.env.DATABASE_URL;
const stamp = Date.now().toString(36);
let caller = 0;

// A fresh browser and IP per request, so no test shares a rate-limit window with another.
function call(qs: string, browser = `t452-${stamp}-${caller++}`) {
  return GET(
    new NextRequest(`http://localhost:3000/api/directory/near${qs}`, {
      headers: { host: "localhost:3000", "x-shop-browser": browser, "x-forwarded-for": `198.51.100.${caller % 250}-${stamp}` },
    }),
  );
}

describe.skipIf(!hasDb)("GET /api/directory/near", () => {
  let raw: PrismaClient;
  const slug = `t452-route-${stamp}`;

  beforeAll(async () => {
    process.env.PLATFORM_ROOT_DOMAIN = "localhost";
    raw = testPrismaClient();
    // Two miles north of the 77002 centroid.
    await raw.store.create({ data: { slug, name: "Route Market", city: "Houston", state: "TX", lat: 29.7858, lng: -95.3657, listed: true } });
  });

  afterAll(async () => {
    await raw.store.deleteMany({ where: { slug } });
    await raw.appRateLimit.deleteMany({ where: { key: { contains: stamp } } });
    await raw.$disconnect();
  });

  it("returns nearby stores for a ZIP, with distance and the store's own link", async () => {
    const res = await call("?q=77002");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ kind: "stores", label: "77002", nearby: true });
    const mine = body.stores.find((s: { slug: string }) => s.slug === slug);
    expect(mine).toMatchObject({ name: "Route Market", href: `http://${slug}.localhost:3000/` });
    expect(mine.distanceMi).toBeCloseTo(2, 0);
  });

  it("never sends a store's own coordinates, which locate its street address", async () => {
    const body = await (await call("?q=77002")).json();
    const mine = body.stores.find((s: { slug: string }) => s.slug === slug);
    for (const key of ["lat", "lng", "id", "deliveryRadiusMi", "addressLine1", "phone", "uberLocationId", "doordashStoreId"]) {
      expect(mine).not.toHaveProperty(key);
    }
    expect(mine).toMatchObject({ deliversToYou: false, courierMayDeliver: false });
    expect(JSON.stringify(body)).not.toContain("29.7858");
  });

  it("answers a point outside the US with the state list", async () => {
    const res = await call("?lat=51.5&lng=-0.12");
    expect(await res.json()).toEqual({ kind: "outside" });
  });

  it("asks which state for a city in several states, and says when a place is unknown", async () => {
    expect(await (await call("?q=Springfield")).json()).toMatchObject({ kind: "ambiguous", name: "Springfield" });
    expect(await (await call("?q=Qqqzzz")).json()).toEqual({ kind: "none" });
  });

  it("refuses input that is not a ZIP, a city or a valid point", async () => {
    for (const qs of ["?q=7700", "?q=", "?lat=91&lng=0", "?lat=abc&lng=1", "?lat=30"]) {
      expect((await call(qs)).status, qs).toBe(400);
    }
  });

  it("refuses a browser over the limit with 429 and Retry-After", async () => {
    const browser = `t452-limit-${stamp}`;
    for (let i = 0; i < NEAR_BROWSER_LIMIT; i++) {
      expect((await call("?q=00000", browser)).status).toBe(200);
    }
    const refused = await call("?q=00000", browser);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});
