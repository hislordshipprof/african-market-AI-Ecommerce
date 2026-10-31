import { storeScoped, platform, storeScopedRawQuery, Prisma } from "../db";
import { stockBadge, type StockBadge } from "./stock-badge";

export async function listCategories() {
  return platform.category.findMany({
    orderBy: { sortOrder: "asc" },
  });
}

export interface StorefrontListing {
  id: string;
  displayName: string;
  altName?: string;
  startingPrice: number;
  badge: StockBadge;
  frozen: boolean;
  perishable: boolean;
}

function deriveNames(
  customName: string | null,
  masterProductName: string | null,
): { displayName: string; altName?: string } {
  const local = customName?.trim() || null;
  const english = masterProductName?.trim() || null;
  if (local && english && local !== english) {
    return { displayName: local, altName: english };
  }
  return { displayName: local || english || "Unnamed" };
}

function toStorefrontListing(listing: {
  id: string;
  customName: string | null;
  price: number;
  confidence: number;
  stockMode: string;
  qty: number | null;
  status: string | null;
  frozen: boolean;
  perishable: boolean;
  masterProduct: { name: string } | null;
  variants: { price: number }[];
}): StorefrontListing {
  const startingPrice =
    listing.variants.length > 0
      ? Math.min(...listing.variants.map((v) => v.price))
      : listing.price;

  const names = deriveNames(listing.customName, listing.masterProduct?.name ?? null);

  return {
    id: listing.id,
    ...names,
    startingPrice,
    badge: stockBadge({
      confidence: listing.confidence,
      stockMode: listing.stockMode,
      qty: listing.qty,
      status: listing.status,
    }),
    frozen: listing.frozen,
    perishable: listing.perishable,
  };
}

export async function listingsByCategory(
  storeId: string,
  categorySlug: string,
): Promise<{ category: { name: string; slug: string } | null; listings: StorefrontListing[] }> {
  const category = await platform.category.findUnique({
    where: { slug: categorySlug },
  });
  if (!category) return { category: null, listings: [] };

  const scoped = storeScoped(storeId);
  const listings = await scoped.listing.findMany({
    where: {
      active: true,
      masterProduct: { categoryId: category.id },
    },
    include: { masterProduct: true, variants: { select: { price: true } } },
    orderBy: { createdAt: "desc" },
  });

  return {
    category: { name: category.name, slug: category.slug },
    listings: listings.map(toStorefrontListing),
  };
}

export interface StorefrontListingDetail {
  id: string;
  displayName: string;
  altName?: string;
  badge: StockBadge;
  frozen: boolean;
  perishable: boolean;
  variants: {
    id: string;
    label: string;
    price: number;
    weightG: number;
  }[];
}

export async function getListingDetail(
  storeId: string,
  listingId: string,
): Promise<StorefrontListingDetail | null> {
  const scoped = storeScoped(storeId);
  const listing = await scoped.listing.findUnique({
    where: { id: listingId },
    include: { masterProduct: true, variants: true },
  });

  if (!listing || !listing.active) return null;

  const names = deriveNames(listing.customName, listing.masterProduct?.name ?? null);

  return {
    id: listing.id,
    ...names,
    badge: stockBadge({
      confidence: listing.confidence,
      stockMode: listing.stockMode,
      qty: listing.qty,
      status: listing.status,
    }),
    frozen: listing.frozen,
    perishable: listing.perishable,
    variants: listing.variants.map((v) => ({
      id: v.id,
      label: v.label,
      price: v.price,
      weightG: v.weightG,
    })),
  };
}

export interface SearchResult {
  id: string;
  name: string;
  altName?: string;
  price: number;
  badge: StockBadge;
}

interface RawSearchRow {
  id: string;
  custom_name: string | null;
  master_product_name: string | null;
  price: number;
  confidence: number;
  stock_mode: string;
  qty: number | null;
  status: string | null;
  min_variant_price: number | null;
}

export async function searchListings(
  storeId: string,
  query: string,
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const results = await storeScopedRawQuery<RawSearchRow>(
    storeId,
    Prisma.sql`
    SELECT DISTINCT ON (l.id)
      l.id,
      l.custom_name,
      mp.name AS master_product_name,
      l.price,
      l.confidence,
      l.stock_mode,
      l.qty,
      l.status,
      (SELECT MIN(lv.price) FROM listing_variants lv WHERE lv.listing_id = l.id) AS min_variant_price
    FROM listings l
    LEFT JOIN master_products mp ON l.master_product_id = mp.id
    LEFT JOIN product_synonyms ps ON ps.product_id = mp.id
    WHERE l.active = true
      AND (
        l.search_vector @@ plainto_tsquery('english', ${trimmed})
        OR mp.search_vector @@ plainto_tsquery('english', ${trimmed})
        OR word_similarity(${trimmed}, ps.term) > 0.3
        OR word_similarity(${trimmed}, mp.name) > 0.3
        OR word_similarity(${trimmed}, COALESCE(l.custom_name, '')) > 0.3
        OR LOWER(ps.term) = LOWER(${trimmed})
      )
    ORDER BY l.id
    LIMIT 50
    `,
  );

  return results.map((row) => {
    const names = deriveNames(row.custom_name, row.master_product_name);
    return {
      id: row.id,
      name: names.displayName,
      altName: names.altName,
      price: row.min_variant_price ?? row.price,
      badge: stockBadge({
        confidence: row.confidence,
        stockMode: row.stock_mode,
        qty: row.qty,
        status: row.status,
      }),
    };
  });
}

