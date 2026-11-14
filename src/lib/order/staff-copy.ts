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
