import { cachedStorefrontRead } from "./cache";
import { listingRelevanceJoin, listingRelevanceWhere } from "./search-relevance";
import { storeScoped, platform, storeScopedRawQuery, Prisma } from "../db";
import { orderPacks } from "./pack-order";
import { stockBadge, type StockBadge, type StockBadgeInput } from "./stock-badge";
import { catalogFor, localNameFor } from "./catalog";
import { E2E_LISTING_PREFIX } from "./e2e-listings";
import { listingImage, storefrontPhoto } from "./images";
import { effectiveMaxPerOrder } from "../cart/limits";
import type { FlowCatalogItem } from "../customer-flow/contracts";

/** Prisma condition for storefront listing reads. NULL names (unnamed listings) must stay visible. */
const notE2eListing = {
  OR: [{ customName: null }, { NOT: { customName: { startsWith: E2E_LISTING_PREFIX } } }],
} satisfies Prisma.ListingWhereInput;

/** Same rule for the raw search SQL. LIKE is wrapped so NULL custom_name rows are kept. */
const notE2eListingSql = Prisma.sql`(l.custom_name IS NULL OR LEFT(l.custom_name, ${E2E_LISTING_PREFIX.length}) <> ${E2E_LISTING_PREFIX})`;

/** Cheapest pack first, then id. The projection sorts the same way with UTF-8 bytes. */
const variantsCheapestFirst = {
  orderBy: [{ price: "asc" as const }, { id: "asc" as const }],
};

