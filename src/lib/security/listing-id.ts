/**
 * Catalog ids are lowercase words with underscores (`mn_egusi`). New rows use
 * Prisma `cuid()` (`c` plus 24 lowercase letters or digits). Hyphens, dots,
 * and slashes are not ids.
 */
export const LISTING_ID = /^[a-z0-9_]{1,64}$/;

export function isListingId(value: string): boolean {
  return LISTING_ID.test(value);
}
