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
  capturedAmountCents: number | null;
  refundId: string | null;
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
  CANCELLING: "Cancelling",
  CAPTURING: "Finalizing your total",
  READY: "Packed and ready",
  AWAITING_PICKUP: "Ready for pickup",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  REFUND_FAILED: "Refund in progress",
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
  if (order.refundId && order.status === "CANCELLING") return "Refund pending";
  // CAPTURING writes the amount before Stripe confirms it, so it is not a charge yet.
  if (order.capturedAmountCents != null && order.status === "CAPTURING") {
    return `Estimated ${money(order.capturedAmountCents)}`;
  }
  if (order.capturedAmountCents != null) return money(order.capturedAmountCents);
  if (order.status === "CANCELLED" || order.status === "CANCELLING") return "Not charged";
  if (order.status === "REFUND_FAILED") return "Refund pending";
  return `Estimated ${money(order.subtotalCents + order.tipCents + order.deliveryFeeCents)}`;
}

function dateLabel(createdAt: Date, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(createdAt);
  } catch {
    // `stores.timezone` is free text. A bad value must not take down the account page.
    return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "America/New_York" }).format(createdAt);
  }
}

export function accountOrderRow(order: AccountOrderRecord, timeZone: string): AccountOrderRow {
  return {
    id: order.id,
    number: order.number,
    href: `/order/${encodeURIComponent(order.id)}`,
    dateLabel: dateLabel(order.createdAt, timeZone),
    itemsLabel: `${order.itemCount} ${order.itemCount === 1 ? "item" : "items"}`,
    statusLabel: customerStatusLabel(order.status),
    amountLabel: amountLabel(order),
  };
}
