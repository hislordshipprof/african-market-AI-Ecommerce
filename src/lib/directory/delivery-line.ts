type Delivering = {
  storeDeliveryEnabled: boolean;
  courierMayDeliver: boolean;
  /** Known only when the shopper gave a ZIP, a city or their location (#452). */
  deliversToYou?: boolean;
};

/**
 * The card's one delivery line (#453). The store's own delivery uses its radius only; courier
 * coverage is known only from a quote at checkout (ADR-0006), so it is never more than a maybe.
 */
export function deliveryLine(store: Delivering): "Delivers to you" | "Delivery" | "Courier may be available" | null {
  if (store.deliversToYou) return "Delivers to you";
  if (store.storeDeliveryEnabled && store.deliversToYou === undefined) return "Delivery";
  if (store.courierMayDeliver) return "Courier may be available";
  return null;
}
