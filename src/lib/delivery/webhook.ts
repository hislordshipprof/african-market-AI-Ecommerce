import { findDeliveryByExternalId, storeScopedTransaction } from "../db";
import { recordOrderNotification } from "../notifications/record";
import { scheduleOrderNotification } from "../inngest/notify";
import { emitCourierEvent } from "./courier-functions";
import { COURIER_PROOF_RECEIVED } from "./dispatch";
import type { CourierEventType, DeliveryWebhookEvent } from "./provider";

/** Delivery statuses a webhook moves forward only; the courier_assigned step is what stops the failover timer (#140). */
const COURIER_PROGRESS = ["requested", "courier_assigned", "picked_up", "delivered"] as const;

/** Courier order statuses, forward only (spec §9). Dispatch moves READY to COURIER_REQUESTED; webhooks do the rest. */
const ORDER_PROGRESS = ["READY", "COURIER_REQUESTED", "COURIER_ASSIGNED", "PICKED_UP", "DELIVERED"] as const;
const ORDER_STATUS: Partial<Record<CourierEventType, (typeof ORDER_PROGRESS)[number]>> = {
  courier_assigned: "COURIER_ASSIGNED",
  picked_up: "PICKED_UP",
  delivered: "DELIVERED",
};

export type CourierWebhookResult = "unknown_delivery" | "not_recorded" | "duplicate" | "recorded";

/**
 * Applies one verified courier webhook event. The event row, the delivery and the order change in one transaction;
 * the provider's event id makes a retried event a no-op. A cancelled delivery (failover replaced it) still records
 * its events but never moves the order.
 */
export async function applyCourierWebhook(event: DeliveryWebhookEvent): Promise<CourierWebhookResult> {
  const found = await findDeliveryByExternalId(event.provider, event.externalDeliveryId);
  if (!found) {
    console.warn(JSON.stringify({ event: "courier_webhook_unknown_delivery", provider: event.provider, externalDeliveryId: event.externalDeliveryId, externalEventId: event.externalEventId }));
    return "unknown_delivery";
  }
  if (!event.type) return "not_recorded";
  const type = event.type;
  const { storeId, orderId } = found;

  const outcome = await storeScopedTransaction(storeId, async (tx) => {
    const inserted = await tx.deliveryEvent.createMany({
      data: [{ storeId, orderId, deliveryId: found.id, externalEventId: event.externalEventId, type, payload: event.payload as object }],
      skipDuplicates: true,
    });
    if (inserted.count === 0) return { result: "duplicate" as const, notify: false, proof: false };

    const delivery = await tx.delivery.findUniqueOrThrow({ where: { id: found.id }, select: { status: true, pin: true } });
    const live = delivery.status !== "cancelled";
    const step = COURIER_PROGRESS.indexOf(type as (typeof COURIER_PROGRESS)[number]);
    if (step > 0) {
      await tx.delivery.updateMany({
        where: { id: found.id, status: { in: COURIER_PROGRESS.slice(0, step) } },
        data: { status: type },
      });
    }
    if (type === "returned" && live) {
      await tx.delivery.update({ where: { id: found.id }, data: { status: "returned" } });
      // The order stays where it was: the goods are back at the store, which decides what happens next.
      console.error(JSON.stringify({ event: "courier_returned_to_store", storeId, orderId, deliveryId: found.id, provider: event.provider }));
    }
    const photoUrl = type === "delivered" ? httpsUrl(event.proof.photoUrl) : null;
    await tx.delivery.update({
      where: { id: found.id },
      data: {
        ...(event.courier && { courierJson: { ...event.courier, dropoffEta: event.courier.dropoffEta?.toISOString() ?? null } }),
        ...(event.trackingUrl && { trackingUrl: event.trackingUrl }),
        ...(event.actualFeeCents !== null && { actualFeeCents: event.actualFeeCents }),
        ...(photoUrl && { proofUrl: photoUrl }),
      },
    });

    let target = live ? ORDER_STATUS[type] : undefined;
    // The provider makes the courier enter the PIN; one it reports that differs from ours keeps the order open.
    if (target === "DELIVERED" && delivery.pin && event.proof.pinEntered !== null && event.proof.pinEntered !== delivery.pin) {
      console.error(JSON.stringify({ event: "courier_pin_mismatch", storeId, orderId, deliveryId: found.id, provider: event.provider }));
      target = undefined;
    }
    let notify = false;
    if (target) {
      const now = new Date();
      const { count } = await tx.order.updateMany({
        where: { id: orderId, fulfillment: "courier", status: { in: ORDER_PROGRESS.slice(0, ORDER_PROGRESS.indexOf(target)) } },
        data: { status: target, ...(target === "DELIVERED" && { deliveredAt: now, completedAt: now }) },
      });
      if (count === 1 && target === "DELIVERED") notify = await recordOrderNotification(tx, storeId, orderId, "delivered");
    }
    return { result: "recorded" as const, notify, proof: photoUrl !== null && live };
  });

  if (outcome.notify) scheduleOrderNotification(storeId, orderId, "delivered");
  // A lost send is logged; the provider's photo URL stays on the delivery.
  if (outcome.proof) await emitCourierEvent({ name: COURIER_PROOF_RECEIVED, data: { storeId, deliveryId: found.id } });
  return outcome.result;
}

function httpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}
