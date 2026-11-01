import { storeScoped, platform, storeScopedRawQuery, Prisma } from "../db";
import { stockBadge, type StockBadge } from "./stock-badge";
import { catalogFor, localNameFor } from "./catalog";
import type { FlowCatalogItem } from "../customer-flow/contracts";

/** Read-only, tenant-scoped catalog projection for the demo journey adapters. */
export async function getFlowCatalog(
  storeId: string,
): Promise<FlowCatalogItem[]> {
  const listings = await storeScoped(storeId).listing.findMany({
    where: { active: true },
    include: {
      masterProduct: true,
      variants: { orderBy: [{ price: "asc" }, { id: "asc" }] },
    },
    orderBy: { createdAt: "desc" },
  });
  return listings.flatMap((listing) => {
    const item = toStorefrontListing(listing);
    const base = {
      listingId: listing.id,
      name: item.displayName,
      imageUrl: item.imageUrl,
      categoryId: listing.masterProduct?.categoryId ?? "uncategorized",
      frozen: listing.frozen,
      maxPerOrder: listing.maxPerOrder ?? 99,
      available:
        !(listing.stockMode === "counted" && (listing.qty ?? 0) <= 0) &&
        !(listing.stockMode === "status" && listing.status === "out_of_stock"),
    };
    return listing.variants.length
      ? listing.variants.map((variant) => ({
          ...base,
          variantId: variant.id,
          price: variant.price,
          packLabel: variant.label,
          weightG: variant.weightG,
        }))
      : [{ ...base, price: listing.price, packLabel: "Each", weightG: 500 }];
  });
}

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
  imageUrl?: string;
  variantId?: string;
  packLabel?: string;
  weightG?: number;
  packLabels?: string[];
  packOptions?: {
    id: string;
    label: string;
    price: number;
    weightG?: number;
  }[];
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
  variants: { id?: string; label?: string; price: number; weightG?: number }[];
}): StorefrontListing {
  const startingPrice =
    listing.variants.length > 0
      ? Math.min(...listing.variants.map((v) => v.price))
      : listing.price;

  const names = deriveNames(
    listing.customName,
    listing.masterProduct?.name ?? null,
  );
  const pack = [...listing.variants].sort(
    (a, b) => a.price - b.price || (a.id ?? "").localeCompare(b.id ?? ""),
  )[0];
  const photo = catalogFor(listing.customName, listing.masterProduct?.name);

  return {
    id: listing.id,
    ...names,
    altName: names.altName ?? localNameFor(names.displayName),
    imageUrl: photo?.imageUrl || undefined,
    variantId: pack?.id,
    packLabel: pack?.label ?? "Each",
    weightG: pack?.weightG,
    packOptions: listing.variants.flatMap((v) =>
      v.id && v.label
        ? [{ id: v.id, label: v.label, price: v.price, weightG: v.weightG }]
        : [],
    ),
    packLabels: [
      ...new Set(
        listing.variants
          .map((v) => v.label)
          .filter((label): label is string => !!label),
      ),
    ],
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
): Promise<{
  category: { name: string; slug: string } | null;
  listings: StorefrontListing[];
}> {
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
    include: { masterProduct: true, variants: true },
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
  imageUrl?: string;
  description?: string;
  categorySlug?: string;
  price: number;
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
    include: {
      masterProduct: { include: { category: true } },
      variants: { orderBy: [{ price: "asc" }, { id: "asc" }] },
    },
  });

  if (!listing || !listing.active) return null;

  const names = deriveNames(
    listing.customName,
    listing.masterProduct?.name ?? null,
  );
  const photo = catalogFor(listing.customName, listing.masterProduct?.name);

  return {
    id: listing.id,
    ...names,
    altName: names.altName ?? localNameFor(names.displayName),
    imageUrl: photo?.imageUrl || undefined,
    description: photo?.description,
    categorySlug: listing.masterProduct?.category?.slug,
    price: listing.price,
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
  frozen: boolean;
  perishable: boolean;
  imageUrl?: string;
  variantId?: string;
  packLabel?: string;
  weightG?: number;
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
  variant_id: string | null;
  pack_label: string | null;
  weight_g: number | null;
  frozen: boolean;
  perishable: boolean;
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
      l.frozen,
      l.perishable,
      pack.price AS min_variant_price,
      pack.id AS variant_id,
      pack.label AS pack_label,
      pack.weight_g
    FROM listings l
    LEFT JOIN master_products mp ON l.master_product_id = mp.id
    LEFT JOIN product_synonyms ps ON ps.product_id = mp.id
    LEFT JOIN LATERAL (
      SELECT lv.id, lv.label, lv.price, lv.weight_g
      FROM listing_variants lv WHERE lv.listing_id = l.id
      ORDER BY lv.price, lv.id LIMIT 1
    ) pack ON true
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
      altName: names.altName ?? localNameFor(names.displayName),
      imageUrl:
        catalogFor(row.custom_name, row.master_product_name)?.imageUrl ||
        undefined,
      variantId: row.variant_id ?? undefined,
      packLabel: row.pack_label ?? "Each",
      weightG: row.weight_g ?? undefined,
      price: row.min_variant_price ?? row.price,
      frozen: row.frozen,
      perishable: row.perishable,
      badge: stockBadge({
        confidence: row.confidence,
        stockMode: row.stock_mode,
        qty: row.qty,
        status: row.status,
      }),
    };
  });
}

export async function getActiveListings(
  storeId: string,
): Promise<StorefrontListing[]> {
  const scoped = storeScoped(storeId);
  const listings = await scoped.listing.findMany({
    where: { active: true },
    include: { masterProduct: true, variants: true },
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

export async function getActiveBanners(
  storeId: string,
): Promise<StorefrontBanner[]> {
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

export async function getActiveCollections(
  storeId: string,
): Promise<StorefrontCollection[]> {
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
): Promise<{
  collection: StorefrontCollection | null;
  listings: StorefrontListing[];
}> {
  const scoped = storeScoped(storeId);
  const collection = await scoped.storeCollection.findFirst({
    where: { slug: collectionSlug, active: true },
    include: {
      items: {
        orderBy: { sortOrder: "asc" },
        include: {
          listing: {
            include: { masterProduct: true, variants: true },
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
      variants: true,
    },
    orderBy: { createdAt: "desc" },
    take: MAX_HOMEPAGE_LISTINGS,
  });

  const byCategory = new Map<
    string,
    { slug: string; listings: StorefrontListing[] }
  >();
  for (const listing of listings) {
    const catName = listing.masterProduct?.category?.name ?? "Other";
    const catSlug = listing.masterProduct?.category?.slug ?? "other";
    const existing = byCategory.get(catName) ?? { slug: catSlug, listings: [] };
    existing.listings.push(toStorefrontListing(listing));
    byCategory.set(catName, existing);
  }

  return Array.from(byCategory.entries())
    .map(([name, data]) => ({
      categoryName: name,
      categorySlug: data.slug,
      listings: data.listings,
    }))
    .sort((a, b) => a.categoryName.localeCompare(b.categoryName));
}
