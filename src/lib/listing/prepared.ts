/**
 * Prepared food in a grocery store (#570, ADR-0004 amendment): jollof, suya or puff-puff from the
 * counter. A prepared listing is hot or cold, carries its prep minutes, is taxed as prepared food,
 * sells only as the exact item, and is on sale only once its owner has stated its allergens.
 */

export const PREPARED_KINDS = ["hot", "cold"] as const;
export type PreparedKind = (typeof PREPARED_KINDS)[number];

/** Stripe Tax "Food for Immediate Consumption": prepared, ready-to-eat and heated food (looked up 2026-11-15). */
export const PREPARED_FOOD_TAX_CODE = "txcd_40060003";

export const MAX_PREP_MINUTES = 120;

export const PREPARED_EXACT_ONLY = "Prepared food is sold as the exact item only, with no swap.";

export const PREPARED_NEEDS_ALLERGENS = "State this item's allergens before it goes on sale.";

export function isPreparedKind(value: unknown): value is PreparedKind {
  return typeof value === "string" && (PREPARED_KINDS as readonly string[]).includes(value);
}

/** A prepared listing sells only once its owner has stated its allergens (decision: owner-stated before sale). */
export function preparedSaleBlocked(
  listing: { prepared: string | null },
  ownAllergensStatus: string | null | undefined,
): boolean {
  return listing.prepared != null && ownAllergensStatus !== "known";
}

/** Prepared items are made in parallel, so the basket waits for the longest one on top of the store's own prep. */
export function orderPrepMinutes(
  storePrepMinutes: number,
  lines: ReadonlyArray<{ prepared: string | null; prepMinutes: number | null }>,
): number {
  const longest = lines.reduce((max, line) => (line.prepared != null ? Math.max(max, line.prepMinutes ?? 0) : max), 0);
  return Math.max(0, storePrepMinutes) + longest;
}
