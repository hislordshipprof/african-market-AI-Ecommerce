export type StockBadge = "in-stock" | "limited" | "ask-store";

export interface StockBadgeInput {
  confidence: number;
  stockMode: string;
  qty: number | null;
  status: string | null;
}

/**
 * Owner decision 2026-11-10: one store-wide threshold for counted listings. The copilot alerts the owner
 * at it, and shoppers see "Only N left" at it (#808).
 */
export const LOW_STOCK_THRESHOLD = 5;

/** "Only 3 left" for a counted listing at or under the threshold; null otherwise. */
export function stockLeftLabel(stockLeft: number | undefined): string | null {
  return stockLeft !== undefined && stockLeft > 0 && stockLeft <= LOW_STOCK_THRESHOLD ? `Only ${stockLeft} left` : null;
}

/** Below this confidence the storefront shows "ask store" and the copilot asks the owner. */
export const ASK_STORE_BELOW = 0.3;

export function stockBadge(input: StockBadgeInput): StockBadge {
  const hardZero =
    (input.stockMode === "counted" && input.qty === 0) ||
    (input.stockMode === "status" && input.status === "out_of_stock");

  if (hardZero || input.confidence < ASK_STORE_BELOW) return "ask-store";
  if (input.confidence < 0.6) return "limited";
  return "in-stock";
}

/**
 * Whether the storefront sells a listing now: switched on, and not counted out
 * or marked out of stock. The basket page, cart lines and the drawer share it (#717 AC2).
 */
export function listingAvailable(listing: { active: boolean; stockMode: string; qty: number | null; status: string | null }): boolean {
  if (!listing.active) return false;
  if (listing.stockMode === "counted" && (listing.qty ?? 0) <= 0) return false;
  return !(listing.stockMode === "status" && listing.status === "out_of_stock");
}
