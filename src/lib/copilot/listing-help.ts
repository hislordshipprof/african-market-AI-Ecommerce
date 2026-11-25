import { platform, storeScoped } from "../db";
import { preparedSaleBlocked } from "../listing/prepared";
import { catalogFor } from "../storefront/catalog";
import { listingImage } from "../storefront/images";
import { listingLabel } from "./cards";
import type { ListingFix, ListingGap } from "./types";

/**
 * What the store chat reads to help with listings (#820): the active listings a shopper sees with a gap, and one
 * listing's facts for a description draft. Read only; both use what the storefront shows, not a guess.
 */

/** At most this many listings to fix go to the model and the card. */
export const FIXES_MAX = 20;

/** Every active listing with a gap, in name order: no photo, no aisle, no description, or prepared food whose allergens the owner has not stated. */
export async function listingFixes(storeId: string): Promise<{ total: number; fixes: ListingFix[] }> {
  const [store, listings] = await Promise.all([
    platform.store.findUniqueOrThrow({ where: { id: storeId }, select: { slug: true } }),
    storeScoped(storeId).listing.findMany({
      where: { active: true },
      select: {
        id: true,
        customName: true,
        imageUrl: true,
        categoryId: true,
        description: true,
        prepared: true,
        attributes: { select: { allergensStatus: true } },
        masterProduct: { select: { name: true, imageUrl: true, categoryId: true } },
      },
    }),
  ]);
  const base = `/store-admin/listings?store=${encodeURIComponent(store.slug)}`;
  const fixes: ListingFix[] = [];
  for (const listing of listings) {
    const missing: ListingGap[] = [];
    if (!listingImage(listing)) missing.push("photo");
    if (!listing.categoryId && !listing.masterProduct?.categoryId) missing.push("aisle");
    // The product page shows the store's words, else the catalogue blurb (storefront/service.ts).
    if (!listing.description && !catalogFor(listing.customName, listing.masterProduct?.name)?.description) missing.push("description");
    if (preparedSaleBlocked(listing, listing.attributes?.allergensStatus)) missing.push("allergens");
    if (missing.length === 0) continue;
    const onlyAllergens = missing.length === 1 && missing[0] === "allergens";
    fixes.push({
      listingId: listing.id,
      name: listingLabel(listing),
      missing,
      href: `${base}&${onlyAllergens ? "allergens" : "edit"}=${listing.id}`,
    });
  }
  fixes.sort((a, b) => a.name.localeCompare(b.name));
  return { total: fixes.length, fixes: fixes.slice(0, FIXES_MAX) };
}

export interface ListingFacts {
  listingId: string;
  name: string;
  catalogueName: string | null;
  aisle: string | null;
  origin: string | null;
  sizes: string[];
  storage: string | null;
  frozen: boolean;
  prepared: string | null;
  allergens: string[] | null;
  currentDescription: string | null;
  catalogueDescription: string | null;
}

/** The facts a description may use. Null when the listing is not this store's or not on sale. */
export async function listingFacts(storeId: string, listingId: string): Promise<ListingFacts | null> {
  const listing = await storeScoped(storeId).listing.findUnique({
    where: { id: listingId },
    select: {
      id: true,
      active: true,
      customName: true,
      description: true,
      frozen: true,
      prepared: true,
      category: { select: { name: true } },
      attributes: { select: { allergens: true, allergensStatus: true } },
      variants: { select: { label: true }, orderBy: { price: "asc" } },
      masterProduct: {
        select: {
          name: true,
          description: true,
          originCountries: true,
          storage: true,
          allergens: true,
          allergensStatus: true,
          category: { select: { name: true } },
        },
      },
    },
  });
  if (!listing || !listing.active) return null;
  const master = listing.masterProduct;
  const own = listing.attributes;
  const allergens = own?.allergensStatus === "known"
    ? own.allergens
    : !own?.allergensStatus && master?.allergensStatus === "known" ? master.allergens : null;
  return {
    listingId: listing.id,
    name: listingLabel(listing),
    catalogueName: master?.name ?? null,
    aisle: master?.category?.name ?? listing.category?.name ?? null,
    origin: master?.originCountries ?? null,
    sizes: listing.variants.map((variant) => variant.label),
    storage: master?.storage ?? null,
    frozen: listing.frozen,
    prepared: listing.prepared,
    allergens,
    currentDescription: listing.description,
    catalogueDescription: master?.description ?? catalogFor(listing.customName, master?.name)?.description ?? null,
  };
}
