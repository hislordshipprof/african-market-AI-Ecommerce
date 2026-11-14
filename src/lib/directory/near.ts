import { Prisma } from "@prisma/client";
import { appUserQuery, platform } from "@/lib/db";
import { EARTH_RADIUS_MI } from "@/lib/address/geo";
import type { NearQuery } from "./near-query";
import { DIRECTORY_STORE_FIELDS, type DirectoryStore } from "./stores";
import type { StateCode } from "./us-states";

export type Point = { lat: number; lng: number };
export type Located =
  | ({ kind: "point"; label: string } & Point)
  | { kind: "ambiguous"; name: string; states: StateCode[] }
  | { kind: "none" };

export const NEARBY_MILES = 50;
const NEARBY_LIMIT = 24;
const FALLBACK_LIMIT = 3;
// Above the largest ZIP reach in the seed (about 102 miles, in Alaska).
const ZIP_REACH_BAND_DEG = 2;

/** Great-circle miles from the point to the row's lat/lng columns, in SQL (no PostGIS, ADR-0012). */
function haversineSql(point: Point, table: string): Prisma.Sql {
  const lat = Prisma.raw(`${table}.lat`);
  const lng = Prisma.raw(`${table}.lng`);
  return Prisma.sql`(2 * ${EARTH_RADIUS_MI}::float8 * asin(sqrt(LEAST(1,
    power(sin(radians(${lat} - ${point.lat}::float8) / 2), 2)
    + cos(radians(${point.lat}::float8)) * cos(radians(${lat})) * power(sin(radians(${lng} - ${point.lng}::float8) / 2), 2)))))`;
}

/** Turns a parsed ZIP or city into a point using the seeded Gazetteer tables. */
export async function locate(query: NearQuery): Promise<Located> {
  if (query.kind === "zip") {
    const zip = await platform.gazetteerZip.findUnique({ where: { zip: query.zip } });
    return zip ? { kind: "point", lat: zip.lat, lng: zip.lng, label: zip.zip } : { kind: "none" };
  }
  const places = await platform.gazetteerPlace.findMany({
    where: { nameKey: query.key, ...(query.state ? { state: query.state } : {}) },
    orderBy: { state: "asc" },
  });
  if (places.length === 0) return { kind: "none" };
  if (places.length > 1) return { kind: "ambiguous", name: places[0]!.name, states: places.map((p) => p.state as StateCode) };
  const [place] = places;
  return { kind: "point", lat: place!.lat, lng: place!.lng, label: `${place!.name}, ${place!.state}` };
}

/** True when the point lies within some US ZIP's reach, which grows with the ZIP's area. */
export async function isUsPoint(point: Point): Promise<boolean> {
  const band = ZIP_REACH_BAND_DEG;
  const rows = await appUserQuery((tx) => tx.$queryRaw<{ hit: number }[]>`
    SELECT 1 AS hit FROM gazetteer_zips z
    WHERE z.lat BETWEEN ${point.lat - band}::float8 AND ${point.lat + band}::float8
      AND ${haversineSql(point, "z")} <= z.reach_mi
    LIMIT 1`);
  return rows.length > 0;
}

export type NearStore = DirectoryStore & { distanceMi: number };

/**
 * Listed, active stores nearest first. Within 50 miles when any are; otherwise the few
 * nearest anywhere, so the shopper still sees how far the closest store is (#447).
 */
export async function nearestStores(point: Point): Promise<{ nearby: boolean; stores: NearStore[] }> {
  const ranked = await appUserQuery((tx) => tx.$queryRaw<{ slug: string; distance: number }[]>`
    SELECT slug, distance FROM (
      SELECT s.slug, ${haversineSql(point, "s")} AS distance
      FROM stores s
      WHERE s.listed AND s.status = 'active' AND s.lat IS NOT NULL AND s.lng IS NOT NULL
    ) d
    ORDER BY distance, slug
    LIMIT ${NEARBY_LIMIT}`);
  const nearby = ranked.some((r) => r.distance <= NEARBY_MILES);
  const picked = nearby ? ranked.filter((r) => r.distance <= NEARBY_MILES) : ranked.slice(0, FALLBACK_LIMIT);
  if (picked.length === 0) return { nearby, stores: [] };
  const rows = await platform.store.findMany({
    where: { slug: { in: picked.map((r) => r.slug) } },
    select: DIRECTORY_STORE_FIELDS,
  });
  const bySlug = new Map(rows.map((row) => [row.slug, row as DirectoryStore]));
  const stores = picked.flatMap((r) => {
    const store = bySlug.get(r.slug);
    return store ? [{ ...store, distanceMi: r.distance }] : [];
  });
  return { nearby, stores };
}
