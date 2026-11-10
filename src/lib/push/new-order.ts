import { platform, storeScoped } from "../db";
import { pushSender, PushSendError } from "./sender";

const GONE = new Set([404, 410]);
let warnedNoKeys = false;

function fulfillmentLabel(fulfillment: string): string {
  if (fulfillment === "pickup") return "Pickup";
  if (fulfillment === "store-delivery") return "Store delivery";
  return "Delivery";
}

/**
 * One push to each current member's subscribed device for a new order.
 * Never throws for a push failure; a gone subscription is deleted.
 */
export async function sendNewOrderPush(
  storeId: string,
  orderId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const sender = pushSender(env);
  if (!sender) {
    if (!warnedNoKeys) {
      warnedNoKeys = true;
      console.warn(JSON.stringify({ event: "push_skipped_no_vapid_keys" }));
    }
    return;
  }

  const scoped = storeScoped(storeId);
  const [order, store, subscriptions] = await Promise.all([
    scoped.order.findUnique({ where: { id: orderId }, select: { number: true, fulfillment: true } }),
    platform.store.findUnique({ where: { id: storeId }, select: { slug: true } }),
    scoped.pushSubscription.findMany(),
  ]);
  if (!order || !store || subscriptions.length === 0) return;

  const members = await scoped.storeMembership.findMany({
    where: { userId: { in: [...new Set(subscriptions.map((s) => s.userId))] } },
    select: { userId: true },
  });
  const memberIds = new Set(members.map((m) => m.userId));

  const message = {
    title: "New order",
    body: `Order #${order.number} · ${fulfillmentLabel(order.fulfillment)}`,
    url: `/store-admin/orders?store=${encodeURIComponent(store.slug)}`,
  };

  for (const subscription of subscriptions) {
    if (!memberIds.has(subscription.userId)) continue;
    try {
      await sender.send(subscription, message);
    } catch (err) {
      const status = err instanceof PushSendError ? err.status : 0;
      if (GONE.has(status)) {
        await scoped.pushSubscription.deleteMany({ where: { id: subscription.id } });
        continue;
      }
      console.error(JSON.stringify({ event: "push_send_failed", storeId, orderId, subscriptionId: subscription.id, status }));
    }
  }
}
