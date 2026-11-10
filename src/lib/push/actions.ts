"use server";

import { requireStoreMember } from "../store-admin/session";
import { parseInput } from "../security/parse-input";
import {
  pushEndpointSchema,
  pushSubscriptionSchema,
  removePushSubscription,
  savePushSubscription,
} from "./subscriptions";

const INVALID = "Invalid push subscription";

/** Order alerts on this device. The store comes from the session, never from the input. */
export async function subscribePushAction(input: unknown) {
  const session = await requireStoreMember();
  const parsed = parseInput(pushSubscriptionSchema, input);
  if (!parsed.ok) return { ok: false as const, error: INVALID };
  await savePushSubscription(session.store.id, session.user.id, parsed.data);
  return { ok: true as const };
}

export async function unsubscribePushAction(endpoint: unknown) {
  const session = await requireStoreMember();
  const parsed = parseInput(pushEndpointSchema, endpoint);
  if (!parsed.ok) return { ok: false as const, error: INVALID };
  await removePushSubscription(session.store.id, parsed.data);
  return { ok: true as const };
}
