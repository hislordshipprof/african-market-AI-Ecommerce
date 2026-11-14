import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { testPrismaClient } from "@/lib/test-prisma";
import { isUsPoint, locate, nearestStores } from "./near";
import { parseNearQuery } from "./near-query";

const hasDb = !!process.env.DATABASE_URL;
const MI_PER_DEG_LAT = 69.0934; // 2π × 3958.8 / 360

// Central Nevada: no seeded or other-test store within 150 miles.
const ORIGIN = { lat: 39.0, lng: -116.5 };
const north = (miles: number) => ({ lat: ORIGIN.lat + miles / MI_PER_DEG_LAT, lng: ORIGIN.lng });

describe.skipIf(!hasDb)("near me", () => {
  let raw: PrismaClient;
  const stamp = Date.now().toString(36);
  const slug = (name: string) => `t452-${name}-${stamp}`;

  beforeAll(async () => {
    raw = testPrismaClient();
    await raw.store.createMany({
      data: [
        { slug: slug("at10"), name: "Ten", ...north(10), listed: true },
        { slug: slug("at49"), name: "Edge In", ...north(49.9), listed: true },
        { slug: slug("at3"), name: "Three", ...north(3), listed: true },
        { slug: slug("at51"), name: "Edge Out", ...north(50.1), listed: true },
        { slug: slug("hidden"), name: "Unlisted", ...north(1), listed: false },
        { slug: slug("closed"), name: "Suspended", ...north(2), listed: true, status: "suspended" },
      ],
    });
  });

  afterAll(async () => {
    await raw.store.deleteMany({ where: { slug: { startsWith: "t452-", endsWith: stamp } } });
    await raw.$disconnect();
  });

  it("returns stores within 50 miles nearest first, the boundary store out", async () => {
    const result = await nearestStores(ORIGIN);
    expect(result.nearby).toBe(true);
    const mine = result.stores.filter((s) => s.slug.endsWith(stamp));
    expect(mine.map((s) => s.slug)).toEqual([slug("at3"), slug("at10"), slug("at49")]);
    expect(mine[0]!.distanceMi).toBeCloseTo(3, 1);
    expect(mine[2]!.distanceMi).toBeCloseTo(49.9, 1);
  });

  it("never returns an unlisted or suspended store, however close", async () => {
    const slugs = (await nearestStores(ORIGIN)).stores.map((s) => s.slug);
    expect(slugs).not.toContain(slug("hidden"));
    expect(slugs).not.toContain(slug("closed"));
  });

  it("with no store within 50 miles, returns the nearest stores with their distance", async () => {
    const result = await nearestStores({ lat: ORIGIN.lat - 60 / MI_PER_DEG_LAT, lng: ORIGIN.lng });
    expect(result.nearby).toBe(false);
    expect(result.stores.slice(0, 2).map((s) => s.slug)).toEqual([slug("at3"), slug("at10")]);
    expect(result.stores[0]!.distanceMi).toBeCloseTo(63, 1);
  });

  it("finds a ZIP and a city through the seeded Gazetteer tables", async () => {
    expect(await locate({ kind: "zip", zip: "77002" })).toEqual({ kind: "point", lat: 29.756845, lng: -95.365652, label: "77002" });
    expect(await locate({ kind: "zip", zip: "00000" })).toEqual({ kind: "none" });
    expect(await locate({ kind: "city", key: "nashville", state: "TN" })).toMatchObject({ kind: "point", label: "Nashville, TN" });
    expect(await locate({ kind: "city", key: "pflugerville", state: null })).toMatchObject({ kind: "point", label: "Pflugerville, TX" });
    // The seed is keyed with the same placeKey, so short and long forms meet: "Mt. Bullion" is a Census name.
    for (const typed of ["Ft Worth, TX", "Fort Worth, TX"]) {
      expect(await locate(parseNearQuery(typed)!)).toMatchObject({ kind: "point", label: "Fort Worth, TX" });
    }
    expect(await locate(parseNearQuery("Mount Bullion, CA")!)).toMatchObject({ kind: "point", label: "Mt. Bullion, CA" });
  });

  it("asks for the state when a city name is in several states", async () => {
    const result = await locate({ kind: "city", key: "springfield", state: null });
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.name).toBe("Springfield");
      expect(result.states).toEqual(expect.arrayContaining(["IL", "MA", "MO"]));
      expect(result.states).toEqual([...result.states].sort());
    }
  });

  it("tells a US point from one abroad", async () => {
    expect(await isUsPoint({ lat: 29.76, lng: -95.37 })).toBe(true);
    expect(await isUsPoint({ lat: 61.2, lng: -149.9 })).toBe(true);
    expect(await isUsPoint(ORIGIN)).toBe(true);
    expect(await isUsPoint({ lat: 19.43, lng: -99.13 })).toBe(false);
    expect(await isUsPoint({ lat: 51.5, lng: -0.12 })).toBe(false);
    expect(await isUsPoint({ lat: 43.65, lng: -79.38 })).toBe(false);
  });
});
