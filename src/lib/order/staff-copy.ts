import { FULFILLMENT_LABELS } from "./status-labels";
import { formatClockInZone, formatListDate } from "../format";
import { formatDeliveryAddress } from "./delivery-address";
import { orderMoney, type OrderMoneyInput } from "./receipt";
import { CARD_FEE_LABEL, capturedPayout, courierFeeCents, platformTaxCents, refundFeeReturns, type RefundFeeFacts } from "./platform-fee";

export const STAFF_GENERIC_ERROR =
  "Something went wrong. Try again, or contact support if it keeps happening.";

/** A provider or database error message for the log, with email addresses and phone numbers removed. */
export function redactedErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "unknown failure";
  return raw
    .replace(/[^\s<>"]+@[^\s<>"]+/g, "[redacted]")
    .replace(/\+?\d[\d\s().-]{8,}\d/g, "[redacted]");
}

export const REFUND_FAILED_STAFF_COPY =
  "The platform team is resolving this refund. Do not refund the customer yourself.";

const CAPTURED_LINE_STATUSES = new Set([
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
  "REFUND_FAILED",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);

export function showCapturedLine(status: string, capturedAmountCents: number | null): boolean {
  return (
    capturedAmountCents != null &&
    capturedAmountCents > 0 &&
    CAPTURED_LINE_STATUSES.has(status)
  );
}

const FULFILLMENT_FEE_LABELS: Record<string, string> = {
  "store-delivery": "Delivery fee",
  courier: "Courier fee",
  ship: "Shipping",
};

/**
 * The store's money lines for an order and the total they add up to, from the same source as the
 * customer's receipt (`orderMoney`). Capture writes the captured amount with the rewritten fees, so
 * from then on the total is what was captured; before it, an answered short gives the expected total.
 */
export function storeOrderBreakdown(order: OrderMoneyInput & {
  fulfillment: string;
  coupon: { code: string; kind: string; percentOff: number | null; amountOffCents: number | null } | null;
  taxCents: number;
  capturedAmountCents: number | null;
}): { lines: { key: string; label: string; cents: number }[]; total: { label: "Total" | "Expected total"; cents: number } } {
  const captured = order.capturedAmountCents != null && order.capturedAmountCents > 0;
  const money = orderMoney(order, captured);
  const lines = [
    { key: "subtotal", label: "Subtotal", cents: money.goodsCents },
    { key: "discount", label: `Promo discount${order.coupon ? ` ${order.coupon.code}` : ""} (your store funds it)`, cents: -money.discountCents },
    { key: "service-fee", label: "Service fee (platform)", cents: money.serviceFeeCents },
    { key: "delivery", label: FULFILLMENT_FEE_LABELS[order.fulfillment] ?? "Delivery fee", cents: order.deliveryFeeCents },
    { key: "tax", label: "Tax", cents: order.taxCents },
    { key: "tip", label: "Tip", cents: order.tipCents },
  ].filter((line) => line.key === "subtotal" || line.cents !== 0);
  const cents = captured ? order.capturedAmountCents! : lines.reduce((sum, line) => sum + line.cents, 0);
  return { lines, total: { label: money.expected ? "Expected total" : "Total", cents } };
}

type ScheduledOrder = { fulfillment: string; pickupSlot: string | null };

type FulfillmentOrder = ScheduledOrder & {
  deliveryLine1: string | null;
  deliveryLine2: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryZip: string | null;
  leaveAtDoor: boolean;
  shippingCarrier: string | null;
  shippingService: string | null;
};

/** A booked slot's start, "Today 7:30 PM CST"; null for ASAP or no slot. */
function dueLabel(slot: string | null, timeZone: string, now: Date): string | null {
  if (!slot || Number.isNaN(Date.parse(slot))) return null;
  return `${formatListDate(slot, timeZone, now)} ${formatClockInZone(slot, timeZone)}`;
}

/** The card's fulfilment and, when scheduled, its due time (#751): "Pickup Today 7:30 PM CST". */
export function fulfillmentHeadline(order: ScheduledOrder, timeZone: string, now: Date = new Date()): string {
  const due = dueLabel(order.pickupSlot, timeZone, now);
  const kind = FULFILLMENT_LABELS[order.fulfillment] ?? order.fulfillment;
  return due ? `${kind} ${due}` : kind;
}

/**
 * How the order leaves the store, so the owner can decide before accepting (#742): the text before the address,
 * the address (null when there is none to link) and the text after it.
 */
export function fulfillmentLine(
  order: FulfillmentOrder,
  timeZone: string,
  now: Date = new Date(),
): { before: string; address: string | null; after: string } {
  const headline = fulfillmentHeadline(order, timeZone, now);
  if (order.fulfillment === "pickup") {
    return { before: dueLabel(order.pickupSlot, timeZone, now) ? headline : "Pickup at the store", address: null, after: "" };
  }
  if (order.fulfillment === "courier") {
    const area = formatDeliveryAddress({ ...order, deliveryLine1: null, deliveryLine2: null }) || null;
    return { before: area ? `${headline} to ` : headline, address: area, after: "" };
  }
  const address = formatDeliveryAddress(order) || null;
  if (order.fulfillment === "store-delivery") {
    const door = order.leaveAtDoor ? " · Leave at door" : "";
    return address ? { before: `${headline} to `, address, after: door } : { before: `${headline} · address missing`, address: null, after: door };
  }
  const carrier = [order.shippingCarrier, order.shippingService].filter(Boolean).join(" ");
  const kind = `${headline}${carrier ? ` · ${carrier}` : ""}`;
  return { before: address ? `${kind} to ` : kind, address, after: "" };
}

/** A succeeded refund as the inbox loads it; fee_refund_id is set once a courier refund's fee share is returned. */
type StoredRefund = Omit<RefundFeeFacts, "feeShareReturned"> & { feeRefundId: string | null };

type PayoutOrder = Parameters<typeof capturedPayout>[0] & { refundRequests?: StoredRefund[] };

/**
 * The store's payout on a captured order as lines that add up (#751): the capture less the card fee, the platform
 * service fee, a courier fee or postage passed through and tax the platform remits, then refunds and the platform
 * fee Stripe returns with them (#757), as the sales CSV counts them. The last line is the payout.
 */
export function storePayoutLines(order: PayoutOrder): { key: string; label: string; cents: number }[] {
  const split = capturedPayout(order);
  const returns = refundFeeReturns(
    { capturedCents: order.capturedAmountCents, applicationFeeCents: order.capturedAmountCents - split.storeReceivesCents },
    (order.refundRequests ?? []).map(({ feeRefundId, ...refund }) => ({ ...refund, feeShareReturned: feeRefundId !== null })),
  );
  const refundsCents = returns.reduce((sum, { refund }) => sum + refund.amountCents, 0);
  const feeReturnedCents = returns.reduce((sum, { feeCents }) => sum + feeCents, 0);
  const lines = [
    { key: "captured", label: "Captured", cents: order.capturedAmountCents },
    { key: "card-fee", label: `Card fee on your part (${CARD_FEE_LABEL})`, cents: -split.storeCardFeeCents },
    { key: "service-fee", label: "Service fee (platform)", cents: -order.serviceFeeCents },
    { key: "courier-fee", label: order.fulfillment === "ship" ? "Postage (paid for the label)" : "Courier fee (paid to the courier)", cents: -courierFeeCents(order) },
    { key: "tax", label: "Tax (the platform pays it to the state)", cents: -platformTaxCents(order) },
    { key: "refunds", label: "Refunds", cents: -refundsCents },
    { key: "fee-returned", label: "Fees returned on refunds", cents: feeReturnedCents },
  ];
  return [
    ...lines.filter((line) => line.key === "captured" || line.cents !== 0),
    { key: "payout", label: "Your payout", cents: split.storeReceivesCents - refundsCents + feeReturnedCents },
  ];
}

export type StaffCourier = { provider: string; status: string; pickupReadyAt: Date | string | null; courierJson: unknown };

const COURIER_BRAND: Record<string, string> = { uber: "Uber Direct", doordash: "DoorDash Drive" };

/** Where the store's courier is (#562): booked for the ready time, a driver on the way with an ETA, or collected. */
export function courierLine(courier: StaffCourier | null, time: (value: Date | string) => string): string | null {
  if (!courier) return null;
  const brand = COURIER_BRAND[courier.provider] ?? "Courier";
  const driver = (courier.courierJson ?? {}) as { name?: string | null; pickupEta?: string | null };
  if (courier.status === "requested") {
    return courier.pickupReadyAt ? `${brand} booked for ${time(courier.pickupReadyAt)}, finding a courier` : `${brand}: finding a courier`;
  }
  if (courier.status === "courier_assigned") {
    const who = driver.name ? `Courier ${driver.name}` : "Courier";
    return driver.pickupEta ? `${who} arriving about ${time(driver.pickupEta)}` : `${who} on the way`;
  }
  if (courier.status === "picked_up") return `${brand}: picked up`;
  if (courier.status === "delivered") return `${brand}: delivered`;
  return null;
}
