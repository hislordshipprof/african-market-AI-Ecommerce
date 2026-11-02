export type OrderLineStatus =
  | "pending"
  | "picked"
  | "short"
  | "refunded"
  | "substituted";

export const RESOLVED_LINE_STATUSES: OrderLineStatus[] = ["picked", "refunded", "substituted"];
