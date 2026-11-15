export const SEARCH_QUERY_MAX = 200;
export const SEARCH_QUERY_TOO_LONG = "Search query is too long";

/** Trim first. 201 spaces is empty, not too long. A 201-character query is rejected. */
export function normalizedSearchQuery(raw: string): { query: string; tooLong: boolean } {
  const query = raw.trim();
  return { query, tooLong: query.length > SEARCH_QUERY_MAX };
}
