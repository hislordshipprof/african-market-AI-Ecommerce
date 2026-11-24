export type OrderLineStatus =
  | "pending"
  | "picked"
  | "short"
  | "refunded"
  | "substituted";

/** The status an order takes when picked: pickup waits for the customer, delivery is ready to go. */
export function fulfilledStatus(fulfillment: string): "AWAITING_PICKUP" | "READY" {
  return fulfillment === "pickup" ? "AWAITING_PICKUP" : "READY";
}

export const RESOLVED_LINE_STATUSES: OrderLineStatus[] = ["picked", "refunded", "substituted"];

/** Uncaptured states a store or Stripe can cancel from; the inbox button and the server share it. */
export const CANCELLABLE_BEFORE_CAPTURE = ["AUTHORIZED", "ACCEPTED", "PICKING", "SUBSTITUTION_PENDING"] as const;

/** Every status after capture that still holds money to refund (#798): Ready onward, not cancelling or refunded. */
export const STORE_REFUNDABLE_FROM = [
  "READY",
  "AWAITING_PICKUP",
  "COURIER_REQUESTED",
  "COURIER_ASSIGNED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "SHIPPED",
  "IN_TRANSIT",
  "DELIVERED",
  "COMPLETED",
  "PARTIALLY_REFUNDED",
] as const;

/** Captured orders the store still holds (#798): a store cancel refunds the whole capture. A ship order uses cancelShipment. */
export const CANCELLABLE_AFTER_CAPTURE = ["READY", "AWAITING_PICKUP", "COURIER_REQUESTED", "COURIER_ASSIGNED"] as const;

/** Why a store cancels before capture. A fixed list, so the customer message and admin views can use it. */
export const STORE_CANCEL_REASONS = ["out_of_stock", "store_closed", "too_busy", "other"] as const;
export type StoreCancelReason = (typeof STORE_CANCEL_REASONS)[number];
