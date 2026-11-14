import { platform, storeScoped } from "../db";
import { pushToStoreMembers } from "./store-members";

function fulfillmentLabel(fulfillment: string): string {
  if (fulfillment === "pickup") return "Pickup";
  if (fulfillment === "store-delivery") return "Store delivery";
  return "Delivery";
}

/** One push to each current member's subscribed device for a new order. Never throws for a push failure. */
export async function sendNewOrderPush(
  storeId: string,
  orderId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const [order, store] = await Promise.all([
    storeScoped(storeId).order.findUnique({ where: { id: orderId }, select: { number: true, fulfillment: true } }),
    platform.store.findUnique({ where: { id: storeId }, select: { slug: true } }),
  ]);
  if (!order || !store) return;

  await pushToStoreMembers(storeId, {
    title: "New order",
    body: `Order #${order.number} · ${fulfillmentLabel(order.fulfillment)}`,
    url: `/store-admin/orders?store=${encodeURIComponent(store.slug)}`,
    tag: "new-order",
  }, env);
}
