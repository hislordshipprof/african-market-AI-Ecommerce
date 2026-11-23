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

/** The store's money lines for an order, read from the amounts stored on it; they add up to its total. */
export function storeOrderBreakdown(order: {
  fulfillment: string;
  subtotalCents: number;
  discountCents: number;
  coupon: { code: string } | null;
  serviceFeeCents: number;
  deliveryFeeCents: number;
  taxCents: number;
  tipCents: number;
}): { key: string; label: string; cents: number }[] {
  const lines = [
    { key: "subtotal", label: "Subtotal", cents: order.subtotalCents },
    { key: "discount", label: `Promo discount${order.coupon ? ` ${order.coupon.code}` : ""} (your store funds it)`, cents: -order.discountCents },
    { key: "service-fee", label: "Service fee (platform)", cents: order.serviceFeeCents },
    { key: "delivery", label: FULFILLMENT_FEE_LABELS[order.fulfillment] ?? "Delivery fee", cents: order.deliveryFeeCents },
    { key: "tax", label: "Tax", cents: order.taxCents },
    { key: "tip", label: "Tip", cents: order.tipCents },
  ];
  return lines.filter((line) => line.key === "subtotal" || line.cents !== 0);
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
