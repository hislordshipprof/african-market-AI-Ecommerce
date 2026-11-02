/**
 * E2E test listings are named with this prefix (see e2e/listings.spec.ts). Storefront reads
 * exclude them so test data never reaches customers even when cleanup has not run (#116), and
 * e2e/cleanup-listings.ts deletes them. Kept dependency-free so Playwright can import it.
 */
export const E2E_LISTING_PREFIX = "E2E ";
