import { readAddressGeocode, upsertAddressGeocode } from "../db";
import { addressCacheKey, CACHE_TTL_MS, type AddressParts, type Geocode } from "./geo";

export async function readGeocodeCache(
  parts: AddressParts,
  now = new Date(),
): Promise<Geocode | null> {
  const cutoff = new Date(now.getTime() - CACHE_TTL_MS);
  return readAddressGeocode(addressCacheKey(parts), cutoff);
}

/**
 * Quote and payment read only the cache, so a failed write is reported to the
 * caller (false) rather than letting Confirm succeed for an address checkout
 * cannot find afterwards.
 */
export async function writeGeocodeCache(parts: AddressParts, match: Geocode, now = new Date()): Promise<boolean> {
  try {
    await upsertAddressGeocode(addressCacheKey(parts), match, now);
    return true;
  } catch (error) {
    const status = error instanceof Error ? error.name : "error";
    console.error(JSON.stringify({ event: "geocode_cache_write_failed", status }));
    return false;
  }
}