/** Read-only, tenant-scoped catalog projection for the demo journey adapters. */
async function readGetFlowCatalog(
  storeId: string,
): Promise<FlowCatalogItem[]> {
  const listings = await storeScoped(storeId).listing.findMany({
    where: { active: true, ...notE2eListing },
    include: {
      masterProduct: true,
      variants: variantsCheapestFirst,
    },
    orderBy: { createdAt: "desc" },
  });
  return listings.flatMap((listing) => {
    const item = projectStorefrontListing(listing);
    const variants = orderPacks(listing.variants);
    const base = {
      listingId: listing.id,
      name: item.displayName,
      imageUrl: item.imageUrl,
      categoryId: listing.masterProduct?.categoryId ?? "uncategorized",
      frozen: listing.frozen,
      maxPerOrder: effectiveMaxPerOrder(listing.maxPerOrder),
      available:
        !(listing.stockMode === "counted" && (listing.qty ?? 0) <= 0) &&
        !(listing.stockMode === "status" && listing.status === "out_of_stock"),
    };
    return variants.length
      ? variants.map((variant) => ({
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
  const categories = await platform.category.findMany({
    orderBy: { sortOrder: "asc" },
    include: { masterProducts: { where: { imageUrl: { not: null }, status: "active" }, orderBy: { id: "asc" }, take: 1, select: { imageUrl: true } } },
  });
  return categories.map(({ masterProducts, ...category }) => ({
    ...category,
    imageUrl: storefrontPhoto(category.imageUrl) ?? storefrontPhoto(masterProducts[0]?.imageUrl) ?? null,
  }));
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
  categorySlug?: string;
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

export function projectStorefrontListing(listing: {
  id: string;
  customName: string | null;
  price: number;
  confidence: number;
  stockMode: string;
  qty: number | null;
  status: string | null;
  frozen: boolean;
  perishable: boolean;
  imageUrl?: string | null;
  masterProduct: { name: string; imageUrl?: string | null; category?: { slug: string } | null } | null;
  variants: { id?: string; label?: string; price: number; weightG?: number }[];
}): StorefrontListing {
  const names = deriveNames(
    listing.customName,
    listing.masterProduct?.name ?? null,
  );
  const ordered = orderPacks(
    listing.variants.flatMap((variant) =>
      variant.id
        ? [{ id: variant.id, label: variant.label, price: variant.price, weightG: variant.weightG }]
        : [],
    ),
  );
  const pack = ordered[0];
  const startingPrice = pack ? pack.price : listing.price;
  const packLabels: string[] = [];
  for (const variant of ordered) {
    if (variant.label && !packLabels.includes(variant.label)) packLabels.push(variant.label);
  }
  return {
    id: listing.id,
    ...names,
    altName: names.altName ?? localNameFor(names.displayName),
    imageUrl: listingImage(listing),
    categorySlug: listing.masterProduct?.category?.slug,
    variantId: pack?.id,
    packLabel: pack?.label ?? "Each",
    weightG: pack?.weightG,
    packOptions: ordered.flatMap((variant) =>
      variant.label
        ? [{ id: variant.id, label: variant.label, price: variant.price, weightG: variant.weightG }]
        : [],
    ),
    packLabels,
    startingPrice,
    badge: stockBadge({
      confidence: listing.confidence,
      stockMode: listing.stockMode,
      qty: listing.qty,
      status: listing.status,
    } satisfies StockBadgeInput),
    frozen: listing.frozen,
    perishable: listing.perishable,
  };
}

// Custom-name-only listings (those without a masterProductId) are excluded by design: categories
// derive from master products. These listings are reachable via search and the all-products view.
async function readListingsByCategory(
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
      ...notE2eListing,
      masterProduct: { categoryId: category.id },
    },
    include: { masterProduct: { include: { category: true } }, variants: variantsCheapestFirst },
    orderBy: { createdAt: "desc" },
  });

  return {
    category: { name: category.name, slug: category.slug },
    listings: listings.map(projectStorefrontListing),
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
  categorySlug?: string;
  description?: string;
  price: number;
  variants: {
    id: string;
    label: string;
    price: number;
    weightG: number;
  }[];
}

async function readGetListingDetail(
  storeId: string,
  listingId: string,
): Promise<StorefrontListingDetail | null> {
  const scoped = storeScoped(storeId);
  const listing = await scoped.listing.findUnique({
    where: { id: listingId },
    include: {
      masterProduct: { include: { category: true } },
      variants: variantsCheapestFirst,
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
    imageUrl: listingImage(listing),
    description: photo?.description,
    categorySlug: listing.masterProduct?.category?.slug,
    price: listing.price,
    badge: stockBadge({
      confidence: listing.confidence,
      stockMode: listing.stockMode,
      qty: listing.qty,
      status: listing.status,
    } satisfies StockBadgeInput),
    frozen: listing.frozen,
    perishable: listing.perishable,
    variants: orderPacks(listing.variants).map((v) => ({
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
  categorySlug?: string;
  variantId?: string;
  packLabel?: string;
  weightG?: number;
}

interface RawSearchRow {
  id: string;
  custom_name: string | null;
  master_product_name: string | null;
  master_product_image: string | null;
  category_slug: string | null;
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

async function readSearchListings(
  storeId: string,
  query: string,
): Promise<SearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const results = await storeScopedRawQuery<RawSearchRow>(
    storeId,
    Prisma.sql`
    SELECT l.id, l.custom_name, mp.name AS master_product_name, mp.image_url AS master_product_image, c.slug AS category_slug,
      l.price, l.confidence, l.stock_mode, l.qty, l.status, l.frozen, l.perishable,
      pack.price AS min_variant_price, pack.id AS variant_id,
      pack.label AS pack_label, pack.weight_g
    FROM listings l
    LEFT JOIN master_products mp ON l.master_product_id = mp.id
    LEFT JOIN categories c ON mp.category_id = c.id
    LEFT JOIN LATERAL (
      SELECT lv.id, lv.label, lv.price, lv.weight_g FROM listing_variants lv
      WHERE lv.listing_id = l.id ORDER BY lv.price, lv.id COLLATE "C" LIMIT 1
    ) pack ON true
    ${listingRelevanceJoin(trimmed)}
    WHERE l.active = true AND ${notE2eListingSql} AND ${listingRelevanceWhere(trimmed)}
    ORDER BY relevance.rank, relevance.fuzzy DESC, LOWER(COALESCE(l.custom_name, mp.name)), l.id
    LIMIT 50
    `,
  );

  return results.map((row) => {
    const names = deriveNames(row.custom_name, row.master_product_name);
    return {
      id: row.id,
      name: names.displayName,
      altName: names.altName ?? localNameFor(names.displayName),
      imageUrl: listingImage({ customName: row.custom_name, masterProduct: row.master_product_name ? { name: row.master_product_name, imageUrl: row.master_product_image } : null }),
      categorySlug: row.category_slug ?? undefined,
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
      } satisfies StockBadgeInput),
    };
  });
}

async function readGetActiveListings(
  storeId: string,
): Promise<StorefrontListing[]> {
  const scoped = storeScoped(storeId);
  const listings = await scoped.listing.findMany({
    where: { active: true, ...notE2eListing },
    include: { masterProduct: { include: { category: true } }, variants: variantsCheapestFirst },
    orderBy: { createdAt: "desc" },
  });

  return listings.map(projectStorefrontListing);
}

export interface StorefrontBanner {
  id: string;
  title: string;
  subtitle: string | null;
  ctaText: string | null;
  ctaHref: string | null;
  imageUrl: string;
}

async function readGetActiveBanners(
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

async function readGetActiveCollections(
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

async function readGetCollectionListings(
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
            include: { masterProduct: { include: { category: true } }, variants: variantsCheapestFirst },
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
      .filter((l) => l.active && !l.customName?.startsWith(E2E_LISTING_PREFIX))
      .map(projectStorefrontListing),
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

async function readGetListingsByCategory(
  storeId: string,
): Promise<CategoryRail[]> {
  const scoped = storeScoped(storeId);
  const MAX_HOMEPAGE_LISTINGS = 120;
  const listings = await scoped.listing.findMany({
    where: { active: true, ...notE2eListing },
    include: {
      masterProduct: { include: { category: true } },
      variants: variantsCheapestFirst,
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
    existing.listings.push(projectStorefrontListing(listing));
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

export function getFlowCatalog(storeId: string) {
  return cachedStorefrontRead(storeId, JSON.stringify(["getFlowCatalog"]), () => readGetFlowCatalog(storeId));
}

export function listingsByCategory(storeId: string, categorySlug: string) {
  return cachedStorefrontRead(storeId, JSON.stringify(["listingsByCategory", categorySlug]), () => readListingsByCategory(storeId, categorySlug));
}

export function getListingDetail(storeId: string, listingId: string) {
  return cachedStorefrontRead(storeId, JSON.stringify(["getListingDetail", listingId]), () => readGetListingDetail(storeId, listingId));
}

export function searchListings(storeId: string, query: string) {
  return cachedStorefrontRead(storeId, JSON.stringify(["searchListings", query]), () => readSearchListings(storeId, query));
}

export function getActiveListings(storeId: string) {
  return cachedStorefrontRead(storeId, JSON.stringify(["getActiveListings"]), () => readGetActiveListings(storeId));
}

export function getActiveBanners(storeId: string) {
  return cachedStorefrontRead(storeId, JSON.stringify(["getActiveBanners"]), () => readGetActiveBanners(storeId));
}

export function getActiveCollections(storeId: string) {
  return cachedStorefrontRead(storeId, JSON.stringify(["getActiveCollections"]), () => readGetActiveCollections(storeId));
}

export function getCollectionListings(storeId: string, collectionSlug: string) {
  return cachedStorefrontRead(storeId, JSON.stringify(["getCollectionListings", collectionSlug]), () => readGetCollectionListings(storeId, collectionSlug));
}

export function getListingsByCategory(storeId: string) {
  return cachedStorefrontRead(storeId, JSON.stringify(["getListingsByCategory"]), () => readGetListingsByCategory(storeId));
}
