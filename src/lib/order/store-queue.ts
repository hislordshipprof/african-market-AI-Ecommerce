import { nextOpening } from "./store-hours";

/** A card hold lasts 7 days, so an order never waits more than 6 days for opening. */
export const MAX_QUEUE_MS = 6 * 24 * 60 * 60_000;

export const STORE_NOT_TAKING_ORDERS = "This store isn't taking orders right now";

export class StoreNotTakingOrdersError extends Error {
  readonly code = "store_not_taking_orders" as const;
  constructor() {
    super(STORE_NOT_TAKING_ORDERS);
    this.name = "StoreNotTakingOrdersError";
  }
}

/**
 * Whether the store can take an order placed at `now`, and when its acceptance
 * clock starts: `now` when open, else the next opening. Refused when there is
 * no opening within 7 days, it is more than 6 × 24 h away, or the zone is invalid.
 */
export type StoreAvailability =
  | { kind: "open"; clockStartsAt: Date }
  | { kind: "queued"; clockStartsAt: Date }
  | { kind: "unavailable" };

export function storeAvailability(hours: unknown, timezone: string, now: Date): StoreAvailability {
  const opening = nextOpening(hours, timezone, now);
  if (!opening || opening.getTime() - now.getTime() > MAX_QUEUE_MS) return { kind: "unavailable" };
  if (opening.getTime() === now.getTime()) return { kind: "open", clockStartsAt: now };
  return { kind: "queued", clockStartsAt: opening };
}

function parts(date: Date, timezone: string, options: Intl.DateTimeFormatOptions) {
  const list = new Intl.DateTimeFormat("en-US", { timeZone: timezone, ...options }).formatToParts(date);
  return (type: Intl.DateTimeFormatPartTypes) => list.find((p) => p.type === type)?.value ?? "";
}

function localDate(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(date);
}

function clock(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }).format(date);
}

/**
 * Checkout copy for a queued order, in the store's own zone:
 * opensAt "Wed 9:00 AM CT", readyAt "9:30 AM" (or "Thu 1:00 AM" when prep crosses midnight).
 */
export function describeQueue(
  opening: Date,
  prepTimeMinutes: number,
  timezone: string,
): { opensAt: string; readyAt: string } {
  const at = parts(opening, timezone, { weekday: "short", timeZoneName: "shortGeneric" });
  const opensAt = `${at("weekday")} ${clock(opening, timezone)} ${at("timeZoneName")}`;
  const ready = new Date(opening.getTime() + Math.max(0, prepTimeMinutes) * 60_000);
  const readyDay = localDate(ready, timezone) === localDate(opening, timezone)
    ? ""
    : `${parts(ready, timezone, { weekday: "short" })("weekday")} `;
  return { opensAt, readyAt: `${readyDay}${clock(ready, timezone)}` };
}
