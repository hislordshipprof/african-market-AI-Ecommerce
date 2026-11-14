import type { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { platform } from "@/lib/db";
import { storefrontUrl } from "./links";

// The only Store columns the public directory may read. `stores_read` is open to every
// role, so whole rows would leak Stripe, fee, limit and address columns (#449). No lat/lng:
// they are the geocoded street address (#452).
export const DIRECTORY_STORE_FIELDS = {
  name: true,
  slug: true,
  logoUrl: true,
  brandColor: true,
  city: true,
  state: true,
  hours: true,
  timezone: true,
  pickupEnabled: true,
  storeDeliveryEnabled: true,
  listingBlurb: true,
  cuisineTags: true,
  ownerName: true,
  ownerStory: true,
  ownerPhotoUrl: true,
} satisfies Prisma.StoreSelect;

export type DirectoryStore = Prisma.StoreGetPayload<{ select: typeof DIRECTORY_STORE_FIELDS }>;

/** Cleared by every store save (revalidateStore), so a listing change shows at once (#450). */
export const DIRECTORY_CACHE_TAG = "store-directory";

/** Listed, active stores with a map point, by state, city and name. Uncached: the sitemap reads it per request. */
export function queryDirectoryStores(): Promise<DirectoryStore[]> {
  return platform.store.findMany({
    where: { listed: true, status: "active", lat: { not: null }, lng: { not: null } },
    select: DIRECTORY_STORE_FIELDS,
    orderBy: [{ state: "asc" }, { city: "asc" }, { name: "asc" }],
  });
}

export function listDirectoryStores(): Promise<DirectoryStore[]> {
  return unstable_cache(queryDirectoryStores, ["store-directory"], { revalidate: 300, tags: [DIRECTORY_CACHE_TAG] })();
}

/** Listed stores with their storefront links, for pages cached for every request (no request host). */
export async function listDirectoryCards(): Promise<(DirectoryStore & { href: string })[]> {
  const root = process.env.PLATFORM_ROOT_DOMAIN ?? "";
  const host = process.env.PORT ? `${root}:${process.env.PORT}` : root;
  return (await listDirectoryStores()).flatMap((store) => {
    const href = storefrontUrl(store.slug, root, host);
    return href ? [{ ...store, href }] : [];
  });
}
