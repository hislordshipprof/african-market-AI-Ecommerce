import { Prisma, storeScopedRawQuery } from "../db";
import { listingRelevanceJoin, listingRelevanceWhere } from "../storefront/search-relevance";
import { normalizedSearchQuery } from "../storefront/search-query";

export interface ListingMatch {
  id: string;
  name: string;
  stockMode: string;
  qty: number | null;
  status: string | null;
}

interface SearchRow {
  id: string;
  name: string;
  stock_mode: string;
  qty: number | null;
  status: string | null;
}

/** Active listings only, uncached, at most five. The storefront E2E name filter does not apply. */
export async function searchListingMatches(storeId: string, rawQuery: string): Promise<ListingMatch[]> {
  const { query, tooLong } = normalizedSearchQuery(rawQuery);
  if (!query || tooLong) return [];
  const rows = await storeScopedRawQuery<SearchRow>(
    storeId,
    Prisma.sql`
      SELECT l.id,
        COALESCE(NULLIF(btrim(l.custom_name), ''), NULLIF(btrim(mp.name), ''), 'Unnamed') AS name,
        l.stock_mode, l.qty, l.status
      FROM listings l
      LEFT JOIN master_products mp ON l.master_product_id = mp.id
      ${listingRelevanceJoin(query)}
      WHERE l.active = true AND ${listingRelevanceWhere(query)}
      ORDER BY relevance.rank, relevance.fuzzy DESC, LOWER(COALESCE(l.custom_name, mp.name)), l.id
      LIMIT 5
    `,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    stockMode: row.stock_mode,
    qty: row.qty,
    status: row.status,
  }));
}
