import type { Fulfillment } from "../customer-flow/contracts";
import { storeToday } from "../analytics/range";

/** Store and courier delivery stop while the store's delivery is paused (#819); pickup and shipping go on. */
export function pausesWith(fulfillment: Fulfillment): boolean {
  return fulfillment === "store-delivery" || fulfillment === "courier";
}

/** The pause end while it is still ahead of `now`, else null. A cached store row carries it as an ISO string. */
export function activeDeliveryPause(store: { deliveryPausedUntil: Date | string | null }, now: Date): Date | null {
  if (!store.deliveryPausedUntil) return null;
  const until = new Date(store.deliveryPausedUntil);
  return until.getTime() > now.getTime() ? until : null;
}

/** "11:59 PM today, Tue Nov 24" or "9:00 AM Wed Nov 25", in the store's zone. */
export function pauseEndLabel(until: Date, timezone: string, now: Date): string {
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(until);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "short", month: "short", day: "numeric" }).format(until).replace(",", "");
  return storeToday(timezone, until) === storeToday(timezone, now) ? `${time} today, ${day}` : `${time} ${day}`;
}

/** What the shopper reads while delivery is paused. */
export function deliveryPausedMessage(until: Date, timezone: string, now: Date): string {
  return `Delivery is paused until ${pauseEndLabel(until, timezone, now)}. Choose pickup.`;
}

export class DeliveryPausedError extends Error {
  readonly code = "delivery_paused" as const;
  constructor(message: string) {
    super(message);
    this.name = "DeliveryPausedError";
  }
}
