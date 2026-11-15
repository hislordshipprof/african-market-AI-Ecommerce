/**
 * Three writers, three shapes. A new writer must add its shape here.
 * - `prisma/seed-demo-catalog.ts` writes lowercase words with underscores (`mn_egusi`).
 * - `src/lib/listing/service.ts` omits the id, so Prisma `cuid()` assigns it.
 * - `src/lib/listing/csv-import.ts` assigns `crypto.randomUUID()` (lowercase, hyphenated).
 * Anything else, including `not-a-listing-id`, is not an id.
 */
export const LISTING_ID = /^(?:[a-z0-9_]{1,64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function isListingId(value: string): boolean {
  return LISTING_ID.test(value);
}
