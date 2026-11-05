/** Prisma `@default(cuid())`: `c` plus 24 lowercase alphanumeric characters. */
export const LISTING_ID = /^c[0-9a-z]{24}$/;

export function isListingId(value: string): boolean {
  return LISTING_ID.test(value);
}
