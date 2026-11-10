import type { CheckoutQuote, Fulfillment } from "../customer-flow/contracts";
import { money } from "../format";

export interface SummaryLine {
  key: string;
  label: string;
  cents: number;
}

export interface OrderSummaryView {
  lines: SummaryLine[];
  totalCents: number;
  bufferCents: number;
  holdCents: number;
}

/** The money lines the basket and checkout both show, read only from the server quote. */
export function orderSummary(quote: CheckoutQuote, fulfillment: Fulfillment): OrderSummaryView {
  const lines: SummaryLine[] = [{ key: "subtotal", label: "Subtotal", cents: quote.subtotalCents }];
  if (fulfillment === "store-delivery") {
    lines.push({ key: "delivery", label: "Store delivery", cents: quote.deliveryFeeCents });
  }
  if (fulfillment === "courier") {
    lines.push({ key: "courier", label: quote.courierProvider ?? "Courier", cents: quote.courierFeeCents });
  }
  lines.push({ key: "tax", label: "Estimated tax", cents: quote.taxCents });
  if (fulfillment !== "pickup" || quote.tipCents > 0) {
    lines.push({ key: "tip", label: "Tip", cents: quote.tipCents });
  }
  if (quote.discountCents) {
    lines.push({ key: "discount", label: "Promo savings", cents: -quote.discountCents });
  }
  return {
    lines,
    totalCents: quote.totalCents,
    bufferCents: quote.bufferCents,
    holdCents: quote.holdCents,
  };
}

export function placeOrderLabel(quote: CheckoutQuote | null): string {
  return quote ? `Place order · ${money(quote.holdCents)} hold` : "Place order";
}

export type BasketQuoteResponse =
  | { key: string; outcome: "ok"; quote: CheckoutQuote }
  | { key: string; outcome: "error" | "timeout" };

/** What the basket summary shows for the latest quote answer. */
export function basketQuoteView(
  response: BasketQuoteResponse | null,
  basketKey: string,
  subtotalCents: number,
): { kind: "pending" } | { kind: "fallback" } | { kind: "quote"; quote: CheckoutQuote } {
  if (!response || response.key !== basketKey) return { kind: "pending" };
  if (response.outcome !== "ok") return { kind: "fallback" };
  // The server priced a different basket (a price changed, or the carts differ): never wait forever.
  if (response.quote.subtotalCents !== subtotalCents) return { kind: "fallback" };
  return { kind: "quote", quote: response.quote };
}
