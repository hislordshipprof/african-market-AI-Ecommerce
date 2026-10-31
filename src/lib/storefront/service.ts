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
  startingPrice: number;
  badge: StockBadge;
  frozen: boolean;
  perishable: boolean;
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

  return {
    id: listing.id,
    displayName: listing.customName || listing.masterProduct?.name || "Unnamed",
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

  return {
    id: listing.id,
    displayName: listing.customName || listing.masterProduct?.name || "Unnamed",
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

  return results.map((row) => ({
    id: row.id,
    name: row.custom_name || row.master_product_name || "Unnamed",
    price: row.min_variant_price ?? row.price,
    badge: stockBadge({
      confidence: row.confidence,
      stockMode: row.stock_mode,
      qty: row.qty,
      status: row.status,
    }),
  }));
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
