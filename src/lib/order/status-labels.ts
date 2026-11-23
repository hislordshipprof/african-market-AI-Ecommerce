import type { OrderStatus } from "./service";

/** One name per order state, on the store inbox, the packing screen and the customer's order page (#742). */
const ORDER_STATUS_LABELS: Record<Exclude<OrderStatus, "READY">, string> = {
  AUTHORIZED: "Order placed",
  ACCEPTED: "Accepted",
  PICKING: "Packing",
  SUBSTITUTION_PENDING: "Waiting for a swap choice",
  CAPTURING: "Finalizing the total",
  CANCELLING: "Cancelling",
  AWAITING_PICKUP: "Ready for pickup",
  COURIER_REQUESTED: "Finding a courier",
  COURIER_ASSIGNED: "Courier on the way to the store",
  PICKED_UP: "Courier has the order",
  OUT_FOR_DELIVERY: "Out for delivery",
  SHIPPED: "Shipped",
  IN_TRANSIT: "In transit",
  DELIVERED: "Delivered",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  REFUND_FAILED: "Refund in progress",
  PARTIALLY_REFUNDED: "Partly refunded",
  REFUNDED: "Refunded",
};

const READY_LABELS: Record<string, string> = {
  pickup: "Ready for pickup",
  "store-delivery": "Ready for delivery",
  courier: "Ready for courier",
  ship: "Ready to ship",
};

/** `orders.status` is a free string with no database check, so an unknown value still gets a label. */
export function orderStatusLabel(status: string, fulfillment: string): string {
  if (status === "READY") return READY_LABELS[fulfillment] ?? "Ready";
  return ORDER_STATUS_LABELS[status as Exclude<OrderStatus, "READY">] ?? "In progress";
}
