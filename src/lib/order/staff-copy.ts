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
