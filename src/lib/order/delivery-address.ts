import { weeklyHours } from "./store-hours";

export type DeliveryAddress = {
  deliveryLine1: string | null;
  deliveryLine2: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryZip: string | null;
};

/** "12 Main St, Apt 4, Houston, TX 77001", from the address stored on the order. */
export function formatDeliveryAddress(order: DeliveryAddress): string {
  const region = [order.deliveryState, order.deliveryZip].filter(Boolean).join(" ");
  return [order.deliveryLine1, order.deliveryLine2, order.deliveryCity, region].filter(Boolean).join(", ");
}

/** Where a delivered or shipped order is going (#753); null for pickup or when no address was stored. */
export function deliveryDestination(order: DeliveryAddress & { fulfillment: string }): { label: string; address: string } | null {
  if (order.fulfillment === "pickup" || !order.deliveryLine1) return null;
  return { label: order.fulfillment === "ship" ? "Shipping to" : "Delivering to", address: formatDeliveryAddress(order) };
}

export type StoreContactFields = {
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  hours: unknown;
};

/** Where the store is, its phone and its week (#783): the storefront footer, a pickup order's page and its email. */
export function storeContact(store: StoreContactFields): { address: string | null; phone: string | null; hours: { day: string; text: string }[] } {
  const address = formatDeliveryAddress({
    deliveryLine1: store.addressLine1,
    deliveryLine2: store.addressLine2,
    deliveryCity: store.city,
    deliveryState: store.state,
    deliveryZip: store.zip,
  });
  return { address: store.addressLine1 ? address : null, phone: store.phone?.trim() || null, hours: weeklyHours(store.hours) };
}
