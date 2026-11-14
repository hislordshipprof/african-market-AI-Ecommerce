import type { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { platform } from "@/lib/db";

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

/** Listed, active stores with a map point, by state, city and name. */
export function listDirectoryStores(): Promise<DirectoryStore[]> {
  return unstable_cache(
    async () => {
      const stores = await platform.store.findMany({
        where: { listed: true, status: "active", lat: { not: null }, lng: { not: null } },
        select: DIRECTORY_STORE_FIELDS,
        orderBy: [{ state: "asc" }, { city: "asc" }, { name: "asc" }],
      });
      return stores;
    },
    ["store-directory"],
    { revalidate: 300, tags: [DIRECTORY_CACHE_TAG] },
  )();
}
