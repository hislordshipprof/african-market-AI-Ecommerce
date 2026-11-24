import type { Prisma } from "@prisma/client";
import { unstable_cache } from "next/cache";
import { platform } from "@/lib/db";
import { storeMayUse } from "@/lib/billing/plan";
import { courierOffered } from "@/lib/delivery/courier-offered";
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
  neighborhood: true,
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

// Read on the server only, to work out the card's delivery lines; never sent to the page.
const DELIVERY_FIELDS = {
  id: true,
  deliveryRadiusMi: true,
  lat: true,
  lng: true,
  addressLine1: true,
  zip: true,
  phone: true,
  uberLocationId: true,
  doordashStoreId: true,
} satisfies Prisma.StoreSelect;

export const DIRECTORY_QUERY_FIELDS = { ...DIRECTORY_STORE_FIELDS, ...DELIVERY_FIELDS } satisfies Prisma.StoreSelect;

export type DirectoryRow = Prisma.StoreGetPayload<{ select: typeof DIRECTORY_QUERY_FIELDS }>;

/** `courierMayDeliver`: the storefront offers courier delivery (registered, full address, plan). Coverage is known only from a quote (ADR-0006). */
export type DirectoryStore = Prisma.StoreGetPayload<{ select: typeof DIRECTORY_STORE_FIELDS }> & { courierMayDeliver: boolean };

/** The public card fields of each row, in order; the delivery fields stay behind. */
export async function toDirectoryStores(rows: DirectoryRow[]): Promise<DirectoryStore[]> {
  return Promise.all(rows.map(async (row) => {
    const card = Object.fromEntries(Object.keys(DIRECTORY_STORE_FIELDS).map((key) => [key, row[key as keyof DirectoryRow]]));
    const courierMayDeliver = courierOffered(row) && (await storeMayUse(row.id, "courier-delivery"));
    return { ...(card as Prisma.StoreGetPayload<{ select: typeof DIRECTORY_STORE_FIELDS }>), courierMayDeliver };
  }));
}

/** Cleared by every store save (revalidateStore), so a listing change shows at once (#450). */
export const DIRECTORY_CACHE_TAG = "store-directory";

/** The stores the directory shows, and so the stores that make a state or city page (#449, #451). */
export const DIRECTORY_STORE_WHERE = { listed: true, status: "active", lat: { not: null }, lng: { not: null } } satisfies Prisma.StoreWhereInput;

/** Listed, active stores with a map point, by state, city and name. Uncached: the sitemap reads it per request. */
export async function queryDirectoryStores(): Promise<DirectoryStore[]> {
  const rows = await platform.store.findMany({
    where: DIRECTORY_STORE_WHERE,
    select: DIRECTORY_QUERY_FIELDS,
    orderBy: [{ state: "asc" }, { city: "asc" }, { name: "asc" }],
  });
  return toDirectoryStores(rows);
}

export function listDirectoryStores(): Promise<DirectoryStore[]> {
  return unstable_cache(queryDirectoryStores, ["store-directory"], { revalidate: 300, tags: [DIRECTORY_CACHE_TAG] })();
}

/** Listed stores with their storefront links, for pages cached for every request (no request host). */
export async function listDirectoryCards(): Promise<(DirectoryStore & { href: string })[]> {
  const root = process.env.PLATFORM_ROOT_DOMAIN ?? "";
  const host = process.env.PORT ? `${root}:${process.env.PORT}` : root;
  return (await listDirectoryStores()).flatMap((store) => {
    const href = storefrontUrl(store.slug, host);
    return href ? [{ ...store, href }] : [];
  });
}
