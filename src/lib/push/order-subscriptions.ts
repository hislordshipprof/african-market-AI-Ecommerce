import { storeScoped } from "../db";
import { isPushServiceEndpoint, isUsablePushKeys } from "./endpoint";
import { pushSender, PushSendError, type PushMessage } from "./sender";
import type { PushSubscriptionInput } from "./subscriptions";

/** Devices one order can have. The newest 5 stay. */
const MAX_DEVICES_PER_ORDER = 5;
const GONE = new Set([404, 410]);

/** The tracking token only, never an order id: the token is the customer's only credential (#129). */
async function orderIdForToken(storeId: string, token: string): Promise<string | null> {
  if (!token || token.length > 128) return null;
  const order = await storeScoped(storeId).order.findUnique({ where: { trackingToken: token }, select: { id: true } });
  return order?.id ?? null;
}

/** False when the token opens no order in this store. */
export async function saveOrderPushSubscription(
  storeId: string,
  token: string,
  input: PushSubscriptionInput,
): Promise<boolean> {
  const orderId = await orderIdForToken(storeId, token);
  if (!orderId) return false;
  const scoped = storeScoped(storeId);
  const keys = { p256dh: input.keys.p256dh, auth: input.keys.auth };
  await scoped.orderPushSubscription.upsert({
    where: { orderId_endpoint: { orderId, endpoint: input.endpoint } },
    update: keys,
    create: { storeId, orderId, endpoint: input.endpoint, ...keys },
  });
  const stale = await scoped.orderPushSubscription.findMany({
    where: { orderId },
    orderBy: { createdAt: "desc" },
    skip: MAX_DEVICES_PER_ORDER,
    select: { id: true },
  });
  if (stale.length > 0) {
    await scoped.orderPushSubscription.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
  }
  return true;
}

export async function removeOrderPushSubscription(storeId: string, token: string, endpoint: string): Promise<boolean> {
  const orderId = await orderIdForToken(storeId, token);
  if (!orderId) return false;
  await storeScoped(storeId).orderPushSubscription.deleteMany({ where: { orderId, endpoint } });
  return true;
}

export type OrderPushResult = { sent: number; failed: number; retryable: boolean };

/** One push to each device subscribed to this order. A gone subscription (404/410) is deleted. Never throws for a push failure. */
export async function pushToOrder(
  storeId: string,
  orderId: string,
  message: PushMessage,
  env: Record<string, string | undefined> = process.env,
): Promise<OrderPushResult> {
  const result: OrderPushResult = { sent: 0, failed: 0, retryable: false };
  const sender = pushSender(env);
  if (!sender) return result;
  const scoped = storeScoped(storeId);
  const subscriptions = await scoped.orderPushSubscription.findMany({ where: { orderId } });
  const gone: string[] = [];
  await Promise.allSettled(
    subscriptions.map(async (subscription) => {
      if (!isPushServiceEndpoint(subscription.endpoint) || !isUsablePushKeys(subscription)) {
        gone.push(subscription.id);
        return;
      }
      try {
        await sender.send(subscription, message);
        result.sent += 1;
      } catch (err) {
        const status = err instanceof PushSendError ? err.status : 0;
        if (GONE.has(status)) {
          gone.push(subscription.id);
          return;
        }
        result.failed += 1;
        if (status === 0 || status === 429 || status >= 500) result.retryable = true;
        console.error(JSON.stringify({ event: "order_push_send_failed", storeId, orderId, subscriptionId: subscription.id, status }));
      }
    }),
  );
  if (gone.length > 0) {
    await scoped.orderPushSubscription.deleteMany({ where: { id: { in: gone } } });
  }
  return result;
}
