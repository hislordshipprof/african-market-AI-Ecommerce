import { formatListDate, money } from "../format";
import { orderStatusLabel } from "../order/status-labels";

export const ACCOUNT_ORDER_LIMIT = 50;

export type AccountOrderRecord = {
  id: string;
  number: number;
  status: string;
  fulfillment: string;
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

export function accountOrderRow(order: AccountOrderRecord, timeZone: string, now: Date = new Date()): AccountOrderRow {
  return {
    id: order.id,
    number: order.number,
    href: `/order/${encodeURIComponent(order.trackingToken ?? order.id)}`,
    dateLabel: formatListDate(order.createdAt, timeZone, now),
    itemsLabel: `${order.itemCount} ${order.itemCount === 1 ? "item" : "items"}`,
    statusLabel: orderStatusLabel(order.status, order.fulfillment),
    amountLabel: amountLabel(order),
  };
}

const BANK_DELAY = "Banks usually take 5 to 10 business days to show it.";

/**
 * What a cancelled or refunded order tells the customer at the top of tracking (#736); null while it is live.
 * refundedCents is the sum of refunds Stripe reports succeeded. Same rules as amountLabel: a pending or failed
 * refund never reads as refunded.
 */
export function orderOutcomeMessage(
  order: { status: string; refundId: string | null; capturedAmountCents: number | null },
  refundedCents: number,
): string | null {
  const refunded = refundedCents > 0 ? money(refundedCents) : null;
  switch (order.status) {
    case "CANCELLED":
      if (refunded) return `We refunded ${refunded} to your card. ${BANK_DELAY}`;
      if (order.capturedAmountCents == null && !order.refundId) return "You were not charged, and your card hold was released.";
      return `Your payment has been refunded. ${BANK_DELAY}`;
    case "REFUNDED":
      return refunded ? `We refunded ${refunded} to your card. ${BANK_DELAY}` : `Your payment has been refunded. ${BANK_DELAY}`;
    case "PARTIALLY_REFUNDED":
      return refunded
        ? `We refunded ${refunded} of this order to your card. ${BANK_DELAY}`
        : `Part of this order has been refunded to your card. ${BANK_DELAY}`;
    case "CANCELLING":
      return "The store is cancelling this order. This page shows what happens to your payment once it is done.";
    case "REFUND_FAILED":
      return "Your refund has not gone through yet. The store and our team have been alerted and will sort it out.";
    default:
      return null;
  }
}
