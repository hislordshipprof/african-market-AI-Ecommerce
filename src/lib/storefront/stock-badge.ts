export type StockBadge = "in-stock" | "limited" | "ask-store";

export interface StockBadgeInput {
  confidence: number;
  stockMode: string;
  qty: number | null;
  status: string | null;
}

export function stockBadge(input: StockBadgeInput): StockBadge {
  const hardZero =
    (input.stockMode === "counted" && input.qty === 0) ||
    (input.stockMode === "status" && input.status === "out_of_stock");

  if (hardZero || input.confidence < 0.3) return "ask-store";
  if (input.confidence < 0.6) return "limited";
  return "in-stock";
}
