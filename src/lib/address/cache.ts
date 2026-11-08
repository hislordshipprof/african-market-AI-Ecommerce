import { readAddressGeocode, upsertAddressGeocode } from "../db";
import { addressCacheKey, CACHE_TTL_MS, type AddressParts, type Geocode } from "./geo";

export async function readGeocodeCache(
  parts: AddressParts,
  now = new Date(),
): Promise<Geocode | null> {
  const cutoff = new Date(now.getTime() - CACHE_TTL_MS);
  return readAddressGeocode(addressCacheKey(parts), cutoff);
}

export async function writeGeocodeCache(parts: AddressParts, match: Geocode, now = new Date()): Promise<void> {
  try {
    await upsertAddressGeocode(addressCacheKey(parts), match, now);
  } catch (error) {
    const status = error instanceof Error ? error.name : "error";
    console.error(JSON.stringify({ event: "geocode_cache_write_failed", status }));
  }
}
