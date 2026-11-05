export interface StockFacts {
  confidence: number;
  stockMode: string;
  qty: number | null;
  status: string | null;
}

/** Spec §8.1: confidence of 0.6 counts as in stock. A hard zero does not. */
export function mayBeUnavailable(facts: StockFacts): boolean {
  const hardZero =
    (facts.stockMode === "counted" && facts.qty === 0) ||
    (facts.stockMode === "status" && facts.status === "out_of_stock");
  return facts.confidence < 0.6 || hardZero;
}
