import type { Prisma } from "@prisma/client";
import { platform } from "@/lib/db";

// The only Store columns the public directory may read. `stores_read` is open to every
// role, so whole rows would leak Stripe, fee, limit and address columns (#449).
const DIRECTORY_STORE_FIELDS = {
  name: true,
  slug: true,
  logoUrl: true,
  brandColor: true,
  city: true,
  state: true,
  lat: true,
  lng: true,
  hours: true,
  timezone: true,
  pickupEnabled: true,
  storeDeliveryEnabled: true,
  listingBlurb: true,
  ownerName: true,
  ownerStory: true,
  ownerPhotoUrl: true,
} satisfies Prisma.StoreSelect;

export type DirectoryStore = Prisma.StoreGetPayload<{ select: typeof DIRECTORY_STORE_FIELDS }> & {
  lat: number;
  lng: number;
};

/** Listed, active stores with a map point, by state, city and name. */
export async function listDirectoryStores(): Promise<DirectoryStore[]> {
  const stores = await platform.store.findMany({
    where: { listed: true, status: "active", lat: { not: null }, lng: { not: null } },
    select: DIRECTORY_STORE_FIELDS,
    orderBy: [{ state: "asc" }, { city: "asc" }, { name: "asc" }],
  });
  return stores as DirectoryStore[];
}
