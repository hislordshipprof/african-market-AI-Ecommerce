import { formatInZone } from "../format";
import type { OrderStatus } from "../order/service";

export const ACCOUNT_ORDER_LIMIT = 50;

export type AccountOrderRecord = {
  id: string;
  number: number;
  status: string;
  createdAt: Date;
  subtotalCents: number;
  tipCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  capturedAmountCents: number | null;
  refundId: string | null;
  trackingToken: string | null;
  itemCount: number;
};

/** What the account page shows for one order. Plain strings, so server and client render the same text. */
export type AccountOrderRow = {
  id: string;
  number: number;
  href: string;
  dateLabel: string;
  itemsLabel: string;
  statusLabel: string;
  amountLabel: string;
};

const CUSTOMER_STATUS_LABELS: Record<OrderStatus, string> = {
  AUTHORIZED: "Order placed",
  ACCEPTED: "Store accepted",
  PICKING: "Shopping your order",
  SUBSTITUTION_PENDING: "Waiting for your answer",
  CANCELLING: "Cancelling",
  CAPTURING: "Finalizing your total",
  READY: "Packed and ready",
  AWAITING_PICKUP: "Ready for pickup",
  COURIER_REQUESTED: "Finding a courier",
  COURIER_ASSIGNED: "Courier on the way to the store",
  PICKED_UP: "Courier on the way to you",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  REFUND_FAILED: "Refund in progress",
  PARTIALLY_REFUNDED: "Partly refunded",
  REFUNDED: "Refunded",
};

/** `orders.status` is a free string with no database check, so an unknown value still gets a label. */
export function customerStatusLabel(status: string): string {
  return CUSTOMER_STATUS_LABELS[status as OrderStatus] ?? "In progress";
}

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/**
 * Never the hold: an amount that is not captured yet reads as an estimate, not a charge.
 * refundId alone does not mean refunded: the order service also writes it on a failed refund
 * (REFUND_FAILED, still charged) and a pending one (CANCELLING). Only CANCELLED has settled.
 * REFUND_FAILED can have no capture when the provider reports nothing received.
 */
function amountLabel(order: AccountOrderRecord): string {
  if (order.refundId && order.status === "CANCELLED") return "Refunded";
  if (order.status === "REFUNDED") return "Refunded";
  if (order.refundId && order.status === "CANCELLING") return "Refund pending";
  // CAPTURING writes the amount before Stripe confirms it, so it is not a charge yet.
  if (order.capturedAmountCents != null && order.status === "CAPTURING") {
    return `Estimated ${money(order.capturedAmountCents)}`;
  }
  if (order.capturedAmountCents != null) return money(order.capturedAmountCents);
  if (order.status === "CANCELLED" || order.status === "CANCELLING") return "Not charged";
  if (order.status === "REFUND_FAILED") return "Refund pending";
  return `Estimated ${money(order.subtotalCents + order.serviceFeeCents + order.tipCents + order.deliveryFeeCents)}`;
}

export function accountOrderRow(order: AccountOrderRecord, timeZone: string): AccountOrderRow {
  return {
    id: order.id,
    number: order.number,
    href: `/order/${encodeURIComponent(order.trackingToken ?? order.id)}`,
    dateLabel: formatInZone(order.createdAt, timeZone, { month: "short", day: "numeric", year: "numeric" }),
    itemsLabel: `${order.itemCount} ${order.itemCount === 1 ? "item" : "items"}`,
    statusLabel: customerStatusLabel(order.status),
    amountLabel: amountLabel(order),
  };
}
