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
