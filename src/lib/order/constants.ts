export type OrderLineStatus =
  | "pending"
  | "picked"
  | "short"
  | "refunded"
  | "substituted";

export const RESOLVED_LINE_STATUSES: OrderLineStatus[] = ["picked", "refunded", "substituted"];

/** Why a store cancels before capture. A fixed list, so the customer message and admin views can use it. */
export const STORE_CANCEL_REASONS = ["out_of_stock", "store_closed", "too_busy", "other"] as const;
export type StoreCancelReason = (typeof STORE_CANCEL_REASONS)[number];
