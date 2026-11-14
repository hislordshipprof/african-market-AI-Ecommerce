import { z } from "zod";
import { storeScoped } from "../db";
import { isPushServiceEndpoint, isUsablePushKeys } from "./endpoint";

/** Devices one member can have on one store. The newest 10 stay. */
const MAX_DEVICES_PER_USER = 10;

const base64url = (max: number) =>
  z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+={0,2}$/);

/** The browser's `PushSubscription.toJSON()` shape. A P-256 key is 87 characters, auth 22. */
export const pushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .max(2048)
    .url()
    .refine(isPushServiceEndpoint),
  keys: z
    .object({
      p256dh: base64url(128),
      auth: base64url(64),
    })
    .refine(isUsablePushKeys),
});

export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

export const pushEndpointSchema = z.string().min(1).max(2048);

/** One row per store and endpoint. A second subscribe moves the device to the caller; a member's oldest devices past 10 are dropped. */
export async function savePushSubscription(
  storeId: string,
  userId: string,
  input: PushSubscriptionInput,
): Promise<void> {
  const data = { userId, p256dh: input.keys.p256dh, auth: input.keys.auth };
  await storeScoped(storeId).pushSubscription.upsert({
    where: { storeId_endpoint: { storeId, endpoint: input.endpoint } },
    update: data,
    create: { storeId, endpoint: input.endpoint, ...data },
  });
  const stale = await storeScoped(storeId).pushSubscription.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    skip: MAX_DEVICES_PER_USER,
    select: { id: true },
  });
  if (stale.length > 0) {
    await storeScoped(storeId).pushSubscription.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
  }
}

export async function removePushSubscription(storeId: string, endpoint: string): Promise<void> {
  await storeScoped(storeId).pushSubscription.deleteMany({ where: { endpoint } });
}
