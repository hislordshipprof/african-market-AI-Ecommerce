export type StockBadge = "in-stock" | "limited" | "ask-store";

export interface StockBadgeInput {
  confidence: number;
  stockMode: string;
  qty: number | null;
  status: string | null;
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
