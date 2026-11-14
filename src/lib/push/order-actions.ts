"use server";

import { getStore } from "../get-store";
import { parseInput } from "../security/parse-input";
import { pushEndpointSchema, pushSubscriptionSchema } from "./subscriptions";
import { removeOrderPushSubscription, saveOrderPushSubscription } from "./order-subscriptions";

const INVALID = "Invalid push subscription";
const NOT_FOUND = "Order not found";

/** Order updates on this device. The store comes from the host, the order from the tracking token. */
export async function subscribeOrderPushAction(token: unknown, input: unknown) {
  const store = await getStore();
  const parsed = parseInput(pushSubscriptionSchema, input);
  if (!parsed.ok) return { ok: false as const, error: INVALID };
  if (typeof token !== "string") return { ok: false as const, error: NOT_FOUND };
  const saved = await saveOrderPushSubscription(store.id, token, parsed.data);
  return saved ? { ok: true as const } : { ok: false as const, error: NOT_FOUND };
}

export async function unsubscribeOrderPushAction(token: unknown, endpoint: unknown) {
  const store = await getStore();
  const parsed = parseInput(pushEndpointSchema, endpoint);
  if (!parsed.ok) return { ok: false as const, error: INVALID };
  if (typeof token !== "string") return { ok: false as const, error: NOT_FOUND };
  const removed = await removeOrderPushSubscription(store.id, token, parsed.data);
  return removed ? { ok: true as const } : { ok: false as const, error: NOT_FOUND };
}
