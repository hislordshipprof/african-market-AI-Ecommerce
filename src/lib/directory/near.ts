import { listedStoresByDistance, platform, pointWithinZipReach } from "@/lib/db";
import type { NearQuery } from "./near-query";
import { assessRadius } from "@/lib/address/geo";
import { DIRECTORY_QUERY_FIELDS, toDirectoryStores, type DirectoryRow, type DirectoryStore } from "./stores";
import type { StateCode } from "./us-states";
import { NEARBY_MILES } from "./distance";

export type Point = { lat: number; lng: number };
export type Located =
  | ({ kind: "point"; label: string } & Point)
  | { kind: "ambiguous"; name: string; states: StateCode[] }
  | { kind: "none" };

const NEARBY_LIMIT = 24;
const FALLBACK_LIMIT = 3;
// Above the largest ZIP reach in the seed (about 102 miles, in Alaska).
const ZIP_REACH_BAND_DEG = 2;

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
  return pointWithinZipReach(point, ZIP_REACH_BAND_DEG);
}

export type NearStore = DirectoryStore & { distanceMi: number; deliversToYou: boolean };

/** The store's own delivery reaches the point: its radius only, as at checkout (equal is inside). */
function deliversTo(point: Point, row: DirectoryRow): boolean {
  if (!row.storeDeliveryEnabled || row.lat == null || row.lng == null) return false;
  return assessRadius(point, { lat: row.lat, lng: row.lng, radiusMi: Number(row.deliveryRadiusMi) }).withinRadius;
}

/**
 * Listed, active stores nearest first. Within 50 miles when any are; otherwise the few
 * nearest anywhere, so the shopper still sees how far the closest store is (#447).
 */
export async function nearestStores(point: Point): Promise<{ nearby: boolean; stores: NearStore[] }> {
  const ranked = await listedStoresByDistance(point, NEARBY_LIMIT);
  const nearby = ranked.some((r) => r.distance <= NEARBY_MILES);
  const picked = nearby ? ranked.filter((r) => r.distance <= NEARBY_MILES) : ranked.slice(0, FALLBACK_LIMIT);
  if (picked.length === 0) return { nearby, stores: [] };
  const rows = await platform.store.findMany({
    where: { slug: { in: picked.map((r) => r.slug) } },
    select: DIRECTORY_QUERY_FIELDS,
  });
  const cards = await toDirectoryStores(rows);
  const bySlug = new Map(rows.map((row, i) => [row.slug, { row, card: cards[i]! }]));
  const stores = picked.flatMap((r) => {
    const found = bySlug.get(r.slug);
    return found ? [{ ...found.card, distanceMi: r.distance, deliversToYou: deliversTo(point, found.row) }] : [];
  });
  return { nearby, stores };
}
