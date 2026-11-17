import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { DEFAULT_CHANNEL_KINDS, type NotificationChannelKind } from "./channel-kinds";

export const ORDER_NOTIFY_EVENTS = [
  "placed",
  "accepted",
  "ready",
  "out_for_delivery",
  "shipped",
  "in_transit",
  "delivered",
  "completed",
  "cancelled",
  "store_replied",
  "refunded",
  "substitution",
] as const;
export type OrderNotifyEvent = (typeof ORDER_NOTIFY_EVENTS)[number];

/**
 * The events an opted-in customer hears on WhatsApp instead of SMS (#560). A store reply stays on SMS, and so do the
 * parcel updates (#568) until Meta approves templates for them.
 */
export const WHATSAPP_EVENTS: ReadonlySet<OrderNotifyEvent> = new Set<OrderNotifyEvent>([
  "placed",
  "accepted",
  "ready",
  "out_for_delivery",
  "delivered",
  "completed",
  "cancelled",
  "refunded",
  "substitution",
]);

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
    findUnique: (args: {
      where: { id: string };
      select: { whatsappOptInAt: true };
    }) => Promise<{ whatsappOptInAt: Date | null } | null>;
  };
  notificationLog: {
    createMany: (args: Prisma.NotificationLogCreateManyArgs) => Promise<{ count: number }>;
    updateMany: (args: Prisma.NotificationLogUpdateManyArgs) => Promise<{ count: number }>;
  };
};

/**
 * Inserts one pending row per default channel kind, plus a whatsapp row when
 * the customer opted in at checkout and the event goes to WhatsApp. A second insert for the same
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
  const order = WHATSAPP_EVENTS.has(event)
    ? await tx.order.findUnique({ where: { id: orderId }, select: { whatsappOptInAt: true } })
    : null;
  const channels: NotificationChannelKind[] = [...DEFAULT_CHANNEL_KINDS];
  if (order?.whatsappOptInAt) channels.push("whatsapp");
  const inserted = await tx.notificationLog.createMany({
    data: channels.map((channel) => ({
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

/**
 * A substitution prompt can come more than once on one order (#13). A new round re-opens a
 * finished row so the customer hears about it; a row still pending or sending already will.
 */
export async function recordSubstitutionPrompt(tx: TokenTx, storeId: string, orderId: string): Promise<boolean> {
  if (await recordOrderNotification(tx, storeId, orderId, "substitution")) return true;
  const reopened = await tx.notificationLog.updateMany({
    where: { orderId, event: "substitution", status: { notIn: ["pending", "sending"] } },
    data: { status: "pending", reason: null, attempts: 0, createdAt: new Date() },
  });
  return reopened.count > 0;
}
