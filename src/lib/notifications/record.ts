import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { NOTIFICATION_CHANNEL_KINDS } from "./channel-kinds";

export const ORDER_NOTIFY_EVENTS = [
  "placed",
  "accepted",
  "ready",
  "out_for_delivery",
  "delivered",
  "completed",
  "cancelled",
  "store_replied",
] as const;
export type OrderNotifyEvent = (typeof ORDER_NOTIFY_EVENTS)[number];

export function isOrderNotifyEvent(value: string): value is OrderNotifyEvent {
  return (ORDER_NOTIFY_EVENTS as readonly string[]).includes(value);
}

/** 32 random bytes, base64url, 43 characters. Never regenerated once written. */
export function newTrackingToken(): string {
  return randomBytes(32).toString("base64url");
}

type TokenTx = {
  order: {
    updateMany: (args: Prisma.OrderUpdateManyArgs) => Promise<{ count: number }>;
  };
  notificationLog: {
    createMany: (args: Prisma.NotificationLogCreateManyArgs) => Promise<{ count: number }>;
  };
};

/**
 * Inserts one pending row per channel kind. A second insert for the same
 * order, event and channel is a no-op, including Cancelled then Refund failed
 * then Cancelled again. Returns whether any row was inserted.
 */
export async function recordOrderNotification(
  tx: TokenTx,
  storeId: string,
  orderId: string,
  event: OrderNotifyEvent,
): Promise<boolean> {
  await tx.order.updateMany({
    where: { id: orderId, trackingToken: null },
    data: { trackingToken: newTrackingToken() },
  });
  const inserted = await tx.notificationLog.createMany({
    data: NOTIFICATION_CHANNEL_KINDS.map((channel) => ({
      storeId,
      orderId,
      event,
      channel,
      status: "pending",
    })),
    skipDuplicates: true,
  });
  return inserted.count > 0;
}
