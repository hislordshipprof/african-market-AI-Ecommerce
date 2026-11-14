import { Prisma } from "../db";

/**
 * Ranks listing `l` against its master product `mp` for a trimmed query.
 * Both the storefront search and the copilot use this join, so the rules stay one copy.
 */
export function listingRelevanceJoin(trimmed: string): Prisma.Sql {
  return Prisma.sql`
    CROSS JOIN LATERAL (
      SELECT MIN(CASE
        WHEN LOWER(term) = LOWER(${trimmed}) THEN 0
        WHEN STARTS_WITH(LOWER(term), LOWER(${trimmed})) THEN 1
        WHEN to_tsvector('english', term) @@ plainto_tsquery('english', ${trimmed}) THEN 2
        ELSE 3 END) AS rank,
        MAX(search_similarity(LOWER(${trimmed}), LOWER(term))) AS fuzzy
      FROM (
        SELECT l.custom_name AS term UNION ALL SELECT mp.name
        UNION ALL SELECT ps.term FROM product_synonyms ps WHERE ps.product_id = mp.id
        UNION ALL SELECT word.w FROM search_words(COALESCE(mp.name, '') || ' ' || COALESCE(l.custom_name, '')) word
        WHERE length(word.w) >= GREATEST(3, length(${trimmed}) - 1)
      ) terms WHERE term IS NOT NULL
    ) relevance
  `;
}

export function listingRelevanceWhere(trimmed: string): Prisma.Sql {
  return Prisma.sql`(relevance.rank < 3 OR (length(${trimmed}) >= 3 AND relevance.fuzzy > 0.3))`;
}
