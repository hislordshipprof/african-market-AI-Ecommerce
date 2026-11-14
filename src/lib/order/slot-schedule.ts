import { z } from "zod";
import { getStoreLocalTime, isValidTimezone, parseTimeMinutes } from "./store-hours";
import { ASAP_SLOT, pickupSlotsToday, type PickupSlot, type PickupStore } from "./pickup-slots";

/** A card hold can be as short as 5 days (Visa merchant-initiated), so no slot ends later than that (#565). */
export const MAX_DAYS_AHEAD = 5;
export const MIN_LEAD_MINUTES = 120;
export const DEFAULT_SLOT_MINUTES = 60;

const windowSchema = z
  .object({ start: z.number().int().min(0).max(1440), end: z.number().int().min(0).max(1440) })
  .refine((window) => window.end > window.start);

export const slotScheduleSchema = z.object({
  slotMinutes: z.number().int().min(15).max(240).refine((minutes) => minutes % 15 === 0),
  leadMinutes: z.number().int().min(MIN_LEAD_MINUTES).max(48 * 60),
  capacity: z.number().int().min(1).max(500),
  daysAhead: z.number().int().min(1).max(MAX_DAYS_AHEAD),
  closedDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60),
  /** Index 0 is Sunday. Minutes from local midnight; no overnight windows. */
  windows: z.array(z.array(windowSchema).max(6)).length(7),
});

export type SlotSchedule = z.infer<typeof slotScheduleSchema>;
export type SlotWindow = SlotSchedule["windows"][number][number];

/** A stored schedule, or null when unset or no longer valid. */
export function readSlotSchedule(raw: unknown): SlotSchedule | null {
  const parsed = slotScheduleSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** "9:00 AM - 12:00 PM, 2:00 PM - 6:00 PM" → windows; "" or "closed" → none; null when unreadable. */
export function parseWindows(text: string): SlotWindow[] | null {
  const trimmed = text.trim();
  if (!trimmed || /^closed$/i.test(trimmed)) return [];
  const windows: SlotWindow[] = [];
  for (const part of trimmed.split(",")) {
    const [open, close, extra] = part.split(/\s*[-–—]\s*/);
    if (!open || !close || extra !== undefined) return null;
    const start = parseTimeMinutes(open);
    const end = parseTimeMinutes(close);
    if (start === null || end === null || end <= start) return null;
    windows.push({ start, end });
  }
  return windows.sort((a, b) => a.start - b.start);
}

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = String(minutes % 60).padStart(2, "0");
  return `${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

export function formatWindows(windows: SlotWindow[]): string {
  return windows.map((window) => `${clock(window.start)} - ${clock(window.end)}`).join(", ");
}

const STEP_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const rangeFormatters = new Map<string, Intl.DateTimeFormat>();

function slotLabel(timezone: string, start: Date, end: Date): string {
  let fmt = rangeFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    rangeFormatters.set(timezone, fmt);
  }
  return fmt.formatRange(start, end).replace(/ | /g, " ");
}

/**
 * The open slots of a schedule, in the store's zone. Candidates are UTC
 * instants 15 minutes apart, so a local time inside the spring-forward gap is
 * never produced; a repeated fall-back hour keeps its first instant. A slot
 * starts at least the lead time from now, ends within days ahead of now, and
 * is dropped once `booked` reaches capacity.
 */
export function scheduledSlots(
  schedule: SlotSchedule,
  timezone: string,
  now: Date,
  booked: ReadonlyMap<string, number>,
): PickupSlot[] {
  if (!isValidTimezone(timezone)) return [];
  const slotMs = schedule.slotMinutes * 60_000;
  const latest = now.getTime() + schedule.daysAhead * DAY_MS;
  const closed = new Set(schedule.closedDates);
  const seen = new Set<string>();
  const slots: PickupSlot[] = [];
  const first = Math.ceil((now.getTime() + schedule.leadMinutes * 60_000) / STEP_MS) * STEP_MS;
  for (let at = first; at + slotMs <= latest; at += STEP_MS) {
    const local = getStoreLocalTime(timezone, new Date(at));
    const date = new Date(local.wallMs).toISOString().slice(0, 10);
    if (closed.has(date)) continue;
    const minute = local.minuteOfDay;
    const fits = schedule.windows[local.dayOfWeek].some((window) =>
      minute >= window.start
      && minute + schedule.slotMinutes <= window.end
      && (minute - window.start) % schedule.slotMinutes === 0);
    if (!fits) continue;
    const key = `${date} ${minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = new Date(at).toISOString();
    if ((booked.get(id) ?? 0) >= schedule.capacity) continue;
    slots.push({ id, label: slotLabel(timezone, new Date(at), new Date(at + slotMs)) });
  }
  return slots;
}

export interface SlotStore extends PickupStore {
  pickupSlotSettings: unknown;
}

/** Pickup times: ASAP when today allows it, then the store's schedule, or today's half hours without one. */
export function pickupSlotsFor(store: SlotStore, now: Date, booked: ReadonlyMap<string, number>): PickupSlot[] {
  const today = pickupSlotsToday(store, now);
  const schedule = readSlotSchedule(store.pickupSlotSettings);
  if (!schedule || !store.pickupEnabled) return today;
  const asap = today.some((slot) => slot.id === ASAP_SLOT.id) ? [ASAP_SLOT] : [];
  return [...asap, ...scheduledSlots(schedule, store.timezone, now, booked)];
}
