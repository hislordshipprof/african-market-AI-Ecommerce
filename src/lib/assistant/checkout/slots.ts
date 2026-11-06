import { findDaySchedule, parseTimeMinutes } from "../../order/store-hours";

export interface PickupSlot {
  id: string;
  label: string;
  /** UTC instant the customer can pick up. ASAP uses the earliest feasible instant. */
  at: string;
}

export interface SlotOffer {
  slots: PickupSlot[];
  reason: "ok" | "pickup_off" | "closed" | "hours_unavailable";
}

const WEEKDAY: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function parts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  });
  const bag = Object.fromEntries(fmt.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    dayOfWeek: WEEKDAY[bag.weekday ?? ""] ?? 0,
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    zone: bag.timeZoneName ?? timeZone,
  };
}

/** UTC instant for a store-local clock time. Null when that local time does not exist. */
export function storeLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date | null {
  parts(new Date(Date.UTC(year, month - 1, day, hour, minute)), timeZone);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  const matches: number[] = [];
  for (let offsetMin = -14 * 60; offsetMin <= 14 * 60; offsetMin += 30) {
    const utc = desired - offsetMin * 60_000;
    const seen = parts(new Date(utc), timeZone);
    if (seen.year === year && seen.month === month && seen.day === day && seen.hour === hour && seen.minute === minute) {
      matches.push(utc);
    }
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => a - b);
  return new Date(matches[0]!);
}

function labelAt(date: Date, timeZone: string): string {
  const local = parts(date, timeZone);
  const hour12 = local.hour % 12 === 0 ? 12 : local.hour % 12;
  const suffix = local.hour < 12 ? "AM" : "PM";
  const minute = String(local.minute).padStart(2, "0");
  return `${hour12}:${minute} ${suffix} ${local.zone}`;
}

function addLocalDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

interface Shift {
  open: Date;
  close: Date;
}

function shiftFor(now: Date, timeZone: string, hours: Record<string, unknown>): Shift | "closed" | "bad" | null {
  let local: ReturnType<typeof parts>;
  try {
    local = parts(now, timeZone);
  } catch {
    return "bad";
  }
  const today = findDaySchedule(hours, local.dayOfWeek);
  const yesterday = findDaySchedule(hours, (local.dayOfWeek + 6) % 7);
  if (today?.kind === "unparseable" || yesterday?.kind === "unparseable") return "bad";

  const todayRange = today?.kind === "range" ? today : null;
  const yRange = yesterday?.kind === "range" ? yesterday : null;
  const openMin = todayRange ? parseTimeMinutes(todayRange.open) : null;
  const closeMin = todayRange ? parseTimeMinutes(todayRange.close) : null;
  if (todayRange && (openMin == null || closeMin == null)) return "bad";

  const yOpen = yRange ? parseTimeMinutes(yRange.open) : null;
  const yClose = yRange ? parseTimeMinutes(yRange.close) : null;
  if (yRange && (yOpen == null || yClose == null)) return "bad";

  const minuteNow = local.hour * 60 + local.minute;
  if (yOpen != null && yClose != null && yClose <= yOpen && minuteNow < yClose) {
    const prev = addLocalDays(local.year, local.month, local.day, -1);
    const open = storeLocalToUtc(prev.year, prev.month, prev.day, Math.floor(yOpen / 60), yOpen % 60, timeZone);
    const close = storeLocalToUtc(local.year, local.month, local.day, Math.floor(yClose / 60), yClose % 60, timeZone);
    if (!open || !close) return "bad";
    return { open, close };
  }

  if (openMin == null || closeMin == null) return "closed";
  const open = storeLocalToUtc(local.year, local.month, local.day, Math.floor(openMin / 60), openMin % 60, timeZone);
  if (!open) return "bad";
  if (closeMin > openMin) {
    const close = storeLocalToUtc(local.year, local.month, local.day, Math.floor(closeMin / 60), closeMin % 60, timeZone);
    if (!close) return "bad";
    if (now.getTime() >= close.getTime()) return "closed";
    return { open, close };
  }
  const next = addLocalDays(local.year, local.month, local.day, 1);
  const close = storeLocalToUtc(next.year, next.month, next.day, Math.floor(closeMin / 60), closeMin % 60, timeZone);
  if (!close) return "bad";
  if (minuteNow < openMin && now.getTime() < open.getTime()) {
    return { open, close };
  }
  if (now.getTime() >= close.getTime()) return "closed";
  return { open, close };
}

/**
 * Stable pickup slots for the current shift. Ids are `asap` or a UTC instant
 * on a 30-minute boundary, so a later request does not rename a slot that is
 * still feasible. The store cannot start until the cancel window closes.
 */
export function offerPickupSlots(input: {
  now: Date;
  timeZone: string;
  hours: unknown;
  prepMinutes: number;
  windowMinutes: number;
  pickupEnabled: boolean;
}): SlotOffer {
  if (!input.pickupEnabled) return { slots: [], reason: "pickup_off" };
  if (!input.hours || typeof input.hours !== "object" || !input.timeZone) {
    return { slots: [], reason: "hours_unavailable" };
  }
  const shift = shiftFor(input.now, input.timeZone, input.hours as Record<string, unknown>);
  if (shift === "bad") return { slots: [], reason: "hours_unavailable" };
  if (shift === "closed" || shift == null) return { slots: [], reason: "closed" };

  const release = Math.max(input.now.getTime() + input.windowMinutes * 60_000, shift.open.getTime());
  const earliest = release + Math.max(0, input.prepMinutes) * 60_000;
  if (earliest > shift.close.getTime()) return { slots: [], reason: "closed" };

  const slots: PickupSlot[] = [{
    id: "asap",
    label: `ASAP · ${labelAt(new Date(earliest), input.timeZone)}`,
    at: new Date(earliest).toISOString(),
  }];

  const local = parts(shift.open, input.timeZone);
  let cursorDay = { year: local.year, month: local.month, day: local.day };
  for (let guard = 0; guard < 3; guard += 1) {
    for (let minute = 0; minute < 24 * 60; minute += 30) {
      const instant = storeLocalToUtc(
        cursorDay.year,
        cursorDay.month,
        cursorDay.day,
        Math.floor(minute / 60),
        minute % 60,
        input.timeZone,
      );
      if (!instant) continue;
      const at = instant.getTime();
      if (at < earliest) continue;
      if (at >= shift.close.getTime()) continue;
      slots.push({
        id: instant.toISOString(),
        label: labelAt(instant, input.timeZone),
        at: instant.toISOString(),
      });
    }
    const next = addLocalDays(cursorDay.year, cursorDay.month, cursorDay.day, 1);
    const nextStart = storeLocalToUtc(next.year, next.month, next.day, 0, 0, input.timeZone);
    if (!nextStart || nextStart.getTime() > shift.close.getTime()) break;
    cursorDay = next;
  }

  return { slots, reason: "ok" };
}

export function slotStillOffered(slotId: string, offer: SlotOffer): boolean {
  return offer.slots.some((slot) => slot.id === slotId);
}
