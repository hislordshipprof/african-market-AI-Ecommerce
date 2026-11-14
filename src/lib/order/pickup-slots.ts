import { isStoreOpen, isValidTimezone, nextOpening } from "./store-hours";

export interface PickupSlot {
  /** "asap" or a UTC ISO instant. */
  id: string;
  label: string;
}

export interface PickupStore {
  hours: unknown;
  timezone: string;
  prepTimeMinutes: number;
  pickupEnabled: boolean;
}

export const ASAP_SLOT: PickupSlot = { id: "asap", label: "As soon as it is ready" };

const SLOT_MS = 30 * 60_000;

function localDay(timezone: string, at: Date): string {
  return at.toLocaleDateString("en-US", { timeZone: timezone });
}

export function slotLabel(timezone: string, at: Date): string {
  return at.toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

/**
 * Today's pickup slots in the store's zone (#247): ASAP while the store is open
 * and the order can be ready before closing, then every 30 minutes from the
 * opening plus prep time until closing or local midnight. US offsets are whole
 * hours, so UTC half hours are local half hours.
 */
export function pickupSlotsToday(store: PickupStore, now: Date): PickupSlot[] {
  if (!store.pickupEnabled || !isValidTimezone(store.timezone)) return [];
  const opening = nextOpening(store.hours, store.timezone, now);
  if (!opening) return [];
  const today = localDay(store.timezone, now);
  const prepMs = Math.max(0, store.prepTimeMinutes) * 60_000;
  const slots: PickupSlot[] = [];
  const readyNow = new Date(now.getTime() + prepMs);
  if (opening.getTime() === now.getTime() && isStoreOpen(store.hours, store.timezone, readyNow)) slots.push(ASAP_SLOT);
  const ready = Math.max(now.getTime(), opening.getTime()) + prepMs;
  for (let at = Math.ceil(ready / SLOT_MS) * SLOT_MS; ; at += SLOT_MS) {
    const instant = new Date(at);
    if (localDay(store.timezone, instant) !== today) break;
    if (isStoreOpen(store.hours, store.timezone, instant)) {
      slots.push({ id: instant.toISOString(), label: slotLabel(store.timezone, instant) });
    }
  }
  return slots;
}
