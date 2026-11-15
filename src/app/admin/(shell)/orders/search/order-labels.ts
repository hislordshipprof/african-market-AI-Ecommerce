import { formatInZone } from "@/lib/format";

export const FULFILLMENT_LABELS: Record<string, string> = {
  pickup: "Pickup",
  "store-delivery": "Store delivery",
  courier: "Courier",
  delivery: "Store delivery",
};

/** A moment in the store's own zone, with the zone named, e.g. "Mar 9, 2026, 9:30 PM CDT". */
export function placedAt(at: Date | string, timeZone: string): string {
  return formatInZone(at, timeZone, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}
