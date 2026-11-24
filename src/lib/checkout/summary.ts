import type { CheckoutQuote, FlowStore, Fulfillment } from "../customer-flow/contracts";
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
  if (quote.discountCents) {
    const label = quote.coupon ? `Promo ${quote.coupon.code}` : "Promo savings";
    lines.push({ key: "discount", label, cents: -quote.discountCents });
  }
  if (quote.serviceFeeCents > 0) {
    lines.push({ key: "service-fee", label: "Service fee", cents: quote.serviceFeeCents });
  }
  if (fulfillment === "store-delivery") {
    lines.push({ key: "delivery", label: "Store delivery", cents: quote.deliveryFeeCents });
  }
  if (fulfillment === "courier") {
    lines.push({ key: "courier", label: quote.courierProvider ?? "Courier", cents: quote.courierFeeCents });
  }
  if (fulfillment === "ship" && quote.shipping) {
    lines.push({ key: "shipping", label: `Shipping · ${quote.shipping.carrier}`, cents: quote.shipping.feeCents });
  }
  lines.push({ key: "tax", label: "Estimated tax", cents: quote.taxCents });
  if (quote.tipCents > 0) {
    lines.push({ key: "tip", label: "Tip", cents: quote.tipCents });
  }
  return {
    lines,
    totalCents: quote.totalCents,
    bufferCents: quote.bufferCents,
    holdCents: quote.holdCents,
  };
}

/** The basket's line under its estimate: only the ways this store hands over an order, at their real starting fees (#750). */
export function basketFulfilmentNote(
  store: Pick<FlowStore, "pickupEnabled" | "storeDeliveryEnabled" | "storeDeliveryFeeCents" | "courierOffered" | "shipsTo">,
): string {
  const options = [
    store.storeDeliveryEnabled
      ? store.storeDeliveryFeeCents === 0 ? "free store delivery" : `store delivery from ${money(store.storeDeliveryFeeCents)}`
      : null,
    store.courierOffered ? "courier quoted at checkout" : null,
    store.shipsTo.length > 0 ? "shipping quoted at checkout" : null,
  ].filter((option) => option !== null);
  const estimate = store.pickupEnabled ? "Estimated for pickup." : "Estimated before delivery.";
  if (!options.length) return estimate;
  const list = options.join("; ");
  return `${estimate} ${list[0].toUpperCase()}${list.slice(1)}. Final fees depend on your choice.`;
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

/**
 * What a checkout quote was asked for: the form and the basket. A quote held for an older
 * key is stale, so a basket changed in the drawer is quoted again before Pay opens (#708 P1).
 */
export function checkoutQuoteKey(input: {
  contact: unknown;
  fulfillment: Fulfillment;
  delivery: unknown;
  couponRev: number;
  lines: readonly { listingId: string; variantId?: string; quantity: number }[];
}): string {
  const basket = input.lines.map((line) => [line.listingId, line.variantId ?? null, line.quantity]);
  return JSON.stringify({ contact: input.contact, fulfillment: input.fulfillment, delivery: input.delivery, couponRev: input.couponRev, basket });
}
