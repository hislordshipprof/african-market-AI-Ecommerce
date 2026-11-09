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

/**
 * `one`: exactly one listing matches every word of the query.
 * `several`: more than one does, or none does and these are look-alikes (`nearOnly`).
 * `none`: nothing is close.
 */
export type ListingSearch =
  | { outcome: "one"; nearOnly: false; listings: [ListingMatch] }
  | { outcome: "several"; nearOnly: boolean; listings: ListingMatch[] }
  | { outcome: "none"; nearOnly: false; listings: [] };

interface SearchRow {
  id: string;
  name: string;
  stock_mode: string;
  qty: number | null;
  status: string | null;
  tier: "one" | "several" | "near";
}

const NONE: ListingSearch = { outcome: "none", nearOnly: false, listings: [] };

/**
 * Active listings only, uncached, at most five. The storefront E2E name filter does not apply.
 * A listing matches every query word when its relevance rank is exact, prefix or full text (rank < 3).
 * Trigram look-alikes (rank 3) are returned only when no listing matches every word.
 */
export async function searchListingMatches(storeId: string, rawQuery: string): Promise<ListingSearch> {
  const { query, tooLong } = normalizedSearchQuery(rawQuery);
  if (!query || tooLong) return NONE;
  const rows = await storeScopedRawQuery<SearchRow>(
    storeId,
    Prisma.sql`
      WITH matches AS (
        SELECT l.id,
          COALESCE(NULLIF(btrim(l.custom_name), ''), NULLIF(btrim(mp.name), ''), 'Unnamed') AS name,
          LOWER(COALESCE(l.custom_name, mp.name)) AS sort_name,
          l.stock_mode, l.qty, l.status, relevance.rank, relevance.fuzzy
        FROM listings l
        LEFT JOIN master_products mp ON l.master_product_id = mp.id
        ${listingRelevanceJoin(query)}
        WHERE l.active = true AND ${listingRelevanceWhere(query)}
      ),
      strong AS (SELECT COUNT(*) AS n FROM matches WHERE rank < 3)
      SELECT m.id, m.name, m.stock_mode, m.qty, m.status,
        CASE WHEN s.n = 1 THEN 'one' WHEN s.n > 1 THEN 'several' ELSE 'near' END AS tier
      FROM matches m CROSS JOIN strong s
      WHERE m.rank < 3 OR s.n = 0
      ORDER BY m.rank, m.fuzzy DESC, m.sort_name, m.id
      LIMIT 5
    `,
  );
  const listings = rows.map((row) => ({
    id: row.id,
    name: row.name,
    stockMode: row.stock_mode,
    qty: row.qty,
    status: row.status,
  }));
  const first = listings[0];
  if (!first) return NONE;
  if (rows[0]!.tier === "one") return { outcome: "one", nearOnly: false, listings: [first] };
  return { outcome: "several", nearOnly: rows[0]!.tier === "near", listings };
}
