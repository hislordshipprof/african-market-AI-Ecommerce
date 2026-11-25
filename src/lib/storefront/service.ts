import { cachedStorefrontRead } from "./cache";
import { storeScoped, platform, storeScopedRawQuery, Prisma } from "../db";
import { orderPacks, shownPack } from "./pack-order";
import { nameMatches } from "./search-relevance";
import { listingAvailable, stockBadge, type StockBadge, type StockBadgeInput } from "./stock-badge";
import { catalogFor, localNameFor } from "./catalog";
import { E2E_LISTING_PREFIX } from "./e2e-listings";
import { listingImage, storefrontPhoto } from "./images";
import { countedStockLeft, effectiveMaxPerOrder } from "../cart/limits";
import { listingAttributes } from "../catalog/listing-attributes";
import { ALLERGENS, DIETARY_CLAIMS, type Allergen, type DietaryClaim } from "../catalog/attributes";
import type { ShopperNeed } from "../catalog/attributes";
import { effectiveAttributesSql, needExcludesSql } from "../catalog/attribute-sql";
import type { FlowCatalogItem } from "../customer-flow/contracts";
import type { CartAlternative } from "../cart/service";
import { isPreparedKind, type PreparedKind } from "../listing/prepared";

/** Prisma condition for storefront listing reads. NULL names (unnamed listings) must stay visible. */
const notE2eListing = {
  OR: [{ customName: null }, { NOT: { customName: { startsWith: E2E_LISTING_PREFIX } } }],
} satisfies Prisma.ListingWhereInput;

/** Same rule for the raw search SQL. LIKE is wrapped so NULL custom_name rows are kept. */
const notE2eListingSql = Prisma.sql`(l.custom_name IS NULL OR LEFT(l.custom_name, ${E2E_LISTING_PREFIX.length}) <> ${E2E_LISTING_PREFIX})`;

/**
 * Listings in one aisle (#782): a master product's category, or the listing's own aisle when it
 * has no master product.
 */
function inAisle(categoryId: string | { in: string[] }) {
  // AND keeps this OR apart from notE2eListing's OR when both are spread into one where.
  return {
    AND: [{ OR: [{ masterProduct: { categoryId } }, { masterProductId: null, categoryId }] }],
  } satisfies Prisma.ListingWhereInput;
}

/** The aisle a listing is shown in: its master product's category wins over its own. */
function aisleOf<C>(listing: { masterProduct: { category?: C | null } | null; category?: C | null }): C | null {
  return listing.masterProduct ? listing.masterProduct.category ?? null : listing.category ?? null;
}

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
      masterProduct: { include: { category: true } },
      category: true,
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
      categoryId: aisleOf(listing)?.id ?? "uncategorized",
      frozen: listing.frozen,
      prepared: isPreparedKind(listing.prepared) ? listing.prepared : null,
      catering: cateringTerms(listing),
      maxPerOrder: effectiveMaxPerOrder(listing.maxPerOrder),
      stockLeft: countedStockLeft(listing),
      cateringMinQty: listing.cateringMinQty ?? undefined,
      available: listingAvailable(listing),
    };
    return variants.length
      ? variants.map((variant) => ({
          ...base,
          variantId: variant.id,
          price: variant.price,
          packLabel: shownPack(variant).label,
          weightG: variant.weightG,
          shownWeightG: shownPack(variant).weightG,
        }))
      : [{ ...base, price: listing.price, packLabel: "Each", weightG: 500 }];
  });
}

/**
 * Up to `perLine` in-stock listings from each unavailable line's aisle, for the
 * drawer's "Try instead" row (#717 AC2). One read, only when a line is unavailable.
 */
