import { Prisma } from "../db";

/** 0 exact, 1 prefix, 2 full text, 3 no match, for column `term` against a trimmed query. */
function termRank(trimmed: string): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN LOWER(term) = LOWER(${trimmed}) THEN 0
    WHEN STARTS_WITH(LOWER(term), LOWER(${trimmed})) THEN 1
    WHEN to_tsvector('english', term) @@ plainto_tsquery('english', ${trimmed}) THEN 2
    ELSE 3 END`;
}

/** The words of `text` long enough to match the query by prefix. */
function wordTerms(text: Prisma.Sql, trimmed: string): Prisma.Sql {
  return Prisma.sql`SELECT word.w FROM search_words(${text}) word
    WHERE length(word.w) >= GREATEST(3, length(${trimmed}) - 1)`;
}

/**
 * Ranks listing `l` against its master product `mp` for a trimmed query.
 * Both the storefront search and the copilot use this join, so the rules stay one copy.
 */
export function listingRelevanceJoin(trimmed: string): Prisma.Sql {
  return Prisma.sql`
    CROSS JOIN LATERAL (
      SELECT MIN(${termRank(trimmed)}) AS rank,
        MAX(search_similarity(LOWER(${trimmed}), LOWER(term))) AS fuzzy
      FROM (
        SELECT l.custom_name AS term UNION ALL SELECT mp.name
        UNION ALL SELECT ps.term FROM product_synonyms ps WHERE ps.product_id = mp.id
        UNION ALL ${wordTerms(Prisma.sql`COALESCE(mp.name, '') || ' ' || COALESCE(l.custom_name, '')`, trimmed)}
      ) terms WHERE term IS NOT NULL
    ) relevance
  `;
}

export function listingRelevanceWhere(trimmed: string): Prisma.Sql {
  return Prisma.sql`(relevance.rank < 3 OR (length(${trimmed}) >= 3 AND relevance.fuzzy > 0.3))`;
}

/** True when `name` alone matches the query by the same rules as the join (rank < 3). */
export function nameMatches(name: Prisma.Sql, trimmed: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM (SELECT ${name} AS term UNION ALL ${wordTerms(name, trimmed)}) terms
    WHERE ${termRank(trimmed)} < 3
  )`;
}
