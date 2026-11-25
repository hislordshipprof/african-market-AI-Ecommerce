import { money } from "@/lib/format";

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

/**
 * The store's own delivery fee, where the card says it delivers (#863). None for a zero or
 * unset fee, and never for a courier: its fee is only known from a quote (ADR-0006).
 */
export function deliveryFee(store: Delivering & { storeDeliveryFeeCents: number | null }): string | null {
  const line = deliveryLine(store);
  if (line !== "Delivers to you" && line !== "Delivery") return null;
  return store.storeDeliveryFeeCents ? `${money(store.storeDeliveryFeeCents)} delivery` : null;
}

type Nearby = { deliversToYou?: boolean; pickupEnabled: boolean };

/** Near me results (#863): the store's own delivery reaches the shopper, or pickup; the rest stay apart. Order is kept. */
export function splitByDelivery<T extends Nearby>(stores: readonly T[]): { door: T[]; pickup: T[]; other: T[] } {
  return {
    door: stores.filter((store) => store.deliversToYou),
    pickup: stores.filter((store) => !store.deliversToYou && store.pickupEnabled),
    other: stores.filter((store) => !store.deliversToYou && !store.pickupEnabled),
  };
}