export async function readCartAlternatives(
  storeId: string,
  wanted: { lineId: string; categoryId: string }[],
  excludeListingIds: string[],
  perLine = 3,
): Promise<Map<string, CartAlternative[]>> {
  const result = new Map<string, CartAlternative[]>();
  if (!wanted.length) return result;
  const listings = await storeScoped(storeId).listing.findMany({
    where: {
      active: true,
      ...notE2eListing,
      id: { notIn: excludeListingIds },
      ...inAisle({ in: [...new Set(wanted.map((entry) => entry.categoryId))] }),
    },
    include: { masterProduct: { include: { category: true } }, category: true, variants: variantsCheapestFirst },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  const inStock = listings.filter((listing) => listingAvailable(listing) && listing.variants.length > 0);
  for (const { lineId, categoryId } of wanted) {
    result.set(
      lineId,
      inStock
        .filter((listing) => aisleOf(listing)?.id === categoryId)
        .slice(0, perLine)
        .map((listing) => {
          const card = projectStorefrontListing(listing);
          return {
            listingId: card.id,
            variantId: card.variantId!,
            name: card.displayName,
            price: card.startingPrice,
            imageUrl: card.imageUrl,
            packLabel: card.packLabel ?? "Each",
            maxPerOrder: card.maxPerOrder,
          };
        }),
    );
  }
  return result;
}

/** The aisles this store has an active listing in (#782), in platform order. */
async function readListCategories(storeId: string) {
  const listings = await storeScoped(storeId).listing.findMany({
    where: { active: true, ...notE2eListing },
    select: { categoryId: true, masterProductId: true, masterProduct: { select: { categoryId: true } } },
  });
  const stocked = new Set(
    listings.flatMap((listing) => {
      const id = listing.masterProductId ? listing.masterProduct?.categoryId : listing.categoryId;
      return id ? [id] : [];
    }),
  );
  const categories = await platform.category.findMany({
    where: { id: { in: [...stocked] } },
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
  maxPerOrder: number;
  /** Units left on a counted listing (#808). */
  stockLeft?: number;
  /** A catering item's minimum, which the first add puts in (#808). */
  cateringMinQty?: number;
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
  maxPerOrder?: number | null;
  cateringMinQty?: number | null;
  imageUrl?: string | null;
  masterProduct: { name: string; imageUrl?: string | null; category?: { slug: string } | null } | null;
  category?: { slug: string } | null;
  variants: { id?: string; label?: string; price: number; weightG?: number; weightPlaceholder?: boolean }[];
}): StorefrontListing {
  const names = deriveNames(
    listing.customName,
    listing.masterProduct?.name ?? null,
  );
  const ordered = orderPacks(
    listing.variants.flatMap((variant) =>
      variant.id
        ? [{
            id: variant.id,
            price: variant.price,
            ...shownPack({ label: variant.label, weightG: variant.weightG, weightPlaceholder: variant.weightPlaceholder }),
          }]
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
    categorySlug: aisleOf(listing)?.slug,
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
    maxPerOrder: effectiveMaxPerOrder(listing.maxPerOrder),
    stockLeft: countedStockLeft(listing),
    cateringMinQty: listing.cateringMinQty ?? undefined,
  };
}

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
      ...inAisle(category.id),
    },
    include: { masterProduct: { include: { category: true } }, category: true, variants: variantsCheapestFirst },
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
  maxPerOrder: number;
  prepared: PreparedKind | null;
  /** Catering (#571): ordered this many hours ahead, at least this many. */
  catering: { leadHours: number; minQty: number } | null;
  variants: {
    id: string;
    label: string;
    price: number;
    weightG?: number;
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
      category: true,
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
    description: listing.description ?? photo?.description,
    categorySlug: aisleOf(listing)?.slug,
    price: listing.price,
    maxPerOrder: effectiveMaxPerOrder(listing.maxPerOrder),
    badge: stockBadge({
      confidence: listing.confidence,
      stockMode: listing.stockMode,
      qty: listing.qty,
      status: listing.status,
    } satisfies StockBadgeInput),
    frozen: listing.frozen,
    perishable: listing.perishable,
    prepared: isPreparedKind(listing.prepared) ? listing.prepared : null,
    catering: cateringTerms(listing),
    variants: orderPacks(listing.variants).map((v) => ({
      id: v.id,
      price: v.price,
      ...shownPack(v),
    })),
  };
}

function cateringTerms(listing: { cateringLeadHours: number | null; cateringMinQty: number | null }) {
  return listing.cateringLeadHours != null && listing.cateringMinQty != null
    ? { leadHours: listing.cateringLeadHours, minQty: listing.cateringMinQty }
    : null;
}

export interface ListingFacts {
  stockLeft?: number;
  /** A prepared item's allergens and dietary claims as stated; null when unknown or not prepared food. */
  allergens: Allergen[] | null;
  dietary: DietaryClaim[] | null;
}

/**
 * What the product page must never show stale (#808), read outside the storefront cache:
 * an order moves counted stock and an owner corrects allergens without revalidating it.
 */
export async function getListingFacts(storeId: string, listingId: string): Promise<ListingFacts | null> {
  const [listing, attributes] = await Promise.all([
    storeScoped(storeId).listing.findUnique({ where: { id: listingId }, select: { stockMode: true, qty: true, prepared: true } }),
    listingAttributes(storeId, listingId),
  ]);
  if (!listing || !attributes) return null;
  // In the listed order (milk before wheat), however the owner ticked them.
  const stated = <T extends string>(group: { status: string; values: T[] }, order: readonly T[]) =>
    listing.prepared != null && group.status !== "unknown" ? order.filter((value) => group.values.includes(value)) : null;
  return { stockLeft: countedStockLeft(listing), allergens: stated(attributes.allergens, ALLERGENS), dietary: stated(attributes.dietary, DIETARY_CLAIMS) };
}

export interface SearchResult {
  id: string;
  name: string;
  altName?: string;
  price: number;
  badge: StockBadge;
  frozen: boolean;
  perishable: boolean;
  maxPerOrder: number;
  imageUrl?: string;
  categorySlug?: string;
  variantId?: string;
  packLabel?: string;
  weightG?: number;
}

export type CatalogMatch = "name" | "synonym" | "near";

export interface SearchHit extends SearchResult {
  match: CatalogMatch;
  matchedTerm?: string;
}

interface RawSearchRow {
  id: string;
  custom_name: string | null;
  master_product_name: string | null;
  image_url: string | null;
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
  weight_placeholder: boolean | null;
  frozen: boolean;
  perishable: boolean;
  max_per_order: number | null;
  match: string;
  matched_term: string | null;
}

async function readSearchListings(
  storeId: string,
  query: string,
  need: ShopperNeed | null = null,
): Promise<SearchHit[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const results = await storeScopedRawQuery<RawSearchRow>(
    storeId,
    Prisma.sql`
    SELECT l.id, l.custom_name, l.image_url, mp.name AS master_product_name, mp.image_url AS master_product_image, c.slug AS category_slug,
      l.price, l.confidence, l.stock_mode, l.qty, l.status, l.frozen, l.perishable, l.max_per_order,
      pack.price AS min_variant_price, pack.id AS variant_id,
      pack.label AS pack_label, pack.weight_g, pack.weight_placeholder,
      CASE
        WHEN to_tsvector('english', name_doc.doc) @@ plainto_tsquery('english', unaccent(${trimmed})) THEN 'name'
        WHEN synonym_hit.term IS NOT NULL THEN 'synonym'
        ELSE 'near'
      END AS match,
      CASE
        WHEN to_tsvector('english', name_doc.doc) @@ plainto_tsquery('english', unaccent(${trimmed})) THEN NULL
        ELSE synonym_hit.term
      END AS matched_term
    FROM listings l
    LEFT JOIN master_products mp ON l.master_product_id = mp.id
    LEFT JOIN categories c ON mp.category_id = c.id
    ${need ? effectiveAttributesSql : Prisma.empty}
    LEFT JOIN LATERAL (
      SELECT lv.id, lv.label, lv.price, lv.weight_g, lv.weight_placeholder FROM listing_variants lv
      WHERE lv.listing_id = l.id ORDER BY lv.price, lv.id COLLATE "C" LIMIT 1
    ) pack ON true
    LEFT JOIN LATERAL (
      SELECT string_agg(lv.label, ' ') AS blob
      FROM listing_variants lv
      WHERE lv.listing_id = l.id
    ) labels ON true
    CROSS JOIN LATERAL (
      SELECT unaccent(coalesce(l.custom_name, '') || ' ' || coalesce(mp.name, '')) AS title,
             unaccent(coalesce(l.custom_name, '') || ' ' || coalesce(mp.name, '') || ' ' || coalesce(labels.blob, '')) AS doc
    ) name_doc
    LEFT JOIN LATERAL (
      SELECT ps.term
      FROM product_synonyms ps
      WHERE ps.product_id = mp.id
        AND (
          lower(unaccent(ps.term)) = lower(unaccent(${trimmed}))
          OR to_tsvector('english', unaccent(ps.term)) @@ plainto_tsquery('english', unaccent(${trimmed}))
        )
      ORDER BY (lower(unaccent(ps.term)) = lower(unaccent(${trimmed}))) DESC, length(ps.term) DESC, ps.term
      LIMIT 1
    ) synonym_hit ON true
    CROSS JOIN LATERAL (
      SELECT MIN(CASE
        WHEN lower(unaccent(term)) = lower(unaccent(${trimmed})) THEN 0
        WHEN starts_with(lower(unaccent(term)), lower(unaccent(${trimmed}))) THEN 1
        WHEN to_tsvector('english', unaccent(term)) @@ plainto_tsquery('english', unaccent(${trimmed})) THEN 2
        ELSE 3 END) AS rank,
        MAX(search_similarity(lower(unaccent(${trimmed})), lower(unaccent(term)))) AS fuzzy
      FROM (
        SELECT l.custom_name AS term UNION ALL SELECT mp.name
        UNION ALL SELECT ps.term FROM product_synonyms ps WHERE ps.product_id = mp.id
      ) terms WHERE term IS NOT NULL AND term <> ''
    ) relevance
    CROSS JOIN LATERAL (
      SELECT search_word_similarity(lower(unaccent(${trimmed})), lower(name_doc.doc)) AS score,
             search_word_similarity(lower(unaccent(${trimmed})), lower(name_doc.title)) AS title_score
    ) typo
    WHERE l.active = true AND ${notE2eListingSql}
      AND (relevance.rank < 3 OR (length(${trimmed}) >= 3 AND typo.score > 0.3))
      AND NOT ${need ? needExcludesSql(need) : Prisma.sql`false`}
    ORDER BY
      CASE
        WHEN to_tsvector('english', name_doc.doc) @@ plainto_tsquery('english', unaccent(${trimmed})) THEN 0
        WHEN synonym_hit.term IS NOT NULL THEN 1
        ELSE 2
      END,
      relevance.rank, GREATEST(relevance.fuzzy, typo.title_score) DESC, LOWER(COALESCE(l.custom_name, mp.name)), l.id
    LIMIT 50
    `,
  );

  return results.map((row) => {
    const names = deriveNames(row.custom_name, row.master_product_name);
    return {
      id: row.id,
      name: names.displayName,
      altName: names.altName ?? localNameFor(names.displayName),
      imageUrl: listingImage({ imageUrl: row.image_url, customName: row.custom_name, masterProduct: row.master_product_name ? { name: row.master_product_name, imageUrl: row.master_product_image } : null }),
      categorySlug: row.category_slug ?? undefined,
      variantId: row.variant_id ?? undefined,
      packLabel: row.weight_placeholder ? "Each" : row.pack_label ?? "Each",
      weightG: row.weight_placeholder ? undefined : row.weight_g ?? undefined,
      price: row.min_variant_price ?? row.price,
      frozen: row.frozen,
      perishable: row.perishable,
      maxPerOrder: effectiveMaxPerOrder(row.max_per_order),
      badge: stockBadge({
        confidence: row.confidence,
        stockMode: row.stock_mode,
        qty: row.qty,
        status: row.status,
      } satisfies StockBadgeInput),
      match: row.match === "name" || row.match === "synonym" ? row.match : "near",
      ...(row.matched_term ? { matchedTerm: row.matched_term } : {}),
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

const DEFAULT_DELIVERY_RADIUS_MI = 8;

/** A Decimal, number or numeric string as a finite number; anything else is the schema default. */
function deliveryRadiusOrDefault(raw: unknown): number {
  if (raw === null || raw === undefined) return DEFAULT_DELIVERY_RADIUS_MI;
  const text = String(raw).trim();
  const n = text === "" ? NaN : Number(text);
  return Number.isFinite(n) ? n : DEFAULT_DELIVERY_RADIUS_MI;
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
    deliveryRadiusMi: deliveryRadiusOrDefault(store.deliveryRadiusMi),
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
      category: true,
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
    const catName = aisleOf(listing)?.name ?? "Other";
    const catSlug = aisleOf(listing)?.slug ?? "other";
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

export function listCategories(storeId: string) {
  return cachedStorefrontRead(storeId, JSON.stringify(["listCategories"]), () => readListCategories(storeId));
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

function loadSearch(storeId: string, query: string) {
  return cachedStorefrontRead(
    storeId,
    JSON.stringify(["searchListings", query]),
    () => readSearchListings(storeId, query),
  );
}

function withoutMatch(row: SearchHit): SearchResult {
  const { match, matchedTerm, ...rest } = row;
  void match;
  void matchedTerm;
  return rest;
}

export function searchListings(storeId: string, query: string) {
  return loadSearch(storeId, query).then((rows) => rows.map(withoutMatch));
}

/** The assistant's search. A need filters in SQL before ranking: an excluded listing never comes back. */
export function searchCatalogHits(storeId: string, query: string, need: ShopperNeed | null = null) {
  // Attribute reviews do not revalidate store caches, so a need always reads fresh.
  return need ? readSearchListings(storeId, query, need) : loadSearch(storeId, query);
}

export interface SearchSuggestion {
  /** A search that finds at least this listing: its display name, lower case. */
  text: string;
  /** The synonym, local or catalogue name the prefix matched when the store's name did not. */
  via?: string;
}

export interface SearchSuggestions {
  suggestions: SearchSuggestion[];
  aisles: { name: string; slug: string }[];
  products: SearchResult[];
}

interface RawSuggestRow {
  display_name: string;
  name_hit: boolean;
  via: string | null;
  aisle_name: string | null;
  aisle_slug: string | null;
  aisle_hit: boolean;
  ordered: number;
}

/** This store's active listings whose name, catalogue name, synonym or aisle starts a word with `prefix`. */
async function readSuggestRows(storeId: string, prefix: string) {
  const displayName = Prisma.sql`COALESCE(NULLIF(TRIM(l.custom_name), ''), mp.name)`;
  return storeScopedRawQuery<RawSuggestRow>(
    storeId,
    Prisma.sql`
    SELECT * FROM (
      SELECT ${displayName} AS display_name,
        ${nameMatches(displayName, prefix)} AS name_hit,
        (SELECT term FROM (SELECT mp.name AS term UNION ALL SELECT ps.term FROM product_synonyms ps WHERE ps.product_id = mp.id) t
          WHERE term IS NOT NULL AND ${nameMatches(Prisma.sql`term`, prefix)} ORDER BY length(term), term LIMIT 1) AS via,
        c.name AS aisle_name, c.slug AS aisle_slug,
        COALESCE(${nameMatches(Prisma.sql`c.name`, prefix)} OR ${nameMatches(Prisma.sql`c.local_name`, prefix)}, false) AS aisle_hit,
        (SELECT COALESCE(SUM(ol.qty_ordered), 0)::int FROM order_lines ol
          JOIN listing_variants lv ON lv.id = ol.listing_variant_id WHERE lv.listing_id = l.id) AS ordered
      FROM listings l
      LEFT JOIN master_products mp ON l.master_product_id = mp.id
      LEFT JOIN categories c ON c.id = CASE WHEN l.master_product_id IS NULL THEN l.category_id ELSE mp.category_id END
      WHERE l.active = true AND ${notE2eListingSql}
    ) rows
    WHERE display_name IS NOT NULL AND (name_hit OR via IS NOT NULL OR aisle_hit)
    `,
  );
}

const SUGGESTION_LIMIT = 6;
const AISLE_LIMIT = 3;
const PRODUCT_LIMIT = 5;

async function readSearchSuggestions(storeId: string, prefix: string): Promise<Omit<SearchSuggestions, "products">> {
  const rows = await readSuggestRows(storeId, prefix);
  const typed = prefix.toLowerCase();
  const ranked = rows
    .filter((row) => row.name_hit || row.via)
    .map((row) => {
      const text = row.display_name.trim().toLowerCase();
      const rank = text.startsWith(typed) ? 0 : row.name_hit ? 1 : 2;
      return { text, rank, ordered: row.ordered, via: rank === 2 ? row.via!.toLowerCase() : undefined };
    })
    .sort((a, b) => a.rank - b.rank || b.ordered - a.ordered || a.text.localeCompare(b.text));
  const suggestions = new Map<string, SearchSuggestion>();
  for (const { text, via } of ranked) {
    if (!suggestions.has(text)) suggestions.set(text, via ? { text, via } : { text });
  }
  // Aisles named like the prefix first, then the aisles of the most matching listings.
  const aisles = new Map<string, { name: string; slug: string; named: boolean; hits: number }>();
  for (const row of rows) {
    if (!row.aisle_slug || !row.aisle_name) continue;
    const aisle = aisles.get(row.aisle_slug) ?? { name: row.aisle_name, slug: row.aisle_slug, named: row.aisle_hit, hits: 0 };
    aisle.hits += row.name_hit || row.via ? 1 : 0;
    aisles.set(row.aisle_slug, aisle);
  }
  return {
    suggestions: [...suggestions.values()].slice(0, SUGGESTION_LIMIT),
    aisles: [...aisles.values()]
      .sort((a, b) => Number(b.named) - Number(a.named) || b.hits - a.hits || a.name.localeCompare(b.name))
      .slice(0, AISLE_LIMIT)
      .map(({ name, slug }) => ({ name, slug })),
  };
}

/** What the search box offers as the shopper types (#835): completions, aisles and products. */
export async function suggestSearch(storeId: string, query: string): Promise<SearchSuggestions> {
  const prefix = query.trim();
  if (!prefix) return { suggestions: [], aisles: [], products: [] };
  const [groups, products] = await Promise.all([
    cachedStorefrontRead(storeId, JSON.stringify(["searchSuggestions", prefix]), () => readSearchSuggestions(storeId, prefix)),
    searchListings(storeId, prefix),
  ]);
  return { ...groups, products: products.slice(0, PRODUCT_LIMIT) };
}

const POPULAR_LIMIT = 6;

/** The store's most ordered listings it still sells, as searches for an empty search box. There is no search log. */
async function readPopularSearches(storeId: string): Promise<string[]> {
  const rows = await storeScopedRawQuery<{ text: string }>(
    storeId,
    Prisma.sql`
    SELECT LOWER(COALESCE(NULLIF(TRIM(l.custom_name), ''), mp.name)) AS text
    FROM order_lines ol
    JOIN listing_variants lv ON lv.id = ol.listing_variant_id
    JOIN listings l ON l.id = lv.listing_id
    LEFT JOIN master_products mp ON l.master_product_id = mp.id
    WHERE l.active = true AND ${notE2eListingSql}
    GROUP BY 1 HAVING LOWER(COALESCE(NULLIF(TRIM(l.custom_name), ''), mp.name)) IS NOT NULL
    ORDER BY SUM(ol.qty_ordered) DESC, 1
    LIMIT ${POPULAR_LIMIT}
    `,
  );
  return rows.map((row) => row.text);
}

export function popularSearches(storeId: string) {
  return cachedStorefrontRead(storeId, JSON.stringify(["popularSearches"]), () => readPopularSearches(storeId));
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
