import { findOrderByShippingLabel, storeScopedTransaction } from "../db";
import { recordOrderNotification, type OrderNotifyEvent } from "../notifications/record";
import { scheduleOrderNotification } from "../inngest/notify";
import type { TrackingEvent } from "./shippo";

/** Shipped order statuses, forward only (ADR-0023): Ready buys the label; the carrier's scans do the rest. */
const PROGRESS = ["READY", "SHIPPED", "IN_TRANSIT", "DELIVERED"] as const;
type ShipStatus = (typeof PROGRESS)[number];

const NOTIFY: Record<Exclude<ShipStatus, "READY">, OrderNotifyEvent> = { SHIPPED: "shipped", IN_TRANSIT: "in_transit", DELIVERED: "delivered" };

export type TrackingResult = "unknown_label" | "duplicate" | "recorded";

/**
 * Applies one verified Shippo `track_updated` event. The first carrier scan (TRANSIT) ships the order, a later
 * TRANSIT scan puts it in transit, DELIVERED delivers it. PRE_TRANSIT (label made, not scanned), RETURNED, FAILURE
 * and UNKNOWN are recorded and never move the order. The status's object id makes a retried event a no-op, and a
 * status never moves back, so each step sends one notification.
 */
export async function applyTrackingWebhook(event: TrackingEvent): Promise<TrackingResult> {
  const found = await findOrderByShippingLabel(event.labelId);
  if (!found) {
    console.warn(JSON.stringify({ event: "shipping_webhook_unknown_label", labelId: event.labelId, eventId: event.eventId }));
    return "unknown_label";
  }
  const { storeId, orderId } = found;
  const outcome = await storeScopedTransaction(storeId, async (tx) => {
    const inserted = await tx.deliveryEvent.createMany({
      data: [{ storeId, orderId, deliveryId: null, externalEventId: event.eventId, type: `shipping_${event.status.toLowerCase()}`, payload: event.payload as object }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return { result: "duplicate" as const, notify: null };

    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    const at = PROGRESS.indexOf(order.status as ShipStatus);
    let target: Exclude<ShipStatus, "READY"> | null = null;
    if (event.status === "TRANSIT") target = order.status === "READY" ? "SHIPPED" : order.status === "SHIPPED" ? "IN_TRANSIT" : null;
    if (event.status === "DELIVERED") target = "DELIVERED";
    if (event.status === "RETURNED" || event.status === "FAILURE") {
      console.error(JSON.stringify({ event: "shipping_parcel_problem", storeId, orderId, status: event.status }));
    }
    if (!target || at < 0 || PROGRESS.indexOf(target) <= at) return { result: "recorded" as const, notify: null };

    const now = new Date();
    const { count } = await tx.order.updateMany({
      where: { id: orderId, fulfillment: "ship", status: { in: PROGRESS.slice(0, PROGRESS.indexOf(target)) as unknown as string[] } },
      data: {
        status: target,
        ...(target !== "IN_TRANSIT" && order.status === "READY" && { shippedAt: now }),
        ...(target === "DELIVERED" && { deliveredAt: now, completedAt: now }),
      },
    });
    const notify = count === 1 && (await recordOrderNotification(tx, storeId, orderId, NOTIFY[target])) ? NOTIFY[target] : null;
    return { result: "recorded" as const, notify };
  });
  if (outcome.notify) scheduleOrderNotification(storeId, orderId, outcome.notify);
  return outcome.result;
}
