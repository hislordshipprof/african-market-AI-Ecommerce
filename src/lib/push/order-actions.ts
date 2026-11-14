"use server";

import { headers } from "next/headers";
import { getStore } from "../get-store";
import { parseInput } from "../security/parse-input";
import { takeRateLimit } from "../rate-limit/app-limiter";
import { clientIp } from "../assistant/client-ip";
import { pushEndpointSchema, pushSubscriptionSchema } from "./subscriptions";
import { removeOrderPushSubscription, saveOrderPushSubscription } from "./order-subscriptions";

const INVALID = "Invalid push subscription";
const NOT_FOUND = "Order not found";
const TOO_MANY = "Too many tries. Wait a while, then try again.";
const WINDOW_MS = 60 * 60 * 1000;
const TOKEN_LIMIT = 20;
const IP_LIMIT = 60;

/** Public: the tracking token is the only credential, so it is rate limited per token and per IP. */
async function limited(token: string): Promise<boolean> {
  const ip = clientIp(await headers());
  const [byToken, byIp] = await Promise.all([
    takeRateLimit(`order-push:token:${token}`, TOKEN_LIMIT, WINDOW_MS),
    takeRateLimit(`order-push:ip:${ip}`, IP_LIMIT, WINDOW_MS),
  ]);
  return !byToken.ok || !byIp.ok;
}

/** Order updates on this device. The store comes from the host, the order from the tracking token. */
export async function subscribeOrderPushAction(token: unknown, input: unknown) {
  const parsed = parseInput(pushSubscriptionSchema, input);
  if (!parsed.ok) return { ok: false as const, error: INVALID };
  if (typeof token !== "string" || !token || token.length > 128) return { ok: false as const, error: NOT_FOUND };
  if (await limited(token)) return { ok: false as const, error: TOO_MANY };
  const store = await getStore();
  const saved = await saveOrderPushSubscription(store.id, token, parsed.data);
  return saved ? { ok: true as const } : { ok: false as const, error: NOT_FOUND };
}

export async function unsubscribeOrderPushAction(token: unknown, endpoint: unknown) {
  const parsed = parseInput(pushEndpointSchema, endpoint);
  if (!parsed.ok) return { ok: false as const, error: INVALID };
  if (typeof token !== "string" || !token || token.length > 128) return { ok: false as const, error: NOT_FOUND };
  if (await limited(token)) return { ok: false as const, error: TOO_MANY };
  const store = await getStore();
  const removed = await removeOrderPushSubscription(store.id, token, parsed.data);
  return removed ? { ok: true as const } : { ok: false as const, error: NOT_FOUND };
}