export async function getActiveListings(storeId: string): Promise<StorefrontListing[]> {
  const scoped = storeScoped(storeId);
  const listings = await scoped.listing.findMany({
    where: { active: true },
    include: { masterProduct: true, variants: { select: { price: true } } },
    orderBy: { createdAt: "desc" },
  });

  return listings.map(toStorefrontListing);
}

export interface StorefrontBanner {
  id: string;
  title: string;
  subtitle: string | null;
  ctaText: string | null;
  ctaHref: string | null;
  imageUrl: string;
}

export async function getActiveBanners(storeId: string): Promise<StorefrontBanner[]> {
  const scoped = storeScoped(storeId);
  const banners = await scoped.storeBanner.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
  });

  return banners.map((b) => ({
    id: b.id,
    title: b.title,
    subtitle: b.subtitle,
    ctaText: b.ctaText,
    ctaHref: b.ctaHref,
    imageUrl: b.imageUrl,
  }));
}

export interface StorefrontCollection {
  id: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null;
  slug: string;
}

export async function getActiveCollections(storeId: string): Promise<StorefrontCollection[]> {
  const scoped = storeScoped(storeId);
  const collections = await scoped.storeCollection.findMany({
    where: { active: true },
    orderBy: { sortOrder: "asc" },
  });

  return collections.map((c) => ({
    id: c.id,
    title: c.title,
    subtitle: c.subtitle,
    imageUrl: c.imageUrl,
    slug: c.slug,
  }));
}

export async function getCollectionListings(
  storeId: string,
  collectionSlug: string,
): Promise<{ collection: StorefrontCollection | null; listings: StorefrontListing[] }> {
  const scoped = storeScoped(storeId);
  const collection = await scoped.storeCollection.findFirst({
    where: { slug: collectionSlug, active: true },
    include: {
      items: {
        orderBy: { sortOrder: "asc" },
        include: {
          listing: {
            include: { masterProduct: true, variants: { select: { price: true } } },
          },
        },
      },
    },
  });

  if (!collection) return { collection: null, listings: [] };

  return {
    collection: {
      id: collection.id,
      title: collection.title,
      subtitle: collection.subtitle,
      imageUrl: collection.imageUrl,
      slug: collection.slug,
    },
    listings: collection.items
      .map((item) => item.listing)
      .filter((l) => l.active)
      .map(toStorefrontListing),
  };
}

export interface StoreProfile {
  ownerName: string | null;
  ownerStory: string | null;
  ownerPhotoUrl: string | null;
  neighborhood: string | null;
  deliveryInfo: string | null;
  hours: unknown;
  pickupEnabled: boolean;
  deliveryRadiusMi: number;
  prepTimeMinutes: number;
}

export function extractStoreProfile(store: {
  ownerName: string | null;
  ownerStory: string | null;
  ownerPhotoUrl: string | null;
  neighborhood: string | null;
  deliveryInfo: string | null;
  hours: unknown;
  pickupEnabled: boolean;
  deliveryRadiusMi: unknown;
  prepTimeMinutes: number;
}): StoreProfile {
  return {
    ownerName: store.ownerName,
    ownerStory: store.ownerStory,
    ownerPhotoUrl: store.ownerPhotoUrl,
    neighborhood: store.neighborhood,
    deliveryInfo: store.deliveryInfo,
    hours: store.hours,
    pickupEnabled: store.pickupEnabled,
    deliveryRadiusMi: Number(store.deliveryRadiusMi),
    prepTimeMinutes: store.prepTimeMinutes,
  };
}

export interface CategoryRail {
  categoryName: string;
  categorySlug: string;
  listings: StorefrontListing[];
}

export async function getListingsByCategory(
  storeId: string,
): Promise<CategoryRail[]> {
  const scoped = storeScoped(storeId);
  const MAX_HOMEPAGE_LISTINGS = 120;
  const listings = await scoped.listing.findMany({
    where: { active: true },
    include: {
      masterProduct: { include: { category: true } },
      variants: { select: { price: true } },
    },
    orderBy: { createdAt: "desc" },
    take: MAX_HOMEPAGE_LISTINGS,
  });

  const byCategory = new Map<string, { slug: string; listings: StorefrontListing[] }>();
  for (const listing of listings) {
    const catName = listing.masterProduct?.category?.name ?? "Other";
    const catSlug = listing.masterProduct?.category?.slug ?? "other";
    const existing = byCategory.get(catName) ?? { slug: catSlug, listings: [] };
    existing.listings.push(toStorefrontListing(listing));
    byCategory.set(catName, existing);
  }

  return Array.from(byCategory.entries()).map(([name, data]) => ({
    categoryName: name,
    categorySlug: data.slug,
    listings: data.listings,
  }));
}
